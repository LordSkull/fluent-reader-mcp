/**
 * Reading and validating rows of the `sources` table (FR-MCP-01 §5.2, §14.1,
 * §11.3.6). Every statement is static, parameterized and addressed by the
 * primary key `sid` (rowid alias): range or point lookups, never OFFSET,
 * never a join or aggregate over `items`.
 *
 * Two phases, both inside the same read transaction (one call of
 * DatabaseAccess.withReadConnection), so they see the same rows:
 *  - S1 reads only sids and record sizes. octet_length() takes the size from
 *    the record header without loading the value [SQLite docs], so a huge
 *    value is never loaded here, whatever its column: every column S2
 *    traverses is measured (RECORD_COLUMNS), the declared-integer ones too.
 *  - S2 loads the projected columns of the candidates S1 accepted. Reading
 *    `hidden`, the last of them, traverses the whole record: S1's sizes bound
 *    that cost, and a record over RECORD_BYTES_MAX never reaches S2.
 *
 * Protected projection: text values are returned only when their storage
 * class is TEXT, integers only when INTEGER and within ±(2^53−1) (compared in
 * SQL, so node:sqlite never sees an unsafe integer). Anything else becomes
 * null with a value-free `fieldIssues` entry. `url` is loaded only to compute
 * sourceRef and is never returned; of `serviceRef` only the type and byte
 * length are read; `iconurl` is never loaded.
 */

import { FrMcpError } from "../errors.js"
import type { ReadOnlyDatabase } from "../db/connection.js"
import type { SourceIdentity } from "../scan/identity.js"
import type { GroupIndex, GroupStatus } from "./groups.js"

const MAX_SAFE = "9007199254740991"

/** A record larger than this (estimated bytes of its columns, see BYTES) is not read. */
export const RECORD_BYTES_MAX = 1024 * 1024
/** Upper bound of the estimated bytes loaded by S2 in one call (the first record always fits). */
export const BATCH_BYTES_MAX = 4 * 1024 * 1024
/** Fixed allowance for the record header. */
const RECORD_OVERHEAD = 32
/** Valid range of a JavaScript Date, in milliseconds. */
const DATE_MS_MAX = 8.64e15

/**
 * Every column of the record up to the last one S2 reads (`hidden`), in
 * record order. SQLite does not enforce column types, so any of them,
 * the "integer" ones included, can hold a TEXT or BLOB of any size: all are
 * measured. `sid` is the rowid alias and is not stored in the record.
 */
const RECORD_COLUMNS = [
    "url",
    "iconurl",
    "name",
    "openTarget",
    "lastFetched",
    "serviceRef",
    "fetchFrequency",
    "textDir",
    "hidden",
] as const

/**
 * Estimated bytes of a record. octet_length() is the byte size of a TEXT or
 * BLOB without loading it, the length of the text form of a number (at most
 * a few dozen bytes), NULL for NULL. Each term is at most SQLITE_MAX_LENGTH
 * (< 2^31), so the sum stays far below 2^53: no overflow in SQLite or JS.
 */
const BYTES = [String(RECORD_OVERHEAD), ...RECORD_COLUMNS.map((column) => `coalesce(octet_length(${column}), 0)`)].join(" + ")

function safeInteger(column: string): string {
    return `typeof(${column}) AS ${column}Type, CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN -${MAX_SAFE} AND ${MAX_SAFE} THEN ${column} END AS ${column}`
}

/** Static SQL of this module (exported for plan and audit tests). */
export const SOURCE_SQL = {
    schemaVersion: "PRAGMA schema_version",
    bounds:
        `SELECT b.lo IS NULL AS empty, ` +
        `CASE WHEN b.lo >= 0 AND b.hi <= ${MAX_SAFE} THEN b.lo END AS lo, ` +
        `CASE WHEN b.lo >= 0 AND b.hi <= ${MAX_SAFE} THEN b.hi END AS hi ` +
        `FROM (SELECT (SELECT MIN(sid) FROM sources) AS lo, (SELECT MAX(sid) FROM sources) AS hi) AS b`,
    candidates: `SELECT sid, ${BYTES} AS bytes FROM sources WHERE sid BETWEEN ? AND ? ORDER BY sid LIMIT ?`,
    memberCandidates:
        `SELECT sid, ${BYTES} AS bytes FROM sources ` +
        `WHERE sid BETWEEN ? AND ? AND sid IN (SELECT value FROM json_each(?)) ORDER BY sid LIMIT ?`,
    candidate: `SELECT sid, ${BYTES} AS bytes FROM sources WHERE sid = ?`,
    rows:
        `SELECT sid, ` +
        `typeof(name) AS nameType, CASE WHEN typeof(name) = 'text' THEN name END AS name, ` +
        `typeof(url) AS urlType, CASE WHEN typeof(url) = 'text' THEN url END AS url, ` +
        `typeof(serviceRef) AS serviceRefType, ` +
        `CASE WHEN typeof(serviceRef) = 'text' THEN octet_length(serviceRef) END AS serviceRefBytes, ` +
        `${safeInteger("openTarget")}, ${safeInteger("lastFetched")}, ${safeInteger("fetchFrequency")}, ` +
        `${safeInteger("textDir")}, ${safeInteger("hidden")} ` +
        `FROM sources WHERE sid IN (SELECT value FROM json_each(?)) ORDER BY sid`,
} as const

