/**
 * The guard that keeps two writers from config.json. It is never removed by
 * anyone who cannot show it is theirs, and it is never what gets published as
 * config.json. Synthetic profiles and backup folders only.
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, mock, test } from "node:test"
import { fileURLToPath } from "node:url"
import { fileLock } from "../src/db/connection.js"
import { GUARD_STALE_MS, WRITE_GUARD_FILE, type RuleWriteSettings, type RuleWriteStep } from "../src/settings/rule-store.js"
import { createTempRoot, removeTempRoot, syntheticSettings } from "./helpers/fixtures.js"
import { createSourcesProfile, harness, type Harness, type ToolOutcome } from "./helpers/sources.js"
import type { WorkerCommit } from "./helpers/rule-writes-worker.js"

let root: string
let counter = 0
const open: Harness[] = []

before(() => { root = createTempRoot() })
after(async () => {
    for (const h of open) await h.close()
    fileLock().close()
    removeTempRoot(root)
})

interface Session {
    readonly h: Harness
    readonly dir: string
    readonly config: string
    readonly guard: string
    readonly store: { readonly localAppData: string; readonly userProfile: string }
}

async function session(settings: Partial<RuleWriteSettings> = {}, existing?: Pick<Session, "dir" | "store">): Promise<Session> {
    const n = ++counter
    const p = existing === undefined
        ? createSourcesProfile(path.join(root, `profile-${n}`), { sources: [{ sid: 0, name: "Synthetic A" }, { sid: 1, name: "Synthetic B" }], settings: syntheticSettings() })
        : { dir: existing.dir, dbPath: path.join(existing.dir, "fluent-reader.db"), configPath: path.join(existing.dir, "config.json") }
    const userProfile = path.join(root, `home-${n}`)
    const localAppData = path.join(userProfile, "AppData", "Local")
    if (existing === undefined) fs.mkdirSync(localAppData, { recursive: true })
    const store = existing?.store ?? { localAppData, userProfile }
    const h = await harness(p, { ruleWrites: { ...store, ...settings } })
    open.push(h)
    return { h, dir: p.dir, config: p.configPath, guard: path.join(p.dir, WRITE_GUARD_FILE), store }
}

const RULE = { field: "title", pattern: "^nuova$", caseSensitive: false, match: true, actions: [{ action: "hide", value: true }] }

function ok(outcome: ToolOutcome): any {
    assert.equal(outcome.isError, false, outcome.text)
    return outcome.payload
}

function refused(outcome: ToolOutcome, code: string, reason?: string): void {
    assert.equal(outcome.isError, true, outcome.text)
    assert.equal(outcome.error?.code, code, outcome.text)
    if (reason !== undefined) assert.equal(outcome.error?.reason, reason, outcome.text)
}

const revisionOf = async (s: Session): Promise<string> => ok(await s.h.call("list_rules", { limit: 100, scope: "group", groupId: 0 })).revision
async function add(s: Session, rule: object = RULE): Promise<ToolOutcome> {
    return s.h.call("add_rule", { scope: "group", groupId: 0, expectedRevision: await revisionOf(s), rule })
}
const previewOutcome = (s: Session): Promise<ToolOutcome> => s.h.call("preview_rule_change", { operation: "add", scope: "group", groupId: 0, rule: RULE })

const partials = (s: Session): string[] => fs.readdirSync(s.dir).filter((name) => name.endsWith(".partial"))
const backups = (s: Session): number => {
    const base = path.join(s.store.localAppData, "FluentReaderMCP-Data", "rule-backups")
    if (!fs.existsSync(base)) return 0
    return fs.readdirSync(base).flatMap((key) => fs.readdirSync(path.join(base, key))).filter((name) => name.endsWith(".bak")).length
}
const ageGuard = (s: Session): void => {
    const old = new Date(Date.now() - GUARD_STALE_MS - 60_000)
    fs.utimesSync(s.guard, old, old)
}
const NEW_OWNER = "guard of a new owner, still alive"

/** The pathname passes to someone else, without going through the code under test. */
function handOver(s: Session, realUnlink: typeof fs.unlinkSync = fs.unlinkSync): void {
    realUnlink.call(fs, s.guard)
    fs.writeFileSync(s.guard, NEW_OWNER)
}

