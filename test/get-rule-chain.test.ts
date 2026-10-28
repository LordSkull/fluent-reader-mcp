import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, test } from "node:test"
import { fileLock } from "../src/db/connection.js"
import { RULES_CONSULTED_MAX } from "../src/domain/rules.js"
import { SOURCE_SQL } from "../src/domain/sources.js"
import { CursorRegistry, CURSOR_TTL_MS } from "../src/scan/cursors.js"
import { RESP_MAX } from "../src/tools/result.js"
import { CHAIN_SEMANTICS, getRuleChainOutput, type GetRuleChainOutput } from "../src/tools/schemas.js"
import { createTempRoot, findLeaks, removeTempRoot, SECRET_SENTINEL, snapshotDir, type ProfileFixture } from "./helpers/fixtures.js"
import {
    createSourcesProfile,
    harness,
    mutate,
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
    const sources = [0, 1, 2, 5, 10, 11, 12].map((sid) => ({ sid }))
    const p = createSourcesProfile(path.join(root, `rc${counter}`), { sources, ...options })
    const h = await harness(p, harnessOptions)
    open.push(h)
    return { p, h }
}

const R = (search: string, actions: unknown[] = ["r-true"], filter = 23, match = true) => ({ filter, search, match, actions })

async function chain(h: Harness, args: Record<string, unknown>): Promise<GetRuleChainOutput & { outcome: ToolOutcome }> {
    const outcome = await h.call("get_rule_chain", args)
    assert.equal(outcome.isError, false, outcome.text)
    assert.ok(outcome.length <= RESP_MAX, String(outcome.length))
    assert.deepEqual(JSON.parse(outcome.text), outcome.payload)
    const parsed = getRuleChainOutput.parse(outcome.payload)
    assert.equal(parsed.semantics, CHAIN_SEMANTICS)
    return { ...parsed, outcome }
}

async function allPages(h: Harness, args: Record<string, unknown>): Promise<GetRuleChainOutput[]> {
    const pages: GetRuleChainOutput[] = []
    let cursor: string | null = null
    do {
        const page = await chain(h, cursor === null ? args : { ...args, cursor })
        pages.push(page)
        cursor = page.nextCursor
        assert.ok(pages.length < 10_000)
    } while (cursor !== null)
    return pages
}

const view = (page: GetRuleChainOutput) => page.chain.map((e) => `${e.order}:${e.origin}:${e.originKey}[${e.index}]${e.inherited ? "^" : ""}=${e.rule.pattern}`)

const basic = {
    sourceGroups: [
        { gid: 3, isMultiple: true, sids: [1, 2], name: "Three" },
        { gid: 6, isMultiple: true, sids: [1] },
    ],
    sourceRules: {
        all: [R("a0"), R("a1")],
        "group:3": [R("g0")],
        "group:6": [R("later group")],
        "source:1": [R("s0"), R("s1")],
        "source:5": [R("lonely")],
    },
}

