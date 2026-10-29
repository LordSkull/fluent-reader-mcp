/**
 * Windowed scan of `items` for list_articles (FR-MCP-01 §11.3, §14.5,
 * adapted to the FR-MCP-02B-01 contract). Every statement is static,
 * parameterized and addressed by the primary key `_id` (rowid alias): range
 * lookups bounded by LIMIT or by a closed range already measured, or point
 * lookups through json_each. Never OFFSET, COUNT, a join, a sort on another
 * column, or a statement whose filters decide how many rows it visits.
 *
 * Per window, inside one read transaction (one withReadConnection call):
 *  A. candidates: the next `limit` ids of [lo, upper], descending, with the
 *     estimated bytes of each record. Only the record header is needed:
 *     typeof() and octet_length() of TEXT/BLOB values take type and size from
 *     it without loading the value [SQLite docs], and other storage classes
 *     are counted as a fixed 8 bytes, so this phase never traverses content.
 *  B. evaluation: the fixed-size columns the filters need (source, date,
 *     fetchedDate, hasRead, starred, hidden) for the closed range [L, U] of
 *     the candidates accepted by the byte budgets. Reading the flags traverses
 *     the record, so its cost is bounded by the bytes measured in A. The
 *     record limit is repeated in the WHERE clause.
 *  C. projection: title, creator and the excerpt, as bounded prefixes, only
 *     for the matching articles that can enter the page (at most pageSize).
 * Filters are evaluated in JavaScript on the values of phase B: no SQL is
 * built from input, and the number of rows a statement visits never depends
 * on how selective the filters are.
 *
 * Integers are read with the protected projection of §11.3.6 (compared in
 * SQL, so node:sqlite never sees an unsafe integer); text values only when
 * their storage class is TEXT and their size is within the field limit.
 */

import type { ReadOnlyDatabase } from "../db/connection.js"
import { FrMcpError } from "../errors.js"
import { ARTICLE_RECORD_BYTES_MAX, FIELD_BYTES_MAX } from "./articles.js"
import { RECORD_BYTES_MAX, type StorageClass } from "./sources.js"

const MAX_SAFE = "9007199254740991"
const RECORD_OVERHEAD = 64
/** Bytes counted for a value that is not TEXT or BLOB (an integer or real takes at most 8). */
const FIXED_VALUE_BYTES = 8

/** Every stored column of `items` but the rowid alias `_id`, in record order. */
const ITEM_COLUMNS = [
    "source",
    "guid",
    "title",
    "link",
    "date",
    "fetchedDate",
    "thumb",
    "content",
    "snippet",
    "creator",
    "hasRead",
    "starred",
    "hidden",
    "notify",
    "serviceRef",
] as const

/**
 * Estimated bytes of a whole record from its header only. Each term is at
 * most SQLITE_MAX_LENGTH (< 2^31), so the sum stays far below 2^53.
 */
const HEADER_BYTES = [
    String(RECORD_OVERHEAD),
    ...ITEM_COLUMNS.map((c) => `(CASE WHEN typeof(${c}) IN ('text', 'blob') THEN octet_length(${c}) ELSE ${FIXED_VALUE_BYTES} END)`),
].join(" + ")

/** Maximum code points of the title, creator and source name returned. */
export const TITLE_CHARS_MAX = 300
export const CREATOR_CHARS_MAX = 200
export const SOURCE_NAME_CHARS_MAX = 300
/** A snippet larger than this gives no excerpt: SQLite would load it whole to cut a prefix. */
export const EXCERPT_SOURCE_BYTES_MAX = 1024 * 1024
/**
 * A feed URL larger than this is never loaded: the identity of its source
 * cannot be verified, and a listing filtered on it cannot be continued
 * (fail-closed, see list-articles.ts).
 */
export const URL_DIGEST_BYTES_MAX = 64 * 1024

/** Every column of a `sources` record up to `hidden`, the last one read here, in record order (`sid` is the rowid). */
const SOURCE_COLUMNS = ["url", "iconurl", "name", "openTarget", "lastFetched", "serviceRef", "fetchFrequency", "textDir", "hidden"] as const
const SOURCE_RECORD_OVERHEAD = 32

