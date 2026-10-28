/**
 * Group membership and rule counts derived from the validated settings
 * (FR-MCP-01 §7, §8.4). Nothing is repaired: the settings are read as stored.
 *
 * Fluent Reader semantics mirrored here:
 *  - `sourceGroups` is an ordered array of user groups (`isMultiple: true`)
 *    and single-source entries (`isMultiple: false`), which are not groups.
 *  - The group of a source is the FIRST `isMultiple` entry whose `sids`
 *    contains it (`getRulesForTarget` in the fork's rule.ts). Later
 *    occurrences of the same sid do not make it a member of other groups.
 *  - A gid carried by more than one entry is ambiguous: filtering by it fails
 *    closed (GROUP_AMBIGUOUS), as the fork's cleanup and retro-rules code do.
 *  - sids in the settings that no longer exist in the database (orphans) are
 *    simply never matched by a database row.
 *  - A negative gid is not a group identity the app keeps: on load the fork
 *    replaces it with a newly allocated gid (`get-groups` in the fork's
 *    main/settings.ts), unknown here. A source whose first group has one is
 *    reported as `groupId: null, groupStatus: "unavailable"`, never as
 *    ungrouped and never under a later group; the public groupId stays >= 0.
 */

import crypto from "node:crypto"
import { FrMcpError, toSafeError, type ErrorCode } from "../errors.js"
import type { SettingsSnapshot, SourceGroupEntry, StoredRuleEntry } from "../settings/read-settings.js"

export type GroupStatus = "grouped" | "ungrouped" | "ambiguous" | "unavailable"

export interface SourceGroupInfo {
    readonly groupId: number | null
    readonly groupStatus: GroupStatus
}

export interface RuleCounts {
    readonly available: boolean
    readonly sourceRuleCount: number | null
    readonly groupRuleCount: number | null
}

export interface GroupMembers {
    readonly groupId: number
    /** Member sids (this group is their first group), ascending, without duplicates. */
    readonly sids: readonly number[]
    /** Fingerprint of the membership, to detect changes between pages. */
    readonly revision: string
}

type Availability<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: ErrorCode }

export class GroupIndex {
    readonly #groups: Availability<readonly SourceGroupEntry[]>
    readonly #rules: Availability<ReadonlyMap<string, readonly StoredRuleEntry[]>>
    /** sid → index of its first isMultiple entry. */
    readonly #owner = new Map<number, number>()
    /** gid → number of entries (of any kind) carrying it. */
    readonly #gidCount = new Map<number, number>()
    /** Number of isMultiple entries with a negative gid. */
    #negativeGroupIds = 0

