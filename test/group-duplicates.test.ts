/**
 * groupDuplicates in list_articles and search_articles, on synthetic profiles
 * only (no real profile, no Fluent Reader repository).
 *
 * The central property: for any pageSize, window size and budget, a chain of
 * grouped pages returns every matching article exactly once, either as an
 * article (a position) or as a reported copy, and the groups it reconstructs
 * are exactly the one-pass stored-order grouping of the matching articles
 * (helpers/duplicates-oracle.ts), unless a memory limit was reached, which is
 * then reported (grouping.forgottenSoFar).
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { fileLock } from "../src/db/connection.js"
import { DUPLICATE_SQL, IDENTITY_SNIPPET_BYTES_MAX, SCAN_SQL, SEARCH_SQL } from "../src/domain/article-scan.js"
import { FIELD_BYTES_MAX } from "../src/domain/articles.js"
import { CursorRegistry, entryWeight, type CursorEntry } from "../src/scan/cursors.js"
import { DuplicateMemory, GROUP_WEIGHT, MEMBER_WEIGHT } from "../src/scan/duplicate-memory.js"
import { DEFAULT_SCAN_LIMITS, listArticles, type ScanLimits } from "../src/tools/list-articles.js"
import { RESP_MAX } from "../src/tools/result.js"
import {
    DUPLICATE_COPIES_PAGE_MAX,
    getArticleOutput,
    GROUPING_SEMANTICS,
    listArticlesOutput,
    searchArticlesOutput,
    type ListArticlesOutput,
    type SearchArticlesOutput,
} from "../src/tools/schemas.js"
import { searchArticles } from "../src/tools/search-articles.js"
import { oracle, reconstruct } from "./helpers/duplicates-oracle.js"
import { createTempRoot, findLeaks, removeTempRoot, snapshotDir, type ProfileFixture } from "./helpers/fixtures.js"
import { createSourcesProfile, harness, mutate, type Harness, type HarnessOptions, type ItemSpec, type SourceSpec, type SourcesProfileOptions } from "./helpers/sources.js"
import { collectGolden, createGoldenProfile, GOLDEN_CALLS, goldenHarness } from "./helpers/ungrouped-golden.js"

let root: string
let counter = 0
const open: { close(): Promise<void> }[] = []

before(() => {
    root = createTempRoot()
})
after(async () => {
    for (const h of open) await h.close()
    fileLock().close()
    removeTempRoot(root)
})

const SOURCES: readonly SourceSpec[] = [
    ...Array.from({ length: 6 }, (_, sid) => ({ sid, name: `Fonte ${sid}` })),
    { sid: 6, name: "Fonte nascosta", hidden: 1 },
]

async function setup(options: Partial<SourcesProfileOptions>, harnessOptions: HarnessOptions = {}): Promise<{ p: ProfileFixture; h: Harness }> {
    counter++
    const p = createSourcesProfile(path.join(root, `gd${counter}`), { sources: SOURCES, ...options })
    const h = await harness(p, harnessOptions)
    open.push(h)
    return { p, h }
}

const T = Date.UTC(2026, 10, 20, 8, 0, 0)
const snippetOf = (n: number): string =>
    `Il testo completo della notizia numero ${n} descrive con abbastanza parole un fatto accaduto oggi in regione.`

/** A copy of story `n`: same publisher, title and snippet; its own id, source, link, guid and date. */
function copy(n: number, id: number, source: number, minutes = 0, extra: Partial<ItemSpec> = {}): ItemSpec {
    return {
        _id: id,
        source,
        title: `Notizia ${n}`,
        snippet: snippetOf(n),
        link: `https://www.ansa.it/regione${source}/notizie/${n}_${id}.html`,
        guid: `guid-${id}`,
        date: T + n * 3_600_000 + minutes * 60_000,
        ...extra,
    }
}

/** An article that is a copy of nothing. */
function single(id: number, source = 0, extra: Partial<ItemSpec> = {}): ItemSpec {
    return { _id: id, source, title: `Articolo unico ${id}`, snippet: snippetOf(100_000 + id), link: `https://example.invalid/a/${id}`, guid: `guid-${id}`, date: T + id * 1000, ...extra }
}

type Tool = "list_articles" | "search_articles"
type Output = ListArticlesOutput | SearchArticlesOutput
const schemaOf = (tool: Tool) => (tool === "list_articles" ? listArticlesOutput : searchArticlesOutput)

/** One page: over MCP with the default limits, otherwise through the handler; validated by the registered schema and the size limit. */
async function call(h: Harness, tool: Tool, args: Record<string, unknown>, limits?: Partial<ScanLimits>): Promise<Output & { text: string }> {
    let result: CallToolResult
    let length: number
    if (limits === undefined) {
        const outcome = await h.call(tool, args)
        assert.equal(outcome.isError, false, outcome.text)
        result = outcome.result
        length = outcome.length
    } else {
        const run = tool === "list_articles" ? listArticles : searchArticles
        result = await run(h.context, args, { ...DEFAULT_SCAN_LIMITS, ...limits })
        assert.equal(result.isError, undefined, JSON.stringify(result.content))
        length = JSON.stringify(result).length
    }
    assert.ok(length <= RESP_MAX, String(length))
    const text = (result.content[0] as { text: string }).text
    assert.deepEqual(JSON.parse(text), result.structuredContent)
    const parsed = schemaOf(tool).parse(result.structuredContent) as Output
    assert.equal(parsed.hasMore, parsed.nextCursor !== null)
    assert.equal(parsed.scan.exhausted, parsed.nextCursor === null)
    assert.ok(parsed.articles.length <= parsed.pageSize)
    return { ...parsed, text }
}

async function errorOf(h: Harness, tool: Tool, args: Record<string, unknown>): Promise<{ code: string; reason?: string }> {
    const outcome = await h.call(tool, args)
    assert.equal(outcome.isError, true, outcome.text)
    return { code: outcome.error?.code ?? "", ...(outcome.error?.reason !== undefined && { reason: outcome.error.reason }) }
}

/** Follows the chain to the end; every non-final call consumes at least one row. */
async function chain(h: Harness, tool: Tool, args: Record<string, unknown>, limits?: Partial<ScanLimits>, between?: () => void): Promise<(Output & { text: string })[]> {
    const pages: (Output & { text: string })[] = []
    let cursor: string | null = null
    do {
        const next: Output & { text: string } = await call(h, tool, cursor === null ? args : { cursor }, limits)
        if (!next.scan.exhausted) assert.ok(next.scan.examined >= 1, "every call advances")
        pages.push(next)
        cursor = next.nextCursor
        if (cursor !== null) between?.()
        assert.ok(pages.length < 20_000, "chain did not terminate")
    } while (cursor !== null)
    return pages
}

