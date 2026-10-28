/**
 * Reading one row of `items` for get_article (FR-MCP-01 §5.2, §11.3.6,
 * §14.6). Every statement is static and addressed by the primary key
 * (`WHERE _id = :id`); no scan, join, COUNT, OFFSET or ORDER BY on `items`.
 *
 * Two phases inside one read transaction (one withReadConnection call):
 *  A. Preflight: storage classes and octet_length() of the columns, plus the
 *     estimated bytes of the whole record. octet_length() and typeof() take
 *     size and type from the record header without loading the value
 *     [SQLite docs], so nothing large is loaded here.
 *  B. Segment: the metadata that passed the preflight and at most `chars`
 *     characters of the body column (`snippet` for text, `content` for html),
 *     returned as the exact bytes of `substr()` cast to BLOB. The full body
 *     column is never projected, so node:sqlite never receives it; only the
 *     segment crosses into JavaScript. SQLite itself loads the column into
 *     its own memory to evaluate length()/substr()/instr(): that is bounded by
 *     BODY_BYTES_MAX, and the whole record (whose traversal is needed to read
 *     the columns after `content`) by ARTICLE_RECORD_BYTES_MAX. Phase B
 *     repeats both conditions in its WHERE clause.
 *
 * Characters: in a UTF-8 database SQLite's length() and substr() count
 * characters as UTF-8 sequences, which are Unicode code points for valid
 * UTF-8 and never split one. Three cases do not segment correctly and make
 * the body unavailable instead: a NUL character (SQLite's text functions stop
 * at the first NUL, so the rest would be unreachable), segments whose bytes
 * exceed 4 per character, and segments that are not valid UTF-8 (both only
 * possible when an external tool stored invalid bytes as TEXT). Validation
 * covers the requested segment only, not the whole stored text.
 * The capability gate (checkTextCapability) verifies the encoding and these
 * semantics on every call before anything is read.
 */

import { FrMcpError } from "../errors.js"
import type { ReadOnlyDatabase } from "../db/connection.js"
import type { StorageClass } from "./sources.js"

/** Records estimated above this are not read (their traversal reads every byte). */
export const ARTICLE_RECORD_BYTES_MAX = 16 * 1024 * 1024
/** A body column above this is not segmented: SQLite would load it whole to count characters. */
export const BODY_BYTES_MAX = 8 * 1024 * 1024
/** Title and creator above this are not loaded (null with a tooLarge field issue). */
export const FIELD_BYTES_MAX = 16 * 1024
/** Bytes of one character in valid UTF-8, at most. */
const UTF8_CHAR_BYTES_MAX = 4
const RECORD_OVERHEAD = 64
const MAX_SAFE = "9007199254740991"

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

const RECORD_BYTES = [String(RECORD_OVERHEAD), ...ITEM_COLUMNS.map((column) => `coalesce(octet_length(${column}), 0)`)].join(" + ")

function safeInteger(column: string): string {
    return `typeof(${column}) AS ${column}Type, CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN -${MAX_SAFE} AND ${MAX_SAFE} THEN ${column} END AS ${column}`
}

function sized(column: string): string {
    return `typeof(${column}) AS ${column}Type, octet_length(${column}) AS ${column}Bytes`
}

function boundedText(column: string): string {
    return `CASE WHEN typeof(${column}) = 'text' AND octet_length(${column}) <= ${FIELD_BYTES_MAX} THEN ${column} END AS ${column}`
}

export type BodyColumn = "snippet" | "content"

function segmentSql(body: BodyColumn): string {
    const segment = `substr(${body}, :offset + 1, :chars)`
    return (
        `SELECT ${safeInteger("date")}, ${safeInteger("fetchedDate")}, ` +
        `${safeInteger("hasRead")}, ${safeInteger("starred")}, ${safeInteger("hidden")}, ` +
        `${boundedText("title")}, ${boundedText("creator")}, ` +
        `CASE WHEN :read = 1 THEN instr(CAST(${body} AS BLOB), x'00') END AS nulAt, ` +
        `CASE WHEN :read = 1 THEN length(${body}) END AS totalChars, ` +
        `CASE WHEN :read = 1 THEN octet_length(${segment}) END AS segmentBytes, ` +
        `CASE WHEN :read = 1 AND octet_length(${segment}) <= :segmentBytesMax THEN CAST(${segment} AS BLOB) END AS segment ` +
        `FROM items WHERE _id = :id AND ${RECORD_BYTES} <= ${ARTICLE_RECORD_BYTES_MAX} ` +
        `AND (:read = 0 OR (typeof(${body}) = 'text' AND octet_length(${body}) <= ${BODY_BYTES_MAX}))`
    )
}

