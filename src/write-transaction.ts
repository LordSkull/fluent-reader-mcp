/**
 * The crash-safe bookkeeping of one write by add_rule, update_rule,
 * delete_rule or apply_news_preferences_change. The stores (settings/rule-store.ts,
 * preferences/store.ts) hold their own guard or lock around every call here.
 *
 * In the store's private folder under %LOCALAPPDATA%\FluentReaderMCP-Data, a
 * transaction is two files with a random id:
 *   tx-<id>.original  the exact bytes the change starts from (absent when the
 *                     target did not exist: the journal records that instead);
 *   tx-<id>.journal   JSON with the SHA-256 and size of the original and of the
 *                     new content, the file id of the copy, and the phase. No
 *                     path, no content.
 *
 * Phases, each written by an atomic replacement of the journal:
 *   prepared       copy and journal durable; the target may or may not have been
 *                  replaced yet, and the result is not verified;
 *   rolling-back   the target was proven to be this write's and is being restored;
 *   verified       every check passed: only the cleanup is left;
 *   recovery-kept  the outcome is uncertain, or a file is not provably this
 *                  transaction's: everything is kept for the user, nothing is automatic.
 *
 * NOTHING HERE OVERWRITES OR DELETES, BY NAME ALONE, A FILE THAT MAY NOT BE THIS
 * WRITER'S: the target, a copy, a journal. (This writer's own temporary files,
 * created moments earlier under fresh random names, are removed by name.) Windows offers no
 * "replace or delete only if this is still the file I checked" through Node.js,
 * and a check followed by a rename or unlink leaves a window in which another
 * process can put its own file under that name. So every destructive step goes
 * through two primitives that cannot destroy someone else's data:
 *   - rename to a NEW random name in the same folder (a name nobody else knows
 *     and that does not exist: nothing is replaced; whatever file sits under the
 *     old name, ours or not, is only moved);
 *   - hard link to a name that must not exist (CreateHardLinkW fails atomically
 *     with EEXIST if the name was taken in the meantime: nothing is replaced).
 * A file moved aside is then checked through ONE open descriptor (regular file,
 * one link, file id, size, SHA-256). Only if it is provably this transaction's
 * is its private name removed; otherwise it is linked back under its original
 * name, never over anything, or left under the private name and reported.
 * The remaining assumption: no other process acts on a random name created a
 * moment earlier in this server's own folder.
 *
 * Recovery (recoverTransactions) runs at the start of the next write of the same
 * store, under its guard or lock, never at server startup: a server that only
 * reads never writes. It removes a transaction only when its outcome is proven by
 * the target's current content (still the original, or verified) AND its copy is
 * provably the one it recorded; otherwise it marks it recovery-kept. Copies
 * without a journal, journals that cannot be read, leftovers of an interrupted
 * removal (*.removing) and the permanent .bak copies of earlier versions are
 * never removed by this code.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { systemErrorCode, type ErrorReason } from "./errors.js"

export type TransactionKind = "rules" | "preferences"
export type TransactionPhase = "prepared" | "rolling-back" | "verified" | "recovery-kept"
export type ContentState = { readonly absent: true } | { readonly absent: false; readonly sha256: string; readonly size: number }

export const TRANSACTION_JOURNAL = /^tx-([0-9a-f]{16})\.journal$/
export const TRANSACTION_COPY = /^tx-[0-9a-f]{16}\.original$/
const JOURNAL_PARTIAL = /^tx-([0-9a-f]{16})\.journal\.[0-9a-f]{16}\.partial$/
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"])
const RENAME_ATTEMPTS = 5
const RENAME_PAUSE_MS = 50
/** A journal is a few hundred bytes; anything larger under that name is not one. */
const JOURNAL_MAX = 4096

/** What is expected of a file before it may be removed: its id (when known) and content. */
interface Expected {
    readonly identity: string | null
    readonly state: Extract<ContentState, { absent: false }>
}

