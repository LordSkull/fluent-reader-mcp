/**
 * Zod v4 input and output schemas of the source, group, article and rule tools. Output schemas are
 * validated by the SDK against every successful structuredContent; input
 * schemas are published in tools/list and checked by the handlers
 * (see input.ts).
 */

import { z } from "zod"
import { SAMPLE_MAX } from "../domain/group-catalog.js"
import { NOTE_ORDERS_MAX, NOTES_PER_PAGE_MAX, RULE_DIAGNOSTICS } from "../domain/rules.js"
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

// ---- Article tool (FR-MCP-02A-04) ----

export const ARTICLE_MAX_CHARS_MAX = 40_000
export const ARTICLE_MAX_CHARS_DEFAULT = 12_000

export const getArticleInput = z.strictObject({
    articleId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe("The article id (_id)."),
    format: z
        .enum(["text", "html"])
        .optional()
        .describe("text (default): the stored plain text (snippet). html: the stored raw HTML (content), never rendered or sanitized."),
    maxChars: z
        .number()
        .int()
        .min(1)
        .max(ARTICLE_MAX_CHARS_MAX)
        .optional()
        .describe(`Maximum Unicode code points of body requested (default ${ARTICLE_MAX_CHARS_DEFAULT}); the response size limit can return fewer.`),
    offset: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe("Zero-based offset in Unicode code points (not bytes, UTF-16 units or grapheme clusters); pass nextOffset to continue."),
})

const articleFieldIssue = z.strictObject({
    field: z.enum(["source", "sourceName", "title", "creator", "date", "fetchedDate", "hasRead", "starred", "hidden", "serviceRef", "snippet", "content"]),
    issue: z.enum(["unexpectedType", "unexpectedNull", "unexpectedValue", "tooLarge"]),
    /** null when the value was not examined (a source record over the record limit). */
    storageClass: storageClass.nullable(),
})

export const getArticleOutput = z.strictObject({
    articleId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sourceId: sourceId.nullable(),
    sourceRef: z.string().nullable(),
    sourceName: z.string().nullable(),
    orphan: z.boolean().nullable(),
    title: z.string().nullable(),
    creator: z.string().nullable(),
    date: z.string().nullable(),
    fetchedDate: z.string().nullable(),
    read: z.boolean().nullable(),
    starred: z.boolean().nullable(),
    hidden: z.boolean().nullable(),
    synced: z.boolean(),
    contentScope: z.literal("feed"),
    editorialCompleteness: z.literal("unknown"),
    fullContentAvailable: z.literal(false),
    format: z.enum(["text", "html"]),
    body: z.string().nullable(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    returnedChars: count,
    totalChars: count.nullable(),
    truncated: z.boolean(),
    nextOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    untrusted: z.literal(true),
    fieldIssues: z.array(articleFieldIssue).optional(),
    meta: groupMeta.extend({ urlsRedacted: z.literal(true) }),
})

export type GetArticleInput = z.output<typeof getArticleInput>
export type GetArticleOutput = z.output<typeof getArticleOutput>
export type ArticleFieldIssue = z.output<typeof articleFieldIssue>

// ---- Article listing (FR-MCP-02B-01) ----

export const ARTICLE_PAGE_SIZE_MAX = 100
export const ARTICLE_PAGE_SIZE_DEFAULT = 20
export const EXCERPT_CHARS_MAX = 500
export const EXCERPT_CHARS_DEFAULT = 200
export const ARTICLE_SOURCE_IDS_MAX = 500
/** Fixed description of what a listing guarantees (returned with every list_articles page). */
export const ARTICLE_LIST_CONSISTENCY =
    "Order 'stored': descending article id, the order in which articles were saved in the database, not publication date. " +
    "Windowed scan without snapshot: each article is included or excluded when the scan reaches it, with its state at that moment; " +
    "articles saved after the first page are not included, articles deleted before the scan reaches them are absent, " +
    "and no article is returned twice in one chain of cursors."

/** Valid range of a JavaScript Date, in milliseconds. */
const DATE_MS_MAX = 8.64e15
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/

/**
 * Milliseconds since the epoch of an ISO 8601 date-time with an explicit
 * offset (`Z` or `±hh:mm`), or null when it is not one or names no real
 * instant (month 13, February 30, hour 24, offset beyond ±23:59). Date-only
 * and offset-less forms are rejected: their time zone would be implicit.
 */
export function parseInstant(text: string): number | null {
    const m = ISO_INSTANT.exec(text)
    if (m === null) return null
    const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [number, number, number, number, number, number]
    const millis = Number((m[7] ?? "0").padEnd(3, "0"))
    const offsetMinutes = m[8] === "Z" ? 0 : (m[9] === "-" ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11]))
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || Number(m[10] ?? 0) > 23 || Number(m[11] ?? 0) > 59) return null
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, millis)
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
    const ms = date.getTime() - offsetMinutes * 60_000
    return Number.isFinite(ms) && Math.abs(ms) <= DATE_MS_MAX ? ms : null
}

