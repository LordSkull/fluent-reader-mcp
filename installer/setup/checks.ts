/**
 * FR-MCP-04-BETA-02: validation of the installation directory and of the
 * Fluent Reader profile chosen in the wizard.
 *
 * The profile is never searched for: only the directory the user picked is
 * inspected, and only for what the server's contract needs (a local
 * directory with a regular config.json and a regular fluent-reader.db). The
 * two files are opened read-only for their first bytes (file type), never
 * parsed: no setting, feed, article or credential is read, nothing is written.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { canonicalPath, isInside, overlaps, pathExists, samePath } from "../lib/common.js"
import { RECORD_NAME, readRecord, type InstallRecord } from "./record.js"
import { SetupRefusal } from "./protocol.js"
import { readJournal, RECORD_COPY, type Journal } from "./transaction.js"

export const PROFILE_CONFIG = "config.json"
export const PROFILE_DB = "fluent-reader.db"
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1")
const MAX_CONFIG_BYTES = 16 * 1024 * 1024
/** Windows MAX_PATH minus the terminating NUL: the deepest installed file must fit. */
const MAX_PATH = 259
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/** Names of the build's own directories inside an installation. */
export const LAYOUT = { current: "current", staging: ".staging", previous: "previous", state: "state" } as const
export const UNINSTALLER = "uninstall.exe"
/** What an uninstallation in progress keeps in state\ (uninstall.ts): its marker, its final marker, its helper copy. */
export const UNINSTALL_STATE = ["uninstall.json", "uninstall-final.marker", "uninstall-helper"] as const
const OWN_ENTRIES: readonly string[] = [LAYOUT.current, LAYOUT.staging, LAYOUT.previous, LAYOUT.state, UNINSTALLER]
/** The subdirectory proposed when the chosen directory is a drive root or already holds other files. */
export const DEFAULT_SUBDIR = "FluentReaderMCP"
/**
 * Top-level directories of any drive that belong to Windows or to programs installed for every user: the
 * recycle bin and the working folders of Windows setup, reset and recovery among the "$" names, not every
 * name starting with "$" ($Projects is an ordinary folder).
 */
const SYSTEM_TOP = /^(windows|program files|program files \(x86\)|programdata|system volume information|recovery|config\.msi|\$recycle\.bin|\$windows\.~bt|\$windows\.~ws|\$winreagent|\$sysreset)$/i
/** The conventional root of Windows profiles, on any drive. */
const PROFILES_ROOT = "users"

function isDriveRoot(resolved: string): boolean {
    return /^[A-Za-z]:\\$/.test(resolved)
}

/**
 * A lexical precaution, not a check of who owns a directory: outside the
 * current user's profile (USERPROFILE), a destination is refused when its
 * path has the conventional shape of a Windows profile location, X:\Users or
 * X:\Users\<account>\... on EVERY drive (by path segment: X:\UsersBackup is
 * not X:\Users; letter case ignored), or lies in the directory that holds the
 * current profile (its siblings: other users, Public), whatever its name. A
 * same-named account on another drive (D:\Users\<me>) is not taken for the
 * current profile. A profile redirected to a path of another shape cannot be
 * recognised without system metadata. Returns the location, or null.
 */
export function otherProfileLocation(canonical: string, home: string): string | null {
    if (isInside(canonical, home)) return null
    const top = canonical.slice(3).split("\\")[0] ?? ""
    if (top.toLowerCase() === PROFILES_ROOT) return `${canonical.slice(0, 3)}${top}`
    const parent = path.win32.dirname(home)
    if (!isDriveRoot(parent) && isInside(canonical, parent)) return parent
    return null
}

/** A real directory with no file anywhere inside (only empty directories, no link or junction): nothing in it can be lost. */
function holdsNothing(dir: string): boolean {
    try {
        const stats = fs.lstatSync(dir)
        if (!stats.isDirectory() || stats.isSymbolicLink()) return false
        return fs.readdirSync(dir).every((entry) => holdsNothing(path.join(dir, entry)))
    } catch {
        return false
    }
}

