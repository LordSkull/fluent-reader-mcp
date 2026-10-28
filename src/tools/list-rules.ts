/**
 * list_rules (FR-MCP-01 §14.8 mode a, adapted to the FR-MCP-02A-05 contract).
 *
 * The rules stored under exactly one key of sourceRules ("all",
 * `group:<gid>`, `source:<sid>`), in stored order, paginated by their index
 * in that array. Inherited rules are not added (see get_rule_chain). Each rule
 * is decoded and diagnosed statically (domain/rules.ts); none is applied and
 * no pattern is executed. Patterns are shown up to PATTERN_PREVIEW_MAX code
 * points, flagged when truncated.
 *
 * `integrity` describes the keys of the whole sourceRules (counts and samples
 * of ids, never arbitrary key text): source keys whose source does not exist
 * (primary-key lookups of ids only, at most MEMBER_CHECK_MAX), group keys
 * without a unique multiple group, malformed and negative keys.
 *
 * The cursor binds the target, limit, the next index and the revision of the
 * target's stored array: CURSOR_STALE when it changed. A target with more than
 * RULES_CONSULTED_MAX rules is LIMIT_EXCEEDED ("too-many-rules").
 */

import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError } from "../errors.js"
import { MEMBER_CHECK_MAX, readExistingSids } from "../domain/group-catalog.js"
import { analyzeRule, analyzeRuleKeys, ruleKey, rulesRevision, RULES_CONSULTED_MAX, sourceKeyIds } from "../domain/rules.js"
import { CURSOR_TOKEN_LENGTH, type CursorEntry } from "../scan/cursors.js"
import { loadGroups, type ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { PageBudget, resultLength, successResult } from "./result.js"
import { groupTarget, readSourceTarget, type SourceTarget } from "./rule-targets.js"
import { listRulesInput, RESULT_SCHEMA_VERSION, type ListRulesInput, type ListRulesOutput } from "./schemas.js"

export const LIST_RULES = "list_rules"

type StoppedBy = ListRulesOutput["scan"]["stoppedBy"]

interface Binding {
    readonly [key: string]: string | number | boolean | null
    readonly scope: "all" | "group" | "source"
    readonly id: number | null
    readonly limit: number
}

interface ListRulesState {
    readonly nextIndex: number
    readonly revision: string
}

export async function listRules(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(listRulesInput, args)
    return context.cursors.exclusive(() => run(context, input))
}

async function run(context: ToolContext, input: ListRulesInput): Promise<CallToolResult> {
    const given: Binding = { scope: input.scope, id: input.groupId ?? input.sourceId ?? null, limit: input.limit }
    let entry: CursorEntry<ListRulesState> | undefined
    if (input.cursor !== undefined) {
        entry = context.cursors.resolve<ListRulesState>(input.cursor, LIST_RULES)
        const bound = entry.binding as Binding
        if (given.scope !== bound.scope || given.id !== bound.id || given.limit !== bound.limit) {
            throw new FrMcpError("CURSOR_MISMATCH", "filters-changed")
        }
        if (entry.response !== undefined) return JSON.parse(entry.response) as CallToolResult
    }

    const groups = await loadGroups(context)
    const rules = groups.rules()
    const key = ruleKey(given.scope, given.id)
    const stored = rules.get(key) ?? []
    if (stored.length > RULES_CONSULTED_MAX) throw new FrMcpError("LIMIT_EXCEEDED", "too-many-rules")
    const revision = rulesRevision(key, stored)
    if (entry !== undefined && entry.state.revision !== revision) {
        context.cursors.invalidate(input.cursor as string)
        throw new FrMcpError("CURSOR_STALE", "rules-changed")
    }

    const sourceIds = [...new Set(sourceKeyIds(rules))]
    const checkAll = sourceIds.length <= MEMBER_CHECK_MAX
    const needsDatabase = given.scope === "source" || (checkAll && sourceIds.length > 0)
    const read = needsDatabase
        ? await context.database.withReadConnection((db) => ({
              existing: checkAll ? readExistingSids(db, sourceIds) : null,
              source: given.scope === "source" ? readSourceTarget(db, given.id as number) : null,
          }))
        : { existing: checkAll ? new Set<number>() : null, source: null as SourceTarget | null }
    const integrity = analyzeRuleKeys(rules, groups.groupsAvailable ? groups : null, read.existing, checkAll ? "complete" : "tooManyKeys")

    let target: ListRulesOutput["target"]
    const common = { scope: given.scope, key, keyPresent: rules.has(key), ruleCount: stored.length }
    if (given.scope === "all") {
        target = { ...common, exists: true, status: "exists", name: null }
    } else if (given.scope === "group") {
        target = { ...common, ...groupTarget(groups, given.id as number) }
    } else {
        const source = read.source as SourceTarget
        target = { ...common, exists: source.exists, status: source.exists ? "exists" : "absent", name: source.name }
    }

    const meta: ListRulesOutput["meta"] = { generatedAt: new Date(context.now()).toISOString(), schemaVersion: RESULT_SCHEMA_VERSION }
    const skeleton: ListRulesOutput = {
        target,
        revision,
        rules: [],
        integrity,
        hasMore: false,
        nextCursor: "x".repeat(CURSOR_TOKEN_LENGTH),
        scan: { examined: Number.MAX_SAFE_INTEGER, stoppedBy: "responseBudget" },
        meta,
    }
    const budget = new PageBudget(resultLength(skeleton))
    const page: ListRulesOutput["rules"] = []
    let stoppedBy: StoppedBy | undefined
    let index = entry?.state.nextIndex ?? 0
    for (; index < stored.length; index++) {
        if (page.length === given.limit) {
            stoppedBy = "pageFull"
            break
        }
        const summary = analyzeRule(stored[index]!, index).summary
        if (!budget.tryAdd(JSON.stringify(summary))) {
            // A rule that cannot be returned even alone (a huge target name): stable error, no progress.
            if (page.length === 0) throw new FrMcpError("LIMIT_EXCEEDED", "response-too-large")
            stoppedBy = "responseBudget"
            break
        }
        page.push(summary)
    }

    let nextCursor: string | null = null
    if (stoppedBy !== undefined) {
        const state: ListRulesState = { nextIndex: index, revision }
        nextCursor = context.cursors.create(LIST_RULES, given, state, entry?.scanStartedAt ?? context.now())
    }
    const payload: ListRulesOutput = {
        ...skeleton,
        rules: page,
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
