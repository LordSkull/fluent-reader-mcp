/**
 * Conformance of src/domain/duplicates.ts and src/scan/duplicate-memory.ts
 * with the Fluent Reader contract fluent-reader/cross-source-duplicates v1,
 * on the versioned copy of its data in test/fixtures/cross-source-duplicates/v1
 * (no access to the Fluent Reader repository).
 */

import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import { describe, test } from "node:test"
import {
    codePointLength,
    CONTRACT_NAME,
    CONTRACT_VERSION,
    countWords,
    decodeEntities,
    GENERIC_PATHS,
    identityOf,
    INVISIBLE_CODE_POINTS,
    isSameArticle,
    MAX_DATE_DIFFERENCE_MS,
    MIN_SNIPPET_LENGTH,
    MIN_SNIPPET_WORDS,
    NAMED_ENTITIES,
    normalizeText,
    parseIsoDate,
    publisherOf,
    SYNTHETIC_GUID_PREFIX,
    timeOf,
    WHITESPACE_CODE_POINTS,
    type DuplicateCandidate,
} from "../src/domain/duplicates.js"
import { DuplicateMemory } from "../src/scan/duplicate-memory.js"

const DIR = new URL("../../test/fixtures/cross-source-duplicates/v1/", import.meta.url)
const CONFORMANCE_SHA256 = "59e553e615a26608f1698dac666486498da0c0013a88d4afb5f34faebbbba855"
const CONTRACT_SHA256 = "9999af95795d74184c721ac7acbf8bbfcac72331ba3c5e0c1264c96bd75bc35d"

interface Item extends DuplicateCandidate {
    readonly _id: number
    readonly source: number
}
interface Case {
    readonly name: string
    readonly items: readonly Item[]
    readonly groups: readonly (readonly number[])[]
    readonly pairs: readonly (readonly [number, number, boolean])[]
}
interface Conformance {
    readonly contract: string
    readonly version: number
    readonly constants: Record<string, unknown>
    readonly genericPaths: readonly string[]
    readonly whitespace: readonly string[]
    readonly invisible: readonly string[]
    readonly namedEntities: Readonly<Record<string, string>>
    readonly normalization: readonly (readonly [string, string])[]
    readonly publishers: readonly (readonly [unknown, string | null])[]
    readonly dates: readonly (readonly [unknown, number | null])[]
    readonly cases: readonly Case[]
}

const bytes = (name: string): Buffer => fs.readFileSync(new URL(name, DIR))
const sha256 = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex")
const data = JSON.parse(bytes("conformance.json").toString("utf8")) as Conformance
const codePoint = (u: string): number => {
    assert.match(u, /^U\+[0-9A-F]{4,6}$/)
    return parseInt(u.slice(2), 16)
}
const caseNamed = (prefix: string): Case => {
    const found = data.cases.find((c) => c.name.startsWith(prefix))
    assert.ok(found, prefix)
    return found
}

/**
 * Groups by the streaming first-fit of DuplicateMemory, articles taken in the
 * given order; members in that order, representative first. The identity key
 * itself serves as fingerprint, with limits that are never reached.
 */
function groupInOrder(items: readonly Item[], before: (a: Item, b: Item) => number): number[][] {
    const memory = new DuplicateMemory({ groupsMax: 1e6, membersMax: 1e7, keyGroupsMax: 1e6 })
    const groups = new Map<number, number[]>()
    for (const item of [...items].sort(before)) {
        const identity = identityOf(item)
        if (identity === null) continue
        const story = memory.find(identity.key, identity.time, item.source)
        if (story === undefined) {
            memory.open(item._id, identity.key, identity.time, item.source)
            groups.set(item._id, [item._id])
        } else {
            memory.join(story, identity.time, item.source)
            groups.get(story.representativeId)?.push(item._id)
        }
    }
    assert.equal(memory.forgotten, 0)
    return [...groups.values()].filter((g) => g.length > 1)
}

const feedOrder = (a: Item, b: Item): number => (timeOf(b.date) as number) - (timeOf(a.date) as number) || b._id - a._id
const storedOrder = (a: Item, b: Item): number => b._id - a._id
const sortGroups = (groups: readonly (readonly number[])[]): number[][] => groups.map((g) => [...g]).sort((a, b) => (a[0] as number) - (b[0] as number))

