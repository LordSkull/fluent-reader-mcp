/**
 * FR-MCP-04-BETA-03A-SIMPLE-02: where the copies of the Claude Code configuration live.
 *
 * ~/.claude.json may hold secrets of other MCP servers (tokens, API keys) and the installation directory may be
 * on a volume or in a folder that other Windows users can read. The copy taken before a change is therefore kept
 * in the personal local storage of the Windows user who runs the setup, never in the installation directory:
 *
 *   %LOCALAPPDATA%\FluentReaderMCP-Data\claude-config-backups\<installation key>\claude.json.<UTC stamp>[-n].bak
 *
 * (not %LOCALAPPDATA%\FluentReaderMCP, the default installation directory). The installation key is derived from
 * the directory the installation record is bound to: the same across repairs and upgrades, different for two
 * installations of the same user. %LOCALAPPDATA% must be a local directory inside the user's profile; when it is
 * not usable nothing is copied anywhere else. The managed directories must be real directories (no link or
 * junction). No permission is read or changed: this is the standard per-user storage of Windows, not a guarantee
 * of confidentiality on an altered system.
 *
 * Earlier setups kept the copies in <install dir>\state\claude-config-backups. Only the copy the installation record
 * names exactly is attributable; anything else there (another copy too, whatever its name or content) stops the whole
 * move before the first change. That copy is copied to a temporary name in the private directory, compared byte for
 * byte, published by a rename inside that directory (never across volumes), compared again, recorded (directory and
 * SHA-256), and only then removed from the old place. An interrupted move is completed by the next attempt.
 *
 * A temporary copy is removed only by the call that created it, when it fails; one left by a crash stays (its name
 * proves nothing about who wrote it). Nothing read from a copy is printed or recorded: the record keeps the file
 * name, the directory and the SHA-256. The copies are never deleted automatically: they stay until the user deletes them.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { canonicalPath, isInside, overlaps, samePath } from "../lib/common.js"
import { LAYOUT } from "./checks.js"
import { SetupRefusal } from "./protocol.js"
import { BACKUP_NAME, backupReference, RECORD_NAME, readRecord, writeRecord, type InstallRecord } from "./record.js"

export { BACKUP_NAME }
export const PRIVATE_ROOT = "FluentReaderMCP-Data"
export const BACKUPS = "claude-config-backups"

/** Test hook: where an interrupted migration is simulated. */
export type MigrationCheckpoint = "after-copy" | "after-publish" | "after-record"

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
    return Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
}

function unavailable(why: string): SetupRefusal {
    return new SetupRefusal(`le copie della configurazione di Claude Code si salvano soltanto nella tua cartella personale (%LOCALAPPDATA%), che non è utilizzabile: ${why}. Nessuna copia viene salvata altrove e la configurazione di Claude Code non viene modificata; puoi installare solo il server`)
}

/** %LOCALAPPDATA% as a canonical local directory inside the user's profile, or a refusal (never a fallback). */
function localAppData(env: NodeJS.ProcessEnv): string {
    const raw = envValue(env, "LOCALAPPDATA")
    const home = envValue(env, "USERPROFILE")
    if (raw === undefined || !/^[A-Za-z]:[\\/]/.test(raw)) throw unavailable("%LOCALAPPDATA% non è impostata o non è un percorso locale")
    if (home === undefined || !/^[A-Za-z]:[\\/]/.test(home)) throw unavailable("la cartella del profilo utente (USERPROFILE) non è disponibile")
    let local: string
    let profile: string
    try {
        local = canonicalPath(path.win32.resolve(raw))
        profile = canonicalPath(path.win32.resolve(home))
    } catch {
        throw unavailable(`${raw} non è risolvibile`)
    }
    const stats = fs.lstatSync(local, { throwIfNoEntry: false })
    if (stats === undefined || !stats.isDirectory()) throw unavailable(`${local} non esiste o non è una cartella`)
    if (local.startsWith("\\\\") || samePath(local, profile) || !isInside(local, profile)) throw unavailable(`${local} non è dentro la cartella del profilo utente ${profile}`)
    return local
}

/** The installation's key: derived from the directory its record is bound to (letter case ignored, as Windows does). */
export function installationKey(installDir: string): string {
    return crypto.createHash("sha256").update(`fluent-reader-mcp\n${path.win32.resolve(installDir).toLowerCase()}`).digest("hex").slice(0, 32)
}

