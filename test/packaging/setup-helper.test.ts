/**
 * FR-MCP-04-BETA-02: the setup helper on SYNTHETIC data only — a synthetic
 * Windows user directory (USERPROFILE), synthetic Fluent Reader profiles
 * (the smoke fixture), synthetic ~/.claude.json files and a simulated
 * claude.exe that implements `mcp add-json` / `mcp remove` on them. No real
 * profile, Claude configuration or Claude Code process is ever used.
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { type ExecFn } from "../../installer/lib/common.js"
import { buildManifest, MANIFEST, type LicenseRecord } from "../../installer/lib/package-content.js"
import { parseRuntimeLock } from "../../installer/lib/runtime-lock.js"
import { setupClosure } from "../../installer/lib/installer-build.js"
import { buildInventory, INVENTORY, removalPlan, removeTree, verifyTree } from "../../installer/setup/app.js"
import { desiredEntry, SERVER_NAME } from "../../installer/setup/claude.js"
import { main, type HelperDeps } from "../../installer/setup/fr-setup.js"
import { decodeResult } from "../../installer/setup/protocol.js"
import { entryFingerprint, PRODUCT, RECORD_NAME, readRecord, writeRecord, type InstallRecord } from "../../installer/setup/record.js"
import { buildSmokeProfile } from "../e2e/smoke-fixture.js"
import { createTempRoot, removeTempRoot, snapshotDir } from "../helpers/fixtures.js"

let root: string
let counter = 0
before(() => {
    root = fs.realpathSync.native(createTempRoot())
})
after(() => removeTempRoot(root))

const COMPILED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const VERSION = "0.1.0"
const MAX_RELATIVE = "120"
/** Sentinels of personal Claude configuration content: never in a result, record or message. */
const SECRET = "CLAUDE_PERSONAL_SECRET_7c1d"
const CLAUDE_VERSION = "2.1.312"

interface World {
    readonly home: string
    readonly env: NodeJS.ProcessEnv
    readonly installDir: string
    readonly profile: string
    readonly claudeExe: string
    readonly configPath: string
    readonly calls: string[][]
    claude: FakeClaude
    /** Concurrent changes or failures injected at the helper's named steps. */
    checkpoint?: HelperDeps["checkpoint"]
}

/** How the simulated claude.exe behaves. */
interface FakeClaude {
    addFails?: "before-write" | "after-write" | undefined
    addWritesWrong?: boolean
    addTouchesOther?: boolean
    removeFails?: boolean
    helpWithoutScope?: boolean
    /** Like a client that stores fields of its own: the saved entry differs from the JSON sent. */
    addsMeta?: boolean
}

function world(config?: unknown | string): World {
    counter++
    const home = path.join(root, `user ${counter} é`)
    fs.mkdirSync(path.join(home, "AppData", "Roaming"), { recursive: true })
    fs.mkdirSync(path.join(home, "AppData", "Local"), { recursive: true })
    const claudeExe = path.join(home, ".vscode", "extensions", `anthropic.claude-code-${CLAUDE_VERSION}-win32-x64`, "resources", "native-binary", "claude.exe")
    fs.mkdirSync(path.dirname(claudeExe), { recursive: true })
    fs.writeFileSync(claudeExe, "synthetic claude.exe")
    const configPath = path.join(home, ".claude.json")
    if (config !== undefined) fs.writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config, null, 2))
    const profile = buildSmokeProfile(path.join(home, "Profili Fluent", "profilo è 😀")).dir
    const env = { USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), PATH: "" }
    return { home, env, installDir: path.join(home, "AppData", "Local", "Fluent Reader MCP é 😀"), profile, claudeExe, configPath, calls: [], claude: {} }
}

/** A synthetic package (manifest schema 1) in dir/app. */
function syntheticTree(dir: string, lockRaw: unknown): void {
    const app = path.join(dir, "app")
    const files: Record<string, string> = {
        "runtime/node.exe": "synthetic node", "runtime/LICENSE": "node licence", "server/dist/main.js": "// server", "server/package.json": "{}",
        "server/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node": "native", "PACKAGING-INFO.md": "info", "licenses/node/LICENSE": "licence",
    }
    for (const [f, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true })
        fs.writeFileSync(path.join(app, f), content)
    }
    const lock = parseRuntimeLock(lockRaw, ">=24.15.0 <25")
    const licenses: LicenseRecord[] = []
    const manifest = buildManifest(app, { version: VERSION, gitCommit: "c".repeat(40), gitDirty: false, sourceDateEpoch: 1767225600, lock, projectLicense: null, licenses })
    fs.writeFileSync(path.join(app, MANIFEST), JSON.stringify(manifest, null, 2))
}

function otherServers(): Record<string, unknown> {
    return {
        "other-tool": { type: "stdio", command: "C:\\Tools\\other.exe", args: ["--x"], env: { API_KEY: SECRET } },
        remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
    }
}

function personalConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { numStartups: 42, oauthAccount: { emailAddress: `${SECRET}@example.com` }, mcpServers: { ...otherServers(), ...extra }, projects: { "C:\\Work": { allowedTools: [], mcpServers: {} } } }
}

function readConfig(w: World): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(w.configPath, "utf8")) as Record<string, unknown>
}

function servers(w: World): Record<string, unknown> {
    return (readConfig(w).mcpServers ?? {}) as Record<string, unknown>
}

/** A simulated Claude Code CLI over the synthetic ~/.claude.json, as documented for `claude mcp`. */
function fakeExec(w: World): ExecFn {
    return (file, args) => {
        w.calls.push([...args])
        if (file !== w.claudeExe) return { status: 1, stdout: "", stderr: "unexpected program" }
        const ok = (stdout = ""): ReturnType<ExecFn> => ({ status: 0, stdout, stderr: "" })
        if (args[0] === "--version") return ok(`${CLAUDE_VERSION} (Claude Code)\n`)
        if (args[0] === "mcp" && args[2] === "--help") return ok(`Usage: claude mcp ${args[1] as string} [options] <name>${w.claude.helpWithoutScope === true ? "" : "\n  -s, --scope <scope>  Configuration scope (local, user, or project)"}\n`)
        const load = (): Record<string, unknown> => (fs.existsSync(w.configPath) ? JSON.parse(fs.readFileSync(w.configPath, "utf8")) as Record<string, unknown> : {})
        const save = (doc: Record<string, unknown>): void => fs.writeFileSync(w.configPath, JSON.stringify(doc, null, 2))
        if (args[0] === "mcp" && args[1] === "add-json" && args[4] === "--scope" && args[5] === "user") {
            if (w.claude.addFails === "before-write") {
                w.claude.addFails = undefined // one failure: a later add-json (a rollback restore) works
                return { status: 1, stdout: "", stderr: "crashed" }
            }
            const doc = load()
            const mcp = (doc.mcpServers ?? {}) as Record<string, unknown>
            if (Object.hasOwn(mcp, args[2] as string)) return { status: 1, stdout: "", stderr: "already exists" }
            const sent = JSON.parse(args[3] as string) as Record<string, unknown>
            const entry = w.claude.addsMeta === true ? { meta: { source: "cli", flags: [1, 2] }, ...sent } : sent
            mcp[args[2] as string] = w.claude.addWritesWrong === true ? { ...entry, args: [] } : entry
            if (w.claude.addTouchesOther === true) mcp["other-tool"] = { type: "stdio", command: "C:\\Tools\\changed.exe" }
            save({ ...doc, mcpServers: mcp })
            if (w.claude.addFails === "after-write") return { status: 1, stdout: "", stderr: "interrupted" }
            return ok(`Added stdio MCP server ${args[2] as string} to user config\n`)
        }
        if (args[0] === "mcp" && args[1] === "remove" && args[3] === "--scope" && args[4] === "user") {
            if (w.claude.removeFails === true) return { status: 1, stdout: "", stderr: "locked" }
            const doc = load()
            const mcp = (doc.mcpServers ?? {}) as Record<string, unknown>
            if (!Object.hasOwn(mcp, args[2] as string)) return { status: 1, stdout: "", stderr: "not found" }
            delete mcp[args[2] as string]
            save({ ...doc, mcpServers: mcp })
            return ok()
        }
        return { status: 1, stdout: "", stderr: `unexpected arguments ${args.join(" ")}` }
    }
}

