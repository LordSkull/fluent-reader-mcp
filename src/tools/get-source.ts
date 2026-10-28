/**
 * get_source (FR-MCP-01 §14.2): one source by primary key, with the fields of
 * list_sources plus the text direction and the number of stored rules for the
 * source and its group (from the validated sourceRules, nothing evaluated).
 *
 * No article aggregate is computed: `items` has no index on `source`, so any
 * count or date range would scan the whole table. They are returned as null
 * with `available: false`.
 */

import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError } from "../errors.js"
import { readCandidate, readSourceRows, selectBatch, toSummary, withIssues } from "../domain/sources.js"
import { loadGroups, type ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { successResult } from "./result.js"
import { getSourceInput, RESULT_SCHEMA_VERSION, type GetSourceOutput } from "./schemas.js"

export const GET_SOURCE = "get_source"

const ARTICLE_STATS_UNAVAILABLE: GetSourceOutput["source"]["articleStats"] = {
    available: false,
    reason: "not-computed-without-index",
    articleCount: null,
    unreadCount: null,
    starredCount: null,
    hiddenCount: null,
    oldestDate: null,
    newestDate: null,
}

export async function getSource(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(getSourceInput, args)
    const groups = await loadGroups(context)
    const row = await context.database.withReadConnection((db) => {
        const candidate = readCandidate(db, input.sourceId)
        if (candidate === undefined) return undefined
        selectBatch([candidate])
        return readSourceRows(db, [candidate.sid]).get(candidate.sid)
    })
    if (row === undefined) throw new FrMcpError("NOT_FOUND", "source-not-found")

    const { summary, record, url } = toSummary(row, groups, context.identity)
    if (input.sourceRef !== undefined) context.identity.verify(input.sourceRef, row.sid, url)

    const source: GetSourceOutput["source"] = withIssues(
        {
            ...summary,
            textDir: record.textDir(),
            rules: groups.ruleCounts(row.sid),
            articleStats: ARTICLE_STATS_UNAVAILABLE,
        },
        record,
    )
    const payload: GetSourceOutput = {
        source,
        meta: {
            generatedAt: new Date(context.now()).toISOString(),
            schemaVersion: RESULT_SCHEMA_VERSION,
            urlsRedacted: true,
            groupsAvailable: groups.groupsAvailable,
            groupsError: groups.groupsError,
        },
    }
    return successResult(payload).result
}