/** The private directory of an installation's copies (nothing is created). Never inside the installation directory, nor containing it. */
export function privateBackupDir(env: NodeJS.ProcessEnv, installDir: string): string {
    const dir = path.win32.join(localAppData(env), PRIVATE_ROOT, BACKUPS, installationKey(installDir))
    if (overlaps(dir, installDir)) throw unavailable(`la cartella delle copie (${dir}) e la cartella di installazione si sovrappongono`)
    return dir
}

/** A managed directory: absent, a real directory at its canonical place, or something else (link, junction, file). */
function dirState(dir: string): "absent" | "ok" | "invalid" {
    const stats = fs.lstatSync(dir, { throwIfNoEntry: false })
    if (stats === undefined) return "absent"
    try {
        return stats.isDirectory() && !stats.isSymbolicLink() && samePath(canonicalPath(dir), dir) ? "ok" : "invalid"
    } catch {
        return "invalid"
    }
}

function managedDirs(dir: string): string[] {
    const sub = path.win32.dirname(dir)
    return [path.win32.dirname(sub), sub, dir]
}

/** The private directory, created one level at a time; every level must be a real directory (no link or junction). */
function ensurePrivateDir(env: NodeJS.ProcessEnv, installDir: string): string {
    const dir = privateBackupDir(env, installDir)
    for (const part of managedDirs(dir)) {
        if (dirState(part) === "absent") {
            try {
                fs.mkdirSync(part)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable(`${part} non può essere creata (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`)
            }
        }
        if (dirState(part) !== "ok") throw new SetupRefusal(`${part} non è una cartella normale (collegamento, junction o file): nessuna copia della configurazione di Claude Code viene scritta attraverso di essa. Controllala, poi esegui di nuovo il setup`)
    }
    return dir
}

function regularFile(file: string): boolean {
    const stats = fs.lstatSync(file, { throwIfNoEntry: false })
    return stats !== undefined && stats.isFile() && !stats.isSymbolicLink()
}

function sha256Of(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

/**
 * Copies `source` to a new temporary name in `dir`, created exclusively: the temporary file is this call's own. If the
 * copy fails, what this call created goes; a file that was already there (EEXIST) is someone else's and stays.
 */
function ownTemporaryCopy(source: string, dir: string, prefix: string): string {
    const temp = path.win32.join(dir, `${prefix}.${crypto.randomBytes(8).toString("hex")}.partial`)
    try {
        fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") fs.rmSync(temp, { force: true })
        throw error
    }
    return temp
}

/**
 * Publishes this call's own temporary copy by a rename inside one directory, never over another entry (the check is
 * not atomic with the rename: see transaction.ts). If it fails, the temporary copy goes; the entry found stays.
 */
function publish(temp: string, target: string): void {
    try {
        if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) throw new SetupRefusal(`${target} esiste già e non viene sostituito`)
        fs.renameSync(temp, target)
    } catch (error) {
        fs.rmSync(temp, { force: true })
        throw error
    }
}

export interface Backup {
    readonly dir: string
    readonly name: string
    readonly sha256: string
}

/** The copy taken before a change: written to a temporary name in the private directory, then published under a new name. */
export function createBackup(configPath: string, installDir: string, env: NodeJS.ProcessEnv, now: Date): Backup {
    const dir = ensurePrivateDir(env, installDir)
    // a temporary copy left by a crash is not touched: only this call's own goes, if publishing it fails
    const temp = ownTemporaryCopy(configPath, dir, ".claude.json")
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
    for (let i = 0; ; i++) {
        const name = `claude.json.${stamp}${i === 0 ? "" : `-${i}`}.bak`
        const target = path.win32.join(dir, name)
        if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) continue
        publish(temp, target)
        return { dir, name, sha256: sha256Of(target) }
    }
}

// ------------------------------------------------------------------ copies of earlier setups

/** Where earlier setups kept the copies. */
export function legacyBackupDir(installDir: string): string {
    return path.win32.join(installDir, LAYOUT.state, BACKUPS)
}

/** Whether a file holds a JSON object (every copy was taken from a configuration the setup had just read as one). */
function holdsJsonObject(file: string): boolean {
    try {
        const doc = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
        return typeof doc === "object" && doc !== null && !Array.isArray(doc)
    } catch {
        return false
    }
}

function removeIfEmpty(dir: string): void {
    try {
        fs.rmdirSync(dir) // only an empty directory goes: nothing in it can be lost
    } catch {
        // left as it is
    }
}

