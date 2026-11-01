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
    /** File name of the backup taken before the change. */
    readonly backup: string | null
    /**
     * FR-MCP-04-BETA-03A-SIMPLE-02: the private directory of `backup` when it was written (backups.ts), only
     * compared with the one derived again for the current user, never used as a destination; and the backup's
     * SHA-256. Both or neither (backupReference): absent in records of earlier setups, whose `backup` is in
     * state\claude-config-backups.
     */
    readonly backupDir?: string
    readonly backupSha256?: string
    readonly updatedAt: string
}

/** The only names a copy of the Claude configuration taken by this product has. */
export const BACKUP_NAME = /^claude\.json\.\d{8}T\d{6}Z(-\d+)?\.bak$/

/**
 * What a registration says about its backup, in one of two complete forms or none:
 *  none     no backup (no name, no directory, no hash)
 *  legacy   a name only (earlier setups): the file is in state\claude-config-backups
 *  private  name, private directory and SHA-256 (backups.ts)
 *  invalid  anything else (a field without the others, a malformed hash or directory, a name of another kind):
 *           never described as available, never a reason to move or delete anything
 * The record stays readable either way (the uninstaller still needs it for the Claude Code entry).
 */
export type BackupReference =
    | { readonly kind: "none" }
    | { readonly kind: "legacy"; readonly name: string }
    | { readonly kind: "private"; readonly name: string; readonly dir: string; readonly sha256: string }
    | { readonly kind: "invalid"; readonly reason: string }

export function backupReference(reg: Registration | null): BackupReference {
    if (reg === null) return { kind: "none" }
    const { backup: name, backupDir: dir, backupSha256: sha256 } = reg
    if (name === null || name === undefined) return dir === undefined && sha256 === undefined ? { kind: "none" } : { kind: "invalid", reason: "cartella o impronta di una copia senza nome" }
    if (typeof name !== "string" || !BACKUP_NAME.test(name)) return { kind: "invalid", reason: "nome della copia non previsto" }
    if (dir === undefined && sha256 === undefined) return { kind: "legacy", name }
    if (dir === undefined || sha256 === undefined) return { kind: "invalid", reason: "riferimento incompleto (cartella o impronta mancante)" }
    if (typeof dir !== "string" || !/^[A-Za-z]:\\/.test(dir) || !path.win32.isAbsolute(dir)) return { kind: "invalid", reason: "cartella della copia non valida" }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return { kind: "invalid", reason: "impronta SHA-256 della copia non valida" }
    return { kind: "private", name, dir, sha256 }
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
    // types only: the coherence of the backup fields is judged by backupReference, without making the record unreadable
    const backupOk = (c: Partial<Registration>): boolean => (c.backupDir === undefined || typeof c.backupDir === "string") && (c.backupSha256 === undefined || typeof c.backupSha256 === "string")
    const claudeOk = r?.claude === null || (typeof r?.claude === "object" && isEntry(r.claude.entry) && typeof r.claude.claudeExe === "string" && typeof r.claude.configPath === "string" && fingerprintOk(r.claude.fingerprint) && backupOk(r.claude))
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
