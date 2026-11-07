import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, mock, test } from "node:test"
import { fileLock } from "../src/db/connection.js"
import { storedRuleFrom } from "../src/domain/rule-definition.js"
import { analyzeRule, REGEX_CHECK_MAX, RULES_CONSULTED_MAX } from "../src/domain/rules.js"
import { spliceRuleTarget } from "../src/settings/json-splice.js"
import { CFG_MAX } from "../src/settings/read-settings.js"
import { TOOLS } from "../installer/lib/package-content.js"
import { APP_LOCK_FILE, BACKUP_KIND, BACKUP_LOCATION, BACKUP_NAME, BACKUP_ROOT, GUARD_STALE_MS, RENAME_PAUSE_MS, ruleWriteSettingsFromEnv, WRITE_GUARD_FILE, type RuleWriteSettings, type RuleWriteStep } from "../src/settings/rule-store.js"
import { addRule, deleteRule, updateRule } from "../src/tools/rule-change.js"
import { getRuleChainOutput, listRulesOutput, previewRuleChangeOutput, RULE_CHANGE_EFFECT, RULE_PREVIEW_LIMITS, ruleWriteOutput } from "../src/tools/schemas.js"
import { createTempRoot, FAKE_PASSWORD, findLeaks, removeTempRoot, SECRET_SENTINEL, snapshotDir, syntheticSettings, type ProfileFixture } from "./helpers/fixtures.js"
import { childEnv, request, startServer } from "./helpers/process.js"
import { addSources, createSourcesProfile, harness, mutate, type Harness, type ToolOutcome } from "./helpers/sources.js"

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

/** A synthetic %USERPROFILE% holding a synthetic %LOCALAPPDATA%. */
function storage(): { localAppData: string; userProfile: string } {
    const userProfile = path.join(root, `home${++counter}`)
    const localAppData = path.join(userProfile, "AppData", "Local")
    fs.mkdirSync(localAppData, { recursive: true })
    return { localAppData, userProfile }
}

const GROUPED = { gid: 7, isMultiple: true, sids: [1, 2], name: "Tech", expanded: true }

const settings = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...syntheticSettings(),
    sourceGroups: [GROUPED, { gid: 8, isMultiple: false, sids: [3] }],
    sourceRules: {
        all: [{ filter: 23, search: "global", match: true, actions: ["n-true"] }],
        "group:7": [{ filter: 23, search: "ingroup", match: true, actions: ["r-true"] }],
        "source:1": [
            { filter: 23, search: "first", match: true, actions: ["s-true"] },
            { filter: 7, search: "second", match: false, actions: ["h-true"] },
            { filter: 55, search: "third", match: true, actions: ["n-false"] },
        ],
        "source:9": [{ filter: 23, search: "other", match: true, actions: ["r-false"] }],
    },
    ...over,
})

interface Setup {
    readonly p: ProfileFixture
    readonly h: Harness
    readonly store: { localAppData: string; userProfile: string }
    readonly backupRoot: string
}

async function setup(config: unknown = settings(), ruleWrites: Partial<RuleWriteSettings> = {}): Promise<Setup> {
    const dir = path.join(root, `rw${++counter}`)
    const p = createSourcesProfile(dir, { sources: [{ sid: 1 }, { sid: 2 }, { sid: 3 }], settings: config })
    const store = storage()
    const h = await harness(p, { ruleWrites: { ...store, ...ruleWrites } })
    open.push(h)
    return { p, h, store, backupRoot: path.join(store.localAppData, BACKUP_ROOT, BACKUP_KIND) }
}

const RULE = { field: "title", pattern: "^new", caseSensitive: false, match: true, actions: [{ action: "hide", value: true }] }

function ok<T>(outcome: ToolOutcome, schema: { parse(v: unknown): T }): T {
    assert.equal(outcome.isError, false, outcome.text)
    assert.deepEqual(JSON.parse(outcome.text), outcome.payload)
    return schema.parse(outcome.payload)
}

function refused(outcome: ToolOutcome, code: string, reason?: string): void {
    assert.equal(outcome.isError, true, outcome.text)
    assert.equal(outcome.error?.code, code, outcome.text)
    if (reason !== undefined) assert.equal(outcome.error?.reason, reason, outcome.text)
}

const config = (p: ProfileFixture): any => JSON.parse(fs.readFileSync(p.configPath, "utf8"))
const bytes = (p: ProfileFixture): Buffer => fs.readFileSync(p.configPath)

async function listed(h: Harness, args: Record<string, unknown>) {
    return ok(await h.call("list_rules", { limit: 100, ...args }), listRulesOutput)
}

async function sourceRef(h: Harness, sourceId: number): Promise<string> {
    return (await h.call("get_source", { sourceId })).payload.source.sourceRef as string
}

/** Target arguments and the revision a client would obtain from the read tools. */
async function source(h: Harness, sourceId = 1): Promise<Record<string, unknown>> {
    const { revision } = await listed(h, { scope: "source", sourceId })
    return { scope: "source", sourceId, sourceRef: await sourceRef(h, sourceId), expectedRevision: revision }
}

async function group(h: Harness, groupId = 7): Promise<Record<string, unknown>> {
    const { revision } = await listed(h, { scope: "group", groupId })
    return { scope: "group", groupId, expectedRevision: revision }
}

function backups(s: Setup): string[] {
    if (!fs.existsSync(s.backupRoot)) return []
    return fs.readdirSync(s.backupRoot).flatMap((key) => fs.readdirSync(path.join(s.backupRoot, key)).map((name) => path.join(s.backupRoot, key, name)))
}

/** The profile is exactly as it was, and no backup or temporary file exists. */
function assertNothingWritten(s: Setup, initial: Map<string, string>): void {
    assert.deepEqual(snapshotDir(s.p.dir), initial)
    assert.deepEqual(backups(s), [])
}

