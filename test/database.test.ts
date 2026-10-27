import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, test } from "node:test"
import {
    BUSY_TIMEOUT_MS,
    DatabaseAccess,
    openConnectionCount,
    sharedLock,
    type DatabaseAccessHooks,
    type ReadOnlyDatabase,
} from "../src/db/connection.js"
import { verifyDatabase } from "../src/db/schema.js"
import { SqliteSharedLock } from "../src/db/shared-lock.js"
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

const isWindows = process.platform === "win32"

let root: string
let counter = 0

before(() => {
    root = createTempRoot()
})
after(async () => {
    await sharedLock().close()
    removeTempRoot(root)
})

function newProfile(db: DatabaseOptions = {}): ProfileFixture {
    counter++
    return createProfile(path.join(root, `db${counter}`), { db })
}

function access(profile: ProfileFixture, hooks?: DatabaseAccessHooks, lock?: SqliteSharedLock): DatabaseAccess {
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

/** Waits synchronously until a process has terminated. */
function waitUntilDead(pid: number): void {
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 10_000
    for (;;) {
        try {
            process.kill(pid, 0)
        } catch {
            return
        }
        assert.ok(Date.now() < deadline, "helper did not terminate")
        Atomics.wait(sleeper, 0, 0, 10)
    }
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
        await db.withReadConnection(verifyDatabase) // helper started
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

describe("FR-REV-001: preventive lock against a concurrent rollback → WAL switch", { skip: !isWindows }, () => {
    test("characterization (Codex experiment): without the lock, a switch after the header check makes the reader create -wal/-shm", () => {
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

    test("regression: the same switch at the critical point is blocked and no file changes", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        let writerDuringRead = ""
        let inventoryDuringRead: string[] = []
        const db = access(profile, {
            afterHeaderCheck: () => {
                writerDuringRead = runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 300)
                inventoryDuringRead = inventory(profile.dir)
            },
        })
        const capabilities = await db.withReadConnection(verifyDatabase)
        assert.equal(capabilities.octetLength, true)
        assert.equal(writerDuringRead, "ERR 5", "the switch needs EXCLUSIVE and gets SQLITE_BUSY")
        assert.deepEqual(inventoryDuringRead, ["config.json", "fluent-reader.db"])
        // Content and inventory unchanged: neither the writer nor the server changed anything.
        assert.deepEqual(snapshotDir(profile.dir), initial)
        assert.deepEqual(header(profile.dbPath), [1, 1])

        // Once released, the writer's switch succeeds (writer effect), and the
        // server then refuses the WAL database without touching any file.
        assert.match(runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 300), /^OK .*wal/)
        assert.deepEqual(header(profile.dbPath), [2, 2])
        const afterWriter = snapshotDir(profile.dir)
        assert.deepEqual([...afterWriter.keys()].sort(), ["config.json", "fluent-reader.db"])
        await expectReject(db.withReadConnection(verifyDatabase), "DB_WAL_UNSUPPORTED", "wal-mode")
        assert.deepEqual(snapshotDir(profile.dir), afterWriter)
    })

    test("repeated: 20 switches injected at the critical point never succeed", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const outcomes: string[] = []
        const db = access(profile, {
            afterHeaderCheck: () => outcomes.push(runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 50)),
        })
        for (let i = 0; i < 20; i++) await db.withReadConnection(verifyDatabase)
        assert.deepEqual(new Set(outcomes), new Set(["ERR 5"]))
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("a writer holding an open connection (rollback) does not prevent reads; its writes then succeed", async () => {
        const profile = newProfile()
        const writer = new DatabaseSync(profile.dbPath, { timeout: 5000 })
        try {
            writer.prepare("SELECT count(*) FROM items").get()
            const before = inventory(profile.dir)
            await access(profile).withReadConnection(verifyDatabase)
            assert.deepEqual(inventory(profile.dir), before)
            writer.exec("BEGIN IMMEDIATE")
            writer.exec("UPDATE items SET hasRead = 1 WHERE _id = 1")
            // RESERVED held by the writer: readers are still allowed.
            const read = await access(profile).withReadConnection(
                (db) => db.prepare("SELECT hasRead FROM items WHERE _id = 1").get() as { hasRead: number },
            )
            assert.equal(read.hasRead, 0, "uncommitted change not visible")
            writer.exec("COMMIT") // succeeds: the server released every lock
            assert.deepEqual(header(profile.dbPath), [1, 1])
        } finally {
            writer.close()
        }
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
        }
        assert.equal(await exited, 0)
        assert.deepEqual(JSON.parse(out), { ok: 150, failed: 0 }, "the writer was never refused")
        assert.ok(reads > 0, `reads ${reads}, busy ${busy}`)
        assert.ok(!seen.has("fluent-reader.db-wal") && !seen.has("fluent-reader.db-shm"), [...seen].join(","))
        // Only the writer's own rollback journal may have been observed, transiently.
        assert.deepEqual(inventory(profile.dir), ["config.json", "fluent-reader.db"])
        assert.deepEqual(header(profile.dbPath), [1, 1])
    })

    test("the database cannot be replaced, renamed or deleted while the lock is held", async () => {
        const profile = newProfile()
        const other = `${profile.dbPath}.other`
        createDatabase(other)
        const initial = snapshotDir(profile.dir)
        const codes: string[] = []
        await access(profile, {
            afterHeaderCheck: () => {
                for (const attempt of [
                    () => fs.renameSync(other, profile.dbPath),
                    () => fs.renameSync(profile.dbPath, `${profile.dbPath}.moved`),
                    () => fs.unlinkSync(profile.dbPath),
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
        assert.equal(codes.length, 3)
        for (const code of codes) assert.ok(code === "EPERM" || code === "EBUSY", codes.join(","))
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("after a call the lock is released: a writer obtains EXCLUSIVE immediately", async () => {
        const profile = newProfile()
        await access(profile).withReadConnection(verifyDatabase)
        assert.match(runWriter(profile.dbPath, "UPDATE items SET starred = 1 WHERE _id = 1", 0), /^OK/)
    })

    test("after close() a late or queued call fails safely and starts no new helper", async () => {
        const profile = newProfile()
        const lock = new SqliteSharedLock()
        const db = access(profile, undefined, lock)
        await db.withReadConnection(verifyDatabase)
        const queued = db.withReadConnection(verifyDatabase)
        const closing = lock.close()
        // The queued call either completed before close() or was refused; nothing is left running.
        await queued.catch((error: unknown) => {
            assert.ok(error instanceof FrMcpError && error.code === "DB_PROTECTION_UNAVAILABLE", String(error))
        })
        await closing
        await expectReject(db.withReadConnection(verifyDatabase), "DB_PROTECTION_UNAVAILABLE", "helper-unavailable")
        assert.equal(lock.pid, undefined)
        assert.equal(lock.isAliveSync(), false)
    })

    test("a helper that cannot start prevents SQLite from opening the database", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        let reachedHeaderCheck = false
        const broken = new SqliteSharedLock({ executable: path.join(root, "missing-helper.exe") })
        await expectReject(
            access(profile, { afterHeaderCheck: () => (reachedHeaderCheck = true) }, broken).withReadConnection(verifyDatabase),
            "DB_PROTECTION_UNAVAILABLE",
            "helper-unavailable",
        )
        assert.equal(reachedHeaderCheck, false)
        assert.equal(openConnectionCount(), 0)
        assert.deepEqual(snapshotDir(profile.dir), initial)
    })

    test("a helper lost before SQLite's first read stops the call before any read; the next call recovers", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const lock = new SqliteSharedLock()
        let reachedOwnLock = false
        let writerAfterKill = ""
        try {
            const db = access(
                profile,
                {
                    afterHeaderCheck: () => {
                        const pid = lock.pid
                        assert.ok(pid !== undefined)
                        lock.terminate()
                        waitUntilDead(pid)
                        // Protection is gone: a concurrent switch now succeeds (writer effect).
                        writerAfterKill = runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 300)
                    },
                    afterOwnSharedLock: () => (reachedOwnLock = true),
                },
                lock,
            )
            await expectReject(db.withReadConnection(verifyDatabase), "DB_PROTECTION_UNAVAILABLE", "helper-lost")
            assert.match(writerAfterKill, /^OK .*wal/)
            assert.equal(reachedOwnLock, false, "no read after the loss")
            assert.equal(openConnectionCount(), 0)
            // The server did not create -wal/-shm: only the writer's header change is visible.
            assert.deepEqual(inventory(profile.dir), ["config.json", "fluent-reader.db"])
            assert.deepEqual(snapshotDir(profile.dir).get("config.json"), initial.get("config.json"))

            // Next call: a new helper is started and the (now WAL) database is refused safely.
            const next = access(profile, undefined, lock)
            await expectReject(next.withReadConnection(verifyDatabase), "DB_WAL_UNSUPPORTED", "wal-mode")
            assert.deepEqual(inventory(profile.dir), ["config.json", "fluent-reader.db"])
        } finally {
            await lock.close()
        }
    })

    test("a helper lost after SQLite holds its own SHARED lock does not invalidate the read", async () => {
        const profile = newProfile()
        const initial = snapshotDir(profile.dir)
        const lock = new SqliteSharedLock()
        let writerAfterKill = ""
        try {
            const db = access(
                profile,
                {
                    afterOwnSharedLock: () => {
                        const pid = lock.pid
                        assert.ok(pid !== undefined)
                        lock.terminate()
                        waitUntilDead(pid)
                        writerAfterKill = runWriter(profile.dbPath, "PRAGMA journal_mode = WAL", 300)
                    },
                },
                lock,
            )
            await db.withReadConnection(verifyDatabase)
            assert.equal(writerAfterKill, "ERR 5", "this connection's own SHARED lock still blocks the switch")
            assert.deepEqual(snapshotDir(profile.dir), initial)
            await access(profile, undefined, lock).withReadConnection(verifyDatabase)
        } finally {
            await lock.close()
        }
    })
})