/**
 * Moves the copy of an earlier setup out of the installation directory into the private one. Only the copy the
 * installation record names EXACTLY is attributable: by name only (record of an earlier setup), or, after a move
 * interrupted once the record pointed to the private copy, with the recorded SHA-256 and this user's directory.
 * Everything in the old directory is checked before the first change: any other entry (another copy too, whatever
 * its name or content; a directory; a link), a record that does not bind the directory or names no copy there, and
 * nothing is copied, recorded or removed. Idempotent. Returns the name moved, if any.
 */
export function migrateLegacyBackups(installDir: string, env: NodeJS.ProcessEnv, checkpoint?: (step: MigrationCheckpoint) => void): string[] {
    const legacy = legacyBackupDir(installDir)
    const state = dirState(legacy)
    if (state === "absent") return []
    if (state === "invalid" || dirState(path.win32.dirname(legacy)) !== "ok") throw new SetupRefusal(`${legacy} non è una cartella normale (collegamento, junction o file): non viene seguita né modificata. Controllala, poi esegui di nuovo il setup`)
    const recordFile = path.win32.join(installDir, RECORD_NAME)
    const record = readRecord(recordFile)
    if (record === null || !samePath(record.installDir, installDir)) throw new SetupRefusal(`${legacy} non è attribuibile a un'installazione registrata in questa cartella: non viene spostata né cancellata`)
    const entries = fs.readdirSync(legacy, { withFileTypes: true })
    if (entries.length === 0) {
        removeIfEmpty(legacy)
        return []
    }
    const ref = backupReference(record.claude)
    const named = ref.kind === "legacy" || (ref.kind === "private" && samePath(ref.dir, privateBackupDir(env, installDir))) ? ref.name : null
    const why = (entry: fs.Dirent): string | null => {
        if (entry.isSymbolicLink()) return "collegamento"
        if (!entry.isFile()) return "non è un file"
        if (entry.name !== named) return BACKUP_NAME.test(entry.name) ? "copia non indicata dal registro di installazione" : "nome non previsto"
        const file = path.win32.join(legacy, entry.name)
        if (ref.kind === "private") return sha256Of(file) === ref.sha256 ? null : "non coincide con la copia indicata dal registro di installazione"
        return holdsJsonObject(file) ? null : "contenuto non riconosciuto"
    }
    const foreign = entries.map((e) => [e.name, why(e)] as const).filter(([, reason]) => reason !== null)
    if (foreign.length > 0) {
        const list = foreign.slice(0, 5).map(([name, reason]) => `${path.win32.join(legacy, name)} (${reason as string})`).join("; ")
        throw new SetupRefusal(`nella cartella delle copie della configurazione di Claude Code lasciata da una versione precedente ci sono elementi non attribuibili con certezza a questa installazione: ${list}${foreign.length > 5 ? `; e altri ${foreign.length - 5}` : ""}. Nessun elemento è stato modificato, spostato o cancellato. Prima di aggiornare o riparare serve un tuo intervento: controlla gli elementi indicati, che possono contenere informazioni riservate (anche token o chiavi di altri server MCP). Non cancellarli senza averli controllati: se ti servono, conservali in una cartella personale sicura del tuo account Windows, non in una cartella condivisa con altri utenti. Dopo la verifica puoi ripetere l'aggiornamento o la riparazione eseguendo di nuovo il setup`)
    }
    const name = named as string
    migrateOne({ installDir, env, legacy, recordFile }, path.win32.join(legacy, name), ensurePrivateDir(env, installDir), name, checkpoint)
    removeIfEmpty(legacy)
    return [name]
}

/**
 * The move of the attributed copy: this call's own temporary copy, compared byte for byte, published, compared
 * again, RECORDED (private directory and SHA-256), and only then the original removed. From the record on, the next
 * attempt recognises the private copy by its hash; before it, the original is still in place.
 */
interface MigrationContext {
    readonly installDir: string
    readonly env: NodeJS.ProcessEnv
    /** The old directory the preflight checked. */
    readonly legacy: string
    readonly recordFile: string
}

/**
 * Right before the original is removed, everything its removal relies on, checked again against what was read at the
 * start of the move (size and SHA-256 of the original), changing nothing: the record (readable, bound to the
 * installation, naming this copy in this user's private directory with this hash), the published copy (a regular
 * file at its place, same size and hash), the original (a regular file still in the old directory, same size and
 * hash). Empty: the removal may go ahead. These checks are not atomic with the removal itself.
 */
