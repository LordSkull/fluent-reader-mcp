/**
 * Synthetic fixtures. Everything is generated under the system temp directory
 * and removed afterwards; no real Fluent Reader profile is ever used.
 * The writable DatabaseSync here is test-only: production code opens SQLite
 * exclusively through src/db/connection.ts.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

/** Marker placed in fake credentials; must never appear in any output. */
export const SECRET_SENTINEL = "FRMCP_SECRET_SENTINEL_7f3a9c1e"
export const FAKE_PASSWORD = `fake-password-${SECRET_SENTINEL}`

export const DB_NAME = "fluent-reader.db"
export const CONFIG_NAME = "config.json"

export function createTempRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "frmcp-test-"))
}

export function removeTempRoot(root: string): void {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

export const ITEMS_DDL = `CREATE TABLE \`items\` (
  \`_id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`source\` integer NOT NULL,
  \`guid\` text,
  \`title\` text NOT NULL,
  \`link\` text NOT NULL,
  \`date\` integer NOT NULL,
  \`fetchedDate\` integer NOT NULL,
  \`thumb\` text,
  \`content\` text NOT NULL,
  \`snippet\` text NOT NULL,
  \`creator\` text,
  \`hasRead\` integer DEFAULT false NOT NULL,
  \`starred\` integer DEFAULT false NOT NULL,
  \`hidden\` integer DEFAULT false NOT NULL,
  \`notify\` integer DEFAULT false NOT NULL,
  \`serviceRef\` text
);`

export const SOURCES_DDL = `CREATE TABLE \`sources\` (
  \`sid\` integer PRIMARY KEY NOT NULL,
  \`url\` text NOT NULL,
  \`iconurl\` text,
  \`name\` text NOT NULL,
  \`openTarget\` integer DEFAULT 0 NOT NULL,
  \`lastFetched\` integer NOT NULL,
  \`serviceRef\` text,
  \`fetchFrequency\` integer DEFAULT 0 NOT NULL,
  \`textDir\` integer DEFAULT 0 NOT NULL,
  \`hidden\` integer DEFAULT false NOT NULL
);
CREATE UNIQUE INDEX \`sources_url_unique\` ON \`sources\` (\`url\`);`

export type SchemaVariant = "compatible" | "missing-items" | "missing-column" | "wrong-type" | "wrong-pk"

export interface DatabaseOptions {
    readonly schema?: SchemaVariant
    readonly wal?: boolean
    readonly rows?: number
}

function ddlFor(variant: SchemaVariant): string {
    switch (variant) {
        case "compatible":
            return `${SOURCES_DDL}\n${ITEMS_DDL}`
        case "missing-items":
            return SOURCES_DDL
        case "missing-column":
            return `${SOURCES_DDL}\n${ITEMS_DDL.replace("  `creator` text,\n", "")}`
        case "wrong-type":
            return `${SOURCES_DDL}\n${ITEMS_DDL.replace("`date` integer NOT NULL", "`date` text NOT NULL")}`
        case "wrong-pk":
            return `${SOURCES_DDL.replace("`sid` integer PRIMARY KEY NOT NULL", "`sid` integer NOT NULL").replace(
                "`url` text NOT NULL",
                "`url` text PRIMARY KEY NOT NULL",
            )}\n${ITEMS_DDL}`
    }
}

/** Creates a synthetic database with fake sources and articles. */
export function createDatabase(dbPath: string, options: DatabaseOptions = {}): void {
    const db = new DatabaseSync(dbPath)
    try {
        if (options.wal) db.exec("PRAGMA journal_mode = WAL")
        db.exec(ddlFor(options.schema ?? "compatible"))
        const hasItems = (options.schema ?? "compatible") !== "missing-items"
        db.exec(
            "INSERT INTO sources (sid, url, name, lastFetched) VALUES " +
                "(0, 'https://feed.invalid/a.xml', 'Synthetic A', 0), (1, 'https://feed.invalid/b.xml', 'Synthetic B', 0)",
        )
        if (hasItems && (options.schema ?? "compatible") === "compatible") {
            const insert = db.prepare(
                "INSERT INTO items (source, title, link, date, fetchedDate, content, snippet) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            db.exec("BEGIN")
            for (let i = 0; i < (options.rows ?? 5); i++) {
                insert.run(i % 2, `Synthetic title ${i} àèì 中文 😀`, `https://article.invalid/${i}`, i, i, `<p>Body ${i}</p>`, `Body ${i}`)
            }
            db.exec("COMMIT")
        }
    } finally {
        db.close()
    }
}

export function syntheticSettings(): Record<string, unknown> {
    return {
        theme: "system",
        sourceGroups: [
            { gid: 0, isMultiple: true, sids: [0, 1], name: "Synthetic group", expanded: true },
            { gid: 1, isMultiple: false, sids: [1] },
        ],
        sourceRules: {
            all: [{ filter: 7, search: "synthetic", match: true, actions: ["r-true"] }],
            "source:0": [{ filter: 15, search: "^x", match: false, actions: ["h-true", "s-false"] }],
        },
        nextGroupId: 2,
        dbVersion: "3",
        serviceConfigs: {
            type: 2,
            endpoint: `https://sync.invalid/${SECRET_SENTINEL}`,
            username: `user-${SECRET_SENTINEL}`,
            password: FAKE_PASSWORD,
            apiKey: `api-key-${SECRET_SENTINEL}`,
            token: `token-${SECRET_SENTINEL}`,
        },
        pac: `http://proxy.invalid/${SECRET_SENTINEL}.pac`,
    }
}

export function writeSettings(configPath: string, value: unknown): void {
    fs.writeFileSync(configPath, typeof value === "string" ? value : JSON.stringify(value))
}

export interface ProfileFixture {
    readonly dir: string
    readonly dbPath: string
    readonly configPath: string
}

export interface ProfileOptions {
    readonly db?: DatabaseOptions | false
    readonly settings?: unknown | false
}

/** Creates a profile directory (and its parents) with the two files. */
export function createProfile(dir: string, options: ProfileOptions = {}): ProfileFixture {
    fs.mkdirSync(dir, { recursive: true })
    const dbPath = path.join(dir, DB_NAME)
    const configPath = path.join(dir, CONFIG_NAME)
    if (options.db !== false) createDatabase(dbPath, options.db ?? {})
    if (options.settings !== false) writeSettings(configPath, options.settings ?? syntheticSettings())
    return { dir, dbPath, configPath }
}

/** File name → SHA-256 of every entry in a directory tree (links not followed). */
export function snapshotDir(dir: string): Map<string, string> {
    const result = new Map<string, string>()
    const walk = (current: string, prefix: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name)
            const key = prefix + entry.name
            if (entry.isSymbolicLink()) {
                result.set(key, `link:${fs.readlinkSync(full)}`)
            } else if (entry.isDirectory()) {
                result.set(key, "dir")
                walk(full, `${key}/`)
            } else {
                result.set(key, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"))
            }
        }
    }
    walk(dir, "")
    return result
}

/** Whether this account may create file symlinks (Windows needs Developer Mode or admin). */
export function canCreateFileSymlinks(root: string): boolean {
    const target = path.join(root, `probe-target-${crypto.randomUUID()}`)
    const link = `${target}-link`
    fs.writeFileSync(target, "x")
    try {
        fs.symlinkSync(target, link, "file")
        fs.unlinkSync(link)
        return true
    } catch {
        return false
    } finally {
        fs.unlinkSync(target)
    }
}

/** Asserts helper: none of the given strings contains the forbidden markers. */
export function findLeaks(haystacks: readonly string[], needles: readonly string[]): string[] {
    const leaks: string[] = []
    for (const needle of needles) {
        if (needle.length === 0) continue
        for (const text of haystacks) {
            if (text.includes(needle)) leaks.push(needle)
        }
    }
    return leaks
}
