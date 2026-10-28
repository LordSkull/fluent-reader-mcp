import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, test } from "node:test"
import { DatabaseAccess, fileLock } from "../src/db/connection.js"
import { GROUP_SQL, MEMBER_CHECK_MAX } from "../src/domain/group-catalog.js"
import { RECORD_BYTES_MAX, SOURCE_SQL } from "../src/domain/sources.js"
import { CursorRegistry, CURSOR_TTL_MS } from "../src/scan/cursors.js"
import { RESP_MAX } from "../src/tools/result.js"
import { getGroupOutput, type GetGroupOutput } from "../src/tools/schemas.js"
import { createTempRoot, findLeaks, removeTempRoot, SECRET_SENTINEL, snapshotDir, type ProfileFixture } from "./helpers/fixtures.js"
import {
    createSourcesProfile,
    harness,
    mutate,
    recordingRowLoads,
    type Harness,
    type HarnessOptions,
    type SourceSpec,
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

function profile(options: SourcesProfileOptions): ProfileFixture {
    counter++
    return createSourcesProfile(path.join(root, `gg${counter}`), options)
}

async function setup(options: SourcesProfileOptions, harnessOptions: HarnessOptions = {}): Promise<{ p: ProfileFixture; h: Harness }> {
    const p = profile(options)
    const h = await harness(p, harnessOptions)
    open.push(h)
    return { p, h }
}

const plain = (ids: readonly number[]): SourceSpec[] => ids.map((sid) => ({ sid }))

/** Successful get_group page, validated against the published output schema. */
async function group(h: Harness, args: Record<string, unknown>): Promise<GetGroupOutput & { outcome: ToolOutcome }> {
    const outcome = await h.call("get_group", args)
    assert.equal(outcome.isError, false, outcome.text)
    assert.ok(outcome.length <= RESP_MAX)
    assert.deepEqual(JSON.parse(outcome.text), outcome.payload)
    return { ...getGroupOutput.parse(outcome.payload), outcome }
}

async function allMembers(h: Harness, groupId: number, limit: number): Promise<GetGroupOutput[]> {
    const pages: GetGroupOutput[] = []
    let cursor: string | null = null
    do {
        const page = await group(h, cursor === null ? { groupId, limit } : { groupId, cursor })
        pages.push(page)
        cursor = page.nextCursor
        assert.ok(pages.length < 10_000, "pagination did not terminate")
    } while (cursor !== null)
    return pages
}

const memberIds = (pages: readonly GetGroupOutput[]) => pages.flatMap((p) => p.sources.map((s) => s.sourceId))

const settings = {
    sourceGroups: [
        { gid: 1, isMultiple: true, sids: [5], name: "Earlier" },
        { gid: 4, isMultiple: true, sids: [2, 0, 99, 5, 1], name: "Four" },
        { gid: 6, isMultiple: false, sids: [3] },
        { gid: 7, isMultiple: true, sids: [] },
        { gid: 8, isMultiple: true, sids: [2] },
        { gid: 9, isMultiple: true, sids: [3] },
        { gid: 9, isMultiple: false, sids: [4] },
    ],
    sourceRules: {
        "group:4": [
            { filter: 7, search: "a", match: true, actions: ["r-true"] },
            { filter: 7, search: "b", match: true, actions: ["h-true"] },
        ],
        "source:2": [{ filter: 7, search: "c", match: true, actions: ["r-true"] }],
    },
}

describe("get_group", () => {
    test("1, 5-10. members in stored order: sid 0, orphan, earlier group, hidden source, sourceRef as get_source", async () => {
        const { h } = await setup({
            sources: [{ sid: 0, name: "Zero" }, { sid: 1, hidden: 1 }, { sid: 2 }, { sid: 3 }, { sid: 4 }, { sid: 5 }],
            settings,
        })
        const page = await group(h, { groupId: 4 })
        assert.deepEqual(
            [page.groupId, page.name, page.position, page.sourceCount, page.distinctSourceCount, page.ruleCount, page.rulesError],
            [4, "Four", 1, 5, 5, 2, null],
        )
        assert.deepEqual(
            page.sources.map((s) => [s.index, s.sourceId, s.name, s.hidden, s.exists, s.effectiveGroup]),
            [
                [0, 2, "Source 2", false, true, true],
                [1, 0, "Zero", false, true, true],
                [2, 99, null, null, false, null], // orphan: nothing invented
                [3, 5, "Source 5", false, true, false], // its first group is gid 1
                [4, 1, "Source 1", true, true, true],
            ],
        )
        assert.equal(page.sources[2]?.sourceRef, null)
        for (const s of page.sources.filter((m) => m.exists)) {
            const viaGetSource = await h.call("get_source", { sourceId: s.sourceId })
            assert.equal(s.sourceRef, viaGetSource.payload.source.sourceRef)
            assert.match(s.sourceRef ?? "", /^sr1\./)
        }
        assert.deepEqual(page.integrity, {
            repeatedMemberships: { count: 0, sample: [] },
            sourcesInEarlierGroups: { count: 1, sample: [5] },
            sourcesInSingleEntries: { count: 0, sample: [] },
            negativeSourceIdCount: 0,
            membersCheck: "complete",
            orphanSourceIds: { count: 1, sample: [99] },
        })
        assert.equal(page.hasMore, false)
        assert.equal(page.nextCursor, null)
        assert.equal(page.meta.urlsRedacted, true)
        // the same source listed later is not effective there; in its first group it is
        assert.equal((await group(h, { groupId: 8 })).sources[0]?.effectiveGroup, false)
        assert.equal((await group(h, { groupId: 1 })).sources[0]?.effectiveGroup, true)
    })

    test("2-4, 8. absent, single entry, duplicate gid, empty group, group without name", async () => {
        const { h } = await setup({ sources: plain([0, 1, 2, 3, 4, 5]), settings })
        const absent = await h.call("get_group", { groupId: 77 })
        assert.deepEqual([absent.error?.code, absent.error?.reason], ["NOT_FOUND", "group-not-found"])
        const single = await h.call("get_group", { groupId: 6 })
        assert.deepEqual([single.error?.code, single.error?.reason], ["NOT_FOUND", "not-a-group"])
        const ambiguous = await h.call("get_group", { groupId: 9 })
        assert.deepEqual([ambiguous.error?.code, ambiguous.error?.reason], ["GROUP_AMBIGUOUS", "duplicate-gid"])
        const empty = await group(h, { groupId: 7 })
        assert.deepEqual([empty.sources, empty.sourceCount, empty.hasMore, empty.nextCursor, empty.name], [[], 0, false, null, null])
        assert.equal(empty.scan.stoppedBy, "exhausted")
        assert.equal(empty.ruleCount, 0)
        for (const args of [{}, { groupId: -1 }, { groupId: 1.5 }, { groupId: "4" }, { groupId: 4, limit: 0 }, { groupId: 4, limit: 201 }, { groupId: 4, x: 1 }]) {
            assert.equal((await h.call("get_group", args)).error?.code, "INVALID_ARGUMENT", JSON.stringify(args))
        }
    })

    test("7. an earlier group with a negative gid still takes precedence; negative member sids are never ids", async () => {
        const { h } = await setup({
            sources: plain([3, 4]),
            settings: {
                sourceGroups: [
                    { gid: -1, isMultiple: true, sids: [3] },
                    { gid: 5, isMultiple: true, sids: [-2, 3, 4, 4] },
                    { gid: 6, isMultiple: false, sids: [4] },
                ],
            },
        })
        const page = await group(h, { groupId: 5 })
        assert.deepEqual(
            page.sources.map((s) => [s.index, s.sourceId, s.exists, s.effectiveGroup]),
            [
                [0, null, null, null],
                [1, 3, true, false],
                [2, 4, true, true],
                [3, 4, true, true],
            ],
        )
        assert.equal(page.integrity.negativeSourceIdCount, 1)
        assert.deepEqual(page.integrity.repeatedMemberships, { count: 1, sample: [4] })
        assert.deepEqual(page.integrity.sourcesInEarlierGroups, { count: 1, sample: [3] })
        assert.deepEqual(page.integrity.sourcesInSingleEntries, { count: 1, sample: [4] })
        assert.deepEqual(page.integrity.orphanSourceIds, { count: 0, sample: [] })
        assert.ok(!page.outcome.text.includes(":-"))
    })

    test("11. rule count: stored rules, none, unreadable sourceRules (null with the settings code)", async () => {
        const { p, h } = await setup({ sources: plain([0, 1, 2, 3, 4, 5]), settings })
        assert.equal((await group(h, { groupId: 4 })).ruleCount, 2)
        assert.equal((await group(h, { groupId: 8 })).ruleCount, 0)
        fs.writeFileSync(p.configPath, JSON.stringify({ ...settings, sourceRules: { "group:4": "broken" } }))
        const broken = await group(h, { groupId: 4 })
        assert.deepEqual([broken.ruleCount, broken.rulesError], [null, "SETTINGS_INVALID"])
        assert.equal(broken.sources.length, 5)
    })

    test("unreadable sourceGroups or settings: the safe settings error", async () => {
        const { p, h } = await setup({
            sources: plain([0]),
            settings: { sourceGroups: { not: "an array" }, serviceConfigs: { password: SECRET_SENTINEL } },
        })
        const r = await h.call("get_group", { groupId: 0 })
        assert.equal(r.error?.code, "SETTINGS_INVALID")
        assert.ok(!r.text.includes(SECRET_SENTINEL))
        fs.rmSync(p.configPath)
        assert.equal((await h.call("get_group", { groupId: 0 })).error?.code, "SETTINGS_UNAVAILABLE")
    })
})

describe("get_group: pagination and cursors", () => {
    const order = [17, 3, 0, 22, 9, 9, 14, 1, 30, 5, 12, 8, 21, 2, 19, 4, 11, 6, 25, 7, 13, 10, 16, 18, 15]
    const pagedSettings = { sourceGroups: [{ gid: 2, isMultiple: true, sids: order, name: "Paged" }], sourceRules: {} }

    test("12. members paginated by index in the stored order, duplicates and orphans included", async () => {
        const { h } = await setup({ sources: plain([...Array(25).keys()]), settings: pagedSettings })
        for (const limit of [1, 4, 7, 200]) {
            const pages = await allMembers(h, 2, limit)
            assert.deepEqual(memberIds(pages), order, `limit ${limit}`)
            assert.deepEqual(
                pages.flatMap((p) => p.sources.map((s) => s.index)),
                order.map((_, i) => i),
            )
            for (const page of pages) assert.ok(page.sources.length >= 1 && page.sources.length <= limit)
            for (const page of pages.slice(0, -1)) assert.equal(page.scan.stoppedBy, "pageFull")
            assert.equal(pages.at(-1)?.hasMore, false)
            // sources 0..24 exist: 25 and 30 are orphans
            for (const page of pages) assert.deepEqual(page.integrity.orphanSourceIds, { count: 2, sample: [25, 30] })
        }
    })

    test("13-14. replay, CURSOR_MISMATCH, CURSOR_STALE on a membership change, expiry", async () => {
        let now = Date.UTC(2026, 9, 28, 12)
        const clock = () => now
        const { p, h } = await setup(
            { sources: plain([...Array(25).keys()]), settings: pagedSettings },
            { now: clock, cursors: new CursorRegistry({ now: clock }) },
        )
        const first = await group(h, { groupId: 2, limit: 5 })
        const cursor = first.nextCursor
        assert.equal((await h.call("get_group", { groupId: 3, cursor })).error?.code, "CURSOR_MISMATCH")
        assert.equal((await h.call("get_group", { groupId: 2, limit: 6, cursor })).error?.code, "CURSOR_MISMATCH")
        assert.equal((await h.call("list_groups", { cursor })).error?.code, "CURSOR_MISMATCH")
        const second = await h.call("get_group", { groupId: 2, cursor })
        assert.deepEqual(second.payload.sources.map((s: { sourceId: number }) => s.sourceId), order.slice(5, 10))
        // replayed verbatim even after the database and the settings changed
        mutate(p.dbPath, "UPDATE sources SET name = 'changed' WHERE sid = 22")
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceGroups: [{ gid: 2, isMultiple: true, sids: [1] }] }))
        assert.equal((await h.call("get_group", { groupId: 2, cursor, limit: 5 })).text, second.text)
        // a cursor not yet consumed sees the change
        const stale = await h.call("get_group", { groupId: 2, cursor: second.payload.nextCursor })
        assert.deepEqual([stale.error?.code, stale.error?.reason], ["CURSOR_STALE", "group-changed"])
        assert.equal((await h.call("get_group", { groupId: 2, cursor: second.payload.nextCursor })).error?.code, "CURSOR_EXPIRED")
        // a change elsewhere in sourceGroups is also a different revision
        fs.writeFileSync(p.configPath, JSON.stringify(pagedSettings))
        const again = await group(h, { groupId: 2, limit: 5 })
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceGroups: [...pagedSettings.sourceGroups, { gid: 3, isMultiple: false, sids: [1] }] }))
        assert.equal((await h.call("get_group", { groupId: 2, cursor: again.nextCursor })).error?.code, "CURSOR_STALE")
        fs.writeFileSync(p.configPath, JSON.stringify(pagedSettings))
        const late = await group(h, { groupId: 2, limit: 5 })
        now += CURSOR_TTL_MS + 1
        assert.equal((await h.call("get_group", { groupId: 2, cursor: late.nextCursor })).error?.code, "CURSOR_EXPIRED")
    })

    test("15. anomalous and oversized member records: fieldIssues; over 1 MiB stops the page, stable LIMIT_EXCEEDED, never loaded", async () => {
        const p = profile({
            loose: true,
            sources: [
                { sid: 1, name: new Uint8Array(4), url: null, hidden: 7 },
                { sid: 2 },
                { sid: 3, hidden: new Uint8Array(RECORD_BYTES_MAX + 1) },
                { sid: 4 },
            ],
            settings: { sourceGroups: [{ gid: 0, isMultiple: true, sids: [1, 2, 3, 4] }] },
        })
        const initial = snapshotDir(p.dir)
        const loads: number[][] = []
        const h = await harness(p, { database: recordingRowLoads(new DatabaseAccess(p.dbPath), loads) })
        open.push(h)
        const first = await group(h, { groupId: 0 })
        assert.deepEqual(memberIds([first]), [1, 2])
        assert.equal(first.scan.stoppedBy, "byteBudget")
        assert.deepEqual(
            [first.sources[0]?.name, first.sources[0]?.sourceRef, first.sources[0]?.hidden, first.sources[0]?.fieldIssues],
            [
                null,
                null,
                null,
                [
                    { field: "url", issue: "unexpectedNull", storageClass: "null" },
                    { field: "name", issue: "unexpectedType", storageClass: "blob" },
                    { field: "hidden", issue: "unexpectedValue", storageClass: "integer" },
                ],
            ],
        )
        for (let k = 0; k < 2; k++) {
            const r = await h.call("get_group", { groupId: 0, cursor: first.nextCursor })
            assert.deepEqual([r.error?.code, r.error?.reason], ["LIMIT_EXCEEDED", "record-too-large"])
        }
        assert.ok(loads.every((sids) => !sids.includes(3)), "the oversized record is never loaded")
        assert.deepEqual(snapshotDir(p.dir), initial)
        mutate(p.dbPath, "UPDATE sources SET hidden = 0 WHERE sid = 3")
        const rest = await group(h, { groupId: 0, cursor: first.nextCursor })
        assert.deepEqual(memberIds([rest]), [3, 4], "resumed at the same member, none skipped")
    })

    test("16. responses within 48,000 UTF-16 units: pages cut by the budget; a header too large is LIMIT_EXCEEDED", async () => {
        const sids = [...Array(200).keys()]
        const { h } = await setup({
            sources: sids.map((sid) => ({ sid, name: `${sid}:` + "n\"\\é😀".repeat(60) })),
            settings: { sourceGroups: [{ gid: 0, isMultiple: true, sids, name: "G".repeat(5_000) }] },
        })
        const pages = await allMembers(h, 0, 200)
        assert.deepEqual(memberIds(pages), sids)
        assert.ok(pages.length > 2)
        for (const page of pages.slice(0, -1)) assert.equal(page.scan.stoppedBy, "responseBudget")
        for (const page of pages) assert.equal(page.name?.length, 5_000, "never truncated")

        const { h: h2 } = await setup({
            sources: plain([0]),
            settings: { sourceGroups: [{ gid: 0, isMultiple: true, sids: [0], name: "H".repeat(30_000) }] },
        })
        const r = await h2.call("get_group", { groupId: 0 })
        assert.deepEqual([r.error?.code, r.error?.reason], ["LIMIT_EXCEEDED", "response-too-large"])
        assert.ok(r.length < 1000)

        const { h: h3 } = await setup({ sources: [{ sid: 0, name: "W".repeat(30_000) }], settings: { sourceGroups: [{ gid: 0, isMultiple: true, sids: [0] }] } })
        const one = await h3.call("get_group", { groupId: 0 })
        assert.deepEqual([one.error?.code, one.error?.reason], ["LIMIT_EXCEEDED", "record-too-large"])
    })

    test("a group with more than MEMBER_CHECK_MAX distinct members: orphan count not computed, members still listed", async () => {
        const sids = Array.from({ length: MEMBER_CHECK_MAX + 1 }, (_, k) => k)
        const { h } = await setup({ sources: plain([0, 1, 2]), settings: { sourceGroups: [{ gid: 0, isMultiple: true, sids }] } })
        const page = await group(h, { groupId: 0, limit: 5 })
        assert.deepEqual([page.integrity.membersCheck, page.integrity.orphanSourceIds], ["tooManyMembers", null])
        assert.deepEqual(page.sources.map((s) => [s.sourceId, s.exists]), [
            [0, true],
            [1, true],
            [2, true],
            [3, false],
            [4, false],
        ])
        assert.equal(page.sourceCount, MEMBER_CHECK_MAX + 1)
    })
})