export interface Transaction {
    readonly dir: string
    readonly id: string
    readonly kind: TransactionKind
    readonly original: ContentState
    readonly next: ContentState
    /** File name of the copy of the original, null when the target did not exist. */
    readonly copyName: string | null
    /** File id of the copy as created, recorded in the journal. */
    readonly copyIdentity: string | null
    readonly journalName: string
    /** The journal as this transaction last wrote (or read) it. */
    journal: Expected
}

interface JournalRecord {
    readonly schema: 1
    readonly kind: TransactionKind
    readonly id: string
    readonly phase: TransactionPhase
    readonly original: ContentState
    readonly next: ContentState
    readonly copyIdentity: string | null
    readonly reason: string | null
}

export function contentState(bytes: Buffer | null): ContentState {
    if (bytes === null) return { absent: true }
    return { absent: false, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length }
}

function presentState(bytes: Buffer): Extract<ContentState, { absent: false }> {
    return contentState(bytes) as Extract<ContentState, { absent: false }>
}

export function sameContent(a: ContentState, b: ContentState): boolean {
    if (a.absent || b.absent) return a.absent === b.absent
    return a.sha256 === b.sha256 && a.size === b.size
}

/** Volume and file id: what tells this write's file from any other with the same bytes. */
export function fileIdentity(stats: fs.BigIntStats): string {
    return `${stats.dev}:${stats.ino}`
}

/** Creates `file` exclusively, writes and flushes it; returns its identity. */
export function writeDurable(file: string, bytes: Buffer): string {
    const fd = fs.openSync(file, "wx", 0o600)
    try {
        fs.writeFileSync(fd, bytes)
        fs.fsyncSync(fd)
        return fileIdentity(fs.fstatSync(fd, { bigint: true }))
    } finally {
        fs.closeSync(fd)
    }
}

export interface InspectedFile {
    readonly identity: string
    readonly bytes: Buffer
}

/**
 * Reads a file through one descriptor: it must be a regular file with a single
 * link and at most `maxBytes`, and must not change size while read. Every fact
 * comes from that descriptor, so they all describe the same file. Returns null
 * when the file is absent, not regular, too large or changing.
 */
export function inspectFile(file: string, maxBytes: number, links = 1): InspectedFile | null {
    let fd: number
    try {
        fd = fs.openSync(file, "r")
    } catch {
        return null
    }
    try {
        const stats = fs.fstatSync(fd, { bigint: true })
        if (!stats.isFile() || stats.nlink !== BigInt(links) || stats.size > BigInt(maxBytes)) return null
        const size = Number(stats.size)
        const bytes = Buffer.alloc(size)
        let total = 0
        while (total < size) {
            const read = fs.readSync(fd, bytes, total, size - total, total)
            if (read === 0) return null
            total += read
        }
        // The file grew while it was read: not the file whose size was checked.
        if (fs.readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) return null
        const after = fs.fstatSync(fd, { bigint: true })
        if (after.size !== stats.size || after.mtimeNs !== stats.mtimeNs) return null
        return { identity: fileIdentity(stats), bytes }
    } catch {
        return null
    } finally {
        try { fs.closeSync(fd) } catch { /* the facts were read through it already */ }
    }
}

function matches(seen: InspectedFile | null, expected: Expected): boolean {
    return seen !== null && (expected.identity === null || seen.identity === expected.identity) && sameContent(contentState(seen.bytes), expected.state)
}

function randomHex(): string {
    return crypto.randomBytes(8).toString("hex")
}

/**
 * Puts a file moved aside back under `name` without replacing anything: a hard
 * link that fails if the name exists, then removal of the private name only.
 * Returns false if the file stays under the private name.
 */
function putBack(aside: string, name: string): boolean {
    try {
        fs.linkSync(aside, name)
    } catch {
        return false
    }
    try { fs.unlinkSync(aside) } catch { /* a second name of the same file: no data at stake */ }
    return true
}

/**
 * "retained": the file was proven to be the expected one but could not be
 * removed; it is back under its name (or, if even that failed, under its
 * private name). "kept": it is not provably the expected file and was left
 * as it was.
 */
export type RemoveOutcome = "removed" | "missing" | "kept" | "retained"

