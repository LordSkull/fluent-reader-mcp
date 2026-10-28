import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileLock } from "../src/db/connection.js"
import { GROUP_SQL } from "../src/domain/group-catalog.js"
import { PATTERN_PREVIEW_MAX, REGEX_CHECK_MAX, RULES_CONSULTED_MAX } from "../src/domain/rules.js"
import { SOURCE_SQL } from "../src/domain/sources.js"
import { CursorRegistry, CURSOR_TTL_MS } from "../src/scan/cursors.js"
import { RESP_MAX } from "../src/tools/result.js"
import { listRulesOutput, type ListRulesOutput } from "../src/tools/schemas.js"
import { createTempRoot, findLeaks, removeTempRoot, SECRET_SENTINEL, snapshotDir, type ProfileFixture } from "./helpers/fixtures.js"
import {
    createSourcesProfile,
    harness,
    type Harness,
    type HarnessOptions,
    type SourcesProfileOptions,
    type ToolOutcome,
} from "./helpers/sources.js"

let root: string
let counter = 0
const open: Harness[] = []

before(() => {
    root = createTempRoot()
})
after(async () => {
    for (const h of open) await h.close()
    fileLock().close()
    removeTempRoot(root)
})

async function setup(options: Partial<SourcesProfileOptions> & { settings: unknown }, harnessOptions: HarnessOptions = {}): Promise<{ p: ProfileFixture; h: Harness }> {
    counter++
    const p = createSourcesProfile(path.join(root, `lr${counter}`), { sources: [{ sid: 0 }, { sid: 1 }, { sid: 2 }], ...options })
    const h = await harness(p, harnessOptions)
    open.push(h)
    return { p, h }
}

/** A stored rule; the editor's standard filter (23 = 7 | CaseInsensitive) by default. */
const R = (search: string, actions: unknown[] = ["r-true"], filter = 23, match = true) => ({ filter, search, match, actions })

async function rules(h: Harness, args: Record<string, unknown>): Promise<ListRulesOutput & { outcome: ToolOutcome }> {
    const outcome = await h.call("list_rules", args)
    assert.equal(outcome.isError, false, outcome.text)
    assert.ok(outcome.length <= RESP_MAX, String(outcome.length))
    assert.deepEqual(JSON.parse(outcome.text), outcome.payload)
    return { ...listRulesOutput.parse(outcome.payload), outcome }
}

async function allPages(h: Harness, args: Record<string, unknown>): Promise<ListRulesOutput[]> {
    const pages: ListRulesOutput[] = []
    let cursor: string | null = null
    do {
        const page = await rules(h, cursor === null ? args : { ...args, cursor })
        pages.push(page)
        cursor = page.nextCursor
        assert.ok(pages.length < 10_000)
    } while (cursor !== null)
    return pages
}

/** Counts executions (exec, and test/match/replace through it) of regexes whose source contains `marker`. */
function regexExecutions(marker: string): { count: () => number; restore: () => void } {
    const original = RegExp.prototype.exec
    let n = 0
    RegExp.prototype.exec = function (this: RegExp, input: string) {
        if (this.source.includes(marker)) n++
        return original.call(this, input)
    }
    return { count: () => n, restore: () => (RegExp.prototype.exec = original) }
}

const groups = [
    { gid: 3, isMultiple: true, sids: [1], name: "Group three" },
    { gid: 4, isMultiple: false, sids: [2] },
    { gid: 5, isMultiple: true, sids: [] },
    { gid: 5, isMultiple: true, sids: [0] },
]