const isoInstant = z
    .string()
    .max(40)
    .regex(ISO_INSTANT)
    .refine((s) => parseInstant(s) !== null)

export const listArticlesInput = z
    .strictObject({
        sourceIds: z
            .array(sourceId)
            .min(1)
            .max(ARTICLE_SOURCE_IDS_MAX)
            .optional()
            .describe(`Only articles of these sources (1..${ARTICLE_SOURCE_IDS_MAX} sourceIds; duplicates are ignored). NOT_FOUND if one does not exist. Not with groupId.`),
        groupId: groupId
            .optional()
            .describe("Only articles of the sources whose first group is this group id (as list_sources groupId). Not with sourceIds."),
        dateFrom: isoInstant
            .optional()
            .describe("Only articles whose stored date is >= this instant. ISO 8601 date-time with Z or ±hh:mm offset, e.g. 2026-10-01T00:00:00Z."),
        dateTo: isoInstant.optional().describe("Only articles whose stored date is < this instant (same format; must be later than dateFrom)."),
        read: z.enum(["any", "read", "unread"]).optional().describe("Read state filter (default any)."),
        starred: z.enum(["any", "starred", "unstarred"]).optional().describe("Starred state filter (default any)."),
        hidden: z
            .enum(["exclude", "include", "only"])
            .optional()
            .describe("Articles hidden in the app (by the user or a rule): exclude (default), include or only."),
        includeHiddenSources: z
            .boolean()
            .optional()
            .describe(
                "Include articles of sources hidden from 'All articles' (default false), also when they are named in sourceIds or groupId. " +
                    "With false, articles of a source whose hidden flag cannot be verified (oversized or malformed source record) are left out too; articles whose source no longer exists are kept.",
            ),
        sort: z
            .enum(["stored"])
            .optional()
            .describe("stored (default, the only one): descending article id, i.e. the order articles were saved in the database, NOT publication date."),
        pageSize: z
            .number()
            .int()
            .min(1)
            .max(ARTICLE_PAGE_SIZE_MAX)
            .optional()
            .describe(`Maximum articles returned in this page (default ${ARTICLE_PAGE_SIZE_DEFAULT}); scan budgets and the response size limit can return fewer.`),
        excerptChars: z
            .number()
            .int()
            .min(0)
            .max(EXCERPT_CHARS_MAX)
            .optional()
            .describe(`Maximum Unicode code points of the stored plain-text excerpt per article (default ${EXCERPT_CHARS_DEFAULT}, 0 for none).`),
        cursor: z
            .string()
            .max(128)
            .optional()
            .describe("nextCursor of the previous page. Other arguments may be omitted; if given they must match the first page."),
    })
    .superRefine((v, ctx) => {
        if (v.sourceIds !== undefined && v.groupId !== undefined) ctx.addIssue({ code: "custom", message: "sourceIds and groupId" })
        if (v.dateFrom !== undefined && v.dateTo !== undefined && (parseInstant(v.dateFrom) ?? 0) >= (parseInstant(v.dateTo) ?? 0)) {
            ctx.addIssue({ code: "custom", message: "date range" })
        }
    })

export const listArticlesOutput = z.strictObject({
    articles: z
        .array(
            z.strictObject({
                articleId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
                sourceId: sourceId.nullable(),
                sourceName: z.string().nullable(),
                sourceNameTruncated: z.literal(true).optional(),
                orphan: z.boolean().nullable(),
                title: z.string().nullable(),
                titleTruncated: z.boolean(),
                date: z.string().nullable(),
                dateValid: z.boolean(),
                fetchedDate: z.string().nullable(),
                creator: z.string().nullable(),
                creatorTruncated: z.literal(true).optional(),
                read: z.boolean().nullable(),
                starred: z.boolean().nullable(),
                hidden: z.boolean().nullable(),
                excerpt: z.string().nullable(),
                excerptTruncated: z.boolean(),
                untrusted: z.literal(true),
                fieldIssues: z.array(articleFieldIssue).optional(),
            }),
        )
        .max(ARTICLE_PAGE_SIZE_MAX),
    sort: z.literal("stored"),
    pageSize: z.number().int().min(1).max(ARTICLE_PAGE_SIZE_MAX),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    scan: z.strictObject({
        examined: count,
        exhausted: z.boolean(),
        stoppedBy: z.enum(["exhausted", "pageFull", "responseBudget", "scanBudget", "timeBudget"]),
        oversizeSkipped: count,
        invalidDateExcluded: count,
    }),
    consistency: z.literal(ARTICLE_LIST_CONSISTENCY),
    meta: groupMeta.extend({ urlsRedacted: z.literal(true) }),
})