/**
 * Contract section 8, step 3, transcribed literally (no heap): within a key,
 * in feed order, the first remaining candidate is the representative and,
 * for every other source, the first remaining candidate of that source joins
 * if it is at most MAX_DATE_DIFFERENCE_MS older. Independent of DuplicateMemory.
 */
function contractGroups(items: readonly Item[]): number[][] {
    const buckets = new Map<string, { id: number; source: number; time: number }[]>()
    const seen = new Set<number>()
    for (const item of items) {
        if (seen.has(item._id)) continue
        seen.add(item._id)
        const identity = identityOf(item)
        if (identity === null) continue
        const bucket = buckets.get(identity.key) ?? []
        bucket.push({ id: item._id, source: item.source, time: identity.time })
        buckets.set(identity.key, bucket)
    }
    const groups: number[][] = []
    for (const bucket of buckets.values()) {
        const remaining = bucket.sort((a, b) => b.time - a.time || b.id - a.id)
        while (remaining.length > 0) {
            const rep = remaining.shift() as (typeof remaining)[number]
            const group = [rep]
            for (const source of [...new Set(remaining.map((c) => c.source))]) {
                if (source === rep.source) continue
                const first = remaining.find((c) => c.source === source) as (typeof remaining)[number]
                if (rep.time - first.time <= MAX_DATE_DIFFERENCE_MS) group.push(first)
            }
            for (const member of group.slice(1)) remaining.splice(remaining.indexOf(member), 1)
            if (group.length > 1) groups.push(group.sort((a, b) => b.time - a.time || b.id - a.id).map((c) => c.id))
        }
    }
    return groups
}

describe("duplicates contract v1: versioned fixtures", () => {
    test("the copies are byte-exact (SHA-256 of the committed files at Fluent Reader 7a23a93)", () => {
        assert.equal(sha256(bytes("conformance.json")), CONFORMANCE_SHA256)
        assert.equal(sha256(bytes("CONTRACT.md")), CONTRACT_SHA256)
        const provenance = bytes("PROVENANCE.md").toString("utf8")
        for (const expected of [CONFORMANCE_SHA256, CONTRACT_SHA256, "7a23a931fbcc974d15bf73fb52a93ee4ae889f08", "Version | 1"]) {
            assert.ok(provenance.includes(expected), expected)
        }
    })

    test("no source or test file depends on the Fluent Reader repository being on this machine", () => {
        const repo = new URL("../../", import.meta.url)
        const files: string[] = []
        const walk = (dir: URL): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir))
                else if (entry.name.endsWith(".ts")) files.push(fs.readFileSync(new URL(entry.name, dir), "utf8"))
            }
        }
        for (const top of ["src/", "test/", "installer/"]) walk(new URL(top, repo))
        assert.ok(files.length > 50)
        const outside = /(?:[A-Za-z]:[\\/]+fluent-reader(?![-\w])|\.\.[\\/]+fluent-reader(?![-\w])|contracts[\\/]+cross-source-duplicates)/
        assert.deepEqual(files.filter((f) => outside.test(f)).length, 0)
    })

    test("contract name, version and constants", () => {
        assert.deepEqual([data.contract, data.version], [CONTRACT_NAME, CONTRACT_VERSION])
        assert.deepEqual(data.constants, {
            MAX_DATE_DIFFERENCE_MS,
            MIN_SNIPPET_LENGTH,
            MIN_SNIPPET_WORDS,
            SYNTHETIC_GUID_PREFIX,
        })
        assert.deepEqual(data.genericPaths, GENERIC_PATHS)
    })
})

