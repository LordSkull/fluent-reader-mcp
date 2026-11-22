/**
 * Grouping of copies (contract fluent-reader/cross-source-duplicates v1,
 * section 8, "Other orders") for a scan in the MCP's "stored" order,
 * descending `_id`, one article at a time.
 *
 * Streaming first-fit. Articles arrive in stored order; for an eligible
 * article A (identity fingerprint F, time t, source s):
 *  - A joins the EARLIEST remembered group with fingerprint F (the one whose
 *    representative came first in stored order) that has no article of
 *    source s and whose earliest and latest times, A included, stay at most
 *    MAX_DATE_DIFFERENCE_MS apart;
 *  - otherwise A is a representative: it opens a new group.
 * Consequences: a group holds at most one article per source and spans at
 * most 10 minutes, so its members are pairwise copies (contract section 7);
 * the representative is the member with the highest `_id`; and the result is
 * prefix-stable: articles examined later never change a group already formed,
 * they can only join one. That is what lets a chain of cursors return a
 * representative on one page and its copies on later pages.
 * Fed in Fluent Reader's feed order (descending time, then descending id),
 * the same rule gives exactly the contract's groups (verified by the tests on
 * conformance.json); in stored order the groups may differ, as the contract
 * allows, while the pairs never do.
 *
 * Bounded memory. A group is kept as its representative id, the identity
 * fingerprint (a keyed SHA-256 of the identity key, never a title, snippet,
 * link or GUID), its earliest and latest times and its sources. Limits:
 * groupsMax groups, membersMax member sources over all groups, keyGroupsMax
 * groups per fingerprint. When a limit is exceeded, whole groups are
 * forgotten, oldest first (in stored order, the farthest from the scan
 * position), and counted in `forgotten`; a later copy of a forgotten group
 * can no longer be recognized and is returned as an article of its own. No
 * probabilistic structure is used: a remembered group is matched exactly (up
 * to SHA-256 collisions), and forgetting never hides an article.
 *
 * Cost. Membership of a source in a group is O(1): a group's sources are a
 * short array, indexed by a Map once it holds more than INDEX_FROM sources.
 * fork() gives the memory of the next page without copying any source: the
 * two memories share every group (structural sharing) and each one copies on
 * write what it changes. A fork costs O(groups) (two Map copies, at most
 * groupsMax entries each), never O(members); a page then pays O(1) per
 * article, amortized. Neither memory can observe a change made through the
 * other (see Group).
 */

import { MAX_DATE_DIFFERENCE_MS } from "../domain/duplicates.js"

export interface DuplicateMemoryLimits {
    /** Groups remembered (each one is a news item returned, whose later copies can still be recognized). */
    readonly groupsMax: number
    /** Member sources over all remembered groups (each group has at least one: its representative's). */
    readonly membersMax: number
    /** Groups remembered with the same fingerprint (only reached by the same text republished many times). */
    readonly keyGroupsMax: number
}

/**
 * Estimated bytes of a remembered group without its members, and of one
 * member, for the cursor memory budget (scan/cursors.ts). Conservative
 * estimates of the V8 heap, not exact measures. On Node.js 24
 * (test/bench/group-duplicates.bench.ts): 2048 groups of 4 sources about
 * 0.93 MB (estimated 1.18 MB), 2048 groups of one source about 0.61 MB
 * (0.88 MB), one group of 8192 sources about 0.31 MB (0.39 MB).
 */
export const GROUP_WEIGHT = 384
export const MEMBER_WEIGHT = 48

/** A group's sources are scanned linearly up to this many, then indexed. */
const INDEX_FROM = 8

/**
 * One version of a group. Its sources are the prefix items[0, members) of an
 * append-only array shared by every version of the group across forks, with
 * the index (source → position) built once the array holds more than
 * INDEX_FROM sources and shared the same way. Only the version whose prefix
 * is the whole array (its tip) appends in place; any other version, whose
 * prefix another memory has extended since, first copies its prefix (and
 * index) to arrays of its own. A version therefore never sees a source added
 * through another memory: positions past its prefix, in the index too, are
 * invisible to it. A version is mutable only by the memory whose generation
 * it carries (`owner`); any other memory copies it on write.
 */
interface Group {
    readonly representativeId: number
    readonly fingerprint: string
    minTime: number
    maxTime: number
    members: number
    items: number[]
    index: Map<number, number> | null
    readonly owner: number
}

/** Representatives of one fingerprint, in creation order, when there are several (one is kept as a bare id). Owned as Group. */
interface KeyGroups {
    readonly ids: number[]
    readonly owner: number
}

export interface RememberedGroup {
    readonly representativeId: number
    readonly fingerprint: string
    readonly minTime: number
    readonly maxTime: number
    /** Member sources of the group, its representative's included. */
    readonly members: number
}

let generations = 0

function indexOf(items: readonly number[]): Map<number, number> | null {
    if (items.length <= INDEX_FROM) return null
    const index = new Map<number, number>()
    for (let i = 0; i < items.length; i++) index.set(items[i] as number, i)
    return index
}

function hasSource(g: Group, source: number): boolean {
    if (g.index !== null) {
        const at = g.index.get(source)
        return at !== undefined && at < g.members
    }
    for (let i = 0; i < g.members; i++) if (g.items[i] === source) return true
    return false
}

/** Appends a source to a version owned by the caller. */
function addSource(g: Group, source: number): void {
    if (g.items.length !== g.members) {
        g.items = g.items.slice(0, g.members)
        g.index = indexOf(g.items)
    }
    g.items.push(source)
    if (g.index !== null) g.index.set(source, g.items.length - 1)
    else if (g.items.length > INDEX_FROM) g.index = indexOf(g.items)
    g.members++
}

