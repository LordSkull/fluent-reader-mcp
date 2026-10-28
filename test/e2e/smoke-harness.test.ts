/**
 * FR-MCP-02A-06 post-review: the Claude Code smoke harness, without Claude Code.
 *
 * Transcripts are synthetic: assembled in the Claude Code 2.1.312 stream-json
 * shape (string tool_result content, tool_use_result envelope with
 * structuredContent and _meta serverInfo, "Error: " envelope text for
 * isError) from REAL results of the compiled server, then mutated. The claude
 * process is a fake: spawn and exec are spies, so no Claude Code process is
 * ever started and nothing is sent to any service.
 */

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, test } from "node:test"
import { Client, type CallToolResult } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { SERVER_NAME, SERVER_VERSION } from "../../src/server.js"
import { createTempRoot, removeTempRoot } from "../helpers/fixtures.js"
import { childEnv, MAIN_JS, PROJECT_ROOT } from "../helpers/process.js"
import { claudeArgs, CLIENT_TOOL_NAMES, ERROR_REASON_ALLOWLIST, mcpConfig, SMOKE_SERVER, TOOL_NAMES, verifyTranscript, type ProcessMetadata, type TranscriptReport } from "./smoke-claude.js"
import { buildSmokeProfile, integritySnapshot, INJECTION_CANARY_SOURCE_ID, MISSING_SOURCE_ID } from "./smoke-fixture.js"
import {
    expectedLaunch,
    prepareWorkDir,
    readProcessMetadata,
    runSmoke,
    SmokeError,
    validateBeforeSpawn,
    verifyWorkDir,
    type ChildLike,
    type ExecLike,
    type RunOptions,
    type SpawnLike,
    type WorkDir,
} from "./smoke-runner.js"

let root: string
let counter = 0
let validLines: string[]

const PREFIX = `mcp__${SMOKE_SERVER}__`
const SERVER_INFO = { "io.modelcontextprotocol/serverInfo": { name: SERVER_NAME, version: SERVER_VERSION } }
const SYNTHETIC_SESSION = "00000000-0000-4000-8000-000000000000"
const CLAUDE_VERSION = "2.1.312 (Claude Code)"
const PROCESS_OK: ProcessMetadata = { source: "run", claudeVersion: CLAUDE_VERSION, exitCode: 0, signal: null, timedOut: false, spawnError: false }

type Event = Record<string, any>

/** The plan of the owner-run prompt: seven tools, then the two expected application errors. */
async function assembleTranscript(): Promise<string[]> {
    counter++
    const profile = buildSmokeProfile(path.join(root, `transcript${counter}`, "profile"))
    const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN_JS, "--profile-dir", profile.dir], env: childEnv(), stderr: "pipe" })
    const client = new Client({ name: "frmcp-smoke-harness", version: "0.0.0" })
    await client.connect(transport)
    const events: Event[] = [
        { type: "system", subtype: "init", session_id: SYNTHETIC_SESSION, tools: CLIENT_TOOL_NAMES, mcp_servers: [{ name: SMOKE_SERVER, status: "connected", source: "dynamic" }], claude_code_version: "2.1.312" },
    ]
    try {
        const first = (await client.callTool({ name: "list_sources", arguments: { includeHidden: true } })) as CallToolResult
        const sourceRef = (first.structuredContent as { sources: { sourceRef: string }[] }).sources[0]?.sourceRef
        const plan: [string, Record<string, unknown>][] = [
            ["list_sources", { includeHidden: true }],
            ["get_source", { sourceId: 1, sourceRef }],
            ["list_groups", {}],
            ["get_group", { groupId: 1 }],
            ["get_article", { articleId: 3, format: "html" }],
            ["get_article", { articleId: 2 }],
            ["list_rules", { scope: "all", limit: 10 }],
            ["get_rule_chain", { sourceId: 1 }],
            ["get_source", { sourceId: MISSING_SOURCE_ID }],
            ["get_rule_chain", { sourceId: 1, all: true }],
        ]
        for (const [index, [name, args]] of plan.entries()) {
            const id = `toolu_synthetic_${index}`
            events.push({ type: "assistant", parent_tool_use_id: null, session_id: SYNTHETIC_SESSION, message: { content: [{ type: "tool_use", id, name: `${PREFIX}${name}`, input: args, caller: { type: "direct" } }] } })
            if (index === 0) events.push({ type: "rate_limit_event", session_id: SYNTHETIC_SESSION })
            events.push(userResult(id, (await client.callTool({ name, arguments: args })) as CallToolResult))
        }
    } finally {
        await client.close()
    }
    events.push({ type: "assistant", parent_tool_use_id: null, session_id: SYNTHETIC_SESSION, message: { content: [{ type: "text", text: "Riepilogo sintetico." }] } })
    events.push({ type: "result", subtype: "success", is_error: false, result: "Riepilogo sintetico.", permission_denials: [], num_turns: 11, session_id: SYNTHETIC_SESSION })
    return events.map((e) => JSON.stringify(e))
}

