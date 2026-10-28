/**
 * get_group (FR-MCP-01 §14.4, adapted to the FR-MCP-02A-03 contract).
 *
 * One user group by gid, with its members paginated by their index in the
 * stored `sids` array (stored order, duplicates and orphans included, never
 * sorted). Errors as GroupIndex.locate: NOT_FOUND (absent gid or a single
 * entry), GROUP_AMBIGUOUS (gid carried by several entries), the settings
 * error when sourceGroups is unavailable.
 *
 * Each call reads the window [index, index + limit) of the members:
 *  - S1/S2 of domain/sources.ts for the window's distinct sids >= 0 (point
 *    lookups on the primary key). A member with no row is `exists: false`.
 *    Members are accepted in order while each record is at most
 *    RECORD_BYTES_MAX and together at most BATCH_BYTES_MAX; the first member
 *    over the record limit is LIMIT_EXCEEDED if nothing precedes it in the
 *    page, otherwise the page stops before it (never skipped).
 *  - the members' existence, for the orphan count, when the group has at
 *    most MEMBER_CHECK_MAX distinct members (ids only).
 * `effectiveGroup` is true when this group is the member's first group, the
 * one whose rules apply (`getRulesForTarget` in the fork's rule.ts), false
 * when an earlier group lists it too; null for a member that does not exist
 * or has an invalid (negative) sid.
 *
 * The cursor binds groupId, limit, the next index and the groupsRevision of
 * the first page: CURSOR_STALE when sourceGroups changed in between.
 */