function deps(w: World): HelperDeps {
    return { env: w.env, exec: fakeExec(w), selfTest: async () => ["self-test: synthetic"], now: () => new Date("2026-10-28T10:00:00Z"), checkpoint: (step) => w.checkpoint?.(step) }
}

interface Answer {
    readonly code: number
    readonly fields: Map<string, string[]>
    readonly text: string
    one(key: string): string
}

/** Runs a helper command through its real request/result files (UTF-16LE, as NSIS writes them). */
async function call(w: World, command: string, request: Record<string, string>, d: HelperDeps = deps(w)): Promise<Answer> {
    counter++
    const dir = path.join(root, `io ${counter}`)
    fs.mkdirSync(dir)
    const requestFile = path.join(dir, "request.txt")
    const resultFile = path.join(dir, "result.txt")
    fs.writeFileSync(requestFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(Object.entries(request).map(([k, v]) => `${k}=${v}\r\n`).join(""), "utf16le")]))
    const code = await main([command, requestFile, resultFile], d)
    const bytes = fs.readFileSync(resultFile)
    const fields = decodeResult(bytes)
    return { code, fields, text: bytes.toString("utf16le"), one: (key) => (fields.get(key) ?? []).join("\n") }
}

function installRequest(w: World, extra: Record<string, string> = {}): Record<string, string> {
    return { installDir: w.installDir, version: VERSION, maxRelative: MAX_RELATIVE, ...extra }
}

/** The state after a committed installation: the layout plus the record as tx-metadata writes it (registration kept). */
async function installed(w: World, dir = w.installDir): Promise<void> {
    fs.mkdirSync(path.join(dir, "current"), { recursive: true })
    const file = path.join(dir, RECORD_NAME)
    const previous = fs.existsSync(file) ? readRecord(file) : null
    writeRecord(file, { schemaVersion: 1, product: PRODUCT, installDir: dir, generation: "ab".repeat(16), version: VERSION, bundleSha256: "a".repeat(64), installedAt: "2026-10-28T10:00:00.000Z", profileDir: w.profile, claude: previous?.claude ?? null })
}

/** The registered entry as stored in the synthetic ~/.claude.json, with one change applied. */
function changeEntry(w: World, change: (entry: Record<string, unknown>) => Record<string, unknown>): void {
    const doc = readConfig(w)
    const mcp = doc.mcpServers as Record<string, unknown>
    fs.writeFileSync(w.configPath, JSON.stringify({ ...doc, mcpServers: { ...mcp, [SERVER_NAME]: change(structuredClone(mcp[SERVER_NAME]) as Record<string, unknown>) } }))
}

function calls(w: World, sub: "remove" | "add-json"): string[][] {
    return mutating(w).filter((c) => c[1] === sub)
}

async function planAndRegister(w: World, extra: Record<string, string> = {}): Promise<{ plan: Answer; register: Answer }> {
    const plan = await call(w, "plan", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile }))
    assert.equal(plan.code, 0, plan.one("message"))
    const register = await call(w, "register", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile, planHash: plan.one("planHash"), consent: "yes", ...extra }))
    return { plan, register }
}

function record(w: World): InstallRecord {
    return JSON.parse(fs.readFileSync(path.join(w.installDir, RECORD_NAME), "utf8")) as InstallRecord
}

function mutating(w: World): string[][] {
    return w.calls.filter((c) => c[0] === "mcp" && c[2] !== "--help")
}

