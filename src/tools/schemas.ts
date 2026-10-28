/**
 * Zod v4 input and output schemas of the source tools. Output schemas are
 * validated by the SDK against every successful structuredContent; input
 * schemas are published in tools/list and checked by the handlers
 * (see input.ts).
 */

import { z } from "zod"
import { OPEN_TARGETS, TEXT_DIRECTIONS } from "../domain/sources.js"

export const LIST_LIMIT_MAX = 500
export const LIST_LIMIT_DEFAULT = 200
export const QUERY_MAX_LENGTH = 100
/** Version of the result contract of these tools. */
export const RESULT_SCHEMA_VERSION = "1"

const sourceId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
/** Public group ids are >= 0: a stored negative gid is reported as groupStatus "unavailable" (domain/groups.ts). */
const groupId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const listSourcesInput = z.strictObject({
    includeHidden: z
        .boolean()
        .optional()
        .describe("Include sources hidden from the 'All articles' view (default true)."),
    groupId: groupId
        .optional()
        .describe("Only sources whose first group (isMultiple entry) is this group id."),
    query: z
        .string()
        .min(1)
        .max(QUERY_MAX_LENGTH)
        .optional()
        .describe("Case-insensitive substring of the source name, matched literally (no wildcards)."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(LIST_LIMIT_MAX)
        .optional()
        .describe(`Maximum sources returned in this page (default ${LIST_LIMIT_DEFAULT}); the response size limit can return fewer.`),
    cursor: z
        .string()
        .max(128)
        .optional()
        .describe("nextCursor of the previous page. Other arguments may be omitted; if given they must match the first page."),
})

export const getSourceInput = z.strictObject({
    sourceId: sourceId.describe("The source id (sid) from list_sources."),
    sourceRef: z
        .string()
        .regex(/^sr1\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{22}$/)
        .optional()
        .describe("sourceRef from list_sources/get_source: fails instead of returning a different source that reused the id."),
})

const storageClass = z.enum(["null", "integer", "real", "text", "blob"])

const fieldIssue = z.strictObject({
    field: z.enum(["name", "url", "serviceRef", "openTarget", "lastFetched", "fetchFrequency", "textDir", "hidden"]),
    issue: z.enum(["unexpectedType", "unexpectedNull", "unexpectedValue"]),
    storageClass,
})

const summaryShape = {
    sourceId,
    sourceRef: z.string().nullable(),
    name: z.string().nullable(),
    hidden: z.boolean().nullable(),
    openTarget: z.enum(OPEN_TARGETS).nullable(),
    fetchFrequencyMin: z.number().int().min(0).nullable(),
    lastFetched: z.string().nullable(),
    synced: z.boolean(),
    groupId: groupId.nullable(),
    groupStatus: z.enum(["grouped", "ungrouped", "ambiguous", "unavailable"]),
}

const meta = z.strictObject({
    generatedAt: z.string(),
    schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
    urlsRedacted: z.literal(true),
    groupsAvailable: z.boolean(),
    groupsError: z.string().nullable(),
})

export const listSourcesOutput = z.strictObject({
    sources: z.array(z.strictObject({ ...summaryShape, fieldIssues: z.array(fieldIssue).optional() })),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    scan: z.strictObject({
        examined: z.number().int().min(0),
        filteredOut: z.number().int().min(0),
        stoppedBy: z.enum(["exhausted", "pageFull", "responseBudget", "byteBudget", "candidateBudget"]),
    }),
    meta,
})

export const getSourceOutput = z.strictObject({
    source: z.strictObject({
        ...summaryShape,
        textDir: z.enum(TEXT_DIRECTIONS).nullable(),
        rules: z.strictObject({
            available: z.boolean(),
            sourceRuleCount: z.number().int().min(0).nullable(),
            groupRuleCount: z.number().int().min(0).nullable(),
        }),
        articleStats: z.strictObject({
            available: z.literal(false),
            reason: z.literal("not-computed-without-index"),
            articleCount: z.null(),
            unreadCount: z.null(),
            starredCount: z.null(),
            hiddenCount: z.null(),
            oldestDate: z.null(),
            newestDate: z.null(),
        }),
        fieldIssues: z.array(fieldIssue).optional(),
    }),
    meta,
})

export type ListSourcesInput = z.output<typeof listSourcesInput>
export type ListSourcesOutput = z.output<typeof listSourcesOutput>
export type GetSourceOutput = z.output<typeof getSourceOutput>
