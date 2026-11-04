/**
 * FR-MCP-04-BETA-02: executable model of the installation and uninstallation
 * lifecycle. Drivers call the REAL helper commands (main(), real files in a
 * synthetic user directory) in exactly the order the NSIS script calls them
 * (nsis-script.test.ts compares the two sequences), and a fake HKCU applies
 * the same rules as the NSIS registry macros. A crash is a driver that stops
 * after a step, or a helper step that throws at a named checkpoint; the next
 * start is the same driver run again. What these tests cannot reach is the
 * NSIS side itself (WriteUninstaller, the advapi32 calls, CopyFiles): see
 * INSTALLER.md.
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { helperCopyNsh, SETUP_ENTRY, setupClosure } from "../../installer/lib/installer-build.js"
import { buildManifest, MANIFEST } from "../../installer/lib/package-content.js"
import { parseRuntimeLock } from "../../installer/lib/runtime-lock.js"
import { buildInventory, INVENTORY, readInventory } from "../../installer/setup/app.js"
import { checkInstallDir } from "../../installer/setup/checks.js"
import { main, type HelperDeps } from "../../installer/setup/fr-setup.js"
import { decodeResult } from "../../installer/setup/protocol.js"
import { privateBackupDir, privateDesktopBackupDir } from "../../installer/setup/backups.js"
import { canonicalJson, entryFingerprint, RECORD_NAME, readRecord, writeRecord, type InstallRecord } from "../../installer/setup/record.js"
import { REGISTRY_SLOTS, rename, SETUP_SCRIPT, type TxCheckpoint } from "../../installer/setup/transaction.js"
import { encodeFinalMarker, helperCopyEntries, type UninstallCheckpoint } from "../../installer/setup/uninstall.js"
import { buildSmokeProfile } from "../e2e/smoke-fixture.js"
import { createTempRoot, removeTempRoot, snapshotDir } from "../helpers/fixtures.js"
import { parseMacros, runNsis, sectionLines, type NsisRun } from "../helpers/nsis-model.js"

const COMPILED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const lockRaw = JSON.parse(fs.readFileSync(path.join(COMPILED_ROOT, "..", "installer", "runtime-lock.json"), "utf8")) as unknown

let root: string
let counter = 0
before(() => {
    root = fs.realpathSync.native(createTempRoot())
})
after(() => removeTempRoot(root))

/** The helper commands the NSIS install section calls, in order (rollback: tx-recover, tx-recover-finish). */
const INSTALL_COMMANDS = ["tx-recover", "tx-recover-finish", "tx-begin", "verify-tree", "tx-prepare", "tx-swap", "tx-metadata", "tx-commit", "tx-cleanup", "desktop-register"]
/** The helper commands the NSIS uninstall section calls, in order. */
const UNINSTALL_COMMANDS = ["un-status", "uninstall-preflight", "desktop-unregister", "un-begin", "remove-tree", "un-metadata", "un-finish"]

const UNINSTALL_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FluentReaderMCP"
const SETTINGS_KEY = "Software\\FluentReaderMCP"
const KEYS = { uninstall: UNINSTALL_KEY, settings: SETTINGS_KEY } as const

class Crash extends Error {}

/** HKCU as the NSIS macros see it: values with a type; keys that may exist empty. */
class FakeRegistry {
    readonly keys = new Map<string, Map<string, { type: string; value: string }>>()
    /** Write or delete operations that fail (simulated), by value name. */
    failing = new Set<string>()

    valueType(key: string, name: string): string {
        return this.keys.get(key)?.get(name)?.type ?? "absent"
    }

    /** RegBackupPut × 9 and RegKeyExists × 2: the tx-prepare request fields. */
    backup(): Record<string, string> {
        const fields: Record<string, string> = {}
        for (const slot of REGISTRY_SLOTS) {
            const v = this.keys.get(KEYS[slot.key])?.get(slot.name)
            fields[`reg${slot.id}.present`] = v === undefined ? "0" : "1"
            if (v !== undefined) {
                // as RegBackupPut: a string with CR or LF is reported as MULTILINE, its value never sent
                const multiline = (v.type === "REG_SZ" || v.type === "REG_EXPAND_SZ") && /[\r\n]/.test(v.value)
                fields[`reg${slot.id}.type`] = multiline ? "MULTILINE" : v.type
                fields[`reg${slot.id}.value`] = !multiline && ["REG_SZ", "REG_EXPAND_SZ", "REG_DWORD"].includes(v.type) ? v.value : ""
            }
        }
        fields["key.uninstall"] = this.keys.has(UNINSTALL_KEY) ? "1" : "0"
        fields["key.settings"] = this.keys.has(SETTINGS_KEY) ? "1" : "0"
        return fields
    }

    write(key: string, name: string, type: string, value: string): void {
        if (this.failing.has(name)) throw new Error(`write ${name} failed`)
        if (!this.keys.has(key)) this.keys.set(key, new Map())
        this.keys.get(key)?.set(name, { type, value })
    }

    delete(key: string, name: string): void {
        if (this.failing.has(name)) throw new Error(`delete ${name} failed`)
        this.keys.get(key)?.delete(name)
    }

    /** Keys whose removal fails (simulated access error). */
    failingKeys = new Set<string>()

    /** RegDeleteKeyIfEmpty: absent, deleted, kept (something of others is in it) or error. */
    deleteIfEmpty(key: string): "absent" | "deleted" | "kept" | "error" {
        const values = this.keys.get(key)
        if (values === undefined) return "absent"
        if (values.size > 0) return "kept"
        if (this.failingKeys.has(key)) return "error"
        this.keys.delete(key)
        return "deleted"
    }

    /** RegApplyRestore × 9 and RegKeyApplyRestore × 2, from a tx-recover result; returns $RestoreOk. */
    applyRestore(fields: Map<string, string[]>): boolean {
        const one = (k: string): string => (fields.get(k) ?? []).join("\n")
        let ok = true
        for (const slot of REGISTRY_SLOTS) {
            const action = one(`reg${slot.id}.action`)
            try {
                if (action === "write") this.write(KEYS[slot.key], slot.name, one(`reg${slot.id}.type`), one(`reg${slot.id}.value`))
                else if (action === "delete") { if (this.valueType(KEYS[slot.key], slot.name) !== "absent") this.delete(KEYS[slot.key], slot.name) }
                else ok = false
            } catch {
                ok = false
            }
        }
        if (one("key.uninstall.deleteIfEmpty") === "yes" && this.deleteIfEmpty(UNINSTALL_KEY) === "error") ok = false
        if (one("key.settings.deleteIfEmpty") === "yes" && this.deleteIfEmpty(SETTINGS_KEY) === "error") ok = false
        return ok
    }

    snapshot(): string {
        return JSON.stringify([...this.keys].map(([k, v]) => [k, [...v].sort()]).sort())
    }
}

interface World {
    readonly home: string
    readonly env: NodeJS.ProcessEnv
    readonly installDir: string
    readonly profile: string
    readonly reg: FakeRegistry
    txCheckpoint?: ((step: TxCheckpoint) => void) | undefined
    uninstallCheckpoint?: ((step: UninstallCheckpoint) => void) | undefined
    unlink?: ((file: string) => void) | undefined
    rmdir?: ((dir: string) => void) | undefined
    /** The rename primitive of the transaction (fs.renameSync unless a test injects a failure or counts the calls). */
    rename?: ((from: string, to: string) => void) | undefined
    lastRun?: NsisRun
    commands: string[]
    lastMessage?: string
    /** Every refusal message of the run, in order (a rollback's message replaces lastMessage). */
    refusals?: string[]
    /** The mode confirmed in the wizard: sent to tx-begin as expectMode, as the NSIS script does. */
    confirmedMode?: string
    /** The version of the setup that runs (its payload is the helper's payloadRoot); the last one started in this world. */
    setupVersion?: string
    /** Test hook: another directory as the running helper's root (a payload that does not describe the running code). */
    payloadRoot?: string | undefined
}

function world(homeDir?: string): World {
    counter++
    const home = homeDir ?? path.join(root, `user ${counter} é`)
    fs.mkdirSync(path.join(home, "AppData", "Roaming"), { recursive: true })
    fs.mkdirSync(path.join(home, "AppData", "Local"), { recursive: true })
    const profile = buildSmokeProfile(path.join(home, "Profili", "profilo è")).dir
    return { home, env: { USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local") }, installDir: path.join(home, "AppData", "Local", "Fluent Reader MCP é"), profile, reg: new FakeRegistry(), commands: [] }
}

/** A synthetic payload (package + the REAL compiled helper + inventory) for a version, built once. */
const payloads = new Map<string, string>()
function payload(version: string): string {
    const existing = payloads.get(version)
    if (existing !== undefined) return existing
    const dir = path.join(root, `payload ${version}`)
    const app = path.join(dir, "app")
    const files: Record<string, string> = {
        "runtime/node.exe": "synthetic node", "runtime/LICENSE": "node licence", "server/dist/main.js": `// server ${version}`, "server/package.json": "{}",
        "server/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node": "native", "PACKAGING-INFO.md": "info", "licenses/node/LICENSE": "licence",
    }
    for (const [f, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true })
        fs.writeFileSync(path.join(app, f), content)
    }
    const manifest = buildManifest(app, { version, gitCommit: "c".repeat(40), gitDirty: false, sourceDateEpoch: 1767225600, lock: parseRuntimeLock(lockRaw, ">=24.15.0 <25"), projectLicense: null, licenses: [] })
    fs.writeFileSync(path.join(app, MANIFEST), JSON.stringify(manifest))
    for (const relative of setupClosure(COMPILED_ROOT)) {
        fs.mkdirSync(path.dirname(path.join(dir, "setup", relative)), { recursive: true })
        fs.copyFileSync(path.join(COMPILED_ROOT, relative), path.join(dir, "setup", relative))
    }
    fs.writeFileSync(path.join(dir, "setup", "package.json"), JSON.stringify({ type: "module" }))
    fs.writeFileSync(path.join(dir, INVENTORY), JSON.stringify(buildInventory(dir, version)))
    payloads.set(version, dir)
    return dir
}

/** Every program the helper tried to start (none is expected in this model: no claude.exe, no permission tool). */
const execCalls: string[][] = []

function deps(w: World): HelperDeps {
    return {
        env: w.env, exec: (file, args) => (execCalls.push([file, ...args]), { status: 1, stdout: "", stderr: "no program in this model" }), selfTest: async () => [], now: () => new Date("2026-10-28T10:00:00Z"),
        txCheckpoint: (s) => w.txCheckpoint?.(s), uninstallCheckpoint: (s) => w.uninstallCheckpoint?.(s), unlink: (f) => (w.unlink ?? fs.unlinkSync)(f), rmdir: (d) => (w.rmdir ?? fs.rmdirSync)(d), rename: (f, t) => (w.rename ?? fs.renameSync)(f, t),
        // as $PLUGINSDIR\helper: the payload of the setup that runs, with its installer-files.json next to setup\
        payloadRoot: w.payloadRoot ?? payload(w.setupVersion ?? "0.1.0"),
    }
}

async function call(w: World, command: string, request: Record<string, string>): Promise<{ code: number; fields: Map<string, string[]>; one(k: string): string }> {
    w.commands.push(command)
    counter++
    const dir = path.join(root, `io ${counter}`)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, "request.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(Object.entries(request).map(([k, v]) => `${k}=${v}\r\n`).join(""), "utf16le")]))
    const code = await main([command, path.join(dir, "request.txt"), path.join(dir, "result.txt")], deps(w))
    const fields = decodeResult(fs.readFileSync(path.join(dir, "result.txt")))
    if (code !== 0) {
        w.lastMessage = (fields.get("message") ?? []).join("\n")
        w.refusals = [...(w.refusals ?? []), w.lastMessage]
    }
    return { code, fields, one: (k) => (fields.get(k) ?? []).join("\n") }
}

/** Where a run stops: a crash (process gone, nothing else runs) or a failure (the script goes to its rollback). */
type Stop =
    | { at: "after-prepare"; mode: "crash" | "fail" }
    | { at: TxCheckpoint; mode: "crash" | "fail" }
    | { at: "registry-partial"; mode: "crash" | "fail" }
    | { at: "after-commit"; mode: "crash" }

type Outcome = "installed" | "crashed" | "rolled-back" | "rollback-incomplete" | "recovery-failed" | "refused"

/**
 * TxRecover: the recovery at the start (no session: $TxId is still empty), and the rollback after a failure
 * in the same run (the transaction id NSIS holds). The payload is the setup's own: version `payloadVersion`.
 */
async function txRecover(w: World, session = "", payloadVersion?: string): Promise<boolean> {
    if (payloadVersion !== undefined) w.setupVersion = payloadVersion
    // payloadInventory is sent as NSIS sends it; the helper never uses it
    const base = { installDir: w.installDir, payloadInventory: path.join(payload(w.setupVersion ?? "0.1.0"), INVENTORY), sessionTransactionId: session }
    const r = await call(w, "tx-recover", base)
    if (r.code !== 0) return false
    if (r.one("outcome") !== "registry-restore") return true
    const ok = w.reg.applyRestore(r.fields)
    const f = await call(w, "tx-recover-finish", { ...base, registryRestored: ok ? "yes" : "no" })
    return f.code === 0
}

/** The NSIS install section, step by step. */
async function install(w: World, version: string, stop?: Stop): Promise<Outcome> {
    w.txCheckpoint = undefined
    w.setupVersion = version
    let session = "" // $TxId: empty until tx-begin answers
    const crashOrRollback = async (mode: "crash" | "fail"): Promise<Outcome> => (mode === "crash" ? "crashed" : (await txRecover(w, session, version)) ? "rolled-back" : "rollback-incomplete")
    // DirectoryLeave: the mode shown and confirmed (the wizard stops there if the directory is refused)
    let expectMode = w.confirmedMode
    if (expectMode === undefined) {
        try {
            expectMode = checkInstallDir({ installDir: w.installDir, version, maxRelative: 150, env: w.env }).mode
        } catch (error) {
            w.lastMessage = (error as Error).message
            return "refused"
        }
    }
    fs.mkdirSync(w.installDir, { recursive: true }) // CreateDirectory "$INSTDIR"
    if (!(await txRecover(w, "", version))) return "recovery-failed"
    const begin = await call(w, "tx-begin", { installDir: w.installDir, version, maxRelative: "150", bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode })
    if (begin.code !== 0) return "refused"
    const tx = { installDir: w.installDir, transactionId: begin.one("transactionId") }
    session = tx.transactionId
    // File "installer-files.json" first, then File /r
    const staging = path.join(w.installDir, ".staging")
    fs.mkdirSync(staging)
    fs.copyFileSync(path.join(payload(version), INVENTORY), path.join(staging, INVENTORY))
    fs.cpSync(payload(version), staging, { recursive: true, force: true })
    w.commands.push("verify-tree")
    fs.writeFileSync(path.join(w.installDir, "state", "uninstall.exe.new"), `uninstaller ${version}`)
    const prepare = await call(w, "tx-prepare", { ...tx, ...w.reg.backup() })
    if (prepare.code !== 0) return crashOrRollback("fail").then((o) => (o === "rolled-back" ? "refused" : o))
    if (stop?.at === "after-prepare") return crashOrRollback(stop.mode)
    w.txCheckpoint = (s) => {
        if (stop !== undefined && s === stop.at) throw new Crash(`stopped at ${s}`)
    }
    if ((await call(w, "tx-swap", tx)).code !== 0) return crashOrRollback(stop?.mode === "crash" ? "crash" : "fail")
    if ((await call(w, "tx-metadata", tx)).code !== 0) return crashOrRollback(stop?.mode === "crash" ? "crash" : "fail")
    w.txCheckpoint = undefined
    const values: [string, string, string][] = [["DisplayName", "REG_SZ", "Fluent Reader MCP (beta)"], ["DisplayVersion", "REG_SZ", version], ["Publisher", "REG_SZ", "Fluent Reader MCP - beta privata"], ["InstallLocation", "REG_SZ", w.installDir], ["UninstallString", "REG_SZ", `"${w.installDir}\\uninstall.exe"`], ["NoModify", "REG_DWORD", "1"], ["NoRepair", "REG_DWORD", "1"], ["EstimatedSize", "REG_DWORD", "42"], ["InstallDir", "REG_SZ", w.installDir]]
    for (const [i, [name, type, value]] of values.entries()) {
        if (stop?.at === "registry-partial" && i === 4) return crashOrRollback(stop.mode)
        try {
            w.reg.write(name === "InstallDir" ? SETTINGS_KEY : UNINSTALL_KEY, name, type, value)
        } catch {
            return crashOrRollback("fail")
        }
    }
    if ((await call(w, "tx-commit", { ...tx, registryWritten: "yes" })).code !== 0) return crashOrRollback("fail")
    if (stop?.at === "after-commit") return "crashed"
    await call(w, "tx-cleanup", tx)
    return "installed"
}

interface Snapshot {
    readonly version: string | null
    readonly record: string | null
    readonly uninstaller: string | null
    readonly registry: string
    readonly dirs: string[]
    readonly state: string[]
}

function snapshot(w: World): Snapshot {
    const current = path.join(w.installDir, "current")
    const read = (f: string): string | null => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null)
    const state = path.join(w.installDir, "state")
    return {
        version: fs.existsSync(path.join(current, INVENTORY)) ? readInventory(current).version : null,
        record: read(path.join(w.installDir, RECORD_NAME)),
        uninstaller: read(path.join(w.installDir, "uninstall.exe")),
        registry: w.reg.snapshot(),
        dirs: fs.existsSync(w.installDir) ? fs.readdirSync(w.installDir).filter((n) => ["current", "previous", ".staging"].includes(n)).sort() : [],
        state: fs.existsSync(state) ? fs.readdirSync(state).sort() : [],
    }
}

/** The transaction id of the journal left in the directory (what NSIS holds in memory during the same run). */
function journalTxId(w: World): string {
    return (JSON.parse(fs.readFileSync(path.join(w.installDir, "state", "install-journal.json"), "utf8")) as { transactionId: string }).transactionId
}

/**
 * What the user does after a rollback that stopped, as its message asks: checks the elements it names and
 * removes those the interrupted installation created and nothing independent attributes (the new
 * uninstaller, the new record). Returns what was removed.
 */