const search = async (h: Harness, args: Record<string, unknown>) => (await call(h, "search_articles", args)) as SearchArticlesOutput & { text: string }
const listChain = (h: Harness, args: Record<string, unknown>, limits?: Partial<ScanLimits>) => chain(h, "list_articles", { groupDuplicates: true, ...args }, limits)

/** The grouping memory kept by a cursor not yet published. */
function memoryOf(entry: CursorEntry<unknown> | undefined): DuplicateMemory {
    const memory = (entry?.state as { grouping?: { memory: DuplicateMemory | null } } | undefined)?.grouping?.memory
    assert.ok(memory instanceof DuplicateMemory)
    return memory
}

const DEFAULT_MEMORY = {
    groupsMax: DEFAULT_SCAN_LIMITS.duplicateGroupsMax,
    membersMax: DEFAULT_SCAN_LIMITS.duplicateMembersMax,
    keyGroupsMax: DEFAULT_SCAN_LIMITS.duplicateKeyGroupsMax,
}

/**
 * The chain reconstructs exactly the oracle of the matching articles, under
 * the same memory limits; the last page reports what was forgotten, and is
 * complete only when nothing was (the datasets here have no notVerifiable).
 */
function assertOracle(pages: readonly Output[], matching: readonly ItemSpec[], memory = DEFAULT_MEMORY): void {
    const got = reconstruct(pages)
    const want = oracle(matching, memory)
    assert.deepEqual(got.positions, want.positions, "positions")
    assert.deepEqual([...got.groups], [...want.groups], "groups")
    assert.deepEqual([...got.seen].sort((a, b) => a - b), matching.map((m) => m._id as number).sort((a, b) => a - b), "every matching article exactly once")
    const last = pages.at(-1) as Output
    assert.equal(last.grouping?.forgottenSoFar, want.forgotten)
    assert.equal(last.grouping?.complete, want.forgotten === 0)
}

/** A deterministic mix of single articles and copies of a few stories, ids interleaved, some copies out of their window. */
function mixed(n: number, seed = 7): ItemSpec[] {
    let s = seed
    const random = (k: number): number => {
        s = (s * 1103515245 + 12345) % 2 ** 31
        return s % k
    }
    const items: ItemSpec[] = []
    for (let id = 1; id <= n; id++) {
        if (random(3) === 0) items.push(single(id, random(6)))
        else items.push(copy(random(Math.max(2, Math.floor(n / 12))), id, random(6), random(4) === 0 ? random(25) : random(3)))
    }
    return items
}

describe("groupDuplicates: compatibility of calls without it", () => {
    test("list_articles and search_articles without groupDuplicates, or with false, return exactly what 0.1.4 returned", async () => {
        const golden = JSON.parse(fs.readFileSync(new URL("../../test/fixtures/ungrouped-golden-0.1.4.json", import.meta.url), "utf8")) as {
            calls: { tool: string; args: unknown; pages: string[] }[]
        }
        assert.equal(golden.calls.length, GOLDEN_CALLS.length)
        counter++
        const p = createGoldenProfile(root, `golden${counter}`)
        const h = await goldenHarness(p)
        open.push(h)
        for (const [i, c] of GOLDEN_CALLS.entries()) {
            const recorded = golden.calls[i] as (typeof golden.calls)[number]
            assert.deepEqual([recorded.tool, recorded.args], [c.tool, c.args])
            assert.deepEqual(await collectGolden(h, c), recorded.pages, `${c.tool} ${JSON.stringify(c.args)}`)
            assert.deepEqual(await collectGolden(h, c, { groupDuplicates: false }), recorded.pages, `${c.tool} ${JSON.stringify(c.args)} false`)
        }
        // The same profile does hold copies: grouping them changes the result.
        const grouped = await call(h, "list_articles", { groupDuplicates: true, pageSize: 100 })
        assert.ok((grouped.grouping?.copies ?? 0) > 0)
    })

    test("without groupDuplicates: no new field and no identity statement; with it: only audited statements", async () => {
        const { h } = await setup({ articles: [copy(1, 1, 0), copy(1, 2, 1), single(3)] })
        const before = h.sql.length
        for (const tool of ["list_articles", "search_articles"] as const) {
            for (const extra of [{}, { groupDuplicates: false }]) {
                const r = await call(h, tool, { ...(tool === "search_articles" && { query: "o" }), ...extra })
                assert.ok(!("earlierCopies" in r) && !("grouping" in r))
                assert.ok(r.articles.every((a) => !("duplicates" in a)))
            }
        }
        const duplicateSql = new Set<string>(Object.values(DUPLICATE_SQL))
        assert.ok(h.sql.slice(before).every((sql) => !duplicateSql.has(sql)), "no identity value is ever read without groupDuplicates")
        await call(h, "list_articles", { groupDuplicates: true })
        await call(h, "search_articles", { groupDuplicates: true, query: "notizia", fields: "text" })
        assert.ok(h.sql.includes(DUPLICATE_SQL.sizes) && h.sql.includes(DUPLICATE_SQL.values))
        const audited = new Set<string>([...Object.values(SCAN_SQL), ...Object.values(SEARCH_SQL).flatMap((s) => [s.candidates, s.evaluate]), ...duplicateSql])
        assert.deepEqual([...new Set(h.sql)].filter((sql) => !audited.has(sql)), [])
    })

    test("published schemas: groupDuplicates is an optional boolean of both tools, the new output fields are optional", async () => {
        const { h } = await setup({ articles: [] })
        const { tools } = await h.client.listTools()
        assert.equal(tools.length, 16)
        for (const name of ["list_articles", "search_articles"]) {
            const tool = tools.find((t) => t.name === name)
            const input = tool?.inputSchema as { properties: Record<string, { type?: string }>; required?: string[] }
            assert.equal(input.properties.groupDuplicates?.type, "boolean", name)
            assert.ok(!(input.required ?? []).includes("groupDuplicates"))
            const output = tool?.outputSchema as { required?: string[]; properties: Record<string, unknown> }
            for (const field of ["earlierCopies", "grouping"]) {
                assert.ok(field in output.properties && !(output.required ?? []).includes(field), `${name}.${field}`)
            }
            assert.match(tool?.description ?? "", /groupDuplicates/)
        }
        // The description names exactly the fields a copy returns (the copy schema), and where the other states are.
        const listed = tools.find((t) => t.name === "list_articles")
        const copyShape = (listed?.outputSchema as { properties: { earlierCopies: { items: { properties: Record<string, unknown> } } } }).properties.earlierCopies.items.properties
        assert.deepEqual(Object.keys(copyShape).sort(), ["articleId", "date", "read", "representativeId", "sourceId", "sourceName", "sourceNameTruncated"])
        const text = listed?.description ?? ""
        assert.match(text, /A copy entry returns only articleId, sourceId, sourceName \(sourceNameTruncated\), date and read \(plus matchedIn in search_articles\); pass its articleId to get_article for its title, starred and hidden states/)
        assert.doesNotMatch(text, /keeps its own articleId and states/)
        assert.equal((await errorOf(h, "list_articles", { groupDuplicates: "yes" })).code, "INVALID_ARGUMENT")
        assert.equal((await errorOf(h, "search_articles", { query: "x", groupDuplicates: 1 })).code, "INVALID_ARGUMENT")
    })

    test("get_article is unchanged and reads every copy of a group", async () => {
        const { h } = await setup({ articles: [copy(1, 1, 0), copy(1, 2, 1)] })
        const r = await call(h, "list_articles", { groupDuplicates: true })
        assert.deepEqual(r.articles.map((a) => [a.articleId, a.duplicates?.copies.map((c) => c.articleId)]), [[2, [1]]])
        for (const articleId of [1, 2]) {
            const article = await h.call("get_article", { articleId })
            assert.equal(article.isError, false)
            const parsed = getArticleOutput.parse(article.payload)
            assert.deepEqual(Object.keys(article.payload).sort(), Object.keys(parsed).sort())
            assert.ok(!("duplicates" in article.payload))
        }
    })
})

