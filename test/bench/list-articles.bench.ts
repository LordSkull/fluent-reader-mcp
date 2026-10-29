/**
 * FR-MCP-02B-01 stress benchmark of list_articles. Not part of `npm test`:
 * run it explicitly (after `npm run pretest` or `tsc -p tsconfig.test.json`):
 *
 *   node dist-test/test/bench/list-articles.bench.js [rows ...]
 *
 * Default rows: 100000 500000. Everything is synthetic, generated under the
 * system temp directory and deleted at the end. Records are kept small
 * (about 1 KB: 600-byte content, 300-byte snippet) so that 500 000 rows stay
 * around 0.5 GB; one extra profile of 20 000 records with 50 KB of content
 * measures the byte budget. Prints one JSON report on stdout.
 *
 * Reported times are observations on this machine, not guarantees.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { closeAllConnections, DatabaseAccess, fileLock } from "../../src/db/connection.js"
import { SCAN_SQL } from "../../src/domain/article-scan.js"
import { FrMcpError } from "../../src/errors.js"
import { createToolContext } from "../../src/tools/context.js"
import { DEFAULT_SCAN_LIMITS, listArticles } from "../../src/tools/list-articles.js"
import type { ListArticlesOutput } from "../../src/tools/schemas.js"
import { CONFIG_NAME, DB_NAME, ITEMS_DDL, SOURCES_DDL } from "../helpers/fixtures.js"

const T0 = Date.UTC(2020, 0, 1)

function build(dir: string, rows: number, contentBytes: number, snippetBytes: number): string {
    fs.mkdirSync(dir, { recursive: true })
    const dbPath = path.join(dir, DB_NAME)
    const db = new DatabaseSync(dbPath)
    try {
        db.exec(`${SOURCES_DDL}\n${ITEMS_DDL}`)
        db.exec("BEGIN")
        const source = db.prepare("INSERT INTO sources (sid, url, name, lastFetched, hidden) VALUES (?, ?, ?, 0, ?)")
        for (let sid = 0; sid < 50; sid++) source.run(sid, `https://feed.invalid/${sid}.xml`, `Bench source ${sid}`, sid === 49 ? 1 : 0)
        const item = db.prepare(
            "INSERT INTO items (source, guid, title, link, date, fetchedDate, content, snippet, creator, hasRead, starred, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        const content = "<p>" + "c".repeat(Math.max(0, contentBytes - 7)) + "</p>"
        const snippet = "s".repeat(snippetBytes)
        for (let i = 1; i <= rows; i++) {
            item.run(
                i % 50,
                `guid-${i}`,
                `Bench article ${i}`,
                `https://article.invalid/${i}`,
                T0 + i * 60_000,
                T0 + i * 60_000 + 1000,
                content,
                snippet,
                i % 7 === 0 ? "Bench author" : null,
                i % 3 === 0 ? 1 : 0,
                i % 10_000 === 0 ? 1 : 0, // very selective: 1 in 10 000
                i % 97 === 0 ? 1 : 0,
            )
            if (i % 50_000 === 0) {
                db.exec("COMMIT")
                db.exec("BEGIN")
            }
        }
        db.exec("COMMIT")
    } finally {
        db.close()
    }
    fs.writeFileSync(path.join(dir, CONFIG_NAME), JSON.stringify({ sourceGroups: [{ gid: 0, isMultiple: true, sids: [1, 2, 3], name: "Bench" }], sourceRules: {} }))
    return dbPath
}

interface CallStat {
    readonly ms: number
    readonly returned: number
    readonly examined: number
    readonly stoppedBy: string
    /** DB_BUSY answers before this call succeeded with the same cursor. */
    readonly busyRetries: number
}

