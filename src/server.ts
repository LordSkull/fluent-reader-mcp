/**
 * MCP server factory (SDK v2). Registers exactly the read-only tools of
 * FR-MCP-02A-02 (list_sources, get_source) and FR-MCP-02A-03 (list_groups,
 * get_group).
 *
 * Every handler returns either the success result of tools/result.ts or a
 * sanitized isError result; no exception escapes to the SDK.
 */

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import { toSafeError } from "./errors.js"
import { logEvent } from "./log.js"
import type { ToolContext } from "./tools/context.js"
import { GET_GROUP, getGroup } from "./tools/get-group.js"
import { GET_SOURCE, getSource } from "./tools/get-source.js"
import { advertised } from "./tools/input.js"
import { LIST_GROUPS, listGroups } from "./tools/list-groups.js"
import { LIST_SOURCES, listSources } from "./tools/list-sources.js"
import { errorResult, RESP_MAX } from "./tools/result.js"
import {
    getGroupInput,
    getGroupOutput,
    getSourceInput,
    getSourceOutput,
    GROUP_LIMIT_MAX,
    listGroupsInput,
    listGroupsOutput,
    listSourcesInput,
    listSourcesOutput,
} from "./tools/schemas.js"

export const SERVER_NAME = "fluent-reader-mcp"
export const SERVER_VERSION = "0.1.0"

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

const LIST_SOURCES_DESCRIPTION = [
    "Lists the RSS sources of the local Fluent Reader profile, by ascending sourceId, read-only.",
    "Filters: includeHidden (default true), groupId (sources whose first group is it), query (case-insensitive literal substring of the name).",
    "Pagination: pass nextCursor back as cursor while hasMore is true. A page can hold fewer sources than limit, or none, and still have hasMore: true (filters, response size limit).",
    "Cursors expire 30 minutes after their last use (2 hours per listing), at most 64 are kept, and they are lost when the server restarts. Repeating a cursor returns the same page.",
    "Sources added after the first page with a higher id are not included; deleted ones disappear.",
    "Feed and icon URLs are never returned. sourceId can be reused by a new source after a deletion: keep sourceRef to detect it with get_source.",
    `Responses are limited to ${RESP_MAX} UTF-16 code units; no name is truncated.`,
].join(" ")

const GET_SOURCE_DESCRIPTION = [
    "Returns one RSS source of the local Fluent Reader profile by sourceId, read-only: the list_sources fields, text direction and the number of stored rules for the source and its group.",
    "Pass sourceRef (from list_sources) to fail with SOURCE_IDENTITY_CHANGED instead of returning a different source that reused the id.",
    "Article counts and dates are not computed (they would require scanning every article) and are returned as null.",
    "Feed and icon URLs are never returned.",
].join(" ")

const LIST_GROUPS_DESCRIPTION = [
    "Lists the user groups of the local Fluent Reader profile (sourceGroups entries with isMultiple: true) in their stored order, read-only.",
    "position is the index in the whole sourceGroups array, single-source entries included (those are not groups and are never listed).",
    "groupId is null with idStatus 'invalid' for a negative stored gid; idStatus 'ambiguous' means several entries carry the gid (get_group fails with GROUP_AMBIGUOUS).",
    "sourceCount counts configured member entries, existingSourceCount the distinct members that exist in the database (null if not checked).",
    "integrity reports duplicates, overlaps, orphans and ungrouped sources with exact counts and samples of at most 20 ids; database-based parts are null when databaseCheck is not 'complete'.",
    `Pagination: pass nextCursor back as cursor while hasMore is true (limit 1..${GROUP_LIMIT_MAX}). CURSOR_STALE if sourceGroups changed since the first page (groupsRevision). Cursors behave as in list_sources.`,
    `Responses are limited to ${RESP_MAX} UTF-16 code units; no name is truncated. Nothing is repaired.`,
].join(" ")

const GET_GROUP_DESCRIPTION = [
    "Returns one user group of the local Fluent Reader profile by groupId, read-only, with its members in stored order, paginated by member index (never sorted; duplicates and orphans included).",
    "For each member: sourceId, sourceRef, name, hidden, exists (false for an orphan id with no source), effectiveGroup (true if this is the member's first group, whose rules apply; false if an earlier group lists it; null when unknown).",
    "ruleCount is the number of stored rules of the group (null with rulesError if sourceRules is unreadable); no rule is evaluated.",
    "Errors: NOT_FOUND (no such group, or a single-source entry), GROUP_AMBIGUOUS (gid carried by several entries), CURSOR_STALE (sourceGroups changed since the first page).",
    "Feed and icon URLs are never returned.",
].join(" ")

async function handle(tool: string, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
        return await run()
    } catch (error) {
        const safe = toSafeError(error)
        logEvent("tool_error", { tool, code: safe.code, ...(safe.reason && { reason: safe.reason }) })
        return errorResult(safe)
    }
}

export function createServer(context: ToolContext): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } })
    server.registerTool(
        LIST_SOURCES,
        {
            title: "List Fluent Reader sources",
            description: LIST_SOURCES_DESCRIPTION,
            inputSchema: advertised(listSourcesInput),
            outputSchema: listSourcesOutput,
            annotations: ANNOTATIONS,
        },
        (args: unknown) => handle(LIST_SOURCES, () => listSources(context, args)),
    )
    server.registerTool(
        GET_SOURCE,
        {
            title: "Get a Fluent Reader source",
            description: GET_SOURCE_DESCRIPTION,
            inputSchema: advertised(getSourceInput),
            outputSchema: getSourceOutput,
            annotations: ANNOTATIONS,
        },
        (args: unknown) => handle(GET_SOURCE, () => getSource(context, args)),
    )
    server.registerTool(
        LIST_GROUPS,
        {
            title: "List Fluent Reader groups",
            description: LIST_GROUPS_DESCRIPTION,
            inputSchema: advertised(listGroupsInput),
            outputSchema: listGroupsOutput,
            annotations: ANNOTATIONS,
        },
        (args: unknown) => handle(LIST_GROUPS, () => listGroups(context, args)),
    )
    server.registerTool(
        GET_GROUP,
        {
            title: "Get a Fluent Reader group",
            description: GET_GROUP_DESCRIPTION,
            inputSchema: advertised(getGroupInput),
            outputSchema: getGroupOutput,
            annotations: ANNOTATIONS,
        },
        (args: unknown) => handle(GET_GROUP, () => getGroup(context, args)),
    )
    return server
}