const idsOf = (keyed: number | KeyGroups): readonly number[] => (typeof keyed === "number" ? [keyed] : keyed.ids)

export class DuplicateMemory {
    readonly limits: DuplicateMemoryLimits
    /** Representative id → current version of its group, in creation order (oldest first). */
    #groups = new Map<number, Group>()
    /** Fingerprint → its representative, or its representatives in creation order. */
    #byKey = new Map<string, number | KeyGroups>()
    #members = 0
    #forgotten = 0
    /** Versions and key lists carrying this generation are owned by this memory only. */
    #generation = ++generations

    constructor(limits: DuplicateMemoryLimits) {
        if (!(limits.groupsMax >= 1 && limits.membersMax >= limits.groupsMax && limits.keyGroupsMax >= 1)) throw new RangeError("duplicate memory limits")
        this.limits = limits
    }

    /** Groups remembered. */
    get size(): number {
        return this.#groups.size
    }

    /** Member sources remembered over all groups. */
    get members(): number {
        return this.#members
    }

    /** Groups forgotten because of a limit since the memory was created (cumulative across forks). */
    get forgotten(): number {
        return this.#forgotten
    }

    /** Estimated bytes held (see GROUP_WEIGHT). Groups shared with a fork are counted by each memory. */
    get weight(): number {
        return this.#groups.size * GROUP_WEIGHT + this.#members * MEMBER_WEIGHT
    }

    /**
     * An independent memory with the same content, for the next page (the
     * state of a cursor is never changed by a page computed from it). Both
     * memories share their groups and copy on write: this one gives up the
     * ownership of everything it holds. O(groups), sources are not copied.
     */
    fork(): DuplicateMemory {
        const copy = new DuplicateMemory(this.limits)
        copy.#groups = new Map(this.#groups)
        copy.#byKey = new Map(this.#byKey)
        copy.#members = this.#members
        copy.#forgotten = this.#forgotten
        this.#generation = ++generations
        return copy
    }

    /** The earliest remembered group the article can join, or undefined (first-fit, see above). */
    find(fingerprint: string, time: number, source: number): RememberedGroup | undefined {
        const keyed = this.#byKey.get(fingerprint)
        if (keyed === undefined) return undefined
        if (typeof keyed === "number") return this.#fits(keyed, time, source)
        for (const id of keyed.ids) {
            const g = this.#fits(id, time, source)
            if (g !== undefined) return g
        }
        return undefined
    }

    #fits(id: number, time: number, source: number): Group | undefined {
        const g = this.#groups.get(id) as Group
        return Math.max(g.maxTime, time) - Math.min(g.minTime, time) <= MAX_DATE_DIFFERENCE_MS && !hasSource(g, source) ? g : undefined
    }

    /** Adds the article to the group returned by the last find() on this memory. */
    join(group: RememberedGroup, time: number, source: number): void {
        let g = this.#groups.get(group.representativeId)
        if (g === undefined || g !== group) throw new Error("not a remembered group")
        if (hasSource(g, source)) throw new Error("source already in the group")
        if (g.owner !== this.#generation) {
            g = { ...g, owner: this.#generation }
            this.#groups.set(g.representativeId, g) // an existing key keeps its creation order
        }
        g.minTime = Math.min(g.minTime, time)
        g.maxTime = Math.max(g.maxTime, time)
        addSource(g, source)
        this.#members++
        this.#enforce()
    }

    /** Opens the group of a new representative. */
    open(representativeId: number, fingerprint: string, time: number, source: number): void {
        if (this.#groups.has(representativeId)) throw new Error("representative already remembered")
        const same = this.#byKey.get(fingerprint)
        if (same !== undefined && idsOf(same).length >= this.limits.keyGroupsMax) this.#forget(idsOf(same)[0] as number)
        this.#groups.set(representativeId, { representativeId, fingerprint, minTime: time, maxTime: time, members: 1, items: [source], index: null, owner: this.#generation })
        const keyed = this.#byKey.get(fingerprint)
        if (keyed === undefined) this.#byKey.set(fingerprint, representativeId)
        else this.#ownedKey(fingerprint, keyed).ids.push(representativeId)
        this.#members++
        this.#enforce()
    }

    /** The key list of `fingerprint`, owned by this memory (copied on write). */
    #ownedKey(fingerprint: string, keyed: number | KeyGroups): KeyGroups {
        if (typeof keyed !== "number" && keyed.owner === this.#generation) return keyed
        const owned: KeyGroups = { ids: [...idsOf(keyed)], owner: this.#generation }
        this.#byKey.set(fingerprint, owned)
        return owned
    }

    #forget(id: number): void {
        const g = this.#groups.get(id) as Group
        this.#groups.delete(id)
        const keyed = this.#byKey.get(g.fingerprint) as number | KeyGroups
        const rest = idsOf(keyed).filter((other) => other !== id)
        if (rest.length === 0) this.#byKey.delete(g.fingerprint)
        else if (rest.length === 1) this.#byKey.set(g.fingerprint, rest[0] as number)
        else {
            const owned = this.#ownedKey(g.fingerprint, keyed)
            owned.ids.splice(owned.ids.indexOf(id), 1)
        }
        this.#members -= g.members
        this.#forgotten++
    }

    #enforce(): void {
        while (this.#groups.size > this.limits.groupsMax || this.#members > this.limits.membersMax) {
            this.#forget(this.#groups.keys().next().value as number)
        }
    }
}