function removalBlockers(ctx: MigrationContext, source: string, target: string, name: string, size: number, sha256: string): string[] {
    const blockers: string[] = []
    let record: InstallRecord | null = null
    try {
        record = readRecord(ctx.recordFile)
    } catch (error) {
        blockers.push(`il registro di installazione non è leggibile (${(error as Error).message})`)
    }
    let dir: string | null = null
    try {
        dir = privateBackupDir(ctx.env, ctx.installDir)
    } catch {
        blockers.push("la cartella personale delle copie non è più utilizzabile")
    }
    if (record !== null) {
        const ref = backupReference(record.claude)
        if (!samePath(record.installDir, ctx.installDir)) blockers.push("il registro di installazione appartiene a un'altra cartella")
        else if (ref.kind !== "private" || ref.name !== name || dir === null || !samePath(ref.dir, dir) || ref.sha256 !== sha256) blockers.push("il registro di installazione non indica più la copia spostata")
    } else if (blockers.length === 0) {
        blockers.push("il registro di installazione non c'è più")
    }
    const sameAsStart = (file: string): boolean => regularFile(file) && fs.statSync(file).size === size && sha256Of(file) === sha256
    if (dir === null || !samePath(path.win32.dirname(target), dir) || !managedDirs(dir).every((d) => dirState(d) === "ok") || !sameAsStart(target)) blockers.push(`la copia ${target} non è più quella verificata`)
    if (!samePath(path.win32.dirname(source), ctx.legacy) || dirState(ctx.legacy) !== "ok" || !sameAsStart(source)) blockers.push(`l'originale ${source} non è più quello copiato`)
    return blockers
}

function migrateOne(ctx: MigrationContext, source: string, dir: string, name: string, checkpoint?: (step: MigrationCheckpoint) => void): void {
    const { recordFile } = ctx
    const target = path.win32.join(dir, name)
    const bytes = fs.readFileSync(source)
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex")
    if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
        // published by an earlier attempt: accepted only if identical, never replaced
        if (!regularFile(target) || !fs.readFileSync(target).equals(bytes)) throw new SetupRefusal(`la copia ${source} non viene spostata: nella cartella personale esiste già ${target} con un contenuto diverso. Nessuna delle due viene sostituita o cancellata: controllale e sposta altrove quella che non ti serve, poi esegui di nuovo il setup`)
    } else {
        const temp = ownTemporaryCopy(source, dir, `.${name}`)
        checkpoint?.("after-copy") // a crash here leaves this temporary copy: no later run deletes it
        if (!fs.readFileSync(temp).equals(bytes) || !fs.readFileSync(source).equals(bytes)) {
            fs.rmSync(temp, { force: true })
            throw new SetupRefusal(`la copia ${source} è cambiata durante lo spostamento nella cartella personale: non viene spostata né cancellata. Esegui di nuovo il setup`)
        }
        publish(temp, target)
        checkpoint?.("after-publish")
    }
    if (!fs.readFileSync(target).equals(bytes) || !fs.readFileSync(source).equals(bytes)) throw new SetupRefusal(`la copia ${target} non coincide con ${source}: l'originale non viene cancellato`)
    const record = readRecord(recordFile) as InstallRecord
    const reg = record.claude
    const before = backupReference(reg)
    if (reg !== null && before.kind === "legacy" && before.name === name) writeRecord(recordFile, { ...record, claude: { ...reg, backupDir: dir, backupSha256: sha256 } })
    const after = backupReference(readRecord(recordFile)?.claude ?? null)
    if (after.kind !== "private" || after.name !== name || !samePath(after.dir, dir) || after.sha256 !== sha256) throw new SetupRefusal(`il registro di installazione non indica la copia spostata in ${target}: l'originale ${source} non viene cancellato`)
    checkpoint?.("after-record")
    const blockers = removalBlockers(ctx, source, target, name, bytes.length, sha256)
    if (blockers.length > 0) throw new SetupRefusal(`lo spostamento della copia ${source} non è stato completato: ${blockers.join("; ")}. L'originale non viene cancellato; la copia nella cartella personale e il registro di installazione restano come sono. Controllali, poi esegui di nuovo il setup`)
    fs.rmSync(source)
    if (fs.existsSync(source)) throw new SetupRefusal(`${source} non risulta rimosso dopo lo spostamento`)
}