describe("groupDuplicates: the contract end to end (conformance cases in SQLite)", () => {
    interface Case {
        readonly name: string
        readonly items: readonly Record<string, unknown>[]
    }
    const conformance = JSON.parse(fs.readFileSync(new URL("../../test/fixtures/cross-source-duplicates/v1/conformance.json", import.meta.url), "utf8")) as {
        cases: Case[]
    }
    /** Stored as Fluent Reader stores them: integer milliseconds (a string that is not a contract date stays TEXT). */
    const stored = (item: Record<string, unknown>): ItemSpec => {
        const date = typeof item.date === "string" && /^\d{4}-/.test(item.date) ? Date.parse(item.date) : (item.date as ItemSpec["date"])
        return { _id: item._id, source: item.source, title: item.title, snippet: item.snippet, link: item.link, guid: item.guid ?? null, date } as ItemSpec
    }
    const STORED_GROUPS: Readonly<Record<string, readonly (readonly number[])[]>> = {
        "A.": [[102, 101]],
        "B.": [[203, 202, 201]],
        "Dates:": [[502, 501]],
        "No transitive chain": [[603, 602]],
        "Two copies in the same source": [[703, 702]],
        "Publisher host": [[1203, 1201]],
    }

    test("every case: the stored-order groups, identities as the contract decides", async () => {
        for (const c of conformance.cases) {
            const items = c.items.map(stored)
            const { h } = await setup({ looseItems: true, articles: items })
            const r = await call(h, "list_articles", { groupDuplicates: true, pageSize: 100, includeHiddenSources: true })
            const expected = Object.entries(STORED_GROUPS).find(([prefix]) => c.name.startsWith(prefix))?.[1] ?? []
            const groups = r.articles.filter((a) => (a.duplicates?.copies.length ?? 0) > 0).map((a) => [a.articleId, ...(a.duplicates?.copies.map((x) => x.articleId) ?? [])])
            assert.deepEqual(groups, expected, c.name)
            assert.deepEqual(r.earlierCopies, [])
            assert.equal(r.grouping?.complete, true)
            assertOracle([r], items)
        }
    })

    test("the five ANSA articles: exact grouped page", async () => {
        const items = [...(conformance.cases[0] as Case).items, ...(conformance.cases[1] as Case).items].map(stored)
        const { h } = await setup({ articles: items, sources: [1, 2, 3].map((sid) => ({ sid, name: `ANSA ${sid}` })) })
        const r = await call(h, "list_articles", { groupDuplicates: true, excerptChars: 0 })
        assert.deepEqual(
            r.articles.map((a) => ({ id: a.articleId, source: a.sourceId, identity: a.duplicates?.identity, copies: a.duplicates?.copies })),
            [
                {
                    id: 203,
                    source: 3,
                    identity: "verified",
                    copies: [
                        { articleId: 202, sourceId: 2, sourceName: "ANSA 2", date: "2026-11-20T17:02:16.000Z", read: false },
                        { articleId: 201, sourceId: 1, sourceName: "ANSA 1", date: "2026-11-20T17:02:10.000Z", read: false },
                    ],
                },
                { id: 102, source: 1, identity: "verified", copies: [{ articleId: 101, sourceId: 2, sourceName: "ANSA 2", date: "2026-11-20T09:14:05.000Z", read: false }] },
            ],
        )
        assert.deepEqual(r.grouping, {
            contract: "fluent-reader/cross-source-duplicates",
            contractVersion: 1,
            copies: 3,
            notVerifiable: 0,
            notVerifiableSoFar: 0,
            rememberedNews: 0,
            forgottenSoFar: 0,
            complete: true,
            semantics: GROUPING_SEMANTICS,
        })
        assert.deepEqual([r.scan.examined, r.scan.exhausted, r.pageSize, r.articles.length], [5, true, 20, 2])
    })

    test("Camera agendas, generic links and malformed values are ineligible, never errors", async () => {
        const cases = conformance.cases.filter((c) => /Camera|Generic|Malformed|Missing/.test(c.name))
        const items = cases.flatMap((c) => c.items.map(stored))
        const { h } = await setup({ looseItems: true, articles: items })
        const r = await call(h, "list_articles", { groupDuplicates: true, pageSize: 100, includeHiddenSources: true })
        assert.equal(r.articles.length, items.length)
        // The legacy Camera points (1103, 1104) are eligible, with different texts: verified, not copies.
        for (const a of r.articles) {
            assert.deepEqual(a.duplicates, { identity: a.articleId === 1103 || a.articleId === 1104 ? "verified" : "ineligible", copies: [] }, String(a.articleId))
        }
    })
})

