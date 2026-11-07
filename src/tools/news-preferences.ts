import { z } from "zod"
import { FrMcpError, toSafeError } from "../errors.js"
import { loadLiveCatalog, type LiveCatalog } from "../preferences/catalog.js"
import { GENERAL_FIELDS, generalKey, GROUP_FIELDS, groupKey, sourceKey, type ParsedPreferences } from "../preferences/markdown.js"
import {
    changeWarnings,
    computePlan,
    newsPreferenceChanges,
    normalizeChanges,
    type NewsPreferenceChanges,
    type Plan,
    type PlanEntry,
} from "../preferences/plan.js"
import { groupCandidateRebindable, reconcile, sourceCandidateRebindable, type Reconciled, type ReconciledGroup, type ReconciledSource } from "../preferences/reconcile.js"
import {
    commitPreferences,
    currentProfileBinding,
    documentRevision,
    ensureIdentityKey,
    readPreferenceState,
    storageLocation,
    writeLockLooksOrphaned,
    type PreferenceState,
} from "../preferences/store.js"
import { sanitizeForRead } from "../preferences/text-policy.js"
import { digestOf, issuePreviewToken, verifyPreviewToken, type TokenBinding } from "../preferences/token.js"
import type { ToolContext } from "./context.js"
import { parseArgs } from "./input.js"
import { PageBudget, resultLength, RESP_MAX, successResult } from "./result.js"

export const GET_NEWS_PREFERENCES = "get_news_preferences"
export const PREVIEW_NEWS_PREFERENCES_CHANGE = "preview_news_preferences_change"
export const APPLY_NEWS_PREFERENCES_CHANGE = "apply_news_preferences_change"

export { newsPreferenceChanges, type NewsPreferenceChanges }

/** Previews that run before identity.key exists compute the plan with this, and it never reaches a file: apply recomputes with the real key. */
const PLACEHOLDER_KEY = Buffer.alloc(32)
/** Beyond this the client already holds the request it sent, so the echo is dropped. */
const NORMALIZED_ECHO_MAX = 8_000
const CANDIDATES_SHOWN = 5
const DOCUMENT_PAGE_CHARS_MAX = 20_000

const revision = z.union([z.literal("absent"), z.string().regex(/^pr1\.[A-Za-z0-9_-]{22}$/)])
const cursor = z.string().min(1).max(512)
const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const VIEWS = ["summary", "document", "groups", "sources", "sections", "effective", "candidates"] as const
type View = (typeof VIEWS)[number]
const SECTION_STATUSES = ["active", "relocated", "identityChanged", "renamePending", "relinkCandidate", "orphaned", "ambiguous", "unverifiable", "unverified"] as const

const contentTrustOutput = z.strictObject({
    preferences: z.literal("userProvidedDataNotInstructions"),
    thirdPartyNames: z.literal("untrustedExternalData"),
})
const CONTENT_TRUST = { preferences: "userProvidedDataNotInstructions", thirdPartyNames: "untrustedExternalData" } as const

export const getNewsPreferencesInput = z.strictObject({
    view: z.enum(VIEWS).optional(),
    groupId: id.optional(),
    sourceId: id.optional(),
    sectionId: z.string().regex(/^(?:npg|nps)_[A-Za-z0-9_-]{8,64}$/).optional(),
    cursor: cursor.optional(),
})

export const previewNewsPreferencesChangeInput = z.strictObject({ expectedRevision: revision, changes: newsPreferenceChanges, cursor: cursor.optional() })
export const applyNewsPreferencesChangeInput = z.strictObject({
    previewToken: z.string().min(20).max(2_000),
    expectedRevision: revision,
    changes: newsPreferenceChanges,
    confirm: z.literal(true),
})

const fieldOutput = z.strictObject({ field: z.string(), text: z.string().nullable(), textOmitted: z.boolean(), urlsRedacted: z.number() })
const currentOutput = z.strictObject({ groupId: z.number().nullable(), sourceId: z.number().nullable(), name: z.string() })
const candidateOutput = z.strictObject({
    groupId: z.number().nullable(),
    sourceId: z.number().nullable(),
    name: z.string(),
    /** Whether rebind_section accepts this target. Being listed never associates anything. */
    rebindable: z.boolean(),
})

const sectionOutput = z.strictObject({
    sectionId: z.string(),
    scope: z.enum(["general", "group", "source"]),
    status: z.enum(SECTION_STATUSES),
    applied: z.boolean(),
    storedName: z.string().nullable(),
    current: currentOutput.nullable(),
    /** At most the first few. candidateCount is the real total; fullCandidates says how to read all of them. */
    candidates: z.array(candidateOutput),
    candidateCount: z.number(),
    candidatesReturned: z.number(),
    candidatesTruncated: z.boolean(),
    fullCandidates: z.strictObject({ view: z.literal("candidates"), sectionId: z.string() }).nullable(),
    fields: z.array(fieldOutput),
})

