import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, test } from "node:test"
import { DatabaseAccess, fileLock, openConnectionCount } from "../src/db/connection.js"
import { BATCH_BYTES_MAX, readCandidate, RECORD_BYTES_MAX, SOURCE_SQL } from "../src/domain/sources.js"
import { bindKernel32, ERROR_LOCK_VIOLATION, SqliteFileLock, type Win32FileApi } from "../src/db/win32-lock.js"
import { CursorRegistry, CURSOR_TTL_MS } from "../src/scan/cursors.js"
import { RESP_MAX, quoteCount } from "../src/tools/result.js"
import { candidateBudget } from "../src/tools/list-sources.js"
import { listSourcesOutput } from "../src/tools/schemas.js"
import { createTempRoot, findLeaks, removeTempRoot, SECRET_SENTINEL, snapshotDir, type ProfileFixture } from "./helpers/fixtures.js"
import {
    addSources,
    createSourcesProfile,
    harness,
    listAll,
    mutate,
    recordingRowLoads,
    sids,
    type Harness,
    type HarnessOptions,
    type SourceSpec,
    type ToolOutcome,
    type SourcesProfileOptions,
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
    return createSourcesProfile(path.join(root, `ls${counter}`), options)
}

async function setup(options: SourcesProfileOptions, harnessOptions: HarnessOptions = {}): Promise<{ p: ProfileFixture; h: Harness }> {
    const p = profile(options)
    const h = await harness(p, harnessOptions)
    open.push(h)
    return { p, h }
}

function range(from: number, to: number, step = 1): number[] {
    const out: number[] = []
    for (let i = from; i <= to; i += step) out.push(i)
    return out
}

const plain = (ids: readonly number[]): SourceSpec[] => ids.map((sid) => ({ sid }))

describe("list_sources: basic listing", () => {
    test("1. no sources: empty terminal page", async () => {
        const { h } = await setup({ sources: [] })
        const page = await h.call("list_sources")
        assert.equal(page.isError, false)
        assert.deepEqual(page.payload.sources, [])
        assert.equal(page.payload.hasMore, false)
        assert.equal(page.payload.nextCursor, null)
        assert.deepEqual(page.payload.scan, { examined: 0, filteredOut: 0, stoppedBy: "exhausted" })
        assert.equal(page.payload.meta.schemaVersion, "1")
        assert.equal(page.payload.meta.urlsRedacted, true)
        assert.deepEqual(JSON.parse(page.text), page.payload)
    })

    test("2. a single source with sid 0, every field validated", async () => {
        const { h } = await setup({
            sources: [{ sid: 0, name: "Zero", openTarget: 3, fetchFrequency: 15, hidden: 1, serviceRef: "remote-1" }],
        })
        const page = await h.call("list_sources")
        assert.equal(page.payload.sources.length, 1)
        const source = page.payload.sources[0]
        assert.deepEqual(Object.keys(source), [
            "sourceId",
            "sourceRef",
            "name",
            "hidden",
            "openTarget",
            "fetchFrequencyMin",
            "lastFetched",
            "synced",
            "groupId",
            "groupStatus",
        ])
        assert.equal(source.sourceId, 0)
        assert.match(source.sourceRef, /^sr1\./)
        assert.equal(source.name, "Zero")
        assert.equal(source.hidden, true)
        assert.equal(source.openTarget, "fullContent")
        assert.equal(source.fetchFrequencyMin, 15)
        assert.equal(source.lastFetched, "2026-10-01T12:00:00.000Z")
        assert.equal(source.synced, true)
        assert.equal(source.groupId, null)
        assert.equal(source.groupStatus, "ungrouped")
        assert.equal(page.payload.hasMore, false)
    })

    test("3. ascending sid order with gaps, whatever the insertion order", async () => {
        const { h } = await setup({ sources: plain([100, 5, 0, 17, 3, 9_007_199_254_740_991]) })
        const pages = await listAll(h, { limit: 2 })
        assert.deepEqual(sids(pages), [0, 3, 5, 17, 100, 9_007_199_254_740_991])
    })

    test("sids outside [0, 2^53−1] are ID_RANGE_UNSUPPORTED, never rounded or skipped", async () => {
        for (const odd of [-1, 2n ** 53n, 2n ** 63n - 1n]) {
            const { h } = await setup({ sources: [{ sid: 0 }, { sid: odd }] })
            const r = await h.call("list_sources")
            assert.equal(r.error?.code, "ID_RANGE_UNSUPPORTED", String(odd))
            assert.equal((await h.call("get_source", { sourceId: 0 })).isError, false)
        }
    })

    test("4. hidden sources included by default, excluded with includeHidden: false", async () => {
        const { h } = await setup({
            sources: [{ sid: 0 }, { sid: 1, hidden: 1 }, { sid: 2 }, { sid: 3, hidden: 1 }],
        })
        assert.deepEqual(sids([await h.call("list_sources")]), [0, 1, 2, 3])
        const visible = await h.call("list_sources", { includeHidden: false })
        assert.deepEqual(sids([visible]), [0, 2])
        assert.deepEqual(visible.payload.scan, { examined: 4, filteredOut: 2, stoppedBy: "exhausted" })
        assert.deepEqual(sids([await h.call("list_sources", { includeHidden: true })]), [0, 1, 2, 3])
    })

    test("5. query: literal, case-insensitive substring; no wildcard or SQL meaning", async () => {
        const names = ["100% Tech", "a_b", "abc", "O'Reilly", 'say "hi"', "back\\slash", "[x]*", "Café", "ÉCOLE", "CAFE"]
        const { h } = await setup({ sources: names.map((name, sid) => ({ sid, name })) })
        const find = async (query: string): Promise<string[]> => {
            const page = await h.call("list_sources", { query })
            assert.equal(page.isError, false, page.text)
            return page.payload.sources.map((s: { name: string }) => s.name)
        }
        assert.deepEqual(await find("%"), ["100% Tech"])
        assert.deepEqual(await find("_"), ["a_b"])
        assert.deepEqual(await find("ABC"), ["abc"])
        assert.deepEqual(await find("'"), ["O'Reilly"])
        assert.deepEqual(await find('"'), ['say "hi"'])
        assert.deepEqual(await find("\\"), ["back\\slash"])
        assert.deepEqual(await find("[x]*"), ["[x]*"])
        assert.deepEqual(await find("' OR 1=1 --"), [])
        assert.deepEqual(await find("cafe\u0301"), ["Café"], "NFC-normalized on both sides")
        assert.deepEqual(await find("école"), ["ÉCOLE"])
        assert.equal((await h.call("list_sources", { query: "" })).error?.code, "INVALID_ARGUMENT")
        assert.equal((await h.call("list_sources", { query: "x".repeat(101) })).error?.code, "INVALID_ARGUMENT")
    })
})

