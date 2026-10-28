/**
 * Helpers for the source tool tests: synthetic profiles with chosen source
 * rows, a test-only writer to change them between calls, and an in-process
 * MCP client connected to createServer() through the SDK's InMemoryTransport.
 * No real profile is ever used.
 */

import fs from "node:fs"
import path from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server"
import { DatabaseAccess, type DatabaseAccessOptions, type ReadOnlyDatabase } from "../../src/db/connection.js"
import { SOURCE_SQL } from "../../src/domain/sources.js"
import { createServer } from "../../src/server.js"
import type { CursorRegistry } from "../../src/scan/cursors.js"
import { createToolContext, type ToolContext } from "../../src/tools/context.js"
import { CONFIG_NAME, DB_NAME, ITEMS_DDL, SOURCES_DDL, writeSettings, type ProfileFixture } from "./fixtures.js"

/** sources DDL without NOT NULL / UNIQUE, to store anomalous values (schema check still passes). */
export const LOOSE_SOURCES_DDL = `CREATE TABLE \`sources\` (
  \`sid\` integer PRIMARY KEY NOT NULL,
  \`url\` text,
  \`iconurl\` text,
  \`name\` text,
  \`openTarget\` integer,
  \`lastFetched\` integer,
  \`serviceRef\` text,
  \`fetchFrequency\` integer,
  \`textDir\` integer,
  \`hidden\` integer
);`

export interface SourceSpec {
    readonly sid: number | bigint
    readonly name?: SQLInputValue
    readonly url?: SQLInputValue
    readonly iconurl?: SQLInputValue
    readonly openTarget?: SQLInputValue
    readonly lastFetched?: SQLInputValue
    readonly serviceRef?: SQLInputValue
    readonly fetchFrequency?: SQLInputValue
    readonly textDir?: SQLInputValue
    readonly hidden?: SQLInputValue
}

export const LAST_FETCHED = Date.UTC(2026, 9, 1, 12, 0, 0)