describe("get_rule_chain: chains in the app's order", () => {
    test("1-5, 10, 17. all; all + group; all + first group + source; source without group; order and original indices", async () => {
        const { h } = await setup({ settings: basic })
        const all = await chain(h, { all: true })
        assert.deepEqual(view(all), ["0:all:all[0]=a0", "1:all:all[1]=a1"])
        assert.deepEqual(all.resolution, {
            complete: true,
            groupStatus: "notApplicable",
            reason: "targetIsAll",
            groupId: null,
            groupPosition: null,
            chainLength: 2,
            countByOrigin: { all: 2, group: 0, source: 0 },
        })
        const group = await chain(h, { groupId: 3 })
        assert.deepEqual(view(group), ["0:all:all[0]^=a0", "1:all:all[1]^=a1", "2:group:group:3[0]=g0"])
        assert.deepEqual([group.target.name, group.resolution.groupStatus, group.resolution.groupPosition], ["Three", "target", 0])
        const source = await chain(h, { sourceId: 1 })
        assert.deepEqual(view(source), [
            "0:all:all[0]^=a0",
            "1:all:all[1]^=a1",
            "2:group:group:3[0]^=g0", // the first group only, never the later group 6
            "3:source:source:1[0]=s0",
            "4:source:source:1[1]=s1",
        ])
        assert.deepEqual(
            [source.resolution.complete, source.resolution.groupStatus, source.resolution.reason, source.resolution.groupId, source.resolution.countByOrigin],
            [true, "grouped", "firstMultipleGroup", 3, { all: 2, group: 1, source: 2 }],
        )
        assert.deepEqual([source.target.key, source.target.name, source.target.sourceId], ["source:1", "Source 1", 1])
        assert.deepEqual(view(await chain(h, { sourceId: 2 })), ["0:all:all[0]^=a0", "1:all:all[1]^=a1", "2:group:group:3[0]^=g0"])
        const lonely = await chain(h, { sourceId: 5 })
        assert.deepEqual(view(lonely), ["0:all:all[0]^=a0", "1:all:all[1]^=a1", "2:source:source:5[0]=lonely"])
        assert.deepEqual([lonely.resolution.complete, lonely.resolution.groupStatus, lonely.resolution.reason], [true, "ungrouped", "noMultipleGroup"])
    })

    test("6-8. earlier negative gid, ambiguous first group, unreadable groups: no fictitious group, chain declared incomplete; errors", async () => {
        const settings = {
            sourceGroups: [
                { gid: -1, isMultiple: true, sids: [10] },
                { gid: 4, isMultiple: true, sids: [10, 11] },
                { gid: 5, isMultiple: true, sids: [12] },
                { gid: 5, isMultiple: false, sids: [2] },
                { gid: 6, isMultiple: true, sids: [11, 12] },
                { gid: 7, isMultiple: false, sids: [0] },
            ],
            sourceRules: {
                all: [R("a")],
                "group:-1": [R("negative")],
                "group:4": [R("four")],
                "group:5": [R("five")],
                "group:6": [R("six")],
                "source:10": [R("s10")],
                "source:12": [R("s12")],
            },
        }
        const { p, h } = await setup({ settings })
        assert.deepEqual(view(await chain(h, { sourceId: 11 })), ["0:all:all[0]^=a", "1:group:group:4[0]^=four"], "first of several groups")
        const negative = await chain(h, { sourceId: 10 })
        assert.deepEqual(view(negative), ["0:all:all[0]^=a", "1:source:source:10[0]=s10"], "neither group:-1 nor the later group:4")
        assert.deepEqual(
            [negative.resolution.complete, negative.resolution.groupStatus, negative.resolution.reason, negative.resolution.groupId, negative.resolution.groupPosition],
            [false, "unavailable", "firstGroupIdInvalid", null, 0],
        )
        const ambiguous = await chain(h, { sourceId: 12 })
        assert.deepEqual(view(ambiguous), ["0:all:all[0]^=a", "1:source:source:12[0]=s12"], "group:5 not resolved arbitrarily, group:6 not used")
        assert.deepEqual(
            [ambiguous.resolution.complete, ambiguous.resolution.groupStatus, ambiguous.resolution.reason, ambiguous.resolution.groupId],
            [false, "ambiguous", "firstGroupIdAmbiguous", 5],
        )
        assert.deepEqual((await h.call("get_rule_chain", { groupId: 5 })).error?.code, "GROUP_AMBIGUOUS")
        assert.deepEqual((await h.call("get_rule_chain", { groupId: 7 })).error?.reason, "not-a-group")
        assert.deepEqual((await h.call("get_rule_chain", { groupId: 77 })).error?.code, "NOT_FOUND")
        const missing = await h.call("get_rule_chain", { sourceId: 99 })
        assert.deepEqual([missing.error?.code, missing.error?.reason], ["NOT_FOUND", "source-not-found"])

        fs.writeFileSync(p.configPath, JSON.stringify({ ...settings, sourceGroups: "broken", serviceConfigs: { password: SECRET_SENTINEL } }))
        const unavailable = await chain(h, { sourceId: 11 })
        assert.deepEqual([unavailable.resolution.complete, unavailable.resolution.reason, unavailable.resolution.groupPosition], [false, "groupsUnavailable", null])
        const groupTarget = await h.call("get_rule_chain", { groupId: 4 })
        assert.equal(groupTarget.error?.code, "SETTINGS_INVALID")
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceRules: "broken" }))
        assert.equal((await h.call("get_rule_chain", { all: true })).error?.code, "SETTINGS_INVALID")
        assert.ok(!groupTarget.text.includes(SECRET_SENTINEL) && !unavailable.outcome.text.includes(SECRET_SENTINEL))
    })

    test("9. sourceRef: valid, replaced source, invalid combinations", async () => {
        const { p, h } = await setup({ settings: basic })
        const ref = (await h.call("get_source", { sourceId: 1 })).payload.source.sourceRef as string
        const ok = await chain(h, { sourceId: 1, sourceRef: ref })
        assert.equal(ok.target.sourceRef, ref)
        mutate(p.dbPath, "UPDATE sources SET url = 'https://feed.invalid/replaced' WHERE sid = 1")
        const replaced = await h.call("get_rule_chain", { sourceId: 1, sourceRef: ref })
        assert.equal(replaced.error?.code, "SOURCE_IDENTITY_CHANGED")
        assert.ok(!replaced.text.includes("feed.invalid"))
        for (const args of [
            {},
            { sourceRef: ref },
            { groupId: 3, sourceRef: ref },
            { sourceId: 1, groupId: 3 },
            { sourceId: 1, all: true },
            { all: false },
            { all: true, limit: 0 },
            { all: true, limit: 101 },
            { all: true, rules: [] },
            { sourceId: 1, sourceRef: "sr1.bad" },
        ]) {
            const r = await h.call("get_rule_chain", args)
            assert.deepEqual([r.error?.code, r.error?.reason], ["INVALID_ARGUMENT", "invalid-argument"], JSON.stringify(args))
        }
    })
})