export type StorageClass = "null" | "integer" | "real" | "text" | "blob"

export type SourceField =
    | "name"
    | "url"
    | "serviceRef"
    | "openTarget"
    | "lastFetched"
    | "fetchFrequency"
    | "textDir"
    | "hidden"

export interface FieldIssue {
    readonly field: SourceField
    readonly issue: "unexpectedType" | "unexpectedNull" | "unexpectedValue"
    readonly storageClass: StorageClass
}

export const OPEN_TARGETS = ["local", "webpage", "external", "fullContent"] as const
export const TEXT_DIRECTIONS = ["ltr", "rtl", "vertical"] as const

export type OpenTarget = (typeof OPEN_TARGETS)[number]
export type TextDirection = (typeof TEXT_DIRECTIONS)[number]

export interface SourceSummary {
    sourceId: number
    sourceRef: string | null
    name: string | null
    hidden: boolean | null
    openTarget: OpenTarget | null
    fetchFrequencyMin: number | null
    lastFetched: string | null
    synced: boolean
    groupId: number | null
    groupStatus: GroupStatus
    fieldIssues?: FieldIssue[]
}

export interface Candidate {
    readonly sid: number
    /** Estimated bytes of the record (S1). */
    readonly bytes: number
}

/** One row of S2, as returned by the protected projection. */
export interface SourceRow {
    readonly sid: number
    readonly nameType: StorageClass
    readonly name: string | null
    readonly urlType: StorageClass
    readonly url: string | null
    readonly serviceRefType: StorageClass
    readonly serviceRefBytes: number | null
    readonly openTargetType: StorageClass
    readonly openTarget: number | null
    readonly lastFetchedType: StorageClass
    readonly lastFetched: number | null
    readonly fetchFrequencyType: StorageClass
    readonly fetchFrequency: number | null
    readonly textDirType: StorageClass
    readonly textDir: number | null
    readonly hiddenType: StorageClass
    readonly hidden: number | null
}

export function readSchemaVersion(db: ReadOnlyDatabase): number {
    const row = db.prepare(SOURCE_SQL.schemaVersion).get() as { schema_version?: unknown } | undefined
    const version = row?.schema_version
    if (typeof version !== "number") throw new FrMcpError("INTERNAL_ERROR", "unexpected")
    return version
}

/**
 * MIN(sid) and MAX(sid) (two O(log n) primary-key lookups); null for an
 * empty table. Ids outside [0, 2^53−1] are ID_RANGE_UNSUPPORTED.
 */
export function readSidBounds(db: ReadOnlyDatabase): { lo: number; hi: number } | null {
    const row = db.prepare(SOURCE_SQL.bounds).get() as { empty: number; lo: number | null; hi: number | null }
    if (row.empty === 1) return null
    if (row.lo === null || row.hi === null) throw new FrMcpError("ID_RANGE_UNSUPPORTED", "sid-out-of-range")
    return { lo: row.lo, hi: row.hi }
}

/** S1: the next `limit` sids of [lower, upper], optionally restricted to `members`. */
export function readCandidates(
    db: ReadOnlyDatabase,
    lower: number,
    upper: number,
    limit: number,
    members?: readonly number[],
): Candidate[] {
    const rows =
        members === undefined
            ? db.prepare(SOURCE_SQL.candidates).all(lower, upper, limit)
            : db.prepare(SOURCE_SQL.memberCandidates).all(lower, upper, JSON.stringify(members), limit)
    return rows as unknown as Candidate[]
}

/** S1 for a single sid. */
export function readCandidate(db: ReadOnlyDatabase, sid: number): Candidate | undefined {
    return db.prepare(SOURCE_SQL.candidate).get(sid) as Candidate | undefined
}

/** S2: projected columns of the given sids (point lookups on the primary key). */
export function readSourceRows(db: ReadOnlyDatabase, sids: readonly number[]): Map<number, SourceRow> {
    const rows = db.prepare(SOURCE_SQL.rows).all(JSON.stringify(sids)) as unknown as SourceRow[]
    return new Map(rows.map((row) => [row.sid, row]))
}

/**
 * The leading candidates whose records may be loaded in one call: each at
 * most RECORD_BYTES_MAX, together at most BATCH_BYTES_MAX. A first candidate
 * over RECORD_BYTES_MAX is LIMIT_EXCEEDED: it is neither skipped nor read.
 */