function summarize(calls: readonly CallStat[]): Record<string, unknown> {
    const ms = calls.map((c) => c.ms).sort((a, b) => a - b)
    const pct = (p: number): number => Number((ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))] ?? 0).toFixed(2))
    return {
        calls: calls.length,
        returned: calls.reduce((n, c) => n + c.returned, 0),
        examined: calls.reduce((n, c) => n + c.examined, 0),
        maxExaminedPerCall: Math.max(...calls.map((c) => c.examined)),
        msP50: pct(50),
        msP95: pct(95),
        msMax: Number((ms.at(-1) ?? 0).toFixed(2)),
        stoppedBy: [...new Set(calls.map((c) => c.stoppedBy))],
        dbBusyRetries: calls.reduce((n, c) => n + c.busyRetries, 0),
    }
}

async function listing(dir: string, args: Record<string, unknown>, maxCalls = Number.POSITIVE_INFINITY): Promise<CallStat[]> {
    const context = createToolContext({ database: new DatabaseAccess(path.join(dir, DB_NAME)), configPath: path.join(dir, CONFIG_NAME), profileDir: dir })
    const calls: CallStat[] = []
    let cursor: string | null = null
    do {
        let busyRetries = 0
        let result: Awaited<ReturnType<typeof listArticles>> | undefined
        let ms = 0
        while (result === undefined) {
            const started = performance.now()
            try {
                result = await listArticles(context, cursor === null ? args : { cursor })
            } catch (error) {
                // DB_BUSY leaves the cursor unchanged: retry it, as a client would (counted, at most 100 times).
                if (!(error instanceof FrMcpError) || error.code !== "DB_BUSY" || ++busyRetries > 100) throw error
            }
            ms = performance.now() - started
        }
        if (result.isError) throw new Error(`list_articles failed: ${JSON.stringify(result.content)}`)
        const page = result.structuredContent as ListArticlesOutput
        calls.push({ ms, returned: page.articles.length, examined: page.scan.examined, stoppedBy: page.scan.stoppedBy, busyRetries })
        cursor = page.nextCursor
    } while (cursor !== null && calls.length < maxCalls)
    return calls
}

function plans(dbPath: string): Record<string, string> {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
        const plan = (sql: string, ...params: unknown[]): string =>
            ((db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all as (...a: unknown[]) => { detail: string }[])(...params)).map((r) => r.detail).join(" | ")
        return {
            bounds: plan(SCAN_SQL.bounds),
            candidates: plan(SCAN_SQL.candidates, 1, 1000, 256),
            evaluate: plan(SCAN_SQL.evaluate, 1, 1000),
            project: plan(SCAN_SQL.project, { ids: "[1,2]", chars: 200 }),
            position: plan(SCAN_SQL.position, 1),
            sourceUrls: plan(SCAN_SQL.sourceUrls, "[1,2]"),
        }
    } finally {
        db.close()
    }
}

/** Phase A (header only) against phase B (traverses records) on the same windows, read-only. */
function phases(dbPath: string, hi: number, windows: number): Record<string, number> {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
        const a = db.prepare(SCAN_SQL.candidates)
        const b = db.prepare(SCAN_SQL.evaluate)
        let msA = 0
        let msB = 0
        let upper = hi
        for (let w = 0; w < windows; w++) {
            let t = performance.now()
            const rows = a.all(1, upper, 256) as { id: number }[]
            msA += performance.now() - t
            const lower = rows.at(-1)?.id ?? 1
            t = performance.now()
            b.all(lower, upper)
            msB += performance.now() - t
            upper = lower - 1
        }
        return { windows, phaseAms: Number(msA.toFixed(2)), phaseBms: Number(msB.toFixed(2)) }
    } finally {
        db.close()
    }
}