describe("groupDuplicates: pagination and cursors", () => {
    test("copies in the same page and in later pages; pages of copies only; every pageSize; the oracle is reconstructed", async () => {
        const items = mixed(240)
        const { h } = await setup({ articles: items })
        for (const [pageSize, limits] of [
            [1, { windowRows: 1 }],
            [1, { windowRows: 5 }],
            [2, { windowRows: 3, callRows: 7 }],
            [7, { windowRows: 16 }],
            [20, undefined],
            [100, undefined],
        ] as const) {
            const pages = await listChain(h, { pageSize, excerptChars: 0 }, limits)
            assertOracle(pages, items)
            assert.equal(pages.reduce((n, p) => n + p.scan.examined, 0), items.length, "each row consumed once")
            assert.ok(pages.every((p) => p.grouping?.copies === p.articles.reduce((n, a) => n + (a.duplicates?.copies.length ?? 0), 0) + (p.earlierCopies?.length ?? 0)))
        }
    })

    test("pages holding only copies of earlier stories: empty articles, hasMore, progress on every call", async () => {
        // Five stories (ids 30..26), then five copies of each from the other sources (ids 25..1).
        const items = [...Array.from({ length: 5 }, (_, k) => copy(k, 30 - k, 0)), ...Array.from({ length: 25 }, (_, j) => copy(j % 5, 25 - j, 1 + Math.floor(j / 5)))]
        const { h } = await setup({ articles: items })
        const pages = await listChain(h, { pageSize: 5 }, { windowRows: 2, callRows: 3 })
        const copiesOnly = pages.filter((p) => p.articles.length === 0 && (p.earlierCopies?.length ?? 0) > 0)
        assert.ok(copiesOnly.length >= 5, String(copiesOnly.length))
        assert.ok(copiesOnly.every((p) => p.scan.examined >= 1 && (p.hasMore || p.scan.exhausted) && p.scan.stoppedBy !== "pageFull"))
        assertOracle(pages, items)
        assert.deepEqual([...reconstruct(pages).groups.values()].map((g) => g.length), [6, 6, 6, 6, 6])
    })

    test("a full page still takes the copies that follow in its window, and stops before the next new article", async () => {
        const items = [single(10), copy(1, 9, 0), copy(1, 8, 1), copy(1, 7, 2), single(6), copy(1, 5, 3)]
        const { h } = await setup({ articles: items })
        const first = await call(h, "list_articles", { groupDuplicates: true, pageSize: 2 })
        assert.deepEqual(first.articles.map((a) => [a.articleId, a.duplicates?.copies.map((c) => c.articleId)]), [[10, []], [9, [8, 7]]])
        assert.deepEqual([first.scan.examined, first.scan.stoppedBy, first.hasMore], [4, "pageFull", true])
        const second = await call(h, "list_articles", { cursor: first.nextCursor })
        assert.deepEqual(second.articles.map((a) => a.articleId), [6])
        assert.deepEqual(second.earlierCopies?.map((c) => [c.representativeId, c.articleId, c.sourceId]), [[9, 5, 3]])
        assert.deepEqual([second.scan.examined, second.scan.exhausted], [2, true])
    })

    test("repeating a cursor returns the same page; responses and memories are charged together, one memory per chain", async () => {
        const cursors = new CursorRegistry()
        const items = mixed(120, 3)
        const { h } = await setup({ articles: items }, { cursors })
        const first = await call(h, "list_articles", { groupDuplicates: true, pageSize: 5 })
        const successor = cursors.peek(first.nextCursor as string)
        assert.ok(successor !== undefined)
        assert.equal(successor.weight, entryWeight(successor.binding, memoryOf(successor).weight, undefined), "the successor is charged its memory")
        assert.deepEqual(cursors.audit(), { entries: 1, weight: successor.weight, stateWeight: memoryOf(successor).weight, responses: 0 })
        const second = await call(h, "list_articles", { cursor: first.nextCursor })
        const published = cursors.peek(first.nextCursor as string)
        assert.ok(published !== undefined)
        assert.equal(published.response?.length, JSON.stringify({ content: [{ type: "text", text: second.text }], structuredContent: JSON.parse(second.text) }).length)
        assert.equal(published.weight, entryWeight(published.binding, 0, published.response), "published: charged its response, its memory dropped")
        assert.equal((published.state as { grouping: { memory: unknown } }).grouping.memory, null)
        const audited = cursors.audit()
        assert.deepEqual([audited.entries, audited.responses], [2, 1])
        assert.equal(audited.stateWeight, memoryOf(cursors.peek(second.nextCursor as string)).weight, "only the newest cursor holds a memory")
        // Replay: the same text, and no weight added.
        for (let k = 0; k < 3; k++) assert.equal((await call(h, "list_articles", { cursor: first.nextCursor })).text, second.text)
        assert.deepEqual(cursors.audit(), audited)
        const rest = await chain(h, "list_articles", { cursor: second.nextCursor })
        assertOracle([first, second, ...rest], items)
        // The pages of the chain are still replayed, after their successors added copies, and charged their responses only.
        assert.equal((await call(h, "list_articles", { cursor: first.nextCursor })).text, second.text)
        const end = cursors.audit()
        assert.deepEqual([end.stateWeight, end.responses, end.entries], [0, 1 + rest.length, 1 + rest.length])
    })

    test("the mode is bound to the cursor; expired and stale cursors behave as before", async () => {
        let now = Date.UTC(2026, 10, 21, 10, 0, 0)
        const { p, h } = await setup({ articles: mixed(40).map((i) => ({ ...i, source: (i._id as number) % 3 })), settings: { sourceGroups: [{ gid: 0, isMultiple: true, sids: [0, 1, 2], name: "G" }], sourceRules: {} } }, { now: () => now })
        const grouped = await call(h, "list_articles", { groupDuplicates: true, pageSize: 2 })
        const plain = await call(h, "list_articles", { pageSize: 2 })
        assert.deepEqual(await errorOf(h, "list_articles", { cursor: grouped.nextCursor, groupDuplicates: false }), { code: "CURSOR_MISMATCH", reason: "filters-changed" })
        assert.deepEqual(await errorOf(h, "list_articles", { cursor: plain.nextCursor, groupDuplicates: true }), { code: "CURSOR_MISMATCH", reason: "filters-changed" })
        assert.ok((await call(h, "list_articles", { cursor: grouped.nextCursor, groupDuplicates: true })).grouping !== undefined)
        assert.ok((await call(h, "list_articles", { cursor: plain.nextCursor, groupDuplicates: false })).grouping === undefined)
        const searchCursor = (await call(h, "search_articles", { groupDuplicates: true, query: "notizia", pageSize: 1 })).nextCursor
        assert.equal((await errorOf(h, "list_articles", { cursor: searchCursor })).code, "CURSOR_MISMATCH")

        const g = await call(h, "list_articles", { groupDuplicates: true, groupId: 0, pageSize: 2 })
        const s = await call(h, "list_articles", { groupDuplicates: true, sourceIds: [1], pageSize: 1 }, { windowRows: 1 })
        assert.ok(s.nextCursor !== null)
        const schema = await call(h, "list_articles", { groupDuplicates: true, pageSize: 1 })
        fs.writeFileSync(p.configPath, JSON.stringify({ sourceGroups: [{ gid: 0, isMultiple: true, sids: [0, 1], name: "G" }], sourceRules: {} }))
        assert.deepEqual(await errorOf(h, "list_articles", { cursor: g.nextCursor }), { code: "CURSOR_STALE", reason: "group-changed" })
        mutate(p.dbPath, "UPDATE sources SET url = 'https://feed.invalid/other.xml' WHERE sid = 1")
        assert.deepEqual(await errorOf(h, "list_articles", { cursor: s.nextCursor }), { code: "CURSOR_STALE", reason: "sources-changed" })
        mutate(p.dbPath, "CREATE TABLE extra (x INTEGER)")
        assert.deepEqual(await errorOf(h, "list_articles", { cursor: schema.nextCursor }), { code: "CURSOR_STALE", reason: "schema-changed" })
        const late = await call(h, "list_articles", { groupDuplicates: true, pageSize: 1 })
        now += 31 * 60 * 1000
        assert.equal((await errorOf(h, "list_articles", { cursor: late.nextCursor })).code, "CURSOR_EXPIRED")
    })

    test("a failed call (DB_BUSY) leaves the cursor's memory and weight intact: the retry returns the right page", async () => {
        const items = [copy(1, 6, 0), single(5), copy(1, 4, 1), copy(1, 3, 2), single(2), single(1)]
        const { p, h } = await setup({ articles: items })
        const first = await call(h, "list_articles", { groupDuplicates: true, pageSize: 1 }, { windowRows: 1 })
        const before = h.context.cursors.audit()
        const kept = memoryOf(h.context.cursors.peek(first.nextCursor as string))
        const { DatabaseSync } = await import("node:sqlite")
        const writer = new DatabaseSync(p.dbPath)
        try {
            writer.exec("BEGIN EXCLUSIVE")
            await assert.rejects(listArticles(h.context, { cursor: first.nextCursor }, { ...DEFAULT_SCAN_LIMITS, windowRows: 1 }), (e: { code?: string }) => e.code === "DB_BUSY")
        } finally {
            writer.exec("ROLLBACK")
            writer.close()
        }
        assert.deepEqual(h.context.cursors.audit(), before)
        assert.equal(memoryOf(h.context.cursors.peek(first.nextCursor as string)), kept)
        assert.deepEqual([kept.size, kept.members], [1, 1])
        const pages = [first, ...(await chain(h, "list_articles", { cursor: first.nextCursor }, { windowRows: 1 }))]
        assertOracle(pages, items)
    })

    test("deletions, insertions and state changes between pages: no article twice, nothing invented", async () => {
        const items = mixed(200, 11)
        const { p, h } = await setup({ articles: items })
        let n = 0
        const pages = await chain(h, "list_articles", { groupDuplicates: true, pageSize: 3, read: "unread" }, { windowRows: 8 }, () => {
            n++
            mutate(p.dbPath, "INSERT INTO items (source, title, link, date, fetchedDate, content, snippet) VALUES (1, 'Notizia 1', 'https://www.ansa.it/x/1.html', ?, 0, '', ?)", T + 3_600_000, snippetOf(1))
            mutate(p.dbPath, "DELETE FROM items WHERE _id = ?", 200 - 2 * n)
            mutate(p.dbPath, "UPDATE items SET hasRead = 1 WHERE _id = ?", 200 - 2 * n - 1)
        })
        const got = reconstruct(pages)
        assert.ok(got.seen.every((id) => id <= 200), "articles saved after the first page are excluded")
        assert.equal(new Set(got.seen).size, got.seen.length)
    })
})

