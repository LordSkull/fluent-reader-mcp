/**
 * list_groups (FR-MCP-01 §14.3, adapted to the FR-MCP-02A-03 contract).
 *
 * Lists the user groups (`isMultiple: true` entries) of sourceGroups in
 * stored order, with their position in the whole array (single entries keep
 * their positions but are never returned). Nothing is repaired.
 *
 * Pagination is by position: each call examines entries from the cursor's
 * position on; single entries and groups excluded by includeEmpty are
 * consumed, returned groups are consumed, and the call stops before the
 * first group that would exceed `limit` or the response budget (it is
 * examined again next time). A page is full only when another returnable
 * group exists, so hasMore is exact; every successful call returns at least
 * one group or ends the listing, or fails with LIMIT_EXCEEDED.
 *
 * The cursor binds includeEmpty, limit and the groupsRevision of the first
 * page: a different revision on a later page is CURSOR_STALE. The response
 * published for a cursor is replayed verbatim (scan/cursors.ts).
 *
 * Database: only the bounded id read of readDatabaseSids (existing members,
 * orphans, ungrouped sources); `items` is never read.
 */

import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError } from "../errors.js"
import { analyzeGroups, groupsRevision, idStatus, readDatabaseSids } from "../domain/group-catalog.js"
import { CURSOR_TOKEN_LENGTH, type CursorEntry } from "../scan/cursors.js"
import { loadGroups, type ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { PageBudget, resultLength, successResult } from "./result.js"
import {
    GROUP_LIMIT_DEFAULT,
    listGroupsInput,
    RESULT_SCHEMA_VERSION,
    type ListGroupsInput,
    type ListGroupsOutput,
} from "./schemas.js"

export const LIST_GROUPS = "list_groups"

type GroupSummary = ListGroupsOutput["groups"][number]
type StoppedBy = ListGroupsOutput["scan"]["stoppedBy"]

interface Binding {
    readonly [key: string]: string | number | boolean | null
    readonly includeEmpty: boolean
    readonly limit: number
}

interface ListGroupsState {
    readonly nextPosition: number
    readonly groupsRevision: string
}

function normalize(input: ListGroupsInput): Binding {
    return { includeEmpty: input.includeEmpty ?? true, limit: input.limit ?? GROUP_LIMIT_DEFAULT }
}

export async function listGroups(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(listGroupsInput, args)
    return context.cursors.exclusive(() => run(context, input))
}

async function run(context: ToolContext, input: ListGroupsInput): Promise<CallToolResult> {
    let entry: CursorEntry<ListGroupsState> | undefined
    let binding: Binding
    if (input.cursor !== undefined) {
        entry = context.cursors.resolve<ListGroupsState>(input.cursor, LIST_GROUPS)
        binding = entry.binding as Binding
        const given = normalize(input)
        for (const key of ["includeEmpty", "limit"] as const) {
            if (input[key] !== undefined && given[key] !== binding[key]) throw new FrMcpError("CURSOR_MISMATCH", "filters-changed")
        }
        if (entry.response !== undefined) return JSON.parse(entry.response) as CallToolResult
    } else {
        binding = normalize(input)
    }

    const groups = await loadGroups(context)
    const entries = groups.entries()
    const revision = groupsRevision(entries)
    if (entry !== undefined && entry.state.groupsRevision !== revision) {
        context.cursors.invalidate(input.cursor as string)
        throw new FrMcpError("CURSOR_STALE", "group-changed")
    }
    const database = await context.database.withReadConnection(readDatabaseSids)
    const integrity = analyzeGroups(groups, entries, database)

    const meta: ListGroupsOutput["meta"] = {
        generatedAt: new Date(context.now()).toISOString(),
        schemaVersion: RESULT_SCHEMA_VERSION,
    }
    // Every page-dependent field at its longest serialization.
    const skeleton: ListGroupsOutput = {
        groups: [],
        integrity,
        groupsRevision: revision,
        hasMore: false,
        nextCursor: "x".repeat(CURSOR_TOKEN_LENGTH),
        scan: { examined: Number.MAX_SAFE_INTEGER, filteredOut: Number.MAX_SAFE_INTEGER, stoppedBy: "responseBudget" },
        meta,
    }
    const budget = new PageBudget(resultLength(skeleton))

    const page: GroupSummary[] = []
    let examined = 0
    let filteredOut = 0
    let stoppedBy: StoppedBy | undefined
    let position = entry?.state.nextPosition ?? 0
    for (; position < entries.length; position++) {
        const group = entries[position]!
        if (!group.isMultiple) continue
        if (!binding.includeEmpty && group.sids.length === 0) {
            examined++
            filteredOut++
            continue
        }
        if (page.length === binding.limit) {
            stoppedBy = "pageFull"
            break
        }
        const status = idStatus(groups, group)
        const distinct = new Set(group.sids)
        let existing: number | null = null
        if (database.sids !== null) {
            existing = 0
            for (const sid of distinct) if (database.sids.has(sid)) existing++
        }
        const item: GroupSummary = {
            position,
            groupId: status === "invalid" ? null : group.gid,
            idStatus: status,
            name: group.name ?? null,
            sourceCount: group.sids.length,
            distinctSourceCount: distinct.size,
            existingSourceCount: existing,
        }
        if (!budget.tryAdd(JSON.stringify(item))) {
            // A group that cannot be returned even alone: stable error, no progress.
            if (page.length === 0) throw new FrMcpError("LIMIT_EXCEEDED", "record-too-large")
            stoppedBy = "responseBudget"
            break
        }
        page.push(item)
        examined++
    }

    let nextCursor: string | null = null
    if (stoppedBy !== undefined) {
        const state: ListGroupsState = { nextPosition: position, groupsRevision: revision }
        nextCursor = context.cursors.create(LIST_GROUPS, binding, state, entry?.scanStartedAt ?? context.now())
    }
    const payload: ListGroupsOutput = {
        groups: page,
        integrity,
        groupsRevision: revision,
        hasMore: stoppedBy !== undefined,
        nextCursor,
        scan: { examined, filteredOut, stoppedBy: stoppedBy ?? "exhausted" },
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