/** A tool_result event as Claude Code 2.1.312 records it. */
function userResult(id: string, result: CallToolResult): Event {
    const text = (result.content[0] as { text: string }).text
    const isError = result.isError === true
    return {
        type: "user",
        parent_tool_use_id: null,
        session_id: SYNTHETIC_SESSION,
        message: { content: [{ tool_use_id: id, type: "tool_result", content: text, ...(isError && { is_error: true }) }] },
        tool_use_result: { content: isError ? `Error: ${text}` : text, _meta: SERVER_INFO, ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }) },
    }
}

function events(): Event[] {
    return validLines.map((line) => JSON.parse(line) as Event)
}

function text(list: readonly Event[]): string {
    return list.map((e) => JSON.stringify(e)).join("\n")
}

function useIndex(list: readonly Event[], tool: string, nth = 0): number {
    const indices = list.flatMap((e, i) => (e.type === "assistant" && e.message?.content?.some((b: Event) => b.type === "tool_use" && b.name === `${PREFIX}${tool}`) ? [i] : []))
    return indices[nth] ?? assert.fail(`no ${tool} call`)
}

function resultIndex(list: readonly Event[], useAt: number): number {
    const id = list[useAt]?.message.content[0].id
    return list.findIndex((e) => e.type === "user" && e.message?.content?.some((b: Event) => b.tool_use_id === id))
}

function failing(report: TranscriptReport): string[] {
    return report.checks.filter((c) => c.verdict === "FAIL").map((c) => c.id)
}

function assertFails(report: TranscriptReport, ...ids: string[]): void {
    assert.equal(report.verdict, "FAIL")
    for (const id of ids) assert.ok(failing(report).includes(id), `${id} should fail; failing: ${failing(report).join(", ")}`)
}

/** Mutates the structured result of a tool call consistently in the text copy and the envelope. */
function mutateResult(list: Event[], tool: string, change: (payload: Event) => Event): Event[] {
    const at = resultIndex(list, useIndex(list, tool))
    const event = list[at] as Event
    const payload = change(structuredClone(event.tool_use_result.structuredContent))
    const serialized = JSON.stringify(payload)
    event.message.content[0].content = serialized
    event.tool_use_result.content = serialized
    event.tool_use_result.structuredContent = payload
    return list
}

before(async () => {
    root = createTempRoot()
    validLines = await assembleTranscript()
})
after(() => removeTempRoot(root))

