/**
 * list_sources (FR-MCP-01 §14.1, adapted to the FR-MCP-02A-02 contract).
 *
 * Keyset scan on the primary key `sid`, ascending, never OFFSET:
 *  - The first page anchors the listing to [MIN(sid), MAX(sid)] observed then
 *    (`lo`, `hi`); sources inserted later with a larger sid are not visited.
 *  - Each call reads one S1 batch of at most `candidateBudget` sids from
 *    [nextLower, hi] (restricted to the group's members with groupId), keeps
 *    the leading candidates that fit the byte budgets, and loads them (S2).
 *  - Candidates are then processed in order. A candidate is *consumed* when
 *    it is returned or excluded by a filter; the checkpoint is the last
 *    consumed sid, and the next page starts right after it. Candidates read
 *    but not consumed (page full, response budget) are read again next time.
 *  - The scan is exhausted when the anchor `hi` was consumed, S1 found
 *    nothing, or S1 returned fewer than its budget and all were consumed.
 *    Exhaustion is never inferred from the number of sources returned, so
 *    pages can be partial or even empty with a non-null nextCursor.
 * Every successful call consumes at least the first candidate (or fails with
 * LIMIT_EXCEEDED without advancing), so a listing ends after at most
 * (number of sids in [lo, hi]) + 1 calls. No transaction outlives a call.
 *
 * Cursors (scan/cursors.ts) bind the normalized arguments and the scan state;
 * the response published for a cursor is replayed verbatim when the same
 * cursor is used again. CURSOR_STALE when the group's membership or the
 * database schema changed since the listing started.
 */

