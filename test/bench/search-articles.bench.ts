/**
 * FR-MCP-02B-02 stress benchmark of search_articles. Not part of `npm test`:
 * run it explicitly (after `npm run pretest` or `tsc -p tsconfig.test.json`):
 *
 *   node dist-test/test/bench/search-articles.bench.js [rows ...]
 *
 * Default rows: 100000 500000. Everything is synthetic, generated under the
 * system temp directory and deleted at the end. Records are about 1 KB
 * (600-byte content, 300-byte snippet with Italian text and accents). Words:
 * "economia" in every other title (frequent), "zebrafish" in 1 title out of
 * 10 000 (very selective), "industriale" in every snippet of articles
 * divisible by 50 000 (selective in the snippet only), nothing contains
 * "nessunrisultato". One extra profile of 20 000 records with 50 KB of
 * content and 40 KB snippets measures the text budgets, and a micro-benchmark
 * measures the comparison of one 256 KiB value against an adversarial query.
 * Prints one JSON report on stdout.
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
import { SEARCH_COLUMN_BYTES_MAX, SEARCH_SQL } from "../../src/domain/article-scan.js"
import { normalizeForSearch, normalizeQuery } from "../../src/domain/text-match.js"
import { FrMcpError } from "../../src/errors.js"
import { createToolContext } from "../../src/tools/context.js"
import { DEFAULT_SCAN_LIMITS } from "../../src/tools/list-articles.js"
import { searchArticles } from "../../src/tools/search-articles.js"
import type { SearchArticlesOutput } from "../../src/tools/schemas.js"
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
        const filler = "La città è cambiata perché il mercato è in crescita; analisi della situazione. "
        const base = filler.repeat(Math.ceil(snippetBytes / filler.length)).slice(0, snippetBytes)
        for (let i = 1; i <= rows; i++) {
            const words = [i % 2 === 0 ? "Economia" : "Politica", i % 10_000 === 0 ? "zebrafish" : "notizia"]
            item.run(
                i % 50,
                `guid-${i}`,
                `Bench article ${i} ${words.join(" ")}`,
                `https://article.invalid/${i}`,
                T0 + i * 60_000,
                T0 + i * 60_000 + 1000,
                content,
                i % 50_000 === 0 ? `crisi industriale ${base}` : base,
                i % 7 === 0 ? "Autore Bench" : null,
                i % 3 === 0 ? 1 : 0,
                i % 10_000 === 0 ? 1 : 0,
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
    readonly textBytes: number
    readonly stoppedBy: string
    readonly busyRetries: number
}

function summarize(calls: readonly CallStat[], last?: SearchArticlesOutput): Record<string, unknown> {
    const ms = calls.map((c) => c.ms).sort((a, b) => a - b)
    const pct = (p: number): number => Number((ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))] ?? 0).toFixed(2))
    return {
        calls: calls.length,
        returned: calls.reduce((n, c) => n + c.returned, 0),
        examined: calls.reduce((n, c) => n + c.examined, 0),
        maxExaminedPerCall: Math.max(...calls.map((c) => c.examined)),
        textMiB: Number((calls.reduce((n, c) => n + c.textBytes, 0) / 2 ** 20).toFixed(2)),
        maxTextMiBPerCall: Number((Math.max(...calls.map((c) => c.textBytes)) / 2 ** 20).toFixed(2)),
        msP50: pct(50),
        msP95: pct(95),
        msMax: Number((ms.at(-1) ?? 0).toFixed(2)),
        totalSeconds: Number((calls.reduce((n, c) => n + c.ms, 0) / 1000).toFixed(2)),
        stoppedBy: [...new Set(calls.map((c) => c.stoppedBy))],
        dbBusyRetries: calls.reduce((n, c) => n + c.busyRetries, 0),
        ...(last && { finished: last.scan.exhausted, exhaustive: last.search.exhaustive, incompleteSoFar: last.search.incompleteSoFar }),
    }
}

async function searching(dir: string, args: Record<string, unknown>, maxCalls = Number.POSITIVE_INFINITY): Promise<Record<string, unknown>> {
    const context = createToolContext({ database: new DatabaseAccess(path.join(dir, DB_NAME)), configPath: path.join(dir, CONFIG_NAME), profileDir: dir })
    const calls: CallStat[] = []
    let cursor: string | null = null
    let last: SearchArticlesOutput | undefined
    do {
        let busyRetries = 0
        let result: Awaited<ReturnType<typeof searchArticles>> | undefined
        let ms = 0
        while (result === undefined) {
            const started = performance.now()
            try {
                result = await searchArticles(context, cursor === null ? args : { cursor })
            } catch (error) {
                // DB_BUSY leaves the cursor unchanged: retry it, as a client would (counted, at most 100 times).
                if (!(error instanceof FrMcpError) || error.code !== "DB_BUSY" || ++busyRetries > 100) throw error
            }
            ms = performance.now() - started
        }
        if (result.isError) throw new Error(`search_articles failed: ${JSON.stringify(result.content)}`)
        last = result.structuredContent as SearchArticlesOutput
        calls.push({ ms, returned: last.articles.length, examined: last.scan.examined, textBytes: last.search.textBytesLoaded, stoppedBy: last.scan.stoppedBy, busyRetries })
        cursor = last.nextCursor
    } while (cursor !== null && calls.length < maxCalls)
    return summarize(calls, cursor === null ? last : undefined)
}

function plans(dbPath: string): Record<string, string> {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
        const plan = (sql: string, ...params: unknown[]): string =>
            ((db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all as (...a: unknown[]) => { detail: string }[])(...params)).map((r) => r.detail).join(" | ")
        return {
            titleCandidates: plan(SEARCH_SQL.title.candidates, 1, 1000, 256),
            titleEvaluate: plan(SEARCH_SQL.title.evaluate, 1, 1000),
            textCandidates: plan(SEARCH_SQL.text.candidates, 1, 1000, 256),
            textEvaluate: plan(SEARCH_SQL.text.evaluate, 1, 1000),
            creatorEvaluate: plan(SEARCH_SQL.creator.evaluate, 1, 1000),
        }
    } finally {
        db.close()
    }
}

/** A separate writer process inserting and updating in short autocommit statements, as Fluent Reader does. */
function startWriter(dbPath: string): { stop(): Promise<{ writes: number; busy: number }> } {
    const script = `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
        const insert = db.prepare("INSERT INTO items (source, title, link, date, fetchedDate, content, snippet) VALUES (1, 'zebrafish nuovo', 'l', 0, 0, 'c', 's')");
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

/** Normalization and comparison of one value at the snippet limit, ordinary and adversarial. */
function comparison(): Record<string, unknown> {
    const size = SEARCH_COLUMN_BYTES_MAX.snippet
    const time = (text: string, query: string, runs = 20): number => {
        const q = normalizeQuery(query) as string
        const started = performance.now()
        let found = 0
        for (let i = 0; i < runs; i++) if (normalizeForSearch(text).includes(q)) found++
        return Number(((performance.now() - started) / runs).toFixed(3))
    }
    const italian = "La città è cambiata perché il mercato è in crescita. ".repeat(size / 52).slice(0, size / 2)
    return {
        valueBytes: size,
        msAsciiNoMatch: time("a".repeat(size), "nessunrisultato"),
        msAdversarialPrefix: time("a".repeat(size), `${"a".repeat(199)}b`),
        msAdversarialPeriodic: time("ab".repeat(size / 2), `${"ab".repeat(99)}ac`),
        msItalianAccents: time(italian, "citta perche crisi"),
        msDecomposingHangul: time("가".repeat(size / 3), "각"),
    }
}

async function main(): Promise<void> {
    const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0)
    const rowsList = sizes.length > 0 ? sizes : [100_000, 500_000]
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frmcp-search-bench-"))
    const report: Record<string, unknown> = {
        machine: { cpus: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)), platform: `${os.platform()} ${os.release()}`, node: process.version },
        limits: { ...DEFAULT_SCAN_LIMITS, clock: "performance.now", searchColumnBytesMax: SEARCH_COLUMN_BYTES_MAX },
        comparison: comparison(),
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
                frequentTitleFirstPage: await searching(dir, { query: "economia" }, 1),
                frequentTitle20Pages: await searching(dir, { query: "ECONOMIA", pageSize: 100 }, 20),
                selectiveTitle1in10000: await searching(dir, { query: "zebrafish" }),
                noResultTitle: await searching(dir, { query: "nessunrisultato" }),
                noResultText: await searching(dir, { query: "nessunrisultato", fields: "text" }),
                selectiveSnippet: await searching(dir, { query: "crisi industriale", fields: "text" }),
                accentsText20Pages: await searching(dir, { query: "CITTA E CAMBIATA PERCHE", fields: "text", pageSize: 100 }, 20),
                creatorWithFilters: await searching(dir, { query: "autore bench", fields: "creator", read: "unread", groupId: 0 }, 20),
            }
            t = performance.now()
            const writer = startWriter(dbPath)
            const concurrent = await searching(dir, { query: "zebrafish" })
            const writes = await writer.stop()
            result.concurrentWriter = { search: concurrent, writer: writes, seconds: Number(((performance.now() - t) / 1000).toFixed(1)) }
            result.heapGrowthMiB = Number(((process.memoryUsage().heapUsed - heapBefore) / 2 ** 20).toFixed(1))
            result.rssMiB = Number((process.memoryUsage().rss / 2 ** 20).toFixed(1))
            ;(report.datasets as unknown[]).push(result)
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
        // Large texts: 20 000 articles with 50 KB of content and 40 KB snippets.
        const dir = path.join(root, "large")
        const dbPath = build(dir, 20_000, 50_000, 40_000)
        const heapBefore = process.memoryUsage().heapUsed
        ;(report.datasets as unknown[]).push({
            rows: 20_000,
            contentBytes: 50_000,
            snippetBytes: 40_000,
            dbMiB: Number((fs.statSync(dbPath).size / 2 ** 20).toFixed(1)),
            noResultTitle: await searching(dir, { query: "nessunrisultato" }),
            noResultText: await searching(dir, { query: "nessunrisultato", fields: "text" }),
            frequentTextFirstPage: await searching(dir, { query: "citta", fields: "text" }, 1),
            heapGrowthMiB: Number(((process.memoryUsage().heapUsed - heapBefore) / 2 ** 20).toFixed(1)),
            rssMiB: Number((process.memoryUsage().rss / 2 ** 20).toFixed(1)),
        })
    } finally {
        closeAllConnections()
        fileLock().close()
        try {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } catch {
            process.stderr.write(`could not remove the synthetic temp directory ${root}\n`)
        }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

await main()