function backups(w: World): string[] {
    const dir = path.join(w.installDir, "state", "claude-config-backups")
    return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

describe("setup helper: installation directory", () => {
    test("a new directory with spaces and Unicode inside the user's local AppData is accepted", async () => {
        const w = world()
        const r = await call(w, "check-install-dir", installRequest(w))
        assert.equal(r.code, 0, r.one("message"))
        assert.equal(r.one("canonical"), w.installDir)
        assert.equal(r.one("mode"), "new")
        assert.equal(fs.existsSync(w.installDir), false, "checking creates nothing")
    })

    test("unsafe or ambiguous directories are refused", async () => {
        const w = world()
        const outside = path.join(root, `outside ${counter}`)
        const linkTarget = path.join(w.home, "real target")
        fs.mkdirSync(linkTarget)
        const junction = path.join(w.home, "AppData", "Local", "junction é")
        fs.symlinkSync(linkTarget, junction, "junction")
        const foreign = path.join(w.home, "AppData", "Local", "Someone else")
        fs.mkdirSync(foreign)
        fs.writeFileSync(path.join(foreign, "notes.txt"), "not ours")
        const file = path.join(w.home, "AppData", "Local", "a file")
        fs.writeFileSync(file, "x")
        const oneDrive = path.join(w.home, "OneDrive")
        fs.mkdirSync(oneDrive)
        const cases: [string, RegExp, Record<string, string>?][] = [
            [outside, /dentro la cartella del tuo utente/],
            [w.home, /dentro la cartella del tuo utente/],
            ["\\\\server\\share\\FluentReaderMCP", /unità locale/],
            ["relative\\dir", /unità locale/],
            [path.join(w.home, "AppData", "Roaming", "FluentReaderMCP"), /Roaming/],
            [path.join(oneDrive, "FluentReaderMCP"), /OneDrive/],
            [path.join(w.home, ".claude", "FluentReaderMCP"), /configurazione di Claude Code/],
            [path.join(junction, "FluentReaderMCP"), /collegamento, una junction o un nome breve/],
            [foreign, /contiene già altri file/],
            [file, /non è una cartella/],
            [path.join(w.home, "AppData", "Local", "NUL"), /non è ammesso/],
            [path.join(w.home, "AppData", "Local", "trailing."), /non è ammesso/],
        ]
        for (const [installDir, message] of cases) {
            const r = await call(w, "check-install-dir", { ...installRequest(w), installDir }, { ...deps(w), env: { ...w.env, OneDrive: oneDrive } })
            assert.equal(r.code, 1, installDir)
            assert.match(r.one("message"), message, installDir)
        }
        const long = await call(w, "check-install-dir", { ...installRequest(w), maxRelative: "250" })
        assert.match(long.one("message"), /percorso troppo lungo/)
        assert.equal(fs.readFileSync(path.join(foreign, "notes.txt"), "utf8"), "not ours")
    })

    test("an existing installation is recognised: same version = repair, older = upgrade, newer = refused, nested = refused", async () => {
        const w = world()
        await installed(w)
        const repair = await call(w, "check-install-dir", installRequest(w))
        assert.equal(repair.one("mode"), "repair")
        assert.equal(repair.one("previousProfile"), w.profile)
        const upgrade = await call(w, "check-install-dir", { ...installRequest(w), version: "0.2.0" })
        assert.equal(upgrade.one("mode"), "upgrade")
        assert.equal(upgrade.one("installedVersion"), VERSION)
        const downgrade = await call(w, "check-install-dir", { ...installRequest(w), version: "0.0.9" })
        assert.match(downgrade.one("message"), /downgrade non è supportato/)
        const nested = await call(w, "check-install-dir", { ...installRequest(w), installDir: path.join(w.installDir, "inner") })
        assert.match(nested.one("message"), /dentro un'altra installazione/)
    })

    test("a directory holding only this installer's own layout (interrupted install) is accepted as new", async () => {
        const w = world()
        fs.mkdirSync(path.join(w.installDir, ".staging"), { recursive: true })
        fs.mkdirSync(path.join(w.installDir, "state"))
        const r = await call(w, "check-install-dir", installRequest(w))
        assert.equal(r.one("mode"), "new")
    })
})

describe("setup helper: Fluent Reader profile", () => {
    function snapshot(dir: string): string {
        return fs.readdirSync(dir).sort().map((n) => {
            const s = fs.statSync(path.join(dir, n))
            return `${n}:${s.size}:${s.mtimeMs}:${fs.readFileSync(path.join(dir, n)).toString("base64")}`
        }).join("|")
    }

    test("a synthetic profile with spaces and Unicode is accepted; its files are not modified", async () => {
        const w = world()
        const before = snapshot(w.profile)
        const r = await call(w, "check-profile", { profileDir: w.profile, installDir: w.installDir })
        assert.equal(r.code, 0, r.one("message"))
        assert.equal(r.one("canonical"), w.profile)
        assert.equal(snapshot(w.profile), before)
        assert.equal(r.text.includes("SMOKE-"), false, "no article or source content in the answer")
    })

    test("missing, incomplete, mistyped, linked, remote or overlapping profiles are refused", async () => {
        const w = world()
        const make = (name: string, files: Record<string, string | Buffer>): string => {
            const dir = path.join(w.home, "bad", name)
            fs.mkdirSync(dir, { recursive: true })
            for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content)
            return dir
        }
        const sqlite = Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(200)])
        const link = path.join(w.home, "bad", "link é")
        fs.mkdirSync(path.dirname(link), { recursive: true })
        fs.symlinkSync(w.profile, link, "junction")
        const cases: [string, RegExp][] = [
            [path.join(w.home, "missing"), /non esiste/],
            [make("no config", { "fluent-reader.db": sqlite }), /config\.json non trovato/],
            [make("no db", { "config.json": "{}" }), /fluent-reader\.db non trovato/],
            [make("not sqlite", { "config.json": "{}", "fluent-reader.db": Buffer.alloc(200) }), /non è un database SQLite/],
            [make("not json", { "config.json": "not json", "fluent-reader.db": sqlite }), /non è un documento JSON/],
            [make("empty config", { "config.json": "", "fluent-reader.db": sqlite }), /dimensione/],
            [link, /non è una cartella normale|collegamento/],
            ["\\\\server\\share\\profile", /unità locale/],
            [w.installDir, /non esiste|cartella di installazione/],
        ]
        for (const [profileDir, message] of cases) {
            const r = await call(w, "check-profile", { profileDir, installDir: w.installDir })
            assert.equal(r.code, 1, profileDir)
            assert.match(r.one("message"), message, profileDir)
        }
        const inside = await call(w, "check-profile", { profileDir: w.profile, installDir: path.join(w.profile, "app") })
        assert.match(inside.one("message"), /cartella di installazione/)
    })
})

describe("setup helper: Claude Code client", () => {
    test("detection runs only on request and lists the newest VS Code extension binary first", async () => {
        const w = world()
        const older = path.join(w.home, ".vscode", "extensions", "anthropic.claude-code-2.1.99-win32-x64", "resources", "native-binary", "claude.exe")
        fs.mkdirSync(path.dirname(older), { recursive: true })
        fs.writeFileSync(older, "older")
        const r = await call(w, "detect-claude", {})
        assert.equal(r.code, 0)
        assert.equal(r.one("claudeExe"), w.claudeExe)
        assert.equal(r.one("candidates"), "2")
        assert.deepEqual(w.calls, [], "detection starts no program")
    })

    test("the chosen claude.exe must answer --version and offer mcp add-json/remove with --scope", async () => {
        const w = world()
        const ok = await call(w, "check-claude", { claudeExe: w.claudeExe })
        assert.equal(ok.one("version"), CLAUDE_VERSION)
        assert.deepEqual(w.calls, [["--version"], ["mcp", "add-json", "--help"], ["mcp", "remove", "--help"]])
        w.claude.helpWithoutScope = true
        assert.match((await call(w, "check-claude", { claudeExe: w.claudeExe })).one("message"), /non è disponibile con --scope/)
        assert.match((await call(w, "check-claude", { claudeExe: path.join(w.home, "claude.cmd") })).one("message"), /claude\.exe/)
        assert.match((await call(w, "check-claude", { claudeExe: path.join(w.home, "missing.exe") })).one("message"), /non esiste/)
    })

    test("CLAUDE_CONFIG_DIR: the configuration location is not guessed, registration is refused", async () => {
        const w = world(personalConfig())
        await installed(w)
        const r = await call(w, "plan", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile }), { ...deps(w), env: { ...w.env, CLAUDE_CONFIG_DIR: path.join(w.home, "alt") } })
        assert.equal(r.code, 1)
        assert.match(r.one("message"), /CLAUDE_CONFIG_DIR/)
    })
})