import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError } from "../errors.js"
import type { GroupMembers } from "../domain/groups.js"
import {
    readCandidates,
    readSchemaVersion,
    readSidBounds,
    readSourceRows,
    selectBatch,
    toSummary,
    withIssues,
    type Candidate,
    type SourceRow,
    type SourceSummary,
} from "../domain/sources.js"
import { CURSOR_TOKEN_LENGTH, type CursorEntry } from "../scan/cursors.js"
import { loadGroups, type ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { PageBudget, resultLength, successResult } from "./result.js"
import {
    LIST_LIMIT_DEFAULT,
    listSourcesInput,
    RESULT_SCHEMA_VERSION,
    type ListSourcesInput,
    type ListSourcesOutput,
} from "./schemas.js"

export const LIST_SOURCES = "list_sources"

/** S1 batch size: twice the page size, within [200, 1000] sids per call. */
export function candidateBudget(limit: number): number {
    return Math.min(1000, Math.max(200, 2 * limit))
}

type StoppedBy = ListSourcesOutput["scan"]["stoppedBy"]
const STOPPED_BY: readonly StoppedBy[] = ["exhausted", "pageFull", "responseBudget", "byteBudget", "candidateBudget"]
const LONGEST_STOPPED_BY = STOPPED_BY.reduce((a, b) => (b.length > a.length ? b : a))

interface Binding {
    readonly [key: string]: string | number | boolean | null
    readonly includeHidden: boolean
    readonly groupId: number | null
    readonly query: string | null
    readonly limit: number
}

interface ListState {
    readonly lo: number
    readonly hi: number
    readonly nextLower: number
    readonly schemaVersion: number
    readonly groupRevision: string | null
}

function normalize(input: ListSourcesInput): Binding {
    return {
        includeHidden: input.includeHidden ?? true,
        groupId: input.groupId ?? null,
        query: input.query ?? null,
        limit: input.limit ?? LIST_LIMIT_DEFAULT,
    }
}

/** Arguments repeated with a cursor must equal those the listing started with. */
function checkBinding(input: ListSourcesInput, binding: Binding): void {
    const given = normalize(input)
    for (const key of ["includeHidden", "groupId", "query", "limit"] as const) {
        if (input[key] !== undefined && given[key] !== binding[key]) {
            throw new FrMcpError("CURSOR_MISMATCH", "filters-changed")
        }
    }
}

/** Case-insensitive comparison form (NFC, lower case). The query is literal text. */
function fold(text: string): string {
    return text.normalize("NFC").toLowerCase()
}

interface PageRead {
    readonly schemaVersion: number
    readonly bounds: { lo: number; hi: number } | null
    readonly candidates: readonly Candidate[]
    readonly batch: readonly Candidate[]
    readonly rows: ReadonlyMap<number, SourceRow>
}

export async function listSources(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(listSourcesInput, args)
    return context.cursors.exclusive(() => run(context, input))
}

async function run(context: ToolContext, input: ListSourcesInput): Promise<CallToolResult> {
    let entry: CursorEntry<ListState> | undefined
    let binding: Binding
    if (input.cursor !== undefined) {
        entry = context.cursors.resolve<ListState>(input.cursor, LIST_SOURCES)
        binding = entry.binding as Binding
        checkBinding(input, binding)
        if (entry.response !== undefined) return JSON.parse(entry.response) as CallToolResult
    } else {
        binding = normalize(input)
    }
    const stale = (reason: "group-changed" | "schema-changed"): never => {
        if (input.cursor !== undefined) context.cursors.invalidate(input.cursor)
        throw new FrMcpError("CURSOR_STALE", reason)
    }

    const groups = await loadGroups(context)
    let members: GroupMembers | undefined
    if (binding.groupId !== null) {
        members = groups.members(binding.groupId)
        if (entry !== undefined && entry.state.groupRevision !== members.revision) stale("group-changed")
    }

    const budget = candidateBudget(binding.limit)
    const read = await context.database.withReadConnection((db): PageRead | "stale" => {
        const schemaVersion = readSchemaVersion(db)
        if (entry !== undefined && entry.state.schemaVersion !== schemaVersion) return "stale"
        const bounds = entry !== undefined ? { lo: entry.state.lo, hi: entry.state.hi } : readSidBounds(db)
        if (bounds === null) return { schemaVersion, bounds, candidates: [], batch: [], rows: new Map() }
        const lower = entry !== undefined ? entry.state.nextLower : bounds.lo
        const candidates = readCandidates(db, lower, bounds.hi, budget, members?.sids)
        const batch = candidates.length > 0 ? selectBatch(candidates) : []
        const rows = readSourceRows(db, batch.map((c) => c.sid))
        return { schemaVersion, bounds, candidates, batch, rows }
    })
    if (read === "stale") return stale("schema-changed")

    const meta: ListSourcesOutput["meta"] = {
        generatedAt: new Date(context.now()).toISOString(),
        schemaVersion: RESULT_SCHEMA_VERSION,
        urlsRedacted: true,
        groupsAvailable: groups.groupsAvailable,
        groupsError: groups.groupsError,
    }
    // Every page-dependent field at its longest serialization.
    const skeleton: ListSourcesOutput = {
        sources: [],
        hasMore: false,
        nextCursor: "x".repeat(CURSOR_TOKEN_LENGTH),
        scan: { examined: Number.MAX_SAFE_INTEGER, filteredOut: Number.MAX_SAFE_INTEGER, stoppedBy: LONGEST_STOPPED_BY },
        meta,
    }
    const pageBudget = new PageBudget(resultLength(skeleton))
    const query = binding.query === null ? null : fold(binding.query)

    const sources: SourceSummary[] = []
    let examined = 0
    let filteredOut = 0
    let lastConsumed: number | null = null
    let stoppedBy: StoppedBy | undefined
    for (const candidate of read.batch) {
        const row = read.rows.get(candidate.sid)
        // S1 and S2 run in one read transaction: every candidate has its row.
        if (row === undefined) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
        const { summary, record } = toSummary(row, groups, context.identity)
        const excluded =
            (!binding.includeHidden && summary.hidden === true) ||
            (query !== null && (summary.name === null || !fold(summary.name).includes(query)))
        if (excluded) {
            filteredOut++
        } else {
            if (sources.length === binding.limit) {
                stoppedBy = "pageFull"
                break
            }
            const item = withIssues(summary, record)
            if (!pageBudget.tryAdd(JSON.stringify(item))) {
                // A single source that cannot be returned even alone: stable error, no progress.
                if (sources.length === 0) throw new FrMcpError("LIMIT_EXCEEDED", "record-too-large")
                stoppedBy = "responseBudget"
                break
            }
            sources.push(item)
        }
        examined++
        lastConsumed = candidate.sid
    }

    let exhausted = false
    if (read.bounds === null || read.candidates.length === 0 || lastConsumed === read.bounds.hi) {
        exhausted = true
    } else if (stoppedBy === undefined) {
        if (read.batch.length < read.candidates.length) stoppedBy = "byteBudget"
        else if (read.candidates.length < budget) exhausted = true
        else stoppedBy = "candidateBudget"
    }

    let nextCursor: string | null = null
    if (!exhausted) {
        // Unreachable: the first candidate is always consumed or the call fails.
        if (read.bounds === null || lastConsumed === null) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
        const state: ListState = {
            lo: read.bounds.lo,
            hi: read.bounds.hi,
            nextLower: lastConsumed + 1,
            schemaVersion: read.schemaVersion,
            groupRevision: members?.revision ?? null,
        }
        nextCursor = context.cursors.create(LIST_SOURCES, binding, state, entry?.scanStartedAt ?? context.now())
    }

    const payload: ListSourcesOutput = {
        sources,
        hasMore: !exhausted,
        nextCursor,
        scan: { examined, filteredOut, stoppedBy: exhausted ? "exhausted" : (stoppedBy as StoppedBy) },
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
