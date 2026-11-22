/**
 * DuplicateMemory (scan/duplicate-memory.ts): streaming first-fit in stored
 * order, the contract's constraints on every group, bounded memory with
 * explicit, deterministic forgetting.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import { describe, test } from "node:test"
import {
    IDENTITY_DATE_TEXT_BYTES_MAX,
    IDENTITY_GUID_BYTES_MAX,
    IDENTITY_LINK_BYTES_MAX,
    IDENTITY_SNIPPET_BYTES_MAX,
    IDENTITY_TITLE_BYTES_MAX,
} from "../src/domain/article-scan.js"
import { identityOfFields, MAX_DATE_DIFFERENCE_MS } from "../src/domain/duplicates.js"
import { performance } from "node:perf_hooks"
import {
    groupingTransientBreakdown,
    groupingTransientEstimate,
    IDENTITY_KEY_UNITS_MAX,
    IDENTITY_RECORD_BYTES_MAX,
    memoryWeightMax,
} from "../src/tools/duplicate-grouping.js"
import { RESP_MAX } from "../src/tools/result.js"
import { DEFAULT_SCAN_LIMITS } from "../src/tools/list-articles.js"
import { DuplicateMemory, GROUP_WEIGHT, MEMBER_WEIGHT, type DuplicateMemoryLimits, type RememberedGroup } from "../src/scan/duplicate-memory.js"

const LARGE: DuplicateMemoryLimits = { groupsMax: 1000, membersMax: 10_000, keyGroupsMax: 1000 }
const T = 1_795_176_000_000
const MIN = 60_000

/** Places articles [id, fingerprint, minute offset, source] in the given order; returns representative → members. */
function place(memory: DuplicateMemory, articles: readonly (readonly [number, string, number, number])[]): Map<number, number[]> {
    const groups = new Map<number, number[]>()
    for (const [id, fp, minutes, source] of articles) {
        const time = T + minutes * MIN
        const story = memory.find(fp, time, source)
        if (story === undefined) {
            memory.open(id, fp, time, source)
            groups.set(id, [id])
        } else {
            memory.join(story, time, source)
            groups.get(story.representativeId)?.push(id)
        }
    }
    return groups
}

