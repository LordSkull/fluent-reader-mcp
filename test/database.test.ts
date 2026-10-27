import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, test } from "node:test"
import {
    BUSY_TIMEOUT_MS,
    DatabaseAccess,
    fileLock,
    openConnectionCount,
    type DatabaseAccessHooks,
    type ReadOnlyDatabase,
} from "../src/db/connection.js"
import { verifyDatabase } from "../src/db/schema.js"
import {
    bindKernel32,
    ERROR_ACCESS_DENIED,
    ERROR_INVALID_HANDLE,
    ERROR_LOCK_VIOLATION,
    ERROR_SHARING_VIOLATION,
    LOCKFILE_FAIL_IMMEDIATELY,
    PENDING_BYTE,
    SHARED_FIRST,
    SHARED_SIZE,
    SqliteFileLock,
    type Win32FileApi,
    type Win32Handle,
} from "../src/db/win32-lock.js"
import { FrMcpError } from "../src/errors.js"
import {
    createDatabase,
    createProfile,
    createTempRoot,
    removeTempRoot,
    snapshotDir,
    type DatabaseOptions,
    type ProfileFixture,
} from "./helpers/fixtures.js"
import { PROJECT_ROOT } from "./helpers/process.js"

const isWindows = process.platform === "win32"

let root: string
let counter = 0

before(() => {
    root = createTempRoot()
})
after(() => {
    fileLock().close()
    removeTempRoot(root)
})

function newProfile(db: DatabaseOptions = {}): ProfileFixture {
    counter++
    return createProfile(path.join(root, `db${counter}`), { db })
}

function access(profile: ProfileFixture, hooks?: DatabaseAccessHooks, lock?: SqliteFileLock): DatabaseAccess {
    return new DatabaseAccess(profile.dbPath, { ...(hooks && { hooks }), ...(lock && { lock }) })
}

function expectError(fn: () => unknown, code: string, reason?: string): FrMcpError {
    let caught: unknown
    try {
        fn()
    } catch (error) {
        caught = error
    }
    assert.ok(caught instanceof FrMcpError, `expected FrMcpError ${code}, got ${String(caught)}`)
    assert.equal(caught.code, code)
    if (reason !== undefined) assert.equal(caught.reason, reason)
    return caught
}

async function expectReject(promise: Promise<unknown>, code: string, reason?: string): Promise<FrMcpError> {
    let caught: unknown
    try {
        await promise
    } catch (error) {
        caught = error
    }
    assert.ok(caught instanceof FrMcpError, `expected FrMcpError ${code}, got ${String(caught)}`)
    assert.equal(caught.code, code)
    if (reason !== undefined) assert.equal(caught.reason, reason)
    return caught
}

/** Files of a directory, sorted (the inventory of auxiliary files). */
function inventory(dir: string): string[] {
    return fs.readdirSync(dir).sort()
}

function header(dbPath: string): number[] {
    return [...fs.readFileSync(dbPath).subarray(18, 20)]
}

/**
 * A synthetic writer in a separate process (as Fluent Reader would be).
 * Prints "OK <json>" or "ERR <errcode>".
 */
function runWriter(dbPath: string, sql: string, timeoutMs: number): string {
    const script = `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1], { timeout: Number(process.argv[3]) });
        try { console.log("OK " + JSON.stringify(db.prepare(process.argv[2]).all())); }
        catch (e) { console.log("ERR " + e.errcode); }
        finally { db.close(); }`
    const result = spawnSync(process.execPath, ["-e", script, dbPath, sql, String(timeoutMs)], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}

/** A writer process that asks for EXCLUSIVE without waiting. */
function writerExclusive(dbPath: string): string {
    return runWriter(dbPath, "BEGIN EXCLUSIVE", 0)
}

const AUX_SUFFIXES = ["-journal", "-wal", "-shm"]

describe("read-only connection", () => {
    test("verifies a compatible schema and leaves every profile file unchanged", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const capabilities = await access(profile).withReadConnection(verifyDatabase)
        assert.match(capabilities.sqliteVersion, /^\d+\.\d+\.\d+$/)
        assert.equal(capabilities.encoding, "UTF-8")
        assert.equal(capabilities.octetLength, true)
        assert.deepEqual(snapshotDir(profile.dir), initial)
        for (const suffix of AUX_SUFFIXES) assert.equal(fs.existsSync(profile.dbPath + suffix), false)
        assert.equal(openConnectionCount(), 0)
    })

    test("enables query_only and rejects every write", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const writes = [
            "INSERT INTO sources (sid, url, name, lastFetched) VALUES (9, 'https://w.invalid', 'w', 0)",
            "UPDATE items SET hasRead = 1",
            "DELETE FROM items",
            "CREATE INDEX extra_date ON items(date)",
            "CREATE TABLE extra (a)",
            "DROP TABLE items",
            "VACUUM",
        ]
        const outcome = await access(profile).withReadConnection((db) => {
            const queryOnly = (db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only
            const accepted: string[] = []
            for (const sql of writes) {
                try {
                    db.prepare(sql).run()
                    accepted.push(sql)
                } catch {
                    // rejected, as expected
                }
            }
            // Journal mode cannot be changed by this connection.
            let mode: string
            try {
                mode = (db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string }).journal_mode
            } catch {
                mode = "rejected"
            }
            return { queryOnly, accepted, mode }
        })
        assert.equal(outcome.queryOnly, 1)
        assert.deepEqual(outcome.accepted, [])
        assert.notEqual(outcome.mode.toLowerCase(), "wal")
        assert.deepEqual(snapshotDir(profile.dir), initial)
        assert.deepEqual(header(profile.dbPath), [1, 1], "still a rollback-journal database")
    })

    test("closes the connection after success, after errors and for async callbacks", async () => {
        const db0 = access(newProfile())
        const seen: DatabaseSync[] = []
        await db0.withReadConnection((db) => {
            seen.push(db as DatabaseSync)
            assert.equal((db as DatabaseSync).isOpen, true)
        })
        await expectReject(
            db0.withReadConnection((db) => {
                seen.push(db as DatabaseSync)
                throw new Error("callback failure")
            }),
            "INTERNAL_ERROR",
        )
        await expectReject(
            db0.withReadConnection(async (db: ReadOnlyDatabase) => {
                seen.push(db as DatabaseSync)
            }),
            "INTERNAL_ERROR",
            "async-callback",
        )
        assert.equal(seen.length, 3)
        for (const db of seen) assert.equal(db.isOpen, false)
        assert.equal(openConnectionCount(), 0)
    })

    test("octet_length() is available on stored columns", async () => {
        const row = await access(newProfile()).withReadConnection(
            (db) =>
                db.prepare("SELECT octet_length(content) AS n, octet_length(title) AS t FROM items WHERE _id = 1").get() as {
                    n: number
                    t: number
                },
        )
        assert.equal(row.n, Buffer.byteLength("<p>Body 0</p>"))
        assert.equal(row.t, Buffer.byteLength("Synthetic title 0 àèì 中文 😀"))
    })

    test("schema verification reads only schema metadata and constants", async () => {
        const statements: string[] = []
        await access(newProfile()).withReadConnection((db) => {
            const recording: ReadOnlyDatabase = {
                prepare: ((sql: string) => {
                    statements.push(sql)
                    return db.prepare(sql)
                }) as ReadOnlyDatabase["prepare"],
            }
            verifyDatabase(recording)
        })
        assert.ok(statements.length > 0)
        for (const sql of statements) {
            assert.match(sql, /sqlite_schema|pragma_table_info|sqlite_version\(\)|PRAGMA encoding|octet_length\('é'\)/)
            assert.doesNotMatch(sql, /FROM\s+(items|sources)\b|count\(|quick_check|integrity_check|EXPLAIN/i)
        }
    })
})

