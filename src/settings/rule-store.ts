/**
 * The only code that writes config.json (FR-MCP-03-RULE-WRITE-01). Nothing else
 * in this server changes a profile, and this module never runs unless the user
 * enabled rule writes.
 *
 * Why Fluent Reader must be closed. The app's main process reads config.json
 * before every get and set (conf has no cache) and saves it with atomically
 * (temporary file + rename), so its own save is one synchronous
 * read-modify-write that nothing outside can join: a change from here between
 * its read and its rename is lost, and comparing hashes before our own rename
 * cannot close that gap. Besides, the renderer keeps the rules in Redux from
 * startup (initRules): rules saved here would not be used until a restart, and
 * saving the same target from the app's editor would overwrite them with its
 * stale list. So a write is refused while the app is open.
 *
 * How it is detected. The app takes Electron's single-instance lock
 * (bootstrap.ts), and on Windows Chromium keeps `lockfile` in the profile
 * directory with FILE_FLAG_DELETE_ON_CLOSE. Verified with the fork's Electron
 * 44 on a synthetic folder: present while the app is open, gone after a normal
 * exit or a forced kill. Its mere presence refuses the write: telling a live
 * lock from a stale one would mean opening it for writing, which could make an
 * app starting at that instant fail. A file left by a power loss is cleared by
 * opening and closing the app once.
 *
 * Remaining gap, documented: the app could start after the last check and save
 * before the rename, within a window of milliseconds; the check repeated after
 * the rename reports that case as RULE_WRITE_UNVERIFIED.
 *
 * Commit sequence:
 *   1. lockfile absent, profile directory still canonical (not re-routed);
 *   2. the guard: the temporary file, created exclusively at a fixed name. It
 *      also keeps two copies of this server from writing at once (one left by a
 *      crash is replaced once older than GUARD_STALE_MS; it never holds the
 *      only copy of anything);
 *   3. the private backup, exactly the bytes the change starts from;
 *   4. new content written to the guard and flushed;
 *   5. lockfile still absent and config.json still byte for byte the same;
 *   6. rename over config.json (atomic; config.json is never written in place).
 *      A retry after a brief refusal repeats step 5 first, after its pause: the
 *      refusal may be the app saving, and that save must not be overwritten;
 *   7. read back and compared; lockfile absent.
 * A failure up to step 6 leaves config.json untouched and removes the temporary
 * file. After step 6 nothing is restored automatically: the file may hold
 * someone else's change, and a backup is the user's to restore.
 *
 * Backups hold the whole configuration, credentials included. They are kept
 * only in %LOCALAPPDATA%\FluentReaderMCP-Data\rule-backups\<profile key>\, the
 * per-user storage the setup already uses for its copies, made of real
 * directories (no link or junction); if it is not usable nothing is written.
 * They are never deleted automatically and never returned: results carry the
 * file name only. No permission is read or changed.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { FrMcpError, isFrMcpError, systemErrorCode } from "../errors.js"
import { readConfigBytes, samePath } from "./read-settings.js"

export const APP_LOCK_FILE = "lockfile"
export const WRITE_GUARD_FILE = "config.json.frmcp-write.tmp"
export const BACKUP_ROOT = "FluentReaderMCP-Data"
export const BACKUP_KIND = "rule-backups"
export const BACKUP_NAME = /^config\.json\.\d{8}T\d{6}Z(?:-\d+)?\.bak$/
export const GUARD_STALE_MS = 60_000
const RENAME_ATTEMPTS = 5
export const RENAME_PAUSE_MS = 50
/** What a result may say about where backups are: no user name. */
export const BACKUP_LOCATION = `%LOCALAPPDATA%\\${BACKUP_ROOT}\\${BACKUP_KIND}`

/** Test-only seams: called at each step, and may change the file or throw. */
export type RuleWriteStep = "after-guard" | "after-backup" | "after-temp" | "before-rename" | "before-retry" | "after-rename"

export interface RuleWriteSettings {
    readonly enabled: boolean
    readonly localAppData?: string | undefined
    readonly userProfile?: string | undefined
    readonly step?: (step: RuleWriteStep) => void
}

/** Rule writes are on only for exactly "1": any other value, an empty one included, leaves them off. */
export const RULE_WRITES_ENV_VAR = "FLUENT_READER_MCP_ENABLE_RULE_WRITES"