describe("DuplicateMemory: first-fit in stored order", () => {
    test("a copy joins within 10 minutes (inclusive) from earliest to latest, one article per source", () => {
        const m = new DuplicateMemory(LARGE)
        const groups = place(m, [
            [10, "k", 0, 1],
            [9, "k", 10, 2], // exactly 10 minutes: joins
            [8, "k", 5, 1], // source 1 already in the group: new story
            [7, "k", 5, 3], // joins the first group (span still 10 minutes)
            [6, "k", -1, 4], // span 11 minutes with the first group: joins the second (8) instead
        ])
        assert.deepEqual([...groups.values()], [[10, 9, 7], [8, 6]])
        const exact = new DuplicateMemory(LARGE)
        exact.open(1, "k", T, 1)
        assert.equal(exact.find("k", T + MAX_DATE_DIFFERENCE_MS, 2)?.representativeId, 1)
        assert.equal(exact.find("k", T + MAX_DATE_DIFFERENCE_MS + 1, 2), undefined)
        assert.equal(exact.find("other", T, 2), undefined, "only the same fingerprint")
    })

    test("dates not monotone in id: the window is the group's span, never the distance to the representative", () => {
        const m = new DuplicateMemory(LARGE)
        // 10 at T; 9 at T+9 joins; 8 at T-2 would make the span 11 minutes: a story of its own.
        assert.deepEqual([...place(m, [[10, "k", 0, 1], [9, "k", 9, 2], [8, "k", -2, 3]]).values()], [[10, 9], [8]])
    })

    test("several stories with the same key and different windows: each copy goes to the earliest story it fits", () => {
        const m = new DuplicateMemory(LARGE)
        const groups = place(m, [
            [10, "k", 0, 1],
            [9, "k", 20, 2],
            [8, "k", 1, 3],
            [7, "k", 21, 4],
            [6, "k", 10, 5], // fits the first (span 10) before the second (span 11)
        ])
        assert.deepEqual([...groups.values()], [[10, 8, 6], [9, 7]])
    })

    test("no transitive chain: A-B and B-C within 8 minutes, A-C 16 minutes", () => {
        const m = new DuplicateMemory(LARGE)
        assert.deepEqual([...place(m, [[3, "k", 0, 3], [2, "k", 8, 2], [1, "k", 16, 1]]).values()], [[3, 2], [1]])
    })

    test("fork: independent memories; a page never changes the cursor's memory, nor the cursor's memory the page's", () => {
        const m = new DuplicateMemory(LARGE)
        place(m, [[10, "k", 0, 1]])
        const copy = m.fork()
        const story = copy.find("k", T, 2)
        assert.ok(story !== undefined)
        copy.join(story, T + 9 * MIN, 2)
        copy.open(5, "j", T, 1)
        assert.deepEqual([m.size, m.members, copy.size, copy.members], [1, 1, 2, 3])
        assert.ok(m.find("k", T - 5 * MIN, 3) !== undefined, "the original still spans [T, T]")
        assert.equal(copy.find("k", T - 5 * MIN, 3), undefined, "the copy spans [T, T+9]")
        assert.ok(m.find("k", T, 2) !== undefined, "source 2 joined the copy only")
        assert.equal(m.find("j", T, 2), undefined, "a group opened by the copy only")
        // The original going on afterwards (a retried page) does not leak into the copy either.
        const again = m.find("k", T, 2)
        assert.ok(again !== undefined)
        m.join(again, T, 2)
        const third = m.find("k", T, 3)
        assert.ok(third !== undefined)
        m.join(third, T, 3)
        assert.deepEqual([m.members, copy.members], [3, 3])
        assert.ok(copy.find("k", T + 9 * MIN, 3) !== undefined, "source 3 joined the original only")
        assert.equal(copy.find("k", T, 2), undefined)
        assert.throws(() => m.join(again, T, 4), /not a remembered group/, "a version replaced by copy on write is no longer current")
        assert.throws(() => m.join(third, T, 3), /source already in the group/)
    })

    test("fork after fork, with failed attempts: every memory of a chain keeps exactly its own sources (indexed groups)", () => {
        const pages: DuplicateMemory[] = [new DuplicateMemory({ groupsMax: 10, membersMax: 100_000, keyGroupsMax: 10 })]
        pages[0]?.open(1, "k", T, 0)
        const expected: Set<number>[] = [new Set([0])]
        const lost = (page: number, k: number): number => 50_000 + page * 100 + k
        let source = 1
        for (let page = 1; page <= 40; page++) {
            const parent = pages[page - 1] as DuplicateMemory
            const failed = parent.fork() // an attempt that fails: its additions are thrown away
            for (let k = 0; k < 30; k++) failed.join(failed.find("k", T, lost(page, k)) as RememberedGroup, T, lost(page, k))
            const next = parent.fork()
            const mine = new Set(expected[page - 1])
            for (let k = 0; k < 25; k++, source++) {
                next.join(next.find("k", T, source) as RememberedGroup, T, source)
                mine.add(source)
            }
            pages.push(next)
            expected.push(mine)
        }
        for (const [i, memory] of pages.entries()) {
            const want = expected[i] as Set<number>
            assert.equal(memory.members, want.size)
            for (let s = 0; s < source + 10; s++) assert.equal(memory.find("k", T, s) === undefined, want.has(s), `page ${i}, source ${s}`)
            for (let page = 1; page <= 40; page++) assert.ok(memory.find("k", T, lost(page, 0)) !== undefined, "no failed attempt leaked")
        }
    })
})