const layerOutput = z.strictObject({
    level: z.enum(["source", "group", "general"]),
    sectionId: z.string().nullable(),
    name: z.string().nullable(),
    fields: z.array(fieldOutput),
})

export const getNewsPreferencesOutput = z.strictObject({
    view: z.enum(VIEWS),
    documentStatus: z.enum(["absent", "ready", "damaged", "tooLarge"]),
    revision,
    profileBinding: z.enum(["verified", "mismatch", "keyMissing", "notInitialized", "unverifiable"]),
    markdownVerified: z.boolean(),
    bytes: z.number().nullable(),
    issue: z.strictObject({ code: z.string(), line: z.number() }).nullable(),
    storageLocation: z.string(),
    catalog: z.strictObject({
        available: z.boolean(),
        revision: z.string().nullable(),
        groups: z.number().nullable(),
        sources: z.number().nullable(),
        ambiguousGroups: z.number().nullable(),
        unavailableCode: z.string().nullable(),
    }).nullable(),
    catalogDrift: z.boolean().nullable(),
    sectionCounts: z.strictObject({
        groups: z.number(),
        groupsApplied: z.number(),
        sources: z.number(),
        sourcesApplied: z.number(),
        needingReview: z.number(),
    }).nullable(),
    contentTrust: contentTrustOutput,
    warnings: z.array(z.string()),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    document: z.strictObject({ offset: z.number(), totalChars: z.number(), text: z.string(), urlsRedacted: z.number() }).optional(),
    groups: z.array(z.strictObject({ groupId: z.number(), name: z.string(), status: z.enum(["active", "ambiguous"]), sectionId: z.string().nullable() })).optional(),
    sources: z.array(z.strictObject({ sourceId: z.number(), name: z.string(), groupId: z.number().nullable(), groupStatus: z.enum(["grouped", "ungrouped", "ambiguous", "unavailable"]), sectionId: z.string().nullable() })).optional(),
    sections: z.array(sectionOutput).optional(),
    candidates: z.strictObject({
        sectionId: z.string(),
        scope: z.enum(["group", "source"]),
        status: z.enum(SECTION_STATUSES),
        total: z.number(),
        offset: z.number(),
        items: z.array(candidateOutput),
    }).optional(),
    effective: z.strictObject({
        priority: z.tuple([z.literal("source"), z.literal("group"), z.literal("general")]),
        withinLevel: z.tuple([z.literal("exceptions"), z.literal("avoid"), z.literal("importance"), z.literal("interests")]),
        layers: z.array(layerOutput),
        notApplied: z.array(z.strictObject({ scope: z.enum(["group", "source"]), sectionId: z.string(), status: z.enum(SECTION_STATUSES) })),
    }).nullable().optional(),
})

const OPERATIONS = ["initialize", "set_general", "set_group", "set_source", "sync_catalog", "rebind_section", "remove_section", "reassociate_profile"] as const

const planEntryOutput = z.strictObject({
    action: z.enum(["create", "replace", "clear", "remove", "rebind", "orphan", "rename", "relocate", "adopt"]),
    scope: z.enum(["document", "general", "group", "source"]),
    sectionId: z.string().nullable(),
    field: z.string().nullable(),
    groupId: z.number().nullable(),
    sourceId: z.number().nullable(),
    name: z.string().nullable(),
    before: z.string().nullable(),
    after: z.string().nullable(),
    textOmitted: z.boolean(),
    urlsRedacted: z.number(),
    statusBefore: z.enum(SECTION_STATUSES).nullable(),
    statusAfter: z.enum(SECTION_STATUSES).nullable(),
})

export const previewNewsPreferencesChangeOutput = z.strictObject({
    operation: z.enum(OPERATIONS),
    expectedRevision: revision,
    profileBinding: z.enum(["verified", "mismatch", "keyMissing", "notInitialized", "unverifiable"]),
    catalogRevision: z.string(),
    previewToken: z.string(),
    normalizedChanges: newsPreferenceChanges.nullable(),
    wouldApply: z.boolean(),
    resultRevision: revision.nullable(),
    summary: z.strictObject({ entries: z.number(), catalogGroups: z.number(), catalogSources: z.number(), unresolvedSections: z.number() }),
    plan: z.array(planEntryOutput),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    warnings: z.array(z.string()),
    contentTrust: contentTrustOutput,
    limits: z.string(),
})