describe("get_rule_chain: structural notes and fetch blockers", () => {
    test("11-16. opposite actions across scopes, state dependence, match false, non-standard rules, invalid regex, unknown actions", async () => {
        const settings = {
            sourceGroups: [{ gid: 3, isMultiple: true, sids: [1] }],
            sourceRules: {
                all: [
                    R("x", ["h-true"], 7), // 0
                    R("x", ["h-true"], 7), // 1: duplicate of 0
                    R("(", ["r-true"]), // 2: invalid regex
                ],
                "group:3": [
                    R("x", ["h-false"], 7), // 3: same state-independent condition as 0, opposite value (proven)
                    R("y", ["s-true", "s-false"]), // 4: contradictory inside the rule
                    R("", ["zz-true"], 7, true), // 5: unknown action, condition always true: every article
                ],
                "source:1": [
                    R("u", ["r-true"], 6), // 6: requires unread (ShowRead unset)
                    R("v", ["h-true"], 6), // 7: requires unread, which orders 2 and 6 can set: state dependent
                    R("u", ["r-false"], 6), // 8: same condition as 6, opposite value, state dependent (possible)
                    R("w", ["q-true"], 23, false), // 9: unknown action, applies only when matched (match false)
                    R("", ["zz-true"], 7, false), // 10: unknown action, condition never applies: no blocker
                ],
            },
        }
        const { h } = await setup({ settings })
        const page = await chain(h, { sourceId: 1 })
        assert.equal(page.chain.length, 11)
        const notes = page.conflicts.map((c) => `${c.kind}:${c.certainty}:${c.flag}:${c.orders.join(",")}`).sort()
        assert.deepEqual(notes, [
            "contradictoryActionsInRule:proven:null:4",
            "duplicateRule:proven:null:0,1",
            "oppositeActionsSameCondition:possible:read:6,8",
            "oppositeActionsSameCondition:proven:hide:0,1,3",
            "sameFlagDifferentConditions:notStaticallyDecidable:hide:0,1,3,7",
            "sameFlagDifferentConditions:notStaticallyDecidable:read:2,6,8",
            "stateDependentCondition:possible:read:6,7,8", // order 2 sets read before them
        ])
        assert.deepEqual(page.conflictCounts, {
            duplicateRule: 1,
            oppositeActionsSameCondition: 2,
            sameFlagDifferentConditions: 2,
            contradictoryActionsInRule: 1,
            stateDependentCondition: 1,
        })
        assert.deepEqual(page.fetchBlockers, [
            { order: 2, kind: "invalidRegex", certainty: "everyArticle" },
            { order: 5, kind: "unknownAction", certainty: "everyArticle" },
            { order: 9, kind: "unknownAction", certainty: "whenMatched" },
        ])
        assert.deepEqual(page.fetchBlockerCounts, { everyArticle: 2, whenMatched: 1, notDeterminable: 0 })
        const rule = (order: number) => page.chain[order]!.rule
        assert.deepEqual([rule(9).match, rule(6).stateMask.requireUnread, rule(6).standard, rule(2).diagnostics], [false, true, false, ["invalidRegex"]])
        assert.ok(rule(10).diagnostics.includes("unknownAction"))
    })

    test("notes on a page are those involving its window; counts cover the whole chain", async () => {
        const all = Array.from({ length: 12 }, (_, k) => R(`r${k}`, [k === 11 ? "h-false" : "h-true"], 7))
        all[10] = R("r0", ["h-true"], 7) // duplicate of order 0
        const { h } = await setup({ settings: { sourceRules: { all } } })
        const first = await chain(h, { all: true, limit: 4 })
        assert.deepEqual(first.conflicts.map((c) => c.kind).sort(), ["duplicateRule", "sameFlagDifferentConditions"])
        const second = await chain(h, { all: true, limit: 4, cursor: first.nextCursor })
        assert.deepEqual(second.conflicts.map((c) => c.kind), ["sameFlagDifferentConditions"])
        assert.deepEqual(second.conflictCounts.duplicateRule, 1)
    })
})