// ------------------------------------------------------------------ the recorded copy, for the messages of recovery and uninstall

export type BackupStatus = "none" | "ok" | "legacy" | "missing" | "altered" | "other-location" | "invalid"

/**
 * Where the copy named in the record is, without changing anything:
 *  none            no copy recorded
 *  ok              in this user's private directory, with the recorded SHA-256 (always compared)
 *  legacy          still in state\claude-config-backups (record of an earlier setup)
 *  missing         not found where the record says (a copy elsewhere with the same name is never taken for it)
 *  altered         present but its content is not the recorded one, or not a regular file
 *  other-location  recorded in a private directory that is not this user's (another account, or %LOCALAPPDATA% moved):
 *                  not searched for, not touched
 *  invalid         the reference is not one of the two complete forms (backupReference), or the private directory
 *                  is not usable: `reason` says why
 */
export function recordedBackup(installDir: string, record: InstallRecord | null, env: NodeJS.ProcessEnv): { status: BackupStatus; path: string | null; reason?: string } {
    const ref = backupReference(record?.claude ?? null)
    if (ref.kind === "none") return { status: "none", path: null }
    if (ref.kind === "invalid") return { status: "invalid", path: null, reason: ref.reason }
    if (ref.kind === "legacy") {
        const old = path.win32.join(legacyBackupDir(installDir), ref.name)
        return { status: regularFile(old) ? "legacy" : "missing", path: old }
    }
    let dir: string | null
    try {
        dir = privateBackupDir(env, installDir)
    } catch {
        dir = null
    }
    if (dir === null || !samePath(ref.dir, dir)) return { status: "other-location", path: path.win32.join(ref.dir, ref.name) }
    const file = path.win32.join(dir, ref.name)
    if (!managedDirs(dir).every((d) => dirState(d) !== "invalid")) return { status: "invalid", path: file, reason: "cartella personale delle copie non utilizzabile" }
    if (fs.lstatSync(file, { throwIfNoEntry: false }) === undefined) return { status: "missing", path: file }
    if (!regularFile(file) || sha256Of(file) !== ref.sha256) return { status: "altered", path: file }
    return { status: "ok", path: file }
}

/** One sentence on the recorded copy for the user (paths only, never content); null for none. */
export function describeBackup(found: { status: BackupStatus; path: string | null; reason?: string }): string | null {
    switch (found.status) {
        case "none":
            return null
        case "ok":
            return `La copia della configurazione presa prima della modifica è in ${found.path as string}.`
        case "legacy":
            return `La copia della configurazione presa prima della modifica è ancora nella cartella di installazione: ${found.path as string}.`
        case "missing":
            return `La copia della configurazione presa prima della modifica non è stata trovata (${found.path as string}).`
        case "altered":
            return `La copia della configurazione presa prima della modifica (${found.path as string}) non è più quella salvata: non è affidabile per un ripristino.`
        case "other-location":
            return `La copia della configurazione presa prima della modifica è stata salvata in ${found.path as string}, che non è la cartella personale dell'utente Windows attuale: non viene cercata né toccata.`
        case "invalid":
            return `Il riferimento alla copia della configurazione presa prima della modifica non è utilizzabile (${found.reason ?? "non valido"}): nessuna copia viene cercata.`
    }
}

/**
 * What the uninstaller tells the user at the end about the copies of this installation (empty: nothing to say).
 * Nothing is deleted: the copies stay in the private directory until the user deletes them.
 */
export function backupNote(installDir: string, env: NodeJS.ProcessEnv): string {
    const notes: string[] = []
    let record: InstallRecord | null = null
    try {
        record = readRecord(path.win32.join(installDir, RECORD_NAME))
    } catch {
        // an unreadable record names no copy
    }
    const found = recordedBackup(installDir, record, env)
    if (found.status === "other-location") notes.push(describeBackup(found) as string)
    try {
        const dir = privateBackupDir(env, installDir)
        if (managedDirs(dir).every((d) => dirState(d) === "ok") && fs.readdirSync(dir).some((name) => BACKUP_NAME.test(name))) {
            notes.push(`Le copie della configurazione di Claude Code prese durante l'installazione restano nella tua cartella personale ${dir}: contengono la tua configurazione, compresa quella di altri server MCP. Cancellale quando non ti servono più.`)
        }
    } catch {
        // no usable private directory: nothing of it to report
    }
    return notes.join(" ")
}
