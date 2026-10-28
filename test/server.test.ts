import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Client, type CallToolResult } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { SERVER_NAME, SERVER_VERSION } from "../src/server.js"
import {
    createProfile,
    createTempRoot,
    FAKE_PASSWORD,
    findLeaks,
    removeTempRoot,
    SECRET_SENTINEL,
    snapshotDir,
    type ProfileFixture,
} from "./helpers/fixtures.js"
import { childEnv, MAIN_JS, PROJECT_ROOT, parseStdoutLines, request, runToExit, startServer } from "./helpers/process.js"

let root: string
let counter = 0

before(() => {
    root = createTempRoot()
})
after(() => removeTempRoot(root))

function newProfile(name = "", options: Parameters<typeof createProfile>[1] = {}): ProfileFixture {
    counter++
    return createProfile(path.join(root, `srv${counter}${name}`), options)
}

/** Every stderr line is a JSON diagnostic and nothing sensitive is printed. */
function assertCleanStderr(stderr: string, forbidden: readonly string[]): void {
    for (const line of stderr.split(/\r?\n/).filter((l) => l.length > 0)) {
        assert.match(line, /^fluent-reader-mcp \{/, `unexpected stderr line: ${line}`)
        JSON.parse(line.slice("fluent-reader-mcp ".length))
    }
    assert.deepEqual(findLeaks([stderr], [SECRET_SENTINEL, FAKE_PASSWORD, root, ...forbidden]), [])
}

function assertOnlyJsonRpc(stdout: string): unknown[] {
    if (stdout.length > 0) assert.ok(stdout.endsWith("\n"), "stdout ends with a complete message")
    const messages = parseStdoutLines(stdout)
    for (const message of messages) {
        assert.equal((message as { jsonrpc?: unknown }).jsonrpc, "2.0")
    }
    return messages
}

test("package.json version matches the advertised server version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { name: string; version: string }
    assert.equal(pkg.name, SERVER_NAME)
    assert.equal(pkg.version, SERVER_VERSION)
})