/** pathExists for the wizard checks: a path that cannot be inspected is a refusal with a clear message, not an internal error. */
function present(p: string, what: string): boolean {
    try {
        return pathExists(p)
    } catch {
        throw new SetupRefusal(`${what}: non è possibile verificare ${p} (accesso negato o cartella non leggibile): scegli un'altra cartella`)
    }
}

/** A local absolute drive path (X:\...), not UNC, device or relative; no ambiguous segment. */
function assertLocalPath(input: string, what: string): string {
    if (input.includes("\0") || !/^[A-Za-z]:[\\/]/.test(input)) throw new SetupRefusal(`${what}: serve un percorso assoluto su un'unità locale (X:\\...); percorsi di rete, relativi o di dispositivo non sono ammessi`)
    if (input.slice(3).split(/[\\/]/).some((segment) => segment === "." || segment === "..")) throw new SetupRefusal(`${what}: il percorso contiene "." o "..": indica il percorso diretto`)
    const resolved = path.win32.resolve(input)
    for (const segment of resolved.slice(3).split("\\").filter((s) => s.length > 0)) {
        if (/[. ]$/.test(segment) || RESERVED.test(segment) || /[<>:"|?*\x00-\x1f]/.test(segment)) throw new SetupRefusal(`${what}: il nome "${segment}" non è ammesso su Windows o è ambiguo`)
    }
    return resolved
}

/**
 * Canonical form, refusing anything that would make the destination
 * ambiguous: a link, junction or 8.3 name on the way (the canonical path
 * differs), a dangling link, or a target on another machine.
 */
function canonicalLocal(resolved: string, what: string): string {
    const drive = resolved.slice(0, 3)
    if (!fs.existsSync(drive)) throw new SetupRefusal(`${what}: l'unità ${drive.slice(0, 2)} non è disponibile (scollegata, inesistente o non pronta)`)
    let canonical: string
    try {
        canonical = canonicalPath(resolved)
    } catch {
        throw new SetupRefusal(`${what}: il percorso contiene un collegamento non risolvibile o una cartella non accessibile`)
    }
    if (canonical.startsWith("\\\\")) throw new SetupRefusal(`${what}: il percorso porta a una cartella di rete`)
    if (!samePath(canonical, resolved)) throw new SetupRefusal(`${what}: il percorso passa per un collegamento, una junction o un nome breve; scegli direttamente la cartella reale: ${canonical}`)
    return canonical
}

/** What an installation in a directory will be: the mode the wizard shows and tx-begin requires (expectMode). */
export const INSTALL_MODES = ["new", "repair", "upgrade"] as const

export interface InstallDirCheck {
    readonly canonical: string
    readonly mode: (typeof INSTALL_MODES)[number]
    readonly installedVersion: string | null
    readonly previousProfile: string | null
}

export interface InstallDirInput {
    readonly installDir: string
    readonly version: string
    /** Longest relative path of the payload, with its longest layout prefix. */
    readonly maxRelative: number
    readonly env: NodeJS.ProcessEnv
}

function envDir(env: NodeJS.ProcessEnv, name: string): string | null {
    const value = Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    if (value === undefined || !/^[A-Za-z]:[\\/]/.test(value) || !fs.existsSync(value)) return null
    try {
        return canonicalPath(path.win32.resolve(value))
    } catch {
        return null
    }
}

function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number)
    const pb = b.split(".").map(Number)
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
    return 0
}

/**
 * FR-MCP-04-BETA-03A-SIMPLE-01: a directory is acceptable for the
 * installation when it is a local drive path (any drive letter, not only
 * under the user's profile) reached without links, junctions or 8.3 names,
 * not a drive root, not a directory of Windows, of programs installed for
 * every user, of another user or the public one, outside roaming, OneDrive
 * and the Claude configuration, short enough for every file, and either
 * new, empty, or an installation of this product. Permissions are neither
 * evaluated nor changed: outside the user's profile the wizard says so.
 */