describe("list_rules: targets and stored order", () => {
    test("1, 6. no rules: sourceRules absent, empty, key absent, empty array", async () => {
        for (const settings of [{ sourceGroups: [] }, { sourceGroups: [], sourceRules: {} }]) {
            const { h } = await setup({ settings })
            const page = await rules(h, { scope: "all", limit: 10 })
            assert.deepEqual(page.target, { scope: "all", key: "all", exists: true, status: "exists", name: null, keyPresent: false, ruleCount: 0 })
            assert.deepEqual([page.rules, page.hasMore, page.nextCursor, page.scan.stoppedBy], [[], false, null, "exhausted"])
            assert.equal(page.integrity.keyCount, 0)
            assert.match(page.revision, /^rr1\.[A-Za-z0-9_-]{22}$/)
        }
        const { h } = await setup({ settings: { sourceRules: { all: [] } } })
        const empty = await rules(h, { scope: "all", limit: 10 })
        assert.deepEqual([empty.target.keyPresent, empty.target.ruleCount, empty.integrity.emptyRuleArrays], [true, 0, 1])
    })

    test("2-5, 7. all, group and source targets: only the stored array, in order, with indices; absent and orphan targets", async () => {
        const { h } = await setup({
            settings: {
                sourceGroups: groups,
                sourceRules: {
                    all: [R("a0"), R("a1")],
                    "group:3": [R("g0")],
                    "source:1": [R("s0"), R("s1"), R("s2")],
                    "group:9": [R("orphan group")],
                    "group:4": [R("single")],
                    "group:5": [R("ambiguous")],
                    "source:50": [R("orphan source")],
                },
            },
        })
        const patterns = (page: ListRulesOutput) => page.rules.map((r) => [r.index, r.pattern])
        assert.deepEqual(patterns(await rules(h, { scope: "all", limit: 10 })), [[0, "a0"], [1, "a1"]])
        const group = await rules(h, { scope: "group", groupId: 3, limit: 10 })
        assert.deepEqual(patterns(group), [[0, "g0"]], "no inherited all rules")
        assert.deepEqual(group.target, { scope: "group", key: "group:3", exists: true, status: "exists", name: "Group three", keyPresent: true, ruleCount: 1 })
        const source = await rules(h, { scope: "source", sourceId: 1, limit: 10 })
        assert.deepEqual(patterns(source), [[0, "s0"], [1, "s1"], [2, "s2"]], "no inherited all or group rules")
        assert.deepEqual([source.target.exists, source.target.name], [true, "Source 1"])
        const statuses = async (args: Record<string, unknown>) => {
            const page = await rules(h, { ...args, limit: 10 })
            return [page.target.status, page.target.exists, page.target.name, page.rules.length]
        }
        assert.deepEqual(await statuses({ scope: "group", groupId: 9 }), ["absent", false, null, 1])
        assert.deepEqual(await statuses({ scope: "group", groupId: 4 }), ["singleEntry", false, null, 1])
        assert.deepEqual(await statuses({ scope: "group", groupId: 5 }), ["ambiguous", null, null, 1])
        assert.deepEqual(await statuses({ scope: "group", groupId: 77 }), ["absent", false, null, 0])
        assert.deepEqual(await statuses({ scope: "source", sourceId: 50 }), ["absent", false, null, 1])
        assert.deepEqual(await statuses({ scope: "source", sourceId: 2 }), ["exists", true, "Source 2", 0])
    })

    test("unreadable sourceGroups: group target unavailable, rules still listed; unreadable sourceRules: SETTINGS_INVALID", async () => {
        const { p, h } = await setup({ settings: { sourceGroups: "broken", sourceRules: { "group:3": [R("g")] }, serviceConfigs: { password: SECRET_SENTINEL } } })
        const page = await rules(h, { scope: "group", groupId: 3, limit: 10 })
        assert.deepEqual([page.target.status, page.target.exists, page.rules.length, page.integrity.groupKeys.groupsAvailable], ["unavailable", null, 1, false])
        assert.equal(page.integrity.groupKeys.orphans, null)
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceRules: { all: "broken" }, serviceConfigs: { password: SECRET_SENTINEL } }))
        const broken = await h.call("list_rules", { scope: "all", limit: 10 })
        assert.equal(broken.error?.code, "SETTINGS_INVALID")
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceRules: { all: Array(10_001).fill(R("x")) } }))
        assert.equal((await h.call("list_rules", { scope: "all", limit: 10 })).error?.code, "SETTINGS_TOO_LARGE")
        fs.rmSync(p.configPath)
        assert.equal((await h.call("list_rules", { scope: "all", limit: 10 })).error?.code, "SETTINGS_UNAVAILABLE")
        assert.ok(!broken.text.includes(SECRET_SENTINEL) && !page.outcome.text.includes(SECRET_SENTINEL))
    })

    test("invalid input: target combinations, limit, unknown keys", async () => {
        const { h } = await setup({ settings: { sourceRules: {} } })
        for (const args of [
            { scope: "all" },
            { scope: "all", limit: 0 },
            { scope: "all", limit: 101 },
            { scope: "all", groupId: 1, limit: 5 },
            { scope: "all", sourceId: 1, limit: 5 },
            { scope: "group", limit: 5 },
            { scope: "group", groupId: 1, sourceId: 1, limit: 5 },
            { scope: "group", groupId: -1, limit: 5 },
            { scope: "source", limit: 5 },
            { scope: "source", groupId: 1, limit: 5 },
            { scope: "source", sourceId: 1.5, limit: 5 },
            { scope: "rules", limit: 5 },
            { scope: "all", limit: 5, extra: true },
        ]) {
            const r = await h.call("list_rules", args)
            assert.deepEqual([r.error?.code, r.error?.reason], ["INVALID_ARGUMENT", "invalid-argument"], JSON.stringify(args))
        }
    })
})