describe("setup helper: preview and registration", () => {
    test("the preview has no side effect and shows only this installation's paths", async () => {
        const w = world(personalConfig())
        await installed(w)
        const before = fs.readFileSync(w.configPath)
        const r = await call(w, "plan", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile }))
        assert.equal(r.code, 0, r.one("message"))
        assert.equal(r.one("action"), "add")
        assert.match(r.one("planHash"), /^[0-9a-f]{64}$/)
        const preview = r.one("preview")
        const entry = desiredEntry(w.installDir, w.profile)
        for (const expected of [SERVER_NAME, "Scope: user", entry.command, entry.args[0] as string, w.profile, w.configPath, CLAUDE_VERSION]) assert.ok(preview.includes(expected), expected)
        assert.equal(r.text.includes(SECRET), false, "no configuration content in the preview")
        assert.ok(fs.readFileSync(w.configPath).equals(before), "configuration unchanged")
        assert.deepEqual(mutating(w), [], "no add or remove")
        assert.deepEqual(backups(w), [], "no backup taken by a preview")
    })

    test("registration adds only fluent-reader, preserves every other server and setting, keeps a backup", async () => {
        const w = world(personalConfig())
        await installed(w)
        const original = fs.readFileSync(w.configPath)
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 0, register.one("message"))
        assert.equal(register.one("action"), "add")
        const after = readConfig(w)
        assert.deepEqual(servers(w)[SERVER_NAME], desiredEntry(w.installDir, w.profile))
        assert.deepEqual(Object.fromEntries(Object.entries(servers(w)).filter(([n]) => n !== SERVER_NAME)), otherServers())
        assert.equal(after.numStartups, 42)
        assert.deepEqual(after.projects, personalConfig().projects)
        assert.deepEqual(mutating(w).map((c) => c.slice(0, 3)), [["mcp", "add-json", SERVER_NAME]])
        const [backup] = backups(w)
        assert.ok(backup !== undefined && /^claude\.json\.\d{8}T\d{6}Z\.bak$/.test(backup))
        assert.ok(fs.readFileSync(path.join(w.installDir, "state", "claude-config-backups", backup)).equals(original), "the backup is the configuration before the change")
        const rec = record(w)
        assert.equal(rec.claude?.state, "registered")
        assert.deepEqual(rec.claude?.entry, desiredEntry(w.installDir, w.profile))
        assert.equal(JSON.stringify(rec).includes(SECRET), false, "the record holds no configuration content")
        assert.equal(register.text.includes(SECRET), false)
    })

    test("a missing ~/.claude.json is left to Claude Code to create; no backup is needed", async () => {
        const w = world()
        await installed(w)
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 0, register.one("message"))
        assert.deepEqual(servers(w), { [SERVER_NAME]: desiredEntry(w.installDir, w.profile) })
        assert.deepEqual(backups(w), [])
    })

    test("without explicit consent nothing is changed", async () => {
        const w = world(personalConfig())
        await installed(w)
        const before = fs.readFileSync(w.configPath)
        const plan = await call(w, "plan", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile }))
        for (const consent of [{}, { consent: "no" }]) {
            const r = await call(w, "register", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile, planHash: plan.one("planHash"), ...consent }))
            assert.equal(r.code, 1)
            assert.match(r.one("message"), /consenso esplicito/)
        }
        assert.ok(fs.readFileSync(w.configPath).equals(before))
        assert.deepEqual(mutating(w), [])
        assert.deepEqual(backups(w), [])
    })

    test("a corrupted configuration stops everything and is neither modified nor recreated", async () => {
        const corrupt = `{"mcpServers": {"other-tool": {"command": "x", "env": {"K": "${SECRET}"}}`
        const w = world(corrupt)
        await installed(w)
        const plan = await call(w, "plan", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile }))
        assert.equal(plan.code, 1)
        assert.match(plan.one("message"), /non è un JSON valido.*non viene modificata né ricreata/)
        const register = await call(w, "register", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile, planHash: "0".repeat(64), consent: "yes" }))
        assert.equal(register.code, 1)
        assert.equal(fs.readFileSync(w.configPath, "utf8"), corrupt)
        assert.deepEqual(mutating(w), [])
        assert.equal(`${plan.text}${register.text}`.includes(SECRET), false)
    })

    test("a foreign fluent-reader entry is replaced only with specific consent; others preserved", async () => {
        const foreign = { command: "C:\\Elsewhere\\node.exe", args: ["server.js"], env: { TOKEN: SECRET }, timeout: 5 }
        const w = world(personalConfig({ [SERVER_NAME]: foreign }))
        await installed(w)
        const plan = await call(w, "plan", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile }))
        assert.equal(plan.one("action"), "replace-foreign")
        assert.match(plan.one("preview"), /ATTENZIONE: esiste già una voce "fluent-reader".*C:\\Elsewhere\\node\.exe, 1 argomenti, 1 variabili/)
        assert.equal(plan.text.includes(SECRET), false, "the foreign entry's values are not shown")
        const refused = await call(w, "register", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile, planHash: plan.one("planHash"), consent: "yes" }))
        assert.match(refused.one("message"), /non è stata confermata/)
        assert.deepEqual(servers(w)[SERVER_NAME], foreign)
        const replaced = await call(w, "register", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile, planHash: plan.one("planHash"), consent: "yes", replaceForeign: "yes" }))
        assert.equal(replaced.code, 0, replaced.one("message"))
        assert.deepEqual(servers(w)[SERVER_NAME], desiredEntry(w.installDir, w.profile))
        assert.deepEqual(Object.fromEntries(Object.entries(servers(w)).filter(([n]) => n !== SERVER_NAME)), otherServers())
        assert.equal(JSON.stringify(record(w)).includes(SECRET), false, "the replaced entry is not copied into the record")
    })

    test("a configuration changed after the preview: registration refused, nothing changed", async () => {
        const w = world(personalConfig())
        await installed(w)
        const plan = await call(w, "plan", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile }))
        fs.writeFileSync(w.configPath, JSON.stringify(personalConfig({ [SERVER_NAME]: { command: "C:\\x.exe" } })))
        const before = fs.readFileSync(w.configPath)
        const r = await call(w, "register", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile, planHash: plan.one("planHash"), consent: "yes", replaceForeign: "yes" }))
        assert.match(r.one("message"), /è cambiata dopo l'anteprima/)
        assert.ok(fs.readFileSync(w.configPath).equals(before))
        assert.deepEqual(mutating(w), [])
    })

    test("claude crashes before writing: nothing to undo, configuration as before", async () => {
        const w = world(personalConfig())
        await installed(w)
        const before = servers(w)
        w.claude = { addFails: "before-write" }
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 1)
        assert.match(register.one("message"), /registrazione non completata .*riportata allo stato precedente.*claude-config-backups/)
        assert.deepEqual(servers(w), before)
        assert.deepEqual(calls(w, "remove"), [], "nothing removed")
        assert.equal(record(w).claude, null, "nothing recorded as registered")
        assert.equal(backups(w).length, 1, "the backup stays available")
    })

    const unattributable: [string, FakeClaude][] = [
        ["claude reports a failure after writing", { addFails: "after-write" }],
        ["claude saves an entry different from the approved one", { addWritesWrong: true }],
    ]
    for (const [label, behaviour] of unattributable) {
        test(`${label}: the entry cannot be attributed, it is not removed; incomplete rollback reported`, async () => {
            const w = world(personalConfig())
            await installed(w)
            w.claude = behaviour
            const { register } = await planAndRegister(w)
            assert.equal(register.code, 1)
            assert.match(register.one("message"), /ripristino automatico NON è stato completato: .*non è attribuibile con certezza.*Serve un tuo intervento.*claude-config-backups/)
            assert.ok(Object.hasOwn(servers(w), SERVER_NAME), "the entry is left for the owner")
            assert.deepEqual(calls(w, "remove"), [], "no remove without proven ownership")
            assert.equal(record(w).claude?.state, "rollback-failed")
            assert.equal(record(w).claude?.fingerprint, null, "not attributed to the installer")
        })
    }

    test("another server changed during the registration (Claude Code open): our own entry undone, the change reported", async () => {
        const w = world(personalConfig())
        await installed(w)
        w.claude = { addTouchesOther: true }
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 1)
        assert.match(register.one("message"), /altri server MCP risultano cambiati.*riportata allo stato precedente/)
        assert.equal(Object.hasOwn(servers(w), SERVER_NAME), false, "our entry removed")
        assert.deepEqual((servers(w)["other-tool"] as { command: string }).command, "C:\\Tools\\changed.exe", "the concurrent change is not overwritten")
    })

    test("reinstallation is idempotent: identical entry, no CLI change, no new backup", async () => {
        const w = world(personalConfig())
        await installed(w)
        await planAndRegister(w)
        const callsBefore = mutating(w).length
        const config = fs.readFileSync(w.configPath)
        const again = await planAndRegister(w)
        assert.equal(again.plan.one("action"), "none")
        assert.match(again.plan.one("preview"), /nessuna/)
        assert.equal(again.register.code, 0)
        assert.equal(mutating(w).length, callsBefore)
        assert.ok(fs.readFileSync(w.configPath).equals(config))
        assert.equal(backups(w).length, 1)
        assert.equal(record(w).claude?.state, "registered")
    })

    test("upgrade simulation: an older installation's own entry (other profile) is updated as its own", async () => {
        const w = world(personalConfig())
        await installed(w)
        await planAndRegister(w)
        // The same installation, recorded as 0.0.9 with an earlier profile: no second package is built.
        const oldProfile = buildSmokeProfile(path.join(w.home, "Profili Fluent", "vecchio")).dir
        const rec = record(w)
        const oldEntry = desiredEntry(w.installDir, oldProfile)
        fs.writeFileSync(path.join(w.installDir, RECORD_NAME), JSON.stringify({ ...rec, version: "0.0.9", profileDir: oldProfile, claude: { ...rec.claude, entry: oldEntry, fingerprint: entryFingerprint(oldEntry) } }))
        const doc = readConfig(w)
        fs.writeFileSync(w.configPath, JSON.stringify({ ...doc, mcpServers: { ...(doc.mcpServers as object), [SERVER_NAME]: oldEntry } }))
        const check = await call(w, "check-install-dir", installRequest(w))
        assert.equal(check.one("mode"), "upgrade")
        assert.equal(check.one("previousProfile"), oldProfile)
        await installed(w)
        assert.equal(record(w).claude?.state, "registered", "the new record keeps the registration")
        const { plan, register } = await planAndRegister(w)
        assert.equal(plan.one("action"), "replace-own")
        assert.equal(register.code, 0, register.one("message"))
        assert.deepEqual(servers(w)[SERVER_NAME], desiredEntry(w.installDir, w.profile))
        assert.equal(record(w).version, VERSION)
    })
})

