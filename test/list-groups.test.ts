import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileLock } from "../src/db/connection.js"
import { DB_SCAN_MAX, GROUP_SQL } from "../src/domain/group-catalog.js"
import { CursorRegistry, CURSOR_TTL_MS } from "../src/scan/cursors.js"
import { RESP_MAX } from "../src/tools/result.js"
import { listGroupsOutput, type ListGroupsOutput } from "../src/tools/schemas.js"
import { createTempRoot, findLeaks, removeTempRoot, SECRET_SENTINEL, snapshotDir, type ProfileFixture } from "./helpers/fixtures.js"
import {
    createSourcesProfile,
    harness,
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

async function setup(options: SourcesProfileOptions, harnessOptions: HarnessOptions = {}): Promise<{ p: ProfileFixture; h: Harness }> {
    counter++
    const p = createSourcesProfile(path.join(root, `lg${counter}`), options)
    const h = await harness(p, harnessOptions)
    open.push(h)
    return { p, h }
}

const plain = (ids: readonly number[]): SourceSpec[] => ids.map((sid) => ({ sid }))
const groupsOf = (settings: unknown) => ({ sourceGroups: settings, sourceRules: {} })

/** Successful list_groups page, validated against the published output schema. */
async function groups(h: Harness, args: Record<string, unknown> = {}): Promise<ListGroupsOutput & { outcome: ToolOutcome }> {
    const outcome = await h.call("list_groups", args)
    assert.equal(outcome.isError, false, outcome.text)
    assert.ok(outcome.length <= RESP_MAX)
    assert.deepEqual(JSON.parse(outcome.text), outcome.payload)
    return { ...listGroupsOutput.parse(outcome.payload), outcome }
}

async function allPages(h: Harness, args: Record<string, unknown> = {}): Promise<ListGroupsOutput[]> {
    const pages: ListGroupsOutput[] = []
    let cursor: string | null = null
    do {
        const page = await groups(h, cursor === null ? args : { cursor })
        pages.push(page)
        cursor = page.nextCursor
        assert.ok(pages.length < 10_000, "listing did not terminate")
    } while (cursor !== null)
    return pages
}

const positions = (pages: readonly ListGroupsOutput[]) => pages.flatMap((p) => p.groups.map((g) => g.position))

describe("list_groups: structure", () => {
    test("1. no groups (empty array or absent key): empty terminal page, every source ungrouped", async () => {
        for (const settings of [groupsOf([]), { sourceRules: {} }]) {
            const { h } = await setup({ sources: plain([0, 1, 2]), settings })
            const page = await groups(h)
            assert.deepEqual(page.groups, [])
            assert.equal(page.hasMore, false)
            assert.equal(page.nextCursor, null)
            assert.equal(page.scan.stoppedBy, "exhausted")
            assert.equal(page.integrity.entryCount, 0)
            assert.equal(page.integrity.databaseCheck, "complete")
            assert.deepEqual(page.integrity.orphanSourceIds, { count: 0, sample: [] })
            assert.deepEqual(page.integrity.ungroupedSources, { count: 3, sample: [0, 1, 2] })
            assert.match(page.groupsRevision, /^gr1\.[A-Za-z0-9_-]{22}$/)
            assert.equal(page.meta.schemaVersion, "1")
        }
    })

    test("2. only single entries: no group listed, their sources count as ungrouped", async () => {
        const { h } = await setup({
            sources: plain([1, 2]),
            settings: groupsOf([
                { gid: 0, isMultiple: false, sids: [1] },
                { gid: 1, isMultiple: false, sids: [2] },
            ]),
        })
        const page = await groups(h)
        assert.deepEqual(page.groups, [])
        assert.deepEqual([page.integrity.groupCount, page.integrity.singleEntryCount, page.integrity.entryCount], [0, 2, 2])
        assert.deepEqual(page.integrity.ungroupedSources, { count: 2, sample: [1, 2] })
    })

    test("3-6. empty groups, interleaved single entries, stored order, original positions, includeEmpty", async () => {
        const { h } = await setup({
            sources: plain([1, 2, 3, 4, 5]),
            settings: groupsOf([
                { gid: 0, isMultiple: false, sids: [1] },
                { gid: 3, isMultiple: true, sids: [2, 3], name: "B" },
                { gid: 4, isMultiple: false, sids: [4] },
                { gid: 7, isMultiple: true, sids: [], name: "Empty" },
                { gid: 1, isMultiple: true, sids: [5], name: "A", expanded: false },
            ]),
        })
        const page = await groups(h)
        assert.deepEqual(page.groups, [
            { position: 1, groupId: 3, idStatus: "unique", name: "B", sourceCount: 2, distinctSourceCount: 2, existingSourceCount: 2 },
            { position: 3, groupId: 7, idStatus: "unique", name: "Empty", sourceCount: 0, distinctSourceCount: 0, existingSourceCount: 0 },
            { position: 4, groupId: 1, idStatus: "unique", name: "A", sourceCount: 1, distinctSourceCount: 1, existingSourceCount: 1 },
        ])
        assert.deepEqual(page.scan, { examined: 3, filteredOut: 0, stoppedBy: "exhausted" })
        assert.equal(page.integrity.emptyGroupCount, 1)

        const nonEmpty = await groups(h, { includeEmpty: false })
        assert.deepEqual(nonEmpty.groups.map((g) => g.position), [1, 4])
        assert.deepEqual(nonEmpty.scan, { examined: 3, filteredOut: 1, stoppedBy: "exhausted" })
        assert.equal(nonEmpty.groupsRevision, page.groupsRevision)
    })

    test("7. duplicate gids: among groups, between a group and a single entry, among single entries only", async () => {
        const { h } = await setup({
            sources: plain([1, 2, 3, 4, 5, 6]),
            settings: groupsOf([
                { gid: 2, isMultiple: true, sids: [1] },
                { gid: 2, isMultiple: true, sids: [2] },
                { gid: 3, isMultiple: true, sids: [3] },
                { gid: 3, isMultiple: false, sids: [4] },
                { gid: 9, isMultiple: false, sids: [5] },
                { gid: 9, isMultiple: false, sids: [6] },
                { gid: 10, isMultiple: true, sids: [] },
            ]),
        })
        const page = await groups(h)
        assert.deepEqual(
            page.groups.map((g) => [g.position, g.groupId, g.idStatus]),
            [
                [0, 2, "ambiguous"],
                [1, 2, "ambiguous"],
                [2, 3, "ambiguous"],
                [6, 10, "unique"],
            ],
        )
        assert.deepEqual(page.integrity.duplicateGroupIds, { count: 2, sample: [2, 3] })
        assert.deepEqual(page.integrity.duplicateSingleEntryIds, { count: 1, sample: [9] })
    })

    test("8. negative gid: listed at its position with groupId null and idStatus 'invalid', never as an id", async () => {
        const { h } = await setup({
            sources: plain([1, 2, 3]),
            settings: groupsOf([
                { gid: -1, isMultiple: true, sids: [1], name: "Negative" },
                { gid: -3, isMultiple: false, sids: [2] },
                { gid: 0, isMultiple: true, sids: [3] },
            ]),
        })
        const page = await groups(h)
        assert.deepEqual(
            page.groups.map((g) => [g.position, g.groupId, g.idStatus, g.name]),
            [
                [0, null, "invalid", "Negative"],
                [2, 0, "unique", null],
            ],
        )
        assert.deepEqual(page.integrity.negativeGroupIds, { groupCount: 1, singleEntryCount: 1, groupPositions: [0] })
        assert.deepEqual(page.integrity.duplicateGroupIds, { count: 0, sample: [] })
        // sid 1 is in a group (with an invalid id): not ungrouped; sid 2 only in a single entry
        assert.deepEqual(page.integrity.ungroupedSources, { count: 1, sample: [2] })
        assert.ok(!page.outcome.text.includes('"groupId":-') && !page.outcome.text.includes(":-1"))
    })

    test("9-11. orphans, overlapping and repeated memberships, ungrouped sources, negative sids", async () => {
        const { h } = await setup({
            sources: plain([1, 2, 3, 4, 5, 6]),
            settings: groupsOf([
                { gid: 1, isMultiple: true, sids: [1, 2, 99, 100], name: "With orphans" },
                { gid: 2, isMultiple: true, sids: [2, 3, 3, -7], name: "Overlap" },
                { gid: 3, isMultiple: true, sids: [98], name: "Only orphans" },
                { gid: 4, isMultiple: false, sids: [3] },
                { gid: 5, isMultiple: false, sids: [4, 5] },
            ]),
        })
        const page = await groups(h, { includeEmpty: false })
        assert.deepEqual(
            page.groups.map((g) => [g.groupId, g.sourceCount, g.distinctSourceCount, g.existingSourceCount]),
            [
                [1, 4, 4, 2],
                [2, 4, 3, 2], // -7 is configured but never a source
                [3, 1, 1, 0], // not empty: one configured member, none existing
            ],
        )
        const i = page.integrity
        assert.deepEqual(i.orphanSourceIds, { count: 3, sample: [98, 99, 100] })
        assert.equal(i.negativeSourceIdCount, 1)
        assert.deepEqual(i.sourcesInMultipleGroups, { count: 1, sample: [2] })
        assert.deepEqual(i.sourcesInGroupAndSingleEntry, { count: 1, sample: [3] })
        assert.deepEqual(i.repeatedMemberships, { count: 1, sample: [3] })
        assert.equal(i.nonStandardSingleEntryCount, 1)
        assert.deepEqual(i.ungroupedSources, { count: 3, sample: [4, 5, 6] })
    })

    test("samples are capped at 20 ids, counts stay exact", async () => {
        const many = Array.from({ length: 50 }, (_, k) => 1000 + k)
        const { h } = await setup({ sources: plain([1]), settings: groupsOf([{ gid: 0, isMultiple: true, sids: many }]) })
        const page = await groups(h)
        assert.equal(page.integrity.orphanSourceIds?.count, 50)
        assert.deepEqual(page.integrity.orphanSourceIds?.sample, many.slice(0, 20))
    })

    test("database part skipped, not guessed: too many sources, ids out of range", async () => {
        const { h } = await setup({
            sources: Array.from({ length: DB_SCAN_MAX + 1 }, (_, sid) => ({ sid })),
            settings: groupsOf([{ gid: 0, isMultiple: true, sids: [1, 2, 999_999] }]),
        })
        const page = await groups(h)
        assert.equal(page.integrity.databaseCheck, "tooManySources")
        assert.equal(page.integrity.orphanSourceIds, null)
        assert.equal(page.integrity.ungroupedSources, null)
        assert.equal(page.groups[0]?.existingSourceCount, null)
        assert.equal(page.groups[0]?.sourceCount, 3)

        const { h: h2 } = await setup({ loose: true, sources: plain([-1, 1]), settings: groupsOf([{ gid: 0, isMultiple: true, sids: [1] }]) })
        const out = await groups(h2)
        assert.equal(out.integrity.databaseCheck, "sourceIdsOutOfRange")
        assert.equal(out.integrity.orphanSourceIds, null)
        assert.equal(out.groups[0]?.existingSourceCount, null)
    })

    test("12. invalid or unavailable settings: safe settings error, nothing private exposed", async () => {
        const { p, h } = await setup({
            sources: plain([1]),
            settings: { sourceGroups: "broken", sourceRules: {}, serviceConfigs: { password: SECRET_SENTINEL } },
        })
        const invalid = await h.call("list_groups")
        assert.equal(invalid.error?.code, "SETTINGS_INVALID")
        assert.ok(!invalid.text.includes(SECRET_SENTINEL))
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceGroups: [{ gid: 0, isMultiple: true, sids: Array(20_001).fill(1) }] }))
        assert.equal((await h.call("list_groups")).error?.code, "SETTINGS_TOO_LARGE")
        fs.writeFileSync(p.configPath, "{not json")
        assert.equal((await h.call("list_groups")).error?.code, "SETTINGS_INVALID")
        fs.rmSync(p.configPath)
        assert.equal((await h.call("list_groups")).error?.code, "SETTINGS_UNAVAILABLE")
        for (const args of [{ limit: 0 }, { limit: 201 }, { includeEmpty: "no" }, { extra: 1 }, { cursor: 5 }]) {
            assert.equal((await h.call("list_groups", args)).error?.code, "INVALID_ARGUMENT", JSON.stringify(args))
        }
    })
})