function removeNamedByHand(w: World): string[] {
    const message = w.lastMessage ?? ""
    const removed: string[] = []
    for (const [pattern, relative] of [
        [/state\\uninstall\.exe\.new \(nuovo disinstallatore/, path.join("state", "uninstall.exe.new")],
        [/(^|[:;] )uninstall\.exe \(nuovo disinstallatore/, "uninstall.exe"],
        [/fluent-reader-mcp\.install\.json \(registro scritto da questa transazione/, RECORD_NAME],
    ] as const) {
        if (pattern.test(message) && fs.existsSync(path.join(w.installDir, relative))) {
            fs.rmSync(path.join(w.installDir, relative))
            removed.push(relative)
        }
    }
    return removed
}

/** A rollback that stopped before any change (lastMessage), then what it named removed by hand, then the next start. */
async function finishByHand(w: World, session = ""): Promise<boolean> {
    assert.match(w.lastMessage ?? "", /ripristino automatico non è possibile: questi elementi non sono attribuibili/)
    assert.ok(removeNamedByHand(w).length > 0, "it named the transaction's own new files")
    return txRecover(w, session)
}

function journalPhase(w: World): string | null {
    const file = path.join(w.installDir, "state", "install-journal.json")
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { phase: string }).phase : null
}

/** An installed 0.1.0 with a foreign value in the product's uninstall key. */
async function installedV1(): Promise<{ w: World; before: Snapshot }> {
    const w = world()
    w.reg.write(UNINSTALL_KEY, "SomeoneElse", "REG_SZ", "foreign value")
    assert.equal(await install(w, "0.1.0"), "installed")
    return { w, before: snapshot(w) }
}

describe("installation transaction: crash at each point, then the next start (Major 1)", { timeout: 120_000 }, () => {
    const points: [Stop, string, "previous" | "new"][] = [
        [{ at: "after-prepare", mode: "crash" }, "prepared", "previous"],
        [{ at: "after-first-rename", mode: "crash" }, "swapping", "previous"],
        [{ at: "after-second-rename", mode: "crash" }, "swapping", "previous"],
        [{ at: "after-record", mode: "crash" }, "metadata", "previous"],
        [{ at: "after-uninstaller", mode: "crash" }, "metadata", "previous"],
        [{ at: "registry-partial", mode: "crash" }, "metadata", "previous"],
        [{ at: "after-commit", mode: "crash" }, "committed", "new"],
    ]
    for (const [stop, phase, expected] of points) {
        test(`upgrade 0.1.0 → 0.2.0 interrupted ${stop.at}: journal "${phase}" persisted; the next start ${expected === "previous" ? "restores 0.1.0 exactly" : "only completes the cleanup of 0.2.0"}`, async () => {
            const { w, before } = await installedV1()
            assert.equal(await install(w, "0.2.0", stop), "crashed")
            // the persistent state the next start finds
            assert.equal(journalPhase(w), phase)
            if (phase !== "committed") {
                const kept = fs.existsSync(path.join(w.installDir, "previous", INVENTORY)) ? readInventory(path.join(w.installDir, "previous")).version : snapshot(w).version
                assert.equal(kept, "0.1.0", "the previous version is still on disk")
            }
            // the next start: before the commit the new uninstaller (and the new record, once written) have no
            // independent reference, so the rollback stops before any change and names them; removed by hand, it completes
            if (phase === "committed") assert.equal(await txRecover(w), true)
            else {
                const stuck = snapshotDir(w.installDir)
                const registry = w.reg.snapshot()
                assert.equal(await txRecover(w), false)
                assert.deepEqual(snapshotDir(w.installDir), stuck, "nothing removed, replaced or moved")
                assert.equal(w.reg.snapshot(), registry, "HKCU untouched")
                assert.equal(await finishByHand(w), true)
            }
            const after = snapshot(w)
            if (expected === "previous") {
                assert.deepEqual(after, before, "current, record, uninstaller, HKCU and state exactly as before the upgrade")
            } else {
                assert.equal(after.version, "0.2.0")
                assert.match(after.record ?? "", /"version": "0\.2\.0"/)
                assert.equal(after.uninstaller, "uninstaller 0.2.0")
                assert.deepEqual(after.dirs, ["current"])
                assert.deepEqual(after.state, [], "previous, copies and journal removed only now")
            }
            assert.equal(journalPhase(w), null)
            // and the upgrade can then be run again to the end
            assert.equal(await install(w, "0.2.0"), "installed")
            assert.equal(snapshot(w).version, "0.2.0")
            assert.equal(w.reg.valueType(UNINSTALL_KEY, "SomeoneElse"), "REG_SZ", "a foreign value is never touched")
        })
    }

    test("a failure (not a crash) after the swap: the script's rollback is the same recovery; it stops at the new uninstaller and record (nothing declared installed); removed by hand, 0.1.0 is back exactly", async () => {
        const { w, before } = await installedV1()
        assert.equal(await install(w, "0.2.0", { at: "after-uninstaller", mode: "fail" }), "rollback-incomplete")
        assert.equal(snapshot(w).version, "0.2.0", "nothing was rolled back automatically")
        assert.equal(await finishByHand(w), true)
        assert.deepEqual(snapshot(w), before)
    })

    test("a repair that fails during the swap rolls back automatically: every target is attributable (the new uninstaller is identical to the installed one)", async () => {
        const { w, before } = await installedV1()
        assert.equal(await install(w, "0.1.0", { at: "after-second-rename", mode: "fail" }), "rolled-back")
        assert.deepEqual(snapshot(w), before)
    })

    test("new installation interrupted after the swap: the next start refuses before any change (no record proves the journal); once the listed files are removed by hand it completes", async () => {
        const w = world()
        const before = snapshot(w)
        assert.equal(await install(w, "0.1.0", { at: "registry-partial", mode: "crash" }), "crashed")
        assert.notEqual(w.reg.snapshot(), before.registry, "four values were written")
        const stuck = snapshotDir(w.installDir)
        const registry = w.reg.snapshot()
        assert.equal(await txRecover(w), false)
        assert.match(w.lastMessage ?? "", /stato verificato: uninstall\.exe \(nuovo disinstallatore scritto da questa transazione[^)]*\); fluent-reader-mcp\.install\.json \(registro scritto da questa transazione[^)]*\)\. Nulla è stato rimosso, sostituito o spostato/)
        assert.deepEqual(snapshotDir(w.installDir), stuck, "nothing removed, replaced or moved")
        assert.equal(w.reg.snapshot(), registry, "HKCU untouched")
        // the user checks and removes what the message names; the next start then completes with payload files only
        fs.rmSync(path.join(w.installDir, "uninstall.exe"))
        fs.rmSync(path.join(w.installDir, RECORD_NAME))
        assert.equal(await txRecover(w), true)
        const after = snapshot(w)
        assert.equal(after.version, null)
        assert.equal(after.record, null)
        assert.equal(after.uninstaller, null)
        assert.equal(after.registry, before.registry, "no value and no empty key left")
        assert.deepEqual(after.dirs, [])
        assert.deepEqual(after.state, [])
    })

    test("crash during extraction, before the inventory: the journal authorises removing only the payload's files", async () => {
        const w = world()
        const begin = await call(w, "tx-begin", { installDir: w.installDir, version: "0.1.0", maxRelative: "150", bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "new" })
        assert.equal(begin.code, 0)
        fs.mkdirSync(path.join(w.installDir, ".staging", "app", "runtime"), { recursive: true })
        fs.copyFileSync(path.join(payload("0.1.0"), "app", "runtime", "node.exe"), path.join(w.installDir, ".staging", "app", "runtime", "node.exe"))
        assert.equal(await txRecover(w), true)
        assert.deepEqual(snapshot(w).dirs, [])
        assert.equal(journalPhase(w), null)
    })
})

describe("FR-MCP-04-BETA-RELEASE-02: the 0.1.0 beta is an earlier version than 0.1.1", { timeout: 120_000 }, () => {
    test("0.1.0 installed: the 0.1.1 setup offers an upgrade and completes it; then 0.1.1 is a repair and 0.1.0 a refused downgrade", async () => {
        const { w } = await installedV1()
        const offered = checkInstallDir({ installDir: w.installDir, version: "0.1.1", maxRelative: 150, env: w.env })
        assert.deepEqual([offered.mode, offered.installedVersion], ["upgrade", "0.1.0"])
        assert.equal(await install(w, "0.1.1"), "installed")
        const after = snapshot(w)
        assert.equal(after.version, "0.1.1")
        assert.match(after.record ?? "", /"version": "0\.1\.1"/)
        assert.deepEqual(after.dirs, ["current"])
        assert.equal(w.reg.keys.get(UNINSTALL_KEY)?.get("DisplayVersion")?.value, "0.1.1")
        assert.equal(checkInstallDir({ installDir: w.installDir, version: "0.1.1", maxRelative: 150, env: w.env }).mode, "repair")
        assert.throws(() => checkInstallDir({ installDir: w.installDir, version: "0.1.0", maxRelative: 150, env: w.env }), /contiene la versione 0\.1\.1, più recente di 0\.1\.0; il downgrade non è supportato/)
    })
})

describe("FR-MCP-04-BETA-RELEASE-03: the 0.1.1 beta is an earlier version than 0.1.2", { timeout: 120_000 }, () => {
    test("0.1.1 installed and registered in Claude Code: the 0.1.2 setup offers an upgrade and completes it, the registration carried over untouched; then 0.1.2 is a repair and 0.1.1 a refused downgrade", async () => {
        const w = world()
        assert.equal(await install(w, "0.1.1"), "installed")
        const app = path.join(w.installDir, "current", "app")
        const entry = { type: "stdio" as const, command: path.join(app, "runtime", "node.exe"), args: [path.join(app, "server", "dist", "main.js"), "--profile-dir", w.profile], env: {} }
        const codeConfig = path.join(w.home, ".claude.json")
        fs.writeFileSync(codeConfig, JSON.stringify({ mcpServers: { "fluent-reader": entry, altro: { command: "a" } } }))
        const code = fs.readFileSync(codeConfig)
        const recordFile = path.join(w.installDir, RECORD_NAME)
        const claude = { state: "registered" as const, name: "fluent-reader", scope: "user" as const, configPath: codeConfig, claudeExe: path.join(w.home, "claude.exe"), entry, fingerprint: entryFingerprint(entry), backup: null, updatedAt: "2026-11-03T09:00:00.000Z" }
        writeRecord(recordFile, { ...(readRecord(recordFile) as InstallRecord), claude })
        const offered = checkInstallDir({ installDir: w.installDir, version: "0.1.2", maxRelative: 150, env: w.env })
        assert.deepEqual([offered.mode, offered.installedVersion], ["upgrade", "0.1.1"])
        assert.equal(await install(w, "0.1.2"), "installed")
        const after = snapshot(w)
        assert.equal(after.version, "0.1.2")
        assert.deepEqual(after.dirs, ["current"])
        assert.equal(w.reg.keys.get(UNINSTALL_KEY)?.get("DisplayVersion")?.value, "0.1.2")
        const record = readRecord(recordFile) as InstallRecord
        assert.deepEqual(record.claude, claude, "the Claude Code registration is carried over")
        assert.equal(record.desktop, undefined, "and implies no Claude Desktop registration")
        assert.ok(fs.readFileSync(codeConfig).equals(code), "~/.claude.json is not touched")
        assert.equal(checkInstallDir({ installDir: w.installDir, version: "0.1.2", maxRelative: 150, env: w.env }).mode, "repair")
        assert.equal(await install(w, "0.1.2"), "installed")
        assert.deepEqual((readRecord(recordFile) as InstallRecord).claude, claude, "the repair keeps it too")
        assert.throws(() => checkInstallDir({ installDir: w.installDir, version: "0.1.1", maxRelative: 150, env: w.env }), /contiene la versione 0\.1\.2, più recente di 0\.1\.1; il downgrade non è supportato/)
    })

    test("a 0.1.0 record is still recognised: the 0.1.2 setup offers an upgrade from it", async () => {
        const { w } = await installedV1()
        const offered = checkInstallDir({ installDir: w.installDir, version: "0.1.2", maxRelative: 150, env: w.env })
        assert.deepEqual([offered.mode, offered.installedVersion], ["upgrade", "0.1.0"])
        assert.equal(await install(w, "0.1.2"), "installed")
        assert.equal(snapshot(w).version, "0.1.2")
    })
})

describe("FR-MCP-04-BETA-RELEASE-04: the 0.1.2 beta is an earlier version than 0.1.3", { timeout: 120_000 }, () => {
    test("0.1.2 installed: the 0.1.3 setup upgrades it; then 0.1.3 is a repair and 0.1.2 a refused downgrade", async () => {
        const w = world()
        assert.equal(await install(w, "0.1.2"), "installed")
        const offered = checkInstallDir({ installDir: w.installDir, version: "0.1.3", maxRelative: 150, env: w.env })
        assert.deepEqual([offered.mode, offered.installedVersion], ["upgrade", "0.1.2"])
        assert.equal(await install(w, "0.1.3"), "installed")
        const after = snapshot(w)
        assert.equal(after.version, "0.1.3")
        assert.deepEqual(after.dirs, ["current"])
        assert.equal(w.reg.keys.get(UNINSTALL_KEY)?.get("DisplayVersion")?.value, "0.1.3")
        assert.equal(checkInstallDir({ installDir: w.installDir, version: "0.1.3", maxRelative: 150, env: w.env }).mode, "repair")
        assert.equal(await install(w, "0.1.3"), "installed")
        assert.throws(() => checkInstallDir({ installDir: w.installDir, version: "0.1.2", maxRelative: 150, env: w.env }), /contiene la versione 0\.1\.3, più recente di 0\.1\.2; il downgrade non è supportato/)
    })
})

describe("installation transaction: HKCU types and values (Major 1)", { timeout: 120_000 }, () => {
    test("values absent, present with the expected types, and REG_EXPAND_SZ: a failed upgrade restores each with its type", async () => {
        const w = world()
        w.reg.write(UNINSTALL_KEY, "InstallLocation", "REG_EXPAND_SZ", "%LOCALAPPDATA%\\Old place")
        w.reg.write(UNINSTALL_KEY, "NoModify", "REG_DWORD", "0")
        w.reg.write(SETTINGS_KEY, "InstallDir", "REG_SZ", "C:\\Old")
        const before = w.reg.snapshot()
        assert.equal(await install(w, "0.1.0", { at: "registry-partial", mode: "fail" }), "rollback-incomplete")
        assert.equal(await finishByHand(w), true)
        assert.equal(w.reg.snapshot(), before)
        assert.deepEqual(w.reg.keys.get(UNINSTALL_KEY)?.get("InstallLocation"), { type: "REG_EXPAND_SZ", value: "%LOCALAPPDATA%\\Old place" })
    })

    for (const type of ["REG_BINARY", "REG_MULTI_SZ", "REG_QWORD", "TOO_LONG", "ERROR_5"]) {
        test(`a value of type ${type} cannot be preserved: refused before the swap, nothing changed`, async () => {
            const { w, before } = await installedV1()
            w.reg.write(UNINSTALL_KEY, "EstimatedSize", type, "00ff")
            const withValue = snapshot(w)
            assert.equal(await install(w, "0.2.0"), "rollback-incomplete", "refused at tx-prepare; the rollback stops at the new uninstaller")
            assert.ok((w.refusals ?? []).some((m) => /che il setup non sa ripristinare fedelmente/.test(m)))
            assert.equal(snapshot(w).version, "0.1.0", "the installed version is untouched")
            assert.equal(await finishByHand(w), true)
            assert.deepEqual(snapshot(w), withValue, "current 0.1.0, record, uninstaller, HKCU untouched")
            assert.equal(before.version, "0.1.0")
            assert.ok(w.commands.lastIndexOf("tx-swap") < w.commands.lastIndexOf("tx-prepare"), "no swap was attempted")
        })
    }

    test("a key-presence flag that cannot be read stops before the swap", async () => {
        const { w } = await installedV1()
        const original = w.reg.backup.bind(w.reg)
        w.reg.backup = () => ({ ...original(), "key.settings": "ERROR_5" })
        assert.equal(await install(w, "0.2.0"), "rollback-incomplete")
        assert.equal(snapshot(w).version, "0.1.0")
    })
})

describe("installation transaction: recovery failures keep everything recoverable (Major 1)", { timeout: 120_000 }, () => {
    test("an error during the recovery: journal, previous version and copies are kept; a later recovery completes", async () => {
        const { w, before } = await installedV1()
        assert.equal(await install(w, "0.2.0", { at: "after-second-rename", mode: "crash" }), "crashed")
        assert.equal(await txRecover(w), false)
        assert.deepEqual(removeNamedByHand(w), [path.join("state", "uninstall.exe.new")])
        w.txCheckpoint = (s) => {
            if (s === "during-recovery") throw new Error("injected")
        }
        const r = await call(w, "tx-recover", { installDir: w.installDir })
        assert.equal(r.code, 1)
        assert.match(r.one("message"), /recupero INCOMPLETO .*journal e copie di recupero sono conservati/)
        assert.equal(journalPhase(w), "swapping", "the journal is still there")
        assert.ok(fs.existsSync(path.join(w.installDir, "previous", INVENTORY)), "the previous version is still on disk")
        assert.ok(fs.existsSync(path.join(w.installDir, "state", "install-record.previous.json")))
        w.txCheckpoint = undefined
        assert.equal(await txRecover(w), true)
        assert.deepEqual(snapshot(w), before)
    })

    test("HKCU cannot be restored: the recovery is incomplete, the journal waits in rolling-back; the next attempt finishes", async () => {
        const { w, before } = await installedV1()
        assert.equal(await install(w, "0.2.0", { at: "registry-partial", mode: "crash" }), "crashed")
        assert.equal(await txRecover(w), false)
        assert.deepEqual(removeNamedByHand(w).sort(), [RECORD_NAME, "uninstall.exe"].sort())
        w.reg.failing.add("Publisher")
        assert.equal(await txRecover(w), false)
        assert.equal(journalPhase(w), "rolling-back")
        assert.equal(snapshot(w).version, "0.1.0", "files already back")
        w.reg.failing.clear()
        assert.equal(await txRecover(w), true)
        assert.deepEqual(snapshot(w), before)
    })

    test("a cleanup that fails after the commit is finished by the next start; the committed version is never rolled back", async () => {
        const { w } = await installedV1()
        w.unlink = (f) => {
            if (f.includes(`${path.sep}previous${path.sep}`) && f.endsWith("main.js")) throw Object.assign(new Error("busy"), { code: "EBUSY" })
            fs.unlinkSync(f)
        }
        assert.equal(await install(w, "0.2.0"), "installed")
        assert.equal(journalPhase(w), "committed")
        w.unlink = undefined
        assert.equal(await txRecover(w), true)
        const after = snapshot(w)
        assert.equal(after.version, "0.2.0")
        assert.deepEqual(after.state, [])
        assert.deepEqual(after.dirs, ["current"])
    })

    test("an altered or foreign journal is never acted upon; leftovers without a journal are not removed by tx-begin", async () => {
        const { w } = await installedV1()
        assert.equal(await install(w, "0.2.0", { at: "after-first-rename", mode: "crash" }), "crashed")
        const file = path.join(w.installDir, "state", "install-journal.json")
        const journal = fs.readFileSync(file, "utf8")
        fs.writeFileSync(file, journal.replace('"phase": "swapping"', '"phase": "committed"'))
        const before = snapshotDir(w.installDir)
        const r = await call(w, "tx-recover", { installDir: w.installDir })
        assert.equal(r.code, 1)
        assert.match(r.one("message"), /journal .*non è valido o è stato alterato/)
        assert.deepEqual(snapshotDir(w.installDir), before, "nothing changed")
        // the same journal copied to another installation directory
        const other = world()
        fs.mkdirSync(path.join(other.installDir, "state"), { recursive: true })
        fs.writeFileSync(path.join(other.installDir, "state", "install-journal.json"), journal)
        assert.match((await call(other, "tx-recover", { installDir: other.installDir })).one("message"), /non è valido o è stato alterato/)
        // the original journal back: the recovery stops at the new uninstaller only; removed by hand, it completes
        fs.writeFileSync(file, journal)
        assert.equal(await txRecover(w), false)
        assert.equal(await finishByHand(w), true)
        // a .staging without a journal is not taken as this installer's
        fs.mkdirSync(path.join(w.installDir, ".staging"))
        fs.writeFileSync(path.join(w.installDir, ".staging", "someone.txt"), "x")
        assert.equal(await install(w, "0.2.0"), "refused")
        assert.equal(fs.readFileSync(path.join(w.installDir, ".staging", "someone.txt"), "utf8"), "x")
    })
})

// ------------------------------------------------------------------ uninstallation

type UninstallOutcome = "uninstalled" | "stopped" | "not-recognised" | "no-helper"

interface UninstallFaults {
    /** a step of the NSIS sequence after which the process is gone */
    crashAfter?: "remove-tree" | "un-metadata" | "un-finish" | "helper-copy-deleted" | "final-marker-deleted" | "uninstaller-deleted"
}