const escapeName = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The private names an interrupted removal gave to the very same file:
 * `<name>.<hex>.removing` siblings with the expected file id. Those, and only
 * those, explain a link count above one; any other extra link makes the file
 * unverifiable.
 */
function ownExtraNames(dir: string, name: string, identity: string | null): string[] {
    if (identity === null) return []
    const pattern = new RegExp(`^${escapeName(name)}\\.[0-9a-f]{16}\\.removing$`)
    try {
        return fs.readdirSync(dir).filter((entry) => {
            if (!pattern.test(entry)) return false
            const stats = fs.lstatSync(path.join(dir, entry), { throwIfNoEntry: false, bigint: true })
            return stats !== undefined && stats.isFile() && !stats.isSymbolicLink() && fileIdentity(stats) === identity
        })
    } catch {
        return []
    }
}

/**
 * Removes `dir/name` only if it is provably the expected file. It is moved to a
 * new private name first (nothing is replaced), checked through one descriptor
 * (regular, its link count, file id, size, SHA-256), then that private name is
 * removed. Anything else is put back, never over another file, and reported
 * as kept. Not atomic: the private name is assumed to be touched by nobody
 * else between the check and the removal (see the header).
 */
export function removeOwned(dir: string, name: string, expected: Expected): RemoveOutcome {
    const file = path.join(dir, name)
    let stats: fs.BigIntStats | undefined
    try {
        stats = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true })
    } catch {
        return "kept"
    }
    if (stats === undefined) return "missing"
    const extra = ownExtraNames(dir, name, expected.identity)
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== BigInt(1 + extra.length)) return "kept"
    if (expected.identity !== null && fileIdentity(stats) !== expected.identity) return "kept"
    const aside = path.join(dir, `${name}.${randomHex()}.removing`)
    try {
        fs.renameSync(file, aside)
    } catch (error) {
        return systemErrorCode(error) === "ENOENT" ? "missing" : "kept"
    }
    if (!matches(inspectFile(aside, expected.state.size, 1 + extra.length), expected)) {
        putBack(aside, file)
        return "kept"
    }
    // Names of the very file just verified, left by an earlier interrupted removal.
    for (const old of extra) {
        try { fs.unlinkSync(path.join(dir, old)) } catch { /* still a name of the same file: counted next time */ }
    }
    try {
        fs.unlinkSync(aside)
        return "removed"
    } catch {
        putBack(aside, file)
        return "retained"
    }
}

function record(tx: Transaction, phase: TransactionPhase, reason: string | null): Buffer {
    const body: JournalRecord = { schema: 1, kind: tx.kind, id: tx.id, phase, original: tx.original, next: tx.next, copyIdentity: tx.copyIdentity, reason }
    return Buffer.from(`${JSON.stringify(body)}\n`, "utf8")
}

/**
 * Starts a transaction: the copy of `original` (verified by reading it back),
 * then the journal, both durable before the target is touched. On failure
 * nothing of it is left and the error is rethrown.
 */
export function beginTransaction(dir: string, kind: TransactionKind, original: Buffer | null, next: Buffer): Transaction {
    const id = randomHex()
    const copyName = original === null ? null : `tx-${id}.original`
    const created: [string, Expected][] = []
    try {
        let copyIdentity: string | null = null
        if (original !== null && copyName !== null) {
            copyIdentity = writeDurable(path.join(dir, copyName), original)
            const expected: Expected = { identity: copyIdentity, state: presentState(original) }
            created.push([copyName, expected])
            if (!matches(inspectFile(path.join(dir, copyName), original.length), expected)) throw new Error("copy differs")
        }
        const tx: Transaction = {
            dir, id, kind, original: contentState(original), next: contentState(next), copyName, copyIdentity,
            journalName: `tx-${id}.journal`, journal: { identity: null, state: presentState(Buffer.alloc(0)) },
        }
        const bytes = record(tx, "prepared", null)
        tx.journal = { identity: writeDurable(path.join(dir, tx.journalName), bytes), state: presentState(bytes) }
        created.push([tx.journalName, tx.journal])
        return tx
    } catch (error) {
        // Only files whose exclusive creation succeeded here, and only while they are still those files.
        for (const [name, expected] of created.reverse()) removeOwned(dir, name, expected)
        throw error
    }
}