describe("list_sources: groups", () => {
    const settings = {
        sourceGroups: [
            { gid: 10, isMultiple: true, sids: [3, 1, 99, 1], name: "First" }, // 99 orphan, 1 duplicated
            { gid: 11, isMultiple: true, sids: [1, 5] }, // 1 already belongs to 10
            { gid: 12, isMultiple: false, sids: [6] }, // single entry, not a group
            { gid: 13, isMultiple: true, sids: [7] },
            { gid: 13, isMultiple: false, sids: [8] }, // gid 13 duplicated
            { gid: 14, isMultiple: true, sids: [] },
        ],
        sourceRules: {},
    }

    test("6. first isMultiple group wins; duplicates, orphans, single entries, ambiguous gids", async () => {
        const { h } = await setup({ sources: plain([1, 3, 5, 6, 7, 8, 9]), settings })
        const all = (await h.call("list_sources")).payload
        const groupOf = Object.fromEntries(all.sources.map((s: any) => [s.sourceId, [s.groupId, s.groupStatus]]))
        assert.deepEqual(groupOf, {
            1: [10, "grouped"],
            3: [10, "grouped"],
            5: [11, "grouped"],
            6: [null, "ungrouped"],
            7: [13, "ambiguous"],
            8: [null, "ungrouped"],
            9: [null, "ungrouped"],
        })
        assert.equal(all.meta.groupsAvailable, true)
        assert.equal(all.meta.groupsError, null)

        assert.deepEqual(sids([await h.call("list_sources", { groupId: 10 })]), [1, 3])
        assert.deepEqual(sids([await h.call("list_sources", { groupId: 11 })]), [5])
        const empty = await h.call("list_sources", { groupId: 14 })
        assert.deepEqual(empty.payload.sources, [])
        assert.equal(empty.payload.hasMore, false)
        assert.equal((await h.call("list_sources", { groupId: 12 })).error?.code, "NOT_FOUND")
        assert.equal((await h.call("list_sources", { groupId: 77 })).error?.code, "NOT_FOUND")
        assert.equal((await h.call("list_sources", { groupId: 13 })).error?.code, "GROUP_AMBIGUOUS")
        assert.equal((await h.call("list_sources", { groupId: -1 })).error?.code, "INVALID_ARGUMENT")
        // group filter combined with a query, paginated one by one
        assert.deepEqual(sids(await listAll(h, { groupId: 10, limit: 1 })), [1, 3])
    })

    test("6b. unavailable groups are reported, never presented as 'no group'", async () => {
        const { p, h } = await setup({
            sources: plain([1, 2]),
            settings: { sourceGroups: "broken", sourceRules: {}, serviceConfigs: { password: SECRET_SENTINEL } },
        })
        const page = await h.call("list_sources")
        assert.equal(page.isError, false)
        assert.equal(page.payload.meta.groupsAvailable, false)
        assert.equal(page.payload.meta.groupsError, "SETTINGS_INVALID")
        for (const s of page.payload.sources) assert.deepEqual([s.groupId, s.groupStatus], [null, "unavailable"])
        const filtered = await h.call("list_sources", { groupId: 0 })
        assert.equal(filtered.error?.code, "SETTINGS_INVALID")
        assert.ok(!filtered.text.includes(SECRET_SENTINEL) && !page.text.includes(SECRET_SENTINEL))

        fs.rmSync(p.configPath)
        const missing = await h.call("list_sources")
        assert.equal(missing.payload.meta.groupsError, "SETTINGS_UNAVAILABLE")
        assert.equal((await h.call("list_sources", { groupId: 0 })).error?.code, "SETTINGS_UNAVAILABLE")
    })

    test("6c. a group with a negative gid: 'unavailable', never a negative groupId, never 'ungrouped'", async () => {
        const negativeSettings = {
            sourceGroups: [
                { gid: -1, isMultiple: true, sids: [1, 2], name: `private ${SECRET_SENTINEL}` },
                { gid: 3, isMultiple: true, sids: [2, 3] }, // sid 2's first group is still gid -1
                { gid: -2, isMultiple: false, sids: [4] }, // single-source entry: not a group
            ],
            sourceRules: { "group:-1": [{ filter: 7, search: SECRET_SENTINEL, match: true, actions: ["r-true"] }] },
            serviceConfigs: { password: SECRET_SENTINEL },
        }
        const { h } = await setup({ sources: plain([1, 2, 3, 4, 5]), settings: negativeSettings })
        let stderr = ""
        const write = process.stderr.write.bind(process.stderr)
        process.stderr.write = ((chunk: string | Uint8Array) => {
            stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
            return true
        }) as typeof process.stderr.write
        let page: Awaited<ReturnType<Harness["call"]>>
        try {
            page = await h.call("list_sources")
        } finally {
            process.stderr.write = write
        }
        assert.equal(page.isError, false, page.text)
        const payload = listSourcesOutput.parse(page.payload)
        const groupOf = Object.fromEntries(payload.sources.map((s) => [s.sourceId, [s.groupId, s.groupStatus]]))
        assert.deepEqual(groupOf, {
            1: [null, "unavailable"],
            2: [null, "unavailable"],
            3: [3, "grouped"],
            4: [null, "ungrouped"],
            5: [null, "ungrouped"],
        })
        assert.equal(payload.meta.groupsAvailable, true)
        assert.equal(payload.meta.groupsError, null)
        // only the count is logged: no gid, sid, name or rule
        assert.match(stderr, /^fluent-reader-mcp \{"event":"settings_suspicious","reason":"negative-gid","groups":1\}$/m)

        // the group filter never selects the unrepresentable group
        assert.deepEqual(sids([await h.call("list_sources", { groupId: 3 })]), [3])
        for (const groupId of [-1, -2]) {
            const r = await h.call("list_sources", { groupId })
            assert.equal(r.error?.code, "INVALID_ARGUMENT")
        }
        assert.deepEqual(sids(await listAll(h, { limit: 1 })), [1, 2, 3, 4, 5])
        assert.deepEqual(findLeaks([page.text, JSON.stringify(page.result), stderr], [SECRET_SENTINEL, "private", '"gid"', '"groupId":-']), [])
    })

    test("a membership change between pages is CURSOR_STALE and kills the cursor", async () => {
        const { p, h } = await setup({
            sources: plain([1, 2, 3]),
            settings: { sourceGroups: [{ gid: 0, isMultiple: true, sids: [1, 2, 3] }], sourceRules: {} },
        })
        const first = await h.call("list_sources", { groupId: 0, limit: 1 })
        const cursor = first.payload.nextCursor
        assert.equal(typeof cursor, "string")
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceGroups: [{ gid: 0, isMultiple: true, sids: [1, 3] }] }))
        const stale = await h.call("list_sources", { cursor })
        assert.equal(stale.error?.code, "CURSOR_STALE")
        assert.equal(stale.error?.reason, "group-changed")
        assert.equal((await h.call("list_sources", { cursor })).error?.code, "CURSOR_EXPIRED")
        // An unrelated settings change (name, other group) keeps the listing valid.
        const again = await h.call("list_sources", { groupId: 0, limit: 1 })
        fs.writeFileSync(
            p.configPath,
            JSON.stringify({ sourceGroups: [{ gid: 0, isMultiple: true, sids: [1, 3], name: "renamed" }, { gid: 5, isMultiple: true, sids: [2] }] }),
        )
        assert.deepEqual(sids([await h.call("list_sources", { cursor: again.payload.nextCursor })]), [3])
    })
})