function insertSources(db: DatabaseSync, sources: readonly SourceSpec[]): void {
    const insert = db.prepare(
        "INSERT INTO sources (sid, url, iconurl, name, openTarget, lastFetched, serviceRef, fetchFrequency, textDir, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    // `undefined` means "default"; an explicit null is stored as NULL (loose schema only).
    const or = (value: SQLInputValue | undefined, fallback: SQLInputValue): SQLInputValue => (value === undefined ? fallback : value)
    db.exec("BEGIN")
    for (const s of sources) {
        insert.run(
            s.sid,
            or(s.url, `https://feed.invalid/${String(s.sid)}.xml`),
            or(s.iconurl, null),
            or(s.name, `Source ${String(s.sid)}`),
            or(s.openTarget, 0),
            or(s.lastFetched, LAST_FETCHED),
            or(s.serviceRef, null),
            or(s.fetchFrequency, 0),
            or(s.textDir, 0),
            or(s.hidden, 0),
        )
    }
    db.exec("COMMIT")
}

export interface SourcesProfileOptions {
    readonly sources: readonly SourceSpec[]
    readonly settings?: unknown
    readonly loose?: boolean
    readonly items?: number
    /** Articles inserted with addItems' defaults. */
    readonly articles?: readonly ItemSpec[]
    /** items DDL without NOT NULL, to store NULL in any column (schema check still passes). */
    readonly looseItems?: boolean
    /** Database text encoding, set before any table exists (default UTF-8). */
    readonly encoding?: "UTF-8" | "UTF-16le"
}

/** items DDL without NOT NULL (types, AUTOINCREMENT primary key and column order kept). */
export const LOOSE_ITEMS_DDL = `CREATE TABLE \`items\` (
  \`_id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`source\` integer,
  \`guid\` text,
  \`title\` text,
  \`link\` text,
  \`date\` integer,
  \`fetchedDate\` integer,
  \`thumb\` text,
  \`content\` text,
  \`snippet\` text,
  \`creator\` text,
  \`hasRead\` integer,
  \`starred\` integer,
  \`hidden\` integer,
  \`notify\` integer,
  \`serviceRef\` text
);`

export interface ItemSpec {
    readonly _id?: number
    readonly source?: SQLInputValue
    readonly guid?: SQLInputValue
    readonly title?: SQLInputValue
    readonly link?: SQLInputValue
    readonly date?: SQLInputValue
    readonly fetchedDate?: SQLInputValue
    readonly thumb?: SQLInputValue
    readonly content?: SQLInputValue
    readonly snippet?: SQLInputValue
    readonly creator?: SQLInputValue
    readonly hasRead?: SQLInputValue
    readonly starred?: SQLInputValue
    readonly hidden?: SQLInputValue
    readonly notify?: SQLInputValue
    readonly serviceRef?: SQLInputValue
}

const ITEM_FIELDS = ["source", "guid", "title", "link", "date", "fetchedDate", "thumb", "content", "snippet", "creator", "hasRead", "starred", "hidden", "notify", "serviceRef"] as const

function insertItems(db: DatabaseSync, items: readonly ItemSpec[]): void {
    const insert = db.prepare(`INSERT INTO items (_id, ${ITEM_FIELDS.join(", ")}) VALUES (${Array(ITEM_FIELDS.length + 1).fill("?").join(", ")})`)
    db.exec("BEGIN")
    items.forEach((item, i) => {
        const defaults: Record<(typeof ITEM_FIELDS)[number], SQLInputValue> = {
            source: 0,
            guid: `guid-${i}`,
            title: `Article ${i}`,
            link: `https://article.invalid/${i}`,
            date: LAST_FETCHED,
            fetchedDate: LAST_FETCHED + 1000,
            thumb: null,
            content: `<p>Article ${i}</p>`,
            snippet: `Article ${i}`,
            creator: null,
            hasRead: 0,
            starred: 0,
            hidden: 0,
            notify: 0,
            serviceRef: null,
        }
        // `undefined` means "default"; an explicit null is stored as NULL.
        insert.run(item._id ?? null, ...ITEM_FIELDS.map((field) => (item[field] === undefined ? defaults[field] : (item[field] as SQLInputValue))))
    })
    db.exec("COMMIT")
}

/** Test-only writer of articles (another connection, as Fluent Reader would be). */
export function addItems(dbPath: string, items: readonly ItemSpec[]): void {
    const db = new DatabaseSync(dbPath)
    try {
        insertItems(db, items)
    } finally {
        db.close()
    }
}

/** A profile whose `sources` table holds exactly `sources`. */
export function createSourcesProfile(dir: string, options: SourcesProfileOptions): ProfileFixture {
    fs.mkdirSync(dir, { recursive: true })
    const dbPath = path.join(dir, DB_NAME)
    const configPath = path.join(dir, CONFIG_NAME)
    const db = new DatabaseSync(dbPath)
    try {
        if (options.encoding !== undefined) db.exec(`PRAGMA encoding = '${options.encoding}'`)
        db.exec(`${options.loose ? LOOSE_SOURCES_DDL : SOURCES_DDL}\n${options.looseItems ? LOOSE_ITEMS_DDL : ITEMS_DDL}`)
        insertSources(db, options.sources)
        if (options.articles !== undefined) insertItems(db, options.articles)
        const items = options.items ?? 0
        if (items > 0) {
            const insert = db.prepare(
                "INSERT INTO items (source, title, link, date, fetchedDate, content, snippet) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            db.exec("BEGIN")
            for (let i = 0; i < items; i++) insert.run(0, `Item ${i}`, `https://article.invalid/${i}`, i, i, "<p>x</p>", "x")
            db.exec("COMMIT")
        }
    } finally {
        db.close()
    }
    writeSettings(configPath, options.settings ?? { sourceGroups: [], sourceRules: {} })
    return { dir, dbPath, configPath }
}

/** Test-only writer (another connection, as Fluent Reader would be). */
export function mutate(dbPath: string, sql: string, ...params: SQLInputValue[]): void {
    const db = new DatabaseSync(dbPath)
    try {
        db.prepare(sql).run(...params)
    } finally {
        db.close()
    }
}

export function addSources(dbPath: string, sources: readonly SourceSpec[]): void {
    const db = new DatabaseSync(dbPath)
    try {
        insertSources(db, sources)
    } finally {
        db.close()
    }
}

/** Wraps a DatabaseAccess so that every SQL text prepared by the tools is recorded. */
export function recordingDatabase(
    access: Pick<DatabaseAccess, "withReadConnection">,
    log: string[],
): Pick<DatabaseAccess, "withReadConnection"> {
    return {
        withReadConnection: <T>(fn: (db: ReadOnlyDatabase) => T): Promise<T> =>
            access.withReadConnection((db) =>
                fn({
                    prepare: ((sql: string) => {
                        log.push(sql)
                        return db.prepare(sql)
                    }) as ReadOnlyDatabase["prepare"],
                }),
            ),
    }
}

export interface Harness {
    readonly context: ToolContext
    readonly client: Client
    readonly sql: string[]
    call(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>
    close(): Promise<void>
}

export interface ToolOutcome {
    readonly result: CallToolResult
    readonly isError: boolean
    /** content[0].text */
    readonly text: string
    /** |S(R)| of { content, structuredContent } as sent by the server. */
    readonly length: number
    readonly payload: any
    readonly error: { code: string; message: string; hint: string; reason?: string } | undefined
}

export interface HarnessOptions {
    readonly now?: () => number
    readonly cursors?: CursorRegistry
    readonly access?: DatabaseAccessOptions
    readonly database?: Pick<DatabaseAccess, "withReadConnection">
}

/** createServer() with a context on the profile, connected to an SDK v2 client in memory. */
export async function harness(profile: ProfileFixture, options: HarnessOptions = {}): Promise<Harness> {
    const sql: string[] = []
    const access = options.database ?? new DatabaseAccess(profile.dbPath, options.access ?? {})
    const context = createToolContext({
        database: recordingDatabase(access, sql),
        configPath: profile.configPath,
        profileDir: profile.dir,
        ...(options.now && { now: options.now }),
        ...(options.cursors && { cursors: options.cursors }),
    })
    const server = createServer(context)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "frmcp-synthetic-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return {
        context,
        client,
        sql,
        async call(name, args = {}) {
            const result = (await client.callTool({ name, arguments: args })) as CallToolResult
            const first = result.content[0]
            const text = first?.type === "text" ? first.text : ""
            const isError = result.isError === true
            const length = JSON.stringify(
                isError ? { content: result.content, isError: true } : { content: result.content, structuredContent: result.structuredContent },
            ).length
            return {
                result,
                isError,
                text,
                length,
                payload: isError ? undefined : result.structuredContent,
                error: isError ? (JSON.parse(text) as ToolOutcome["error"]) : undefined,
            }
        },
        async close() {
            await client.close()
            await server.close()
        },
    }
}

/**
 * Wraps a DatabaseAccess so that the sids passed to every S2 statement
 * (SOURCE_SQL.rows) are recorded, one array per execution.
 */
export function recordingRowLoads(
    access: Pick<DatabaseAccess, "withReadConnection">,
    loads: number[][],
): Pick<DatabaseAccess, "withReadConnection"> {
    return {
        withReadConnection: <T>(fn: (db: ReadOnlyDatabase) => T): Promise<T> =>
            access.withReadConnection((db) =>
                fn({
                    prepare: ((sql: string) => {
                        const statement = db.prepare(sql)
                        if (sql !== SOURCE_SQL.rows) return statement
                        return new Proxy(statement, {
                            get(target, key) {
                                if (key === "all") {
                                    return (...params: SQLInputValue[]) => {
                                        loads.push(JSON.parse(String(params[0])) as number[])
                                        return target.all(...params)
                                    }
                                }
                                const value: unknown = Reflect.get(target, key, target)
                                return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
                            },
                        })
                    }) as ReadOnlyDatabase["prepare"],
                }),
            ),
    }
}

export interface JsonRpcResponse {
    readonly id: number
    readonly result?: any
    readonly error?: { code: number; message: string }
}

export interface RawSession {
    readonly context: ToolContext
    /** Sends a request with exactly these params (no SDK client validation) and waits for its response. */
    request(method: string, params?: unknown): Promise<JsonRpcResponse>
    close(): Promise<void>
}

/** createServer() on the profile, driven with raw JSON-RPC messages through the SDK's InMemoryTransport. */
export async function rawSession(profile: ProfileFixture): Promise<RawSession> {
    const context = createToolContext({
        database: new DatabaseAccess(profile.dbPath),
        configPath: profile.configPath,
        profileDir: profile.dir,
    })
    const server = createServer(context)
    const [peer, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const pending = new Map<number, (message: JsonRpcResponse) => void>()
    peer.onmessage = (message) => {
        const id = (message as { id?: unknown }).id
        if (typeof id !== "number") return
        pending.get(id)?.(message as unknown as JsonRpcResponse)
        pending.delete(id)
    }
    await peer.start()
    type Message = Parameters<typeof peer.send>[0]
    let nextId = 1
    const request = (method: string, params?: unknown): Promise<JsonRpcResponse> =>
        new Promise((resolve, reject) => {
            const id = nextId++
            pending.set(id, resolve)
            peer.send({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) } as Message).catch(reject)
        })
    const init = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
    })
    if (init.error !== undefined) throw new Error("initialize failed")
    await peer.send({ jsonrpc: "2.0", method: "notifications/initialized" } as Message)
    return {
        context,
        request,
        async close() {
            await peer.close()
            await server.close()
        },
    }
}

/** Follows nextCursor until the listing ends; returns every page. */
export async function listAll(h: Harness, args: Record<string, unknown> = {}, maxPages = 10_000): Promise<ToolOutcome[]> {
    const pages: ToolOutcome[] = []
    let cursor: string | null = null
    do {
        const page = await h.call("list_sources", cursor === null ? args : { cursor })
        if (page.isError) throw new Error(`list_sources failed: ${page.text}`)
        pages.push(page)
        cursor = page.payload.nextCursor
        if (pages.length > maxPages) throw new Error("listing did not terminate")
    } while (cursor !== null)
    return pages
}

export function sids(pages: readonly ToolOutcome[]): number[] {
    return pages.flatMap((p) => (p.payload.sources as { sourceId: number }[]).map((s) => s.sourceId))
}
