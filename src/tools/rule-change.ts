/**
 * add_rule, update_rule, delete_rule and preview_rule_change
 * (FR-MCP-03-RULE-WRITE-01): the only tools that can change the profile, on
 * `source:<sid>` and `group:<gid>` only, and only through the checks below.
 *
 * A change is one transaction, serialized with every other tool of this process:
 * Fluent Reader closed → document read → target resolved (a source exists and
 * sourceRef verified; a unique multiple group) → expectedRevision compared →
 * new list computed from the stored array, so that the other rules of the target
 * keep their stored form, unknown fields included → only that target's bytes
 * replaced (settings/json-splice.ts) → the result parsed and compared with what
 * was meant, member by member, before anything is written → commit
 * (settings/rule-store.ts).
 *
 * expectedRevision makes a repeated request harmless: the first one changes the
 * revision, so a duplicate is REVISION_CONFLICT and adds nothing.
 *
 * The preview runs everything up to the comparison on the same code and stops
 * there. It keeps no state: it neither authorizes nor is required for a write.
 *
 * Results say nothing about real articles (no pattern is ever executed), and a
 * write result carries no source or group name: a name too long for the response
 * must not turn a saved change into a reported failure.
 */

import { isDeepStrictEqual } from "node:util"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { GroupIndex } from "../domain/groups.js"
import { storedRuleFrom } from "../domain/rule-definition.js"
import {
    analyzeRule,
    chainNotes,
    NOTE_ORDERS_MAX,
    NOTES_PER_PAGE_MAX,
    ruleKey,
    rulesRevision,
    RULES_CONSULTED_MAX,
    type ActionFlag,
    type RuleAnalysis,
} from "../domain/rules.js"
import { FrMcpError } from "../errors.js"
import { logEvent } from "../log.js"
import { spliceRuleTarget } from "../settings/json-splice.js"
import { CFG_MAX, LIMITS, readSettingsDocument, snapshotOf, type SettingsDocument, type SettingsSnapshot, type StoredRuleEntry } from "../settings/read-settings.js"
import { BACKUP_LOCATION, commitConfig, fluentReaderOpen, requireSingleLink } from "../settings/rule-store.js"
import type { ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { successResult } from "./result.js"
import { readSourceTarget } from "./rule-targets.js"
import {
    addRuleInput,
    deleteRuleInput,
    previewRuleChangeInput,
    RESULT_SCHEMA_VERSION,
    RULE_CHANGE_EFFECT,
    RULE_PREVIEW_LIMITS,
    updateRuleInput,
    type PreviewRuleChangeOutput,
    type RuleChangeWarning,
    type RuleWriteOutput,
} from "./schemas.js"

export const ADD_RULE = "add_rule"
export const UPDATE_RULE = "update_rule"
export const DELETE_RULE = "delete_rule"
export const PREVIEW_RULE_CHANGE = "preview_rule_change"

type Operation = "add" | "update" | "delete"

interface TargetArgs {
    readonly scope: "source" | "group"
    readonly sourceId?: number | undefined
    readonly sourceRef?: string | undefined
    readonly groupId?: number | undefined
}

interface ChainPart {
    readonly key: string
    readonly rules: readonly StoredRuleEntry[]
}

interface Target {
    readonly key: string
    readonly name: string | null
    readonly output: RuleWriteOutput["target"]
    /** The chain the target belongs to, ending with its own part. */
    readonly inherited: readonly ChainPart[]
    readonly chainComplete: boolean
    readonly affectedSourceCount: number | null
}

/** Every allowlisted section must be valid: nothing is written over a structure this server cannot read. */
function requireValidSections(snapshot: SettingsSnapshot): void {
    for (const section of [snapshot.sourceRules, snapshot.sourceGroups, snapshot.nextGroupId, snapshot.dbVersion]) {
        if (!section.ok) throw new FrMcpError(section.code)
    }
}

async function resolveTarget(context: ToolContext, args: TargetArgs, groups: GroupIndex): Promise<Target> {
    const rules = groups.rules()
    const part = (key: string): ChainPart => ({ key, rules: rules.get(key) ?? [] })
    if (args.scope === "group") {
        const gid = args.groupId as number
        const { entry } = groups.locate(gid)
        const key = ruleKey("group", gid)
        return {
            key,
            name: entry.name ?? null,
            output: { scope: "group", key, sourceId: null, sourceRef: null, groupId: gid },
            inherited: [part("all")],
            chainComplete: true,
            affectedSourceCount: groups.members(gid).sids.length,
        }
    }
    const sid = args.sourceId as number
    const source = await context.database.withReadConnection((db) => readSourceTarget(db, sid))
    if (!source.exists) throw new FrMcpError("NOT_FOUND", "source-not-found")
    if (args.sourceRef !== undefined) {
        // As get_source: a record over the limit cannot be verified.
        if (source.tooLarge) throw new FrMcpError("LIMIT_EXCEEDED", "record-too-large")
        context.identity.verify(args.sourceRef, sid, source.url)
    }
    const key = ruleKey("source", sid)
    const info = groups.groupOf(sid)
    return {
        key,
        name: source.name,
        output: { scope: "source", key, sourceId: sid, sourceRef: source.url === null ? null : context.identity.refFor(sid, source.url), groupId: null },
        inherited: info.groupStatus === "grouped" ? [part("all"), part(ruleKey("group", info.groupId as number))] : [part("all")],
        chainComplete: info.groupStatus === "grouped" || info.groupStatus === "ungrouped",
        affectedSourceCount: null,
    }
}

interface Change {
    readonly operation: Operation
    readonly index: number
    readonly previous: StoredRuleEntry | null
    readonly next: StoredRuleEntry | null
    readonly storedBefore: readonly StoredRuleEntry[]
    /** The list to store, built from the stored array so that other rules keep their stored form; null removes the key. */
    readonly rawAfter: readonly unknown[] | null
    /** false only for an update identical to the stored rule. */
    readonly changed: boolean
}

function planChange(document: SettingsDocument, target: Target, stored: readonly StoredRuleEntry[], operation: Operation, index: number | undefined, next: StoredRuleEntry | null): Change {
    if (stored.length > RULES_CONSULTED_MAX) throw new FrMcpError("LIMIT_EXCEEDED", "too-many-rules")
    const section = document.root.sourceRules as Record<string, unknown> | undefined
    const raw: readonly unknown[] = section !== undefined && Object.hasOwn(section, target.key) ? (section[target.key] as unknown[]) : []
    if (operation === "add") {
        const inheritedLength = target.inherited.reduce((sum, part) => sum + part.rules.length, 0)
        let total = 0
        for (const list of (document.snapshot.sourceRules as { value: ReadonlyMap<string, readonly StoredRuleEntry[]> }).value.values()) total += list.length
        if (stored.length + 1 > RULES_CONSULTED_MAX || inheritedLength + stored.length + 1 > RULES_CONSULTED_MAX || total + 1 > LIMITS.rulesTotal) throw new FrMcpError("LIMIT_EXCEEDED", "too-many-rules")
        const rule = next as StoredRuleEntry
        return { operation, index: stored.length, previous: null, next: rule, storedBefore: stored, rawAfter: [...raw, rule], changed: true }
    }
    const at = index as number
    const previous = stored[at]
    if (previous === undefined) throw new FrMcpError("RULE_NOT_FOUND", "rule-not-found")
    if (operation === "update") {
        const rule = next as StoredRuleEntry
        return {
            operation,
            index: at,
            previous,
            next: rule,
            storedBefore: stored,
            rawAfter: raw.map((current, i) => (i === at ? rule : current)),
            // Unknown fields of the stored rule would go, so it counts as changed unless identical as stored.
            changed: !isDeepStrictEqual(raw[at], rule),
        }
    }
    const keep = raw.filter((_, i) => i !== at)
    return { operation, index: at, previous, next: null, storedBefore: stored, rawAfter: keep.length > 0 ? keep : null, changed: true }
}

interface Impact {
    readonly warnings: RuleChangeWarning[]
    readonly chain: PreviewRuleChangeOutput["chain"]
    readonly conflicts: PreviewRuleChangeOutput["conflicts"]
    readonly conflictsOmitted: number
    readonly overlaps: PreviewRuleChangeOutput["overlaps"]
    readonly overlapsOmitted: number
}

/**
 * Structural facts on the chain holding the changed rule; never about real
 * articles. `storedAfter` comes from parsing the new document, so that the new
 * rule is compared with the stored ones on the same terms.
 */
function impactOf(target: Target, change: Change, storedAfter: readonly StoredRuleEntry[]): Impact {
    const analyses = (rules: readonly StoredRuleEntry[]): RuleAnalysis[] => rules.map((rule, index) => analyzeRule(rule, index))
    const offset = target.inherited.reduce((sum, part) => sum + part.rules.length, 0)
    const inherited = target.inherited.flatMap((part) => analyses(part.rules))
    const before = [...inherited, ...analyses(change.storedBefore)]
    const after = [...inherited, ...analyses(storedAfter)]
    const focusChain = change.operation === "delete" ? before : after
    const focusOrder = offset + change.index
    const changed = focusChain[focusOrder] as RuleAnalysis

    const keys = [...target.inherited.flatMap((part) => part.rules.map(() => part.key)), ...focusChain.slice(offset).map(() => target.key)]
    const notes = chainNotes(focusChain).filter((note) => note.orders.includes(focusOrder))
    const conflicts = notes.slice(0, NOTES_PER_PAGE_MAX).map((note) => ({
        kind: note.kind,
        certainty: note.certainty,
        flag: note.flag,
        orders: note.orders.slice(0, NOTE_ORDERS_MAX),
        ordersCount: note.orders.length,
        ordersTruncated: note.orders.length > NOTE_ORDERS_MAX,
    }))
    const flags = [...(changed.sets?.keys() ?? [])]
    const overlaps: PreviewRuleChangeOutput["overlaps"] = []
    let overlapCount = 0
    let laterMayOverride = false
    focusChain.forEach((rule, order) => {
        if (order === focusOrder) return
        const shared = flags.filter((flag) => rule.sets?.has(flag))
        if (shared.length === 0) return
        overlapCount++
        if (order > focusOrder && shared.some((flag) => rule.sets?.get(flag) !== changed.sets?.get(flag))) laterMayOverride = true
        if (overlaps.length < NOTE_ORDERS_MAX) overlaps.push({ order, originKey: keys[order] as string, index: rule.summary.index, flags: shared as ActionFlag[] })
    })

    const warnings: RuleChangeWarning[] = []
    if (!target.chainComplete) warnings.push("chainIncomplete")
    const next = change.next === null ? null : analyzeRule(change.next, change.index)
    if (next !== null && next.reads.length > 0) {
        warnings.push("stateConditionsNotEditableInApp")
        if (!next.summary.match) warnings.push("invertedMatchIncludesState")
    }
    if (change.previous !== null && !analyzeRule(change.previous, change.index).summary.standard) warnings.push("previousRuleNonStandard")
    if (laterMayOverride && change.operation !== "delete") warnings.push("laterRuleMayOverride")
    if (after.some((rule) => rule.blockers.length > 0)) warnings.push("fetchBlockersInChain")
    if (target.affectedSourceCount === 0) warnings.push("groupHasNoEffectiveMembers")

    return {
        warnings,
        chain: {
            complete: target.chainComplete,
            lengthBefore: before.length,
            lengthAfter: after.length,
            orderBefore: change.operation === "add" ? null : focusOrder,
            orderAfter: change.operation === "delete" ? null : focusOrder,
            laterRulesInChain: focusChain.length - focusOrder - 1,
            affectedSourceCount: target.affectedSourceCount,
        },
        conflicts,
        conflictsOmitted: notes.length - conflicts.length,
        overlaps,
        overlapsOmitted: overlapCount - overlaps.length,
    }
}

/**
 * The new text of config.json, checked: the result must parse to exactly the
 * current document with this one target changed, within the structural limits.
 * Also returns the target's list and revision as they will be read.
 */
function nextDocument(document: SettingsDocument, target: Target, change: Change): { text: string; revision: string; storedAfter: readonly StoredRuleEntry[] } {
    const text = spliceRuleTarget(document.text, target.key, change.rawAfter)
    if (Buffer.byteLength(text) > CFG_MAX) throw new FrMcpError("SETTINGS_TOO_LARGE", "file-too-large")
    const expected = JSON.parse(document.text) as Record<string, unknown>
    if (!Object.hasOwn(expected, "sourceRules")) expected.sourceRules = {}
    const section = expected.sourceRules as Record<string, unknown>
    if (change.rawAfter === null) delete section[target.key]
    else section[target.key] = change.rawAfter
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (!isDeepStrictEqual(parsed, expected)) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
    const snapshot = snapshotOf(parsed, 1)
    requireValidSections(snapshot)
    const rules = snapshot.sourceRules as { value: ReadonlyMap<string, readonly StoredRuleEntry[]> }
    const storedAfter = rules.value.get(target.key) ?? []
    return { text, revision: rulesRevision(target.key, storedAfter), storedAfter }
}

interface WriteArgs extends TargetArgs {
    readonly expectedRevision: string
    readonly index?: number | undefined
}

async function write(context: ToolContext, tool: string, operation: Operation, args: WriteArgs, next: StoredRuleEntry | null): Promise<CallToolResult> {
    return context.cursors.exclusive(async () => {
        if (fluentReaderOpen(context.profileDir)) throw new FrMcpError("FLUENT_READER_RUNNING", "lockfile-present")
        const document = await readSettingsDocument(context.configPath, context.profileDir)
        try {
            requireSingleLink(context.configPath)
            requireValidSections(document.snapshot)
            const groups = GroupIndex.fromSnapshot(document.snapshot)
            const target = await resolveTarget(context, args, groups)
            const stored = groups.rules().get(target.key) ?? []
            const previousRevision = rulesRevision(target.key, stored)
            if (previousRevision !== args.expectedRevision) throw new FrMcpError("REVISION_CONFLICT", "revision-mismatch")
            const change = planChange(document, target, stored, operation, args.index, next)
            const built = nextDocument(document, target, change)
            const impact = impactOf(target, change, built.storedAfter)

            let backup: RuleWriteOutput["backup"] = null
            if (change.changed) {
                const bytes = Buffer.from(built.text, "utf8")
                try {
                    const name = await commitConfig({
                        configPath: context.configPath,
                        profileDir: context.profileDir,
                        settings: context.ruleWrites,
                        original: document.bytes,
                        next: bytes,
                        now: context.now(),
                    })
                    backup = { location: BACKUP_LOCATION, name }
                } finally {
                    bytes.fill(0)
                }
                logEvent("rule_write_committed", { tool, scope: target.output.scope })
            }
            const payload: RuleWriteOutput = {
                operation,
                applied: change.changed,
                target: target.output,
                index: change.index,
                previousRule: change.previous === null ? null : analyzeRule(change.previous, change.index).summary,
                rule: change.next === null ? null : analyzeRule(change.next, change.index).summary,
                previousRevision,
                revision: built.revision,
                ruleCount: built.storedAfter.length,
                keyRemoved: change.rawAfter === null,
                backup,
                warnings: impact.warnings,
                effect: RULE_CHANGE_EFFECT,
                meta: { generatedAt: new Date(context.now()).toISOString(), schemaVersion: RESULT_SCHEMA_VERSION },
            }
            return successResult(payload).result
        } finally {
            document.bytes.fill(0)
        }
    })
}

export async function addRule(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(addRuleInput, args)
    return write(context, ADD_RULE, "add", input, storedRuleFrom(input.rule))
}

export async function updateRule(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(updateRuleInput, args)
    return write(context, UPDATE_RULE, "update", input, storedRuleFrom(input.rule))
}

export async function deleteRule(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(deleteRuleInput, args)
    return write(context, DELETE_RULE, "delete", input, null)
}

export async function previewRuleChange(context: ToolContext, args: unknown): Promise<CallToolResult> {
    const input = parseArgs(previewRuleChangeInput, args)
    const next = input.rule === undefined ? null : storedRuleFrom(input.rule)
    return context.cursors.exclusive(async () => {
        const document = await readSettingsDocument(context.configPath, context.profileDir)
        try {
            requireValidSections(document.snapshot)
            const groups = GroupIndex.fromSnapshot(document.snapshot)
            const target = await resolveTarget(context, input, groups)
            const stored = groups.rules().get(target.key) ?? []
            const currentRevision = rulesRevision(target.key, stored)
            const change = planChange(document, target, stored, input.operation, input.index, next)
            // What a write would refuse is refused here too, on the same code.
            const built = nextDocument(document, target, change)
            const impact = impactOf(target, change, built.storedAfter)
            const open = fluentReaderOpen(context.profileDir)
            const stale = input.expectedRevision !== undefined && input.expectedRevision !== currentRevision
            const payload: PreviewRuleChangeOutput = {
                operation: input.operation,
                target: { ...target.output, name: target.name },
                index: change.index,
                previousRule: change.previous === null ? null : analyzeRule(change.previous, change.index).summary,
                newRule: change.next === null ? null : analyzeRule(change.next, change.index).summary,
                currentRevision,
                expectedRevisionCurrent: input.expectedRevision === undefined ? null : !stale,
                ruleCountBefore: change.storedBefore.length,
                ruleCountAfter: built.storedAfter.length,
                keyWouldBeRemoved: change.rawAfter === null,
                order: {
                    shiftedFromIndex: input.operation === "delete" && change.index + 1 < stored.length ? change.index + 1 : null,
                    shiftedCount: input.operation === "delete" ? stored.length - change.index - 1 : 0,
                    otherRulesUnchanged: true,
                },
                chain: impact.chain,
                conflicts: impact.conflicts,
                conflictsOmitted: impact.conflictsOmitted,
                overlaps: impact.overlaps,
                overlapsOmitted: impact.overlapsOmitted,
                warnings: [...impact.warnings, ...(stale ? (["expectedRevisionStale"] as const) : []), ...(open ? (["fluentReaderOpen"] as const) : [])],
                writeAvailability: { writesEnabled: true, fluentReaderOpen: open },
                limits: RULE_PREVIEW_LIMITS,
                effect: RULE_CHANGE_EFFECT,
                meta: { generatedAt: new Date(context.now()).toISOString(), schemaVersion: RESULT_SCHEMA_VERSION },
            }
            return successResult(payload).result
        } finally {
            document.bytes.fill(0)
        }
    })
}
