/**
 * list_articles (FR-MCP-01 §11.3, §11.5, §14.5, adapted to the
 * FR-MCP-02B-01 contract).
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
 */

import crypto from "node:crypto"
import { performance } from "node:perf_hooks"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError, isFrMcpError } from "../errors.js"
import type { ReadOnlyDatabase } from "../db/connection.js"
import { ARTICLE_RECORD_BYTES_MAX, FIELD_BYTES_MAX } from "../domain/articles.js"
import {
    EXCERPT_SOURCE_BYTES_MAX,
    readEvaluation,
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
    type SourceInfoRow,
} from "../domain/article-scan.js"
import { BATCH_BYTES_MAX, RECORD_BYTES_MAX, type StorageClass } from "../domain/sources.js"
import { CURSOR_TOKEN_LENGTH, type CursorEntry } from "../scan/cursors.js"
import type { SourceIdentity } from "../scan/identity.js"
import { loadGroups, type ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { PageBudget, resultLength, successResult } from "./result.js"
import {
    ARTICLE_LIST_CONSISTENCY,
    ARTICLE_PAGE_SIZE_DEFAULT,
    EXCERPT_CHARS_DEFAULT,
    listArticlesInput,
    parseInstant,
    RESULT_SCHEMA_VERSION,
    type ArticleFieldIssue,
    type ListArticlesInput,
    type ListArticlesOutput,
    type ListedArticle,
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
const LONGEST_STOPPED_BY = STOPPED_BY.reduce((a, b) => (b.length > a.length ? b : a))

interface Binding {
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
}

interface ScanState {
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
}

function normalize(input: ListArticlesInput): Binding {
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
    }
}

/** Arguments repeated with a cursor must equal (after normalization) those the listing started with. */
function checkBinding(input: ListArticlesInput, binding: Binding): void {
    const given = normalize(input)
    for (const key of Object.keys(given)) {
        if (input[key as keyof ListArticlesInput] !== undefined && given[key] !== binding[key]) {
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

interface PageInput {
    readonly binding: Binding
    readonly entry: CursorEntry<ScanState> | undefined
    readonly filterSids: readonly number[] | null
    readonly groupRevision: string | null
    readonly limits: ScanLimits
    readonly identity: SourceIdentity
    readonly budget: PageBudget
}

interface PageResult {
    readonly articles: ListedArticle[]
    readonly examined: number
    readonly oversizeSkipped: number
    readonly invalidDateExcluded: number
    readonly exhausted: boolean
    readonly stoppedBy: StoppedBy
    /** State of the successor cursor; null when exhausted. */
    readonly next: ScanState | null
}

/** One page, synchronously inside one read transaction. */
function scanPage(db: ReadOnlyDatabase, page: PageInput): PageResult {
    const { binding, entry, limits } = page
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
    const empty = { articles: [], examined: 0, oversizeSkipped: 0, invalidDateExcluded: 0 }

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
    const sourceCheck = (rows: readonly EvaluatedRow[], pre: readonly (boolean | "invalidDate")[], i: number): "visible" | "excluded" | "unresolved" => {
        const row = rows[i] as EvaluatedRow
        if (row.sourceType !== "integer") return "visible"
        if (row.source === null) return binding.includeHiddenSources ? "visible" : "excluded"
        if (!sources.has(row.source)) {
            const ahead: number[] = [row.source]
            for (let j = i + 1; j < rows.length && ahead.length < SOURCE_LOOKAHEAD; j++) {
                const sid = pre[j] === true ? resolvable(rows[j] as EvaluatedRow) : null
                if (sid !== null && !sources.has(sid) && !ahead.includes(sid)) ahead.push(sid)
            }
            resolveSources(ahead)
        }
        const info = sources.get(row.source)
        if (info === undefined) return "unresolved"
        if (binding.includeHiddenSources || info.kind === "orphan") return "visible"
        return info.kind === "found" && info.row.hiddenType === "integer" && info.row.hidden === 0 ? "visible" : "excluded"
    }

    const articles: ListedArticle[] = []
    const started = limits.clock()
    let upper = entry !== undefined ? entry.state.nextUpper : hi
    let examined = 0
    let oversizeSkipped = 0
    let bytesUsed = 0
    let windows = 0
    let lastConsumed: number | null = null
    const counters = () => ({ articles, examined, oversizeSkipped, invalidDateExcluded })

    for (;;) {
        if (windows > 0) {
            if (examined >= limits.callRows || bytesUsed >= limits.callBytes || windows >= limits.callWindows) {
                return result(false, "scanBudget", counters(), lastConsumed, lo, hi)
            }
            if (limits.clock() - started >= limits.timeBudgetMs) return result(false, "timeBudget", counters(), lastConsumed, lo, hi)
        }
        const asked = Math.min(limits.windowRows, limits.callRows - examined)
        const candidates = readScanCandidates(db, lo, upper, asked)
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
        const room = Math.min(limits.windowBytes, limits.callBytes - bytesUsed)
        let accepted = 1
        let windowBytes = first.bytes
        for (; accepted < candidates.length; accepted++) {
            const c = candidates[accepted] as (typeof candidates)[number]
            if (c.bytes > ARTICLE_RECORD_BYTES_MAX || windowBytes + c.bytes > room) break
            windowBytes += c.bytes
        }
        bytesUsed += windowBytes
        const lower = (candidates[accepted - 1] as (typeof candidates)[number]).id
        const rows = readEvaluation(db, lower, first.id)
        // Same transaction as phase A: exactly the accepted candidates, in the same order.
        if (rows.length !== accepted || rows.some((row, i) => row.id !== candidates[i]?.id)) throw new FrMcpError("INTERNAL_ERROR", "unexpected")

        const pre = rows.map(preMatch)
        let projection: Map<number, ProjectedRow> | undefined

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i] as EvaluatedRow
            let matched = false
            if (pre[i] === true) {
                const check = sourceCheck(rows, pre, i)
                // Not evaluated: not consumed either, the next call starts with this row.
                if (check === "unresolved") return result(false, "scanBudget", counters(), lastConsumed, lo, hi)
                matched = check === "visible"
            }
            if (matched) {
                if (projection === undefined || !projection.has(row.id)) {
                    // The candidates of this window that can still enter the page, from this one on.
                    const ids = rows.filter((_, j) => j >= i && pre[j] === true).slice(0, binding.pageSize - articles.length).map((r) => r.id)
                    projection = readProjection(db, ids, binding.excerptChars)
                }
                const projected = projection.get(row.id)
                // Same transaction as phase B: the row exists and passed the same record limit.
                if (projected === undefined) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
                const sid = resolvable(row)
                const article = toArticle(row, projected, sid === null ? undefined : sources.get(sid), binding.excerptChars)
                if (!page.budget.tryAdd(JSON.stringify(article))) {
                    // A single article that cannot be returned even alone: stable error, no progress.
                    if (articles.length === 0) throw new FrMcpError("LIMIT_EXCEEDED", "response-too-large")
                    return result(false, "responseBudget", counters(), lastConsumed, lo, hi)
                }
                articles.push(article)
            } else if (pre[i] === "invalidDate") {
                invalidDateExcluded++
            }
            examined++
            lastConsumed = row.id
            if (articles.length === binding.pageSize) {
                const end = row.id === lo || (short && accepted === candidates.length && i === rows.length - 1)
                return result(end, "pageFull", counters(), lastConsumed, lo, hi)
            }
        }
        if (lower === lo || (short && accepted === candidates.length)) return result(true, "exhausted", counters(), lastConsumed, lo, hi)
        upper = lower - 1
    }
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
        checkBinding(input, binding)
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
    // Every page-dependent field at its longest serialization.
    const skeleton: ListArticlesOutput = {
        articles: [],
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
        consistency: ARTICLE_LIST_CONSISTENCY,
        meta,
    }
    const budget = new PageBudget(resultLength(skeleton))

    let page: PageResult
    try {
        page = await context.database.withReadConnection((db) =>
            scanPage(db, { binding, entry, filterSids, groupRevision, limits, identity: context.identity, budget }),
        )
    } catch (error) {
        if (isFrMcpError(error) && error.code === "CURSOR_STALE" && input.cursor !== undefined) context.cursors.invalidate(input.cursor)
        throw error
    }

    const nextCursor =
        page.next === null ? null : context.cursors.create(LIST_ARTICLES, binding, page.next, entry?.scanStartedAt ?? context.now())
    const payload: ListArticlesOutput = {
        articles: page.articles,
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