describe("add_rule", () => {
    test("source target: appended last, others untouched, index and revision returned", async () => {
        const s = await setup()
        const before = config(s.p)
        const target = await source(s.h)
        const out = ok(await s.h.call("add_rule", { ...target, rule: RULE }), ruleWriteOutput)
        assert.deepEqual([out.operation, out.applied, out.index, out.ruleCount, out.keyRemoved], ["add", true, 3, 4, false])
        assert.equal(out.previousRevision, target.expectedRevision)
        assert.notEqual(out.revision, target.expectedRevision)
        assert.equal(out.effect, RULE_CHANGE_EFFECT)
        const after = config(s.p)
        assert.deepEqual(after.sourceRules["source:1"].slice(0, 3), before.sourceRules["source:1"])
        assert.deepEqual(after.sourceRules["source:1"][3], { filter: 23, search: "^new", match: true, actions: ["h-true"] })
        const page = await listed(s.h, { scope: "source", sourceId: 1 })
        assert.equal(page.revision, out.revision, "the revision returned is the one list_rules reports")
        assert.deepEqual(page.rules.map((r) => r.pattern), ["first", "second", "third", "^new"])
        assert.equal(page.rules[3]?.standard, true)
    })

    test("group target, key absent, sourceRules absent", async () => {
        const s = await setup(settings({ sourceRules: undefined }))
        const out = ok(await s.h.call("add_rule", { ...(await group(s.h)), rule: RULE }), ruleWriteOutput)
        assert.deepEqual([out.index, out.ruleCount, out.target.key], [0, 1, "group:7"])
        assert.deepEqual(Object.keys(config(s.p).sourceRules), ["group:7"])
        assert.deepEqual(config(s.p).sourceGroups[0], GROUPED, "membership is not touched")
    })

    test("the conversion to StoredRule follows the fork's editor", () => {
        const of = (over: Record<string, unknown>) => storedRuleFrom({ ...RULE, ...over } as never)
        assert.equal(of({}).filter, 23)
        assert.equal(of({ caseSensitive: true }).filter, 7)
        assert.equal(of({ field: "text" }).filter, 31)
        assert.equal(of({ field: "text", caseSensitive: true }).filter, 15)
        assert.equal(of({ field: "creator" }).filter, 55)
        assert.equal(of({ field: "creator", caseSensitive: true }).filter, 39)
        assert.equal(of({ match: false }).match, false, "'Non ci sono risultati'")
        assert.deepEqual(
            of({ actions: [{ action: "read", value: true }, { action: "star", value: false }, { action: "hide", value: true }, { action: "notify", value: false }] }).actions,
            ["r-true", "s-false", "h-true", "n-false"],
        )
        assert.equal(of({ stateMask: { requireUnread: true, requireStarred: false, requireVisible: true } }).filter, 18)
        // Decoded back by the read tools' analysis.
        const summary = analyzeRule(of({ field: "creator", caseSensitive: true, match: false, stateMask: { requireUnread: false, requireStarred: true, requireVisible: false } }), 0).summary
        assert.deepEqual([summary.field, summary.caseSensitive, summary.match, summary.stateMask.requireStarred, summary.stateMask.requireUnread], ["creator", true, false, true, false])
    })

    test("invalid definitions are refused without writing", async () => {
        const s = await setup()
        const target = await source(s.h)
        const initial = snapshotDir(s.p.dir)
        const cases: [Record<string, unknown>, string][] = [
            [{ ...RULE, pattern: "(unclosed" }, "invalid-regex"],
            [{ ...RULE, pattern: "x".repeat(REGEX_CHECK_MAX + 1) }, "pattern-too-long"],
            [{ ...RULE, actions: [{ action: "hide", value: true }, { action: "hide", value: false }] }, "duplicate-action"],
            [{ ...RULE, pattern: "" }, "invalid-argument"],
            [{ ...RULE, actions: [] }, "invalid-argument"],
            [{ ...RULE, actions: [{ action: "download", value: true }] }, "invalid-argument"],
            [{ ...RULE, actions: ["r-true"] }, "invalid-argument"],
            [{ ...RULE, field: "link" }, "invalid-argument"],
            [{ ...RULE, extra: 1 }, "invalid-argument"],
            [{ pattern: "x", actions: RULE.actions }, "invalid-argument"],
        ]
        for (const [rule, reason] of cases) refused(await s.h.call("add_rule", { ...target, rule }), "INVALID_ARGUMENT", reason)
        assertNothingWritten(s, initial)
    })

    test("targets: global refused, sourceRef required, unknown, ambiguous, single-entry", async () => {
        const dup = await setup(settings({ sourceGroups: [GROUPED, { gid: 7, isMultiple: true, sids: [3] }, { gid: 8, isMultiple: false, sids: [3] }] }))
        const initial = snapshotDir(dup.p.dir)
        const expectedRevision = (await source(dup.h)).expectedRevision
        const add = (args: Record<string, unknown>) => dup.h.call("add_rule", { expectedRevision, rule: RULE, ...args })
        refused(await add({ scope: "all" }), "INVALID_ARGUMENT")
        refused(await add({ scope: "source", sourceId: 1 }), "INVALID_ARGUMENT")
        refused(await add({ scope: "source", sourceId: 1, sourceRef: await sourceRef(dup.h, 1), groupId: 7 }), "INVALID_ARGUMENT")
        refused(await add({ scope: "group", groupId: 7, sourceId: 1 }), "INVALID_ARGUMENT")
        refused(await add({ scope: "source", sourceId: 99, sourceRef: await sourceRef(dup.h, 1) }), "NOT_FOUND", "source-not-found")
        refused(await add({ scope: "group", groupId: 7 }), "GROUP_AMBIGUOUS")
        refused(await add({ scope: "group", groupId: 8 }), "NOT_FOUND", "not-a-group")
        refused(await add({ scope: "group", groupId: 99 }), "NOT_FOUND", "group-not-found")
        refused(await add({ scope: "group", groupId: -1 }), "INVALID_ARGUMENT")
        refused(await dup.h.call("add_rule", { scope: "group", groupId: 8, rule: RULE }), "INVALID_ARGUMENT")
        assertNothingWritten(dup, initial)
    })

    test("a source that reused the id is refused", async () => {
        const s = await setup()
        const target = await source(s.h)
        mutate(s.p.dbPath, "DELETE FROM sources WHERE sid = 1")
        addSources(s.p.dbPath, [{ sid: 1, url: "https://feed.invalid/another.xml" }])
        const initial = snapshotDir(s.p.dir)
        for (const [name, args] of [["add_rule", { rule: RULE }], ["update_rule", { index: 0, rule: RULE }], ["delete_rule", { index: 0 }]] as const) {
            refused(await s.h.call(name, { ...target, ...args }), "SOURCE_IDENTITY_CHANGED", "ref-mismatch")
        }
        assertNothingWritten(s, initial)
    })
})

describe("update_rule", () => {
    test("replaces one rule in place, for source and group", async () => {
        const s = await setup()
        const before = config(s.p)
        const out = ok(await s.h.call("update_rule", { ...(await source(s.h)), index: 1, rule: { ...RULE, match: false } }), ruleWriteOutput)
        assert.deepEqual([out.operation, out.index, out.ruleCount, out.previousRule?.pattern, out.rule?.pattern], ["update", 1, 3, "second", "^new"])
        const list = config(s.p).sourceRules["source:1"]
        assert.deepEqual([list[0], list[2]], [before.sourceRules["source:1"][0], before.sourceRules["source:1"][2]])
        assert.deepEqual(list[1], { filter: 23, search: "^new", match: false, actions: ["h-true"] })
        const groupOut = ok(await s.h.call("update_rule", { ...(await group(s.h)), index: 0, rule: RULE }), ruleWriteOutput)
        assert.equal(groupOut.target.key, "group:7")
        assert.equal(config(s.p).sourceRules["group:7"][0].search, "^new")
    })

    test("an identical definition writes nothing", async () => {
        const s = await setup()
        const initial = snapshotDir(s.p.dir)
        const target = await source(s.h)
        const out = ok(await s.h.call("update_rule", { ...target, index: 0, rule: { field: "title", pattern: "first", caseSensitive: false, match: true, actions: [{ action: "star", value: true }] } }), ruleWriteOutput)
        assert.deepEqual([out.applied, out.backup, out.revision], [false, null, target.expectedRevision])
        assertNothingWritten(s, initial)
    })

    test("index out of range and stale revision are refused", async () => {
        const s = await setup()
        const initial = snapshotDir(s.p.dir)
        const target = await source(s.h)
        refused(await s.h.call("update_rule", { ...target, index: 3, rule: RULE }), "RULE_NOT_FOUND", "rule-not-found")
        refused(await s.h.call("update_rule", { ...target, index: -1, rule: RULE }), "INVALID_ARGUMENT")
        refused(await s.h.call("update_rule", { ...target, index: 0.5, rule: RULE }), "INVALID_ARGUMENT")
        refused(await s.h.call("update_rule", { ...target, expectedRevision: "rr1.AAAAAAAAAAAAAAAAAAAAAA", index: 0, rule: RULE }), "REVISION_CONFLICT", "revision-mismatch")
        refused(await s.h.call("update_rule", { ...target, expectedRevision: "nonsense", index: 0, rule: RULE }), "INVALID_ARGUMENT")
        assertNothingWritten(s, initial)
    })
})

describe("delete_rule", () => {
    test("removes only that rule; the order of the others is kept; inherited rules untouched", async () => {
        const s = await setup()
        const before = config(s.p)
        const out = ok(await s.h.call("delete_rule", { ...(await source(s.h)), index: 1 }), ruleWriteOutput)
        assert.deepEqual([out.operation, out.index, out.ruleCount, out.keyRemoved, out.rule, out.previousRule?.pattern], ["delete", 1, 2, false, null, "second"])
        const after = config(s.p)
        assert.deepEqual(after.sourceRules["source:1"].map((r: { search: string }) => r.search), ["first", "third"])
        assert.deepEqual(after.sourceRules.all, before.sourceRules.all)
        assert.deepEqual(after.sourceRules["group:7"], before.sourceRules["group:7"])
    })

    test("deleting the last rule removes the key, as the app does; sourceRules stays", async () => {
        const s = await setup(settings({ sourceRules: { "group:7": [{ filter: 23, search: "only", match: true, actions: ["r-true"] }] } }))
        const out = ok(await s.h.call("delete_rule", { ...(await group(s.h)), index: 0 }), ruleWriteOutput)
        assert.deepEqual([out.ruleCount, out.keyRemoved], [0, true])
        assert.deepEqual(config(s.p).sourceRules, {})
        const page = await listed(s.h, { scope: "group", groupId: 7 })
        assert.deepEqual([page.revision, page.target.keyPresent, page.rules], [out.revision, false, []])
    })

    test("no rule at the index, or a stale revision: nothing is written", async () => {
        const s = await setup()
        const initial = snapshotDir(s.p.dir)
        const target = await source(s.h)
        refused(await s.h.call("delete_rule", { ...target, index: 5 }), "RULE_NOT_FOUND")
        refused(await s.h.call("delete_rule", { ...target, expectedRevision: "rr1.AAAAAAAAAAAAAAAAAAAAAA", index: 0 }), "REVISION_CONFLICT")
        refused(await s.h.call("delete_rule", { ...(await group(s.h, 7)), index: 1 }), "RULE_NOT_FOUND")
        assertNothingWritten(s, initial)
    })
})

