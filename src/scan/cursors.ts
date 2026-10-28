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
 * started, at most 64 cursors (least recently used evicted first). Expired
 * and evicted cursors are indistinguishable (CURSOR_EXPIRED).
 *
 * Entries are immutable except for their last-use time and the response
 * published for them, which makes a repeated cursor return the same result
 * (replay) instead of reading the database again.
 */

import crypto from "node:crypto"
import { FrMcpError } from "../errors.js"

export const CURSOR_TTL_MS = 30 * 60 * 1000
export const CURSOR_SCAN_MAX_MS = 2 * 60 * 60 * 1000
export const CURSOR_CAPACITY = 64

const ID_BYTES = 16
const MAC_BYTES = 16
const TOKEN_PATTERN = /^c1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/

/** Length of every cursor token (`c1.` + 22 + `.` + 22). */
export const CURSOR_TOKEN_LENGTH = 48

export interface CursorEntry<S> {
    readonly tool: string
    /** Normalized arguments the cursor is bound to. */
    readonly binding: Readonly<Record<string, string | number | boolean | null>>
    readonly state: S
    readonly scanStartedAt: number
    lastUsedAt: number
    /** Serialized result published for this cursor (replayed verbatim). */
    response?: string
}

export interface CursorRegistryOptions {
    readonly now?: () => number
    readonly ttlMs?: number
    readonly scanMaxMs?: number
    readonly capacity?: number
}

export class CursorRegistry {
    readonly #key = crypto.randomBytes(32)
    /** id → entry, least recently used first. */
    readonly #entries = new Map<string, CursorEntry<unknown>>()
    readonly #now: () => number
    readonly #ttlMs: number
    readonly #scanMaxMs: number
    readonly #capacity: number
    #queue: Promise<unknown> = Promise.resolve()

    constructor(options: CursorRegistryOptions = {}) {
        this.#now = options.now ?? Date.now
        this.#ttlMs = options.ttlMs ?? CURSOR_TTL_MS
        this.#scanMaxMs = options.scanMaxMs ?? CURSOR_SCAN_MAX_MS
        this.#capacity = options.capacity ?? CURSOR_CAPACITY
    }

    /** Number of cursors currently kept. */
    get size(): number {
        return this.#entries.size
    }

    #mac(id: string): Buffer {
        return crypto.createHmac("sha256", this.#key).update(`c1.${id}`).digest().subarray(0, MAC_BYTES)
    }

    #expired(entry: CursorEntry<unknown>, now: number): boolean {
        return now - entry.lastUsedAt > this.#ttlMs || now - entry.scanStartedAt > this.#scanMaxMs
    }

    /** Registers a new cursor and returns its token. */
    create<S>(tool: string, binding: CursorEntry<S>["binding"], state: S, scanStartedAt: number): string {
        const now = this.#now()
        for (const [id, entry] of this.#entries) {
            if (this.#expired(entry, now)) this.#entries.delete(id)
        }
        while (this.#entries.size >= this.#capacity) {
            const oldest = this.#entries.keys().next().value
            if (oldest === undefined) break
            this.#entries.delete(oldest)
        }
        const id = crypto.randomBytes(ID_BYTES).toString("base64url")
        this.#entries.set(id, { tool, binding, state, scanStartedAt, lastUsedAt: now })
        return `c1.${id}.${this.#mac(id).toString("base64url")}`
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
        if (this.#expired(entry, now)) {
            this.#entries.delete(id)
            const reason = now - entry.scanStartedAt > this.#scanMaxMs ? "scan-expired" : "unknown-or-expired"
            throw new FrMcpError("CURSOR_EXPIRED", reason)
        }
        if (entry.tool !== tool) throw new FrMcpError("CURSOR_MISMATCH", "tool-mismatch")
        entry.lastUsedAt = now
        this.#entries.delete(id)
        this.#entries.set(id, entry)
        return entry as CursorEntry<S>
    }

    /** Forgets a cursor for good (CURSOR_STALE, or a successor that was never published). */
    invalidate(token: string): void {
        const match = TOKEN_PATTERN.exec(token)
        if (match?.[1] !== undefined) this.#entries.delete(match[1])
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
