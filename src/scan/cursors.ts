/**
 * Cursor registry (FR-MCP-01 §11.7, D-06 option B, §11.3.5).
 *
 * A cursor is an opaque token `c1.<id>.<mac>`: `id` is 128 random bits, never
 * derived from data, and `mac` is HMAC-SHA256 of the id under a random key of
 * this process, truncated to 128 bits. The token carries no state: position,
 * filters and the published response live only in this process's memory.
 * The MAC lets the server tell a forged or altered token (CURSOR_INVALID)
 * from a genuine one that is no longer kept (CURSOR_EXPIRED); tokens of a
 * previous server run fail the MAC and are CURSOR_INVALID.
 *
 * Lifetime: 30 minutes after the last use, at most 2 hours after the listing
 * started, at most 64 cursors (least recently used evicted first), and the
 * memory budget below. Expired and evicted cursors are indistinguishable
 * (CURSOR_EXPIRED).
 *
 * An entry is created with its state, then published once: publish() stores
 * the serialized result returned for it, which makes a repeated cursor return
 * the same result (replay) instead of reading the database again, and drops
 * its state, no longer needed. Only the registry changes an entry.
 *
 * Persistent memory budget, every tool included. Each kept entry is charged
 * an estimated weight (entryWeight): ENTRY_WEIGHT for the entry itself
 * (record, id, position in the registry, fixed-size state: positions,
 * checkpoints, revisions, fingerprints), the binding (its strings at two
 * bytes per UTF-16 unit), the variable part of its state as declared by the
 * tool (`stateWeight`: the groupDuplicates memory) until it is published, and
 * the published response (two bytes per UTF-16 unit) after. The weights of
 * all kept entries stay within `weightCapacity` (CURSOR_WEIGHT_CAPACITY,
 * 8 MiB): create() and publish() evict least recently used entries until the
 * total fits. The totals are kept by the registry itself, on every insertion,
 * publication and removal (expiry, eviction, invalidation), never by tools.
 * Without groupDuplicates an entry weighs at most about 115 KB (a response is
 * at most RESP_MAX = 48 000 units, the largest binding about 18 KB), so the
 * 64 entries the registry keeps stay within the budget and the count limit
 * alone applies, as before.
 *
 * Transition of a chain. The successor of an entry is created before that
 * entry's response is built (its token is part of the response), then the
 * entry is published. create() is told which entry it continues: that entry
 * is never evicted, and the state weight it is about to drop is not counted,
 * so a chain never evicts other chains for a memory it is releasing.
 * Between the two steps, which run synchronously within one exclusive call,
 * the total may exceed the capacity by at most that state weight (the
 * overlap of predecessor and successor); publish() then evicts until the
 * total fits again, never the entry it publishes nor its successor. A call
 * that fails before publishing invalidates the successor it created: the
 * entry it was called with keeps its state and weight, unchanged.
 *
 * Expiry at publication. publish() checks the entry itself, with the same
 * clock and rule as resolve() and create() (#expiry): an entry that expired
 * during the call (inactivity or the listing's age), or that is no longer
 * kept, is not published. It is removed with its weight, the successor the
 * result would hand out is invalidated, and the call fails with
 * CURSOR_EXPIRED, with or without a successor (last page).
 *
 * These weights are conservative estimates of retained heap, not a bound on
 * the V8 heap: allocator and object overheads are not measured exactly, and
 * the temporary allocations of a call (see tools/duplicate-grouping.ts) are
 * outside this budget.
 */

import crypto from "node:crypto"
import { FrMcpError } from "../errors.js"

export const CURSOR_TTL_MS = 30 * 60 * 1000
export const CURSOR_SCAN_MAX_MS = 2 * 60 * 60 * 1000
export const CURSOR_CAPACITY = 64
/** Estimated bytes kept over all cursors (see entryWeight). */
export const CURSOR_WEIGHT_CAPACITY = 8 * 1024 * 1024
/** Estimated bytes of one entry without its binding strings, variable state and response. */
export const ENTRY_WEIGHT = 1024
/** Estimated bytes of one binding property, besides its string value. */
const PROPERTY_WEIGHT = 32
/** Estimated bytes of a string besides its characters. */
const STRING_WEIGHT = 32

const ID_BYTES = 16
const MAC_BYTES = 16
const TOKEN_PATTERN = /^c1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/

/** Length of every cursor token (`c1.` + 22 + `.` + 22). */
export const CURSOR_TOKEN_LENGTH = 48

export type CursorBinding = Readonly<Record<string, string | number | boolean | null>>

/** Estimated bytes of an entry with this binding, variable state weight and published response. */
export function entryWeight(binding: CursorBinding, stateWeight: number, response: string | undefined): number {
    let weight = ENTRY_WEIGHT + stateWeight
    for (const value of Object.values(binding)) weight += PROPERTY_WEIGHT + (typeof value === "string" ? STRING_WEIGHT + 2 * value.length : 0)
    if (response !== undefined) weight += STRING_WEIGHT + 2 * response.length
    return weight
}

