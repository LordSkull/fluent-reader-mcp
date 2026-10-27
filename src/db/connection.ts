/**
 * Read-only, short-lived SQLite access through `node:sqlite` (FR-MCP-01,
 * D-01, D-15, §16; FR-REV-001).
 *
 * Each use runs one synchronous callback on a connection opened and closed
 * within the call. No connection or transaction outlives a call. Calls are
 * serialized.
 *
 * One attempt is a single synchronous block (no await, so no other code of
 * this process runs in between):
 *  1. This process takes an SQLite-compatible SHARED lock on the database
 *     file through its own Win32 handle (win32-lock.ts). While it is held no
 *     writer can obtain EXCLUSIVE, so the journal mode cannot change, and the
 *     file cannot be renamed, replaced or deleted.
 *  2. File identity (dev, ino, birthtime) equal to startup and to the locked
 *     handle; no -wal/-shm file; 100-byte header read with fs: SQLite magic
 *     and rollback-journal format (1/1).
 *  3. readOnly connection, busy timeout 0, `PRAGMA query_only = ON` (verified),
 *     `BEGIN`.
 *  4. First read: SQLite takes its own SHARED lock without waiting (a busy
 *     result releases everything and retries the attempt). Identity checked
 *     again against the locked handle.
 *  5. Callback, COMMIT, close.
 *  6. Only once the connection is closed: unlock and close the Win32 handle.
 * The preventive lock is therefore held from before the header check until
 * after SQLite has closed the file. It belongs to this process: it can only
 * disappear together with the process, and with it the SQLite connection.
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
import { SqliteFileLock, type HeldLock } from "./win32-lock.js"

/** Maximum total wait for database locks per call. Not a query time limit. */
export const BUSY_TIMEOUT_MS = 1000

/** The only part of the connection API exposed to callers. */
export type ReadOnlyDatabase = Pick<DatabaseSync, "prepare">

/**
 * Test-only seams to inject concurrent events at the critical points. All run
 * while the preventive lock is held.
 */
export interface DatabaseAccessHooks {
    /** Right after the Win32 lock is taken, before any check. */
    afterLock?(lock: HeldLock): void
    /** After the header check, before SQLite opens the file. */
    afterHeaderCheck?(): void
    /** After SQLite opened the file and began the transaction, before its first read. */
    beforeFirstRead?(): void
    /** After this connection holds its own SHARED lock, before the callback. */
    afterOwnSharedLock?(): void
    /** After the SQLite connection is closed, before the Win32 lock is released. */
    beforeRelease?(lock: HeldLock): void
}

export interface DatabaseAccessOptions {
    readonly lock?: SqliteFileLock
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
let defaultLock: SqliteFileLock | undefined

/** The process-wide lock factory used when no other is given. */
export function fileLock(): SqliteFileLock {
    defaultLock ??= new SqliteFileLock()
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
    readonly #lock: SqliteFileLock
    readonly #hooks: DatabaseAccessHooks | undefined
    #replaced = false
    #queue: Promise<unknown> = Promise.resolve()

    /** Records the identity of the database file; call once at startup. */
    constructor(databasePath: string, options: DatabaseAccessOptions = {}) {
        this.#path = databasePath
        this.#identity = readIdentity(databasePath)
        this.#lock = options.lock ?? fileLock()
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

    /** Path identity equal to startup and, when given, to the locked handle. */
    #checkIdentity(lock?: HeldLock): void {
        if (this.#replaced) throw new FrMcpError("DB_REPLACED", "identity-changed")
        let current: FileIdentity
        try {
            current = readIdentity(this.#path)
        } catch (error) {
            if (error instanceof FrMcpError && error.code === "DB_REPLACED") this.#markReplaced()
            throw error
        }
        if (!sameIdentity(current, this.#identity) || (lock !== undefined && !sameIdentity(current, lock))) {
            this.#markReplaced()
            throw new FrMcpError("DB_REPLACED", "identity-changed")
        }
    }

    /** Invariant: the preventive lock is released only at the end of an attempt. */
    #ensureProtected(lock: HeldLock): void {
        if (!lock.held) throw new FrMcpError("DB_PROTECTION_UNAVAILABLE", "lock-failed")
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
            const outcome = this.#attempt(fn)
            if (outcome !== RETRY) return outcome.value
            if (Date.now() >= deadline) throw new FrMcpError("DB_BUSY", "busy")
            const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] as number
            await sleep(Math.min(delay, Math.max(0, deadline - Date.now())))
        }
    }

    /** One synchronous attempt: lock, check, open, read, close, unlock. */
    #attempt<T>(fn: (db: ReadOnlyDatabase) => T): { value: T } | typeof RETRY {
        let lock: HeldLock | "busy" | "unopenable"
        try {
            lock = this.#lock.acquire(this.#path)
        } catch (error) {
            throw toSafeError(error)
        }
        if (lock === "busy") return RETRY
        if (lock === "unopenable") {
            // Missing or replaced file first; otherwise an I/O problem. SQLite is not opened.
            this.#checkIdentity()
            throw new FrMcpError("DB_UNREADABLE", "io")
        }

        let db: DatabaseSync | undefined
        try {
            this.#hooks?.afterLock?.(lock)
            this.#ensureProtected(lock)
            this.#checkIdentity(lock)
            if (fileExists(`${this.#path}-wal`) || fileExists(`${this.#path}-shm`)) {
                throw new FrMcpError("DB_WAL_UNSUPPORTED", "wal-files-present")
            }
            checkHeader(this.#path)
            this.#hooks?.afterHeaderCheck?.()

            this.#ensureProtected(lock)
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
            this.#hooks?.beforeFirstRead?.()

            this.#ensureProtected(lock)
            try {
                db.prepare("PRAGMA schema_version").get()
            } catch (error) {
                if (isBusy(error)) return RETRY
                throw error
            }
            // SQLite opened by path the very file this process has locked.
            this.#checkIdentity(lock)
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
            let closed = true
            if (db !== undefined) {
                try {
                    if (db.isOpen) db.close()
                } catch {
                    // close() fails only while a statement runs, which cannot
                    // happen here: every call is synchronous.
                }
                closed = !db.isOpen
                if (closed) openConnections.delete(db)
            }
            // Never released before SQLite has closed the file. A connection
            // that could not be closed keeps the lock until process exit.
            if (closed) {
                try {
                    this.#hooks?.beforeRelease?.(lock)
                } catch (error) {
                    throw toSafeError(error)
                } finally {
                    lock.release()
                }
            }
        }
    }
}
