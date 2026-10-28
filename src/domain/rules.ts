/**
 * Static analysis of the stored article rules (FR-MCP-01 §8, §14.8, §14.9,
 * D-09). Pure: no database, no settings I/O, and no rule is ever applied.
 * Regular expressions from the settings are only compiled to check their
 * syntax (`new RegExp`), never executed on any text.
 *
 * Semantics mirrored from the fork (src/scripts/models/rule.ts, feed.ts):
 *  - Keys: "all", `group:${gid}`, `source:${sid}` (getRuleTargetKey). Only the
 *    canonical decimal form is ever looked up by the app.
 *  - Filter bits are tested with `type & bit`: ShowRead 1, ShowNotStarred 2,
 *    ShowHidden 4 (when unset, the article must be unread / starred /
 *    visible), FullSearch 8 (title or snippet), CaseInsensitive 16,
 *    CreatorSearch 32 (FullSearch wins). Other bits are ignored. The editor
 *    writes 7 | 16? | (8 or 32)?, so the standard values are 7, 15, 23, 31,
 *    39, 55.
 *  - Text condition: skipped when `search` is ""; otherwise
 *    `RegExp(search, caseInsensitive ? "i" : "")` is built on EVERY evaluation
 *    (an invalid pattern throws for every article). `match: false` inverts.
 *  - Actions (RuleActions.fromKeys): `str.split("-")`, key = part 0; value =
 *    part 1 === "true", or true when part 1 is missing or empty; later parts
 *    are ignored. Object.fromEntries keeps the LAST value of a key at the
 *    position of its first occurrence. A key other than r/s/h/n has no
 *    transform: applying the rule throws (a TypeError that fails the fetch),
 *    except for keys naming a callable Object.prototype member.
 *  - A chain (getRulesForTarget) is the concatenation all → first group →
 *    source, every rule evaluated in order with no early stop; for each flag
 *    the last matching rule wins, and a later condition can depend on a flag
 *    set by an earlier rule.
 */

import crypto from "node:crypto"
import { ruleActionsMetadata, type StoredRuleEntry } from "../settings/read-settings.js"
import { idSample, type IdSample } from "./group-catalog.js"
import type { GroupIndex } from "./groups.js"

/** Rules considered by one consultation (a target array or a whole chain). */
export const RULES_CONSULTED_MAX = 1000
/** Code points of a pattern shown in a result. */
export const PATTERN_PREVIEW_MAX = 500
/** Patterns longer than this (code points) are not compiled. */
export const REGEX_CHECK_MAX = 10_000
/** Orders listed in one note. */
export const NOTE_ORDERS_MAX = 20
/** Notes returned with one page. */
export const NOTES_PER_PAGE_MAX = 20

const SHOW_READ = 1
const SHOW_NOT_STARRED = 2
const SHOW_HIDDEN = 4
const FULL_SEARCH = 8
const CASE_INSENSITIVE = 16
const CREATOR_SEARCH = 32
const STANDARD_FILTERS: ReadonlySet<number> = new Set([7, 15, 23, 31, 39, 55])

export type RuleScope = "all" | "group" | "source"
export type ActionFlag = "read" | "star" | "hide" | "notify"
export type RuleField = "title" | "text" | "creator"

const ACTION_KEYS: Readonly<Record<string, ActionFlag>> = { r: "read", s: "star", h: "hide", n: "notify" }
const STATE_FLAGS: readonly ActionFlag[] = ["read", "star", "hide"]

export const RULE_DIAGNOSTICS = [
    "invalidRegex",
    "regexNotChecked",
    "emptyPattern",
    "unknownAction",
    "nonStandardAction",
    "duplicateAction",
    "contradictoryActions",
    "noActions",
    "malformedActions",
    "nonStandardFilter",
] as const
export type RuleDiagnostic = (typeof RULE_DIAGNOSTICS)[number]

export type ParsedKey = { readonly kind: "all" } | { readonly kind: "group" | "source"; readonly id: number } | { readonly kind: "malformed" }

/** Parses a sourceRules key; only the forms the app can produce are recognized. */
export function parseRuleKey(key: string): ParsedKey {
    if (key === "all") return { kind: "all" }
    const match = /^(group|source):(-?(?:0|[1-9][0-9]*))$/.exec(key)
    if (match === null) return { kind: "malformed" }
    const id = Number(match[2])
    if (!Number.isSafeInteger(id) || Object.is(id, -0)) return { kind: "malformed" }
    return { kind: match[1] as "group" | "source", id }
}