export type ListArticlesInput = z.output<typeof listArticlesInput>
export type ListArticlesOutput = z.output<typeof listArticlesOutput>
export type ListedArticle = ListArticlesOutput["articles"][number]

// ---- Rule tools (FR-MCP-02A-05) ----

export const RULE_LIMIT_MAX = 100
export const RULE_CHAIN_LIMIT_DEFAULT = 100

/** Fixed description of how the app evaluates a chain (returned with every get_rule_chain page). */
export const CHAIN_SEMANTICS =
    "Chain order is all, then the first multiple group (in sourceGroups order) containing the source, then the source. " +
    "The app evaluates every rule of the chain, in order and without early stop, on each article it fetches or syncs; " +
    "for each flag the last matching rule wins, and a condition can depend on flags set by earlier rules. " +
    "Besides fetch and sync, rules are only applied by an explicit retroactive hide requested in the app. " +
    "This server never evaluates or applies rules."

const ruleCursor = z.string().max(128).optional().describe("nextCursor of the previous page. Other arguments must match the first page.")
const sourceRefInput = z.string().regex(/^sr1\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{22}$/)

export const listRulesInput = z
    .strictObject({
        scope: z
            .enum(["all", "group", "source"])
            .describe("all: sourceRules.all; group: group:<groupId>; source: source:<sourceId>. Only the rules stored under that key, never inherited ones."),
        groupId: groupId.optional().describe("Required with scope group, not allowed otherwise."),
        sourceId: sourceId.optional().describe("Required with scope source, not allowed otherwise."),
        limit: z.number().int().min(1).max(RULE_LIMIT_MAX).describe(`Rules per page (1..${RULE_LIMIT_MAX}); the response size limit can return fewer.`),
        cursor: ruleCursor,
    })
    .superRefine((v, ctx) => {
        const ok =
            v.scope === "all"
                ? v.groupId === undefined && v.sourceId === undefined
                : v.scope === "group"
                  ? v.groupId !== undefined && v.sourceId === undefined
                  : v.sourceId !== undefined && v.groupId === undefined
        if (!ok) ctx.addIssue({ code: "custom", message: "target" })
    })