export const applyNewsPreferencesChangeOutput = z.strictObject({
    operation: z.enum(OPERATIONS),
    applied: z.boolean(),
    previousRevision: revision,
    revision,
    profileBinding: z.literal("verified"),
    backup: z.strictObject({ location: z.string(), name: z.string() }).nullable(),
    sectionsChanged: z.array(z.string()),
    warnings: z.array(z.string()),
    consentLimitation: z.string(),
})

const PREVIEW_LIMITS =
    "The preview writes nothing and authenticates only the reviewed plan and observed revisions. The previewToken and confirm:true are client inputs; they do not independently prove human consent."
const CONSENT_LIMITATION =
    "The authenticated preview token proves that this server produced a preview for the exact plan and revisions. It does not prove that a human reviewed or authorized the request; confirm:true is supplied by the client."

function requireEnabled(context: ToolContext): void {
    if (!context.newsPreferences.enabled) throw new FrMcpError("NEWS_PREFERENCES_DISABLED", "preferences-disabled")
}

function encodeCursor(view: string, basis: string, offset: number): string {
    return `npc1.${Buffer.from(JSON.stringify({ v: view, b: basis, o: offset })).toString("base64url")}`
}

function decodeCursor(value: string | undefined, view: string, basis: string): number {
    if (value === undefined) return 0
    if (!value.startsWith("npc1.")) throw new FrMcpError("CURSOR_INVALID")
    let parsed: unknown
    try {
        parsed = JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8"))
    } catch {
        throw new FrMcpError("CURSOR_INVALID")
    }
    const c = parsed as { v?: unknown; b?: unknown; o?: unknown } | null
    if (typeof c !== "object" || c === null || typeof c.v !== "string" || typeof c.b !== "string" || !Number.isSafeInteger(c.o) || (c.o as number) < 0) throw new FrMcpError("CURSOR_INVALID")
    if (c.v !== view) throw new FrMcpError("CURSOR_MISMATCH")
    if (c.b !== basis) throw new FrMcpError("CURSOR_STALE")
    return c.o as number
}

const basisOf = (...parts: readonly unknown[]): string => digestOf(parts).slice(0, 22)

interface Page<E> {
    readonly items: E[]
    readonly hasMore: boolean
    readonly nextCursor: string | null
}

/** One page within RESP_MAX. An element too large for an empty page is shrunk, never truncated silently. */
function pageOf<E>(all: readonly E[], start: number, view: string, basis: string, build: (items: E[], hasMore: boolean, nextCursor: string | null) => object, shrink: (element: E) => E = (element) => element): Page<E> {
    const budget = new PageBudget(resultLength(build([], true, encodeCursor(view, basis, Number.MAX_SAFE_INTEGER))))
    const items: E[] = []
    let index = start
    for (; index < all.length; index++) {
        let element = all[index] as E
        if (!budget.tryAdd(JSON.stringify(element))) {
            if (items.length > 0) break
            element = shrink(element)
            if (!budget.tryAdd(JSON.stringify(element))) throw new FrMcpError("LIMIT_EXCEEDED", "response-too-large")
        }
        items.push(element)
    }
    const hasMore = index < all.length
    return { items, hasMore, nextCursor: hasMore ? encodeCursor(view, basis, index) : null }
}

function fieldEntry(field: string, body: string) {
    const clean = sanitizeForRead(body)
    return { field, text: clean.text, textOmitted: false, urlsRedacted: clean.urlsRedacted }
}

const omitFields = <T extends { fields: readonly { field: string }[] }>(element: T): T => ({
    ...element,
    fields: element.fields.map(({ field }) => ({ field, text: null, textOmitted: true, urlsRedacted: 0 })),
})

interface CatalogAttempt {
    readonly catalog: LiveCatalog | null
    /** The real cause, kept so a view that needs the catalog reports it and not something else. */
    readonly error: FrMcpError | null
}

async function tryCatalog(context: ToolContext, key: Buffer | null): Promise<CatalogAttempt> {
    try {
        return { catalog: await loadLiveCatalog(context, key ?? undefined), error: null }
    } catch (error) {
        return { catalog: null, error: toSafeError(error) }
    }
}

function stateWarnings(state: PreferenceState, now: number): string[] {
    return [
        ...(state.profileBinding === "mismatch" ? ["profileMismatchPreferencesNotApplied"] : []),
        ...(state.profileBinding === "keyMissing" ? ["identityKeyMissingPreferencesNotApplied"] : []),
        ...(state.keyInvalid ? ["identityKeyInvalid"] : []),
        ...(state.documentStatus === "damaged" ? ["documentDamagedPreferencesNotApplied"] : []),
        ...(state.documentStatus === "tooLarge" ? ["documentTooLargePreferencesNotApplied"] : []),
        ...(writeLockLooksOrphaned(state.paths, now) ? ["writeLockMayBeOrphaned"] : []),
    ]
}

