/**
 * The only code that writes config.json (FR-MCP-03-RULE-WRITE-01). Nothing else
 * in this server changes a profile, and this module runs only for a rule change
 * a client explicitly asked for, never at startup or when listing tools.
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
 *   2. the guard, created exclusively at a fixed name, holding only a random
 *      owner token (see below);
 *   3. the private backup, exactly the bytes the change starts from;
 *   4. new content written to a temporary file with a unique name and flushed;
 *   5. lockfile still absent and config.json still byte for byte the same;
 *   6. the guard still holds this writer's token, then rename of the temporary
 *      file over config.json (atomic; config.json is never written in place). A
 *      retry after a brief refusal repeats step 5 and this check first, after
 *      its pause: the refusal may be the app saving, and that save must not be
 *      overwritten;
 *   7. read back and compared; lockfile absent;
 *   8. the guard released.
 * A failure up to step 6 leaves config.json untouched and removes the temporary
 * file. After step 6 nothing is restored automatically: the file may hold
 * someone else's change, and a backup is the user's to restore.
 *
 * The guard keeps two copies of this server from writing at once, until the
 * result has been read back. Only the exclusive create takes it, and nothing
 * here removes a guard it did not create: whether one was abandoned cannot be
 * proven atomically, because between looking at it and deleting it a new owner
 * may have taken its place. So age is only a diagnostic (RULE_WRITE_BUSY with
 * reason write-guard-orphaned), and a guard left by a crash refuses writes, never
 * reads or previews, until someone removes it on purpose:
 *   1. close Fluent Reader and every MCP client using this profile, so that no
 *      writer is alive;
 *   2. delete config.json.frmcp-write.tmp from the profile directory. config.json
 *      was not touched. The next writer also removes the temporary file a crash
 *      left, which holds a copy of the settings.
 * If the token cannot be written, the guard stays where it is, for the same reason.
 *
 * Remaining gap, documented: a holder compares its token and then acts (rename,
 * release), with no way to do both atomically. It matters only if someone deletes
 * the guard of a writer still alive and a new writer takes it in those few
 * microseconds, which step 1 of the recovery excludes.
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
const WRITE_TEMP_PREFIX = "config.json.frmcp-write."
const WRITE_TEMP = /^config\.json\.frmcp-write\.[0-9a-f]{16}\.partial$/
export const BACKUP_ROOT = "FluentReaderMCP-Data"
export const BACKUP_KIND = "rule-backups"
export const BACKUP_NAME = /^config\.json\.\d{8}T\d{6}Z(?:-\d+)?\.bak$/
/** Beyond this age a guard is reported as possibly orphaned. It decides nothing about the guard. */
export const GUARD_STALE_MS = 60_000
const RENAME_ATTEMPTS = 5
export const RENAME_PAUSE_MS = 50
/** What a result may say about where backups are: no user name. */
export const BACKUP_LOCATION = `%LOCALAPPDATA%\\${BACKUP_ROOT}\\${BACKUP_KIND}`

/** Test-only seams: called at each step, and may change the file or throw. */
export type RuleWriteStep = "after-guard" | "after-backup" | "after-temp" | "before-rename" | "before-retry" | "after-rename"

export interface RuleWriteSettings {
    readonly localAppData?: string | undefined
    readonly userProfile?: string | undefined
    readonly step?: (step: RuleWriteStep) => void
}

export function ruleWriteSettingsFromEnv(env: Readonly<Record<string, string | undefined>>): RuleWriteSettings {
    return { localAppData: env.LOCALAPPDATA, userProfile: env.USERPROFILE }
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

interface HeldGuard {
    readonly file: string
    readonly token: string
}

function guardLooksOrphaned(file: string, now: number): boolean {
    try {
        const stats = fs.lstatSync(file, { throwIfNoEntry: false })
        return stats !== undefined && now - stats.mtimeMs >= GUARD_STALE_MS
    } catch {
        return false
    }
}

function acquireGuard(profileDir: string, now: number): HeldGuard {
    const file = path.join(profileDir, WRITE_GUARD_FILE)
    let fd: number
    try {
        fd = fs.openSync(file, "wx", 0o666)
    } catch (error) {
        if (systemErrorCode(error) !== "EEXIST") throw new FrMcpError("RULE_WRITE_FAILED", "write-failed")
        throw new FrMcpError("RULE_WRITE_BUSY", guardLooksOrphaned(file, now) ? "write-guard-orphaned" : "write-in-progress")
    }
    const token = crypto.randomBytes(16).toString("hex")
    try {
        fs.writeSync(fd, token)
    } catch {
        // The pathname may already belong to someone else, so it is left alone: at worst an orphan guard, recovered by hand.
        try { fs.closeSync(fd) } catch { /* the write failure is the error to report */ }
        throw new FrMcpError("RULE_WRITE_FAILED", "write-failed")
    }
    try { fs.closeSync(fd) } catch { /* the token is written; the guard is held */ }
    return { file, token }
}

function ownsGuard(guard: HeldGuard): boolean {
    try {
        return fs.readFileSync(guard.file, "utf8") === guard.token
    } catch {
        return false
    }
}

function requireOwnedGuard(guard: HeldGuard): void {
    if (!ownsGuard(guard)) throw new FrMcpError("RULE_WRITE_BUSY", "write-in-progress")
}

/** A guard that is not this writer's, or that stays held, is left where it is: the next write reports it. */
async function releaseGuard(guard: HeldGuard): Promise<void> {
    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
        if (!ownsGuard(guard)) return
        try {
            fs.unlinkSync(guard.file)
            return
        } catch (error) {
            const code = systemErrorCode(error)
            if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") return
            if (attempt < RENAME_ATTEMPTS) await sleep(RENAME_PAUSE_MS)
        }
    }
}

/** Only a dead writer leaves these, and whoever really holds the guard is the only live writer. */
function removeDeadTemps(profileDir: string, guard: HeldGuard): void {
    if (!ownsGuard(guard)) return
    try {
        for (const name of fs.readdirSync(profileDir)) {
            if (WRITE_TEMP.test(name)) fs.rmSync(path.join(profileDir, name), { force: true })
        }
    } catch {
        // Retried by the next writer.
    }
}

function writeTemp(file: string, bytes: Buffer): void {
    const fd = fs.openSync(file, "wx", 0o666)
    try {
        fs.writeFileSync(fd, bytes)
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
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
    // Nobody else knows this name, so what is renamed over config.json, or removed after a failure, is always this writer's own file.
    const temp = path.join(profileDir, `${WRITE_TEMP_PREFIX}${crypto.randomBytes(8).toString("hex")}.partial`)
    try {
        let backup: string
        try {
            removeDeadTemps(profileDir, guard)
            settings.step?.("after-guard")
            backup = writeBackup(settings, profileDir, original, now)
            settings.step?.("after-backup")
            writeTemp(temp, next)
            settings.step?.("after-temp")
            await requireUntouched(configPath, profileDir, original)
            settings.step?.("before-rename")
            requireOwnedGuard(guard)
            await replaceWithRetry(temp, configPath, async () => {
                settings.step?.("before-retry")
                await requireUntouched(configPath, profileDir, original)
                requireOwnedGuard(guard)
            })
        } catch (error) {
            try {
                fs.rmSync(temp, { force: true })
            } catch {
                // Removed by the next writer that holds the guard; config.json was not touched.
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
    } finally {
        await releaseGuard(guard)
    }
}
