/**
 * list_articles (FR-MCP-01 §11.3, §11.5, §14.5, adapted to the
 * FR-MCP-02B-01 contract). The scan below (scanPage, with its source checks
 * and identity fingerprint) is also the scan of search_articles
 * (FR-MCP-02B-02, search-articles.ts), which adds a text comparison.
 *
 * Lists stored articles in "stored" order, descending `_id`, by a windowed
 * keyset scan of the primary key. Never OFFSET, and never one statement whose
 * work depends on how selective the filters are (domain/article-scan.ts):
 *  - The first page anchors the scan to [lo, hi] = [MIN(_id), MAX(_id)]
 *    observed then; articles saved later (higher ids) are not visited.
 *  - A window is at most `windowRows` candidates of [lo, nextUpper] read
 *    by LIMIT on the primary key (phase A), cut to the prefix whose records
 *    fit the byte budgets, then evaluated on the closed range [L, U] of that
 *    prefix (phase B). Filters run in JavaScript on phase B's values.
 *  - Candidates are consumed in descending order: a non-matching one at once,
 *    a matching one when it enters the page. The checkpoint is the last
 *    consumed id, never the last returned article: the next page starts at
 *    nextUpper = lastConsumed − 1. Candidates read but not consumed (page
 *    full, response budget, the rest of a window) are read again next time.
 *  - A record estimated above ARTICLE_RECORD_BYTES_MAX is consumed without
 *    evaluation (its flags lie behind the whole record) and counted in
 *    scan.oversizeSkipped; get_article refuses it as well.
 *  - Per call: at most `callRows` candidates consumed, `callBytes` estimated
 *    bytes traversed and `callWindows` windows; a cooperative time budget is
 *    checked between windows only (a running SQLite statement cannot be
 *    interrupted). At least one window runs, so every successful call
 *    consumes at least one candidate (or fails with LIMIT_EXCEEDED without
 *    advancing) and a chain of cursors ends after at most hi − lo + 1 calls.
 *  - The scan is exhausted when phase A finds no candidate, when `lo` is
 *    consumed, or when a window that phase A returned short (fewer rows than
 *    asked: nothing else exists in [lo, upper]) is consumed entirely.
 *    Exhaustion is never inferred from the number of articles returned.
 *
 * Sources: a candidate that passes the article filters needs its source row
 * (hidden flag for includeHiddenSources: false, name prefix for the output).
 * Sources are resolved in order, with their own budgets (ScanLimits
 * source*): a record over RECORD_BYTES_MAX is not read (its hidden flag is
 * unknown), and when the budgets are spent before a candidate's source is
 * read, the page stops before that candidate (scanBudget) without consuming
 * it. With includeHiddenSources false, only a source verified not hidden
 * (stored hidden = 0) or absent (orphan article) lets an article through.
 *
 * hasMore = (nextCursor !== null) = !scan.exhausted: the scan has candidates
 * left, not necessarily matching ones. Pages can be partial or empty.
 *
 * Each call runs in one read transaction (DatabaseAccess.withReadConnection):
 * nothing outlives the call. Cursors (scan/cursors.ts) bind the normalized
 * filters and keep lo, hi, nextUpper and the checks below; the response
 * published for a cursor is replayed verbatim. CURSOR_STALE (the cursor is
 * dropped) when, since the first page:
 *  - the schema version changed;
 *  - with groupId, the group's membership (first-group members) changed;
 *  - with sourceIds or groupId, a filtered source was deleted, added (an
 *    orphan member) or its id reused by another feed URL (internal HMAC
 *    fingerprint of (sid, url); a source re-added with the same URL is not
 *    detectable);
 *  - the row at the checkpoint still exists but its header fingerprint
 *    (types, sizes, source, date, fetchedDate) changed, e.g. a backup
 *    restore. A deleted checkpoint row cannot be told from a restore.
 * A replaced database file is DB_REPLACED (connection.ts).
 *
 * groupDuplicates (both tools; binding and cursor carry it, so a chain never
 * changes mode). Without it, nothing below runs and no statement of
 * DUPLICATE_SQL is prepared. With it, every article that passes the filters
 * (and the text, in a search) and whose source is visible is a "matched"
 * article, as before; then, in stored order:
 *  - its identity is computed (domain/duplicates.ts) from the values loaded by
 *    DUPLICATE_SQL for the matched rows of the window, within their own
 *    per-record limits and byte budgets (ScanLimits identityWindowBytes and
 *    identityCallBytes, accepted like the record bytes: the first record of a
 *    call always, later ones only within the budget, otherwise the page stops
 *    before the row without consuming it, scanBudget);
 *  - a copy of a remembered story (DuplicateMemory.find) is consumed and
 *    reported: in its representative's duplicates.copies when that one is on
 *    this page, otherwise in earlierCopies. It takes no position: pageSize
 *    counts the articles returned, scan.examined every consumed row;
 *  - any other matched article is returned as before, with `duplicates`
 *    (identity verified, ineligible or notVerifiable); a verified one opens a
 *    story in the memory.
 * Once the page holds pageSize articles, the rest of the window already read
 * is still consumed while its rows are copies or excluded ones; the page
 * stops (pageFull) before the first row that would be a new article, which
 * the next call reads again. A copy that does not fit the response stops the
 * page before it (responseBudget). Each call still consumes at least one row.
 */