interface ReadContext {
    readonly state: PreferenceState
    readonly attempt: CatalogAttempt | null
    readonly reconciled: Reconciled | null
    readonly verified: boolean
}

function commonFields(context: ToolContext, view: View, read: ReadContext) {
    const { state, attempt, reconciled, verified } = read
    const catalog = attempt?.catalog ?? null
    return {
        view,
        documentStatus: state.documentStatus,
        revision: state.revision,
        profileBinding: state.profileBinding,
        markdownVerified: verified,
        bytes: state.size,
        issue: state.issue,
        storageLocation: storageLocation(context.profileDir),
        catalog: attempt === null ? null : {
            available: catalog !== null,
            revision: catalog?.revision ?? null,
            groups: catalog?.groups.length ?? null,
            sources: catalog?.sources.length ?? null,
            ambiguousGroups: catalog?.ambiguousGroups ?? null,
            unavailableCode: attempt.error?.code ?? null,
        },
        catalogDrift: reconciled?.drift ?? null,
        sectionCounts: reconciled === null ? null : {
            groups: reconciled.groups.length,
            groupsApplied: reconciled.groups.filter((group) => group.applied).length,
            sources: reconciled.sources.length,
            sourcesApplied: reconciled.sources.filter((source) => source.applied).length,
            needingReview: reconciled.groups.filter((group) => !group.applied).length + reconciled.sources.filter((source) => !source.applied).length,
        },
        contentTrust: CONTENT_TRUST,
        warnings: [
            ...stateWarnings(state, context.now()),
            ...(attempt !== null && catalog === null ? ["catalogUnavailable"] : []),
            ...(catalog !== null && catalog.ambiguousGroups > 0 ? ["ambiguousGroupsNotAssociated"] : []),
            ...(reconciled !== null && verified && [...reconciled.groups, ...reconciled.sources].some((section) => !section.applied) ? ["sectionsNeedReview"] : []),
        ],
        hasMore: false,
        nextCursor: null as string | null,
    }
}

function requireCatalog(read: ReadContext): LiveCatalog {
    const catalog = read.attempt?.catalog
    if (catalog === undefined || catalog === null) throw read.attempt?.error ?? new FrMcpError("INTERNAL_ERROR", "unexpected")
    return catalog
}

function documentView(context: ToolContext, read: ReadContext, input: z.output<typeof getNewsPreferencesInput>) {
    const base = commonFields(context, "document", read)
    const { state } = read
    if (state.documentStatus === "tooLarge") throw new FrMcpError("PREFERENCES_INVALID", "file-too-large")
    const offset = decodeCursor(input.cursor, "document", state.revision)
    if (state.bytes === null) return successResult({ ...base }).result
    const clean = sanitizeForRead(state.bytes.toString("utf8"))
    if (offset > clean.text.length) throw new FrMcpError("CURSOR_INVALID")
    const worst = encodeCursor("document", state.revision, Number.MAX_SAFE_INTEGER)
    const build = (end: number) => ({
        ...base,
        hasMore: true,
        nextCursor: worst,
        document: { offset, totalChars: clean.text.length, text: clean.text.slice(offset, end), urlsRedacted: clean.urlsRedacted },
    })
    let low = offset
    let high = Math.min(clean.text.length, offset + DOCUMENT_PAGE_CHARS_MAX)
    let best = offset
    while (low <= high) {
        const middle = Math.ceil((low + high) / 2)
        if (resultLength(build(middle)) <= RESP_MAX) {
            best = middle
            low = middle + 1
        } else {
            high = middle - 1
        }
    }
    // Never split a surrogate pair across two pages.
    if (best > offset && best < clean.text.length && (clean.text.charCodeAt(best - 1) & 0xfc00) === 0xd800) best--
    const hasMore = best < clean.text.length
    return successResult({
        ...base,
        hasMore,
        nextCursor: hasMore ? encodeCursor("document", state.revision, best) : null,
        document: { offset, totalChars: clean.text.length, text: clean.text.slice(offset, best), urlsRedacted: clean.urlsRedacted },
    }).result
}

function groupsView(context: ToolContext, read: ReadContext, input: z.output<typeof getNewsPreferencesInput>) {
    const catalog = requireCatalog(read)
    const sectionByGid = new Map((read.reconciled?.groups ?? []).filter((group) => group.live !== null).map((group) => [group.live?.groupId, group.entry.id]))
    const all = catalog.groups.map(({ groupId, name, status }) => ({ groupId, name, status, sectionId: sectionByGid.get(groupId) ?? null }))
    const basis = basisOf(catalog.revision, read.state.revision)
    const base = commonFields(context, "groups", read)
    const build = (groups: typeof all, hasMore: boolean, nextCursor: string | null) => ({ ...base, hasMore, nextCursor, groups })
    const page = pageOf(all, decodeCursor(input.cursor, "groups", basis), "groups", basis, build)
    return successResult(build(page.items, page.hasMore, page.nextCursor)).result
}