    private constructor(
        groups: Availability<readonly SourceGroupEntry[]>,
        rules: Availability<ReadonlyMap<string, readonly StoredRuleEntry[]>>,
    ) {
        this.#groups = groups
        this.#rules = rules
        if (!groups.ok) return
        groups.value.forEach((entry, index) => {
            this.#gidCount.set(entry.gid, (this.#gidCount.get(entry.gid) ?? 0) + 1)
            if (!entry.isMultiple) return
            if (entry.gid < 0) this.#negativeGroupIds++
            for (const sid of entry.sids) {
                if (!this.#owner.has(sid)) this.#owner.set(sid, index)
            }
        })
    }

    static fromSnapshot(snapshot: SettingsSnapshot): GroupIndex {
        const groups = snapshot.sourceGroups
        const rules = snapshot.sourceRules
        return new GroupIndex(
            groups.ok ? { ok: true, value: groups.value } : { ok: false, code: groups.code },
            rules.ok ? { ok: true, value: rules.value } : { ok: false, code: rules.code },
        )
    }

    /** Settings that could not be read at all: groups and rules unavailable. */
    static unavailable(error: unknown): GroupIndex {
        const code = toSafeError(error).code
        return new GroupIndex({ ok: false, code }, { ok: false, code })
    }

    get groupsAvailable(): boolean {
        return this.#groups.ok
    }

    /** Error code explaining why groups are unavailable, or null. */
    get groupsError(): ErrorCode | null {
        return this.#groups.ok ? null : this.#groups.code
    }

    /** Number of groups (isMultiple entries) whose gid is negative, for diagnostics. */
    get negativeGroupIds(): number {
        return this.#negativeGroupIds
    }

    #ownerEntry(sid: number): SourceGroupEntry | undefined {
        if (!this.#groups.ok) return undefined
        const index = this.#owner.get(sid)
        return index === undefined ? undefined : this.#groups.value[index]
    }

    groupOf(sid: number): SourceGroupInfo {
        if (!this.#groups.ok) return { groupId: null, groupStatus: "unavailable" }
        const owner = this.#ownerEntry(sid)
        if (owner === undefined) return { groupId: null, groupStatus: "ungrouped" }
        if (owner.gid < 0) return { groupId: null, groupStatus: "unavailable" }
        return { groupId: owner.gid, groupStatus: (this.#gidCount.get(owner.gid) ?? 0) > 1 ? "ambiguous" : "grouped" }
    }

    /**
     * Sources whose first group is `gid`. NOT_FOUND if no entry has the gid
     * or it is a single-source entry; GROUP_AMBIGUOUS if several entries have
     * it; the settings error if groups are unavailable. A negative gid is not
     * a public group id (the input schema already rejects it): INVALID_ARGUMENT.
     */
    members(gid: number): GroupMembers {
        const { index, entry } = this.locate(gid)
        const sids = [...new Set(entry.sids)].filter((sid) => this.#owner.get(sid) === index).sort((a, b) => a - b)
        const revision = crypto.createHash("sha256").update(JSON.stringify([gid, sids])).digest("base64url")
        return { groupId: gid, sids, revision }
    }

    /**
     * The entry of group `gid` and its position in sourceGroups, with the
     * errors of members().
     */
    locate(gid: number): { readonly index: number; readonly entry: SourceGroupEntry } {
        if (!Number.isSafeInteger(gid) || gid < 0) throw new FrMcpError("INVALID_ARGUMENT", "invalid-argument")
        const entries = this.entries()
        const count = this.#gidCount.get(gid) ?? 0
        if (count === 0) throw new FrMcpError("NOT_FOUND", "group-not-found")
        if (count > 1) throw new FrMcpError("GROUP_AMBIGUOUS", "duplicate-gid")
        const index = entries.findIndex((entry) => entry.gid === gid)
        const entry = entries[index] as SourceGroupEntry
        if (!entry.isMultiple) throw new FrMcpError("NOT_FOUND", "not-a-group")
        return { index, entry }
    }

    /** The validated sourceGroups array, as stored; the settings error if unavailable. */
    entries(): readonly SourceGroupEntry[] {
        if (!this.#groups.ok) throw new FrMcpError(this.#groups.code)
        return this.#groups.value
    }

    /** Position of the first isMultiple entry containing `sid` (its group for the rules), if any. */
    ownerIndex(sid: number): number | undefined {
        return this.#owner.get(sid)
    }

    /** Number of entries (of any kind) carrying `gid`. */
    gidCount(gid: number): number {
        return this.#gidCount.get(gid) ?? 0
    }

    /** Stored rules under `group:<gid>`; null when sourceRules is unavailable. */
    groupRuleCount(gid: number): number | null {
        return this.#rules.ok ? (this.#rules.value.get(`group:${gid}`)?.length ?? 0) : null
    }

    /** Error code explaining why rules are unavailable, or null. */
    get rulesError(): ErrorCode | null {
        return this.#rules.ok ? null : this.#rules.code
    }

    /** The validated sourceRules, key → rules as stored; the settings error if unavailable. */
    rules(): ReadonlyMap<string, readonly StoredRuleEntry[]> {
        if (!this.#rules.ok) throw new FrMcpError(this.#rules.code)
        return this.#rules.value
    }

    /** Number of stored rules for the source and for its group (rule keys `source:<sid>`, `group:<gid>`). */
    ruleCounts(sid: number): RuleCounts {
        if (!this.#rules.ok) return { available: false, sourceRuleCount: null, groupRuleCount: null }
        const rules = this.#rules.value
        const group = this.groupOf(sid)
        return {
            available: true,
            sourceRuleCount: rules.get(`source:${sid}`)?.length ?? 0,
            groupRuleCount: group.groupId === null ? null : (rules.get(`group:${group.groupId}`)?.length ?? 0),
        }
    }
}