describe("list_groups: pagination and cursors", () => {
    // 40 entries: groups at even positions (every third one empty), single entries at odd positions
    const entries = Array.from({ length: 40 }, (_, position) =>
        position % 2 === 0
            ? { gid: 100 + position, isMultiple: true, sids: position % 3 === 0 ? [] : [position], name: `G${position}` }
            : { gid: 100 + position, isMultiple: false, sids: [position] },
    )
    const expectedAll = entries.flatMap((e, position) => (e.isMultiple ? [position] : []))
    const expectedNonEmpty = entries.flatMap((e, position) => (e.isMultiple && e.sids.length > 0 ? [position] : []))

    test("13. every page size yields every group once, in order; filtered groups and single entries are consumed", async () => {
        const { h } = await setup({ sources: plain([0, 1, 2]), settings: groupsOf(entries) })
        for (const limit of [1, 2, 3, 7, 200]) {
            for (const [includeEmpty, expected] of [
                [true, expectedAll],
                [false, expectedNonEmpty],
            ] as const) {
                const pages = await allPages(h, { limit, includeEmpty })
                assert.deepEqual(positions(pages), expected, `limit ${limit} includeEmpty ${includeEmpty}`)
                for (const page of pages) assert.ok(page.groups.length >= 1 && page.groups.length <= limit)
                for (const page of pages.slice(0, -1)) assert.equal(page.scan.stoppedBy, "pageFull")
                assert.equal(pages.at(-1)?.hasMore, false)
                assert.equal(new Set(pages.map((pg) => pg.groupsRevision)).size, 1)
            }
        }
    })

    test("arguments repeated with a cursor must match; a cursor of another tool is CURSOR_MISMATCH", async () => {
        const { h } = await setup({ sources: plain([0, 1]), settings: groupsOf(entries) })
        const first = await groups(h, { limit: 2, includeEmpty: false })
        const cursor = first.nextCursor
        assert.equal((await h.call("list_groups", { cursor, limit: 3 })).error?.code, "CURSOR_MISMATCH")
        assert.equal((await h.call("list_groups", { cursor, includeEmpty: true })).error?.code, "CURSOR_MISMATCH")
        assert.equal((await h.call("list_groups", { cursor, limit: 2, includeEmpty: false })).isError, false)
        const sourcesCursor = (await h.call("list_sources", { limit: 1 })).payload.nextCursor as string
        assert.equal((await h.call("list_groups", { cursor: sourcesCursor })).error?.code, "CURSOR_MISMATCH")
        assert.equal((await h.call("list_sources", { cursor })).error?.code, "CURSOR_MISMATCH")
        assert.equal((await h.call("list_groups", { cursor: "c1.forged" })).error?.code, "CURSOR_INVALID")
    })

    test("14. replay: the same cursor returns the same page, even after a change; expiry", async () => {
        let now = Date.UTC(2026, 9, 28, 12)
        const clock = () => now
        const { p, h } = await setup(
            { sources: plain([0]), settings: groupsOf(entries) },
            { now: clock, cursors: new CursorRegistry({ now: clock }) },
        )
        const first = await groups(h, { limit: 2 })
        const cursor = first.nextCursor
        const second = await h.call("list_groups", { cursor })
        now += 1000
        fs.writeFileSync(p.configPath, JSON.stringify(groupsOf([{ gid: 1, isMultiple: true, sids: [] }])))
        const again = await h.call("list_groups", { cursor })
        assert.equal(again.text, second.text, "replayed verbatim")
        assert.deepEqual(again.result, second.result)
        now += CURSOR_TTL_MS + 1
        assert.equal((await h.call("list_groups", { cursor })).error?.code, "CURSOR_EXPIRED")
    })

    test("15. a sourceGroups change between pages is CURSOR_STALE and kills the cursor; other keys and 'expanded' do not", async () => {
        const { p, h } = await setup({ sources: plain([0]), settings: groupsOf(entries) })
        const first = await groups(h, { limit: 2 })
        // UI expansion state and unrelated settings keep the revision
        const touched = entries.map((e) => ({ ...e, expanded: true }))
        fs.writeFileSync(p.configPath, JSON.stringify({ ...groupsOf(touched), theme: "dark", sourceRules: { all: [] } }))
        const second = await groups(h, { cursor: first.nextCursor })
        assert.equal(second.groupsRevision, first.groupsRevision)
        for (const change of [
            entries.map((e, i) => (i === 30 ? { ...e, name: "renamed" } : e)),
            entries.map((e, i) => (i === 30 ? { ...e, sids: [...e.sids, 77] } : e)),
            entries.map((e, i) => (i === 31 ? { ...e, isMultiple: true } : e)),
            entries.map((e, i) => (i === 30 ? { ...e, gid: 999 } : e)),
            [...entries.slice(0, 30), entries[32]!, entries[31]!, entries[30]!, ...entries.slice(33)],
        ]) {
            fs.writeFileSync(p.configPath, JSON.stringify(groupsOf(entries)))
            const start = await groups(h, { limit: 2 })
            fs.writeFileSync(p.configPath, JSON.stringify(groupsOf(change)))
            const stale = await h.call("list_groups", { cursor: start.nextCursor })
            assert.equal(stale.error?.code, "CURSOR_STALE")
            assert.equal(stale.error?.reason, "group-changed")
            assert.equal((await h.call("list_groups", { cursor: start.nextCursor })).error?.code, "CURSOR_EXPIRED")
        }
    })

    test("16. many groups: pages cut by the response limit, never truncated; a group too large alone is LIMIT_EXCEEDED", async () => {
        const big = Array.from({ length: 600 }, (_, k) => ({ gid: k, isMultiple: true, sids: [k], name: `${k}:` + "n\"é😀".repeat(40) }))
        const { h } = await setup({ sources: plain([0, 1]), settings: groupsOf(big) })
        const pages = await allPages(h, { limit: 200 })
        assert.deepEqual(positions(pages), big.map((_, k) => k))
        assert.ok(pages.length > 3)
        for (const page of pages.slice(0, -1)) {
            assert.equal(page.scan.stoppedBy, "responseBudget")
            assert.ok(page.groups.length < 200)
        }
        for (const page of pages) for (const g of page.groups) assert.equal(g.name, big[g.position]!.name, "never truncated")

        const huge = [
            { gid: 0, isMultiple: true, sids: [] },
            { gid: 1, isMultiple: true, sids: [], name: "H".repeat(30_000) },
            { gid: 2, isMultiple: true, sids: [] },
        ]
        const { h: h2 } = await setup({ sources: plain([0]), settings: groupsOf(huge) })
        const first = await groups(h2)
        assert.deepEqual(first.groups.map((g) => g.groupId), [0])
        assert.equal(first.scan.stoppedBy, "responseBudget")
        for (let k = 0; k < 2; k++) {
            const r = await h2.call("list_groups", { cursor: first.nextCursor })
            assert.equal(r.error?.code, "LIMIT_EXCEEDED")
            assert.equal(r.error?.reason, "record-too-large")
            assert.ok(r.length < 1000 && !r.text.includes("HHHH"))
        }
    })
})