function sourcesView(context: ToolContext, read: ReadContext, input: z.output<typeof getNewsPreferencesInput>) {
    const catalog = requireCatalog(read)
    const sectionBySid = new Map((read.reconciled?.sources ?? []).filter((source) => source.live !== null).map((source) => [source.live?.sourceId, source.entry.id]))
    const all = catalog.sources.map(({ sourceId, name, groupId, groupStatus }) => ({ sourceId, name, groupId, groupStatus, sectionId: sectionBySid.get(sourceId) ?? null }))
    const basis = basisOf(catalog.revision, read.state.revision)
    const base = commonFields(context, "sources", read)
    const build = (sources: typeof all, hasMore: boolean, nextCursor: string | null) => ({ ...base, hasMore, nextCursor, sources })
    const page = pageOf(all, decodeCursor(input.cursor, "sources", basis), "sources", basis, build)
    return successResult(build(page.items, page.hasMore, page.nextCursor)).result
}

function requireParsed(state: PreferenceState): ParsedPreferences {
    if (state.documentStatus === "tooLarge") throw new FrMcpError("PREFERENCES_INVALID", "file-too-large")
    if (state.documentStatus === "damaged") throw new FrMcpError("PREFERENCES_INVALID", "invalid-markdown")
    if (state.parsed === null) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "not-initialized")
    return state.parsed
}

const current = (c: { readonly groupId?: number | null; readonly sourceId?: number | null; readonly name: string }) => ({ groupId: c.groupId ?? null, sourceId: c.sourceId ?? null, name: c.name })

type CandidateRow = z.output<typeof candidateOutput>

function groupCandidates(section: ReconciledGroup, all: readonly ReconciledGroup[]): CandidateRow[] {
    return section.candidates.map((c) => ({ groupId: c.groupId, sourceId: null, name: c.name, rebindable: groupCandidateRebindable(section, c, all) }))
}

function sourceCandidates(section: ReconciledSource, all: readonly ReconciledSource[]): CandidateRow[] {
    return section.candidates.map((c) => ({ groupId: null, sourceId: c.sourceId, name: c.name, rebindable: sourceCandidateRebindable(section, c, all) }))
}

/** A partial list is never presented as complete: the counts and the way to the rest travel with it. */
function candidateFields(sectionId: string, rows: readonly CandidateRow[]) {
    const shown = rows.slice(0, CANDIDATES_SHOWN)
    const truncated = shown.length < rows.length
    return {
        candidates: shown,
        candidateCount: rows.length,
        candidatesReturned: shown.length,
        candidatesTruncated: truncated,
        fullCandidates: truncated ? { view: "candidates" as const, sectionId } : null,
    }
}

function sectionsView(context: ToolContext, read: ReadContext, input: z.output<typeof getNewsPreferencesInput>) {
    const parsed = requireParsed(read.state)
    const reconciled = read.reconciled ?? reconcile(parsed.metadata, null, read.verified)
    const bodyOf = (key: string): string => parsed.sections.get(key)?.body ?? ""
    const all: z.output<typeof sectionOutput>[] = [
        ...GENERAL_FIELDS.map((field) => ({
            sectionId: generalKey(field),
            scope: "general" as const,
            status: read.verified ? ("active" as const) : ("unverified" as const),
            applied: read.verified,
            storedName: null,
            current: null,
            ...candidateFields(generalKey(field), []),
            fields: [fieldEntry(field, bodyOf(generalKey(field)))],
        })),
        ...reconciled.groups.map((group) => ({
            sectionId: group.entry.id,
            scope: "group" as const,
            status: group.status,
            applied: group.applied,
            storedName: group.entry.name,
            current: group.live === null ? null : current(group.live),
            ...candidateFields(group.entry.id, groupCandidates(group, reconciled.groups)),
            fields: GROUP_FIELDS.map((field) => fieldEntry(field, bodyOf(groupKey(group.entry.id, field)))),
        })),
        ...reconciled.sources.map((source) => ({
            sectionId: source.entry.id,
            scope: "source" as const,
            status: source.status,
            applied: source.applied,
            storedName: source.entry.name,
            current: source.live === null ? null : current(source.live),
            ...candidateFields(source.entry.id, sourceCandidates(source, reconciled.sources)),
            fields: [fieldEntry("preferences", bodyOf(sourceKey(source.entry.id)))],
        })),
    ]
    const basis = basisOf(read.state.revision, read.attempt?.catalog?.revision ?? null)
    const base = commonFields(context, "sections", read)
    const build = (sections: typeof all, hasMore: boolean, nextCursor: string | null) => ({ ...base, hasMore, nextCursor, sections })
    const page = pageOf(all, decodeCursor(input.cursor, "sections", basis), "sections", basis, build, omitFields)
    return successResult(build(page.items, page.hasMore, page.nextCursor)).result
}