describe("get_rule_chain: pagination, revisions, limits, read-only", () => {
    const settings = {
        sourceGroups: [{ gid: 3, isMultiple: true, sids: [1] }],
        sourceRules: {
            all: Array.from({ length: 10 }, (_, k) => R(`a${k}`)),
            "group:3": Array.from({ length: 10 }, (_, k) => R(`g${k}`)),
            "source:1": Array.from({ length: 10 }, (_, k) => R(`s${k}`)),
            "source:2": [R("unrelated")],
        },
    }

    test("18-20. the whole chain by order, replay after changes, CURSOR_STALE when the rules or the group used change", async () => {
        let now = Date.UTC(2026, 9, 29, 12)
        const clock = () => now
        const { p, h } = await setup({ settings }, { now: clock, cursors: new CursorRegistry({ now: clock }) })
        const expected = [...settings.sourceRules.all.map((r) => r.search), ...settings.sourceRules["group:3"].map((r) => r.search), ...settings.sourceRules["source:1"].map((r) => r.search)]
        for (const limit of [1, 4, 7, 100]) {
            const pages = await allPages(h, { sourceId: 1, limit })
            assert.deepEqual(pages.flatMap((pg) => pg.chain.map((e) => e.rule.pattern)), expected, `limit ${limit}`)
            assert.deepEqual(pages.flatMap((pg) => pg.chain.map((e) => e.order)), expected.map((_, k) => k))
            assert.equal(new Set(pages.map((pg) => pg.chainRevision)).size, 1)
        }
        const first = await chain(h, { sourceId: 1, limit: 4 })
        const cursor = first.nextCursor
        for (const args of [{ sourceId: 2 }, { groupId: 3 }, { all: true }, { sourceId: 1, limit: 5 }]) {
            assert.equal((await h.call("get_rule_chain", { ...args, cursor })).error?.code, "CURSOR_MISMATCH", JSON.stringify(args))
        }
        assert.equal((await h.call("list_rules", { scope: "all", limit: 4, cursor })).error?.code, "CURSOR_MISMATCH")
        const second = await h.call("get_rule_chain", { sourceId: 1, cursor })
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceRules: {} }))
        assert.equal((await h.call("get_rule_chain", { sourceId: 1, cursor })).text, second.text, "replayed verbatim")

        const changes: unknown[] = [
            { ...settings, sourceRules: { ...settings.sourceRules, all: settings.sourceRules.all.slice(1) } },
            { ...settings, sourceRules: { ...settings.sourceRules, "group:3": [...settings.sourceRules["group:3"], R("new")] } },
            { ...settings, sourceRules: { ...settings.sourceRules, "source:1": settings.sourceRules["source:1"].map((r, k) => (k === 9 ? { ...r, filter: 7 } : r)) } },
            { ...settings, sourceGroups: [{ gid: 8, isMultiple: true, sids: [1] }, ...settings.sourceGroups] }, // another first group
            { ...settings, sourceGroups: [] }, // no group any more
        ]
        for (const change of changes) {
            fs.writeFileSync(p.configPath, JSON.stringify(settings))
            const start = await chain(h, { sourceId: 1, limit: 4 })
            fs.writeFileSync(p.configPath, JSON.stringify(change))
            const stale = await h.call("get_rule_chain", { sourceId: 1, cursor: start.nextCursor })
            assert.deepEqual([stale.error?.code, stale.error?.reason], ["CURSOR_STALE", "rules-changed"], JSON.stringify(change).slice(0, 80))
            assert.equal((await h.call("get_rule_chain", { sourceId: 1, cursor: start.nextCursor })).error?.code, "CURSOR_EXPIRED")
        }
        // the source replaced under the same id is another chain
        fs.writeFileSync(p.configPath, JSON.stringify(settings))
        const before = await chain(h, { sourceId: 1, limit: 4 })
        mutate(p.dbPath, "UPDATE sources SET url = 'https://feed.invalid/other' WHERE sid = 1")
        assert.equal((await h.call("get_rule_chain", { sourceId: 1, cursor: before.nextCursor })).error?.code, "CURSOR_STALE")
        // unrelated changes keep the chain
        const keep = await chain(h, { sourceId: 1, limit: 4 })
        fs.writeFileSync(p.configPath, JSON.stringify({ ...settings, sourceRules: { ...settings.sourceRules, "source:2": [] }, sourceGroups: [...settings.sourceGroups, { gid: 9, isMultiple: true, sids: [2] }] }))
        assert.deepEqual((await chain(h, { sourceId: 1, cursor: keep.nextCursor })).chain.map((e) => e.order), [4, 5, 6, 7])
        const late = await chain(h, { sourceId: 1, limit: 4 })
        now += CURSOR_TTL_MS + 1
        assert.equal((await h.call("get_rule_chain", { sourceId: 1, cursor: late.nextCursor })).error?.code, "CURSOR_EXPIRED")
    })

    test("response limit: pages cut by the budget; a chain over the rule limit is LIMIT_EXCEEDED", async () => {
        const heavy = Array.from({ length: 40 }, (_, k) => R(`${k}` + "\u0001\"\\".repeat(200)))
        const { h } = await setup({
            settings: { sourceRules: { all: heavy.slice(0, 20), "source:1": heavy.slice(20), "source:2": Array(RULES_CONSULTED_MAX).fill(R("x")) } },
        })
        const pages = await allPages(h, { sourceId: 1 })
        assert.deepEqual(pages.flatMap((pg) => pg.chain.map((e) => e.order)), heavy.map((_, k) => k))
        for (const page of pages.slice(0, -1)) assert.equal(page.scan.stoppedBy, "responseBudget")
        // 20 global + 1000 source rules
        const over = await h.call("get_rule_chain", { sourceId: 2 })
        assert.deepEqual([over.error?.code, over.error?.reason], ["LIMIT_EXCEEDED", "too-many-rules"])
    })

    test("21, 22. no rule is executed; nothing written; primary-key SQL only; no secrets", async () => {
        const marker = "MARKERchain"
        counter++
        const p = createSourcesProfile(path.join(root, `rc${counter}`), {
            sources: [{ sid: 1, url: `https://feed.invalid/${SECRET_SENTINEL}`, serviceRef: SECRET_SENTINEL }],
            items: 10,
            settings: {
                sourceGroups: [{ gid: 3, isMultiple: true, sids: [1] }],
                sourceRules: { all: [R(`^${marker}`)], "group:3": [R(`(${marker}a+)+$`)], "source:1": [R(`${marker}|x`, ["h-true"], 0)] },
                serviceConfigs: { password: SECRET_SENTINEL },
            },
        })
        const initial = snapshotDir(p.dir)
        const h = await harness(p)
        open.push(h)
        const original = RegExp.prototype.exec
        let executions = 0
        RegExp.prototype.exec = function (this: RegExp, input: string) {
            if (this.source.includes(marker)) executions++
            return original.call(this, input)
        }
        let page: GetRuleChainOutput & { outcome: ToolOutcome }
        try {
            page = await chain(h, { sourceId: 1 })
            await chain(h, { groupId: 3 })
            await chain(h, { all: true })
        } finally {
            RegExp.prototype.exec = original
        }
        assert.equal(executions, 0, "patterns are compiled, never executed")
        assert.equal(page.chain.length, 3)
        assert.deepEqual(findLeaks([page.outcome.text, JSON.stringify(page.outcome.result)], [SECRET_SENTINEL, "invalid", "http"]), [])
        assert.deepEqual([...new Set(h.sql)].sort(), [SOURCE_SQL.candidate, SOURCE_SQL.rows].sort())
        await h.close()
        open.splice(open.indexOf(h), 1)
        const db = new DatabaseSync(p.dbPath, { readOnly: true })
        try {
            assert.equal((db.prepare("SELECT count(*) AS n FROM items WHERE hasRead = 0 AND hidden = 0").get() as { n: number }).n, 10)
        } finally {
            db.close()
        }
        assert.deepEqual(snapshotDir(p.dir), initial, "same files, same hashes: no -wal, -shm or -journal")
    })
})