/** The location rules of an installation directory (shared by the wizard checks and every destructive command). */
function safeInstallRoot(installDir: string, env: NodeJS.ProcessEnv, what: string): { canonical: string; home: string } {
    const resolved = assertLocalPath(installDir, what)
    if (isDriveRoot(resolved)) throw new SetupRefusal(`${what}: non può essere la radice di un'unità (${resolved}); scegli una cartella, per esempio ${resolved}${DEFAULT_SUBDIR}`)
    // on the path as typed (an 8.3 or linked alias of these is refused by canonicalLocal anyway)
    const top = resolved.slice(3).split("\\")[0] ?? ""
    if (SYSTEM_TOP.test(top)) throw new SetupRefusal(`${what}: ${resolved.slice(0, 3)}${top} è una cartella di Windows o dei programmi installati per tutti gli utenti`)
    const canonical = canonicalLocal(resolved, what)
    const home = envDir(env, "USERPROFILE")
    if (home === null) throw new SetupRefusal(`${what}: la cartella del profilo utente (USERPROFILE) non è disponibile`)
    if (samePath(canonical, home)) throw new SetupRefusal(`${what}: non può essere direttamente la tua cartella utente (${home}); scegli una sottocartella`)
    const profiles = otherProfileLocation(canonical, home)
    if (profiles !== null) throw new SetupRefusal(`${what}: non può stare nella cartella di un altro utente, in quella pubblica o direttamente in ${profiles} (percorso con la forma di una cartella dei profili di Windows, diversa dalla tua: ${home})`)
    const forbidden: [string | null, string][] = [
        [envDir(env, "SystemRoot"), "la cartella di Windows"],
        [envDir(env, "windir"), "la cartella di Windows"],
        [envDir(env, "ProgramFiles"), "la cartella dei programmi"],
        [envDir(env, "ProgramFiles(x86)"), "la cartella dei programmi"],
        [envDir(env, "ProgramW6432"), "la cartella dei programmi"],
        [envDir(env, "ProgramData"), "la cartella dei dati comuni a tutti gli utenti (ProgramData)"],
        [envDir(env, "ALLUSERSPROFILE"), "la cartella dei dati comuni a tutti gli utenti (ProgramData)"],
        [envDir(env, "PUBLIC"), "la cartella pubblica degli utenti"],
        [envDir(env, "APPDATA"), "la cartella Roaming (sincronizzata)"],
        [envDir(env, "OneDrive"), "OneDrive"],
        [envDir(env, "OneDriveConsumer"), "OneDrive"],
        [envDir(env, "OneDriveCommercial"), "OneDrive"],
        [path.join(home, ".claude"), "la configurazione di Claude Code"],
    ]
    for (const [dir, label] of forbidden) if (dir !== null && overlaps(canonical, dir)) throw new SetupRefusal(`${what}: non può stare dentro ${label} né contenerla`)
    return { canonical, home }
}

export type TreeName = (typeof LAYOUT)["current"] | (typeof LAYOUT)["staging"] | (typeof LAYOUT)["previous"]

/**
 * The only directories a destructive command may remove: `current`,
 * `.staging` or `previous` directly inside an installation directory that
 * passes the location rules and has a record naming this very directory (a
 * copied record authorises nothing else). Without a record nothing is
 * removed here. The target must be a real directory: no link, junction or
 * other reparse point, canonical path equal to the expected one.
 */
export function authorizedTree(installDir: string, tree: string, env: NodeJS.ProcessEnv): string {
    const what = "Rimozione"
    if (![LAYOUT.current, LAYOUT.staging, LAYOUT.previous].includes(tree as TreeName)) throw new SetupRefusal(`${what}: cartella non ammessa: ${tree}`)
    const { canonical } = safeInstallRoot(installDir, env, "Cartella di installazione")
    const rootStats = fs.lstatSync(canonical, { throwIfNoEntry: false })
    if (rootStats === undefined || !rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new SetupRefusal(`${what}: la cartella di installazione non esiste o non è una cartella normale`)
    const record = readRecord(path.join(canonical, RECORD_NAME))
    // Only a real installation authorises a removal: the layout of a directory proves nothing. The trees of an
    // installation that has no record yet are removed only by the transaction that created them (tx-recover).
    if (record === null) throw new SetupRefusal(`${what}: la cartella non ha un registro di installazione: nulla viene rimosso`)
    if (!samePath(record.installDir, canonical)) throw new SetupRefusal(`${what}: il registro di installazione appartiene a un'altra cartella: nulla viene rimosso`)
    const target = path.join(canonical, tree)
    const stats = fs.lstatSync(target, { throwIfNoEntry: false })
    if (stats === undefined) throw new SetupRefusal(`${what}: ${tree} non esiste`)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new SetupRefusal(`${what}: ${tree} non è una cartella normale (collegamento o junction): nulla viene rimosso`)
    if (!samePath(canonicalPath(target), target)) throw new SetupRefusal(`${what}: ${tree} porta altrove: nulla viene rimosso`)
    return target
}

/** An installation directory that passes the location rules and exists (with or without a record). */
export function installRoot(installDir: string, env: NodeJS.ProcessEnv): string {
    const { canonical } = safeInstallRoot(installDir, env, "Cartella di installazione")
    const stats = fs.lstatSync(canonical, { throwIfNoEntry: false })
    if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) throw new SetupRefusal("la cartella di installazione non esiste o non è una cartella normale")
    return canonical
}

