import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { after, before, describe, test } from "node:test"
import { FrMcpError } from "../src/errors.js"
import {
    CFG_MAX,
    LIMITS,
    MAX_READ_ATTEMPTS,
    readSettings,
    type ReadSettingsHooks,
    type SettingsSnapshot,
} from "../src/settings/read-settings.js"
import {
    canCreateFileSymlinks,
    createProfile,
    createTempRoot,
    FAKE_PASSWORD,
    removeTempRoot,
    SECRET_SENTINEL,
    syntheticSettings,
    writeSettings,
    type ProfileFixture,
} from "./helpers/fixtures.js"

let root: string
let counter = 0

before(() => {
    root = createTempRoot()
})
after(() => removeTempRoot(root))

function newProfile(settings?: unknown): ProfileFixture {
    counter++
    return createProfile(path.join(root, `p${counter}`), { db: false, settings })
}

function read(profile: ProfileFixture, hooks?: ReadSettingsHooks): Promise<SettingsSnapshot> {
    return readSettings(profile.configPath, profile.dir, hooks ? { hooks } : {})
}

async function expectError(promise: Promise<unknown>, code: string, reason?: string): Promise<FrMcpError> {
    let caught: unknown
    try {
        await promise
    } catch (error) {
        caught = error
    }
    assert.ok(caught instanceof FrMcpError, "expected a FrMcpError")
    assert.equal(caught.code, code)
    if (reason !== undefined) assert.equal(caught.reason, reason)
    return caught
}

function serializeError(error: FrMcpError): string {
    return [error.message, error.hint, String(error), JSON.stringify(error), inspect(error, { depth: null })].join("\n")
}

function serializeSnapshot(snapshot: SettingsSnapshot): string {
    return inspect(snapshot, { depth: null, maxArrayLength: null, maxStringLength: null })
}

