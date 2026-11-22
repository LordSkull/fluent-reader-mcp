/**
 * groupDuplicates stress benchmark (list_articles). Not part of `npm test`:
 * run it explicitly (after `npm run pretest` or `tsc -p tsconfig.test.json`):
 *
 *   node dist-test/test/bench/group-duplicates.bench.js [rows ...]
 *
 * Default rows: 100000. Everything is synthetic, generated under the system
 * temp directory and deleted at the end. A quarter of the articles are copies
 * of stories published by six regional sources of one publisher, a few
 * hundred ids apart; one pathological story is republished 5 000 times by a
 * single source, another one by 1 500 sources within 10 minutes. Prints one
 * JSON report on stdout: the same chains with and without groupDuplicates,
 * per-call times, memory kept by cursors, and 64 concurrent grouped chains.
 *
 * Reported times are observations on this machine, not guarantees.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { closeAllConnections, DatabaseAccess, fileLock } from "../../src/db/connection.js"
import { CursorRegistry } from "../../src/scan/cursors.js"
import { DuplicateMemory } from "../../src/scan/duplicate-memory.js"
import { createToolContext, type ToolContext } from "../../src/tools/context.js"
import { DEFAULT_SCAN_LIMITS, listArticles } from "../../src/tools/list-articles.js"
import type { ListArticlesOutput } from "../../src/tools/schemas.js"
import { CONFIG_NAME, DB_NAME, ITEMS_DDL, SOURCES_DDL } from "../helpers/fixtures.js"

const T0 = Date.UTC(2026, 0, 1)
const WIDE_SOURCES = 1500

function text(n: number): string {
    return `Il consiglio regionale ha approvato il provvedimento numero ${n} dopo una lunga discussione in aula, con modifiche richieste dalle opposizioni e dai sindacati. `.repeat(3)
}

function build(dir: string, rows: number): string {
    fs.mkdirSync(dir, { recursive: true })
    const dbPath = path.join(dir, DB_NAME)
    const db = new DatabaseSync(dbPath)
    try {
        db.exec(`${SOURCES_DDL}\n${ITEMS_DDL}`)
        db.exec("BEGIN")
        const source = db.prepare("INSERT INTO sources (sid, url, name, lastFetched) VALUES (?, ?, ?, 0)")
        for (let sid = 0; sid < WIDE_SOURCES; sid++) source.run(sid, `https://feed.invalid/${sid}.xml`, `Bench source ${sid}`)
        const item = db.prepare("INSERT INTO items (_id, source, guid, title, link, date, fetchedDate, content, snippet, hasRead) VALUES (?, ?, ?, ?, ?, ?, ?, '<p>c</p>', ?, ?)")
        const story = (id: number, n: number, sid: number, minutes: number): void => {
            item.run(id, sid, `g${id}`, `Notizia ${n}`, `https://www.ansa.it/r${sid}/${n}_${id}.html`, T0 + n * 3_600_000 + minutes * 60_000, T0 + id * 1000, text(n), id % 3 === 0 ? 1 : 0)
        }
        let id = 0
        // Pathological buckets first (lowest ids): 5 000 copies from one source, then 1 500 sources within 10 minutes.
        for (let k = 0; k < 5000; k++) story(++id, -1, 7, 0)
        for (let k = 0; k < WIDE_SOURCES; k++) story(++id, -2, k, k % 10)
        while (id < rows) {
            id++
            if (id % 4 === 0) story(id, Math.floor(id / 400), id % 6, (id % 3) - 1)
            else item.run(id, 6 + (id % 40), `g${id}`, `Articolo ${id}`, `https://example.invalid/${id}`, T0 + id * 60_000, T0 + id * 1000, text(1_000_000 + id), 0)
            if (id % 50_000 === 0) {
                db.exec("COMMIT")
                db.exec("BEGIN")
            }
        }
        db.exec("COMMIT")
    } finally {
        db.close()
    }
    fs.writeFileSync(path.join(dir, CONFIG_NAME), JSON.stringify({ sourceGroups: [], sourceRules: {} }))
    return dbPath
}

interface ChainStat {
    calls: number
    returned: number
    copies: number
    examined: number
    msTotal: number
    msP50: number
    msP95: number
    msMax: number
    maxCursorWeight: number
    forgottenSoFar: number | null
    complete: boolean | null
    stoppedBy: string[]
}

async function chain(context: ToolContext, args: Record<string, unknown>, maxCalls = Number.POSITIVE_INFINITY): Promise<ChainStat> {
    const ms: number[] = []
    let cursor: string | null = null
    let returned = 0
    let copies = 0
    let examined = 0
    let maxCursorWeight = 0
    let last: ListArticlesOutput | undefined
    const stoppedBy = new Set<string>()
    do {
        const started = performance.now()
        const result = await listArticles(context, cursor === null ? args : { cursor })
        ms.push(performance.now() - started)
        if (result.isError) throw new Error(`list_articles failed: ${JSON.stringify(result.content)}`)
        last = result.structuredContent as ListArticlesOutput
        returned += last.articles.length
        copies += last.grouping?.copies ?? 0
        examined += last.scan.examined
        stoppedBy.add(last.scan.stoppedBy)
        maxCursorWeight = Math.max(maxCursorWeight, context.cursors.weight)
        cursor = last.nextCursor
    } while (cursor !== null && ms.length < maxCalls)
    const sorted = [...ms].sort((a, b) => a - b)
    const pct = (p: number): number => Number((sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0).toFixed(2))
    return {
        calls: ms.length,
        returned,
        copies,
        examined,
        msTotal: Math.round(ms.reduce((a, b) => a + b, 0)),
        msP50: pct(50),
        msP95: pct(95),
        msMax: Number((sorted.at(-1) ?? 0).toFixed(2)),
        maxCursorWeight,
        forgottenSoFar: last?.grouping?.forgottenSoFar ?? null,
        complete: last?.grouping?.complete ?? null,
        stoppedBy: [...stoppedBy],
    }
}

/** 64 grouped chains advanced in turn, 10 pages each: the registry's weight stays within its capacity. */
async function concurrentChains(context: ToolContext): Promise<Record<string, unknown>> {
    const cursors: (string | null)[] = []
    let maxWeight = 0
    let expired = 0
    for (let k = 0; k < 64; k++) {
        const result = await listArticles(context, { groupDuplicates: true, pageSize: 100, excerptChars: k })
        cursors.push((result.structuredContent as ListArticlesOutput).nextCursor)
        maxWeight = Math.max(maxWeight, context.cursors.weight)
    }
    for (let round = 0; round < 10; round++) {
        for (let k = 0; k < cursors.length; k++) {
            const cursor = cursors[k]
            if (cursor === null || cursor === undefined) continue
            try {
                const result = await listArticles(context, { cursor })
                cursors[k] = (result.structuredContent as ListArticlesOutput).nextCursor
            } catch {
                expired++
                cursors[k] = null
            }
            maxWeight = Math.max(maxWeight, context.cursors.weight)
        }
    }
    return { chains: 64, maxRegistryWeight: maxWeight, chainsEvicted: expired, heapUsedMiB: Number((process.memoryUsage().heapUsed / 2 ** 20).toFixed(1)) }
}