describe("groupDuplicates: identity rules on stored data", () => {
    test("several copies from one source, non-monotone dates, several windows of one key", async () => {
        const items = [
            copy(1, 20, 0, 0),
            copy(1, 19, 0, 1), // same source: a story of its own
            copy(1, 18, 1, 9), // joins 20 (span 9)
            copy(1, 17, 2, -2), // span 11 with 20's group; joins 19's
            copy(2, 16, 0, 0),
            copy(2, 15, 1, 20), // 20 minutes later: a new story
            copy(2, 14, 2, 1), // joins 16
            copy(2, 13, 3, 21), // joins 15
        ]
        const { h } = await setup({ articles: items })
        const r = await call(h, "list_articles", { groupDuplicates: true, pageSize: 100 })
        assert.deepEqual(
            r.articles.map((a) => [a.articleId, a.duplicates?.copies.map((c) => c.articleId)]),
            [[20, [18]], [19, [17]], [16, [14]], [15, [13]]],
        )
        assertOracle([r], items)
    })

    test("never by title, link or guid alone", async () => {
        const items = [
            copy(1, 6, 0),
            copy(1, 5, 1, 0, { snippet: snippetOf(2) }), // same title, other text
            copy(1, 4, 2, 0, { link: "https://www.ilpost.it/x/4.html" }), // other publisher
            copy(3, 3, 3, 0, { title: "Notizia 1", link: "https://www.ansa.it/regione0/notizie/1_6.html", guid: "guid-6" }), // same link and guid as 6, other text
        ]
        const { h } = await setup({ articles: items })
        const r = await call(h, "list_articles", { groupDuplicates: true })
        assert.deepEqual(r.articles.map((a) => a.duplicates?.copies.length), [0, 0, 0, 0])
    })

    test("values over this server's limits are notVerifiable, wrong storage classes ineligible: never grouped, counted", async () => {
        const big = (n: number) => "x".repeat(n)
        const items: ItemSpec[] = [
            copy(1, 20, 0),
            copy(1, 19, 1, 0, { title: `Notizia 1${" ".repeat(FIELD_BYTES_MAX)}` }), // normalizes like the others, but over the limit
            copy(1, 18, 2, 0, { snippet: `${snippetOf(1)}${" ".repeat(IDENTITY_SNIPPET_BYTES_MAX)}` }),
            copy(1, 17, 3, 0, { link: `https://www.ansa.it/r/${big(FIELD_BYTES_MAX)}.html` }),
            copy(1, 16, 4, 0, { guid: big(FIELD_BYTES_MAX + 1) }),
            copy(1, 15, 5, 0, { snippet: new TextEncoder().encode(snippetOf(1)) }),
            copy(1, 14, 1, 0, { title: new TextEncoder().encode("Notizia 1") }),
            copy(1, 13, 2, 0, { link: null }),
            copy(1, 12, 3, 0, { date: "not a date" }),
            copy(1, 11, 4, 0, { date: new Date(T + 3_600_000).toISOString() }), // a contract date string: eligible, joins 20
            copy(1, 10, 5, 0, { date: T + 3_600_000 + 0.5 }), // REAL that is not an integer: ineligible
            copy(1, 9, 3, 0, { guid: "urn:fluent-reader:x" }),
            copy(1, 8, 5, 0, { source: 5.0, date: T + 3_600_000 }), // INTEGER 5 after affinity: joins
        ]
        const { h } = await setup({ looseItems: true, articles: items })
        const r = await call(h, "list_articles", { groupDuplicates: true, pageSize: 100, excerptChars: 0 })
        const status = new Map(r.articles.map((a) => [a.articleId, a.duplicates?.identity]))
        assert.deepEqual(r.articles.find((a) => a.articleId === 20)?.duplicates?.copies.map((c) => c.articleId), [11, 8])
        assert.deepEqual([19, 18, 17, 16].map((id) => status.get(id)), Array(4).fill("notVerifiable"))
        assert.deepEqual([15, 14, 13, 12, 10, 9].map((id) => status.get(id)), Array(6).fill("ineligible"))
        assert.deepEqual([r.grouping?.notVerifiable, r.grouping?.notVerifiableSoFar, r.grouping?.complete], [4, 4, false])
    })

    test("records over the record limit are skipped, never grouped", async () => {
        const { h } = await setup({ articles: [copy(1, 3, 0), copy(1, 2, 1, 0, { content: "c".repeat(16 * 1024 * 1024 + 1) }), copy(1, 1, 2)] })
        const r = await call(h, "list_articles", { groupDuplicates: true })
        assert.deepEqual(r.articles.map((a) => [a.articleId, a.duplicates?.copies.map((c) => c.articleId)]), [[3, [1]]])
        assert.equal(r.scan.oversizeSkipped, 1)
    })
})