/**
 * Estimated bytes of a `sources` record from its header only, as
 * HEADER_BYTES for `items`. Reading `hidden` (the last column) traverses
 * at most this many bytes.
 */
const SOURCE_HEADER_BYTES = [
    String(SOURCE_RECORD_OVERHEAD),
    ...SOURCE_COLUMNS.map((c) => `(CASE WHEN typeof(${c}) IN ('text', 'blob') THEN octet_length(${c}) ELSE ${FIXED_VALUE_BYTES} END)`),
].join(" + ")

function safeInteger(column: string): string {
    return `typeof(${column}) AS ${column}Type, CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN -${MAX_SAFE} AND ${MAX_SAFE} THEN ${column} END AS ${column}`
}

/** A prefix of at most `chars` code points of a TEXT value within FIELD_BYTES_MAX, and whether it is shorter. */
function boundedPrefix(column: string, chars: string, bytesMax: string | number): string {
    const ok = `typeof(${column}) = 'text' AND octet_length(${column}) <= ${bytesMax}`
    const prefix = `substr(${column}, 1, ${chars})`
    return (
        `typeof(${column}) AS ${column}Type, octet_length(${column}) AS ${column}Bytes, ` +
        `CASE WHEN ${ok} THEN ${prefix} END AS ${column}Prefix, ` +
        `CASE WHEN ${ok} THEN octet_length(${prefix}) < octet_length(${column}) END AS ${column}Cut`
    )
}

/** Static SQL of this module (exported for plan and audit tests). */
export const SCAN_SQL = {
    schemaVersion: "PRAGMA schema_version",
    /** MIN/MAX of the primary key (two O(log n) lookups), range-checked in SQL. */
    bounds:
        `SELECT b.lo IS NULL AS empty, ` +
        `CASE WHEN b.lo >= 1 AND b.hi <= ${MAX_SAFE} THEN b.lo END AS lo, ` +
        `CASE WHEN b.lo >= 1 AND b.hi <= ${MAX_SAFE} THEN b.hi END AS hi ` +
        `FROM (SELECT (SELECT MIN(_id) FROM items) AS lo, (SELECT MAX(_id) FROM items) AS hi) AS b`,
    candidates: `SELECT _id AS id, ${HEADER_BYTES} AS bytes FROM items WHERE _id BETWEEN ? AND ? ORDER BY _id DESC LIMIT ?`,
    evaluate:
        `SELECT _id AS id, ${safeInteger("source")}, ${safeInteger("date")}, ${safeInteger("fetchedDate")}, ` +
        `${safeInteger("hasRead")}, ${safeInteger("starred")}, ${safeInteger("hidden")} ` +
        `FROM items WHERE _id BETWEEN ? AND ? AND ${HEADER_BYTES} <= ${ARTICLE_RECORD_BYTES_MAX} ORDER BY _id DESC`,
    project:
        `SELECT _id AS id, ` +
        `${boundedPrefix("title", String(TITLE_CHARS_MAX), FIELD_BYTES_MAX)}, ` +
        `${boundedPrefix("creator", String(CREATOR_CHARS_MAX), FIELD_BYTES_MAX)}, ` +
        `typeof(snippet) AS snippetType, octet_length(snippet) AS snippetBytes, ` +
        `CASE WHEN :chars > 0 AND typeof(snippet) = 'text' AND octet_length(snippet) <= ${EXCERPT_SOURCE_BYTES_MAX} ` +
        `THEN substr(snippet, 1, :chars) END AS excerpt, ` +
        `CASE WHEN :chars > 0 AND typeof(snippet) = 'text' AND octet_length(snippet) <= ${EXCERPT_SOURCE_BYTES_MAX} ` +
        `THEN octet_length(substr(snippet, 1, :chars)) < octet_length(snippet) END AS excerptCut ` +
        `FROM items WHERE _id IN (SELECT value FROM json_each(:ids)) AND ${HEADER_BYTES} <= ${ARTICLE_RECORD_BYTES_MAX}`,
    /**
     * Header-derived fingerprint of one row (the scan position), to detect a
     * restore that replaced it between pages. No value is loaded: only types
     * and sizes, plus `source`, `date` and `fetchedDate`, which precede the
     * large columns.
     */
    position:
        `SELECT ${safeInteger("source")}, ${safeInteger("date")}, ${safeInteger("fetchedDate")}, ` +
        ITEM_COLUMNS.map((c) => `typeof(${c}) AS ${c}T, CASE WHEN typeof(${c}) IN ('text', 'blob') THEN octet_length(${c}) END AS ${c}B`).join(", ") +
        ` FROM items WHERE _id = ?`,
    /** S1 of the article sources: estimated record bytes, from the header only (no value is loaded). */
    sourceSizes: `SELECT sid, ${SOURCE_HEADER_BYTES} AS bytes FROM sources WHERE sid IN (SELECT value FROM json_each(?))`,
    /**
     * S2 of the article sources: only `hidden` and a prefix of `name`. `url`,
     * `iconurl` and `serviceRef` are traversed (counted in S1's bytes) but
     * never loaded. The record limit is repeated in the WHERE clause.
     */
    sourceInfo:
        `SELECT sid, ${SOURCE_HEADER_BYTES} AS bytes, ` +
        `typeof(hidden) AS hiddenType, CASE WHEN typeof(hidden) = 'integer' AND hidden IN (0, 1) THEN hidden END AS hidden, ` +
        `${boundedPrefix("name", String(SOURCE_NAME_CHARS_MAX), RECORD_BYTES_MAX)} ` +
        `FROM sources WHERE sid IN (SELECT value FROM json_each(?)) AND ${SOURCE_HEADER_BYTES} <= ${RECORD_BYTES_MAX}`,
    /** Type and size of the feed URL of each given source, from the header only (identity fingerprint, S1). */
    sourceUrlSizes: `SELECT sid, typeof(url) AS urlType, octet_length(url) AS urlBytes FROM sources WHERE sid IN (SELECT value FROM json_each(?))`,
    /**
     * Exact stored bytes of the feed URL of each given source (identity
     * fingerprint, S2; never returned). Only TEXT or BLOB values within
     * URL_DIGEST_BYTES_MAX are loaded; the limit is repeated here.
     */
    sourceUrls:
        `SELECT sid, CAST(url AS BLOB) AS url FROM sources WHERE sid IN (SELECT value FROM json_each(?)) ` +
        `AND typeof(url) IN ('text', 'blob') AND octet_length(url) <= ${URL_DIGEST_BYTES_MAX}`,
} as const

