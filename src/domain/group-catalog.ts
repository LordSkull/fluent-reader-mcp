/**
 * Read-only views of sourceGroups for list_groups and get_group
 * (FR-MCP-01 §7, §14.3, §14.4): revision, integrity analysis and the bounded
 * database reads they need. Nothing is repaired: duplicates, orphans, negative
 * ids and the stored order are reported as found (the fork repairs some of
 * them on load and rewrites config.json; this server never does).
 *
 * Membership semantics are those of GroupIndex: the group of a source, for
 * the rules, is the first isMultiple entry containing it (`getRulesForTarget`
 * in the fork's rule.ts); single entries (`isMultiple: false`) are not groups.
 *
 * Identifiers in samples: schema fields hold safe integers >= 0 only. Negative
 * gids and sids are counted, never listed.
 */

import crypto from "node:crypto"
import { FrMcpError } from "../errors.js"
import type { ReadOnlyDatabase } from "../db/connection.js"
import type { SourceGroupEntry } from "../settings/read-settings.js"
import type { GroupIndex } from "./groups.js"
import { readSidBounds } from "./sources.js"

/** Maximum identifiers listed in one sample (counts are always complete). */
export const SAMPLE_MAX = 20
/** list_groups: sources whose ids are read to check orphans, ungrouped sources and existing members. */
export const DB_SCAN_MAX = 10_000
/** get_group: distinct members looked up to count the group's orphans. */
export const MEMBER_CHECK_MAX = 10_000
/** Ids per point-lookup statement. */
export const LOOKUP_CHUNK = 500

const MAX_SAFE = String(Number.MAX_SAFE_INTEGER)

/** Static SQL of this module: ids only (rowid), never a record payload. */
export const GROUP_SQL = {
    sidScan: `SELECT sid FROM sources WHERE sid BETWEEN 0 AND ${MAX_SAFE} ORDER BY sid LIMIT ?`,
    existing: `SELECT sid FROM sources WHERE sid IN (SELECT value FROM json_each(?))`,
} as const

export interface IdSample {
    /** Exact number of distinct ids (negative ones included). */
    readonly count: number
    /** The smallest non-negative ids, ascending, at most SAMPLE_MAX. */
    readonly sample: number[]
}

export function idSample(ids: Iterable<number>): IdSample {
    let count = 0
    const valid: number[] = []
    for (const id of ids) {
        count++
        if (id >= 0) valid.push(id)
    }
    return { count, sample: valid.sort((a, b) => a - b).slice(0, SAMPLE_MAX) }
}

/**
 * Revision of the group configuration: SHA-256 (128 bits) of the canonical
 * JSON of every entry in stored order, [gid, isMultiple, name, sids]. Not
 * included: `expanded` (sidebar state) and every other settings key. Equal
 * configurations give the same revision, also across restarts.
 */
export function groupsRevision(entries: readonly SourceGroupEntry[]): string {
    const hash = crypto.createHash("sha256")
    for (const entry of entries) {
        // A JSON text never contains a raw newline: the separator is unambiguous.
        hash.update(JSON.stringify([entry.gid, entry.isMultiple, entry.name ?? null, entry.sids])).update("\n")
    }
    return `gr1.${hash.digest().subarray(0, 16).toString("base64url")}`
}

export type IdStatus = "unique" | "ambiguous" | "invalid"

/** Status of a group's gid: negative (invalid, not exposed), carried by several entries, or unique. */
export function idStatus(groups: GroupIndex, entry: SourceGroupEntry): IdStatus {
    if (entry.gid < 0) return "invalid"
    return groups.gidCount(entry.gid) > 1 ? "ambiguous" : "unique"
}

export type DatabaseCheck = "complete" | "tooManySources" | "sourceIdsOutOfRange"

export interface DatabaseSids {
    readonly check: DatabaseCheck
    /** Every sid of the table when check is "complete", otherwise null. */
    readonly sids: ReadonlySet<number> | null
}

/**
 * All source ids, if the table holds at most DB_SCAN_MAX sources with ids in
 * [0, 2^53−1]: two primary-key lookups (bounds), then a primary-key range read
 * of ids only, LIMIT DB_SCAN_MAX + 1. Never a COUNT or a read of `items`.
 */