function watchGuardRemovals(s: Session): { calls: () => string[]; restore: () => void } {
    const seen: string[] = []
    const realUnlink = fs.unlinkSync
    const realRm = fs.rmSync
    const realRename = fs.renameSync
    const unlink = mock.method(fs, "unlinkSync", (target: any) => { if (target === s.guard) seen.push("unlink"); return realUnlink.call(fs, target) })
    const rm = mock.method(fs, "rmSync", (target: any, options: any) => { if (target === s.guard) seen.push("rm"); return realRm.call(fs, target, options) })
    const rename = mock.method(fs, "renameSync", (from: any, to: any) => { if (from === s.guard || to === s.guard) seen.push("rename"); return realRename.call(fs, from, to) })
    return { calls: () => seen, restore: () => { unlink.mock.restore(); rm.mock.restore(); rename.mock.restore() } }
}

function assertUntouched(s: Session, config: Buffer, backupCount: number): void {
    assert.ok(fs.readFileSync(s.config).equals(config), "config.json keeps its bytes")
    assert.equal(backups(s), backupCount)
}

describe("Major 1: age never authorizes a removal", () => {
    test("a guard is refused at any age, stays as it is, and is removed by nobody", async () => {
        const s = await session()
        const config = fs.readFileSync(s.config)
        fs.writeFileSync(s.guard, "someone else's")
        const removals = watchGuardRemovals(s)
        try {
            refused(await add(s), "RULE_WRITE_BUSY", "write-in-progress")
            ageGuard(s)
            const outcome = await add(s)
            refused(outcome, "RULE_WRITE_BUSY", "write-guard-orphaned")
            assert.match(outcome.error?.hint ?? "", /never removed automatically/)
            assert.match(outcome.error?.hint ?? "", /config\.json\.frmcp-write\.tmp/)
            assert.match(outcome.error?.hint ?? "", /close Fluent Reader and every MCP client/)
        } finally {
            removals.restore()
        }
        assert.deepEqual(removals.calls(), [])
        assert.equal(fs.readFileSync(s.guard, "utf8"), "someone else's")
        assertUntouched(s, config, 0)
    })

    test("reads and previews stay available while a guard blocks the writes", async () => {
        const s = await session()
        fs.writeFileSync(s.guard, "orphan")
        ageGuard(s)
        ok(await s.h.call("list_rules", { limit: 10, scope: "group", groupId: 0 }))
        ok(await s.h.call("get_rule_chain", { sourceId: 0 }))
        assert.equal(ok(await previewOutcome(s)).writeAvailability.writesEnabled, true)
        ok(await s.h.call("list_sources", {}))
    })

    test("a new owner appearing between the observation and a possible removal keeps its guard", async () => {
        const s = await session()
        const config = fs.readFileSync(s.config)
        fs.writeFileSync(s.guard, "orphan")
        ageGuard(s)
        const realStat = fs.lstatSync
        const realUnlink = fs.unlinkSync
        let swapped = false
        const stat = mock.method(fs, "lstatSync", (target: any, ...rest: any[]) => {
            const out = (realStat as any).call(fs, target, ...rest)
            if (target === s.guard && !swapped) {
                swapped = true
                handOver(s, realUnlink)
            }
            return out
        })
        const removals = watchGuardRemovals(s)
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            removals.restore()
            stat.mock.restore()
        }
        assert.equal(swapped, true, "the scenario really happened")
        refused(outcome, "RULE_WRITE_BUSY")
        assert.deepEqual(removals.calls(), [])
        assert.equal(fs.readFileSync(s.guard, "utf8"), NEW_OWNER)
        assertUntouched(s, config, 0)
    })
})