export interface ScanCandidate {
    readonly id: number
    /** Estimated bytes of the record (phase A). */
    readonly bytes: number
}

/** One row of phase B. */
export interface EvaluatedRow {
    readonly id: number
    readonly sourceType: StorageClass
    readonly source: number | null
    readonly dateType: StorageClass
    readonly date: number | null
    readonly fetchedDateType: StorageClass
    readonly fetchedDate: number | null
    readonly hasReadType: StorageClass
    readonly hasRead: number | null
    readonly starredType: StorageClass
    readonly starred: number | null
    readonly hiddenType: StorageClass
    readonly hidden: number | null
}

/** One row of phase C. */
export interface ProjectedRow {
    readonly id: number
    readonly titleType: StorageClass
    readonly titleBytes: number | null
    readonly titlePrefix: string | null
    readonly titleCut: number | null
    readonly creatorType: StorageClass
    readonly creatorBytes: number | null
    readonly creatorPrefix: string | null
    readonly creatorCut: number | null
    readonly snippetType: StorageClass
    readonly snippetBytes: number | null
    readonly excerpt: string | null
    readonly excerptCut: number | null
}

export interface SourceSizeRow {
    readonly sid: number
    readonly bytes: number
}

/** One row of the article sources' S2. */
export interface SourceInfoRow {
    readonly sid: number
    readonly bytes: number
    readonly hiddenType: StorageClass
    /** 0 or 1; null for any other value or type. */
    readonly hidden: number | null
    readonly nameType: StorageClass
    readonly nameBytes: number | null
    readonly namePrefix: string | null
    readonly nameCut: number | null
}

export interface SourceUrlSize {
    readonly urlType: StorageClass
    /** octet_length(url): byte size for TEXT and BLOB; null for NULL. */
    readonly urlBytes: number | null
}