/** Replaces the journal atomically: the previous phase stays until the new one is durable. */
export function setPhase(tx: Transaction, phase: TransactionPhase, reason: string | null = null): void {
    const temp = path.join(tx.dir, `${tx.journalName}.${randomHex()}.partial`)
    const bytes = record(tx, phase, reason)
    let identity: string | null = null
    try {
        identity = writeDurable(temp, bytes)
        fs.renameSync(temp, path.join(tx.dir, tx.journalName))
        tx.journal = { identity, state: presentState(bytes) }
    } catch (error) {
        if (identity !== null) removeOwned(tx.dir, path.basename(temp), { identity, state: presentState(bytes) })
        throw error
    }
}

export type CopyStatus = "verified" | "unverifiable" | "missing" | "none"

/** Whether the copy of the original is there and still exactly what the transaction recorded. */
export function copyStatus(tx: Transaction): CopyStatus {
    if (tx.copyName === null || tx.original.absent) return "none"
    const file = path.join(tx.dir, tx.copyName)
    let stats: fs.Stats | undefined
    try {
        stats = fs.lstatSync(file, { throwIfNoEntry: false })
    } catch {
        return "unverifiable"
    }
    if (stats === undefined) return "missing"
    if (stats.isSymbolicLink() || !stats.isFile()) return "unverifiable"
    const links = 1 + ownExtraNames(tx.dir, tx.copyName, tx.copyIdentity).length
    return matches(inspectFile(file, tx.original.size, links), { identity: tx.copyIdentity, state: tx.original }) ? "verified" : "unverifiable"
}

/** The copy of the original, only if it is still the recorded file with the recorded content. */
function readCopy(tx: Transaction): Buffer | null {
    if (tx.copyName === null || tx.original.absent) return null
    const file = path.join(tx.dir, tx.copyName)
    const stats = fs.lstatSync(file, { throwIfNoEntry: false })
    if (stats === undefined || stats.isSymbolicLink() || !stats.isFile()) return null
    const seen = inspectFile(file, tx.original.size, 1 + ownExtraNames(tx.dir, tx.copyName, tx.copyIdentity).length)
    return seen !== null && matches(seen, { identity: tx.copyIdentity, state: tx.original }) ? seen.bytes : null
}

/** Removes the copy, then the journal, each only if provably this transaction's. Returns whether both are gone; never throws. */
function removeFiles(tx: Transaction): boolean {
    if (tx.copyName !== null && !tx.original.absent) {
        // A copy that stays (not provably the recorded one, or not removable) keeps the journal that explains it.
        const copy = removeOwned(tx.dir, tx.copyName, { identity: tx.copyIdentity, state: tx.original })
        if (copy === "kept" || copy === "retained") return false
    }
    const journal = removeOwned(tx.dir, tx.journalName, tx.journal)
    return journal === "removed" || journal === "missing"
}

/** Before the target was touched: nothing to restore, only this transaction's own files to remove. */
export function abandonTransaction(tx: Transaction): void {
    removeFiles(tx)
}

export type Completion = "clean" | "copy-kept" | "pending"

/**
 * After every verification: the journal says verified first, so that a crash
 * during the cleanup is finished by the next recovery. "copy-kept": the copy
 * could not be removed and is still the verified one; "pending": something else
 * was left (journal, or a copy that is not provably the recorded one). Either
 * way the change itself is a success.
 */
export function completeTransaction(tx: Transaction, beforeCleanup?: () => void): Completion {
    try {
        setPhase(tx, "verified")
        beforeCleanup?.()
    } catch {
        return copyStatus(tx) === "verified" ? "copy-kept" : "pending"
    }
    if (removeFiles(tx)) return "clean"
    return copyStatus(tx) === "verified" ? "copy-kept" : "pending"
}

/** Marks the transaction for the user; never throws (the copy stays either way). */
export function keepForRecovery(tx: Transaction, reason: string): void {
    try { setPhase(tx, "recovery-kept", reason) } catch { /* still "prepared" or "rolling-back": the recovery keeps it too */ }
}