export interface CursorEntry<S> {
    readonly tool: string
    /** Normalized arguments the cursor is bound to. */
    readonly binding: CursorBinding
    /** The state the next page is computed from; dropped (see releaseState) once published. */
    readonly state: S
    readonly scanStartedAt: number
    readonly lastUsedAt: number
    /** Serialized result published for this cursor (replayed verbatim). */
    readonly response: string | undefined
    /** Estimated bytes charged to this entry (entryWeight). */
    readonly weight: number
}

export interface CreateOptions<S> {
    /** Estimated bytes of the variable part of `state`, held until the entry is published (default 0). */
    readonly stateWeight?: number
    /** Called once when the entry is published, to drop what stateWeight accounted for. */
    readonly releaseState?: (state: S) => void
    /** The entry whose page this cursor continues (published right after). */
    readonly replacing?: CursorEntry<unknown>
}

interface Entry {
    readonly id: string
    readonly tool: string
    readonly binding: CursorBinding
    readonly state: unknown
    readonly scanStartedAt: number
    lastUsedAt: number
    response: string | undefined
    stateWeight: number
    weight: number
    releaseState: ((state: never) => void) | undefined
}

export interface CursorRegistryOptions {
    readonly now?: () => number
    readonly ttlMs?: number
    readonly scanMaxMs?: number
    readonly capacity?: number
    readonly weightCapacity?: number
}

export class CursorRegistry {
    readonly #key = crypto.randomBytes(32)
    /** id → entry, least recently used first. */
    readonly #entries = new Map<string, Entry>()
    readonly #now: () => number
    readonly #ttlMs: number
    readonly #scanMaxMs: number
    readonly #capacity: number
    readonly #weightCapacity: number
    /** Σ weight of the kept entries. */
    #weight = 0
    #queue: Promise<unknown> = Promise.resolve()

    constructor(options: CursorRegistryOptions = {}) {
        this.#now = options.now ?? Date.now
        this.#ttlMs = options.ttlMs ?? CURSOR_TTL_MS
        this.#scanMaxMs = options.scanMaxMs ?? CURSOR_SCAN_MAX_MS
        this.#capacity = options.capacity ?? CURSOR_CAPACITY
        this.#weightCapacity = options.weightCapacity ?? CURSOR_WEIGHT_CAPACITY
    }

    /** Number of cursors currently kept. */
    get size(): number {
        return this.#entries.size
    }

    /** Estimated bytes charged to the cursors currently kept. */
    get weight(): number {
        return this.#weight
    }

    /** Capacity of the persistent memory budget. */
    get weightCapacity(): number {
        return this.#weightCapacity
    }

    #mac(id: string): Buffer {
        return crypto.createHmac("sha256", this.#key).update(`c1.${id}`).digest().subarray(0, MAC_BYTES)
    }

    /** The CURSOR_EXPIRED reason of `entry` at `now`, or null while it is live (the one expiry rule of the registry). */
    #expiry(entry: Entry, now: number): "scan-expired" | "unknown-or-expired" | null {
        if (now - entry.scanStartedAt > this.#scanMaxMs) return "scan-expired"
        if (now - entry.lastUsedAt > this.#ttlMs) return "unknown-or-expired"
        return null
    }

    #delete(id: string): void {
        const entry = this.#entries.get(id)
        if (entry === undefined) return
        this.#entries.delete(id)
        this.#weight -= entry.weight
    }