export function ruleKey(scope: RuleScope, id: number | null): string {
    return scope === "all" ? "all" : `${scope}:${id as number}`
}

/**
 * Private fingerprint of the stored actions array (reader metadata, taken
 * before sanitization), or the JSON of the sanitized array for entries that
 * did not come from the reader.
 */
function actionsFingerprint(rule: StoredRuleEntry): string {
    return ruleActionsMetadata(rule)?.fingerprint ?? JSON.stringify(rule.actions)
}

/**
 * SHA-256 (128 bits) of the canonical JSON of the key and of every stored
 * rule, in stored order. The actions enter through their private fingerprint,
 * so a change of actions the reader discarded (action limits) or of unknown
 * actions is detected; the fingerprint itself is never exposed.
 */
export function rulesRevision(key: string, rules: readonly StoredRuleEntry[]): string {
    const hash = crypto.createHash("sha256").update(JSON.stringify(key)).update("\n")
    for (const rule of rules) {
        hash.update(JSON.stringify([rule.filter, rule.search, rule.match, rule.actions, rule.malformed ?? null, actionsFingerprint(rule)])).update("\n")
    }
    return `rr1.${hash.digest().subarray(0, 16).toString("base64url")}`
}

export interface RuleSummary {
    index: number
    field: RuleField
    pattern: string
    patternTruncated: boolean
    patternLength: number
    caseSensitive: boolean
    match: boolean
    stateMask: { requireUnread: boolean; requireStarred: boolean; requireVisible: boolean }
    rawFilter: number
    standard: boolean
    actions: { action: ActionFlag; value: boolean }[] | null
    rawActionCount: number
    unknownActionCount: number
    diagnostics: RuleDiagnostic[]
}

export type BlockerKind = "invalidRegex" | "regexNotChecked" | "unknownAction" | "malformedActions"
export type BlockerCertainty = "everyArticle" | "whenMatched" | "notDeterminable"

export interface RuleAnalysis {
    readonly summary: RuleSummary
    /** Canonical condition: equal keys always evaluate alike on the same article state. */
    readonly condition: string
    /** Canonical condition + effective actions. */
    readonly identity: string
    /** True when the condition reads no flag (no state requirement). */
    readonly stateIndependent: boolean
    /** Flags the condition reads. */
    readonly reads: readonly ActionFlag[]
    /** Effective value per flag; null when the actions are not known. */
    readonly sets: ReadonlyMap<ActionFlag, boolean> | null
    /** The same flag with different values inside this rule (the last one is effective). */
    readonly contradictory: boolean
    /**
     * Every stored action is known and was kept by the reader: no discarded
     * array, no unknown key (including Object.prototype names). Only then can
     * a note about the rule's effects be proven.
     */
    readonly actionsComplete: boolean
    readonly blockers: readonly { kind: BlockerKind; certainty: BlockerCertainty }[]
}

/** First PATTERN_PREVIEW_MAX code points and the total, without splitting a surrogate pair. */
function preview(search: string): { text: string; truncated: boolean; length: number } {
    let length = 0
    let end = 0
    for (const char of search) {
        if (length < PATTERN_PREVIEW_MAX) end += char.length
        length++
    }
    return { text: search.slice(0, end), truncated: length > PATTERN_PREVIEW_MAX, length }
}

function isPrototypeMember(key: string): boolean {
    return typeof (Object.prototype as unknown as Record<string, unknown>)[key] === "function"
}