export function readDatabaseSids(db: ReadOnlyDatabase): DatabaseSids {
    try {
        readSidBounds(db)
    } catch (error) {
        if (error instanceof FrMcpError && error.code === "ID_RANGE_UNSUPPORTED") return { check: "sourceIdsOutOfRange", sids: null }
        throw error
    }
    const rows = db.prepare(GROUP_SQL.sidScan).all(DB_SCAN_MAX + 1) as { sid: number }[]
    if (rows.length > DB_SCAN_MAX) return { check: "tooManySources", sids: null }
    return { check: "complete", sids: new Set(rows.map((row) => row.sid)) }
}

/** Which of `sids` (safe integers) exist: primary-key lookups in chunks of LOOKUP_CHUNK. */
export function readExistingSids(db: ReadOnlyDatabase, sids: readonly number[]): Set<number> {
    const found = new Set<number>()
    const statement = db.prepare(GROUP_SQL.existing)
    for (let i = 0; i < sids.length; i += LOOKUP_CHUNK) {
        const rows = statement.all(JSON.stringify(sids.slice(i, i + LOOKUP_CHUNK))) as { sid: number }[]
        for (const row of rows) found.add(row.sid)
    }
    return found
}

/** Global integrity of sourceGroups (list_groups). */
export interface GroupsIntegrity {
    entryCount: number
    groupCount: number
    singleEntryCount: number
    emptyGroupCount: number
    /** Single entries whose sids are not exactly one source (the app creates them with one). */
    nonStandardSingleEntryCount: number
    /** gids >= 0 carried by several entries, at least one of them a group: GROUP_AMBIGUOUS. */
    duplicateGroupIds: IdSample
    /** gids >= 0 carried by several single entries only (no group affected). */
    duplicateSingleEntryIds: IdSample
    /** Entries with a negative gid: never exposed as an id; group positions listed instead. */
    negativeGroupIds: { groupCount: number; singleEntryCount: number; groupPositions: number[] }
    /** Sources listed in two or more groups: only the first one counts for the rules. */
    sourcesInMultipleGroups: IdSample
    /** Sources listed both in a group and in a single entry. */
    sourcesInGroupAndSingleEntry: IdSample
    /** Sources repeated inside one entry. */
    repeatedMemberships: IdSample
    /** Distinct configured sids below 0 (never valid source ids). */
    negativeSourceIdCount: number
    /** Whether the database part below was computed, or why not. */
    databaseCheck: DatabaseCheck
    /** Configured sids >= 0 (any entry) with no source in the database; null unless databaseCheck is "complete". */
    orphanSourceIds: IdSample | null
    /** Sources of the database in no group (single entries do not count); null unless databaseCheck is "complete". */
    ungroupedSources: IdSample | null
}