import crypto from "node:crypto"
import { performance } from "node:perf_hooks"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError, isFrMcpError } from "../errors.js"
import type { ReadOnlyDatabase } from "../db/connection.js"
import { ARTICLE_RECORD_BYTES_MAX, FIELD_BYTES_MAX } from "../domain/articles.js"
import { identityOfFields, timeOf } from "../domain/duplicates.js"
import type { RememberedGroup } from "../scan/duplicate-memory.js"
import {
    classifyIdentitySizes,
    EXCERPT_SOURCE_BYTES_MAX,
    readEvaluation,
    readIdentitySizes,
    readIdentityValues,
    readIdBounds,
    readPosition,
    readProjection,
    readScanCandidates,
    readScanSchemaVersion,
    readSourceInfo,
    readSourceSizes,
    readSourceUrls,
    readSourceUrlSizes,
    URL_DIGEST_BYTES_MAX,
    type EvaluatedRow,
    type ProjectedRow,
    type SearchColumn,
    type SearchFields,
    type SourceInfoRow,
} from "../domain/article-scan.js"
import { BATCH_BYTES_MAX, RECORD_BYTES_MAX, type StorageClass } from "../domain/sources.js"
import { CURSOR_TOKEN_LENGTH, type CursorEntry } from "../scan/cursors.js"
import type { SourceIdentity } from "../scan/identity.js"
import { loadGroups, type ToolContext } from "./context.js"
import {
    finishGrouping,
    GROUPING_SKELETON,
    NO_PAGE_GROUPING,
        startGrouping,
    successorOptions,
    type GroupingSpec,
    type GroupingState,
    type PageGrouping,
} from "./duplicate-grouping.js"
import { parseArgs } from "./input.js"
import { PageBudget, resultLength, successResult } from "./result.js"
import {
    ARTICLE_LIST_CONSISTENCY,
    ARTICLE_PAGE_SIZE_DEFAULT,
    DUPLICATE_COPIES_PAGE_MAX,
    EXCERPT_CHARS_DEFAULT,
    listArticlesInput,
    parseInstant,
    RESULT_SCHEMA_VERSION,
    type ArticleFieldIssue,
    type DuplicateIdentityStatus,
    type ListArticlesInput,
    type ListArticlesOutput,
    type ListedArticle,
    type ListedCopy,
} from "./schemas.js"

export const LIST_ARTICLES = "list_articles"

/** Work limits of one call. Exported for tests; the server always uses DEFAULT_SCAN_LIMITS. */
export interface ScanLimits {
    /** Candidates read by one phase-A statement (rows visited by a phase-B statement, at most). */
    readonly windowRows: number
    /** Candidates consumed per call. */
    readonly callRows: number
    /** Estimated record bytes evaluated by one phase-B statement (one record is always allowed). */
    readonly windowBytes: number
    /** Estimated record bytes evaluated per call, checked before each window. */
    readonly callBytes: number
    /** Windows per call. */
    readonly callWindows: number
    /** Cooperative time budget, checked between windows, never inside a statement. */
    readonly timeBudgetMs: number
    readonly clock: () => number
    /** Estimated source-record bytes read by one source statement (S2); the first source of a call is always allowed. */
    readonly sourceBatchBytes: number
    /** Estimated source-record bytes read per call, accounted apart from the article budgets. */
    readonly sourceCallBytes: number
    /** Distinct sources resolved and cached per call (each entry holds at most a 300-code-point name). */
    readonly sourceCacheEntries: number
    /** Search only: bytes of searchable values loaded by one phase-B statement (the first record of a window is always allowed). */
    readonly searchWindowBytes: number
    /** Search only: bytes of searchable values loaded per call, checked before each window. */
    readonly searchCallBytes: number
    /** groupDuplicates only: bytes of identity values loaded by one DUPLICATE_SQL.values statement (the first record of a call is always allowed). */
    readonly identityWindowBytes: number
    /** groupDuplicates only: bytes of identity values loaded per call. */
    readonly identityCallBytes: number
    /** groupDuplicates only, fixed by the first page of a chain: limits of the DuplicateMemory kept by its cursors. */
    readonly duplicateGroupsMax: number
    readonly duplicateMembersMax: number
    readonly duplicateKeyGroupsMax: number
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
    windowRows: 256,
    callRows: 4096,
    windowBytes: 8 * 1024 * 1024,
    callBytes: 64 * 1024 * 1024,
    callWindows: 64,
    timeBudgetMs: 300,
    clock: () => performance.now(),
    sourceBatchBytes: BATCH_BYTES_MAX,
    sourceCallBytes: 8 * 1024 * 1024,
    sourceCacheEntries: 1024,
    searchWindowBytes: 1024 * 1024,
    searchCallBytes: 8 * 1024 * 1024,
    identityWindowBytes: 1024 * 1024,
    identityCallBytes: 8 * 1024 * 1024,
    duplicateGroupsMax: 2048,
    duplicateMembersMax: 8192,
    duplicateKeyGroupsMax: 16,
}

/** Uncached sources resolved ahead by one source lookup (S1 of at most this many point lookups). */
const SOURCE_LOOKAHEAD = 64
/** Sources whose URL size is read per statement for the identity fingerprint (S1), and at most per S2. */
const FINGERPRINT_SIDS = 512
/** URL bytes loaded by one fingerprint statement (S2); a single URL of up to URL_DIGEST_BYTES_MAX is always allowed. */
const FINGERPRINT_BATCH_BYTES = 1024 * 1024
/** URL bytes hashed per call; beyond, the identity is not verifiable (fail-closed). */
const FINGERPRINT_CALL_BYTES = 32 * 1024 * 1024

/** Valid range of a JavaScript Date, in milliseconds. */
const DATE_MS_MAX = 8.64e15

type StoppedBy = ListArticlesOutput["scan"]["stoppedBy"]
const STOPPED_BY: readonly StoppedBy[] = ["exhausted", "pageFull", "responseBudget", "scanBudget", "timeBudget"]
export const LONGEST_STOPPED_BY = STOPPED_BY.reduce((a, b) => (b.length > a.length ? b : a))

/**
 * Outcome of the text comparison of one row that passed the article filters
 * (search_articles): the column that matched, "none" when every searched
 * value was examined without a match, or why one could not be examined.
 */
export type TextOutcome = SearchColumn | "none" | "tooLarge" | "unexpectedType"

/** A search run by scanPage: the columns to load (SEARCH_SQL) and the comparison of one row. */
export interface SearchSpec {
    readonly fields: SearchFields
    readonly match: (row: EvaluatedRow) => TextOutcome
}

/** A copy reported by a page; matchedIn only in a search. */
export type ScannedCopy = ListedCopy & { matchedIn?: SearchColumn }
/** A copy of a story returned on an earlier page of the chain. */
export type EarlierCopy = { representativeId: number } & ScannedCopy

/** An article of a page; matchedIn only in a search, duplicates only with groupDuplicates. */
export type ScannedArticle = ListedArticle & {
    matchedIn?: SearchColumn
    duplicates?: { readonly identity: DuplicateIdentityStatus; readonly copies: ScannedCopy[] }
}