describe("duplicates contract v1: text normalization (section 3)", () => {
    test("the 94 named entities, exactly: each decoded, nothing else", () => {
        assert.equal(Object.keys(data.namedEntities).length, 94)
        assert.deepEqual(
            Object.fromEntries(Object.entries(NAMED_ENTITIES).map(([k, v]) => [k, `U+${(v.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`])),
            data.namedEntities,
        )
        for (const [name, u] of Object.entries(data.namedEntities)) {
            assert.equal(decodeEntities(`x&${name};y`), `x${String.fromCodePoint(codePoint(u))}y`, name)
            assert.equal(decodeEntities(`&${name}`), `&${name}`, "the semicolon is mandatory")
        }
        // Names are case-sensitive and the table is complete: anything else stays as written.
        for (const unknown of ["&AMP;", "&Amp;", "&euml2;", "&Yuml;", "&hearts;", "&nbsp ;", "&x;", `&a${"b".repeat(31)};`]) {
            assert.equal(decodeEntities(unknown), unknown, unknown)
        }
        assert.equal(Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, "constructor"), false)
        assert.equal(decodeEntities("&constructor;&toString;&__proto__;"), "&constructor;&toString;&__proto__;")
    })

    test("numeric references: one pass, 1-6 hex or 1-7 decimal digits, no 0, surrogate or value above U+10FFFF", () => {
        assert.equal(decodeEntities("&amp;lt; &amp;#38;"), "&lt; &#38;", "decoded text is not scanned again")
        assert.equal(decodeEntities("&#x10FFFF;&#1114111;"), "\u{10FFFF}\u{10FFFF}")
        for (const kept of ["&#0;", "&#x0;", "&#xD800;", "&#57343;", "&#x110000;", "&#1114112;", "&#x1234567;", "&#12345678;", "&#;", "&#x;"]) {
            assert.equal(decodeEntities(kept), kept, kept)
        }
        assert.equal(decodeEntities("&#X41;&#x61;&#0065;"), "AaA")
    })

    test("every normalization vector", () => {
        assert.ok(data.normalization.length >= 16)
        for (const [input, expected] of data.normalization) assert.equal(normalizeText(input), expected, JSON.stringify(input))
        for (const value of [null, undefined, 42, {}, ["x"], new Uint8Array([65])]) assert.equal(normalizeText(value), null)
    })

    test("white space and invisible characters are exactly the contract's lists", () => {
        assert.deepEqual(WHITESPACE_CODE_POINTS, data.whitespace.map(codePoint))
        assert.deepEqual(INVISIBLE_CODE_POINTS, data.invisible.map(codePoint))
        const invisible = new Set(INVISIBLE_CODE_POINTS)
        for (const c of WHITESPACE_CODE_POINTS) {
            const ch = String.fromCodePoint(c)
            // U+FEFF is in both lists: step 3 removes it before step 4 sees it.
            assert.equal(normalizeText(`a${ch}${ch}b${ch}`), invisible.has(c) ? "ab" : "a b", c.toString(16))
        }
        for (const c of INVISIBLE_CODE_POINTS) assert.equal(normalizeText(`a${String.fromCodePoint(c)}b`), "ab")
        // Not white space: U+0085, U+180E, U+200B (invisible, removed), U+2060.
        assert.equal(normalizeText("a\u0085b"), "a\u0085b")
        assert.equal(normalizeText("a᠎b"), "a᠎b")
        assert.equal(normalizeText("  a  "), "a")
        assert.equal(normalizeText("  x　"), "x")
    })

    test("NFKC, locale-independent lowercase, typographic punctuation kept", () => {
        assert.equal(normalizeText("ﬁ … Ｃａｆé"), "fi ... café")
        assert.equal(normalizeText("Café"), "café", "NFKC composes")
        assert.equal(normalizeText("İSTANBUL"), "i̇stanbul")
        assert.equal(normalizeText("ΣΟΦΟΣ"), "ΣΟΦΟΣ".toLowerCase())
        assert.notEqual(normalizeText("l’energia"), normalizeText("l'energia"))
        assert.equal(normalizeText("&laquo;Sì&raquo;"), "«sì»")
    })

    test("lengths count code points (an unpaired surrogate counts as one); words are runs of L and N", () => {
        assert.equal(codePointLength("a😀b"), 3)
        assert.equal(codePointLength("\ud800x\udc00"), 3)
        assert.equal(codePointLength("😀".repeat(70), 60), 60, "counting stops at the cap")
        assert.equal(countWords("l'energia, 2027: 12,5% — città"), 6)
        assert.equal(countWords("中文 ١٢٣ x_y"), 4)
        assert.equal(countWords(" ... "), 0)
        assert.equal(countWords("a b c d e f g h i j", 8), 8)
    })
})