/** The installation directory of an existing installation, bound to its record (uninstall, metadata rollback). */
export function recordedInstallDir(installDir: string, env: NodeJS.ProcessEnv): string {
    const { canonical } = safeInstallRoot(installDir, env, "Cartella di installazione")
    const record = readRecord(path.join(canonical, RECORD_NAME))
    if (record === null) throw new SetupRefusal("registro di installazione mancante: la cartella non è un'installazione riconosciuta")
    if (!samePath(record.installDir, canonical)) throw new SetupRefusal("il registro di installazione appartiene a un'altra cartella")
    return canonical
}

/** The directory exists and holds files that are not an installation of this product: the wizard may propose a subdirectory. */
class ForeignContent extends SetupRefusal {
    constructor(message: string, readonly canonical: string) {
        super(message)
    }
}

export function checkInstallDir(input: InstallDirInput): InstallDirCheck {
    const what = "Cartella di installazione"
    const { canonical } = safeInstallRoot(input.installDir, input.env, what)
    const has = (...segments: string[]): boolean => present(path.join(canonical, ...segments), what)
    // An uninstallation that did not finish: its state is never inherited by a new installation.
    const leftovers = UNINSTALL_STATE.filter((name) => has(LAYOUT.state, name))
    if (leftovers.length > 0) {
        const list = leftovers.map((n) => `state\\${n}`).join(", ")
        // Only the last steps of an uninstallation are left and its uninstaller is gone: the setup can finish them
        // itself (finish-uninstall, from the final marker), without the deleted helper.
        const finishable = leftovers.includes("uninstall-final.marker") && !has(UNINSTALLER) && !has(RECORD_NAME) && !has(LAYOUT.state, "install-journal.json")
        if (finishable) {
            throw new SetupRefusal(`${what}: una disinstallazione precedente è rimasta da completare (${list}) e il suo disinstallatore non c'è più. Il setup può completarla rimuovendo soltanto i file che quella disinstallazione ha elencato nel suo marcatore finale; poi l'installazione può proseguire`, [["pendingUninstall", "yes"]])
        }
        throw new SetupRefusal(`${what}: contiene lo stato di una disinstallazione non conclusa (${list}). Se nella cartella c'è ancora uninstall.exe, eseguilo per completarla; se non c'è più, controlla e cancella a mano gli elementi indicati. Nessuna installazione viene avviata finché sono presenti`)
    }
    if (canonical.length + 1 + input.maxRelative > MAX_PATH) throw new SetupRefusal(`${what}: percorso troppo lungo (al massimo ${MAX_PATH - 1 - input.maxRelative} caratteri)`)
    // No installation nested in another one, up to the drive root.
    for (let dir = path.win32.dirname(canonical); ; dir = path.win32.dirname(dir)) {
        if (present(path.win32.join(dir, RECORD_NAME), what)) throw new SetupRefusal(`${what}: si trova dentro un'altra installazione di Fluent Reader MCP (${dir})`)
        if (isDriveRoot(dir)) break
    }
    if (!present(canonical, what)) return { canonical, mode: "new", installedVersion: null, previousProfile: null }
    let entries: string[]
    try {
        const stats = fs.lstatSync(canonical)
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw new SetupRefusal(`${what}: esiste già e non è una cartella`)
        entries = fs.readdirSync(canonical)
    } catch (error) {
        if (error instanceof SetupRefusal) throw error
        throw new SetupRefusal(`${what}: non è possibile leggere il contenuto di ${canonical} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): non viene usata, scegli un'altra cartella`)
    }
    // A name proves nothing. What attributes the directory's content to this product is a record bound to it,
    // or a valid journal of an installation interrupted before its record (verified: product, directory, checksum).
    const journal = readJournal(canonical)
    const recordFile = path.join(canonical, RECORD_NAME)
    let record: InstallRecord | null
    if (journal !== null && (journal.phase === "metadata" || journal.phase === "rolling-back")) {
        // The recovery that runs before anything else puts the previous record back: the mode shown is the one after it.
        const previous = journal.previous as NonNullable<Journal["previous"]>
        const copy = path.join(canonical, LAYOUT.state, RECORD_COPY)
        record = previous.recordExisted ? readRecord(present(copy, what) ? copy : recordFile) : null
    } else {
        record = readRecord(recordFile)
    }
    if (record === null) {
        const own = (e: string): boolean => OWN_ENTRIES.includes(e.toLowerCase()) || e.toLowerCase() === RECORD_NAME
        if (journal !== null) {
            // an installation interrupted before its record: its own layout, described by the journal
            if (!entries.every(own)) throw new ForeignContent(`${what}: contiene già altri file; scegli una cartella vuota o nuova`, canonical)
            return { canonical, mode: "new", installedVersion: null, previousProfile: null }
        }
        // Without record or journal only an empty state directory is accepted: nothing in it can be overwritten or lost.
        const unattributed = entries.filter((e) => !(e.toLowerCase() === LAYOUT.state && holdsNothing(path.join(canonical, e))))
        if (unattributed.length === 0) return { canonical, mode: "new", installedVersion: null, previousProfile: null }
        if (unattributed.every(own)) {
            throw new ForeignContent(`${what}: contiene elementi con i nomi usati da Fluent Reader MCP (${unattributed.join(", ")}) ma nessun registro di installazione né transazione che li attribuisca: non vengono usati, sostituiti né rimossi. Scegli un'altra cartella, oppure controllali e spostali a mano`, canonical)
        }
        throw new ForeignContent(`${what}: contiene già altri file; scegli una cartella vuota o nuova`, canonical)
    }
    if (!samePath(record.installDir, canonical)) throw new SetupRefusal(`${what}: il registro di installazione appartiene a un'altra cartella (copiato?): scegli una cartella vuota o nuova`)
    const order = compareVersions(record.version, input.version)
    if (order > 0) throw new SetupRefusal(`${what}: contiene la versione ${record.version}, più recente di ${input.version}; il downgrade non è supportato`)
    return { canonical, mode: order === 0 ? "repair" : "upgrade", installedVersion: record.version, previousProfile: record.profileDir }
}