/** Exact analysis of the validated array (bounded by the settings limits), plus the database part when available. */
export function analyzeGroups(groups: GroupIndex, entries: readonly SourceGroupEntry[], db: DatabaseSids): GroupsIntegrity {
    const gidKinds = new Map<number, { groups: number; singles: number }>()
    const sidKinds = new Map<number, { groups: number; singles: number }>()
    const repeated = new Set<number>()
    const negativePositions: number[] = []
    let groupCount = 0
    let emptyGroupCount = 0
    let nonStandardSingleEntryCount = 0
    let negativeSingles = 0
    entries.forEach((entry, position) => {
        const gid = gidKinds.get(entry.gid) ?? { groups: 0, singles: 0 }
        gidKinds.set(entry.gid, gid)
        if (entry.isMultiple) {
            gid.groups++
            groupCount++
            if (entry.sids.length === 0) emptyGroupCount++
            if (entry.gid < 0) negativePositions.push(position)
        } else {
            gid.singles++
            if (entry.sids.length !== 1) nonStandardSingleEntryCount++
            if (entry.gid < 0) negativeSingles++
        }
        const distinct = new Set(entry.sids)
        if (distinct.size !== entry.sids.length) {
            const seen = new Set<number>()
            for (const sid of entry.sids) {
                if (seen.has(sid)) repeated.add(sid)
                seen.add(sid)
            }
        }
        for (const sid of distinct) {
            const kinds = sidKinds.get(sid) ?? { groups: 0, singles: 0 }
            sidKinds.set(sid, kinds)
            if (entry.isMultiple) kinds.groups++
            else kinds.singles++
        }
    })
    const select = <K>(map: Map<number, K>, predicate: (value: K, id: number) => boolean): number[] =>
        [...map].filter(([id, value]) => predicate(value, id)).map(([id]) => id)

    let orphanSourceIds: IdSample | null = null
    let ungroupedSources: IdSample | null = null
    if (db.sids !== null) {
        const present = db.sids
        orphanSourceIds = idSample(select(sidKinds, (_, sid) => sid >= 0 && !present.has(sid)))
        ungroupedSources = idSample([...present].filter((sid) => groups.ownerIndex(sid) === undefined))
    }
    return {
        entryCount: entries.length,
        groupCount,
        singleEntryCount: entries.length - groupCount,
        emptyGroupCount,
        nonStandardSingleEntryCount,
        duplicateGroupIds: idSample(select(gidKinds, (k, gid) => gid >= 0 && k.groups >= 1 && k.groups + k.singles > 1)),
        duplicateSingleEntryIds: idSample(select(gidKinds, (k, gid) => gid >= 0 && k.groups === 0 && k.singles > 1)),
        negativeGroupIds: {
            groupCount: negativePositions.length,
            singleEntryCount: negativeSingles,
            groupPositions: negativePositions.slice(0, SAMPLE_MAX),
        },
        sourcesInMultipleGroups: idSample(select(sidKinds, (k) => k.groups > 1)),
        sourcesInGroupAndSingleEntry: idSample(select(sidKinds, (k) => k.groups >= 1 && k.singles >= 1)),
        repeatedMemberships: idSample(repeated),
        negativeSourceIdCount: select(sidKinds, (_, sid) => sid < 0).length,
        databaseCheck: db.check,
        orphanSourceIds,
        ungroupedSources,
    }
}

/** Integrity of one group's members (get_group). */
export interface MemberIntegrity {
    /** Sources repeated in this group's sids. */
    repeatedMemberships: IdSample
    /** Members whose first group is an earlier entry: listed here, but that group's rules apply. */
    sourcesInEarlierGroups: IdSample
    /** Members also listed in a single entry. */
    sourcesInSingleEntries: IdSample
    /** Distinct member sids below 0 (never valid source ids, not looked up). */
    negativeSourceIdCount: number
    /** "complete" when every distinct member was looked up; "tooManyMembers" over MEMBER_CHECK_MAX. */
    membersCheck: "complete" | "tooManyMembers"
    /** Member sids >= 0 with no source in the database; null unless membersCheck is "complete". */
    orphanSourceIds: IdSample | null
}

/** Distinct member sids >= 0 of a group, in stored order. */
export function distinctValidMembers(entry: SourceGroupEntry): number[] {
    return [...new Set(entry.sids)].filter((sid) => sid >= 0)
}

export function analyzeMembers(
    groups: GroupIndex,
    position: number,
    entry: SourceGroupEntry,
    existing: ReadonlySet<number> | null,
): MemberIntegrity {
    const inSingles = new Set<number>()
    const members = new Set(entry.sids)
    for (const other of groups.entries()) {
        if (other.isMultiple) continue
        for (const sid of other.sids) if (members.has(sid)) inSingles.add(sid)
    }
    const seen = new Set<number>()
    const repeated = new Set<number>()
    for (const sid of entry.sids) {
        if (seen.has(sid)) repeated.add(sid)
        seen.add(sid)
    }
    const distinct = [...members]
    return {
        repeatedMemberships: idSample(repeated),
        sourcesInEarlierGroups: idSample(distinct.filter((sid) => groups.ownerIndex(sid) !== position)),
        sourcesInSingleEntries: idSample(inSingles),
        negativeSourceIdCount: distinct.filter((sid) => sid < 0).length,
        membersCheck: existing === null ? "tooManyMembers" : "complete",
        orphanSourceIds: existing === null ? null : idSample(distinct.filter((sid) => sid >= 0 && !existing.has(sid))),
    }
}
