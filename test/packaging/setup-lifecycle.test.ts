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
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { helperCopyNsh, setupClosure } from "../../installer/lib/installer-build.js"
import { buildManifest, MANIFEST } from "../../installer/lib/package-content.js"
import { parseRuntimeLock } from "../../installer/lib/runtime-lock.js"
import { buildInventory, INVENTORY, readInventory } from "../../installer/setup/app.js"
import { main, type HelperDeps } from "../../installer/setup/fr-setup.js"
import { decodeResult } from "../../installer/setup/protocol.js"
import { canonicalJson, RECORD_NAME } from "../../installer/setup/record.js"
import { REGISTRY_SLOTS, type TxCheckpoint } from "../../installer/setup/transaction.js"
import { helperCopyEntries, type UninstallCheckpoint } from "../../installer/setup/uninstall.js"
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
const INSTALL_COMMANDS = ["tx-recover", "tx-recover-finish", "tx-begin", "verify-tree", "tx-prepare", "tx-swap", "tx-metadata", "tx-commit", "tx-cleanup", "register"]
/** The helper commands the NSIS uninstall section calls, in order. */
const UNINSTALL_COMMANDS = ["un-status", "uninstall-preflight", "unregister", "un-begin", "remove-tree", "un-metadata", "un-finish"]

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
    lastRun?: NsisRun
    commands: string[]
    lastMessage?: string
}