describe("list_rules: static decoding and diagnostics", () => {
    test("8-10. bitmask: standard and non-standard filters, FullSearch over CreatorSearch, match false", async () => {
        const stored = [
            R("t", ["r-true"], 7),
            R("c", ["r-true"], 55), // 7 | CaseInsensitive | CreatorSearch
            R("both", ["r-true"], 47), // 7 | FullSearch | CreatorSearch: FullSearch wins, not an editor value
            R("state", ["r-true"], 0), // no state bit: unread, starred and visible required
            R("extra bit", ["r-true"], 71), // 7 | 64 (ignored by the app)
            R("int32", ["r-true"], 2 ** 32 + 7), // ToInt32 → 7 in the app
            R("inverted", ["r-true"], 15, false),
            R("negative", ["r-true"], -1),
        ]
        const { h } = await setup({ settings: { sourceRules: { all: stored } } })
        const page = await rules(h, { scope: "all", limit: 100 })
        const view = page.rules.map((r) => [
            r.pattern,
            r.field,
            r.caseSensitive,
            r.match,
            [r.stateMask.requireUnread, r.stateMask.requireStarred, r.stateMask.requireVisible],
            r.rawFilter,
            r.standard,
            r.diagnostics.includes("nonStandardFilter"),
        ])
        assert.deepEqual(view, [
            ["t", "title", true, true, [false, false, false], 7, true, false],
            ["c", "creator", false, true, [false, false, false], 55, true, false],
            ["both", "text", true, true, [false, false, false], 47, false, true],
            ["state", "title", true, true, [true, true, true], 0, false, true],
            ["extra bit", "title", true, true, [false, false, false], 71, false, true],
            ["int32", "title", true, true, [false, false, false], 2 ** 32 + 7, false, true],
            ["inverted", "text", true, false, [false, false, false], 15, true, false],
            ["negative", "text", false, true, [false, false, false], -1, false, true],
        ])
    })

    test("11, 12. regex syntax only (never executed), empty and long patterns, preview without truncated surrogates", async () => {
        const marker = "MARKERzq"
        const long = "a".repeat(REGEX_CHECK_MAX + 1)
        const emoji = "😀".repeat(PATTERN_PREVIEW_MAX + 100)
        const stored = [
            R(`^${marker}\\d+$`),
            R(`(${marker}`),
            R(""),
            R(long),
            R(emoji),
            R(`(${marker}a+)+$`), // catastrophic if executed, harmless when only compiled
            R("[z-a]"),
        ]
        const { h } = await setup({ settings: { sourceRules: { all: stored } } })
        const spy = regexExecutions(marker)
        let page: ListRulesOutput & { outcome: ToolOutcome }
        try {
            page = await rules(h, { scope: "all", limit: 100 })
        } finally {
            spy.restore()
        }
        assert.equal(spy.count(), 0, "no rule pattern is ever executed")
        const diag = page.rules.map((r) => r.diagnostics.filter((d) => ["invalidRegex", "regexNotChecked", "emptyPattern"].includes(d)))
        assert.deepEqual(diag, [[], ["invalidRegex"], ["emptyPattern"], ["regexNotChecked"], [], [], ["invalidRegex"]])
        const longRule = page.rules[3]!
        assert.deepEqual([longRule.pattern.length, longRule.patternTruncated, longRule.patternLength], [PATTERN_PREVIEW_MAX, true, REGEX_CHECK_MAX + 1])
        const emojiRule = page.rules[4]!
        assert.deepEqual([emojiRule.pattern, emojiRule.patternTruncated, emojiRule.patternLength], ["😀".repeat(PATTERN_PREVIEW_MAX), true, PATTERN_PREVIEW_MAX + 100])
        assert.deepEqual([page.rules[0]!.patternTruncated, page.rules[0]!.patternLength], [false, marker.length + 5])
        assert.ok(!page.outcome.text.includes("Invalid regular expression"), "no raw engine message")
    })

    test("13. actions decoded as the app does: non-standard forms, unknown, duplicate, contradictory, none, malformed", async () => {
        const stored = [
            R("std", ["r-true", "s-false"]),
            R("nosuffix", ["r"]),
            R("empty suffix", ["r-"]),
            R("other suffix", ["r-yes"]),
            R("extra part", ["r-true-x"]),
            R("contradiction", ["h-true", "r-true", "h-false"]),
            R("duplicate", ["r-true", "r-true"]),
            R("unknown", ["x-true", "r-true"]),
            R("prototype", ["constructor-true", "__proto__"]),
            R("none", []),
            R("malformed", Array(65).fill("r-true")),
        ]
        const { h } = await setup({ settings: { sourceRules: { all: stored } } })
        const page = await rules(h, { scope: "all", limit: 100 })
        const view = Object.fromEntries(
            page.rules.map((r) => [
                r.pattern,
                [r.actions?.map((a) => `${a.action}:${a.value}`) ?? null, r.unknownActionCount, r.rawActionCount, r.standard, r.diagnostics.filter((d) => d !== "nonStandardFilter")],
            ]),
        )
        assert.deepEqual(view, {
            std: [["read:true", "star:false"], 0, 2, true, []],
            nosuffix: [["read:true"], 0, 1, false, ["nonStandardAction"]],
            "empty suffix": [["read:true"], 0, 1, false, ["nonStandardAction"]],
            "other suffix": [["read:false"], 0, 1, false, ["nonStandardAction"]],
            "extra part": [["read:true"], 0, 1, false, ["nonStandardAction"]],
            contradiction: [["hide:false", "read:true"], 0, 3, false, ["duplicateAction", "contradictoryActions"]],
            duplicate: [["read:true"], 0, 2, false, ["duplicateAction"]],
            unknown: [["read:true"], 1, 2, false, ["unknownAction"]],
            prototype: [[], 2, 2, false, ["unknownAction", "nonStandardAction"]],
            none: [[], 0, 0, false, ["noActions"]],
            malformed: [null, 0, 65, false, ["malformedActions"]], // original count, actions not decodable
        })
    })

    test("14, 15. key integrity: orphan, single-entry, ambiguous, negative and malformed keys, as counts and id samples", async () => {
        const { h } = await setup({
            settings: {
                sourceGroups: [...groups, { gid: -1, isMultiple: true, sids: [2] }],
                sourceRules: {
                    all: [R("a")],
                    "group:3": [R("g")],
                    "group:9": [R("g")],
                    "group:4": [R("g")],
                    "group:5": [R("g")],
                    "group:-1": [R("g")],
                    "source:1": [R("s")],
                    "source:77": [R("s")],
                    "source:-2": [R("s")],
                    "source:2": [],
                    "group:03": [R("m")],
                    [`private ${SECRET_SENTINEL}`]: [R("m")],
                    "source:9007199254740993": [R("m")],
                    "": [R("m")],
                },
            },
        })
        const { integrity, outcome } = await rules(h, { scope: "all", limit: 10 })
        assert.deepEqual(integrity, {
            keyCount: 14,
            ruleCount: 13,
            emptyRuleArrays: 1,
            oversizedRuleArrays: 0,
            malformedKeys: 4,
            negativeIdKeys: 2,
            sourceKeys: { count: 3, check: "complete", orphans: { count: 1, sample: [77] } },
            groupKeys: {
                count: 4,
                groupsAvailable: true,
                orphans: { count: 1, sample: [9] },
                singleEntryOnly: { count: 1, sample: [4] },
                ambiguous: { count: 1, sample: [5] },
            },
        })
        assert.deepEqual(findLeaks([outcome.text], [SECRET_SENTINEL, "private", "group:03"]), [])
    })
})

