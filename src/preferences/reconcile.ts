/**
 * Whether a stored section still describes something in Fluent Reader,
 * computed from live data on every call and never stored. A preference applies
 * only when its identity is proven; everything else keeps its text and waits
 * for an explicit decision.
 *
 * Sources: the keyed fingerprint of the feed URL is the identity. The sid is
 * only a hint, because Fluent Reader reuses it. `sources.url` is unique, so the
 * same fingerprint on another single sid is the same feed.
 *
 * Groups: gid and keyed name must both match. The gid alone proves nothing
 * after an import, so a different name waits for confirmation.
 */

import type { CatalogGroup, CatalogSource, LiveCatalog } from "./catalog.js"
import type { DocumentMetadata, GroupMetadata, SourceMetadata } from "./markdown.js"

export type SectionStatus =
    | "active"
    | "relocated"
    | "identityChanged"
    | "renamePending"
    | "relinkCandidate"
    | "orphaned"
    | "ambiguous"
    | "unverifiable"
    | "unverified"

export interface ReconciledGroup {
    readonly entry: GroupMetadata
    readonly status: SectionStatus
    readonly applied: boolean
    readonly live: CatalogGroup | null
    readonly candidates: readonly CatalogGroup[]
}

export interface ReconciledSource {
    readonly entry: SourceMetadata
    readonly status: SectionStatus
    readonly applied: boolean
    readonly live: CatalogSource | null
    readonly candidates: readonly CatalogSource[]
}

export interface Reconciled {
    readonly groups: readonly ReconciledGroup[]
    readonly sources: readonly ReconciledSource[]
    /** Null when the catalog could not be read. */
    readonly drift: boolean | null
}

/** The same conditions rebind_section checks: a candidate that is ambiguous or already taken cannot be chosen. */
export function groupCandidateRebindable(section: ReconciledGroup, candidate: CatalogGroup, all: readonly ReconciledGroup[]): boolean {
    return candidate.status === "active" && candidate.binding !== null && !all.some((other) => other.entry.id !== section.entry.id && other.entry.groupId === candidate.groupId)
}

export function sourceCandidateRebindable(section: ReconciledSource, candidate: CatalogSource, all: readonly ReconciledSource[]): boolean {
    return candidate.binding !== null && !all.some((other) => other.entry.id !== section.entry.id && other.entry.binding === candidate.binding)
}

function indexBy<T, K>(items: readonly T[], key: (item: T) => K | null): Map<K, T[]> {
    const map = new Map<K, T[]>()
    for (const item of items) {
        const k = key(item)
        if (k === null) continue
        const list = map.get(k)
        if (list === undefined) map.set(k, [item])
        else list.push(item)
    }
    return map
}

function group(entry: GroupMetadata, catalog: LiveCatalog | null, verified: boolean, stored: ReadonlyMap<number, GroupMetadata[]>, byId: ReadonlyMap<number, CatalogGroup[]>, byBinding: ReadonlyMap<string, CatalogGroup[]>): ReconciledGroup {
    const result = (status: SectionStatus, live: CatalogGroup | null = null, candidates: readonly CatalogGroup[] = []): ReconciledGroup => ({ entry, status, applied: status === "active", live, candidates })
    if (!verified) return result("unverified")
    if (catalog === null) return result("unverifiable")
    if (entry.binding === null) return result("orphaned")
    if (entry.groupId !== null && (stored.get(entry.groupId)?.length ?? 0) > 1) return result("ambiguous")
    const live = entry.groupId === null ? [] : (byId.get(entry.groupId) ?? [])
    if (live.length > 1) return result("ambiguous", null, live)
    const current = live[0]
    if (current !== undefined) return current.binding === entry.binding ? result("active", current) : result("renamePending", current, [current])
    const sameName = (byBinding.get(entry.binding) ?? []).filter((candidate) => candidate.status === "active")
    if (sameName.length === 1) return result("relinkCandidate", null, sameName)
    return sameName.length > 1 ? result("ambiguous", null, sameName) : result("orphaned")
}

function source(entry: SourceMetadata, catalog: LiveCatalog | null, verified: boolean, stored: ReadonlyMap<string, SourceMetadata[]>, bySid: ReadonlyMap<number, CatalogSource>, byBinding: ReadonlyMap<string, CatalogSource[]>): ReconciledSource {
    const result = (status: SectionStatus, live: CatalogSource | null = null, candidates: readonly CatalogSource[] = []): ReconciledSource => ({ entry, status, applied: status === "active" || status === "relocated", live, candidates })
    if (!verified) return result("unverified")
    if (catalog === null) return result("unverifiable")
    if (entry.binding === null) return result("orphaned")
    if ((stored.get(entry.binding)?.length ?? 0) > 1) return result("ambiguous")
    const matches = byBinding.get(entry.binding) ?? []
    const atSid = entry.sourceId === null ? undefined : bySid.get(entry.sourceId)
    if (atSid !== undefined && atSid.binding === entry.binding) return result("active", atSid)
    const only = matches[0]
    if (only !== undefined && matches.length === 1) return result("relocated", only)
    if (matches.length > 1) return result("ambiguous", null, matches)
    if (atSid === undefined) return result("orphaned")
    return atSid.binding === null ? result("unverifiable", null, [atSid]) : result("identityChanged", null, [atSid])
}

export function reconcile(metadata: DocumentMetadata, catalog: LiveCatalog | null, verified: boolean): Reconciled {
    const storedGroups = indexBy(metadata.groups, (entry) => entry.groupId)
    const storedSources = indexBy(metadata.sources, (entry) => entry.binding)
    const groupsById = indexBy(catalog?.groups ?? [], (entry) => entry.groupId)
    const groupsByBinding = indexBy(catalog?.groups ?? [], (entry) => entry.binding)
    const sourcesBySid = new Map((catalog?.sources ?? []).map((entry) => [entry.sourceId, entry]))
    const sourcesByBinding = indexBy(catalog?.sources ?? [], (entry) => entry.binding)
    const groups = metadata.groups.map((entry) => group(entry, catalog, verified, storedGroups, groupsById, groupsByBinding))
    const sources = metadata.sources.map((entry) => source(entry, catalog, verified, storedSources, sourcesBySid, sourcesByBinding))
    const drift = catalog === null || !verified
        ? null
        : groups.some((g) => g.status !== "active" || g.live?.name !== g.entry.name) || sources.some((s) => s.status !== "active" || s.live?.name !== s.entry.name)
    return { groups, sources, drift }
}
