/**
 * A change request becomes one plan: every effective change with its before and
 * after, and the exact resulting document. Preview and apply run this same
 * function on the same inputs, so what a preview shows is what apply writes.
 * Pure: no filesystem, no clock, no randomness.
 */

import { z } from "zod"
import { FrMcpError } from "../errors.js"
import type { LiveCatalog } from "./catalog.js"
import {
    DocumentEdit,
    editorialId,
    GENERAL_FIELDS,
    generalKey,
    GROUP_FIELDS,
    groupHeading,
    groupKey,
    parsePreferences,
    renderNewDocument,
    sourceHeading,
    sourceKey,
    verifyResult,
    type GeneralField,
    type GroupField,
    type ParsedPreferences,
} from "./markdown.js"
import { reconcile, type ReconciledGroup, type ReconciledSource, type SectionStatus } from "./reconcile.js"
import { listBody, normalizeItems, textWarnings } from "./text-policy.js"
import { canonicalJson } from "./token.js"

const item = z.string().min(1).max(2_000)
const items = z.array(item).max(100)
const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const editorialGroupId = z.string().regex(/^npg_[A-Za-z0-9_-]{8,64}$/)
const editorialSourceId = z.string().regex(/^nps_[A-Za-z0-9_-]{8,64}$/)

const generalFields = { interests: items.optional(), avoid: items.optional(), importance: items.optional(), exceptions: items.optional() }

export const newsPreferenceChanges = z.discriminatedUnion("operation", [
    z.strictObject({ operation: z.literal("initialize"), ...generalFields }),
    z.strictObject({ operation: z.literal("set_general"), ...generalFields }),
    z.strictObject({ operation: z.literal("set_group"), groupId: id.optional(), editorialGroupId: editorialGroupId.optional(), interests: items.optional(), avoid: items.optional(), exceptions: items.optional() }),
    z.strictObject({ operation: z.literal("set_source"), sourceId: id.optional(), editorialSourceId: editorialSourceId.optional(), preferences: items }),
    z.strictObject({ operation: z.literal("sync_catalog") }),
    z.strictObject({ operation: z.literal("rebind_section"), editorialGroupId: editorialGroupId.optional(), groupId: id.optional(), editorialSourceId: editorialSourceId.optional(), sourceId: id.optional() }),
    z.strictObject({ operation: z.literal("remove_section"), editorialGroupId: editorialGroupId.optional(), editorialSourceId: editorialSourceId.optional() }),
    z.strictObject({
        operation: z.literal("reassociate_profile"),
        groupMappings: z.array(z.strictObject({ editorialGroupId, groupId: id })).max(2_000),
        sourceMappings: z.array(z.strictObject({ editorialSourceId, sourceId: id })).max(2_000),
        allowUnmapped: z.boolean().optional(),
    }),
])

export type NewsPreferenceChanges = z.output<typeof newsPreferenceChanges>

const OPERATIONS_WITH_TEXT = ["interests", "avoid", "importance", "exceptions", "preferences"] as const

function invalid(): never {
    throw new FrMcpError("INVALID_ARGUMENT", "invalid-argument")
}

function review(): never {
    throw new FrMcpError("PREFERENCE_BINDING_REVIEW_REQUIRED", "binding-review-required")
}

function notFound(): never {
    throw new FrMcpError("NOT_FOUND", "preference-target-not-found")
}

/** The canonical request, or a refusal: this is the form a preview shows and a token binds. */
export function normalizeChanges(changes: NewsPreferenceChanges): NewsPreferenceChanges {
    const out: Record<string, unknown> = { ...changes }
    for (const field of OPERATIONS_WITH_TEXT) {
        const value = out[field]
        if (Array.isArray(value)) out[field] = normalizeItems(value as string[])
    }
    const normalized = out as NewsPreferenceChanges
    const has = (...fields: string[]): boolean => fields.some((field) => out[field] !== undefined)
    switch (normalized.operation) {
        case "set_general":
            if (!has(...GENERAL_FIELDS)) invalid()
            break
        case "set_group":
            if (has("groupId") === has("editorialGroupId") || !has(...GROUP_FIELDS)) invalid()
            break
        case "set_source":
            if (has("sourceId") === has("editorialSourceId")) invalid()
            break
        case "rebind_section": {
            const group = has("editorialGroupId") && has("groupId") && !has("editorialSourceId") && !has("sourceId")
            const source = has("editorialSourceId") && has("sourceId") && !has("editorialGroupId") && !has("groupId")
            if (!group && !source) invalid()
            break
        }
        case "remove_section":
            if (has("editorialGroupId") === has("editorialSourceId")) invalid()
            break
        default:
            break
    }
    return normalized
}