/** The worst case of one find(): keyGroupsMax groups of one fingerprint, one of them with membersMax − 15 sources. */
function memoryWorstCase(): Record<string, unknown> {
    const limits = { groupsMax: DEFAULT_SCAN_LIMITS.duplicateGroupsMax, membersMax: DEFAULT_SCAN_LIMITS.duplicateMembersMax, keyGroupsMax: DEFAULT_SCAN_LIMITS.duplicateKeyGroupsMax }
    const memory = new DuplicateMemory(limits)
    memory.open(1, "k", T0, 0)
    let story = memory.find("k", T0, 1)
    for (let s = 1; story !== undefined && memory.members < limits.membersMax - limits.keyGroupsMax; s++) {
        memory.join(story, T0, s)
        story = memory.find("k", T0, s + 1)
    }
    for (let g = 2; g <= limits.keyGroupsMax; g++) memory.open(g, "k", T0 + 3_600_000 * g, 0)
    const started = performance.now()
    let found = 0
    for (let k = 0; k < DEFAULT_SCAN_LIMITS.callRows; k++) if (memory.find("k", T0 + 3_600_000 * 50, 1) !== undefined) found++
    const cloneStarted = performance.now()
    memory.fork()
    const cloneMs = performance.now() - cloneStarted
    // Real heap of full memories against their estimated weight. Needs --expose-gc.
    const gc = (globalThis as { gc?: () => void }).gc
    let measured: Record<string, unknown> | string = "run with node --expose-gc"
    if (gc !== undefined) {
        const heapOf = (build: () => DuplicateMemory): Record<string, number> => {
            gc()
            const before = process.memoryUsage().heapUsed
            const kept = build()
            gc()
            return { heapBytes: process.memoryUsage().heapUsed - before, estimatedWeight: kept.weight, groups: kept.size, members: kept.members }
        }
        measured = {
            // 2048 stories of 4 sources each, 43-character fingerprints.
            manySmallGroups: heapOf(() => {
                const full = new DuplicateMemory(limits)
                for (let g = 0; g < limits.groupsMax; g++) {
                    const fingerprint = Buffer.from(`fingerprint-${g}`.padEnd(32, "x")).toString("base64url")
                    full.open(1_000_000 - g, fingerprint, T0, 0)
                    for (let s = 1; s < limits.membersMax / limits.groupsMax; s++) {
                        const story = full.find(fingerprint, T0, s)
                        if (story !== undefined) full.join(story, T0, s)
                    }
                }
                return full
            }),
            // One story of membersMax sources (indexed).
            oneLargeGroup: heapOf(() => {
                const full = new DuplicateMemory(limits)
                full.open(1, "k", T0, 0)
                for (let s = 1; s < limits.membersMax; s++) full.join(full.find("k", T0, s) as NonNullable<ReturnType<DuplicateMemory["find"]>>, T0, s)
                return full
            }),
            // 2048 stories of one source each.
            singleSourceGroups: heapOf(() => {
                const full = new DuplicateMemory(limits)
                for (let g = 0; g < limits.groupsMax; g++) full.open(1_000_000 - g, Buffer.from(`fingerprint-${g}`.padEnd(32, "x")).toString("base64url"), T0, 0)
                return full
            }),
        }
    }
    return {
        groups: memory.size,
        members: memory.members,
        weightBytes: memory.weight,
        findsPerCall: DEFAULT_SCAN_LIMITS.callRows,
        msForCallRowsFinds: Number((cloneStarted - started).toFixed(2)),
        found,
        msFork: Number(cloneMs.toFixed(2)),
        fullMemory: measured,
    }
}