describe("preview_rule_change", () => {
    test("add, update and delete: read-only, on source and group", async () => {
        const s = await setup()
        const initial = snapshotDir(s.p.dir)
        const add = ok(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: RULE }), previewRuleChangeOutput)
        assert.deepEqual([add.index, add.previousRule, add.newRule?.pattern, add.ruleCountBefore, add.ruleCountAfter], [3, null, "^new", 3, 4])
        assert.deepEqual([add.chain.lengthBefore, add.chain.lengthAfter, add.chain.orderBefore, add.chain.orderAfter, add.chain.laterRulesInChain, add.chain.complete], [5, 6, null, 5, 0, true])
        assert.equal(add.target.name, "Source 1")
        assert.equal(add.limits, RULE_PREVIEW_LIMITS)
        assert.deepEqual(add.writeAvailability, { writesEnabled: true, fluentReaderOpen: false })
        const update = ok(await s.h.call("preview_rule_change", { operation: "update", scope: "group", groupId: 7, index: 0, rule: RULE }), previewRuleChangeOutput)
        assert.deepEqual([update.previousRule?.pattern, update.newRule?.pattern, update.chain.orderBefore, update.chain.orderAfter, update.chain.affectedSourceCount], ["ingroup", "^new", 1, 1, 2])
        const del = ok(await s.h.call("preview_rule_change", { operation: "delete", scope: "source", sourceId: 1, index: 0 }), previewRuleChangeOutput)
        assert.deepEqual([del.previousRule?.pattern, del.newRule, del.ruleCountAfter, del.keyWouldBeRemoved], ["first", null, 2, false])
        assert.deepEqual(del.order, { shiftedFromIndex: 1, shiftedCount: 2, otherRulesUnchanged: true })
        const last = ok(await s.h.call("preview_rule_change", { operation: "delete", scope: "group", groupId: 7, index: 0 }), previewRuleChangeOutput)
        assert.equal(last.keyWouldBeRemoved, true)
        assertNothingWritten(s, initial)
    })

    test("its currentRevision is what a write needs and what list_rules reports, and it authorizes nothing", async () => {
        const s = await setup()
        const preview = ok(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: RULE }), previewRuleChangeOutput)
        assert.equal(preview.currentRevision, (await listed(s.h, { scope: "source", sourceId: 1 })).revision)
        assert.ok(preview.target.sourceRef)
        const stale = ok(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: RULE, expectedRevision: "rr1.AAAAAAAAAAAAAAAAAAAAAA" }), previewRuleChangeOutput)
        assert.deepEqual([stale.expectedRevisionCurrent, stale.warnings.includes("expectedRevisionStale")], [false, true])
        assert.equal(config(s.p).sourceRules["source:1"].length, 3, "a preview does not save")
        refused(await s.h.call("add_rule", { scope: "source", sourceId: 1, sourceRef: preview.target.sourceRef, rule: RULE }), "INVALID_ARGUMENT")
        const out = ok(await s.h.call("add_rule", { scope: "source", sourceId: 1, sourceRef: preview.target.sourceRef, expectedRevision: preview.currentRevision, rule: RULE }), ruleWriteOutput)
        assert.equal(out.index, preview.index)
    })

    test("warnings and conflicts: order, state conditions, duplicates, overrides", async () => {
        const s = await setup()
        const flags = (r: { warnings: string[] }): string[] => r.warnings
        const stated = ok(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: { ...RULE, match: false, stateMask: { requireUnread: true, requireStarred: false, requireVisible: false } } }), previewRuleChangeOutput)
        assert.ok(flags(stated).includes("stateConditionsNotEditableInApp"))
        assert.ok(flags(stated).includes("invertedMatchIncludesState"))
        assert.equal(stated.newRule?.standard, false)
        const same = { field: "title", pattern: "first", caseSensitive: false, match: true, actions: [{ action: "star", value: true }] }
        const duplicate = ok(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: same }), previewRuleChangeOutput)
        assert.ok(duplicate.conflicts.some((c) => c.kind === "duplicateRule" && c.certainty === "proven" && c.orders.includes(5)))
        assert.deepEqual(duplicate.overlaps.map((o) => [o.originKey, o.index, o.flags]), [["source:1", 0, ["star"]]])
        const earlier = { field: "title", pattern: "zzz", caseSensitive: false, match: true, actions: [{ action: "notify", value: true }] }
        const overridden = ok(await s.h.call("preview_rule_change", { operation: "update", scope: "source", sourceId: 1, index: 0, rule: earlier }), previewRuleChangeOutput)
        assert.ok(flags(overridden).includes("laterRuleMayOverride"), "source:1[2] sets notify false later")
        assert.deepEqual(overridden.overlaps.map((o) => o.originKey), ["all", "source:1"])
        const legacy = await setup(settings({ sourceRules: { "source:1": [{ filter: 1, search: "old", match: true, actions: ["r"] }] } }))
        const nonStandard = ok(await legacy.h.call("preview_rule_change", { operation: "delete", scope: "source", sourceId: 1, index: 0 }), previewRuleChangeOutput)
        assert.deepEqual([nonStandard.previousRule?.standard, nonStandard.warnings.includes("previousRuleNonStandard")], [false, true])
    })

    test("the first group cannot be resolved: the chain is declared incomplete", async () => {
        const s = await setup(settings({ sourceGroups: [{ gid: 7, isMultiple: true, sids: [1] }, { gid: 7, isMultiple: true, sids: [] }] }))
        const out = ok(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: RULE }), previewRuleChangeOutput)
        assert.equal(out.chain.complete, false)
        assert.ok(out.warnings.includes("chainIncomplete"))
    })

    test("existing rules that can stop a fetch are reported; a group without effective members too", async () => {
        const s = await setup(settings({ sourceGroups: [{ gid: 7, isMultiple: true, sids: [] }], sourceRules: { all: [{ filter: 23, search: "(bad", match: true, actions: ["r-true"] }] } }))
        const out = ok(await s.h.call("preview_rule_change", { operation: "add", scope: "group", groupId: 7, rule: RULE }), previewRuleChangeOutput)
        assert.ok(out.warnings.includes("fetchBlockersInChain"))
        assert.ok(out.warnings.includes("groupHasNoEffectiveMembers"))
    })

    test("invalid requests", async () => {
        const s = await setup()
        for (const args of [
            { operation: "add", scope: "source", sourceId: 1 },
            { operation: "add", scope: "source", sourceId: 1, rule: RULE, index: 0 },
            { operation: "update", scope: "source", sourceId: 1, rule: RULE },
            { operation: "delete", scope: "source", sourceId: 1, index: 0, rule: RULE },
            { operation: "delete", scope: "all", index: 0 },
            { operation: "move", scope: "source", sourceId: 1, index: 0 },
        ]) refused(await s.h.call("preview_rule_change", args), "INVALID_ARGUMENT")
        refused(await s.h.call("preview_rule_change", { operation: "update", scope: "source", sourceId: 1, index: 9, rule: RULE }), "RULE_NOT_FOUND")
        refused(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: { ...RULE, pattern: "[" } }), "INVALID_ARGUMENT", "invalid-regex")
    })

    test("never executes a pattern", async () => {
        const s = await setup()
        const original = RegExp.prototype.exec
        let executed = 0
        RegExp.prototype.exec = function (this: RegExp, input: string) {
            if (this.source.includes("NEVER_RUN")) executed++
            return original.call(this, input)
        }
        try {
            const target = await source(s.h)
            ok(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: { ...RULE, pattern: "NEVER_RUN" } }), previewRuleChangeOutput)
            ok(await s.h.call("add_rule", { ...target, rule: { ...RULE, pattern: "NEVER_RUN" } }), ruleWriteOutput)
        } finally {
            RegExp.prototype.exec = original
        }
        assert.equal(executed, 0)
    })
})

describe("compatibility with the read tools", () => {
    test("get_rule_chain sees the new order: all, group, source, in stored order", async () => {
        const s = await setup()
        ok(await s.h.call("add_rule", { ...(await source(s.h)), rule: RULE }), ruleWriteOutput)
        ok(await s.h.call("add_rule", { ...(await group(s.h)), rule: { ...RULE, pattern: "^group" } }), ruleWriteOutput)
        const chain = ok(await s.h.call("get_rule_chain", { sourceId: 1 }), getRuleChainOutput)
        assert.deepEqual(chain.chain.map((e) => [e.originKey, e.rule.pattern]), [
            ["all", "global"],
            ["group:7", "ingroup"],
            ["group:7", "^group"],
            ["source:1", "first"],
            ["source:1", "second"],
            ["source:1", "third"],
            ["source:1", "^new"],
        ])
        assert.equal(chain.resolution.complete, true)
    })

    test("a listing in progress is invalidated by a change of its target", async () => {
        const s = await setup()
        const first = await listed(s.h, { scope: "source", sourceId: 1, limit: 1 })
        ok(await s.h.call("add_rule", { ...(await source(s.h)), rule: RULE }), ruleWriteOutput)
        refused(await s.h.call("list_rules", { scope: "source", sourceId: 1, limit: 1, cursor: first.nextCursor }), "CURSOR_STALE", "rules-changed")
    })
})