/** Every candidate of one section, in catalog order, paged like the other lists. */
function candidatesView(context: ToolContext, read: ReadContext, input: z.output<typeof getNewsPreferencesInput>) {
    const parsed = requireParsed(read.state)
    const catalog = requireCatalog(read)
    const reconciled = read.reconciled ?? reconcile(parsed.metadata, catalog, read.verified)
    const sectionId = input.sectionId as string
    const group = reconciled.groups.find((section) => section.entry.id === sectionId)
    const source = reconciled.sources.find((section) => section.entry.id === sectionId)
    if (group === undefined && source === undefined) throw new FrMcpError("NOT_FOUND", "preference-target-not-found")
    const rows = group !== undefined ? groupCandidates(group, reconciled.groups) : sourceCandidates(source as ReconciledSource, reconciled.sources)
    const status = (group ?? (source as ReconciledSource)).status
    const basis = basisOf(read.state.revision, catalog.revision, sectionId)
    const offset = decodeCursor(input.cursor, "candidates", basis)
    const base = commonFields(context, "candidates", read)
    const build = (items: CandidateRow[], hasMore: boolean, nextCursor: string | null) => ({
        ...base,
        hasMore,
        nextCursor,
        candidates: { sectionId, scope: group !== undefined ? ("group" as const) : ("source" as const), status, total: rows.length, offset, items },
    })
    const page = pageOf(rows, offset, "candidates", basis, build)
    return successResult(build(page.items, page.hasMore, page.nextCursor)).result
}

function effectiveView(context: ToolContext, read: ReadContext, input: z.output<typeof getNewsPreferencesInput>) {
    const base = commonFields(context, "effective", read)
    if (input.groupId !== undefined && input.sourceId !== undefined) throw new FrMcpError("INVALID_ARGUMENT", "invalid-argument")
    const emptyEffective = (layers: z.output<typeof layerOutput>[], notApplied: { scope: "group" | "source"; sectionId: string; status: (typeof SECTION_STATUSES)[number] }[]) => ({
        priority: ["source", "group", "general"] as const,
        withinLevel: ["exceptions", "avoid", "importance", "interests"] as const,
        layers,
        notApplied,
    })
    if (!read.verified || read.state.parsed === null) return successResult({ ...base, effective: null }).result
    const parsed = read.state.parsed
    const targeted = input.groupId !== undefined || input.sourceId !== undefined
    const catalog = targeted ? requireCatalog(read) : (read.attempt?.catalog ?? null)
    const reconciled = read.reconciled ?? reconcile(parsed.metadata, catalog, true)
    const bodyOf = (key: string): string => parsed.sections.get(key)?.body ?? ""
    const layers: z.output<typeof layerOutput>[] = []
    const notApplied: { scope: "group" | "source"; sectionId: string; status: (typeof SECTION_STATUSES)[number] }[] = []
    let groupId = input.groupId ?? null
    if (input.sourceId !== undefined) {
        const live = catalog?.sources.find((source) => source.sourceId === input.sourceId)
        if (live === undefined) throw new FrMcpError("NOT_FOUND", "preference-target-not-found")
        groupId = live.groupStatus === "grouped" ? live.groupId : null
        for (const source of reconciled.sources) {
            const matches = source.applied ? source.live?.sourceId === live.sourceId : source.entry.sourceId === live.sourceId
            if (!matches) continue
            if (source.applied) layers.push({ level: "source", sectionId: source.entry.id, name: live.name, fields: [fieldEntry("preferences", bodyOf(sourceKey(source.entry.id)))] })
            else notApplied.push({ scope: "source", sectionId: source.entry.id, status: source.status })
        }
    } else if (input.groupId !== undefined && !catalog?.groups.some((group) => group.groupId === input.groupId)) {
        throw new FrMcpError("NOT_FOUND", "preference-target-not-found")
    }
    if (groupId !== null) {
        for (const group of reconciled.groups) {
            const matches = group.applied ? group.live?.groupId === groupId : group.entry.groupId === groupId || group.candidates.some((c) => c.groupId === groupId)
            if (!matches) continue
            if (group.applied) layers.push({ level: "group", sectionId: group.entry.id, name: group.live?.name ?? group.entry.name, fields: GROUP_FIELDS.map((field) => fieldEntry(field, bodyOf(groupKey(group.entry.id, field)))) })
            else notApplied.push({ scope: "group", sectionId: group.entry.id, status: group.status })
        }
    }
    layers.push({ level: "general", sectionId: null, name: null, fields: GENERAL_FIELDS.map((field) => fieldEntry(field, bodyOf(generalKey(field)))) })
    const basis = basisOf(read.state.revision, catalog?.revision ?? null, input.groupId ?? null, input.sourceId ?? null)
    const build = (items: typeof layers, hasMore: boolean, nextCursor: string | null) => ({ ...base, hasMore, nextCursor, effective: emptyEffective(items, notApplied) })
    const page = pageOf(layers, decodeCursor(input.cursor, "effective", basis), "effective", basis, build, omitFields)
    return successResult(build(page.items, page.hasMore, page.nextCursor)).result
}