/** Identity of a matched row (groupDuplicates). */
type RowIdentity = { readonly kind: "verified"; readonly fingerprint: string; readonly time: number } | { readonly kind: "ineligible" | "notVerifiable" }
const INELIGIBLE: RowIdentity = { kind: "ineligible" }
const NOT_VERIFIABLE: RowIdentity = { kind: "notVerifiable" }

export interface Binding {
    readonly [key: string]: string | number | boolean | null
    /** JSON of the sorted, distinct sourceIds. */
    readonly sourceIds: string | null
    readonly groupId: number | null
    readonly dateFrom: number | null
    readonly dateTo: number | null
    readonly read: "any" | "read" | "unread"
    readonly starred: "any" | "starred" | "unstarred"
    readonly hidden: "exclude" | "include" | "only"
    readonly includeHiddenSources: boolean
    readonly sort: "stored"
    readonly pageSize: number
    readonly excerptChars: number
    readonly groupDuplicates: boolean
}

export interface ScanState {
    readonly lo: number
    readonly hi: number
    /** Highest id not yet examined (inclusive), within [lo, hi]. */
    readonly nextUpper: number
    readonly schemaVersion: number
    readonly groupRevision: string | null
    /** Fingerprint of the filtered sources; null without a source filter, or when it could not be verified. */
    readonly sourcesFingerprint: string | null
    /** Last consumed id and the fingerprint of its row at that time. */
    readonly positionId: number
    readonly positionFingerprint: string | null
    /** groupDuplicates only. */
    readonly grouping?: GroupingState
}

/** The filter arguments shared with search_articles, with their defaults. */
export type FilterInput = Omit<ListArticlesInput, "cursor">

export function normalize(input: FilterInput): Binding {
    return {
        sourceIds: input.sourceIds === undefined ? null : JSON.stringify([...new Set(input.sourceIds)].sort((a, b) => a - b)),
        groupId: input.groupId ?? null,
        dateFrom: input.dateFrom === undefined ? null : parseInstant(input.dateFrom),
        dateTo: input.dateTo === undefined ? null : parseInstant(input.dateTo),
        read: input.read ?? "any",
        starred: input.starred ?? "any",
        hidden: input.hidden ?? "exclude",
        includeHiddenSources: input.includeHiddenSources ?? false,
        sort: input.sort ?? "stored",
        pageSize: input.pageSize ?? ARTICLE_PAGE_SIZE_DEFAULT,
        excerptChars: input.excerptChars ?? EXCERPT_CHARS_DEFAULT,
        groupDuplicates: input.groupDuplicates ?? false,
    }
}

/**
 * Arguments repeated with a cursor must equal (after normalization) those the
 * listing started with. `given` is the normalized form of `input`; only the
 * arguments present in `input` are compared.
 */
export function checkBinding(input: object, given: Readonly<Record<string, unknown>>, binding: Readonly<Record<string, unknown>>): void {
    for (const key of Object.keys(given)) {
        if ((input as Record<string, unknown>)[key] !== undefined && given[key] !== binding[key]) {
            throw new FrMcpError("CURSOR_MISMATCH", "filters-changed")
        }
    }
}

function sha256(value: unknown): string {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("base64url")
}

/** The source row of an article, as resolved during one call. */
type SourceInfo =
    /** No source row has the article's sid. */
    | { readonly kind: "orphan" }
    /** Record over RECORD_BYTES_MAX: neither traversed nor loaded, so its hidden flag and name are unknown. */
    | { readonly kind: "tooLarge" }
    | { readonly kind: "found"; readonly row: SourceInfoRow }

/**
 * Internal identity of the filtered sources (never returned): a keyed
 * SHA-256 (SourceIdentity.digest) over, for each sid in order, either
 * "missing" or the storage class, byte length and EXACT stored bytes of its
 * feed URL. Two different URLs give different fingerprints whatever their
 * length or common prefix; deleted, added or reused ids change it. A source
 * deleted and re-added with exactly the same URL cannot be told apart.
 *
 * Bounded work, streamed (no URL is kept after it is hashed):
 *  - sizes first, from the header only, FINGERPRINT_SIDS sids per statement;
 *  - URL bytes read in runs of consecutive sids holding at most
 *    FINGERPRINT_BATCH_BYTES (one URL at least), each URL at most
 *    URL_DIGEST_BYTES_MAX, at most FINGERPRINT_CALL_BYTES per call.
 * fingerprint is null when the identity cannot be verified: a URL over
 * URL_DIGEST_BYTES_MAX, a URL that is not TEXT or BLOB, or more URL bytes
 * than FINGERPRINT_CALL_BYTES. The caller then refuses to continue the
 * listing (fail-closed). `missing` is always complete.
 */
function sourcesFingerprint(db: ReadOnlyDatabase, sids: readonly number[], identity: SourceIdentity): { fingerprint: string | null; missing: number } {
    const digest = identity.digest("source-set/1")
    let missing = 0
    let verifiable = true
    let total = 0
    for (let i = 0; i < sids.length; i += FINGERPRINT_SIDS) {
        const chunk = sids.slice(i, i + FINGERPRINT_SIDS)
        const sizes = readSourceUrlSizes(db, chunk)
        const urlBytes = (sid: number): number | null => {
            const size = sizes.get(sid)
            if (size === undefined) return 0
            const ok = (size.urlType === "text" || size.urlType === "blob") && size.urlBytes !== null && size.urlBytes <= URL_DIGEST_BYTES_MAX
            return ok ? (size.urlBytes as number) : null
        }
        for (const sid of chunk) {
            if (!sizes.has(sid)) missing++
            else if (urlBytes(sid) === null) verifiable = false
        }
        if (!verifiable) continue // keep counting missing sids, read no more URL
        let start = 0
        while (start < chunk.length) {
            let end = start
            let runBytes = 0
            while (end < chunk.length) {
                const bytes = urlBytes(chunk[end] as number) as number
                if (end > start && runBytes + bytes > FINGERPRINT_BATCH_BYTES) break
                runBytes += bytes
                end++
            }
            total += runBytes
            if (total > FINGERPRINT_CALL_BYTES) {
                verifiable = false
                break
            }
            const run = chunk.slice(start, end)
            const urls = readSourceUrls(db, run.filter((sid) => sizes.has(sid)))
            for (const sid of run) {
                const size = sizes.get(sid)
                if (size === undefined) {
                    digest.update(`${sid}\0missing\n`)
                    continue
                }
                const bytes = urls.get(sid)
                // Same transaction as the sizes: the URL is there and within the limit.
                if (bytes === undefined || bytes.length !== size.urlBytes) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
                digest.update(`${sid}\0${size.urlType}\0${bytes.length}\0`)
                digest.update(bytes)
                digest.update("\n")
            }
            start = end
        }
    }
    return { fingerprint: verifiable ? digest.digest("base64url") : null, missing }
}