describe("list_sources: pagination", () => {
    test("7. every page size yields the whole ordered list exactly once", async () => {
        const ids = [0, 1, 2, 4, 8, 9, 10, 15, 16, 23, 42, 43, 44, 45, 100, 101, 250, 251, 999, 1000, 1001, 5000, 7777]
        const { h } = await setup({ sources: plain(ids) })
        for (const limit of [1, 2, 3, 5, 7, 22, 23, 24, 500]) {
            const pages = await listAll(h, { limit })
            assert.deepEqual(sids(pages), ids, `limit ${limit}`)
            for (const page of pages) assert.ok(page.payload.sources.length <= limit)
            assert.equal(pages.length, Math.max(1, Math.ceil(ids.length / limit)))
            assert.equal(pages.at(-1)?.payload.hasMore, false)
            assert.equal(pages.at(-1)?.payload.scan.stoppedBy, "exhausted")
            for (const page of pages.slice(0, -1)) assert.equal(page.payload.scan.stoppedBy, "pageFull")
        }
        assert.equal((await h.call("list_sources", { limit: 0 })).error?.code, "INVALID_ARGUMENT")
        assert.equal((await h.call("list_sources", { limit: 501 })).error?.code, "INVALID_ARGUMENT")
        assert.equal((await h.call("list_sources", { limit: 1.5 })).error?.code, "INVALID_ARGUMENT")
        assert.equal((await h.call("list_sources", { unknown: 1 })).error?.code, "INVALID_ARGUMENT")
    })

    test("empty intermediate pages: filters that match only far away (candidate budget)", async () => {
        const total = 1200
        const sources: SourceSpec[] = range(0, total - 1).map((sid) => ({ sid, name: sid === total - 1 ? "needle" : `hay ${sid}` }))
        const { p, h } = await setup({ sources })
        const pages = await listAll(h, { query: "needle", limit: 1 })
        const budget = candidateBudget(1)
        assert.equal(pages.length, Math.ceil(total / budget))
        for (const page of pages.slice(0, -1)) {
            assert.deepEqual(page.payload.sources, [])
            assert.equal(page.payload.hasMore, true)
            assert.equal(page.payload.scan.stoppedBy, "candidateBudget")
            assert.equal(page.payload.scan.examined, budget)
        }
        assert.deepEqual(sids(pages), [total - 1])
        // hidden-only tail: the last page is empty and terminal
        mutate(p.dbPath, "UPDATE sources SET hidden = 1 WHERE sid >= 1000")
        const visible = await listAll(h, { includeHidden: false, limit: 500 })
        assert.deepEqual(sids(visible), range(0, 999))
        assert.equal(visible.at(-1)?.payload.hasMore, false)
    })

    test("8. replaying a cursor returns the same page, even after the database changed", async () => {
        const { p, h } = await setup({ sources: plain(range(0, 9)) })
        const first = await h.call("list_sources", { limit: 3 })
        const cursor = first.payload.nextCursor
        const a = await h.call("list_sources", { cursor })
        mutate(p.dbPath, "DELETE FROM sources WHERE sid IN (3, 4)")
        const b = await h.call("list_sources", { cursor })
        assert.equal(b.text, a.text)
        assert.deepEqual(b.payload, a.payload)
        assert.deepEqual(sids([a]), [3, 4, 5])
        // the successor reflects the current data
        assert.deepEqual(sids(await listAllFrom(h, a.payload.nextCursor)), [6, 7, 8, 9])
        // the same cursor with the same explicit arguments is still a replay
        assert.equal((await h.call("list_sources", { cursor, limit: 3, includeHidden: true })).text, a.text)
        // concurrent calls with the same cursor publish one response
        const c = (await h.call("list_sources", { limit: 2 })).payload.nextCursor
        const [x, y] = await Promise.all([h.call("list_sources", { cursor: c }), h.call("list_sources", { cursor: c })])
        assert.equal(x.text, y.text)
    })

    test("9. invalid, expired and mismatched cursors", async () => {
        let t = Date.UTC(2026, 9, 28)
        const now = (): number => t
        const { h } = await setup({ sources: plain(range(0, 9)) }, { now })
        const cursor = (await h.call("list_sources", { limit: 2, query: "Source" })).payload.nextCursor as string
        const tampered = cursor.slice(0, 10) + (cursor[10] === "A" ? "B" : "A") + cursor.slice(11)
        assert.equal((await h.call("list_sources", { cursor: tampered })).error?.code, "CURSOR_INVALID")
        assert.equal((await h.call("list_sources", { cursor: "garbage" })).error?.code, "CURSOR_INVALID")
        assert.equal((await h.call("list_sources", { cursor: 42 })).error?.code, "INVALID_ARGUMENT")
        const foreign = await harness(profile({ sources: plain([0, 1, 2]) }))
        open.push(foreign)
        const foreignCursor = (await foreign.call("list_sources", { limit: 1 })).payload.nextCursor
        assert.equal((await h.call("list_sources", { cursor: foreignCursor })).error?.code, "CURSOR_INVALID")

        for (const changed of [{ query: "Other" }, { includeHidden: false }, { limit: 3 }, { groupId: 0 }]) {
            const r = await h.call("list_sources", { cursor, ...changed })
            assert.equal(r.error?.code, "CURSOR_MISMATCH", JSON.stringify(changed))
        }
        const ok = await h.call("list_sources", { cursor, query: "Source", limit: 2 })
        assert.equal(ok.isError, false)

        t += CURSOR_TTL_MS + 1
        const expired = await h.call("list_sources", { cursor: ok.payload.nextCursor })
        assert.equal(expired.error?.code, "CURSOR_EXPIRED")
        assert.ok(!expired.text.includes(cursor))
    })

    test("at most 64 cursors are kept: the oldest listing expires", async () => {
        const { h } = await setup({ sources: plain(range(0, 3)) }, { cursors: new CursorRegistry() })
        const firstCursor = (await h.call("list_sources", { limit: 1 })).payload.nextCursor
        for (let i = 0; i < 64; i++) await h.call("list_sources", { limit: 1 })
        assert.equal(h.context.cursors.size, 64)
        assert.equal((await h.call("list_sources", { cursor: firstCursor })).error?.code, "CURSOR_EXPIRED")
    })

    test("10. deletions between pages: no skip, no duplicate, empty terminal page", async () => {
        const { p, h } = await setup({ sources: plain([1, 2, 3, 4, 5]) })
        const first = await h.call("list_sources", { limit: 2 })
        assert.deepEqual(sids([first]), [1, 2])
        mutate(p.dbPath, "DELETE FROM sources WHERE sid = 3")
        const rest = await listAllFrom(h, first.payload.nextCursor)
        assert.deepEqual(sids(rest), [4, 5])

        // the anchor itself deleted
        const p2 = await setup({ sources: plain([1, 2, 3, 4, 5]) })
        const f2 = await p2.h.call("list_sources", { limit: 2 })
        mutate(p2.p.dbPath, "DELETE FROM sources WHERE sid = 5")
        assert.deepEqual(sids(await listAllFrom(p2.h, f2.payload.nextCursor)), [3, 4])

        // everything after the checkpoint deleted: an empty, terminal page
        const p3 = await setup({ sources: plain([1, 2, 3, 4, 5]) })
        const f3 = await p3.h.call("list_sources", { limit: 2 })
        mutate(p3.p.dbPath, "DELETE FROM sources WHERE sid > 2")
        const last = await p3.h.call("list_sources", { cursor: f3.payload.nextCursor })
        assert.deepEqual(last.payload.sources, [])
        assert.equal(last.payload.hasMore, false)
        assert.equal(last.payload.nextCursor, null)
    })

    test("11. insertions: inside the anchored range visited, beyond the anchor excluded", async () => {
        const { p, h } = await setup({ sources: plain([0, 10, 20]) })
        const first = await h.call("list_sources", { limit: 1 })
        assert.deepEqual(sids([first]), [0])
        addSources(p.dbPath, plain([5, 30]))
        assert.deepEqual(sids(await listAllFrom(h, first.payload.nextCursor)), [5, 10, 20])
        // a new listing sees everything
        assert.deepEqual(sids(await listAll(h)), [0, 5, 10, 20, 30])
    })

    test("12. sid reuse: the same id with another feed gets another sourceRef", async () => {
        const { p, h } = await setup({ sources: [{ sid: 0 }, { sid: 1 }, { sid: 2, url: "https://feed.invalid/old.xml" }] })
        const before = (await h.call("list_sources")).payload.sources[2]
        mutate(p.dbPath, "DELETE FROM sources WHERE sid = 2")
        addSources(p.dbPath, [{ sid: 2, url: "https://feed.invalid/new.xml", name: before.name }])
        const after = (await h.call("list_sources")).payload.sources[2]
        assert.equal(after.sourceId, 2)
        assert.equal(after.name, before.name)
        assert.notEqual(after.sourceRef, before.sourceRef)
        const check = await h.call("get_source", { sourceId: 2, sourceRef: before.sourceRef })
        assert.equal(check.error?.code, "SOURCE_IDENTITY_CHANGED")
        // documented limit: the same feed re-added under the same sid is not detectable
        mutate(p.dbPath, "DELETE FROM sources WHERE sid = 2")
        addSources(p.dbPath, [{ sid: 2, url: "https://feed.invalid/new.xml", name: "re-added" }])
        assert.equal((await h.call("list_sources")).payload.sources[2].sourceRef, after.sourceRef)
    })

    test("a schema change between pages is CURSOR_STALE", async () => {
        const { p, h } = await setup({ sources: plain([1, 2, 3]) })
        const first = await h.call("list_sources", { limit: 1 })
        mutate(p.dbPath, "CREATE TABLE synthetic_extra (x INTEGER)")
        const r = await h.call("list_sources", { cursor: first.payload.nextCursor })
        assert.equal(r.error?.code, "CURSOR_STALE")
        assert.equal(r.error?.reason, "schema-changed")
    })
})

