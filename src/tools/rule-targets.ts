/**
 * Targets of the rule tools: the existence and display name of a source or
 * group, read with the approved helpers (S1/S2 record limit for sources,
 * GroupIndex for groups). A source id that exists now is not a durable
 * identity: sourceRef is the way to detect a reused id.
 */

import { readCandidate, readSourceRows, RECORD_BYTES_MAX, SourceRecord } from "../domain/sources.js"
import type { GroupIndex } from "../domain/groups.js"
import type { ReadOnlyDatabase } from "../db/connection.js"

export interface SourceTarget {
    readonly exists: boolean
    readonly name: string | null
    /** Validated feed URL, for sourceRef only; null when absent, invalid or not read. */
    readonly url: string | null
    /** The record is over RECORD_BYTES_MAX: name and URL were not read. */
    readonly tooLarge: boolean
}

/** Point lookups on the primary key (S1, then S2 when the record is within the limit). */
export function readSourceTarget(db: ReadOnlyDatabase, sid: number): SourceTarget {
    const candidate = readCandidate(db, sid)
    if (candidate === undefined) return { exists: false, name: null, url: null, tooLarge: false }
    if (candidate.bytes > RECORD_BYTES_MAX) return { exists: true, name: null, url: null, tooLarge: true }
    const row = readSourceRows(db, [sid]).get(sid)
    if (row === undefined) return { exists: false, name: null, url: null, tooLarge: false }
    const record = new SourceRecord(row)
    return { exists: true, name: record.name(), url: record.url(), tooLarge: false }
}

export type GroupTargetStatus = "exists" | "absent" | "ambiguous" | "singleEntry" | "unavailable"

/** Status of `group:<gid>` as a rule target; the name only for a unique multiple group. */
export function groupTarget(groups: GroupIndex, gid: number): { status: GroupTargetStatus; exists: boolean | null; name: string | null } {
    if (!groups.groupsAvailable) return { status: "unavailable", exists: null, name: null }
    const count = groups.gidCount(gid)
    if (count === 0) return { status: "absent", exists: false, name: null }
    if (count > 1) return { status: "ambiguous", exists: null, name: null }
    const entry = groups.entries().find((e) => e.gid === gid)
    if (entry?.isMultiple !== true) return { status: "singleEntry", exists: false, name: null }
    return { status: "exists", exists: true, name: entry.name ?? null }
}