export function ruleWriteSettingsFromEnv(env: Readonly<Record<string, string | undefined>>): RuleWriteSettings {
    return { enabled: env[RULE_WRITES_ENV_VAR] === "1", localAppData: env.LOCALAPPDATA, userProfile: env.USERPROFILE }
}

/** Whether the app's lock file is there (see above). Unknown counts as open. */
export function fluentReaderOpen(profileDir: string): boolean {
    try {
        return fs.lstatSync(path.join(profileDir, APP_LOCK_FILE), { throwIfNoEntry: false }) !== undefined
    } catch {
        return true
    }
}

function requireClosed(profileDir: string, reason: "lockfile-present" | "app-started" = "lockfile-present"): void {
    if (fluentReaderOpen(profileDir)) throw new FrMcpError("FLUENT_READER_RUNNING", reason)
}

function requireCanonicalProfile(profileDir: string): void {
    let real: string
    try {
        real = fs.realpathSync.native(profileDir)
    } catch {
        throw new FrMcpError("SETTINGS_UNAVAILABLE", "inaccessible")
    }
    if (!samePath(real, profileDir)) throw new FrMcpError("SETTINGS_UNAVAILABLE", "outside-profile")
}

/** Refused before any work: a write through a hard link would silently split the file from its other name. */
export function requireSingleLink(configPath: string): void {
    if (fs.statSync(configPath, { throwIfNoEntry: false })?.nlink !== 1) throw new FrMcpError("SETTINGS_UNAVAILABLE", "hard-linked")
}

function acquireGuard(profileDir: string, now: number): { fd: number; file: string } {
    const file = path.join(profileDir, WRITE_GUARD_FILE)
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return { fd: fs.openSync(file, "wx", 0o666), file }
        } catch (error) {
            if (systemErrorCode(error) !== "EEXIST") throw new FrMcpError("RULE_WRITE_FAILED", "write-failed")
        }
        const stats = fs.lstatSync(file, { throwIfNoEntry: false })
        if (stats !== undefined && (!stats.isFile() || now - stats.mtimeMs < GUARD_STALE_MS)) break
        try {
            if (stats !== undefined) fs.unlinkSync(file)
        } catch {
            break
        }
    }
    throw new FrMcpError("RULE_WRITE_BUSY", "write-in-progress")
}

function backupUnavailable(reason: "backup-location" | "backup-failed"): FrMcpError {
    return new FrMcpError("RULE_BACKUP_UNAVAILABLE", reason)
}

function isRealDirectory(dir: string): boolean {
    const stats = fs.lstatSync(dir, { throwIfNoEntry: false })
    return stats !== undefined && stats.isDirectory() && !stats.isSymbolicLink() && samePath(fs.realpathSync.native(dir), dir)
}

/** The profile's backup directory, created one level at a time; every level a real directory, inside the user profile. */
function backupDirectory(settings: RuleWriteSettings, profileDir: string): string {
    const { localAppData, userProfile } = settings
    if (localAppData === undefined || userProfile === undefined || !/^[A-Za-z]:[\\/]/.test(localAppData) || !/^[A-Za-z]:[\\/]/.test(userProfile)) throw backupUnavailable("backup-location")
    let base: string
    try {
        base = fs.realpathSync.native(path.resolve(localAppData))
        const home = fs.realpathSync.native(path.resolve(userProfile))
        const relative = path.relative(home, base)
        if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || !isRealDirectory(base)) throw backupUnavailable("backup-location")
    } catch (error) {
        throw isFrMcpError(error) ? error : backupUnavailable("backup-location")
    }
    const key = crypto.createHash("sha256").update(`fluent-reader-mcp\n${profileDir.toLowerCase()}`).digest("hex").slice(0, 32)
    let dir = base
    for (const part of [BACKUP_ROOT, BACKUP_KIND, key]) {
        dir = path.join(dir, part)
        try {
            if (fs.lstatSync(dir, { throwIfNoEntry: false }) === undefined) fs.mkdirSync(dir)
            if (!isRealDirectory(dir)) throw backupUnavailable("backup-location")
        } catch (error) {
            throw isFrMcpError(error) ? error : backupUnavailable("backup-location")
        }
    }
    return dir
}

