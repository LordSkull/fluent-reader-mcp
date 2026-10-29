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

import fs from "node:fs"
import path from "node:path"
import { canonicalPath, isInside, overlaps, pathExists, samePath } from "../lib/common.js"
import { RECORD_NAME, readRecord } from "./record.js"
import { SetupRefusal } from "./protocol.js"

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
    let canonical: string
    try {
        canonical = canonicalPath(resolved)
    } catch {
        throw new SetupRefusal(`${what}: il percorso contiene un collegamento non risolvibile`)
    }
    if (canonical.startsWith("\\\\")) throw new SetupRefusal(`${what}: il percorso porta a una cartella di rete`)
    if (!samePath(canonical, resolved)) throw new SetupRefusal(`${what}: il percorso passa per un collegamento, una junction o un nome breve; scegli direttamente la cartella reale: ${canonical}`)
    return canonical
}

export interface InstallDirCheck {
    readonly canonical: string
    readonly mode: "new" | "repair" | "upgrade"
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
 * A directory is safe for the installation when it is a local path strictly
 * inside the user's own profile directory (private by default: nobody else
 * can replace the node.exe that Claude Code will start), outside roaming,
 * OneDrive and the Claude configuration, short enough for every file, and
 * either new, empty, or an installation of this product.
 */
/** The location rules of an installation directory (shared by the wizard checks and every destructive command). */
function safeInstallRoot(installDir: string, env: NodeJS.ProcessEnv, what: string): { canonical: string; home: string } {
    const canonical = canonicalLocal(assertLocalPath(installDir, what), what)
    const home = envDir(env, "USERPROFILE")
    if (home === null) throw new SetupRefusal(`${what}: la cartella del profilo utente (USERPROFILE) non è disponibile`)
    if (!isInside(canonical, home) || samePath(canonical, home)) throw new SetupRefusal(`${what}: deve trovarsi dentro la cartella del tuo utente (${home}), per esempio in %LOCALAPPDATA%; cartelle condivise o di sistema non sono sicure`)
    const forbidden: [string | null, string][] = [
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

export function checkInstallDir(input: InstallDirInput): InstallDirCheck {
    const what = "Cartella di installazione"
    const { canonical, home } = safeInstallRoot(input.installDir, input.env, what)
    // An uninstallation that did not finish: its state is never inherited by a new installation.
    const leftovers = UNINSTALL_STATE.filter((name) => pathExists(path.join(canonical, LAYOUT.state, name)))
    if (leftovers.length > 0) {
        const list = leftovers.map((n) => `state\\${n}`).join(", ")
        // Only the last steps of an uninstallation are left and its uninstaller is gone: the setup can finish them
        // itself (finish-uninstall, from the final marker), without the deleted helper.
        const finishable = leftovers.includes("uninstall-final.marker") && !pathExists(path.join(canonical, UNINSTALLER)) && !pathExists(path.join(canonical, RECORD_NAME)) && !pathExists(path.join(canonical, LAYOUT.state, "install-journal.json"))
        if (finishable) {
            throw new SetupRefusal(`${what}: una disinstallazione precedente è rimasta da completare (${list}) e il suo disinstallatore non c'è più. Il setup può completarla rimuovendo soltanto i file che quella disinstallazione ha elencato nel suo marcatore finale; poi l'installazione può proseguire`, [["pendingUninstall", "yes"]])
        }
        throw new SetupRefusal(`${what}: contiene lo stato di una disinstallazione non conclusa (${list}). Se nella cartella c'è ancora uninstall.exe, eseguilo per completarla; se non c'è più, controlla e cancella a mano gli elementi indicati. Nessuna installazione viene avviata finché sono presenti`)
    }
    if (canonical.length + 1 + input.maxRelative > MAX_PATH) throw new SetupRefusal(`${what}: percorso troppo lungo (al massimo ${MAX_PATH - 1 - input.maxRelative} caratteri)`)
    // No installation nested in another one.
    for (let dir = path.dirname(canonical); isInside(dir, home) && !samePath(dir, home); dir = path.dirname(dir)) {
        if (pathExists(path.join(dir, RECORD_NAME))) throw new SetupRefusal(`${what}: si trova dentro un'altra installazione di Fluent Reader MCP (${dir})`)
    }
    if (!pathExists(canonical)) return { canonical, mode: "new", installedVersion: null, previousProfile: null }
    const stats = fs.lstatSync(canonical)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new SetupRefusal(`${what}: esiste già e non è una cartella`)
    const entries = fs.readdirSync(canonical)
    // Empty, or only this installer's own layout (an installation interrupted before its record was written).
    if (!entries.includes(RECORD_NAME)) {
        if (entries.every((e) => OWN_ENTRIES.includes(e.toLowerCase()))) return { canonical, mode: "new", installedVersion: null, previousProfile: null }
        throw new SetupRefusal(`${what}: contiene già altri file; scegli una cartella vuota o nuova`)
    }
    const record = readRecord(path.join(canonical, RECORD_NAME))
    if (record === null) throw new SetupRefusal(`${what}: registro di installazione mancante`)
    if (!samePath(record.installDir, canonical)) throw new SetupRefusal(`${what}: il registro di installazione appartiene a un'altra cartella (copiato?): scegli una cartella vuota o nuova`)
    const order = compareVersions(record.version, input.version)
    if (order > 0) throw new SetupRefusal(`${what}: contiene la versione ${record.version}, più recente di ${input.version}; il downgrade non è supportato`)
    return { canonical, mode: order === 0 ? "repair" : "upgrade", installedVersion: record.version, previousProfile: record.profileDir }
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
