/**
 * Read-only, short-lived SQLite access through `node:sqlite` (FR-MCP-01,
 * D-01, D-15, §16; FR-REV-001).
 *
 * Each use runs one synchronous callback on a connection opened and closed
 * within the call. No connection or transaction outlives a call. Calls are
 * serialized.
 *
 * Sequence of one call:
 *  1. The helper takes an SQLite-compatible SHARED lock on the database file
 *     (shared-lock.ts). While it is held no writer can obtain EXCLUSIVE, so
 *     the journal mode cannot change and the file cannot be replaced.
 *  2. T0: helper alive; file identity (dev, ino, birthtime) equal to startup
 *     and to the file the helper locked; no -wal/-shm file; 100-byte header
 *     read with fs: SQLite magic and rollback-journal format (1/1).
 *  3. readOnly connection, busy timeout 0, `PRAGMA query_only = ON` (verified),
 *     `BEGIN`.
 *  4. T1: helper alive. First read: SQLite takes its own SHARED lock without
 *     waiting (a busy result restarts the call from step 1).
 *  5. T2: helper alive, hence the lock was held without interruption from
 *     step 1 until this connection held SHARED. From here the read
 *     transaction keeps this connection's own SHARED lock until COMMIT.
 *  6. Callback, COMMIT, close, identity check; then the helper releases.
 * If the helper is lost at T0/T1/T2 the call fails with
 * DB_PROTECTION_UNAVAILABLE before the callback runs.
 *
 * BUSY_TIMEOUT_MS bounds only the total wait for locks (step 1 and the first
 * read, with retries). It does not bound how long the callback's statements
 * run; node:sqlite cannot interrupt a running statement.
 *
 * A hot rollback journal makes SQLite fail with SQLITE_READONLY_ROLLBACK,
 * reported as DB_NEEDS_RECOVERY; the journal is never touched.
 */

import fs from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { FrMcpError, systemErrorCode, toSafeError } from "../errors.js"
import { logEvent } from "../log.js"
import { SqliteSharedLock, type LockLease } from "./shared-lock.js"

/** Maximum total wait for database locks per call. Not a query time limit. */
export const BUSY_TIMEOUT_MS = 1000

/** The only part of the connection API exposed to callers. */
export type ReadOnlyDatabase = Pick<DatabaseSync, "prepare">

/** Test-only seams to inject concurrent events at the critical points. */
export interface DatabaseAccessHooks {
    /** After the header check, before SQLite opens the file (lock held by the helper). */
    afterHeaderCheck?(): void
    /** After this connection holds its own SHARED lock, before the callback. */
    afterOwnSharedLock?(): void
}

export interface DatabaseAccessOptions {
    readonly lock?: SqliteSharedLock
    readonly hooks?: DatabaseAccessHooks
}

interface FileIdentity {
    readonly dev: bigint
    readonly ino: bigint
    readonly birthtimeNs: bigint
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1")
const HEADER_SIZE = 100
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const RETRY_DELAYS_MS = [5, 10, 20, 40, 80]

const openConnections = new Set<DatabaseSync>()
let defaultLock: SqliteSharedLock | undefined

/** The process-wide lock helper used when no other is given. */
export function sharedLock(): SqliteSharedLock {
    defaultLock ??= new SqliteSharedLock()
    return defaultLock
}

/** Number of SQLite connections currently open (expected to be 0 between calls). */
export function openConnectionCount(): number {
    return openConnections.size
}

/** Closes any connection still open. Used on shutdown as a safety net. */
export function closeAllConnections(): void {
    for (const db of openConnections) {
        try {
            if (db.isOpen) db.close()
        } catch {
            // A statement still running cannot be closed; the process is exiting.
        }
    }
    openConnections.clear()
}

function readIdentity(databasePath: string): FileIdentity {
    let stats: fs.BigIntStats
    try {
        stats = fs.lstatSync(databasePath, { bigint: true })
    } catch (error) {
        const code = systemErrorCode(error)
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new FrMcpError("PROFILE_UNAVAILABLE", "db-missing")
        }
        throw new FrMcpError("DB_UNREADABLE", "io")
    }
    if (!stats.isFile()) throw new FrMcpError("DB_REPLACED", "identity-changed")
    return { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs }
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs
}

function fileExists(p: string): boolean {
    try {
        fs.lstatSync(p)
        return true
    } catch (error) {
        const code = systemErrorCode(error)
        if (code === "ENOENT" || code === "ENOTDIR") return false
        throw new FrMcpError("DB_UNREADABLE", "io")
    }
}

/**
 * Checks the SQLite header without SQLite: magic string and the file format
 * read/write versions (offsets 18-19; 1 = rollback journal, 2 = WAL).
 */
function checkHeader(databasePath: string): void {
    const header = Buffer.alloc(HEADER_SIZE)
    let bytesRead = 0
    let fd: number | undefined
    try {
        fd = fs.openSync(databasePath, "r")
        while (bytesRead < HEADER_SIZE) {
            const n = fs.readSync(fd, header, bytesRead, HEADER_SIZE - bytesRead, bytesRead)
            if (n === 0) break
            bytesRead += n
        }
    } catch {
        throw new FrMcpError("DB_UNREADABLE", "io")
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd)
            } catch {
                // ignore
            }
        }
    }
    if (bytesRead < HEADER_SIZE || !header.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
        throw new FrMcpError("SCHEMA_UNSUPPORTED", "not-sqlite")
    }
    const writeVersion = header[18]
    const readVersion = header[19]
    if (writeVersion === 2 || readVersion === 2) {
        throw new FrMcpError("DB_WAL_UNSUPPORTED", "wal-mode")
    }
    if (writeVersion !== 1 || readVersion !== 1) {
        throw new FrMcpError("SCHEMA_UNSUPPORTED", "unsupported-format")
    }
}

