/**
 * search_articles (FR-MCP-01 §12.2 strategy A, §14.7; FR-MCP-02B-02).
 *
 * Literal search in the stored title, plain-text snippet or creator of the
 * articles, read-only, without index, FTS or regex. It is list_articles' scan
 * (scanPage in list-articles.ts: same anchor, windows, checkpoint, budgets,
 * filters, hidden-source policy, identity fingerprint and cursors) with one
 * more condition: the normalized query (domain/text-match.ts) must be a
 * substring of one searched value, normalized the same way.
 *
 * Work per call, all checked before a statement and never inside one:
 *  - the list_articles limits (windowRows candidates per statement, callRows
 *    per call, windowBytes/callBytes of records traversed, callWindows, the
 *    cooperative time budget, the source budgets);
 *  - searchable values: a value is loaded only when it is TEXT and within
 *    SEARCH_COLUMN_BYTES_MAX (title and creator 16 KiB, snippet 256 KiB), in
 *    the same traversal as the flags (phase B). The bytes to load are known
 *    from the record header in phase A, and windows are cut so that one
 *    statement loads at most searchWindowBytes (1 MiB) and one call at most
 *    searchCallBytes (8 MiB); the first record of a call is always allowed.
 *  - the comparison runs only on rows that passed the article filters; each
 *    normalized value is at most NORMALIZED_EXPANSION_MAX times its loaded
 *    length and is dropped after the comparison. One window's values are held
 *    until the window is processed.
 *
 * A value over its limit is never loaded, not even a prefix, and a value
 * that is not TEXT is never converted: when no other searched value matched,
 * the article is consumed, not returned, and counted (notSearchedTooLarge,
 * notSearchedUnexpectedType) if its source passes the visibility check.
 * NULL means no text (nothing to find). Records over the record limit are
 * skipped as in list_articles (scan.oversizeSkipped). search.incompleteSoFar
 * accumulates these counts along the chain of cursors, and search.exhaustive
 * is true only on the final page of a chain in which every examined article
 * was fully searched.
 *
 * Cursors are bound to the normalized query, fields and the list_articles
 * filters; a cursor keeps the running incompleteness count. Nothing about
 * the query is logged.
 */