describe("Major 2: a cleanup touches only what is provably its own", () => {
    const failing: readonly RuleWriteStep[] = ["after-guard", "after-backup", "after-temp", "before-rename"]
    for (const at of failing) {
        test(`a failure at ${at}, after the pathname changed owner: the new owner's guard survives`, async () => {
            let armed = false
            let s: Session | undefined
            const realUnlink = fs.unlinkSync
            s = await session({ step: (name) => {
                if (armed && name === at) {
                    armed = false
                    handOver(s as Session, realUnlink)
                    throw new Error("synthetic failure")
                }
            } })
            const config = fs.readFileSync(s.config)
            armed = true
            refused(await add(s), "RULE_WRITE_FAILED", "write-failed")
            assert.equal(fs.readFileSync(s.guard, "utf8"), NEW_OWNER)
            assert.ok(fs.readFileSync(s.config).equals(config))
            assert.deepEqual(partials(s), [], "its own temporary file is gone")
        })
    }

    test("the pathname changing owner before the rename: nothing is published, and the new owner's file is not config.json", async () => {
        let armed = false
        let s: Session | undefined
        const realUnlink = fs.unlinkSync
        s = await session({ step: (name) => {
            if (armed && name === "before-rename") {
                armed = false
                handOver(s as Session, realUnlink)
            }
        } })
        const config = fs.readFileSync(s.config)
        armed = true
        refused(await add(s), "RULE_WRITE_BUSY", "write-in-progress")
        assert.ok(fs.readFileSync(s.config).equals(config), "config.json was not replaced by another owner's file")
        assert.equal(fs.readFileSync(s.guard, "utf8"), NEW_OWNER)
        assert.deepEqual(partials(s), [])
    })

    test("the pathname changing owner during a retry: the writer stops", async () => {
        let armed = false
        let s: Session | undefined
        const realUnlink = fs.unlinkSync
        s = await session({ step: (name) => {
            if (armed && name === "before-retry") {
                armed = false
                handOver(s as Session, realUnlink)
            }
        } })
        const config = fs.readFileSync(s.config)
        const realRename = fs.renameSync
        let refusals = 0
        const rename = mock.method(fs, "renameSync", (from: any, to: any) => {
            if (path.basename(String(to)) === "config.json" && refusals === 0) {
                refusals++
                throw Object.assign(new Error("held"), { code: "EPERM" })
            }
            return realRename.call(fs, from, to)
        })
        armed = true
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            rename.mock.restore()
        }
        refused(outcome, "RULE_WRITE_BUSY", "write-in-progress")
        assert.ok(fs.readFileSync(s.config).equals(config))
        assert.equal(fs.readFileSync(s.guard, "utf8"), NEW_OWNER)
    })

    test("a failed creation of the guard leaves nothing and writes nothing", async () => {
        const s = await session()
        const config = fs.readFileSync(s.config)
        const realOpen = fs.openSync
        const failing2 = mock.method(fs, "openSync", (target: any, ...rest: any[]) => {
            if (target === s.guard) throw Object.assign(new Error("denied"), { code: "EACCES" })
            return (realOpen as any).call(fs, target, ...rest)
        })
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            failing2.mock.restore()
        }
        refused(outcome, "RULE_WRITE_FAILED", "write-failed")
        assert.equal(fs.existsSync(s.guard), false)
        assertUntouched(s, config, 0)
    })

    /** Fails the first token write and optionally hands the pathname over right after the descriptor closes. */
    function failTokenWrite(s: Session, afterClose?: () => void): { closes: () => number; restore: () => void } {
        const realClose = fs.closeSync
        const realOpen = fs.openSync
        const realWrite = fs.writeSync
        let guardFd: number | null = null
        let closes = 0
        const openM = mock.method(fs, "openSync", (target: any, ...rest: any[]) => {
            const fd = (realOpen as any).call(fs, target, ...rest)
            if (target === s.guard) guardFd = fd
            return fd
        })
        const write = mock.method(fs, "writeSync", (fd: number, ...rest: any[]) => {
            if (fd === guardFd) throw Object.assign(new Error("full"), { code: "ENOSPC" })
            return (realWrite as any).call(fs, fd, ...rest)
        })
        const close = mock.method(fs, "closeSync", (fd: number) => {
            realClose.call(fs, fd)
            if (fd !== guardFd) return
            guardFd = null
            closes++
            afterClose?.()
        })
        return { closes: () => closes, restore: () => { openM.mock.restore(); write.mock.restore(); close.mock.restore() } }
    }

    test("a failed token write closes the descriptor and does not touch a pathname that changed owner", async () => {
        const s = await session()
        const config = fs.readFileSync(s.config)
        const realUnlink = fs.unlinkSync
        const fault = failTokenWrite(s, () => handOver(s, realUnlink))
        const removals = watchGuardRemovals(s)
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            removals.restore()
            fault.restore()
        }
        refused(outcome, "RULE_WRITE_FAILED", "write-failed")
        assert.equal(fault.closes(), 1)
        assert.deepEqual(removals.calls(), [])
        assert.equal(fs.readFileSync(s.guard, "utf8"), NEW_OWNER)
        assertUntouched(s, config, 0)
    })

    test("a failed token write with no new owner leaves an orphan: writes refused, reads fine, recovery by hand", async () => {
        const s = await session()
        const config = fs.readFileSync(s.config)
        const fault = failTokenWrite(s)
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            fault.restore()
        }
        refused(outcome, "RULE_WRITE_FAILED", "write-failed")
        assert.ok(fs.existsSync(s.guard), "left in place: nobody can prove it is still this writer's")
        refused(await add(s), "RULE_WRITE_BUSY", "write-in-progress")
        ok(await previewOutcome(s))
        assertUntouched(s, config, 0)
        fs.unlinkSync(s.guard)
        assert.equal(ok(await add(s)).applied, true)
        assert.equal(fs.existsSync(s.guard), false)
    })

    test("a failed backup writes nothing and releases only its own guard", async () => {
        const s = await session({ localAppData: "relative", userProfile: "relative" })
        const config = fs.readFileSync(s.config)
        refused(await add(s), "RULE_BACKUP_UNAVAILABLE", "backup-location")
        assert.equal(fs.existsSync(s.guard), false)
        assert.deepEqual(partials(s), [])
        assert.ok(fs.readFileSync(s.config).equals(config))
    })
})

