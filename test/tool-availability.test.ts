/**
 * All sixteen tools are registered on every start, whatever the environment
 * says, and being available changes nothing about what a write requires.
 * Real entry point, synthetic profile and private storage.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { LEGACY_ACTIVATION_ENV_VARS, READ_ONLY_TOOLS, TOOLS, WRITE_TOOLS } from "../installer/lib/package-content.js"
import { ERROR_CODES, FrMcpError } from "../src/errors.js"
import { APP_LOCK_FILE } from "../src/settings/rule-store.js"
import { createTempRoot, removeTempRoot, snapshotDir, syntheticSettings } from "./helpers/fixtures.js"
import { childEnv, request, startServer, type RunningServer } from "./helpers/process.js"
import { createSourcesProfile } from "./helpers/sources.js"

const [RULES_VAR, NEWS_VAR] = LEGACY_ACTIVATION_ENV_VARS
const RULE = { field: "title", pattern: "^x", caseSensitive: false, match: true, actions: [{ action: "hide", value: true }] }
const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const ANNOTATIONS: Readonly<Record<string, object>> = {
    add_rule: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    update_rule: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    delete_rule: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    apply_news_preferences_change: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}

interface ListedTool {
    readonly name: string
    readonly description?: string
    readonly annotations?: object
    readonly inputSchema: unknown
    readonly outputSchema?: unknown
}

let root: string
let counter = 0

before(() => { root = createTempRoot() })
after(() => { removeTempRoot(root) })

function fixture(): { dir: string; configPath: string; localAppData: string; userProfile: string } {
    const n = ++counter
    const p = createSourcesProfile(path.join(root, `profile-${n}`), { sources: [{ sid: 0, name: "Synthetic A" }, { sid: 1, name: "Synthetic B" }], settings: syntheticSettings() })
    const userProfile = path.join(root, `home-${n}`)
    const localAppData = path.join(userProfile, "AppData", "Local")
    fs.mkdirSync(localAppData, { recursive: true })
    return { dir: p.dir, configPath: p.configPath, localAppData, userProfile }
}

async function open(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}): Promise<RunningServer> {
    const env = childEnv({ LOCALAPPDATA: f.localAppData, USERPROFILE: f.userProfile })
    for (const name of LEGACY_ACTIVATION_ENV_VARS) delete env[name]
    const server = startServer(["--profile-dir", f.dir], { ...env, ...extra })
    await request(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "availability", version: "0" } } })
    server.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    return server
}

async function close(server: RunningServer): Promise<{ code: number | null; stderr: string }> {
    server.child.stdin.end()
    return server.exited(5_000)
}

async function listed(server: RunningServer): Promise<ListedTool[]> {
    const response = await request(server, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    return (response.result as { tools: ListedTool[] }).tools
}

let callId = 100
async function call(server: RunningServer, name: string, args: unknown): Promise<{ isError: boolean; payload: any }> {
    const response = await request(server, { jsonrpc: "2.0", id: ++callId, method: "tools/call", params: { name, arguments: args } })
    const result = response.result as { isError?: boolean; structuredContent?: unknown; content: { text: string }[] }
    return { isError: result.isError === true, payload: result.structuredContent ?? JSON.parse(result.content[0]?.text ?? "null") }
}

function refused(outcome: { isError: boolean; payload: any }, code: string): void {
    assert.equal(outcome.isError, true, JSON.stringify(outcome.payload))
    assert.equal(outcome.payload.code, code, JSON.stringify(outcome.payload))
}

describe("all sixteen tools, always", { timeout: 120_000 }, () => {
    test("the list has no duplicates and each tool is either read-only or a write", () => {
        assert.equal(TOOLS.length, 16)
        assert.equal(new Set(TOOLS).size, 16)
        assert.deepEqual([...READ_ONLY_TOOLS, ...WRITE_TOOLS].sort(), [...TOOLS])
        assert.equal(READ_ONLY_TOOLS.filter((name) => (WRITE_TOOLS as readonly string[]).includes(name)).length, 0)
    })

    test("no variable, or the legacy ones at any value: exactly the same sixteen tools, schemas and annotations", async () => {
        const f = fixture()
        const variants: Record<string, string>[] = [
            {},
            { [RULES_VAR]: "0", [NEWS_VAR]: "0" },
            { [RULES_VAR]: "1", [NEWS_VAR]: "1" },
            { [RULES_VAR]: "1", [NEWS_VAR]: "0" },
            { [RULES_VAR]: "0", [NEWS_VAR]: "1" },
            { [RULES_VAR]: "true", [NEWS_VAR]: "no" },
        ]
        let reference: ListedTool[] | undefined
        for (const variant of variants) {
            const server = await open(f, variant)
            const tools = await listed(server)
            assert.equal((await close(server)).code, 0, JSON.stringify(variant))
            assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS], JSON.stringify(variant))
            if (reference === undefined) reference = tools
            else assert.deepEqual(tools, reference, JSON.stringify(variant))
        }
    })

    test("each tool keeps its annotations and declares strict input and an output schema", async () => {
        const server = await open(fixture())
        const tools = await listed(server)
        await close(server)
        for (const tool of tools) {
            assert.deepEqual(tool.annotations, ANNOTATIONS[tool.name] ?? READ_ANNOTATIONS, tool.name)
            assert.equal((tool.inputSchema as { type?: unknown; additionalProperties?: unknown }).type, "object", tool.name)
            assert.equal((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties, false, tool.name)
            assert.equal((tool.outputSchema as { type?: unknown } | undefined)?.type, "object", tool.name)
        }
    })

    test("descriptions: writes only on the user's explicit request, and no activation is mentioned anywhere", async () => {
        const server = await open(fixture())
        const tools = await listed(server)
        await close(server)
        for (const name of [...WRITE_TOOLS, "preview_news_preferences_change"]) {
            assert.match(tools.find((t) => t.name === name)?.description ?? "", /Use only on the user's own explicit request/, name)
        }
        const everything = JSON.stringify(tools)
        assert.doesNotMatch(everything, /FLUENT_READER_MCP_ENABLE|opt-in|must be enabled/i)
        for (const code of ERROR_CODES) assert.doesNotMatch(JSON.stringify(new FrMcpError(code).toJSON()), /FLUENT_READER_MCP_ENABLE/, code)
    })

    test("starting and listing change nothing in the profile and create no private storage", async () => {
        const f = fixture()
        const profileBefore = snapshotDir(f.dir)
        for (const extra of [{}, { [RULES_VAR]: "1", [NEWS_VAR]: "1" }]) {
            const server = await open(f, extra)
            await listed(server)
            const exit = await close(server)
            assert.equal(exit.code, 0)
            assert.doesNotMatch(exit.stderr, /"event":"(?:rule_writes|news_preferences)"/)
            assert.deepEqual(snapshotDir(f.dir), profileBefore)
            assert.deepEqual(snapshotDir(f.localAppData), new Map())
        }
    })
})

describe("available does not mean automatic", { timeout: 120_000 }, () => {
    test("rule writes without any variable keep every check, and then work", async () => {
        const f = fixture()
        const before = fs.readFileSync(f.configPath)
        const server = await open(f)
        const { revision } = (await call(server, "list_rules", { limit: 100, scope: "group", groupId: 0 })).payload
        const target = { scope: "group", groupId: 0, expectedRevision: revision, rule: RULE }

        refused(await call(server, "add_rule", {}), "INVALID_ARGUMENT")
        refused(await call(server, "add_rule", { ...target, expectedRevision: "rr1.AAAAAAAAAAAAAAAAAAAAAA" }), "REVISION_CONFLICT")
        refused(await call(server, "add_rule", { ...target, groupId: 999 }), "NOT_FOUND")
        refused(await call(server, "add_rule", { scope: "source", sourceId: 0, expectedRevision: revision, rule: RULE }), "INVALID_ARGUMENT")

        const lock = path.join(f.dir, APP_LOCK_FILE)
        fs.writeFileSync(lock, "")
        refused(await call(server, "add_rule", target), "FLUENT_READER_RUNNING")
        refused(await call(server, "update_rule", { scope: "group", groupId: 0, expectedRevision: revision, index: 0, rule: RULE }), "FLUENT_READER_RUNNING")
        refused(await call(server, "delete_rule", { scope: "group", groupId: 0, expectedRevision: revision, index: 0 }), "FLUENT_READER_RUNNING")
        const preview = await call(server, "preview_rule_change", { operation: "add", scope: "group", groupId: 0, rule: RULE })
        assert.equal(preview.isError, false)
        assert.deepEqual(preview.payload.writeAvailability, { writesEnabled: true, fluentReaderOpen: true })
        fs.unlinkSync(lock)
        assert.ok(fs.readFileSync(f.configPath).equals(before), "nothing written by any refused call or by the preview")
        assert.deepEqual(snapshotDir(f.localAppData), new Map(), "and no backup taken")

        const saved = await call(server, "add_rule", target)
        assert.equal(saved.isError, false, JSON.stringify(saved.payload))
        assert.equal(saved.payload.applied, true)
        assert.ok(saved.payload.backup?.name, "the real write took a backup first")
        assert.equal(fs.readFileSync(f.configPath).equals(before), false)
        await close(server)
    })

    test("preference writes without any variable need the preview, its token and confirm", async () => {
        const f = fixture()
        const profileBefore = snapshotDir(f.dir)
        const server = await open(f)
        const changes = { operation: "initialize", interests: ["Sintetico"] }
        const preview = await call(server, "preview_news_preferences_change", { expectedRevision: "absent", changes })
        assert.equal(preview.isError, false, JSON.stringify(preview.payload))
        assert.deepEqual(snapshotDir(f.localAppData), new Map(), "a preview writes nothing")

        const forged = `npp1.${"A".repeat(30)}.${"A".repeat(43)}`
        refused(await call(server, "apply_news_preferences_change", { expectedRevision: "absent", changes, confirm: true }), "INVALID_ARGUMENT")
        refused(await call(server, "apply_news_preferences_change", { previewToken: preview.payload.previewToken, expectedRevision: "absent", changes }), "INVALID_ARGUMENT")
        refused(await call(server, "apply_news_preferences_change", { previewToken: preview.payload.previewToken, expectedRevision: "absent", changes, confirm: false }), "INVALID_ARGUMENT")
        refused(await call(server, "apply_news_preferences_change", { previewToken: forged, expectedRevision: "absent", changes, confirm: true }), "PREVIEW_INVALID")
        refused(await call(server, "apply_news_preferences_change", { previewToken: preview.payload.previewToken, expectedRevision: "absent", changes: { ...changes, interests: ["Altro"] }, confirm: true }), "PREVIEW_INVALID")
        assert.deepEqual(snapshotDir(f.localAppData), new Map(), "no refused call writes anything")

        const saved = await call(server, "apply_news_preferences_change", { previewToken: preview.payload.previewToken, expectedRevision: "absent", changes, confirm: true })
        assert.equal(saved.isError, false, JSON.stringify(saved.payload))
        assert.equal(saved.payload.applied, true)
        await close(server)
        assert.deepEqual(snapshotDir(f.dir), profileBefore, "the preferences never touch the profile")
    })
})