export async function getNewsPreferences(context: ToolContext, args: unknown) {
    requireEnabled(context)
    const input = parseArgs(getNewsPreferencesInput, args)
    return context.cursors.exclusive(async () => {
        const view = input.view ?? "summary"
        if ((input.groupId !== undefined || input.sourceId !== undefined) && view !== "effective") throw new FrMcpError("INVALID_ARGUMENT", "invalid-argument")
        if ((input.sectionId !== undefined) !== (view === "candidates")) throw new FrMcpError("INVALID_ARGUMENT", "invalid-argument")
        const state = readPreferenceState(context.newsPreferences, context.profileDir)
        const verified = state.profileBinding === "verified" && state.parsed !== null
        // Reading the file never needs the catalog, so the document stays readable when the database is not.
        const attempt = view === "document" ? null : await tryCatalog(context, state.key)
        const reconciled = state.parsed === null || attempt === null ? null : reconcile(state.parsed.metadata, attempt.catalog, verified)
        const read: ReadContext = { state, attempt, reconciled, verified }
        switch (view) {
            case "summary": return successResult(commonFields(context, "summary", read)).result
            case "document": return documentView(context, read, input)
            case "groups": return groupsView(context, read, input)
            case "sources": return sourcesView(context, read, input)
            case "sections": return sectionsView(context, read, input)
            case "effective": return effectiveView(context, read, input)
            case "candidates": return candidatesView(context, read, input)
        }
    })
}

function validateOperation(state: PreferenceState, changes: NewsPreferenceChanges): void {
    if (state.documentStatus === "damaged") throw new FrMcpError("PREFERENCES_INVALID", "invalid-markdown")
    if (state.documentStatus === "tooLarge") throw new FrMcpError("PREFERENCES_INVALID", "file-too-large")
    if (changes.operation === "initialize") {
        if (state.parsed !== null) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "already-initialized")
        return
    }
    if (state.parsed === null) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "not-initialized")
    if (state.profileBinding === "mismatch" || state.profileBinding === "keyMissing") {
        if (changes.operation !== "reassociate_profile") throw new FrMcpError("PROFILE_BINDING_REQUIRED", "profile-binding")
        return
    }
    if (state.profileBinding !== "verified" || changes.operation === "reassociate_profile") {
        throw new FrMcpError("PROFILE_BINDING_REQUIRED", "profile-binding")
    }
}

function planFor(context: ToolContext, state: PreferenceState, catalog: LiveCatalog, key: Buffer, changes: NewsPreferenceChanges): Plan {
    return computePlan({
        parsed: state.parsed,
        catalog,
        profileBinding: currentProfileBinding(key, context.profileDir),
        baseRevision: state.revision,
        verified: state.profileBinding === "verified",
        changes,
    })
}

function bindingOf(state: PreferenceState, catalog: LiveCatalog, changes: NewsPreferenceChanges, plan: Plan): TokenBinding {
    return {
        operation: changes.operation,
        expectedRevision: state.revision,
        catalogRevision: catalog.revision,
        planDigest: digestOf({ changes, entries: plan.entries }),
        resultRevision: state.key === null ? null : documentRevision(plan.next),
    }
}

function planEntryForClient(entry: PlanEntry) {
    const before = entry.before === null ? null : sanitizeForRead(entry.before)
    const after = entry.after === null ? null : sanitizeForRead(entry.after)
    return {
        ...entry,
        before: before?.text ?? null,
        after: after?.text ?? null,
        textOmitted: false,
        urlsRedacted: (before?.urlsRedacted ?? 0) + (after?.urlsRedacted ?? 0),
    }
}