describe("integrity of config.json", () => {
    const UNKNOWN = {
        futureFeature: { nested: [1, { deep: true }] },
        bigNumber: "PLACEHOLDER",
    }

    test("everything outside the target is preserved byte for byte", async () => {
        const compact = JSON.stringify(settings({ ...UNKNOWN }), undefined, "\t")
        // Spelling JSON.parse + JSON.stringify would lose: precision, exponent, escapes, trailing zeros.
        const text = compact.replace('"PLACEHOLDER"', "12345678901234567890").replace('"theme": "system"', '"theme": "syst\\u0065m",\n\t"ratio": 1.50,\n\t"tiny": 1e-7')
        const s = await setup(text)
        const out = ok(await s.h.call("update_rule", { ...(await source(s.h)), index: 0, rule: RULE }), ruleWriteOutput)
        assert.equal(out.applied, true)
        const saved = fs.readFileSync(s.p.configPath, "utf8")
        for (const piece of ["12345678901234567890", '"syst\\u0065m"', "1.50", "1e-7", FAKE_PASSWORD]) assert.ok(saved.includes(piece), piece)
        const start = text.indexOf('"source:1"')
        const end = text.indexOf('"source:9"')
        assert.equal(saved.slice(0, start), text.slice(0, start))
        assert.equal(saved.slice(saved.indexOf('"source:9"')), text.slice(end))
    })

    test("the other rules of the target keep unknown fields and discarded actions", async () => {
        const many = Array.from({ length: 70 }, () => "r-true")
        const kept = { filter: 23, search: "kept", match: true, actions: many, futureField: { a: 1 } }
        const s = await setup(settings({ sourceRules: { "source:1": [kept, { filter: 23, search: "b", match: true, actions: ["x-true"] }] } }))
        ok(await s.h.call("delete_rule", { ...(await source(s.h)), index: 1 }), ruleWriteOutput)
        assert.deepEqual(config(s.p).sourceRules["source:1"], [kept])
        const target = await source(s.h)
        ok(await s.h.call("add_rule", { ...target, rule: RULE }), ruleWriteOutput)
        assert.deepEqual(config(s.p).sourceRules["source:1"][0], kept)
    })

    test("a tab-indented file stays tab-indented, as conf writes it", async () => {
        const s = await setup(JSON.stringify(settings(), undefined, "\t"))
        ok(await s.h.call("add_rule", { ...(await source(s.h)), rule: RULE }), ruleWriteOutput)
        const parsed = config(s.p)
        assert.equal(fs.readFileSync(s.p.configPath, "utf8"), JSON.stringify(parsed, undefined, "\t"))
    })

    test("spliceRuleTarget: insertion, replacement, removal in every position", () => {
        const check = (text: string, key: string, rules: unknown[] | null, expected: unknown): void => {
            const out = spliceRuleTarget(text, key, rules)
            assert.deepEqual(JSON.parse(out), expected)
        }
        const r = [{ a: "x\ny\"}{]" }]
        check("{}", "k", r, { sourceRules: { k: r } })
        check('{"a":1}', "k", r, { a: 1, sourceRules: { k: r } })
        check('{"sourceRules":{}}', "k", r, { sourceRules: { k: r } })
        check('{ "sourceRules" : { "j" : [ ] , "k" : [1] , "l" : "}" } , "z" : "{" }', "k", r, { sourceRules: { j: [], k: r, l: "}" }, z: "{" })
        check('{"sourceRules":{"k":[1]}}', "k", null, { sourceRules: {} })
        check('{"sourceRules":{"k":[1],"l":[2]}}', "k", null, { sourceRules: { l: [2] } })
        check('{"sourceRules":{"j":[0],"k":[1]}}', "k", null, { sourceRules: { j: [0] } })
        check('{"sourceRules":{"j":[0],"k":[1],"l":[2]}}', "k", null, { sourceRules: { j: [0], l: [2] } })
        check('{"\\u0073ourceRules":{"k":[1]},"b":true,"c":null,"d":-1.5e3}', "k", r, { sourceRules: { k: r }, b: true, c: null, d: -1500 })
        assert.equal(spliceRuleTarget('{"a":1}', "k", null), '{"a":1}')
        assert.throws(() => spliceRuleTarget('{"sourceRules":{},"sourceRules":{}}', "k", r), { code: "SETTINGS_INVALID", reason: "duplicate-key" })
        assert.throws(() => spliceRuleTarget('{"sourceRules":{"k":[],"k":[]}}', "k", r), { code: "SETTINGS_INVALID", reason: "duplicate-key" })
    })

    test("invalid, unreadable or suspicious configurations are refused, never repaired", async () => {
        const base = await setup()
        const target = await source(base.h)
        const cases: [string, string, string?][] = [
            ['{"sourceRules":{', "SETTINGS_INVALID", "not-json"],
            ["[1,2]", "SETTINGS_INVALID", "not-object"],
            ["﻿{}", "SETTINGS_INVALID", "byte-order-mark"],
            [JSON.stringify(settings({ sourceRules: { "source:1": "not-a-list" } })), "SETTINGS_INVALID"],
            [JSON.stringify(settings({ sourceRules: { "source:1": [{ filter: "x" }] } })), "SETTINGS_INVALID"],
            [JSON.stringify(settings({ sourceGroups: "nope" })), "SETTINGS_INVALID"],
            [JSON.stringify(settings({ nextGroupId: "nope" })), "SETTINGS_INVALID"],
            ['{"sourceRules":{},"sourceRules":{}}', "SETTINGS_INVALID", "duplicate-key"],
        ]
        for (const [text, code, reason] of cases) {
            fs.writeFileSync(base.p.configPath, text)
            const initial = snapshotDir(base.p.dir)
            // With the revision still current where the rules can be read: only the structure is at fault.
            const current = await base.h.call("list_rules", { scope: "source", sourceId: 1, limit: 1 })
            const expectedRevision = current.isError ? target.expectedRevision : current.payload.revision
            refused(await base.h.call("add_rule", { ...target, expectedRevision, rule: RULE }), code, reason)
            refused(await base.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: RULE }), code, reason)
            assert.deepEqual(snapshotDir(base.p.dir), initial, text)
            assert.equal(fs.readFileSync(base.p.configPath, "utf8"), text, "not repaired")
        }
        assert.deepEqual(backups(base), [])
    })

    test("config.json missing, or not a file: refused, nothing created", async () => {
        const s = await setup()
        const target = await source(s.h)
        const text = fs.readFileSync(s.p.configPath)
        fs.unlinkSync(s.p.configPath)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "SETTINGS_UNAVAILABLE", "missing")
        assert.equal(fs.existsSync(s.p.configPath), false)
        fs.mkdirSync(s.p.configPath)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "SETTINGS_UNAVAILABLE", "not-regular-file")
        fs.rmdirSync(s.p.configPath)
        fs.writeFileSync(s.p.configPath, text)
        assert.deepEqual(backups(s), [])
    })

    test("size limits: the file, the new content, the rules of a target", async () => {
        const padded = (bytes: number): string => JSON.stringify({ ...settings(), pad: "x".repeat(bytes) })
        const huge = await setup()
        const target = await source(huge.h)
        fs.writeFileSync(huge.p.configPath, padded(CFG_MAX))
        refused(await huge.h.call("add_rule", { ...target, rule: RULE }), "SETTINGS_TOO_LARGE", "file-too-large")

        const size = Buffer.byteLength(padded(0))
        const full = await setup(padded(CFG_MAX - size - 1))
        const initial = snapshotDir(full.p.dir)
        refused(await full.h.call("add_rule", { ...(await source(full.h)), rule: RULE }), "SETTINGS_TOO_LARGE", "file-too-large")
        assertNothingWritten(full, initial)

        const stored = { filter: 23, search: "x", match: true, actions: ["r-true"] }
        const many = await setup(settings({ sourceRules: { "source:3": Array.from({ length: RULES_CONSULTED_MAX }, () => stored) } }))
        refused(await many.h.call("add_rule", { ...(await source(many.h, 3)), rule: RULE }), "LIMIT_EXCEEDED", "too-many-rules")
        const chained = await setup(settings({ sourceRules: { all: Array.from({ length: RULES_CONSULTED_MAX }, () => stored) } }))
        refused(await chained.h.call("add_rule", { ...(await source(chained.h, 3)), rule: RULE }), "LIMIT_EXCEEDED", "too-many-rules")
    })

    test("a linked config.json is refused; a hard link too; a junctioned profile is not written through", async (t) => {
        const hard = await setup()
        const target = await source(hard.h)
        const other = path.join(root, `elsewhere${++counter}.json`)
        fs.linkSync(hard.p.configPath, other)
        refused(await hard.h.call("add_rule", { ...target, rule: RULE }), "SETTINGS_UNAVAILABLE", "hard-linked")
        fs.unlinkSync(other)

        const s = await setup()
        const swapped = await source(s.h)
        const real = path.join(root, `real-config${++counter}.json`)
        fs.copyFileSync(s.p.configPath, real)
        const content = fs.readFileSync(real)
        fs.unlinkSync(s.p.configPath)
        try {
            fs.symlinkSync(real, s.p.configPath, "file")
        } catch {
            t.diagnostic("file symlinks not available to this account: the symlink case was not run")
            return
        }
        refused(await s.h.call("add_rule", { ...swapped, rule: RULE }), "SETTINGS_UNAVAILABLE", "linked-file")
        assert.deepEqual(fs.readFileSync(real), content)
    })

    test("the profile directory re-routed through a junction after startup is refused at commit", async () => {
        const s = await setup()
        const target = await source(s.h)
        const parked = `${s.p.dir}-parked`
        const initial = fs.readFileSync(s.p.configPath)
        // Same content reached through a junction: the path given at startup is no longer canonical.
        fs.renameSync(s.p.dir, parked)
        fs.symlinkSync(parked, s.p.dir, "junction")
        try {
            refused(await s.h.call("add_rule", { ...target, rule: RULE }), "SETTINGS_UNAVAILABLE", "outside-profile")
            assert.deepEqual(fs.readFileSync(path.join(parked, "config.json")), initial)
            assert.equal(fs.existsSync(path.join(parked, WRITE_GUARD_FILE)), false)
        } finally {
            fs.rmdirSync(s.p.dir)
            fs.renameSync(parked, s.p.dir)
        }
    })
})