describe("groupDuplicates: filters and search", () => {
    test("every filter applies before grouping: copies that do not pass are not reported", async () => {
        const items = [
            copy(1, 10, 0, 0, { hasRead: 1 }),
            copy(1, 9, 1, 0, { starred: 1 }),
            copy(1, 8, 2, 0, { hidden: 1 }),
            copy(1, 7, 6), // hidden source
            copy(1, 6, 3, 0, { date: T - 1 }), // outside the date range below, and not a copy (10 hours earlier)
            copy(1, 5, 4),
        ]
        const { h } = await setup({ articles: items, settings: { sourceGroups: [{ gid: 0, isMultiple: true, sids: [1, 4], name: "G" }], sourceRules: {} } })
        const ids = async (args: Record<string, unknown>) =>
            (await call(h, "list_articles", { groupDuplicates: true, ...args })).articles.map((a) => [a.articleId, a.duplicates?.copies.map((c) => c.articleId)])
        assert.deepEqual(await ids({}), [[10, [9, 5]], [6, []]])
        assert.deepEqual(await ids({ read: "unread" }), [[9, [5]], [6, []]])
        assert.deepEqual(await ids({ starred: "unstarred" }), [[10, [5]], [6, []]])
        assert.deepEqual(await ids({ hidden: "only" }), [[8, []]])
        assert.deepEqual(await ids({ hidden: "include" }), [[10, [9, 8, 5]], [6, []]])
        assert.deepEqual(await ids({ includeHiddenSources: true }), [[10, [9, 7, 5]], [6, []]])
        assert.deepEqual(await ids({ sourceIds: [2, 3, 4], hidden: "include" }), [[8, [5]], [6, []]])
        assert.deepEqual(await ids({ groupId: 0 }), [[9, [5]]])
        assert.deepEqual(await ids({ dateFrom: new Date(T).toISOString() }), [[10, [9, 5]]])
    })

    test("search: only matching articles are grouped, each copy with its own matchedIn; search counters unchanged", async () => {
        const items = [
            copy(1, 6, 0, 0, { title: "Mps &amp; Cda", creator: "Redazione" }),
            copy(1, 5, 1, 0, { title: "Mps & Cda" }), // same identity, but the query "amp" is not in its stored title
            copy(1, 4, 2, 0, { title: "MPS &amp; CDA" }),
            copy(1, 3, 3, 0, { title: "Mps &amp; Cda", creator: "Redazione" }),
            copy(2, 2, 0),
            copy(2, 1, 1),
        ]
        const { p, h } = await setup({ articles: items })
        const before = snapshotDir(p.dir)
        const r = await search(h, { groupDuplicates: true, query: "amp" })
        assert.deepEqual(r.articles.map((a) => [a.articleId, a.matchedIn, a.duplicates?.copies.map((c) => [c.articleId, (c as { matchedIn?: string }).matchedIn])]), [[6, "title", [[4, "title"], [3, "title"]]]])
        const text = await search(h, { groupDuplicates: true, query: "notizia numero 2", fields: "text" })
        assert.deepEqual(text.articles.map((a) => [a.articleId, a.matchedIn, a.duplicates?.copies.map((c) => c.articleId)]), [[2, "snippet", [1]]])
        const creator = await call(h, "search_articles", { groupDuplicates: true, query: "redazione", fields: "creator" })
        assert.deepEqual(creator.articles.map((a) => [a.articleId, a.duplicates?.copies.map((c) => c.articleId)]), [[6, [3]]])
        assert.deepEqual([r.search.exhaustive, r.grouping?.complete], [true, true])
        const pages = await chain(h, "search_articles", { groupDuplicates: true, query: "notizia", fields: "text", pageSize: 1 }, { windowRows: 1 })
        assertOracle(pages, items)
        assert.deepEqual(snapshotDir(p.dir), before, "searching never marks anything as read")
    })
})