describe("DuplicateMemory: cost", () => {
    test("one group of 100 000 sources: membership is not a linear scan (quadratic insertion: 5·10⁹ comparisons)", () => {
        const m = new DuplicateMemory({ groupsMax: 1, membersMax: 100_000, keyGroupsMax: 1 })
        m.open(1, "k", T, 0)
        const started = performance.now()
        for (let s = 1; s < 100_000; s++) {
            const story = m.find("k", T, s)
            assert.ok(story !== undefined)
            m.join(story, T, s)
        }
        const ms = performance.now() - started
        assert.equal(m.find("k", T, 99_999), undefined, "every source is found")
        assert.equal(m.members, 100_000)
        assert.ok(ms < 5_000, `${ms} ms`)
    })

    test("1 500 pages forked from a memory with a group of 50 000 sources, one copy each: forks copy no sources", () => {
        let m = new DuplicateMemory({ groupsMax: 2048, membersMax: 100_000, keyGroupsMax: 16 })
        m.open(1, "k", T, 0)
        for (let s = 1; s < 50_000; s++) m.join(m.find("k", T, s) as RememberedGroup, T, s)
        for (let g = 2; g <= 2048; g++) m.open(g, `g${g}`, T, 0)
        const chain = [m]
        const started = performance.now()
        for (let page = 0; page < 1500; page++) {
            m = m.fork()
            m.join(m.find("k", T, 50_000 + page) as RememberedGroup, T, 50_000 + page)
            chain.push(m)
        }
        const ms = performance.now() - started
        // Copying the sources at every fork would move 75 million entries.
        assert.ok(ms < 5_000, `${ms} ms`)
        assert.equal(m.members, 50_000 + 2047 + 1500)
        const page700 = chain[701] as DuplicateMemory
        assert.equal(page700.find("k", T, 50_000 + 700), undefined, "page 700 holds its own copy")
        assert.ok(page700.find("k", T, 50_000 + 701) !== undefined, "and not the next page's")
    })

    test("skewed keys through forks and failed attempts: the same groups as the reference first-fit in one pass", () => {
        let seed = 7
        const random = (n: number): number => {
            seed = (seed + 0x6d2b79f5) | 0
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
            return ((t ^ (t >>> 14)) >>> 0) % n
        }
        const articles: [number, string, number, number][] = []
        for (let id = 6000; id >= 1; id--) {
            const hot = random(10) < 7 // 70% of the articles on 3 keys, up to thousands of sources
            articles.push([id, hot ? `hot${random(3)}` : `k${random(400)}`, hot ? random(6) : random(25), hot ? random(3000) : random(40)])
        }
        const reference = new Map<number, number[]>()
        const open: { id: number; fp: string; min: number; max: number; sources: number[] }[] = []
        for (const [id, fp, minutes, source] of articles) {
            const time = T + minutes * MIN
            const g = open.find((x) => x.fp === fp && Math.max(x.max, time) - Math.min(x.min, time) <= MAX_DATE_DIFFERENCE_MS && !x.sources.includes(source))
            if (g === undefined) {
                open.push({ id, fp, min: time, max: time, sources: [source] })
                reference.set(id, [id])
            } else {
                g.min = Math.min(g.min, time)
                g.max = Math.max(g.max, time)
                g.sources.push(source)
                reference.get(g.id)?.push(id)
            }
        }
        const unbounded = { groupsMax: 100_000, membersMax: 100_000, keyGroupsMax: 100_000 }
        let m = new DuplicateMemory(unbounded)
        const got = new Map<number, number[]>()
        for (let at = 0; at < articles.length; at += 37) {
            const page = articles.slice(at, at + 37)
            place(m.fork(), page.map(([id, fp, minutes, source]) => [id + 1_000_000, fp, minutes, source + 7])) // thrown away
            m = m.fork()
            for (const [id, fp, minutes, source] of page) {
                const time = T + minutes * MIN
                const story = m.find(fp, time, source)
                if (story === undefined) {
                    m.open(id, fp, time, source)
                    got.set(id, [id])
                } else {
                    m.join(story, time, source)
                    got.get(story.representativeId)?.push(id)
                }
            }
        }
        assert.deepEqual(got, reference)
        const largest = Math.max(...[...got.values()].map((g) => g.length))
        assert.ok(largest > 500, `some groups hold hundreds of sources (${largest})`)
    })
})

