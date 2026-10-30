/**
 * FR-MCP-02A-06: end-to-end interoperability of the compiled server
 * (dist/main.js) as a real stdio process, on the synthetic smoke profile.
 *
 * These are SDK and raw JSON-RPC clients, not Claude Code: the Claude Code
 * run is owner-run (smoke-cli.ts); the harness and its transcript verifier
 * are tested in smoke-harness.test.ts.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, test } from "node:test"
import { Client, type CallToolResult } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { SERVER_NAME, SERVER_VERSION } from "../../src/server.js"
import {
    getArticleOutput,
    getGroupOutput,
    getRuleChainOutput,
    getSourceOutput,
    listArticlesOutput,
    listGroupsOutput,
    listRulesOutput,
    listSourcesOutput,
    searchArticlesOutput,
} from "../../src/tools/schemas.js"
import { CONFIG_NAME, createTempRoot, DB_NAME, findLeaks, removeTempRoot } from "../helpers/fixtures.js"
import { childEnv, MAIN_JS, parseStdoutLines, request, runToExit, startServer, type RunningServer } from "../helpers/process.js"
import { TOOL_NAMES } from "./smoke-claude.js"
import {
    buildSmokeProfile,
    INJECTION_HTML,
    integrityDifferences,
    integritySnapshot,
    MISSING_ARTICLE_ID,
    MISSING_SOURCE_ID,
    SMOKE_EXPECTED,
    SMOKE_FEED_HOST,
    SMOKE_SECRET,
    UNICODE_TEXT,
    UNICODE_TITLE,
    type SmokeProfile,
} from "./smoke-fixture.js"

let root: string
let counter = 0

before(() => {
    root = createTempRoot()
})
after(() => removeTempRoot(root))

function newSmokeProfile(): SmokeProfile {
    counter++
    return buildSmokeProfile(path.join(root, `smoke${counter} àè 😀`, "profile"))
}

function scratch(): string {
    return path.join(root, "scratch")
}

/** Markers the server must never return (credentials, feed/icon/article URLs). */
const REDACTED = [SMOKE_SECRET, SMOKE_FEED_HOST, "icons.example.org", "www.example.com/smoke/article-", "sync.example.org", "proxy.example.org"]

function assertCleanStderr(stderr: string, profile: SmokeProfile): void {
    for (const line of stderr.split(/\r?\n/).filter((l) => l.length > 0)) {
        assert.match(line, /^fluent-reader-mcp \{/, `unexpected stderr line: ${line}`)
        JSON.parse(line.slice("fluent-reader-mcp ".length))
    }
    assert.deepEqual(findLeaks([stderr], [...REDACTED, profile.dir, root]), [])
}

interface Outcome {
    readonly result: CallToolResult
    readonly text: string
    readonly payload: any
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Outcome> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    const text = (result.content[0] as { text: string }).text
    return { result, text, payload: JSON.parse(text) }
}

function assertSuccess(outcome: Outcome, schema: { parse(value: unknown): unknown }): void {
    assert.equal(outcome.result.isError, undefined)
    assert.equal(outcome.result.content.length, 1)
    assert.deepEqual(outcome.payload, outcome.result.structuredContent, "the text copy is the JSON of structuredContent")
    schema.parse(outcome.result.structuredContent)
}

function assertError(outcome: Outcome, code: string): void {
    assert.equal(outcome.result.isError, true)
    assert.equal(outcome.result.structuredContent, undefined)
    assert.equal(outcome.payload.code, code)
    assert.deepEqual(Object.keys(outcome.payload).filter((k) => !["code", "message", "hint", "reason"].includes(k)), [])
}

function processGone(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return false
    } catch {
        return true
    }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return true
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return condition()
}

/** No process holds a handle that forbids renaming (the server's own handles have no FILE_SHARE_DELETE). */
function assertNoHandleHeld(dbPath: string): void {
    const moved = `${dbPath}.moved`
    fs.renameSync(dbPath, moved)
    fs.renameSync(moved, dbPath)
}