describe("groupDuplicates: memory and response limits", () => {
    test("memory budget reached: oldest stories forgotten and counted, their later copies returned as articles, nothing lost", async () => {
        // 30 stories (ids 100..71); copies of the 8 newest ones (still remembered), then of the 22 older ones (forgotten).
        const items = [
            ...Array.from({ length: 30 }, (_, k) => copy(k, 100 - k, 0)),
            ...Array.from({ length: 8 }, (_, j) => copy(29 - j, 50 - j, 1)),
            ...Array.from({ length: 22 }, (_, j) => copy(j, 42 - j, 1)),
        ]
        const { h } = await setup({ articles: items })
        const pages = await listChain(h, { pageSize: 10 }, { duplicateGroupsMax: 8, duplicateMembersMax: 64 })
        const got = reconstruct(pages)
        assert.deepEqual([...got.seen].sort((a, b) => a - b), items.map((i) => i._id as number).sort((a, b) => a - b), "every article exactly once")
        const want = oracle(items, { groupsMax: 8, membersMax: 64, keyGroupsMax: 16 })
        assert.deepEqual([got.positions, [...got.groups]], [want.positions, [...want.groups]])
        const last = pages.at(-1) as Output
        assert.deepEqual([last.grouping?.forgottenSoFar, last.grouping?.complete], [want.forgotten, false])
        assert.ok(want.forgotten > 0 && got.groups.size === 8, "the 8 most recent stories still got their copies")
        assert.ok(pages.every((p) => (p.grouping?.rememberedNews ?? 0) <= 8))
    })

    test("global memory of all chains: least recently used cursors are evicted, grouped or not, within the capacity", async () => {
        const items = Array.from({ length: 60 }, (_, k) => single(60 - k))
        const probe = new CursorRegistry()
        const { h: probing } = await setup({ articles: items }, { cursors: probe })
        const sized = await call(probing, "list_articles", { groupDuplicates: true })
        const chainWeight = (probe.peek(sized.nextCursor as string) as CursorEntry<unknown>).weight
        assert.equal(chainWeight, entryWeight((probe.peek(sized.nextCursor as string) as CursorEntry<unknown>).binding, 20 * (GROUP_WEIGHT + MEMBER_WEIGHT), undefined))
        const cursors = new CursorRegistry({ weightCapacity: 3 * chainWeight })
        const { h } = await setup({ articles: items }, { cursors })
        const a = await call(h, "list_articles", { groupDuplicates: true })
        const b = await call(h, "list_articles", { groupDuplicates: true, excerptChars: 1 })
        const plain = await call(h, "list_articles", {})
        assert.ok(cursors.weight <= 3 * chainWeight)
        cursors.audit()
        const c = await call(h, "list_articles", { groupDuplicates: true, excerptChars: 2 })
        assert.equal((await errorOf(h, "list_articles", { cursor: a.nextCursor })).code, "CURSOR_EXPIRED", "the least recently used (a) was evicted")
        assert.ok(cursors.peek(b.nextCursor as string) !== undefined && cursors.peek(plain.nextCursor as string) !== undefined)
        cursors.audit()
        // c's next page: its successor (40 stories) and its own response; the least recently used entries go, never c's.
        const c2 = await call(h, "list_articles", { cursor: c.nextCursor })
        // With a capacity this small, the published page and its successor alone may exceed it: everything else is evicted first.
        if (cursors.weight > cursors.weightCapacity) assert.equal(cursors.size, 2)
        assert.equal((await call(h, "list_articles", { cursor: c.nextCursor })).text, c2.text, "the published page is replayed")
        assert.equal((await errorOf(h, "list_articles", { cursor: b.nextCursor })).code, "CURSOR_EXPIRED")
        assert.equal((await call(h, "list_articles", { cursor: c2.nextCursor })).articles.length, 20)
        cursors.audit()
    })

    test("64 chains, grouped and plain, list and search, with responses near the limit: the budget holds after every call", async () => {
        const sources = Array.from({ length: 6 }, (_, sid) => ({ sid, name: `Fonte ${sid}` }))
        const long = (n: number): string => `${snippetOf(n)} ${"parola ".repeat(900)}`
        const items = Array.from({ length: 400 }, (_, k) => copy(Math.floor(k / 4), 400 - k, k % 4, 0, { snippet: long(Math.floor(k / 4)) }))
        const cursors = new CursorRegistry({ weightCapacity: 2 * 1024 * 1024 })
        const { h } = await setup({ sources, articles: items }, { cursors })
        const chains: { tool: Tool; cursor: string | null }[] = []
        let expired = 0
        let maxResponse = 0
        let mixedSeen = false
        const step = async (tool: Tool, args: Record<string, unknown>): Promise<string | null> => {
            const outcome = await h.call(tool, args)
            if (outcome.isError) {
                assert.equal(outcome.error?.code, "CURSOR_EXPIRED")
                expired++
                return null
            }
            maxResponse = Math.max(maxResponse, outcome.length)
            assert.ok(cursors.weight <= cursors.weightCapacity, `${cursors.weight}`)
            const audited = cursors.audit()
            assert.equal(audited.weight, cursors.weight)
            if (audited.responses > 0 && audited.stateWeight > 0) mixedSeen = true
            assert.ok(cursors.size <= 64)
            return (outcome.result.structuredContent as Output).nextCursor
        }
        for (let k = 0; k < 64; k++) {
            const tool: Tool = k % 2 === 0 ? "list_articles" : "search_articles"
            const args = { excerptChars: 500, pageSize: 100, groupDuplicates: k % 4 < 2, ...(tool === "search_articles" && { query: "notizia", fields: "text" }) }
            chains.push({ tool, cursor: await step(tool, args) })
        }
        for (let round = 0; round < 6; round++) {
            for (const entry of chains) if (entry.cursor !== null) entry.cursor = await step(entry.tool, { cursor: entry.cursor })
        }
        assert.ok(maxResponse > RESP_MAX * 0.8, String(maxResponse))
        assert.ok(expired > 0, "some chains were evicted")
        assert.ok(mixedSeen, "responses and grouping memories were charged together")
    })

    test("responses near the limit: a story with 400 copies spans pages, at most 300 copies per page, each page within 48 000 units", async () => {
        const sources = Array.from({ length: 401 }, (_, sid) => ({ sid, name: `Fonte regionale con un nome piuttosto lungo numero ${sid} 😀` }))
        const items = sources.map((s, k) => copy(1, 401 - k, s.sid as number, 0))
        const { h } = await setup({ sources, articles: items })
        const pages = await listChain(h, { pageSize: 1 })
        assert.ok(pages.length >= 3, String(pages.length))
        assert.equal(pages[0]?.scan.stoppedBy, "responseBudget")
        assert.ok(pages.every((p) => (p.grouping?.copies ?? 0) <= DUPLICATE_COPIES_PAGE_MAX))
        const got = reconstruct(pages)
        assert.deepEqual([got.positions, got.groups.get(401)?.length], [[401], 401])
        assertOracle(pages, items)
        const long = await listChain(h, { pageSize: 100, excerptChars: 500 })
        assertOracle(long, items)
    })

    test("identity byte budgets: windows and calls stop before the budget, the first record of a call always passes", async () => {
        const items = mixed(90, 5).map((i) => ({ ...i, ...(i._id === 45 && { snippet: `${snippetOf(9)} ${"y ".repeat(100_000)}` }) }))
        const { h } = await setup({ articles: items })
        const pages = await listChain(h, { pageSize: 4 }, { identityWindowBytes: 600, identityCallBytes: 1500 })
        assert.ok(pages.some((p) => p.scan.stoppedBy === "scanBudget"))
        assertOracle(pages, items)
    })
})

