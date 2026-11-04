/**
 * FR-MCP-04-BETA-02: the setup helper on SYNTHETIC data only — a synthetic
 * Windows user directory (USERPROFILE), synthetic Fluent Reader profiles
 * (the smoke fixture), synthetic ~/.claude.json files and a simulated
 * claude.exe that implements `mcp add-json` / `mcp remove` on them. No real
 * profile, Claude configuration or Claude Code process is ever used.
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { type ExecFn } from "../../installer/lib/common.js"
import { buildManifest, MANIFEST, type LicenseRecord } from "../../installer/lib/package-content.js"
import { parseRuntimeLock } from "../../installer/lib/runtime-lock.js"
import { setupClosure } from "../../installer/lib/installer-build.js"
import { buildInventory, INVENTORY, removalPlan, removeTree, verifyTree } from "../../installer/setup/app.js"
import { BACKUP_NAME, createDesktopBackup, migrateLegacyBackups, privateBackupDir, privateDesktopBackupDir, recordedBackup, recordedDesktopBackup, type MigrationCheckpoint } from "../../installer/setup/backups.js"
import { createProbe, DEFAULT_SUBDIR, otherProfileLocation, writeProbe, type DirectoryProbe } from "../../installer/setup/checks.js"
import { SERVER_NAME } from "../../installer/setup/claude.js"
import { desiredDesktopEntry } from "../../installer/setup/desktop.js"
import { main, type HelperDeps } from "../../installer/setup/fr-setup.js"
import { decodeResult } from "../../installer/setup/protocol.js"
import { DESKTOP_BACKUP_NAME, entryFingerprint, PRODUCT, RECORD_NAME, readRecord, writeRecord, type DesktopRegistration, type InstallRecord } from "../../installer/setup/record.js"
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

interface World {
    readonly home: string
    readonly env: NodeJS.ProcessEnv
    readonly installDir: string
    readonly profile: string
    /** The synthetic configuration of Claude Desktop the tests select. */
    readonly configPath: string
    /** Every program the helper tried to start. */
    readonly calls: string[][]
    /** Concurrent changes or failures injected at the helper's named steps. */
    checkpoint?: HelperDeps["checkpoint"]
    /** The rename that replaces the configuration. */
    replace?: ((from: string, to: string) => void) | undefined
    /** What reg.exe answers for a key (policies): nothing found by default. */
    policy?: Record<string, string>
}

function world(config?: unknown | string, homeDir?: string): World {
    counter++
    const home = homeDir ?? path.join(root, `user ${counter} é`)
    fs.mkdirSync(path.join(home, "AppData", "Roaming", "Claude"), { recursive: true })
    fs.mkdirSync(path.join(home, "AppData", "Local"), { recursive: true })
    const configPath = path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
    if (config !== undefined) fs.writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config, null, 2))
    const profile = buildSmokeProfile(path.join(home, "Profili Fluent", "profilo è 😀")).dir
    const env = { USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), PATH: "", SystemRoot: process.env.SystemRoot ?? "" }
    return { home, env, installDir: path.join(home, "AppData", "Local", "Fluent Reader MCP é 😀"), profile, configPath, calls: [] }
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
        "foundry-mcp": { command: "C:\\Tools\\foundry.exe", args: ["--stdio"], env: { FOUNDRY_API_KEY: SECRET } },
        remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
    }
}

function personalConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { preferences: { sidebarMode: "chat", token: SECRET, future: { nested: [1, { deep: true }] } }, unknownField: 42, mcpServers: { ...otherServers(), ...extra } }
}

function readConfig(w: World): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(w.configPath, "utf8")) as Record<string, unknown>
}

function servers(w: World): Record<string, unknown> {
    return (readConfig(w).mcpServers ?? {}) as Record<string, unknown>
}

function deps(w: World): HelperDeps {
    return {
        env: w.env,
        // the only program the helper may start here is reg.exe, read-only, for the policy
        exec: (file, args) => {
            w.calls.push([path.basename(file), ...args])
            const answer = w.policy?.[args[1] as string]
            return answer === undefined ? { status: 1, stdout: "", stderr: "not found" } : { status: 0, stdout: answer, stderr: "" }
        },
        selfTest: async () => ["self-test: synthetic"],
        now: () => new Date("2026-10-28T10:00:00Z"),
        checkpoint: (step) => w.checkpoint?.(step),
        desktopReplace: (from, to) => (w.replace ?? fs.renameSync)(from, to),
    }
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
/** Whether `child` is strictly below `base` (lexically, after resolution, case-insensitive on Windows): no "..", no sibling sharing a prefix. */
function strictlyInside(child: string, base: string): boolean {
    const relative = path.win32.relative(path.win32.resolve(base).toLowerCase(), path.win32.resolve(child).toLowerCase())
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative)
}

/**
 * The guard of every fixture that writes: `dir` must be an absolute drive path strictly inside one of the
 * test areas (by default the temp root and the synthetic machines' base), never the area itself, never the
 * working directory. The part of `dir` that already exists is resolved (realpath) and must still be inside
 * the same area: a junction or link there does not lead the fixture out.
 */
function assertInTestArea(dir: string, areas: readonly (string | null)[] = [root, awayRoot]): void {
    const fail = (why: string): never => assert.fail(`fixture outside the test area (${why}): ${JSON.stringify(dir)}`)
    if (typeof dir !== "string" || dir.length === 0) fail("empty")
    if (!/^[A-Za-z]:[\\/]/.test(dir) || !path.win32.isAbsolute(dir)) fail("not an absolute drive path")
    const resolved = path.win32.resolve(dir)
    const area = areas.find((a): a is string => a !== null && strictlyInside(resolved, a))
    if (area === undefined) fail("not strictly inside a test area")
    let existing = resolved
    while (!fs.existsSync(existing)) existing = path.win32.dirname(existing)
    const real = fs.realpathSync.native(existing)
    if (!(samePathCI(real, fs.realpathSync.native(area as string)) || strictlyInside(real, fs.realpathSync.native(area as string)))) fail(`resolves to ${real}`)
}

function samePathCI(a: string, b: string): boolean {
    return path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase()
}

async function installed(w: World, dir = w.installDir): Promise<void> {
    // never relative, never outside the fixtures: an empty path would write into the working directory (the repository)
    assertInTestArea(dir)
    fs.mkdirSync(path.join(dir, "current"), { recursive: true })
    const file = path.join(dir, RECORD_NAME)
    const previous = fs.existsSync(file) ? readRecord(file) : null
    writeRecord(file, { schemaVersion: 1, product: PRODUCT, installDir: dir, generation: "ab".repeat(16), version: VERSION, bundleSha256: "a".repeat(64), installedAt: "2026-10-28T10:00:00.000Z", profileDir: w.profile, claude: previous?.claude ?? null })
}

/** The registered entry as stored in the synthetic configuration, with one change applied. */
function changeEntry(w: World, change: (entry: Record<string, unknown>) => Record<string, unknown>): void {
    const doc = readConfig(w)
    const mcp = doc.mcpServers as Record<string, unknown>
    fs.writeFileSync(w.configPath, JSON.stringify({ ...doc, mcpServers: { ...mcp, [SERVER_NAME]: change(structuredClone(mcp[SERVER_NAME]) as Record<string, unknown>) } }))
}

function planRequest(w: World, extra: Record<string, string> = {}): Record<string, string> {
    return installRequest(w, { configPath: w.configPath, profileDir: w.profile, ...extra })
}

async function planAndRegister(w: World, extra: Record<string, string> = {}): Promise<{ plan: Answer; register: Answer }> {
    const plan = await call(w, "desktop-plan", planRequest(w))
    assert.equal(plan.code, 0, plan.one("message"))
    const register = await call(w, "desktop-register", planRequest(w, { planHash: plan.one("planHash"), consent: "yes", ...extra }))
    return { plan, register }
}

function record(w: World): InstallRecord {
    return JSON.parse(fs.readFileSync(path.join(w.installDir, RECORD_NAME), "utf8")) as InstallRecord
}

/** The copies of the configuration: only in the user's private directory, never under the installation directory. */
function backups(w: World): string[] {
    assert.equal(fs.existsSync(path.join(w.installDir, "state", "desktop-config-backups")), false, "no copy under the installation directory")
    const dir = privateDesktopBackupDir(w.env, w.installDir)
    return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

/** Everything but our entry, as read now. */
function others(w: World): Record<string, unknown> {
    return Object.fromEntries(Object.entries(servers(w)).filter(([n]) => n !== SERVER_NAME))
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
            // in this fixture the parent of the user's folder plays C:\Users: other users' folders are refused
            [outside, /cartella di un altro utente/],
            ["\\\\server\\share\\FluentReaderMCP", /unità locale/],
            ["relative\\dir", /unità locale/],
            [path.join(w.home, "AppData", "Roaming", "FluentReaderMCP"), /Roaming/],
            [path.join(oneDrive, "FluentReaderMCP"), /OneDrive/],
            [path.join(w.home, ".claude", "FluentReaderMCP"), /configurazione di Claude Code/],
            [path.join(junction, "FluentReaderMCP"), /collegamento, una junction o un nome breve/],
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

// ------------------------------------------------------------------ FR-MCP-04-BETA-UX-01: Claude Desktop

/** A synthetic file named as Claude Desktop's configuration, somewhere under the user's folders. */
function configAt(w: World, relative: string[], content: unknown = {}): string {
    const file = path.join(w.home, "AppData", ...relative, "claude_desktop_config.json")
    assertInTestArea(file)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content))
    return file
}