describe("FR-MCP-02A-06 synthetic smoke fixture", () => {
    test("is reproducible and matches the documented data", () => {
        const a = newSmokeProfile()
        const b = newSmokeProfile()
        assert.equal(fs.readFileSync(a.configPath, "utf8"), fs.readFileSync(b.configPath, "utf8"))
        const sa = integritySnapshot(a.dir, scratch())
        const sb = integritySnapshot(b.dir, scratch())
        assert.deepEqual(Object.keys(sa.files), [CONFIG_NAME, DB_NAME])
        assert.deepEqual(sa.files, sb.files, "same bytes on the same SQLite version")
        assert.deepEqual(sa.auxiliaryFiles, [])
        assert.deepEqual(sa.hasRead, SMOKE_EXPECTED.hasRead)
        assert.throws(() => buildSmokeProfile(a.dir), /not empty/)
    })
})

describe("compiled server over stdio with the SDK client", { timeout: 60_000 }, () => {
    test("handshake, nine tools, one conforming call each, errors, no writes, clean shutdown", async () => {
        const profile = newSmokeProfile()
        const initial = integritySnapshot(profile.dir, scratch())
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [MAIN_JS, "--profile-dir", profile.dir],
            env: childEnv(),
            stderr: "pipe",
        })
        let stderr = ""
        transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
        const client = new Client({ name: "frmcp-smoke-client", version: "0.0.0" })
        await client.connect(transport)
        const pid = transport.pid
        assert.ok(typeof pid === "number")
        const texts: string[] = []
        const run = async (name: string, args: Record<string, unknown>): Promise<Outcome> => {
            const outcome = await call(client, name, args)
            texts.push(outcome.text)
            return outcome
        }
        try {
            assert.deepEqual(client.getServerVersion(), { name: SERVER_NAME, version: SERVER_VERSION })
            const tools = (await client.listTools()).tools
            // TOOL_NAMES is the set exercised by the Claude Code smoke (FR-MCP-02A); list_articles is FR-MCP-02B-01, search_articles FR-MCP-02B-02.
            assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES, "list_articles", "search_articles"].sort())
            for (const tool of tools) {
                assert.equal(tool.inputSchema.type, "object")
                assert.equal(tool.outputSchema?.type, "object")
                assert.equal(tool.annotations?.readOnlyHint, true)
            }

            // A. Sources
            const sources = await run("list_sources", { includeHidden: true })
            assertSuccess(sources, listSourcesOutput)
            assert.deepEqual(sources.payload.sources.map((s: any) => s.sourceId), SMOKE_EXPECTED.listSources.sourceIds)
            assert.deepEqual(
                Object.fromEntries(sources.payload.sources.map((s: any) => [s.sourceId, s.groupId])),
                Object.fromEntries(Object.entries(SMOKE_EXPECTED.sourceGroupIds)),
            )
            assert.equal(sources.payload.sources.find((s: any) => s.sourceId === 4).groupStatus, "ungrouped")
            assert.equal(sources.payload.meta.urlsRedacted, true)
            const visible = await run("list_sources", { includeHidden: false })
            assert.deepEqual(visible.payload.sources.map((s: any) => s.sourceId), SMOKE_EXPECTED.listSources.visibleSourceIds)
            const sourceRef = sources.payload.sources[0].sourceRef as string
            const source = await run("get_source", { sourceId: 1, sourceRef })
            assertSuccess(source, getSourceOutput)
            assert.equal(source.payload.source.name, "SMOKE Tech Daily")
            assert.equal(source.payload.source.groupId, 0)
            assert.deepEqual(source.payload.source.rules, { available: true, ...SMOKE_EXPECTED.getSource1Rules })
            assert.equal(source.payload.source.articleStats.available, false)

            // B. Groups
            const groups = await run("list_groups", {})
            assertSuccess(groups, listGroupsOutput)
            assert.deepEqual(
                groups.payload.groups.map((g: any) => ({ groupId: g.groupId, position: g.position, name: g.name, sourceCount: g.sourceCount })),
                SMOKE_EXPECTED.listGroups,
            )
            assert.deepEqual(groups.payload.integrity.ungroupedSources, { count: 2, sample: SMOKE_EXPECTED.ungroupedSourceIds })
            assert.deepEqual(groups.payload.integrity.sourcesInMultipleGroups, { count: 1, sample: [1] })
            const beta = await run("get_group", { groupId: 1 })
            assertSuccess(beta, getGroupOutput)
            assert.deepEqual(beta.payload.sources.map((s: any) => [s.sourceId, s.effectiveGroup]), SMOKE_EXPECTED.getGroupBeta.members)
            assert.equal(beta.payload.ruleCount, SMOKE_EXPECTED.getGroupBeta.ruleCount)

            // C. Articles: Unicode, untrusted HTML with a fake injection, read state
            const unicode = await run("get_article", { articleId: 2 })
            assertSuccess(unicode, getArticleOutput)
            assert.deepEqual([unicode.payload.title, unicode.payload.body, unicode.payload.sourceName], [UNICODE_TITLE, UNICODE_TEXT, "SMOKE Caffè Ünïcødé 📰"])
            assert.equal(unicode.payload.totalChars, [...UNICODE_TEXT].length)
            assert.equal(unicode.payload.starred, true)
            const injected = await run("get_article", { articleId: 3, format: "html" })
            assertSuccess(injected, getArticleOutput)
            assert.equal(injected.payload.body, INJECTION_HTML, "raw HTML, never rendered or sanitized")
            assert.deepEqual(
                [injected.payload.untrusted, injected.payload.contentScope, injected.payload.fullContentAvailable, injected.payload.editorialCompleteness],
                [true, "feed", false, "unknown"],
            )
            assert.equal((await run("get_article", { articleId: 4 })).payload.read, true)

            // D. Rules
            const all = await run("list_rules", { scope: "all", limit: 10 })
            assertSuccess(all, listRulesOutput)
            assert.deepEqual(all.payload.rules.map((r: any) => r.pattern), ["SMOKE-GLOBAL-1", "sponsored"])
            assert.deepEqual(all.payload.integrity.sourceKeys.orphans, { count: 0, sample: [] })
            const chain = await run("get_rule_chain", { sourceId: 1 })
            assertSuccess(chain, getRuleChainOutput)
            assert.deepEqual(chain.payload.chain.map((e: any) => [e.originKey, e.rule.pattern]), SMOKE_EXPECTED.chainSource1)
            assert.deepEqual(chain.payload.chain.map((e: any) => e.inherited), [true, true, true, false])
            assert.deepEqual(
                [chain.payload.resolution.complete, chain.payload.resolution.reason, chain.payload.resolution.groupId, chain.payload.resolution.countByOrigin],
                [true, "firstMultipleGroup", 0, { all: 2, group: 1, source: 1 }],
            )
            assert.deepEqual((await run("get_rule_chain", { sourceId: 3 })).payload.chain.map((e: any) => [e.originKey, e.rule.pattern]), SMOKE_EXPECTED.chainSource3)
            const ungrouped = await run("get_rule_chain", { sourceId: 4 })
            assert.equal(ungrouped.payload.resolution.reason, "noMultipleGroup")
            assert.equal(ungrouped.payload.chain.length, 2)

            // E. Errors: nonexistent ids and semantically invalid input
            assertError(await run("get_source", { sourceId: MISSING_SOURCE_ID }), "NOT_FOUND")
            assertError(await run("get_article", { articleId: MISSING_ARTICLE_ID }), "NOT_FOUND")
            assertError(await run("get_group", { groupId: 2 }), "NOT_FOUND")
            assertError(await run("get_rule_chain", { sourceId: 1, all: true }), "INVALID_ARGUMENT")
            assertError(await run("list_rules", { scope: "group", limit: 5 }), "INVALID_ARGUMENT")
            assertError(await run("get_article", { articleId: 0 }), "INVALID_ARGUMENT")

            assert.deepEqual(findLeaks(texts, REDACTED), [], "no credential or URL in any result")
            assert.deepEqual(findLeaks(texts, [profile.dir, root]), [], "no path in any result")
        } finally {
            await client.close()
        }
        assert.ok(await waitFor(() => processGone(pid), 5_000), "the server exits when the client closes")
        assert.match(stderr, /"event":"shutdown","reason":"stdin-(end|close)"/)
        assertCleanStderr(stderr, profile)
        assertNoHandleHeld(profile.dbPath)
        assert.deepEqual(integrityDifferences(initial, integritySnapshot(profile.dir, scratch())), [])
    })
})