describe("Fluent Reader open", () => {
    test("a write is refused while its lock file exists, a preview is not", async () => {
        const s = await setup()
        const target = await source(s.h)
        const lock = path.join(s.p.dir, APP_LOCK_FILE)
        fs.writeFileSync(lock, "")
        const initial = snapshotDir(s.p.dir)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "FLUENT_READER_RUNNING", "lockfile-present")
        refused(await s.h.call("update_rule", { ...target, index: 0, rule: RULE }), "FLUENT_READER_RUNNING")
        refused(await s.h.call("delete_rule", { ...target, index: 0 }), "FLUENT_READER_RUNNING")
        const preview = ok(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: RULE }), previewRuleChangeOutput)
        assert.deepEqual([preview.writeAvailability.fluentReaderOpen, preview.warnings.includes("fluentReaderOpen")], [true, true])
        ok(await s.h.call("list_rules", { scope: "all", limit: 5 }), listRulesOutput)
        assertNothingWritten(s, initial)
        fs.unlinkSync(lock)
        ok(await s.h.call("add_rule", { ...target, rule: RULE }), ruleWriteOutput)
    })

    test("the app starting during a write stops it before the rename", async () => {
        const lock = (s: Setup): string => path.join(s.p.dir, APP_LOCK_FILE)
        let s: Setup
        s = await setup(settings(), { step: (step) => { if (step === "after-temp") fs.writeFileSync(lock(s), "") } })
        const target = await source(s.h)
        const before = bytes(s.p)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "FLUENT_READER_RUNNING", "lockfile-present")
        assert.deepEqual(bytes(s.p), before)
        assert.equal(fs.existsSync(path.join(s.p.dir, WRITE_GUARD_FILE)), false)
    })

    test("the app starting right after the rename is reported, not hidden", async () => {
        let s: Setup
        s = await setup(settings(), { step: (step) => { if (step === "after-rename") fs.writeFileSync(path.join(s.p.dir, APP_LOCK_FILE), "") } })
        const target = await source(s.h)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "RULE_WRITE_UNVERIFIED", "app-started")
        assert.equal(config(s.p).sourceRules["source:1"].length, 4)
        assert.equal(backups(s).length, 1)
    })
})

describe("concurrent changes", () => {
    test("config.json changed between the read and the rename: refused, the other change survives", async () => {
        for (const step of ["after-guard", "after-backup", "after-temp"] satisfies RuleWriteStep[]) {
            let s: Setup
            let once = true
            s = await setup(settings(), {
                step: (current) => {
                    if (current !== step || !once) return
                    once = false
                    // As the app would save a setting, conf style: temporary file and rename.
                    const doc = config(s.p)
                    doc.theme = "dark"
                    const temp = `${s.p.configPath}.tmp-other`
                    fs.writeFileSync(temp, JSON.stringify(doc, undefined, "\t"))
                    fs.renameSync(temp, s.p.configPath)
                },
            })
            const target = await source(s.h)
            refused(await s.h.call("add_rule", { ...target, rule: RULE }), "REVISION_CONFLICT", "settings-changed")
            assert.equal(config(s.p).theme, "dark", step)
            assert.equal(config(s.p).sourceRules["source:1"].length, 3, step)
            assert.equal(fs.existsSync(path.join(s.p.dir, WRITE_GUARD_FILE)), false, step)
        }
    })

    test("the rules changed before the call: stale revision", async () => {
        const s = await setup()
        const target = await source(s.h)
        const doc = config(s.p)
        doc.sourceRules["source:1"].pop()
        fs.writeFileSync(s.p.configPath, JSON.stringify(doc))
        const initial = snapshotDir(s.p.dir)
        refused(await s.h.call("delete_rule", { ...target, index: 0 }), "REVISION_CONFLICT", "revision-mismatch")
        assertNothingWritten(s, initial)
    })

    test("a change of another target does not conflict", async () => {
        const s = await setup()
        const target = await source(s.h)
        ok(await s.h.call("add_rule", { ...(await group(s.h)), rule: RULE }), ruleWriteOutput)
        ok(await s.h.call("add_rule", { ...target, rule: RULE }), ruleWriteOutput)
    })

    test("a duplicate request adds nothing, in sequence and at the same time", async () => {
        const s = await setup()
        const target = await source(s.h)
        ok(await s.h.call("add_rule", { ...target, rule: RULE }), ruleWriteOutput)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "REVISION_CONFLICT", "revision-mismatch")
        assert.equal(config(s.p).sourceRules["source:1"].length, 4)

        const next = await source(s.h)
        const both = await Promise.all([1, 2, 3].map(() => s.h.call("add_rule", { ...next, rule: { ...RULE, pattern: "^same" } })))
        assert.equal(both.filter((o) => !o.isError).length, 1)
        for (const o of both.filter((x) => x.isError)) refused(o, "REVISION_CONFLICT")
        assert.equal(config(s.p).sourceRules["source:1"].length, 5)

        const del = await source(s.h)
        const dels = await Promise.all([1, 2].map(() => s.h.call("delete_rule", { ...del, index: 0 })))
        assert.equal(dels.filter((o) => !o.isError).length, 1)
        assert.equal(config(s.p).sourceRules["source:1"].length, 4)
    })

    test("another copy of the server writing: busy; a guard left by a crash stays until removed by hand", async () => {
        const s = await setup()
        const target = await source(s.h)
        const guard = path.join(s.p.dir, WRITE_GUARD_FILE)
        fs.writeFileSync(guard, "partial")
        const before = bytes(s.p)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "RULE_WRITE_BUSY", "write-in-progress")
        assert.deepEqual(bytes(s.p), before)
        assert.equal(fs.readFileSync(guard, "utf8"), "partial")
        const old = new Date(Date.now() - GUARD_STALE_MS - 1000)
        fs.utimesSync(guard, old, old)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "RULE_WRITE_BUSY", "write-guard-orphaned")
        assert.deepEqual(bytes(s.p), before)
        assert.equal(fs.readFileSync(guard, "utf8"), "partial")
        fs.unlinkSync(guard)
        ok(await s.h.call("add_rule", { ...target, rule: RULE }), ruleWriteOutput)
        assert.equal(fs.existsSync(guard), false)
    })
})