import type { CallToolResult } from "@modelcontextprotocol/server"
import { isFrMcpError, FrMcpError } from "../errors.js"
import { SEARCH_COLUMNS, SEARCH_COLUMN_BYTES_MAX, type EvaluatedRow, type SearchFields } from "../domain/article-scan.js"
import { NORMALIZED_EXPANSION_MAX, normalizeForSearch, normalizeQuery } from "../domain/text-match.js"
import { CURSOR_TOKEN_LENGTH, type CursorEntry } from "../scan/cursors.js"
import { loadGroups, type ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import {
    checkBinding,
    DEFAULT_SCAN_LIMITS,
    LONGEST_STOPPED_BY,
    normalize,
    scanPage,
    type Binding,
    type PageResult,
    type ScanLimits,
    type ScanState,
    type TextOutcome,
} from "./list-articles.js"
import { PageBudget, resultLength, successResult } from "./result.js"
import {
    ARTICLE_LIST_CONSISTENCY,
    RESULT_SCHEMA_VERSION,
    SEARCH_MATCHING,
    searchArticlesInput,
    type SearchArticlesInput,
    type SearchArticlesOutput,
    type SearchedArticle,
} from "./schemas.js"

export const SEARCH_ARTICLES = "search_articles"

interface SearchBinding extends Binding {
    /** The normalized query. */
    readonly query: string
    readonly fields: SearchFields
}

interface SearchState extends ScanState {
    /** search.incompleteSoFar after the page that created this cursor. */
    readonly incomplete: number
}

function searchBinding(input: SearchArticlesInput, query: string): SearchBinding {
    return { ...normalize(input), query, fields: input.fields ?? "title" }
}

/**
 * Comparison of one row of SEARCH_SQL[fields].evaluate. Columns are tried in
 * precedence order (title before snippet); the first match wins. Otherwise
 * "tooLarge" or "unexpectedType" when a searched value could not be
 * examined (tooLarge first), else "none".
 */
function matcher(fields: SearchFields, query: string): (row: EvaluatedRow) => TextOutcome {
    const columns = SEARCH_COLUMNS[fields]
    return (row) => {
        let incomplete: "tooLarge" | "unexpectedType" | null = null
        for (const column of columns) {
            const type = row[`${column}Type`]
            const bytes = row[`${column}Bytes`]
            const value = row[`${column}Text`]
            if (type === "null") continue
            if (type !== "text") {
                incomplete ??= "unexpectedType"
                continue
            }
            if (bytes === null || bytes === undefined || bytes > SEARCH_COLUMN_BYTES_MAX[column]) {
                incomplete = "tooLarge"
                continue
            }
            // Same statement as the type and size: a loadable TEXT value is there.
            if (typeof value !== "string") throw new FrMcpError("INTERNAL_ERROR", "unexpected")
            const normalized = normalizeForSearch(value)
            // Unreachable by construction (text-match.ts); kept as a guard on the memory bound.
            if (normalized.length > NORMALIZED_EXPANSION_MAX * value.length) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
            if (normalized.includes(query)) return column
        }
        return incomplete ?? "none"
    }
}

export async function searchArticles(context: ToolContext, args: unknown, limits: ScanLimits = DEFAULT_SCAN_LIMITS): Promise<CallToolResult> {
    const input = parseArgs(searchArticlesInput, args)
    return context.cursors.exclusive(() => run(context, input, limits))
}

async function run(context: ToolContext, input: SearchArticlesInput, limits: ScanLimits): Promise<CallToolResult> {
    // The schema already accepted the query, so it normalizes.
    const query = input.query === undefined ? null : normalizeQuery(input.query)
    let entry: CursorEntry<SearchState> | undefined
    let binding: SearchBinding
    if (input.cursor !== undefined) {
        entry = context.cursors.resolve<SearchState>(input.cursor, SEARCH_ARTICLES)
        binding = entry.binding as SearchBinding
        checkBinding(input, searchBinding(input, query ?? binding.query), binding)
        if (entry.response !== undefined) return JSON.parse(entry.response) as CallToolResult
    } else {
        if (query === null) throw new FrMcpError("INVALID_ARGUMENT", "invalid-argument")
        binding = searchBinding(input, query)
    }
    const stale = (reason: "group-changed"): never => {
        if (input.cursor !== undefined) context.cursors.invalidate(input.cursor)
        throw new FrMcpError("CURSOR_STALE", reason)
    }

    let filterSids: readonly number[] | null = null
    let groupRevision: string | null = null
    if (binding.groupId !== null) {
        const members = (await loadGroups(context)).members(binding.groupId)
        if (entry !== undefined && entry.state.groupRevision !== members.revision) stale("group-changed")
        filterSids = members.sids
        groupRevision = members.revision
    } else if (binding.sourceIds !== null) {
        filterSids = JSON.parse(binding.sourceIds) as number[]
    }

    const meta: SearchArticlesOutput["meta"] = {
        generatedAt: new Date(context.now()).toISOString(),
        schemaVersion: RESULT_SCHEMA_VERSION,
        urlsRedacted: true,
    }
    const max = Number.MAX_SAFE_INTEGER
    // Every page-dependent field at its longest serialization.
    const skeleton: SearchArticlesOutput = {
        articles: [],
        sort: binding.sort,
        pageSize: binding.pageSize,
        hasMore: false,
        nextCursor: "x".repeat(CURSOR_TOKEN_LENGTH),
        scan: { examined: max, exhausted: false, stoppedBy: LONGEST_STOPPED_BY, oversizeSkipped: max, invalidDateExcluded: max },
        search: { fields: binding.fields, textBytesLoaded: max, notSearchedTooLarge: max, notSearchedUnexpectedType: max, incompleteSoFar: max, exhaustive: false },
        matching: SEARCH_MATCHING,
        consistency: ARTICLE_LIST_CONSISTENCY,
        meta,
    }
    const budget = new PageBudget(resultLength(skeleton))
    const search = { fields: binding.fields, match: matcher(binding.fields, binding.query) }

    let page: PageResult
    try {
        page = await context.database.withReadConnection((db) =>
            scanPage(db, { binding, entry, filterSids, groupRevision, limits, identity: context.identity, budget, search }),
        )
    } catch (error) {
        if (isFrMcpError(error) && error.code === "CURSOR_STALE" && input.cursor !== undefined) context.cursors.invalidate(input.cursor)
        throw error
    }

    const incomplete = (entry?.state.incomplete ?? 0) + page.notSearchedTooLarge + page.notSearchedUnexpectedType + page.oversizeSkipped
    const nextCursor =
        page.next === null
            ? null
            : context.cursors.create<SearchState>(SEARCH_ARTICLES, binding, { ...page.next, incomplete }, entry?.scanStartedAt ?? context.now())
    const payload: SearchArticlesOutput = {
        articles: page.articles as SearchedArticle[],
        sort: binding.sort,
        pageSize: binding.pageSize,
        hasMore: nextCursor !== null,
        nextCursor,
        scan: {
            examined: page.examined,
            exhausted: page.exhausted,
            stoppedBy: page.stoppedBy,
            oversizeSkipped: page.oversizeSkipped,
            invalidDateExcluded: page.invalidDateExcluded,
        },
        search: {
            fields: binding.fields,
            textBytesLoaded: page.textBytes,
            notSearchedTooLarge: page.notSearchedTooLarge,
            notSearchedUnexpectedType: page.notSearchedUnexpectedType,
            incompleteSoFar: incomplete,
            exhaustive: page.exhausted && incomplete === 0,
        },
        matching: SEARCH_MATCHING,
        consistency: ARTICLE_LIST_CONSISTENCY,
        meta,
    }
    let built: ReturnType<typeof successResult>
    try {
        built = successResult(payload)
    } catch (error) {
        if (nextCursor !== null) context.cursors.invalidate(nextCursor)
        throw error
    }
    if (entry !== undefined) entry.response = built.serialized
    return built.result
}