export interface ResolvedInstallDir extends InstallDirCheck {
    /** Why the destination is not the chosen directory: a drive root, or a directory that already holds other files. */
    readonly adjusted: "root" | "not-empty" | null
    /** Outside the user's profile: the wizard tells the user that the permissions there are not changed. */
    readonly outsideProfile: boolean
}

/** Creates and removes an empty file: the directory is writable for this user (no permission is read or changed). */
export function writeProbe(dir: string): void {
    const probe = path.win32.join(dir, `.fluent-reader-mcp-check-${crypto.randomBytes(6).toString("hex")}.tmp`)
    fs.writeFileSync(probe, "", { flag: "wx" })
    fs.rmSync(probe, { force: true })
}

/**
 * The wizard's choice turned into the ONE effective destination, which the
 * wizard shows and the user confirms; every later command receives that
 * destination and checks it with checkInstallDir, which never proposes
 * anything. A drive root becomes <root>\FluentReaderMCP; a directory that
 * holds other files (or the user's own folder) becomes <dir>\FluentReaderMCP,
 * checked with every rule; if that one is occupied too, or the chosen
 * directory is already called FluentReaderMCP, the user picks another one.
 * An existing destination must accept a new file (probe created and removed).
 */
export function resolveInstallDir(input: InstallDirInput, probe: (dir: string) => void = writeProbe): ResolvedInstallDir {
    const what = "Cartella di installazione"
    const at = (dir: string, adjusted: ResolvedInstallDir["adjusted"]): ResolvedInstallDir => {
        const check = checkInstallDir({ ...input, installDir: dir })
        if (present(check.canonical, what)) {
            try {
                probe(check.canonical)
            } catch (error) {
                throw new SetupRefusal(`${what}: non è possibile scrivere in ${check.canonical} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); scegli un'altra cartella. Il setup non modifica i permessi delle cartelle`)
            }
        }
        return { ...check, adjusted, outsideProfile: !isInside(check.canonical, envDir(input.env, "USERPROFILE") as string) }
    }
    const proposed = (parent: string, adjusted: "root" | "not-empty"): ResolvedInstallDir => {
        const dir = path.win32.join(parent, DEFAULT_SUBDIR)
        try {
            return at(dir, adjusted)
        } catch (error) {
            if (error instanceof ForeignContent) throw new SetupRefusal(`${what}: la cartella proposta ${dir} contiene già altri file e non è un'installazione di Fluent Reader MCP: scegli un'altra cartella`)
            throw error
        }
    }
    const chosen = assertLocalPath(input.installDir, what)
    if (isDriveRoot(chosen)) return proposed(chosen, "root")
    const home = envDir(input.env, "USERPROFILE")
    if (home !== null && samePath(chosen, home)) return proposed(home, "not-empty")
    try {
        return at(chosen, null)
    } catch (error) {
        if (!(error instanceof ForeignContent)) throw error
        // never FluentReaderMCP\FluentReaderMCP: a destination already named so is occupied, not a parent
        if (path.win32.basename(error.canonical).toLowerCase() === DEFAULT_SUBDIR.toLowerCase()) throw new SetupRefusal(`${what}: ${error.canonical} contiene già altri file e non è un'installazione di Fluent Reader MCP: scegli un'altra cartella`)
        return proposed(error.canonical, "not-empty")
    }
}