export async function previewNewsPreferencesChange(context: ToolContext, args: unknown) {
    requireEnabled(context)
    const input = parseArgs(previewNewsPreferencesChangeInput, args)
    const changes = normalizeChanges(input.changes)
    return context.cursors.exclusive(async () => {
        const state = readPreferenceState(context.newsPreferences, context.profileDir)
        if (state.revision !== input.expectedRevision) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "revision-mismatch")
        validateOperation(state, changes)
        const key = state.key ?? PLACEHOLDER_KEY
        const catalog = await loadLiveCatalog(context, key)
        const plan = planFor(context, state, catalog, key, changes)
        const binding = bindingOf(state, catalog, changes, plan)
        const previewToken = issuePreviewToken(context.newsPreferences, state.key, context.now(), binding)
        const reconciled = state.parsed === null ? null : reconcile(state.parsed.metadata, catalog, state.profileBinding === "verified")
        const echo = JSON.stringify(changes).length <= NORMALIZED_ECHO_MAX ? changes : null
        const base = {
            operation: changes.operation,
            expectedRevision: input.expectedRevision,
            profileBinding: state.profileBinding,
            catalogRevision: catalog.revision,
            previewToken,
            normalizedChanges: echo,
            wouldApply: plan.changed,
            resultRevision: binding.resultRevision,
            summary: {
                entries: plan.entries.length,
                catalogGroups: catalog.groups.length,
                catalogSources: catalog.sources.length,
                unresolvedSections: reconciled === null ? 0 : [...reconciled.groups, ...reconciled.sources].filter((section) => !section.applied).length,
            },
            warnings: [...changeWarnings(changes), ...(state.key === null ? ["identityKeyCreatedOnApply"] : [])],
            contentTrust: CONTENT_TRUST,
            limits: PREVIEW_LIMITS,
        }
        const entries = plan.entries.map(planEntryForClient)
        const basis = basisOf(binding.planDigest, input.expectedRevision)
        const build = (items: typeof entries, hasMore: boolean, nextCursor: string | null) => ({ ...base, plan: items, hasMore, nextCursor })
        const shrink = (entry: (typeof entries)[number]): (typeof entries)[number] => ({ ...entry, before: null, after: null, textOmitted: true })
        const page = pageOf(entries, decodeCursor(input.cursor, "preview", basis), "preview", basis, build, shrink)
        return successResult(build(page.items, page.hasMore, page.nextCursor)).result
    })
}

export async function applyNewsPreferencesChange(context: ToolContext, args: unknown) {
    requireEnabled(context)
    const input = parseArgs(applyNewsPreferencesChangeInput, args)
    const changes = normalizeChanges(input.changes)
    return context.cursors.exclusive(async () => {
        const settings = context.newsPreferences
        const before = readPreferenceState(settings, context.profileDir)
        if (before.revision !== input.expectedRevision) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "revision-mismatch")
        validateOperation(before, changes)
        const provisionalKey = before.key ?? PLACEHOLDER_KEY
        const catalogBefore = await loadLiveCatalog(context, provisionalKey)
        // A plan that cannot be written, or a token that does not match it, stops here: no key, backup or temporary file exists yet.
        const planBefore = planFor(context, before, catalogBefore, provisionalKey, changes)
        verifyPreviewToken(settings, before.key, input.previewToken, context.now(), bindingOf(before, catalogBefore, changes, planBefore))

        let plan = planBefore
        if (before.key === null) {
            const key = ensureIdentityKey(settings, context.profileDir, context.now())
            const state = readPreferenceState(settings, context.profileDir)
            if (state.revision !== input.expectedRevision) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "revision-mismatch")
            const catalog = await loadLiveCatalog(context, key)
            if (catalog.revision !== catalogBefore.revision) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "catalog-changed")
            plan = planFor(context, state, catalog, key, changes)
            if (digestOf(plan.entries) !== digestOf(planBefore.entries)) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "catalog-changed")
        }

        const committed = await commitPreferences(settings, context.profileDir, input.expectedRevision, plan.next, context.now())
        settings.usedTokens.add(input.previewToken)
        let verified = false
        try {
            verified = readPreferenceState(settings, context.profileDir).profileBinding === "verified"
        } catch {
            verified = false
        }
        if (!verified) throw new FrMcpError("PREFERENCES_WRITE_UNVERIFIED", "profile-binding")
        return successResult({
            operation: changes.operation,
            applied: committed.applied,
            previousRevision: committed.previousRevision,
            revision: committed.revision,
            profileBinding: "verified",
            backup: committed.backup === null ? null : { location: `${storageLocation(context.profileDir)}\\backups`, name: committed.backup },
            sectionsChanged: [...new Set(plan.entries.map((entry) => [entry.sectionId ?? entry.scope, entry.field].filter((part) => part !== null).join(":")))],
            warnings: changeWarnings(changes),
            consentLimitation: CONSENT_LIMITATION,
        }).result
    })
}