export function changeWarnings(changes: NewsPreferenceChanges): string[] {
    const all: string[] = []
    const record = changes as unknown as Record<string, unknown>
    for (const field of OPERATIONS_WITH_TEXT) {
        const value = record[field]
        if (Array.isArray(value)) all.push(...(value as string[]))
    }
    return textWarnings(all)
}

export type PlanAction = "create" | "replace" | "clear" | "remove" | "rebind" | "orphan" | "rename" | "relocate" | "adopt"

export interface PlanEntry {
    readonly action: PlanAction
    readonly scope: "document" | "general" | "group" | "source"
    readonly sectionId: string | null
    readonly field: string | null
    readonly groupId: number | null
    readonly sourceId: number | null
    readonly name: string | null
    readonly before: string | null
    readonly after: string | null
    readonly statusBefore: SectionStatus | null
    readonly statusAfter: SectionStatus | null
}

export interface Plan {
    readonly entries: readonly PlanEntry[]
    readonly next: Buffer
    readonly changed: boolean
}

export interface PlanInput {
    readonly parsed: ParsedPreferences | null
    readonly catalog: LiveCatalog
    readonly profileBinding: string
    readonly baseRevision: string
    readonly verified: boolean
    readonly changes: NewsPreferenceChanges
}

const entryOf = (partial: Partial<PlanEntry> & Pick<PlanEntry, "action" | "scope">): PlanEntry => ({
    sectionId: null, field: null, groupId: null, sourceId: null, name: null, before: null, after: null, statusBefore: null, statusAfter: null, ...partial,
})

function bodyEntry(action: "create" | "replace", base: Partial<PlanEntry> & Pick<PlanEntry, "scope">, before: string | null, after: string): PlanEntry {
    return entryOf({ ...base, action: after === "" && action === "replace" ? "clear" : action, before, after })
}

function requireParsed(parsed: ParsedPreferences | null): ParsedPreferences {
    if (parsed === null) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "not-initialized")
    return parsed
}

function planInitialize(input: PlanInput, changes: Extract<NewsPreferenceChanges, { operation: "initialize" }>): Plan {
    const general: Partial<Record<GeneralField, string>> = {}
    const entries: PlanEntry[] = [entryOf({ action: "create", scope: "document" })]
    for (const field of GENERAL_FIELDS) {
        const values = changes[field]
        if (values === undefined) continue
        const body = listBody(values)
        general[field] = body
        if (body !== "") entries.push(bodyEntry("create", { scope: "general", sectionId: generalKey(field), field, statusAfter: "active" }, null, body))
    }
    const next = renderNewDocument(input.profileBinding, general)
    verifyResult(null, next, new Set())
    return { entries, next, changed: true }
}

function planSetGeneral(edit: DocumentEdit, changes: Extract<NewsPreferenceChanges, { operation: "set_general" }>): PlanEntry[] {
    const entries: PlanEntry[] = []
    for (const field of GENERAL_FIELDS) {
        const values = changes[field]
        if (values === undefined) continue
        const key = generalKey(field)
        const body = listBody(values)
        const before = edit.body(key)
        if (edit.setBody(key, body)) entries.push(bodyEntry("replace", { scope: "general", sectionId: key, field, statusBefore: "active", statusAfter: "active" }, before, body))
    }
    return entries
}

function liveGroup(catalog: LiveCatalog, groupId: number): LiveCatalog["groups"][number] {
    const live = catalog.groups.filter((group) => group.groupId === groupId)
    const first = live[0]
    if (first === undefined) notFound()
    if (live.length > 1 || first.status !== "active" || first.binding === null) review()
    return first
}

function liveSource(catalog: LiveCatalog, sourceId: number): LiveCatalog["sources"][number] {
    const live = catalog.sources.find((source) => source.sourceId === sourceId)
    if (live === undefined) notFound()
    if (live.binding === null) review()
    return live
}