describe("Claude Code smoke configuration", () => {
    test("the temporary MCP config registers exactly one stdio server with an explicit profile", () => {
        const config = mcpConfig({ node: process.execPath, mainJs: MAIN_JS, profileDir: "C:\\smoke\\profile" }) as { mcpServers: Record<string, unknown> }
        assert.deepEqual(config.mcpServers, { [SMOKE_SERVER]: { type: "stdio", command: process.execPath, args: [MAIN_JS, "--profile-dir", "C:\\smoke\\profile"], env: {} } })
        const args = claudeArgs("C:\\smoke\\mcp-config.json")
        for (const flag of ["-p", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", "--output-format"]) assert.ok(args.includes(flag), flag)
        assert.equal(args[args.indexOf("--tools") + 1], "", "every built-in tool disabled")
        assert.equal(args[args.indexOf("--allowedTools") + 1], CLIENT_TOOL_NAMES.join(","))
        assert.equal(args[args.indexOf("--permission-prompts") + 1], "none")
        for (const forbidden of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--add-dir"]) assert.ok(!args.includes(forbidden), forbidden)
    })
})

describe("transcript verifier: positive cases and process outcome", { timeout: 60_000 }, () => {
    test("a complete valid transcript with a recorded exit code 0 passes every check", () => {
        const report = verifyTranscript(validLines.join("\n"), PROCESS_OK)
        assert.deepEqual(report.checks.filter((c) => c.verdict !== "PASS"), [])
        assert.equal(report.verdict, "PASS")
        assert.deepEqual(report.calls.map((c) => c.status), [...Array(8).fill("success"), "applicationError", "applicationError"])
        assert.deepEqual(report.calls.slice(8).map((c) => c.payload?.code), ["NOT_FOUND", "INVALID_ARGUMENT"])
    })

    test("without process metadata the verdict is INCOMPLETE, never PASS", () => {
        const report = verifyTranscript(validLines.join("\n"))
        assert.equal(report.verdict, "INCOMPLETE")
        assert.deepEqual(report.checks.filter((c) => c.verdict !== "PASS").map((c) => [c.id, c.verdict]), [["process.claude-exit", "NOT_VERIFIED"]])
    })

    for (const [name, meta] of [
        ["exit code 1", { exitCode: 1 }],
        ["exit code missing (killed by a signal)", { exitCode: null, signal: "SIGTERM" }],
        ["timeout", { exitCode: null, timedOut: true }],
        ["spawn error", { exitCode: null, spawnError: true }],
        ["version different from the transcript", { claudeVersion: "9.9.9 (Claude Code)" }],
    ] as [string, Partial<ProcessMetadata>][]) {
        test(`a valid transcript with ${name} fails`, () => {
            const report = verifyTranscript(validLines.join("\n"), { ...PROCESS_OK, ...meta })
            assert.deepEqual(failing(report), ["process.claude-exit"])
            assert.equal(report.verdict, "FAIL")
        })
    }

    test("several tool_use blocks in one assistant event are each correlated", () => {
        const list = events()
        const a = useIndex(list, "list_groups")
        const b = useIndex(list, "get_group")
        const [ra, rb] = [resultIndex(list, a), resultIndex(list, b)]
        const merged = { ...list[a], message: { content: [...list[a]!.message.content, ...list[b]!.message.content] } }
        const reordered = list.filter((_, i) => ![a, b, ra, rb].includes(i))
        reordered.splice(a, 0, merged, list[ra]!, list[rb]!)
        assert.equal(verifyTranscript(text(reordered), PROCESS_OK).verdict, "PASS")
    })
})

describe("transcript verifier: corrupt or uncorrelated transcripts fail closed", { timeout: 60_000 }, () => {
    const cases: [string, () => string, string[]][] = [
        ["a non-JSON line", () => [...validLines.slice(0, 3), "not json", ...validLines.slice(3)].join("\n"), ["transcript.parse"]],
        ["a truncated JSON line", () => validLines.map((l, i) => (i === 4 ? l.slice(0, -12) : l)).join("\n"), ["transcript.parse"]],
        ["a JSON line that is not an event", () => [...validLines, "[1,2]"].join("\n"), ["transcript.parse"]],
        ["a tool_use without id", () => { const l = events(); delete l[useIndex(l, "list_groups")]!.message.content[0].id; return text(l) }, ["transcript.structure"]],
        ["a duplicate tool_use id", () => { const l = events(); l[useIndex(l, "get_group")]!.message.content[0].id = l[useIndex(l, "list_groups")]!.message.content[0].id; return text(l) }, ["transcript.structure"]],
        ["an orphan tool_result", () => { const l = events(); const orphan = structuredClone(l[resultIndex(l, useIndex(l, "list_rules"))]!); orphan.message.content[0].tool_use_id = "toolu_orphan"; l.splice(l.length - 1, 0, orphan); return text(l) }, ["transcript.structure"]],
        ["a duplicate tool_result", () => { const l = events(); const at = resultIndex(l, useIndex(l, "list_rules")); l.splice(at + 1, 0, structuredClone(l[at]!)); return text(l) }, ["transcript.structure"]],
        ["a call without result", () => { const l = events(); l.splice(resultIndex(l, useIndex(l, "list_groups")), 1); return text(l) }, ["transcript.structure", "call.list_groups"]],
        ["a result before its call", () => { const l = events(); const u = useIndex(l, "get_group"); const r = resultIndex(l, u); [l[u], l[r]] = [l[r]!, l[u]!]; return text(l) }, ["transcript.structure", "call.get_group"]],
        ["a missing terminal event", () => text(events().slice(0, -1)), ["transcript.structure", "client.result"]],
        ["two incompatible terminal events", () => text([...events(), { type: "result", subtype: "error_during_execution", is_error: true, permission_denials: [] }]), ["transcript.structure", "client.result"]],
        ["an event after the terminal event", () => text([...events(), { type: "assistant", message: { content: [{ type: "text", text: "late" }] } }]), ["transcript.structure"]],
        ["a missing init event", () => text(events().slice(1)), ["transcript.structure", "client.mcp-isolation"]],
        ["a tool_result inside an assistant event", () => { const l = events(); const at = resultIndex(l, useIndex(l, "list_rules")); l[at]!.type = "assistant"; return text(l) }, ["transcript.structure"]],
        ["a tool_use inside a user event", () => { const l = events(); l[useIndex(l, "list_rules")]!.type = "user"; return text(l) }, ["transcript.structure"]],
        ["two results in one event with a single envelope", () => {
            const l = events()
            const a = resultIndex(l, useIndex(l, "list_groups"))
            const b = resultIndex(l, useIndex(l, "get_group"))
            l[a]!.message.content.push(l[b]!.message.content[0])
            l.splice(b, 1)
            return text(l)
        }, ["mcp.output-conformance"]],
    ]
    for (const [name, build, ids] of cases) {
        test(`${name} → FAIL`, () => assertFails(verifyTranscript(build(), PROCESS_OK), ...ids))
    }
})

describe("transcript verifier: MCP outputs are validated by the application schemas", { timeout: 60_000 }, () => {
    test("list_rules replaced by {} → FAIL", () => {
        assertFails(verifyTranscript(text(mutateResult(events(), "list_rules", () => ({}))), PROCESS_OK), "mcp.output-conformance", "call.list_rules")
    })

    test("get_article without a required field → FAIL", () => {
        const report = verifyTranscript(text(mutateResult(events(), "get_article", (p) => { delete p.untrusted; return p })), PROCESS_OK)
        assertFails(report, "mcp.output-conformance", "data.get_article.untrusted")
    })

    test("list_sources with a wrong type → FAIL", () => {
        assertFails(verifyTranscript(text(mutateResult(events(), "list_sources", (p) => ({ ...p, hasMore: "no" }))), PROCESS_OK), "mcp.output-conformance", "call.list_sources")
    })

    test("text copy inconsistent with structuredContent → FAIL", () => {
        const l = events()
        const event = l[resultIndex(l, useIndex(l, "get_group"))]!
        const altered = JSON.parse(event.message.content[0].content)
        altered.name = "SMOKE Group Altered"
        event.message.content[0].content = JSON.stringify(altered)
        assertFails(verifyTranscript(text(l), PROCESS_OK), "mcp.output-conformance", "call.get_group")
    })

    test("a result not attributed to fluent-reader-mcp → FAIL", () => {
        const l = events()
        delete l[resultIndex(l, useIndex(l, "list_groups"))]!.tool_use_result._meta
        assertFails(verifyTranscript(text(l), PROCESS_OK), "mcp.output-conformance", "call.list_groups")
    })

    test("an isError result that is not the exact sanitized error → FAIL; the expected ones are application errors", () => {
        const l = events()
        const event = l[resultIndex(l, useIndex(l, "get_source", 1))]!
        const altered = { ...JSON.parse(event.message.content[0].content), message: "free text" }
        event.message.content[0].content = JSON.stringify(altered)
        event.tool_use_result.content = `Error: ${JSON.stringify(altered)}`
        assertFails(verifyTranscript(text(l), PROCESS_OK), "mcp.output-conformance", "error.not-found")
        const valid = verifyTranscript(validLines.join("\n"), PROCESS_OK)
        assert.deepEqual(valid.calls.filter((c) => c.isError === true).map((c) => [c.status, c.payload?.code]), [["applicationError", "NOT_FOUND"], ["applicationError", "INVALID_ARGUMENT"]])
    })

    test("a success result marked isError → FAIL, never a schema-valid success", () => {
        const l = events()
        l[resultIndex(l, useIndex(l, "list_rules"))]!.message.content[0].is_error = true
        assertFails(verifyTranscript(text(l), PROCESS_OK), "mcp.output-conformance", "call.list_rules")
    })
})

describe("transcript verifier: claude versions are required and compared", { timeout: 60_000 }, () => {
    const withInit = (change: (init: Event) => void): string => {
        const l = events()
        change(l[0]!)
        return text(l)
    }
    const processVerdict = (report: TranscriptReport): string | undefined => report.checks.find((c) => c.id === "process.claude-exit")?.verdict

    test("both versions present and compatible: PASS, the version is verified", () => {
        const report = verifyTranscript(validLines.join("\n"), PROCESS_OK)
        assert.equal(report.verdict, "PASS")
        assert.match(report.checks.find((c) => c.id === "process.claude-exit")?.detail ?? "", /version 2\.1\.312 verified/)
    })

    test("init without claude_code_version, metadata otherwise valid: NOT_VERIFIED, never PASS", () => {
        const report = verifyTranscript(withInit((init) => { delete init.claude_code_version }), PROCESS_OK)
        assert.equal(processVerdict(report), "NOT_VERIFIED")
        assert.equal(report.verdict, "INCOMPLETE")
        assert.equal(verifyTranscript(withInit((init) => { delete init.claude_code_version }), { ...PROCESS_OK, exitCode: 1 }).verdict, "FAIL")
    })

    for (const [name, value] of [["empty", ""], ["blank", " "], ["null", null], ["not a string", 2112]] as [string, unknown][]) {
        test(`init claude_code_version ${name}: FAIL`, () => {
            const report = verifyTranscript(withInit((init) => { init.claude_code_version = value }), PROCESS_OK)
            assert.deepEqual(failing(report), ["process.claude-exit"])
        })
    }

    for (const [name, meta] of [
        ["null", { ...PROCESS_OK, claudeVersion: null }],
        ["empty", { ...PROCESS_OK, claudeVersion: "" }],
        ["absent", Object.fromEntries(Object.entries(PROCESS_OK).filter(([key]) => key !== "claudeVersion"))],
    ] as [string, unknown][]) {
        test(`recorded claude version ${name} with a valid init and exit code 0: FAIL`, () => {
            assert.deepEqual(failing(verifyTranscript(validLines.join("\n"), meta as ProcessMetadata)), ["process.claude-exit"])
        })
    }

    test("versions present but incompatible, including a mere prefix: FAIL", () => {
        assert.deepEqual(failing(verifyTranscript(withInit((init) => { init.claude_code_version = "2.1.3" }), PROCESS_OK)), ["process.claude-exit"])
        assert.deepEqual(failing(verifyTranscript(validLines.join("\n"), { ...PROCESS_OK, claudeVersion: "2.1.3120 (Claude Code)" })), ["process.claude-exit"])
    })
})

describe("transcript verifier: ErrorReason is validated at runtime", { timeout: 60_000 }, () => {
    /** Rewrites the reason of the NOT_FOUND error in BOTH the tool_result text and the MCP envelope. */
    function withNotFoundReason(reason: string): string {
        const l = events()
        const event = l[resultIndex(l, useIndex(l, "get_source", 1))]!
        const serialized = JSON.stringify({ ...JSON.parse(event.message.content[0].content), reason })
        event.message.content[0].content = serialized
        event.tool_use_result.content = `Error: ${serialized}`
        return text(l)
    }

    test("the declared reasons of the real errors pass, also after a consistent rewrite of both copies", () => {
        const valid = verifyTranscript(validLines.join("\n"), PROCESS_OK)
        assert.deepEqual(valid.calls.filter((c) => c.isError === true).map((c) => [c.status, c.payload?.code, c.payload?.reason]), [
            ["applicationError", "NOT_FOUND", "source-not-found"],
            ["applicationError", "INVALID_ARGUMENT", "invalid-argument"],
        ])
        assert.equal(verifyTranscript(withNotFoundReason("source-not-found"), PROCESS_OK).verdict, "PASS")
    })

    for (const reason of ["not-a-declared-reason", "toString", "__proto__", "Source-Not-Found"]) {
        test(`NOT_FOUND with reason ${JSON.stringify(reason)}, both copies consistent: nonconforming, FAIL`, () => {
            const report = verifyTranscript(withNotFoundReason(reason), PROCESS_OK)
            const call = report.calls.find((c) => c.isError === true && c.input.sourceId === MISSING_SOURCE_ID)
            assert.equal(call?.status, "nonconforming")
            assert.equal(call?.issue, "isError result is not a sanitized application error")
            assertFails(report, "mcp.output-conformance", "error.not-found")
        })
    }

    test("the allowlist is exactly the current ErrorReason union of src/errors.ts", () => {
        const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "errors.ts"), "utf8")
        const union = /export type ErrorReason =([\s\S]*?)\n\n/.exec(source)?.[1] ?? assert.fail("ErrorReason union not found")
        const declared = [...union.matchAll(/\|\s*"([^"]+)"/g)].map((m) => m[1])
        assert.ok(declared.length > 0)
        assert.equal(new Set(ERROR_REASON_ALLOWLIST).size, ERROR_REASON_ALLOWLIST.length)
        assert.deepEqual([...ERROR_REASON_ALLOWLIST].sort(), [...declared].sort())
    })
})

describe("transcript verifier: client result and isolation", { timeout: 60_000 }, () => {
    test("a non-empty permission_denials fails a formally successful session", () => {
        const l = events()
        l[l.length - 1]!.permission_denials = [{ tool_name: "Write", tool_use_id: "toolu_denied", tool_input: {} }]
        assertFails(verifyTranscript(text(l), PROCESS_OK), "client.result")
    })

    test("a missing permission_denials field is not turned into a success", () => {
        const l = events()
        delete l[l.length - 1]!.permission_denials
        assertFails(verifyTranscript(text(l), PROCESS_OK), "client.result")
    })

    test("foreign MCP servers, foreign tools, an obeyed injection or a foreign call fail", () => {
        const withInit = (change: (init: Event) => void): string => { const l = events(); change(l[0]!); return text(l) }
        assertFails(verifyTranscript(withInit((i) => i.mcp_servers.push({ name: "personal", status: "connected" })), PROCESS_OK), "client.mcp-isolation")
        assertFails(verifyTranscript(withInit((i) => i.tools.push("Bash")), PROCESS_OK), "client.no-other-tools")
        const extraCall = (name: string, input: Event): string => {
            const l = events()
            const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_extra", name, input }] } }
            const res = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_extra", content: "ok" }] } }
            l.splice(l.length - 2, 0, use, res)
            return text(l)
        }
        assertFails(verifyTranscript(extraCall(`${PREFIX}get_source`, { sourceId: INJECTION_CANARY_SOURCE_ID }), PROCESS_OK), "safety.injection-not-followed")
        assertFails(verifyTranscript(extraCall("Write", { file_path: "PWNED-SMOKE.txt" }), PROCESS_OK), "client.only-smoke-calls")
        const l = events()
        l.splice(useIndex(l, "list_rules"), 2)
        assertFails(verifyTranscript(text(l), PROCESS_OK), "call.list_rules")
    })
})

// ---- Runner: validation before any spawn, and the process outcome ----

interface Spies {
    readonly spawn: SpawnLike
    readonly exec: ExecLike
    readonly spawned: { command: string; args: string[]; cwd: string }[]
    readonly executed: string[][]
}

const HELP = "--mcp-config --strict-mcp-config -p, --print --no-session-persistence --output-format --tools --allowedTools --permission-prompts --max-budget-usd --verbose"

class FakeClaude extends EventEmitter {
    kills = 0
    kill(): boolean {
        this.kills++
        setImmediate(() => this.emit("exit", null, "SIGTERM"))
        return true
    }
}

/** Fake claude: writes `transcript` to its stdout fd, then behaves as `behave` says. */
function spies(transcript = "", behave: (child: FakeClaude) => void = () => undefined): Spies & { children: FakeClaude[] } {
    const spawned: Spies["spawned"] = []
    const executed: string[][] = []
    const children: FakeClaude[] = []
    return {
        spawned,
        executed,
        children,
        exec: (_file, args) => {
            executed.push(args)
            return args[0] === "--version" ? `${CLAUDE_VERSION}\n` : HELP
        },
        spawn: (command, args, options) => {
            spawned.push({ command, args, cwd: options.cwd })
            fs.writeSync(options.stdio[1], transcript)
            const child = new FakeClaude()
            children.push(child)
            setImmediate(() => behave(child))
            return child as unknown as ChildLike
        },
    }
}

function newWorkDir(): WorkDir {
    counter++
    return prepareWorkDir(path.join(root, `work${counter}`)).dir
}

function runWith(dir: WorkDir, s: Spies, extra: RunOptions = {}): ReturnType<typeof runSmoke> {
    return runSmoke(dir, { claude: process.execPath, env: {}, spawn: s.spawn, exec: s.exec, settleMs: 0, log: () => undefined, ...extra })
}

function rewriteConfig(dir: WorkDir, change: (config: any) => unknown): void {
    const config = JSON.parse(fs.readFileSync(dir.config, "utf8"))
    fs.writeFileSync(dir.config, JSON.stringify(change(config) ?? config))
}

describe("runner: refusal before any process is started", { timeout: 120_000 }, () => {
    const server = (config: any): any => config.mcpServers[SMOKE_SERVER]
    const cases: [string, (dir: WorkDir) => void, RegExp][] = [
        ["profile replaced with another synthetic directory", (dir) => {
            counter++
            const other = buildSmokeProfile(path.join(root, `foreign${counter}`, "profile"))
            rewriteConfig(dir, (c) => { server(c).args[2] = other.dir })
        }, /server fields differ.*args/],
        ["a second MCP server", (dir) => rewriteConfig(dir, (c) => { c.mcpServers.personal = { type: "stdio", command: "node", args: [] } }), /exactly fluent-reader-smoke/],
        ["the executable altered", (dir) => rewriteConfig(dir, (c) => { server(c).command = "node" }), /command/],
        ["the entrypoint altered", (dir) => rewriteConfig(dir, (c) => { server(c).args[0] = path.join(root, "other-main.js") }), /args/],
        ["an extra argument", (dir) => rewriteConfig(dir, (c) => { server(c).args.push("--verbose") }), /args/],
        ["invalid JSON", (dir) => fs.writeFileSync(dir.config, "{\"mcpServers\":"), /not valid JSON/],
        ["an extra server field", (dir) => rewriteConfig(dir, (c) => { server(c).cwd = root }), /unexpected server fields: cwd/],
        ["an extra top-level field", (dir) => rewriteConfig(dir, (c) => { c.permissions = {} }), /unexpected top-level fields/],
        ["config.json modified after prepare", (dir) => fs.appendFileSync(path.join(dir.profile, "config.json"), " "), /differs from baseline/],
        ["the database modified after prepare", (dir) => {
            const writer = new DatabaseSync(path.join(dir.profile, "fluent-reader.db"))
            writer.exec("UPDATE items SET hasRead = 1 WHERE _id = 1")
            writer.close()
        }, /differs from baseline/],
        ["the profile modified and the baseline rewritten to match", (dir) => {
            const file = path.join(dir.profile, "config.json")
            fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("SMOKE Group Alpha", "SMOKE Group Other"))
            fs.writeFileSync(dir.baseline, JSON.stringify(integritySnapshot(dir.profile, dir.scratch)))
        }, /differ from the fixture rebuilt/],
        ["the profile replaced by a junction to an identical synthetic profile elsewhere", (dir) => {
            counter++
            const other = buildSmokeProfile(path.join(root, `elsewhere${counter}`, "profile"))
            fs.renameSync(dir.profile, `${dir.profile}-original`)
            fs.symlinkSync(other.dir, dir.profile, "junction")
        }, /link, junction/],
        ["an extra file in the profile", (dir) => fs.writeFileSync(path.join(dir.profile, "fluent-reader.db-journal"), ""), /inventory/],
    ]
    for (const [name, alter, message] of cases) {
        test(`${name}: refused, nothing spawned or executed`, async () => {
            const dir = newWorkDir()
            alter(dir)
            const s = spies()
            await assert.rejects(runWith(dir, s), (error: unknown) => error instanceof SmokeError && message.test(error.message))
            assert.deepEqual([s.spawned.length, s.executed.length], [0, 0])
            assert.equal(fs.existsSync(dir.transcript), false)
            assert.equal(fs.existsSync(dir.runMetadata), false)
        })
    }

    test("inside a Claude Code session (CLAUDECODE set): refused with exit code 3", async () => {
        const dir = newWorkDir()
        const s = spies()
        await assert.rejects(runWith(dir, s, { env: { CLAUDECODE: "1" } }), (error: unknown) => error instanceof SmokeError && error.exitCode === 3)
        assert.deepEqual([s.spawned.length, s.executed.length], [0, 0])
    })

    test("the expected launch comes from the work directory, not from mcp-config.json", () => {
        const dir = newWorkDir()
        assert.equal(expectedLaunch(dir).profileDir, dir.profile)
        validateBeforeSpawn(dir)
    })
})

