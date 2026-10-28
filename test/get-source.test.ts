import assert from "node:assert/strict"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { DatabaseAccess, fileLock } from "../src/db/connection.js"
import { RECORD_BYTES_MAX, SOURCE_SQL } from "../src/domain/sources.js"
import { RESP_MAX } from "../src/tools/result.js"
import { getSourceOutput } from "../src/tools/schemas.js"
import { createTempRoot, findLeaks, removeTempRoot, SECRET_SENTINEL, snapshotDir, type ProfileFixture } from "./helpers/fixtures.js"
import {
    createSourcesProfile,
    harness,
    mutate,
    recordingRowLoads,
    type Harness,
    type HarnessOptions,
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

async function setup(options: SourcesProfileOptions, harnessOptions: HarnessOptions = {}): Promise<{ p: ProfileFixture; h: Harness }> {
    counter++
    const p = createSourcesProfile(path.join(root, `gs${counter}`), options)
    const h = await harness(p, harnessOptions)
    open.push(h)
    return { p, h }
}

const settings = {
    sourceGroups: [
        { gid: 4, isMultiple: true, sids: [1, 2], name: "Group four" },
        { gid: 5, isMultiple: false, sids: [3] },
    ],
    sourceRules: {
        all: [{ filter: 7, search: "x", match: true, actions: ["r-true"] }],
        "source:1": [
            { filter: 7, search: "a", match: true, actions: ["r-true"] },
            { filter: 7, search: "b", match: false, actions: ["h-true"] },
        ],
        "group:4": [{ filter: 15, search: "c", match: true, actions: ["s-true"] }],
        "source:0": [{ filter: 7, search: "z", match: true, actions: ["r-true"] }],
    },
}

describe("get_source", () => {
    test("1. an existing source: list fields, text direction, rule counts, no article aggregates", async () => {
        const { h } = await setup({
            sources: [{ sid: 0 }, { sid: 1, name: "One", openTarget: 1, textDir: 1, fetchFrequency: 60 }, { sid: 2 }, { sid: 3 }],
            settings,
        })
        const listed = (await h.call("list_sources")).payload.sources[1]
        const r = await h.call("get_source", { sourceId: 1 })
        assert.equal(r.isError, false, r.text)
        const source = r.payload.source
        for (const key of Object.keys(listed)) assert.deepEqual(source[key], listed[key], key)
        assert.equal(source.openTarget, "webpage")
        assert.equal(source.textDir, "rtl")
        assert.deepEqual(source.rules, { available: true, sourceRuleCount: 2, groupRuleCount: 1 })
        assert.deepEqual(source.articleStats, {
            available: false,
            reason: "not-computed-without-index",
            articleCount: null,
            unreadCount: null,
            starredCount: null,
            hiddenCount: null,
            oldestDate: null,
            newestDate: null,
        })
        assert.equal(source.fieldIssues, undefined)
        assert.deepEqual(JSON.parse(r.text), r.payload)
        // single-source entry: not a group
        const three = (await h.call("get_source", { sourceId: 3 })).payload.source
        assert.deepEqual([three.groupId, three.groupStatus, three.rules.groupRuleCount], [null, "ungrouped", null])
    })

    test("1b. first group with a negative gid: 'unavailable', no groupId, no group rule count, within the output schema", async () => {
        const { h } = await setup({
            sources: [{ sid: 1 }, { sid: 2 }, { sid: 3 }],
            settings: {
                sourceGroups: [
                    { gid: -1, isMultiple: true, sids: [1, 2], name: `private ${SECRET_SENTINEL}` },
                    { gid: 6, isMultiple: true, sids: [2, 3] },
                ],
                sourceRules: {
                    "source:1": [{ filter: 7, search: "a", match: true, actions: ["r-true"] }],
                    "group:-1": [{ filter: 7, search: SECRET_SENTINEL, match: true, actions: ["r-true"] }],
                    "group:6": [{ filter: 7, search: "b", match: true, actions: ["r-true"] }],
                },
            },
        })
        const expected: Record<number, [number | null, string, { available: boolean; sourceRuleCount: number; groupRuleCount: number | null }]> = {
            1: [null, "unavailable", { available: true, sourceRuleCount: 1, groupRuleCount: null }],
            2: [null, "unavailable", { available: true, sourceRuleCount: 0, groupRuleCount: null }],
            3: [6, "grouped", { available: true, sourceRuleCount: 0, groupRuleCount: 1 }],
        }
        for (const sourceId of [1, 2, 3]) {
            const r = await h.call("get_source", { sourceId })
            assert.equal(r.isError, false, r.text)
            const { source, meta } = getSourceOutput.parse(r.payload)
            assert.deepEqual([source.groupId, source.groupStatus, source.rules], expected[sourceId])
            assert.equal(meta.groupsAvailable, true)
            assert.deepEqual(findLeaks([r.text, JSON.stringify(r.result)], [SECRET_SENTINEL, "private", '"gid"', '"groupId":-']), [])
        }
    })

    test("2-3. absent source is NOT_FOUND; sid 0 is a valid id", async () => {
        const { h } = await setup({ sources: [{ sid: 0, name: "Zero" }, { sid: 7 }], settings })
        const zero = await h.call("get_source", { sourceId: 0 })
        assert.equal(zero.payload.source.sourceId, 0)
        assert.equal(zero.payload.source.name, "Zero")
        assert.equal(zero.payload.source.rules.sourceRuleCount, 1)
        for (const sourceId of [1, 6, 8, Number.MAX_SAFE_INTEGER]) {
            const r = await h.call("get_source", { sourceId })
            assert.equal(r.error?.code, "NOT_FOUND")
            assert.equal(r.error?.reason, "source-not-found")
        }
        for (const args of [{}, { sourceId: -1 }, { sourceId: 1.5 }, { sourceId: "1" }, { sourceId: 2 ** 53 }, { sourceId: 1, extra: true }]) {
            assert.equal((await h.call("get_source", args)).error?.code, "INVALID_ARGUMENT", JSON.stringify(args))
        }
    })

    test("4. sourceRef: matching, replaced source, other process, malformed", async () => {
        const { p, h } = await setup({ sources: [{ sid: 0 }, { sid: 1, url: "https://feed.invalid/one" }] })
        const ref = (await h.call("get_source", { sourceId: 1 })).payload.source.sourceRef as string
        assert.equal((await h.call("get_source", { sourceId: 1, sourceRef: ref })).isError, false)
        // a ref of another source
        assert.equal((await h.call("get_source", { sourceId: 0, sourceRef: ref })).error?.code, "SOURCE_IDENTITY_CHANGED")
        // the source replaced under the same sid
        mutate(p.dbPath, "UPDATE sources SET url = 'https://feed.invalid/other' WHERE sid = 1")
        const replaced = await h.call("get_source", { sourceId: 1, sourceRef: ref })
        assert.equal(replaced.error?.code, "SOURCE_IDENTITY_CHANGED")
        assert.ok(!replaced.text.includes("feed.invalid"))
        // issued by another server process
        const other = await harness(p)
        open.push(other)
        assert.equal((await other.call("get_source", { sourceId: 0, sourceRef: ref })).error?.code, "SOURCE_REF_EXPIRED")
        for (const bad of ["", "sr1.x.y", `${ref}x`, ref.replace("sr1", "sr2")]) {
            assert.equal((await h.call("get_source", { sourceId: 1, sourceRef: bad })).error?.code, "INVALID_ARGUMENT", bad)
        }
        // a deleted source is NOT_FOUND even with a ref
        mutate(p.dbPath, "DELETE FROM sources WHERE sid = 1")
        assert.equal((await h.call("get_source", { sourceId: 1, sourceRef: ref })).error?.code, "NOT_FOUND")
    })

    test("5-6. invalid dates, unexpected enums and storage classes become null with fieldIssues", async () => {
        const { h } = await setup({
            loose: true,
            sources: [
                { sid: 0, lastFetched: "yesterday", openTarget: 7, textDir: -1, hidden: 2, fetchFrequency: -5 },
                { sid: 1, lastFetched: 1.5, openTarget: 1.0, hidden: "1", fetchFrequency: 2n ** 63n - 1n },
                { sid: 2, lastFetched: 9e15, name: Buffer.from([0xde, 0xad]), url: Buffer.from("x"), serviceRef: Buffer.from("s") },
                { sid: 3, lastFetched: 2n ** 63n - 1n, name: null, url: null, serviceRef: "", textDir: 2 },
                { sid: 4, lastFetched: -1, openTarget: null, hidden: null, textDir: null, fetchFrequency: null },
            ],
        })
        const get = async (sourceId: number) => (await h.call("get_source", { sourceId })).payload.source
        const issues = (s: any): string[] => (s.fieldIssues ?? []).map((i: any) => `${i.field}:${i.issue}:${i.storageClass}`).sort()

        const s0 = await get(0)
        assert.deepEqual([s0.lastFetched, s0.openTarget, s0.textDir, s0.hidden, s0.fetchFrequencyMin], [null, null, null, null, null])
        assert.deepEqual(issues(s0), [
            "fetchFrequency:unexpectedValue:integer",
            "hidden:unexpectedValue:integer",
            "lastFetched:unexpectedType:text",
            "openTarget:unexpectedValue:integer",
            "textDir:unexpectedValue:integer",
        ])
        const s1 = await get(1)
        assert.equal(s1.openTarget, "webpage", "1.0 is stored as INTEGER by the column affinity")
        assert.equal(s1.hidden, true, "'1' is stored as INTEGER by the column affinity")
        assert.deepEqual(issues(s1), ["fetchFrequency:unexpectedValue:integer", "lastFetched:unexpectedType:real"])
        const s2 = await get(2)
        assert.deepEqual([s2.name, s2.sourceRef, s2.synced, s2.lastFetched], [null, null, true, null])
        assert.deepEqual(issues(s2), [
            "lastFetched:unexpectedValue:integer",
            "name:unexpectedType:blob",
            "serviceRef:unexpectedType:blob",
            "url:unexpectedType:blob",
        ])
        const s3 = await get(3)
        assert.deepEqual([s3.name, s3.sourceRef, s3.synced, s3.lastFetched, s3.textDir], [null, null, false, null, "vertical"])
        assert.deepEqual(issues(s3), ["lastFetched:unexpectedValue:integer", "name:unexpectedNull:null", "url:unexpectedNull:null"])
        const s4 = await get(4)
        assert.equal(s4.lastFetched, "1969-12-31T23:59:59.999Z")
        assert.deepEqual(issues(s4), [
            "fetchFrequency:unexpectedNull:null",
            "hidden:unexpectedNull:null",
            "openTarget:unexpectedNull:null",
            "textDir:unexpectedNull:null",
        ])
        // the same validation applies to list_sources, and a ref can never be checked against a non-text URL
        const listed = (await h.call("list_sources")).payload.sources
        assert.deepEqual(issues(listed[2]), issues({ fieldIssues: s2.fieldIssues.filter((i: any) => i.field !== "textDir") }))
        assert.equal((await h.call("get_source", { sourceId: 2, sourceRef: "sr1.AAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA" })).error?.code, "SOURCE_REF_EXPIRED")
    })

    test("7-8. one primary-key lookup on sources; items is never read or counted", async () => {
        const { h } = await setup({ sources: [{ sid: 0 }, { sid: 1 }], items: 200, settings })
        h.sql.length = 0
        await h.call("get_source", { sourceId: 1 })
        await h.call("get_source", { sourceId: 9 })
        const statements = h.sql.filter((s) => !s.startsWith("PRAGMA"))
        assert.deepEqual([...new Set(statements)].sort(), [SOURCE_SQL.candidate, SOURCE_SQL.rows].sort())
        for (const sql of h.sql) assert.ok(!/\bitems\b|count\(/i.test(sql), sql)
    })

    test("9. no URL, icon, serviceRef or settings secret in the output", async () => {
        const { h } = await setup({
            sources: [{ sid: 0, url: `https://${SECRET_SENTINEL}.invalid/?token=${SECRET_SENTINEL}`, iconurl: `https://icon.invalid/${SECRET_SENTINEL}`, serviceRef: SECRET_SENTINEL }],
            settings: { ...settings, serviceConfigs: { token: SECRET_SENTINEL } },
        })
        const r = await h.call("get_source", { sourceId: 0 })
        assert.equal(r.isError, false)
        assert.deepEqual(findLeaks([r.text, JSON.stringify(r.result)], [SECRET_SENTINEL, "invalid", "http"]), [])
    })

    test("10. the response limit is enforced: a source too large to return is LIMIT_EXCEEDED", async () => {
        const { h } = await setup({
            sources: [
                { sid: 0, name: "W".repeat(20_000) },
                { sid: 1, name: "\u0001".repeat(4_000) }, // 6 + 7 escaped units per character in the two copies
                { sid: 2, name: "W".repeat(30_000) },
                { sid: 3, iconurl: "I".repeat(RECORD_BYTES_MAX + 1) }, // not loaded at all
            ],
        })
        const over = await h.call("get_source", { sourceId: 3 })
        assert.equal(over.error?.code, "LIMIT_EXCEEDED")
        assert.equal(over.error?.reason, "record-too-large")
        const fits = await h.call("get_source", { sourceId: 0 })
        assert.equal(fits.isError, false)
        assert.ok(fits.length <= RESP_MAX && fits.length > 40_000, String(fits.length))
        assert.equal(fits.payload.source.name.length, 20_000, "never truncated")
        for (const sourceId of [1, 2]) {
            const r = await h.call("get_source", { sourceId })
            assert.equal(r.error?.code, "LIMIT_EXCEEDED")
            assert.ok(r.length < 1000)
        }
    })

    test("10b. an oversized BLOB in a declared-integer column is LIMIT_EXCEEDED without loading the row", async () => {
        const columns = ["openTarget", "lastFetched", "fetchFrequency", "textDir", "hidden"] as const
        counter++
        const p = createSourcesProfile(path.join(root, `gs${counter}`), {
            sources: [
                ...columns.map((column, i) => ({ sid: i, [column]: new Uint8Array(RECORD_BYTES_MAX + 1) })),
                { sid: 9, textDir: new Uint8Array(RECORD_BYTES_MAX - 1024) }, // just under the limit: read
            ],
        })
        const initial = snapshotDir(p.dir)
        const loads: number[][] = []
        const h = await harness(p, { database: recordingRowLoads(new DatabaseAccess(p.dbPath), loads) })
        open.push(h)
        for (const sourceId of columns.keys()) {
            for (let i = 0; i < 2; i++) {
                const r = await h.call("get_source", { sourceId })
                assert.equal(r.error?.code, "LIMIT_EXCEEDED")
                assert.equal(r.error?.reason, "record-too-large")
            }
        }
        assert.deepEqual(loads, [], "S2 never ran")
        const under = await h.call("get_source", { sourceId: 9 })
        assert.equal(under.isError, false, under.text)
        assert.deepEqual(under.payload.source.fieldIssues, [{ field: "textDir", issue: "unexpectedType", storageClass: "blob" }])
        assert.deepEqual(loads, [[9]])
        assert.deepEqual(snapshotDir(p.dir), initial)
    })
})