describe("get_group: privacy and read-only behaviour", () => {
    test("no secrets, URLs or serviceRef; primary-key lookups only, never items; profile unchanged", async () => {
        const p = profile({
            sources: [
                { sid: 0, url: `https://user:pw@feed.invalid/${SECRET_SENTINEL}`, serviceRef: SECRET_SENTINEL, iconurl: `https://i.invalid/${SECRET_SENTINEL}` },
                { sid: 1 },
            ],
            items: 30,
            settings: {
                sourceGroups: [{ gid: 0, isMultiple: true, sids: [0, 1, 40] }],
                sourceRules: { "group:0": [{ filter: 7, search: SECRET_SENTINEL, match: true, actions: ["r-true"] }] },
                serviceConfigs: { password: SECRET_SENTINEL },
            },
        })
        const initial = snapshotDir(p.dir)
        const h = await harness(p)
        open.push(h)
        const page = await group(h, { groupId: 0, limit: 1 })
        await allMembers(h, 0, 1)
        await h.call("list_groups")
        assert.equal(page.sources[0]?.sourceRef?.startsWith("sr1."), true)
        assert.deepEqual(findLeaks([page.outcome.text, JSON.stringify(page.outcome.result)], [SECRET_SENTINEL, "invalid", "http"]), [])

        const statements = [...new Set(h.sql)].filter((s) => !s.startsWith("PRAGMA"))
        assert.deepEqual(
            statements.sort(),
            [GROUP_SQL.existing, GROUP_SQL.sidScan, SOURCE_SQL.bounds, SOURCE_SQL.memberCandidates, SOURCE_SQL.rows].sort(),
        )
        const db = new DatabaseSync(p.dbPath, { readOnly: true })
        try {
            for (const sql of statements) {
                assert.ok(!/\bitems\b/i.test(sql), sql)
                const args =
                    sql === SOURCE_SQL.bounds ? [] : sql === GROUP_SQL.sidScan ? [5] : sql === SOURCE_SQL.memberCandidates ? [0, 9, "[1]", 5] : ["[1]"]
                const text = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => String(row.detail)).join(" | ")
                assert.ok(!/SCAN sources|TEMP B-TREE|items/.test(text), `${sql}\n${text}`)
                assert.ok(/SEARCH sources/.test(text), text)
            }
        } finally {
            db.close()
        }
        await h.close()
        open.splice(open.indexOf(h), 1)
        assert.deepEqual(snapshotDir(p.dir), initial, "same files, same hashes: no -wal, -shm or -journal")
    })
})