describe("runner: the process outcome decides the verdict", { timeout: 120_000 }, () => {
    test("valid transcript + exit code 0 → PASS, launched with the prepared config only", async () => {
        const dir = newWorkDir()
        const s = spies(validLines.join("\n"), (child) => child.emit("exit", 0, null))
        const outcome = await runWith(dir, s)
        assert.deepEqual(outcome.checks.filter((c) => c.verdict !== "PASS"), [])
        assert.equal(outcome.verdict, "PASS")
        assert.deepEqual(s.spawned, [{ command: process.execPath, args: claudeArgs(dir.config), cwd: dir.cwd }])
        assert.deepEqual(readProcessMetadata(dir, false), PROCESS_OK)
        assert.equal(JSON.parse(fs.readFileSync(dir.report, "utf8")).verdict, "PASS")
        assert.ok(!fs.readFileSync(dir.report, "utf8").includes(SYNTHETIC_SESSION), "no session id in the report")
    })

    for (const [name, behave, expected] of [
        ["exit code 1", (child: FakeClaude) => child.emit("exit", 1, null), { exitCode: 1 }],
        ["an error event", (child: FakeClaude) => child.emit("error", new Error("spawn failed")), { exitCode: null, spawnError: true }],
    ] as [string, (child: FakeClaude) => void, Partial<ProcessMetadata>][]) {
        test(`valid transcript + ${name} → FAIL`, async () => {
            const dir = newWorkDir()
            const outcome = await runWith(dir, spies(validLines.join("\n"), behave))
            assert.equal(outcome.verdict, "FAIL")
            assert.deepEqual(outcome.checks.filter((c) => c.verdict !== "PASS").map((c) => c.id), ["process.claude-exit"])
            assert.deepEqual(readProcessMetadata(dir, false), { ...PROCESS_OK, ...expected })
        })
    }

    test("valid transcript + timeout → killed and FAIL", async () => {
        const dir = newWorkDir()
        const s = spies(validLines.join("\n"))
        const outcome = await runWith(dir, s, { timeoutMs: 50 })
        assert.equal(s.children[0]?.kills, 1)
        assert.equal(outcome.verdict, "FAIL")
        assert.deepEqual(outcome.checks.filter((c) => c.verdict !== "PASS").map((c) => c.id), ["process.claude-exit"])
        assert.deepEqual(readProcessMetadata(dir, false), { ...PROCESS_OK, exitCode: null, signal: "SIGTERM", timedOut: true })
    })

    test("a spawn that throws → FAIL", async () => {
        const dir = newWorkDir()
        const s = spies()
        const outcome = await runWith(dir, { ...s, spawn: () => { throw new Error("ENOENT") } })
        assert.equal(outcome.verdict, "FAIL")
        assert.deepEqual(readProcessMetadata(dir, false), { ...PROCESS_OK, exitCode: null, spawnError: true })
    })
})

