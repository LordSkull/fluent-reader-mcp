import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { FrMcpError, isFrMcpError, systemErrorCode } from "../errors.js"
import { inspectPreferences, PREFERENCES_BYTES_MAX, type DocumentIssue, type ParsedPreferences } from "./markdown.js"

export const PREFERENCES_ROOT = "FluentReaderMCP-Data"
export const PREFERENCES_KIND = "news-preferences"
export const PREFERENCES_FILE = "preferences.md"
export const IDENTITY_FILE = "identity.key"
export const PREFERENCES_LOCK = "preferences.lock"
export const PREFERENCES_BACKUPS = "backups"
export const PREVIEW_TTL_MS = 15 * 60_000
const LOCK_ORPHAN_HINT_MS = 60_000
const RENAME_ATTEMPTS = 5
const RENAME_PAUSE_MS = 50
const KEY_BYTES = 32
const READ_CHUNK = 64 * 1024
const PARTIAL_FILE = /^\.(?:preferences|identity)\.[0-9a-f]{16}\.partial$/

/** Fault injection points for tests. */
export type PreferenceStep = "before-rename" | "after-rename" | "key-written"

export interface NewsPreferenceSettings {
    readonly localAppData?: string | undefined
    readonly userProfile?: string | undefined
    readonly previewKey: Buffer
    readonly usedTokens: Set<string>
    readonly step?: (step: PreferenceStep) => void
}

export interface PreferencePaths {
    readonly root: string
    readonly document: string
    readonly key: string
    readonly lock: string
    readonly backups: string
}

export type ProfileBindingStatus = "verified" | "mismatch" | "keyMissing" | "notInitialized" | "unverifiable"
export type DocumentStatus = "absent" | "ready" | "damaged" | "tooLarge"

export interface PreferenceState {
    readonly paths: PreferencePaths
    readonly revision: string
    readonly key: Buffer | null
    readonly keyInvalid: boolean
    readonly parsed: ParsedPreferences | null
    readonly bytes: Buffer | null
    readonly size: number | null
    readonly documentStatus: DocumentStatus
    readonly issue: DocumentIssue | null
    readonly profileBinding: ProfileBindingStatus
}

export function newsPreferenceSettingsFromEnv(env: Readonly<Record<string, string | undefined>>): NewsPreferenceSettings {
    return {
        localAppData: env.LOCALAPPDATA,
        userProfile: env.USERPROFILE,
        previewKey: crypto.randomBytes(32),
        usedTokens: new Set(),
    }
}