describe("setup helper: conservative Claude Code rollback (Major 3)", () => {
    const injected = (step: string): HelperDeps["checkpoint"] => (s) => {
        if (s === step) throw new Error(`injected failure at ${s}`)
    }

    test("add-json succeeded, immediate rollback: only the entry read back as ours is removed", async () => {
        const w = world(personalConfig())
        await installed(w)
        w.checkpoint = injected("after-readback")
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 1)
        assert.match(register.one("message"), /injected failure.*riportata allo stato precedente/)
        assert.equal(Object.hasOwn(servers(w), SERVER_NAME), false)
        assert.equal(calls(w, "remove").length, 1)
        assert.equal(record(w).claude, null)
    })

    test("add-json succeeded, entry changed before the rollback: not removed, owner intervention required", async () => {
        const w = world(personalConfig())
        await installed(w)
        w.checkpoint = (s) => {
            if (s === "after-readback") throw new Error("injected failure")
            if (s === "before-rollback") changeEntry(w, (e) => ({ ...e, timeout: 9000 }))
        }
        const { register } = await planAndRegister(w)
        assert.match(register.one("message"), /NON è stato completato: .*non è attribuibile con certezza/)
        assert.equal((servers(w)[SERVER_NAME] as { timeout?: number }).timeout, 9000, "the concurrent change is preserved")
        assert.deepEqual(calls(w, "remove"), [])
    })

    test("add-json failed and another fluent-reader entry appeared: not removed", async () => {
        const w = world(personalConfig())
        await installed(w)
        w.claude = { addFails: "before-write" }
        w.checkpoint = (s) => {
            if (s === "before-rollback") {
                const doc = readConfig(w)
                fs.writeFileSync(w.configPath, JSON.stringify({ ...doc, mcpServers: { ...(doc.mcpServers as object), [SERVER_NAME]: { command: "C:\\Someone\\else.exe" } } }))
            }
        }
        const { register } = await planAndRegister(w)
        assert.match(register.one("message"), /NON è stato completato/)
        assert.deepEqual(servers(w)[SERVER_NAME], { command: "C:\\Someone\\else.exe" })
        assert.deepEqual(calls(w, "remove"), [])
    })

    test("entry already absent at rollback time: no removal", async () => {
        const w = world(personalConfig())
        await installed(w)
        w.checkpoint = (s) => {
            if (s === "after-readback") throw new Error("injected failure")
            if (s === "before-rollback") fs.writeFileSync(w.configPath, JSON.stringify(personalConfig()))
        }
        const { register } = await planAndRegister(w)
        assert.match(register.one("message"), /riportata allo stato precedente/)
        assert.deepEqual(calls(w, "remove"), [])
        assert.deepEqual(servers(w), otherServers())
    })

    test("consented replacement, safe rollback: the previous entry is put back exactly", async () => {
        const foreign = { command: "C:\\Elsewhere\\node.exe", args: ["server.js"], env: { TOKEN: SECRET }, timeout: 5 }
        const w = world(personalConfig({ [SERVER_NAME]: foreign }))
        await installed(w)
        w.claude = { addFails: "before-write" }
        const { register } = await planAndRegister(w, { replaceForeign: "yes" })
        assert.match(register.one("message"), /riportata allo stato precedente/)
        assert.deepEqual(servers(w)[SERVER_NAME], foreign, "unknown fields included")
        assert.deepEqual(Object.fromEntries(Object.entries(servers(w)).filter(([n]) => n !== SERVER_NAME)), otherServers())
        assert.deepEqual(calls(w, "add-json").map((c) => JSON.parse(c[3] as string) as unknown), [desiredEntry(w.installDir, w.profile), foreign])
    })

    test("consented replacement, concurrent change before the rollback: incomplete, the concurrent entry preserved", async () => {
        const foreign = { command: "C:\\Elsewhere\\node.exe", args: ["server.js"] }
        const w = world(personalConfig({ [SERVER_NAME]: foreign }))
        await installed(w)
        w.checkpoint = (s) => {
            if (s === "after-readback") throw new Error("injected failure")
            if (s === "before-rollback") changeEntry(w, (e) => ({ ...e, alwaysLoad: true }))
        }
        const { register } = await planAndRegister(w, { replaceForeign: "yes" })
        assert.match(register.one("message"), /NON è stato completato/)
        assert.equal((servers(w)[SERVER_NAME] as { alwaysLoad?: boolean }).alwaysLoad, true)
        assert.equal(calls(w, "add-json").length, 1, "the previous entry is not forced back")
    })

    test("consented replacement, the name taken again before the restore: the previous entry is not written over it", async () => {
        const foreign = { command: "C:\\Elsewhere\\node.exe" }
        const w = world(personalConfig({ [SERVER_NAME]: foreign }))
        await installed(w)
        w.claude = { addFails: "before-write" }
        w.checkpoint = (s) => {
            if (s === "before-rollback-restore") {
                const doc = readConfig(w)
                fs.writeFileSync(w.configPath, JSON.stringify({ ...doc, mcpServers: { ...(doc.mcpServers as object), [SERVER_NAME]: { command: "C:\\New\\one.exe" } } }))
            }
        }
        const { register } = await planAndRegister(w, { replaceForeign: "yes" })
        assert.match(register.one("message"), /nel frattempo è comparsa un'altra voce/)
        assert.deepEqual(servers(w)[SERVER_NAME], { command: "C:\\New\\one.exe" })
    })

    test("the CLI removal fails during the rollback: explicit error, no false success; the entry stays attributable", async () => {
        const w = world(personalConfig())
        await installed(w)
        w.checkpoint = injected("after-readback")
        w.claude = { removeFails: true }
        const { register } = await planAndRegister(w)
        assert.match(register.one("message"), /NON è stato completato: claude mcp remove non è riuscito/)
        assert.equal(record(w).claude?.state, "rollback-failed")
        assert.equal(record(w).claude?.fingerprint, entryFingerprint(servers(w)[SERVER_NAME]), "the uninstaller can still recognise it")
        w.claude = {}
        w.checkpoint = undefined
        const r = await call(w, "unregister", { installDir: w.installDir })
        assert.equal(r.one("outcome"), "removed")
    })
})