describe("DuplicateMemory: bounded, explicit forgetting", () => {
    test("groupsMax: the oldest stories are forgotten first and counted; the newest is always kept", () => {
        const m = new DuplicateMemory({ groupsMax: 3, membersMax: 100, keyGroupsMax: 100 })
        for (let id = 10; id >= 5; id--) m.open(id, `k${id}`, T, 1)
        assert.deepEqual([m.size, m.forgotten, m.members], [3, 3, 3])
        assert.equal(m.find("k10", T, 2), undefined, "forgotten")
        assert.equal(m.find("k5", T, 2)?.representativeId, 5)
        assert.equal(m.fork().forgotten, 3, "the count follows the chain")
    })

    test("membersMax: a group growing past the budget forgets older groups, possibly itself, never another article", () => {
        const m = new DuplicateMemory({ groupsMax: 4, membersMax: 4, keyGroupsMax: 10 })
        m.open(10, "a", T, 1)
        m.open(9, "b", T, 1)
        let story = m.find("b", T, 2)
        assert.ok(story)
        m.join(story, T, 2)
        story = m.find("b", T, 3)
        assert.ok(story)
        m.join(story, T, 3) // 4 members
        assert.deepEqual([m.size, m.members, m.forgotten], [2, 4, 0])
        story = m.find("b", T, 4)
        assert.ok(story)
        m.join(story, T, 4) // 5 members: "a" (oldest) is forgotten
        assert.deepEqual([m.size, m.members, m.forgotten], [1, 4, 1])
        story = m.find("b", T, 5)
        assert.ok(story)
        m.join(story, T, 5) // the only group exceeds the budget alone: forgotten
        assert.deepEqual([m.size, m.members, m.forgotten], [0, 0, 2])
    })

    test("keyGroupsMax: a key republished many times by one source keeps its newest stories, work per article stays bounded", () => {
        const m = new DuplicateMemory({ groupsMax: 100_000, membersMax: 100_000, keyGroupsMax: 16 })
        for (let id = 20_000; id >= 1; id--) {
            const story = m.find("same", T, 1)
            assert.equal(story, undefined, "same source: never a copy")
            m.open(id, "same", T, 1)
        }
        assert.deepEqual([m.size, m.forgotten], [16, 20_000 - 16])
        assert.equal(m.find("same", T, 2)?.representativeId, 16, "the earliest remembered one")
    })

    test("weight of a full memory under the default limits, and the temporary estimate of a call (README figures)", () => {
        assert.equal(memoryWeightMax(DEFAULT_SCAN_LIMITS), 2048 * GROUP_WEIGHT + 8192 * MEMBER_WEIGHT)
        assert.equal(memoryWeightMax(DEFAULT_SCAN_LIMITS), 1_179_648) // about 1.2 MB
        const t = groupingTransientBreakdown(DEFAULT_SCAN_LIMITS)
        assert.deepEqual(t, {
            fork: 1_179_648,
            predecessor: 1_179_648,
            windowValues: 2 * 1024 * 1024,
            keyParts: 2 * IDENTITY_KEY_UNITS_MAX,
            key: 2 * IDENTITY_KEY_UNITS_MAX,
            hmacBuffer: 2 * IDENTITY_KEY_UNITS_MAX,
            page: 2 * RESP_MAX,
            result: 6 * RESP_MAX,
        })
        // Fork and predecessor, then the identity phase (larger than the construction of the result, which never overlaps it).
        assert.ok(t.windowValues + t.keyParts + t.key + t.hmacBuffer + t.page > t.result)
        assert.equal(groupingTransientEstimate(DEFAULT_SCAN_LIMITS), 2 * 1_179_648 + 2 * 1024 * 1024 + 3 * 2 * IDENTITY_KEY_UNITS_MAX + 2 * RESP_MAX)
        assert.equal(groupingTransientEstimate(DEFAULT_SCAN_LIMITS), 6_321_932) // about 6.0 MiB
        // A window smaller than one record still loads its first record whole.
        assert.equal(groupingTransientBreakdown({ ...DEFAULT_SCAN_LIMITS, identityWindowBytes: 1024 }).windowValues, 2 * IDENTITY_RECORD_BYTES_MAX)
    })

    test("the estimate does not raise any SQL budget or record limit", () => {
        assert.deepEqual(
            [DEFAULT_SCAN_LIMITS.identityWindowBytes, DEFAULT_SCAN_LIMITS.identityCallBytes, DEFAULT_SCAN_LIMITS.duplicateGroupsMax, DEFAULT_SCAN_LIMITS.duplicateMembersMax],
            [1024 * 1024, 8 * 1024 * 1024, 2048, 8192],
        )
        assert.deepEqual(
            [IDENTITY_TITLE_BYTES_MAX, IDENTITY_SNIPPET_BYTES_MAX, IDENTITY_LINK_BYTES_MAX, IDENTITY_GUID_BYTES_MAX, IDENTITY_DATE_TEXT_BYTES_MAX],
            [16 * 1024, 256 * 1024, 16 * 1024, 16 * 1024, 64],
        )
        assert.equal(IDENTITY_KEY_UNITS_MAX, 16 * 1024 + 256 * 1024 + 16 * 1024 + 2)
    })

    test("ASCII window near identityWindowBytes: values, key and its UTF-16LE HMAC buffer within their terms", () => {
        const t = groupingTransientBreakdown(DEFAULT_SCAN_LIMITS)
        const link = (bytes: number): string => `https://example.com/${"p".repeat(bytes - 20)}`
        const words = (bytes: number, word: string): string => `${word} `.repeat(Math.ceil(bytes / (word.length + 1))).slice(0, bytes - 1) + "x"
        // Records at the per-field limits, then a last one filling the window to its last byte (each byte one UTF-16 unit).
        const records: { title: string; snippet: string; link: string; date: string }[] = []
        let stored = 0
        const date = "2026-11-21T12:00:00.000+00:00"
        while (stored < DEFAULT_SCAN_LIMITS.identityWindowBytes) {
            const left = DEFAULT_SCAN_LIMITS.identityWindowBytes - stored
            const full = IDENTITY_TITLE_BYTES_MAX + IDENTITY_SNIPPET_BYTES_MAX + IDENTITY_LINK_BYTES_MAX + date.length
            const snippet = left >= full ? IDENTITY_SNIPPET_BYTES_MAX : left - IDENTITY_TITLE_BYTES_MAX - IDENTITY_LINK_BYTES_MAX - date.length
            const r = { title: words(IDENTITY_TITLE_BYTES_MAX, "Title"), snippet: words(snippet, "lorem"), link: link(IDENTITY_LINK_BYTES_MAX), date }
            records.push(r)
            stored += r.title.length + r.snippet.length + r.link.length + r.date.length
        }
        assert.equal(stored, DEFAULT_SCAN_LIMITS.identityWindowBytes)
        const units = records.reduce((n, r) => n + r.title.length + r.snippet.length + r.link.length + r.date.length, 0)
        assert.equal(Buffer.byteLength(records.map((r) => r.title + r.snippet + r.link + r.date).join(""), "utf8"), units, "ASCII: one unit per stored byte")
        assert.ok(2 * units <= t.windowValues, `${2 * units} > ${t.windowValues}`)
        let largest = 0
        for (const [i, r] of records.entries()) {
            const found = identityOfFields({ id: i + 1, source: 1, synthetic: false, time: 0, link: r.link, title: r.title, snippet: r.snippet })
            assert.ok(found !== null)
            const buffer = Buffer.from(found.key, "utf16le") // what the HMAC is computed over (startGrouping)
            assert.equal(buffer.length, 2 * found.key.length)
            assert.ok(buffer.length <= t.hmacBuffer && 2 * found.key.length <= t.key && 2 * found.key.length <= t.keyParts)
            largest = Math.max(largest, buffer.length)
        }
        // The largest key of the window is close to the per-record maximum, and its buffer is a term of its own in the estimate.
        assert.ok(largest > 0.9 * t.hmacBuffer, String(largest))
        assert.ok(groupingTransientEstimate(DEFAULT_SCAN_LIMITS) >= t.fork + t.predecessor + 2 * units + 3 * largest + t.page)
    })

    test("README: the figure of the temporary estimate is the one computed, declared indicative and not a guaranteed bound", () => {
        const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8")
        const bullet = readme.split(/\r?\n/).find((line) => line.startsWith("- **Allocazioni temporanee:**"))
        assert.ok(bullet !== undefined)
        const figure = /stima orientativa\*\* è di circa (\d+,\d) MiB/.exec(bullet)?.[1]
        assert.equal(figure, (groupingTransientEstimate(DEFAULT_SCAN_LIMITS) / 2 ** 20).toFixed(1).replace(".", ","))
        for (const term of ["UTF-16LE", "HMAC", "NFKC", "heap V8", "non un limite garantito", "294 914"]) assert.ok(bullet.includes(term), term)
        assert.ok(bullet.includes(`${IDENTITY_KEY_UNITS_MAX.toLocaleString("en").replace(",", " ")} unità`))
    })

    test("weight: estimated bytes of the groups and members held", () => {
        const m = new DuplicateMemory(LARGE)
        place(m, [[3, "k", 0, 1], [2, "k", 1, 2], [1, "j", 0, 1]])
        assert.equal(m.weight, 2 * GROUP_WEIGHT + 3 * MEMBER_WEIGHT)
    })

    test("invalid limits and misuse are refused", () => {
        assert.throws(() => new DuplicateMemory({ groupsMax: 0, membersMax: 1, keyGroupsMax: 1 }), RangeError)
        assert.throws(() => new DuplicateMemory({ groupsMax: 2, membersMax: 1, keyGroupsMax: 1 }), RangeError)
        const m = new DuplicateMemory(LARGE)
        m.open(1, "k", T, 1)
        assert.throws(() => m.open(1, "k", T, 2), /already remembered/)
    })
})