async function main(): Promise<void> {
    const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0)
    const rowsList = sizes.length > 0 ? sizes : [100_000]
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frmcp-bench-dup-"))
    const report: Record<string, unknown> = {
        machine: { cpus: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)), platform: `${os.platform()} ${os.release()}`, node: process.version },
        limits: { ...DEFAULT_SCAN_LIMITS, clock: "performance.now" },
        memoryWorstCase: memoryWorstCase(),
        datasets: [] as unknown[],
    }
    try {
        for (const rows of rowsList) {
            const dir = path.join(root, `p${rows}`)
            const t = performance.now()
            const dbPath = build(dir, rows)
            const context = () =>
                createToolContext({ database: new DatabaseAccess(dbPath), configPath: path.join(dir, CONFIG_NAME), profileDir: dir, cursors: new CursorRegistry() })
            const heapBefore = process.memoryUsage().heapUsed
            ;(report.datasets as unknown[]).push({
                rows,
                dbMiB: Number((fs.statSync(dbPath).size / 2 ** 20).toFixed(1)),
                buildSeconds: Number(((performance.now() - t) / 1000).toFixed(1)),
                ungroupedFull: await chain(context(), { pageSize: 100, excerptChars: 0 }),
                groupedFull: await chain(context(), { groupDuplicates: true, pageSize: 100, excerptChars: 0 }),
                groupedFirst20Pages: await chain(context(), { groupDuplicates: true }, 20),
                groupedUnreadFull: await chain(context(), { groupDuplicates: true, read: "unread", pageSize: 100, excerptChars: 0 }),
                concurrent: await concurrentChains(context()),
                heapGrowthMiB: Number(((process.memoryUsage().heapUsed - heapBefore) / 2 ** 20).toFixed(1)),
                rssMiB: Number((process.memoryUsage().rss / 2 ** 20).toFixed(1)),
            })
            closeAllConnections()
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
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