describe("groupDuplicates: read-only, no leaks, bounded work", () => {
    test("EXPLAIN QUERY PLAN: identity statements are primary-key point lookups; values are bounded in SQL, GUIDs never projected", async () => {
        const { p } = await setup({ articles: mixed(500) })
        const { DatabaseSync } = await import("node:sqlite")
        const db = new DatabaseSync(p.dbPath, { readOnly: true })
        try {
            for (const sql of Object.values(DUPLICATE_SQL)) {
                const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("[1,2,3]") as { detail: string }[]).map((r) => r.detail).join(" | ")
                assert.match(detail, /SEARCH items USING INTEGER PRIMARY KEY \(rowid=\?\)/, detail)
                assert.doesNotMatch(detail, /SCAN items|TEMP B-TREE/, detail)
                assert.doesNotMatch(sql, /OFFSET|COUNT\(|JOIN|ORDER BY|LIKE|GLOB|REGEXP/i)
                assert.ok(sql.includes("16777216"), "the record limit is repeated")
            }
            // Every loaded value is guarded by its storage class and size; the GUID only by a prefix comparison.
            assert.doesNotMatch(DUPLICATE_SQL.sizes.replace(/(typeof|octet_length)\((title|snippet|link|guid|date)\)/g, ""), /\b(title|snippet|link|guid)\b/, "sizes come from the header only")
            for (const [column, max] of [["title", FIELD_BYTES_MAX], ["snippet", IDENTITY_SNIPPET_BYTES_MAX], ["link", FIELD_BYTES_MAX], ["guid", FIELD_BYTES_MAX]] as const) {
                assert.ok(DUPLICATE_SQL.values.includes(`typeof(${column}) = 'text' AND octet_length(${column}) <= ${max}`), column)
            }
            assert.match(DUPLICATE_SQL.values, /THEN substr\(guid, 1, 18\) = 'urn:fluent-reader:' END AS synthetic/)
            assert.doesNotMatch(DUPLICATE_SQL.values, /THEN guid END/)
            const row = db.prepare(DUPLICATE_SQL.values).get("[1]") as Record<string, unknown>
            assert.deepEqual(Object.keys(row).sort(), ["date", "id", "link", "snippet", "synthetic", "title"])
        } finally {
            db.close()
        }
    })

    test("links, guids, keys and fingerprints never appear; the profile is unchanged byte for byte", async () => {
        const items = Array.from({ length: 12 }, (_, k) => copy(k % 3, 12 - k, k % 4, 0, { link: `https://www.ansa.it/LINKSENTINEL/${k}.html`, guid: `GUIDSENTINEL-${k}`, thumb: "https://t.invalid/THUMBSENTINEL" }))
        const { p, h } = await setup({ articles: items })
        const before = snapshotDir(p.dir)
        const texts = [
            ...(await listChain(h, { pageSize: 1, excerptChars: 0 })).map((r) => r.text),
            ...(await chain(h, "search_articles", { groupDuplicates: true, query: "notizia", fields: "text", pageSize: 2, excerptChars: 0 })).map((r) => r.text),
        ]
        assert.ok(texts.some((t) => t.includes('"copies":[{')), "copies are reported")
        assert.deepEqual(findLeaks(texts, ["LINKSENTINEL", "GUIDSENTINEL", "THUMBSENTINEL", "ansa.it", "https://", "duplicate-key", "descrive con abbastanza"]), [])
        assert.deepEqual(snapshotDir(p.dir), before)
        assert.deepEqual(fs.readdirSync(p.dir).sort(), ["config.json", "fluent-reader.db"])
    })

    test("20 000 articles (a quarter of them copies) and pathological buckets: bounded per call, oracle reconstructed", async (t) => {
        const items: ItemSpec[] = []
        for (let id = 1; id <= 20_000; id++) items.push(id % 4 === 0 ? copy(Math.floor(id / 40), id, id % 6, (id % 3) - 1) : single(id, id % 6))
        const { h } = await setup({ articles: items })
        let started = performance.now()
        const pages = await listChain(h, { pageSize: 100, excerptChars: 0 })
        const listMs = performance.now() - started
        assertOracle(pages, items)
        t.diagnostic(`20 000 articles, grouped: ${pages.length} pages in ${Math.round(listMs)} ms`)

        // One key republished 3 000 times by one source: never copies of each other; work per article bounded by keyGroupsMax.
        const same = Array.from({ length: 3000 }, (_, k) => copy(1, 3000 - k, 0, 0))
        const one = await setup({ articles: same })
        started = performance.now()
        const sameSource = await listChain(one.h, { pageSize: 100, excerptChars: 0 })
        const sameMs = performance.now() - started
        const last = sameSource.at(-1) as Output
        assert.equal(reconstruct(sameSource).groups.size, 0)
        assert.equal(last.grouping?.forgottenSoFar, 3000 - DEFAULT_SCAN_LIMITS.duplicateKeyGroupsMax)
        t.diagnostic(`3 000 copies from one source: ${sameSource.length} pages in ${Math.round(sameMs)} ms`)

        // One key from 1 500 sources within 10 minutes, twice: two stories of 1 500 articles.
        const many = Array.from({ length: 1500 }, (_, sid) => ({ sid, name: `S${sid}` }))
        const bucket = Array.from({ length: 3000 }, (_, k) => copy(1, 3000 - k, k % 1500, k < 1500 ? 0 : 5))
        const wide = await setup({ sources: many, articles: bucket })
        started = performance.now()
        const widePages = await listChain(wide.h, { pageSize: 100, excerptChars: 0 })
        const wideMs = performance.now() - started
        const groups = reconstruct(widePages).groups
        assert.deepEqual([...groups.values()].map((g) => g.length), [1500, 1500])
        assertOracle(widePages, bucket)
        t.diagnostic(`3 000 copies from 1 500 sources: ${widePages.length} pages in ${Math.round(wideMs)} ms`)
        assert.ok(listMs + sameMs + wideMs < 120_000)
    })
})