function planSetGroup(input: PlanInput, edit: DocumentEdit, groups: readonly ReconciledGroup[], changes: Extract<NewsPreferenceChanges, { operation: "set_group" }>): PlanEntry[] {
    let section: ReconciledGroup | undefined
    let target: LiveCatalog["groups"][number] | undefined
    if (changes.editorialGroupId !== undefined) {
        section = groups.find((group) => group.entry.id === changes.editorialGroupId)
        if (section === undefined) notFound()
        if (section.status !== "active") review()
    } else {
        target = liveGroup(input.catalog, changes.groupId as number)
        const related = groups.filter((group) => group.live?.groupId === target?.groupId || group.candidates.some((candidate) => candidate.groupId === target?.groupId) || group.entry.groupId === target?.groupId)
        const first = related[0]
        if (related.length > 1 || (first !== undefined && first.status !== "active")) review()
        section = first
    }
    const entries: PlanEntry[] = []
    if (section !== undefined) {
        const { entry, status } = section
        for (const field of GROUP_FIELDS) {
            const values = changes[field]
            if (values === undefined) continue
            const key = groupKey(entry.id, field)
            const body = listBody(values)
            const before = edit.body(key)
            if (edit.setBody(key, body)) entries.push(bodyEntry("replace", { scope: "group", sectionId: entry.id, field, groupId: entry.groupId, name: entry.name, statusBefore: status, statusAfter: status }, before, body))
        }
        return entries
    }
    const live = target as LiveCatalog["groups"][number]
    const newId = editorialId("npg", `${input.baseRevision}\0${canonicalJson(changes)}`)
    const bodies: Partial<Record<GroupField, string>> = {}
    for (const field of GROUP_FIELDS) {
        const values = changes[field]
        if (values === undefined) continue
        const body = listBody(values)
        bodies[field] = body
        entries.push(bodyEntry("create", { scope: "group", sectionId: newId, field, groupId: live.groupId, name: live.name, statusAfter: "active" }, null, body))
    }
    edit.addGroup({ id: newId, binding: live.binding, groupId: live.groupId, name: live.name }, bodies)
    return entries
}

function planSetSource(input: PlanInput, edit: DocumentEdit, sources: readonly ReconciledSource[], changes: Extract<NewsPreferenceChanges, { operation: "set_source" }>): PlanEntry[] {
    let section: ReconciledSource | undefined
    let target: LiveCatalog["sources"][number] | undefined
    if (changes.editorialSourceId !== undefined) {
        section = sources.find((source) => source.entry.id === changes.editorialSourceId)
        if (section === undefined) notFound()
        if (!section.applied) review()
    } else {
        target = liveSource(input.catalog, changes.sourceId as number)
        const related = sources.filter((source) => source.entry.binding === target?.binding)
        const first = related[0]
        if (related.length > 1 || (first !== undefined && !first.applied)) review()
        section = first
    }
    const body = listBody(changes.preferences)
    if (section !== undefined) {
        const { entry, status } = section
        const key = sourceKey(entry.id)
        const before = edit.body(key)
        return edit.setBody(key, body) ? [bodyEntry("replace", { scope: "source", sectionId: entry.id, field: "preferences", sourceId: section.live?.sourceId ?? entry.sourceId, name: section.live?.name ?? entry.name, statusBefore: status, statusAfter: status }, before, body)] : []
    }
    const live = target as LiveCatalog["sources"][number]
    const newId = editorialId("nps", `${input.baseRevision}\0${canonicalJson(changes)}`)
    edit.addSource({ id: newId, binding: live.binding, sourceId: live.sourceId, name: live.name }, body)
    return [bodyEntry("create", { scope: "source", sectionId: newId, field: "preferences", sourceId: live.sourceId, name: live.name, statusAfter: "active" }, null, body)]
}

function planSync(edit: DocumentEdit, groups: readonly ReconciledGroup[], sources: readonly ReconciledSource[]): PlanEntry[] {
    const entries: PlanEntry[] = []
    for (const { entry, status, live } of groups) {
        if (status !== "active" || live === null || live.name === entry.name) continue
        const stored = edit.metadata.groups.find((group) => group.id === entry.id)
        if (stored !== undefined) stored.name = live.name
        edit.setHeading(entry.id, groupHeading(live.name))
        entries.push(entryOf({ action: "rename", scope: "group", sectionId: entry.id, groupId: live.groupId, name: live.name, before: entry.name, after: live.name, statusBefore: status, statusAfter: status }))
    }
    for (const { entry, status, live, applied } of sources) {
        if (!applied || live === null || (live.name === entry.name && live.sourceId === entry.sourceId)) continue
        const stored = edit.metadata.sources.find((source) => source.id === entry.id)
        if (stored !== undefined) {
            stored.name = live.name
            stored.sourceId = live.sourceId
        }
        edit.setHeading(entry.id, sourceHeading(live.name))
        entries.push(entryOf({ action: status === "relocated" ? "relocate" : "rename", scope: "source", sectionId: entry.id, sourceId: live.sourceId, name: live.name, before: entry.name, after: live.name, statusBefore: status, statusAfter: "active" }))
    }
    return entries
}