export interface ProfileCheck {
    readonly canonical: string
}

/** Reads at most `length` bytes from the start of a regular file, read-only. */
function head(file: string, length: number): Buffer {
    const fd = fs.openSync(file, "r")
    try {
        const buffer = Buffer.alloc(length)
        const read = fs.readSync(fd, buffer, 0, length, 0)
        return buffer.subarray(0, read)
    } finally {
        fs.closeSync(fd)
    }
}

function regularFile(dir: string, name: string): fs.Stats {
    const file = path.join(dir, name)
    let stats: fs.Stats
    try {
        stats = fs.lstatSync(file)
    } catch {
        throw new SetupRefusal(`Profilo: ${name} non trovato nella cartella scelta`)
    }
    if (stats.isSymbolicLink() || !stats.isFile()) throw new SetupRefusal(`Profilo: ${name} non è un file normale`)
    return stats
}

/** Validates the profile directory the user picked; the install directory must not overlap it. */
export function checkProfile(profileDir: string, installDir: string | null): ProfileCheck {
    const what = "Profilo"
    const resolved = assertLocalPath(profileDir, what)
    if (!pathExists(resolved)) throw new SetupRefusal(`${what}: la cartella non esiste`)
    const stats = fs.lstatSync(resolved)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new SetupRefusal(`${what}: il percorso scelto non è una cartella normale`)
    const canonical = canonicalLocal(resolved, what)
    if (installDir !== null && overlaps(canonical, installDir)) throw new SetupRefusal(`${what}: non può coincidere con la cartella di installazione, contenerla o esserne contenuto`)
    const config = regularFile(canonical, PROFILE_CONFIG)
    if (config.size === 0 || config.size > MAX_CONFIG_BYTES) throw new SetupRefusal(`${what}: ${PROFILE_CONFIG} ha una dimensione non compatibile con Fluent Reader`)
    const start = head(path.join(canonical, PROFILE_CONFIG), 64).toString("latin1").replace(/^\xef\xbb\xbf/, "").trimStart()
    if (!start.startsWith("{")) throw new SetupRefusal(`${what}: ${PROFILE_CONFIG} non è un documento JSON di Fluent Reader`)
    const db = regularFile(canonical, PROFILE_DB)
    if (db.size < 100 || !head(path.join(canonical, PROFILE_DB), SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) throw new SetupRefusal(`${what}: ${PROFILE_DB} non è un database SQLite`)
    return { canonical }
}