describe("the rename", () => {
    test("a brief refusal is retried while still holding the guard, and ends with nothing left behind", async () => {
        const s = await session()
        const realRename = fs.renameSync
        let refusals = 0
        const guardHeld: boolean[] = []
        const rename = mock.method(fs, "renameSync", (from: any, to: any) => {
            if (path.basename(String(to)) === "config.json") {
                guardHeld.push(fs.existsSync(s.guard))
                assert.notEqual(from, s.guard, "the guard itself is never published")
                if (++refusals <= 2) throw Object.assign(new Error("held"), { code: "EBUSY" })
            }
            return realRename.call(fs, from, to)
        })
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            rename.mock.restore()
        }
        assert.equal(ok(outcome).applied, true)
        assert.deepEqual(guardHeld, [true, true, true])
        assert.equal(fs.existsSync(s.guard), false)
        assert.deepEqual(partials(s), [])
        assert.equal(backups(s), 1)
    })

    test("config.json changing during a retry is never overwritten", async () => {
        const s = await session()
        const external = Buffer.from(JSON.stringify({ ...syntheticSettings(), theme: "changed by someone else" }))
        const realRename = fs.renameSync
        let refusals = 0
        const rename = mock.method(fs, "renameSync", (from: any, to: any) => {
            if (path.basename(String(to)) === "config.json" && ++refusals === 1) {
                fs.writeFileSync(s.config, external)
                throw Object.assign(new Error("held"), { code: "EPERM" })
            }
            return realRename.call(fs, from, to)
        })
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            rename.mock.restore()
        }
        refused(outcome, "REVISION_CONFLICT", "settings-changed")
        assert.ok(fs.readFileSync(s.config).equals(external))
        assert.equal(fs.existsSync(s.guard), false)
        assert.deepEqual(partials(s), [])
    })

    test("a permanent refusal keeps config.json, retries five times and cleans up", async () => {
        const s = await session()
        const config = fs.readFileSync(s.config)
        const realRename = fs.renameSync
        let attempts = 0
        const rename = mock.method(fs, "renameSync", (from: any, to: any) => {
            if (path.basename(String(to)) === "config.json") {
                attempts++
                throw Object.assign(new Error("held"), { code: "EBUSY" })
            }
            return realRename.call(fs, from, to)
        })
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            rename.mock.restore()
        }
        refused(outcome, "RULE_WRITE_FAILED", "replace-failed")
        assert.equal(attempts, 5)
        assert.ok(fs.readFileSync(s.config).equals(config))
        assert.equal(fs.existsSync(s.guard), false)
        assert.deepEqual(partials(s), [])
    })

    test("a read-back problem after the rename is UNVERIFIED, and the guard is released", async () => {
        let armed = false
        const s = await session({ step: (name) => {
            if (armed && name === "after-rename") {
                armed = false
                throw new Error("read failure")
            }
        } })
        armed = true
        refused(await add(s), "RULE_WRITE_UNVERIFIED", "read-back-failed")
        assert.equal(fs.existsSync(s.guard), false)
        assert.match(fs.readFileSync(s.config, "utf8"), /\^nuova\$/, "the file was in fact replaced")
    })
})