/** A separate writer process inserting and updating in short autocommit statements, as Fluent Reader does. */
function startWriter(dbPath: string): { stop(): Promise<{ writes: number; busy: number }> } {
    const script = `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
        const insert = db.prepare("INSERT INTO items (source, title, link, date, fetchedDate, content, snippet) VALUES (1, 'w', 'l', 0, 0, 'c', 's')");
        const update = db.prepare("UPDATE items SET hasRead = 1 - hasRead WHERE _id = ?");
        let writes = 0, busy = 0, stop = false;
        process.stdin.on("data", () => { stop = true });
        const tick = () => {
            if (stop) { process.stdout.write(JSON.stringify({ writes, busy })); db.close(); process.exit(0); }
            try { insert.run(); update.run(1 + (writes % 1000)); writes += 2; } catch { busy++; }
            setTimeout(tick, 2);
        };
        tick();`
    const child = spawn(process.execPath, ["-e", script, dbPath], { stdio: ["pipe", "pipe", "inherit"] })
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
    return {
        stop: () =>
            new Promise((resolve) => {
                child.once("exit", () => resolve(JSON.parse(out) as { writes: number; busy: number }))
                child.stdin.write("x")
            }),
    }
}

async function main(): Promise<void> {
    const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0)
    const rowsList = sizes.length > 0 ? sizes : [100_000, 500_000]
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frmcp-bench-"))
    const report: Record<string, unknown> = {
        machine: { cpus: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)), platform: `${os.platform()} ${os.release()}`, node: process.version },
        limits: { ...DEFAULT_SCAN_LIMITS, clock: "performance.now" },
        datasets: [] as unknown[],
    }
    try {
        for (const rows of rowsList) {
            const dir = path.join(root, `p${rows}`)
            let t = performance.now()
            const dbPath = build(dir, rows, 600, 300)
            const buildMs = performance.now() - t
            const heapBefore = process.memoryUsage().heapUsed
            const result: Record<string, unknown> = {
                rows,
                dbMiB: Number((fs.statSync(dbPath).size / 2 ** 20).toFixed(1)),
                buildSeconds: Number((buildMs / 1000).toFixed(1)),
                plans: plans(dbPath),
                phases: phases(dbPath, rows, 16),
                firstPageDefault: summarize(await listing(dir, {}, 1)),
                firstPageMax: summarize(await listing(dir, { pageSize: 100, excerptChars: 500 }, 1)),
                default20Pages: summarize(await listing(dir, {}, 20)),
                selectiveStarred1in10000: summarize(await listing(dir, { starred: "starred" })),
                noMatchGroupHiddenSource: summarize(await listing(dir, { sourceIds: [49] })),
                dateRangeLastDay: summarize(await listing(dir, { dateFrom: new Date(T0 + (rows - 1440) * 60_000).toISOString(), dateTo: new Date(T0 + (rows + 1) * 60_000).toISOString() }, 3)),
                group: summarize(await listing(dir, { groupId: 0, read: "unread" }, 10)),
            }
            t = performance.now()
            const writer = startWriter(dbPath)
            const concurrent = await listing(dir, { starred: "starred" })
            const writes = await writer.stop()
            result.concurrentWriter = { listing: summarize(concurrent), writer: writes, seconds: Number(((performance.now() - t) / 1000).toFixed(1)) }
            result.heapGrowthMiB = Number(((process.memoryUsage().heapUsed - heapBefore) / 2 ** 20).toFixed(1))
            result.rssMiB = Number((process.memoryUsage().rss / 2 ** 20).toFixed(1))
            ;(report.datasets as unknown[]).push(result)
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
        // Large records: 20 000 articles with 50 KB of content, to observe the byte budget.
        const dir = path.join(root, "large")
        const dbPath = build(dir, 20_000, 50_000, 2_000)
        ;(report.datasets as unknown[]).push({
            rows: 20_000,
            contentBytes: 50_000,
            dbMiB: Number((fs.statSync(dbPath).size / 2 ** 20).toFixed(1)),
            phases: phases(dbPath, 20_000, 16),
            selectiveStarred: summarize(await listing(dir, { starred: "starred" })),
            firstPageDefault: summarize(await listing(dir, {}, 1)),
        })
    } finally {
        closeAllConnections()
        fileLock().close()
        try {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } catch {
            process.stderr.write(`could not remove the synthetic temp directory ${root}
`)
        }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

await main()