async function listAllFrom(h: Harness, cursor: string | null) {
    const pages = []
    while (cursor !== null) {
        const page = await h.call("list_sources", { cursor })
        assert.equal(page.isError, false, page.text)
        pages.push(page)
        cursor = page.payload.nextCursor
    }
    return pages
}

describe("list_sources: response and record limits", () => {
    test("13. a single source that cannot fit is a stable LIMIT_EXCEEDED, never truncated or skipped", async () => {
        const huge = "N".repeat(30_000) // 2 copies > RESP_MAX
        const { p, h } = await setup({ sources: [{ sid: 0 }, { sid: 1 }, { sid: 2, name: huge }, { sid: 3 }] })
        const first = await h.call("list_sources")
        assert.deepEqual(sids([first]), [0, 1])
        assert.equal(first.payload.scan.stoppedBy, "responseBudget")
        const cursor = first.payload.nextCursor
        for (let i = 0; i < 2; i++) {
            const r = await h.call("list_sources", { cursor })
            assert.equal(r.error?.code, "LIMIT_EXCEEDED")
            assert.equal(r.error?.reason, "record-too-large")
            assert.ok(r.length < 1000 && !r.text.includes("NNNN"))
        }
        // filters can step over it; once it is gone the same cursor continues
        assert.deepEqual(sids([await h.call("list_sources", { query: "Source 3" })]), [3])
        mutate(p.dbPath, "UPDATE sources SET name = 'short' WHERE sid = 2")
        assert.deepEqual(sids(await listAllFrom(h, cursor)), [2, 3])
    })

    test("13b. records over the byte budgets are not loaded", async () => {
        const icon = "data:image/png;base64," + "A".repeat(RECORD_BYTES_MAX)
        const { h } = await setup({ sources: [{ sid: 0 }, { sid: 1, iconurl: icon }, { sid: 2 }] })
        const first = await h.call("list_sources")
        assert.deepEqual(sids([first]), [0])
        assert.equal(first.payload.scan.stoppedBy, "byteBudget")
        const r = await h.call("list_sources", { cursor: first.payload.nextCursor })
        assert.equal(r.error?.code, "LIMIT_EXCEEDED")

        const big = "x".repeat(Math.floor(RECORD_BYTES_MAX * 0.9))
        const { h: h2 } = await setup({ sources: range(0, 9).map((sid) => ({ sid, iconurl: big })) })
        const pages = await listAll(h2, { limit: 500 })
        assert.deepEqual(sids(pages), range(0, 9))
        const perCall = Math.floor(BATCH_BYTES_MAX / (big.length + 100))
        for (const page of pages.slice(0, -1)) {
            assert.equal(page.payload.scan.stoppedBy, "byteBudget")
            assert.equal(page.payload.sources.length, perCall)
        }
    })

    test("13c. oversized TEXT/BLOB in declared-integer columns: measured by S1, never loaded by S2, never skipped", async () => {
        const blob = (size: number): Uint8Array => new Uint8Array(size).fill(0x5a)
        // sid → column holding a value over RECORD_BYTES_MAX (SQLite keeps BLOBs and non-numeric TEXT as stored)
        const oversized = new Map<number, string>([
            [1, "openTarget"],
            [3, "lastFetched"],
            [4, "fetchFrequency"],
            [5, "textDir"],
            [6, "hidden"],
            [8, "serviceRef"],
        ])
        const sources: SourceSpec[] = range(0, 9).map((sid) => {
            const column = oversized.get(sid)
            if (column === undefined) return { sid }
            return { sid, [column]: sid === 5 ? "t".repeat(RECORD_BYTES_MAX + 1) : blob(RECORD_BYTES_MAX + 1) }
        })
        const p = profile({ sources })
        const loads: number[][] = []
        const h = await harness(p, { database: recordingRowLoads(new DatabaseAccess(p.dbPath), loads) })
        open.push(h)
        const initial = snapshotDir(p.dir)

        // S1 sees every oversized record without loading it
        const bytes = await h.context.database.withReadConnection((db) => range(0, 9).map((sid) => readCandidate(db, sid)?.bytes))
        for (const [sid, size] of bytes.entries()) {
            assert.ok(Number.isSafeInteger(size))
            assert.equal((size as number) > RECORD_BYTES_MAX, oversized.has(sid), `sid ${sid}: ${size}`)
        }

        // get_source: LIMIT_EXCEEDED before any S2 load
        for (const sid of oversized.keys()) {
            const r = await h.call("get_source", { sourceId: sid })
            assert.equal(r.error?.code, "LIMIT_EXCEEDED")
            assert.equal(r.error?.reason, "record-too-large")
            assert.ok(r.length < 1000)
        }
        assert.deepEqual(loads, [])

        // list_sources stops before each one, fails stably on it, and the cursor does not move
        const listed: number[] = []
        let page: ToolOutcome = await h.call("list_sources", { limit: 500 })
        let cursor: string | null = null
        const loaded = (): number[] => loads.flat()
        for (;;) {
            assert.equal(page.isError, false, page.text)
            listed.push(...sids([page]))
            for (const sid of loaded()) assert.ok(!oversized.has(sid), `S2 loaded oversized sid ${sid}`)
            cursor = page.payload.nextCursor
            if (cursor === null) break
            const next: number = sids([page]).at(-1)! + 1
            if (!oversized.has(next)) {
                page = await h.call("list_sources", { cursor })
                continue
            }
            assert.equal(page.payload.scan.stoppedBy, "byteBudget")
            const loadsBefore: number = loads.length
            for (let i = 0; i < 2; i++) {
                const r = await h.call("list_sources", { cursor })
                assert.equal(r.error?.code, "LIMIT_EXCEEDED")
                assert.equal(r.error?.reason, "record-too-large")
            }
            assert.equal(loads.length, loadsBefore, "no S2 load for a failing call")
            if (next === 1) assert.deepEqual(snapshotDir(p.dir), initial, "reads leave the profile unchanged")
            // once the value is gone, the same cursor resumes exactly at that source
            mutate(p.dbPath, `UPDATE sources SET ${oversized.get(next)!} = 0 WHERE sid = ?`, next)
            oversized.delete(next)
            page = await h.call("list_sources", { cursor })
            assert.equal(sids([page])[0], next)
        }
        assert.deepEqual(listed, range(0, 9), "every source exactly once, none skipped")
        assert.equal(oversized.size, 0)
    })

    test("13d. the 4 MiB batch budget counts BLOBs in declared-integer columns", async () => {
        const size = Math.floor(RECORD_BYTES_MAX * 0.9)
        const columns = ["openTarget", "lastFetched", "fetchFrequency", "textDir", "hidden"] as const
        const p = profile({
            sources: range(0, 9).map((sid) => ({ sid, [columns[sid % columns.length]!]: new Uint8Array(size).fill(0x41) })),
        })
        const initial = snapshotDir(p.dir)
        const loads: number[][] = []
        const h = await harness(p, { database: recordingRowLoads(new DatabaseAccess(p.dbPath), loads) })
        open.push(h)
        const pages = await listAll(h, { limit: 500 })
        assert.deepEqual(sids(pages), range(0, 9))
        const perCall = Math.floor(BATCH_BYTES_MAX / (size + 200))
        assert.equal(perCall, 4)
        for (const page of pages.slice(0, -1)) {
            assert.equal(page.payload.scan.stoppedBy, "byteBudget")
            assert.equal(page.payload.sources.length, perCall)
        }
        for (const load of loads) assert.ok(load.length <= perCall, `S2 loaded ${load.length} records of ~${size} bytes`)
        for (const [i, s] of pages.flatMap((pg) => pg.payload.sources as { fieldIssues?: unknown[] }[]).entries()) {
            const field = columns[i % columns.length]
            // textDir is only read by get_source
            const expected = field === "textDir" ? undefined : [{ field, issue: "unexpectedType", storageClass: "blob" }]
            assert.deepEqual(s.fieldIssues, expected)
        }
        assert.deepEqual(snapshotDir(p.dir), initial)
    })

    test("13e. S1 estimate: every traversed column, NULLs as 0, numbers by text length, octet_length only", async () => {
        for (const column of ["url", "iconurl", "name", "openTarget", "lastFetched", "serviceRef", "fetchFrequency", "textDir", "hidden"]) {
            for (const sql of [SOURCE_SQL.candidate, SOURCE_SQL.candidates, SOURCE_SQL.memberCandidates]) {
                assert.ok(sql.includes(`coalesce(octet_length(${column}), 0)`), `${column} not measured`)
                assert.ok(!/(^|[^_])length\(/.test(sql), "length() is not a byte size")
            }
        }
        const p = profile({
            loose: true,
            sources: [
                {
                    sid: 0,
                    url: null,
                    iconurl: null,
                    name: null,
                    openTarget: 1.5, // REAL: text form "1.5"
                    lastFetched: "abcd", // TEXT in an integer column
                    serviceRef: null,
                    fetchFrequency: new Uint8Array(10), // BLOB
                    textDir: 12345,
                    hidden: null,
                },
            ],
        })
        const h = await harness(p)
        open.push(h)
        const candidate = await h.context.database.withReadConnection((db) => readCandidate(db, 0))
        assert.equal(candidate?.bytes, 32 + 3 + 4 + 10 + 5)
    })

    test("14. a page cut by the response budget, not by limit, and continued", async () => {
        const sources = range(0, 299).map((sid) => ({ sid, name: `${sid}:` + "n\"\\".repeat(60) + "é😀" }))
        const { h } = await setup({ sources })
        const pages = await listAll(h, { limit: 500 })
        assert.deepEqual(sids(pages), range(0, 299))
        assert.ok(pages.length > 2)
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i]!
            assert.ok(page.length <= RESP_MAX, `page ${i}: ${page.length}`)
            assert.ok(page.payload.sources.length < 500)
            if (i < pages.length - 1) {
                assert.equal(page.payload.scan.stoppedBy, "responseBudget")
                // tight: the next source would not have fitted (slack = reserved outcome fields)
                const next = JSON.stringify(pages[i + 1]!.payload.sources[0])
                assert.ok(page.length + 2 * next.length + quoteCount(next) + 2 > RESP_MAX - 64)
            }
        }
    })

    test("15. Unicode, emoji and control characters survive both copies unchanged", async () => {
        const names = ["中文 ελληνικά русский", "emoji 😀👍🏽🇮🇹", "ctl \u0000\u0001\u0007\u001f\u007f end", "sep \u2028\u2029", "tab\tnew\nline\r", '"quoted" \\ back']
        const { h } = await setup({ sources: names.map((name, sid) => ({ sid, name })) })
        const page = await h.call("list_sources")
        assert.deepEqual(
            page.payload.sources.map((s: { name: string }) => s.name),
            names,
        )
        assert.deepEqual(JSON.parse(page.text), page.payload)
        assert.ok(!/[\u0000-\u001f]/.test(page.text), "control characters are escaped in the text copy")
    })
})