function planRebind(input: PlanInput, edit: DocumentEdit, groups: readonly ReconciledGroup[], sources: readonly ReconciledSource[], changes: Extract<NewsPreferenceChanges, { operation: "rebind_section" }>): PlanEntry[] {
    if (changes.editorialGroupId !== undefined) {
        const section = groups.find((group) => group.entry.id === changes.editorialGroupId)
        if (section === undefined) notFound()
        const live = liveGroup(input.catalog, changes.groupId as number)
        if (groups.some((group) => group.entry.id !== section.entry.id && group.entry.groupId === live.groupId)) throw new FrMcpError("INVALID_ARGUMENT", "duplicate-mapping")
        const stored = edit.metadata.groups.find((group) => group.id === section.entry.id)
        if (stored === undefined) notFound()
        Object.assign(stored, { binding: live.binding, groupId: live.groupId, name: live.name })
        edit.setHeading(section.entry.id, groupHeading(live.name))
        if (section.status === "active" && section.entry.groupId === live.groupId && section.entry.name === live.name) return []
        return [entryOf({ action: "rebind", scope: "group", sectionId: section.entry.id, groupId: live.groupId, name: live.name, before: section.entry.name, after: live.name, statusBefore: section.status, statusAfter: "active" })]
    }
    const section = sources.find((source) => source.entry.id === changes.editorialSourceId)
    if (section === undefined) notFound()
    const live = liveSource(input.catalog, changes.sourceId as number)
    if (sources.some((source) => source.entry.id !== section.entry.id && source.entry.binding === live.binding)) throw new FrMcpError("INVALID_ARGUMENT", "duplicate-mapping")
    const stored = edit.metadata.sources.find((source) => source.id === section.entry.id)
    if (stored === undefined) notFound()
    Object.assign(stored, { binding: live.binding, sourceId: live.sourceId, name: live.name })
    edit.setHeading(section.entry.id, sourceHeading(live.name))
    if (section.status === "active" && section.entry.sourceId === live.sourceId && section.entry.name === live.name) return []
    return [entryOf({ action: "rebind", scope: "source", sectionId: section.entry.id, sourceId: live.sourceId, name: live.name, before: section.entry.name, after: live.name, statusBefore: section.status, statusAfter: "active" })]
}

function planRemove(edit: DocumentEdit, groups: readonly ReconciledGroup[], sources: readonly ReconciledSource[], changes: Extract<NewsPreferenceChanges, { operation: "remove_section" }>): PlanEntry[] {
    if (changes.editorialGroupId !== undefined) {
        const section = groups.find((group) => group.entry.id === changes.editorialGroupId)
        if (section === undefined) notFound()
        const entries = GROUP_FIELDS.map((field) => entryOf({ action: "remove", scope: "group", sectionId: section.entry.id, field, groupId: section.entry.groupId, name: section.entry.name, before: edit.body(groupKey(section.entry.id, field)), statusBefore: section.status }))
        edit.removeGroup(section.entry.id)
        return entries
    }
    const section = sources.find((source) => source.entry.id === changes.editorialSourceId)
    if (section === undefined) notFound()
    const entry = entryOf({ action: "remove", scope: "source", sectionId: section.entry.id, field: "preferences", sourceId: section.entry.sourceId, name: section.entry.name, before: edit.body(sourceKey(section.entry.id)), statusBefore: section.status })
    edit.removeSource(section.entry.id)
    return [entry]
}