describe("setup helper: identity of the registration (Major 2)", () => {
    async function registered(claude: FakeClaude = { addsMeta: true }): Promise<World> {
        const w = world(personalConfig())
        await installed(w)
        w.claude = claude
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 0, register.one("message"))
        w.claude = {}
        return w
    }

    test("the identity is the entry as the CLI saved it (extra nested fields included)", async () => {
        const w = await registered()
        const saved = servers(w)[SERVER_NAME]
        assert.deepEqual((saved as { meta: unknown }).meta, { source: "cli", flags: [1, 2] })
        assert.equal(record(w).claude?.fingerprint, entryFingerprint(saved))
        assert.equal((await call(w, "plan", installRequest(w, { claudeExe: w.claudeExe, profileDir: w.profile }))).one("action"), "none")
    })

    const changes: [string, (e: Record<string, unknown>) => Record<string, unknown>][] = [
        ["timeout added", (e) => ({ ...e, timeout: 30000 })],
        ["alwaysLoad added", (e) => ({ ...e, alwaysLoad: true })],
        ["an unknown field added", (e) => ({ ...e, "x-custom": "value" })],
        ["a nested property changed", (e) => ({ ...e, meta: { ...(e.meta as object), source: "user" } })],
        ["a nested array element changed", (e) => ({ ...e, meta: { ...(e.meta as object), flags: [2, 1] } })],
        ["an args element changed", (e) => ({ ...e, args: [...(e.args as string[]).slice(0, 2), "C:\\Other\\profile"] })],
        ["an env value added", (e) => ({ ...e, env: { DEBUG: "1" } })],
    ]
    for (const [label, change] of changes) {
        test(`uninstall: ${label} → recognised as modified, not removed`, async () => {
            const w = await registered()
            changeEntry(w, change)
            const changed = servers(w)[SERVER_NAME]
            const r = await call(w, "unregister", { installDir: w.installDir })
            assert.equal(r.one("outcome"), "modified")
            assert.deepEqual(servers(w)[SERVER_NAME], changed)
            assert.deepEqual(calls(w, "remove"), [])
        })
    }

    test("uninstall: the identical entry with its keys in another order is recognised and removed", async () => {
        const w = await registered()
        const stored = JSON.stringify(servers(w)[SERVER_NAME])
        changeEntry(w, (e) => {
            const reversed = Object.fromEntries(Object.entries(e).reverse())
            reversed.meta = Object.fromEntries(Object.entries(e.meta as object).reverse())
            return reversed
        })
        assert.notEqual(JSON.stringify(servers(w)[SERVER_NAME]), stored, "same content, other key order")
        const r = await call(w, "unregister", { installDir: w.installDir })
        assert.equal(r.one("outcome"), "removed")
        assert.deepEqual(servers(w), otherServers())
    })
})