describe("duplicates contract v1: publisher and dates (sections 4 and 5)", () => {
    test("every publisher vector", () => {
        assert.ok(data.publishers.length >= 25)
        for (const [link, expected] of data.publishers) assert.equal(publisherOf(link), expected, JSON.stringify(link))
    })

    test("WHATWG parsing details: IDNA, ports, query, fragment, trim set", () => {
        assert.equal(publisherOf("https://www.Bücher.example/x"), "xn--bcher-kva.example")
        assert.equal(publisherOf("http://ansa.it:80/x"), "ansa.it")
        assert.equal(publisherOf("http://ansa.it:8080/x"), "ansa.it:8080")
        assert.equal(publisherOf("https://ansa.it/?"), null, "an empty query is no query")
        assert.equal(publisherOf("https://ansa.it/?a"), "ansa.it")
        assert.equal(publisherOf("https://ansa.it/home.html#x"), null)
        assert.equal(publisherOf("https://192.168.0.1/x"), "192.168.0.1")
        for (const c of WHITESPACE_CODE_POINTS) {
            const ch = String.fromCodePoint(c)
            assert.equal(publisherOf(`${ch}https://www.ansa.it/x.html${ch}`), "ansa.it", c.toString(16))
        }
        assert.equal(publisherOf("\u0085https://www.ansa.it/x.html"), null, "U+0085 is not trimmed")
    })

    test("every date vector, and a Date object", () => {
        assert.ok(data.dates.length >= 29)
        for (const [value, expected] of data.dates) assert.equal(timeOf(value), expected, JSON.stringify(value))
        assert.equal(timeOf(new Date(1795176000000)), 1795176000000)
        assert.equal(timeOf(new Date(Number.NaN)), null)
        assert.equal(timeOf(8.64e15), 8.64e15)
        assert.equal(timeOf(-8.64e15 - 1), null)
        assert.equal(parseIsoDate("0000-01-01T00:00:00Z"), Date.UTC(2000, 0, 1) - 2000 * 365.2425 * 86_400_000)
        assert.equal(parseIsoDate("2026-11-20T12:00:00.12Z"), 1795176000120)
        assert.equal(parseIsoDate("2026-11-20T12:00:00+23:59"), 1795176000000 - (23 * 60 + 59) * 60_000)
    })
})

