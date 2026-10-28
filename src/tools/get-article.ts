/**
 * get_article (FR-MCP-01 §14.6, adapted to the FR-MCP-02A-04 contract).
 *
 * One article by `_id`: stored metadata and one segment of the stored body,
 * `snippet` for format "text" (default) and `content` for "html". Both are
 * the local copy written when the feed or sync service was fetched; the
 * "load full content" extraction of the app is not persisted, so nothing
 * here claims the article is complete. Nothing is fetched, rendered,
 * sanitized or rewritten: the body is returned as stored, as untrusted data.
 * Article URLs, thumbnails, guid and serviceRef are never returned.
 *
 * Offsets and lengths are Unicode code points (SQLite characters of a UTF-8
 * database, see domain/articles.ts). The segment read from SQLite has at most
 * `maxChars` code points; it is then shortened, by whole code points, to the
 * longest prefix whose real serialized result stays within RESP_MAX (two
 * copies, JSON escapes included, §14.0.3). truncated/nextOffset report what
 * remains after the returned prefix. No snapshot spans two calls.
 *
 * Reading state never changes it: the connection is read-only.
 */

import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError } from "../errors.js"
import {
    ARTICLE_RECORD_BYTES_MAX,
    BODY_BYTES_MAX,
    checkTextCapability,
    FIELD_BYTES_MAX,
    readPreflight,
    readSegment,
    splitCharacters,
    type BodyColumn,
    type PreflightRow,
    type SegmentRow,
} from "../domain/articles.js"
import { readCandidate, readSourceRows, RECORD_BYTES_MAX, SourceRecord, type SourceRow, type StorageClass } from "../domain/sources.js"
import type { ReadOnlyDatabase } from "../db/connection.js"
import type { ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { resultLength, RESP_MAX, successResult } from "./result.js"
import {
    ARTICLE_MAX_CHARS_DEFAULT,
    getArticleInput,
    RESULT_SCHEMA_VERSION,
    type ArticleFieldIssue,
    type GetArticleOutput,
} from "./schemas.js"

export const GET_ARTICLE = "get_article"

/** Valid range of a JavaScript Date, in milliseconds. */
const DATE_MS_MAX = 8.64e15

type SourceInfo =
    | { readonly kind: "invalid" }
    | { readonly kind: "orphan"; readonly sid: number }
    | { readonly kind: "tooLarge"; readonly sid: number }
    | { readonly kind: "found"; readonly sid: number; readonly row: SourceRow }

interface ArticleRead {
    readonly pre: PreflightRow
    readonly row: SegmentRow
    readonly readable: boolean
    readonly source: SourceInfo
}

/** The article's source by primary key, with the S1/S2 record limit of get_source. */
function readSource(db: ReadOnlyDatabase, pre: PreflightRow): SourceInfo {
    if (pre.sourceType !== "integer" || pre.source === null || pre.source < 0) return { kind: "invalid" }
    const sid = pre.source
    const candidate = readCandidate(db, sid)
    if (candidate === undefined) return { kind: "orphan", sid }
    if (candidate.bytes > RECORD_BYTES_MAX) return { kind: "tooLarge", sid }
    const row = readSourceRows(db, [sid]).get(sid)
    // Same read transaction as readCandidate: the row exists.
    if (row === undefined) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
    return { kind: "found", sid, row }
}

export async function getArticle(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(getArticleInput, args)
    const format = input.format ?? "text"
    const column: BodyColumn = format === "text" ? "snippet" : "content"
    const offset = input.offset ?? 0
    const chars = input.maxChars ?? ARTICLE_MAX_CHARS_DEFAULT

    const read = await context.database.withReadConnection((db): ArticleRead | undefined => {
        checkTextCapability(db)
        const pre = readPreflight(db, input.articleId)
        if (pre === undefined) return undefined
        if (pre.recordBytes > ARTICLE_RECORD_BYTES_MAX) throw new FrMcpError("LIMIT_EXCEEDED", "record-too-large")
        const bodyType = column === "snippet" ? pre.snippetType : pre.contentType
        const bodyBytes = (column === "snippet" ? pre.snippetBytes : pre.contentBytes) ?? 0
        const readable = bodyType === "text" && bodyBytes <= BODY_BYTES_MAX
        const row = readSegment(db, input.articleId, column, readable, offset, chars)
        // Phase B repeats the preflight conditions in the same transaction: the row is there.
        if (row === undefined) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
        return { pre, row, readable, source: readSource(db, pre) }
    })
    if (read === undefined) throw new FrMcpError("NOT_FOUND", "article-not-found")
    const { pre, row } = read

    const issues: ArticleFieldIssue[] = []
    const issue = (field: ArticleFieldIssue["field"], storageClass: StorageClass | null, kind?: ArticleFieldIssue["issue"]): null => {
        issues.push({ field, issue: kind ?? (storageClass === "null" ? "unexpectedNull" : "unexpectedType"), storageClass })
        return null
    }
    const text = (field: "title" | "creator", type: StorageClass, bytes: number | null, value: string | null, nullable: boolean): string | null => {
        if (type === "null" && nullable) return null
        if (type !== "text") return issue(field, type)
        if ((bytes ?? 0) > FIELD_BYTES_MAX) return issue(field, "text", "tooLarge")
        return value ?? issue(field, type, "unexpectedValue")
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

    // Source
    let sourceId: number | null = null
    let orphan: boolean | null = null
    let sourceName: string | null = null
    let sourceRef: string | null = null
    const source = read.source
    if (source.kind === "invalid") {
        issue("source", pre.sourceType, pre.sourceType === "integer" ? "unexpectedValue" : undefined)
    } else {
        sourceId = source.sid
        orphan = source.kind === "orphan"
        if (source.kind === "tooLarge") issue("sourceName", null, "tooLarge")
        if (source.kind === "found") {
            const record = new SourceRecord(source.row)
            const url = record.url()
            sourceRef = url === null ? null : context.identity.refFor(source.sid, url)
            sourceName = record.name()
            for (const found of record.issues()) {
                if (found.field === "name") issue("sourceName", found.storageClass, found.issue)
            }
            if (sourceName !== null && Buffer.byteLength(sourceName, "utf8") > FIELD_BYTES_MAX) {
                sourceName = issue("sourceName", "text", "tooLarge")
            }
        }
    }

    const fields = {
        title: text("title", pre.titleType, pre.titleBytes, row.title, false),
        creator: text("creator", pre.creatorType, pre.creatorBytes, row.creator, true),
        date: date("date", row.dateType, row.date),
        fetchedDate: date("fetchedDate", row.fetchedDateType, row.fetchedDate),
        read: flag("hasRead", row.hasReadType, row.hasRead),
        starred: flag("starred", row.starredType, row.starred),
        hidden: flag("hidden", row.hiddenType, row.hidden),
    }
    // Synchronized with a service: the app tests serviceRef for truthiness. The value is never read.
    let synced = false
    if (pre.serviceRefType === "text") {
        synced = (pre.serviceRefBytes ?? 0) > 0
    } else if (pre.serviceRefType !== "null") {
        issue("serviceRef", pre.serviceRefType)
        synced = true
    }

    // Body segment, as SQLite characters (code points for valid UTF-8)
    let pieces: string[] | null = null
    let totalChars: number | null = null
    if (!read.readable) {
        const type = column === "snippet" ? pre.snippetType : pre.contentType
        issue(column, type, type === "text" ? "tooLarge" : undefined)
    } else {
        // NUL characters stop SQLite's text functions; > 4 bytes per character or a segment that is not
        // valid UTF-8 has no code point counts: the body is unavailable, never returned with U+FFFD.
        const split = (row.nulAt ?? 0) > 0 || row.segment === null || row.totalChars === null ? null : splitCharacters(row.segment)
        if (split === null || row.totalChars === null) {
            issue(column, "text", "unexpectedValue")
        } else {
            const expected = Math.max(0, Math.min(chars, row.totalChars - offset))
            if (split.length !== expected) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
            pieces = split
            totalChars = row.totalChars
        }
    }

    const build = (body: string | null, returnedChars: number, nextOffset: number | null): GetArticleOutput => {
        const payload: GetArticleOutput = {
            articleId: input.articleId,
            sourceId,
            sourceRef,
            sourceName,
            orphan,
            ...fields,
            synced,
            contentScope: "feed",
            editorialCompleteness: "unknown",
            fullContentAvailable: false,
            format,
            body,
            offset,
            returnedChars,
            totalChars,
            truncated: nextOffset !== null,
            nextOffset,
            untrusted: true,
            meta: {
                generatedAt: new Date(context.now()).toISOString(),
                schemaVersion: RESULT_SCHEMA_VERSION,
                urlsRedacted: true,
            },
        }
        if (issues.length > 0) payload.fieldIssues = [...issues]
        return payload
    }

    if (pieces === null || totalChars === null) return successResult(build(null, 0, null)).result
    const segment = pieces
    const total = totalChars

    // The decision uses the real serialized size of each candidate, never an estimate.
    const candidate = (returned: number): GetArticleOutput => {
        const end = offset + returned
        return build(segment.slice(0, returned).join(""), returned, end < total ? end : null)
    }
    const fits = (returned: number): boolean => resultLength(candidate(returned)) <= RESP_MAX
    // Empty segment (empty body or offset at/after the end) and whole segment: checked as they are.
    if (segment.length === 0 || fits(segment.length)) return successResult(candidate(segment.length)).result
    // Otherwise the longest prefix of 1..length−1 code points that fits. On that range truncated is true
    // and nextOffset is a number, so the size only grows with the prefix: binary search, at most
    // ⌈log2(40,000)⌉ = 16 candidates. Zero code points would not let the reader progress: LIMIT_EXCEEDED.
    let lo = 0
    let hi = segment.length - 1
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (fits(mid)) lo = mid
        else hi = mid - 1
    }
    if (lo === 0) throw new FrMcpError("LIMIT_EXCEEDED", "response-too-large")
    return successResult(candidate(lo)).result
}