export function readScanSchemaVersion(db: ReadOnlyDatabase): number {
    const version = (db.prepare(SCAN_SQL.schemaVersion).get() as { schema_version?: unknown } | undefined)?.schema_version
    if (typeof version !== "number") throw new FrMcpError("INTERNAL_ERROR", "unexpected")
    return version
}

/**
 * MIN(_id) and MAX(_id); null for an empty table. Ids outside [1, 2^53−1]
 * are ID_RANGE_UNSUPPORTED: get_article accepts ids >= 1 only, and a larger
 * id cannot be represented exactly in JSON.
 */
export function readIdBounds(db: ReadOnlyDatabase): { lo: number; hi: number } | null {
    const row = db.prepare(SCAN_SQL.bounds).get() as { empty: number; lo: number | null; hi: number | null }
    if (row.empty === 1) return null
    if (row.lo === null || row.hi === null) throw new FrMcpError("ID_RANGE_UNSUPPORTED", "article-id-out-of-range")
    return { lo: row.lo, hi: row.hi }
}

/** Phase A: at most `limit` ids of [lower, upper], descending, with their estimated bytes. */
export function readScanCandidates(db: ReadOnlyDatabase, lower: number, upper: number, limit: number): ScanCandidate[] {
    return db.prepare(SCAN_SQL.candidates).all(lower, upper, limit) as unknown as ScanCandidate[]
}

/** Phase B on the closed range [lower, upper], descending. */
export function readEvaluation(db: ReadOnlyDatabase, lower: number, upper: number): EvaluatedRow[] {
    return db.prepare(SCAN_SQL.evaluate).all(lower, upper) as unknown as EvaluatedRow[]
}

/** Phase C for the given ids (point lookups); `chars` 0 reads no excerpt. */
export function readProjection(db: ReadOnlyDatabase, ids: readonly number[], chars: number): Map<number, ProjectedRow> {
    const rows = db.prepare(SCAN_SQL.project).all({ ids: JSON.stringify(ids), chars }) as unknown as ProjectedRow[]
    return new Map(rows.map((row) => [row.id, row]))
}

/** Position fingerprint input of one row, or undefined when the row no longer exists. */
export function readPosition(db: ReadOnlyDatabase, id: number): Record<string, unknown> | undefined {
    return db.prepare(SCAN_SQL.position).get(id) as Record<string, unknown> | undefined
}

/** Header-only sizes of the given sids that exist (point lookups). */
export function readSourceSizes(db: ReadOnlyDatabase, sids: readonly number[]): Map<number, number> {
    const rows = db.prepare(SCAN_SQL.sourceSizes).all(JSON.stringify(sids)) as unknown as SourceSizeRow[]
    return new Map(rows.map((row) => [row.sid, row.bytes]))
}

/** `hidden` and the name prefix of the given sids (each within RECORD_BYTES_MAX). */
export function readSourceInfo(db: ReadOnlyDatabase, sids: readonly number[]): Map<number, SourceInfoRow> {
    const rows = db.prepare(SCAN_SQL.sourceInfo).all(JSON.stringify(sids)) as unknown as SourceInfoRow[]
    return new Map(rows.map((row) => [row.sid, row]))
}

/** Header-only type and size of the feed URL of the given sids that exist (point lookups). */
export function readSourceUrlSizes(db: ReadOnlyDatabase, sids: readonly number[]): Map<number, SourceUrlSize> {
    const rows = db.prepare(SCAN_SQL.sourceUrlSizes).all(JSON.stringify(sids)) as unknown as (SourceUrlSize & { sid: number })[]
    return new Map(rows.map((row) => [row.sid, { urlType: row.urlType, urlBytes: row.urlBytes }]))
}

/** Exact bytes of the TEXT or BLOB feed URLs within URL_DIGEST_BYTES_MAX of the given sids. */
export function readSourceUrls(db: ReadOnlyDatabase, sids: readonly number[]): Map<number, Uint8Array> {
    const rows = db.prepare(SCAN_SQL.sourceUrls).all(JSON.stringify(sids)) as unknown as { sid: number; url: Uint8Array }[]
    return new Map(rows.map((row) => [row.sid, row.url]))
}