describe("duplicates contract v1: copies and groups (sections 6 to 8)", () => {
    test("the pairs of every case, in both argument orders", () => {
        let checked = 0
        for (const c of data.cases) {
            const byId = new Map(c.items.map((i) => [i._id, i]))
            for (const [a, b, expected] of c.pairs) {
                assert.equal(isSameArticle(byId.get(a) as Item, byId.get(b) as Item), expected, `${c.name}: ${a}-${b}`)
                assert.equal(isSameArticle(byId.get(b) as Item, byId.get(a) as Item), expected, `${c.name}: ${b}-${a}`)
                checked++
            }
        }
        assert.ok(checked >= 25 && data.cases.length === 12)
    })

    test("feed order (descending date, then id): the groups of every case, exactly", () => {
        for (const c of data.cases) {
            assert.deepEqual(sortGroups(groupInOrder(c.items, feedOrder)), sortGroups(c.groups), c.name)
            assert.deepEqual(sortGroups(contractGroups(c.items)), sortGroups(c.groups), `${c.name} (literal transcription)`)
        }
    })

    /**
     * Groups recomputed for the MCP's stored order (descending _id), as the
     * contract asks for another order. They differ from feed order in two
     * cases only, F and "Two copies": the pairs are the same.
     */
    const STORED_GROUPS: Readonly<Record<string, readonly (readonly number[])[]>> = {
        "A.": [[102, 101]],
        "B.": [[203, 202, 201]],
        "Same title": [],
        "Different publishers": [],
        "Dates:": [[502, 501]],
        "No transitive chain": [[603, 602]],
        "Two copies in the same source": [[703, 702]],
        "Missing, short": [],
        "Generic links": [],
        "Malformed fields": [],
        "Camera dei deputati": [],
        "Publisher host": [[1203, 1201]],
    }

    test("stored order (descending _id): recomputed groups, each one within the contract's constraints", () => {
        assert.equal(Object.keys(STORED_GROUPS).length, data.cases.length)
        for (const [prefix, expected] of Object.entries(STORED_GROUPS)) {
            const c = caseNamed(prefix)
            const groups = groupInOrder(c.items, storedOrder)
            assert.deepEqual(groups, expected, c.name)
            const byId = new Map(c.items.map((i) => [i._id, i]))
            for (const group of groups) {
                const members = group.map((id) => byId.get(id) as Item)
                assert.equal(new Set(members.map((m) => m.source)).size, members.length, "one article per source")
                const times = members.map((m) => timeOf(m.date) as number)
                assert.ok(Math.max(...times) - Math.min(...times) <= MAX_DATE_DIFFERENCE_MS, "within 10 minutes")
                assert.equal(group[0], Math.max(...group), "the representative comes first in stored order")
                for (const a of members) for (const b of members) if (a !== b) assert.ok(isSameArticle(a, b), "members are pairwise copies")
            }
        }
    })

    test("the five synthetic ANSA articles (cases A and B)", () => {
        const a = caseNamed("A.")
        const b = caseNamed("B.")
        assert.equal(a.items.length + b.items.length, 5)
        assert.ok([...a.items, ...b.items].every((i) => publisherOf(i.link) === "ansa.it" && identityOf(i) !== null))
        // A: entities (&#39;, &nbsp;), case and spacing differ; the normalized keys are equal.
        assert.equal(identityOf(a.items[0] as Item)?.key, identityOf(a.items[1] as Item)?.key)
        assert.deepEqual(groupInOrder([...a.items, ...b.items], storedOrder), [[203, 202, 201], [102, 101]])
        assert.deepEqual(sortGroups(groupInOrder([...a.items, ...b.items], feedOrder)), [[102, 101], [203, 202, 201]])
    })

    test("Camera dei deputati: synthetic GUIDs are never grouped, legacy points differ in text", () => {
        const c = caseNamed("Camera dei deputati")
        const [agenda1, agenda2, point1, point2] = c.items as [Item, Item, Item, Item]
        assert.ok(String(agenda1.guid).startsWith(SYNTHETIC_GUID_PREFIX))
        assert.equal(identityOf(agenda1), null)
        assert.equal(identityOf({ ...agenda1, guid: "other" })?.key, identityOf({ ...agenda2, guid: "other" })?.key, "without the GUID they would be copies")
        assert.equal(identityOf({ ...agenda1, guid: 42 }) !== null, true, "a GUID that is not a string is not synthetic")
        assert.notEqual(identityOf(point1)?.key ?? "1", identityOf(point2)?.key ?? "2")
        assert.deepEqual(groupInOrder(c.items, storedOrder), [])
    })

    test("eligibility: ids, sources and every field of the wrong type make an article ineligible, never an error", () => {
        const base = caseNamed("A.").items[0] as Item
        assert.notEqual(identityOf(base), null)
        for (const change of [
            { _id: 0 },
            { _id: -1 },
            { _id: 1.5 },
            { _id: "101" },
            { source: 1.5 },
            { source: "2" },
            { source: 2 ** 53 },
            { title: null },
            { title: "   " },
            { snippet: 42 },
            { snippet: base.title },
            { link: null },
            { date: null },
            { date: "2026-11-20 09:14:05Z" },
            { guid: `${SYNTHETIC_GUID_PREFIX}x` },
        ]) {
            assert.equal(identityOf({ ...base, ...change }), null, JSON.stringify(change))
        }
        assert.notEqual(identityOf({ ...base, source: -3 }), null, "any safe integer is a source")
        assert.equal(isSameArticle(base, { ...base }), false, "same id")
        assert.equal(isSameArticle(base, { ...base, _id: 999 }), false, "same source")
        assert.equal(isSameArticle(base, { ...base, _id: 999, source: 7 }), true)
    })

    test("property: in feed order the streaming first-fit equals the literal contract on random buckets", () => {
        let seed = 12345
        const random = (n: number): number => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31
            return seed % n
        }
        const texts = ["prima notizia di prova", "seconda notizia di prova"].map((t) => ({ title: t, snippet: `${t} con un testo abbastanza lungo da essere significativo per il confronto` }))
        for (let round = 0; round < 300; round++) {
            const items: Item[] = []
            const n = 1 + random(14)
            for (let k = 0; k < n; k++) {
                const text = texts[random(2)] as (typeof texts)[number]
                items.push({ _id: 1000 + random(40), source: random(4), date: 1_795_176_000_000 + random(5) * 240_000 + random(3), link: "https://www.ansa.it/x.html", ...text })
            }
            const unique = [...new Map(items.map((i) => [i._id, i])).values()]
            assert.deepEqual(sortGroups(groupInOrder(unique, feedOrder)), sortGroups(contractGroups(unique)), JSON.stringify(unique))
            // Stored order: valid groups, and prefix-stable (adding older ids never changes earlier groups).
            const stored = groupInOrder(unique, storedOrder)
            const cut = 1000 + random(40)
            const prefix = groupInOrder(unique.filter((i) => i._id >= cut), storedOrder)
            for (const g of prefix) {
                const full = stored.find((s) => s[0] === g[0])
                assert.ok(full !== undefined && g.every((id, j) => full[j] === id), "a group of the prefix is the beginning of a group of the whole")
            }
        }
    })
})