describe("write failures", () => {
    test("a real refusal to replace (read-only file): config.json intact, no temporary file", async () => {
        const s = await setup()
        const target = await source(s.h)
        const before = bytes(s.p)
        fs.chmodSync(s.p.configPath, 0o444)
        try {
            refused(await s.h.call("add_rule", { ...target, rule: RULE }), "RULE_WRITE_FAILED", "replace-failed")
        } finally {
            fs.chmodSync(s.p.configPath, 0o666)
        }
        assert.deepEqual(bytes(s.p), before)
        assert.equal(fs.existsSync(path.join(s.p.dir, WRITE_GUARD_FILE)), false)
        assert.equal(backups(s).length, 1, "the copy taken stays")
    })

    test("a failure at any step before the rename leaves config.json intact", async () => {
        for (const step of ["after-guard", "after-backup", "after-temp", "before-rename"] satisfies RuleWriteStep[]) {
            const s = await setup(settings(), {
                step: (current) => {
                    if (current === step) throw Object.assign(new Error(`ENOSPC ${SECRET_SENTINEL}`), { code: "ENOSPC" })
                },
            })
            const target = await source(s.h)
            const before = bytes(s.p)
            const call = await s.h.call("add_rule", { ...target, rule: RULE })
            refused(call, "RULE_WRITE_FAILED", "write-failed")
            assert.deepEqual(findLeaks([call.text], [SECRET_SENTINEL]), [], step)
            assert.deepEqual(bytes(s.p), before, step)
            assert.equal(fs.existsSync(path.join(s.p.dir, WRITE_GUARD_FILE)), false, step)
        }
    })

    test("the result cannot be read back: reported and not restored", async () => {
        let s: Setup
        s = await setup(settings(), {
            step: (step) => {
                if (step === "after-rename") fs.writeFileSync(s.p.configPath, JSON.stringify({ someoneElse: true }))
            },
        })
        const target = await source(s.h)
        const call = await s.h.call("add_rule", { ...target, rule: RULE })
        refused(call, "RULE_WRITE_UNVERIFIED", "read-back-failed")
        assert.deepEqual(config(s.p), { someoneElse: true }, "someone else's change is not overwritten")
        assert.equal(backups(s).length, 1)
    })
})

describe("retries of the rename", () => {
    /**
     * The rename of the temporary file over config.json fails `failures` times
     * with `code`, then is the real one; every other rename is untouched.
     */
    function refuseReplace(t: { mock: typeof mock }, failures: number, code = "EACCES", onRefusal?: () => void): { attempts: number } {
        const seen = { attempts: 0 }
        const real = fs.renameSync
        t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike): void => {
            if (/^config.json.frmcp-write..*.partial$/.test(path.basename(String(from))) && ++seen.attempts <= failures) {
                onRefusal?.()
                throw Object.assign(new Error(`${code} ${SECRET_SENTINEL}`), { code })
            }
            real(from, to)
        })
        return seen
    }

    /** As the app would save a setting, conf style: temporary file and rename. Returns the bytes saved. */
    function externalSave(p: ProfileFixture): Buffer {
        const doc = config(p)
        doc.theme = "dark"
        const saved = Buffer.from(JSON.stringify(doc, undefined, "\t"))
        const temp = `${p.configPath}.tmp-other`
        fs.writeFileSync(temp, saved)
        fs.renameSync(temp, p.configPath)
        return saved
    }

    const guardGone = (s: Setup): boolean => !fs.existsSync(path.join(s.p.dir, WRITE_GUARD_FILE))

    test("A: a save and the lockfile appearing during the pause stop the retries; the save survives", async (t) => {
        const seen = refuseReplace(t, 1)
        let saved: Buffer = Buffer.alloc(0)
        let s: Setup
        s = await setup(settings(), {
            step: (step) => {
                if (step !== "before-retry") return
                saved = externalSave(s.p)
                fs.writeFileSync(path.join(s.p.dir, APP_LOCK_FILE), "")
            },
        })
        const target = await source(s.h)
        const before = bytes(s.p)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "FLUENT_READER_RUNNING", "lockfile-present")
        assert.equal(seen.attempts, 1, "no replacement after the failed one")
        assert.deepEqual(bytes(s.p), saved)
        assert.equal(config(s.p).theme, "dark")
        assert.equal(config(s.p).sourceRules["source:1"].length, 3)
        assert.equal(guardGone(s), true)
        const copies = backups(s)
        assert.equal(copies.length, 1)
        assert.deepEqual(fs.readFileSync(copies[0] as string), before)
    })

    test("the lockfile appearing alone stops the retries too", async (t) => {
        const seen = refuseReplace(t, 1)
        let s: Setup
        s = await setup(settings(), { step: (step) => { if (step === "before-retry") fs.writeFileSync(path.join(s.p.dir, APP_LOCK_FILE), "") } })
        const target = await source(s.h)
        const before = bytes(s.p)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "FLUENT_READER_RUNNING", "lockfile-present")
        assert.equal(seen.attempts, 1)
        assert.deepEqual(bytes(s.p), before)
        assert.equal(guardGone(s), true)
    })

    test("B: a save during the pause without the lockfile is a conflict, for every retryable code; the save survives", async (t) => {
        for (const code of ["EACCES", "EPERM", "EBUSY"]) {
            await t.test(code, async (sub) => {
                const seen = refuseReplace(sub, 1, code)
                let saved: Buffer = Buffer.alloc(0)
                let s: Setup
                s = await setup(settings(), { step: (step) => { if (step === "before-retry") saved = externalSave(s.p) } })
                const target = await source(s.h)
                const call = await s.h.call("add_rule", { ...target, rule: RULE })
                refused(call, "REVISION_CONFLICT", "settings-changed")
                assert.deepEqual(findLeaks([call.text], [SECRET_SENTINEL]), [])
                assert.equal(seen.attempts, 1)
                assert.deepEqual(bytes(s.p), saved)
                assert.equal(guardGone(s), true)
                assert.equal(backups(s).length, 1)
            })
        }
    })

    test("a save during a later pause is caught as well", async (t) => {
        const seen = refuseReplace(t, 3)
        let saved: Buffer = Buffer.alloc(0)
        let pauses = 0
        let s: Setup
        s = await setup(settings(), { step: (step) => { if (step === "before-retry" && ++pauses === 3) saved = externalSave(s.p) } })
        const target = await source(s.h)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "REVISION_CONFLICT", "settings-changed")
        assert.equal(seen.attempts, 3)
        assert.deepEqual(bytes(s.p), saved)
    })

    test("the checks of every retry run after its pause", async (t) => {
        const gaps = { lockfile: [] as number[], read: [] as number[] }
        let refusal: { at: number; lockfile: boolean; read: boolean } | undefined
        const note = (check: "lockfile" | "read"): void => {
            if (refusal === undefined || refusal[check]) return
            refusal[check] = true
            gaps[check].push(performance.now() - refusal.at)
        }
        const realLstat = fs.lstatSync
        const realRead = fs.readSync
        const s = await setup()
        const target = await source(s.h)
        const seen = refuseReplace(t, 2, "EACCES", () => { refusal = { at: performance.now(), lockfile: false, read: false } })
        t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
            if (path.basename(String(args[0])) === APP_LOCK_FILE) note("lockfile")
            return realLstat(...args)
        })
        t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>): number => {
            note("read")
            return realRead(...args)
        })
        ok(await s.h.call("add_rule", { ...target, rule: RULE }), ruleWriteOutput)
        assert.equal(seen.attempts, 3)
        assert.deepEqual([gaps.lockfile.length, gaps.read.length], [2, 2])
        // A slow machine only widens these gaps. Timers may fire a millisecond or so early.
        for (const gap of [...gaps.lockfile, ...gaps.read]) assert.ok(gap >= RENAME_PAUSE_MS - 5, `checked ${gap} ms after the refusal`)
    })

    test("a real refusal (read-only file, no mock) followed by a save: conflict, the save survives", async () => {
        let saved: Buffer = Buffer.alloc(0)
        let s: Setup
        s = await setup(settings(), {
            step: (step) => {
                if (step !== "before-retry") return
                fs.chmodSync(s.p.configPath, 0o666)
                saved = externalSave(s.p)
            },
        })
        const target = await source(s.h)
        fs.chmodSync(s.p.configPath, 0o444)
        try {
            refused(await s.h.call("add_rule", { ...target, rule: RULE }), "REVISION_CONFLICT", "settings-changed")
        } finally {
            fs.chmodSync(s.p.configPath, 0o666)
        }
        assert.deepEqual(bytes(s.p), saved)
        assert.equal(config(s.p).theme, "dark")
        assert.equal(guardGone(s), true)
    })

    test("a save made while the rename is being refused is caught as well", async (t) => {
        let saved: Buffer = Buffer.alloc(0)
        const s = await setup()
        const seen = refuseReplace(t, 1, "EACCES", () => { saved = externalSave(s.p) })
        const target = await source(s.h)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "REVISION_CONFLICT", "settings-changed")
        assert.equal(seen.attempts, 1)
        assert.deepEqual(bytes(s.p), saved)
    })

    test("with no change the retry goes on and saves, and the reading tools see the result", async (t) => {
        const seen = refuseReplace(t, 2)
        let pauses = 0
        const s = await setup(settings(), { step: (step) => { if (step === "before-retry") pauses++ } })
        const added = ok(await s.h.call("add_rule", { ...(await source(s.h)), rule: RULE }), ruleWriteOutput)
        assert.deepEqual([added.applied, added.index, added.ruleCount], [true, 3, 4])
        assert.deepEqual([seen.attempts, pauses], [3, 2])
        assert.equal(config(s.p).sourceRules["source:1"][3].search, "^new")
        assert.equal(config(s.p).sourceRules["source:9"].length, 1)
        assert.equal(guardGone(s), true)
        assert.equal(backups(s).length, 1)

        const listing = await listed(s.h, { scope: "source", sourceId: 1 })
        assert.equal(listing.revision, added.revision)
        assert.equal(listing.rules.length, 4)
        const chain = ok(await s.h.call("get_rule_chain", { sourceId: 1 }), getRuleChainOutput)
        assert.equal(chain.chain.at(-1)?.rule.pattern, "^new")

        // Later writes in the same run: the first rename of each is the real one.
        const updated = ok(await s.h.call("update_rule", { ...(await source(s.h)), index: 3, rule: { ...RULE, pattern: "^newer" } }), ruleWriteOutput)
        assert.equal(updated.applied, true)
        ok(await s.h.call("delete_rule", { ...(await source(s.h)), index: 3 }), ruleWriteOutput)
        assert.equal(config(s.p).sourceRules["source:1"].length, 3)
        assert.equal(pauses, 2)
    })

    test("a rename that always fails: every retry checked, an I/O error in the end, config.json intact", async (t) => {
        const seen = refuseReplace(t, Number.MAX_SAFE_INTEGER, "EBUSY")
        let pauses = 0
        const s = await setup(settings(), { step: (step) => { if (step === "before-retry") pauses++ } })
        const target = await source(s.h)
        const before = bytes(s.p)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "RULE_WRITE_FAILED", "replace-failed")
        assert.deepEqual([seen.attempts, pauses], [5, 4])
        assert.deepEqual(bytes(s.p), before)
        assert.equal(guardGone(s), true)
        assert.equal(backups(s).length, 1)
    })

    test("an error that is not retryable: no pause, no retry", async (t) => {
        const seen = refuseReplace(t, Number.MAX_SAFE_INTEGER, "ENOSPC")
        let pauses = 0
        const s = await setup(settings(), { step: (step) => { if (step === "before-retry") pauses++ } })
        const target = await source(s.h)
        const before = bytes(s.p)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "RULE_WRITE_FAILED", "replace-failed")
        assert.deepEqual([seen.attempts, pauses], [1, 0])
        assert.deepEqual(bytes(s.p), before)
        assert.equal(guardGone(s), true)
    })

    test("config.json no longer readable during the pause: no rename, not reported as a conflict, nothing recreated", async (t) => {
        const seen = refuseReplace(t, 1)
        let s: Setup
        s = await setup(settings(), { step: (step) => { if (step === "before-retry") fs.unlinkSync(s.p.configPath) } })
        const target = await source(s.h)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "SETTINGS_UNAVAILABLE", "missing")
        assert.equal(seen.attempts, 1)
        assert.equal(fs.existsSync(s.p.configPath), false)
        assert.equal(guardGone(s), true)
        assert.equal(backups(s).length, 1)
    })

    test("the lockfile appearing while the retry reads config.json stops it", async (t) => {
        const seen = refuseReplace(t, 1)
        let s: Setup | undefined
        let armed = false
        const realRead = fs.readSync
        t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>): number => {
            if (armed) {
                armed = false
                fs.writeFileSync(path.join((s as Setup).p.dir, APP_LOCK_FILE), "")
            }
            return realRead(...args)
        })
        s = await setup(settings(), { step: (step) => { if (step === "before-retry") armed = true } })
        const target = await source(s.h)
        const before = bytes(s.p)
        refused(await s.h.call("add_rule", { ...target, rule: RULE }), "FLUENT_READER_RUNNING", "lockfile-present")
        assert.equal(seen.attempts, 1)
        assert.deepEqual(bytes(s.p), before)
    })

    test("rules, foreign fields and the rule count stay as they were on every refused retry", async (t) => {
        const seen = refuseReplace(t, 1)
        let s: Setup
        s = await setup(settings({ futureField: { keep: [1, 2, 3] } }), { step: (step) => { if (step === "before-retry") externalSave(s.p) } })
        const target = await source(s.h)
        const listedBefore = (await listed(s.h, { scope: "source", sourceId: 1 })).rules.length
        refused(await s.h.call("delete_rule", { ...target, index: 0 }), "REVISION_CONFLICT", "settings-changed")
        assert.equal(seen.attempts, 1)
        assert.deepEqual(config(s.p).futureField, { keep: [1, 2, 3] })
        assert.equal((await listed(s.h, { scope: "source", sourceId: 1 })).rules.length, listedBefore)
    })
})