describe("the ordinary release", () => {
    test("a successful write leaves neither guard nor temporary file, and the guard never held the new content", async () => {
        let observed: { guard: string; partials: number } | undefined
        let s: Session | undefined
        s = await session({ step: (name) => {
            if (name === "after-temp") {
                const current = s as Session
                observed = { guard: fs.readFileSync(current.guard, "utf8"), partials: partials(current).length }
            }
        } })
        const before = fs.readdirSync(s.dir).sort()
        const saved = ok(await add(s))
        assert.equal(saved.applied, true)
        assert.ok(saved.backup?.name)
        assert.deepEqual(fs.readdirSync(s.dir).sort(), before)
        assert.equal(backups(s), 1)
        assert.match(observed?.guard ?? "", /^[0-9a-f]{32}$/, "the guard holds only an owner token")
        assert.equal(observed?.partials, 1)
    })

    test("a guard briefly held at release is released on a retry", async () => {
        const s = await session()
        const realUnlink = fs.unlinkSync
        let refusals = 0
        const unlink = mock.method(fs, "unlinkSync", (target: any) => {
            if (target === s.guard && ++refusals <= 2) throw Object.assign(new Error("held"), { code: "EBUSY" })
            return realUnlink.call(fs, target)
        })
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            unlink.mock.restore()
        }
        assert.equal(ok(outcome).applied, true)
        assert.equal(refusals, 3)
        assert.equal(fs.existsSync(s.guard), false)
    })

    test("a guard that cannot be released does not turn a saved change into an error, and blocks the next one", async () => {
        const s = await session()
        const realUnlink = fs.unlinkSync
        const unlink = mock.method(fs, "unlinkSync", (target: any) => {
            if (target === s.guard) throw Object.assign(new Error("held"), { code: "EBUSY" })
            return realUnlink.call(fs, target)
        })
        let outcome: ToolOutcome
        try {
            outcome = await add(s)
        } finally {
            unlink.mock.restore()
        }
        assert.equal(ok(outcome).applied, true)
        assert.ok(fs.existsSync(s.guard))
        refused(await add(s, { ...RULE, pattern: "^altra$" }), "RULE_WRITE_BUSY", "write-in-progress")
    })

    test("a temporary file left by a dead writer is removed only by whoever holds the guard", async () => {
        const s = await session()
        const dead = path.join(s.dir, `${WRITE_GUARD_FILE.replace(/\.tmp$/, "")}.0123456789abcdef.partial`)
        fs.writeFileSync(dead, "resto di un processo terminato")
        fs.writeFileSync(s.guard, "someone else's")
        refused(await add(s), "RULE_WRITE_BUSY")
        assert.ok(fs.existsSync(dead), "not without the guard")
        fs.unlinkSync(s.guard)
        ok(await add(s))
        assert.equal(fs.existsSync(dead), false)
    })
})

