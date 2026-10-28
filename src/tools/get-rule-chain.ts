/**
 * get_rule_chain (FR-MCP-01 §14.9, adapted to the FR-MCP-02A-05 contract).
 *
 * The ordered chain the app evaluates for one target (`getRulesForTarget` in
 * the fork's rule.ts), paginated by chain order:
 *  - all: sourceRules.all;
 *  - group (a unique multiple group, as get_group): all + group:<gid>;
 *  - source (existing now; optional sourceRef verified as in get_source):
 *    all + the first multiple group containing it (GroupIndex.groupOf) +
 *    source:<sid>. When that first group cannot be resolved reliably
 *    (ambiguous gid, negative gid, sourceGroups unavailable) its rules are NOT
 *    in the chain, no later group is used instead, and resolution.complete is
 *    false: the chain is explicitly incomplete.
 *
 * Rules are decoded and diagnosed statically (domain/rules.ts). conflicts are
 * structural notes on the whole chain, returned when they involve an order of
 * the requested window [order, order + limit); conflictCounts cover the whole
 * chain. fetchBlockers are those of the returned entries; fetchBlockerCounts
 * cover the whole chain. Nothing is evaluated on any article.
 *
 * The cursor binds the target, limit, sourceRef, the next order and the chain
 * revision (the stored arrays used, the resolved group and the source
 * identity): CURSOR_STALE when any of them changed. A chain longer than
 * RULES_CONSULTED_MAX is LIMIT_EXCEEDED ("too-many-rules").
 */