describe("private backups", () => {
    test("exact bytes in the private folder, one per change, under a new name; the result has no path", async () => {
        const s = await setup()
        const first = bytes(s.p)
        const a = ok(await s.h.call("add_rule", { ...(await source(s.h)), rule: RULE }), ruleWriteOutput)
        const second = bytes(s.p)
        const b = ok(await s.h.call("delete_rule", { ...(await source(s.h)), index: 0 }), ruleWriteOutput)
        const files = backups(s)
        assert.equal(files.length, 2)
        for (const file of files) assert.match(path.basename(file), BACKUP_NAME)
        assert.deepEqual(fs.readFileSync(path.join(path.dirname(files[0] as string), a.backup?.name as string)), first)
        assert.deepEqual(fs.readFileSync(path.join(path.dirname(files[0] as string), b.backup?.name as string)), second)
        assert.equal(a.backup?.location, BACKUP_LOCATION)
        const text = JSON.stringify([a, b])
        assert.deepEqual(findLeaks([text], [s.store.userProfile, s.p.dir, SECRET_SENTINEL, FAKE_PASSWORD]), [])
        assert.deepEqual(fs.readdirSync(s.p.dir).sort(), ["config.json", "fluent-reader.db"])
    })

    test("the same second does not overwrite a backup", async () => {
        const dir = path.join(root, `rw${++counter}`)
        const p = createSourcesProfile(dir, { sources: [{ sid: 1 }], settings: settings() })
        const store = storage()
        const h = await harness(p, { now: () => Date.UTC(2026, 10, 4, 12, 0, 0), ruleWrites: store })
        open.push(h)
        const names: string[] = []
        for (let i = 0; i < 3; i++) names.push((ok(await h.call("add_rule", { ...(await source(h)), rule: { ...RULE, pattern: `p${i}` } }), ruleWriteOutput).backup?.name) as string)
        assert.deepEqual(names, ["config.json.20261104T120000Z.bak", "config.json.20261104T120000Z-1.bak", "config.json.20261104T120000Z-2.bak"])
    })

    test("restoring a backup by hand brings back the previous rules", async () => {
        const s = await setup()
        const first = bytes(s.p)
        const out = ok(await s.h.call("add_rule", { ...(await source(s.h)), rule: RULE }), ruleWriteOutput)
        const key = fs.readdirSync(s.backupRoot)[0] as string
        fs.copyFileSync(path.join(s.backupRoot, key, out.backup?.name as string), s.p.configPath)
        assert.deepEqual(bytes(s.p), first)
        assert.equal((await listed(s.h, { scope: "source", sourceId: 1 })).revision, out.previousRevision)
    })

    test("no usable private folder: nothing is written, nothing is saved elsewhere", async () => {
        const home = storage()
        const inside = path.join(home.localAppData, BACKUP_ROOT)
        const variants: Partial<RuleWriteSettings>[] = [
            { localAppData: undefined },
            { userProfile: undefined },
            { localAppData: "relative\\path" },
            { localAppData: "\\\\server\\share" },
            { localAppData: path.join(root, "not-created-outside"), userProfile: home.userProfile },
        ]
        for (const variant of variants) {
            const s = await setup(settings(), variant)
            const target = await source(s.h)
            const initial = snapshotDir(s.p.dir)
            refused(await s.h.call("add_rule", { ...target, rule: RULE }), "RULE_BACKUP_UNAVAILABLE", "backup-location")
            assert.deepEqual(snapshotDir(s.p.dir), initial)
        }
        // Outside the user profile, even if it exists.
        const outside = path.join(root, `outside${++counter}`)
        fs.mkdirSync(outside)
        const far = await setup(settings(), { localAppData: outside, userProfile: home.userProfile })
        refused(await far.h.call("add_rule", { ...(await source(far.h)), rule: RULE }), "RULE_BACKUP_UNAVAILABLE", "backup-location")
        assert.deepEqual(fs.readdirSync(outside), [])
        // A managed level that is a file, or a junction leading elsewhere.
        fs.writeFileSync(inside, "x")
        const file = await setup(settings(), home)
        refused(await file.h.call("add_rule", { ...(await source(file.h)), rule: RULE }), "RULE_BACKUP_UNAVAILABLE", "backup-location")
        fs.unlinkSync(inside)
        fs.symlinkSync(outside, inside, "junction")
        const linked = await setup(settings(), home)
        refused(await linked.h.call("add_rule", { ...(await source(linked.h)), rule: RULE }), "RULE_BACKUP_UNAVAILABLE", "backup-location")
        assert.deepEqual(fs.readdirSync(outside), [])
        fs.rmdirSync(inside)
    })
})

