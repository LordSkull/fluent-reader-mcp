/**
 * FR-MCP-04-BETA-02: the installation record, `<install dir>\fluent-reader-mcp.install.json`.
 *
 * It marks a directory as an installation of this product (the only kind of
 * non-empty directory the wizard accepts), and remembers what the installer
 * registered in Claude Code, so that the uninstaller removes the MCP entry
 * only while it is still exactly the one the installer created. It stays on
 * the user's machine and holds no configuration content: no copy of other
 * MCP entries, no environment values, no token.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { SetupRefusal } from "./protocol.js"

export const RECORD_NAME = "fluent-reader-mcp.install.json"
export const PRODUCT = "fluent-reader-mcp"

/** A stdio MCP entry in the normalised form used for every comparison. */
export interface StdioEntry {
    readonly type: "stdio"
    readonly command: string
    readonly args: readonly string[]
    readonly env: Readonly<Record<string, string>>
}

export type RegistrationState = "pending" | "registered" | "removed" | "not-registered" | "rollback-failed"

export interface Registration {
    readonly state: RegistrationState
    readonly name: string
    readonly scope: "user"
    readonly configPath: string
    readonly claudeExe: string
    /** The entry this installer asked the CLI to write (what it builds the command from). */
    readonly entry: StdioEntry
    /**
     * Identity of the entry as the CLI actually SAVED it, read back after a
     * successful `add-json`: SHA-256 of its complete canonical JSON (every
     * field, recursively; key order irrelevant, array order kept). Null while
     * pending, or when no saved entry could be attributed to this installer:
     * then nothing is ever removed automatically.
     */
    readonly fingerprint: string | null
    /** File name of the backup taken before the change, in state\claude-config-backups. */
    readonly backup: string | null
    readonly updatedAt: string
}

export interface InstallRecord {
    readonly schemaVersion: 1
    readonly product: typeof PRODUCT
    /** Canonical installation directory this record belongs to (a copied record does not authorise another directory). */
    readonly installDir: string
    /** Identity of this installation (the transaction that wrote the record): uninstall markers are bound to it. */
    readonly generation: string
    readonly version: string
    readonly bundleSha256: string
    readonly installedAt: string
    readonly profileDir: string | null
    readonly claude: Registration | null
}

/** Canonical JSON: object keys sorted (ordinal) at every level, arrays in their order, every field kept. */
export function canonicalJson(value: unknown): string {
    const canon = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(canon)
        if (typeof v === "object" && v !== null) return Object.fromEntries(Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        return v
    }
    return JSON.stringify(canon(value)) ?? "undefined"
}

/** The ownership identity of a stored MCP entry: SHA-256 of its complete canonical JSON. */
export function entryFingerprint(value: unknown): string {
    return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function isEntry(value: unknown): value is StdioEntry {
    const e = value as Partial<StdioEntry> | null
    return typeof e === "object" && e !== null && e.type === "stdio" && typeof e.command === "string" && Array.isArray(e.args) && e.args.every((a) => typeof a === "string") &&
        typeof e.env === "object" && e.env !== null && Object.values(e.env).every((v) => typeof v === "string")
}

export function readRecord(file: string): InstallRecord | null {
    if (!fs.existsSync(file)) return null
    let raw: unknown
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
        throw new SetupRefusal("il registro di installazione è danneggiato: non viene sovrascritto (reinstalla in una cartella nuova o ripristinalo)")
    }
    const r = raw as Partial<InstallRecord> | null
    const fingerprintOk = (f: unknown): boolean => f === null || (typeof f === "string" && /^[0-9a-f]{64}$/.test(f))
    const claudeOk = r?.claude === null || (typeof r?.claude === "object" && isEntry(r.claude.entry) && typeof r.claude.claudeExe === "string" && typeof r.claude.configPath === "string" && fingerprintOk(r.claude.fingerprint))
    if (r?.schemaVersion !== 1 || r.product !== PRODUCT || typeof r.installDir !== "string" || typeof r.generation !== "string" || !/^[0-9a-f]{32}$/.test(r.generation) || typeof r.version !== "string" || !/^\d+\.\d+\.\d+$/.test(r.version) || !claudeOk || (r.profileDir !== null && typeof r.profileDir !== "string")) {
        throw new SetupRefusal("il registro di installazione non è riconosciuto: non viene sovrascritto")
    }
    return r as InstallRecord
}

/** Replaces a file of this installer through a temporary name in the same directory. */
function replaceFile(file: string, text: string): void {
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, text, { flag: "wx" })
    fs.renameSync(temp, file)
}

export function writeRecord(file: string, record: InstallRecord): void {
    replaceFile(file, `${JSON.stringify(record, null, 2)}\n`)
}

export function sameEntry(a: StdioEntry | null, b: StdioEntry | null): boolean {
    return a !== null && b !== null && isDeepStrictEqual(a, b)
}