describe("missing and incompatible databases", () => {
    test("a database missing at startup is PROFILE_UNAVAILABLE", () => {
        const profile = newProfile()
        fs.unlinkSync(profile.dbPath)
        expectError(() => new DatabaseAccess(profile.dbPath), "PROFILE_UNAVAILABLE", "db-missing")
        assert.equal(fs.existsSync(profile.dbPath), false)
    })

    test("a database deleted after startup is not recreated", async () => {
        const profile = newProfile()
        const db = access(profile)
        fs.unlinkSync(profile.dbPath)
        const initial = snapshotDir(profile.dir)
        await expectReject(db.withReadConnection(verifyDatabase), "PROFILE_UNAVAILABLE", "db-missing")
        assert.equal(fs.existsSync(profile.dbPath), false)
        assert.equal(openConnectionCount(), 0)
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    const variants = [
        ["missing-items", "missing-table"],
        ["missing-column", "missing-column"],
        ["wrong-type", "column-type"],
        ["wrong-pk", "primary-key"],
    ] as const
    for (const [schema, reason] of variants) {
        test(`schema variant ${schema} is SCHEMA_UNSUPPORTED (${reason})`, async () => {
            const profile = newProfile({ schema })
            const initial = snapshotDir(profile.dir)
            const error = await expectReject(access(profile).withReadConnection(verifyDatabase), "SCHEMA_UNSUPPORTED", reason)
            assert.ok(!JSON.stringify(error).includes(root))
            assert.deepEqual(snapshotDir(profile.dir), initial)
        })
    }

    test("a file that is not SQLite is SCHEMA_UNSUPPORTED and never opened by SQLite", async () => {
        const profile = newProfile()
        fs.writeFileSync(profile.dbPath, "this is not a database, but it is long enough to fill a header ".repeat(4))
        const initial = snapshotDir(profile.dir)
        await expectReject(access(profile).withReadConnection(verifyDatabase), "SCHEMA_UNSUPPORTED", "not-sqlite")
        fs.writeFileSync(profile.dbPath, "")
        await expectReject(access(profile).withReadConnection(verifyDatabase), "SCHEMA_UNSUPPORTED", "not-sqlite")
        assert.equal(snapshotDir(profile.dir).size, initial.size)
    })
})

describe("journal modes", () => {
    test("rollback journal: no auxiliary file is created", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const db = access(profile)
        for (let i = 0; i < 3; i++) await db.withReadConnection(verifyDatabase)
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("characterization: raw node:sqlite readOnly on WAL creates -wal/-shm (why the guard exists)", () => {
        const dir = path.join(root, "wal-raw")
        fs.mkdirSync(dir)
        const dbPath = path.join(dir, "raw.db")
        createDatabase(dbPath, { wal: true })
        assert.deepEqual(fs.readdirSync(dir), ["raw.db"])
        const db = new DatabaseSync(dbPath, { readOnly: true })
        try {
            db.prepare("SELECT count(*) FROM sources").get()
        } finally {
            db.close()
        }
        const created = fs.readdirSync(dir).filter((name) => name !== "raw.db").sort()
        assert.deepEqual(created, ["raw.db-shm", "raw.db-wal"])
    })

    test("WAL database: refused with DB_WAL_UNSUPPORTED, nothing created or changed", async () => {
        const profile = newProfile({ wal: true })
        const initial = snapshotDir(profile.dir)
        assert.deepEqual(header(profile.dbPath), [2, 2])
        await expectReject(access(profile).withReadConnection(verifyDatabase), "DB_WAL_UNSUPPORTED", "wal-mode")
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("leftover -wal/-shm next to a rollback database: refused, files untouched", async () => {
        for (const suffix of ["-wal", "-shm"]) {
            const profile = newProfile()
            fs.writeFileSync(profile.dbPath + suffix, Buffer.alloc(64))
            const initial = snapshotDir(profile.dir)
            await expectReject(access(profile).withReadConnection(verifyDatabase), "DB_WAL_UNSUPPORTED", "wal-files-present")
            assert.deepEqual(snapshotDir(profile.dir), initial)
        }
    })

    test("hot journal: DB_NEEDS_RECOVERY, database and journal unchanged", async () => {
        const profile = newProfile({ rows: 2000 })
        // A writer that dies mid-transaction leaves a hot journal.
        const script = `
            const { DatabaseSync } = require("node:sqlite");
            const db = new DatabaseSync(process.argv[1]);
            db.exec("PRAGMA cache_size = 2; BEGIN; UPDATE items SET content = hex(randomblob(600));");
            process.exit(0);`
        const child = spawnSync(process.execPath, ["-e", script, profile.dbPath], { encoding: "utf8" })
        assert.equal(child.status, 0, child.stderr)
        assert.ok(fs.existsSync(`${profile.dbPath}-journal`), "hot journal created")

        const initial = snapshotDir(profile.dir)
        await expectReject(access(profile).withReadConnection(verifyDatabase), "DB_NEEDS_RECOVERY", "hot-journal")
        assert.deepEqual(snapshotDir(profile.dir), initial)
        assert.equal(openConnectionCount(), 0)
    })
})

describe("concurrency and identity", () => {
    test("a replaced database file is DB_REPLACED until restart", async () => {
        const profile = newProfile()
        const db = access(profile)
        await db.withReadConnection(verifyDatabase)
        const replacement = `${profile.dbPath}.new`
        createDatabase(replacement)
        fs.renameSync(replacement, profile.dbPath)
        await expectReject(db.withReadConnection(verifyDatabase), "DB_REPLACED", "identity-changed")
        assert.equal(db.replaced, true)
        await expectReject(db.withReadConnection(verifyDatabase), "DB_REPLACED")
        assert.equal(openConnectionCount(), 0)
    })

    test(`a held lock is DB_BUSY after about BUSY_TIMEOUT_MS (${BUSY_TIMEOUT_MS} ms)`, async () => {
        const profile = newProfile()
        const db = access(profile)
        await db.withReadConnection(verifyDatabase)
        const writer = new DatabaseSync(profile.dbPath)
        try {
            writer.exec("BEGIN EXCLUSIVE")
            const started = Date.now()
            await expectReject(db.withReadConnection(verifyDatabase), "DB_BUSY", "busy")
            const elapsed = Date.now() - started
            assert.ok(elapsed >= BUSY_TIMEOUT_MS * 0.8, `waited ${elapsed} ms`)
            assert.ok(elapsed < BUSY_TIMEOUT_MS * 5, `waited ${elapsed} ms`)
        } finally {
            writer.exec("ROLLBACK")
            writer.close()
        }
        assert.equal(openConnectionCount(), 0)
        // The lock is gone: the same access works again.
        await db.withReadConnection(verifyDatabase)
    })
})

// ---------------------------------------------------------------------------
// FR-REV-001: preventive SHARED lock held by this Node process (Win32 via Koffi)
// ---------------------------------------------------------------------------

interface ApiTrace {
    readonly calls: string[]
    readonly opened: Win32Handle[]
    readonly closed: Win32Handle[]
    /** Handles open right now (Windows reuses handle values once closed). */
    readonly live: Set<Win32Handle>
    /** CloseHandle calls on a value that was not open at that moment. */
    invalidCloses: number
}

type Overrides = {
    [K in keyof Win32FileApi]?: (real: Win32FileApi, ...args: Parameters<Win32FileApi[K]>) => ReturnType<Win32FileApi[K]>
}

/** A lock factory over the real kernel32 binding, recording every Win32 call; failures can be injected. */
function traced(overrides: Overrides = {}): { lock: SqliteFileLock; trace: ApiTrace } {
    const real = bindKernel32()
    const trace: ApiTrace = { calls: [], opened: [], closed: [], live: new Set(), invalidCloses: 0 }
    const region = (offset: number): string =>
        offset === PENDING_BYTE ? "PENDING" : offset === SHARED_FIRST ? "SHARED" : String(offset)
    const api: Win32FileApi = {
        open(filePath) {
            trace.calls.push("open")
            const result = overrides.open ? overrides.open(real, filePath) : real.open(filePath)
            if ("handle" in result) {
                trace.opened.push(result.handle)
                trace.live.add(result.handle)
            }
            return result
        },
        lock(handle, flags, offset, length) {
            trace.calls.push(`lock ${region(offset)}/${length} flags=${flags}`)
            return overrides.lock ? overrides.lock(real, handle, flags, offset, length) : real.lock(handle, flags, offset, length)
        },
        unlock(handle, offset, length) {
            trace.calls.push(`unlock ${region(offset)}/${length}`)
            return overrides.unlock ? overrides.unlock(real, handle, offset, length) : real.unlock(handle, offset, length)
        },
        identity(handle) {
            trace.calls.push("identity")
            return overrides.identity ? overrides.identity(real, handle) : real.identity(handle)
        },
        close(handle) {
            trace.calls.push("close")
            trace.closed.push(handle)
            if (!trace.live.delete(handle)) trace.invalidCloses++
            return overrides.close ? overrides.close(real, handle) : real.close(handle)
        },
    }
    return { lock: new SqliteFileLock({ api: () => api }), trace }
}

/** Every handle opened was closed exactly once (no leak, no double close). */
function assertClosedExactlyOnce(trace: ApiTrace): void {
    assert.equal(trace.invalidCloses, 0, "no handle closed twice or closed while not open")
    assert.equal(trace.live.size, 0, "no handle left open")
    assert.equal(trace.closed.length, trace.opened.length, "one CloseHandle per CreateFileW")
}

const LOCK_CHILD = path.join(PROJECT_ROOT, "dist-test", "test", "helpers", "lock-child.js")

/** Starts a Node reader process and waits until it is stopped at `point` with the lock held. */
async function startStoppedReader(
    profile: ProfileFixture,
    point: "before-first-read" | "in-callback",
): Promise<{ child: ReturnType<typeof spawn>; exited: Promise<number | null> }> {
    counter++
    const marker = path.join(root, `marker-${counter}`)
    const child = spawn(process.execPath, [LOCK_CHILD, profile.dbPath, marker, point], { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)))
    const deadline = Date.now() + 15_000
    while (!fs.existsSync(marker)) {
        assert.equal(child.exitCode, null, `reader exited early: ${stderr}`)
        assert.ok(Date.now() < deadline, "reader did not reach the point")
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(fs.readFileSync(marker, "utf8"), point)
    return { child, exited }
}

describe("FR-REV-001: in-process Win32 lock (Koffi)", { skip: !isWindows }, () => {
    test("the Win32 calls follow SQLite 3.53.4 winLock(SHARED) and the locked handle is the database file", async () => {
        const profile = newProfile()
        const { lock, trace } = traced()
        let identity: { dev: bigint; ino: bigint; birthtimeNs: bigint } | undefined
        let heldDuring = -1
        let callsAtLock: string[] = []
        await access(
            profile,
            {
                afterLock: (held) => {
                    identity = { dev: held.dev, ino: held.ino, birthtimeNs: held.birthtimeNs }
                    heldDuring = lock.heldCount
                    callsAtLock = [...trace.calls]
                },
            },
            lock,
        ).withReadConnection(verifyDatabase)
        const fail = LOCKFILE_FAIL_IMMEDIATELY
        assert.deepEqual(callsAtLock, [
            "open",
            `lock PENDING/1 flags=${fail}`, // shared, fail-immediately (as SQLite does for SHARED)
            `lock SHARED/${SHARED_SIZE} flags=${fail}`,
            "unlock PENDING/1",
            "identity",
        ])
        assert.deepEqual(trace.calls.slice(callsAtLock.length), [`unlock SHARED/${SHARED_SIZE}`, "close"])
        assert.equal(heldDuring, 1)
        assert.equal(lock.heldCount, 0)
        assertClosedExactlyOnce(trace)
        const stats = fs.lstatSync(profile.dbPath, { bigint: true })
        assert.deepEqual(identity, { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs })
    })

    test("while held, other readers proceed and a writer cannot obtain EXCLUSIVE", async () => {
        const profile = newProfile()
        const seen: Record<string, string> = {}
        await access(profile, {
            afterLock: () => {
                seen.reader = runWriter(profile.dbPath, "SELECT count(*) AS n FROM sources", 0)
                seen.exclusive = writerExclusive(profile.dbPath)
                seen.write = runWriter(profile.dbPath, "UPDATE items SET starred = 1 WHERE _id = 1", 0)
            },
        }).withReadConnection(verifyDatabase)
        assert.match(seen.reader as string, /^OK \[\{"n":2\}\]$/, "SHARED locks are compatible")
        assert.equal(seen.exclusive, "ERR 5")
        assert.equal(seen.write, "ERR 5", "a write commit needs EXCLUSIVE")
        assert.match(writerExclusive(profile.dbPath), /^OK/, "released after the call")
    })

    test("characterization (Codex counterexample): without the lock, a switch after the header check makes the reader create -wal/-shm", () => {
        const profile = newProfile()
        assert.deepEqual(header(profile.dbPath), [1, 1], "header checked: rollback journal")
        // The concurrent writer switches to WAL and closes; its own -wal/-shm are removed at close.
        assert.match(runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 300), /^OK .*wal/)
        assert.deepEqual(inventory(profile.dir), ["config.json", "fluent-reader.db"], "writer left no auxiliary file")
        const db = new DatabaseSync(profile.dbPath, { readOnly: true })
        try {
            db.prepare("SELECT count(*) FROM sources").get()
        } finally {
            db.close()
        }
        // Files that appear now were created by the unprotected reader.
        assert.deepEqual(inventory(profile.dir), [
            "config.json",
            "fluent-reader.db",
            "fluent-reader.db-shm",
            "fluent-reader.db-wal",
        ])
    })

    test("regression: the rollback → WAL switch is refused at every critical point, up to after SQLite's close", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const outcomes: Record<string, string> = {}
        const inventories: Record<string, string[]> = {}
        let connectionsAtRelease = -1
        let heldAtRelease = false
        const attempt = (point: string): void => {
            outcomes[point] = runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 0)
            inventories[point] = inventory(profile.dir)
        }
        const capabilities = await access(profile, {
            afterLock: () => attempt("afterLock"),
            afterHeaderCheck: () => attempt("afterHeaderCheck"),
            beforeFirstRead: () => attempt("beforeFirstRead"), // the T1–T2 window of the counterexample
            afterOwnSharedLock: () => attempt("afterOwnSharedLock"),
            beforeRelease: (held) => {
                connectionsAtRelease = openConnectionCount()
                heldAtRelease = held.held
                attempt("beforeRelease") // SQLite closed: only this process's Win32 lock remains
            },
        }).withReadConnection(verifyDatabase)
        assert.equal(capabilities.octetLength, true)
        assert.deepEqual(outcomes, {
            afterLock: "ERR 5",
            afterHeaderCheck: "ERR 5",
            beforeFirstRead: "ERR 5",
            afterOwnSharedLock: "ERR 5",
            beforeRelease: "ERR 5",
        })
        assert.equal(connectionsAtRelease, 0, "SQLite connection already closed before the release")
        assert.equal(heldAtRelease, true, "the Win32 lock is still held at that point")
        for (const files of Object.values(inventories)) assert.deepEqual(files, ["config.json", "fluent-reader.db"])
        assert.deepEqual(snapshotDir(profile.dir), initial, "neither the writer nor the reader changed anything")
        assert.deepEqual(header(profile.dbPath), [1, 1])

        // Once released, the writer's switch succeeds (writer effect), and the
        // server then refuses the WAL database without touching any file.
        assert.match(runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 0), /^OK .*wal/)
        assert.deepEqual(header(profile.dbPath), [2, 2])
        const afterWriter = snapshotDir(profile.dir)
        assert.deepEqual([...afterWriter.keys()].sort(), ["config.json", "fluent-reader.db"])
        await expectReject(access(profile).withReadConnection(verifyDatabase), "DB_WAL_UNSUPPORTED", "wal-mode")
        assert.deepEqual(snapshotDir(profile.dir), afterWriter)
    })

    test("repeated: 20 switches injected in the T1–T2 window never succeed", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const outcomes: string[] = []
        const db = access(profile, {
            beforeFirstRead: () => outcomes.push(runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 50)),
        })
        for (let i = 0; i < 20; i++) await db.withReadConnection(verifyDatabase)
        assert.deepEqual(new Set(outcomes), new Set(["ERR 5"]))
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("Codex counterexample, process view: a reader stopped in the T1–T2 window keeps the lock until it dies, and dies with it", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const { child, exited } = await startStoppedReader(profile, "before-first-read")
        let whileStopped: string
        try {
            // The reader process holds the lock (and has SQLite open, before its first read).
            whileStopped = runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 0)
            // This process can still read concurrently (SHARED locks are compatible).
            await access(profile).withReadConnection(verifyDatabase)
        } finally {
            child.kill() // TerminateProcess: no cleanup code runs in the reader
        }
        assert.notEqual(await exited, 0)
        assert.equal(whileStopped, "ERR 5")
        assert.deepEqual(snapshotDir(profile.dir), initial, "nothing changed while the reader was stopped")
        // The OS closed the reader's handles: the lock is gone, and so is the reader.
        assert.match(runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 0), /^OK .*wal/)
        assert.deepEqual(inventory(profile.dir), ["config.json", "fluent-reader.db"], "no -wal/-shm left by the reader")
    })

    test("a reader process terminated during its callback releases the lock with its SQLite connection", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const { child, exited } = await startStoppedReader(profile, "in-callback")
        let whileStopped: string
        try {
            whileStopped = writerExclusive(profile.dbPath)
        } finally {
            child.kill()
        }
        await exited
        assert.equal(whileStopped, "ERR 5")
        assert.deepEqual(snapshotDir(profile.dir), initial)
        assert.match(writerExclusive(profile.dbPath), /^OK/, "EXCLUSIVE available immediately after the reader died")
    })

    test("a writer that already holds RESERVED: reads proceed, its commit waits for the release and then succeeds", async () => {
        const profile = newProfile()
        const writer = new DatabaseSync(profile.dbPath, { timeout: 0 })
        try {
            writer.exec("BEGIN IMMEDIATE")
            writer.exec("UPDATE items SET hasRead = 1 WHERE _id = 1")
            let commitDuringRead = ""
            const read = await access(profile, {
                beforeRelease: () => {
                    try {
                        writer.exec("COMMIT")
                        commitDuringRead = "committed"
                    } catch (error) {
                        commitDuringRead = `ERR ${(error as { errcode?: number }).errcode}`
                    }
                },
            }).withReadConnection(
                (db) => db.prepare("SELECT hasRead FROM items WHERE _id = 1").get() as { hasRead: number },
            )
            assert.equal(read.hasRead, 0, "uncommitted change not visible")
            assert.equal(commitDuringRead, "ERR 5", "EXCLUSIVE refused while the Win32 lock is held")
            writer.exec("COMMIT") // succeeds: the server released every lock
            assert.equal(writer.isTransaction, false)
            assert.deepEqual(header(profile.dbPath), [1, 1])
        } finally {
            if (writer.isTransaction) writer.exec("ROLLBACK")
            writer.close()
        }
        const after = await access(profile).withReadConnection(
            (db) => db.prepare("SELECT hasRead FROM items WHERE _id = 1").get() as { hasRead: number },
        )
        assert.equal(after.hasRead, 1)
    })

    test("a writer waiting for EXCLUSIVE (PENDING held) is not starved: the server backs off with DB_BUSY", async () => {
        const profile = newProfile()
        const otherReader = new DatabaseSync(profile.dbPath, { readOnly: true })
        const writer = new DatabaseSync(profile.dbPath, { timeout: 0 })
        let lockedCalls = 0
        try {
            otherReader.exec("BEGIN")
            otherReader.prepare("SELECT count(*) FROM sources").get() // SHARED held by another reader
            writer.exec("BEGIN IMMEDIATE")
            writer.exec("UPDATE items SET starred = 1 WHERE _id = 2")
            // COMMIT fails on the other reader's SHARED lock; the writer keeps PENDING.
            assert.throws(() => writer.exec("COMMIT"), (error: { errcode?: number }) => error.errcode === 5)
            await expectReject(
                access(profile, { afterLock: () => lockedCalls++ }).withReadConnection(verifyDatabase),
                "DB_BUSY",
                "busy",
            )
            assert.equal(lockedCalls, 0, "the lock was never obtained, SQLite never opened")
            otherReader.exec("COMMIT")
            writer.exec("COMMIT") // the writer gets EXCLUSIVE now
        } finally {
            if (writer.isTransaction) writer.exec("ROLLBACK")
            writer.close()
            otherReader.close()
        }
        await access(profile).withReadConnection(verifyDatabase)
    })

    test("a WAL writer holding its connection open: refused, its -wal/-shm untouched by the server", async () => {
        const profile = newProfile({ wal: true })
        const writer = new DatabaseSync(profile.dbPath)
        try {
            writer.exec("INSERT INTO sources (sid, url, name, lastFetched) VALUES (50, 'https://w.invalid/50', 'w', 0)")
            const writerFiles = snapshotDir(profile.dir)
            assert.ok(writerFiles.has("fluent-reader.db-wal") && writerFiles.has("fluent-reader.db-shm"), "writer's own files")
            await expectReject(access(profile).withReadConnection(verifyDatabase), "DB_WAL_UNSUPPORTED", "wal-files-present")
            assert.deepEqual(snapshotDir(profile.dir), writerFiles)
        } finally {
            writer.close()
        }
    })

    test("concurrent reads and writes: writer never fails, no WAL file ever appears", async () => {
        const profile = newProfile()
        const script = `
            const { DatabaseSync } = require("node:sqlite");
            const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
            const pause = new Int32Array(new SharedArrayBuffer(4));
            let ok = 0, failed = 0;
            for (let i = 0; i < 150; i++) {
                try { db.exec("INSERT INTO sources (sid, url, name, lastFetched) VALUES (" + (1000 + i) + ", 'https://w.invalid/" + i + "', 'w', 0)"); ok++; }
                catch (e) { failed++; }
                Atomics.wait(pause, 0, 0, 2);
            }
            db.close();
            console.log(JSON.stringify({ ok, failed }));`
        const child = spawn(process.execPath, ["-e", script, profile.dbPath], { stdio: ["ignore", "pipe", "pipe"] })
        let out = ""
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk))
        const exited = new Promise<number | null>((resolve) => child.once("close", resolve))

        const db = access(profile)
        let reads = 0
        let busy = 0
        const seen = new Set<string>()
        let running = true
        void exited.then(() => (running = false))
        while (running) {
            try {
                await db.withReadConnection(verifyDatabase)
                reads++
            } catch (error) {
                assert.ok(error instanceof FrMcpError && error.code === "DB_BUSY", String(error))
                busy++
            }
            for (const name of inventory(profile.dir)) seen.add(name)
            // A successful read completes without I/O callbacks: yield so the child's events are processed.
            await new Promise((resolve) => setImmediate(resolve))
        }
        assert.equal(await exited, 0)
        assert.deepEqual(JSON.parse(out), { ok: 150, failed: 0 }, "the writer was never refused")
        assert.ok(reads > 0, `reads ${reads}, busy ${busy}`)
        assert.ok(!seen.has("fluent-reader.db-wal") && !seen.has("fluent-reader.db-shm"), [...seen].join(","))
        // Only the writer's own rollback journal may have been observed, transiently.
        assert.deepEqual(inventory(profile.dir), ["config.json", "fluent-reader.db"])
        assert.deepEqual(header(profile.dbPath), [1, 1])
        assert.equal(fileLock().heldCount, 0)
    })

    test("concurrent requests from several accessors share the file without leaking handles", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const { lock, trace } = traced()
        const accessors = [access(profile, undefined, lock), access(profile, undefined, lock), access(profile, undefined, lock)]
        let maxHeld = 0
        const calls = accessors.flatMap((a) =>
            Array.from({ length: 10 }, () =>
                a.withReadConnection((db) => {
                    maxHeld = Math.max(maxHeld, lock.heldCount)
                    return verifyDatabase(db)
                }),
            ),
        )
        const results = await Promise.all(calls)
        assert.equal(results.length, 30)
        // Each attempt runs synchronously, so attempts never overlap inside one process.
        assert.equal(maxHeld, 1)
        assert.equal(lock.heldCount, 0)
        assert.equal(openConnectionCount(), 0)
        assert.equal(trace.opened.length, 30)
        assertClosedExactlyOnce(trace)
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("the database and its directory cannot be replaced, renamed or deleted while the lock is held", async () => {
        const profile = newProfile()
        const other = `${profile.dbPath}.other`
        createDatabase(other)
        const initial = snapshotDir(profile.dir)
        const codes: string[] = []
        await access(profile, {
            afterLock: () => {
                for (const attempt of [
                    () => fs.renameSync(other, profile.dbPath),
                    () => fs.renameSync(profile.dbPath, `${profile.dbPath}.moved`),
                    () => fs.unlinkSync(profile.dbPath),
                    () => fs.renameSync(profile.dir, `${profile.dir}-moved`),
                ]) {
                    try {
                        attempt()
                        codes.push("succeeded")
                    } catch (error) {
                        codes.push((error as { code?: string }).code ?? "error")
                    }
                }
            },
        }).withReadConnection(verifyDatabase)
        // Replacing gives EPERM (access denied), renaming/deleting EBUSY (sharing violation).
        assert.equal(codes.length, 4)
        for (const code of codes) assert.ok(code === "EPERM" || code === "EBUSY", codes.join(","))
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("a locked handle whose identity differs from the path is DB_REPLACED before SQLite opens the file", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const { lock, trace } = traced({
            identity: (real, handle) => {
                const id = real.identity(handle)
                return "error" in id ? id : { ...id, ino: id.ino + 1n }
            },
        })
        let reachedHeaderCheck = false
        const db = access(profile, { afterHeaderCheck: () => (reachedHeaderCheck = true) }, lock)
        await expectReject(db.withReadConnection(verifyDatabase), "DB_REPLACED", "identity-changed")
        assert.equal(db.replaced, true)
        assert.equal(reachedHeaderCheck, false)
        assert.equal(openConnectionCount(), 0)
        assertClosedExactlyOnce(trace)
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("after a call the handle is closed: the file can be renamed and EXCLUSIVE is available at once", async () => {
        const profile = newProfile()
        const { lock, trace } = traced()
        let held: { release(): void; readonly held: boolean } | undefined
        await access(profile, { afterLock: (h) => (held = h) }, lock).withReadConnection(verifyDatabase)
        assert.equal(held?.held, false)
        held?.release() // idempotent: no second CloseHandle
        assertClosedExactlyOnce(trace)
        assert.equal(trace.closed.length, 1)
        assert.equal(lock.heldCount, 0)
        // A handle without FILE_SHARE_DELETE would make this rename fail.
        fs.renameSync(profile.dbPath, `${profile.dbPath}.moved`)
        fs.renameSync(`${profile.dbPath}.moved`, profile.dbPath)
        assert.match(writerExclusive(profile.dbPath), /^OK/)
    })

    describe("Win32 failures during acquisition (injected)", () => {
        const cases: ReadonlyArray<{
            name: string
            overrides: Overrides
            code: string
            reason: string
        }> = [
            { name: "CreateFileW: access denied", overrides: { open: () => ({ error: ERROR_ACCESS_DENIED }) }, code: "DB_UNREADABLE", reason: "io" },
            { name: "CreateFileW: sharing violation (persistent)", overrides: { open: () => ({ error: ERROR_SHARING_VIOLATION }) }, code: "DB_BUSY", reason: "busy" },
            {
                name: "LockFileEx(PENDING): invalid handle",
                overrides: { lock: (real, h, f, o, l) => (o === PENDING_BYTE ? ERROR_INVALID_HANDLE : real.lock(h, f, o, l)) },
                code: "DB_PROTECTION_UNAVAILABLE",
                reason: "lock-failed",
            },
            {
                name: "LockFileEx(SHARED): lock violation (persistent)",
                overrides: { lock: (real, h, f, o, l) => (o === SHARED_FIRST ? ERROR_LOCK_VIOLATION : real.lock(h, f, o, l)) },
                code: "DB_BUSY",
                reason: "busy",
            },
            {
                name: "LockFileEx(SHARED): unexpected error",
                overrides: { lock: (real, h, f, o, l) => (o === SHARED_FIRST ? ERROR_INVALID_HANDLE : real.lock(h, f, o, l)) },
                code: "DB_PROTECTION_UNAVAILABLE",
                reason: "lock-failed",
            },
            {
                name: "UnlockFileEx(PENDING) fails",
                overrides: { unlock: (real, h, o, l) => (o === PENDING_BYTE ? ERROR_INVALID_HANDLE : real.unlock(h, o, l)) },
                code: "DB_PROTECTION_UNAVAILABLE",
                reason: "lock-failed",
            },
            {
                name: "GetFileInformationByHandle fails",
                overrides: { identity: () => ({ error: ERROR_INVALID_HANDLE }) },
                code: "DB_PROTECTION_UNAVAILABLE",
                reason: "lock-failed",
            },
            {
                name: "the binding throws",
                overrides: {
                    lock: () => {
                        throw new Error("koffi conversion error with C:\\private\\path")
                    },
                },
                code: "DB_PROTECTION_UNAVAILABLE",
                reason: "lock-failed",
            },
        ]
        for (const { name, overrides, code, reason } of cases) {
            test(`${name}: ${code}, SQLite never opened, no handle left`, async () => {
                const profile = newProfile()
                const initial = snapshotDir(profile.dir)
                const { lock, trace } = traced(overrides)
                let reachedLock = false
                const error = await expectReject(
                    access(profile, { afterLock: () => (reachedLock = true) }, lock).withReadConnection(verifyDatabase),
                    code,
                    reason,
                )
                assert.ok(!JSON.stringify(error).includes(root) && !error.message.includes("private"))
                assert.equal(reachedLock, false)
                assert.equal(openConnectionCount(), 0)
                assert.equal(lock.heldCount, 0)
                assertClosedExactlyOnce(trace)
                assert.match(writerExclusive(profile.dbPath), /^OK/, "no lock left behind")
                assert.deepEqual(snapshotDir(profile.dir), initial)
            })
        }

        test("UnlockFileEx fails at release: the handle is still closed once, the call fails safely", async () => {
            const profile = newProfile()
            const { lock, trace } = traced({
                unlock: (real, h, o, l) => (o === SHARED_FIRST ? ERROR_INVALID_HANDLE : real.unlock(h, o, l)),
            })
            await expectReject(access(profile, undefined, lock).withReadConnection(verifyDatabase), "INTERNAL_ERROR", "lock-release")
            assert.equal(lock.heldCount, 0)
            assertClosedExactlyOnce(trace)
            assert.match(writerExclusive(profile.dbPath), /^OK/, "closing the handle dropped its locks")
        })

        test("FFI unavailable or unsupported platform: sanitized DB_PROTECTION_UNAVAILABLE, no file touched", async () => {
            const profile = newProfile()
            const initial = snapshotDir(profile.dir)
            const variants: ReadonlyArray<[SqliteFileLock, string]> = [
                [
                    new SqliteFileLock({
                        api: () => {
                            throw new Error("Cannot find the native Koffi module at C:\\private\\path")
                        },
                    }),
                    "ffi-unavailable",
                ],
                [new SqliteFileLock({ platform: "linux" }), "unsupported-platform"],
                [new SqliteFileLock({ arch: "arm64" }), "unsupported-platform"],
                [new SqliteFileLock({ arch: "ia32" }), "unsupported-platform"],
            ]
            for (const [lock, reason] of variants) {
                const error = await expectReject(
                    access(profile, undefined, lock).withReadConnection(verifyDatabase),
                    "DB_PROTECTION_UNAVAILABLE",
                    reason,
                )
                assert.ok(!error.message.includes("private") && !JSON.stringify(error).includes(root))
            }
            assert.equal(openConnectionCount(), 0)
            assert.deepEqual(snapshotDir(profile.dir), initial)
        })
    })

    describe("lifecycle", () => {
        test("close() during a read does not release the lock early; later calls are refused", async () => {
            const profile = newProfile()
            const initial = snapshotDir(profile.dir)
            const { lock, trace } = traced()
            let atRelease = ""
            let inCallback = ""
            const db = access(profile, { beforeRelease: () => (atRelease = writerExclusive(profile.dbPath)) }, lock)
            await db.withReadConnection((conn) => {
                lock.close()
                inCallback = writerExclusive(profile.dbPath)
                return verifyDatabase(conn)
            })
            assert.equal(inCallback, "ERR 5")
            assert.equal(atRelease, "ERR 5", "still held after close(), until SQLite is closed")
            assert.equal(lock.heldCount, 0)
            assertClosedExactlyOnce(trace)
            assert.match(writerExclusive(profile.dbPath), /^OK/)
            const opened = trace.opened.length
            await expectReject(db.withReadConnection(verifyDatabase), "DB_PROTECTION_UNAVAILABLE", "closed")
            assert.equal(trace.opened.length, opened, "no handle opened after close()")
            assert.equal(openConnectionCount(), 0)
            assert.deepEqual(snapshotDir(profile.dir), initial)
        })

        test("a call queued behind close() fails safely", async () => {
            const profile = newProfile()
            const lock = new SqliteFileLock()
            const db = access(profile, undefined, lock)
            const first = db.withReadConnection(verifyDatabase)
            const queued = db.withReadConnection(verifyDatabase)
            lock.close()
            await expectReject(first, "DB_PROTECTION_UNAVAILABLE", "closed")
            await expectReject(queued, "DB_PROTECTION_UNAVAILABLE", "closed")
            assert.equal(lock.heldCount, 0)
            assert.equal(openConnectionCount(), 0)
        })

        test("an exception in the callback or in SQLite's first read releases everything", async () => {
            const profile = newProfile({ rows: 2000 })
            const { lock, trace } = traced()
            const db = access(profile, undefined, lock)
            await expectReject(
                db.withReadConnection(() => {
                    throw new Error("callback failure")
                }),
                "INTERNAL_ERROR",
                "unexpected",
            )
            assert.equal(lock.heldCount, 0)
            assert.equal(openConnectionCount(), 0)
            // First read failing: a hot journal makes SQLite refuse the read (SQLITE_READONLY_ROLLBACK).
            const script = `
                const { DatabaseSync } = require("node:sqlite");
                const db = new DatabaseSync(process.argv[1]);
                db.exec("PRAGMA cache_size = 2; BEGIN; UPDATE items SET content = hex(randomblob(600));");
                process.exit(0);`
            assert.equal(spawnSync(process.execPath, ["-e", script, profile.dbPath]).status, 0)
            const withJournal = snapshotDir(profile.dir)
            await expectReject(db.withReadConnection(verifyDatabase), "DB_NEEDS_RECOVERY", "hot-journal")
            assert.equal(lock.heldCount, 0)
            assert.equal(openConnectionCount(), 0)
            assertClosedExactlyOnce(trace)
            assert.deepEqual(snapshotDir(profile.dir), withJournal, "database and journal untouched")
        })

        test("a lock released early (invariant violation) stops the call before SQLite opens the file", async () => {
            const profile = newProfile()
            const { lock, trace } = traced()
            let reachedHeaderCheck = false
            await expectReject(
                access(profile, { afterLock: (held) => held.release(), afterHeaderCheck: () => (reachedHeaderCheck = true) }, lock).withReadConnection(
                    verifyDatabase,
                ),
                "DB_PROTECTION_UNAVAILABLE",
                "lock-failed",
            )
            assert.equal(reachedHeaderCheck, false)
            assert.equal(openConnectionCount(), 0)
            assertClosedExactlyOnce(trace)
            assert.equal(trace.closed.length, 1)
        })
    })

    test("many reads leave the synthetic profile byte-for-byte unchanged and create no auxiliary file", async () => {
        const profile = newProfile({ rows: 200 })
        const initial = snapshotDir(profile.dir)
        const initialStats = fs.statSync(profile.dbPath, { bigint: true })
        const db = access(profile)
        for (let i = 0; i < 25; i++) {
            await db.withReadConnection((conn) => {
                verifyDatabase(conn)
                return conn.prepare("SELECT count(*) AS n FROM items").get()
            })
        }
        assert.deepEqual(snapshotDir(profile.dir), initial)
        assert.deepEqual(inventory(profile.dir), ["config.json", "fluent-reader.db"])
        for (const suffix of AUX_SUFFIXES) assert.equal(fs.existsSync(profile.dbPath + suffix), false)
        const stats = fs.statSync(profile.dbPath, { bigint: true })
        assert.equal(stats.mtimeNs, initialStats.mtimeNs)
        assert.equal(stats.size, initialStats.size)
    })
})