describe("setup helper: repeatable uninstallation (Major 4)", () => {
    const lockRaw = JSON.parse(fs.readFileSync(path.join(COMPILED_ROOT, "..", "installer", "runtime-lock.json"), "utf8")) as unknown

    /** A synthetic package plus the REAL compiled helper in current\, record written and committed. */
    async function fullInstall(w: World, register = true): Promise<string> {
        const current = path.join(w.installDir, "current")
        syntheticTree(current, lockRaw)
        const setup = path.join(current, "setup")
        for (const relative of setupClosure(COMPILED_ROOT)) {
            fs.mkdirSync(path.dirname(path.join(setup, relative)), { recursive: true })
            fs.copyFileSync(path.join(COMPILED_ROOT, relative), path.join(setup, relative))
        }
        fs.writeFileSync(path.join(setup, "package.json"), JSON.stringify({ type: "module", private: true }))
        fs.writeFileSync(path.join(current, INVENTORY), JSON.stringify(buildInventory(current, VERSION)))
        await installed(w)
        if (register) assert.equal((await planAndRegister(w)).register.code, 0)
        return current
    }

    /** Runs the helper COPIED INTO the installation, as the uninstaller does from its own copy. */
    function installedHelper(w: World, command: string, request: Record<string, string>): Map<string, string[]> & { code: number | null } {
        counter++
        const dir = path.join(root, `uninstall io ${counter}`)
        fs.mkdirSync(dir)
        fs.writeFileSync(path.join(dir, "request.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(Object.entries(request).map(([k, v]) => `${k}=${v}\r\n`).join(""), "utf16le")]))
        const run = spawnSync(process.execPath, [path.join(w.installDir, "current", "setup", "installer", "setup", "fr-setup.js"), command, path.join(dir, "request.txt"), path.join(dir, "result.txt")], { env: { ...w.env, SystemRoot: process.env.SystemRoot }, encoding: "utf8", windowsHide: true })
        const fields = decodeResult(fs.readFileSync(path.join(dir, "result.txt"))) as Map<string, string[]> & { code: number | null }
        fields.code = run.status
        return fields
    }

    test("a foreign file in current stops the uninstallation before anything is removed; after moving it away the second attempt succeeds with the same installed helper", async () => {
        const w = world(personalConfig())
        const current = await fullInstall(w)
        const foreign = path.join(current, "app", "server", "my notes é.txt")
        fs.writeFileSync(foreign, "mine")
        const before = fs.readFileSync(w.configPath)
        const first = installedHelper(w, "uninstall-preflight", { installDir: w.installDir })
        assert.equal(first.code, 1)
        assert.match(first.get("message")?.join("") ?? "", /file che non appartengono all'installazione: app\/server\/my notes é\.txt.*nulla è stato rimosso/)
        assert.ok(fs.readFileSync(w.configPath).equals(before), "the Claude Code entry is untouched")
        const removeFirst = await call(w, "remove-tree", { installDir: w.installDir, tree: "current" })
        assert.equal(removeFirst.code, 1, "remove-tree refuses as well")
        assert.ok(fs.existsSync(path.join(current, "setup", "installer", "setup", "fr-setup.js")) && fs.existsSync(path.join(current, "app", "runtime", "node.exe")), "the helper is intact")
        fs.renameSync(foreign, path.join(w.home, "my notes é.txt"))
        const second = installedHelper(w, "uninstall-preflight", { installDir: w.installDir })
        assert.equal(second.code, 0, second.get("message")?.join(""))
        assert.deepEqual(second.get("claude"), ["ours"])
        assert.equal((await call(w, "unregister", { installDir: w.installDir })).one("outcome"), "removed")
        const removed = await call(w, "remove-tree", { installDir: w.installDir, tree: "current" })
        assert.equal(removed.code, 0, removed.one("message"))
        assert.equal(fs.existsSync(current), false)
        assert.ok(fs.existsSync(path.join(w.installDir, RECORD_NAME)), "the record goes last (NSIS)")
        assert.ok(fs.existsSync(path.join(w.profile, "fluent-reader.db")) && fs.existsSync(path.join(w.home, "my notes é.txt")), "personal files untouched")
        assert.deepEqual(servers(w), otherServers())
    })

    test("a failure removing an owned file stops early: helper and inventory intact, the next attempt completes", async () => {
        const w = world(personalConfig())
        const current = await fullInstall(w, false)
        assert.throws(() => removeTree(current, (file) => {
            if (file.endsWith("main.js")) throw Object.assign(new Error("busy"), { code: "EBUSY" })
            fs.unlinkSync(file)
        }), /impossibile rimuovere current\/app\/server\/dist\/main\.js \(EBUSY\).*Il programma di supporto e l'inventario sono intatti/)
        assert.ok(fs.existsSync(path.join(current, INVENTORY)))
        const again = installedHelper(w, "uninstall-preflight", { installDir: w.installDir })
        assert.equal(again.code, 0, again.get("message")?.join(""))
        assert.deepEqual(removeTree(current).removed > 0, true)
        assert.equal(fs.existsSync(current), false)
    })

    const outcomes: [string, (w: World) => void, string][] = [
        ["unregister fails (CLI error)", (w) => (w.claude = { removeFails: true }), "cli-error"],
        ["registration already absent", (w) => fs.writeFileSync(w.configPath, JSON.stringify(personalConfig())), "absent"],
        ["corrupted configuration", (w) => fs.writeFileSync(w.configPath, "{ not json"), "config-error"],
        ["claude.exe moved away", (w) => fs.rmSync(w.claudeExe), "claude-missing"],
    ]
    for (const [label, setup, expected] of outcomes) {
        test(`unregister: ${label} → ${expected}; files and record untouched`, async () => {
            const w = world(personalConfig())
            const current = await fullInstall(w)
            setup(w)
            const r = await call(w, "unregister", { installDir: w.installDir })
            assert.equal(r.one("outcome"), expected)
            assert.ok(fs.existsSync(path.join(current, INVENTORY)) && fs.existsSync(path.join(w.installDir, RECORD_NAME)))
            if (expected === "cli-error") assert.ok(Object.hasOwn(servers(w), SERVER_NAME))
        })
    }

    test("an installation without a Claude Code registration: not-configured, uninstall can proceed", async () => {
        const w = world(personalConfig())
        await fullInstall(w, false)
        assert.deepEqual((await call(w, "uninstall-preflight", { installDir: w.installDir })).fields.get("claude"), ["not-configured"])
        assert.equal((await call(w, "unregister", { installDir: w.installDir })).one("outcome"), "not-configured")
        assert.deepEqual(mutating(w), [])
    })

    test("record or helper not available: the preflight refuses, nothing is removed", async () => {
        const w = world(personalConfig())
        const current = await fullInstall(w, false)
        fs.rmSync(path.join(current, "setup", "installer", "setup", "fr-setup.js"))
        assert.match((await call(w, "uninstall-preflight", { installDir: w.installDir })).one("message"), /programma di supporto è incompleto/)
        const v = world(personalConfig())
        await fullInstall(v, false)
        fs.rmSync(path.join(v.installDir, RECORD_NAME))
        assert.match((await call(v, "uninstall-preflight", { installDir: v.installDir })).one("message"), /registro di installazione mancante/)
        assert.ok(fs.existsSync(path.join(v.installDir, "current", INVENTORY)))
    })
})

describe("setup helper: remove-tree confined to the authorised installation (Major 5)", () => {
    const lockRaw = JSON.parse(fs.readFileSync(path.join(COMPILED_ROOT, "..", "installer", "runtime-lock.json"), "utf8")) as unknown

    function tree(dir: string): void {
        syntheticTree(dir, lockRaw)
        fs.writeFileSync(path.join(dir, INVENTORY), JSON.stringify(buildInventory(dir, VERSION)))
    }

    test("current, .staging and previous of the recorded installation are accepted", async () => {
        const w = world()
        for (const name of ["current", ".staging", "previous"]) tree(path.join(w.installDir, name))
        await installed(w)
        for (const name of [".staging", "previous", "current"]) {
            const r = await call(w, "remove-tree", { installDir: w.installDir, tree: name })
            assert.equal(r.code, 0, `${name}: ${r.one("message")}`)
            assert.equal(fs.existsSync(path.join(w.installDir, name)), false)
        }
    })

    test("Codex counterexample: an arbitrary directory under the user's home with a valid-looking previous/.staging and no record is refused; nothing changes", async () => {
        const w = world()
        const arbitrary = path.join(w.home, "AppData", "Local", "Strumenti di prova")
        for (const name of ["previous", ".staging", "current"]) tree(path.join(arbitrary, name))
        const before = snapshotDir(arbitrary)
        for (const tree_ of ["previous", ".staging", "current"]) {
            const r = await call(w, "remove-tree", { installDir: arbitrary, tree: tree_ })
            assert.equal(r.code, 1, tree_)
            assert.match(r.one("message"), /non ha un registro di installazione: nulla viene rimosso/)
        }
        assert.deepEqual(snapshotDir(arbitrary), before, "the external tree is untouched")
    })

    test("same-named trees elsewhere, forged or copied records, junctions, traversal and missing trees are refused; nothing outside is touched", async () => {
        const w = world()
        tree(path.join(w.installDir, "current"))
        await installed(w)
        // trees named like ours outside the installation
        const external = path.join(root, `external ${counter} é`)
        for (const name of ["current", "previous"]) tree(path.join(external, name))
        const inHome = path.join(w.home, "Documents", "something")
        tree(path.join(inHome, "current"))
        fs.writeFileSync(path.join(inHome, "notes.txt"), "mine")
        // a record copied from the real installation into another directory
        const copied = path.join(w.home, "AppData", "Local", "Copia")
        tree(path.join(copied, "current"))
        fs.copyFileSync(path.join(w.installDir, RECORD_NAME), path.join(copied, RECORD_NAME))
        // current as a junction to an external tree
        const linked = path.join(w.home, "AppData", "Local", "Linked install")
        fs.mkdirSync(linked)
        fs.symlinkSync(path.join(external, "current"), path.join(linked, "current"), "junction")
        const outsideBefore = snapshotDir(external)
        const homeTreeBefore = snapshotDir(inHome)
        const cases: [Record<string, string>, RegExp][] = [
            [{ installDir: external, tree: "current" }, /dentro la cartella del tuo utente/],
            [{ installDir: external, tree: "previous" }, /dentro la cartella del tuo utente/],
            [{ installDir: inHome, tree: "current" }, /non ha un registro di installazione/],
            [{ installDir: inHome, tree: "previous" }, /non ha un registro di installazione/],
            [{ installDir: copied, tree: "current" }, /appartiene a un'altra cartella/],
            [{ installDir: w.installDir, tree: "..\\external" }, /cartella non ammessa/],
            [{ installDir: w.installDir, tree: "current\\..\\..\\x" }, /cartella non ammessa/],
            [{ installDir: `${w.installDir}\\..\\${path.basename(copied)}`, tree: "current" }, /"\." o "\.\."/],
            [{ installDir: w.installDir, tree: "previous" }, /previous non esiste/],
            [{ root: path.join(w.installDir, "current") }, /manca installDir/],
        ]
        for (const [request, message] of cases) {
            const r = await call(w, "remove-tree", request)
            assert.notEqual(r.code, 0, JSON.stringify(request))
            assert.match(r.one("message"), message, JSON.stringify(request))
        }
        writeRecord(path.join(linked, RECORD_NAME), { schemaVersion: 1, product: PRODUCT, installDir: linked, generation: "ab".repeat(16), version: VERSION, bundleSha256: "a".repeat(64), installedAt: "2026-10-28T10:00:00.000Z", profileDir: w.profile, claude: null })
        const junction = await call(w, "remove-tree", { installDir: linked, tree: "current" })
        assert.match(junction.one("message"), /collegamento o junction/)
        assert.deepEqual(snapshotDir(external), outsideBefore, "external trees untouched")
        assert.deepEqual(snapshotDir(inHome), homeTreeBefore)
        assert.ok(fs.existsSync(path.join(copied, "current", INVENTORY)) && fs.existsSync(path.join(w.installDir, "current", INVENTORY)))
    })

    test("an inventory that names a path outside its tree, or a link inside the tree: refused, nothing removed", async () => {
        const w = world()
        const current = path.join(w.installDir, "current")
        tree(current)
        await installed(w)
        const inventory = JSON.parse(fs.readFileSync(path.join(current, INVENTORY), "utf8")) as { files: { path: string }[] }
        fs.writeFileSync(path.join(current, INVENTORY), JSON.stringify({ ...inventory, files: [...inventory.files, { path: "../../outside.txt", size: 1, sha256: "0".repeat(64) }] }))
        assert.match((await call(w, "remove-tree", { installDir: w.installDir, tree: "current" })).one("message"), /percorso non ammesso/)
        fs.writeFileSync(path.join(current, INVENTORY), JSON.stringify(inventory))
        const target = path.join(root, `link target ${counter}`)
        fs.mkdirSync(target)
        fs.writeFileSync(path.join(target, "keep.txt"), "keep")
        fs.symlinkSync(target, path.join(current, "app", "link"), "junction")
        assert.match((await call(w, "remove-tree", { installDir: w.installDir, tree: "current" })).one("message"), /non è verificabile/)
        assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "keep")
        assert.ok(fs.existsSync(path.join(current, INVENTORY)))
    })
})

describe("setup helper: installed tree", () => {
    const lockRaw = JSON.parse(fs.readFileSync(path.join(COMPILED_ROOT, "..", "installer", "runtime-lock.json"), "utf8")) as unknown

    function tree(): string {
        counter++
        const current = path.join(root, `tree ${counter} é`, "current")
        syntheticTree(current, lockRaw)
        fs.mkdirSync(path.join(current, "setup", "installer", "setup"), { recursive: true })
        fs.writeFileSync(path.join(current, "setup", "installer", "setup", "fr-setup.js"), "// helper")
        fs.writeFileSync(path.join(current, INVENTORY), JSON.stringify(buildInventory(current, VERSION)))
        return current
    }

    const nodeExec: ExecFn = (_file, args) => ({ status: 0, stdout: args[0] === "--version" ? "v24.22.1\n" : "win32 x64\n", stderr: "" })

    test("verification: inventory, manifest, runtime identity and the (synthetic) self-test", async () => {
        const current = tree()
        let selfTests = 0
        const lines = await verifyTree(current, { exec: nodeExec, env: {}, selfTest: async () => (selfTests++, ["self-test: synthetic"]) })
        assert.ok(lines.some((l) => /Runtime: Node\.js v24\.22\.1 win32 x64/.test(l)))
        assert.equal(selfTests, 1)
        await verifyTree(current, { exec: nodeExec, env: {}, selfTest: null })
        assert.equal(selfTests, 1, "the quick check skips the self-test")
    })

    test("verification refuses an altered, missing or extra file and a wrong runtime", async () => {
        const altered = tree()
        fs.writeFileSync(path.join(altered, "app", "server", "dist", "main.js"), "// tampered")
        await assert.rejects(verifyTree(altered, { exec: nodeExec, env: {}, selfTest: null }), /alterato: app\/server\/dist\/main\.js/)
        const extra = tree()
        fs.writeFileSync(path.join(extra, "app", "extra.js"), "x")
        await assert.rejects(verifyTree(extra, { exec: nodeExec, env: {}, selfTest: null }), /non corrispondono all'inventario/)
        const missing = tree()
        fs.rmSync(path.join(missing, "app", "runtime", "LICENSE"))
        await assert.rejects(verifyTree(missing, { exec: nodeExec, env: {}, selfTest: null }), /non corrispondono all'inventario/)
        await assert.rejects(verifyTree(tree(), { exec: () => ({ status: 0, stdout: "v22.0.0\n", stderr: "" }), env: {}, selfTest: null }), /runtime incluso inatteso/)
    })

    test("removal plan: a user's file blocks the removal (nothing deleted); the helper and the inventory come last", () => {
        const current = tree()
        const order = removalPlan(current)
        assert.equal(order.at(-1), INVENTORY)
        assert.deepEqual(order.slice(-3, -1).sort(), ["app/runtime/node.exe", "setup/installer/setup/fr-setup.js"])
        const userFile = path.join(current, "app", "server", "my notes.txt")
        fs.writeFileSync(userFile, "mine")
        const before = snapshotDir(current)
        assert.throws(() => removeTree(current), /my notes\.txt.*nulla è stato rimosso/)
        assert.deepEqual(snapshotDir(current), before)
        fs.rmSync(userFile)
        assert.ok(removeTree(current).removed > 8)
        assert.equal(fs.existsSync(current), false)
    })
})

describe("setup helper: uninstallation of the Claude Code entry", () => {
    async function registered(): Promise<World> {
        const w = world(personalConfig())
        await installed(w)
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 0, register.one("message"))
        return w
    }

    test("the entry created by the installer is removed; every other server stays", async () => {
        const w = await registered()
        const r = await call(w, "unregister", { installDir: w.installDir })
        assert.equal(r.code, 0)
        assert.equal(r.one("outcome"), "removed")
        assert.deepEqual(servers(w), otherServers())
        assert.equal(record(w).claude?.state, "removed")
        assert.equal(r.text.includes(SECRET), false)
        assert.equal((await call(w, "unregister", { installDir: w.installDir })).one("outcome"), "not-configured", "a repeated attempt has nothing left to do")
    })

    test("a moved claude.exe (extension updated): nothing removed (claude-missing); an override works", async () => {
        const w = await registered()
        const moved = path.join(w.home, "moved", "claude.exe")
        fs.mkdirSync(path.dirname(moved), { recursive: true })
        fs.renameSync(w.claudeExe, moved)
        const r = await call(w, "unregister", { installDir: w.installDir })
        assert.equal(r.one("outcome"), "claude-missing")
        assert.ok(Object.hasOwn(servers(w), SERVER_NAME))
        const fakeMoved: World = { ...w, claudeExe: moved }
        const again = await call(w, "unregister", { installDir: w.installDir, claudeExe: moved }, deps(fakeMoved))
        assert.equal(again.one("outcome"), "removed")
        assert.deepEqual(servers(w), otherServers())
    })

    test("unregister refuses a directory that is not a recorded installation", async () => {
        const w = world(personalConfig())
        assert.match((await call(w, "unregister", { installDir: w.installDir })).one("message"), /registro di installazione mancante/)
    })
})

describe("setup helper: process protocol", () => {
    test("the compiled helper runs as a process with UTF-16LE request and result files", () => {
        const w = world()
        counter++
        const dir = path.join(root, `process ${counter} é`)
        fs.mkdirSync(dir)
        const request = path.join(dir, "request.txt")
        const result = path.join(dir, "result.txt")
        fs.writeFileSync(request, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`profileDir=${w.profile}\r\ninstallDir=${w.installDir}\r\n`, "utf16le")]))
        const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "installer", "setup", "fr-setup.js")
        const run = spawnSync(process.execPath, [helper, "check-profile", request, result], { encoding: "utf8", windowsHide: true })
        assert.equal(run.status, 0, run.stderr)
        assert.equal(run.stdout, "", "the helper prints nothing")
        assert.equal(run.stderr, "")
        const fields = decodeResult(fs.readFileSync(result))
        assert.deepEqual(fields.get("status"), ["ok"])
        assert.deepEqual(fields.get("canonical"), [w.profile])
        const bad = spawnSync(process.execPath, [helper, "check-profile", request], { encoding: "utf8", windowsHide: true })
        assert.equal(bad.status, 2, "wrong arguments: internal error code")
    })
})