export interface PageInput {
    readonly binding: Binding
    readonly entry: CursorEntry<ScanState> | undefined
    readonly filterSids: readonly number[] | null
    readonly groupRevision: string | null
    readonly limits: ScanLimits
    readonly identity: SourceIdentity
    readonly budget: PageBudget
    /** search_articles only. */
    readonly search?: SearchSpec
    /** groupDuplicates only. */
    readonly grouping?: GroupingSpec
}

export interface PageResult {
    readonly articles: ScannedArticle[]
    readonly examined: number
    readonly oversizeSkipped: number
    readonly invalidDateExcluded: number
    /** Search only: consumed articles that passed every filter but had a searched value too large to load, or not TEXT, and no match elsewhere. */
    readonly notSearchedTooLarge: number
    readonly notSearchedUnexpectedType: number
    /** Search only: bytes of searchable values loaded by this call. */
    readonly textBytes: number
    /** groupDuplicates only. */
    readonly grouping?: PageGrouping<EarlierCopy>
    readonly exhausted: boolean
    readonly stoppedBy: StoppedBy
    /** State of the successor cursor; null when exhausted. */
    readonly next: ScanState | null
}

/**
 * One page, synchronously inside one read transaction. Shared by
 * list_articles and search_articles: with `page.search`, phases A and B use
 * SEARCH_SQL, the searchable values loaded are bounded per statement and per
 * call (searchWindowBytes, searchCallBytes, accepted like the record bytes),
 * and a row must also match the text (page.search.match) to enter the page.
 * The text is compared only for rows that passed the article filters; rows
 * whose value could not be examined go through the same source check and,
 * when visible, are counted (notSearched*), never returned.
 */