function planReassociate(input: PlanInput, parsed: ParsedPreferences, edit: DocumentEdit, changes: Extract<NewsPreferenceChanges, { operation: "reassociate_profile" }>): PlanEntry[] {
    const entries: PlanEntry[] = [entryOf({ action: "adopt", scope: "document", statusBefore: "unverified", statusAfter: "active" })]
    const mappedGroups = new Map<string, number>()
    const groupTargets = new Set<number>()
    for (const mapping of changes.groupMappings) {
        if (mappedGroups.has(mapping.editorialGroupId) || groupTargets.has(mapping.groupId)) throw new FrMcpError("INVALID_ARGUMENT", "duplicate-mapping")
        if (!parsed.metadata.groups.some((group) => group.id === mapping.editorialGroupId)) throw new FrMcpError("INVALID_ARGUMENT", "invalid-mapping")
        mappedGroups.set(mapping.editorialGroupId, mapping.groupId)
        groupTargets.add(mapping.groupId)
    }
    const mappedSources = new Map<string, number>()
    const sourceTargets = new Set<number>()
    for (const mapping of changes.sourceMappings) {
        if (mappedSources.has(mapping.editorialSourceId) || sourceTargets.has(mapping.sourceId)) throw new FrMcpError("INVALID_ARGUMENT", "duplicate-mapping")
        if (!parsed.metadata.sources.some((source) => source.id === mapping.editorialSourceId)) throw new FrMcpError("INVALID_ARGUMENT", "invalid-mapping")
        mappedSources.set(mapping.editorialSourceId, mapping.sourceId)
        sourceTargets.add(mapping.sourceId)
    }
    const unmapped = parsed.metadata.groups.filter((group) => !mappedGroups.has(group.id)).length + parsed.metadata.sources.filter((source) => !mappedSources.has(source.id)).length
    if (unmapped > 0 && changes.allowUnmapped !== true) throw new FrMcpError("INVALID_ARGUMENT", "unmapped-sections")

    edit.metadata.profileBinding = input.profileBinding
    for (const stored of edit.metadata.groups) {
        const target = mappedGroups.get(stored.id)
        const before = stored.name
        if (target === undefined) {
            stored.binding = null
            stored.groupId = null
            entries.push(entryOf({ action: "orphan", scope: "group", sectionId: stored.id, name: before, before, statusBefore: "unverified", statusAfter: "orphaned" }))
            continue
        }
        const live = input.catalog.groups.filter((group) => group.groupId === target)
        const first = live[0]
        if (first === undefined || live.length > 1 || first.status !== "active") throw new FrMcpError("INVALID_ARGUMENT", "invalid-mapping")
        stored.binding = first.binding
        stored.groupId = first.groupId
        stored.name = first.name
        edit.setHeading(stored.id, groupHeading(first.name))
        entries.push(entryOf({ action: "rebind", scope: "group", sectionId: stored.id, groupId: first.groupId, name: first.name, before, after: first.name, statusBefore: "unverified", statusAfter: "active" }))
    }
    for (const stored of edit.metadata.sources) {
        const target = mappedSources.get(stored.id)
        const before = stored.name
        if (target === undefined) {
            stored.binding = null
            stored.sourceId = null
            entries.push(entryOf({ action: "orphan", scope: "source", sectionId: stored.id, name: before, before, statusBefore: "unverified", statusAfter: "orphaned" }))
            continue
        }
        const live = input.catalog.sources.find((source) => source.sourceId === target)
        if (live === undefined || live.binding === null) throw new FrMcpError("INVALID_ARGUMENT", "invalid-mapping")
        stored.binding = live.binding
        stored.sourceId = live.sourceId
        stored.name = live.name
        edit.setHeading(stored.id, sourceHeading(live.name))
        entries.push(entryOf({ action: "rebind", scope: "source", sectionId: stored.id, sourceId: live.sourceId, name: live.name, before, after: live.name, statusBefore: "unverified", statusAfter: "active" }))
    }
    return entries
}

/** Every refusal happens here, before any key, backup or temporary file exists. */
export function computePlan(input: PlanInput): Plan {
    const { changes, catalog, verified } = input
    if (changes.operation === "initialize") return planInitialize(input, changes)
    const parsed = requireParsed(input.parsed)
    const edit = new DocumentEdit(parsed)
    const { groups, sources } = reconcile(parsed.metadata, catalog, verified)
    let entries: PlanEntry[]
    switch (changes.operation) {
        case "set_general": entries = planSetGeneral(edit, changes); break
        case "set_group": entries = planSetGroup(input, edit, groups, changes); break
        case "set_source": entries = planSetSource(input, edit, sources, changes); break
        case "sync_catalog": entries = planSync(edit, groups, sources); break
        case "rebind_section": entries = planRebind(input, edit, groups, sources, changes); break
        case "remove_section": entries = planRemove(edit, groups, sources, changes); break
        case "reassociate_profile": entries = planReassociate(input, parsed, edit, changes); break
    }
    const text = edit.finish()
    const next = Buffer.from(text, "utf8")
    const changed = text !== parsed.text
    if (changed) verifyResult(parsed, next, edit.touched)
    else parsePreferences(next)
    return { entries, next, changed }
}