/** Analysis of one stored rule at `index` of its array. */
export function analyzeRule(rule: StoredRuleEntry, index: number): RuleAnalysis {
    const t = rule.filter
    const requireUnread = !(t & SHOW_READ)
    const requireStarred = !(t & SHOW_NOT_STARRED)
    const requireVisible = !(t & SHOW_HIDDEN)
    const field: RuleField = t & FULL_SEARCH ? "text" : t & CREATOR_SEARCH ? "creator" : "title"
    const caseSensitive = !(t & CASE_INSENSITIVE)
    const diagnostics = new Set<RuleDiagnostic>()
    const blockers: { kind: BlockerKind; certainty: BlockerCertainty }[] = []
    const shown = preview(rule.search)

    if (rule.search === "") {
        diagnostics.add("emptyPattern")
    } else if (shown.length > REGEX_CHECK_MAX) {
        diagnostics.add("regexNotChecked")
        blockers.push({ kind: "regexNotChecked", certainty: "notDeterminable" })
    } else {
        try {
            // Syntax check only: the expression is never executed.
            new RegExp(rule.search, caseSensitive ? "" : "i")
        } catch {
            diagnostics.add("invalidRegex")
            // testItem builds the RegExp before any other check, for every article.
            blockers.push({ kind: "invalidRegex", certainty: "everyArticle" })
        }
    }
    const stateIndependent = !requireUnread && !requireStarred && !requireVisible
    if (!STANDARD_FILTERS.has(t)) diagnostics.add("nonStandardFilter")

    let sets: Map<ActionFlag, boolean> | null = null
    let actions: RuleSummary["actions"] = null
    let unknownCount = 0
    let contradictory = false
    if (rule.actions === null) {
        diagnostics.add("malformedActions")
        blockers.push({ kind: "malformedActions", certainty: "notDeterminable" })
    } else {
        if (rule.actions.length === 0) diagnostics.add("noActions")
        // Object.fromEntries(strs.map(fromKey)): first position, last value.
        const decoded = new Map<string, boolean>()
        for (const str of rule.actions) {
            const parts = str.split("-")
            const key = parts[0] as string
            const suffix = parts[1]
            const value = suffix ? suffix === "true" : true
            if (parts.length !== 2 || (suffix !== "true" && suffix !== "false")) diagnostics.add("nonStandardAction")
            if (decoded.has(key)) {
                diagnostics.add("duplicateAction")
                if (decoded.get(key) !== value) contradictory = true
            }
            decoded.set(key, value)
        }
        if (contradictory) diagnostics.add("contradictoryActions")
        sets = new Map()
        actions = []
        let throwing = false
        let undecidable = false
        for (const [key, value] of decoded) {
            // Own keys only: "constructor" or "__proto__" are not actions.
            const flag = Object.hasOwn(ACTION_KEYS, key) ? ACTION_KEYS[key] : undefined
            if (flag !== undefined) {
                sets.set(flag, value)
                actions.push({ action: flag, value })
            } else {
                unknownCount++
                if (isPrototypeMember(key)) undecidable = true
                else throwing = true
            }
        }
        if (unknownCount > 0) diagnostics.add("unknownAction")
        // Unknown actions throw only when the rule applies (testItem result === match).
        const alwaysTrue = rule.search === "" && stateIndependent
        if (throwing && !(alwaysTrue && !rule.match)) {
            blockers.push({ kind: "unknownAction", certainty: alwaysTrue && rule.match ? "everyArticle" : "whenMatched" })
        } else if (undecidable && !(alwaysTrue && !rule.match)) {
            blockers.push({ kind: "unknownAction", certainty: "notDeterminable" })
        }
    }

    const reads: ActionFlag[] = []
    if (requireUnread) reads.push("read")
    if (requireStarred) reads.push("star")
    if (requireVisible) reads.push("hide")
    const condition = JSON.stringify([
        requireUnread,
        requireStarred,
        requireVisible,
        rule.search === "" ? null : field,
        rule.search === "" ? null : caseSensitive,
        rule.search,
        rule.match,
    ])
    const standard =
        STANDARD_FILTERS.has(t) &&
        rule.search !== "" &&
        rule.actions !== null &&
        rule.actions.length > 0 &&
        !diagnostics.has("nonStandardAction") &&
        !diagnostics.has("duplicateAction") &&
        unknownCount === 0
    const summary: RuleSummary = {
        index,
        field,
        pattern: shown.text,
        patternTruncated: shown.truncated,
        patternLength: shown.length,
        caseSensitive,
        match: rule.match,
        stateMask: { requireUnread, requireStarred, requireVisible },
        rawFilter: t,
        standard,
        actions,
        rawActionCount: ruleActionsMetadata(rule)?.count ?? rule.actions?.length ?? 0,
        unknownActionCount: unknownCount,
        diagnostics: RULE_DIAGNOSTICS.filter((d) => diagnostics.has(d)),
    }
    return {
        summary,
        condition,
        // The whole stored actions array (order, duplicates, unknown and discarded actions) through its fingerprint.
        identity: JSON.stringify([condition, actionsFingerprint(rule)]),
        stateIndependent,
        reads,
        sets,
        contradictory,
        actionsComplete: rule.actions !== null && unknownCount === 0,
        blockers,
    }
}

export type NoteKind =
    | "duplicateRule"
    | "oppositeActionsSameCondition"
    | "sameFlagDifferentConditions"
    | "contradictoryActionsInRule"
    | "stateDependentCondition"
export type NoteCertainty = "proven" | "possible" | "notStaticallyDecidable"