export function scanPage(db: ReadOnlyDatabase, page: PageInput): PageResult {
    const { binding, entry, limits, search } = page
    const schemaVersion = readScanSchemaVersion(db)
    if (entry !== undefined && entry.state.schemaVersion !== schemaVersion) throw new FrMcpError("CURSOR_STALE", "schema-changed")

    let fingerprint: string | null = null
    if (page.filterSids !== null) {
        const found = sourcesFingerprint(db, page.filterSids, page.identity)
        if (entry === undefined && binding.sourceIds !== null && found.missing > 0) throw new FrMcpError("NOT_FOUND", "source-not-found")
        if (entry !== undefined) {
            // Fail-closed: an identity that could not be verified, then or now, never lets the listing continue.
            if (entry.state.sourcesFingerprint === null || found.fingerprint === null) throw new FrMcpError("CURSOR_STALE", "source-identity-unverifiable")
            if (entry.state.sourcesFingerprint !== found.fingerprint) throw new FrMcpError("CURSOR_STALE", "sources-changed")
        }
        fingerprint = found.fingerprint
    }
    if (entry !== undefined && entry.state.positionFingerprint !== null) {
        const position = readPosition(db, entry.state.positionId)
        if (position !== undefined && sha256(position) !== entry.state.positionFingerprint) throw new FrMcpError("CURSOR_STALE", "position-changed")
    }

    const result = (exhausted: boolean, stoppedBy: StoppedBy, rest: Omit<PageResult, "exhausted" | "stoppedBy" | "next">, lastConsumed: number | null, lo: number, hi: number): PageResult => {
        if (exhausted) return { ...rest, exhausted, stoppedBy: "exhausted", next: null }
        // Unreachable: a call that does not exhaust the scan has consumed a candidate above lo.
        if (lastConsumed === null || lastConsumed <= lo) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
        const position = readPosition(db, lastConsumed)
        return {
            ...rest,
            exhausted,
            stoppedBy,
            next: {
                lo,
                hi,
                nextUpper: lastConsumed - 1,
                schemaVersion,
                groupRevision: page.groupRevision,
                sourcesFingerprint: fingerprint,
                positionId: lastConsumed,
                positionFingerprint: position === undefined ? null : sha256(position),
            },
        }
    }
    const empty = { articles: [], examined: 0, oversizeSkipped: 0, invalidDateExcluded: 0, notSearchedTooLarge: 0, notSearchedUnexpectedType: 0, textBytes: 0 }

    const bounds = entry !== undefined ? { lo: entry.state.lo, hi: entry.state.hi } : readIdBounds(db)
    // No article, or a group without members: nothing can match, nothing is scanned.
    if (bounds === null || (page.filterSids !== null && page.filterSids.length === 0)) return result(true, "exhausted", empty, null, 0, 0)
    const { lo, hi } = bounds

    const filterSet = page.filterSids === null ? null : new Set(page.filterSids)

    /*
     * Article sources: hidden flag and name prefix only (SCAN_SQL.sourceInfo),
     * never URLs. Bounded per record (RECORD_BYTES_MAX: larger records are
     * "tooLarge", not read), per statement (sourceBatchBytes), per call
     * (sourceCallBytes, accounted apart from the article budgets) and in
     * number (sourceCacheEntries). The first source of a call is always
     * resolved, so a call always progresses.
     */
    const sources = new Map<number, SourceInfo>()
    let sourceBytes = 0
    const resolveSources = (wanted: readonly number[]): void => {
        const need = [...new Set(wanted)].filter((sid) => !sources.has(sid)).slice(0, Math.max(0, limits.sourceCacheEntries - sources.size))
        if (need.length === 0) return
        const sizes = readSourceSizes(db, need)
        const batch: number[] = []
        let batchBytes = 0
        for (const sid of need) {
            const bytes = sizes.get(sid)
            if (bytes === undefined) {
                sources.set(sid, { kind: "orphan" })
                continue
            }
            if (bytes > RECORD_BYTES_MAX) {
                sources.set(sid, { kind: "tooLarge" })
                continue
            }
            const first = sourceBytes === 0 && batch.length === 0
            if (!first && (batchBytes + bytes > limits.sourceBatchBytes || sourceBytes + batchBytes + bytes > limits.sourceCallBytes)) break
            batch.push(sid)
            batchBytes += bytes
        }
        if (batch.length === 0) return
        const rows = readSourceInfo(db, batch)
        for (const sid of batch) {
            const row = rows.get(sid)
            // Same transaction as the sizes: the row exists and is within the record limit.
            if (row === undefined) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
            sources.set(sid, { kind: "found", row })
        }
        sourceBytes += batchBytes
    }

    const validDate = (row: EvaluatedRow): boolean => row.dateType === "integer" && row.date !== null && Math.abs(row.date) <= DATE_MS_MAX
    const dateFiltered = binding.dateFrom !== null || binding.dateTo !== null
    let invalidDateExcluded = 0
    /**
     * Every filter but the hidden-source one, which needs the source row.
     * "invalidDate": excluded only because a date filter met an invalid date
     * (counted when the row is consumed, so never twice).
     */
    const preMatch = (row: EvaluatedRow): boolean | "invalidDate" => {
        if (filterSet !== null && (row.source === null || !filterSet.has(row.source))) return false
        if (binding.read !== "any" && row.hasRead !== (binding.read === "read" ? 1 : 0)) return false
        if (binding.starred !== "any" && row.starred !== (binding.starred === "starred" ? 1 : 0)) return false
        if (binding.hidden !== "include" && row.hidden !== (binding.hidden === "only" ? 1 : 0)) return false
        if (dateFiltered) {
            if (!validDate(row)) return "invalidDate"
            const date = row.date as number
            if ((binding.dateFrom !== null && date < binding.dateFrom) || (binding.dateTo !== null && date >= binding.dateTo)) return false
        }
        return true
    }
    /**
     * Source check of a row that passed the other filters:
     *  - "visible": no source row can exist (the stored source is not an
     *    integer), the source is an orphan, hidden sources were requested, or
     *    the source is verified not hidden (stored hidden = 0);
     *  - "excluded": the source is hidden, or its hidden flag cannot be
     *    verified (record over the limit, malformed flag, source id outside
     *    ±(2^53−1)): uncertainty never counts as visible;
     *  - "unresolved": the source budgets are spent before this source could
     *    be read; the row is not evaluated and the page stops before it.
     */
    const resolvable = (row: EvaluatedRow): number | null => (row.sourceType === "integer" ? row.source : null)
    /** `eligible[j]`: row j needs its source checked (it passed the filters and, in a search, did not fail the text). */
    const sourceCheck = (rows: readonly EvaluatedRow[], eligible: readonly boolean[], i: number): "visible" | "excluded" | "unresolved" => {
        const row = rows[i] as EvaluatedRow
        if (row.sourceType !== "integer") return "visible"
        if (row.source === null) return binding.includeHiddenSources ? "visible" : "excluded"
        if (!sources.has(row.source)) {
            const ahead: number[] = [row.source]
            for (let j = i + 1; j < rows.length && ahead.length < SOURCE_LOOKAHEAD; j++) {
                const sid = eligible[j] === true ? resolvable(rows[j] as EvaluatedRow) : null
                if (sid !== null && !sources.has(sid) && !ahead.includes(sid)) ahead.push(sid)
            }
            resolveSources(ahead)
        }
        const info = sources.get(row.source)
        if (info === undefined) return "unresolved"
        if (binding.includeHiddenSources || info.kind === "orphan") return "visible"
        return info.kind === "found" && info.row.hiddenType === "integer" && info.row.hidden === 0 ? "visible" : "excluded"
    }

    const articles: ScannedArticle[] = []
    const started = limits.clock()
    let upper = entry !== undefined ? entry.state.nextUpper : hi
    let examined = 0
    let oversizeSkipped = 0
    let notSearchedTooLarge = 0
    let notSearchedUnexpectedType = 0
    let bytesUsed = 0
    let textUsed = 0
    let windows = 0
    let lastConsumed: number | null = null

    // groupDuplicates (see the header): representatives of this page, copies reported, identity bytes loaded.
    const grouping = page.grouping
    const onPage = new Map<number, ScannedArticle>()
    const earlierCopies: EarlierCopy[] = []
    let copies = 0
    let notVerifiable = 0
    let identityUsed = 0

    const counters = () => ({
        articles,
        examined,
        oversizeSkipped,
        invalidDateExcluded,
        notSearchedTooLarge,
        notSearchedUnexpectedType,
        textBytes: textUsed,
        ...(grouping !== undefined && { grouping: { earlierCopies, copies, notVerifiable, identityBytes: identityUsed } }),
    })
    /** Searchable bytes phase B will load for a candidate (always 0 for list_articles). */
    const textOf = (c: { readonly textBytes?: number }): number => (search === undefined ? 0 : (c.textBytes ?? 0))

    for (;;) {
        if (windows > 0) {
            if (
                examined >= limits.callRows ||
                bytesUsed >= limits.callBytes ||
                windows >= limits.callWindows ||
                (search !== undefined && textUsed >= limits.searchCallBytes)
            ) {
                return result(false, "scanBudget", counters(), lastConsumed, lo, hi)
            }
            if (limits.clock() - started >= limits.timeBudgetMs) return result(false, "timeBudget", counters(), lastConsumed, lo, hi)
        }
        const asked = Math.min(limits.windowRows, limits.callRows - examined)
        const candidates = readScanCandidates(db, lo, upper, asked, search?.fields)
        windows++
        if (candidates.length === 0) return result(true, "exhausted", counters(), lastConsumed, lo, hi)
        const short = candidates.length < asked
        const first = candidates[0] as (typeof candidates)[number]

        if (first.bytes > ARTICLE_RECORD_BYTES_MAX) {
            // Consumed without evaluation: reading its flags would traverse the whole record.
            examined++
            oversizeSkipped++
            lastConsumed = first.id
            if (first.id === lo || (short && candidates.length === 1)) return result(true, "exhausted", counters(), lastConsumed, lo, hi)
            upper = first.id - 1
            continue
        }
        // The first record of the call always fits; later windows stop before a record over the call budget.
        if (bytesUsed > 0 && bytesUsed + first.bytes > limits.callBytes) return result(false, "scanBudget", counters(), lastConsumed, lo, hi)
        if (textUsed > 0 && textUsed + textOf(first) > limits.searchCallBytes) return result(false, "scanBudget", counters(), lastConsumed, lo, hi)
        const room = Math.min(limits.windowBytes, limits.callBytes - bytesUsed)
        const textRoom = Math.min(limits.searchWindowBytes, limits.searchCallBytes - textUsed)
        let accepted = 1
        let windowBytes = first.bytes
        let windowText = textOf(first)
        for (; accepted < candidates.length; accepted++) {
            const c = candidates[accepted] as (typeof candidates)[number]
            if (c.bytes > ARTICLE_RECORD_BYTES_MAX || windowBytes + c.bytes > room) break
            if (search !== undefined && windowText + textOf(c) > textRoom) break
            windowBytes += c.bytes
            windowText += textOf(c)
        }
        bytesUsed += windowBytes
        textUsed += windowText
        const lower = (candidates[accepted - 1] as (typeof candidates)[number]).id
        const rows = readEvaluation(db, lower, first.id, search?.fields)
        // Same transaction as phase A: exactly the accepted candidates, in the same order.
        if (rows.length !== accepted || rows.some((row, i) => row.id !== candidates[i]?.id)) throw new FrMcpError("INTERNAL_ERROR", "unexpected")

        const pre = rows.map(preMatch)
        // Search: the text of the rows that passed the filters, compared once per window (bounded by textRoom).
        const text = search === undefined ? undefined : rows.map((row, j): TextOutcome => (pre[j] === true ? search.match(row) : "none"))
        const eligible = rows.map((_, j) => pre[j] === true && (text === undefined || text[j] !== "none"))
        /** Rows that enter the page if their source is visible. */
        const wanted = rows.map((_, j) => eligible[j] === true && (text === undefined || (text[j] !== "tooLarge" && text[j] !== "unexpectedType")))
        let projection: Map<number, ProjectedRow> | undefined

        /**
         * groupDuplicates: identity of the matched row i, loading (G1 sizes,
         * G2 values) the matched rows of this window from i on that fit the
         * identity budgets; undefined when row i itself does not fit (the call
         * budget is spent: the page stops before it). Rows whose sizes or
         * storage classes decide their status cost nothing.
         */
        const identities = new Map<number, RowIdentity>()
        const identityAt = (spec: GroupingSpec, i: number): RowIdentity | undefined => {
            const row = rows[i] as EvaluatedRow
            const known = identities.get(row.id)
            if (known !== undefined) return known
            // The contract needs a safe-integer source; phase B gives one only for an INTEGER within ±(2^53−1).
            const loadable = (r: EvaluatedRow): boolean => r.sourceType === "integer" && r.source !== null
            if (!loadable(row)) {
                identities.set(row.id, INELIGIBLE)
                return INELIGIBLE
            }
            const pending = new Map<number, EvaluatedRow>()
            for (let j = i; j < rows.length; j++) {
                const r = rows[j] as EvaluatedRow
                if (wanted[j] === true && loadable(r) && !identities.has(r.id)) pending.set(r.id, r)
            }
            const sizes = readIdentitySizes(db, [...pending.keys()])
            const load: number[] = []
            let batchBytes = 0
            for (const id of pending.keys()) {
                const size = sizes.get(id)
                // Same transaction as phase B: the row exists and passed the same record limit.
                if (size === undefined) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
                const decided = classifyIdentitySizes(size)
                if (decided === "ineligible" || decided === "notVerifiable") {
                    identities.set(id, decided === "ineligible" ? INELIGIBLE : NOT_VERIFIABLE)
                    continue
                }
                const first = identityUsed === 0 && load.length === 0
                if (!first && (batchBytes + decided.load > limits.identityWindowBytes || identityUsed + batchBytes + decided.load > limits.identityCallBytes)) break
                load.push(id)
                batchBytes += decided.load
            }
            if (load.length > 0) {
                const values = readIdentityValues(db, load)
                for (const id of load) {
                    const v = values.get(id)
                    // Same transaction as the sizes: every value classified as loadable is there.
                    if (v === undefined || typeof v.title !== "string" || typeof v.snippet !== "string" || typeof v.link !== "string") {
                        throw new FrMcpError("INTERNAL_ERROR", "unexpected")
                    }
                    const found = identityOfFields({
                        id,
                        source: (pending.get(id) as EvaluatedRow).source,
                        synthetic: v.synthetic === 1,
                        time: timeOf(v.date),
                        link: v.link,
                        title: v.title,
                        snippet: v.snippet,
                    })
                    identities.set(id, found === null ? INELIGIBLE : { kind: "verified", fingerprint: spec.fingerprint(found.key), time: found.time })
                }
            }
            identityUsed += batchBytes
            return identities.get(row.id)
        }
        /** groupDuplicates: the page holds pageSize articles; only copies and excluded rows are still consumed in this window. */
        let full = false

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i] as EvaluatedRow
            let matched = false
            let visible = false
            if (eligible[i] === true) {
                const check = sourceCheck(rows, eligible, i)
                // Not evaluated: not consumed either, the next call starts with this row.
                if (check === "unresolved") return result(false, full ? "pageFull" : "scanBudget", counters(), lastConsumed, lo, hi)
                visible = check === "visible"
                matched = visible && wanted[i] === true
            }
            if (matched) {
                const sid = resolvable(row)
                const source = sid === null ? undefined : sources.get(sid)
                let identity: RowIdentity | undefined
                let story: RememberedGroup | undefined
                if (grouping !== undefined) {
                    identity = identityAt(grouping, i)
                    if (identity === undefined) return result(false, full ? "pageFull" : "scanBudget", counters(), lastConsumed, lo, hi)
                    if (identity.kind === "verified") story = grouping.memory.find(identity.fingerprint, identity.time, row.source as number)
                    // A full page takes no new article: this row is read again by the next call.
                    if (story === undefined && full) return result(false, "pageFull", counters(), lastConsumed, lo, hi)
                }
                if (grouping !== undefined && story !== undefined && identity?.kind === "verified") {
                    // A copy: reported under its story, never a new position.
                    const copy = toCopy(row, source, text?.[i] as SearchColumn | undefined)
                    const representative = onPage.get(story.representativeId)
                    let added = false
                    if (copies < DUPLICATE_COPIES_PAGE_MAX) {
                        if (representative?.duplicates !== undefined) {
                            added = page.budget.tryAddTo(representative.duplicates.copies.length, JSON.stringify(copy))
                            if (added) representative.duplicates.copies.push(copy)
                        } else {
                            const earlier: EarlierCopy = { representativeId: story.representativeId, ...copy }
                            added = page.budget.tryAddTo(earlierCopies.length, JSON.stringify(earlier))
                            if (added) earlierCopies.push(earlier)
                        }
                    }
                    if (!added) {
                        // Unreachable in practice (a copy entry is a few hundred units); kept for the same guarantee as articles.
                        if (articles.length === 0 && copies === 0) throw new FrMcpError("LIMIT_EXCEEDED", "response-too-large")
                        return result(false, "responseBudget", counters(), lastConsumed, lo, hi)
                    }
                    copies++
                    grouping.memory.join(story, identity.time, row.source as number)
                } else {
                    if (projection === undefined || !projection.has(row.id)) {
                        // The candidates of this window that can still enter the page, from this one on.
                        const ids = rows.filter((_, j) => j >= i && wanted[j] === true).slice(0, binding.pageSize - articles.length).map((r) => r.id)
                        projection = readProjection(db, ids, binding.excerptChars)
                    }
                    const projected = projection.get(row.id)
                    // Same transaction as phase B: the row exists and passed the same record limit.
                    if (projected === undefined) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
                    const listed = toArticle(row, projected, source, binding.excerptChars)
                    let article: ScannedArticle = text === undefined ? listed : { ...listed, matchedIn: text[i] as SearchColumn }
                    if (identity !== undefined) article = { ...article, duplicates: { identity: identityStatus(identity), copies: [] } }
                    if (!page.budget.tryAdd(JSON.stringify(article))) {
                        // A single article that cannot be returned even alone: stable error, no progress.
                        if (articles.length === 0 && copies === 0) throw new FrMcpError("LIMIT_EXCEEDED", "response-too-large")
                        return result(false, "responseBudget", counters(), lastConsumed, lo, hi)
                    }
                    articles.push(article)
                    if (grouping !== undefined && identity?.kind === "verified") {
                        grouping.memory.open(row.id, identity.fingerprint, identity.time, row.source as number)
                        onPage.set(row.id, article)
                    }
                    if (identity?.kind === "notVerifiable") notVerifiable++
                }
            } else if (pre[i] === "invalidDate") {
                invalidDateExcluded++
            } else if (visible && text?.[i] === "tooLarge") {
                notSearchedTooLarge++
            } else if (visible && text?.[i] === "unexpectedType") {
                notSearchedUnexpectedType++
            }
            examined++
            lastConsumed = row.id
            if (articles.length === binding.pageSize && !full) {
                if (grouping !== undefined) {
                    full = true
                    continue
                }
                const end = row.id === lo || (short && accepted === candidates.length && i === rows.length - 1)
                return result(end, "pageFull", counters(), lastConsumed, lo, hi)
            }
        }
        const end = lower === lo || (short && accepted === candidates.length)
        // groupDuplicates: a full page whose window was consumed to its end.
        if (full) return result(end, "pageFull", counters(), lastConsumed, lo, hi)
        if (end) return result(true, "exhausted", counters(), lastConsumed, lo, hi)
        upper = lower - 1
    }
}