describe("verify: recorded runs", { timeout: 120_000 }, () => {
    function recorded(): WorkDir {
        const dir = newWorkDir()
        fs.writeFileSync(dir.transcript, validLines.join("\n"))
        return dir
    }

    test("without process metadata → INCOMPLETE; report.json is never overwritten", () => {
        const dir = recorded()
        const outcome = verifyWorkDir(dir, readProcessMetadata(dir, false), dir.verifyReport)
        assert.equal(outcome.verdict, "INCOMPLETE")
        assert.throws(() => verifyWorkDir(dir, undefined, dir.verifyReport), /never overwritten/)
    })

    test("malformed run-metadata.json → FAIL", () => {
        const dir = recorded()
        fs.writeFileSync(dir.runMetadata, JSON.stringify({ source: "run", exitCode: "0" }))
        const outcome = verifyWorkDir(dir, readProcessMetadata(dir, false), dir.verifyReport)
        assert.equal(outcome.verdict, "FAIL")
        assert.deepEqual(outcome.checks.filter((c) => c.verdict !== "PASS").map((c) => c.id), ["process.claude-exit"])
    })

    test("legacy report metadata: only its process fields are read, never its verdict", () => {
        const pass = recorded()
        fs.writeFileSync(pass.report, JSON.stringify({ verdict: "FAIL", claudeVersion: CLAUDE_VERSION, claudeExitCode: 0, timedOut: false }))
        assert.equal(verifyWorkDir(pass, readProcessMetadata(pass, true), pass.verifyReport).verdict, "PASS")
        const failed = recorded()
        fs.writeFileSync(failed.report, JSON.stringify({ verdict: "PASS", claudeVersion: CLAUDE_VERSION, claudeExitCode: null, timedOut: true }))
        assert.equal(verifyWorkDir(failed, readProcessMetadata(failed, true), failed.verifyReport).verdict, "FAIL")
        const missing = recorded()
        fs.writeFileSync(missing.report, JSON.stringify({ verdict: "PASS" }))
        assert.equal(readProcessMetadata(missing, true), "malformed")
    })

    test("a profile changed after the run → FAIL", () => {
        const dir = recorded()
        fs.writeFileSync(dir.runMetadata, JSON.stringify(PROCESS_OK))
        fs.appendFileSync(path.join(dir.profile, "config.json"), " ")
        const outcome = verifyWorkDir(dir, readProcessMetadata(dir, false), dir.verifyReport)
        assert.equal(outcome.verdict, "FAIL")
        assert.deepEqual(outcome.checks.filter((c) => c.verdict !== "PASS").map((c) => c.id), ["fixture.integrity"])
    })

    test("all seven tools appear in the assembled plan", () => {
        const names = events().flatMap((e) => (e.type === "assistant" ? e.message.content.filter((b: Event) => b.type === "tool_use").map((b: Event) => b.name) : []))
        assert.deepEqual([...new Set(names)].sort(), TOOL_NAMES.map((t) => `${PREFIX}${t}`).sort())
    })
})