function samePath(a: string, b: string): boolean {
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function realDirectory(dir: string): boolean {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
    return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink() && samePath(fs.realpathSync.native(dir), dir)
}

function requireStorageBase(settings: NewsPreferenceSettings): string {
    const { localAppData, userProfile } = settings
    if (localAppData === undefined || userProfile === undefined || !path.isAbsolute(localAppData) || !path.isAbsolute(userProfile)) {
        throw new FrMcpError("PREFERENCES_UNAVAILABLE", "storage-location")
    }
    try {
        const base = fs.realpathSync.native(path.resolve(localAppData))
        const home = fs.realpathSync.native(path.resolve(userProfile))
        const relative = path.relative(home, base)
        if (relative === "" || relative.split(path.sep)[0] === ".." || path.isAbsolute(relative) || !realDirectory(base)) {
            throw new FrMcpError("PREFERENCES_UNAVAILABLE", "storage-location")
        }
        return base
    } catch (error) {
        throw isFrMcpError(error) ? error : new FrMcpError("PREFERENCES_UNAVAILABLE", "storage-location")
    }
}

/** The canonical profile path: the only profile fact a binding may depend on, because config.json and the database are replaced in normal use. */
function canonicalProfile(profileDir: string): string {
    try {
        const directory = fs.realpathSync.native(profileDir)
        return process.platform === "win32" ? directory.toLowerCase() : directory
    } catch {
        throw new FrMcpError("PREFERENCES_UNAVAILABLE", "profile-identity")
    }
}

const storeKey = (profileDir: string): string =>
    crypto.createHash("sha256").update(`fluent-reader-mcp\n${canonicalProfile(profileDir)}`).digest("hex").slice(0, 32)

export function preferencePaths(settings: NewsPreferenceSettings, profileDir: string): PreferencePaths {
    const base = requireStorageBase(settings)
    const root = path.join(base, PREFERENCES_ROOT, PREFERENCES_KIND, storeKey(profileDir))
    return {
        root,
        document: path.join(root, PREFERENCES_FILE),
        key: path.join(root, IDENTITY_FILE),
        lock: path.join(root, PREFERENCES_LOCK),
        backups: path.join(root, PREFERENCES_BACKUPS),
    }
}

/** Where the private files of this profile live, without the user name. */
export function storageLocation(profileDir: string): string {
    return `%LOCALAPPDATA%\\${PREFERENCES_ROOT}\\${PREFERENCES_KIND}\\${storeKey(profileDir)}`
}

function regular(file: string): boolean {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    if (stat === undefined) return false
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new FrMcpError("PREFERENCES_UNAVAILABLE", "unsafe-storage")
    if (!samePath(fs.realpathSync.native(file), file)) throw new FrMcpError("PREFERENCES_UNAVAILABLE", "unsafe-storage")
    return true
}

export function documentRevision(bytes: Buffer): string {
    return `pr1.${crypto.createHash("sha256").update(bytes).digest().subarray(0, 16).toString("base64url")}`
}

export function currentProfileBinding(key: Buffer, profileDir: string): string {
    return `pb1.${crypto.createHmac("sha256", key).update("fluent-reader-mcp/news-preferences/profile/1\0").update(canonicalProfile(profileDir)).digest().subarray(0, 16).toString("base64url")}`
}

/** Bounded in memory whatever the file size; the revision always covers every byte. */
function readDocument(file: string): { bytes: Buffer | null; revision: string; size: number } {
    const fd = fs.openSync(file, "r")
    try {
        const hash = crypto.createHash("sha256")
        const chunks: Buffer[] = []
        const chunk = Buffer.allocUnsafe(READ_CHUNK)
        let size = 0
        for (;;) {
            const read = fs.readSync(fd, chunk, 0, READ_CHUNK, null)
            if (read === 0) break
            const piece = chunk.subarray(0, read)
            hash.update(piece)
            size += read
            if (size <= PREFERENCES_BYTES_MAX) chunks.push(Buffer.from(piece))
        }
        return {
            bytes: size <= PREFERENCES_BYTES_MAX ? Buffer.concat(chunks) : null,
            revision: `pr1.${hash.digest().subarray(0, 16).toString("base64url")}`,
            size,
        }
    } finally {
        fs.closeSync(fd)
    }
}

function readKey(file: string): Buffer | null {
    const fd = fs.openSync(file, "r")
    try {
        const buffer = Buffer.alloc(KEY_BYTES + 1)
        let total = 0
        for (;;) {
            const read = fs.readSync(fd, buffer, total, buffer.length - total, null)
            if (read === 0) break
            total += read
            if (total === buffer.length) break
        }
        return total === KEY_BYTES ? buffer.subarray(0, KEY_BYTES) : null
    } finally {
        fs.closeSync(fd)
    }
}

/** Reads never create or change anything, and a damaged document or key does not hide the rest of the state. */
export function readPreferenceState(settings: NewsPreferenceSettings, profileDir: string): PreferenceState {
    const paths = preferencePaths(settings, profileDir)
    const absent = (key: Buffer | null, keyInvalid: boolean): PreferenceState => ({
        paths, revision: "absent", key, keyInvalid, parsed: null, bytes: null, size: null, documentStatus: "absent", issue: null, profileBinding: "notInitialized",
    })
    try {
        if (fs.lstatSync(paths.root, { throwIfNoEntry: false }) === undefined) {
            // A link above the store must still be refused, not read as an empty store.
            const kind = path.dirname(paths.root)
            for (const level of [kind, path.dirname(kind)]) {
                if (fs.lstatSync(level, { throwIfNoEntry: false }) !== undefined && !realDirectory(level)) throw new FrMcpError("PREFERENCES_UNAVAILABLE", "unsafe-storage")
            }
            return absent(null, false)
        }
        if (!realDirectory(paths.root)) throw new FrMcpError("PREFERENCES_UNAVAILABLE", "unsafe-storage")
        const documentExists = regular(paths.document)
        const key = regular(paths.key) ? readKey(paths.key) : null
        const keyInvalid = key === null && fs.lstatSync(paths.key, { throwIfNoEntry: false }) !== undefined
        if (!documentExists) return absent(key, keyInvalid)
        const read = readDocument(paths.document)
        if (read.bytes === null) {
            return { paths, revision: read.revision, key, keyInvalid, parsed: null, bytes: null, size: read.size, documentStatus: "tooLarge", issue: { code: "file-too-large", line: 0 }, profileBinding: "unverifiable" }
        }
        const { parsed, issue } = inspectPreferences(read.bytes)
        if (parsed === null) {
            return { paths, revision: read.revision, key, keyInvalid, parsed: null, bytes: read.bytes, size: read.size, documentStatus: "damaged", issue, profileBinding: "unverifiable" }
        }
        const profileBinding: ProfileBindingStatus = key === null ? "keyMissing" : parsed.metadata.profileBinding === currentProfileBinding(key, profileDir) ? "verified" : "mismatch"
        return { paths, revision: read.revision, key, keyInvalid, parsed, bytes: read.bytes, size: read.size, documentStatus: "ready", issue: null, profileBinding }
    } catch (error) {
        throw isFrMcpError(error) ? error : new FrMcpError("PREFERENCES_UNAVAILABLE", "preferences-read-failed")
    }
}

function ensureDirectory(parent: string, name: string): string {
    const dir = path.join(parent, name)
    try {
        if (fs.lstatSync(dir, { throwIfNoEntry: false }) === undefined) {
            try {
                fs.mkdirSync(dir)
            } catch (error) {
                if (systemErrorCode(error) !== "EEXIST") throw error
            }
        }
        if (!realDirectory(dir)) throw new FrMcpError("PREFERENCES_UNAVAILABLE", "unsafe-storage")
        return dir
    } catch (error) {
        throw isFrMcpError(error) ? error : new FrMcpError("PREFERENCES_UNAVAILABLE", "storage-location")
    }
}

function ensureRoot(settings: NewsPreferenceSettings, profileDir: string): PreferencePaths {
    const paths = preferencePaths(settings, profileDir)
    const base = requireStorageBase(settings)
    const product = ensureDirectory(base, PREFERENCES_ROOT)
    const kind = ensureDirectory(product, PREFERENCES_KIND)
    ensureDirectory(kind, path.basename(paths.root))
    return paths
}

interface HeldLock {
    readonly nonce: string
    readonly fd: number
}

/**
 * The lock is taken only by the atomic `wx` create, and no code here removes a
 * lock it did not create. Whether a lock was abandoned cannot be proven
 * atomically: between looking at it and deleting it, a new owner may have taken
 * its place, and deleting that one would give two writers. So age is only a
 * diagnostic, and a lock left by a crash refuses writes (never reads) until
 * someone removes it on purpose:
 *
 *   1. get_news_preferences warns writeLockMayBeOrphaned and gives storageLocation;
 *   2. close every MCP client using this profile, so that no writer is alive;
 *   3. delete preferences.lock from that folder; the document is untouched.
 *
 * The random token in the lock makes a holder notice that step 3 was done while
 * it was still alive: it then stops before replacing the document.
 */
function acquireLock(paths: PreferencePaths, now: number): HeldLock {
    let fd: number
    try {
        fd = fs.openSync(paths.lock, "wx", 0o600)
    } catch (error) {
        if (systemErrorCode(error) !== "EEXIST") throw new FrMcpError("PREFERENCES_WRITE_FAILED", "write-failed")
        throw new FrMcpError("PREFERENCES_WRITE_BUSY", writeLockLooksOrphaned(paths, now) ? "write-lock-orphaned" : "write-in-progress")
    }
    const nonce = crypto.randomBytes(16).toString("hex")
    try {
        fs.writeSync(fd, nonce)
        return { fd, nonce }
    } catch {
        // The pathname may already belong to someone else, so it is left alone: at worst an orphan lock, recovered by hand as described above.
        try { fs.closeSync(fd) } catch { /* the write failure is the error to report */ }
        throw new FrMcpError("PREFERENCES_WRITE_FAILED", "write-failed")
    }
}

/** Only a hint for the person reading the warning: it never decides anything about the lock. */
export function writeLockLooksOrphaned(paths: PreferencePaths, now: number): boolean {
    try {
        const stat = fs.lstatSync(paths.lock, { throwIfNoEntry: false })
        return stat !== undefined && now - stat.mtimeMs >= LOCK_ORPHAN_HINT_MS
    } catch {
        return false
    }
}

function ownsLock(paths: PreferencePaths, lock: HeldLock): boolean {
    try {
        return fs.readFileSync(paths.lock, "utf8") === lock.nonce
    } catch {
        return false
    }
}

function releaseLock(paths: PreferencePaths, lock: HeldLock): void {
    try { fs.closeSync(lock.fd) } catch { /* already closed */ }
    try {
        if (ownsLock(paths, lock)) fs.unlinkSync(paths.lock)
    } catch { /* it stays as an orphan lock, recovered by hand */ }
}

/** Only a dead writer leaves these, and whoever really holds the lock is the only live writer. */
function removeDeadPartials(paths: PreferencePaths, lock: HeldLock): void {
    if (!ownsLock(paths, lock)) return
    try {
        for (const name of fs.readdirSync(paths.root)) {
            if (PARTIAL_FILE.test(name)) fs.rmSync(path.join(paths.root, name), { force: true })
        }
    } catch { /* retried on the next write */ }
}

function partialPath(paths: PreferencePaths, kind: "preferences" | "identity"): string {
    return path.join(paths.root, `.${kind}.${crypto.randomBytes(8).toString("hex")}.partial`)
}

function writeDurable(file: string, bytes: Buffer): void {
    const fd = fs.openSync(file, "wx", 0o600)
    try {
        fs.writeFileSync(fd, bytes)
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
}

/**
 * identity.key appears complete or not at all: written aside and renamed under
 * the lock. A file of the wrong size (an older interrupted write) is moved
 * aside, never deleted, and a new key is generated: the document keeps its
 * text and needs an explicit reassociation.
 */
export function ensureIdentityKey(settings: NewsPreferenceSettings, profileDir: string, now: number): Buffer {
    const paths = ensureRoot(settings, profileDir)
    const lock = acquireLock(paths, now)
    const temp = partialPath(paths, "identity")
    try {
        removeDeadPartials(paths, lock)
        if (regular(paths.key)) {
            const existing = readKey(paths.key)
            if (existing !== null) return existing
            fs.renameSync(paths.key, path.join(paths.root, `${IDENTITY_FILE}.invalid-${crypto.randomBytes(4).toString("hex")}`))
        }
        const key = crypto.randomBytes(KEY_BYTES)
        writeDurable(temp, key)
        settings.step?.("key-written")
        if (!ownsLock(paths, lock)) throw new FrMcpError("PREFERENCES_WRITE_BUSY", "write-in-progress")
        fs.renameSync(temp, paths.key)
        const check = readKey(paths.key)
        if (check === null || !check.equals(key)) throw new FrMcpError("PREFERENCES_WRITE_UNVERIFIED", "read-back-failed")
        return key
    } catch (error) {
        try { fs.rmSync(temp, { force: true }) } catch { /* removed under the next lock */ }
        throw isFrMcpError(error) ? error : new FrMcpError("PREFERENCES_WRITE_FAILED", "write-failed")
    } finally {
        releaseLock(paths, lock)
    }
}

function backup(paths: PreferencePaths, bytes: Buffer, now: number): string {
    try {
        ensureDirectory(paths.root, PREFERENCES_BACKUPS)
    } catch {
        throw new FrMcpError("PREFERENCES_BACKUP_UNAVAILABLE", "backup-failed")
    }
    const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
    for (let index = 0; ; index++) {
        const name = `preferences.md.${stamp}${index === 0 ? "" : `-${index}`}.bak`
        const target = path.join(paths.backups, name)
        try {
            writeDurable(target, bytes)
            if (!fs.readFileSync(target).equals(bytes)) throw new FrMcpError("PREFERENCES_BACKUP_UNAVAILABLE", "backup-failed")
            return name
        } catch (error) {
            if (systemErrorCode(error) === "EEXIST") continue
            try { fs.rmSync(target, { force: true }) } catch { /* kept private */ }
            throw isFrMcpError(error) ? error : new FrMcpError("PREFERENCES_BACKUP_UNAVAILABLE", "backup-failed")
        }
    }
}

export interface CommitResult {
    readonly applied: boolean
    readonly previousRevision: string
    readonly revision: string
    readonly backup: string | null
}

export async function commitPreferences(
    settings: NewsPreferenceSettings,
    profileDir: string,
    expectedRevision: string,
    next: Buffer,
    now: number,
): Promise<CommitResult> {
    const paths = ensureRoot(settings, profileDir)
    const lock = acquireLock(paths, now)
    const temp = partialPath(paths, "preferences")
    let renamed = false
    try {
        removeDeadPartials(paths, lock)
        const state = readPreferenceState(settings, profileDir)
        if (state.revision !== expectedRevision) throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "revision-mismatch")
        if (state.bytes?.equals(next) === true) return { applied: false, previousRevision: state.revision, revision: state.revision, backup: null }
        const backupName = state.bytes === null ? null : backup(paths, state.bytes, now)
        writeDurable(temp, next)
        if (!fs.readFileSync(temp).equals(next)) throw new FrMcpError("PREFERENCES_WRITE_FAILED", "write-failed")
        for (let attempt = 1; ; attempt++) {
            settings.step?.("before-rename")
            if (!ownsLock(paths, lock)) throw new FrMcpError("PREFERENCES_WRITE_BUSY", "write-in-progress")
            const current = readPreferenceState(settings, profileDir)
            if (current.revision !== expectedRevision || (state.bytes !== null && current.bytes?.equals(state.bytes) !== true)) {
                throw new FrMcpError("PREFERENCES_REVISION_CONFLICT", "revision-mismatch")
            }
            try {
                fs.renameSync(temp, paths.document)
                renamed = true
                break
            } catch (error) {
                const code = systemErrorCode(error)
                if (attempt >= RENAME_ATTEMPTS || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw new FrMcpError("PREFERENCES_WRITE_FAILED", "replace-failed")
                await sleep(RENAME_PAUSE_MS)
            }
        }
        settings.step?.("after-rename")
        const saved = fs.readFileSync(paths.document)
        if (!saved.equals(next)) throw new FrMcpError("PREFERENCES_WRITE_UNVERIFIED", "read-back-failed")
        return { applied: true, previousRevision: expectedRevision, revision: documentRevision(saved), backup: backupName }
    } catch (error) {
        try { fs.rmSync(temp, { force: true }) } catch { /* removed under the next lock */ }
        if (renamed) throw new FrMcpError("PREFERENCES_WRITE_UNVERIFIED", "read-back-failed")
        if (isFrMcpError(error)) throw error
        throw new FrMcpError("PREFERENCES_WRITE_FAILED", "write-failed")
    } finally {
        releaseLock(paths, lock)
    }
}