import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError } from "../errors.js"
import {
    analyzeMembers,
    distinctValidMembers,
    groupsRevision,
    MEMBER_CHECK_MAX,
    readExistingSids,
} from "../domain/group-catalog.js"
import {
    BATCH_BYTES_MAX,
    readCandidates,
    readSourceRows,
    RECORD_BYTES_MAX,
    SourceRecord,
    type SourceRow,
} from "../domain/sources.js"
import { CURSOR_TOKEN_LENGTH, type CursorEntry } from "../scan/cursors.js"
import { loadGroups, type ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { PageBudget, resultLength, RESP_MAX, successResult } from "./result.js"
import { GROUP_LIMIT_DEFAULT, getGroupInput, RESULT_SCHEMA_VERSION, type GetGroupInput, type GetGroupOutput } from "./schemas.js"

export const GET_GROUP = "get_group"

type GroupSource = GetGroupOutput["sources"][number]
type StoppedBy = GetGroupOutput["scan"]["stoppedBy"]

interface Binding {
    readonly [key: string]: string | number | boolean | null
    readonly groupId: number
    readonly limit: number
}

interface GetGroupState {
    readonly nextIndex: number
    readonly groupsRevision: string
}

interface WindowRead {
    /** Members of the window accepted by the byte budgets (a prefix of the window). */
    readonly accepted: number
    readonly cutByBytes: boolean
    readonly present: ReadonlySet<number>
    readonly rows: ReadonlyMap<number, SourceRow>
    readonly existing: ReadonlySet<number> | null
}

export async function getGroup(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(getGroupInput, args)
    return context.cursors.exclusive(() => run(context, input))
}

async function run(context: ToolContext, input: GetGroupInput): Promise<CallToolResult> {
    let entry: CursorEntry<GetGroupState> | undefined
    let binding: Binding = { groupId: input.groupId, limit: input.limit ?? GROUP_LIMIT_DEFAULT }
    if (input.cursor !== undefined) {
        entry = context.cursors.resolve<GetGroupState>(input.cursor, GET_GROUP)
        const bound = entry.binding as Binding
        if (input.groupId !== bound.groupId || (input.limit !== undefined && input.limit !== bound.limit)) {
            throw new FrMcpError("CURSOR_MISMATCH", "filters-changed")
        }
        binding = bound
        if (entry.response !== undefined) return JSON.parse(entry.response) as CallToolResult
    }

    const groups = await loadGroups(context)
    const revision = groupsRevision(groups.entries())
    if (entry !== undefined && entry.state.groupsRevision !== revision) {
        context.cursors.invalidate(input.cursor as string)
        throw new FrMcpError("CURSOR_STALE", "group-changed")
    }
    const { index: position, entry: group } = groups.locate(binding.groupId)
    const start = entry?.state.nextIndex ?? 0
    const window = group.sids.slice(start, start + binding.limit)
    const windowSids = [...new Set(window)].filter((sid) => sid >= 0)
    const members = distinctValidMembers(group)
    const checkAll = members.length <= MEMBER_CHECK_MAX

    const read: WindowRead =
        windowSids.length === 0 && (members.length === 0 || !checkAll)
            ? { accepted: window.length, cutByBytes: false, present: new Set(), rows: new Map(), existing: checkAll ? new Set() : null }
            : await context.database.withReadConnection((db): WindowRead => {
                  const existing = checkAll ? readExistingSids(db, members) : null
                  const candidates = readCandidates(db, 0, Number.MAX_SAFE_INTEGER, windowSids.length, windowSids)
                  const bytes = new Map(candidates.map((c) => [c.sid, c.bytes]))
                  const loaded = new Set<number>()
                  let total = 0
                  let accepted = 0
                  let cutByBytes = false
                  for (const sid of window) {
                      const size = bytes.get(sid)
                      if (size !== undefined && !loaded.has(sid)) {
                          if (size > RECORD_BYTES_MAX) {
                              if (accepted === 0) throw new FrMcpError("LIMIT_EXCEEDED", "record-too-large")
                              cutByBytes = true
                              break
                          }
                          if (loaded.size > 0 && total + size > BATCH_BYTES_MAX) {
                              cutByBytes = true
                              break
                          }
                          loaded.add(sid)
                          total += size
                      }
                      accepted++
                  }
                  return { accepted, cutByBytes, present: new Set(bytes.keys()), rows: readSourceRows(db, [...loaded]), existing }
              })

    const meta: GetGroupOutput["meta"] = {
        generatedAt: new Date(context.now()).toISOString(),
        schemaVersion: RESULT_SCHEMA_VERSION,
        urlsRedacted: true,
    }
    const skeleton: GetGroupOutput = {
        groupId: group.gid,
        name: group.name ?? null,
        position,
        sourceCount: group.sids.length,
        distinctSourceCount: new Set(group.sids).size,
        ruleCount: groups.groupRuleCount(group.gid),
        rulesError: groups.rulesError,
        sources: [],
        integrity: analyzeMembers(groups, position, group, read.existing),
        groupsRevision: revision,
        hasMore: false,
        nextCursor: "x".repeat(CURSOR_TOKEN_LENGTH),
        scan: { examined: Number.MAX_SAFE_INTEGER, stoppedBy: "responseBudget" },
        meta,
    }
    const skeletonLength = resultLength(skeleton)
    // The group header alone (for example a huge name) cannot be returned: no truncation.
    if (skeletonLength > RESP_MAX) throw new FrMcpError("LIMIT_EXCEEDED", "response-too-large")
    const budget = new PageBudget(skeletonLength)

    const sources: GroupSource[] = []
    let stoppedBy: StoppedBy | undefined = read.cutByBytes ? "byteBudget" : undefined
    for (let i = 0; i < read.accepted; i++) {
        const sid = window[i]!
        const item = member(context, groups.ownerIndex(sid) === position, sid, start + i, read)
        if (!budget.tryAdd(JSON.stringify(item))) {
            if (sources.length === 0) throw new FrMcpError("LIMIT_EXCEEDED", "record-too-large")
            stoppedBy = "responseBudget"
            break
        }
        sources.push(item)
    }
    const nextIndex = start + sources.length
    const hasMore = nextIndex < group.sids.length
    if (hasMore && stoppedBy === undefined) stoppedBy = "pageFull"

    let nextCursor: string | null = null
    if (hasMore) {
        const state: GetGroupState = { nextIndex, groupsRevision: revision }
        nextCursor = context.cursors.create(GET_GROUP, binding, state, entry?.scanStartedAt ?? context.now())
    }
    const payload: GetGroupOutput = {
        ...skeleton,
        sources,
        hasMore,
        nextCursor,
        scan: { examined: sources.length, stoppedBy: hasMore ? (stoppedBy as StoppedBy) : "exhausted" },
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

/** One member: identity, name and hidden flag of its source, or nulls when it does not exist. */
function member(context: ToolContext, effective: boolean, sid: number, index: number, read: WindowRead): GroupSource {
    if (sid < 0) {
        return { index, sourceId: null, sourceRef: null, name: null, hidden: null, exists: null, effectiveGroup: null }
    }
    if (!read.present.has(sid)) {
        return { index, sourceId: sid, sourceRef: null, name: null, hidden: null, exists: false, effectiveGroup: null }
    }
    const row = read.rows.get(sid)
    // S1 and S2 run in one read transaction: every accepted member found by S1 has its row.
    if (row === undefined) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
    const record = new SourceRecord(row)
    const url = record.url()
    const item: GroupSource = {
        index,
        sourceId: sid,
        sourceRef: url === null ? null : context.identity.refFor(sid, url),
        name: record.name(),
        hidden: record.hidden(),
        exists: true,
        effectiveGroup: effective,
    }
    const issues = record.issues()
    if (issues.length > 0) item.fieldIssues = [...issues]
    return item
}