describe("list_sources: privacy, errors, read-only behaviour", () => {
    test("16. no URL, icon URL, serviceRef or token reaches the output", async () => {
        const { p, h } = await setup({
            sources: [
                { sid: 0, url: `https://user:${SECRET_SENTINEL}@private.invalid/feed?token=${SECRET_SENTINEL}`, iconurl: `https://icons.invalid/${SECRET_SENTINEL}.png`, serviceRef: `svc-${SECRET_SENTINEL}` },
                { sid: 1, url: `https://feed.invalid/${SECRET_SENTINEL}/rss` },
            ],
            settings: { sourceGroups: [], serviceConfigs: { password: SECRET_SENTINEL, endpoint: "https://sync.invalid" }, pac: "http://proxy.invalid/x.pac" },
        })
        const outputs = [await h.call("list_sources"), await h.call("list_sources", { limit: 1 }), await h.call("get_source", { sourceId: 0 }), await h.call("get_source", { sourceId: 1 })]
        const texts = outputs.flatMap((o) => [o.text, JSON.stringify(o.result)])
        assert.deepEqual(findLeaks(texts, [SECRET_SENTINEL, "private.invalid", "icons.invalid", "feed.invalid", "sync.invalid", "proxy.invalid", "http", p.dir]), [])
        for (const o of outputs) assert.ok(!("url" in (o.payload.sources?.[0] ?? o.payload.source)))
    })

    test("17. SQLite and Win32 failures are sanitized MCP errors", async () => {
        // WAL switched on after startup
        const wal = await setup({ sources: plain([0]) })
        const writer = new DatabaseSync(wal.p.dbPath)
        writer.exec("PRAGMA journal_mode = WAL")
        let r = await wal.h.call("list_sources")
        assert.equal(r.error?.code, "DB_WAL_UNSUPPORTED")
        writer.close()
        r = await wal.h.call("get_source", { sourceId: 0 })
        assert.equal(r.error?.code, "DB_WAL_UNSUPPORTED")

        // database file replaced
        const replaced = await setup({ sources: plain([0]) })
        const copy = `${replaced.p.dbPath}.copy`
        fs.copyFileSync(replaced.p.dbPath, copy)
        fs.rmSync(replaced.p.dbPath)
        fs.renameSync(copy, replaced.p.dbPath)
        assert.equal((await replaced.h.call("list_sources")).error?.code, "DB_REPLACED")

        // lock unavailable (unsupported platform) and lock always busy
        const noLock = await setup({ sources: plain([0]) }, { access: { lock: new SqliteFileLock({ platform: "linux" }) } })
        assert.equal((await noLock.h.call("list_sources")).error?.code, "DB_PROTECTION_UNAVAILABLE")
        const busyLock = new SqliteFileLock({ api: busyApi })
        const busy = await setup({ sources: plain([0]) }, { access: { lock: busyLock } })
        const started = Date.now()
        const busyResult = await busy.h.call("list_sources")
        assert.equal(busyResult.error?.code, "DB_BUSY")
        assert.ok(Date.now() - started >= 900)

        // raw exceptions carrying paths and SQL
        const raw = await setup(
            { sources: plain([0]) },
            {
                database: {
                    withReadConnection: () =>
                        Promise.reject(Object.assign(new Error(`SELECT * FROM sources C:\\${SECRET_SENTINEL}`), { path: SECRET_SENTINEL })),
                },
            },
        )
        const internal = await raw.h.call("list_sources")
        assert.equal(internal.error?.code, "INTERNAL_ERROR")
        for (const outcome of [r, busyResult, internal]) {
            assert.deepEqual(findLeaks([outcome.text], [SECRET_SENTINEL, "SELECT", root, "\\fluent-reader.db"]), [])
            assert.deepEqual(Object.keys(outcome.error ?? {}).sort(), ["code", "hint", "message", "reason"])
        }
    })

    test("listing never changes the profile and leaves no connection or lock open", async () => {
        const { p, h } = await setup({ sources: plain(range(0, 50)), items: 20 })
        const initial = snapshotDir(p.dir)
        await listAll(h, { limit: 7 })
        await h.call("get_source", { sourceId: 3 })
        assert.deepEqual(snapshotDir(p.dir), initial)
        for (const suffix of ["-journal", "-wal", "-shm"]) assert.equal(fs.existsSync(p.dbPath + suffix), false)
        assert.equal(openConnectionCount(), 0)
        assert.equal(fileLock().heldCount, 0)
    })

    test("only primary-key statements on sources; no access to items (EXPLAIN QUERY PLAN)", async () => {
        const { p, h } = await setup({
            sources: plain(range(0, 30)),
            items: 50,
            settings: { sourceGroups: [{ gid: 1, isMultiple: true, sids: [3, 4, 5] }], sourceRules: {} },
        })
        await listAll(h, { limit: 4 })
        await listAll(h, { groupId: 1, limit: 1 })
        await h.call("list_sources", { query: "x", includeHidden: false })
        await h.call("get_source", { sourceId: 2 })
        const statements = [...new Set(h.sql)]
        assert.deepEqual(
            statements.filter((s) => !s.startsWith("PRAGMA")).sort(),
            [SOURCE_SQL.bounds, SOURCE_SQL.candidate, SOURCE_SQL.candidates, SOURCE_SQL.memberCandidates, SOURCE_SQL.rows].sort(),
        )
        const db = new DatabaseSync(p.dbPath, { readOnly: true })
        try {
            for (const sql of statements) {
                assert.ok(!/\bitems\b/i.test(sql), sql)
                assert.ok(!/\b(count|sum|avg|group by|join|offset)\b/i.test(sql.replace(/json_each/g, "")), sql)
                if (sql.startsWith("PRAGMA")) continue
                const args = sql === SOURCE_SQL.bounds ? [] : sql === SOURCE_SQL.candidate ? [1] : sql === SOURCE_SQL.rows ? ["[1]"] : sql === SOURCE_SQL.candidates ? [0, 9, 5] : [0, 9, "[1]", 5]
                const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => String(row.detail))
                const text = plan.join(" | ")
                assert.ok(!/SCAN sources|TEMP B-TREE|items/.test(text), `${sql}\n${text}`)
                assert.ok(/SEARCH sources/.test(text), text)
                if (sql !== SOURCE_SQL.bounds) assert.ok(/USING INTEGER PRIMARY KEY/.test(text), text)
            }
        } finally {
            db.close()
        }
    })
})

/** The real kernel32 binding, except that byte-range locks always conflict with a writer. */
function busyApi(): Win32FileApi {
    const real = bindKernel32()
    return {
        open: (filePath) => real.open(filePath),
        lock: () => ERROR_LOCK_VIOLATION,
        unlock: (handle, offset, length) => real.unlock(handle, offset, length),
        identity: (handle) => real.identity(handle),
        close: (handle) => real.close(handle),
    }
}