    /** Evicts least recently used entries, never those protected, while `over()` holds. */
    #evict(over: () => boolean, protect: readonly (Entry | undefined)[]): void {
        for (const [id, entry] of this.#entries) {
            if (!over()) return
            if (!protect.includes(entry)) this.#delete(id)
        }
    }

    /** Registers a new cursor and returns its token. */
    create<S>(tool: string, binding: CursorBinding, state: S, scanStartedAt: number, options: CreateOptions<S> = {}): string {
        const stateWeight = options.stateWeight ?? 0
        const weight = entryWeight(binding, stateWeight, undefined)
        if (!(Number.isSafeInteger(stateWeight) && stateWeight >= 0 && weight <= this.#weightCapacity)) throw new RangeError("cursor weight")
        const replacing = options.replacing as Entry | undefined
        const now = this.#now()
        for (const [id, entry] of this.#entries) {
            if (this.#expiry(entry, now) !== null) this.#delete(id)
        }
        this.#evict(() => this.#entries.size >= this.#capacity, [replacing])
        // The state weight `replacing` is about to drop is not counted (see the transition above).
        const pending = replacing !== undefined && this.#kept(replacing) ? replacing.stateWeight : 0
        this.#evict(() => this.#weight - pending + weight > this.#weightCapacity, [replacing])
        const id = crypto.randomBytes(ID_BYTES).toString("base64url")
        this.#entries.set(id, {
            id,
            tool,
            binding,
            state,
            scanStartedAt,
            lastUsedAt: now,
            response: undefined,
            stateWeight,
            weight,
            releaseState: options.releaseState as ((state: never) => void) | undefined,
        })
        this.#weight += weight
        return `c1.${id}.${this.#mac(id).toString("base64url")}`
    }

    #kept(entry: Entry): boolean {
        return this.#entries.get(entry.id) === entry
    }

    /**
     * Publishes the result returned for `entry`: replay returns it from now
     * on, and the entry's state is dropped (releaseState). `successor`: the
     * token of the cursor this result hands out, never evicted here.
     * CURSOR_EXPIRED when the entry expired during the call or is no longer
     * kept: nothing is published or released, the entry is removed with its
     * weight and the successor is invalidated (see Expiry at publication).
     */
    publish(entry: CursorEntry<unknown>, serialized: string, successor: string | null): void {
        const published = entry as unknown as Entry
        if (published.response !== undefined) throw new Error("cursor already published")
        const expiry = this.#expiry(published, this.#now())
        if (expiry !== null || !this.#kept(published)) {
            if (this.#kept(published)) this.#delete(published.id)
            if (successor !== null) this.invalidate(successor)
            throw new FrMcpError("CURSOR_EXPIRED", expiry ?? "unknown-or-expired")
        }
        published.response = serialized
        if (published.stateWeight > 0 || published.releaseState !== undefined) {
            published.releaseState?.(published.state as never)
            published.releaseState = undefined
            published.stateWeight = 0
        }
        const weight = entryWeight(published.binding, 0, serialized)
        this.#weight += weight - published.weight
        published.weight = weight
        const next = successor === null ? undefined : this.#entries.get(TOKEN_PATTERN.exec(successor)?.[1] ?? "")
        this.#evict(() => this.#weight > this.#weightCapacity, [published, next])
    }

    #idOf(token: string): string {
        const match = TOKEN_PATTERN.exec(token)
        if (match === null) throw new FrMcpError("CURSOR_INVALID", "malformed")
        const [, id, mac] = match as unknown as [string, string, string]
        const idBytes = Buffer.from(id, "base64url")
        const macBytes = Buffer.from(mac, "base64url")
        // Canonical base64url only: re-encoding must give the same text.
        if (idBytes.length !== ID_BYTES || macBytes.length !== MAC_BYTES || idBytes.toString("base64url") !== id) {
            throw new FrMcpError("CURSOR_INVALID", "malformed")
        }
        if (macBytes.toString("base64url") !== mac || !crypto.timingSafeEqual(macBytes, this.#mac(id))) {
            throw new FrMcpError("CURSOR_INVALID", "malformed")
        }
        return id
    }

    /**
     * Returns the live entry of a token issued for `tool` and marks it used.
     * CURSOR_INVALID, CURSOR_EXPIRED or CURSOR_MISMATCH otherwise.
     */
    resolve<S>(token: string, tool: string): CursorEntry<S> {
        const id = this.#idOf(token)
        const entry = this.#entries.get(id)
        if (entry === undefined) throw new FrMcpError("CURSOR_EXPIRED", "unknown-or-expired")
        const now = this.#now()
        const expiry = this.#expiry(entry, now)
        if (expiry !== null) {
            this.#delete(id)
            throw new FrMcpError("CURSOR_EXPIRED", expiry)
        }
        if (entry.tool !== tool) throw new FrMcpError("CURSOR_MISMATCH", "tool-mismatch")
        entry.lastUsedAt = now
        this.#entries.delete(id)
        this.#entries.set(id, entry)
        return entry as unknown as CursorEntry<S>
    }

    /** The kept entry of a genuine token, without marking it used (diagnostics and tests). */
    peek(token: string): CursorEntry<unknown> | undefined {
        let id: string
        try {
            id = this.#idOf(token)
        } catch {
            return undefined
        }
        return this.#entries.get(id) as unknown as CursorEntry<unknown> | undefined
    }

    /** Recomputes every weight from scratch and checks it against the running totals (diagnostics and tests). */
    audit(): { readonly entries: number; readonly weight: number; readonly stateWeight: number; readonly responses: number } {
        let weight = 0
        let stateWeight = 0
        let responses = 0
        for (const entry of this.#entries.values()) {
            const expected = entryWeight(entry.binding, entry.stateWeight, entry.response)
            if (expected !== entry.weight || (entry.response !== undefined && entry.stateWeight !== 0)) throw new Error("cursor weight out of sync")
            weight += expected
            stateWeight += entry.stateWeight
            if (entry.response !== undefined) responses++
        }
        if (weight !== this.#weight) throw new Error("cursor weight out of sync")
        return { entries: this.#entries.size, weight, stateWeight, responses }
    }

    /** Forgets a cursor for good (CURSOR_STALE, or a successor that was never published). */
    invalidate(token: string): void {
        const match = TOKEN_PATTERN.exec(token)
        if (match?.[1] !== undefined) this.#delete(match[1])
    }

    /**
     * Runs cursor-bearing work one call at a time, so that two concurrent
     * calls with the same cursor publish one response and replay it.
     */
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(fn)
        this.#queue = run.catch(() => undefined)
        return run
    }
}
