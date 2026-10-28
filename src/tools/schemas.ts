/**
 * Zod v4 input and output schemas of the source and group tools. Output schemas are
 * validated by the SDK against every successful structuredContent; input
 * schemas are published in tools/list and checked by the handlers
 * (see input.ts).
 */

import { z } from "zod"
import { SAMPLE_MAX } from "../domain/group-catalog.js"
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

// ---- Group tools (FR-MCP-02A-03) ----

export const GROUP_LIMIT_MAX = 200
export const GROUP_LIMIT_DEFAULT = 100

const count = z.number().int().min(0)
const idSample = z.strictObject({
    count,
    sample: z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).max(SAMPLE_MAX),
})
const groupLimit = (what: string) =>
    z
        .number()
        .int()
        .min(1)
        .max(GROUP_LIMIT_MAX)
        .optional()
        .describe(`Maximum ${what} returned in this page (default ${GROUP_LIMIT_DEFAULT}); the response size limit can return fewer.`)
const groupCursor = z
    .string()
    .max(128)
    .optional()
    .describe("nextCursor of the previous page. Other arguments must match the first page.")
const groupsRevision = z.string().describe("Revision of sourceGroups this page was built from.")
const groupMeta = z.strictObject({
    generatedAt: z.string(),
    schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
})

export const listGroupsInput = z.strictObject({
    includeEmpty: z.boolean().optional().describe("Include groups with no configured member (default true)."),
    limit: groupLimit("groups"),
    cursor: groupCursor,
})

export const getGroupInput = z.strictObject({
    groupId: groupId.describe("The group id (groupId from list_groups)."),
    limit: groupLimit("members"),
    cursor: groupCursor,
})

export const listGroupsOutput = z.strictObject({
    groups: z.array(
        z.strictObject({
            position: count,
            groupId: groupId.nullable(),
            idStatus: z.enum(["unique", "ambiguous", "invalid"]),
            name: z.string().nullable(),
            sourceCount: count,
            distinctSourceCount: count,
            existingSourceCount: count.nullable(),
        }),
    ),
    integrity: z.strictObject({
        entryCount: count,
        groupCount: count,
        singleEntryCount: count,
        emptyGroupCount: count,
        nonStandardSingleEntryCount: count,
        duplicateGroupIds: idSample,
        duplicateSingleEntryIds: idSample,
        negativeGroupIds: z.strictObject({
            groupCount: count,
            singleEntryCount: count,
            groupPositions: z.array(count).max(SAMPLE_MAX),
        }),
        sourcesInMultipleGroups: idSample,
        sourcesInGroupAndSingleEntry: idSample,
        repeatedMemberships: idSample,
        negativeSourceIdCount: count,
        databaseCheck: z.enum(["complete", "tooManySources", "sourceIdsOutOfRange"]),
        orphanSourceIds: idSample.nullable(),
        ungroupedSources: idSample.nullable(),
    }),
    groupsRevision,
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    scan: z.strictObject({
        examined: count,
        filteredOut: count,
        stoppedBy: z.enum(["exhausted", "pageFull", "responseBudget"]),
    }),
    meta: groupMeta,
})

export const getGroupOutput = z.strictObject({
    groupId,
    name: z.string().nullable(),
    position: count,
    sourceCount: count,
    distinctSourceCount: count,
    ruleCount: count.nullable(),
    rulesError: z.string().nullable(),
    sources: z.array(
        z.strictObject({
            index: count,
            sourceId: sourceId.nullable(),
            sourceRef: z.string().nullable(),
            name: z.string().nullable(),
            hidden: z.boolean().nullable(),
            exists: z.boolean().nullable(),
            effectiveGroup: z.boolean().nullable(),
            fieldIssues: z.array(fieldIssue).optional(),
        }),
    ),
    integrity: z.strictObject({
        repeatedMemberships: idSample,
        sourcesInEarlierGroups: idSample,
        sourcesInSingleEntries: idSample,
        negativeSourceIdCount: count,
        membersCheck: z.enum(["complete", "tooManyMembers"]),
        orphanSourceIds: idSample.nullable(),
    }),
    groupsRevision,
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    scan: z.strictObject({
        examined: count,
        stoppedBy: z.enum(["exhausted", "pageFull", "byteBudget", "responseBudget"]),
    }),
    meta: groupMeta.extend({ urlsRedacted: z.literal(true) }),
})

export type ListGroupsInput = z.output<typeof listGroupsInput>
export type ListGroupsOutput = z.output<typeof listGroupsOutput>
export type GetGroupInput = z.output<typeof getGroupInput>
export type GetGroupOutput = z.output<typeof getGroupOutput>