describe("always available, never automatic", () => {
    test("the settings read only the storage location: the legacy variable means nothing, at any value", () => {
        for (const value of [undefined, "", "0", "true", "yes", "TRUE", " 1", "1 ", "1"]) {
            assert.deepEqual(ruleWriteSettingsFromEnv({ FLUENT_READER_MCP_ENABLE_RULE_WRITES: value, LOCALAPPDATA: "a", USERPROFILE: "b" }), { localAppData: "a", userProfile: "b" }, String(value))
        }
    })

    test("listed even without private storage, where a write is refused and the profile stays as it was", async () => {
        const dir = path.join(root, `rw${++counter}`)
        const p = createSourcesProfile(dir, { sources: [{ sid: 1 }], settings: settings() })
        const h = await harness(p)
        open.push(h)
        const tools = (await h.client.listTools()).tools
        assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS])
        const initial = snapshotDir(p.dir)
        refused(await h.call("add_rule", { ...(await source(h)), rule: RULE }), "RULE_BACKUP_UNAVAILABLE")
        for (const handler of [addRule, updateRule, deleteRule]) {
            await assert.rejects(handler(h.context, { anything: true }), { code: "INVALID_ARGUMENT" })
        }
        assert.deepEqual(snapshotDir(p.dir), initial)
    })

    test("sixteen tools, with annotations telling reads, writes and deletion apart", async () => {
        const s = await setup()
        const tools = new Map((await s.h.client.listTools()).tools.map((t) => [t.name, t]))
        assert.equal(tools.size, 16)
        for (const name of ["list_rules", "get_rule_chain", "preview_rule_change"]) {
            assert.deepEqual([tools.get(name)?.annotations?.readOnlyHint, tools.get(name)?.annotations?.destructiveHint], [true, false], name)
        }
        assert.deepEqual([tools.get("add_rule")?.annotations?.readOnlyHint, tools.get("add_rule")?.annotations?.destructiveHint], [false, false])
        assert.deepEqual([tools.get("update_rule")?.annotations?.readOnlyHint, tools.get("update_rule")?.annotations?.destructiveHint], [false, true])
        assert.deepEqual([tools.get("delete_rule")?.annotations?.readOnlyHint, tools.get("delete_rule")?.annotations?.destructiveHint], [false, true])
        assert.match(tools.get("delete_rule")?.description ?? "", /^DESTRUCTIVE/)
        for (const name of ["add_rule", "update_rule", "delete_rule", "preview_rule_change"]) {
            const tool = tools.get(name)
            assert.equal(tool?.annotations?.openWorldHint, false)
            assert.equal(tool?.inputSchema.type, "object")
            assert.equal((tool?.inputSchema as { additionalProperties?: unknown }).additionalProperties, false)
            assert.equal(tool?.outputSchema?.type, "object")
        }
    })
})

describe("privacy", () => {
    test("no result, error or log line carries credentials, paths or settings", async () => {
        const s = await setup()
        const target = await source(s.h)
        const stderr: string[] = []
        const write = process.stderr.write.bind(process.stderr)
        process.stderr.write = ((chunk: string) => {
            stderr.push(String(chunk))
            return true
        }) as typeof process.stderr.write
        const outcomes: ToolOutcome[] = []
        try {
            outcomes.push(await s.h.call("preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: RULE }))
            outcomes.push(await s.h.call("add_rule", { ...target, rule: RULE }))
            outcomes.push(await s.h.call("add_rule", { ...target, rule: RULE }))
            fs.writeFileSync(s.p.configPath, `{"serviceConfigs":{"password":"${FAKE_PASSWORD}"},`)
            outcomes.push(await s.h.call("add_rule", { ...target, rule: RULE }))
        } finally {
            process.stderr.write = write
        }
        const texts = [...outcomes.map((o) => o.text), ...stderr]
        assert.deepEqual(findLeaks(texts, [SECRET_SENTINEL, FAKE_PASSWORD, s.p.dir, s.store.userProfile, "sync.invalid", "proxy.invalid", "feed.invalid"]), [])
        assert.ok(stderr.some((line) => line.includes('"event":"rule_write_committed"')))
        assert.ok(!stderr.join("").includes("^new"), "a pattern is never logged")
    })
})

describe("over stdio, with the real entry point", { timeout: 60_000 }, () => {
    const start = async (env: Record<string, string>, dir: string) => {
        const server = startServer(["--profile-dir", dir], childEnv(env))
        await request(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } })
        server.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
        return server
    }

    test("without the variable, or with the legacy one at any value: sixteen tools and the same refusals; the whole flow saves on disk", async () => {
        const dir = path.join(root, `rw${++counter}`)
        const p = createSourcesProfile(dir, { sources: [{ sid: 1 }], settings: JSON.stringify(settings(), undefined, "\t") })
        const store = storage()
        const env = { LOCALAPPDATA: store.localAppData, USERPROFILE: store.userProfile }
        const initial = snapshotDir(p.dir)

        for (const legacy of ["0", "1"]) {
            const server = await start({ ...env, FLUENT_READER_MCP_ENABLE_RULE_WRITES: legacy }, p.dir)
            const listed = await request(server, { jsonrpc: "2.0", id: 2, method: "tools/list" })
            assert.equal((listed.result as { tools: unknown[] }).tools.length, 16)
            const refusedCall = await request(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add_rule", arguments: {} } })
            assert.ok("error" in refusedCall || (refusedCall.result as { isError?: boolean }).isError === true)
            server.child.stdin.end()
            assert.equal((await server.exited(5_000)).code, 0)
            assert.deepEqual(snapshotDir(p.dir), initial)
        }

        const on = await start(env, p.dir)
        const onList = await request(on, { jsonrpc: "2.0", id: 2, method: "tools/list" })
        assert.equal((onList.result as { tools: unknown[] }).tools.length, 16)
        const call = async (id: number, name: string, args: unknown): Promise<any> => ((await request(on, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).result as { structuredContent: unknown }).structuredContent
        const preview = await call(3, "preview_rule_change", { operation: "add", scope: "source", sourceId: 1, rule: RULE })
        const saved = await call(4, "add_rule", { scope: "source", sourceId: 1, sourceRef: preview.target.sourceRef, expectedRevision: preview.currentRevision, rule: RULE })
        assert.deepEqual([saved.index, saved.applied], [preview.index, true])
        const page = await call(5, "list_rules", { scope: "source", sourceId: 1, limit: 10 })
        assert.equal(page.revision, saved.revision)
        on.child.stdin.end()
        const onExit = await on.exited(5_000)
        assert.equal(onExit.code, 0)
        assert.deepEqual(findLeaks([onExit.stdout, onExit.stderr], [SECRET_SENTINEL, FAKE_PASSWORD, p.dir, store.userProfile]), [])
        const onDisk = config(p)
        assert.equal(onDisk.sourceRules["source:1"].length, 4)
        assert.deepEqual(onDisk.serviceConfigs, syntheticSettings().serviceConfigs)
        assert.equal(fs.readFileSync(p.configPath, "utf8"), JSON.stringify(onDisk, undefined, "\t"))
    })
})