export interface CurrentTarget {
    readonly bytes: Buffer
    readonly identity: string
}

export type RollbackRefusal = Extract<
    ErrorReason,
    "rollback-unsafe-changed" | "rollback-unsafe-lock-lost" | "rollback-unsafe-app-open" | "rollback-unsafe-location" | "rollback-unsupported" | "rollback-failed"
>

export interface RollbackOps {
    /** The file being restored. */
    readonly target: string
    /** A new, unique temporary name in the target's folder, of the kind the store's next writer removes. */
    readonly tempPath: () => string
    /** A new, unique name in the target's folder for a file moved aside, never removed by any automatic cleanup. */
    readonly asidePath: () => string
    readonly holdsLock: () => boolean
    /** Fluent Reader open, for config.json. */
    readonly blocked?: () => boolean
    /** The profile and storage paths still pass the store's checks. */
    readonly locationSafe: () => boolean
    /** The target as it is now, null when absent; throws when it cannot be read safely. */
    readonly readCurrent: () => Promise<CurrentTarget | null>
    readonly step?: (step: "before-restore" | "before-move-aside" | "after-move-aside" | "after-restore") => void
}

export type RollbackOutcome =
    | { readonly restored: true; readonly cleaned: boolean }
    | { readonly restored: false; readonly reason: RollbackRefusal; /** A concurrent file left under a private ".aside" name, when it could not be put back without overwriting. */ readonly stranded: boolean }

/** Whether the target's folder supports the hard links the restoration needs. Leaves nothing behind. */
function hardLinksWork(ops: RollbackOps): boolean {
    const a = ops.tempPath()
    const b = ops.tempPath()
    try {
        writeDurable(a, Buffer.alloc(0))
        fs.linkSync(a, b)
        return true
    } catch {
        return false
    } finally {
        // Both names are this writer's, created moments ago under random names.
        for (const file of [b, a]) {
            try { fs.rmSync(file, { force: true }) } catch { /* removed by the store's next writer with its temporary files */ }
        }
    }
}

function renameWithRetry(from: string, to: string): Promise<void> {
    return (async () => {
        for (let attempt = 1; ; attempt++) {
            try {
                fs.renameSync(from, to)
                return
            } catch (error) {
                if (attempt >= RENAME_ATTEMPTS || !RETRYABLE.has(systemErrorCode(error) ?? "")) throw error
                await sleep(RENAME_PAUSE_MS)
            }
        }
    })()
}

/**
 * Undoes a replacement that failed its verification without ever destroying a
 * file that is not this write's (see the header):
 *   1. refused early if the guard or lock is lost, the app is open, the paths
 *      fail their checks, the target is not (any more) this write's file, the
 *      folder has no hard links, or the copy is not the recorded one;
 *   2. the original is written to a new temporary file;
 *   3. the target is renamed to a new private name and THAT file is checked:
 *      if it is not exactly this write's file, it is linked back (never over
 *      anything) and the rollback is refused;
 *   4. the original is published with a hard link that fails if anything took
 *      the target's name meanwhile (then that file is left alone and the
 *      rollback refused); a first save is undone by removing only the private
 *      name of the file proven to be this write's;
 *   5. the restored target is read back through one descriptor.
 * Whatever is refused or fails keeps the copy (recovery-kept).
 */