function identityStatus(identity: RowIdentity): DuplicateIdentityStatus {
    return identity.kind
}

/** A copy as reported (groupDuplicates): ids, source, date and read state, nothing of its text. */
function toCopy(row: EvaluatedRow, source: SourceInfo | undefined, matchedIn: SearchColumn | undefined): ScannedCopy {
    let sourceName: string | null = null
    let truncated = false
    if (source?.kind === "found" && source.row.nameType === "text" && source.row.namePrefix !== null) {
        sourceName = source.row.namePrefix
        truncated = source.row.nameCut === 1
    }
    const date = row.dateType === "integer" && row.date !== null && Math.abs(row.date) <= DATE_MS_MAX ? new Date(row.date).toISOString() : null
    const read = row.hasReadType === "integer" && (row.hasRead === 0 || row.hasRead === 1) ? row.hasRead === 1 : null
    const copy: ScannedCopy = {
        articleId: row.id,
        // Copies have an INTEGER source (identity); a negative one is reported as null, as for articles.
        sourceId: row.source !== null && row.source >= 0 ? row.source : null,
        sourceName,
        ...(truncated && { sourceNameTruncated: true as const }),
        date,
        read,
    }
    if (matchedIn !== undefined) copy.matchedIn = matchedIn
    return copy
}