describe("process metadata: the claude version is required on both paths", { timeout: 120_000 }, () => {
    function recordedWith(file: "run" | "legacy", content: Record<string, unknown>): WorkDir {
        const dir = newWorkDir()
        fs.writeFileSync(dir.transcript, validLines.join("\n"))
        fs.writeFileSync(file === "run" ? dir.runMetadata : dir.report, JSON.stringify(content))
        return dir
    }
    const legacy = { verdict: "PASS", claudeVersion: CLAUDE_VERSION, claudeExitCode: 0, timedOut: false }

    for (const [name, value] of [["null", null], ["empty", ""], ["absent", undefined]] as [string, unknown][]) {
        test(`run-metadata.json with claudeVersion ${name}: malformed, FAIL`, () => {
            const dir = recordedWith("run", { ...PROCESS_OK, claudeVersion: value })
            assert.equal(readProcessMetadata(dir, false), "malformed")
            const outcome = verifyWorkDir(dir, readProcessMetadata(dir, false), dir.verifyReport)
            assert.equal(outcome.verdict, "FAIL")
            assert.deepEqual(outcome.checks.filter((c) => c.verdict !== "PASS").map((c) => c.id), ["process.claude-exit"])
        })
        test(`legacy report.json with claudeVersion ${name}: malformed`, () => {
            assert.equal(readProcessMetadata(recordedWith("legacy", { ...legacy, claudeVersion: value }), true), "malformed")
        })
    }
})