/** Written to a temporary name, flushed, read back, then published under a new name; an existing copy is never replaced. */
function writeBackup(settings: RuleWriteSettings, profileDir: string, bytes: Buffer, now: number): string {
    const dir = backupDirectory(settings, profileDir)
    const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
    const temp = path.join(dir, `.config.json.${crypto.randomBytes(8).toString("hex")}.partial`)
    try {
        const fd = fs.openSync(temp, "wx", 0o600)
        try {
            fs.writeFileSync(fd, bytes)
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        if (!fs.readFileSync(temp).equals(bytes)) throw backupUnavailable("backup-failed")
        for (let i = 0; ; i++) {
            const name = `config.json.${stamp}${i === 0 ? "" : `-${i}`}.bak`
            const target = path.join(dir, name)
            if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) continue
            fs.renameSync(temp, target)
            return name
        }
    } catch (error) {
        fs.rmSync(temp, { force: true })
        throw isFrMcpError(error) ? error : backupUnavailable("backup-failed")
    }
}

/**
 * Windows reports a file briefly held by another program as EPERM, EACCES or
 * EBUSY. `beforeRetry` runs after each pause and stops the retries by throwing.
 */
async function replaceWithRetry(from: string, to: string, beforeRetry: () => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            fs.renameSync(from, to)
            return
        } catch (error) {
            const code = systemErrorCode(error)
            if (attempt >= RENAME_ATTEMPTS || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw new FrMcpError("RULE_WRITE_FAILED", "replace-failed")
            await sleep(RENAME_PAUSE_MS)
            await beforeRetry()
        }
    }
}

/** Step 5. The lockfile is checked again after the read, which can pause while the file is held. */
async function requireUntouched(configPath: string, profileDir: string, original: Buffer): Promise<void> {
    requireClosed(profileDir)
    const current = await readConfigBytes(configPath, profileDir, undefined)
    const unchanged = current.bytes.equals(original)
    current.bytes.fill(0)
    if (!unchanged) throw new FrMcpError("REVISION_CONFLICT", "settings-changed")
    requireClosed(profileDir)
}

export interface CommitInput {
    readonly configPath: string
    readonly profileDir: string
    readonly settings: RuleWriteSettings
    /** The bytes `next` was computed from. */
    readonly original: Buffer
    readonly next: Buffer
    readonly now: number
}

/** Runs the sequence above; returns the backup's file name. */
export async function commitConfig(input: CommitInput): Promise<string> {
    const { configPath, profileDir, settings, original, next, now } = input
    requireClosed(profileDir)
    requireCanonicalProfile(profileDir)
    const guard = acquireGuard(profileDir, now)
    let open = true
    let backup: string
    try {
        settings.step?.("after-guard")
        backup = writeBackup(settings, profileDir, original, now)
        settings.step?.("after-backup")
        fs.writeFileSync(guard.fd, next)
        fs.fsyncSync(guard.fd)
        fs.closeSync(guard.fd)
        open = false
        settings.step?.("after-temp")
        await requireUntouched(configPath, profileDir, original)
        settings.step?.("before-rename")
        await replaceWithRetry(guard.file, configPath, async () => {
            settings.step?.("before-retry")
            await requireUntouched(configPath, profileDir, original)
        })
    } catch (error) {
        if (open) {
            try {
                fs.closeSync(guard.fd)
            } catch {
                // already closed
            }
        }
        try {
            fs.rmSync(guard.file, { force: true })
        } catch {
            // Left behind, it is replaced once stale; config.json was not touched.
        }
        throw isFrMcpError(error) ? error : new FrMcpError("RULE_WRITE_FAILED", "write-failed")
    }
    try {
        settings.step?.("after-rename")
        const saved = await readConfigBytes(configPath, profileDir, undefined)
        const same = saved.bytes.equals(next)
        saved.bytes.fill(0)
        if (!same) throw new FrMcpError("RULE_WRITE_UNVERIFIED", "read-back-failed")
    } catch {
        throw new FrMcpError("RULE_WRITE_UNVERIFIED", "read-back-failed")
    }
    if (fluentReaderOpen(profileDir)) throw new FrMcpError("RULE_WRITE_UNVERIFIED", "app-started")
    return backup
}