describe("real processes", { timeout: 120_000 }, () => {
    interface Run {
        readonly mode: "edit" | "crash" | "hold"
        readonly id: string
        readonly s: Session
        readonly until: number
        readonly ready?: string
        readonly go?: string
    }

    function worker(run: Run): Promise<WorkerCommit[]> {
        const file = fileURLToPath(new URL("./helpers/rule-writes-worker.js", import.meta.url))
        const { s, ...rest } = run
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [file, JSON.stringify({ ...rest, dir: s.dir, ...s.store })], { stdio: ["ignore", "pipe", "ignore"] })
            let out = ""
            child.stdout.on("data", (d) => { out += String(d) })
            child.on("error", reject)
            child.on("exit", (code) => code === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1) as string)) : reject(new Error(`worker exit ${code}`)))
        })
    }

    async function waitFor(condition: () => boolean): Promise<void> {
        const limit = Date.now() + 15_000
        while (!condition()) {
            if (Date.now() > limit) throw new Error("timeout")
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
    }

    const groupRules = (s: Session): { search: string }[] => (JSON.parse(fs.readFileSync(s.config, "utf8")).sourceRules["group:0"] ?? []) as { search: string }[]

    for (const count of [2, 3]) {
        test(`${count} writers: every committed rule present exactly once, no corruption`, async () => {
            const s = await session()
            const commits = (await Promise.all(Array.from({ length: count }, (_, i) => worker({ mode: "edit", id: `P${i}`, s, until: Date.now() + 2_500 })))).flat()
            assert.ok(commits.length > 0)
            // Revisions are keyed per process, so they cannot be chained across writers. The stored list is the proof:
            // every reported commit is there exactly once (a lost update would drop one), and nothing else (a write reported as failed would add one).
            assert.deepEqual(groupRules(s).map((rule) => rule.search).sort(), commits.map((commit) => commit.pattern).sort(), "no lost update and nothing unexpected")
            assert.deepEqual(JSON.parse(fs.readFileSync(s.config, "utf8")).serviceConfigs, syntheticSettings().serviceConfigs, "the other settings are intact")
            assert.equal(fs.existsSync(s.guard), false)
            assert.deepEqual(partials(s), [])
            // A writer that read before another one's commit takes a backup, finds config.json changed and gives up: an extra copy, no write.
            assert.ok(backups(s) >= commits.length, "every commit has its backup")
        })

        test(`${count} writers facing an old guard: none removes it, none writes`, async () => {
            const s = await session()
            const config = fs.readFileSync(s.config)
            fs.writeFileSync(s.guard, "owner still alive, with an old timestamp")
            ageGuard(s)
            const commits = (await Promise.all(Array.from({ length: count }, (_, i) => worker({ mode: "edit", id: `P${i}`, s, until: Date.now() + 1_500 })))).flat()
            assert.deepEqual(commits, [])
            assert.equal(fs.readFileSync(s.guard, "utf8"), "owner still alive, with an old timestamp")
            assertUntouched(s, config, 0)
        })
    }

    test("a slow owner that is still alive keeps its guard and finishes its write", async () => {
        const s = await session()
        const ready = path.join(s.store.userProfile, "ready")
        const go = path.join(s.store.userProfile, "go")
        const owner = worker({ mode: "hold", id: "Owner", s, until: Date.now() + 30_000, ready, go })
        await waitFor(() => fs.existsSync(ready))
        const held = fs.readFileSync(s.guard)
        ageGuard(s)
        refused(await add(s), "RULE_WRITE_BUSY", "write-guard-orphaned")
        assert.ok(fs.readFileSync(s.guard).equals(held))
        fs.writeFileSync(go, "")
        assert.equal((await owner).length, 1)
        assert.deepEqual(groupRules(s).map((rule) => rule.search), ["^Owner$"], "the intruder wrote nothing and the owner lost nothing")
        assert.equal(fs.existsSync(s.guard), false)
        assert.deepEqual(partials(s), [])
    })

    test("after a real crash: writes refused, reads fine, config.json intact, recovery by removing the guard", async () => {
        const s = await session()
        const config = fs.readFileSync(s.config)
        await assert.rejects(worker({ mode: "crash", id: "Dead", s, until: Date.now() + 30_000 }), /worker exit 9/)
        assert.ok(fs.existsSync(s.guard), "the crash left the guard")
        assert.ok(fs.readFileSync(s.config).equals(config), "config.json is intact")
        const dead = partials(s)
        assert.equal(dead.length, 1, "and its temporary file")
        const afterCrash = backups(s)

        refused(await add(s), "RULE_WRITE_BUSY", "write-in-progress")
        ageGuard(s)
        refused(await add(s), "RULE_WRITE_BUSY", "write-guard-orphaned")
        ok(await s.h.call("list_rules", { limit: 10, scope: "group", groupId: 0 }))
        ok(await previewOutcome(s))
        assertUntouched(s, config, afterCrash)
        assert.ok(fs.existsSync(path.join(s.dir, dead[0] as string)), "a writer without the guard removes nothing")

        fs.unlinkSync(s.guard) // The documented recovery.
        assert.equal(ok(await add(s)).applied, true)
        assert.deepEqual(groupRules(s).map((rule) => rule.search), ["^nuova$"])
        assert.equal(fs.existsSync(s.guard), false)
        assert.deepEqual(partials(s), [], "the next real owner cleans up")
    })
})