describe("list_rules: pagination, limits, privacy", () => {
    const many = Array.from({ length: 25 }, (_, k) => R(`rule ${k}`, [k % 2 ? "h-true" : "r-true"]))

    test("16. pagination by index, replay, revision and staleness, mismatch, expiry", async () => {
        let now = Date.UTC(2026, 9, 29, 12)
        const clock = () => now
        const settings = { sourceRules: { all: many, "source:1": [R("other")] } }
        const { p, h } = await setup({ settings }, { now: clock, cursors: new CursorRegistry({ now: clock }) })
        for (const limit of [1, 4, 7, 100]) {
            const pages = await allPages(h, { scope: "all", limit })
            assert.deepEqual(pages.flatMap((pg) => pg.rules.map((r) => r.index)), many.map((_, k) => k), `limit ${limit}`)
            for (const page of pages.slice(0, -1)) assert.equal(page.scan.stoppedBy, "pageFull")
            assert.equal(new Set(pages.map((pg) => pg.revision)).size, 1)
        }
        const first = await rules(h, { scope: "all", limit: 4 })
        const cursor = first.nextCursor
        for (const args of [{ scope: "all", limit: 5 }, { scope: "source", sourceId: 1, limit: 4 }]) {
            assert.equal((await h.call("list_rules", { ...args, cursor })).error?.code, "CURSOR_MISMATCH")
        }
        const second = await h.call("list_rules", { scope: "all", limit: 4, cursor })
        // replayed verbatim even after the rules changed
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceRules: { all: many.slice(1) } }))
        assert.equal((await h.call("list_rules", { scope: "all", limit: 4, cursor })).text, second.text)
        const changes = [
            [...many.slice(1), many[0]], // order
            many.map((r, k) => (k === 20 ? { ...r, filter: 7 } : r)),
            many.map((r, k) => (k === 20 ? { ...r, search: "changed" } : r)),
            many.map((r, k) => (k === 20 ? { ...r, actions: ["s-true"] } : r)),
            many.map((r, k) => (k === 20 ? { ...r, match: false } : r)),
            [...many, R("appended")],
        ]
        for (const change of changes) {
            fs.writeFileSync(p.configPath, JSON.stringify(settings))
            const start = await rules(h, { scope: "all", limit: 4 })
            fs.writeFileSync(p.configPath, JSON.stringify({ ...settings, sourceRules: { ...settings.sourceRules, all: change } }))
            const stale = await h.call("list_rules", { scope: "all", limit: 4, cursor: start.nextCursor })
            assert.deepEqual([stale.error?.code, stale.error?.reason], ["CURSOR_STALE", "rules-changed"])
            assert.equal((await h.call("list_rules", { scope: "all", limit: 4, cursor: start.nextCursor })).error?.code, "CURSOR_EXPIRED")
        }
        // another target's rules or the groups changing does not affect this listing
        fs.writeFileSync(p.configPath, JSON.stringify(settings))
        const keep = await rules(h, { scope: "all", limit: 4 })
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceGroups: [{ gid: 1, isMultiple: true, sids: [1] }], sourceRules: { all: many, "source:1": [] } }))
        assert.deepEqual((await rules(h, { scope: "all", limit: 4, cursor: keep.nextCursor })).rules.map((r) => r.index), [4, 5, 6, 7])
        const late = await rules(h, { scope: "all", limit: 4 })
        now += CURSOR_TTL_MS + 1
        assert.equal((await h.call("list_rules", { scope: "all", limit: 4, cursor: late.nextCursor })).error?.code, "CURSOR_EXPIRED")
    })

    test("17. responses within 48,000 UTF-16 units; huge target name and too many rules are LIMIT_EXCEEDED", async () => {
        const heavy = Array.from({ length: 60 }, (_, k) => R(`${k}` + "\u0001\"\\".repeat(200)))
        const { h } = await setup({
            settings: {
                sourceGroups: [{ gid: 1, isMultiple: true, sids: [], name: "N".repeat(30_000) }],
                sourceRules: { all: heavy, "group:1": [R("x")], "source:2": Array(RULES_CONSULTED_MAX + 1).fill(R("x")) },
            },
        })
        const pages = await allPages(h, { scope: "all", limit: 100 })
        assert.deepEqual(pages.flatMap((pg) => pg.rules.map((r) => r.index)), heavy.map((_, k) => k))
        assert.ok(pages.length > 2)
        for (const page of pages.slice(0, -1)) assert.equal(page.scan.stoppedBy, "responseBudget")
        const named = await h.call("list_rules", { scope: "group", groupId: 1, limit: 5 })
        assert.deepEqual([named.error?.code, named.error?.reason], ["LIMIT_EXCEEDED", "response-too-large"])
        const tooMany = await h.call("list_rules", { scope: "source", sourceId: 2, limit: 5 })
        assert.deepEqual([tooMany.error?.code, tooMany.error?.reason], ["LIMIT_EXCEEDED", "too-many-rules"])
    })

    test("18. only the requested target; no secrets from other keys; read-only, ids-only SQL", async () => {
        counter++
        const p = createSourcesProfile(path.join(root, `lr${counter}`), {
            sources: [{ sid: 1, url: `https://feed.invalid/${SECRET_SENTINEL}`, serviceRef: SECRET_SENTINEL }],
            items: 5,
            settings: {
                sourceRules: { all: [R("visible")], "source:1": [R(`other-target-${SECRET_SENTINEL}`)] },
                serviceConfigs: { password: SECRET_SENTINEL, apiKey: SECRET_SENTINEL },
                pac: `http://proxy.invalid/${SECRET_SENTINEL}`,
            },
        })
        const initial = snapshotDir(p.dir)
        const h = await harness(p)
        open.push(h)
        const page = await rules(h, { scope: "all", limit: 10 })
        assert.deepEqual(findLeaks([page.outcome.text, JSON.stringify(page.outcome.result)], [SECRET_SENTINEL, "invalid", "http"]), [])
        await rules(h, { scope: "source", sourceId: 1, limit: 10 })
        const statements = [...new Set(h.sql)].sort()
        assert.deepEqual(statements, [GROUP_SQL.existing, SOURCE_SQL.candidate, SOURCE_SQL.rows].sort())
        await h.close()
        open.splice(open.indexOf(h), 1)
        assert.deepEqual(snapshotDir(p.dir), initial, "same files, same hashes: no -wal, -shm or -journal")
    })
})