/** Runs the helper COPIED from its source in a real process (as $PLUGINSDIR\helper would): proves the second attempt is possible. */
function helperRuns(w: World, source: string): boolean {
    counter++
    const dir = path.join(root, `plugins ${counter}`)
    fs.cpSync(path.join(source, "setup"), path.join(dir, "setup"), { recursive: true })
    fs.writeFileSync(path.join(dir, "request.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`installDir=${w.installDir}\r\n`, "utf16le")]))
    const run = spawnSync(process.execPath, [path.join(dir, "setup", "installer", "setup", "fr-setup.js"), "un-status", path.join(dir, "request.txt"), path.join(dir, "result.txt")], { env: { ...w.env, SystemRoot: process.env.SystemRoot }, encoding: "utf8", windowsHide: true })
    // a refusal (1) is an answer: the helper runs; 2 or no result means it does not
    return (run.status === 0 || run.status === 1) && fs.existsSync(path.join(dir, "result.txt"))
}

/** un.FinalMarkerValid: product, kind and this directory, read as NSIS reads it. */
function finalMarkerValid(w: World): boolean {
    const bytes = fs.readFileSync(path.join(w.installDir, "state", "uninstall-final.marker"))
    const lines = bytes.subarray(2).toString("utf16le").split("\r\n")
    return lines.includes("product=fluent-reader-mcp") && lines.includes("kind=uninstall-final") && lines.some((l) => l.toLowerCase() === `installdir=${w.installDir}`.toLowerCase())
}

/** The NSIS uninstall section, step by step (un.onInit included). */
async function uninstall(w: World, faults: UninstallFaults = {}): Promise<UninstallOutcome> {
    const state = path.join(w.installDir, "state")
    if (!fs.existsSync(path.join(w.installDir, RECORD_NAME)) && !fs.existsSync(path.join(state, "uninstall.json")) && !fs.existsSync(path.join(state, "uninstall-final.marker"))) return "not-recognised"
    const req = { installDir: w.installDir }
    let backupNote = "" // $BackupNote: from un-status, empty when only the last steps are left
    if (fs.existsSync(path.join(state, "uninstall-final.marker"))) {
        // only the last steps are left: never next to an installation, never with a marker of another directory
        if (fs.existsSync(path.join(w.installDir, RECORD_NAME)) || !finalMarkerValid(w)) return "stopped"
    } else {
        const copy = path.join(state, "uninstall-helper")
        const source = fs.existsSync(path.join(copy, "setup", "installer", "setup", "fr-setup.js")) && fs.existsSync(path.join(copy, "app", "runtime", "node.exe")) ? copy
            : fs.existsSync(path.join(w.installDir, "current", "setup", "installer", "setup", "fr-setup.js")) && fs.existsSync(path.join(w.installDir, "current", "app", "runtime", "node.exe")) ? path.join(w.installDir, "current") : null
        if (source === null || !helperRuns(w, source)) return "no-helper"
        const status = await call(w, "un-status", req)
        if (status.code !== 0) return "stopped"
        backupNote = status.one("backups")
        if (status.one("phase") !== "metadata") {
            if ((await call(w, "uninstall-preflight", req)).code !== 0) return "stopped"
            const unreg = await call(w, "desktop-unregister", req)
            if (!["removed", "absent", "config-missing", "not-configured"].includes(unreg.one("outcome"))) return "stopped"
            if ((await call(w, "un-begin", req)).code !== 0) return "stopped"
            for (const tree of [".staging", "previous", "current"]) {
                if (fs.existsSync(path.join(w.installDir, tree)) && (await call(w, "remove-tree", { ...req, tree })).code !== 0) return "stopped"
            }
            if (faults.crashAfter === "remove-tree") return "stopped"
        }
        if ((await call(w, "un-metadata", req)).code !== 0) return "stopped"
        if (faults.crashAfter === "un-metadata") return "stopped"
        let regFail = false
        for (const slot of REGISTRY_SLOTS) {
            const key = KEYS[slot.key]
            try {
                if (w.reg.valueType(key, slot.name) !== "absent") w.reg.delete(key, slot.name)
            } catch {
                regFail = true
            }
        }
        if (!regFail) {
            if (w.reg.deleteIfEmpty(UNINSTALL_KEY) === "error") regFail = true
            if (w.reg.deleteIfEmpty(SETTINGS_KEY) === "error") regFail = true
        }
        if (regFail) return "stopped"
        if ((await call(w, "un-finish", req)).code !== 0) return "stopped"
        if (faults.crashAfter === "un-finish") return "stopped"
    }
    // uninstall_last: the script's own instructions (interpreted), no helper from here on
    const script = fs.readFileSync(path.join(COMPILED_ROOT, "..", "installer", "nsis", "fluent-reader-mcp.nsi"), "utf8")
    const nsh = helperCopyNsh(helperCopyEntries(readInventory(payload("0.1.0")).files.map((f) => f.path)))
    const crashAt: Record<string, string> = {
        "helper-copy-deleted": 'RMDir "$INSTDIR\\state\\uninstall-helper"',
        "final-marker-deleted": 'Delete "$INSTDIR\\state\\uninstall-final.marker"',
        "uninstaller-deleted": 'Delete "$INSTDIR\\uninstall.exe"',
    }
    const run = runNsis({
        lines: sectionLines(script, "Uninstall", "uninstall_last", "!undef UN"),
        macros: parseMacros(script, nsh),
        vars: { INSTDIR: w.installDir, CleanFail: "0", BackupNote: backupNote },
        fs: { unlink: w.unlink ?? fs.unlinkSync, rmdir: w.rmdir ?? fs.rmdirSync },
        crashAfter: (instruction) => faults.crashAfter !== undefined && crashAt[faults.crashAfter] === instruction,
    })
    w.lastRun = run
    return run.outcome === "completed" ? "uninstalled" : "stopped"
}

async function installedForUninstall(): Promise<World> {
    const w = world()
    w.reg.write(UNINSTALL_KEY, "SomeoneElse", "REG_SZ", "foreign value")
    assert.equal(await install(w, "0.1.0"), "installed")
    fs.writeFileSync(path.join(w.installDir, "my notes é.txt"), "mine")
    return w
}

function assertUninstalled(w: World): void {
    assert.deepEqual(fs.readdirSync(w.installDir), ["my notes é.txt"], "no file of the product is left; the user's file stays")
    for (const slot of REGISTRY_SLOTS) assert.equal(w.reg.valueType(KEYS[slot.key], slot.name), "absent")
    assert.equal(w.reg.valueType(UNINSTALL_KEY, "SomeoneElse"), "REG_SZ", "a foreign value stays, with its key")
    assert.equal(w.reg.keys.has(SETTINGS_KEY), false, "the product's own key, left empty, is removed")
    assert.ok(fs.existsSync(path.join(w.profile, "fluent-reader.db")))
}

describe("uninstallation: helper partly removed (Major 2)", { timeout: 120_000 }, () => {
    test("Codex counterexample: node.exe removed, EBUSY on fr-setup.js; the second attempt runs the verified copy and finishes", async () => {
        const w = await installedForUninstall()
        w.unlink = (f) => {
            if (f.endsWith(`setup${path.sep}installer${path.sep}setup${path.sep}fr-setup.js`) && f.includes(`${path.sep}current${path.sep}`)) throw Object.assign(new Error("busy"), { code: "EBUSY" })
            fs.unlinkSync(f)
        }
        assert.equal(await uninstall(w), "stopped")
        const current = path.join(w.installDir, "current")
        assert.equal(fs.existsSync(path.join(current, "app", "runtime", "node.exe")), false, "node.exe already removed (the counterexample)")
        assert.equal(fs.existsSync(path.join(current, "setup", "installer", "setup", "fr-setup.js")), true)
        assert.ok(fs.existsSync(path.join(w.installDir, RECORD_NAME)), "record kept")
        assert.ok(fs.existsSync(path.join(w.installDir, "uninstall.exe")), "uninstaller kept")
        assert.equal(helperRuns(w, path.join(w.installDir, "state", "uninstall-helper")), true, "the recovery copy is a working helper")
        w.unlink = undefined
        assert.equal(await uninstall(w), "uninstalled")
        assertUninstalled(w)
    })

    test("the recovery copy cannot be created: nothing is removed; after fixing the cause the uninstallation completes", async () => {
        const w = await installedForUninstall()
        fs.writeFileSync(path.join(w.installDir, "state", "uninstall-helper"), "a file in the way")
        const before = snapshotDir(w.installDir)
        assert.equal(await uninstall(w), "stopped")
        assert.deepEqual(snapshotDir(w.installDir), before, "nothing removed, record and helper intact")
        fs.rmSync(path.join(w.installDir, "state", "uninstall-helper"))
        assert.equal(await uninstall(w), "uninstalled")
        assertUninstalled(w)
    })

    test("a recovery copy altered after a partial attempt: the next attempt stops explicitly and removes nothing more", async () => {
        const w = await installedForUninstall()
        w.unlink = (f) => {
            if (f.endsWith("main.js") && f.includes(`${path.sep}current${path.sep}`)) throw Object.assign(new Error("busy"), { code: "EBUSY" })
            fs.unlinkSync(f)
        }
        assert.equal(await uninstall(w), "stopped")
        w.unlink = undefined
        fs.appendFileSync(path.join(w.installDir, "state", "uninstall-helper", "setup", "installer", "setup", "app.js"), "\n// altered")
        const before = snapshotDir(w.installDir)
        const status = await call(w, "un-status", { installDir: w.installDir })
        assert.equal(status.one("helperCopy"), "incomplete")
        assert.equal(await uninstall(w), "stopped")
        assert.match((await call(w, "uninstall-preflight", { installDir: w.installDir })).one("message"), /copia di recupero .*incompleta o alterata/)
        assert.deepEqual(snapshotDir(w.installDir), before)
    })

    test("a foreign file inside current stops before anything is removed; after moving it, the uninstallation completes", async () => {
        const w = await installedForUninstall()
        fs.writeFileSync(path.join(w.installDir, "current", "app", "foreign.txt"), "not ours")
        const before = snapshotDir(w.installDir)
        assert.equal(await uninstall(w), "stopped")
        assert.deepEqual(snapshotDir(w.installDir), before)
        fs.renameSync(path.join(w.installDir, "current", "app", "foreign.txt"), path.join(w.home, "foreign.txt"))
        assert.equal(await uninstall(w), "uninstalled")
        assertUninstalled(w)
        assert.equal(fs.readFileSync(path.join(w.home, "foreign.txt"), "utf8"), "not ours")
    })
})

describe("uninstallation: resumable finalisation (Major 2)", { timeout: 120_000 }, () => {
    const faults: [string, (w: World) => UninstallFaults][] = [
        ["after the application files are removed", () => ({ crashAfter: "remove-tree" })],
        ["before the record is removed", (w) => ((w.uninstallCheckpoint = (s) => { if (s === "before-record-delete") throw new Error("injected") }), {})],
        ["after the record is removed", (w) => ((w.uninstallCheckpoint = (s) => { if (s === "after-record-delete") throw new Error("injected") }), {})],
        ["while deleting the first HKCU key's values", (w) => (w.reg.failing.add("DisplayName"), {})],
        ["while deleting the second HKCU key's value", (w) => (w.reg.failing.add("InstallDir"), {})],
        ["while removing the marker in un-finish", (w) => ((w.uninstallCheckpoint = (s) => { if (s === "before-marker-delete") throw new Error("injected") }), {})],
        ["after un-finish, before the last steps", () => ({ crashAfter: "un-finish" })],
    ]
    for (const [label, inject] of faults) {
        test(`a failure ${label}: the second attempt is possible and completes; nothing foreign removed`, async () => {
            const w = await installedForUninstall()
            const first = await uninstall(w, inject(w))
            assert.equal(first, "stopped")
            assert.notEqual(await uninstallStateKind(w), "nothing", "a record or a marker still lets the uninstaller start")
            w.uninstallCheckpoint = undefined
            w.unlink = undefined
            w.reg.failing.clear()
            assert.equal(await uninstall(w), "uninstalled")
            assertUninstalled(w)
        })
    }

    test("an altered marker authorises nothing", async () => {
        const w = await installedForUninstall()
        assert.equal(await uninstall(w, { crashAfter: "remove-tree" }), "stopped")
        const marker = path.join(w.installDir, "state", "uninstall.json")
        fs.writeFileSync(marker, fs.readFileSync(marker, "utf8").replace('"phase": "files"', '"phase": "metadata"'))
        const before = snapshotDir(w.installDir)
        assert.match((await call(w, "un-metadata", { installDir: w.installDir })).one("message"), /non è valido o è stato alterato/)
        assert.deepEqual(snapshotDir(w.installDir), before)
    })
})

async function uninstallStateKind(w: World): Promise<"record" | "marker" | "final" | "nothing"> {
    const state = path.join(w.installDir, "state")
    if (fs.existsSync(path.join(w.installDir, RECORD_NAME))) return "record"
    if (fs.existsSync(path.join(state, "uninstall.json"))) return "marker"
    if (fs.existsSync(path.join(state, "uninstall-final.marker"))) return "final"
    return "nothing"
}

describe("round 4: recovery of the record after its copy is gone (Major 1)", { timeout: 120_000 }, () => {
    /** An upgrade interrupted in metadata, then a recovery that stops right after removing the record copy. */
    async function copyGoneJournalLeft(): Promise<{ w: World; before: Snapshot }> {
        const { w, before } = await installedV1()
        assert.equal(await install(w, "0.2.0", { at: "after-uninstaller", mode: "crash" }), "crashed")
        assert.equal(await txRecover(w), false)
        assert.deepEqual(removeNamedByHand(w).sort(), [RECORD_NAME, "uninstall.exe"].sort())
        w.txCheckpoint = (s) => {
            if (s === "after-record-copy-removed") throw new Crash("crash after removing the record copy")
        }
        assert.equal(await txRecover(w), false)
        w.txCheckpoint = undefined
        assert.equal(journalPhase(w), "rolling-back", "the journal is still there")
        assert.equal(fs.existsSync(path.join(w.installDir, "state", "install-record.previous.json")), false, "the copy is gone")
        assert.equal(snapshot(w).record, before.record, "the record was already restored")
        return { w, before }
    }

    test("the next recovery accepts the restored record by its SHA-256 and completes; nothing is lost", async () => {
        const { w, before } = await copyGoneJournalLeft()
        assert.equal(await txRecover(w), true)
        assert.deepEqual(snapshot(w), before)
        assert.equal(journalPhase(w), null)
    })

    const tampering: [string, (record: string) => void, RegExp][] = [
        // the copy is gone and the record is not the one found at tx-begin: refused before any change
        ["record missing", (r) => fs.rmSync(r), /fluent-reader-mcp\.install\.json \(il registro precedente non si trova né al suo posto né nella copia\)/],
        ["record altered", (r) => fs.appendFileSync(r, " "), /fluent-reader-mcp\.install\.json \(il registro precedente non si trova né al suo posto né nella copia\)/],
        ["another valid record (different hash)", (r) => fs.writeFileSync(r, fs.readFileSync(r, "utf8").replace('"0.1.0"', '"0.0.9"')), /fluent-reader-mcp\.install\.json \(il registro precedente non si trova né al suo posto né nella copia\)/],
    ]
    for (const [label, tamper, message] of tampering) {
        test(`${label}: the recovery refuses, journal and every remaining file kept`, async () => {
            const { w } = await copyGoneJournalLeft()
            tamper(path.join(w.installDir, RECORD_NAME))
            const before = snapshotDir(w.installDir)
            const r = await call(w, "tx-recover", { installDir: w.installDir })
            assert.equal(r.code, 1)
            assert.match(r.one("message"), message)
            assert.deepEqual(snapshotDir(w.installDir), before, "nothing deleted or rewritten")
        })
    }
})

describe("round 4: finalisation without the helper (Major 2)", { timeout: 120_000 }, () => {
    test("Codex counterexample: node.exe of the recovery copy removed, EBUSY on fr-setup.js; the second attempt finishes without any helper", async () => {
        const w = await installedForUninstall()
        w.unlink = (f) => {
            if (f.includes(`${path.sep}uninstall-helper${path.sep}`) && f.endsWith("fr-setup.js")) throw Object.assign(new Error("busy"), { code: "EBUSY" })
            fs.unlinkSync(f)
        }
        assert.equal(await uninstall(w), "stopped")
        const copy = path.join(w.installDir, "state", "uninstall-helper")
        assert.equal(fs.existsSync(path.join(copy, "app", "runtime", "node.exe")), false, "node.exe of the copy already removed")
        assert.equal(fs.existsSync(path.join(copy, "setup", "installer", "setup", "fr-setup.js")), true)
        assert.ok(fs.existsSync(path.join(w.installDir, "state", "uninstall-final.marker")), "the final marker was written before anything was destroyed")
        assert.equal(fs.existsSync(path.join(w.installDir, RECORD_NAME)), false)
        w.unlink = undefined
        const calls = w.commands.length
        assert.equal(await uninstall(w), "uninstalled")
        assert.equal(w.commands.length, calls, "the second attempt called no helper command")
        assertUninstalled(w)
    })

    test("a crash between the removal of the helper copy and the final marker: the next attempt finishes without the helper", async () => {
        const w = await installedForUninstall()
        assert.equal(await uninstall(w, { crashAfter: "helper-copy-deleted" }), "stopped")
        assert.equal(fs.existsSync(path.join(w.installDir, "state", "uninstall-helper")), false)
        const calls = w.commands.length
        assert.equal(await uninstall(w), "uninstalled")
        assert.equal(w.commands.length, calls)
        assertUninstalled(w)
    })

    test("un-finish destroys nothing: after it the helper copy is still complete", async () => {
        const w = await installedForUninstall()
        assert.equal(await uninstall(w, { crashAfter: "un-finish" }), "stopped")
        const status = await call(w, "un-status", { installDir: w.installDir })
        assert.equal(status.one("phase"), "final")
        assert.equal(status.one("helperCopy"), "complete")
    })
})

/** The wizard's DirectoryLeave: check-install-dir; a pending uninstallation is completed only if the user agrees, once. */
async function directoryLeave(w: World, answer: "yes" | "no"): Promise<"ok" | "refused"> {
    let offered = false
    for (;;) {
        const check = await call(w, "check-install-dir", { installDir: w.installDir, version: "0.1.0", maxRelative: "150" })
        if (check.code === 0) return "ok"
        if (check.one("pendingUninstall") !== "yes" || offered || answer === "no") return "refused"
        offered = true
        if ((await call(w, "finish-uninstall", { installDir: w.installDir })).code !== 0) return "refused"
    }
}

/** The last steps stopped (final marker not deletable), then the user deleted uninstall.exe by hand: marker present, uninstaller absent. */
async function markerLeftUninstallerGone(): Promise<World> {
    const w = await installedForUninstall()
    w.unlink = (f) => {
        if (f.endsWith("uninstall-final.marker")) throw Object.assign(new Error("busy"), { code: "EBUSY" })
        fs.unlinkSync(f)
    }
    assert.equal(await uninstall(w), "stopped")
    w.unlink = undefined
    assert.ok(fs.existsSync(path.join(w.installDir, "uninstall.exe")), "the uninstaller is kept while the marker is there")
    fs.rmSync(path.join(w.installDir, "uninstall.exe"))
    return w
}

describe("round 4: uninstall state of an earlier installation (Major 3)", { timeout: 120_000 }, () => {
    test("uninstall.exe gone, final marker left: a new installation is refused until the earlier uninstallation is completed; nothing is created", async () => {
        const w = await markerLeftUninstallerGone()
        const before = snapshotDir(w.installDir)
        assert.equal(await install(w, "0.1.0"), "refused")
        assert.match(w.lastMessage ?? "", /disinstallazione precedente è rimasta da completare \(state\\uninstall-final\.marker\) e il suo disinstallatore non c'è più/)
        assert.deepEqual(snapshotDir(w.installDir), before, "no journal, no .staging, nothing changed")
        assert.equal(await directoryLeave(w, "no"), "refused", "declined: nothing done")
        assert.deepEqual(snapshotDir(w.installDir), before)
        fs.renameSync(path.join(w.installDir, "my notes é.txt"), path.join(w.home, "my notes é.txt"))
        assert.equal(await directoryLeave(w, "yes"), "ok")
        assert.equal(await install(w, "0.1.0"), "installed")
    })

    test("a final marker next to a new installation is never taken as its own: the uninstaller stops, nothing removed", async () => {
        const w = await markerLeftUninstallerGone()
        const marker = fs.readFileSync(path.join(w.installDir, "state", "uninstall-final.marker"))
        fs.renameSync(path.join(w.installDir, "my notes é.txt"), path.join(w.home, "my notes é.txt"))
        assert.equal(await directoryLeave(w, "yes"), "ok")
        assert.equal(await install(w, "0.1.0"), "installed")
        fs.writeFileSync(path.join(w.installDir, "state", "uninstall-final.marker"), marker)
        const before = snapshotDir(w.installDir)
        assert.equal(await uninstall(w), "stopped")
        assert.deepEqual(snapshotDir(w.installDir), before)
        assert.match((await call(w, "un-status", { installDir: w.installDir })).one("message"), /installazione insieme al marcatore finale/)
    })

    test("an uninstall.json of another generation (valid checksum) authorises nothing on the current installation", async () => {
        const w = await installedForUninstall()
        const body = { schemaVersion: 1, product: "fluent-reader-mcp", kind: "uninstall-marker", installDir: w.installDir, generation: "cd".repeat(16), phase: "metadata" }
        const checksum = crypto.createHash("sha256").update(canonicalJson(body)).digest("hex")
        fs.writeFileSync(path.join(w.installDir, "state", "uninstall.json"), JSON.stringify({ ...body, checksum }))
        const before = snapshotDir(w.installDir)
        assert.equal(await uninstall(w), "stopped")
        assert.deepEqual(snapshotDir(w.installDir), before, "record, files, uninstaller untouched")
        assert.match(w.lastMessage ?? "", /appartiene a un'altra installazione/)
        for (const command of ["uninstall-preflight", "un-begin", "un-metadata", "un-finish"]) {
            assert.notEqual((await call(w, command, { installDir: w.installDir })).code, 0, command)
        }
        assert.deepEqual(snapshotDir(w.installDir), before)
        assert.equal(await install(w, "0.2.0"), "refused", "and no new installation inherits it")
    })

    test("an altered final marker (another directory) is refused by the uninstaller and by the helper", async () => {
        const w = await installedForUninstall()
        assert.equal(await uninstall(w, { crashAfter: "un-finish" }), "stopped")
        const file = path.join(w.installDir, "state", "uninstall-final.marker")
        const text = fs.readFileSync(file).subarray(2).toString("utf16le").replace(`installDir=${w.installDir}`, "installDir=C:\\Elsewhere")
        fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]))
        const before = snapshotDir(w.installDir)
        assert.equal(await uninstall(w), "stopped")
        assert.deepEqual(snapshotDir(w.installDir), before)
        assert.match((await call(w, "un-status", { installDir: w.installDir })).one("message"), /marcatore finale .*non è valido/)
    })

    test("a legitimate partial uninstallation still resumes", async () => {
        const w = await installedForUninstall()
        assert.equal(await uninstall(w, { crashAfter: "remove-tree" }), "stopped")
        assert.equal(await uninstall(w), "uninstalled")
        assertUninstalled(w)
    })
})

describe("round 4: HKCU strings with line breaks (Major 4)", { timeout: 120_000 }, () => {
    const cases: [string, string, string][] = [
        ["REG_SZ with CR", "REG_SZ", "Fluent\rReader"],
        ["REG_SZ with LF", "REG_SZ", "Fluent\nReader"],
        ["REG_SZ with CRLF", "REG_SZ", "Fluent\r\nReader"],
        ["REG_EXPAND_SZ with LF", "REG_EXPAND_SZ", "%LOCALAPPDATA%\nFluent"],
    ]
    for (const [label, type, value] of cases) {
        test(`${label}: refused before the swap, nothing changed, the value left intact`, async () => {
            const { w } = await installedV1()
            w.reg.write(UNINSTALL_KEY, "Publisher", type, value)
            const before = snapshot(w)
            assert.equal(await install(w, "0.2.0"), "rollback-incomplete", "refused at tx-prepare; the rollback stops at the new uninstaller")
            assert.ok((w.refusals ?? []).some((m) => /contiene un a capo \(CR o LF\): il suo backup non è rappresentabile in sicurezza/.test(m)))
            assert.equal(await finishByHand(w), true)
            assert.deepEqual(snapshot(w), before)
            assert.deepEqual(w.reg.keys.get(UNINSTALL_KEY)?.get("Publisher"), { type, value })
            assert.ok(w.commands.lastIndexOf("tx-swap") < w.commands.lastIndexOf("tx-prepare"), "no swap")
        })
    }

    test("an unexpanded %LOCALAPPDATA% REG_EXPAND_SZ and normal strings are preserved identically", async () => {
        const { w, before } = await installedV1()
        w.reg.write(UNINSTALL_KEY, "InstallLocation", "REG_EXPAND_SZ", "%LOCALAPPDATA%\\FluentReaderMCP")
        const withExpand = w.reg.snapshot()
        assert.equal(await install(w, "0.2.0", { at: "registry-partial", mode: "fail" }), "rollback-incomplete")
        assert.equal(await finishByHand(w), true)
        assert.equal(w.reg.snapshot(), withExpand)
        assert.equal(snapshot(w).version, before.version)
    })
})

describe("round 4: removal of keys left empty (Minor)", { timeout: 120_000 }, () => {
    test("rollback of a new installation: an empty key is deleted, a key with another program's value is kept (not an error)", async () => {
        const w = world()
        assert.equal(await install(w, "0.1.0", { at: "registry-partial", mode: "crash" }), "crashed")
        w.reg.write(UNINSTALL_KEY, "SomeoneElse", "REG_SZ", "foreign")
        assert.equal(await txRecover(w, journalTxId(w)), false, "the same run's id correlates, it authorises nothing")
        assert.equal(await finishByHand(w), true)
        assert.deepEqual([...(w.reg.keys.get(UNINSTALL_KEY)?.keys() ?? [])], ["SomeoneElse"], "kept, with the foreign value only")
        assert.equal(w.reg.keys.has(SETTINGS_KEY), false, "the empty key is deleted")
    })

    test("a key that should go and cannot: the recovery is not declared complete; a later attempt finishes", async () => {
        const w = world()
        assert.equal(await install(w, "0.1.0", { at: "registry-partial", mode: "crash" }), "crashed")
        assert.equal(await txRecover(w), false)
        assert.deepEqual(removeNamedByHand(w).sort(), [RECORD_NAME, "uninstall.exe"].sort())
        w.reg.failingKeys.add(UNINSTALL_KEY)
        assert.equal(await txRecover(w), false)
        assert.equal(journalPhase(w), "rolling-back")
        w.reg.failingKeys.clear()
        // a later start: only payload files and the journal are left, so it may finish
        assert.equal(await txRecover(w), true)
        assert.equal(w.reg.snapshot(), "[]")
    })

    test("uninstallation: a key that cannot be removed stops it; the next attempt completes, a foreign value is preserved", async () => {
        const w = await installedForUninstall()
        w.reg.failingKeys.add(SETTINGS_KEY)
        assert.equal(await uninstall(w), "stopped")
        w.reg.failingKeys.clear()
        assert.equal(await uninstall(w), "uninstalled")
        assertUninstalled(w)
    })
})

describe("round 5: the uninstaller's last steps, run from the script's own instructions", { timeout: 120_000 }, () => {
    const busy = (match: (p: string) => boolean, real: (p: string) => void) => (p: string): void => {
        if (match(p)) throw Object.assign(new Error("busy"), { code: "EBUSY" })
        real(p)
    }
    const kept = (w: World): { marker: boolean; uninstaller: boolean; copy: boolean } => ({
        marker: fs.existsSync(path.join(w.installDir, "state", "uninstall-final.marker")),
        uninstaller: fs.existsSync(path.join(w.installDir, "uninstall.exe")),
        copy: fs.existsSync(path.join(w.installDir, "state", "uninstall-helper")),
    })
    /** After the recovery: a new installation in the same folder works and leaves no uninstall state. */
    /**
     * Major 1 (03A-SIMPLE-01 review): a leftover uninstall.exe without a record is not attributable; the
     * directory is not reused (the wizard proposes a subfolder) and the file is neither replaced nor deleted.
     * Removed by hand, the directory is reused normally.
     */
    async function leftoverRefusedThenReinstall(w: World): Promise<void> {
        if (fs.existsSync(path.join(w.installDir, "my notes é.txt"))) fs.renameSync(path.join(w.installDir, "my notes é.txt"), path.join(w.home, `my notes ${counter}.txt`))
        const leftover = fs.readFileSync(path.join(w.installDir, "uninstall.exe"))
        // (a short maxRelative: the proposal is 16 characters longer than the synthetic directory, already deep in the temp folder)
        const check = await call(w, "check-install-dir", { installDir: w.installDir, version: "0.1.0", maxRelative: "60" })
        assert.equal(check.one("canonical"), path.join(w.installDir, "FluentReaderMCP"), "not the directory itself: a subfolder is proposed")
        assert.equal(check.one("adjusted"), "not-empty")
        assert.equal(await install(w, "0.1.0"), "refused")
        assert.match(w.lastMessage ?? "", /nomi usati da Fluent Reader MCP \(uninstall\.exe\) ma nessun registro/)
        assert.deepEqual(fs.readFileSync(path.join(w.installDir, "uninstall.exe")), leftover, "the leftover is untouched")
        fs.rmSync(path.join(w.installDir, "uninstall.exe")) // by hand, as the uninstaller's message says
        await reinstall(w)
    }

    async function reinstall(w: World): Promise<void> {
        if (fs.existsSync(path.join(w.installDir, "my notes é.txt"))) fs.renameSync(path.join(w.installDir, "my notes é.txt"), path.join(w.home, `my notes ${counter}.txt`))
        assert.equal(await directoryLeave(w, "yes"), "ok")
        assert.equal(await install(w, "0.1.0"), "installed")
        assert.equal(fs.readFileSync(path.join(w.installDir, "uninstall.exe"), "utf8"), "uninstaller 0.1.0")
        assert.deepEqual(fs.readdirSync(path.join(w.installDir, "state")), [], "no uninstall state, no copies left")
    }

    test("1. EBUSY on an RMDir of the helper copy: aborted (no success), marker and uninstaller kept; the retry completes; reinstall works", async () => {
        const w = await installedForUninstall()
        w.rmdir = busy((d) => d.endsWith(path.join("uninstall-helper", "setup", "installer", "setup")), fs.rmdirSync)
        assert.equal(await uninstall(w), "stopped")
        assert.equal(w.lastRun?.outcome, "aborted")
        assert.match(w.lastRun?.messages.join("\n") ?? "", /non è stata rimossa del tutto/)
        assert.deepEqual(kept(w), { marker: true, uninstaller: true, copy: true })
        w.rmdir = undefined
        assert.equal(await uninstall(w), "uninstalled")
        assertUninstalled(w)
        await reinstall(w)
    })

    test("2. EBUSY deleting the final marker: aborted, marker and uninstaller kept; the retry completes; reinstall works", async () => {
        const w = await installedForUninstall()
        w.unlink = busy((f) => f.endsWith("uninstall-final.marker"), fs.unlinkSync)
        assert.equal(await uninstall(w), "stopped")
        assert.equal(w.lastRun?.outcome, "aborted")
        assert.deepEqual(kept(w), { marker: true, uninstaller: true, copy: false })
        w.unlink = undefined
        assert.equal(await uninstall(w), "uninstalled")
        assertUninstalled(w)
        await reinstall(w)
    })

    test("3. crash right after deleting uninstall.exe: nothing of the uninstallation is left; reinstall works", async () => {
        const w = await installedForUninstall()
        assert.equal(await uninstall(w, { crashAfter: "uninstaller-deleted" }), "stopped")
        assert.deepEqual(kept(w), { marker: false, uninstaller: false, copy: false })
        assert.equal(await uninstallStateKind(w), "nothing", "the marker went before the uninstaller")
        await reinstall(w)
    })

    test("4. crash after the marker is deleted, uninstaller still there: a leftover that authorises nothing; the directory is reused once it is removed by hand", async () => {
        const w = await installedForUninstall()
        assert.equal(await uninstall(w, { crashAfter: "final-marker-deleted" }), "stopped")
        assert.deepEqual(kept(w), { marker: false, uninstaller: true, copy: false })
        assert.equal(await uninstallStateKind(w), "nothing", "the leftover uninstaller authorises nothing (un.onInit refuses)")
        const check = await call(w, "check-install-dir", { installDir: w.installDir, version: "0.1.0", maxRelative: "150" })
        assert.notEqual(check.one("pendingUninstall"), "yes")
        await leftoverRefusedThenReinstall(w)
        assert.equal(await uninstall(w), "uninstalled", "the new installation uninstalls normally")
    })

    test("5. an empty state\\uninstall-helper that cannot be removed: no success; through the uninstaller or a new setup, completed once possible", async () => {
        const w = await installedForUninstall()
        const copy = path.join(w.installDir, "state", "uninstall-helper")
        w.rmdir = (d) => {
            if (d === copy) throw Object.assign(new Error("denied"), { code: "EACCES" })
            fs.rmdirSync(d)
        }
        assert.equal(await uninstall(w), "stopped")
        assert.deepEqual(fs.readdirSync(copy), [], "empty, but still there")
        assert.deepEqual(kept(w), { marker: true, uninstaller: true, copy: true })
        assert.equal(await directoryLeave(w, "yes"), "refused", "with the uninstaller present the procedure is to run it")
        // the uninstaller deleted by hand: the new setup offers to finish, still fails while the cause persists
        fs.rmSync(path.join(w.installDir, "uninstall.exe"))
        assert.equal(await directoryLeave(w, "yes"), "refused")
        assert.match(w.lastMessage ?? "", /impossibile rimuovere la cartella .*uninstall-helper \(EACCES\)/)
        assert.ok(kept(w).marker, "the final marker stays until the end")
        w.rmdir = undefined
        await reinstall(w)
    })

    test("6a. an altered final marker: neither the uninstaller nor the new setup act on it", async () => {
        const w = await markerLeftUninstallerGone()
        const file = path.join(w.installDir, "state", "uninstall-final.marker")
        const text = fs.readFileSync(file).subarray(2).toString("utf16le").replace(`installDir=${w.installDir}`, "installDir=C:\\Elsewhere")
        fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]))
        const before = snapshotDir(w.installDir)
        assert.equal(await directoryLeave(w, "yes"), "refused")
        assert.match(w.lastMessage ?? "", /marcatore finale .*non è valido/)
        assert.deepEqual(snapshotDir(w.installDir), before)
    })

    test("6b. a leftover marker of another generation next to the final marker: the new setup refuses, nothing removed", async () => {
        const w = await markerLeftUninstallerGone()
        const body = { schemaVersion: 1, product: "fluent-reader-mcp", kind: "uninstall-marker", installDir: w.installDir, generation: "ef".repeat(16), phase: "metadata" }
        fs.writeFileSync(path.join(w.installDir, "state", "uninstall.json"), JSON.stringify({ ...body, checksum: crypto.createHash("sha256").update(canonicalJson(body)).digest("hex") }))
        const before = snapshotDir(w.installDir)
        assert.equal(await directoryLeave(w, "yes"), "refused")
        assert.match(w.lastMessage ?? "", /non appartiene a quella del marcatore finale/)
        assert.deepEqual(snapshotDir(w.installDir), before)
    })

    test("6c. the final marker of an earlier generation next to a new installation: no recovery is offered or applied", async () => {
        const w = await markerLeftUninstallerGone()
        const marker = fs.readFileSync(path.join(w.installDir, "state", "uninstall-final.marker"))
        await reinstall(w)
        fs.writeFileSync(path.join(w.installDir, "state", "uninstall-final.marker"), marker)
        const before = snapshotDir(w.installDir)
        const check = await call(w, "check-install-dir", { installDir: w.installDir, version: "0.1.0", maxRelative: "150" })
        assert.equal(check.code, 1)
        assert.notEqual(check.one("pendingUninstall"), "yes")
        assert.match((await call(w, "finish-uninstall", { installDir: w.installDir })).one("message"), /c'è un'installazione/)
        assert.equal(await uninstall(w), "stopped")
        assert.deepEqual(snapshotDir(w.installDir), before, "the new installation is untouched")
    })

    test("7. a foreign file in the leftover state\\uninstall-helper: never deleted; both paths stop until it is moved, then complete", async () => {
        const w = await installedForUninstall()
        assert.equal(await uninstall(w, { crashAfter: "un-finish" }), "stopped")
        const foreign = path.join(w.installDir, "state", "uninstall-helper", "setup", "someone else é.txt")
        fs.writeFileSync(foreign, "not ours")
        assert.equal(await uninstall(w), "stopped")
        assert.equal(w.lastRun?.outcome, "aborted")
        assert.equal(fs.readFileSync(foreign, "utf8"), "not ours")
        assert.deepEqual(kept(w), { marker: true, uninstaller: true, copy: true })
        fs.rmSync(path.join(w.installDir, "uninstall.exe"))
        assert.equal(await directoryLeave(w, "yes"), "refused")
        assert.match(w.lastMessage ?? "", /file che non appartengono alla disinstallazione: setup\/someone else é\.txt/)
        assert.equal(fs.readFileSync(foreign, "utf8"), "not ours")
        fs.renameSync(foreign, path.join(w.home, "someone else é.txt"))
        await reinstall(w)
        assert.equal(fs.readFileSync(path.join(w.home, "someone else é.txt"), "utf8"), "not ours")
    })

    test("marker present, uninstaller absent: the new setup completes the earlier uninstallation from the final marker alone", async () => {
        const w = await markerLeftUninstallerGone()
        const calls = w.commands.length
        await reinstall(w)
        assert.deepEqual(w.commands.slice(calls, calls + 3), ["check-install-dir", "finish-uninstall", "check-install-dir"])
    })

    test("uninstall.exe that cannot be deleted at the very end: the uninstallation is complete; the leftover is not reused until removed by hand", async () => {
        const w = await installedForUninstall()
        w.unlink = busy((f) => f.endsWith("uninstall.exe"), fs.unlinkSync)
        assert.equal(await uninstall(w), "uninstalled")
        assert.match(w.lastRun?.messages.join("\n") ?? "", /non serve più, cancellalo a mano\. Finché è presente, senza un registro di installazione il setup non lo considera suo e non riusa questa cartella/)
        assert.deepEqual(kept(w), { marker: false, uninstaller: true, copy: false })
        w.unlink = undefined
        await leftoverRefusedThenReinstall(w)
    })
})