function world(): World {
    counter++
    const home = path.join(root, `user ${counter} é`)
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

function deps(w: World): HelperDeps {
    return {
        env: w.env, exec: () => ({ status: 1, stdout: "", stderr: "no program in this model" }), selfTest: async () => [], now: () => new Date("2026-10-28T10:00:00Z"),
        txCheckpoint: (s) => w.txCheckpoint?.(s), uninstallCheckpoint: (s) => w.uninstallCheckpoint?.(s), unlink: (f) => (w.unlink ?? fs.unlinkSync)(f), rmdir: (d) => (w.rmdir ?? fs.rmdirSync)(d),
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
    if (code !== 0) w.lastMessage = (fields.get("message") ?? []).join("\n")
    return { code, fields, one: (k) => (fields.get(k) ?? []).join("\n") }
}

/** Where a run stops: a crash (process gone, nothing else runs) or a failure (the script goes to its rollback). */
type Stop =
    | { at: "after-prepare"; mode: "crash" | "fail" }
    | { at: TxCheckpoint; mode: "crash" | "fail" }
    | { at: "registry-partial"; mode: "crash" | "fail" }
    | { at: "after-commit"; mode: "crash" }

type Outcome = "installed" | "crashed" | "rolled-back" | "rollback-incomplete" | "recovery-failed" | "refused"

/** TxRecover: the recovery at the start, and the rollback after a failure. */
async function txRecover(w: World): Promise<boolean> {
    const base = { installDir: w.installDir, payloadInventory: path.join(payload("0.1.0"), INVENTORY) }
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
    const crashOrRollback = async (mode: "crash" | "fail"): Promise<Outcome> => (mode === "crash" ? "crashed" : (await txRecover(w)) ? "rolled-back" : "rollback-incomplete")
    fs.mkdirSync(w.installDir, { recursive: true }) // CreateDirectory "$INSTDIR"
    if (!(await txRecover(w))) return "recovery-failed"
    const begin = await call(w, "tx-begin", { installDir: w.installDir, version, maxRelative: "150", bundleSha256: "a".repeat(64), profileDir: w.profile })
    if (begin.code !== 0) return "refused"
    const tx = { installDir: w.installDir, transactionId: begin.one("transactionId") }
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
            // the next start
            assert.equal(await txRecover(w), true)
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

    test("a failure (not a crash) after the swap: the script's rollback is the same recovery; nothing is declared installed", async () => {
        const { w, before } = await installedV1()
        assert.equal(await install(w, "0.2.0", { at: "after-uninstaller", mode: "fail" }), "rolled-back")
        assert.deepEqual(snapshot(w), before)
    })

    test("new installation interrupted after the swap: the next start removes it completely (values and keys that did not exist)", async () => {
        const w = world()
        const before = snapshot(w)
        assert.equal(await install(w, "0.1.0", { at: "registry-partial", mode: "crash" }), "crashed")
        assert.notEqual(w.reg.snapshot(), before.registry, "four values were written")
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
        const begin = await call(w, "tx-begin", { installDir: w.installDir, version: "0.1.0", maxRelative: "150", bundleSha256: "a".repeat(64), profileDir: w.profile })
        assert.equal(begin.code, 0)
        fs.mkdirSync(path.join(w.installDir, ".staging", "app", "runtime"), { recursive: true })
        fs.copyFileSync(path.join(payload("0.1.0"), "app", "runtime", "node.exe"), path.join(w.installDir, ".staging", "app", "runtime", "node.exe"))
        assert.equal(await txRecover(w), true)
        assert.deepEqual(snapshot(w).dirs, [])
        assert.equal(journalPhase(w), null)
    })
})

describe("installation transaction: HKCU types and values (Major 1)", { timeout: 120_000 }, () => {
    test("values absent, present with the expected types, and REG_EXPAND_SZ: a failed upgrade restores each with its type", async () => {
        const w = world()
        w.reg.write(UNINSTALL_KEY, "InstallLocation", "REG_EXPAND_SZ", "%LOCALAPPDATA%\\Old place")
        w.reg.write(UNINSTALL_KEY, "NoModify", "REG_DWORD", "0")
        w.reg.write(SETTINGS_KEY, "InstallDir", "REG_SZ", "C:\\Old")
        const before = w.reg.snapshot()
        assert.equal(await install(w, "0.1.0", { at: "registry-partial", mode: "fail" }), "rolled-back")
        assert.equal(w.reg.snapshot(), before)
        assert.deepEqual(w.reg.keys.get(UNINSTALL_KEY)?.get("InstallLocation"), { type: "REG_EXPAND_SZ", value: "%LOCALAPPDATA%\\Old place" })
    })

    for (const type of ["REG_BINARY", "REG_MULTI_SZ", "REG_QWORD", "TOO_LONG", "ERROR_5"]) {
        test(`a value of type ${type} cannot be preserved: refused before the swap, nothing changed`, async () => {
            const { w, before } = await installedV1()
            w.reg.write(UNINSTALL_KEY, "EstimatedSize", type, "00ff")
            const withValue = snapshot(w)
            assert.equal(await install(w, "0.2.0"), "refused")
            assert.deepEqual(snapshot(w), withValue, "current 0.1.0, record, uninstaller, HKCU untouched")
            assert.equal(before.version, "0.1.0")
            assert.ok(w.commands.lastIndexOf("tx-swap") < w.commands.lastIndexOf("tx-prepare"), "no swap was attempted")
        })
    }

    test("a key-presence flag that cannot be read stops before the swap", async () => {
        const { w } = await installedV1()
        const original = w.reg.backup.bind(w.reg)
        w.reg.backup = () => ({ ...original(), "key.settings": "ERROR_5" })
        assert.equal(await install(w, "0.2.0"), "refused")
        assert.equal(snapshot(w).version, "0.1.0")
    })
})

describe("installation transaction: recovery failures keep everything recoverable (Major 1)", { timeout: 120_000 }, () => {
    test("an error during the recovery: journal, previous version and copies are kept; a later recovery completes", async () => {
        const { w, before } = await installedV1()
        assert.equal(await install(w, "0.2.0", { at: "after-second-rename", mode: "crash" }), "crashed")
        w.txCheckpoint = (s) => {
            if (s === "during-recovery") throw new Error("injected")
        }
        const r = await call(w, "tx-recover", { installDir: w.installDir })
        assert.equal(r.code, 1)
        assert.match(r.one("message"), /recupero INCOMPLETO .*journal e copie di recupero sono conservati/)
        assert.equal(journalPhase(w), "swapping", "the journal is still there")
        assert.ok(fs.existsSync(path.join(w.installDir, "previous", INVENTORY)), "the previous version is still on disk")
        assert.ok(fs.existsSync(path.join(w.installDir, "state", "install-record.previous.json")) && fs.existsSync(path.join(w.installDir, "state", "uninstall.exe.new")))
        w.txCheckpoint = undefined
        assert.equal(await txRecover(w), true)
        assert.deepEqual(snapshot(w), before)
    })

    test("HKCU cannot be restored: the recovery is incomplete, the journal waits in rolling-back; the next attempt finishes", async () => {
        const { w, before } = await installedV1()
        assert.equal(await install(w, "0.2.0", { at: "registry-partial", mode: "crash" }), "crashed")
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
        // the original journal back: the recovery works
        fs.writeFileSync(file, journal)
        assert.equal(await txRecover(w), true)
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
        if (status.one("phase") !== "metadata") {
            if ((await call(w, "uninstall-preflight", req)).code !== 0) return "stopped"
            const unreg = await call(w, "unregister", req)
            if (!["removed", "absent", "not-configured"].includes(unreg.one("outcome"))) return "stopped"
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
        vars: { INSTDIR: w.installDir, CleanFail: "0" },
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
        ["record missing", (r) => fs.rmSync(r), /registro di installazione precedente manca e la sua copia non c'è più/],
        ["record altered", (r) => fs.appendFileSync(r, " "), /non corrisponde a quello precedente \(SHA-256\)/],
        ["another valid record (different hash)", (r) => fs.writeFileSync(r, fs.readFileSync(r, "utf8").replace('"0.1.0"', '"0.0.9"')), /non corrisponde a quello precedente \(SHA-256\)/],
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
            assert.equal(await install(w, "0.2.0"), "refused")
            assert.match(w.lastMessage ?? "", /contiene un a capo \(CR o LF\): il suo backup non è rappresentabile in sicurezza/)
            assert.deepEqual(snapshot(w), before)
            assert.deepEqual(w.reg.keys.get(UNINSTALL_KEY)?.get("Publisher"), { type, value })
            assert.ok(w.commands.lastIndexOf("tx-swap") < w.commands.lastIndexOf("tx-prepare"), "no swap")
        })
    }

    test("an unexpanded %LOCALAPPDATA% REG_EXPAND_SZ and normal strings are preserved identically", async () => {
        const { w, before } = await installedV1()
        w.reg.write(UNINSTALL_KEY, "InstallLocation", "REG_EXPAND_SZ", "%LOCALAPPDATA%\\FluentReaderMCP")
        const withExpand = w.reg.snapshot()
        assert.equal(await install(w, "0.2.0", { at: "registry-partial", mode: "fail" }), "rolled-back")
        assert.equal(w.reg.snapshot(), withExpand)
        assert.equal(snapshot(w).version, before.version)
    })
})

describe("round 4: removal of keys left empty (Minor)", { timeout: 120_000 }, () => {
    test("rollback of a new installation: an empty key is deleted, a key with another program's value is kept (not an error)", async () => {
        const w = world()
        assert.equal(await install(w, "0.1.0", { at: "registry-partial", mode: "crash" }), "crashed")
        w.reg.write(UNINSTALL_KEY, "SomeoneElse", "REG_SZ", "foreign")
        assert.equal(await txRecover(w), true)
        assert.deepEqual([...(w.reg.keys.get(UNINSTALL_KEY)?.keys() ?? [])], ["SomeoneElse"], "kept, with the foreign value only")
        assert.equal(w.reg.keys.has(SETTINGS_KEY), false, "the empty key is deleted")
    })

    test("a key that should go and cannot: the recovery is not declared complete; a later attempt finishes", async () => {
        const w = world()
        assert.equal(await install(w, "0.1.0", { at: "registry-partial", mode: "crash" }), "crashed")
        w.reg.failingKeys.add(UNINSTALL_KEY)
        assert.equal(await txRecover(w), false)
        assert.equal(journalPhase(w), "rolling-back")
        w.reg.failingKeys.clear()
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

    test("4. crash after the marker is deleted, uninstaller still there: a harmless leftover; reinstall works and replaces it", async () => {
        const w = await installedForUninstall()
        assert.equal(await uninstall(w, { crashAfter: "final-marker-deleted" }), "stopped")
        assert.deepEqual(kept(w), { marker: false, uninstaller: true, copy: false })
        assert.equal(await uninstallStateKind(w), "nothing", "the leftover uninstaller authorises nothing (un.onInit refuses)")
        const check = await call(w, "check-install-dir", { installDir: w.installDir, version: "0.1.0", maxRelative: "150" })
        assert.notEqual(check.one("pendingUninstall"), "yes")
        await reinstall(w)
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

    test("uninstall.exe that cannot be deleted at the very end: the uninstallation is complete, the leftover is harmless", async () => {
        const w = await installedForUninstall()
        w.unlink = busy((f) => f.endsWith("uninstall.exe"), fs.unlinkSync)
        assert.equal(await uninstall(w), "uninstalled")
        assert.match(w.lastRun?.messages.join("\n") ?? "", /non impedisce una nuova installazione/)
        assert.deepEqual(kept(w), { marker: false, uninstaller: true, copy: false })
        w.unlink = undefined
        await reinstall(w)
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
        assert.deepEqual(firstOccurrences(commands(section("Uninstall")).filter((c) => c !== "detect-claude")), UNINSTALL_COMMANDS)
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