describe("MCP over stdio with the SDK v2 client", { timeout: 60_000 }, () => {
    for (const mode of ["legacy", "auto"] as const) {
        test(`handshake, exactly two tools, calls and close (versionNegotiation: ${mode})`, async () => {
            const profile = newProfile(` ${mode} àè 😀`)
            const initial = snapshotDir(profile.dir)
            const transport = new StdioClientTransport({
                command: process.execPath,
                args: [MAIN_JS, "--profile-dir", profile.dir],
                env: childEnv(),
                stderr: "pipe",
            })
            let stderr = ""
            transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
            const client = new Client({ name: "frmcp-synthetic-client", version: "0.0.0" }, { versionNegotiation: { mode } })
            await client.connect(transport)
            try {
                assert.equal(client.getProtocolEra(), mode === "auto" ? "modern" : "legacy")
                assert.deepEqual(client.getServerVersion(), { name: SERVER_NAME, version: SERVER_VERSION })
                const tools = await client.listTools()
                assert.deepEqual(
                    tools.tools.map((t) => t.name).sort(),
                    ["get_article", "get_group", "get_rule_chain", "get_source", "list_groups", "list_rules", "list_sources"],
                    "exactly the FR-MCP-02A-02 to 02A-05 tools",
                )
                for (const tool of tools.tools) {
                    assert.equal(tool.annotations?.readOnlyHint, true)
                    assert.equal(tool.annotations?.openWorldHint, false)
                    assert.equal(tool.annotations?.destructiveHint, false)
                    assert.equal(tool.inputSchema.type, "object")
                    assert.equal((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties, false)
                    assert.equal(tool.outputSchema?.type, "object")
                }
                const listSchema = tools.tools.find((t) => t.name === "list_sources")?.inputSchema as {
                    properties: Record<string, { maximum?: number; maxLength?: number; minimum?: number }>
                }
                assert.deepEqual(Object.keys(listSchema.properties).sort(), ["cursor", "groupId", "includeHidden", "limit", "query"])
                assert.equal(listSchema.properties.limit?.maximum, 500)
                assert.equal(listSchema.properties.query?.maxLength, 100)
                assert.equal(listSchema.properties.groupId?.minimum, 0)
                type Props = { properties: Record<string, { maximum?: number; minimum?: number }>; required?: string[] }
                const groupsSchema = tools.tools.find((t) => t.name === "list_groups")?.inputSchema as Props
                assert.deepEqual(Object.keys(groupsSchema.properties).sort(), ["cursor", "includeEmpty", "limit"])
                assert.equal(groupsSchema.properties.limit?.maximum, 200)
                const groupSchema = tools.tools.find((t) => t.name === "get_group")?.inputSchema as Props
                assert.deepEqual(Object.keys(groupSchema.properties).sort(), ["cursor", "groupId", "limit"])
                assert.deepEqual(groupSchema.required, ["groupId"])
                assert.equal(groupSchema.properties.groupId?.minimum, 0)
                assert.equal(groupSchema.properties.limit?.maximum, 200)
                const articleSchema = tools.tools.find((t) => t.name === "get_article")?.inputSchema as Props & {
                    properties: Record<string, { enum?: string[] }>
                }
                assert.deepEqual(Object.keys(articleSchema.properties).sort(), ["articleId", "format", "maxChars", "offset"])
                assert.deepEqual(articleSchema.required, ["articleId"])
                assert.equal(articleSchema.properties.articleId?.minimum, 1)
                assert.equal(articleSchema.properties.maxChars?.maximum, 40_000)
                assert.deepEqual(articleSchema.properties.format?.enum, ["text", "html"])
                assert.match(tools.tools.find((t) => t.name === "get_article")?.description ?? "", /UNTRUSTED CONTENT/)
                const rulesSchema = tools.tools.find((t) => t.name === "list_rules")?.inputSchema as Props & { properties: Record<string, { enum?: string[] }> }
                assert.deepEqual(Object.keys(rulesSchema.properties).sort(), ["cursor", "groupId", "limit", "scope", "sourceId"])
                assert.deepEqual([...(rulesSchema.required ?? [])].sort(), ["limit", "scope"])
                assert.deepEqual(rulesSchema.properties.scope?.enum, ["all", "group", "source"])
                assert.equal(rulesSchema.properties.limit?.maximum, 100)
                const chainSchema = tools.tools.find((t) => t.name === "get_rule_chain")?.inputSchema as Props
                assert.deepEqual(Object.keys(chainSchema.properties).sort(), ["all", "cursor", "groupId", "limit", "sourceId", "sourceRef"])
                assert.equal(chainSchema.required, undefined)

                const list = (await client.callTool({ name: "list_sources", arguments: { limit: 1 } })) as CallToolResult
                assert.equal(list.isError, undefined)
                const page = list.structuredContent as { sources: { sourceId: number; sourceRef: string; name: string }[]; nextCursor: string }
                assert.deepEqual(JSON.parse((list.content[0] as { text: string }).text), page)
                assert.deepEqual(page.sources.map((s) => [s.sourceId, s.name]), [[0, "Synthetic A"]])
                const next = (await client.callTool({ name: "list_sources", arguments: { cursor: page.nextCursor } })) as CallToolResult
                assert.deepEqual(
                    (next.structuredContent as { sources: { sourceId: number }[] }).sources.map((s) => s.sourceId),
                    [1],
                )
                const one = (await client.callTool({
                    name: "get_source",
                    arguments: { sourceId: 0, sourceRef: page.sources[0]?.sourceRef },
                })) as CallToolResult
                assert.equal((one.structuredContent as { source: { name: string } }).source.name, "Synthetic A")
                const missing = (await client.callTool({ name: "get_source", arguments: { sourceId: 99 } })) as CallToolResult
                assert.equal(missing.isError, true)
                assert.equal(JSON.parse((missing.content[0] as { text: string }).text).code, "NOT_FOUND")
                const invalid = (await client.callTool({ name: "list_sources", arguments: { limit: "x" } })) as CallToolResult
                assert.equal(invalid.isError, true)
                assert.equal(JSON.parse((invalid.content[0] as { text: string }).text).code, "INVALID_ARGUMENT")
                const groupList = (await client.callTool({ name: "list_groups", arguments: {} })) as CallToolResult
                assert.equal(groupList.isError, undefined)
                assert.deepEqual(JSON.parse((groupList.content[0] as { text: string }).text), groupList.structuredContent)
                const groupsPayload = groupList.structuredContent as { groups: { groupId: number; position: number; name: string }[] }
                assert.deepEqual(groupsPayload.groups.map((g) => [g.groupId, g.position, g.name]), [[0, 0, "Synthetic group"]])
                const group = (await client.callTool({ name: "get_group", arguments: { groupId: 0 } })) as CallToolResult
                assert.equal(group.isError, undefined)
                const groupPayload = group.structuredContent as { sources: { sourceId: number; sourceRef: string }[]; ruleCount: number }
                assert.deepEqual(groupPayload.sources.map((s) => s.sourceId), [0, 1])
                assert.equal(groupPayload.sources[0]?.sourceRef, page.sources[0]?.sourceRef)
                const single = (await client.callTool({ name: "get_group", arguments: { groupId: 1 } })) as CallToolResult
                assert.equal(JSON.parse((single.content[0] as { text: string }).text).code, "NOT_FOUND")
                const art = (await client.callTool({ name: "get_article", arguments: { articleId: 1 } })) as CallToolResult
                assert.equal(art.isError, undefined)
                assert.deepEqual(JSON.parse((art.content[0] as { text: string }).text), art.structuredContent)
                const artPayload = art.structuredContent as { title: string; body: string; sourceName: string; untrusted: boolean }
                assert.deepEqual([artPayload.title, artPayload.body, artPayload.sourceName, artPayload.untrusted], ["Synthetic title 0 àèì 中文 😀", "Body 0", "Synthetic A", true])
                const html = (await client.callTool({ name: "get_article", arguments: { articleId: 2, format: "html", maxChars: 3 } })) as CallToolResult
                assert.deepEqual((html.structuredContent as { body: string; nextOffset: number }).body, "<p>")
                const noArticle = (await client.callTool({ name: "get_article", arguments: { articleId: 999 } })) as CallToolResult
                assert.equal(JSON.parse((noArticle.content[0] as { text: string }).text).code, "NOT_FOUND")
                const ruleList = (await client.callTool({ name: "list_rules", arguments: { scope: "all", limit: 5 } })) as CallToolResult
                assert.equal(ruleList.isError, undefined)
                assert.deepEqual(JSON.parse((ruleList.content[0] as { text: string }).text), ruleList.structuredContent)
                assert.deepEqual((ruleList.structuredContent as { rules: { pattern: string }[] }).rules.map((r) => r.pattern), ["synthetic"])
                const ruleChain = (await client.callTool({ name: "get_rule_chain", arguments: { sourceId: 0 } })) as CallToolResult
                assert.equal(ruleChain.isError, undefined)
                const chainPayload = ruleChain.structuredContent as { chain: { originKey: string; rule: { pattern: string } }[]; resolution: { groupId: number } }
                assert.deepEqual(chainPayload.chain.map((e) => [e.originKey, e.rule.pattern]), [["all", "synthetic"], ["source:0", "^x"]])
                assert.equal(chainPayload.resolution.groupId, 0)
                const badChain = (await client.callTool({ name: "get_rule_chain", arguments: { sourceId: 0, all: true } })) as CallToolResult
                assert.equal(JSON.parse((badChain.content[0] as { text: string }).text).code, "INVALID_ARGUMENT")
                if (mode === "legacy") await client.ping()
            } finally {
                await client.close()
            }
            assert.match(stderr, /"event":"serving"/)
            assertCleanStderr(stderr, [profile.dir])
            assert.deepEqual(snapshotDir(profile.dir), initial)
        })
    }
})

describe("MCP over stdio with raw JSON-RPC", { timeout: 60_000 }, () => {
    test("stdout carries only JSON-RPC; closing stdin ends the process with code 0", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const server = startServer(["--profile-dir", profile.dir])
        const init = await request(server, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
        })
        const result = init.result as { serverInfo: unknown; capabilities: Record<string, unknown> }
        assert.deepEqual(result.serverInfo, { name: SERVER_NAME, version: SERVER_VERSION })
        assert.ok("tools" in result.capabilities)
        server.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
        assert.deepEqual((await request(server, { jsonrpc: "2.0", id: 2, method: "ping" })).result, {})
        const list = await request(server, { jsonrpc: "2.0", id: 3, method: "tools/list" })
        assert.deepEqual((list.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort(), ["get_article", "get_group", "get_rule_chain", "get_source", "list_groups", "list_rules", "list_sources"])
        const unknown = await request(server, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "simulate_rules", arguments: {} } })
        assert.ok("error" in unknown || (unknown.result as { isError?: boolean }).isError === true)
        const call = await request(server, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_sources", arguments: {} } })
        const callResult = call.result as { structuredContent: { sources: unknown[] }; content: { text: string }[] }
        assert.equal(callResult.structuredContent.sources.length, 2)
        assert.deepEqual(JSON.parse(callResult.content[0]?.text ?? ""), callResult.structuredContent)
        const bad = await request(server, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_source", arguments: { sourceId: -1 } } })
        assert.equal((bad.result as { isError?: boolean }).isError, true)

        server.child.stdin.end()
        const exit = await server.exited(5_000)
        assert.equal(exit.code, 0)
        const messages = assertOnlyJsonRpc(exit.stdout)
        assert.equal(messages.length, 6)
        assert.deepEqual(findLeaks([exit.stdout], ["feed.invalid", SECRET_SENTINEL]), [])
        assertCleanStderr(exit.stderr, [profile.dir])
        assert.match(exit.stderr, /"event":"shutdown","reason":"stdin-(end|close)"/)
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("an idle server writes nothing on stdout and exits when stdin closes", async () => {
        const profile = newProfile()
        const server = startServer(["--profile-dir", profile.dir])
        const deadline = Date.now() + 10_000
        while (!server.stderr().includes('"event":"serving"') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        server.child.stdin.end()
        const exit = await server.exited(5_000)
        assert.equal(exit.code, 0)
        assert.equal(exit.stdout, "")
        assertCleanStderr(exit.stderr, [profile.dir])
    })

    test("the environment variable alone configures the profile", async () => {
        const profile = newProfile()
        const server = startServer([], childEnv({ FLUENT_READER_PROFILE_DIR: profile.dir }))
        const init = await request(server, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
        })
        assert.ok("result" in init)
        server.child.stdin.end()
        assert.equal((await server.exited(5_000)).code, 0)
    })

    test("a profile reached through a junction is served and flagged without its path", async () => {
        const profile = newProfile(" junction target")
        const junction = path.join(root, `PATHMARK-junction-${counter}`)
        fs.symlinkSync(profile.dir, junction, "junction")
        const server = startServer(["--profile-dir", junction])
        const init = await request(server, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
        })
        assert.ok("result" in init)
        server.child.stdin.end()
        const exit = await server.exited(5_000)
        assert.match(exit.stderr, /"canonicalPathDiffers":true/)
        assertCleanStderr(exit.stderr, ["PATHMARK", profile.dir])
    })
})

describe("bootstrap errors", { timeout: 60_000 }, () => {
    async function expectStartupFailure(args: string[], code: string, reason: string, env = childEnv()): Promise<string> {
        const exit = await runToExit(args, env)
        assert.equal(exit.code, 1)
        assert.equal(exit.stdout, "", "nothing on stdout")
        assert.match(exit.stderr, new RegExp(`"event":"startup_failed","code":"${code}","reason":"${reason}"`))
        return exit.stderr
    }

    test("no profile configured", async () => {
        const stderr = await expectStartupFailure([], "PROFILE_UNAVAILABLE", "not-configured")
        assertCleanStderr(stderr, [])
    })

    test("relative path", async () => {
        await expectStartupFailure(["--profile-dir", "relative\\profile"], "PROFILE_UNAVAILABLE", "not-absolute")
    })

    test("missing directory: no path in output, nothing created", async () => {
        const missing = path.join(root, "PATHMARK-missing-profile")
        const initial = snapshotDir(root)
        const stderr = await expectStartupFailure(["--profile-dir", missing], "PROFILE_UNAVAILABLE", "not-found")
        assertCleanStderr(stderr, ["PATHMARK"])
        assert.equal(fs.existsSync(missing), false)
        assert.deepEqual(snapshotDir(root), initial)
    })

    test("missing database: no database is created as a fallback", async () => {
        const profile = newProfile("", { db: false })
        const initial = snapshotDir(profile.dir)
        await expectStartupFailure(["--profile-dir", profile.dir], "PROFILE_UNAVAILABLE", "db-missing")
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("separate --db override is rejected", async () => {
        const profile = newProfile()
        await expectStartupFailure(["--db", profile.dbPath], "PROFILE_UNAVAILABLE", "invalid-argument")
    })

    test("conflicting argument and environment variable", async () => {
        const a = newProfile()
        const b = newProfile()
        await expectStartupFailure(
            ["--profile-dir", a.dir],
            "PROFILE_UNAVAILABLE",
            "ambiguous",
            childEnv({ FLUENT_READER_PROFILE_DIR: b.dir }),
        )
    })

    test("incompatible schema", async () => {
        const profile = newProfile("", { db: { schema: "missing-column" } })
        const initial = snapshotDir(profile.dir)
        await expectStartupFailure(["--profile-dir", profile.dir], "SCHEMA_UNSUPPORTED", "missing-column")
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("WAL database: refused, no auxiliary file created", async () => {
        const profile = newProfile("", { db: { wal: true } })
        const initial = snapshotDir(profile.dir)
        await expectStartupFailure(["--profile-dir", profile.dir], "DB_WAL_UNSUPPORTED", "wal-mode")
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("invalid settings are reported but do not stop the server; secrets stay hidden", async () => {
        const profile = newProfile("", {
            settings: `{"serviceConfigs":{"password":"${FAKE_PASSWORD}"},"sourceGroups":[${SECRET_SENTINEL}`,
        })
        const server = startServer(["--profile-dir", profile.dir])
        const init = await request(server, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
        })
        assert.ok("result" in init)
        server.child.stdin.end()
        const exit = await server.exited(5_000)
        assert.equal(exit.code, 0)
        assert.match(exit.stderr, /"event":"settings_unavailable","code":"SETTINGS_INVALID"/)
        assertCleanStderr(exit.stderr, [profile.dir])
        assert.deepEqual(findLeaks([exit.stdout], [SECRET_SENTINEL, FAKE_PASSWORD]), [])
    })

    test("valid settings with fake credentials: nothing leaks on stdout or stderr", async () => {
        const profile = newProfile()
        const server = startServer(["--profile-dir", profile.dir])
        await request(server, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
        })
        await request(server, { jsonrpc: "2.0", id: 2, method: "tools/list" })
        server.child.stdin.end()
        const exit = await server.exited(5_000)
        assert.match(exit.stderr, /"event":"settings_ok","sourceGroups":"ok","sourceRules":"ok"/)
        assertCleanStderr(exit.stderr, [profile.dir, "proxy.invalid", "sync.invalid"])
        assert.deepEqual(findLeaks([exit.stdout], [SECRET_SENTINEL, FAKE_PASSWORD, "proxy.invalid", "sync.invalid"]), [])
    })
})