import crypto from "node:crypto"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError } from "../errors.js"
import {
    analyzeRule,
    chainNotes,
    NOTE_ORDERS_MAX,
    NOTES_PER_PAGE_MAX,
    ruleKey,
    rulesRevision,
    RULES_CONSULTED_MAX,
    type RuleScope,
} from "../domain/rules.js"
import type { StoredRuleEntry } from "../settings/read-settings.js"
import { CURSOR_TOKEN_LENGTH, type CursorEntry } from "../scan/cursors.js"
import { loadGroups, type ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { PageBudget, resultLength, successResult } from "./result.js"
import { readSourceTarget } from "./rule-targets.js"
import {
    CHAIN_SEMANTICS,
    getRuleChainInput,
    RESULT_SCHEMA_VERSION,
    RULE_CHAIN_LIMIT_DEFAULT,
    type GetRuleChainInput,
    type GetRuleChainOutput,
} from "./schemas.js"

export const GET_RULE_CHAIN = "get_rule_chain"

type Output = GetRuleChainOutput
type StoppedBy = Output["scan"]["stoppedBy"]

interface Binding {
    readonly [key: string]: string | number | boolean | null
    readonly scope: RuleScope
    readonly id: number | null
    readonly sourceRef: string | null
    readonly limit: number
}

interface ChainState {
    readonly nextOrder: number
    readonly chainRevision: string
}

interface Part {
    readonly origin: RuleScope
    readonly key: string
    readonly inherited: boolean
    readonly rules: readonly StoredRuleEntry[]
}

export async function getRuleChain(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(getRuleChainInput, args)
    return context.cursors.exclusive(() => run(context, input))
}

async function run(context: ToolContext, input: GetRuleChainInput): Promise<CallToolResult> {
    const scope: RuleScope = input.sourceId !== undefined ? "source" : input.groupId !== undefined ? "group" : "all"
    const id = input.sourceId ?? input.groupId ?? null
    let binding: Binding = { scope, id, sourceRef: input.sourceRef ?? null, limit: input.limit ?? RULE_CHAIN_LIMIT_DEFAULT }
    let entry: CursorEntry<ChainState> | undefined
    if (input.cursor !== undefined) {
        entry = context.cursors.resolve<ChainState>(input.cursor, GET_RULE_CHAIN)
        const bound = entry.binding as Binding
        const mismatch =
            scope !== bound.scope ||
            id !== bound.id ||
            (input.limit !== undefined && input.limit !== bound.limit) ||
            (input.sourceRef !== undefined && input.sourceRef !== bound.sourceRef)
        if (mismatch) throw new FrMcpError("CURSOR_MISMATCH", "filters-changed")
        binding = bound
        if (entry.response !== undefined) return JSON.parse(entry.response) as CallToolResult
    }

    const groups = await loadGroups(context)
    const rules = groups.rules()
    const part = (origin: RuleScope, key: string, inherited: boolean): Part => ({ origin, key, inherited, rules: rules.get(key) ?? [] })
    const all = part("all", "all", scope !== "all")

    let target: Output["target"]
    let resolution: Omit<Output["resolution"], "chainLength" | "countByOrigin">
    let parts: Part[]
    let identity: string | null = null
    if (scope === "all") {
        target = { scope, key: "all", sourceId: null, groupId: null, name: null, sourceRef: null }
        resolution = { complete: true, groupStatus: "notApplicable", reason: "targetIsAll", groupId: null, groupPosition: null }
        parts = [all]
    } else if (scope === "group") {
        const gid = id as number
        const { index, entry: group } = groups.locate(gid)
        target = { scope, key: ruleKey("group", gid), sourceId: null, groupId: gid, name: group.name ?? null, sourceRef: null }
        resolution = { complete: true, groupStatus: "target", reason: "targetIsGroup", groupId: gid, groupPosition: index }
        parts = [all, part("group", ruleKey("group", gid), false)]
    } else {
        const sid = id as number
        const source = await context.database.withReadConnection((db) => readSourceTarget(db, sid))
        if (!source.exists) throw new FrMcpError("NOT_FOUND", "source-not-found")
        if (binding.sourceRef !== null) {
            // As get_source: a record over the limit cannot be verified.
            if (source.tooLarge) throw new FrMcpError("LIMIT_EXCEEDED", "record-too-large")
            context.identity.verify(binding.sourceRef, sid, source.url)
        }
        const sourceRef = source.url === null ? null : context.identity.refFor(sid, source.url)
        identity = sourceRef
        target = { scope, key: ruleKey("source", sid), sourceId: sid, groupId: null, name: source.name, sourceRef }
        const own = part("source", ruleKey("source", sid), false)
        const info = groups.groupOf(sid)
        const position = groups.ownerIndex(sid) ?? null
        if (info.groupStatus === "grouped") {
            const gid = info.groupId as number
            resolution = { complete: true, groupStatus: "grouped", reason: "firstMultipleGroup", groupId: gid, groupPosition: position }
            parts = [all, part("group", ruleKey("group", gid), true), own]
        } else if (info.groupStatus === "ungrouped") {
            resolution = { complete: true, groupStatus: "ungrouped", reason: "noMultipleGroup", groupId: null, groupPosition: null }
            parts = [all, own]
        } else if (info.groupStatus === "ambiguous") {
            // The duplicated gid is not resolved arbitrarily: no group part, chain declared incomplete.
            resolution = { complete: false, groupStatus: "ambiguous", reason: "firstGroupIdAmbiguous", groupId: info.groupId, groupPosition: position }
            parts = [all, own]
        } else {
            const available = groups.groupsAvailable
            resolution = {
                complete: false,
                groupStatus: "unavailable",
                reason: available ? "firstGroupIdInvalid" : "groupsUnavailable",
                groupId: null,
                groupPosition: available ? position : null,
            }
            parts = [all, own]
        }
    }

    const chain = parts.flatMap((p) => p.rules.map((rule, index) => ({ part: p, rule, index })))
    if (chain.length > RULES_CONSULTED_MAX) throw new FrMcpError("LIMIT_EXCEEDED", "too-many-rules")
    const chainRevision = `cr1.${crypto
        .createHash("sha256")
        .update(
            JSON.stringify({
                target: [scope, id],
                identity,
                resolution: [resolution.groupStatus, resolution.groupId, resolution.groupPosition],
                parts: parts.map((p) => [p.origin, p.key, rulesRevision(p.key, p.rules)]),
            }),
        )
        .digest()
        .subarray(0, 16)
        .toString("base64url")}`
    if (entry !== undefined && entry.state.chainRevision !== chainRevision) {
        context.cursors.invalidate(input.cursor as string)
        throw new FrMcpError("CURSOR_STALE", "rules-changed")
    }

    const analyses = chain.map((item) => analyzeRule(item.rule, item.index))
    const notes = chainNotes(analyses)
    const start = entry?.state.nextOrder ?? 0
    const windowEnd = start + binding.limit
    const windowNotes = notes.filter((note) => note.orders.some((order) => order >= start && order < windowEnd))
    const conflicts: Output["conflicts"] = windowNotes.slice(0, NOTES_PER_PAGE_MAX).map((note) => ({
        kind: note.kind,
        certainty: note.certainty,
        flag: note.flag,
        orders: note.orders.slice(0, NOTE_ORDERS_MAX),
        ordersCount: note.orders.length,
        ordersTruncated: note.orders.length > NOTE_ORDERS_MAX,
    }))
    const conflictCounts: Output["conflictCounts"] = {
        duplicateRule: 0,
        oppositeActionsSameCondition: 0,
        sameFlagDifferentConditions: 0,
        contradictoryActionsInRule: 0,
        stateDependentCondition: 0,
    }
    for (const note of notes) conflictCounts[note.kind]++
    const fetchBlockerCounts: Output["fetchBlockerCounts"] = { everyArticle: 0, whenMatched: 0, notDeterminable: 0 }
    for (const analysis of analyses) for (const blocker of analysis.blockers) fetchBlockerCounts[blocker.certainty]++
    const blockersOf = (order: number): Output["fetchBlockers"] => analyses[order]!.blockers.map((b) => ({ order, kind: b.kind, certainty: b.certainty }))

    const meta: Output["meta"] = { generatedAt: new Date(context.now()).toISOString(), schemaVersion: RESULT_SCHEMA_VERSION }
    const countByOrigin = { all: 0, group: 0, source: 0 }
    for (const item of chain) countByOrigin[item.part.origin]++
    const skeleton: Output = {
        target,
        chain: [],
        resolution: { ...resolution, chainLength: chain.length, countByOrigin },
        semantics: CHAIN_SEMANTICS,
        conflicts,
        conflictsOmitted: windowNotes.length - conflicts.length,
        conflictCounts,
        // Upper bound: the blockers of the whole window (the page returns those of its entries only).
        fetchBlockers: chain.slice(start, windowEnd).flatMap((_, k) => blockersOf(start + k)),
        fetchBlockerCounts,
        chainRevision,
        hasMore: false,
        nextCursor: "x".repeat(CURSOR_TOKEN_LENGTH),
        scan: { examined: Number.MAX_SAFE_INTEGER, stoppedBy: "responseBudget" },
        meta,
    }
    const budget = new PageBudget(resultLength(skeleton))
    const page: Output["chain"] = []
    let stoppedBy: StoppedBy | undefined
    let order = start
    for (; order < chain.length; order++) {
        if (page.length === binding.limit) {
            stoppedBy = "pageFull"
            break
        }
        const item = chain[order]!
        const element: Output["chain"][number] = {
            order,
            origin: item.part.origin,
            originKey: item.part.key,
            inherited: item.part.inherited,
            index: item.index,
            rule: analyses[order]!.summary,
        }
        if (!budget.tryAdd(JSON.stringify(element))) {
            if (page.length === 0) throw new FrMcpError("LIMIT_EXCEEDED", "response-too-large")
            stoppedBy = "responseBudget"
            break
        }
        page.push(element)
    }

    let nextCursor: string | null = null
    if (stoppedBy !== undefined) {
        const state: ChainState = { nextOrder: order, chainRevision }
        nextCursor = context.cursors.create(GET_RULE_CHAIN, binding, state, entry?.scanStartedAt ?? context.now())
    }
    const payload: Output = {
        ...skeleton,
        chain: page,
        fetchBlockers: page.flatMap((element) => blockersOf(element.order)),
        hasMore: stoppedBy !== undefined,
        nextCursor,
        scan: { examined: page.length, stoppedBy: stoppedBy ?? "exhausted" },
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