export async function rollBack(tx: Transaction, written: CurrentTarget, ops: RollbackOps): Promise<RollbackOutcome> {
    let stranded = false
    const refuse = (reason: RollbackRefusal): RollbackOutcome => {
        keepForRecovery(tx, reason)
        return { restored: false, reason, stranded }
    }
    const precondition = async (): Promise<RollbackRefusal | null> => {
        if (!ops.holdsLock()) return "rollback-unsafe-lock-lost"
        if (ops.blocked?.() === true) return "rollback-unsafe-app-open"
        let safe = false
        try { safe = ops.locationSafe() } catch { safe = false }
        if (!safe) return "rollback-unsafe-location"
        let current: CurrentTarget | null
        try {
            current = await ops.readCurrent()
        } catch {
            return "rollback-unsafe-changed"
        }
        const ours = current !== null && current.identity === written.identity && current.bytes.equals(written.bytes)
        current?.bytes.fill(0)
        return ours ? null : "rollback-unsafe-changed"
    }

    const first = await precondition()
    if (first !== null) return refuse(first)
    if (!hardLinksWork(ops)) return refuse("rollback-unsupported")
    const original = tx.original.absent ? null : readCopy(tx)
    if (!tx.original.absent && original === null) return refuse("rollback-failed")
    try {
        setPhase(tx, "rolling-back")
    } catch {
        original?.fill(0)
        return refuse("rollback-failed")
    }

    let temp: string | null = null
    const dropTemp = (): void => {
        if (temp === null) return
        try { fs.rmSync(temp, { force: true }) } catch { /* holds the previous content; removed by the store's next writer */ }
        temp = null
    }
    try {
        let restoredIdentity: string | null = null
        if (original !== null) {
            const file = ops.tempPath()
            restoredIdentity = writeDurable(file, original)
            temp = file
        }
        ops.step?.("before-restore")
        const again = await precondition()
        if (again !== null) {
            dropTemp()
            return refuse(again)
        }

        // 3. Whatever is under the target's name now is moved, not destroyed.
        ops.step?.("before-move-aside")
        const aside = ops.asidePath()
        try {
            await renameWithRetry(ops.target, aside)
        } catch (error) {
            dropTemp()
            return refuse(systemErrorCode(error) === "ENOENT" ? "rollback-unsafe-changed" : "rollback-failed")
        }
        const moved = inspectFile(aside, written.bytes.length)
        const ours = moved !== null && moved.identity === written.identity && moved.bytes.equals(written.bytes)
        moved?.bytes.fill(0)
        if (!ours) {
            // Someone else's file was there: it goes back exactly as it was, or stays under the private name.
            stranded = !putBack(aside, ops.target)
            dropTemp()
            return refuse("rollback-unsafe-changed")
        }
        ops.step?.("after-move-aside")

        // 4. The private name holds exactly this write's file; the target's name is free, unless someone takes it now.
        if (original === null) {
            fs.unlinkSync(aside)
            ops.step?.("after-restore")
            if (fs.lstatSync(ops.target, { throwIfNoEntry: false }) !== undefined) return refuse("rollback-unsafe-changed")
        } else {
            try {
                fs.linkSync(temp as string, ops.target)
            } catch (error) {
                if (systemErrorCode(error) === "EEXIST") {
                    // Another file took the name: it is left alone; this write's file is not published again.
                    try { fs.unlinkSync(aside) } catch { /* this write's own content under a private name */ }
                    dropTemp()
                    return refuse("rollback-unsafe-changed")
                }
                // This write's file goes back where it was, never over anything; if even that fails it stays under the private name.
                stranded = !putBack(aside, ops.target)
                dropTemp()
                return refuse("rollback-failed")
            }
            dropTemp() // a second name of the published file
            try { fs.unlinkSync(aside) } catch { /* this write's own content under a private name */ }
            ops.step?.("after-restore")
            const restored = inspectFile(ops.target, original.length)
            const good = restored !== null && restored.identity === restoredIdentity && restored.bytes.equals(original)
            restored?.bytes.fill(0)
            if (!good) return refuse("rollback-failed")
        }
    } catch {
        dropTemp()
        return refuse("rollback-failed")
    } finally {
        original?.fill(0)
    }
    // Restored and verified: the copy is now redundant. If it cannot be removed, the next recovery finds the target equal to it.
    return { restored: true, cleaned: removeFiles(tx) }
}