export function selectBatch(candidates: readonly Candidate[]): Candidate[] {
    const batch: Candidate[] = []
    let total = 0
    for (const candidate of candidates) {
        if (candidate.bytes > RECORD_BYTES_MAX) {
            if (batch.length === 0) throw new FrMcpError("LIMIT_EXCEEDED", "record-too-large")
            break
        }
        if (batch.length > 0 && total + candidate.bytes > BATCH_BYTES_MAX) break
        batch.push(candidate)
        total += candidate.bytes
    }
    return batch
}

/** Validated view of one row. */
export class SourceRecord {
    readonly #row: SourceRow
    readonly #issues: FieldIssue[] = []

    constructor(row: SourceRow) {
        this.#row = row
    }

    #issue(field: SourceField, storageClass: StorageClass, issue?: FieldIssue["issue"]): null {
        this.#issues.push({
            field,
            issue: issue ?? (storageClass === "null" ? "unexpectedNull" : "unexpectedType"),
            storageClass,
        })
        return null
    }

    #text(field: "name" | "url", type: StorageClass, value: string | null): string | null {
        return type === "text" && value !== null ? value : this.#issue(field, type)
    }

    #integer(field: SourceField, type: StorageClass, value: number | null): number | null {
        if (type !== "integer") return this.#issue(field, type)
        return value ?? this.#issue(field, type, "unexpectedValue")
    }

    #enum<T>(field: SourceField, type: StorageClass, value: number | null, values: readonly T[]): T | null {
        const n = this.#integer(field, type, value)
        if (n === null) return null
        return values[n] ?? this.#issue(field, type, "unexpectedValue")
    }

    get sid(): number {
        return this.#row.sid
    }

    /** The feed URL, for identity only. Never returned to clients. */
    url(): string | null {
        return this.#text("url", this.#row.urlType, this.#row.url)
    }

    name(): string | null {
        return this.#text("name", this.#row.nameType, this.#row.name)
    }

    /** Stored as drizzle boolean: 1 is true, 0 is false, anything else is reported. */
    hidden(): boolean | null {
        const n = this.#integer("hidden", this.#row.hiddenType, this.#row.hidden)
        if (n === null) return null
        return n === 1 ? true : n === 0 ? false : this.#issue("hidden", "integer", "unexpectedValue")
    }

    openTarget(): OpenTarget | null {
        return this.#enum("openTarget", this.#row.openTargetType, this.#row.openTarget, OPEN_TARGETS)
    }

    textDir(): TextDirection | null {
        return this.#enum("textDir", this.#row.textDirType, this.#row.textDir, TEXT_DIRECTIONS)
    }

    fetchFrequencyMin(): number | null {
        const n = this.#integer("fetchFrequency", this.#row.fetchFrequencyType, this.#row.fetchFrequency)
        if (n === null) return null
        return n >= 0 ? n : this.#issue("fetchFrequency", "integer", "unexpectedValue")
    }

    /** Milliseconds since the epoch as ISO 8601 UTC; null when not a valid date. */
    lastFetched(): string | null {
        const n = this.#integer("lastFetched", this.#row.lastFetchedType, this.#row.lastFetched)
        if (n === null) return null
        return Math.abs(n) <= DATE_MS_MAX ? new Date(n).toISOString() : this.#issue("lastFetched", "integer", "unexpectedValue")
    }

    /**
     * Synchronized with a service: the app tests `serviceRef` for truthiness,
     * so NULL and the empty string are not synced. The value is never read.
     */
    synced(): boolean {
        const type = this.#row.serviceRefType
        if (type === "null") return false
        if (type === "text") return (this.#row.serviceRefBytes ?? 0) > 0
        this.#issue("serviceRef", type)
        return true
    }

    issues(): FieldIssue[] {
        return this.#issues
    }
}

/** The summary returned by list_sources (and embedded in get_source). */
export function toSummary(row: SourceRow, groups: GroupIndex, identity: SourceIdentity): {
    summary: SourceSummary
    record: SourceRecord
    /** Validated feed URL, for identity checks only; never returned. */
    url: string | null
} {
    const record = new SourceRecord(row)
    const url = record.url()
    const group = groups.groupOf(row.sid)
    const summary: SourceSummary = {
        sourceId: row.sid,
        sourceRef: url === null ? null : identity.refFor(row.sid, url),
        name: record.name(),
        hidden: record.hidden(),
        openTarget: record.openTarget(),
        fetchFrequencyMin: record.fetchFrequencyMin(),
        lastFetched: record.lastFetched(),
        synced: record.synced(),
        groupId: group.groupId,
        groupStatus: group.groupStatus,
    }
    return { summary, record, url }
}

/** Adds the field issues collected so far (omitted when there are none). */
export function withIssues<T extends { fieldIssues?: FieldIssue[] }>(value: T, record: SourceRecord): T {
    const issues = record.issues()
    if (issues.length > 0) value.fieldIssues = [...issues]
    return value
}
