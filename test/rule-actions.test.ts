/**
 * Regressions of the FR-MCP-02A-05 review: actions the settings reader
 * discards (over the action limits) or that are unknown must not make two
 * different rules identical, must not support "proven" notes, and must
 * change the revisions; none of them, nor their private fingerprints, may
 * appear in any output.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileLock } from "../src/db/connection.js"
import { LIMITS, readSettings, ruleActionsMetadata, type StoredRuleEntry } from "../src/settings/read-settings.js"
import { RESP_MAX } from "../src/tools/result.js"
import { getRuleChainOutput, listRulesOutput } from "../src/tools/schemas.js"
import { createTempRoot, findLeaks, removeTempRoot, snapshotDir, type ProfileFixture } from "./helpers/fixtures.js"
import { createSourcesProfile, harness, type Harness, type ToolOutcome } from "./helpers/sources.js"

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

const R = (actions: unknown[], search = "same", filter = 7, match = true) => ({ filter, search, match, actions })
const many = (action: string) => Array.from({ length: LIMITS.actionsPerRule + 1 }, () => action)
const LONG_A = `r-${"a".repeat(LIMITS.actionLength)}` // over 64 characters
const LONG_B = `r-${"b".repeat(LIMITS.actionLength)}`

async function setup(settings: unknown): Promise<{ p: ProfileFixture; h: Harness }> {
    counter++
    const p = createSourcesProfile(path.join(root, `ra${counter}`), { sources: [{ sid: 0 }, { sid: 1 }, { sid: 2 }], settings })
    const h = await harness(p)
    open.push(h)
    return { p, h }
}

async function ok(h: Harness, tool: "list_rules" | "get_rule_chain", args: Record<string, unknown>): Promise<ToolOutcome> {
    const outcome = await h.call(tool, args)
    assert.equal(outcome.isError, false, outcome.text)
    assert.ok(outcome.length <= RESP_MAX)
    ;(tool === "list_rules" ? listRulesOutput : getRuleChainOutput).parse(outcome.payload)
    return outcome
}

const notes = (outcome: ToolOutcome) =>
    (outcome.payload.conflicts as { kind: string; certainty: string; flag: string | null; orders: number[] }[])
        .map((c) => `${c.kind}:${c.certainty}:${c.flag}:${c.orders.join(",")}`)
        .sort()

/** Captures stderr while `fn` runs. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
    const write = process.stderr.write.bind(process.stderr)
    let text = ""
    process.stderr.write = ((chunk: string | Uint8Array) => {
        text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
        return true
    }) as typeof process.stderr.write
    try {
        return { result: await fn(), text }
    } finally {
        process.stderr.write = write
    }
}

describe("rule actions discarded by the reader or unknown", () => {
    test("1-4, 8. the reader keeps the sanitized shape and private metadata taken before sanitization", async () => {
        const settings = { sourceRules: { all: [R(many("r-true")), R(many("h-true")), R([LONG_A]), R([LONG_B]), R(["r-true"]), R(["r-true"]), R([])] } }
        const { p } = await setup(settings)
        const snapshot = await readSettings(p.configPath, p.dir)
        assert.ok(snapshot.sourceRules.ok)
        const rules = snapshot.sourceRules.value.get("all") as StoredRuleEntry[]
        // unchanged public shape: discarded arrays are still null, an empty array stays empty
        for (const k of [0, 1, 2, 3]) assert.deepEqual(rules[k], { filter: 7, search: "same", match: true, actions: null, malformed: "actions-limit" })
        assert.deepEqual(rules[6]?.actions, [])
        const meta = rules.map((rule) => ruleActionsMetadata(rule)!)
        assert.deepEqual(meta.map((m) => [m.count, m.preserved]), [[65, false], [65, false], [1, false], [1, false], [1, true], [1, true], [0, true]])
        for (const m of meta) assert.match(m.fingerprint, /^[0-9a-f]{64}$/)
        assert.notEqual(meta[0]!.fingerprint, meta[1]!.fingerprint, "65 × r-true ≠ 65 × h-true")
        assert.notEqual(meta[2]!.fingerprint, meta[3]!.fingerprint, "two different over-long actions")
        assert.equal(meta[4]!.fingerprint, meta[5]!.fingerprint, "identical arrays")
        // stable for the life of the process (no spurious staleness), invisible to serialization
        const again = await readSettings(p.configPath, p.dir)
        assert.ok(again.sourceRules.ok)
        assert.deepEqual(again.sourceRules.value.get("all")!.map((rule) => ruleActionsMetadata(rule)!.fingerprint), meta.map((m) => m.fingerprint))
        const serialized = JSON.stringify(rules)
        for (const m of meta) assert.ok(!serialized.includes(m.fingerprint))
        assert.ok(!serialized.includes("aaaa"))
    })

    test("5, 9, 11-13. no false 'proven': discarded, over-long and unknown actions, Object.prototype names", async () => {
        const { h } = await setup({
            sourceRules: {
                all: [
                    R(many("r-true")), // 0
                    R(many("h-true")), // 1: same condition and count, different actions
                    R([LONG_A]), // 2
                    R([LONG_B]), // 3: different over-long action
                    R(many("r-true")), // 4: identical to 0 (fingerprint), effect unknown
                ],
                "source:1": [
                    R(["zz-true", "h-true"]), // 5
                    R(["qq-true", "h-true"]), // 6: different unknown action, same count
                    R(["zz-true", "h-false"]), // 7: same condition, opposite hide, unknown action
                    R(["constructor-true", "s-true"], "proto"), // 8
                    R(["toString-true", "s-false"], "proto"), // 9: Object.prototype names, opposite star
                    R(["toString", "n-true", "n-false"], "contra"), // 10: contradictory, with an unknown action
                    R(["n-true", "n-false"], "contra2"), // 11: contradictory, fully known
                    R(["s-true"], "known"), // 12
                    R(["s-false"], "known"), // 13: fully known, state independent: proven
                ],
            },
        })
        const listed = await ok(h, "list_rules", { scope: "all", limit: 10 })
        for (const rule of listed.payload.rules as { actions: unknown; rawActionCount: number; diagnostics: string[] }[]) {
            assert.equal(rule.actions, null)
            assert.ok(rule.diagnostics.includes("malformedActions"))
        }
        assert.deepEqual((listed.payload.rules as { rawActionCount: number }[]).map((r) => r.rawActionCount), [65, 65, 1, 1, 65])

        const { result: chain, text: stderr } = await captureStderr(() => ok(h, "get_rule_chain", { sourceId: 1 }))
        assert.deepEqual(notes(chain), [
            "contradictoryActionsInRule:notStaticallyDecidable:null:10",
            "contradictoryActionsInRule:proven:null:11",
            // identical stored rules, but their (discarded) actions are unknown
            "duplicateRule:notStaticallyDecidable:null:0,4",
            "oppositeActionsSameCondition:notStaticallyDecidable:hide:5,6,7",
            "oppositeActionsSameCondition:notStaticallyDecidable:star:8,9",
            "oppositeActionsSameCondition:proven:star:12,13",
            "sameFlagDifferentConditions:notStaticallyDecidable:star:8,9,12,13",
        ])
        // 0 vs 1 and 2 vs 3 (same count, different actions) and 5 vs 6 (different unknown actions) are not duplicates
        for (const raw of ["zz-true", "qq-true", "constructor-true", "toString", "aaaa", "bbbb"]) {
            assert.ok(!chain.text.includes(raw) && !listed.text.includes(raw) && !stderr.includes(raw), raw)
        }
    })

    test("6, 7, 10, 14-17. revisions and cursors follow the stored actions; replay; unrelated or no change keeps the scan", async () => {
        const base = {
            sourceGroups: [{ gid: 3, isMultiple: true, sids: [1] }],
            sourceRules: {
                all: [R(many("r-true")), R(["r-true"], "a1"), R(["r-true"], "a2")],
                "group:3": [R([LONG_A], "g0"), R(["r-true"], "g1")],
                "source:1": [R(["zz-true"], "s0"), R(["r-true"], "s1")],
                "source:2": [R(["r-true"], "unrelated")],
            },
        }
        const { p, h } = await setup(base)
        const write = (settings: unknown) => fs.writeFileSync(p.configPath, JSON.stringify(settings))
        const initial = snapshotDir(p.dir)
        const variants: [string, "list" | "chain", unknown][] = [
            ["discarded all actions (same count)", "list", { ...base, sourceRules: { ...base.sourceRules, all: [R(many("h-true")), ...base.sourceRules.all.slice(1)] } }],
            ["discarded all actions (same count)", "chain", { ...base, sourceRules: { ...base.sourceRules, all: [R(many("h-true")), ...base.sourceRules.all.slice(1)] } }],
            ["over-long group action", "chain", { ...base, sourceRules: { ...base.sourceRules, "group:3": [R([LONG_B], "g0"), base.sourceRules["group:3"][1]] } }],
            ["unknown source action, same count", "chain", { ...base, sourceRules: { ...base.sourceRules, "source:1": [R(["qq-true"], "s0"), base.sourceRules["source:1"][1]] } }],
            ["action order", "list", { ...base, sourceRules: { ...base.sourceRules, all: [R([...many("r-true").slice(1), "h-true"]), ...base.sourceRules.all.slice(1)] } }],
        ]
        for (const [label, kind, change] of variants) {
            write(base)
            const args = kind === "list" ? { scope: "all", limit: 1 } : { sourceId: 1, limit: 2 }
            const tool = kind === "list" ? "list_rules" : "get_rule_chain"
            const first = await ok(h, tool, args)
            const cursor = first.payload.nextCursor as string
            const second = await ok(h, tool, { ...args, cursor })
            const revisionField = kind === "list" ? "revision" : "chainRevision"
            write(change)
            // a page already published is replayed verbatim
            assert.equal((await h.call(tool, { ...args, cursor })).text, second.text, label)
            // a new page sees the change
            const stale = await h.call(tool, { ...args, cursor: second.payload.nextCursor })
            assert.deepEqual([stale.error?.code, stale.error?.reason], ["CURSOR_STALE", "rules-changed"], `${kind}: ${label}`)
            const fresh = await ok(h, tool, args)
            assert.notEqual(fresh.payload[revisionField], first.payload[revisionField], `${kind}: ${label}`)
        }
        // the same configuration rewritten, and changes to other targets: no invalidation
        write(base)
        const keep = await ok(h, "get_rule_chain", { sourceId: 1, limit: 2 })
        const keepList = await ok(h, "list_rules", { scope: "all", limit: 1 })
        write(JSON.parse(JSON.stringify(base)))
        write({ ...base, sourceRules: { ...base.sourceRules, "source:2": [R(many("h-true"), "unrelated")] } })
        assert.equal((await ok(h, "get_rule_chain", { sourceId: 1, cursor: keep.payload.nextCursor })).payload.chain[0].order, 2)
        assert.equal((await ok(h, "list_rules", { scope: "all", limit: 1, cursor: keepList.payload.nextCursor })).payload.rules[0].index, 1)
        // unchanged configuration: identical revisions on every read
        write(base)
        const r1 = await ok(h, "get_rule_chain", { sourceId: 1 })
        const r2 = await ok(h, "get_rule_chain", { sourceId: 1 })
        assert.equal(r1.payload.chainRevision, r2.payload.chainRevision)

        // 18-20. nothing private in any output; nothing written by the reads (config rewritten by the test only)
        const { result: out, text: stderr } = await captureStderr(() => ok(h, "get_rule_chain", { sourceId: 1 }))
        const snapshot = await readSettings(p.configPath, p.dir)
        assert.ok(snapshot.sourceRules.ok)
        const fingerprints = [...snapshot.sourceRules.value.values()].flat().map((rule) => ruleActionsMetadata(rule)!.fingerprint)
        assert.deepEqual(findLeaks([out.text, JSON.stringify(out.result), stderr], [...fingerprints, "zz-true", "aaaa"]), [])
        const errorOut = await h.call("list_rules", { scope: "all", limit: 1, cursor: "c1.forged" })
        assert.deepEqual(findLeaks([errorOut.text], [...fingerprints, "zz-true", "aaaa"]), [])
        const db = [...snapshotDir(p.dir)].filter(([name]) => name !== "config.json")
        assert.deepEqual(db, [...initial].filter(([name]) => name !== "config.json"), "database unchanged, no -wal/-shm/-journal")
    })
})