export interface ChainNote {
    readonly kind: NoteKind
    readonly certainty: NoteCertainty
    readonly flag: ActionFlag | null
    /** Every chain order involved, ascending. */
    readonly orders: readonly number[]
}

/**
 * Structural notes on a whole chain (orders = positions in `chain`). They
 * compare rules; they never decide whether a pattern matches an article.
 *  - duplicateRule: identical condition and identical stored actions array at
 *    several orders; proven when the actions are fully known, otherwise not
 *    statically decidable (the rules are identical, their effect is unknown).
 *  - oppositeActionsSameCondition: identical conditions set a flag to both
 *    values; proven when the condition reads no flag (both rules then always
 *    match together and the later wins) and every rule involved has fully
 *    known actions, possible when only the state dependence prevents it, not
 *    statically decidable when an involved rule has unknown or discarded
 *    actions (it can throw before or after setting the flag).
 *  - sameFlagDifferentConditions (not statically decidable): a flag set to
 *    different values under different conditions; the result depends on
 *    which conditions match.
 *  - contradictoryActionsInRule: one rule sets a flag twice with different
 *    values; the last occurrence is effective (proven), unless the rule also
 *    has unknown actions (not statically decidable: applying it can throw).
 *  - stateDependentCondition (possible): a condition reads a flag that an
 *    earlier rule of the chain can set (a rule with discarded actions can set
 *    any flag).
 */
export function chainNotes(chain: readonly RuleAnalysis[]): ChainNote[] {
    const notes: ChainNote[] = []
    const byIdentity = new Map<string, { orders: number[]; complete: boolean }>()
    const byConditionFlag = new Map<string, { orders: number[]; values: Set<boolean>; stateIndependent: boolean; complete: boolean }>()
    const byFlag = new Map<ActionFlag, { orders: number[]; pairs: Set<string> }>()
    const contradictory: number[] = []
    const contradictoryIncomplete: number[] = []
    const dependents = new Map<ActionFlag, number[]>()
    const setSoFar = new Set<ActionFlag>()

    chain.forEach((rule, order) => {
        const same = byIdentity.get(rule.identity) ?? { orders: [], complete: true }
        same.orders.push(order)
        same.complete &&= rule.actionsComplete
        byIdentity.set(rule.identity, same)
        if (rule.contradictory) (rule.actionsComplete ? contradictory : contradictoryIncomplete).push(order)
        for (const flag of rule.reads) {
            if (setSoFar.has(flag)) dependents.set(flag, [...(dependents.get(flag) ?? []), order])
        }
        for (const [flag, value] of rule.sets ?? []) {
            const key = JSON.stringify([rule.condition, flag])
            const group = byConditionFlag.get(key) ?? { orders: [], values: new Set(), stateIndependent: rule.stateIndependent, complete: true }
            group.orders.push(order)
            group.values.add(value)
            group.complete &&= rule.actionsComplete
            byConditionFlag.set(key, group)
            const perFlag = byFlag.get(flag) ?? { orders: [], pairs: new Set() }
            perFlag.orders.push(order)
            perFlag.pairs.add(JSON.stringify([rule.condition, value]))
            byFlag.set(flag, perFlag)
            setSoFar.add(flag)
        }
        // Discarded actions are unknown: the rule may set any flag.
        if (rule.sets === null) for (const flag of STATE_FLAGS) setSoFar.add(flag)
    })
    for (const { orders, complete } of byIdentity.values()) {
        if (orders.length > 1) notes.push({ kind: "duplicateRule", certainty: complete ? "proven" : "notStaticallyDecidable", flag: null, orders })
    }
    for (const [key, group] of byConditionFlag) {
        if (group.values.size > 1) {
            const flag = JSON.parse(key)[1] as ActionFlag
            const certainty = !group.complete ? "notStaticallyDecidable" : group.stateIndependent ? "proven" : "possible"
            notes.push({ kind: "oppositeActionsSameCondition", certainty, flag, orders: group.orders })
        }
    }
    for (const [flag, group] of byFlag) {
        const values = new Set([...group.pairs].map((pair) => JSON.parse(pair)[1] as boolean))
        const conditions = new Set([...group.pairs].map((pair) => JSON.parse(pair)[0] as string))
        if (values.size > 1 && conditions.size > 1) {
            notes.push({ kind: "sameFlagDifferentConditions", certainty: "notStaticallyDecidable", flag, orders: group.orders })
        }
    }
    if (contradictory.length > 0) notes.push({ kind: "contradictoryActionsInRule", certainty: "proven", flag: null, orders: contradictory })
    if (contradictoryIncomplete.length > 0) {
        notes.push({ kind: "contradictoryActionsInRule", certainty: "notStaticallyDecidable", flag: null, orders: contradictoryIncomplete })
    }
    for (const flag of STATE_FLAGS) {
        const orders = dependents.get(flag)
        if (orders !== undefined) notes.push({ kind: "stateDependentCondition", certainty: "possible", flag, orders })
    }
    return notes
}