function parseRecord(text: string, id: string, kind: TransactionKind): JournalRecord | null {
    try {
        const value = JSON.parse(text) as Partial<JournalRecord>
        const state = (s: unknown): s is ContentState => {
            const c = s as Partial<{ absent: boolean; sha256: string; size: number }> | null
            if (typeof c !== "object" || c === null) return false
            return c.absent === true || (c.absent === false && typeof c.sha256 === "string" && /^[0-9a-f]{64}$/.test(c.sha256) && Number.isSafeInteger(c.size))
        }
        const phases: readonly unknown[] = ["prepared", "rolling-back", "verified", "recovery-kept"]
        if (value.schema !== 1 || value.kind !== kind || value.id !== id || !phases.includes(value.phase) || !state(value.original) || !state(value.next)) return null
        if (!(value.copyIdentity === null || (typeof value.copyIdentity === "string" && /^\d+:\d+$/.test(value.copyIdentity)))) return null
        // A copy is recorded exactly when there was an original.
        if ((value.copyIdentity === null) !== value.original.absent) return null
        return value as JournalRecord
    } catch {
        return null
    }
}

export interface RecoveryReport {
    /** Transactions whose outcome was proven and whose files were removed. */
    readonly cleaned: number
    /** Transactions left for the user (recovery-kept, unreadable, or uncertain). */
    readonly kept: number
}

/**
 * Settles the transactions an interrupted writer left in `dir`. Call only under
 * the store's guard or lock. `current` reads the target now (null when absent)
 * and throws when it cannot be read. Never throws itself.
 */
export async function recoverTransactions(dir: string, kind: TransactionKind, current: () => Promise<Buffer | null>): Promise<RecoveryReport> {
    let names: string[]
    try {
        names = fs.readdirSync(dir)
    } catch {
        return { cleaned: 0, kept: 0 }
    }
    let now: ContentState | null | undefined
    const currentState = async (): Promise<ContentState | null> => {
        if (now === undefined) {
            try {
                const bytes = await current()
                now = contentState(bytes)
                bytes?.fill(0)
            } catch {
                now = null
            }
        }
        return now
    }
    let cleaned = 0
    let kept = 0
    for (const name of names) {
        try {
            const partial = JOURNAL_PARTIAL.exec(name)
            if (partial !== null) {
                // An unfinished journal replacement: removed only if it is one (it holds only hashes).
                const seen = inspectFile(path.join(dir, name), JOURNAL_MAX)
                if (seen !== null && parseRecord(seen.bytes.toString("utf8"), partial[1] as string, kind) !== null) {
                    removeOwned(dir, name, { identity: seen.identity, state: presentState(seen.bytes) })
                }
                continue
            }
            const match = TRANSACTION_JOURNAL.exec(name)
            if (match === null) continue
            const id = match[1] as string
            const seen = inspectFile(path.join(dir, name), JOURNAL_MAX)
            const parsed = seen === null ? null : parseRecord(seen.bytes.toString("utf8"), id, kind)
            if (seen === null || parsed === null) {
                kept++
                continue
            }
            const tx: Transaction = {
                dir, id, kind, original: parsed.original, next: parsed.next,
                copyName: parsed.original.absent ? null : `tx-${id}.original`, copyIdentity: parsed.copyIdentity,
                journalName: name, journal: { identity: seen.identity, state: presentState(seen.bytes) },
            }
            if (parsed.phase === "recovery-kept") {
                kept++
                continue
            }
            const copy = copyStatus(tx)
            if (copy === "unverifiable") {
                // The phase alone proves nothing about a file that is no longer the recorded copy.
                keepForRecovery(tx, "copy-unverifiable")
                kept++
                continue
            }
            if (parsed.phase === "verified") {
                if (removeFiles(tx)) cleaned++
                else kept++
                continue
            }
            const state = await currentState()
            if (state !== null && sameContent(state, parsed.original)) {
                // Never applied, or fully rolled back: the target holds the original, so neither the copy nor the journal is needed.
                if (removeFiles(tx)) cleaned++
                else kept++
                continue
            }
            if (parsed.phase === "prepared" && parsed.original.absent && state !== null && sameContent(state, parsed.next)) {
                // A first save that was applied and interrupted before its verification: the document is the requested one,
                // and there is no previous content to keep. It is left in place; the read tools verify it on every read.
                if (removeFiles(tx)) cleaned++
                else kept++
                continue
            }
            keepForRecovery(tx, copy === "missing" ? "copy-missing" : "interrupted")
            kept++
        } catch {
            kept++
        }
    }
    return { cleaned, kept }
}