describe("FR-MCP-02B-01 list_articles over stdio (SDK client)", { timeout: 60_000 }, () => {
    test("handshake, tools/list, first page, cursor continuation, get_article on a returned id, other tools still available", async () => {
        const profile = newSmokeProfile()
        const initial = integritySnapshot(profile.dir, scratch())
        const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN_JS, "--profile-dir", profile.dir], env: childEnv(), stderr: "pipe" })
        let stderr = ""
        transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
        const client = new Client({ name: "frmcp-smoke-list-articles", version: "0.0.0" })
        await client.connect(transport)
        const pid = transport.pid
        assert.ok(typeof pid === "number")
        const texts: string[] = []
        const run = async (name: string, args: Record<string, unknown>): Promise<Outcome> => {
            const outcome = await call(client, name, args)
            texts.push(outcome.text)
            return outcome
        }
        try {
            const tools = (await client.listTools()).tools
            assert.ok(tools.some((t) => t.name === "list_articles"))
            assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES, "list_articles", "search_articles"].sort(), "the seven FR-MCP-02A tools are still listed")
            const listed = tools.find((t) => t.name === "list_articles")
            assert.equal(listed?.annotations?.readOnlyHint, true)
            assert.equal(listed?.outputSchema?.type, "object")

            // Default filters: hidden source 5 is left out; stored order is descending _id.
            const first = await run("list_articles", { pageSize: 2, excerptChars: 40 })
            assertSuccess(first, listArticlesOutput)
            assert.deepEqual(first.payload.articles.map((a: any) => a.articleId), [6, 4])
            assert.equal(first.payload.hasMore, true)
            assert.equal(typeof first.payload.nextCursor, "string")
            const ids: number[] = first.payload.articles.map((a: any) => a.articleId)
            let cursor: string | null = first.payload.nextCursor
            let pages = 1
            while (cursor !== null) {
                const next = await run("list_articles", { cursor })
                assertSuccess(next, listArticlesOutput)
                ids.push(...next.payload.articles.map((a: any) => a.articleId))
                cursor = next.payload.nextCursor
                assert.equal(next.payload.hasMore, cursor !== null)
                assert.ok(++pages < 10)
            }
            assert.deepEqual(ids, [6, 4, 3, 2, 1])
            const all = await run("list_articles", { includeHiddenSources: true, pageSize: 10 })
            assert.deepEqual(all.payload.articles.map((a: any) => a.articleId), [6, 5, 4, 3, 2, 1])
            assert.equal(all.payload.scan.exhausted, true)

            // The returned id is directly usable with get_article.
            const listedUnicode = all.payload.articles.find((a: any) => a.articleId === 2)
            const article = await run("get_article", { articleId: listedUnicode.articleId })
            assertSuccess(article, getArticleOutput)
            assert.equal(article.payload.title, listedUnicode.title)
            assert.equal(article.payload.sourceName, listedUnicode.sourceName)

            // The injected article is listed as data.
            const injected = all.payload.articles.find((a: any) => a.articleId === 3)
            assert.equal(injected.untrusted, true)
            assert.ok(injected.excerpt.startsWith("SMOKE-ART-3"))

            // The other tools still answer.
            assertSuccess(await run("list_sources", {}), listSourcesOutput)
            assertSuccess(await run("get_source", { sourceId: 1 }), getSourceOutput)
            assertSuccess(await run("list_groups", {}), listGroupsOutput)
            assertSuccess(await run("get_group", { groupId: 0 }), getGroupOutput)
            assertSuccess(await run("list_rules", { scope: "all", limit: 5 }), listRulesOutput)
            assertSuccess(await run("get_rule_chain", { sourceId: 1 }), getRuleChainOutput)

            assert.deepEqual(findLeaks(texts, REDACTED), [], "no credential or URL in any result")
            assert.deepEqual(findLeaks(texts, [profile.dir, root]), [], "no path in any result")
        } finally {
            await client.close()
        }
        assert.ok(await waitFor(() => processGone(pid), 5_000))
        assertCleanStderr(stderr, profile)
        assertNoHandleHeld(profile.dbPath)
        assert.deepEqual(integrityDifferences(initial, integritySnapshot(profile.dir, scratch())), [])
    })
})