describe("Claude Desktop: which file (read-only discovery, assisted selection)", () => {
    const candidates = async (w: World, extra: Record<string, string> = {}): Promise<Answer> => {
        const r = await call(w, "desktop-candidates", extra)
        assert.equal(r.code, 0, r.one("message"))
        return r
    }

    test("Desktop absent: nothing found, nothing proposed, nothing created", async () => {
        const w = world()
        const before = snapshotDir(w.home)
        const r = await candidates(w)
        assert.deepEqual([r.one("proposal"), r.one("selected"), r.one("packaged")], ["none", "", "no"])
        assert.match(r.one("preview"), /Nessun file di configurazione/)
        assert.deepEqual(snapshotDir(w.home), before)
    })

    test("one file and no packaged app: proposed, listed with its place and date, never opened", async () => {
        const w = world(`{"mcpServers": {"x": {"env": {"K": "${SECRET}"}}`) // not even valid JSON: nobody reads it here
        const r = await candidates(w)
        assert.deepEqual([r.one("proposal"), r.one("selected")], ["single", w.configPath])
        assert.match(r.one("preview"), /cartella Roaming, modificato il \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
        assert.equal(r.text.includes(SECRET), false)
    })

    test("more than one file: nothing proposed, every one listed, no identifier assumed", async () => {
        const w = world(personalConfig())
        const dataDir = configAt(w, ["Local", "Claude-Data", "qualsiasi-identificatore"])
        const thirdParty = configAt(w, ["Local", "Claude-3p"])
        const packaged = configAt(w, ["Local", "Packages", "Claude_abc123", "LocalCache", "Roaming", "Claude"])
        const notClaude = configAt(w, ["Local", "AltroProgramma"])
        const r = await candidates(w)
        assert.deepEqual([r.one("proposal"), r.one("selected"), r.one("packaged")], ["ambiguous", "", "yes"])
        for (const file of [w.configPath, dataDir, thirdParty, packaged]) assert.ok(r.one("preview").includes(file), file)
        assert.equal(r.one("preview").includes(notClaude), false, "only the per-user folders of Claude")
        assert.match(r.one("preview"), /può aprire un file diverso da quello che l'app legge davvero/)
    })

    test("a packaged app with only the documented file: not proposed, the app may read another one", async () => {
        const w = world(personalConfig())
        fs.mkdirSync(path.join(w.home, "AppData", "Local", "Packages", "Claude_zzz999"), { recursive: true })
        const r = await candidates(w)
        assert.deepEqual([r.one("proposal"), r.one("selected"), r.one("packaged")], ["ambiguous", "", "yes"])
    })

    test("a packaged app with only its private file: proposed", async () => {
        const w = world()
        const packaged = configAt(w, ["Local", "Packages", "Claude_any", "LocalCache", "Roaming", "Claude"])
        const r = await candidates(w)
        assert.deepEqual([r.one("proposal"), r.one("selected")], ["single", packaged])
    })

    test("a junction is not followed: what is behind it is not listed", async () => {
        const w = world()
        const elsewhere = path.join(w.home, "altrove")
        fs.mkdirSync(elsewhere)
        fs.writeFileSync(path.join(elsewhere, "claude_desktop_config.json"), "{}")
        fs.symlinkSync(elsewhere, path.join(w.home, "AppData", "Local", "Claude-Link"), "junction")
        assert.equal((await candidates(w)).one("proposal"), "none")
    })

    test("a repair proposes the file of its own registration, also among several", async () => {
        const w = world(personalConfig())
        await installed(w)
        configAt(w, ["Local", "Claude-Data", "id"])
        assert.equal((await planAndRegister(w)).register.code, 0)
        const r = await candidates(w, { installDir: w.installDir })
        assert.deepEqual([r.one("proposal"), r.one("selected")], ["recorded", w.configPath])
    })

    test("a policy that disables local MCP servers: reported; the page and the registration refuse, the machine's value first", async () => {
        const w = world(personalConfig())
        await installed(w)
        const before = fs.readFileSync(w.configPath)
        const ok = await call(w, "desktop-plan", planRequest(w))
        w.policy = { "HKLM\\SOFTWARE\\Policies\\Claude": "    isLocalDevMcpEnabled    REG_DWORD    0x0\r\n", "HKCU\\SOFTWARE\\Policies\\Claude": "    isLocalDevMcpEnabled    REG_DWORD    0x1\r\n" }
        assert.equal((await candidates(w)).one("policy"), "blocked")
        assert.match((await call(w, "desktop-plan", planRequest(w))).one("message"), /policy .*isLocalDevMcpEnabled.*installare solo il server/)
        assert.match((await call(w, "desktop-register", planRequest(w, { planHash: ok.one("planHash"), consent: "yes" }))).one("message"), /policy/)
        assert.ok(fs.readFileSync(w.configPath).equals(before))
        assert.ok(w.calls.every((c) => c[0] === "reg.exe" && c[1] === "query"), "only a registry query is started")
        w.policy = { "HKLM\\SOFTWARE\\Policies\\Claude": "    isLocalDevMcpEnabled    REG_DWORD    0x1\r\n", "HKCU\\SOFTWARE\\Policies\\Claude": "    isLocalDevMcpEnabled    REG_DWORD    0x0\r\n" }
        assert.equal((await candidates(w)).one("policy"), "allowed")
        w.policy = {}
        assert.equal((await candidates(w)).one("policy"), "allowed", "no policy: nothing stops")
    })

    test("the selected file must be a regular file with the right name, in this user's folders, reached without links", async () => {
        const w = world(personalConfig())
        await installed(w)
        const elsewhere = path.join(root, `elsewhere ${counter}`)
        fs.mkdirSync(elsewhere)
        const outside = path.join(elsewhere, "claude_desktop_config.json")
        fs.writeFileSync(outside, "{}")
        const wrongName = path.join(w.home, ".claude.json")
        fs.writeFileSync(wrongName, "{}")
        const junction = path.join(w.home, "AppData", "Roaming", "Claude-junction")
        fs.symlinkSync(path.dirname(w.configPath), junction, "junction")
        const directory = path.join(w.home, "AppData", "Local", "dir", "claude_desktop_config.json")
        fs.mkdirSync(directory, { recursive: true })
        const inInstall = path.join(w.installDir, "claude_desktop_config.json")
        fs.writeFileSync(inInstall, "{}")
        const cases: [string, RegExp][] = [
            [wrongName, /deve chiamarsi claude_desktop_config\.json/],
            [outside, /non è nelle cartelle del tuo utente/],
            [path.join(junction, "claude_desktop_config.json"), /collegamento, una junction o un nome breve/],
            [directory, /non è un file normale/],
            [path.join(w.home, "AppData", "Roaming", "Assente", "claude_desktop_config.json"), /non esiste.*non lo crea in un percorso ipotizzato/],
            [inInstall, /dentro la cartella di installazione/],
            ["\\\\server\\share\\claude_desktop_config.json", /unità locale/],
        ]
        for (const [configPath, message] of cases) {
            const r = await call(w, "desktop-check", { configPath, installDir: w.installDir })
            assert.equal(r.code, 1, configPath)
            assert.match(r.one("message"), message, configPath)
        }
        assert.equal(fs.readFileSync(wrongName, "utf8"), "{}", "~/.claude.json is never a target")
        assert.equal(fs.existsSync(path.join(w.home, "AppData", "Roaming", "Assente")), false, "a missing file is not created")
        assert.equal((await call(w, "desktop-check", { configPath: w.configPath, installDir: w.installDir })).one("canonical"), w.configPath)
    })
})

describe("Claude Desktop: the change is mcpServers.fluent-reader and nothing else", () => {
    test("the page has no side effect, names the file and the entry, says the selection is not a verification, shows no content", async () => {
        const w = world(personalConfig())
        await installed(w)
        const before = fs.readFileSync(w.configPath)
        const r = await call(w, "desktop-plan", planRequest(w))
        assert.equal(r.code, 0, r.one("message"))
        assert.equal(r.one("action"), "add")
        assert.match(r.one("planHash"), /^[0-9a-f]{64}$/)
        const entry = desiredDesktopEntry(w.installDir, w.profile)
        for (const expected of [`File selezionato: ${w.configPath}`, "mcpServers.fluent-reader", entry.command, entry.args[0] as string, w.profile, "non può dimostrare che sia quello letto da Claude Desktop"]) assert.ok(r.one("preview").includes(expected), expected)
        assert.equal(r.text.includes(SECRET), false)
        assert.equal(r.text.includes("foundry"), false, "other servers are not even named")
        assert.ok(fs.readFileSync(w.configPath).equals(before))
        assert.deepEqual(backups(w), [], "no backup taken by a page")
    })

    test("the entry is the bundle's real start command: absolute runtime, entrypoint, --profile-dir; nothing else", async () => {
        const w = world({})
        await installed(w)
        assert.equal((await planAndRegister(w)).register.code, 0)
        const app = path.join(w.installDir, "current", "app")
        assert.deepEqual(servers(w)[SERVER_NAME], { command: path.join(app, "runtime", "node.exe"), args: [path.join(app, "server", "dist", "main.js"), "--profile-dir", w.profile] })
    })

    test("foundry-mcp, other servers, preferences and unknown fields stay exactly; a backup is kept; the record holds no content", async () => {
        const w = world(personalConfig())
        await installed(w)
        const original = fs.readFileSync(w.configPath)
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 0, register.one("message"))
        assert.equal(register.one("action"), "add")
        const after = readConfig(w)
        assert.deepEqual(others(w), otherServers())
        assert.deepEqual(after.preferences, personalConfig().preferences)
        assert.equal(after.unknownField, 42)
        const [backup] = backups(w)
        assert.ok(backup !== undefined && DESKTOP_BACKUP_NAME.test(backup))
        assert.ok(fs.readFileSync(path.join(privateDesktopBackupDir(w.env, w.installDir), backup)).equals(original))
        const rec = record(w)
        assert.equal(rec.desktop?.state, "registered")
        assert.equal(rec.desktop?.configPath, w.configPath)
        assert.equal(rec.desktop?.fingerprint, entryFingerprint(servers(w)[SERVER_NAME]))
        assert.equal(rec.claude, null, "nothing recorded for Claude Code")
        assert.equal(JSON.stringify(rec).includes(SECRET), false)
        assert.equal(register.text.includes(SECRET), false)
        assert.deepEqual(w.calls.filter((c) => c[0] !== "reg.exe"), [], "no program but the policy query")
    })

    const shapes: [string, string][] = [
        ["an empty object", "{}"],
        ["an empty object, multi-line", "{\n}\n"],
        ["no mcpServers", '{\n  "preferences": {"a": 1}\n}\n'],
        ["an empty mcpServers", '{"mcpServers": {}, "z": 1}'],
        ["one line", `{"mcpServers":{"foundry-mcp":{"command":"f"}},"z":[1,{"y":"}{\\""}]}`],
        ["CRLF and tabs", '{\r\n\t"mcpServers": {\r\n\t\t"foundry-mcp": {\r\n\t\t\t"command": "f"\r\n\t\t}\r\n\t}\r\n}\r\n'],
        ["a UTF-8 BOM", '\uFEFF{"a": "è 😀"}'],
    ]
    for (const [label, text] of shapes) {
        test(`${label}: add and remove are valid JSON, everything else preserved`, async () => {
            const w = world(text)
            await installed(w)
            const before = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>
            const { register } = await planAndRegister(w)
            assert.equal(register.code, 0, register.one("message"))
            const saved = fs.readFileSync(w.configPath)
            assert.equal(saved.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), text.startsWith("\uFEFF"), "the BOM stays as it was")
            const added = JSON.parse(saved.toString("utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>
            assert.deepEqual((added.mcpServers as Record<string, unknown>)[SERVER_NAME], desiredDesktopEntry(w.installDir, w.profile))
            assert.equal((await call(w, "desktop-unregister", { installDir: w.installDir })).one("outcome"), "removed")
            const removed = JSON.parse(fs.readFileSync(w.configPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>
            assert.deepEqual({ ...removed, mcpServers: removed.mcpServers ?? {} }, { ...before, mcpServers: before.mcpServers ?? {} })
        })
    }

    test("every other byte stays: formatting, key order, numbers JSON.parse would round, a repeated key elsewhere", async () => {
        const head = '{\n    "numbers": [12345678901234567890, 1.0e2],\n    "same": {"k": 1, "k": 2},\n    "mcpServers": {\n        "foundry-mcp"  :  {"command":"f"},\n        "zeta": {"command": "z"}'
        const tail = '\n    },\n    "last": "\\u00e8"\n}\n'
        const w = world(`${head}${tail}`)
        await installed(w)
        assert.equal((await planAndRegister(w)).register.code, 0)
        const text = fs.readFileSync(w.configPath, "utf8")
        assert.ok(text.startsWith(`${head},\n        "fluent-reader": {\n`), text)
        assert.ok(text.endsWith(tail), text)
        assert.equal((await call(w, "desktop-unregister", { installDir: w.installDir })).one("outcome"), "removed")
        assert.equal(fs.readFileSync(w.configPath, "utf8"), `${head}${tail}`, "byte for byte what it was")
    })

    const refused: [string, string, RegExp][] = [
        ["invalid JSON", `{"mcpServers": {"foundry-mcp": {"env": {"K": "${SECRET}"}}`, /non è un JSON valido: non viene modificato né ricreato/],
        ["an empty file", "", /non è un JSON valido/],
        ["an array", "[1, 2]", /struttura attesa/],
        ["a string", '"x"', /struttura attesa/],
        ["mcpServers as an array", '{"mcpServers": []}', /sezione mcpServers non ha la struttura attesa/],
        ["mcpServers null", '{"mcpServers": null}', /sezione mcpServers non ha la struttura attesa/],
        ["mcpServers repeated", '{"mcpServers": {}, "mcpServers": {"a": {}}}', /"mcpServers" è ripetuta/],
        ["fluent-reader repeated", '{"mcpServers": {"fluent-reader": {}, "fluent-reader": {"command": "x"}}}', /"fluent-reader" è ripetuta/],
    ]
    for (const [label, content, message] of refused) {
        test(`${label}: refused at every step, left byte for byte, no backup`, async () => {
            const w = world(content)
            await installed(w)
            const before = fs.readFileSync(w.configPath)
            const check = await call(w, "desktop-check", { configPath: w.configPath, installDir: w.installDir })
            const plan = await call(w, "desktop-plan", planRequest(w))
            const register = await call(w, "desktop-register", planRequest(w, { planHash: "0".repeat(64), consent: "yes", replaceForeign: "yes" }))
            for (const r of [check, plan, register]) {
                assert.equal(r.code, 1)
                assert.match(r.one("message"), message)
                assert.equal(r.text.includes(SECRET), false)
            }
            assert.ok(fs.readFileSync(w.configPath).equals(before))
            assert.deepEqual(backups(w), [])
        })
    }

    test("invalid UTF-8: refused, not rewritten with replacement characters", async () => {
        const w = world()
        fs.writeFileSync(w.configPath, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))
        const before = fs.readFileSync(w.configPath)
        assert.match((await call(w, "desktop-check", { configPath: w.configPath })).one("message"), /non è un JSON valido/)
        assert.ok(fs.readFileSync(w.configPath).equals(before))
    })

    test("without explicit consent nothing is changed", async () => {
        const w = world(personalConfig())
        await installed(w)
        const before = fs.readFileSync(w.configPath)
        const plan = await call(w, "desktop-plan", planRequest(w))
        for (const consent of [{}, { consent: "no" }]) {
            const r = await call(w, "desktop-register", planRequest(w, { planHash: plan.one("planHash"), ...consent }))
            assert.equal(r.code, 1)
            assert.match(r.one("message"), /consenso esplicito/)
        }
        assert.ok(fs.readFileSync(w.configPath).equals(before))
        assert.deepEqual(backups(w), [])
    })

    test("several candidates: only the selected file changes", async () => {
        const w = world(personalConfig())
        await installed(w)
        const other = configAt(w, ["Local", "Claude-Data", "id"], personalConfig())
        const before = fs.readFileSync(other)
        assert.equal((await planAndRegister(w)).register.code, 0)
        assert.ok(fs.readFileSync(other).equals(before), "the file not selected is untouched")
        assert.ok(Object.hasOwn(servers(w), SERVER_NAME))
    })

    test("a foreign fluent-reader entry is replaced only with specific consent, shown without its values; a server-only choice leaves it", async () => {
        const foreign = { command: "C:\\Elsewhere\\node.exe", args: ["server.js"], env: { TOKEN: SECRET }, timeout: 5 }
        const w = world(personalConfig({ [SERVER_NAME]: foreign }))
        await installed(w)
        const before = fs.readFileSync(w.configPath)
        const plan = await call(w, "desktop-plan", planRequest(w))
        assert.equal(plan.one("action"), "replace-foreign")
        assert.match(plan.one("preview"), /ATTENZIONE: esiste già una voce "fluent-reader".*C:\\Elsewhere\\node\.exe, 1 argomenti, 1 variabili/)
        assert.equal(plan.text.includes(SECRET), false)
        const refused = await call(w, "desktop-register", planRequest(w, { planHash: plan.one("planHash"), consent: "yes" }))
        assert.match(refused.one("message"), /non è stata confermata/)
        assert.ok(fs.readFileSync(w.configPath).equals(before), "not replaced silently")
        assert.equal(record(w).desktop, undefined, "and not taken for ours")
        const replaced = await call(w, "desktop-register", planRequest(w, { planHash: plan.one("planHash"), consent: "yes", replaceForeign: "yes" }))
        assert.equal(replaced.code, 0, replaced.one("message"))
        assert.deepEqual(servers(w)[SERVER_NAME], desiredDesktopEntry(w.installDir, w.profile))
        assert.deepEqual(others(w), otherServers())
        assert.equal(JSON.stringify(record(w)).includes(SECRET), false, "the replaced entry is not copied into the record")
        const [backup] = backups(w)
        assert.ok(fs.readFileSync(path.join(privateDesktopBackupDir(w.env, w.installDir), backup as string)).equals(before), "the replaced entry stays in the private copy")
    })

    test("an entry already identical but not written by this installer: nothing changes and it is not taken for ours", async () => {
        const base = world()
        const entry = desiredDesktopEntry(base.installDir, base.profile)
        fs.writeFileSync(base.configPath, JSON.stringify(personalConfig({ [SERVER_NAME]: entry })))
        await installed(base)
        const before = fs.readFileSync(base.configPath)
        const { plan, register } = await planAndRegister(base)
        assert.equal(plan.one("action"), "none")
        assert.match(plan.one("preview"), /non viene considerata sua/)
        assert.equal(register.code, 0)
        assert.ok(fs.readFileSync(base.configPath).equals(before))
        assert.deepEqual(backups(base), [])
        assert.equal((await call(base, "desktop-unregister", { installDir: base.installDir })).one("outcome"), "not-configured")
        assert.ok(fs.readFileSync(base.configPath).equals(before), "the uninstaller leaves it")
    })

    test("the entry changed after the page: registration refused, nothing changed", async () => {
        const w = world(personalConfig())
        await installed(w)
        const plan = await call(w, "desktop-plan", planRequest(w))
        fs.writeFileSync(w.configPath, JSON.stringify(personalConfig({ [SERVER_NAME]: { command: "C:\\x.exe" } })))
        const before = fs.readFileSync(w.configPath)
        const r = await call(w, "desktop-register", planRequest(w, { planHash: plan.one("planHash"), consent: "yes", replaceForeign: "yes" }))
        assert.match(r.one("message"), /è cambiata dopo la conferma/)
        assert.ok(fs.readFileSync(w.configPath).equals(before))
    })

    test("another program changes the file between the read and the write: nothing overwritten, its change kept", async () => {
        const w = world(personalConfig())
        await installed(w)
        const concurrent = JSON.stringify(personalConfig({ nuovo: { command: "n" } }))
        w.checkpoint = (s) => {
            if (s === "before-replace") fs.writeFileSync(w.configPath, concurrent)
        }
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 1)
        assert.match(register.one("message"), /modificato da un altro programma durante l'operazione/)
        assert.equal(fs.readFileSync(w.configPath, "utf8"), concurrent)
        assert.equal(record(w).desktop, undefined, "nothing recorded")
        assert.deepEqual(fs.readdirSync(path.dirname(w.configPath)), ["claude_desktop_config.json"], "no temporary file left")
    })

    test("the file cannot be replaced (in use, read-only): the file as before, no temporary file, the record as before, a copy kept", async () => {
        const w = world(personalConfig())
        await installed(w)
        const before = fs.readFileSync(w.configPath)
        w.replace = () => {
            throw Object.assign(new Error("in use"), { code: "EBUSY" })
        }
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 1)
        assert.match(register.one("message"), /errore di scrittura EBUSY.*riportata allo stato precedente/)
        assert.ok(fs.readFileSync(w.configPath).equals(before))
        assert.deepEqual(fs.readdirSync(path.dirname(w.configPath)), ["claude_desktop_config.json"])
        assert.equal(record(w).desktop, undefined)
        assert.equal(backups(w).length, 1)
    })

    const afterWrite: HelperDeps["checkpoint"] = (s) => {
        if (s === "after-replace") throw new Error("injected failure")
    }

    test("a failure right after the write, nobody else touched the file: its previous bytes go back", async () => {
        const w = world(personalConfig())
        await installed(w)
        const before = fs.readFileSync(w.configPath)
        w.checkpoint = afterWrite
        const { register } = await planAndRegister(w)
        assert.match(register.one("message"), /injected failure.*riportata allo stato precedente/)
        assert.ok(fs.readFileSync(w.configPath).equals(before))
        assert.equal(record(w).desktop, undefined)
    })

    test("a failure after the write, others changed the file meanwhile: only our entry goes, their change stays, the old file is NOT restored", async () => {
        const w = world(personalConfig())
        await installed(w)
        w.checkpoint = (s) => {
            if (s === "after-replace") throw new Error("injected failure")
            if (s === "before-rollback") {
                const doc = readConfig(w)
                fs.writeFileSync(w.configPath, JSON.stringify({ ...doc, preferences: { changed: "by the app" } }))
            }
        }
        const { register } = await planAndRegister(w)
        assert.match(register.one("message"), /riportata allo stato precedente/)
        assert.equal(Object.hasOwn(servers(w), SERVER_NAME), false)
        assert.deepEqual(readConfig(w).preferences, { changed: "by the app" })
        assert.deepEqual(others(w), otherServers())
    })

    test("a failure after the write, the entry changed by others: not touched, owner intervention required", async () => {
        const w = world(personalConfig())
        await installed(w)
        w.checkpoint = (s) => {
            if (s === "after-replace") throw new Error("injected failure")
            if (s === "before-rollback") changeEntry(w, (e) => ({ ...e, timeout: 9000 }))
        }
        const { register } = await planAndRegister(w)
        assert.match(register.one("message"), /NON è stato completato: .*non è attribuibile con certezza.*Serve un tuo intervento/)
        assert.equal((servers(w)[SERVER_NAME] as { timeout?: number }).timeout, 9000)
        assert.equal(record(w).desktop?.state, "rollback-failed")
    })

    test("a failure after a consented replacement: the previous entry goes back exactly, unknown fields included", async () => {
        const foreign = { command: "C:\\Elsewhere\\node.exe", env: { TOKEN: SECRET }, timeout: 5 }
        const w = world(personalConfig({ [SERVER_NAME]: foreign }))
        await installed(w)
        w.checkpoint = (s) => {
            if (s === "after-replace") throw new Error("injected failure")
            if (s === "before-rollback") {
                const doc = readConfig(w)
                fs.writeFileSync(w.configPath, JSON.stringify({ ...doc, altro: 1 }))
            }
        }
        const { register } = await planAndRegister(w, { replaceForeign: "yes" })
        assert.match(register.one("message"), /riportata allo stato precedente/)
        assert.deepEqual(servers(w)[SERVER_NAME], foreign)
        assert.equal(readConfig(w).altro, 1)
    })

    test("a crash between the write and the record: the fingerprint was recorded first, so the next run recognises the entry", async () => {
        const w = world(personalConfig())
        await installed(w)
        assert.equal((await planAndRegister(w)).register.code, 0)
        const rec = record(w)
        writeRecord(path.join(w.installDir, RECORD_NAME), { ...rec, desktop: { ...(rec.desktop as DesktopRegistration), state: "pending" } })
        const { plan, register } = await planAndRegister(w)
        assert.equal(plan.one("action"), "none")
        assert.equal(register.code, 0)
        assert.equal(record(w).desktop?.state, "registered")
    })

    test("a repeated repair is idempotent: the same bytes, no new backup", async () => {
        const w = world(personalConfig())
        await installed(w)
        assert.equal((await planAndRegister(w)).register.code, 0)
        const config = fs.readFileSync(w.configPath)
        for (let i = 0; i < 2; i++) {
            const again = await planAndRegister(w)
            assert.equal(again.plan.one("action"), "none")
            assert.match(again.plan.one("preview"), /Modifica: nessuna/)
            assert.equal(again.register.code, 0)
        }
        assert.ok(fs.readFileSync(w.configPath).equals(config))
        assert.equal(backups(w).length, 1)
        assert.equal(record(w).desktop?.state, "registered")
    })

    test("an upgrade with another profile: the installation's own entry is updated, the others stay, the record keeps it", async () => {
        const w = world(personalConfig())
        await installed(w)
        assert.equal((await planAndRegister(w)).register.code, 0)
        const oldProfile = buildSmokeProfile(path.join(w.home, "Profili Fluent", "vecchio")).dir
        const rec = record(w)
        const oldEntry = desiredDesktopEntry(w.installDir, oldProfile)
        fs.writeFileSync(path.join(w.installDir, RECORD_NAME), JSON.stringify({ ...rec, version: "0.0.9", profileDir: oldProfile, desktop: { ...rec.desktop, entry: oldEntry, fingerprint: entryFingerprint(oldEntry) } }))
        changeEntry(w, () => ({ ...oldEntry }))
        const { plan, register } = await planAndRegister(w)
        assert.equal(plan.one("action"), "replace-own")
        assert.equal(register.code, 0, register.one("message"))
        assert.deepEqual(servers(w)[SERVER_NAME], desiredDesktopEntry(w.installDir, w.profile))
        assert.deepEqual(others(w), otherServers())
    })

    test("pointing a later run to another file: the first file is not touched then, its entry stays attributable and goes at uninstall", async () => {
        const w = world(personalConfig())
        await installed(w)
        assert.equal((await planAndRegister(w)).register.code, 0)
        const first = fs.readFileSync(w.configPath)
        const second = configAt(w, ["Local", "Claude-Data", "id"], personalConfig())
        const v: World = { ...w, configPath: second }
        const { plan, register } = await planAndRegister(v)
        assert.ok(plan.one("preview").includes(`La voce scritta in precedenza in ${w.configPath} non viene toccata`))
        assert.equal(register.code, 0, register.one("message"))
        assert.ok(fs.readFileSync(w.configPath).equals(first), "not modified by trial and error")
        const rec = record(w).desktop as DesktopRegistration
        assert.equal(rec.configPath, second)
        assert.deepEqual(rec.formerTargets?.map((t) => t.configPath), [w.configPath])
        // and the preference is the file of the last run
        assert.equal((await call(w, "desktop-candidates", { installDir: w.installDir })).one("selected"), second)
        const r = await call(w, "desktop-unregister", { installDir: w.installDir })
        assert.equal(r.one("outcome"), "removed", r.one("message"))
        assert.equal(Object.hasOwn(servers(w), SERVER_NAME), false, "the first file")
        assert.equal(Object.hasOwn(servers(v), SERVER_NAME), false, "the second file")
        assert.deepEqual(others(w), otherServers())
    })
})

describe("Claude Desktop: uninstallation", () => {
    async function registered(): Promise<World> {
        const w = world(personalConfig())
        await installed(w)
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 0, register.one("message"))
        return w
    }

    test("the entry as written is removed; every other server, preference and backup stays; a repeated attempt has nothing to do", async () => {
        const w = await registered()
        const dir = privateDesktopBackupDir(w.env, w.installDir)
        const snap = snapshotDir(dir)
        const r = await call(w, "desktop-unregister", { installDir: w.installDir })
        assert.equal(r.code, 0)
        assert.equal(r.one("outcome"), "removed")
        assert.deepEqual(servers(w), otherServers())
        assert.deepEqual(readConfig(w).preferences, personalConfig().preferences)
        assert.equal(record(w).desktop?.state, "removed")
        assert.equal(r.text.includes(SECRET), false)
        assert.deepEqual(snapshotDir(dir), snap, "the copies are never deleted")
        assert.equal((await call(w, "desktop-unregister", { installDir: w.installDir })).one("outcome"), "not-configured")
    })

    const changes: [string, (e: Record<string, unknown>) => Record<string, unknown>][] = [
        ["a field added", (e) => ({ ...e, timeout: 30000 })],
        ["an args element changed", (e) => ({ ...e, args: [...(e.args as string[]).slice(0, 2), "C:\\Other\\profile"] })],
        ["env added", (e) => ({ ...e, env: { DEBUG: "1" } })],
        ["the command changed", (e) => ({ ...e, command: "C:\\Other\\node.exe" })],
    ]
    for (const [label, change] of changes) {
        test(`${label} by someone else: recognised as modified, not removed, not restored`, async () => {
            const w = await registered()
            changeEntry(w, change)
            const before = fs.readFileSync(w.configPath)
            const r = await call(w, "desktop-unregister", { installDir: w.installDir })
            assert.equal(r.one("outcome"), "modified")
            assert.match(r.one("message"), /non viene rimossa automaticamente/)
            assert.ok(fs.readFileSync(w.configPath).equals(before))
            assert.equal(record(w).desktop?.state, "registered", "repeatable")
        })
    }

    test("the same entry with its keys in another order is recognised and removed", async () => {
        const w = await registered()
        changeEntry(w, (e) => Object.fromEntries(Object.entries(e).reverse()))
        assert.equal((await call(w, "desktop-unregister", { installDir: w.installDir })).one("outcome"), "removed")
        assert.deepEqual(servers(w), otherServers())
    })

    test("others changed the rest of the file after the registration: their changes stay, no copy is restored over them", async () => {
        const w = await registered()
        const doc = readConfig(w)
        fs.writeFileSync(w.configPath, JSON.stringify({ ...doc, preferences: { changed: true }, mcpServers: { ...(doc.mcpServers as object), nuovo: { command: "n" } } }))
        assert.equal((await call(w, "desktop-unregister", { installDir: w.installDir })).one("outcome"), "removed")
        assert.deepEqual(readConfig(w).preferences, { changed: true })
        assert.deepEqual(servers(w), { ...otherServers(), nuovo: { command: "n" } })
    })

    test("the entry changes between the check and the removal: not removed", async () => {
        const w = await registered()
        w.checkpoint = (s) => {
            if (s === "before-unregister") changeEntry(w, (e) => ({ ...e, timeout: 1 }))
        }
        const r = await call(w, "desktop-unregister", { installDir: w.installDir })
        assert.equal(r.one("outcome"), "modified")
        assert.equal((servers(w)[SERVER_NAME] as { timeout?: number }).timeout, 1)
    })

    test("the file changes in the last instant before the replacement: nothing overwritten, repeatable", async () => {
        const w = await registered()
        const concurrent = JSON.stringify(personalConfig({ nuovo: { command: "n" } }))
        w.checkpoint = (s) => {
            if (s === "before-replace") fs.writeFileSync(w.configPath, concurrent)
        }
        const r = await call(w, "desktop-unregister", { installDir: w.installDir })
        assert.equal(r.one("outcome"), "write-error")
        assert.equal(fs.readFileSync(w.configPath, "utf8"), concurrent)
        assert.equal(record(w).desktop?.state, "registered")
    })

    test("a file that cannot be read any more, or a record pointing outside this user's folders: nothing touched", async () => {
        const w = await registered()
        fs.writeFileSync(w.configPath, `{ broken ${SECRET}`)
        const broken = await call(w, "desktop-unregister", { installDir: w.installDir })
        assert.equal(broken.one("outcome"), "config-error")
        assert.equal(broken.text.includes(SECRET), false)
        const v = await registered()
        const elsewhere = path.join(root, `foreign ${counter}`)
        fs.mkdirSync(elsewhere)
        const foreign = path.join(elsewhere, "claude_desktop_config.json")
        fs.copyFileSync(v.configPath, foreign)
        const before = fs.readFileSync(foreign)
        const rec = record(v)
        writeRecord(path.join(v.installDir, RECORD_NAME), { ...rec, desktop: { ...(rec.desktop as DesktopRegistration), configPath: foreign } })
        assert.equal((await call(v, "desktop-unregister", { installDir: v.installDir })).one("outcome"), "config-error")
        assert.ok(fs.readFileSync(foreign).equals(before), "a record alone authorises nothing outside this user's folders")
    })

    test("desktop-unregister refuses a directory that is not a recorded installation", async () => {
        const w = world(personalConfig())
        assert.match((await call(w, "desktop-unregister", { installDir: w.installDir })).one("message"), /registro di installazione mancante/)
    })
})

describe("Claude Desktop: installations of the Code-first beta", () => {
    /** A record as the 0.1.x beta wrote it, with its entry in the synthetic ~/.claude.json. */
    function codeFirst(w: World): Buffer {
        const entry = codeEntry(w)
        fs.writeFileSync(codeConfigPath(w), JSON.stringify({ numStartups: 7, oauthAccount: SECRET, mcpServers: { [SERVER_NAME]: entry, altro: { command: "a" } } }))
        const file = path.join(w.installDir, RECORD_NAME)
        writeRecord(file, { ...(readRecord(file) as InstallRecord), claude: { state: "registered", name: SERVER_NAME, scope: "user", configPath: codeConfigPath(w), claudeExe: path.join(w.home, "claude.exe"), entry, fingerprint: entryFingerprint(entry), backup: null, updatedAt: "2026-10-01T09:00:00.000Z" } })
        return fs.readFileSync(codeConfigPath(w))
    }

    test("a Code registration does not count as a Desktop one: the page adds the entry, reports the old one, and ~/.claude.json is never written", async () => {
        const w = world(personalConfig())
        await installed(w)
        const code = codeFirst(w)
        assert.equal((await call(w, "uninstall-preflight", { installDir: w.installDir })).code, 1, "no helper in this fixture")
        const { plan, register } = await planAndRegister(w)
        assert.equal(plan.one("action"), "add", "no Desktop entry is implied")
        assert.match(plan.one("preview"), /registrato il server in Claude Code: quella voce non viene modificata né rimossa, e non implica alcuna registrazione in Claude Desktop/)
        assert.equal(plan.text.includes(SECRET), false)
        assert.equal(register.code, 0, register.one("message"))
        assert.ok(fs.readFileSync(codeConfigPath(w)).equals(code), "~/.claude.json byte for byte")
        const rec = record(w)
        assert.equal(rec.claude?.state, "registered", "the historical registration is carried over")
        assert.equal(rec.desktop?.state, "registered")
        assert.deepEqual(w.calls.filter((c) => c[0] !== "reg.exe"), [], "no claude.exe, no search")
    })

    test("uninstall: the Desktop entry goes, the Code entry stays and the user is told how to remove it", async () => {
        const w = world(personalConfig())
        await installed(w)
        const code = codeFirst(w)
        assert.equal((await planAndRegister(w)).register.code, 0)
        assert.match((await call(w, "un-status", { installDir: w.installDir })).one("backups"), /registrato il server anche in Claude Code: quella voce non viene toccata.*claude mcp remove fluent-reader --scope user/)
        const r = await call(w, "desktop-unregister", { installDir: w.installDir })
        assert.equal(r.one("outcome"), "removed")
        assert.ok(fs.readFileSync(codeConfigPath(w)).equals(code))
        assert.equal(record(w).claude?.state, "registered")
    })

    test("uninstall of a Code-first installation that never registered Desktop: nothing is done to either client", async () => {
        const w = world(personalConfig())
        await installed(w)
        const code = codeFirst(w)
        const desktop = fs.readFileSync(w.configPath)
        const r = await call(w, "desktop-unregister", { installDir: w.installDir })
        assert.equal(r.one("outcome"), "not-configured")
        assert.ok(fs.readFileSync(codeConfigPath(w)).equals(code))
        assert.ok(fs.readFileSync(w.configPath).equals(desktop))
    })

    test("no helper command starts or looks for Claude Code any more", async () => {
        const w = world(personalConfig())
        await installed(w)
        for (const command of ["detect-claude", "check-claude", "plan", "register", "unregister"]) {
            const r = await call(w, command, { installDir: w.installDir })
            assert.equal(r.code, 1, command)
            assert.match(r.one("message"), /comando sconosciuto/, command)
        }
        assert.deepEqual(w.calls, [])
        const shipped = setupClosure(COMPILED_ROOT).map((f) => fs.readFileSync(path.join(COMPILED_ROOT, f), "utf8")).join("\n")
        assert.doesNotMatch(shipped, /add-json|claude\.exe"\)|detectClaude|checkClaude/, "the shipped helper holds none of the old flow")
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
        assert.ok(fs.readFileSync(w.configPath).equals(before), "the Claude Desktop entry is untouched")
        const removeFirst = await call(w, "remove-tree", { installDir: w.installDir, tree: "current" })
        assert.equal(removeFirst.code, 1, "remove-tree refuses as well")
        assert.ok(fs.existsSync(path.join(current, "setup", "installer", "setup", "fr-setup.js")) && fs.existsSync(path.join(current, "app", "runtime", "node.exe")), "the helper is intact")
        fs.renameSync(foreign, path.join(w.home, "my notes é.txt"))
        const second = installedHelper(w, "uninstall-preflight", { installDir: w.installDir })
        assert.equal(second.code, 0, second.get("message")?.join(""))
        assert.deepEqual(second.get("desktop"), ["ours"])
        assert.equal((await call(w, "desktop-unregister", { installDir: w.installDir })).one("outcome"), "removed")
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
        ["the file cannot be replaced", (w) => (w.replace = () => {
            throw Object.assign(new Error("busy"), { code: "EBUSY" })
        }), "write-error"],
        ["registration already absent", (w) => fs.writeFileSync(w.configPath, JSON.stringify(personalConfig())), "absent"],
        ["corrupted configuration", (w) => fs.writeFileSync(w.configPath, "{ not json"), "config-error"],
        ["the configuration is gone", (w) => fs.rmSync(w.configPath), "config-missing"],
    ]
    for (const [label, setup, expected] of outcomes) {
        test(`desktop-unregister: ${label} → ${expected}; files and record untouched`, async () => {
            const w = world(personalConfig())
            const current = await fullInstall(w)
            setup(w)
            const r = await call(w, "desktop-unregister", { installDir: w.installDir })
            assert.equal(r.one("outcome"), expected)
            assert.ok(fs.existsSync(path.join(current, INVENTORY)) && fs.existsSync(path.join(w.installDir, RECORD_NAME)))
            if (expected === "write-error") assert.ok(Object.hasOwn(servers(w), SERVER_NAME))
        })
    }

    test("an installation without a Claude Desktop registration: not-configured, uninstall can proceed", async () => {
        const w = world(personalConfig())
        await fullInstall(w, false)
        const before = fs.readFileSync(w.configPath)
        const preflight = await call(w, "uninstall-preflight", { installDir: w.installDir })
        assert.deepEqual(preflight.fields.get("desktop"), ["not-configured"])
        assert.deepEqual(preflight.fields.get("claude"), ["not-configured"])
        assert.equal((await call(w, "desktop-unregister", { installDir: w.installDir })).one("outcome"), "not-configured")
        assert.ok(fs.readFileSync(w.configPath).equals(before))
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
            [{ installDir: external, tree: "current" }, /cartella di un altro utente/],
            [{ installDir: external, tree: "previous" }, /cartella di un altro utente/],
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

// ------------------------------------------------------------------ FR-MCP-04-BETA-03A-SIMPLE-01: any drive, one effective destination

/**
 * Where synthetic machines live: a directory that is not itself under a
 * conventional profile path (X:\Users\...), which the location rules refuse
 * outside the current profile. The system temp usually is under one; the
 * build directory (dist-test, ignored by Git) usually is not.
 */
const underProfiles = (p: string): boolean => /^[A-Za-z]:\\users(\\|$)/i.test(p)
const AWAY_SKIP = underProfiles(fs.realpathSync.native(os.tmpdir())) && underProfiles(COMPILED_ROOT) ? "no directory outside X:\\Users\\... for a synthetic machine (temp and build both under a profile)" : false
let awayRoot: string | null = null
function awayBase(): string {
    if (awayRoot === null) awayRoot = underProfiles(root) ? fs.realpathSync.native(fs.mkdtempSync(path.join(COMPILED_ROOT, "frmcp-away-"))) : root
    return awayRoot
}
after(() => {
    if (awayRoot !== null && awayRoot !== root) removeTempRoot(awayRoot)
})

/**
 * A synthetic machine: the user's folder is <machine>\Users\<user> and
 * <machine>\Volume D é plays another drive, outside the profile. Real drive
 * roots are only inspected (lstat, realpath), never written.
 */
function away(config?: unknown): { w: World; volume: string; machine: string } {
    counter++
    const machine = path.join(awayBase(), `machine ${counter}`)
    const w = world(config, path.join(machine, "Users", "utente é"))
    const volume = path.join(machine, "Volume D é")
    fs.mkdirSync(volume, { recursive: true })
    return { w, volume, machine }
}

/** deps whose write check records the directories it is asked about (and really probes them unless told otherwise). */
function probing(w: World, probe: DirectoryProbe = (dir, exists) => (exists ? writeProbe(dir) : createProbe(dir))): { d: HelperDeps; probes: string[] } {
    const probes: string[] = []
    return {
        d: {
            ...deps(w),
            writeProbe: (dir, exists) => {
                probes.push(dir)
                probe(dir, exists)
            },
        },
        probes,
    }
}

const tempDrive = (): string => root.slice(0, 3)

describe("setup helper: destination on any drive (FR-MCP-04-BETA-03A-SIMPLE-01)", { skip: AWAY_SKIP }, () => {
    test("drive roots C:\\, D:\\, H:\\ become <root>\\FluentReaderMCP, shown before anything is created; an absent drive is refused", async () => {
        const { w } = away()
        for (const letter of ["C", "D", "H"]) {
            const rootDir = `${letter}:\\`
            const target = `${letter}:\\${DEFAULT_SUBDIR}`
            if (fs.existsSync(rootDir) && fs.existsSync(target)) continue // a real one on this machine: never checked by a test
            // real drive roots are only inspected: the write check is the fixture's, it creates nothing there
            const { d, probes } = probing(w, () => undefined)
            const r = await call(w, "check-install-dir", installRequest(w, { installDir: rootDir }), d)
            if (!fs.existsSync(rootDir)) {
                assert.equal(r.code, 1)
                assert.match(r.one("message"), new RegExp(`l'unità ${letter}: non è disponibile`))
                continue
            }
            if (r.code !== 0) {
                // a drive of this machine that is not a plain local volume (mapped or substituted): refused, never used
                assert.match(r.one("message"), /cartella di rete|collegamento/, rootDir)
                continue
            }
            assert.equal(r.one("canonical").toLowerCase(), target.toLowerCase())
            assert.equal(r.one("adjusted"), "root")
            assert.equal(r.one("mode"), "new")
            assert.equal(r.one("outsideProfile"), "yes")
            assert.equal(fs.existsSync(target), false, "checking creates nothing")
            assert.deepEqual(probes.map((p) => p.toLowerCase()), [rootDir.toLowerCase()], "the place where the destination would be created is what gets checked")
        }
        const absent = [..."ZYXWVUTSRQPONMLKJI"].find((l) => !fs.existsSync(`${l}:\\`))
        if (absent !== undefined) {
            for (const dir of [`${absent}:\\`, `${absent}:\\Programmi\\Reader`]) {
                const r = await call(w, "check-install-dir", installRequest(w, { installDir: dir }))
                assert.equal(r.code, 1)
                assert.match(r.one("message"), new RegExp(`l'unità ${absent}: non è disponibile`))
            }
        }
    })

    test("a new directory outside the user's folder, with spaces and Unicode, is used exactly as chosen (nothing appended)", async () => {
        const { w, volume } = away()
        const chosen = path.join(volume, "Miei Programmi", "Reader MCP 😀 è")
        const { d, probes } = probing(w)
        const r = await call(w, "check-install-dir", installRequest(w, { installDir: chosen }), d)
        assert.equal(r.code, 0, r.one("message"))
        assert.equal(r.one("canonical"), chosen)
        assert.equal(r.one("adjusted"), "")
        assert.equal(r.one("mode"), "new")
        assert.equal(r.one("outsideProfile"), "yes")
        assert.equal(fs.existsSync(path.join(volume, "Miei Programmi")), false, "checking creates nothing")
        assert.deepEqual(probes, [volume], "the nearest existing parent is checked")
        assert.deepEqual(fs.readdirSync(volume), [], "the write check leaves nothing behind")
        const inside = await call(w, "check-install-dir", installRequest(w))
        assert.equal(inside.one("outsideProfile"), "no")
    })

    test("an existing empty directory is used directly; the write check leaves nothing behind", async () => {
        const { w, volume } = away()
        const empty = path.join(volume, "Vuota é")
        fs.mkdirSync(empty)
        const { d, probes } = probing(w)
        const r = await call(w, "check-install-dir", installRequest(w, { installDir: empty }), d)
        assert.equal(r.code, 0, r.one("message"))
        assert.equal(r.one("canonical"), empty)
        assert.equal(r.one("adjusted"), "")
        assert.deepEqual(probes, [empty])
        assert.deepEqual(fs.readdirSync(empty), [])
    })

    test("a directory with other files: the FluentReaderMCP subdirectory is proposed and the files are untouched; going back with it changes nothing; an occupied proposal is refused, never nested further", async () => {
        const { w, volume } = away()
        const apps = path.join(volume, "Applicazioni")
        fs.mkdirSync(path.join(apps, "Altro programma"), { recursive: true })
        fs.writeFileSync(path.join(apps, "Altro programma", "app.exe"), "someone else's program")
        fs.writeFileSync(path.join(apps, "leggimi.txt"), "mine")
        const before = snapshotDir(apps)
        const proposal = path.join(apps, DEFAULT_SUBDIR)
        const r = await call(w, "check-install-dir", installRequest(w, { installDir: apps }))
        assert.equal(r.code, 0, r.one("message"))
        assert.equal(r.one("canonical"), proposal)
        assert.equal(r.one("adjusted"), "not-empty")
        assert.equal(r.one("mode"), "new")
        assert.deepEqual(snapshotDir(apps), before, "nothing created or changed in the chosen directory")
        // Back, then Next with the destination now shown in the field: the same destination, nothing appended again
        const again = await call(w, "check-install-dir", installRequest(w, { installDir: proposal }))
        assert.equal(again.one("canonical"), proposal)
        assert.equal(again.one("adjusted"), "")
        // the proposal is occupied by something else: refused, no FluentReaderMCP\FluentReaderMCP
        fs.mkdirSync(proposal)
        fs.writeFileSync(path.join(proposal, "altro.txt"), "not ours")
        for (const chosen of [apps, proposal]) {
            const refused = await call(w, "check-install-dir", installRequest(w, { installDir: chosen }))
            assert.equal(refused.code, 1, chosen)
            assert.match(refused.one("message"), /contiene già altri file e non è un'installazione di Fluent Reader MCP: scegli un'altra cartella/)
            assert.equal(refused.one("message").includes(`${DEFAULT_SUBDIR}\\${DEFAULT_SUBDIR}`), false, "never nested further")
        }
        assert.deepEqual(fs.readdirSync(proposal), ["altro.txt"])
    })

    test("the user's own folder is not a destination: its FluentReaderMCP subdirectory is proposed", async () => {
        const { w } = away()
        const r = await call(w, "check-install-dir", installRequest(w, { installDir: w.home }))
        assert.equal(r.code, 0, r.one("message"))
        assert.equal(r.one("canonical"), path.join(w.home, DEFAULT_SUBDIR))
        assert.equal(r.one("adjusted"), "not-empty")
        assert.equal(r.one("outsideProfile"), "no")
        const direct = await call(w, "tx-begin", installRequest(w, { installDir: w.home, bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "new" }))
        assert.match(direct.one("message"), /non può essere direttamente la tua cartella utente/)
    })

    test("an installation outside the profile is recognised directly or through its parent; layout names alone prove nothing", async () => {
        const { w, volume } = away()
        const parent = path.join(volume, "Programmi")
        const dir = path.join(parent, DEFAULT_SUBDIR)
        await installed(w, dir)
        const direct = await call(w, "check-install-dir", installRequest(w, { installDir: dir }))
        assert.deepEqual([direct.one("canonical"), direct.one("mode"), direct.one("adjusted")], [dir, "repair", ""])
        const viaParent = await call(w, "check-install-dir", installRequest(w, { installDir: parent, version: "0.2.0" }))
        assert.deepEqual([viaParent.one("canonical"), viaParent.one("mode"), viaParent.one("adjusted")], [dir, "upgrade", "not-empty"])
        assert.match((await call(w, "check-install-dir", installRequest(w, { installDir: path.join(dir, "current", "x") }))).one("message"), /dentro un'altra installazione/)
        // a current tree without record or journal: not attributable, not used (it would be moved and removed otherwise)
        const fake = path.join(volume, "Sembra nostra")
        fs.mkdirSync(path.join(fake, "current", "app"), { recursive: true })
        fs.writeFileSync(path.join(fake, "current", "app", "file.txt"), "someone else's")
        fs.mkdirSync(path.join(fake, "state"))
        const before = snapshotDir(fake)
        const r = await call(w, "check-install-dir", installRequest(w, { installDir: fake }))
        assert.deepEqual([r.one("canonical"), r.one("adjusted")], [path.join(fake, DEFAULT_SUBDIR), "not-empty"], "a subfolder is proposed, the directory itself is not used")
        const begin = await call(w, "tx-begin", installRequest(w, { installDir: fake, bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "new" }))
        assert.match(begin.one("message"), /nomi usati da Fluent Reader MCP \(current\) ma nessun registro/)
        assert.deepEqual(snapshotDir(fake), before)
    })

    test("Windows, shared and other users' directories are refused on every drive", async () => {
        const { w, machine } = away()
        const sys = (name: string): string => {
            const dir = path.join(machine, name)
            fs.mkdirSync(dir, { recursive: true })
            return dir
        }
        const systemRoot = sys("Win")
        const programData = sys("Data comuni")
        const pub = sys(path.join("Users", "Public"))
        const env = { ...w.env, SystemRoot: systemRoot, ProgramData: programData, PUBLIC: pub }
        const drive = tempDrive()
        const cases: [string, RegExp][] = [
            [path.join(systemRoot, "FluentReaderMCP"), /cartella di Windows/],
            [path.join(programData, "FluentReaderMCP"), /ProgramData/],
            [path.join(pub, "FluentReaderMCP"), /cartella di un altro utente, in quella pubblica/],
            [path.join(machine, "Users", "altro utente", "FluentReaderMCP"), /cartella di un altro utente/],
            [path.join(machine, "Users"), /cartella di un altro utente/],
            [`${drive}Windows\\FluentReaderMCP`, /riservata a Windows o ai dati comuni/],
            [`${drive}ProgramData\\FluentReaderMCP`, /riservata a Windows o ai dati comuni/],
            ["D:\\Windows", /riservata a Windows o ai dati comuni/],
            ["D:\\ProgramData", /riservata a Windows o ai dati comuni/],
            ["D:\\windows\\FluentReaderMCP", /riservata a Windows o ai dati comuni/],
            [`${drive}$Recycle.Bin\\FluentReaderMCP`, /riservata a Windows o ai dati comuni/],
            [`${drive}System Volume Information\\FluentReaderMCP`, /riservata a Windows o ai dati comuni/],
        ]
        for (const [installDir, message] of cases) {
            const r = await call(w, "check-install-dir", installRequest(w, { installDir }), { ...deps(w), env })
            assert.equal(r.code, 1, installDir)
            assert.match(r.one("message"), message, installDir)
        }
    })

    test("DEC-C12: a folder under Program Files or Program Files (x86) is not refused for its name, on any drive: the write check decides", async () => {
        const { w } = away()
        const drive = tempDrive()
        for (const top of ["Program Files", "Program Files (x86)", "program files"]) {
            const dir = `${drive}${top}\\FluentReaderMCP`
            if (fs.existsSync(dir)) continue // a real one on this machine: never checked by a test
            const { d, probes } = probing(w, () => undefined)
            const r = await call(w, "check-install-dir", installRequest(w, { installDir: dir }), d)
            assert.deepEqual([r.code, r.one("adjusted"), r.one("mode"), r.one("outsideProfile")], [0, "", "new", "yes"], `${top}: ${r.one("message")}`)
            assert.equal(r.one("canonical").toLowerCase(), dir.toLowerCase())
            assert.equal(probes.length, 1, "the write check is what decides")
            // not writable: refused with a clear message, no permission touched, nothing elevated
            const denied = probing(w, () => {
                throw Object.assign(new Error("denied"), { code: "EPERM" })
            })
            const refused = await call(w, "check-install-dir", installRequest(w, { installDir: dir }), denied.d)
            assert.equal(refused.code, 1)
            assert.match(refused.one("message"), /non è possibile scrivere in .*\(EPERM\); scegli un'altra cartella\. Il setup non modifica i permessi delle cartelle e non chiede privilegi di amministratore/)
        }
    })

    test("DEC-C12: the folders the environment calls ProgramFiles follow the same rule, wherever they are", async () => {
        const { w, machine } = away()
        const programs = path.join(machine, "Programs")
        fs.mkdirSync(path.join(programs, "Altro"), { recursive: true })
        const env = { ...w.env, ProgramFiles: programs, "ProgramFiles(x86)": programs }
        const inside = path.join(programs, "FluentReaderMCP")
        const r = await call(w, "check-install-dir", installRequest(w, { installDir: inside }), { ...deps(w), env })
        assert.deepEqual([r.code, r.one("canonical"), r.one("adjusted")], [0, inside, ""], r.one("message"))
        // the programs directory itself is not a destination: its own subfolder is shown, as for a drive root
        const itself = await call(w, "check-install-dir", installRequest(w, { installDir: programs }), { ...deps(w), env })
        assert.deepEqual([itself.code, itself.one("canonical"), itself.one("adjusted")], [0, inside, "programs"], itself.one("message"))
        const direct = await call(w, "tx-begin", installRequest(w, { installDir: programs, bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "new" }), { ...deps(w), env })
        assert.match(direct.one("message"), /non può essere direttamente/)
        // a foreign installation folder under it stays protected like any other
        fs.writeFileSync(path.join(programs, "Altro", "app.exe"), "someone else's")
        const foreign = await call(w, "check-install-dir", installRequest(w, { installDir: path.join(programs, "Altro") }), { ...deps(w), env })
        assert.deepEqual([foreign.one("canonical"), foreign.one("adjusted")], [path.join(programs, "Altro", "FluentReaderMCP"), "not-empty"])
        assert.equal(fs.readFileSync(path.join(programs, "Altro", "app.exe"), "utf8"), "someone else's")
    })

    test("DEC-C12: a destination that cannot be created is refused at the wizard, and the real write check leaves nothing behind", async () => {
        const { w, volume } = away()
        const blocker = path.join(volume, "un file.txt")
        fs.writeFileSync(blocker, "a file, not a directory")
        const r = await call(w, "check-install-dir", installRequest(w, { installDir: path.join(blocker, "Reader") }))
        assert.equal(r.code, 1)
        assert.match(r.one("message"), /non è possibile scrivere in .*un file\.txt/)
        assert.equal(fs.readFileSync(blocker, "utf8"), "a file, not a directory")
        const ok = await call(w, "check-install-dir", installRequest(w, { installDir: path.join(volume, "Nuova", "Reader") }))
        assert.equal(ok.code, 0, ok.one("message"))
        assert.deepEqual(fs.readdirSync(volume), ["un file.txt"])
    })

    /** Runs `during` right after the probe creates its own file in its temporary directory, with that file's path; the real probe code, no production hook. */
    function duringProbe(t: TestContext, during: (ownFile: string, write: typeof fs.writeFileSync) => void): void {
        const realWrite = fs.writeFileSync
        t.mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
            realWrite(file, data, options)
            if (/\.fluent-reader-mcp-check-[0-9a-f]+[\\/]\.fluent-reader-mcp-check-[0-9a-f]+\.tmp$/.test(String(file))) during(String(file), realWrite)
        })
    }

    test("Codex Major: a foreign file that appears in the probe's temporary directory survives, unchanged, and the check does not succeed", async (t) => {
        const { w, volume } = away()
        const FOREIGN = "not ours: appeared during the check"
        const foreign: string[] = []
        duringProbe(t, (ownFile, write) => {
            const file = path.join(path.dirname(ownFile), "foreign.txt")
            write(file, FOREIGN)
            foreign.push(file)
        })
        // the probe alone
        const parent = path.join(volume, "Sintetica")
        fs.mkdirSync(parent)
        assert.throws(() => createProbe(parent), /la cartella di prova .* non è stata rimossa \(ENOTEMPTY\): il suo contenuto non viene toccato/)
        assert.equal(fs.readFileSync(foreign[0] as string, "utf8"), FOREIGN)
        assert.deepEqual(fs.readdirSync(path.dirname(foreign[0] as string)), ["foreign.txt"], "the probe's own file is gone, only the foreign one is left")
        // through the wizard's command: a refusal the user can read, no success
        const r = await call(w, "check-install-dir", installRequest(w, { installDir: path.join(volume, "Nuova", "Reader") }))
        assert.equal(r.code, 1)
        assert.equal(r.fields.has("canonical"), false)
        assert.match(r.one("message"), /non è possibile scrivere in .*non è stata rimossa \(ENOTEMPTY\).*scegli un'altra cartella\. Il setup non modifica i permessi/)
        assert.equal(fs.readFileSync(foreign[1] as string, "utf8"), FOREIGN)
    })

    test("the probe undisturbed succeeds and leaves nothing; a write it cannot do is reported as such and its empty directory goes", async (t) => {
        const { volume } = away()
        const parent = path.join(volume, "Sintetica")
        fs.mkdirSync(parent)
        fs.writeFileSync(path.join(parent, "esistente.txt"), "mine")
        createProbe(parent)
        assert.deepEqual(fs.readdirSync(parent), ["esistente.txt"])
        assert.equal(fs.readFileSync(path.join(parent, "esistente.txt"), "utf8"), "mine")
        const realWrite = fs.writeFileSync
        t.mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
            if (/\.fluent-reader-mcp-check-[0-9a-f]+\.tmp$/.test(String(file))) throw Object.assign(new Error("denied"), { code: "EACCES" })
            realWrite(file, data, options)
        })
        assert.throws(() => createProbe(parent), { code: "EACCES" })
        assert.deepEqual(fs.readdirSync(parent), ["esistente.txt"])
    })

    test("malformed paths are refused", async () => {
        const { w } = away()
        const drive = tempDrive()
        const cases: [string, RegExp][] = [
            ["D:", /unità locale/],
            ["D:relativo\\x", /unità locale/],
            ["\\\\?\\D:\\x", /unità locale/],
            ["\\\\.\\D:\\x", /unità locale/],
            ["\\\\server\\share\\x", /unità locale/],
            [`${drive}a\\..\\b`, /"\." o "\.\."/],
            [`${drive}con\\x`, /non è ammesso/],
            [`${drive}a|b`, /non è ammesso/],
            [`${drive}fine. `, /non è ammesso/],
            ["", /manca installDir/],
        ]
        for (const [installDir, message] of cases) {
            const r = await call(w, "check-install-dir", installRequest(w, { installDir }))
            assert.equal(r.code, 1, installDir)
            assert.match(r.one("message"), message, installDir)
        }
    })

    test("junctions on the way or as the destination are refused, their target untouched", async () => {
        const { w, volume, machine } = away()
        const target = path.join(machine, "Elsewhere é")
        fs.mkdirSync(target)
        fs.writeFileSync(path.join(target, "file.txt"), "elsewhere")
        const link = path.join(volume, "Collegamento")
        fs.symlinkSync(target, link, "junction")
        const before = snapshotDir(target)
        for (const installDir of [link, path.join(link, "FluentReaderMCP")]) {
            for (const command of ["check-install-dir", "tx-begin"]) {
                const r = await call(w, command, installRequest(w, { installDir, bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "new" }))
                assert.equal(r.code, 1, `${command} ${installDir}`)
                assert.match(r.one("message"), /collegamento, una junction o un nome breve/)
            }
        }
        assert.deepEqual(snapshotDir(target), before)
    })

    test("a destination that cannot be written is refused at the wizard, without touching permissions", async () => {
        const { w, volume } = away()
        const dir = path.join(volume, "Sola lettura")
        fs.mkdirSync(dir)
        const { d, probes } = probing(w, () => {
            throw Object.assign(new Error("access denied"), { code: "EACCES" })
        })
        const r = await call(w, "check-install-dir", installRequest(w, { installDir: dir }), d)
        assert.equal(r.code, 1)
        assert.match(r.one("message"), /non è possibile scrivere in .*\(EACCES\); scegli un'altra cartella\. Il setup non modifica i permessi delle cartelle/)
        assert.deepEqual(probes, [dir])
    })

    test("commands after the wizard never redirect: a drive root or a directory with other files is refused by tx-begin, desktop-plan and desktop-register; nothing written", async () => {
        const { w, volume } = away(personalConfig())
        const apps = path.join(volume, "Applicazioni")
        fs.mkdirSync(apps)
        fs.writeFileSync(path.join(apps, "altro.txt"), "not ours")
        const before = snapshotDir(volume)
        const config = fs.readFileSync(w.configPath)
        const extra = { bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "new", configPath: w.configPath, planHash: "0".repeat(64), consent: "yes" }
        for (const command of ["tx-begin", "desktop-plan", "desktop-register"]) {
            const r = await call(w, command, installRequest(w, { installDir: apps, ...extra }))
            assert.equal(r.code, 1, command)
            assert.match(r.one("message"), /contiene già altri file/, command)
            const atRoot = await call(w, command, installRequest(w, { installDir: tempDrive(), ...extra }))
            assert.match(atRoot.one("message"), /non può essere la radice di un'unità/, command)
        }
        assert.deepEqual(snapshotDir(volume), before)
        assert.ok(fs.readFileSync(w.configPath).equals(config), "Claude Desktop untouched")
    })

    test("the destination changes after the confirmation: tx-begin re-checks it before writing anything", async () => {
        const { w, volume, machine } = away()
        const begin = (installDir: string, expectMode: string): Promise<Answer> => call(w, "tx-begin", installRequest(w, { installDir, bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode }))
        // confirmed as new; another process then fills it
        const filled = path.join(volume, "Riempita")
        assert.equal((await call(w, "check-install-dir", installRequest(w, { installDir: filled }))).one("mode"), "new")
        fs.mkdirSync(filled)
        fs.writeFileSync(path.join(filled, "altro.txt"), "not ours")
        assert.match((await begin(filled, "new")).one("message"), /contiene già altri file/)
        assert.deepEqual(fs.readdirSync(filled), ["altro.txt"])
        // confirmed as new; an installation appears there
        const raced = path.join(volume, "Concorrente")
        assert.equal((await call(w, "check-install-dir", installRequest(w, { installDir: raced }))).one("mode"), "new")
        await installed(w, raced)
        const before = snapshotDir(raced)
        assert.match((await begin(raced, "new")).one("message"), /cambiata dopo la conferma \(attesa: new, trovata: repair\)/)
        assert.deepEqual(snapshotDir(raced), before)
        // confirmed as new; it becomes a junction to another place
        const swapped = path.join(volume, "Scambiata")
        assert.equal((await call(w, "check-install-dir", installRequest(w, { installDir: swapped }))).one("mode"), "new")
        const elsewhere = path.join(machine, "Altrove")
        fs.mkdirSync(elsewhere)
        fs.symlinkSync(elsewhere, swapped, "junction")
        assert.match((await begin(swapped, "new")).one("message"), /collegamento, una junction o un nome breve/)
        assert.deepEqual(fs.readdirSync(elsewhere), [])
        // the destination cannot be created (a file stands where its parent should be): refused before any write
        const blocker = path.join(volume, "un file.txt")
        fs.writeFileSync(blocker, "a file, not a directory")
        const r = await begin(path.join(blocker, "Reader"), "new")
        assert.equal(r.code, 1)
        assert.match(r.one("message"), /non è possibile scrivere nella cartella di installazione .*installazione non avviata, nulla è stato cambiato/)
        assert.equal(fs.readFileSync(blocker, "utf8"), "a file, not a directory")
        // and when the confirmed mode still matches, the transaction starts
        assert.equal((await begin(path.join(volume, "Libera"), "new")).code, 0)
    })

    test("preview, record and registration use the effective destination outside the profile", async () => {
        const { w: base, volume } = away(personalConfig())
        const apps = path.join(volume, "Applicazioni")
        fs.mkdirSync(apps)
        fs.writeFileSync(path.join(apps, "altro.txt"), "not ours")
        const choice = await call(base, "check-install-dir", installRequest(base, { installDir: apps }))
        assert.equal(choice.code, 0, choice.one("message"))
        const effective = choice.one("canonical")
        const w: World = { ...base, installDir: effective }
        await installed(w)
        const { plan, register } = await planAndRegister(w)
        const node = path.join(effective, "current", "app", "runtime", "node.exe")
        assert.ok((plan.fields.get("preview") ?? []).includes(`Eseguibile: ${node}`), "the preview shows the effective destination")
        assert.equal(register.code, 0, register.one("message"))
        assert.equal(record(w).installDir, effective)
        assert.equal(record(w).desktop?.entry.command, node)
        assert.equal((servers(w)[SERVER_NAME] as { command: string }).command, node)
        assert.equal(fs.readFileSync(path.join(apps, "altro.txt"), "utf8"), "not ours")
    })

    test("no permission is changed: the shipped setup helper and the NSIS script contain no ACL, ownership or elevation operation, and none of the 03A1/03A2a modules", () => {
        const shipped = setupClosure(COMPILED_ROOT)
        for (const excluded of ["location.js", "win32-security.js", "location-facts.js"]) assert.equal(shipped.some((f) => /[\\/]setup[\\/]/.test(f) && f.endsWith(excluded) && path.basename(f) === excluded), false, excluded)
        const forbidden = /icacls|\bcacls\b|takeown|SetSecurityInfo|SetNamedSecurityInfo|SetFileSecurity|SetKernelObjectSecurity|AccessControl::|\bchmod(Sync)?\b|\bchown(Sync)?\b|(from|import\(|require\()\s*"koffi"|runas|RequestExecutionLevel (admin|highest)/i
        for (const f of shipped) assert.doesNotMatch(fs.readFileSync(path.join(COMPILED_ROOT, f), "utf8"), forbidden, f)
        assert.doesNotMatch(fs.readFileSync(path.join(COMPILED_ROOT, "..", "installer", "nsis", "fluent-reader-mcp.nsi"), "utf8"), forbidden)
    })
})

// ------------------------------------------------------------------ FR-MCP-04-BETA-03A-SIMPLE-01: corrections after the Codex review

describe("review Major 1: a product name is not a proof of ownership", { skip: AWAY_SKIP }, () => {
    const begin = (w: World, installDir: string, extra: Record<string, string> = {}): Promise<Answer> => call(w, "tx-begin", installRequest(w, { installDir, bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "new", ...extra }))

    test("Codex case: a directory holding only someone else's uninstall.exe is not a new installation; nothing is replaced, moved or deleted", async () => {
        const { w, volume } = away()
        const dir = path.join(volume, "Vecchio programma")
        fs.mkdirSync(dir)
        const foreign = Buffer.from("MZ someone else's uninstaller \u0000\u0001\u0002")
        fs.writeFileSync(path.join(dir, "uninstall.exe"), foreign)
        const before = snapshotDir(dir)
        const check = await call(w, "check-install-dir", installRequest(w, { installDir: dir }))
        assert.deepEqual([check.one("canonical"), check.one("adjusted"), check.one("mode")], [path.join(dir, DEFAULT_SUBDIR), "not-empty", "new"], "only a dedicated subfolder is proposed")
        const r = await begin(w, dir)
        assert.equal(r.code, 1)
        assert.match(r.one("message"), /nomi usati da Fluent Reader MCP \(uninstall\.exe\) ma nessun registro di installazione né transazione che li attribuisca: non vengono usati, sostituiti né rimossi/)
        assert.deepEqual(snapshotDir(dir), before, "no state, no journal, no copy, no new uninstaller")
        assert.deepEqual(fs.readFileSync(path.join(dir, "uninstall.exe")), foreign, "byte for byte")
        // a directory already named FluentReaderMCP is not nested further: refused
        const named = path.join(volume, DEFAULT_SUBDIR)
        fs.mkdirSync(named)
        fs.writeFileSync(path.join(named, "uninstall.exe"), foreign)
        assert.match((await call(w, "check-install-dir", installRequest(w, { installDir: named }))).one("message"), /contiene già altri file e non è un'installazione di Fluent Reader MCP: scegli un'altra cartella/)
        assert.deepEqual(fs.readdirSync(named), ["uninstall.exe"])
    })

    test("every name of the layout without record or journal is unattributed; only an empty state directory and an empty directory are used as they are", async () => {
        const { w, volume } = away()
        const file = (dir: string, relative: string): void => {
            fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
            fs.writeFileSync(path.join(dir, relative), `content of ${relative}`)
        }
        const cases: [string, (dir: string) => void, "direct" | RegExp][] = [
            ["vuota", () => undefined, "direct"],
            ["solo state vuota", (d) => fs.mkdirSync(path.join(d, "state", "sub"), { recursive: true }), "direct"],
            ["state con file", (d) => file(d, "state\\claude-config-backups\\claude.json.bak"), /\(state\) ma nessun registro/],
            ["solo .staging", (d) => file(d, ".staging\\app\\x.js"), /\(\.staging\) ma nessun registro/],
            ["solo .staging vuota", (d) => fs.mkdirSync(path.join(d, ".staging")), /\(\.staging\) ma nessun registro/],
            ["solo previous", (d) => file(d, "previous\\installer-files.json"), /\(previous\) ma nessun registro/],
            ["solo current", (d) => file(d, "current\\app\\x.js"), /\(current\) ma nessun registro/],
            ["combinazione", (d) => { file(d, "uninstall.exe"); file(d, "state\\x"); file(d, "previous\\y"); file(d, ".staging\\z") }, /nomi usati da Fluent Reader MCP \(.*uninstall\.exe.*\) ma nessun registro/],
            ["file estranei", (d) => file(d, "documento.txt"), /contiene già altri file; scegli una cartella vuota o nuova/],
            ["state vuota e un file estraneo", (d) => { fs.mkdirSync(path.join(d, "state")); file(d, "documento.txt") }, /contiene già altri file; scegli una cartella vuota o nuova/],
        ]
        for (const [name, make, expected] of cases) {
            const dir = path.join(volume, name)
            fs.mkdirSync(dir)
            make(dir)
            const before = snapshotDir(dir)
            const check = await call(w, "check-install-dir", installRequest(w, { installDir: dir }))
            assert.equal(check.code, 0, `${name}: ${check.one("message")}`)
            const r = await begin(w, dir)
            if (expected === "direct") {
                assert.deepEqual([check.one("canonical"), check.one("adjusted")], [dir, ""], name)
                assert.equal(r.code, 0, `${name}: ${r.one("message")}`)
                continue
            }
            assert.deepEqual([check.one("canonical"), check.one("adjusted")], [path.join(dir, DEFAULT_SUBDIR), "not-empty"], name)
            assert.equal(r.code, 1, name)
            assert.match(r.one("message"), expected, name)
            assert.deepEqual(snapshotDir(dir), before, `${name}: untouched`)
        }
    })

    test("a valid record or journal still attributes the layout: repair, upgrade and an interrupted first installation; an altered or copied journal is refused", async () => {
        const { w, volume } = away()
        const recorded = path.join(volume, "Installata")
        await installed(w, recorded)
        fs.writeFileSync(path.join(recorded, "uninstall.exe"), "our uninstaller")
        assert.equal((await call(w, "check-install-dir", installRequest(w, { installDir: recorded }))).one("mode"), "repair")
        assert.equal((await call(w, "check-install-dir", installRequest(w, { installDir: recorded, version: "0.2.0" }))).one("mode"), "upgrade")
        // a first installation interrupted before its record: the journal describes .staging and state
        const interrupted = path.join(volume, "Interrotta")
        assert.equal((await begin(w, interrupted)).code, 0)
        fs.mkdirSync(path.join(interrupted, ".staging", "app"), { recursive: true })
        fs.writeFileSync(path.join(interrupted, ".staging", "app", "x.js"), "partial")
        const resumed = await call(w, "check-install-dir", installRequest(w, { installDir: interrupted }))
        assert.deepEqual([resumed.one("canonical"), resumed.one("mode"), resumed.one("adjusted")], [interrupted, "new", ""])
        // the same journal copied next to someone else's files, or altered: incoherent, nothing used
        const journal = fs.readFileSync(path.join(interrupted, "state", "install-journal.json"), "utf8")
        const copied = path.join(volume, "Copiata")
        fs.mkdirSync(path.join(copied, "state"), { recursive: true })
        fs.writeFileSync(path.join(copied, "state", "install-journal.json"), journal)
        fs.writeFileSync(path.join(copied, "uninstall.exe"), "someone else's")
        fs.writeFileSync(path.join(interrupted, "state", "install-journal.json"), journal.replace('"phase": "staging"', '"phase": "committed"'))
        for (const dir of [copied, interrupted]) {
            const before = snapshotDir(dir)
            const r = await call(w, "check-install-dir", installRequest(w, { installDir: dir }))
            assert.equal(r.code, 1, dir)
            assert.match(r.one("message"), /journal dell'installazione .* non è valido o è stato alterato/, dir)
            assert.equal((await begin(w, dir)).code, 1, dir)
            assert.deepEqual(snapshotDir(dir), before, dir)
        }
        // an incoherent uninstall marker keeps refusing as before
        const marked = path.join(volume, "Marcatore")
        fs.mkdirSync(path.join(marked, "state"), { recursive: true })
        fs.writeFileSync(path.join(marked, "state", "uninstall.json"), "{}")
        assert.match((await call(w, "check-install-dir", installRequest(w, { installDir: marked }))).one("message"), /disinstallazione non conclusa/)
    })
})

describe("review Major 2: conventional profile locations on every drive (lexical precaution)", () => {
    test("X:\\Users\\<account> is refused on any drive unless it is inside USERPROFILE; segment-aware, case-insensitive; other shapes allowed", () => {
        const cases: [string, string, string | null][] = [
            // home C:\Users\Bruno
            ["C:\\Users\\Bruno", "C:\\Users\\Bruno\\FluentReaderMCP", null],
            ["C:\\Users\\Bruno", "C:\\Users\\Bruno\\AppData\\Local\\FluentReaderMCP", null],
            ["C:\\Users\\Bruno", "C:\\Users\\Alice\\FluentReaderMCP", "C:\\Users"],
            ["C:\\Users\\Bruno", "C:\\Users\\Public\\FluentReaderMCP", "C:\\Users"],
            ["C:\\Users\\Bruno", "C:\\Users", "C:\\Users"],
            ["C:\\Users\\Bruno", "D:\\Users\\Alice\\FluentReaderMCP", "D:\\Users"],
            ["C:\\Users\\Bruno", "H:\\Users\\Alice\\FluentReaderMCP", "H:\\Users"],
            ["C:\\Users\\Bruno", "D:\\Users\\Bruno\\FluentReaderMCP", "D:\\Users"],
            ["C:\\Users\\Bruno", "d:\\USERS\\alice\\FluentReaderMCP", "d:\\USERS"],
            ["C:\\Users\\Bruno", "c:\\users\\bruno\\FluentReaderMCP", null],
            ["C:\\Users\\Bruno", "D:\\UsersBackup\\FluentReaderMCP", null],
            ["C:\\Users\\Bruno", "D:\\Users.old\\Alice\\FluentReaderMCP", null],
            ["C:\\Users\\Bruno", "D:\\Dati\\Users\\Alice\\FluentReaderMCP", null],
            ["C:\\Users\\Bruno", "D:\\Applicazioni\\FluentReaderMCP", null],
            // the current profile on another letter
            ["E:\\Users\\bruno", "E:\\Users\\bruno\\FluentReaderMCP", null],
            ["E:\\Users\\bruno", "E:\\Users\\alice\\FluentReaderMCP", "E:\\Users"],
            ["E:\\Users\\bruno", "C:\\Users\\bruno\\FluentReaderMCP", "C:\\Users"],
            // a current profile under another root: its siblings on its own drive; the root name is not generalised
            ["D:\\Profili\\bruno", "D:\\Profili\\alice\\FluentReaderMCP", "D:\\Profili"],
            ["D:\\Profili\\bruno", "D:\\Profili\\bruno\\FluentReaderMCP", null],
            ["D:\\Profili\\bruno", "C:\\Profili\\alice\\FluentReaderMCP", null],
            ["D:\\Profili\\bruno", "D:\\ProfiliVecchi\\FluentReaderMCP", null],
            ["D:\\Profili\\bruno", "C:\\Users\\alice\\FluentReaderMCP", "C:\\Users"],
            // a profile directly under a drive root: no sibling rule (it would cover the whole drive)
            ["D:\\bruno", "D:\\alice\\FluentReaderMCP", null],
        ]
        for (const [home, dir, expected] of cases) assert.equal(otherProfileLocation(dir, home), expected, `${home} | ${dir}`)
    })

    test("through the helper (read-only on the real drives): C:\\Users\\Alice and D:\\Users\\Alice refused, D:\\UsersBackup and D:\\Applicazioni allowed", { skip: AWAY_SKIP }, async () => {
        const { w } = away()
        const noWrite = probing(w, () => undefined).d // real drive roots are only inspected
        for (const dir of ["C:\\Users\\Alice\\FluentReaderMCP", "D:\\Users\\Alice\\FluentReaderMCP", "D:\\users\\BRUNO\\FluentReaderMCP"]) {
            if (!fs.existsSync(dir.slice(0, 3))) continue
            const r = await call(w, "check-install-dir", installRequest(w, { installDir: dir }), noWrite)
            assert.equal(r.code, 1, dir)
            assert.match(r.one("message"), /non può stare nella cartella di un altro utente, in quella pubblica o direttamente in [A-Za-z]:\\Users \(percorso con la forma di una cartella dei profili di Windows/i, dir)
        }
        for (const dir of ["D:\\UsersBackup\\FluentReaderMCP", "D:\\Applicazioni\\FluentReaderMCP"]) {
            if (!fs.existsSync("D:\\") || fs.existsSync(path.dirname(dir))) continue // never checked against a real existing folder
            const r = await call(w, "check-install-dir", installRequest(w, { installDir: dir }), noWrite)
            assert.deepEqual([r.code, r.one("canonical"), r.one("mode"), r.one("adjusted")], [0, dir, "new", ""], r.one("message"))
            assert.equal(fs.existsSync(path.dirname(dir)), false, "nothing created")
        }
    })
})

describe("review Minor 1: tx-begin requires the confirmed mode", { skip: AWAY_SKIP }, () => {
    test("absent, empty or unknown expectMode, or a mode that is not the directory's, is refused before any write; new, repair and upgrade pass", async () => {
        const { w, volume } = away()
        const fresh = path.join(volume, "Nuova")
        const base = { installDir: fresh, bundleSha256: "a".repeat(64), profileDir: w.profile }
        const refused: [Record<string, string>, RegExp][] = [
            [{}, /richiesta incompleta: manca expectMode/],
            [{ expectMode: "" }, /richiesta incompleta: manca expectMode/],
            [{ expectMode: "install" }, /expectMode deve essere new, repair, upgrade/],
            [{ expectMode: "NEW" }, /expectMode deve essere new, repair, upgrade/],
            [{ expectMode: "repair" }, /cambiata dopo la conferma \(attesa: repair, trovata: new\)/],
            [{ expectMode: "upgrade" }, /cambiata dopo la conferma \(attesa: upgrade, trovata: new\)/],
        ]
        for (const [extra, message] of refused) {
            const r = await call(w, "tx-begin", installRequest(w, { ...base, ...extra }))
            assert.equal(r.code, 1, JSON.stringify(extra))
            assert.match(r.one("message"), message, JSON.stringify(extra))
            assert.equal(fs.existsSync(fresh), false, `${JSON.stringify(extra)}: nothing written`)
        }
        assert.equal((await call(w, "tx-begin", installRequest(w, { ...base, expectMode: "new" }))).code, 0)
        const recorded = path.join(volume, "Installata")
        await installed(w, recorded)
        // an installed tree that tx-begin can verify file by file against its own inventory
        fs.writeFileSync(path.join(recorded, "current", "file.txt"), "installed")
        fs.writeFileSync(path.join(recorded, "current", INVENTORY), JSON.stringify(buildInventory(path.join(recorded, "current"), VERSION)))
        const before = snapshotDir(recorded)
        for (const [version, wrong] of [["0.1.0", "upgrade"], ["0.2.0", "repair"], ["0.1.0", "new"]] as const) {
            const r = await call(w, "tx-begin", installRequest(w, { ...base, installDir: recorded, version, expectMode: wrong }))
            assert.match(r.one("message"), /cambiata dopo la conferma/, `${version} ${wrong}`)
            assert.deepEqual(snapshotDir(recorded), before, "nothing written")
        }
        assert.equal((await call(w, "tx-begin", installRequest(w, { ...base, installDir: recorded, expectMode: "repair" }))).code, 0)
        fs.rmSync(path.join(recorded, "state", "install-journal.json"))
        assert.equal((await call(w, "tx-begin", installRequest(w, { ...base, installDir: recorded, version: "0.2.0", expectMode: "upgrade" }))).code, 0)
    })
})

describe("review Minor 2: \"$\" alone does not make a system folder", { skip: AWAY_SKIP }, () => {
    test("$Recycle.Bin and the Windows setup folders are refused at the top of a drive; $Projects and look-alikes are not", async () => {
        const { w } = away()
        const drive = awayBase().slice(0, 3)
        const noWrite = probing(w, () => undefined).d // real drive roots are only inspected
        for (const top of ["$Recycle.Bin", "$RECYCLE.BIN", "$recycle.bin", "$WinREAgent", "$Windows.~BT", "$Windows.~WS", "$SysReset", "System Volume Information"]) {
            const r = await call(w, "check-install-dir", installRequest(w, { installDir: `${drive}${top}\\FluentReaderMCP` }), noWrite)
            assert.equal(r.code, 1, top)
            assert.match(r.one("message"), /riservata a Windows o ai dati comuni a tutti gli utenti/, top)
        }
        for (const relative of ["$Projects\\FluentReaderMCP", "$Recycle.Bin.old\\FluentReaderMCP", "$RecycleBin\\FluentReaderMCP", "Progetti\\$Recycle.Bin\\FluentReaderMCP"]) {
            const dir = `${drive}${relative}`
            if (fs.existsSync(`${drive}${relative.split("\\")[0] as string}`)) continue // never checked against a real existing folder
            const r = await call(w, "check-install-dir", installRequest(w, { installDir: dir }), noWrite)
            assert.deepEqual([r.code, r.one("canonical"), r.one("adjusted")], [0, dir, ""], `${relative}: ${r.one("message")}`)
        }
    })
})

describe("review Minor: the fixture guard is independent of how the path is written", () => {
    test("empty, relative, the area itself, a sibling with a shared prefix, '..' escapes and a junction out are refused before anything is created; normalised paths inside pass", async () => {
        counter++
        const box = path.join(root, `guard ${counter}`)
        const area = path.join(box, "area")
        const outside = path.join(box, "outside")
        fs.mkdirSync(area, { recursive: true })
        fs.mkdirSync(outside)
        fs.writeFileSync(path.join(outside, "x.txt"), "outside")
        fs.symlinkSync(outside, path.join(area, "link"), "junction")
        const ok = (dir: string): void => assert.doesNotThrow(() => assertInTestArea(dir, [area]), dir)
        const ko = (dir: string): void => assert.throws(() => assertInTestArea(dir, [area]), /fixture outside the test area/, dir)
        ko("")
        ko("relative\\dir")
        ko(".")
        ko(area)
        ko(`${area}\\..`)
        ko(`${area}2\\x`)
        ko(`${area}-sibling\\x`)
        ko(`${area}\\..\\outside\\x`)
        ko(`${area}\\sub\\..\\..\\outside`)
        ko(path.join(area, "link"))
        ko(path.join(area, "link", "deeper", "x"))
        ok(path.join(area, "sub"))
        ok(`${area}\\a\\..\\b`)
        ok(`${area.toUpperCase()}\\sub`)
        ok(path.join(area, "..link", "x"))
        // the fixture itself refuses, and nothing appears outside
        const w = world()
        const escape = `${root}\\..\\frmcp-escape-${counter}`
        for (const dir of ["", "relativo", escape, `${root}2\\x`, `${root}\\sub\\..\\..\\frmcp-escape-${counter}`]) {
            await assert.rejects(installed(w, dir), /fixture outside the test area/, dir)
        }
        assert.equal(fs.existsSync(path.win32.resolve(escape)), false, "nothing created next to the temp root")
        assert.deepEqual(fs.readdirSync(outside), ["x.txt"], "nothing created through the junction")
        assert.equal(fs.existsSync(path.join(process.cwd(), "current")), false, "nothing in the working directory")
    })
})

// ---------------------------------------------------------------- FR-MCP-04-BETA-03A-SIMPLE-02

const LEGACY_A = "claude.json.20261001T090000Z.bak"
const LEGACY_B = "claude.json.20261002T090000Z-1.bak"

function localAppData(w: World): string {
    return path.join(w.home, "AppData", "Local")
}

/** Files under `dir` whose bytes hold the synthetic secret: none may be under an installation directory. */
function secretFilesUnder(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    return [...snapshotDir(dir).keys()].filter((key) => {
        const file = path.join(dir, ...key.split("/"))
        return fs.lstatSync(file).isFile() && fs.readFileSync(file).includes(SECRET)
    })
}

function sha256(bytes: Buffer): string {
    return crypto.createHash("sha256").update(bytes).digest("hex")
}

/** ~/.claude.json of the synthetic user, and the entry an earlier setup wrote in it. */
function codeConfigPath(w: World): string {
    return path.join(w.home, ".claude.json")
}

function codeEntry(w: World): { type: "stdio"; command: string; args: string[]; env: Record<string, string> } {
    const app = path.join(w.installDir, "current", "app")
    return { type: "stdio", command: path.join(app, "runtime", "node.exe"), args: [path.join(app, "server", "dist", "main.js"), "--profile-dir", w.profile], env: {} }
}

/** A record as an earlier setup wrote it: registered in Claude Code, its copy named by file only (state\claude-config-backups). */
function legacyRegistration(w: World, backup: string | null): void {
    const file = path.join(w.installDir, RECORD_NAME)
    const entry = codeEntry(w)
    writeRecord(file, { ...(readRecord(file) as InstallRecord), claude: { state: "registered", name: SERVER_NAME, scope: "user", configPath: codeConfigPath(w), claudeExe: path.join(w.home, "claude.exe"), entry, fingerprint: entryFingerprint(entry), backup, updatedAt: "2026-10-01T09:00:00.000Z" } })
}

function legacyDir(w: World): string {
    return path.join(w.installDir, "state", "claude-config-backups")
}

/** A copy left by an earlier setup in state\claude-config-backups (synthetic content with the secret). */
function legacyCopy(w: World, name: string, content: string | Buffer = JSON.stringify(personalConfig({ n: name }))): string {
    assertInTestArea(legacyDir(w))
    fs.mkdirSync(legacyDir(w), { recursive: true })
    fs.writeFileSync(path.join(legacyDir(w), name), content)
    return path.join(legacyDir(w), name)
}

describe("FR-MCP-04-BETA-03A-SIMPLE-02: copies of the configurations in the user's private directory", () => {
    test("a registration keeps its copy only in %LOCALAPPDATA%\\FluentReaderMCP-Data, bound to the installation; nothing sensitive under the installation directory", async () => {
        const w = world(personalConfig())
        await installed(w)
        const original = fs.readFileSync(w.configPath)
        const dir = privateDesktopBackupDir(w.env, w.installDir)
        assert.ok(dir.startsWith(path.join(localAppData(w), "FluentReaderMCP-Data", "desktop-config-backups") + path.sep), dir)
        assert.match(path.basename(dir), /^[0-9a-f]{32}$/)
        const { plan, register } = await planAndRegister(w)
        assert.ok(plan.one("preview").includes(`nella tua cartella personale, fuori dalla cartella di installazione: ${dir}`), plan.one("preview"))
        assert.equal(register.code, 0, register.one("message"))
        const [name] = backups(w)
        assert.ok(name !== undefined && DESKTOP_BACKUP_NAME.test(name))
        assert.deepEqual(fs.readdirSync(dir), [name], "no temporary copy left")
        assert.equal(register.one("backup"), path.join(dir, name))
        assert.ok(fs.readFileSync(path.join(dir, name)).equals(original))
        const rec = record(w)
        assert.equal(rec.desktop?.backup, name)
        assert.equal(rec.desktop?.backupDir, dir)
        assert.equal(rec.desktop?.backupSha256, sha256(original))
        assert.equal(JSON.stringify(rec).includes(SECRET), false, "only name, directory and SHA-256 are recorded")
        assert.deepEqual(secretFilesUnder(w.installDir), [])
        assert.equal(`${plan.text}${register.text}`.includes(SECRET), false)
        assert.deepEqual(recordedDesktopBackup(w.installDir, rec, w.env), { status: "ok", path: path.join(dir, name) })
    })

    test("the default installation directory %LOCALAPPDATA%\\FluentReaderMCP: the copy is next to it, never inside", async () => {
        const base = world(personalConfig())
        const w: World = { ...base, installDir: path.join(localAppData(base), "FluentReaderMCP") }
        await installed(w)
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 0, register.one("message"))
        const dir = privateDesktopBackupDir(w.env, w.installDir)
        assert.equal(dir.toLowerCase().startsWith(`${w.installDir.toLowerCase()}\\`), false)
        assert.equal(backups(w).length, 1)
        assert.deepEqual(secretFilesUnder(w.installDir), [])
    })

    test("%LOCALAPPDATA% missing, relative, on the network, outside the profile, the profile itself or a file: refused before consent and at registration; nothing copied anywhere", async () => {
        const w = world(personalConfig())
        await installed(w)
        const plan = await call(w, "desktop-plan", planRequest(w))
        const outside = path.join(root, `shared ${counter}`)
        fs.mkdirSync(outside)
        const aFile = path.join(w.home, "a file")
        fs.writeFileSync(aFile, "x")
        const config = fs.readFileSync(w.configPath)
        const recordBefore = fs.readFileSync(path.join(w.installDir, RECORD_NAME))
        const { LOCALAPPDATA: _local, ...without } = w.env
        const envs: [string, NodeJS.ProcessEnv][] = [
            ["missing", without], ["relative", { ...w.env, LOCALAPPDATA: "AppData\\Local" }], ["network", { ...w.env, LOCALAPPDATA: "\\\\server\\share\\Local" }],
            ["outside the profile", { ...w.env, LOCALAPPDATA: outside }], ["the profile itself", { ...w.env, LOCALAPPDATA: w.home }], ["a file", { ...w.env, LOCALAPPDATA: aFile }],
        ]
        for (const [label, env] of envs) {
            const d = { ...deps(w), env }
            const p = await call(w, "desktop-plan", planRequest(w), d)
            assert.equal(p.code, 1, label)
            assert.match(p.one("message"), /cartella personale \(%LOCALAPPDATA%\), che non è utilizzabile.*Nessuna copia viene salvata altrove/, label)
            const r = await call(w, "desktop-register", planRequest(w, { planHash: plan.one("planHash"), consent: "yes" }), d)
            assert.equal(r.code, 1, label)
            assert.match(r.one("message"), /Nessuna copia viene salvata altrove e la configurazione non viene modificata/, label)
        }
        assert.ok(fs.readFileSync(w.configPath).equals(config), "configuration unchanged")
        assert.ok(fs.readFileSync(path.join(w.installDir, RECORD_NAME)).equals(recordBefore), "record unchanged")
        assert.deepEqual(fs.readdirSync(outside), [], "no fallback to another directory")
        assert.equal(fs.existsSync(path.join(w.installDir, "state")), false, "no fallback to the installation directory")
        assert.equal(fs.existsSync(path.join(localAppData(w), "FluentReaderMCP-Data")), false)
    })

    test("a junction or a file in place of a managed directory: nothing is written through it", async () => {
        const w = world(personalConfig())
        await installed(w)
        const config = fs.readFileSync(w.configPath)
        const elsewhere = path.join(w.home, "elsewhere")
        fs.mkdirSync(elsewhere)
        fs.symlinkSync(elsewhere, path.join(localAppData(w), "FluentReaderMCP-Data"), "junction")
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 1)
        assert.match(register.one("message"), /FluentReaderMCP-Data non è una cartella normale \(collegamento, junction o file\)/)
        assert.deepEqual(fs.readdirSync(elsewhere), [])
        assert.ok(fs.readFileSync(w.configPath).equals(config), "Claude Desktop untouched")
        const v = world(personalConfig())
        await installed(v)
        fs.mkdirSync(path.join(localAppData(v), "FluentReaderMCP-Data"))
        fs.writeFileSync(path.join(localAppData(v), "FluentReaderMCP-Data", "desktop-config-backups"), "a file")
        const second = await planAndRegister(v)
        assert.match(second.register.one("message"), /desktop-config-backups non è una cartella normale/)
        assert.equal(fs.readFileSync(path.join(localAppData(v), "FluentReaderMCP-Data", "desktop-config-backups"), "utf8"), "a file")
    })

    test("a file that changes while its copy is taken: no copy passed off as the content the change starts from, no temporary file left", () => {
        const w = world(personalConfig())
        assert.throws(() => createDesktopBackup(w.configPath, "0".repeat(64), w.installDir, w.env, new Date("2026-10-28T10:00:00Z")), /è cambiato mentre ne veniva salvata la copia: nessuna modifica eseguita/)
        assert.deepEqual(backups(w), [])
    })

    test("two installations of one user: separate private directories, no collision; repair and upgrade keep the same directory with a new copy per change", async () => {
        const a = world(personalConfig())
        await installed(a)
        assert.equal((await planAndRegister(a)).register.code, 0)
        const b: World = { ...a, installDir: path.join(localAppData(a), "Seconda installazione") }
        await installed(b)
        const dirA = privateDesktopBackupDir(a.env, a.installDir)
        const dirB = privateDesktopBackupDir(b.env, b.installDir)
        assert.notEqual(dirA.toLowerCase(), dirB.toLowerCase())
        const snapA = snapshotDir(dirA)
        assert.equal((await planAndRegister(b, { replaceForeign: "yes" })).register.code, 0)
        assert.equal(backups(b).length, 1)
        assert.deepEqual(snapshotDir(dirA), snapA, "the first installation's copies untouched")
        // upgrade simulation of b: another generation, an older own entry; the same private directory, a second copy
        const rec = record(b)
        const oldProfile = buildSmokeProfile(path.join(b.home, "Profili Fluent", `vecchio ${counter}`)).dir
        const oldEntry = desiredDesktopEntry(b.installDir, oldProfile)
        fs.writeFileSync(path.join(b.installDir, RECORD_NAME), JSON.stringify({ ...rec, generation: "cd".repeat(16), version: "0.0.9", desktop: { ...rec.desktop, entry: oldEntry, fingerprint: entryFingerprint(oldEntry) } }))
        const doc = readConfig(b)
        fs.writeFileSync(b.configPath, JSON.stringify({ ...doc, mcpServers: { ...(doc.mcpServers as object), [SERVER_NAME]: oldEntry } }))
        const again = await planAndRegister(b)
        assert.equal(again.plan.one("action"), "replace-own")
        assert.equal(again.register.code, 0, again.register.one("message"))
        assert.equal(backups(b).length, 2, "same directory across generations, never overwritten")
        assert.equal(record(b).desktop?.backupDir, dirB)
        assert.deepEqual(others(b), otherServers(), "other servers preserved")
        assert.deepEqual(snapshotDir(dirA), snapA)
        const noteA = (await call(a, "un-status", { installDir: a.installDir })).one("backups")
        assert.ok(noteA.includes(dirA) && !noteA.includes(dirB), noteA)
    })

    test("errors before and after the change: the private copy is the configuration before it, and the message names it", async () => {
        const failures: [string, (w: World) => void][] = [
            ["before", (w) => (w.replace = () => {
                throw Object.assign(new Error("denied"), { code: "EPERM" })
            })],
            ["after", (w) => (w.checkpoint = (s) => {
                if (s === "after-replace") throw new Error("injected failure")
            })],
        ]
        for (const [label, setup] of failures) {
            const w = world(personalConfig())
            await installed(w)
            const original = fs.readFileSync(w.configPath)
            setup(w)
            const { register } = await planAndRegister(w)
            assert.equal(register.code, 1, label)
            const [name] = backups(w)
            const file = path.join(privateDesktopBackupDir(w.env, w.installDir), name as string)
            assert.ok(register.one("message").includes(`La copia presa prima della modifica è in ${file}.`), label)
            assert.ok(fs.readFileSync(file).equals(original), label)
            assert.ok(fs.readFileSync(w.configPath).equals(original), `${label}: the file is byte for byte what it was`)
            assert.equal(register.text.includes(SECRET), false)
        }
    })

    /** The registration's backup fields replaced (undefined removes a field): the record stays as written otherwise. */
    function patchRegistration(w: World, patch: Record<string, unknown>): void {
        const rec = record(w)
        writeRecord(path.join(w.installDir, RECORD_NAME), { ...rec, claude: { ...(rec.claude as NonNullable<InstallRecord["claude"]>), ...patch } })
    }

    /** An installation of an earlier setup whose record names LEGACY_A, kept in state\claude-config-backups. */
    async function legacyInstallation(): Promise<{ w: World; a: Buffer }> {
        const w = world(personalConfig())
        await installed(w)
        const a = fs.readFileSync(legacyCopy(w, LEGACY_A))
        legacyRegistration(w, LEGACY_A)
        return { w, a }
    }

    const privateRoot = (w: World): string => path.join(localAppData(w), "FluentReaderMCP-Data")

    test("the one copy the record names: moved byte for byte, recorded (directory and SHA-256) before the original goes; a repeated run changes nothing", async () => {
        const { w, a } = await legacyInstallation()
        assert.equal(recordedBackup(w.installDir, record(w), w.env).status, "legacy")
        const steps: string[] = []
        assert.deepEqual(migrateLegacyBackups(w.installDir, w.env, (s) => {
            steps.push(s)
            if (s === "after-record") {
                assert.equal(record(w).claude?.backupSha256, sha256(a), "recorded first")
                assert.ok(fs.existsSync(path.join(legacyDir(w), LEGACY_A)), "the original is still there")
            }
        }), [LEGACY_A])
        assert.deepEqual(steps, ["after-copy", "after-publish", "after-record"])
        const dir = privateBackupDir(w.env, w.installDir)
        assert.deepEqual(fs.readdirSync(dir), [LEGACY_A])
        assert.ok(fs.readFileSync(path.join(dir, LEGACY_A)).equals(a), "identical byte for byte")
        assert.equal(fs.existsSync(legacyDir(w)), false, "the old directory is gone")
        assert.deepEqual(secretFilesUnder(w.installDir), [])
        assert.equal(record(w).claude?.backupDir, dir)
        assert.deepEqual(recordedBackup(w.installDir, record(w), w.env), { status: "ok", path: path.join(dir, LEGACY_A) })
        const snap = snapshotDir(privateRoot(w))
        const rec = fs.readFileSync(path.join(w.installDir, RECORD_NAME))
        assert.deepEqual(migrateLegacyBackups(w.installDir, w.env), [])
        assert.deepEqual(snapshotDir(privateRoot(w)), snap)
        assert.ok(fs.readFileSync(path.join(w.installDir, RECORD_NAME)).equals(rec))
    })

    test("Codex Major: anything next to the named copy (another valid copy, even identical; another name; a directory; a link) stops the whole move before any change", async () => {
        const cases: [string, (w: World, a: Buffer) => void, RegExp][] = [
            ["an unreferenced copy with valid JSON", (w) => legacyCopy(w, LEGACY_B), /claude\.json\.20261002T090000Z-1\.bak \(copia non indicata dal registro di installazione\)/],
            ["an unreferenced copy identical to the named one", (w, a) => legacyCopy(w, LEGACY_B, a), /claude\.json\.20261002T090000Z-1\.bak \(copia non indicata dal registro di installazione\)/],
            ["another name", (w) => legacyCopy(w, "notes.txt", "mine"), /notes\.txt \(nome non previsto\)/],
            ["a subdirectory", (w) => fs.mkdirSync(path.join(legacyDir(w), "sub")), /sub \(non è un file\)/],
            ["a junction with a copy's name", (w) => fs.symlinkSync(w.home, path.join(legacyDir(w), "claude.json.20261005T090000Z.bak"), "junction"), /claude\.json\.20261005T090000Z\.bak \(collegamento\)/],
            ["a leftover temporary copy", (w) => legacyCopy(w, `.${LEGACY_A}.0123456789abcdef.partial`, "{}"), /\.partial \(nome non previsto\)/],
        ]
        for (const [label, add, message] of cases) {
            const { w, a } = await legacyInstallation()
            add(w, a)
            const before = snapshotDir(legacyDir(w))
            const rec = fs.readFileSync(path.join(w.installDir, RECORD_NAME))
            assert.throws(() => migrateLegacyBackups(w.installDir, w.env), (e: Error) => message.test(e.message) && /non attribuibili con certezza a questa installazione.*Nessun elemento è stato modificato, spostato o cancellato\. Prima di aggiornare o riparare serve un tuo intervento/.test(e.message) && !e.message.includes(SECRET), label)
            assert.deepEqual(snapshotDir(legacyDir(w)), before, `${label}: every original in place, byte for byte`)
            assert.ok(fs.readFileSync(path.join(legacyDir(w), LEGACY_A)).equals(a), label)
            assert.ok(fs.readFileSync(path.join(w.installDir, RECORD_NAME)).equals(rec), `${label}: record unchanged`)
            assert.equal(fs.existsSync(privateRoot(w)), false, `${label}: no private copy created`)
            // and so does the transaction that would run it: an upgrade or a repair does not start
            const begin = await call(w, "tx-begin", installRequest(w, { bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "repair" }))
            assert.equal(begin.code, 1, label)
            assert.deepEqual(snapshotDir(legacyDir(w)), before, label)
        }
    })

    test("a record that names no copy there, names it in another form, or is bound to another directory: nothing is moved; an empty old directory blocks nothing", async () => {
        const refused = (w: World, message: RegExp, label: string): void => {
            const before = snapshotDir(legacyDir(w))
            const rec = fs.readFileSync(path.join(w.installDir, RECORD_NAME))
            assert.throws(() => migrateLegacyBackups(w.installDir, w.env), message, label)
            assert.deepEqual(snapshotDir(legacyDir(w)), before, label)
            assert.ok(fs.readFileSync(path.join(w.installDir, RECORD_NAME)).equals(rec), label)
            assert.equal(fs.existsSync(privateRoot(w)), false, label)
        }
        const cases: [string, (w: World) => void][] = [
            ["no registration", () => undefined],
            ["a registration without a copy", (w) => legacyRegistration(w, null)],
            ["a registration naming another copy", (w) => legacyRegistration(w, LEGACY_B)],
            ["an incomplete reference (directory only)", (w) => (legacyRegistration(w, LEGACY_A), patchRegistration(w, { backupDir: privateBackupDir(w.env, w.installDir) }))],
            ["a reference of another user's directory", (w) => (legacyRegistration(w, LEGACY_A), patchRegistration(w, { backupDir: path.join(root, "someone", "Local", "FluentReaderMCP-Data", "claude-config-backups", "x"), backupSha256: "0".repeat(64) }))],
        ]
        for (const [label, setup] of cases) {
            const w = world(personalConfig())
            await installed(w)
            legacyCopy(w, LEGACY_A)
            setup(w)
            refused(w, /claude\.json\.20261001T090000Z\.bak \(copia non indicata dal registro di installazione\).*Nessun elemento è stato modificato/, label)
        }
        const other = world(personalConfig())
        await installed(other)
        legacyCopy(other, LEGACY_A)
        legacyRegistration(other, LEGACY_A)
        const rec = record(other)
        writeRecord(path.join(other.installDir, RECORD_NAME), { ...rec, installDir: path.join(localAppData(other), "Another installation") })
        refused(other, /non è attribuibile a un'installazione registrata in questa cartella/, "record bound to another directory")
        const empty = world(personalConfig())
        await installed(empty)
        fs.mkdirSync(legacyDir(empty), { recursive: true })
        assert.deepEqual(migrateLegacyBackups(empty.installDir, empty.env), [])
        assert.equal(fs.existsSync(legacyDir(empty)), false, "an empty old directory just goes")
        assert.equal((await planAndRegister(empty)).register.code, 0)
    })

    test("the private name already taken by a different copy: neither replaced nor deleted; the same copy already there: accepted, nothing duplicated", async () => {
        const { w, a } = await legacyInstallation()
        const dir = privateBackupDir(w.env, w.installDir)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, LEGACY_A), "{\"other\":true}")
        const rec = fs.readFileSync(path.join(w.installDir, RECORD_NAME))
        assert.throws(() => migrateLegacyBackups(w.installDir, w.env), /esiste già .*con un contenuto diverso\. Nessuna delle due viene sostituita o cancellata/)
        assert.equal(fs.readFileSync(path.join(dir, LEGACY_A), "utf8"), "{\"other\":true}")
        assert.ok(fs.readFileSync(path.join(legacyDir(w), LEGACY_A)).equals(a))
        assert.ok(fs.readFileSync(path.join(w.installDir, RECORD_NAME)).equals(rec))
        fs.writeFileSync(path.join(dir, LEGACY_A), a) // the identical copy
        assert.deepEqual(migrateLegacyBackups(w.installDir, w.env), [LEGACY_A])
        assert.deepEqual(fs.readdirSync(dir), [LEGACY_A])
        assert.ok(fs.readFileSync(path.join(dir, LEGACY_A)).equals(a))
        assert.equal(fs.existsSync(legacyDir(w)), false)
        assert.equal(recordedBackup(w.installDir, record(w), w.env).status, "ok")
    })

    test("without %LOCALAPPDATA% or without a record nothing moves", async () => {
        const { w } = await legacyInstallation()
        const { LOCALAPPDATA: _l, ...without } = w.env
        assert.throws(() => migrateLegacyBackups(w.installDir, without), /non è utilizzabile/)
        fs.rmSync(path.join(w.installDir, RECORD_NAME))
        assert.throws(() => migrateLegacyBackups(w.installDir, w.env), /non è attribuibile a un'installazione registrata/)
        assert.ok(fs.existsSync(path.join(legacyDir(w), LEGACY_A)))
        assert.equal(fs.existsSync(privateRoot(w)), false)
    })

    test("interrupted moves at every step: the next attempt completes; a temporary copy left by a crash is never deleted", async () => {
        for (const step of ["after-copy", "after-publish", "after-record"] as const) {
            const { w, a } = await legacyInstallation()
            const dir = privateBackupDir(w.env, w.installDir)
            assert.throws(() => migrateLegacyBackups(w.installDir, w.env, (s) => {
                if (s === step) throw new Error(`crash at ${s}`)
            }), /crash at/, step)
            assert.ok(fs.readFileSync(path.join(legacyDir(w), LEGACY_A)).equals(a), `${step}: the original is still there`)
            const left = fs.readdirSync(dir).filter((n) => n.endsWith(".partial"))
            const leftBytes = left.map((n) => fs.readFileSync(path.join(dir, n)))
            assert.deepEqual(migrateLegacyBackups(w.installDir, w.env), [LEGACY_A], step)
            assert.ok(fs.readFileSync(path.join(dir, LEGACY_A)).equals(a), step)
            assert.equal(fs.existsSync(legacyDir(w)), false, step)
            assert.equal(recordedBackup(w.installDir, record(w), w.env).status, "ok", step)
            assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".partial")), left, `${step}: the crash's temporary copy stays as it was`)
            left.forEach((n, i) => assert.ok(fs.readFileSync(path.join(dir, n)).equals(leftBytes[i] as Buffer)))
            assert.equal(fs.readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).length, 1, `${step}: no duplicate`)
        }
    })

    test("a move recorded before the crash, then the original changed: not removed; a private copy with the name but no record of it: never adopted", async () => {
        const { w } = await legacyInstallation()
        assert.throws(() => migrateLegacyBackups(w.installDir, w.env, (s) => {
            if (s === "after-record") throw new Error("crash")
        }), /crash/)
        fs.appendFileSync(path.join(legacyDir(w), LEGACY_A), " ")
        assert.throws(() => migrateLegacyBackups(w.installDir, w.env), /claude\.json\.20261001T090000Z\.bak \(non coincide con la copia indicata dal registro di installazione\)/)
        assert.ok(fs.existsSync(path.join(legacyDir(w), LEGACY_A)))
        // an original gone and a record still naming it by file only: the private file of the same name proves nothing
        const v = await legacyInstallation()
        const dir = privateBackupDir(v.w.env, v.w.installDir)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, LEGACY_A), v.a)
        fs.rmSync(legacyDir(v.w), { recursive: true })
        const rec = fs.readFileSync(path.join(v.w.installDir, RECORD_NAME))
        assert.deepEqual(migrateLegacyBackups(v.w.installDir, v.w.env), [])
        assert.ok(fs.readFileSync(path.join(v.w.installDir, RECORD_NAME)).equals(rec), "the record is not changed")
        assert.deepEqual(recordedBackup(v.w.installDir, record(v.w), v.w.env), { status: "missing", path: path.join(legacyDir(v.w), LEGACY_A) })
        assert.ok(fs.readFileSync(path.join(dir, LEGACY_A)).equals(v.a), "and the private file is left as it is")
    })

    test("a copy changed during the move, or the private name taken while publishing: only this call's temporary copy goes, everything else stays", async () => {
        const { w } = await legacyInstallation()
        const source = path.join(legacyDir(w), LEGACY_A)
        const dir = privateBackupDir(w.env, w.installDir)
        assert.throws(() => migrateLegacyBackups(w.installDir, w.env, (s) => {
            if (s === "after-copy") fs.appendFileSync(source, " ")
        }), /è cambiata durante lo spostamento.*non viene spostata né cancellata/)
        assert.deepEqual(fs.readdirSync(dir), [], "nothing published, this call's temporary copy removed")
        assert.ok(fs.readFileSync(source, "utf8").endsWith(" "), "the old copy stays as it is now")
        const v = await legacyInstallation()
        const vdir = privateBackupDir(v.w.env, v.w.installDir)
        const rec = fs.readFileSync(path.join(v.w.installDir, RECORD_NAME))
        assert.throws(() => migrateLegacyBackups(v.w.installDir, v.w.env, (s) => {
            if (s === "after-copy") fs.writeFileSync(path.join(vdir, LEGACY_A), "{\"someone\":\"else\"}")
        }), /esiste già e non viene sostituito/)
        assert.deepEqual(fs.readdirSync(vdir), [LEGACY_A], "this call's temporary copy removed")
        assert.equal(fs.readFileSync(path.join(vdir, LEGACY_A), "utf8"), "{\"someone\":\"else\"}", "the entry found stays")
        assert.ok(fs.readFileSync(path.join(legacyDir(v.w), LEGACY_A)).equals(v.a))
        assert.ok(fs.readFileSync(path.join(v.w.installDir, RECORD_NAME)).equals(rec))
    })

    test("Codex re-review Major: a change during after-record (original, record or private copy) stops the move before the original is removed; nothing is deleted or rewritten", async () => {
        const replaced = Buffer.from(JSON.stringify({ replaced: true }))
        const cases: [string, (w: World, dir: string) => void, RegExp][] = [
            ["original replaced", (w) => fs.writeFileSync(path.join(legacyDir(w), LEGACY_A), replaced), /l'originale .*claude\.json\.20261001T090000Z\.bak non è più quello copiato/],
            ["record: another hash", (w) => patchRegistration(w, { backupSha256: "0".repeat(64) }), /il registro di installazione non indica più la copia spostata/],
            ["record: another name", (w) => patchRegistration(w, { backup: "claude.json.20261003T090000Z.bak" }), /il registro di installazione non indica più la copia spostata/],
            ["record: another directory", (w) => patchRegistration(w, { backupDir: path.join(localAppData(w), "Altrove") }), /il registro di installazione non indica più la copia spostata/],
            ["record: the copy dropped", (w) => patchRegistration(w, { backup: null, backupDir: undefined, backupSha256: undefined }), /il registro di installazione non indica più la copia spostata/],
            ["record: another installation directory", (w) => writeRecord(path.join(w.installDir, RECORD_NAME), { ...record(w), installDir: path.join(localAppData(w), "Altra installazione") }), /appartiene a un'altra cartella/],
            ["private copy changed", (_w, dir) => fs.appendFileSync(path.join(dir, LEGACY_A), " "), /la copia .*claude\.json\.20261001T090000Z\.bak non è più quella verificata/],
            ["private copy replaced by a directory", (_w, dir) => (fs.rmSync(path.join(dir, LEGACY_A)), fs.mkdirSync(path.join(dir, LEGACY_A))), /non è più quella verificata/],
        ]
        for (const [label, change, message] of cases) {
            const { w } = await legacyInstallation()
            const dir = privateBackupDir(w.env, w.installDir)
            let recordAfterChange: Buffer | null = null
            let privateAfterChange: Map<string, string> | null = null
            let sourceAfterChange: Buffer | null = null
            let result: string[] | null = null
            assert.throws(() => {
                result = migrateLegacyBackups(w.installDir, w.env, (s) => {
                    if (s !== "after-record") return
                    change(w, dir)
                    recordAfterChange = fs.readFileSync(path.join(w.installDir, RECORD_NAME))
                    privateAfterChange = snapshotDir(dir)
                    sourceAfterChange = fs.readFileSync(path.join(legacyDir(w), LEGACY_A))
                })
            }, (e: Error) => message.test(e.message) && /L'originale non viene cancellato; la copia nella cartella personale e il registro di installazione restano come sono/.test(e.message) && !e.message.includes(SECRET), label)
            assert.equal(result, null, `${label}: no completed migration is reported`)
            assert.ok(fs.readFileSync(path.join(legacyDir(w), LEGACY_A)).equals(sourceAfterChange as unknown as Buffer), `${label}: the original stays, byte for byte as it is now`)
            assert.deepEqual(snapshotDir(dir), privateAfterChange, `${label}: the private copy is not deleted or changed`)
            assert.ok(fs.readFileSync(path.join(w.installDir, RECORD_NAME)).equals(recordAfterChange as unknown as Buffer), `${label}: the record is not rewritten`)
        }
    })

    test("Codex re-review Major: after a refused removal, the next attempts change nothing until the difference is resolved; without a concurrent change the move completes", async () => {
        // the original changed during after-record, then again later: always refused by the preflight (hash of the record)
        const { w, a } = await legacyInstallation()
        const dir = privateBackupDir(w.env, w.installDir)
        assert.throws(() => migrateLegacyBackups(w.installDir, w.env, (s) => {
            if (s === "after-record") fs.appendFileSync(path.join(legacyDir(w), LEGACY_A), " ")
        }), /non è più quello copiato/)
        for (let i = 0; i < 2; i++) {
            const before = snapshotDir(legacyDir(w))
            const rec = fs.readFileSync(path.join(w.installDir, RECORD_NAME))
            assert.throws(() => migrateLegacyBackups(w.installDir, w.env), /non coincide con la copia indicata dal registro di installazione/)
            assert.deepEqual(snapshotDir(legacyDir(w)), before)
            assert.ok(fs.readFileSync(path.join(w.installDir, RECORD_NAME)).equals(rec))
            assert.ok(fs.readFileSync(path.join(dir, LEGACY_A)).equals(a), "the private copy stays available")
            fs.appendFileSync(path.join(legacyDir(w), LEGACY_A), "x") // changed again after the refusal
        }
        assert.equal(recordedBackup(w.installDir, record(w), w.env).status, "ok")
        // the private copy changed during after-record: the next attempt finds it different and replaces nothing
        const v = await legacyInstallation()
        const vdir = privateBackupDir(v.w.env, v.w.installDir)
        assert.throws(() => migrateLegacyBackups(v.w.installDir, v.w.env, (s) => {
            if (s === "after-record") fs.appendFileSync(path.join(vdir, LEGACY_A), " ")
        }), /non è più quella verificata/)
        assert.throws(() => migrateLegacyBackups(v.w.installDir, v.w.env), /esiste già .*con un contenuto diverso/)
        assert.ok(fs.readFileSync(path.join(legacyDir(v.w), LEGACY_A)).equals(v.a))
        assert.equal(recordedBackup(v.w.installDir, record(v.w), v.w.env).status, "altered")
        // a crash after the record and before the removal, nothing changed: the next attempt revalidates and completes
        const c = await legacyInstallation()
        assert.throws(() => migrateLegacyBackups(c.w.installDir, c.w.env, (s) => {
            if (s === "after-record") throw new Error("crash")
        }), /crash/)
        assert.equal(recordedBackup(c.w.installDir, record(c.w), c.w.env).status, "ok", "a valid private record with the original still there")
        assert.deepEqual(migrateLegacyBackups(c.w.installDir, c.w.env), [LEGACY_A])
        assert.equal(fs.existsSync(legacyDir(c.w)), false)
        assert.ok(fs.readFileSync(path.join(privateBackupDir(c.w.env, c.w.installDir), LEGACY_A)).equals(c.a))
        assert.deepEqual(migrateLegacyBackups(c.w.installDir, c.w.env), [], "repeated: nothing to do")
    })

    test("Codex re-review Minor: the message on elements that are not attributable names paths and reasons only, warns that they may be confidential, and points to a safe personal folder", async () => {
        const { w } = await legacyInstallation()
        legacyCopy(w, LEGACY_B, `{"token":"${SECRET}"}`)
        let message = ""
        assert.throws(() => migrateLegacyBackups(w.installDir, w.env), (e: Error) => ((message = e.message), true))
        assert.ok(message.includes(`${path.join(legacyDir(w), LEGACY_B)} (copia non indicata dal registro di installazione)`), message)
        for (const fact of ["possono contenere informazioni riservate", "Non cancellarli senza averli controllati", "cartella personale sicura del tuo account Windows", "non in una cartella condivisa con altri utenti", "puoi ripetere l'aggiornamento o la riparazione"]) assert.ok(message.includes(fact), fact)
        assert.doesNotMatch(message, /spostali fuori dalla cartella di installazione|cancella (la cartella )?state/)
        assert.equal(message.includes(SECRET), false)
        assert.equal(message.includes("{"), false, "no content")
    })

    test("Codex Minor 1: temporary copies of other runs, or of unknown origin, are never deleted by a backup or a move", async () => {
        const { w, a } = await legacyInstallation()
        const dir = privateBackupDir(w.env, w.installDir)
        fs.mkdirSync(dir, { recursive: true })
        const foreign = [".claude.json.0123456789abcdef.partial", `.${LEGACY_A}.fedcba9876543210.partial`, "notes.partial"]
        for (const name of foreign) fs.writeFileSync(path.join(dir, name), `not ours ${name}`)
        const desktopDir = privateDesktopBackupDir(w.env, w.installDir)
        const desktopForeign = ".claude_desktop_config.json.0123456789abcdef.partial"
        fs.mkdirSync(desktopDir, { recursive: true })
        fs.writeFileSync(path.join(desktopDir, desktopForeign), "not ours")
        assert.deepEqual(migrateLegacyBackups(w.installDir, w.env), [LEGACY_A])
        const { register } = await planAndRegister(w)
        assert.equal(register.code, 0, register.one("message"))
        for (const name of foreign) assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), `not ours ${name}`, name)
        assert.ok(fs.readFileSync(path.join(dir, LEGACY_A)).equals(a))
        assert.equal(fs.readdirSync(dir).length, foreign.length + 1, "no temporary copy of this run left")
        assert.equal(fs.readFileSync(path.join(desktopDir, desktopForeign), "utf8"), "not ours")
        assert.equal(fs.readdirSync(desktopDir).filter((n) => DESKTOP_BACKUP_NAME.test(n)).length, 1)
        assert.equal(fs.readdirSync(desktopDir).length, 2, "no temporary copy of this run left")
    })

    test("Codex Minor 2: only the two complete forms of a backup reference are accepted; every other combination is never ok and moves nothing; the record stays readable", async () => {
        const { w } = await legacyInstallation()
        migrateLegacyBackups(w.installDir, w.env)
        const dir = privateBackupDir(w.env, w.installDir)
        const name = LEGACY_A
        const genuine = record(w).claude as NonNullable<InstallRecord["claude"]>
        const sha = genuine.backupSha256 as string
        const cases: [string, Record<string, unknown>, string][] = [
            ["new form, genuine", {}, "ok"],
            ["new form, hash of another content", { backupSha256: "0".repeat(64) }, "altered"],
            ["directory only", { backupSha256: undefined }, "invalid"],
            ["hash only", { backupDir: undefined }, "invalid"],
            ["malformed hash", { backupSha256: "ABC" }, "invalid"],
            ["upper-case hash", { backupSha256: sha.toUpperCase() }, "invalid"],
            ["relative directory", { backupDir: "AppData\\Local\\x" }, "invalid"],
            ["name of another kind", { backup: "notes.txt" }, "invalid"],
            ["name escaping the directory", { backup: "..\\..\\claude.json.20261001T090000Z.bak" }, "invalid"],
            ["no copy, with the other fields", { backup: null }, "invalid"],
            ["no copy at all", { backup: null, backupDir: undefined, backupSha256: undefined }, "none"],
            ["legacy form, file absent", { backupDir: undefined, backupSha256: undefined }, "missing"],
        ]
        for (const [label, patch, expected] of cases) {
            writeRecord(path.join(w.installDir, RECORD_NAME), { ...record(w), claude: genuine })
            patchRegistration(w, patch)
            const rec = readRecord(path.join(w.installDir, RECORD_NAME)) as InstallRecord
            const found = recordedBackup(w.installDir, rec, w.env)
            assert.equal(found.status, expected, label)
            if (expected === "invalid") assert.ok(typeof found.reason === "string" && found.reason.length > 0, `${label}: a diagnosable reason`)
            if (expected === "ok") assert.equal(found.path, path.join(dir, name as string))
        }
        // legacy form with the file in place: legacy; an invalid reference never authorises a move
        writeRecord(path.join(w.installDir, RECORD_NAME), { ...record(w), claude: genuine })
        legacyCopy(w, LEGACY_A)
        patchRegistration(w, { backup: LEGACY_A, backupDir: undefined, backupSha256: undefined })
        assert.equal(recordedBackup(w.installDir, record(w), w.env).status, "legacy")
        patchRegistration(w, { backupDir: dir })
        const snap = snapshotDir(legacyDir(w))
        const privateSnap = snapshotDir(dir)
        assert.throws(() => migrateLegacyBackups(w.installDir, w.env), /copia non indicata dal registro di installazione/)
        assert.deepEqual(snapshotDir(legacyDir(w)), snap)
        assert.deepEqual(snapshotDir(dir), privateSnap)
        const plan = await call(w, "desktop-plan", planRequest(w))
        assert.equal(plan.code, 0, "the record stays readable")
    })

    test("uninstall status: this installation's private copies are reported and kept; repeated, the same; without the record they are found again", async () => {
        const w = world(personalConfig())
        await installed(w)
        assert.equal((await planAndRegister(w)).register.code, 0)
        const dir = privateDesktopBackupDir(w.env, w.installDir)
        const snap = snapshotDir(dir)
        const first = await call(w, "un-status", { installDir: w.installDir })
        assert.equal(first.code, 0, first.one("message"))
        assert.ok(first.one("backups").includes(`restano nella tua cartella personale ${dir}`), first.one("backups"))
        assert.equal((await call(w, "un-status", { installDir: w.installDir })).one("backups"), first.one("backups"))
        assert.equal((await call(w, "desktop-unregister", { installDir: w.installDir })).one("outcome"), "removed")
        fs.rmSync(path.join(w.installDir, RECORD_NAME))
        assert.ok((await call(w, "un-status", { installDir: w.installDir })).one("backups").includes(dir), "found again without the record (derived, not stored)")
        assert.deepEqual(snapshotDir(dir), snap, "nothing deleted")
        const n = world()
        await installed(n)
        assert.equal((await call(n, "un-status", { installDir: n.installDir })).one("backups"), "", "no copy, nothing to say")
    })

    test("an interrupted registration: the next page finds its copy again; missing, altered, recorded elsewhere or invalid references are reported, nothing searched or touched", async () => {
        const w = world(personalConfig())
        await installed(w)
        assert.equal((await planAndRegister(w)).register.code, 0)
        const dir = privateDesktopBackupDir(w.env, w.installDir)
        const [name] = backups(w)
        const file = path.join(dir, name as string)
        const crashed = (patch: Record<string, unknown> = {}): void => {
            const rec = record(w)
            writeRecord(path.join(w.installDir, RECORD_NAME), { ...rec, desktop: { ...(rec.desktop as DesktopRegistration), state: "pending", ...patch } })
        }
        const preview = async (): Promise<string> => {
            const r = await call(w, "desktop-plan", planRequest(w))
            assert.equal(r.code, 0, r.one("message"))
            assert.equal(r.text.includes(SECRET), false)
            return r.one("preview")
        }
        crashed()
        assert.ok((await preview()).includes(`Una registrazione precedente non si è conclusa. La copia della configurazione presa prima della modifica è in ${file}.`))
        fs.appendFileSync(file, " ")
        assert.match(await preview(), /non è più quella salvata: non è affidabile per un ripristino/)
        assert.equal(recordedDesktopBackup(w.installDir, record(w), w.env).status, "altered")
        fs.renameSync(file, `${file}.moved`)
        assert.match(await preview(), /non è stata trovata/)
        const otherRoot = path.join(root, `other account ${counter}`)
        const other = path.join(otherRoot, "AppData", "Local", "FluentReaderMCP-Data", "desktop-config-backups", path.basename(dir))
        crashed({ backupDir: other })
        assert.ok((await preview()).includes(`è stata salvata in ${path.join(other, name as string)}, che non è la cartella personale dell'utente Windows attuale`))
        assert.equal(fs.existsSync(otherRoot), false, "never searched or created")
        crashed({ backup: "..\\..\\x.bak", backupDir: dir })
        assert.equal(recordedDesktopBackup(w.installDir, record(w), w.env).status, "invalid")
        assert.match(await preview(), /riferimento alla copia .* non è utilizzabile/)
    })
})

describe("FR-MCP-04-BETA-03A-SIMPLE-02: installation on another drive and another Windows account", { skip: AWAY_SKIP }, () => {
    test("installation directory on another (synthetic) drive: the copy is in the user's profile; old copies are moved through the private directory only", async () => {
        const { w, volume } = away(personalConfig())
        const v: World = { ...w, installDir: path.join(volume, "Programmi", "Fluent Reader MCP") }
        await installed(v)
        const old = fs.readFileSync(legacyCopy(v, LEGACY_A))
        legacyRegistration(v, LEGACY_A)
        const dir = privateBackupDir(v.env, v.installDir)
        assert.ok(dir.toLowerCase().startsWith(`${v.home.toLowerCase()}\\`), dir)
        assert.throws(() => migrateLegacyBackups(v.installDir, v.env, (s) => {
            if (s !== "after-copy") return
            // the temporary copy is in the private directory, never next to the old one
            assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".partial")).length, 1)
            assert.deepEqual(fs.readdirSync(legacyDir(v)), [LEGACY_A])
            throw new Error("crash")
        }), /crash/)
        assert.deepEqual(migrateLegacyBackups(v.installDir, v.env), [LEGACY_A])
        assert.ok(fs.readFileSync(path.join(dir, LEGACY_A)).equals(old))
        const { register } = await planAndRegister(v)
        assert.equal(register.code, 0, register.one("message"))
        assert.equal(backups(v).filter((n) => DESKTOP_BACKUP_NAME.test(n)).length, 1)
        assert.ok(privateBackupDir(v.env, v.installDir).toLowerCase().startsWith(`${v.home.toLowerCase()}\\`))
        assert.ok(fs.readdirSync(dir).some((n) => n.endsWith(".partial")), "the temporary copy left by the crash is not deleted")
        assert.deepEqual(secretFilesUnder(volume), [], "nothing sensitive on the other drive")
    })

    test("the old directory is a junction: not followed", async () => {
        const { w, volume } = away(personalConfig())
        const v: World = { ...w, installDir: path.join(volume, "FR junction") }
        await installed(v)
        const target = path.join(volume, "target")
        fs.mkdirSync(target)
        fs.writeFileSync(path.join(target, LEGACY_A), "{}")
        fs.mkdirSync(path.join(v.installDir, "state"))
        fs.symlinkSync(target, legacyDir(v), "junction")
        assert.throws(() => migrateLegacyBackups(v.installDir, v.env), /non è una cartella normale.*non viene seguita né modificata/)
        assert.deepEqual(fs.readdirSync(target), [LEGACY_A])
    })

    test("uninstall status under another Windows account: the recorded copy is reported, never searched, nothing created in either profile", async () => {
        const { w, volume, machine } = away(personalConfig())
        const v: World = { ...w, installDir: path.join(volume, "Condivisa") }
        await installed(v)
        assert.equal((await planAndRegister(v)).register.code, 0)
        const dir = privateDesktopBackupDir(v.env, v.installDir)
        const snap = snapshotDir(dir)
        const otherHome = path.join(machine, "Users", "altro")
        fs.mkdirSync(path.join(otherHome, "AppData", "Local"), { recursive: true })
        const env = { USERPROFILE: otherHome, APPDATA: path.join(otherHome, "AppData", "Roaming"), LOCALAPPDATA: path.join(otherHome, "AppData", "Local"), PATH: "" }
        const r = await call(v, "un-status", { installDir: v.installDir }, { ...deps(v), env })
        assert.equal(r.code, 0, r.one("message"))
        assert.ok(r.one("backups").includes(`è stata salvata in ${dir}\\`) && r.one("backups").includes("non è la cartella personale dell'utente Windows attuale"), r.one("backups"))
        assert.deepEqual(fs.readdirSync(path.join(otherHome, "AppData", "Local")), [], "nothing searched or created for the other account")
        assert.deepEqual(snapshotDir(dir), snap)
    })
})