function toArticle(row: EvaluatedRow, projected: ProjectedRow, source: SourceInfo | undefined, excerptChars: number): ListedArticle {
    const issues: ArticleFieldIssue[] = []
    const issue = (field: ArticleFieldIssue["field"], storageClass: StorageClass | null, kind?: ArticleFieldIssue["issue"]): null => {
        issues.push({ field, issue: kind ?? (storageClass === "null" ? "unexpectedNull" : "unexpectedType"), storageClass })
        return null
    }
    const integer = (field: ArticleFieldIssue["field"], type: StorageClass, value: number | null): number | null => {
        if (type !== "integer") return issue(field, type)
        return value ?? issue(field, type, "unexpectedValue")
    }
    const flag = (field: "hasRead" | "starred" | "hidden", type: StorageClass, value: number | null): boolean | null => {
        const n = integer(field, type, value)
        if (n === null) return null
        return n === 1 ? true : n === 0 ? false : issue(field, "integer", "unexpectedValue")
    }
    const date = (field: "date" | "fetchedDate", type: StorageClass, value: number | null): string | null => {
        const n = integer(field, type, value)
        if (n === null) return null
        return Math.abs(n) <= DATE_MS_MAX ? new Date(n).toISOString() : issue(field, "integer", "unexpectedValue")
    }
    const text = (field: "title" | "creator", type: StorageClass, bytes: number | null, prefix: string | null, nullable: boolean): string | null => {
        if (type === "null" && nullable) return null
        if (type !== "text") return issue(field, type)
        if ((bytes ?? 0) > FIELD_BYTES_MAX) return issue(field, "text", "tooLarge")
        return prefix ?? issue(field, type, "unexpectedValue")
    }

    let sourceId: number | null = null
    let orphan: boolean | null = null
    let sourceName: string | null = null
    let sourceNameTruncated = false
    if (row.sourceType !== "integer" || row.source === null || row.source < 0) {
        issue("source", row.sourceType, row.sourceType === "integer" ? "unexpectedValue" : undefined)
    } else {
        sourceId = row.source
        orphan = source?.kind === "orphan"
        if (source?.kind === "tooLarge") issue("sourceName", null, "tooLarge")
        if (source?.kind === "found") {
            const r = source.row
            if (r.nameType !== "text") issue("sourceName", r.nameType)
            else if (r.namePrefix === null) issue("sourceName", "text", "unexpectedValue")
            else {
                sourceName = r.namePrefix
                sourceNameTruncated = r.nameCut === 1
            }
        }
    }

    const title = text("title", projected.titleType, projected.titleBytes, projected.titlePrefix, false)
    const creator = text("creator", projected.creatorType, projected.creatorBytes, projected.creatorPrefix, true)
    const dateIso = date("date", row.dateType, row.date)
    const fetchedDate = date("fetchedDate", row.fetchedDateType, row.fetchedDate)
    const read = flag("hasRead", row.hasReadType, row.hasRead)
    const starred = flag("starred", row.starredType, row.starred)
    const hidden = flag("hidden", row.hiddenType, row.hidden)

    let excerpt: string | null = null
    let excerptTruncated = false
    if (excerptChars > 0) {
        if (projected.snippetType !== "text") issue("snippet", projected.snippetType)
        else if ((projected.snippetBytes ?? 0) > EXCERPT_SOURCE_BYTES_MAX) issue("snippet", "text", "tooLarge")
        else if (projected.excerpt === null) issue("snippet", "text", "unexpectedValue")
        else {
            excerpt = projected.excerpt
            excerptTruncated = projected.excerptCut === 1
        }
    }

    const article: ListedArticle = {
        articleId: row.id,
        sourceId,
        sourceName,
        orphan,
        title,
        titleTruncated: title !== null && projected.titleCut === 1,
        date: dateIso,
        dateValid: dateIso !== null,
        fetchedDate,
        creator,
        read,
        starred,
        hidden,
        excerpt,
        excerptTruncated,
        untrusted: true,
    }
    if (sourceNameTruncated) article.sourceNameTruncated = true
    if (creator !== null && projected.creatorCut === 1) article.creatorTruncated = true
    if (issues.length > 0) article.fieldIssues = issues
    return article
}