export interface RuleKeysIntegrity {
    keyCount: number
    ruleCount: number
    /** Keys holding an empty array (the app deletes the key instead). */
    emptyRuleArrays: number
    /** Keys holding more rules than one consultation considers. */
    oversizedRuleArrays: number
    /** Keys the app never looks up (any other text); never listed, they may contain private text. */
    malformedKeys: number
    /** group:/source: keys with a negative id (the app never produces nor uses them). */
    negativeIdKeys: number
    sourceKeys: {
        count: number
        /** "complete" when every source key was looked up in the database. */
        check: "complete" | "tooManyKeys" | "notChecked"
        /** Keys whose source does not exist now (a later source can reuse the id); null unless check is "complete". */
        orphans: IdSample | null
    }
    groupKeys: {
        count: number
        groupsAvailable: boolean
        /** gid carried by no sourceGroups entry. */
        orphans: IdSample | null
        /** gid carried only by a single entry (not a group: its rules never apply). */
        singleEntryOnly: IdSample | null
        /** gid carried by several entries (ambiguous). */
        ambiguous: IdSample | null
    }
}

/** Source ids (>= 0) of the source: keys, for the existence check. */
export function sourceKeyIds(rules: ReadonlyMap<string, readonly StoredRuleEntry[]>): number[] {
    const ids: number[] = []
    for (const key of rules.keys()) {
        const parsed = parseRuleKey(key)
        if (parsed.kind === "source" && parsed.id >= 0) ids.push(parsed.id)
    }
    return ids
}

/**
 * Integrity of the sourceRules keys. `groups` is null when sourceGroups is
 * unavailable; `existing` is null when the source keys were not looked up
 * (`check` says why).
 */
export function analyzeRuleKeys(
    rules: ReadonlyMap<string, readonly StoredRuleEntry[]>,
    groups: GroupIndex | null,
    existing: ReadonlySet<number> | null,
    check: RuleKeysIntegrity["sourceKeys"]["check"],
): RuleKeysIntegrity {
    let ruleCount = 0
    let emptyRuleArrays = 0
    let oversizedRuleArrays = 0
    let malformedKeys = 0
    let negativeIdKeys = 0
    const sourceIds: number[] = []
    const groupIds: number[] = []
    for (const [key, list] of rules) {
        ruleCount += list.length
        if (list.length === 0) emptyRuleArrays++
        if (list.length > RULES_CONSULTED_MAX) oversizedRuleArrays++
        const parsed = parseRuleKey(key)
        if (parsed.kind === "malformed") malformedKeys++
        else if (parsed.kind !== "all" && parsed.id < 0) negativeIdKeys++
        else if (parsed.kind === "source") sourceIds.push(parsed.id)
        else if (parsed.kind === "group") groupIds.push(parsed.id)
    }
    // gid → isMultiple of its (first) entry, built once.
    const multiple = new Map<number, boolean>()
    for (const entry of groups?.entries() ?? []) if (!multiple.has(entry.gid)) multiple.set(entry.gid, entry.isMultiple)
    const kinds = (gid: number): "orphan" | "single" | "ambiguous" | "ok" => {
        const count = (groups as GroupIndex).gidCount(gid)
        if (count === 0) return "orphan"
        if (count > 1) return "ambiguous"
        return multiple.get(gid) ? "ok" : "single"
    }
    return {
        keyCount: rules.size,
        ruleCount,
        emptyRuleArrays,
        oversizedRuleArrays,
        malformedKeys,
        negativeIdKeys,
        sourceKeys: {
            count: sourceIds.length,
            check,
            orphans: existing === null ? null : idSample(sourceIds.filter((sid) => !existing.has(sid))),
        },
        groupKeys: {
            count: groupIds.length,
            groupsAvailable: groups !== null,
            orphans: groups === null ? null : idSample(groupIds.filter((gid) => kinds(gid) === "orphan")),
            singleEntryOnly: groups === null ? null : idSample(groupIds.filter((gid) => kinds(gid) === "single")),
            ambiguous: groups === null ? null : idSample(groupIds.filter((gid) => kinds(gid) === "ambiguous")),
        },
    }
}