function isBusy(error: unknown): boolean {
    const errcode = (error as { errcode?: unknown } | null)?.errcode
    return typeof errcode === "number" && ((errcode & 0xff) === SQLITE_BUSY || (errcode & 0xff) === SQLITE_LOCKED)
}

const RETRY = Symbol("retry")

export class DatabaseAccess {
    readonly #path: string
    readonly #identity: FileIdentity
    readonly #lock: SqliteSharedLock
    readonly #hooks: DatabaseAccessHooks | undefined
    #replaced = false
    #queue: Promise<unknown> = Promise.resolve()

    /** Records the identity of the database file; call once at startup. */
    constructor(databasePath: string, options: DatabaseAccessOptions = {}) {
        this.#path = databasePath
        this.#identity = readIdentity(databasePath)
        this.#lock = options.lock ?? sharedLock()
        this.#hooks = options.hooks
    }

    /** True once a replacement was detected; stays true until restart. */
    get replaced(): boolean {
        return this.#replaced
    }

    #markReplaced(): void {
        if (!this.#replaced) logEvent("database_replaced")
        this.#replaced = true
    }

    #checkIdentity(lease?: LockLease): void {
        if (this.#replaced) throw new FrMcpError("DB_REPLACED", "identity-changed")
        let current: FileIdentity
        try {
            current = readIdentity(this.#path)
        } catch (error) {
            if (error instanceof FrMcpError && error.code === "DB_REPLACED") this.#markReplaced()
            throw error
        }
        const lockedOther = lease !== undefined && (lease.dev !== current.dev || lease.ino !== current.ino)
        if (lockedOther || !sameIdentity(current, this.#identity)) {
            this.#markReplaced()
            throw new FrMcpError("DB_REPLACED", "identity-changed")
        }
    }

    #ensureProtected(): void {
        if (!this.#lock.isAliveSync()) throw new FrMcpError("DB_PROTECTION_UNAVAILABLE", "helper-lost")
    }

    /**
     * Opens a read-only connection under the preventive lock, runs `fn`
     * synchronously and closes the connection. `fn` must not return a promise.
     * Errors are converted into sanitized domain errors.
     */
    withReadConnection<T>(fn: (db: ReadOnlyDatabase) => T): Promise<T> {
        const run = this.#queue.then(() => this.#run(fn))
        this.#queue = run.catch(() => undefined)
        return run
    }

    async #run<T>(fn: (db: ReadOnlyDatabase) => T): Promise<T> {
        if (this.#replaced) throw new FrMcpError("DB_REPLACED", "identity-changed")
        const deadline = Date.now() + BUSY_TIMEOUT_MS
        for (let attempt = 0; ; attempt++) {
            let lease: LockLease | "busy" | "unopenable"
            try {
                lease = await this.#lock.acquire(this.#path)
            } catch (error) {
                throw toSafeError(error)
            }
            if (lease === "unopenable") {
                // Missing or replaced file first; otherwise an I/O problem. SQLite is not opened.
                this.#checkIdentity()
                throw new FrMcpError("DB_UNREADABLE", "io")
            }
            let outcome: { value: T } | typeof RETRY = RETRY
            if (lease !== "busy") {
                try {
                    outcome = this.#readUnderLock(lease, fn)
                } finally {
                    await this.#lock.release()
                }
            }
            if (outcome !== RETRY) return outcome.value
            if (Date.now() >= deadline) throw new FrMcpError("DB_BUSY", "busy")
            const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] as number
            await sleep(Math.min(delay, Math.max(0, deadline - Date.now())))
        }
    }

    #readUnderLock<T>(lease: LockLease, fn: (db: ReadOnlyDatabase) => T): { value: T } | typeof RETRY {
        let db: DatabaseSync | undefined
        try {
            // T0: protection in place before anything is checked.
            this.#ensureProtected()
            this.#checkIdentity(lease)
            if (fileExists(`${this.#path}-wal`) || fileExists(`${this.#path}-shm`)) {
                throw new FrMcpError("DB_WAL_UNSUPPORTED", "wal-files-present")
            }
            checkHeader(this.#path)
            this.#hooks?.afterHeaderCheck?.()

            db = new DatabaseSync(this.#path, {
                readOnly: true,
                timeout: 0,
                defensive: true,
                allowExtension: false,
            })
            openConnections.add(db)
            db.exec("PRAGMA query_only = ON")
            const row = db.prepare("PRAGMA query_only").get() as { query_only?: unknown } | undefined
            if (row?.query_only !== 1) throw new FrMcpError("INTERNAL_ERROR", "query-only")
            db.exec("BEGIN")

            // T1: no unprotected first read.
            this.#ensureProtected()
            try {
                db.prepare("PRAGMA schema_version").get()
            } catch (error) {
                if (isBusy(error)) return RETRY
                throw error
            }
            // T2: the helper's lock covered every step up to this connection's own SHARED lock.
            this.#ensureProtected()
            this.#hooks?.afterOwnSharedLock?.()

            const result = fn(db)
            if (typeof (result as { then?: unknown } | null)?.then === "function") {
                throw new FrMcpError("INTERNAL_ERROR", "async-callback")
            }
            db.exec("COMMIT")
            this.#checkIdentity()
            return { value: result }
        } catch (error) {
            throw toSafeError(error)
        } finally {
            if (db !== undefined) {
                openConnections.delete(db)
                try {
                    if (db.isOpen) db.close()
                } catch {
                    // close() fails only while a statement runs, which cannot
                    // happen here: every call is synchronous.
                }
            }
        }
    }
}