describe("list_groups: privacy and read-only behaviour", () => {
    test("no secrets, URLs or serviceRef; ids-only primary-key SQL; profile unchanged, no journal files", async () => {
        const settings = {
            sourceGroups: [{ gid: 0, isMultiple: true, sids: [0, 1, 50], name: "Visible" }],
            sourceRules: { "group:0": [{ filter: 7, search: SECRET_SENTINEL, match: true, actions: ["r-true"] }] },
            serviceConfigs: { password: SECRET_SENTINEL, endpoint: `https://sync.invalid/${SECRET_SENTINEL}` },
            pac: `http://proxy.invalid/${SECRET_SENTINEL}`,
        }
        counter++
        const p = createSourcesProfile(path.join(root, `lg${counter}`), {
            sources: [
                { sid: 0, url: `https://user:pw@feed.invalid/${SECRET_SENTINEL}`, serviceRef: SECRET_SENTINEL },
                { sid: 1, iconurl: `https://icon.invalid/${SECRET_SENTINEL}` },
            ],
            settings,
            items: 20,
        })
        const initial = snapshotDir(p.dir)
        const h = await harness(p)
        open.push(h)
        const page = await groups(h)
        const first = await groups(h, { limit: 1 })
        assert.equal(first.hasMore, false)
        assert.deepEqual(findLeaks([page.outcome.text, JSON.stringify(page.outcome.result)], [SECRET_SENTINEL, "invalid", "http"]), [])
        const statements = [...new Set(h.sql)].filter((s) => !s.startsWith("PRAGMA"))
        assert.ok(statements.includes(GROUP_SQL.sidScan))
        for (const sql of statements) {
            assert.ok(!/\bitems\b/i.test(sql), sql)
            assert.ok(!/\b(count|sum|avg|group by|join|offset)\b/i.test(sql.replace(/json_each/g, "")), sql)
        }
        await h.close()
        open.splice(open.indexOf(h), 1)
        assert.deepEqual(snapshotDir(p.dir), initial, "same files, same hashes: no -wal, -shm or -journal")
    })
})