export const getRuleChainInput = z
    .strictObject({
        sourceId: sourceId.optional().describe("Chain of a source: all + its first group + source."),
        sourceRef: sourceRefInput.optional().describe("Only with sourceId: fails with SOURCE_IDENTITY_CHANGED if the id now designates another source."),
        groupId: groupId.optional().describe("Chain of a group: all + group."),
        all: z.literal(true).optional().describe("Chain of the global target: all only."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(RULE_LIMIT_MAX)
            .optional()
            .describe(`Chain entries per page (default ${RULE_CHAIN_LIMIT_DEFAULT}); the response size limit can return fewer.`),
        cursor: ruleCursor,
    })
    .superRefine((v, ctx) => {
        const selected = [v.sourceId !== undefined, v.groupId !== undefined, v.all !== undefined].filter(Boolean).length
        if (selected !== 1 || (v.sourceRef !== undefined && v.sourceId === undefined)) ctx.addIssue({ code: "custom", message: "target" })
    })

const ruleSummary = z.strictObject({
    index: count,
    field: z.enum(["title", "text", "creator"]),
    pattern: z.string(),
    patternTruncated: z.boolean(),
    patternLength: count,
    caseSensitive: z.boolean(),
    match: z.boolean(),
    stateMask: z.strictObject({ requireUnread: z.boolean(), requireStarred: z.boolean(), requireVisible: z.boolean() }),
    rawFilter: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    standard: z.boolean(),
    actions: z
        .array(z.strictObject({ action: z.enum(["read", "star", "hide", "notify"]), value: z.boolean() }))
        .max(4)
        .nullable(),
    rawActionCount: count,
    unknownActionCount: count,
    diagnostics: z.array(z.enum(RULE_DIAGNOSTICS)).max(RULE_DIAGNOSTICS.length),
})

const ruleKeysIntegrity = z.strictObject({
    keyCount: count,
    ruleCount: count,
    emptyRuleArrays: count,
    oversizedRuleArrays: count,
    malformedKeys: count,
    negativeIdKeys: count,
    sourceKeys: z.strictObject({
        count,
        check: z.enum(["complete", "tooManyKeys", "notChecked"]),
        orphans: idSample.nullable(),
    }),
    groupKeys: z.strictObject({
        count,
        groupsAvailable: z.boolean(),
        orphans: idSample.nullable(),
        singleEntryOnly: idSample.nullable(),
        ambiguous: idSample.nullable(),
    }),
})

const ruleScan = z.strictObject({ examined: count, stoppedBy: z.enum(["exhausted", "pageFull", "responseBudget"]) })

export const listRulesOutput = z.strictObject({
    target: z.strictObject({
        scope: z.enum(["all", "group", "source"]),
        key: z.string(),
        exists: z.boolean().nullable(),
        status: z.enum(["exists", "absent", "ambiguous", "singleEntry", "unavailable"]),
        name: z.string().nullable(),
        keyPresent: z.boolean(),
        ruleCount: count,
    }),
    revision: z.string(),
    rules: z.array(ruleSummary),
    integrity: ruleKeysIntegrity,
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    scan: ruleScan,
    meta: groupMeta,
})

const actionFlag = z.enum(["read", "star", "hide", "notify"])

export const getRuleChainOutput = z.strictObject({
    target: z.strictObject({
        scope: z.enum(["all", "group", "source"]),
        key: z.string(),
        sourceId: sourceId.nullable(),
        groupId: groupId.nullable(),
        name: z.string().nullable(),
        sourceRef: z.string().nullable(),
    }),
    chain: z.array(
        z.strictObject({
            order: count,
            origin: z.enum(["all", "group", "source"]),
            originKey: z.string(),
            inherited: z.boolean(),
            index: count,
            rule: ruleSummary,
        }),
    ),
    resolution: z.strictObject({
        complete: z.boolean(),
        groupStatus: z.enum(["notApplicable", "target", "grouped", "ungrouped", "ambiguous", "unavailable"]),
        reason: z.enum([
            "targetIsAll",
            "targetIsGroup",
            "firstMultipleGroup",
            "noMultipleGroup",
            "firstGroupIdAmbiguous",
            "firstGroupIdInvalid",
            "groupsUnavailable",
        ]),
        groupId: groupId.nullable(),
        groupPosition: count.nullable(),
        chainLength: count,
        countByOrigin: z.strictObject({ all: count, group: count, source: count }),
    }),
    semantics: z.literal(CHAIN_SEMANTICS),
    conflicts: z
        .array(
            z.strictObject({
                kind: z.enum([
                    "duplicateRule",
                    "oppositeActionsSameCondition",
                    "sameFlagDifferentConditions",
                    "contradictoryActionsInRule",
                    "stateDependentCondition",
                ]),
                certainty: z.enum(["proven", "possible", "notStaticallyDecidable"]),
                flag: actionFlag.nullable(),
                orders: z.array(count).max(NOTE_ORDERS_MAX),
                ordersCount: count,
                ordersTruncated: z.boolean(),
            }),
        )
        .max(NOTES_PER_PAGE_MAX),
    conflictsOmitted: count,
    conflictCounts: z.strictObject({
        duplicateRule: count,
        oppositeActionsSameCondition: count,
        sameFlagDifferentConditions: count,
        contradictoryActionsInRule: count,
        stateDependentCondition: count,
    }),
    fetchBlockers: z.array(
        z.strictObject({
            order: count,
            kind: z.enum(["invalidRegex", "regexNotChecked", "unknownAction", "malformedActions"]),
            certainty: z.enum(["everyArticle", "whenMatched", "notDeterminable"]),
        }),
    ),
    fetchBlockerCounts: z.strictObject({ everyArticle: count, whenMatched: count, notDeterminable: count }),
    chainRevision: z.string(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    scan: ruleScan,
    meta: groupMeta,
})

export type ListRulesInput = z.output<typeof listRulesInput>
export type ListRulesOutput = z.output<typeof listRulesOutput>
export type GetRuleChainInput = z.output<typeof getRuleChainInput>
export type GetRuleChainOutput = z.output<typeof getRuleChainOutput>