export async function listArticles(context: ToolContext, args: unknown, limits: ScanLimits = DEFAULT_SCAN_LIMITS): Promise<CallToolResult> {
    const input = parseArgs(listArticlesInput, args)
    return context.cursors.exclusive(() => run(context, input, limits))
}

async function run(context: ToolContext, input: ListArticlesInput, limits: ScanLimits): Promise<CallToolResult> {
    let entry: CursorEntry<ScanState> | undefined
    let binding: Binding
    if (input.cursor !== undefined) {
        entry = context.cursors.resolve<ScanState>(input.cursor, LIST_ARTICLES)
        binding = entry.binding as Binding
        checkBinding(input, normalize(input), binding)
        if (entry.response !== undefined) return JSON.parse(entry.response) as CallToolResult
    } else {
        binding = normalize(input)
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

    const meta: ListArticlesOutput["meta"] = {
        generatedAt: new Date(context.now()).toISOString(),
        schemaVersion: RESULT_SCHEMA_VERSION,
        urlsRedacted: true,
    }
    const grouped = binding.groupDuplicates
    // Every page-dependent field at its longest serialization.
    const skeleton: ListArticlesOutput = {
        articles: [],
        ...(grouped && { earlierCopies: [] }),
        sort: binding.sort,
        pageSize: binding.pageSize,
        hasMore: false,
        nextCursor: "x".repeat(CURSOR_TOKEN_LENGTH),
        scan: {
            examined: Number.MAX_SAFE_INTEGER,
            exhausted: false,
            stoppedBy: LONGEST_STOPPED_BY,
            oversizeSkipped: Number.MAX_SAFE_INTEGER,
            invalidDateExcluded: Number.MAX_SAFE_INTEGER,
        },
        ...(grouped && { grouping: GROUPING_SKELETON }),
        consistency: ARTICLE_LIST_CONSISTENCY,
        meta,
    }
    const budget = new PageBudget(resultLength(skeleton))
    const grouping = grouped ? startGrouping(context, entry, limits) : undefined

    let page: PageResult
    try {
        page = await context.database.withReadConnection((db) =>
            scanPage(db, { binding, entry, filterSids, groupRevision, limits, identity: context.identity, budget, ...(grouping !== undefined && { grouping }) }),
        )
    } catch (error) {
        if (isFrMcpError(error) && error.code === "CURSOR_STALE" && input.cursor !== undefined) context.cursors.invalidate(input.cursor)
        throw error
    }

    const pageGrouping = page.grouping ?? NO_PAGE_GROUPING
    const finished = grouping === undefined ? undefined : finishGrouping(grouping, pageGrouping, entry, page.exhausted)
    const nextCursor =
        page.next === null
            ? null
            : context.cursors.create<ScanState>(
                  LIST_ARTICLES,
                  binding,
                  finished === undefined ? page.next : { ...page.next, grouping: finished.state },
                  entry?.scanStartedAt ?? context.now(),
                  successorOptions(finished, entry),
              )
    const payload: ListArticlesOutput = {
        articles: page.articles,
        ...(finished !== undefined && { earlierCopies: pageGrouping.earlierCopies }),
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
        ...(finished !== undefined && { grouping: finished.output }),
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
    if (entry !== undefined) context.cursors.publish(entry, built.serialized, nextCursor)
    return built.result
}