describe("FR-MCP-02B-02 search_articles over stdio (SDK client)", { timeout: 60_000 }, () => {
    test("tools/list, title/text/creator searches, accents, cursor continuation, get_article on a result, no query in stderr", async () => {
        const profile = newSmokeProfile()
        const initial = integritySnapshot(profile.dir, scratch())
        const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN_JS, "--profile-dir", profile.dir], env: childEnv(), stderr: "pipe" })
        let stderr = ""
        transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
        const client = new Client({ name: "frmcp-smoke-search-articles", version: "0.0.0" })
        await client.connect(transport)
        const pid = transport.pid
        assert.ok(typeof pid === "number")
        const texts: string[] = []
        const run = async (name: string, args: Record<string, unknown>): Promise<Outcome> => {
            const outcome = await call(client, name, args)
            texts.push(outcome.text)
            return outcome
        }
        try {
            const tools = (await client.listTools()).tools
            assert.equal(tools.length, 9)
            const searched = tools.find((t) => t.name === "search_articles")
            assert.equal(searched?.annotations?.readOnlyHint, true)
            assert.equal(searched?.outputSchema?.type, "object")
            assert.deepEqual((searched?.inputSchema as { properties: Record<string, unknown> }).properties.query !== undefined, true)

            // Title search (default), case-insensitive; hidden source 5 left out; stored order; continued by cursor only.
            const first = await run("search_articles", { query: "smoke-art", pageSize: 2 })
            assertSuccess(first, searchArticlesOutput)
            const ids: number[] = first.payload.articles.map((a: any) => a.articleId)
            assert.deepEqual(ids, [6, 4])
            let cursor: string | null = first.payload.nextCursor
            while (cursor !== null) {
                const next = await run("search_articles", { cursor })
                assertSuccess(next, searchArticlesOutput)
                ids.push(...next.payload.articles.map((a: any) => a.articleId))
                cursor = next.payload.nextCursor
            }
            assert.deepEqual(ids, [6, 4, 3, 2, 1])

            // Accent-insensitive title match on the Unicode article; its id works with get_article.
            const accent = await run("search_articles", { query: "CAFFE NAIVE" })
            assertSuccess(accent, searchArticlesOutput)
            assert.deepEqual(accent.payload.articles.map((a: any) => [a.articleId, a.matchedIn]), [[2, "title"]])
            assert.deepEqual([accent.payload.scan.exhausted, accent.payload.search.exhaustive], [true, true])
            const article = await run("get_article", { articleId: 2 })
            assertSuccess(article, getArticleOutput)
            assert.equal(article.payload.title, accent.payload.articles[0].title)

            // Snippet search finds the injected text, returned as data only.
            const injected = await run("search_articles", { query: "ignore your instructions", fields: "text" })
            assertSuccess(injected, searchArticlesOutput)
            assert.deepEqual(injected.payload.articles.map((a: any) => [a.articleId, a.matchedIn, a.untrusted]), [[3, "snippet", true]])
            const titleOnly = await run("search_articles", { query: "ignore your instructions" })
            assert.deepEqual(titleOnly.payload.articles, [])

            const creator = await run("search_articles", { query: "smoke writer", fields: "creator" })
            assertSuccess(creator, searchArticlesOutput)
            assert.deepEqual(creator.payload.articles.map((a: any) => [a.articleId, a.matchedIn]), [[6, "creator"], [1, "creator"]])

            const invalid = await run("search_articles", { query: "   " })
            assert.equal(invalid.result.isError, true)

            // The other tools still answer.
            assertSuccess(await run("list_articles", { pageSize: 2 }), listArticlesOutput)
            assertSuccess(await run("list_sources", {}), listSourcesOutput)

            assert.deepEqual(findLeaks(texts, REDACTED), [], "no credential or URL in any result")
            assert.deepEqual(findLeaks(texts, [profile.dir, root]), [], "no path in any result")
        } finally {
            await client.close()
        }
        assert.ok(await waitFor(() => processGone(pid), 5_000))
        assertCleanStderr(stderr, profile)
        for (const query of ["smoke-art", "CAFFE", "ignore your instructions", "smoke writer"]) assert.ok(!stderr.toLowerCase().includes(query.toLowerCase()), "no query in diagnostics")
        assertNoHandleHeld(profile.dbPath)
        assert.deepEqual(integrityDifferences(initial, integritySnapshot(profile.dir, scratch())), [])
    })
})