/** Captures what the code under test writes to this process's stderr. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; text: string }> {
    const original = process.stderr.write.bind(process.stderr)
    let text = ""
    process.stderr.write = ((chunk: string | Uint8Array) => {
        text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
        return true
    }) as typeof process.stderr.write
    try {
        return { result: await fn(), error: undefined, text }
    } catch (error) {
        return { result: undefined, error, text }
    } finally {
        process.stderr.write = original
    }
}

function assertFdClosed(fd: number | undefined): void {
    assert.ok(fd !== undefined, "file was opened")
    assert.throws(() => fs.fstatSync(fd), { code: "EBADF" })
}

describe("allowlist and secrets", () => {
    test("returns only the allowlisted settings", async () => {
        const snapshot = await read(newProfile())
        assert.deepEqual(Object.keys(snapshot).sort(), [
            "attempts",
            "dbVersion",
            "effectiveNextGroupId",
            "nextGroupId",
            "sourceGroups",
            "sourceRules",
        ])
        assert.equal(snapshot.attempts, 1)
        assert.deepEqual(snapshot.sourceGroups, {
            ok: true,
            present: true,
            value: [
                { gid: 0, isMultiple: true, sids: [0, 1], name: "Synthetic group", expanded: true },
                { gid: 1, isMultiple: false, sids: [1] },
            ],
        })
        assert.ok(snapshot.sourceRules.ok)
        assert.deepEqual([...snapshot.sourceRules.value.keys()], ["all", "source:0"])
        assert.deepEqual(snapshot.sourceRules.value.get("source:0"), [
            { filter: 15, search: "^x", match: false, actions: ["h-true", "s-false"] },
        ])
        assert.deepEqual(snapshot.nextGroupId, { ok: true, present: true, value: 2 })
        assert.deepEqual(snapshot.effectiveNextGroupId, { ok: true, value: 2 })
        assert.deepEqual(snapshot.dbVersion, { ok: true, present: true, value: "3" })
    })

    test("fake credentials never appear in the result", async () => {
        const text = serializeSnapshot(await read(newProfile()))
        assert.ok(!text.includes(SECRET_SENTINEL))
        assert.ok(!text.includes(FAKE_PASSWORD))
        assert.ok(!text.includes("serviceConfigs"))
        assert.ok(!text.includes("proxy.invalid"))
    })

    test("absent keys fall back to Fluent Reader's defaults and are marked absent", async () => {
        const snapshot = await read(newProfile({ serviceConfigs: { password: FAKE_PASSWORD } }))
        assert.deepEqual(snapshot.sourceGroups, { ok: true, present: false, value: [] })
        assert.ok(snapshot.sourceRules.ok && !snapshot.sourceRules.present && snapshot.sourceRules.value.size === 0)
        assert.deepEqual(snapshot.nextGroupId, { ok: true, present: false, value: null })
        assert.deepEqual(snapshot.effectiveNextGroupId, { ok: true, value: 0 })
        assert.deepEqual(snapshot.dbVersion, { ok: true, present: false, value: null })
    })

    test("invalid JSON with secrets: SETTINGS_INVALID, retried once, no fragment in the error", async () => {
        const broken = `{"serviceConfigs":{"password":"${FAKE_PASSWORD}"}, "sourceGroups": [ ${SECRET_SENTINEL}`
        const profile = newProfile(broken)
        const started = Date.now()
        const { error, text } = await captureStderr(() => read(profile))
        assert.ok(Date.now() - started >= 45, "one retry after ~50 ms")
        assert.ok(error instanceof FrMcpError)
        assert.equal(error.code, "SETTINGS_INVALID")
        assert.equal(error.reason, "not-json")
        const serialized = serializeError(error) + text
        assert.ok(!serialized.includes(SECRET_SENTINEL))
        assert.ok(!serialized.includes("serviceConfigs"))
        assert.ok(!serialized.includes(root))
    })

    test("a file fixed during the parse retry is accepted", async () => {
        const profile = newProfile("{ truncated")
        const promise = read(profile)
        writeSettings(profile.configPath, syntheticSettings())
        const snapshot = await promise
        assert.ok(snapshot.sourceGroups.ok)
    })

    test("invalid UTF-8 is SETTINGS_INVALID", async () => {
        const profile = newProfile()
        fs.writeFileSync(profile.configPath, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]))
        await expectError(read(profile), "SETTINGS_INVALID")
    })

    test("a non-object document is SETTINGS_INVALID", async () => {
        for (const doc of ["[]", "null", "42", '"text"']) {
            await expectError(read(newProfile(doc)), "SETTINGS_INVALID", "not-object")
        }
    })

    test("__proto__ keys stay inert", async () => {
        const doc = `{"sourceRules":{"__proto__":[{"filter":7,"search":"p","match":true,"actions":[]}]},"__proto__":{"polluted":true}}`
        const snapshot = await read(newProfile(doc))
        assert.ok(snapshot.sourceRules.ok)
        assert.deepEqual([...snapshot.sourceRules.value.keys()], ["__proto__"])
        assert.equal(({} as Record<string, unknown>).polluted, undefined)
    })
})

describe("size limits", () => {
    test(`a file larger than CFG_MAX (${CFG_MAX} bytes) is SETTINGS_TOO_LARGE`, async () => {
        const profile = newProfile()
        const doc = Buffer.alloc(CFG_MAX + 1, 0x20)
        doc.write('{"a":1}', 0)
        fs.writeFileSync(profile.configPath, doc)
        await expectError(read(profile), "SETTINGS_TOO_LARGE", "file-too-large")
    })

    test("a file of exactly CFG_MAX bytes is accepted", async () => {
        const profile = newProfile()
        const doc = Buffer.alloc(CFG_MAX, 0x20)
        doc.write(JSON.stringify(syntheticSettings()), 0)
        fs.writeFileSync(profile.configPath, doc)
        const snapshot = await read(profile)
        assert.ok(snapshot.sourceGroups.ok)
    })

    test("growth past CFG_MAX between fstat and read is SETTINGS_TOO_LARGE, never truncated", async () => {
        const profile = newProfile()
        const doc = Buffer.alloc(CFG_MAX, 0x20)
        doc.write("{}", 0)
        fs.writeFileSync(profile.configPath, doc)
        let fd: number | undefined
        await expectError(
            read(profile, {
                afterOpen: (_attempt, opened) => (fd = opened),
                afterFstat: () => fs.appendFileSync(profile.configPath, " "),
            }),
            "SETTINGS_TOO_LARGE",
        )
        assertFdClosed(fd)
    })

    test("growth below CFG_MAX between fstat and read is retried", async () => {
        const profile = newProfile()
        let grown = false
        const snapshot = await read(profile, {
            afterFstat: () => {
                if (!grown) fs.appendFileSync(profile.configPath, "   ")
                grown = true
            },
        })
        assert.equal(snapshot.attempts, 2)
    })
})

describe("structural limits (fail-closed per section)", () => {
    const rule = { filter: 7, search: "s", match: true, actions: ["r-true"] }

    test("wrong types invalidate only their section", async () => {
        const settings = { ...syntheticSettings(), sourceGroups: [{ gid: "zero", isMultiple: true, sids: [] }] }
        const snapshot = await read(newProfile(settings))
        assert.deepEqual(snapshot.sourceGroups, { ok: false, code: "SETTINGS_INVALID" })
        assert.ok(snapshot.sourceRules.ok)

        const badSids = await read(newProfile({ sourceGroups: [{ gid: 0, isMultiple: true, sids: "1,2" }] }))
        assert.deepEqual(badSids.sourceGroups, { ok: false, code: "SETTINGS_INVALID" })

        const badRules = await read(newProfile({ sourceRules: { all: [{ ...rule, filter: 1.5 }] } }))
        assert.deepEqual(badRules.sourceRules, { ok: false, code: "SETTINGS_INVALID" })
        const rulesArray = await read(newProfile({ sourceRules: [] }))
        assert.deepEqual(rulesArray.sourceRules, { ok: false, code: "SETTINGS_INVALID" })

        const badScalars = await read(newProfile({ nextGroupId: "2", dbVersion: { v: 1 } }))
        assert.deepEqual(badScalars.nextGroupId, { ok: false, code: "SETTINGS_INVALID" })
        assert.deepEqual(badScalars.effectiveNextGroupId, { ok: false, code: "SETTINGS_INVALID" })
        assert.deepEqual(badScalars.dbVersion, { ok: false, code: "SETTINGS_INVALID" })
    })

    test(`more than ${LIMITS.groupEntries} group entries is SETTINGS_TOO_LARGE`, async () => {
        const groups = Array.from({ length: LIMITS.groupEntries + 1 }, (_, i) => ({ gid: i, isMultiple: false, sids: [i] }))
        const snapshot = await read(newProfile({ sourceGroups: groups, sourceRules: { all: [rule] } }))
        assert.deepEqual(snapshot.sourceGroups, { ok: false, code: "SETTINGS_TOO_LARGE" })
        assert.ok(snapshot.sourceRules.ok)
    })

    test("too many sids per entry or in total is SETTINGS_TOO_LARGE", async () => {
        const perEntry = [{ gid: 0, isMultiple: true, sids: Array.from({ length: LIMITS.sidsPerEntry + 1 }, (_, i) => i) }]
        assert.deepEqual((await read(newProfile({ sourceGroups: perEntry }))).sourceGroups, {
            ok: false,
            code: "SETTINGS_TOO_LARGE",
        })
        const entries = Math.ceil((LIMITS.sidsTotal + 1) / LIMITS.sidsPerEntry)
        const total = Array.from({ length: entries }, (_, g) => ({
            gid: g,
            isMultiple: true,
            sids: Array.from({ length: LIMITS.sidsPerEntry }, (_, i) => i),
        }))
        assert.deepEqual((await read(newProfile({ sourceGroups: total }))).sourceGroups, {
            ok: false,
            code: "SETTINGS_TOO_LARGE",
        })
    })

    test("too many rule keys, rules per key or rules in total is SETTINGS_TOO_LARGE", async () => {
        const keys = Object.fromEntries(Array.from({ length: LIMITS.ruleKeys + 1 }, (_, i) => [`source:${i}`, []]))
        assert.deepEqual((await read(newProfile({ sourceRules: keys }))).sourceRules, { ok: false, code: "SETTINGS_TOO_LARGE" })

        const perKey = { all: Array.from({ length: LIMITS.rulesPerKey + 1 }, () => rule) }
        assert.deepEqual((await read(newProfile({ sourceRules: perKey }))).sourceRules, { ok: false, code: "SETTINGS_TOO_LARGE" })

        const keyCount = Math.ceil((LIMITS.rulesTotal + 1) / LIMITS.rulesPerKey)
        const total = Object.fromEntries(
            Array.from({ length: keyCount }, (_, k) => [`source:${k}`, Array.from({ length: LIMITS.rulesPerKey }, () => rule)]),
        )
        const snapshot = await read(newProfile({ sourceRules: total, sourceGroups: [] }))
        assert.deepEqual(snapshot.sourceRules, { ok: false, code: "SETTINGS_TOO_LARGE" })
        assert.ok(snapshot.sourceGroups.ok)
    })

    test("rules exceeding the action limits are marked malformed, not rejected", async () => {
        const many = { ...rule, actions: Array.from({ length: LIMITS.actionsPerRule + 1 }, () => "r-true") }
        const long = { ...rule, actions: ["x".repeat(LIMITS.actionLength + 1)] }
        const snapshot = await read(newProfile({ sourceRules: { all: [rule, many, long] } }))
        assert.ok(snapshot.sourceRules.ok)
        const rules = snapshot.sourceRules.value.get("all")
        assert.deepEqual(rules?.[0], rule)
        assert.deepEqual(rules?.[1], { filter: 7, search: "s", match: true, actions: null, malformed: "actions-limit" })
        assert.deepEqual(rules?.[2], { filter: 7, search: "s", match: true, actions: null, malformed: "actions-limit" })
    })
})

describe("file checks and atomic rename", () => {
    function atomicReplace(profile: ProfileFixture, value: unknown): void {
        const tmp = `${profile.configPath}.tmp-${process.hrtime.bigint()}`
        writeSettings(tmp, value)
        fs.renameSync(tmp, profile.configPath)
    }

    test("a rename between two reads is accepted and the new content is read", async () => {
        const profile = newProfile()
        const first = await read(profile)
        atomicReplace(profile, { ...syntheticSettings(), nextGroupId: 99 })
        const second = await read(profile)
        assert.deepEqual(first.nextGroupId, { ok: true, present: true, value: 2 })
        assert.deepEqual(second.nextGroupId, { ok: true, present: true, value: 99 })
        assert.equal(second.attempts, 1)
    })

    test("a rename once between lstat and open succeeds on the second attempt without a tamper flag", async () => {
        const profile = newProfile()
        const fds: number[] = []
        const { result, text } = await captureStderr(() =>
            read(profile, {
                afterLstat: (attempt) => {
                    if (attempt === 1) atomicReplace(profile, { ...syntheticSettings(), nextGroupId: 7 })
                },
                afterOpen: (_attempt, fd) => fds.push(fd),
            }),
        )
        assert.ok(result)
        assert.equal(result.attempts, 2)
        assert.deepEqual(result.nextGroupId, { ok: true, present: true, value: 7 })
        assert.equal(text, "", "no suspicious flag for a legitimate rename")
        assert.equal(fds.length, 2)
        for (const fd of fds) assertFdClosed(fd)
    })

    test(`a rename at every attempt ends with SETTINGS_TRANSIENT after ${MAX_READ_ATTEMPTS} attempts`, async () => {
        const profile = newProfile()
        let lstatCalls = 0
        const fds: number[] = []
        const error = await expectError(
            read(profile, {
                afterLstat: () => {
                    lstatCalls++
                    atomicReplace(profile, syntheticSettings())
                },
                afterOpen: (_attempt, fd) => fds.push(fd),
            }),
            "SETTINGS_TRANSIENT",
            "identity-mismatch",
        )
        assert.equal(lstatCalls, MAX_READ_ATTEMPTS)
        for (const fd of fds) assertFdClosed(fd)
        assert.ok(!serializeError(error).includes(root))
    })

    test("a missing config.json at read time is SETTINGS_UNAVAILABLE and is not recreated", async () => {
        const profile = newProfile()
        fs.unlinkSync(profile.configPath)
        await expectError(read(profile), "SETTINGS_UNAVAILABLE", "missing")
        assert.equal(fs.existsSync(profile.configPath), false)
    })

    test("config.json replaced by a directory is SETTINGS_UNAVAILABLE with a flag on stderr", async () => {
        const profile = newProfile()
        fs.unlinkSync(profile.configPath)
        fs.mkdirSync(profile.configPath)
        const { error, text } = await captureStderr(() => read(profile))
        assert.ok(error instanceof FrMcpError && error.code === "SETTINGS_UNAVAILABLE")
        assert.match(text, /"event":"settings_suspicious","reason":"not-regular-file"/)
        assert.ok(!text.includes(root))
    })

    test("config.json replaced by a symlink is SETTINGS_UNAVAILABLE with a flag on stderr", async (t) => {
        if (!canCreateFileSymlinks(root)) {
            t.skip("file symlinks cannot be created by this account (Developer Mode/admin required)")
            return
        }
        const profile = newProfile()
        const elsewhere = path.join(root, `elsewhere-${counter}.json`)
        writeSettings(elsewhere, syntheticSettings())
        fs.unlinkSync(profile.configPath)
        fs.symlinkSync(elsewhere, profile.configPath, "file")
        const { error, text } = await captureStderr(() => read(profile))
        assert.ok(error instanceof FrMcpError && error.code === "SETTINGS_UNAVAILABLE" && error.reason === "linked-file")
        assert.match(text, /"reason":"linked-file"/)
        assert.ok(!text.includes(root))
    })

    test("descriptors are closed after success and after errors", async () => {
        const profile = newProfile()
        let fd: number | undefined
        await read(profile, { afterOpen: (_a, opened) => (fd = opened) })
        assertFdClosed(fd)

        fd = undefined
        await expectError(
            read(profile, {
                afterOpen: (_a, opened) => {
                    fd = opened
                    throw new Error("injected failure after open")
                },
            }),
            "INTERNAL_ERROR",
        )
        assertFdClosed(fd)
    })
})

describe("effective next group id (FR-REV-002)", () => {
    const rule = { filter: 7, search: "s", match: true, actions: [] }

    test("nextGroupId absent with existing groups and group rules: no colliding id", async () => {
        const snapshot = await read(
            newProfile({
                sourceGroups: [
                    { gid: 0, isMultiple: true, sids: [0] },
                    { gid: 5, isMultiple: true, sids: [1] },
                    { gid: 2, isMultiple: false, sids: [2] },
                ],
                sourceRules: { all: [rule], "group:7": [rule], "source:40": [rule] },
            }),
        )
        assert.deepEqual(snapshot.nextGroupId, { ok: true, present: false, value: null })
        assert.deepEqual(snapshot.effectiveNextGroupId, { ok: true, value: 8 })
        const used = [0, 5, 2, 7]
        assert.ok(snapshot.effectiveNextGroupId.ok && !used.includes(snapshot.effectiveNextGroupId.value))
    })

    test("a stored counter larger than every id wins", async () => {
        const snapshot = await read(newProfile({ sourceGroups: [{ gid: 3, isMultiple: true, sids: [] }], nextGroupId: 20 }))
        assert.deepEqual(snapshot.effectiveNextGroupId, { ok: true, value: 20 })
    })

    test("a stale stored counter is raised past existing ids, as in the fork", async () => {
        const snapshot = await read(newProfile({ sourceGroups: [{ gid: 9, isMultiple: true, sids: [] }], nextGroupId: 1 }))
        assert.deepEqual(snapshot.nextGroupId, { ok: true, present: true, value: 1 })
        assert.deepEqual(snapshot.effectiveNextGroupId, { ok: true, value: 10 })
    })

    test("rule keys are parsed like the fork (Number()); negative and non-numeric ids are ignored", async () => {
        const snapshot = await read(
            newProfile({
                sourceGroups: [{ gid: -4, isMultiple: true, sids: [] }],
                sourceRules: { "group:abc": [rule], "group:-3": [rule], "group: 11": [rule], "group:1.5": [rule] },
            }),
        )
        // Number(" 11") === 11 is counted by the fork too; 1.5, -3, -4 and NaN are not.
        assert.deepEqual(snapshot.effectiveNextGroupId, { ok: true, value: 12 })
    })

    test("an invalid or too large input section makes it unavailable instead of guessing", async () => {
        const badGroups = await read(newProfile({ sourceGroups: [{ gid: "x", isMultiple: true, sids: [] }], nextGroupId: 3 }))
        assert.deepEqual(badGroups.effectiveNextGroupId, { ok: false, code: "SETTINGS_INVALID" })
        const keys = Object.fromEntries(Array.from({ length: LIMITS.ruleKeys + 1 }, (_, i) => [`group:${i}`, []]))
        const bigRules = await read(newProfile({ sourceRules: keys }))
        assert.deepEqual(bigRules.effectiveNextGroupId, { ok: false, code: "SETTINGS_TOO_LARGE" })
    })
})

describe("access errors (FR-REV-003)", { skip: process.platform !== "win32" }, () => {
    function currentUserSid(): string {
        const out = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).stdout
        const sid = /"(S-1-[\d-]+)"/.exec(out)?.[1]
        assert.ok(sid, "current user SID")
        return sid
    }

    function icacls(file: string, ...args: string[]): void {
        const result = spawnSync("icacls", [file, ...args], { encoding: "utf8" })
        assert.equal(result.status, 0, result.stdout + result.stderr)
    }

    test("a permanently denied read permission is SETTINGS_UNAVAILABLE, not SETTINGS_TRANSIENT", async () => {
        const profile = newProfile()
        const sid = currentUserSid()
        icacls(profile.configPath, "/deny", `*${sid}:(RD)`)
        try {
            let attempts = 0
            const { error, text } = await captureStderr(() => read(profile, { afterLstat: () => attempts++ }))
            assert.ok(error instanceof FrMcpError)
            assert.equal(error.code, "SETTINGS_UNAVAILABLE")
            assert.equal(error.reason, "permission-denied")
            assert.equal(attempts, MAX_READ_ATTEMPTS, "bounded retries")
            assert.ok(!serializeError(error).includes(root) && !text.includes(root))
        } finally {
            icacls(profile.configPath, "/remove:d", `*${sid}`)
        }
        assert.ok((await read(profile)).sourceGroups.ok, "readable again once the permission is restored")
    })

    test("a persistent sharing conflict (file held without read sharing) is SETTINGS_TRANSIENT", async () => {
        const profile = newProfile()
        const script =
            "$f = [IO.File]::Open($env:FRMCP_TARGET, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('HELD'); [void][Console]::In.ReadLine(); $f.Dispose()"
        const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        const holder = spawn(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
            env: { ...process.env, FRMCP_TARGET: profile.configPath },
            stdio: ["pipe", "pipe", "ignore"],
        })
        try {
            await new Promise<void>((resolve, reject) => {
                let out = ""
                holder.stdout.setEncoding("utf8").on("data", (chunk: string) => {
                    out += chunk
                    if (out.includes("HELD")) resolve()
                })
                holder.once("exit", () => reject(new Error("holder exited")))
            })
            await expectError(read(profile), "SETTINGS_TRANSIENT", "open-failed")
        } finally {
            holder.stdin.end()
            await new Promise((resolve) => holder.once("close", resolve))
        }
        assert.ok((await read(profile)).sourceGroups.ok, "readable once the conflict ends")
    })
})
