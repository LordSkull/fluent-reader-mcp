/**
 * Compatibility snapshot of list_articles and search_articles without
 * groupDuplicates. The calls below run on a deterministic synthetic profile
 * with a fixed clock; following every cursor, each page's content[0].text is
 * recorded with the cursor tokens (random by design) replaced by a marker.
 *
 * test/fixtures/ungrouped-golden-0.1.4.json was recorded with this helper on
 * the code BEFORE groupDuplicates existed (commit aecf15c), so a test
 * comparing today's output with it proves that calls without the parameter,
 * or with groupDuplicates: false, return exactly what they returned before.
 * The profile includes copies that the grouped mode would merge.
 */

import path from "node:path"
import type { ProfileFixture } from "./fixtures.js"
import { createSourcesProfile, harness, type Harness, type ItemSpec } from "./sources.js"

export const GOLDEN_NOW = Date.UTC(2026, 10, 21, 9, 30, 0)
const T = Date.UTC(2026, 10, 20, 9, 0, 0)
const SNIPPET =
    "La compagnia ha confermato l'acquisto di dodici aerei destinati ai collegamenti regionali, con le prime consegne previste nel corso del 2027."

function goldenArticles(): ItemSpec[] {
    const items: ItemSpec[] = []
    for (let id = 1; id <= 48; id++) {
        const copy = id % 6 === 0 || id % 6 === 1
        items.push({
            _id: id,
            source: id % 4,
            title: copy ? `Notizia condivisa ${Math.floor((id + 1) / 6)}` : `Articolo ${id} città`,
            snippet: copy ? SNIPPET : `Testo ${id} news`,
            link: copy ? `https://www.ansa.it/regione${id % 4}/notizia_${Math.floor((id + 1) / 6)}.html` : `https://example.invalid/${id}`,
            guid: id === 13 ? "urn:fluent-reader:camera:13" : `guid-${id}`,
            date: T + (copy ? Math.floor((id + 1) / 6) * 3_600_000 + (id % 6) * 1000 : id * 60_000),
            fetchedDate: T + id * 60_000 + 500,
            creator: id % 5 === 0 ? `Autore ${id}` : null,
            hasRead: id % 3 === 0 ? 1 : 0,
            starred: id % 7 === 0 ? 1 : 0,
            hidden: id % 11 === 0 ? 1 : 0,
        })
    }
    return items
}

export function createGoldenProfile(root: string, name: string): ProfileFixture {
    return createSourcesProfile(path.join(root, name), {
        sources: [
            { sid: 0, name: "Fonte zero" },
            { sid: 1, name: "Fonte uno" },
            { sid: 2, name: "Fonte due" },
            { sid: 3, name: "Fonte nascosta", hidden: 1 },
        ],
        settings: { sourceGroups: [{ gid: 0, isMultiple: true, sids: [1, 2], name: "Gruppo" }], sourceRules: {} },
        articles: goldenArticles(),
    })
}

export interface GoldenCall {
    readonly tool: "list_articles" | "search_articles"
    readonly args: Readonly<Record<string, unknown>>
}

export const GOLDEN_CALLS: readonly GoldenCall[] = [
    { tool: "list_articles", args: {} },
    { tool: "list_articles", args: { pageSize: 7 } },
    { tool: "list_articles", args: { pageSize: 5, excerptChars: 30, read: "unread", hidden: "include", includeHiddenSources: true } },
    { tool: "list_articles", args: { groupId: 0, starred: "unstarred", pageSize: 4 } },
    { tool: "list_articles", args: { sourceIds: [0, 3], dateFrom: "2026-11-20T09:10:00Z", dateTo: "2026-11-20T14:00:00+01:00", pageSize: 3 } },
    { tool: "list_articles", args: { pageSize: 100, excerptChars: 500, hidden: "only", includeHiddenSources: true } },
    { tool: "search_articles", args: { query: "notizia", pageSize: 4 } },
    { tool: "search_articles", args: { query: "news", fields: "text", pageSize: 6 } },
    { tool: "search_articles", args: { query: "autore", fields: "creator", includeHiddenSources: true } },
    { tool: "search_articles", args: { query: "citta", read: "read", pageSize: 2, excerptChars: 0 } },
]

export const CURSOR_MARKER = "<cursor>"

/** content[0].text of every page of the call, cursors replaced by CURSOR_MARKER. `extra` is merged into the first page's arguments. */
export async function collectGolden(h: Harness, call: GoldenCall, extra: Readonly<Record<string, unknown>> = {}): Promise<string[]> {
    const pages: string[] = []
    let cursor: string | null = null
    do {
        const outcome = await h.call(call.tool, cursor === null ? { ...call.args, ...extra } : { cursor })
        if (outcome.isError) throw new Error(`${call.tool} failed: ${outcome.text}`)
        cursor = outcome.payload.nextCursor as string | null
        pages.push(cursor === null ? outcome.text : outcome.text.split(cursor).join(CURSOR_MARKER))
        if (pages.length > 1000) throw new Error("listing did not terminate")
    } while (cursor !== null)
    return pages
}

export async function goldenHarness(profile: ProfileFixture): Promise<Harness> {
    return harness(profile, { now: () => GOLDEN_NOW })
}