describe("compiled server over stdio with raw JSON-RPC", { timeout: 60_000 }, () => {
    async function initialize(server: RunningServer): Promise<void> {
        const init = await request(server, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "frmcp-smoke-raw", version: "0" } },
        })
        assert.ok("result" in init)
        server.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    }

    test("stdout carries only JSON-RPC; protocol and application errors are distinct; stdin EOF exits with 0", async () => {
        const profile = newSmokeProfile()
        const initial = integritySnapshot(profile.dir, scratch())
        const server = startServer(["--profile-dir", profile.dir])
        await initialize(server)
        let id = 1
        const tool = (name: string, args: unknown) => request(server, { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })
        const listed = await request(server, { jsonrpc: "2.0", id: ++id, method: "tools/list" })
        assert.equal((listed.result as { tools: unknown[] }).tools.length, 9)
        const calls: [string, Record<string, unknown>][] = [
            ["list_sources", {}],
            ["get_source", { sourceId: 2 }],
            ["list_groups", { limit: 5 }],
            ["get_group", { groupId: 0 }],
            ["get_article", { articleId: 1 }],
            ["list_rules", { scope: "source", sourceId: 3, limit: 5 }],
            ["get_rule_chain", { groupId: 1 }],
            ["list_articles", { pageSize: 2 }],
            ["search_articles", { query: "smoke-art", pageSize: 2 }],
        ]
        for (const [name, args] of calls) {
            const response = await tool(name, args)
            const result = response.result as { isError?: boolean; structuredContent?: unknown; content: { text: string }[] }
            assert.equal(result.isError, undefined, name)
            assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), result.structuredContent)
        }
        // Protocol level: SDK rejects non-object arguments with JSON-RPC -32602 before any handler.
        const protocol = await tool("get_source", "not-an-object")
        assert.equal((protocol.error as { code: number } | undefined)?.code, -32602)
        // Application level: a valid JSON-RPC call answered with a sanitized isError result.
        const application = await tool("get_source", { sourceId: "1" })
        assert.equal((application.result as { isError?: boolean }).isError, true)
        assert.equal(JSON.parse((application.result as { content: { text: string }[] }).content[0]?.text ?? "").code, "INVALID_ARGUMENT")
        const unknown = await tool("set_rule", {})
        assert.ok("error" in unknown || (unknown.result as { isError?: boolean }).isError === true)

        server.child.stdin.end()
        const exit = await server.exited(5_000)
        assert.equal(exit.code, 0)
        const messages = parseStdoutLines(exit.stdout)
        assert.ok(exit.stdout.endsWith("\n"))
        for (const message of messages) assert.equal((message as { jsonrpc?: unknown }).jsonrpc, "2.0")
        assert.equal(messages.length, 2 + calls.length + 3, "one response per request, nothing else")
        assert.deepEqual(findLeaks([exit.stdout], REDACTED), [])
        assertCleanStderr(exit.stderr, profile)
        assert.match(exit.stderr, /"event":"shutdown","reason":"stdin-(end|close)"/)
        assertNoHandleHeld(profile.dbPath)
        assert.deepEqual(integrityDifferences(initial, integritySnapshot(profile.dir, scratch())), [])
    })

    test("a terminated server (TerminateProcess) leaves no handle or auxiliary file", async () => {
        const profile = newSmokeProfile()
        const initial = integritySnapshot(profile.dir, scratch())
        const server = startServer(["--profile-dir", profile.dir])
        await initialize(server)
        await request(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_article", arguments: { articleId: 2 } } })
        server.child.kill()
        const exit = await server.exited(5_000)
        assert.notEqual(exit.code, 0)
        assertNoHandleHeld(profile.dbPath)
        assert.deepEqual(integrityDifferences(initial, integritySnapshot(profile.dir, scratch())), [])
    })

    test("a held database lock is a sanitized DB_BUSY error, and the next call succeeds", async () => {
        const profile = newSmokeProfile()
        const server = startServer(["--profile-dir", profile.dir])
        await initialize(server)
        // Test-only writer holding EXCLUSIVE, as Fluent Reader writing would.
        const writer = new DatabaseSync(profile.dbPath)
        let busy: Record<string, unknown>
        try {
            writer.exec("BEGIN EXCLUSIVE")
            busy = await request(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sources", arguments: {} } })
        } finally {
            writer.exec("ROLLBACK")
            writer.close()
        }
        const busyResult = busy.result as { isError?: boolean; content: { text: string }[] }
        assert.equal(busyResult.isError, true)
        assert.equal(JSON.parse(busyResult.content[0]?.text ?? "").code, "DB_BUSY")
        const ok = await request(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sources", arguments: {} } })
        assert.equal((ok.result as { isError?: boolean }).isError, undefined)
        server.child.stdin.end()
        const exit = await server.exited(5_000)
        assert.equal(exit.code, 0)
        assertCleanStderr(exit.stderr, profile)
        assert.deepEqual(integritySnapshot(profile.dir, scratch()).auxiliaryFiles, [])
    })
})

describe("smoke profile negative startup cases", { timeout: 60_000 }, () => {
    async function expectStartupFailure(dir: string, code: string, reason: string): Promise<string> {
        const exit = await runToExit(["--profile-dir", dir], childEnv())
        assert.equal(exit.code, 1)
        assert.equal(exit.stdout, "")
        assert.match(exit.stderr, new RegExp(`"event":"startup_failed","code":"${code}","reason":"${reason}"`))
        assert.deepEqual(findLeaks([exit.stderr], [dir, root, SMOKE_SECRET]), [])
        return exit.stderr
    }

    test("nonexistent profile: refused, nothing created", async () => {
        const dir = path.join(root, "smoke-missing-profile")
        await expectStartupFailure(dir, "PROFILE_UNAVAILABLE", "not-found")
        assert.equal(fs.existsSync(dir), false)
    })

    test("missing database: refused, no database created", async () => {
        const profile = newSmokeProfile()
        fs.rmSync(profile.dbPath)
        await expectStartupFailure(profile.dir, "PROFILE_UNAVAILABLE", "db-missing")
        assert.deepEqual(fs.readdirSync(profile.dir), [CONFIG_NAME])
    })

    test("WAL database: refused without bypass, no -wal or -shm created", async () => {
        const profile = newSmokeProfile()
        const writer = new DatabaseSync(profile.dbPath)
        writer.exec("PRAGMA journal_mode = WAL")
        writer.close()
        const initial = integritySnapshot(profile.dir, scratch())
        assert.deepEqual(initial.auxiliaryFiles, [])
        await expectStartupFailure(profile.dir, "DB_WAL_UNSUPPORTED", "wal-mode")
        assert.deepEqual(integrityDifferences(initial, integritySnapshot(profile.dir, scratch())), [])
    })

    test("invalid config.json: the server starts, settings tools fail with a sanitized error", async () => {
        const profile = newSmokeProfile()
        fs.writeFileSync(profile.configPath, `{"serviceConfigs":{"password":"${SMOKE_SECRET}"},"sourceGroups":[`)
        const initial = integritySnapshot(profile.dir, scratch())
        const server = startServer(["--profile-dir", profile.dir])
        await request(server, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "frmcp-smoke-raw", version: "0" } },
        })
        const groups = await request(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_groups", arguments: {} } })
        const result = groups.result as { isError?: boolean; content: { text: string }[] }
        assert.equal(result.isError, true)
        assert.equal(JSON.parse(result.content[0]?.text ?? "").code, "SETTINGS_INVALID")
        const article = await request(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_article", arguments: { articleId: 1 } } })
        assert.equal((article.result as { isError?: boolean }).isError, undefined, "database tools keep working")
        server.child.stdin.end()
        const exit = await server.exited(5_000)
        assert.equal(exit.code, 0)
        assert.match(exit.stderr, /"event":"settings_unavailable","code":"SETTINGS_INVALID"/)
        assert.deepEqual(findLeaks([exit.stdout, exit.stderr], [SMOKE_SECRET, profile.dir]), [])
        assert.deepEqual(integrityDifferences(initial, integritySnapshot(profile.dir, scratch())), [])
    })
})