describe("the model follows the NSIS script", () => {
    const script = fs.readFileSync(path.join(COMPILED_ROOT, "..", "installer", "nsis", "fluent-reader-mcp.nsi"), "utf8").split(/\r?\n/).filter((l) => !/^\s*;/.test(l)).join("\n")
    const section = (name: string): string => script.slice(script.indexOf(`Section "${name}"`), script.indexOf("SectionEnd", script.indexOf(`Section "${name}"`)))
    const macro = (name: string): string => script.slice(script.indexOf(`!macro ${name}`), script.indexOf("!macroend", script.indexOf(`!macro ${name}`)))
    const commands = (text: string): string[] => [...text.matchAll(/RunHelper(?:With "[^"]*" "[^"]*")? "([a-z-]+)"|!insertmacro (TxRecover|RemoveOwnTree)\b/g)].map((m) => (m[2] === "TxRecover" ? "tx-recover" : m[2] === "RemoveOwnTree" ? "remove-tree" : (m[1] as string)))
    const firstOccurrences = (list: string[]): string[] => list.filter((c, i) => list.indexOf(c) === i)
    const keyOf = (key: "uninstall" | "settings"): string => (key === "uninstall" ? "${UNINSTALL_KEY}" : "${SETTINGS_KEY}")

    test("install section: same helper commands, same order; the rollback is the recovery", () => {
        const main = section("Fluent Reader MCP")
        const expanded = commands(main).flatMap((c) => (c === "tx-recover" ? ["tx-recover", "tx-recover-finish"] : [c]))
        assert.deepEqual(firstOccurrences(expanded), INSTALL_COMMANDS)
        assert.deepEqual(commands(macro("TxRecover")), ["tx-recover", "tx-recover-finish"])
        assert.deepEqual(commands(main.slice(main.indexOf("install_rollback:"))), ["tx-recover"], "rollback: TxRecover only")
    })

    test("uninstall section: same helper commands, same order", () => {
        assert.deepEqual(firstOccurrences(commands(section("Uninstall"))), UNINSTALL_COMMANDS)
    })

    test("the nine HKCU values are the same in the helper, the backup, the writes, the restore and the uninstall", () => {
        const install = section("Fluent Reader MCP")
        const expected = REGISTRY_SLOTS.map((s) => `${s.id} ${keyOf(s.key)} ${s.name}`)
        const names = REGISTRY_SLOTS.map((s) => `${keyOf(s.key)} ${s.name}`)
        assert.deepEqual([...install.matchAll(/RegBackupPut (\d) "([^"]+)" "(\w+)"/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`), expected)
        assert.deepEqual([...macro("TxRecover").matchAll(/RegApplyRestore (\d) "([^"]+)" "(\w+)"/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`), expected)
        assert.deepEqual([...install.matchAll(/RegWrite "([^"]+)" "(\w+)"/g)].map((m) => `${m[1]} ${m[2]}`), names)
        assert.deepEqual([...section("Uninstall").matchAll(/RegDeleteOwn "([^"]+)" "(\w+)"/g)].map((m) => `${m[1]} ${m[2]}`), names)
    })
})


// ------------------------------------------------------------------ FR-MCP-04-BETA-03A-SIMPLE-01: a destination outside the user's folder

/** The wizard's DirectoryLeave: the chosen directory becomes the effective destination, which the user confirms. */
async function chooseDirectory(w: World, chosen: string, version: string): Promise<{ canonical: string; adjusted: string; mode: string }> {
    const r = await call(w, "check-install-dir", { installDir: chosen, version, maxRelative: "150" })
    assert.equal(r.code, 0, r.one("message"))
    return { canonical: r.one("canonical"), adjusted: r.one("adjusted"), mode: r.one("mode") }
}

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

/** A synthetic machine: the user's folder is <machine>\Users\<user>; <machine>\Volume H é plays another drive. */
function machine(): { base: World; volume: string; dir: string } {
    counter++
    const dir = path.join(awayBase(), `machine ${counter}`)
    const base = world(path.join(dir, "Users", "utente é"))
    const volume = path.join(dir, "Volume H é")
    fs.mkdirSync(volume, { recursive: true })
    return { base, volume, dir }
}

describe("lifecycle on a destination outside the user's folder (FR-MCP-04-BETA-03A-SIMPLE-01)", { timeout: 180_000, skip: AWAY_SKIP }, () => {
    test("a directory with other files: install in the proposed subfolder, repair, crashed and failed upgrade, upgrade, uninstall twice; the other files and the chosen folder stay intact", async () => {
        const { base, volume } = machine()
        const apps = path.join(volume, "Applicazioni é")
        fs.mkdirSync(path.join(apps, "Altro programma"), { recursive: true })
        fs.writeFileSync(path.join(apps, "Altro programma", "app.exe"), "someone else's program")
        fs.writeFileSync(path.join(apps, "leggimi.txt"), "mine")
        const appsBefore = snapshotDir(apps)
        const first = await chooseDirectory(base, apps, "0.1.0")
        assert.deepEqual([first.canonical, first.adjusted, first.mode], [path.join(apps, "FluentReaderMCP"), "not-empty", "new"])
        const w: World = { ...base, installDir: first.canonical, confirmedMode: first.mode }
        execCalls.length = 0
        assert.equal(await install(w, "0.1.0"), "installed")
        assert.equal((JSON.parse(fs.readFileSync(path.join(w.installDir, RECORD_NAME), "utf8")) as { installDir: string }).installDir, w.installDir)
        assert.equal(w.reg.keys.get(UNINSTALL_KEY)?.get("InstallLocation")?.value, w.installDir)
        assert.equal(w.reg.keys.get(SETTINGS_KEY)?.get("InstallDir")?.value, w.installDir)
        // repair: the same destination, chosen directly or again through its parent
        for (const chosen of [w.installDir, apps]) {
            const again = await chooseDirectory(base, chosen, "0.1.0")
            assert.deepEqual([again.canonical, again.mode], [w.installDir, "repair"], chosen)
        }
        w.confirmedMode = "repair"
        assert.equal(await install(w, "0.1.0"), "installed")
        const v1 = snapshot(w)
        // upgrade: a crash, then the next start restores 0.1.0; a failure, then the rollback restores it
        assert.equal((await chooseDirectory(base, w.installDir, "0.2.0")).mode, "upgrade")
        w.confirmedMode = "upgrade"
        assert.equal(await install(w, "0.2.0", { at: "after-uninstaller", mode: "crash" }), "crashed")
        assert.equal(await txRecover(w), false)
        assert.equal(await finishByHand(w), true)
        assert.deepEqual(snapshot(w), v1)
        assert.equal(await install(w, "0.2.0", { at: "after-uninstaller", mode: "fail" }), "rollback-incomplete")
        assert.equal(await finishByHand(w), true)
        assert.deepEqual(snapshot(w), v1)
        assert.equal(await install(w, "0.2.0"), "installed")
        assert.equal(snapshot(w).version, "0.2.0")
        // a file of the user inside the installation: kept; a repeated uninstallation finds nothing of its own
        fs.writeFileSync(path.join(w.installDir, "mie note é.txt"), "mine")
        assert.equal(await uninstall(w), "uninstalled")
        assert.deepEqual(fs.readdirSync(w.installDir), ["mie note é.txt"])
        for (const slot of REGISTRY_SLOTS) assert.equal(w.reg.valueType(KEYS[slot.key], slot.name), "absent")
        assert.equal(await uninstall(w), "not-recognised")
        assert.deepEqual(fs.readdirSync(w.installDir), ["mie note é.txt"])
        fs.rmSync(path.join(w.installDir, "mie note é.txt"))
        fs.rmdirSync(w.installDir)
        assert.deepEqual(snapshotDir(apps), appsBefore, "the chosen folder and the other programs are exactly as before")
        assert.deepEqual(execCalls, [], "no program started by the helper: no permission tool, no elevation")
    })

    test("a new directory on another volume is used as chosen; after the uninstallation only what the installer created is gone", async () => {
        const { base, volume } = machine()
        fs.writeFileSync(path.join(volume, "altro.txt"), "not ours")
        const chosen = path.join(volume, "Miei Programmi", "Reader MCP 😀")
        const choice = await chooseDirectory(base, chosen, "0.1.0")
        assert.deepEqual([choice.canonical, choice.adjusted, choice.mode], [chosen, "", "new"])
        const w: World = { ...base, installDir: choice.canonical, confirmedMode: choice.mode }
        assert.equal(await install(w, "0.1.0"), "installed")
        assert.equal(await uninstall(w), "uninstalled")
        assert.equal(fs.existsSync(chosen), false, "the empty installation directory is removed (RMDir, never recursive)")
        assert.deepEqual(fs.readdirSync(volume).sort(), ["Miei Programmi", "altro.txt"], "the parent created for it stays; nothing else touched")
        assert.equal(fs.readFileSync(path.join(volume, "altro.txt"), "utf8"), "not ours")
    })

    test("a drive root is never an installation directory: every command refuses it before touching anything", async () => {
        const { base } = machine()
        const driveRoot = root.slice(0, 3)
        for (const command of ["tx-recover", "tx-recover-finish", "tx-begin", "tx-prepare", "tx-swap", "tx-metadata", "tx-commit", "tx-cleanup", "un-status", "uninstall-preflight", "desktop-unregister", "un-begin", "remove-tree", "un-metadata", "un-finish", "finish-uninstall"]) {
            const r = await call(base, command, { installDir: driveRoot, version: "0.1.0", maxRelative: "150", bundleSha256: "a".repeat(64), profileDir: base.profile, expectMode: "new", transactionId: "ab".repeat(16), tree: "current", registryRestored: "yes", registryWritten: "yes" })
            assert.equal(r.code, 1, command)
            assert.match(r.one("message"), /non può essere la radice di un'unità/, command)
        }
    })

    test("a junction appearing after the confirmation: the installation stops before writing; its target is untouched", async () => {
        const { base, volume, dir } = machine()
        const chosen = path.join(volume, "Reader")
        const choice = await chooseDirectory(base, chosen, "0.1.0")
        const elsewhere = path.join(dir, "Altrove é")
        fs.mkdirSync(elsewhere)
        fs.writeFileSync(path.join(elsewhere, "file.txt"), "elsewhere")
        fs.symlinkSync(elsewhere, chosen, "junction")
        const before = snapshotDir(elsewhere)
        const w: World = { ...base, installDir: choice.canonical, confirmedMode: choice.mode }
        assert.notEqual(await install(w, "0.1.0"), "installed")
        assert.match(w.lastMessage ?? "", /collegamento, una junction o un nome breve/)
        assert.deepEqual(snapshotDir(elsewhere), before)
    })

    test("a copied installation or an incoherent final marker in a custom location authorises nothing", async () => {
        const { base, volume } = machine()
        const choice = await chooseDirectory(base, path.join(volume, "Prima"), "0.1.0")
        const w: World = { ...base, installDir: choice.canonical, confirmedMode: choice.mode }
        assert.equal(await install(w, "0.1.0"), "installed")
        // the whole installation copied elsewhere: its record names the original directory
        const copy = path.join(volume, "Copia")
        fs.cpSync(w.installDir, copy, { recursive: true })
        const copyWorld: World = { ...base, installDir: copy }
        const copyBefore = snapshotDir(copy)
        assert.equal(await uninstall(copyWorld), "stopped")
        assert.match(copyWorld.lastMessage ?? "", /appartiene a un'altra cartella/)
        for (const tree of ["current", "previous", ".staging"]) assert.notEqual((await call(copyWorld, "remove-tree", { installDir: copy, tree })).code, 0, tree)
        assert.deepEqual(snapshotDir(copy), copyBefore)
        // a final marker written for another directory next to the real installation
        fs.writeFileSync(path.join(w.installDir, "state", "uninstall-final.marker"), encodeFinalMarker(copy, "cd".repeat(16), []))
        const before = snapshotDir(w.installDir)
        assert.equal(await uninstall(w), "stopped")
        assert.deepEqual(snapshotDir(w.installDir), before)
        assert.ok(fs.existsSync(path.join(w.installDir, "current", INVENTORY)))
    })
})

// ------------------------------------------------------------------ FR-MCP-04-BETA-03A-SIMPLE-01: corrections after the Codex review

describe("review Major 1 and Minor 1 in the lifecycle", { timeout: 180_000, skip: AWAY_SKIP }, () => {
    /** The install section up to tx-prepare, as the driver runs it, with something dropped in before tx-prepare. */
    async function upToPrepare(w: World, dropIn: () => void): Promise<{ prepare: number; session: string }> {
        fs.mkdirSync(w.installDir, { recursive: true })
        const begin = await call(w, "tx-begin", { installDir: w.installDir, version: "0.1.0", maxRelative: "150", bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "new" })
        assert.equal(begin.code, 0, begin.one("message"))
        const staging = path.join(w.installDir, ".staging")
        fs.mkdirSync(staging)
        fs.copyFileSync(path.join(payload("0.1.0"), INVENTORY), path.join(staging, INVENTORY))
        fs.cpSync(payload("0.1.0"), staging, { recursive: true, force: true })
        fs.writeFileSync(path.join(w.installDir, "state", "uninstall.exe.new"), "uninstaller 0.1.0")
        dropIn()
        const prepare = await call(w, "tx-prepare", { installDir: w.installDir, transactionId: begin.one("transactionId"), ...w.reg.backup() })
        return { prepare: prepare.code, session: begin.one("transactionId") }
    }

    test("Codex case through the installation: a directory with only someone else's uninstall.exe is refused, the file byte for byte unchanged", async () => {
        const { base, volume } = machine()
        const w: World = { ...base, installDir: path.join(volume, "Vecchio programma") }
        fs.mkdirSync(w.installDir)
        const foreign = Buffer.from("MZ someone else's uninstaller")
        fs.writeFileSync(path.join(w.installDir, "uninstall.exe"), foreign)
        const before = snapshotDir(w.installDir)
        assert.equal(await install(w, "0.1.0"), "refused")
        assert.match(w.lastMessage ?? "", /nomi usati da Fluent Reader MCP \(uninstall\.exe\)/)
        // even if the wizard were bypassed: tx-begin refuses on its own
        const r = await call(w, "tx-begin", { installDir: w.installDir, version: "0.1.0", maxRelative: "150", bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode: "new" })
        assert.equal(r.code, 1)
        assert.deepEqual(snapshotDir(w.installDir), before)
        assert.deepEqual(fs.readFileSync(path.join(w.installDir, "uninstall.exe")), foreign)
        assert.equal(w.reg.snapshot(), new FakeRegistry().snapshot(), "HKCU untouched")
    })

    test("an uninstall.exe or a current tree appearing after tx-begin: tx-prepare refuses, the rollback removes only the transaction's own files", async () => {
        for (const [what, drop, check] of [
            ["uninstall.exe", (dir: string) => fs.writeFileSync(path.join(dir, "uninstall.exe"), "someone else's"), (dir: string) => assert.equal(fs.readFileSync(path.join(dir, "uninstall.exe"), "utf8"), "someone else's")],
            ["current", (dir: string) => { fs.mkdirSync(path.join(dir, "current")); fs.writeFileSync(path.join(dir, "current", "x.txt"), "someone else's") }, (dir: string) => assert.equal(fs.readFileSync(path.join(dir, "current", "x.txt"), "utf8"), "someone else's")],
        ] as const) {
            const { base, volume } = machine()
            const w: World = { ...base, installDir: path.join(volume, "Reader") }
            const { prepare, session } = await upToPrepare(w, () => drop(w.installDir))
            assert.equal(prepare, 1, what)
            assert.match(w.lastMessage ?? "", new RegExp(`cambiata dopo l'inizio della transazione \\(${what === "current" ? "è comparsa una cartella current" : "è comparso un uninstall\\.exe"}\\): nulla viene spostato, sostituito o rimosso`), what)
            assert.equal(await txRecover(w, session), false, `${what}: the same run's id authorises nothing; the new uninstaller has no reference`)
            assert.equal(await finishByHand(w, session), true, what)
            check(w.installDir)
            assert.deepEqual(fs.readdirSync(w.installDir).filter((n) => n !== "state").sort(), [what], `${what}: only the foreign entry is left`)
            assert.deepEqual(fs.readdirSync(path.join(w.installDir, "state")), [], `${what}: no copy, no journal, no new uninstaller`)
        }
    })

    test("a crash after the record of a first installation or of an upgrade: the wizard shows the mode after the recovery, so the confirmed mode matches and the installation completes", async () => {
        // first installation: the record of the failed transaction is not taken for an installed version
        const { base, volume } = machine()
        const first: World = { ...base, installDir: path.join(volume, "Prima") }
        assert.equal(await install(first, "0.1.0", { at: "after-record", mode: "crash" }), "crashed")
        assert.ok(fs.existsSync(path.join(first.installDir, RECORD_NAME)), "the new record is there")
        const shown = await chooseDirectory(first, first.installDir, "0.1.0")
        assert.deepEqual([shown.canonical, shown.mode], [first.installDir, "new"])
        first.confirmedMode = shown.mode
        // the next start: nothing proves the journal of a first installation, so its record and new uninstaller stay
        const stuck = snapshotDir(first.installDir)
        assert.equal(await install(first, "0.1.0"), "recovery-failed")
        assert.match(first.lastMessage ?? "", /state\\uninstall\.exe\.new \(nuovo disinstallatore[^)]*\); fluent-reader-mcp\.install\.json \(registro scritto da questa transazione[^)]*\)\. Nulla è stato rimosso/)
        assert.deepEqual(snapshotDir(first.installDir), stuck)
        fs.rmSync(path.join(first.installDir, RECORD_NAME))
        fs.rmSync(path.join(first.installDir, "state", "uninstall.exe.new"))
        assert.equal(await install(first, "0.1.0"), "installed")

        // upgrade: the previous version is what the recovery restores
        const upgrade: World = { ...base, installDir: path.join(volume, "Aggiornata") }
        assert.equal(await install(upgrade, "0.1.0"), "installed")
        assert.equal(await install(upgrade, "0.2.0", { at: "after-record", mode: "crash" }), "crashed")
        const again = await chooseDirectory(upgrade, upgrade.installDir, "0.2.0")
        assert.equal(again.mode, "upgrade")
        upgrade.confirmedMode = again.mode
        assert.equal(await install(upgrade, "0.2.0"), "recovery-failed", "the new record and uninstaller have no independent reference")
        assert.deepEqual(removeNamedByHand(upgrade).sort(), [RECORD_NAME, path.join("state", "uninstall.exe.new")].sort())
        assert.equal(await install(upgrade, "0.2.0"), "installed", (upgrade.refusals ?? []).join(" | "))
        assert.equal(snapshot(upgrade).version, "0.2.0")
        // a stale confirmation is refused before any write
        upgrade.confirmedMode = "new"
        const before = snapshotDir(upgrade.installDir)
        assert.equal(await install(upgrade, "0.2.0"), "refused")
        assert.match(upgrade.lastMessage ?? "", /cambiata dopo la conferma \(attesa: new, trovata: repair\)/)
        assert.deepEqual(snapshotDir(upgrade.installDir), before)
    })
})

// ------------------------------------------------------------------ FR-MCP-04-BETA-03A-SIMPLE-01: final review (ownership and recovery)

/** The section's first steps for `version`: tx-begin, extraction (inventory first), WriteUninstaller. Returns $TxId. */
async function startTx(w: World, version: string, expectMode: string): Promise<string> {
    w.setupVersion = version
    fs.mkdirSync(w.installDir, { recursive: true })
    const begin = await call(w, "tx-begin", { installDir: w.installDir, version, maxRelative: "150", bundleSha256: "a".repeat(64), profileDir: w.profile, expectMode })
    assert.equal(begin.code, 0, begin.one("message"))
    const staging = path.join(w.installDir, ".staging")
    fs.mkdirSync(staging)
    fs.copyFileSync(path.join(payload(version), INVENTORY), path.join(staging, INVENTORY))
    fs.cpSync(payload(version), staging, { recursive: true, force: true })
    fs.writeFileSync(path.join(w.installDir, "state", "uninstall.exe.new"), `uninstaller ${version}`)
    return begin.one("transactionId")
}

function prepare(w: World, transactionId: string): ReturnType<typeof call> {
    return call(w, "tx-prepare", { installDir: w.installDir, transactionId, ...w.reg.backup() })
}

/** A journal rewritten with a recomputed checksum (consistent, so readJournal accepts it: it proves nothing about its author). */
function rewriteJournal(w: World, change: (body: Record<string, unknown>) => Record<string, unknown>): void {
    const file = path.join(w.installDir, "state", "install-journal.json")
    const { checksum: _checksum, ...body } = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    const next = change(body)
    fs.writeFileSync(file, JSON.stringify({ ...next, checksum: crypto.createHash("sha256").update(canonicalJson(next)).digest("hex") }, null, 2))
}

function synthRecord(installDir: string, generation: string, profileDir: string, version = "0.1.0"): string {
    return `${JSON.stringify({ schemaVersion: 1, product: "fluent-reader-mcp", installDir, generation, version, bundleSha256: "a".repeat(64), installedAt: "2026-10-28T10:00:00.000Z", profileDir, claude: null }, null, 2)}\n`
}

describe("final review Major 1: what tx-begin found is checked again before anything is moved, replaced or deleted", { timeout: 180_000, skip: AWAY_SKIP }, () => {
    test("Codex sequence: tx-begin on an empty directory, then someone else's uninstall.exe and a valid record of another directory; tx-prepare refuses; both files byte for byte unchanged after the rollback and after a next start", async () => {
        for (const ending of ["rollback of the same run", "crash, then the next start"] as const) {
            const { base, volume } = machine()
            const w: World = { ...base, installDir: path.join(volume, "Vuota") }
            const tx = await startTx(w, "0.1.0", "new")
            const foreign = Buffer.from("MZ someone else's uninstaller \u0000\u0001")
            fs.writeFileSync(path.join(w.installDir, "uninstall.exe"), foreign)
            const record = synthRecord(path.join(volume, "Altra cartella"), "cd".repeat(16), w.profile)
            fs.writeFileSync(path.join(w.installDir, RECORD_NAME), record)
            const r = await prepare(w, tx)
            assert.equal(r.code, 1, ending)
            assert.match(r.one("message"), /il registro di installazione presente appartiene a un'altra cartella: nulla viene spostato, sostituito o rimosso/, ending)
            assert.equal(fs.existsSync(path.join(w.installDir, "state", "uninstall.exe.previous")), false)
            if (ending === "rollback of the same run") {
                assert.equal(await txRecover(w, tx), false, "the same run's id authorises nothing")
                assert.equal(await finishByHand(w, tx), true)
                assert.deepEqual(fs.readdirSync(w.installDir).sort(), [RECORD_NAME, "state", "uninstall.exe"].sort(), "only the transaction's own files went")
                assert.deepEqual(fs.readdirSync(path.join(w.installDir, "state")), [])
            } else {
                const stuck = snapshotDir(w.installDir)
                assert.equal(await txRecover(w), false)
                assert.match(w.lastMessage ?? "", /stato verificato: state\\uninstall\.exe\.new \(nuovo disinstallatore[^)]*\)\. Nulla è stato rimosso/, "uninstall.exe and the record are not targets of this rollback")
                assert.deepEqual(snapshotDir(w.installDir), stuck)
            }
            assert.deepEqual(fs.readFileSync(path.join(w.installDir, "uninstall.exe")), foreign, `${ending}: uninstall.exe untouched`)
            assert.equal(fs.readFileSync(path.join(w.installDir, RECORD_NAME), "utf8"), record, `${ending}: record untouched`)
            assert.equal(w.reg.snapshot(), "[]", `${ending}: nothing registered`)
        }
    })

    test("upgrade: a record that appears, is replaced or removed, an uninstall.exe replaced, a current tree changed after tx-begin: refused at tx-prepare, the changed file kept as it is; the authentic state still upgrades", async () => {
        const cases: [string, (w: World) => string, RegExp][] = [
            ["record replaced (valid, same directory, other generation)", (w) => {
                const file = path.join(w.installDir, RECORD_NAME)
                fs.writeFileSync(file, synthRecord(w.installDir, "cd".repeat(16), w.profile))
                return file
            }, /il registro di installazione è stato sostituito/],
            ["record of another directory", (w) => {
                const file = path.join(w.installDir, RECORD_NAME)
                fs.writeFileSync(file, synthRecord(path.join(w.home, "altrove"), "ab".repeat(16), w.profile))
                return file
            }, /appartiene a un'altra cartella/],
            ["record removed", (w) => {
                fs.rmSync(path.join(w.installDir, RECORD_NAME))
                return path.join(w.installDir, "uninstall.exe")
            }, /il registro di installazione è stato rimosso/],
            ["uninstall.exe replaced", (w) => {
                const file = path.join(w.installDir, "uninstall.exe")
                fs.writeFileSync(file, "someone else's uninstaller")
                return file
            }, /uninstall\.exe è stato sostituito/],
            ["current changed (its inventory rewritten with a foreign file)", (w) => {
                const current = path.join(w.installDir, "current")
                fs.writeFileSync(path.join(current, "foreign.txt"), "not ours")
                fs.writeFileSync(path.join(current, INVENTORY), JSON.stringify(buildInventory(current, "0.1.0")))
                return path.join(current, "foreign.txt")
            }, /la cartella current è cambiata/],
        ]
        for (const [label, tamper, message] of cases) {
            const { w } = await installedV1()
            const tx = await startTx(w, "0.2.0", "upgrade")
            const kept = tamper(w)
            const bytes = fs.readFileSync(kept)
            const r = await prepare(w, tx)
            assert.equal(r.code, 1, label)
            assert.match(r.one("message"), message, label)
            assert.equal(await txRecover(w, tx, "0.2.0"), false, `${label}: stopped at the new uninstaller`)
            assert.equal(await finishByHand(w, tx), true, label)
            assert.deepEqual(fs.readFileSync(kept), bytes, `${label}: kept as it is`)
            assert.deepEqual(snapshot(w).dirs, ["current"], `${label}: no .staging, no previous`)
            assert.deepEqual(snapshot(w).state, [], `${label}: no copy, no journal`)
        }
        // the authentic, unchanged state: upgrade, then repair
        const { w } = await installedV1()
        w.confirmedMode = "upgrade"
        assert.equal(await install(w, "0.2.0"), "installed")
        w.confirmedMode = "repair"
        assert.equal(await install(w, "0.2.0"), "installed")
        assert.equal(snapshot(w).version, "0.2.0")
    })

    test("later steps: tx-metadata refuses an uninstall.exe or a record changed after the swap; nothing foreign is moved or deleted, the recovery stops instead", async () => {
        for (const what of ["uninstall.exe", RECORD_NAME]) {
            const { w } = await installedV1()
            const tx = await startTx(w, "0.2.0", "upgrade")
            assert.equal((await prepare(w, tx)).code, 0)
            assert.equal((await call(w, "tx-swap", { installDir: w.installDir, transactionId: tx })).code, 0)
            const file = path.join(w.installDir, what)
            fs.writeFileSync(file, what === RECORD_NAME ? synthRecord(w.installDir, "cd".repeat(16), w.profile) : "someone else's uninstaller")
            const bytes = fs.readFileSync(file)
            const r = await call(w, "tx-metadata", { installDir: w.installDir, transactionId: tx })
            assert.equal(r.code, 1, what)
            assert.match(r.one("message"), /è cambiato dopo l'inizio della transazione: non viene sostituito/, what)
            assert.equal(fs.existsSync(path.join(w.installDir, "state", "uninstall.exe.previous")), false, what)
            assert.equal(await txRecover(w, tx, "0.2.0"), false, `${what}: not the previous one, not this transaction's: the recovery stops`)
            assert.deepEqual(fs.readFileSync(file), bytes, `${what}: untouched`)
            assert.equal(journalPhase(w), "metadata", `${what}: journal kept`)
        }
    })

    test("cleanup after the commit: a previous tree with a foreign file (its inventory rewritten) or a replaced uninstall.exe.previous is not removed; the authentic leftovers are", async () => {
        const cases: [string, (w: World) => string, RegExp][] = [
            ["previous with a foreign file", (w) => {
                const previous = path.join(w.installDir, "previous")
                fs.writeFileSync(path.join(previous, "foreign.txt"), "not ours")
                fs.writeFileSync(path.join(previous, INVENTORY), JSON.stringify(buildInventory(previous, "0.1.0")))
                return path.join(previous, "foreign.txt")
            }, /previous \(il suo inventario è cambiato dall'inizio della transazione\)/],
            ["uninstall.exe.previous replaced", (w) => {
                const file = path.join(w.installDir, "state", "uninstall.exe.previous")
                fs.writeFileSync(file, "someone else's")
                return file
            }, /state\\uninstall\.exe\.previous \(non è il disinstallatore che l'installazione aveva all'inizio della transazione\)/],
        ]
        for (const [label, tamper, message] of cases) {
            const { w } = await installedV1()
            w.confirmedMode = "upgrade"
            assert.equal(await install(w, "0.2.0", { at: "after-commit", mode: "crash" }), "crashed")
            const kept = tamper(w)
            const bytes = fs.readFileSync(kept)
            assert.equal(await txRecover(w, "", "0.2.0"), false, label)
            assert.match(w.lastMessage ?? "", message, label)
            assert.deepEqual(fs.readFileSync(kept), bytes, `${label}: kept`)
            assert.equal(journalPhase(w), "committed", `${label}: journal kept`)
        }
        const { w } = await installedV1()
        w.confirmedMode = "upgrade"
        assert.equal(await install(w, "0.2.0", { at: "after-commit", mode: "crash" }), "crashed")
        assert.equal(await txRecover(w, "", "0.2.0"), true, "anchored by the copy of the previous record")
        assert.deepEqual(snapshot(w).dirs, ["current"])
        assert.deepEqual(snapshot(w).state, [])
    })

    test("journals of earlier setups (no initial state): an upgrade is not restored from them (refused before any change); a new installation with only payload files is still cleaned", async () => {
        const { w, before: _before } = await installedV1()
        assert.equal(await install(w, "0.2.0", { at: "after-uninstaller", mode: "crash" }), "crashed")
        rewriteJournal(w, ({ initial: _i, staged: _s, ...legacy }) => legacy)
        const stuck = snapshotDir(w.installDir)
        assert.equal(await txRecover(w, "", "0.2.0"), false)
        assert.match(w.lastMessage ?? "", /il journal è di un setup precedente e non registra lo stato iniziale della cartella/)
        assert.deepEqual(snapshotDir(w.installDir), stuck, "nothing changed")
        // a first installation that stopped after the extraction, journal of an earlier setup
        const { base, volume } = machine()
        const fresh: World = { ...base, installDir: path.join(volume, "Legacy") }
        await startTx(fresh, "0.1.0", "new")
        fs.rmSync(path.join(fresh.installDir, "state", "uninstall.exe.new")) // stopped before WriteUninstaller
        rewriteJournal(fresh, ({ initial: _i, staged: _s, ...legacy }) => legacy)
        assert.equal(await txRecover(fresh), true)
        assert.deepEqual(fs.readdirSync(fresh.installDir), ["state"])
        assert.deepEqual(fs.readdirSync(path.join(fresh.installDir, "state")), [])
    })
})

describe("final review Major 2: a consistent journal and a local inventory authorise no deletion", { timeout: 180_000, skip: AWAY_SKIP }, () => {
    /** Codex construction: .staging\foreign.txt, an inventory that lists it (real hashes), a staging journal with a valid checksum. */
    function forged(w: World, withInitial: boolean): Buffer {
        const staging = path.join(w.installDir, ".staging")
        fs.mkdirSync(staging, { recursive: true })
        const foreign = Buffer.from("someone else's document é")
        fs.writeFileSync(path.join(staging, "foreign.txt"), foreign)
        fs.writeFileSync(path.join(staging, INVENTORY), JSON.stringify(buildInventory(staging, "0.1.0")))
        fs.mkdirSync(path.join(w.installDir, "state"), { recursive: true })
        const body: Record<string, unknown> = {
            schemaVersion: 1, product: "fluent-reader-mcp", kind: "install-journal", installDir: w.installDir, transactionId: "ef".repeat(16), createdAt: "2026-10-28T10:00:00.000Z",
            phase: "staging", target: { version: "0.1.0", bundleSha256: "a".repeat(64), profileDir: w.profile }, previous: null, registry: null,
            ...(withInitial && {
                initial: { record: null, uninstallerSha256: null, current: null },
                staged: { inventorySha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(staging, INVENTORY))).digest("hex"), uninstallerSha256: null },
            }),
        }
        fs.writeFileSync(path.join(w.installDir, "state", "install-journal.json"), JSON.stringify({ ...body, checksum: crypto.createHash("sha256").update(canonicalJson(body)).digest("hex") }))
        return foreign
    }

    test("Codex sequence: the directory is accepted by the wizard check (nothing is deleted there), the recovery refuses, foreign.txt byte for byte unchanged, journal and inventory kept", async () => {
        for (const withInitial of [false, true]) {
            const { base, volume } = machine()
            const w: World = { ...base, installDir: path.join(volume, `Costruita ${withInitial ? "nuova" : "legacy"}`) }
            const foreign = forged(w, withInitial)
            const before = snapshotDir(w.installDir)
            const check = await call(w, "check-install-dir", { installDir: w.installDir, version: "0.1.0", maxRelative: "150" })
            assert.equal(check.one("mode"), "new", "the check only classifies: the journal makes the layout look like an interrupted installation")
            assert.equal(await txRecover(w), false)
            assert.match(w.lastMessage ?? "", /ripristino automatico non è possibile: [^]*\.staging \(contiene un file non previsto: foreign\.txt\)\. Nulla è stato rimosso/)
            assert.deepEqual(fs.readFileSync(path.join(w.installDir, ".staging", "foreign.txt")), foreign)
            assert.deepEqual(snapshotDir(w.installDir), before, "inventory, journal and .staging kept")
            // the whole installation stops there too
            w.confirmedMode = "new"
            assert.equal(await install(w, "0.1.0"), "recovery-failed")
            assert.deepEqual(snapshotDir(w.installDir), before)
        }
    })

    test("only an inventory independent of the directory counts: the forged one passed as payload, a payload of another version, a local inventory with a path out of the tree: refused, nothing removed", async () => {
        const { base, volume } = machine()
        const w: World = { ...base, installDir: path.join(volume, "Costruita") }
        const foreign = forged(w, true)
        const before = snapshotDir(w.installDir)
        for (const payloadInventory of [path.join(w.installDir, ".staging", INVENTORY), path.join(payload("0.2.0"), INVENTORY)]) {
            const r = await call(w, "tx-recover", { installDir: w.installDir, payloadInventory, sessionTransactionId: "" })
            assert.equal(r.code, 1, payloadInventory)
            assert.deepEqual(snapshotDir(w.installDir), before, payloadInventory)
        }
        assert.deepEqual(fs.readFileSync(path.join(w.installDir, ".staging", "foreign.txt")), foreign)
        // payload files, but a local inventory naming a file outside the tree
        const other: World = { ...base, installDir: path.join(volume, "Percorso fuori") }
        await startTx(other, "0.1.0", "new")
        fs.rmSync(path.join(other.installDir, "state", "uninstall.exe.new"))
        const outside = path.join(volume, "fuori.txt")
        fs.writeFileSync(outside, "outside the installation")
        const inventory = JSON.parse(fs.readFileSync(path.join(other.installDir, ".staging", INVENTORY), "utf8")) as { files: { path: string; size: number; sha256: string }[] }
        inventory.files.push({ path: "../../fuori.txt", size: 24, sha256: "0".repeat(64) })
        fs.writeFileSync(path.join(other.installDir, ".staging", INVENTORY), JSON.stringify(inventory))
        const otherBefore = snapshotDir(other.installDir)
        assert.equal(await txRecover(other), false)
        assert.deepEqual(snapshotDir(other.installDir), otherBefore)
        assert.equal(fs.readFileSync(outside, "utf8"), "outside the installation")
    })

    test("files added by someone else to a real interrupted installation: refused at the next start and in the same run; the payload's own files alone are recovered", async () => {
        for (const ending of ["next start", "same run"] as const) {
            const { base, volume } = machine()
            const w: World = { ...base, installDir: path.join(volume, `Interrotta ${ending}`) }
            const tx = await startTx(w, "0.1.0", "new")
            fs.rmSync(path.join(w.installDir, "state", "uninstall.exe.new")) // stopped at the verification, before WriteUninstaller
            fs.writeFileSync(path.join(w.installDir, ".staging", "app", "aggiunto.txt"), "someone else's")
            const before = snapshotDir(w.installDir)
            assert.equal(await txRecover(w, ending === "same run" ? tx : ""), false, ending)
            assert.deepEqual(snapshotDir(w.installDir), before, ending)
            fs.rmSync(path.join(w.installDir, ".staging", "app", "aggiunto.txt"))
            assert.equal(await txRecover(w, ending === "same run" ? tx : ""), true, `${ending}: payload files only`)
            assert.deepEqual(fs.readdirSync(w.installDir), ["state"], ending)
        }
    })

    test("recoveries: automatic when every target is attributable, otherwise stopped before any change and completed once the named files are removed by hand", async () => {
        const { base, volume } = machine()
        // before WriteUninstaller: payload files only, automatic
        const early: World = { ...base, installDir: path.join(volume, "Prima di WriteUninstaller") }
        await startTx(early, "0.1.0", "new")
        fs.rmSync(path.join(early.installDir, "state", "uninstall.exe.new"))
        assert.equal(await txRecover(early), true)
        assert.deepEqual(fs.readdirSync(early.installDir), ["state"])
        assert.deepEqual(fs.readdirSync(path.join(early.installDir, "state")), [])
        // refused at tx-prepare (new installation): the new uninstaller has no reference
        const w: World = { ...base, installDir: path.join(volume, "Nuova") }
        w.reg.write(UNINSTALL_KEY, "DisplayName", "REG_BINARY", "00")
        assert.equal(await install(w, "0.1.0"), "rollback-incomplete")
        assert.equal(await finishByHand(w), true)
        assert.deepEqual(fs.readdirSync(w.installDir), ["state"])
        assert.deepEqual(fs.readdirSync(path.join(w.installDir, "state")), [])
        // failure after the swap of a new installation: the new uninstaller and record are named
        const fresh: World = { ...base, installDir: path.join(volume, "Nuova 2"), reg: new FakeRegistry() }
        assert.equal(await install(fresh, "0.1.0", { at: "after-uninstaller", mode: "fail" }), "rollback-incomplete")
        assert.equal(await finishByHand(fresh), true)
        assert.deepEqual(fs.readdirSync(fresh.installDir), ["state"])
        assert.equal(fresh.reg.snapshot(), "[]")
        // upgrade crash at the next start: the new uninstaller is named; removed by hand, 0.1.0 is back exactly
        const { w: upgraded, before } = await installedV1()
        assert.equal(await install(upgraded, "0.2.0", { at: "after-second-rename", mode: "crash" }), "crashed")
        assert.equal(await txRecover(upgraded), false)
        assert.equal(await finishByHand(upgraded), true)
        assert.deepEqual(snapshot(upgraded), before)
    })

})

// ------------------------------------------------------------------ FR-MCP-04-BETA-03A-SIMPLE-01: corrective review (each target needs its own evidence)

describe("corrective review: correlation and integrity are not ownership", { timeout: 180_000, skip: AWAY_SKIP }, () => {
    const sha = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

    test("a matching transaction id authorises nothing: a constructed journal is refused with its own id as session; another id is refused as another transaction", async () => {
        const { base, volume } = machine()
        const w: World = { ...base, installDir: path.join(volume, "Costruita") }
        const staging = path.join(w.installDir, ".staging")
        fs.mkdirSync(staging, { recursive: true })
        const foreign = Buffer.from("someone else's document")
        fs.writeFileSync(path.join(staging, "foreign.txt"), foreign)
        fs.writeFileSync(path.join(staging, INVENTORY), JSON.stringify(buildInventory(staging, "0.1.0")))
        fs.mkdirSync(path.join(w.installDir, "state"))
        const body = {
            schemaVersion: 1, product: "fluent-reader-mcp", kind: "install-journal", installDir: w.installDir, transactionId: "ef".repeat(16), createdAt: "2026-10-28T10:00:00.000Z",
            phase: "staging", target: { version: "0.1.0", bundleSha256: "a".repeat(64), profileDir: w.profile }, previous: null, registry: null,
            initial: { record: null, uninstallerSha256: null, current: null }, staged: { inventorySha256: sha(path.join(staging, INVENTORY)), uninstallerSha256: null },
        }
        fs.writeFileSync(path.join(w.installDir, "state", "install-journal.json"), JSON.stringify({ ...body, checksum: crypto.createHash("sha256").update(canonicalJson(body)).digest("hex") }))
        const before = snapshotDir(w.installDir)
        assert.equal(await txRecover(w, "ef".repeat(16)), false, "its own id as session")
        assert.match(w.lastMessage ?? "", /\.staging \(contiene un file non previsto: foreign\.txt\)/)
        assert.equal(await txRecover(w, "12".repeat(16)), false, "another id")
        assert.match(w.lastMessage ?? "", /si riferisce a un'altra transazione di installazione rispetto al journal presente/)
        assert.deepEqual(snapshotDir(w.installDir), before, "files, inventory and journal untouched")
        assert.deepEqual(fs.readFileSync(path.join(staging, "foreign.txt")), foreign)
    })

    test("a recognised record does not make the journal's claims true: a foreign new uninstaller or a foreign file in .staging, declared in the journal with their hashes, are kept", async () => {
        for (const claim of ["uninstall.exe.new", ".staging"] as const) {
            const { w } = await installedV1()
            const tx = await startTx(w, "0.2.0", "upgrade")
            const target = claim === "uninstall.exe.new" ? path.join(w.installDir, "state", "uninstall.exe.new") : path.join(w.installDir, ".staging", "app", "foreign.txt")
            fs.writeFileSync(target, "someone else's file")
            const staging = path.join(w.installDir, ".staging")
            if (claim === ".staging") fs.writeFileSync(path.join(staging, INVENTORY), JSON.stringify(buildInventory(staging, "0.2.0")))
            rewriteJournal(w, (body) => ({ ...body, staged: { inventorySha256: sha(path.join(staging, INVENTORY)), uninstallerSha256: sha(path.join(w.installDir, "state", "uninstall.exe.new")) } }))
            const before = snapshotDir(w.installDir)
            assert.equal(await txRecover(w, tx), false, claim)
            assert.match(w.lastMessage ?? "", claim === "uninstall.exe.new" ? /state\\uninstall\.exe\.new \(nuovo disinstallatore/ : /\.staging \(contiene un file non previsto: app\/foreign\.txt\)/, claim)
            assert.deepEqual(snapshotDir(w.installDir), before, `${claim}: nothing removed`)
            assert.equal(fs.readFileSync(target, "utf8"), "someone else's file", claim)
            assert.equal(snapshot(w).version, "0.1.0", `${claim}: the recognised installation is untouched`)
        }
    })

    test("a file modified without touching its inventory is found before the cleanup, the swap and the restore; nothing is moved or removed", async () => {
        const modify = (file: string): Buffer => {
            fs.writeFileSync(file, "modified by someone, inventory left as it was")
            return fs.readFileSync(file)
        }
        // cleanup after the commit: previous
        {
            const { w } = await installedV1()
            w.confirmedMode = "upgrade"
            assert.equal(await install(w, "0.2.0", { at: "after-commit", mode: "crash" }), "crashed")
            const file = path.join(w.installDir, "previous", "app", "server", "dist", "main.js")
            const bytes = modify(file)
            const before = snapshotDir(w.installDir)
            assert.equal(await txRecover(w), false)
            assert.match(w.lastMessage ?? "", /previous \(contiene un file modificato: app\/server\/dist\/main\.js\)/)
            assert.deepEqual(fs.readFileSync(file), bytes)
            assert.deepEqual(snapshotDir(w.installDir), before)
            assert.equal(journalPhase(w), "committed")
        }
        // swap: the installed tree, then the staged one
        for (const tree of ["current", ".staging"] as const) {
            const { w } = await installedV1()
            const tx = await startTx(w, "0.2.0", "upgrade")
            assert.equal((await prepare(w, tx)).code, 0)
            const file = path.join(w.installDir, tree, "app", "server", "dist", "main.js")
            const bytes = modify(file)
            const r = await call(w, "tx-swap", { installDir: w.installDir, transactionId: tx })
            assert.equal(r.code, 1, tree)
            assert.match(r.one("message"), /contiene un file modificato: app\/server\/dist\/main\.js\): nulla viene spostato/, tree)
            assert.deepEqual(fs.readFileSync(file), bytes, tree)
            assert.deepEqual(snapshot(w).dirs, [".staging", "current"], `${tree}: nothing renamed`)
            assert.equal(journalPhase(w), "prepared", tree)
        }
        // restore: the previous version to put back
        {
            const { w } = await installedV1()
            assert.equal(await install(w, "0.2.0", { at: "after-second-rename", mode: "crash" }), "crashed")
            const file = path.join(w.installDir, "previous", "app", "server", "dist", "main.js")
            const bytes = modify(file)
            const before = snapshotDir(w.installDir)
            assert.equal(await txRecover(w), false)
            assert.match(w.lastMessage ?? "", /previous \(contiene un file modificato: app\/server\/dist\/main\.js\)/)
            assert.deepEqual(snapshotDir(w.installDir), before, "both trees left as they are")
            assert.deepEqual(fs.readFileSync(file), bytes)
        }
    })

    test("only the payload the running helper was shipped with counts: an inventory path in the request is ignored, a payload that does not describe the running code is not used", async () => {
        const { base, volume, dir } = machine()
        // a .staging with a foreign file and an inventory outside the directory that lists it, passed in the request
        const w: World = { ...base, installDir: path.join(volume, "Richiesta") }
        const tx = await startTx(w, "0.1.0", "new")
        fs.rmSync(path.join(w.installDir, "state", "uninstall.exe.new"))
        fs.writeFileSync(path.join(w.installDir, ".staging", "foreign.txt"), "someone else's")
        const fake = path.join(dir, "Falso pacchetto")
        fs.cpSync(path.join(w.installDir, ".staging"), fake, { recursive: true })
        fs.writeFileSync(path.join(fake, INVENTORY), JSON.stringify(buildInventory(fake, "0.1.0")))
        const before = snapshotDir(w.installDir)
        const r = await call(w, "tx-recover", { installDir: w.installDir, payloadInventory: path.join(fake, INVENTORY), sessionTransactionId: tx })
        assert.equal(r.code, 1)
        assert.match(r.one("message"), /\.staging \(contiene un file non previsto: foreign\.txt\)/)
        assert.deepEqual(snapshotDir(w.installDir), before)
        // the payload root of the running helper whose setup files are not those its inventory lists: no reference at all
        const tampered = path.join(dir, "Pacchetto alterato")
        fs.cpSync(payload("0.1.0"), tampered, { recursive: true })
        fs.appendFileSync(path.join(tampered, ...SETUP_SCRIPT.split("/")), "\n// changed")
        const clean: World = { ...base, installDir: path.join(volume, "Pulita") }
        await startTx(clean, "0.1.0", "new")
        fs.rmSync(path.join(clean.installDir, "state", "uninstall.exe.new"))
        clean.payloadRoot = tampered
        const cleanBefore = snapshotDir(clean.installDir)
        assert.equal(await txRecover(clean), false)
        assert.match(clean.lastMessage ?? "", /il pacchetto del setup in esecuzione non è disponibile o non è verificabile/)
        assert.deepEqual(snapshotDir(clean.installDir), cleanBefore)
        // the real payload of the running helper: the same .staging is recovered
        clean.payloadRoot = undefined
        assert.equal(await txRecover(clean), true)
        assert.deepEqual(fs.readdirSync(clean.installDir), ["state"])
        // the helper script in the payload is where the builder puts it
        assert.equal(SETUP_SCRIPT, `setup/${SETUP_ENTRY}`)
    })

    test("ordinary paths still complete: new installation, upgrade, repair, uninstallation; a foreign file in the installation is kept by the uninstaller", async () => {
        const { base, volume } = machine()
        const w: World = { ...base, installDir: path.join(volume, "Ordinaria") }
        w.confirmedMode = "new"
        assert.equal(await install(w, "0.1.0"), "installed", (w.refusals ?? []).join(" | "))
        w.confirmedMode = "upgrade"
        assert.equal(await install(w, "0.2.0"), "installed", (w.refusals ?? []).join(" | "))
        w.confirmedMode = "repair"
        assert.equal(await install(w, "0.2.0"), "installed", (w.refusals ?? []).join(" | "))
        assert.deepEqual(snapshot(w).dirs, ["current"])
        assert.deepEqual(snapshot(w).state, [], "no previous, no copy, no journal left by the upgrade and the repair")
        assert.equal(snapshot(w).uninstaller, "uninstaller 0.2.0")
        fs.writeFileSync(path.join(w.installDir, "current", "app", "mine.txt"), "mine")
        assert.equal(await uninstall(w), "stopped", "a foreign file in current stops the uninstallation before anything is removed")
        assert.equal(fs.readFileSync(path.join(w.installDir, "current", "app", "mine.txt"), "utf8"), "mine")
        fs.renameSync(path.join(w.installDir, "current", "app", "mine.txt"), path.join(volume, "mine.txt"))
        assert.equal(await uninstall(w), "uninstalled")
        assert.equal(fs.existsSync(w.installDir), false)
        assert.equal(fs.readFileSync(path.join(volume, "mine.txt"), "utf8"), "mine")
    })
})

// ------------------------------------------------------------------ FR-MCP-04-BETA-03A-SIMPLE-01: the active version is verified before commit and cleanup

describe("final fix: the new active version is verified as a whole before the commit and before every cleanup", { timeout: 240_000, skip: AWAY_SKIP }, () => {
    /** The old version this transaction keeps, byte for byte: previous, the old uninstaller, the copy of the old record. */
    function oldVersion(w: World): { previous: Map<string, string> | null; uninstaller: Buffer | null; copy: Buffer | null } {
        const previous = path.join(w.installDir, "previous")
        const read = (f: string): Buffer | null => (fs.existsSync(f) ? fs.readFileSync(f) : null)
        return {
            previous: fs.existsSync(previous) ? snapshotDir(previous) : null,
            uninstaller: read(path.join(w.installDir, "state", "uninstall.exe.previous")),
            copy: read(path.join(w.installDir, "state", "install-record.previous.json")),
        }
    }

    /** What may happen to the new version after the swap, and how the refusal names it. */
    const tampering: [string, (w: World) => void, RegExp][] = [
        ["a file of current modified, inventory unchanged", (w) => fs.writeFileSync(path.join(w.installDir, "current", "app", "server", "dist", "main.js"), "// modified after the swap"), /current \(contiene un file modificato: app\/server\/dist\/main\.js\)/],
        ["a foreign file added to current", (w) => fs.writeFileSync(path.join(w.installDir, "current", "app", "estraneo.txt"), "not ours"), /current \(contiene un file non previsto: app\/estraneo\.txt\)/],
        ["an expected file missing from current", (w) => fs.rmSync(path.join(w.installDir, "current", "app", "PACKAGING-INFO.md")), /current \(manca app\/PACKAGING-INFO\.md\)/],
        ["the new uninstall.exe replaced", (w) => fs.writeFileSync(path.join(w.installDir, "uninstall.exe"), "someone else's uninstaller"), /uninstall\.exe \(non è il disinstallatore attivato da questa transazione\)/],
        ["the new record with another generation", (w) => fs.writeFileSync(path.join(w.installDir, RECORD_NAME), synthRecord(w.installDir, "cd".repeat(16), w.profile, "0.2.0")), /fluent-reader-mcp\.install\.json \(non è il registro scritto da questa transazione\)/],
        ["the new record bound to another directory", (w) => {
            const record = JSON.parse(fs.readFileSync(path.join(w.installDir, RECORD_NAME), "utf8")) as Record<string, unknown>
            fs.writeFileSync(path.join(w.installDir, RECORD_NAME), JSON.stringify({ ...record, installDir: path.join(w.home, "altrove") }, null, 2))
        }, /fluent-reader-mcp\.install\.json \(appartiene a un'altra cartella\)/],
    ]

    /** An upgrade 0.1.0 -> 0.2.0 driven up to tx-metadata, as the install section does (HKCU written meanwhile). */
    async function upToCommit(): Promise<{ w: World; tx: string }> {
        const { w } = await installedV1()
        const tx = await startTx(w, "0.2.0", "upgrade")
        assert.equal((await prepare(w, tx)).code, 0)
        for (const step of ["tx-swap", "tx-metadata"]) {
            const r = await call(w, step, { installDir: w.installDir, transactionId: tx })
            assert.equal(r.code, 0, `${step}: ${r.one("message")}`)
        }
        return { w, tx }
    }

    const commit = (w: World, tx: string): ReturnType<typeof call> => call(w, "tx-commit", { installDir: w.installDir, transactionId: tx, registryWritten: "yes" })

    test("before the commit: the intact new version is committed", async () => {
        const { w, tx } = await upToCommit()
        assert.equal((await commit(w, tx)).code, 0)
        assert.equal(journalPhase(w), "committed")
    })

    for (const [label, tamper, message] of tampering) {
        test(`before the commit: ${label}: not committed; previous, the old uninstaller, the record copy and the journal kept`, async () => {
            const { w, tx } = await upToCommit()
            const before = oldVersion(w)
            assert.ok(before.previous !== null && before.uninstaller !== null && before.copy !== null)
            tamper(w)
            const r = await commit(w, tx)
            assert.equal(r.code, 1)
            assert.match(r.one("message"), /la nuova versione non risulta integra: /)
            assert.match(r.one("message"), message)
            assert.equal(journalPhase(w), "metadata", "not declared committed")
            assert.deepEqual(oldVersion(w), before, "byte for byte")
        })
    }

    /** An upgrade that reached the commit, then stopped before its cleanup (the next start does it). */
    async function committed(): Promise<World> {
        const { w } = await installedV1()
        w.confirmedMode = "upgrade"
        assert.equal(await install(w, "0.2.0", { at: "after-commit", mode: "crash" }), "crashed")
        assert.equal(journalPhase(w), "committed")
        return w
    }

    test("before the cleanup: the intact active version lets the next start remove previous, the old uninstaller, the copy, then the journal", async () => {
        const w = await committed()
        assert.equal(await txRecover(w), true)
        assert.deepEqual(oldVersion(w), { previous: null, uninstaller: null, copy: null })
        assert.equal(journalPhase(w), null)
        assert.equal(snapshot(w).version, "0.2.0")
    })

    for (const [label, tamper, message] of tampering) {
        test(`before the cleanup: ${label}: nothing of the old version is removed`, async () => {
            const w = await committed()
            const before = oldVersion(w)
            tamper(w)
            assert.equal(await txRecover(w), false)
            assert.match(w.lastMessage ?? "", /la pulizia della versione precedente non è possibile/)
            assert.match(w.lastMessage ?? "", message)
            assert.deepEqual(oldVersion(w), before, "previous, old uninstaller and record copy byte for byte")
            assert.equal(journalPhase(w), "committed")
            // the same through tx-cleanup of the same run (its request is tx-commit's)
            const r = await call(w, "tx-cleanup", { installDir: w.installDir, transactionId: journalTxId(w), registryWritten: "yes" })
            assert.equal(r.code, 1)
            assert.deepEqual(oldVersion(w), before)
        })
    }

    test("before the cleanup, after a crash during it: some elements already gone; with the active version intact it completes, with it modified nothing more is removed; a repeated cleanup is idempotent", async () => {
        const crashDuringCleanup = async (): Promise<World> => {
            const w = await committed()
            w.txCheckpoint = (s) => {
                if (s === "during-cleanup") throw new Crash("crash during the cleanup")
            }
            assert.equal(await txRecover(w), false)
            w.txCheckpoint = undefined
            assert.equal(fs.existsSync(path.join(w.installDir, "previous")), false, "previous already removed")
            return w
        }
        // intact: completes, then a further start finds nothing to do
        const intact = await crashDuringCleanup()
        assert.equal(await txRecover(intact), true)
        assert.deepEqual(oldVersion(intact), { previous: null, uninstaller: null, copy: null })
        assert.equal(journalPhase(intact), null)
        const settled = snapshotDir(intact.installDir)
        assert.equal(await txRecover(intact), true, "no journal: nothing to do")
        assert.deepEqual(snapshotDir(intact.installDir), settled)
        // the active version modified after the crash: the old uninstaller and the copy stay
        const modified = await crashDuringCleanup()
        const before = oldVersion(modified)
        assert.ok(before.uninstaller !== null && before.copy !== null)
        fs.writeFileSync(path.join(modified.installDir, "current", "app", "server", "dist", "main.js"), "// modified")
        assert.equal(await txRecover(modified), false)
        assert.match(modified.lastMessage ?? "", /current \(contiene un file modificato: app\/server\/dist\/main\.js\)/)
        assert.deepEqual(oldVersion(modified), before)
        assert.equal(journalPhase(modified), "committed")
    })

    test("non-regression: a first installation and a repair are verified the same way and complete; a repair with a file missing from the installed tree still completes", async () => {
        const { base, volume } = machine()
        const w: World = { ...base, installDir: path.join(volume, "Prima") }
        w.confirmedMode = "new"
        assert.equal(await install(w, "0.1.0"), "installed", (w.refusals ?? []).join(" | "))
        fs.rmSync(path.join(w.installDir, "current", "app", "PACKAGING-INFO.md"))
        w.confirmedMode = "repair"
        assert.equal(await install(w, "0.1.0"), "installed", (w.refusals ?? []).join(" | "))
        assert.equal(fs.existsSync(path.join(w.installDir, "current", "app", "PACKAGING-INFO.md")), true, "the repair put the missing file back")
        assert.deepEqual(snapshot(w).state, [])
        assert.deepEqual(snapshot(w).dirs, ["current"])
    })
})

// ------------------------------------------------------------------ FR-MCP-04-BETA-03A-SIMPLE-01: one rename, no retry, never over anything

/** A rename primitive that records its calls and, for the renames `fails` selects, throws the given code instead. */
function recordingRename(calls: [string, string][], fails: (from: string, to: string) => string | null = () => null): (from: string, to: string) => void {
    return (from, to) => {
        calls.push([from, to])
        const code = fails(from, to)
        if (code !== null) throw Object.assign(new Error(`${code}: injected`), { code })
        fs.renameSync(from, to)
    }
}

describe("rename(): one call, the error as it is, nothing renamed over another entry", () => {
    function box(): string {
        counter++
        const dir = path.join(root, `rename ${counter}`)
        fs.mkdirSync(dir)
        return dir
    }

    test("succeeds at the first call", () => {
        const dir = box()
        fs.writeFileSync(path.join(dir, "a.txt"), "content a")
        const calls: [string, string][] = []
        rename(path.join(dir, "a.txt"), path.join(dir, "b.txt"), "prova", recordingRename(calls))
        assert.equal(calls.length, 1)
        assert.equal(fs.existsSync(path.join(dir, "a.txt")), false)
        assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "content a")
    })

    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
        test(`${code} comes back at once, after a single call; the source stays, nothing appears at the destination`, () => {
            const dir = box()
            fs.writeFileSync(path.join(dir, "a.txt"), "content a")
            const calls: [string, string][] = []
            assert.throws(() => rename(path.join(dir, "a.txt"), path.join(dir, "b.txt"), "prova", recordingRename(calls, () => code)), new RegExp(`^SetupRefusal: prova non riuscito \\(${code}\\)$`))
            assert.equal(calls.length, 1, "no second attempt")
            assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "content a")
            assert.equal(fs.existsSync(path.join(dir, "b.txt")), false)
        })
    }

    test("an existing destination (file or directory) is refused before any call; both are left byte for byte", () => {
        const dir = box()
        fs.writeFileSync(path.join(dir, "a.txt"), "content a")
        fs.writeFileSync(path.join(dir, "b.txt"), "someone else's b")
        fs.mkdirSync(path.join(dir, "src"))
        fs.writeFileSync(path.join(dir, "src", "x.txt"), "x")
        fs.mkdirSync(path.join(dir, "dst"))
        fs.writeFileSync(path.join(dir, "dst", "y.txt"), "someone else's y")
        const calls: [string, string][] = []
        assert.throws(() => rename(path.join(dir, "a.txt"), path.join(dir, "b.txt"), "prova", recordingRename(calls)), /prova: la destinazione esiste già e non viene sostituita/)
        assert.throws(() => rename(path.join(dir, "src"), path.join(dir, "dst"), "prova", recordingRename(calls)), /prova: la destinazione esiste già e non viene sostituita/)
        assert.equal(calls.length, 0)
        assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "content a")
        assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "someone else's b")
        assert.deepEqual(snapshotDir(path.join(dir, "src")), new Map([["x.txt", crypto.createHash("sha256").update("x").digest("hex")]]))
        assert.equal(fs.readFileSync(path.join(dir, "dst", "y.txt"), "utf8"), "someone else's y")
    })

    test("a missing source is an explicit failure before any call", () => {
        const dir = box()
        const calls: [string, string][] = []
        assert.throws(() => rename(path.join(dir, "missing.txt"), path.join(dir, "b.txt"), "prova", recordingRename(calls)), /prova: l'origine non esiste/)
        assert.equal(calls.length, 0)
        assert.equal(fs.existsSync(path.join(dir, "b.txt")), false)
    })
})

describe("a failed rename in the transaction: nothing retried, nothing removed, the journal kept for the recovery", { timeout: 180_000, skip: AWAY_SKIP }, () => {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
        test(`upgrade: ${code} on current -> previous: one call, the swap stops; installed version, record, uninstaller and copies kept; the recovery completes once the named files are removed`, async () => {
            const { w, before } = await installedV1()
            const record = fs.readFileSync(path.join(w.installDir, RECORD_NAME))
            const calls: [string, string][] = []
            w.rename = recordingRename(calls, (_from, to) => (path.basename(to) === "previous" ? code : null))
            w.confirmedMode = "upgrade"
            assert.equal(await install(w, "0.2.0"), "rollback-incomplete")
            assert.ok((w.refusals ?? []).some((m) => m === `spostamento della versione installata in previous non riuscito (${code})`), (w.refusals ?? []).join(" | "))
            assert.equal(calls.filter(([, to]) => path.basename(to) === "previous").length, 1, "no second attempt")
            assert.equal(journalPhase(w), "swapping", "journal kept")
            assert.equal(snapshot(w).version, "0.1.0")
            assert.deepEqual(fs.readFileSync(path.join(w.installDir, RECORD_NAME)), record, "record untouched")
            assert.deepEqual(fs.readFileSync(path.join(w.installDir, "state", "install-record.previous.json")), record, "the copy of the record kept")
            assert.equal(snapshot(w).uninstaller, before.uninstaller)
            assert.ok(fs.existsSync(path.join(w.installDir, ".staging", INVENTORY)), ".staging kept for the recovery")
            w.rename = undefined
            assert.equal(await finishByHand(w), true)
            assert.deepEqual(snapshot(w), before)
        })
    }

    test("repair: EPERM on .staging -> current after previous was made: one call each; the rollback that needs the same rename stops too; with renames working again the recovery restores 0.1.0", async () => {
        const { w, before } = await installedV1()
        const calls: [string, string][] = []
        w.rename = recordingRename(calls, (_from, to) => (path.basename(to) === "current" ? "EPERM" : null))
        w.confirmedMode = "repair"
        assert.equal(await install(w, "0.1.0"), "rollback-incomplete")
        assert.equal(calls.filter(([from, to]) => path.basename(from) === ".staging" && path.basename(to) === "current").length, 1, "no second attempt of the swap")
        assert.equal(calls.filter(([from, to]) => path.basename(from) === "previous" && path.basename(to) === "current").length, 1, "the rollback tried its own rename once")
        assert.deepEqual(snapshot(w).dirs, [".staging", "previous"])
        assert.equal(journalPhase(w), "swapping")
        assert.equal(readInventory(path.join(w.installDir, "previous")).version, "0.1.0", "the installed version kept in previous")
        w.rename = undefined
        assert.equal(await txRecover(w), true)
        assert.deepEqual(snapshot(w), before)
    })

    test("a destination already there is never replaced: previous before the swap, uninstall.exe.previous before the metadata; nothing moved, the foreign entries byte for byte", async () => {
        {
            const { w } = await installedV1()
            const tx = await startTx(w, "0.2.0", "upgrade")
            assert.equal((await prepare(w, tx)).code, 0)
            fs.mkdirSync(path.join(w.installDir, "previous"))
            fs.writeFileSync(path.join(w.installDir, "previous", "altro.txt"), "someone else's")
            const calls: [string, string][] = []
            w.rename = recordingRename(calls)
            const r = await call(w, "tx-swap", { installDir: w.installDir, transactionId: tx })
            assert.equal(r.code, 1)
            assert.match(r.one("message"), /la destinazione esiste già e non viene sostituita/)
            assert.deepEqual(calls, [], "no rename attempted")
            assert.equal(fs.readFileSync(path.join(w.installDir, "previous", "altro.txt"), "utf8"), "someone else's")
            assert.equal(readInventory(path.join(w.installDir, "current")).version, "0.1.0")
        }
        {
            const { w } = await installedV1()
            const tx = await startTx(w, "0.2.0", "upgrade")
            assert.equal((await prepare(w, tx)).code, 0)
            assert.equal((await call(w, "tx-swap", { installDir: w.installDir, transactionId: tx })).code, 0)
            const saved = path.join(w.installDir, "state", "uninstall.exe.previous")
            fs.writeFileSync(saved, "someone else's")
            const record = fs.readFileSync(path.join(w.installDir, RECORD_NAME))
            const uninstaller = fs.readFileSync(path.join(w.installDir, "uninstall.exe"))
            const r = await call(w, "tx-metadata", { installDir: w.installDir, transactionId: tx })
            assert.equal(r.code, 1)
            assert.match(r.one("message"), /state\\uninstall\.exe\.previous esiste già: non viene sostituito, nulla viene cambiato/)
            assert.equal(fs.readFileSync(saved, "utf8"), "someone else's")
            assert.deepEqual(fs.readFileSync(path.join(w.installDir, RECORD_NAME)), record, "the record is not rewritten either")
            assert.deepEqual(fs.readFileSync(path.join(w.installDir, "uninstall.exe")), uninstaller)
            assert.equal(journalPhase(w), "metadata")
        }
    })

    test("ordinary installation, upgrade and repair: each rename of the transaction called exactly once", async () => {
        const { base, volume } = machine()
        const w: World = { ...base, installDir: path.join(volume, "Una volta") }
        const calls: [string, string][] = []
        w.rename = recordingRename(calls)
        const names = (): string[] => calls.map(([from, to]) => `${path.basename(from)}->${path.basename(to)}`)
        w.confirmedMode = "new"
        assert.equal(await install(w, "0.1.0"), "installed")
        assert.deepEqual(names(), [".staging->current", "uninstall.exe.new->uninstall.exe"])
        calls.length = 0
        w.confirmedMode = "upgrade"
        assert.equal(await install(w, "0.2.0"), "installed")
        assert.deepEqual(names(), ["current->previous", ".staging->current", "uninstall.exe->uninstall.exe.previous", "uninstall.exe.new->uninstall.exe"])
        calls.length = 0
        w.confirmedMode = "repair"
        assert.equal(await install(w, "0.2.0"), "installed")
        assert.deepEqual(names(), ["current->previous", ".staging->current", "uninstall.exe->uninstall.exe.previous", "uninstall.exe.new->uninstall.exe"])
        assert.deepEqual(snapshot(w).state, [])
    })
})

describe("FR-MCP-04-BETA-03A-SIMPLE-02: copies of the Claude configuration left by an earlier setup, in the lifecycle", { timeout: 180_000 }, () => {
    const NAMES = ["claude.json.20261001T090000Z.bak", "claude.json.20261002T090000Z.bak"]

    /**
     * 0.1.0 as an earlier setup left it: a registration whose copy (NAMES[0], named in the record) is in
     * state\claude-config-backups; with `unreferenced`, also an older valid copy the record does not name (NAMES[1]).
     */
    async function withLegacyCopies(unreferenced = false): Promise<{ w: World; copies: Map<string, Buffer> }> {
        const w = world()
        w.reg.write(UNINSTALL_KEY, "SomeoneElse", "REG_SZ", "foreign value")
        assert.equal(await install(w, "0.1.0"), "installed")
        const file = path.join(w.installDir, RECORD_NAME)
        const app = path.join(w.installDir, "current", "app")
        const entry = { type: "stdio" as const, command: path.join(app, "runtime", "node.exe"), args: [path.join(app, "server", "dist", "main.js"), "--profile-dir", w.profile], env: {} }
        writeRecord(file, { ...(readRecord(file) as InstallRecord), claude: { state: "registered", name: "fluent-reader", scope: "user", configPath: path.join(w.home, ".claude.json"), claudeExe: path.join(w.home, "claude.exe"), entry, fingerprint: entryFingerprint(entry), backup: NAMES[0] as string, updatedAt: "2026-10-02T09:00:00.000Z" } })
        const legacy = path.join(w.installDir, "state", "claude-config-backups")
        fs.mkdirSync(legacy)
        const copies = new Map<string, Buffer>()
        for (const name of unreferenced ? NAMES : NAMES.slice(0, 1)) {
            const bytes = Buffer.from(JSON.stringify({ mcpServers: { other: { command: "x", env: { TOKEN: `synthetic ${name}` } } } }))
            fs.writeFileSync(path.join(legacy, name), bytes)
            if (name === NAMES[0]) copies.set(name, bytes)
        }
        return { w, copies }
    }

    function assertPrivate(w: World, copies: Map<string, Buffer>): string {
        const dir = privateBackupDir(w.env, w.installDir)
        assert.deepEqual(fs.readdirSync(dir).sort(), [...copies.keys()])
        for (const [name, bytes] of copies) assert.ok(fs.readFileSync(path.join(dir, name)).equals(bytes), name)
        assert.equal(fs.existsSync(path.join(w.installDir, "state", "claude-config-backups")), false)
        return dir
    }

    test("upgrade: tx-begin moves the named copy to the private directory and the record follows; cleanup and uninstall leave it there and say where", async () => {
        const { w, copies } = await withLegacyCopies()
        assert.equal(await install(w, "0.2.0"), "installed")
        assert.equal(snapshot(w).version, "0.2.0")
        const dir = assertPrivate(w, copies)
        const rec = readRecord(path.join(w.installDir, RECORD_NAME)) as InstallRecord
        assert.equal(rec.claude?.backup, NAMES[0])
        assert.equal(rec.claude?.backupDir, dir)
        fs.writeFileSync(path.join(w.installDir, "my notes é.txt"), "mine")
        assert.equal(await uninstall(w), "uninstalled")
        assertUninstalled(w)
        assertPrivate(w, copies)
        assert.ok(w.lastRun?.messages.some((m) => m.includes(`restano nella tua cartella personale ${dir}`)), JSON.stringify(w.lastRun?.messages))
        assert.equal(w.lastRun?.messages.some((m) => m.includes("versione precedente del setup")), false, "no old copy left to report")
    })

    test("an element there that is not attributable (another name; a valid copy the record does not name): the upgrade does not start, nothing is moved, the element is named", async () => {
        const cases: [string, boolean, RegExp][] = [
            ["another name", false, /notes\.txt \(nome non previsto\)/],
            ["an unreferenced valid copy", true, /claude\.json\.20261002T090000Z\.bak \(copia non indicata dal registro di installazione\)/],
        ]
        for (const [label, unreferenced, message] of cases) {
            const { w } = await withLegacyCopies(unreferenced)
            if (!unreferenced) fs.writeFileSync(path.join(w.installDir, "state", "claude-config-backups", "notes.txt"), "mine")
            const before = snapshot(w)
            const files = snapshotDir(path.join(w.installDir, "state", "claude-config-backups"))
            assert.equal(await install(w, "0.2.0"), "refused", label)
            assert.match(w.lastMessage ?? "", message, label)
            assert.match(w.lastMessage ?? "", /Nessun elemento è stato modificato, spostato o cancellato\. Prima di aggiornare o riparare serve un tuo intervento/, label)
            assert.deepEqual(snapshot(w), before, label)
            assert.deepEqual(snapshotDir(path.join(w.installDir, "state", "claude-config-backups")), files, label)
            assert.equal(fs.existsSync(path.join(w.home, "AppData", "Local", "FluentReaderMCP-Data")), false, label)
        }
    })

    test("the move done, then the upgrade refused for another reason: the private copy and the updated record stay", async () => {
        const { w, copies } = await withLegacyCopies()
        fs.mkdirSync(path.join(w.installDir, ".staging"))
        assert.equal(await install(w, "0.2.0"), "refused")
        assert.match(w.lastMessage ?? "", /\.staging esiste senza una transazione/)
        assert.equal(snapshot(w).version, "0.1.0")
        const dir = assertPrivate(w, copies)
        assert.equal((readRecord(path.join(w.installDir, RECORD_NAME)) as InstallRecord).claude?.backupDir, dir)
        fs.rmdirSync(path.join(w.installDir, ".staging"))
        assert.equal(await install(w, "0.2.0"), "installed")
        assertPrivate(w, copies)
    })

    test("a repair rolled back after the move: the installation and its record come back, the copies stay in the private directory", async () => {
        const { w, copies } = await withLegacyCopies()
        const generation = (readRecord(path.join(w.installDir, RECORD_NAME)) as InstallRecord).generation
        assert.equal(await install(w, "0.1.0", { at: "after-second-rename", mode: "fail" }), "rolled-back", w.lastMessage)
        const dir = assertPrivate(w, copies)
        const restored = readRecord(path.join(w.installDir, RECORD_NAME)) as InstallRecord
        assert.equal(restored.generation, generation, "the record of before the repair")
        assert.equal(restored.claude?.backupDir, dir, "the restored record points to the private copy")
        assert.equal(await install(w, "0.1.0"), "installed")
        assertPrivate(w, copies)
    })
})

describe("FR-MCP-04-BETA-UX-01: the Claude Desktop registration in the lifecycle", { timeout: 180_000 }, () => {
    const SECRET = "SYNTHETIC_SECRET_4d2a"
    const others = { "foundry-mcp": { command: "C:\\Tools\\foundry.exe", env: { KEY: SECRET } } }

    function desktopConfig(w: World): string {
        const file = path.join(w.home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ preferences: { sidebarMode: "chat" }, mcpServers: others }, null, 2))
        return file
    }

    const servers = (file: string): Record<string, unknown> => (JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers

    async function register(w: World, configPath: string, version: string): Promise<string> {
        const request = { installDir: w.installDir, version, maxRelative: "150", configPath, profileDir: w.profile }
        const plan = await call(w, "desktop-plan", request)
        assert.equal(plan.code, 0, plan.one("message"))
        const done = await call(w, "desktop-register", { ...request, planHash: plan.one("planHash"), consent: "yes" })
        assert.equal(done.code, 0, done.one("message"))
        return plan.one("action")
    }

    const record = (w: World): InstallRecord => readRecord(path.join(w.installDir, RECORD_NAME)) as InstallRecord

    test("new installation, repair, upgrade, uninstall: one entry, kept by every step, removed at the end; the other server and the backup stay", async () => {
        const w = world()
        w.reg.write(UNINSTALL_KEY, "SomeoneElse", "REG_SZ", "foreign value")
        const config = desktopConfig(w)
        assert.equal(await install(w, "0.1.0"), "installed")
        assert.equal(await register(w, config, "0.1.0"), "add")
        const registered = fs.readFileSync(config)
        const first = record(w)
        assert.equal(first.desktop?.state, "registered")
        const backups = privateDesktopBackupDir(w.env, w.installDir)
        const copies = snapshotDir(backups)
        assert.equal(copies.size, 1)
        // repair: a new generation, the same registration, nothing to do in the file
        assert.equal(await install(w, "0.1.0"), "installed")
        assert.notEqual(record(w).generation, first.generation)
        assert.deepEqual(record(w).desktop, first.desktop)
        assert.equal(await register(w, config, "0.1.0"), "none")
        // upgrade: the paths of the entry are those of current\, which stays where it is
        assert.equal(await install(w, "0.2.0"), "installed")
        assert.equal(record(w).version, "0.2.0")
        assert.deepEqual(record(w).desktop, first.desktop)
        assert.equal(await register(w, config, "0.2.0"), "none")
        assert.ok(fs.readFileSync(config).equals(registered), "the file was not touched again")
        assert.deepEqual(snapshotDir(backups), copies)
        fs.writeFileSync(path.join(w.installDir, "my notes é.txt"), "mine")
        assert.equal(await uninstall(w), "uninstalled")
        assertUninstalled(w)
        assert.deepEqual(servers(config), others)
        assert.deepEqual(snapshotDir(backups), copies, "the private copies survive the uninstallation")
        assert.ok(w.lastRun?.messages.some((m) => m.includes(`restano nella tua cartella personale ${backups}`)), JSON.stringify(w.lastRun?.messages))
    })

    test("a repair that fails is rolled back with its record: the registration is still the installation's, the file untouched", async () => {
        const w = world()
        const config = desktopConfig(w)
        assert.equal(await install(w, "0.1.0"), "installed")
        await register(w, config, "0.1.0")
        const registered = fs.readFileSync(config)
        const before = record(w)
        assert.equal(await install(w, "0.1.0", { at: "after-second-rename", mode: "fail" }), "rolled-back", w.lastMessage)
        assert.deepEqual(record(w), before)
        assert.ok(fs.readFileSync(config).equals(registered))
        assert.equal(await uninstall(w), "uninstalled")
        assert.deepEqual(servers(config), others)
    })

    test("uninstall with an entry changed by someone else: the model stops (the wizard asks), nothing is removed; put back, it goes", async () => {
        const w = world()
        const config = desktopConfig(w)
        assert.equal(await install(w, "0.1.0"), "installed")
        await register(w, config, "0.1.0")
        const doc = JSON.parse(fs.readFileSync(config, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> }
        const mine = doc.mcpServers["fluent-reader"] as Record<string, unknown>
        fs.writeFileSync(config, JSON.stringify({ ...doc, mcpServers: { ...doc.mcpServers, "fluent-reader": { ...mine, timeout: 5 } } }))
        const before = fs.readFileSync(config)
        assert.equal(await uninstall(w), "stopped")
        assert.ok(fs.readFileSync(config).equals(before))
        assert.ok(fs.existsSync(path.join(w.installDir, RECORD_NAME)))
        fs.writeFileSync(config, JSON.stringify(doc))
        assert.equal(await uninstall(w), "uninstalled")
        assert.deepEqual(servers(config), others)
    })

    test("an upgrade of a Code-first installation: the Claude Code registration is carried over untouched and no Desktop one is implied", async () => {
        const w = world()
        assert.equal(await install(w, "0.1.0"), "installed")
        const app = path.join(w.installDir, "current", "app")
        const entry = { type: "stdio" as const, command: path.join(app, "runtime", "node.exe"), args: [path.join(app, "server", "dist", "main.js"), "--profile-dir", w.profile], env: {} }
        const codeConfig = path.join(w.home, ".claude.json")
        fs.writeFileSync(codeConfig, JSON.stringify({ mcpServers: { "fluent-reader": entry, altro: { command: "a" } }, token: SECRET }))
        const code = fs.readFileSync(codeConfig)
        const file = path.join(w.installDir, RECORD_NAME)
        const claude = { state: "registered" as const, name: "fluent-reader", scope: "user" as const, configPath: codeConfig, claudeExe: path.join(w.home, "claude.exe"), entry, fingerprint: entryFingerprint(entry), backup: null, updatedAt: "2026-10-02T09:00:00.000Z" }
        writeRecord(file, { ...(readRecord(file) as InstallRecord), claude })
        assert.equal(await install(w, "0.2.0"), "installed")
        assert.deepEqual(record(w).claude, claude)
        assert.equal(record(w).desktop, undefined)
        assert.ok(fs.readFileSync(codeConfig).equals(code))
        assert.equal(await uninstall(w), "uninstalled")
        assert.ok(fs.readFileSync(codeConfig).equals(code), "the uninstaller does not touch it either")
        assert.ok(w.lastRun?.messages.some((m) => m.includes("claude mcp remove fluent-reader --scope user")), JSON.stringify(w.lastRun?.messages))
        assert.equal(execCalls.some((c) => /claude/i.test(c[0] as string)), false, "no Claude Code program started")
    })
})