/** Static SQL of this module (exported for plan and audit tests). */
export const ARTICLE_SQL = {
    encoding: "PRAGMA encoding",
    probe: "SELECT length(:t) AS n, CAST(substr(:t, 2, 1) AS BLOB) AS s",
    preflight:
        `SELECT ${safeInteger("source")}, ${sized("title")}, ${sized("creator")}, ` +
        `${sized("content")}, ${sized("snippet")}, ${sized("serviceRef")}, ${RECORD_BYTES} AS recordBytes ` +
        `FROM items WHERE _id = :id`,
    segment: { snippet: segmentSql("snippet"), content: segmentSql("content") },
} as const

export interface PreflightRow {
    readonly sourceType: StorageClass
    readonly source: number | null
    readonly titleType: StorageClass
    readonly titleBytes: number | null
    readonly creatorType: StorageClass
    readonly creatorBytes: number | null
    readonly contentType: StorageClass
    readonly contentBytes: number | null
    readonly snippetType: StorageClass
    readonly snippetBytes: number | null
    readonly serviceRefType: StorageClass
    readonly serviceRefBytes: number | null
    readonly recordBytes: number
}

export interface SegmentRow {
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
    readonly title: string | null
    readonly creator: string | null
    readonly nulAt: number | null
    readonly totalChars: number | null
    readonly segmentBytes: number | null
    readonly segment: Uint8Array | null
}

const PROBE_TEXT = "a\u{1F600}b"
const PROBE_BYTES = [0xf0, 0x9f, 0x98, 0x80]

/**
 * Capability gate: a UTF-8 database whose length()/substr() count code
 * points (a non-BMP character is one character of four bytes). Otherwise
 * RUNTIME_CAPABILITY_MISSING, never a fallback that would load the body.
 */
export function checkTextCapability(db: ReadOnlyDatabase): void {
    const encoding = (db.prepare(ARTICLE_SQL.encoding).get() as { encoding?: unknown } | undefined)?.encoding
    const probe = db.prepare(ARTICLE_SQL.probe).get({ t: PROBE_TEXT }) as { n?: unknown; s?: unknown } | undefined
    const bytes = probe?.s
    const ok =
        encoding === "UTF-8" &&
        probe?.n === 3 &&
        bytes instanceof Uint8Array &&
        bytes.length === PROBE_BYTES.length &&
        PROBE_BYTES.every((b, i) => bytes[i] === b)
    if (!ok) throw new FrMcpError("RUNTIME_CAPABILITY_MISSING", "text-encoding")
}

export function readPreflight(db: ReadOnlyDatabase, articleId: number): PreflightRow | undefined {
    return db.prepare(ARTICLE_SQL.preflight).get({ id: articleId }) as PreflightRow | undefined
}

/** Phase B. `read` false: metadata only, the body column is not touched. */
export function readSegment(
    db: ReadOnlyDatabase,
    articleId: number,
    body: BodyColumn,
    read: boolean,
    offset: number,
    chars: number,
): SegmentRow | undefined {
    return db.prepare(ARTICLE_SQL.segment[body]).get({
        id: articleId,
        read: read ? 1 : 0,
        offset,
        chars,
        segmentBytesMax: segmentBytesMax(chars),
    }) as SegmentRow | undefined
}

/** Upper bound of the bytes of a valid segment of `chars` characters. */
export function segmentBytesMax(chars: number): number {
    return chars * UTF8_CHAR_BYTES_MAX
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * The code points of the bytes of a substr() result, or null when they are
 * not valid UTF-8. Only for valid UTF-8 is one SQLite character exactly one
 * code point; invalid bytes would decode to a different number of U+FFFD,
 * so no counter could describe them: the caller makes the body unavailable.
 * Only this segment is validated, never the rest of the stored text.
 */
export function splitCharacters(bytes: Uint8Array): string[] | null {
    try {
        return [...strict.decode(bytes)]
    } catch {
        return null
    }
}
