/**
 * FR-MCP-04-BETA-02: the installation transaction and its recovery, driven
 * by a persistent journal (state\install-journal.json).
 *
 * Phases, each written to the journal BEFORE the operations it covers:
 *   staging      tx-begin: the installer is about to extract .staging
 *   prepared     tx-prepare: .staging verified, new uninstaller in
 *                state\uninstall.exe.new, previous record copied, the nine
 *                HKCU values (presence, type, value) and key presence saved
 *   swapping     tx-swap: current -> previous, .staging -> current
 *   metadata     new current active; record, uninstaller, then HKCU (NSIS)
 *   committed    tx-commit: everything verified; the new version is final
 *   rolling-back recovery has put files back and waits for HKCU (NSIS)
 * After `committed`, tx-cleanup removes previous and the copies, then the
 * journal. The rollback after an error and the recovery after a crash are
 * the same function: tx-recover. It never deletes `previous` of a
 * transaction that is not committed, verifies every step, and keeps the
 * journal and copies whenever something cannot be completed.
 *
 * NSIS does what Node cannot: WriteUninstaller and the HKCU reads/writes
 * (the journal tells it what to restore). The journal holds no Claude
 * configuration, article or Fluent Reader data.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { canonicalPath, listFiles, overlaps, safeJoin, samePath, sha256FileSync } from "../lib/common.js"
import { INVENTORY, readInventory, removeTree, type Inventory } from "./app.js"
import { migrateLegacyBackups } from "./backups.js"
import { checkInstallDir, installRoot, LAYOUT, UNINSTALLER } from "./checks.js"
import { SetupRefusal, type Request } from "./protocol.js"
import { canonicalJson, PRODUCT, RECORD_NAME, readRecord, writeRecord, type InstallRecord } from "./record.js"

export const JOURNAL = "install-journal.json"
export const RECORD_COPY = "install-record.previous.json"
export const UNINSTALLER_NEW = "uninstall.exe.new"
export const UNINSTALLER_PREVIOUS = "uninstall.exe.previous"

export type Phase = "staging" | "prepared" | "swapping" | "metadata" | "committed" | "rolling-back"
const PHASES: readonly Phase[] = ["staging", "prepared", "swapping", "metadata", "committed", "rolling-back"]

/** The per-user registry values the installer writes (same list, same order, as the NSIS script). */
export const REGISTRY_SLOTS = [
    { id: 1, key: "uninstall", name: "DisplayName" },
    { id: 2, key: "uninstall", name: "DisplayVersion" },
    { id: 3, key: "uninstall", name: "Publisher" },
    { id: 4, key: "uninstall", name: "InstallLocation" },
    { id: 5, key: "uninstall", name: "UninstallString" },
    { id: 6, key: "uninstall", name: "NoModify" },
    { id: 7, key: "uninstall", name: "NoRepair" },
    { id: 8, key: "uninstall", name: "EstimatedSize" },
    { id: 9, key: "settings", name: "InstallDir" },
] as const

/** Types the installer can read back and write again exactly; anything else stops the installation before the swap. */
export const PRESERVABLE_TYPES = ["REG_SZ", "REG_EXPAND_SZ", "REG_DWORD"] as const
export type RegType = (typeof PRESERVABLE_TYPES)[number]

export interface RegValue {
    readonly id: number
    readonly present: boolean
    readonly type: RegType | null
    readonly value: string | null
}

/**
 * FR-MCP-04-BETA-03A-SIMPLE-01: what tx-begin found in the directory it was allowed to use, by content. The
 * steps compare the directory with it before they move or replace anything, and the cleanups delete only
 * what matches the hashes recorded against it. Journals of earlier setups do not have it: they are never
 * trusted for anything but the payload's own files.
 */
export interface InitialState {
    /** The record bound to the directory (checked by checkInstallDir), by content and generation; null: none. */
    readonly record: { readonly sha256: string; readonly generation: string } | null
    /** uninstall.exe by content; null: absent (only a recorded installation may have one). */
    readonly uninstallerSha256: string | null
    /** null: no current tree; otherwise its installer-files.json by content (null: it had none). */
    readonly current: { readonly inventorySha256: string | null } | null
}

/** What NSIS staged, by content: noted by tx-prepare before anything in it can refuse (the rollback removes only these). */
export interface StagedState {
    readonly inventorySha256: string | null
    readonly uninstallerSha256: string | null
}

export interface Journal {
    readonly schemaVersion: 1
    readonly product: typeof PRODUCT
    readonly kind: "install-journal"
    readonly installDir: string
    readonly transactionId: string
    readonly createdAt: string
    readonly phase: Phase
    readonly target: { readonly version: string; readonly bundleSha256: string; readonly profileDir: string }
    readonly previous: {
        readonly version: string | null
        readonly hadCurrent: boolean
        readonly recordExisted: boolean
        readonly recordSha256: string | null
        readonly uninstallerExisted: boolean
        /** SHA-256 of the installed uninstall.exe and of the new one: a file is recognised by its content, never by its name. */
        readonly uninstallerSha256: string | null
        readonly newUninstallerSha256: string
    } | null
    readonly registry: { readonly keys: { readonly uninstall: boolean; readonly settings: boolean }; readonly values: readonly RegValue[] } | null
    /** Absent in the journals of earlier setups. */
    readonly initial?: InitialState
    readonly staged?: StagedState
    readonly checksum: string
}

type JournalBody = Omit<Journal, "checksum">

/** Test hook: the named points where a crash (process killed) is simulated. */
export type TxCheckpoint = "after-first-rename" | "after-second-rename" | "after-record" | "after-uninstaller" | "during-recovery" | "after-record-copy-removed" | "during-cleanup"

export interface TxDeps {
    readonly now: () => Date
    readonly checkpoint?: ((step: TxCheckpoint) => void) | undefined
    readonly unlink?: ((file: string) => void) | undefined
    /** Test hook: the rename primitive (fs.renameSync), called once per rename. */
    readonly rename?: ((from: string, to: string) => void) | undefined
    /** Where the running setup helper was extracted with its payload's inventory (bindPayload); null: none. */
    readonly payloadRoot?: string | null | undefined
}

function stateDir(installDir: string): string {
    return path.win32.join(installDir, LAYOUT.state)
}

function journalPath(installDir: string): string {
    return path.win32.join(stateDir(installDir), JOURNAL)
}

function sha256Text(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex")
}

function sha256Of(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function checksumOf(body: JournalBody): string {
    return sha256Text(canonicalJson(body))
}

/** Writes the journal through a temporary name (rename is atomic on NTFS): a crash leaves the old or the new journal, never a mix. */
function writeJournal(body: JournalBody): Journal {
    const journal: Journal = { ...body, checksum: checksumOf(body) }
    const file = journalPath(body.installDir)
    const temp = `${file}.${process.pid}.tmp`
    fs.rmSync(temp, { force: true })
    fs.writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx" })
    fs.renameSync(temp, file)
    return journal
}

const isSha = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)
const isShaOrNull = (v: unknown): boolean => v === null || isSha(v)

function validInitial(v: unknown): boolean {
    const i = v as Partial<InitialState> | null
    if (typeof i !== "object" || i === null) return false
    const record = i.record as Partial<NonNullable<InitialState["record"]>> | null | undefined
    const current = i.current as Partial<NonNullable<InitialState["current"]>> | null | undefined
    return (record === null || (typeof record === "object" && record !== undefined && isSha(record.sha256) && typeof record.generation === "string" && /^[0-9a-f]{32}$/.test(record.generation))) &&
        isShaOrNull(i.uninstallerSha256) &&
        (current === null || (typeof current === "object" && current !== undefined && isShaOrNull(current.inventorySha256)))
}

function validStaged(v: unknown): boolean {
    const s = v as Partial<StagedState> | null
    return typeof s === "object" && s !== null && isShaOrNull(s.inventorySha256) && isShaOrNull(s.uninstallerSha256)
}

/**
 * The journal of `installDir`, or null. A journal that is unreadable, of
 * another product or directory, or whose checksum does not match is never
 * acted upon: the caller stops without changing anything. A valid checksum
 * proves only that the journal is consistent, not who wrote it, and its
 * transaction id only correlates requests: the journal authorises nothing by
 * itself. Every rename, replacement or deletion is decided by checks on its own
 * target (see "ownership" below); without enough evidence it is refused and
 * the data, the journal included, stay as they are.
 */
export function readJournal(installDir: string): Journal | null {
    const file = journalPath(installDir)
    if (!fs.existsSync(file)) return null
    const invalid = (): never => {
        throw new SetupRefusal(`il journal dell'installazione (${file}) non è valido o è stato alterato: nessuna operazione automatica viene eseguita. Le cartelle current, previous e .staging restano come sono`)
    }
    let raw: Partial<Journal>
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Journal>
    } catch {
        return invalid()
    }
    const { checksum, ...body } = raw
    if (raw.schemaVersion !== 1 || raw.product !== PRODUCT || raw.kind !== "install-journal" || typeof raw.installDir !== "string" || !samePath(raw.installDir, installDir)) return invalid()
    if (typeof raw.transactionId !== "string" || !/^[0-9a-f]{32}$/.test(raw.transactionId) || !PHASES.includes(raw.phase as Phase) || typeof raw.target?.version !== "string") return invalid()
    if (typeof checksum !== "string" || checksum !== checksumOf(body as JournalBody)) return invalid()
    if (raw.phase !== "staging" && (raw.previous === null || raw.previous === undefined || raw.registry === null || raw.registry === undefined)) return invalid()
    if ((raw.initial !== undefined && !validInitial(raw.initial)) || (raw.staged !== undefined && !validStaged(raw.staged))) return invalid()
    return raw as Journal
}

function requireJournal(installDir: string, transactionId: string, phase: Phase): Journal {
    const journal = readJournal(installDir)
    if (journal === null) throw new SetupRefusal("nessuna transazione di installazione in corso")
    if (journal.transactionId !== transactionId) throw new SetupRefusal("la transazione di installazione in corso non è questa")
    if (journal.phase !== phase) throw new SetupRefusal(`transazione nella fase ${journal.phase}, attesa ${phase}`)
    return journal
}

function exists(p: string): boolean {
    return fs.existsSync(p)
}

/** A directory of this installation that is a real directory (no link or junction) at its canonical place. */
function ownDirectory(installDir: string, name: string): string {
    const dir = path.win32.join(installDir, name)
    const stats = fs.lstatSync(dir, { throwIfNoEntry: false })
    if (stats === undefined) return dir
    if (stats.isSymbolicLink() || !stats.isDirectory() || !samePath(canonicalPath(dir), dir)) throw new SetupRefusal(`${name} non è una cartella normale (collegamento o junction): nulla viene toccato`)
    return dir
}

/**
 * One rename, attempted once: refused if the source is missing or the destination already exists (nothing is
 * ever renamed over another file or directory), and any error of the rename itself (EPERM, EBUSY, EACCES
 * included) goes to the caller as it is, without a retry or a fallback. The checks before it are not atomic
 * with it: they refuse what is already wrong, they cannot rule out a concurrent change in between.
 */
export function rename(from: string, to: string, what: string, renameSync: (from: string, to: string) => void = fs.renameSync): void {
    if (!exists(from)) throw new SetupRefusal(`${what}: l'origine non esiste (${from})`)
    if (exists(to)) throw new SetupRefusal(`${what}: la destinazione esiste già e non viene sostituita (${to})`)
    try {
        renameSync(from, to)
    } catch (error) {
        throw new SetupRefusal(`${what} non riuscito (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`)
    }
    if (!exists(to) || exists(from)) throw new SetupRefusal(`${what}: esito non verificato`)
}

function removeFile(file: string, what: string): void {
    try {
        fs.rmSync(file, { force: true })
    } catch (error) {
        throw new SetupRefusal(`rimozione di ${what} non riuscita (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`)
    }
    if (exists(file)) throw new SetupRefusal(`${what} non risulta rimosso`)
}

// ------------------------------------------------------------------ ownership (FR-MCP-04-BETA-03A-SIMPLE-01)
//
// A journal, a transaction id, a checksum or an inventory found in the installation directory correlate
// requests and detect changes: none of them proves that a file is this product's. What may be renamed,
// replaced or deleted is decided per target, and a whole recovery or cleanup is checked before its first
// change (one target that fails and nothing is changed; the journal stays for diagnosis):
//  - the NEW tree (.staging, or current after the swap of a first installation): every file byte for byte a
//    file of the payload shipped with the running setup helper (bindPayload), never an inventory from a request;
//  - a tree of the RECOGNISED installation (its record, bound to the directory, found by tx-begin): every file
//    as its own installer-files.json states (size, SHA-256), no other file, no link, that inventory unchanged
//    since tx-begin;
//  - a FILE of the recognised installation (uninstall.exe, the record) or the copy the transaction made of it:
//    content unchanged since tx-begin;
//  - a DUPLICATE: byte-identical to a file that stays.
// What the transaction created with no reference outside the directory (the new uninstaller, the new
// record) is never deleted or replaced automatically: the recovery stops and names it.

/** The helper script inside a payload, and inside an installed tree (setup\ + the builder's SETUP_ENTRY). */
export const SETUP_SCRIPT = "setup/installer/setup/fr-setup.js"

interface FileRef {
    readonly size: number
    readonly sha256: string
}

/** The payload the running setup helper was shipped with (bindPayload). */
export interface BoundPayload {
    readonly version: string
    readonly files: ReadonlyMap<string, FileRef>
    readonly inventoryBytes: Buffer
}

/**
 * The payload of the running setup helper. `root` comes from the helper's own location (fr-setup.ts), never
 * from a request: the installer extracts the payload's installer-files.json and its setup\ files together
 * into its own $PLUGINSDIR\helper, the layout of an installed tree. The inventory counts only if it
 * describes the code that is running: it lists the helper script, and every setup\ file it lists is there
 * with its size and SHA-256. Never inside the installation directory.
 */
export function bindPayload(root: string | null | undefined, installDir: string): BoundPayload | null {
    if (root === null || root === undefined || !path.win32.isAbsolute(root) || overlaps(root, installDir)) return null
    try {
        const inventory = readInventory(root)
        const setup = inventory.files.filter((f) => f.path.startsWith("setup/"))
        if (!setup.some((f) => f.path === SETUP_SCRIPT)) return null
        for (const f of setup) {
            const full = safeJoin(root, f.path)
            if (fs.statSync(full).size !== f.size || sha256FileSync(full) !== f.sha256) return null
        }
        return { version: inventory.version, files: new Map(inventory.files.map((f) => [f.path, { size: f.size, sha256: f.sha256 }])), inventoryBytes: fs.readFileSync(path.win32.join(root, INVENTORY)) }
    } catch {
        return null
    }
}

/** Only empty directories (an earlier attempt removed every file): nothing in them can be lost. */
function holdsNoFile(dir: string): boolean {
    try {
        return listFiles(dir).length === 0
    } catch {
        return false
    }
}

/**
 * Why the files under `dir` are not as `expected` states (null: they are). Every file is read and compared
 * (size, SHA-256) with a reference that does not come from it; `inventory` judges the tree's own
 * installer-files.json. `complete`: every expected file must be there (a tree to activate or restore);
 * otherwise missing files are allowed (a tree an earlier attempt partly removed).
 */
function treeMismatch(dir: string, expected: ReadonlyMap<string, FileRef>, inventory: (bytes: Buffer) => boolean, complete: boolean): string | null {
    let present: string[]
    try {
        present = listFiles(dir)
    } catch (error) {
        return `non verificabile: ${(error as Error).message}`
    }
    for (const f of present) {
        const full = safeJoin(dir, f)
        if (f === INVENTORY) {
            if (!inventory(fs.readFileSync(full))) return "il suo inventario non è quello atteso"
            continue
        }
        const e = expected.get(f)
        if (e === undefined) return `contiene un file non previsto: ${f}`
        if (fs.statSync(full).size !== e.size || sha256FileSync(full) !== e.sha256) return `contiene un file modificato: ${f}`
    }
    if (complete) {
        const missing = [...expected.keys()].find((p) => !present.includes(p))
        if (missing !== undefined) return `manca ${missing}`
        if (!present.includes(INVENTORY)) return "manca il suo inventario"
    }
    return null
}

/** The new tree: byte for byte the payload of the running setup, of the transaction's version. */
function newTreeMismatch(dir: string, payload: BoundPayload | null, version: string, complete: boolean): string | null {
    if (payload === null) return "il pacchetto del setup in esecuzione non è disponibile o non è verificabile: manca un riferimento indipendente"
    if (payload.version !== version) return `il setup in esecuzione è della versione ${payload.version}, la transazione della ${version}`
    return treeMismatch(dir, payload.files, (bytes) => bytes.equals(payload.inventoryBytes), complete)
}

/** A tree of the recognised installation: exactly as its own inventory, that inventory being the one found by tx-begin. */
function installedTreeMismatch(dir: string, inventorySha256: string | null, version: string | null, complete: boolean): string | null {
    if (inventorySha256 === null) return "il suo inventario non era registrato all'inizio della transazione"
    const file = path.win32.join(dir, INVENTORY)
    if (!exists(file)) return !complete && holdsNoFile(dir) ? null : "manca il suo inventario"
    if (sha256Of(file) !== inventorySha256) return "il suo inventario è cambiato dall'inizio della transazione"
    let inventory: Inventory
    try {
        inventory = readInventory(dir)
    } catch (error) {
        return (error as Error).message
    }
    if (version !== null && inventory.version !== version) return `contiene la versione ${inventory.version}, attesa ${version}`
    return treeMismatch(dir, new Map(inventory.files.map((f) => [f.path, { size: f.size, sha256: f.sha256 }])), () => true, complete)
}

/** A record file of this product, bound to `installDir`, of the given generation. */
function recordBoundAs(file: string, installDir: string, generation: string): boolean {
    try {
        const record = readRecord(file)
        return record !== null && samePath(record.installDir, installDir) && record.generation === generation
    } catch {
        return false
    }
}

function sameBytes(a: string, b: string): boolean {
    return exists(a) && exists(b) && fs.readFileSync(a).equals(fs.readFileSync(b))
}

/** The directory as the transaction relies on it: record, uninstall.exe and current, by content. */
function initialState(installDir: string): InitialState {
    const recordFile = path.win32.join(installDir, RECORD_NAME)
    const record = readRecord(recordFile)
    if (record !== null && !samePath(record.installDir, installDir)) throw new SetupRefusal("il registro di installazione presente appartiene a un'altra cartella: nulla viene spostato, sostituito o rimosso")
    const uninstaller = path.win32.join(installDir, UNINSTALLER)
    const current = ownDirectory(installDir, LAYOUT.current)
    const inventory = path.win32.join(current, INVENTORY)
    return {
        record: record === null ? null : { sha256: sha256Of(recordFile), generation: record.generation },
        uninstallerSha256: exists(uninstaller) ? sha256Of(uninstaller) : null,
        current: exists(current) ? { inventorySha256: exists(inventory) ? sha256Of(inventory) : null } : null,
    }
}

function initialOf(journal: Journal): InitialState {
    if (journal.initial === undefined) throw new SetupRefusal("il journal non registra lo stato iniziale della cartella (setup di una versione precedente): nessuna operazione")
    return journal.initial
}

/** Change detection: refuses when the directory is no longer what tx-begin found. */
function verifyInitial(installDir: string, journal: Journal): void {
    const initial = initialOf(journal)
    const now = initialState(installDir)
    const changed: string[] = []
    if (canonicalJson(now.record) !== canonicalJson(initial.record)) changed.push(initial.record === null ? "è comparso un registro di installazione" : now.record === null ? "il registro di installazione è stato rimosso" : "il registro di installazione è stato sostituito")
    if (now.uninstallerSha256 !== initial.uninstallerSha256) changed.push(initial.uninstallerSha256 === null ? "è comparso un uninstall.exe" : now.uninstallerSha256 === null ? "uninstall.exe è stato rimosso" : "uninstall.exe è stato sostituito")
    if (canonicalJson(now.current) !== canonicalJson(initial.current)) changed.push(initial.current === null ? "è comparsa una cartella current" : "la cartella current è cambiata")
    if (changed.length > 0) throw new SetupRefusal(`la cartella di installazione è cambiata dopo l'inizio della transazione (${changed.join("; ")}): nulla viene spostato, sostituito o rimosso. Installazione annullata`)
}

/** Correlation only: a request about another transaction than the journal's is refused (it authorises nothing when it matches). */
function correlate(journal: Journal, transactionId: string | null): void {
    if (transactionId !== null && transactionId !== journal.transactionId) throw new SetupRefusal("la richiesta si riferisce a un'altra transazione di installazione rispetto al journal presente: nessuna operazione automatica")
}

const LEGACY = "il journal è di un setup precedente e non registra lo stato iniziale della cartella"
const NEW_UNINSTALLER = "nuovo disinstallatore scritto da questa transazione: nessun riferimento indipendente ne dimostra il contenuto"
const NEW_RECORD = "registro scritto da questa transazione: nessun riferimento indipendente ne dimostra il contenuto"

function blocked(what: string, blockers: readonly string[]): SetupRefusal {
    return new SetupRefusal(`${what} non è possibile: questi elementi non sono attribuibili con certezza a Fluent Reader MCP o non corrispondono allo stato verificato: ${blockers.join("; ")}. Nulla è stato rimosso, sostituito o spostato; il journal (state\\${JOURNAL}) resta per la diagnosi. Controlla gli elementi indicati: se sono stati creati da questa installazione interrotta di Fluent Reader MCP puoi rimuoverli, poi esegui di nuovo il setup`)
}

// ------------------------------------------------------------------ transaction steps

/** Before the extraction: the journal makes `.staging` an artifact of this transaction and records what the directory held. */
export function txBegin(deps: TxDeps, input: { installDir: string; version: string; maxRelative: number; bundleSha256: string; profileDir: string; env: NodeJS.ProcessEnv }): Journal {
    const installDir = checkInstallDir({ installDir: input.installDir, version: input.version, maxRelative: input.maxRelative, env: input.env }).canonical
    // FR-MCP-04-BETA-03A-SIMPLE-02: copies of the Claude configuration left in state\ by an earlier setup go to the
    // user's private directory first (or nothing starts), and before the record is noted: it may be updated
    if (readJournal(installDir) === null) migrateLegacyBackups(installDir, input.env)
    const initial = initialState(installDir)
    // Only a recorded installation owns an uninstall.exe or a current tree (checkInstallDir refuses them too).
    if (initial.record === null && (initial.uninstallerSha256 !== null || initial.current !== null)) {
        throw new SetupRefusal(`${initial.uninstallerSha256 !== null ? "uninstall.exe" : "la cartella current"} esiste senza un registro di installazione: non è attribuibile a Fluent Reader MCP e non viene sostituito, spostato né rimosso. Installazione annullata prima di qualsiasi modifica`)
    }
    // The installed tree that an upgrade or a repair will retire must be exactly what its inventory states.
    if (initial.current !== null) {
        const why = initial.current.inventorySha256 === null ? "non ha un inventario" : installedTreeMismatch(ownDirectory(installDir, LAYOUT.current), initial.current.inventorySha256, null, false)
        if (why !== null) throw new SetupRefusal(`la cartella current dell'installazione esistente non è verificabile (${why}): non viene spostata né sostituita. Installazione annullata prima di qualsiasi modifica`)
    }
    try {
        fs.mkdirSync(stateDir(installDir), { recursive: true })
    } catch (error) {
        throw new SetupRefusal(`non è possibile scrivere nella cartella di installazione ${installDir} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): installazione non avviata, nulla è stato cambiato. Il setup non modifica i permessi delle cartelle: scegline un'altra`)
    }
    if (readJournal(installDir) !== null) throw new SetupRefusal("una transazione di installazione precedente non è stata risolta: va eseguito prima il recupero")
    for (const name of [LAYOUT.staging, LAYOUT.previous]) {
        if (exists(path.win32.join(installDir, name))) throw new SetupRefusal(`la cartella ${name} esiste senza una transazione che la descriva: non viene rimossa automaticamente; spostala o cancellala a mano dopo averla controllata`)
    }
    for (const file of [RECORD_COPY, UNINSTALLER_NEW, UNINSTALLER_PREVIOUS]) {
        if (exists(path.win32.join(stateDir(installDir), file))) throw new SetupRefusal(`state\\${file} esiste senza una transazione che lo descriva: controllalo e rimuovilo a mano`)
    }
    return writeJournal({
        schemaVersion: 1, product: PRODUCT, kind: "install-journal", installDir, transactionId: crypto.randomBytes(16).toString("hex"), createdAt: deps.now().toISOString(),
        phase: "staging", target: { version: input.version, bundleSha256: input.bundleSha256, profileDir: input.profileDir }, previous: null, registry: null, initial,
    })
}

/** Parses the HKCU state the installer read (presence, type, value of the nine values, key presence) and refuses anything not preservable. */
export function parseRegistryBackup(request: Request): NonNullable<Journal["registry"]> {
    const flagOf = (key: string): boolean => {
        const v = request.get(key)
        if (v !== "0" && v !== "1") throw new SetupRefusal(`stato del registro di Windows incompleto (${key}): installazione annullata prima di qualsiasi modifica`)
        return v === "1"
    }
    const values = REGISTRY_SLOTS.map((slot): RegValue => {
        const present = flagOf(`reg${slot.id}.present`)
        if (!present) return { id: slot.id, present: false, type: null, value: null }
        const type = request.get(`reg${slot.id}.type`) ?? ""
        if (type === "MULTILINE") throw new SetupRefusal(`il valore di registro ${slot.name} contiene un a capo (CR o LF): il suo backup non è rappresentabile in sicurezza, quindi l'installazione è annullata prima di qualsiasi modifica. Il valore non è stato alterato`)
        if (!(PRESERVABLE_TYPES as readonly string[]).includes(type)) {
            throw new SetupRefusal(`il valore di registro ${slot.name} esiste già con un tipo (${type || "sconosciuto"}) che il setup non sa ripristinare fedelmente: installazione annullata prima di qualsiasi modifica`)
        }
        const value = request.get(`reg${slot.id}.value`) ?? ""
        if (type === "REG_DWORD" && !/^-?\d+$/.test(value)) throw new SetupRefusal(`il valore di registro ${slot.name} non è un DWORD leggibile: installazione annullata prima di qualsiasi modifica`)
        return { id: slot.id, present: true, type: type as RegType, value }
    })
    return { keys: { uninstall: flagOf("key.uninstall"), settings: flagOf("key.settings") }, values }
}

/** First part of tx-prepare: what NSIS staged is noted by content (change detection for the later steps). */
export function txStage(installDir: string, transactionId: string): Journal {
    const journal = requireJournal(installDir, transactionId, "staging")
    initialOf(journal)
    const inventory = path.win32.join(ownDirectory(installDir, LAYOUT.staging), INVENTORY)
    const uninstallerNew = path.win32.join(stateDir(installDir), UNINSTALLER_NEW)
    const staged: StagedState = { inventorySha256: exists(inventory) ? sha256Of(inventory) : null, uninstallerSha256: exists(uninstallerNew) ? sha256Of(uninstallerNew) : null }
    if (journal.staged !== undefined) {
        if (canonicalJson(journal.staged) !== canonicalJson(staged)) throw new SetupRefusal("i file preparati per l'installazione sono cambiati dopo essere stati annotati: installazione annullata")
        return journal
    }
    const { checksum: _checksum, ...body } = journal
    return writeJournal({ ...body, staged })
}

/** After the verification of .staging and WriteUninstaller: everything needed to go back is persisted. */
export function txPrepare(installDir: string, transactionId: string, registry: NonNullable<Journal["registry"]>, deps: TxDeps): Journal {
    const journal = requireJournal(installDir, transactionId, "staging")
    const staged = journal.staged
    if (staged === undefined) throw new SetupRefusal("i file preparati non sono stati annotati: installazione annullata")
    verifyInitial(installDir, journal)
    const initial = initialOf(journal)
    const staging = ownDirectory(installDir, LAYOUT.staging)
    const why = newTreeMismatch(staging, bindPayload(deps.payloadRoot, installDir), journal.target.version, true)
    if (why !== null) throw new SetupRefusal(`.staging non corrisponde al pacchetto di questo setup (${why}): installazione annullata`)
    const inventory = path.win32.join(staging, INVENTORY)
    if (staged.inventorySha256 === null || sha256Of(inventory) !== staged.inventorySha256) throw new SetupRefusal(".staging è cambiata dopo essere stata annotata")
    const uninstallerNew = path.win32.join(stateDir(installDir), UNINSTALLER_NEW)
    if (staged.uninstallerSha256 === null || !exists(uninstallerNew) || sha256Of(uninstallerNew) !== staged.uninstallerSha256) throw new SetupRefusal("il nuovo disinstallatore non è stato scritto o è cambiato")
    const recordPath = path.win32.join(installDir, RECORD_NAME)
    const record = readRecord(recordPath)
    let recordSha256: string | null = null
    if (record !== null) {
        const text = fs.readFileSync(recordPath, "utf8")
        recordSha256 = sha256Text(text)
        if (recordSha256 !== initial.record?.sha256) throw new SetupRefusal("il registro di installazione non è leggibile esattamente com'era all'inizio della transazione: installazione annullata")
        fs.writeFileSync(path.win32.join(stateDir(installDir), RECORD_COPY), text, { flag: "wx" })
    }
    const { checksum: _checksum, ...body } = journal
    return writeJournal({
        ...body, phase: "prepared", registry,
        previous: {
            version: record?.version ?? null, hadCurrent: initial.current !== null, recordExisted: record !== null, recordSha256,
            uninstallerExisted: initial.uninstallerSha256 !== null, uninstallerSha256: initial.uninstallerSha256, newUninstallerSha256: staged.uninstallerSha256,
        },
    })
}

/** current -> previous, .staging -> current: both trees verified file by file right before the first rename. */
export function txSwap(installDir: string, transactionId: string, deps: TxDeps): Journal {
    const journal = requireJournal(installDir, transactionId, "prepared")
    verifyInitial(installDir, journal)
    const initial = initialOf(journal)
    const staging = ownDirectory(installDir, LAYOUT.staging)
    const current = ownDirectory(installDir, LAYOUT.current)
    const stagingWhy = newTreeMismatch(staging, bindPayload(deps.payloadRoot, installDir), journal.target.version, true)
    if (stagingWhy !== null) throw new SetupRefusal(`.staging non viene attivata (${stagingWhy}): nulla viene spostato`)
    if (journal.previous?.hadCurrent === true) {
        const currentWhy = installedTreeMismatch(current, initial.current?.inventorySha256 ?? null, journal.previous.version, false)
        if (currentWhy !== null) throw new SetupRefusal(`la versione installata non viene spostata (${currentWhy}): nulla viene spostato`)
    }
    const { checksum: _checksum, ...body } = journal
    writeJournal({ ...body, phase: "swapping" })
    if (journal.previous?.hadCurrent === true) rename(current, ownDirectory(installDir, LAYOUT.previous), "spostamento della versione installata in previous", deps.rename)
    deps.checkpoint?.("after-first-rename")
    rename(staging, current, "attivazione della nuova versione", deps.rename)
    deps.checkpoint?.("after-second-rename")
    return writeJournal({ ...body, phase: "metadata" })
}

/** The new record and the new uninstaller (the previous one kept in state\uninstall.exe.previous); each replaced file checked first. */
export function txMetadata(installDir: string, transactionId: string, deps: TxDeps): void {
    const journal = requireJournal(installDir, transactionId, "metadata")
    const prev = journal.previous as NonNullable<Journal["previous"]>
    const recordPath = path.win32.join(installDir, RECORD_NAME)
    const uninstaller = path.win32.join(installDir, UNINSTALLER)
    const uninstallerNew = path.win32.join(stateDir(installDir), UNINSTALLER_NEW)
    if ((exists(recordPath) ? sha256Of(recordPath) : null) !== (initialOf(journal).record?.sha256 ?? null)) throw new SetupRefusal("il registro di installazione è cambiato dopo l'inizio della transazione: non viene sostituito")
    if ((exists(uninstaller) ? sha256Of(uninstaller) : null) !== prev.uninstallerSha256) throw new SetupRefusal("uninstall.exe è cambiato dopo l'inizio della transazione: non viene sostituito né spostato")
    if (!exists(uninstallerNew) || sha256Of(uninstallerNew) !== prev.newUninstallerSha256) throw new SetupRefusal("il nuovo disinstallatore è cambiato dopo la verifica: non viene attivato")
    // the destinations of the renames below, checked before the record is written (rename() checks again)
    if (prev.uninstallerExisted && exists(path.win32.join(stateDir(installDir), UNINSTALLER_PREVIOUS))) throw new SetupRefusal("state\\uninstall.exe.previous esiste già: non viene sostituito, nulla viene cambiato")
    const previousRecord = readRecord(recordPath)
    writeRecord(recordPath, { schemaVersion: 1, product: PRODUCT, installDir, generation: journal.transactionId, version: journal.target.version, bundleSha256: journal.target.bundleSha256, installedAt: deps.now().toISOString(), profileDir: journal.target.profileDir, claude: previousRecord?.claude ?? null })
    deps.checkpoint?.("after-record")
    if (prev.uninstallerExisted) rename(uninstaller, path.win32.join(stateDir(installDir), UNINSTALLER_PREVIOUS), "conservazione del disinstallatore precedente", deps.rename)
    rename(uninstallerNew, uninstaller, "attivazione del nuovo disinstallatore", deps.rename)
    deps.checkpoint?.("after-uninstaller")
}

/** The completion point: the new installation is coherent (tree, record, uninstaller, HKCU written and read back by NSIS). */
/**
 * The new version a commit declares and a cleanup relies on, checked as a whole, changing nothing:
 *  - current: a real directory, byte for byte the payload of the transaction's version (its inventory, every
 *    file present with its size and SHA-256, no other file, no link);
 *  - the record: valid, bound to this directory, of this transaction's generation and version;
 *  - uninstall.exe: a regular file with the content noted at tx-prepare (an invariance check of the file this
 *    transaction activated, not a proof of anything else).
 * Empty: verified; otherwise the reasons. A missing reference is a reason, never a pass.
 */
function activeVersionMismatch(installDir: string, journal: Journal, payload: BoundPayload | null): string[] {
    const reasons: string[] = []
    let current: string
    try {
        current = ownDirectory(installDir, LAYOUT.current)
    } catch (error) {
        return [`current (${(error as Error).message})`]
    }
    if (!exists(current)) reasons.push("current (manca)")
    else {
        const why = newTreeMismatch(current, payload, journal.target.version, true)
        if (why !== null) reasons.push(`current (${why})`)
    }
    let record: InstallRecord | null
    try {
        record = readRecord(path.win32.join(installDir, RECORD_NAME))
    } catch (error) {
        record = null
        reasons.push(`${RECORD_NAME} (${(error as Error).message})`)
    }
    if (record === null) {
        if (!reasons.some((r) => r.startsWith(RECORD_NAME))) reasons.push(`${RECORD_NAME} (manca)`)
    } else {
        if (!samePath(record.installDir, installDir)) reasons.push(`${RECORD_NAME} (appartiene a un'altra cartella)`)
        if (record.generation !== journal.transactionId) reasons.push(`${RECORD_NAME} (non è il registro scritto da questa transazione)`)
        if (record.version !== journal.target.version) reasons.push(`${RECORD_NAME} (versione ${record.version}, attesa ${journal.target.version})`)
    }
    const uninstaller = path.win32.join(installDir, UNINSTALLER)
    const stats = fs.lstatSync(uninstaller, { throwIfNoEntry: false })
    const noted = journal.previous?.newUninstallerSha256 ?? null
    if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) reasons.push(`${UNINSTALLER} (manca o non è un file normale)`)
    else if (noted === null || sha256Of(uninstaller) !== noted) reasons.push(`${UNINSTALLER} (non è il disinstallatore attivato da questa transazione)`)
    return reasons
}

/** The completion point: only a new version verified as a whole (activeVersionMismatch) is declared committed. */
export function txCommit(installDir: string, transactionId: string, registryWritten: boolean, deps: TxDeps): Journal {
    const journal = requireJournal(installDir, transactionId, "metadata")
    if (!registryWritten) throw new SetupRefusal("i valori di registro non risultano scritti e verificati")
    if (exists(path.win32.join(stateDir(installDir), UNINSTALLER_NEW))) throw new SetupRefusal("il disinstallatore non è nella posizione attesa")
    const reasons = activeVersionMismatch(installDir, journal, bindPayload(deps.payloadRoot, installDir))
    if (reasons.length > 0) throw new SetupRefusal(`la nuova versione non risulta integra: ${reasons.join("; ")}. La transazione non viene confermata; journal, versione precedente e copie restano dove sono`)
    const { checksum: _checksum, ...body } = journal
    return writeJournal({ ...body, phase: "committed" })
}

/**
 * What keeps the cleanup of a committed transaction from going ahead (empty: every target verified): the
 * active version first (nothing of the old one goes while the new one is not verified as a whole), then
 * each target to remove.
 */
function cleanupBlockers(installDir: string, journal: Journal, payload: BoundPayload | null): string[] {
    const blockers = activeVersionMismatch(installDir, journal, payload)
    const initial = journal.initial
    const prev = journal.previous as NonNullable<Journal["previous"]>
    const state = stateDir(installDir)
    const previous = ownDirectory(installDir, LAYOUT.previous)
    if (exists(previous)) {
        const why = initial === undefined ? LEGACY : installedTreeMismatch(previous, initial.current?.inventorySha256 ?? null, prev.version, false)
        if (why !== null) blockers.push(`previous (${why})`)
    }
    const saved = path.win32.join(state, UNINSTALLER_PREVIOUS)
    if (exists(saved) && (initial === undefined || initial.uninstallerSha256 === null || sha256Of(saved) !== initial.uninstallerSha256)) blockers.push(`state\\${UNINSTALLER_PREVIOUS} (${initial === undefined ? LEGACY : "non è il disinstallatore che l'installazione aveva all'inizio della transazione"})`)
    const copy = path.win32.join(state, RECORD_COPY)
    const anchor = initial?.record ?? null
    if (exists(copy) && (anchor === null || sha256Of(copy) !== anchor.sha256 || !recordBoundAs(copy, installDir, anchor.generation))) blockers.push(`state\\${RECORD_COPY} (${initial === undefined ? LEGACY : "non è il registro che l'installazione aveva all'inizio della transazione"})`)
    if (exists(path.win32.join(state, UNINSTALLER_NEW))) blockers.push(`state\\${UNINSTALLER_NEW} (non previsto dopo la conferma)`)
    return blockers
}

/**
 * After the commit: removes what this committed transaction kept (previous, the old uninstaller, the copy of
 * the old record), each verified as the recognised installation's own file or tree; all of them checked
 * before the first removal, each again right before it. Then the journal.
 */
export function txCleanup(installDir: string, deps: TxDeps, transactionId: string | null): void {
    const journal = readJournal(installDir)
    if (journal === null) return
    if (journal.phase !== "committed") throw new SetupRefusal("la transazione non è confermata: nessuna pulizia")
    correlate(journal, transactionId)
    const payload = bindPayload(deps.payloadRoot, installDir)
    // preflight: the active version and every target, before the first removal; then again right before each one
    const verify = (): void => {
        const blockers = cleanupBlockers(installDir, journal, payload)
        if (blockers.length > 0) throw blocked("la pulizia della versione precedente", blockers)
    }
    verify()
    const previous = ownDirectory(installDir, LAYOUT.previous)
    if (exists(previous)) {
        verify()
        removeTree(previous, deps.unlink, true)
    }
    deps.checkpoint?.("during-cleanup")
    for (const [file, what] of [[UNINSTALLER_PREVIOUS, "il disinstallatore precedente"], [RECORD_COPY, "la copia del registro precedente"]] as const) {
        const full = path.win32.join(stateDir(installDir), file)
        if (!exists(full)) continue
        verify()
        removeFile(full, what)
    }
    verify()
    removeFile(journalPath(installDir), "il journal")
}

// ------------------------------------------------------------------ recovery (also the rollback after an error)

export interface RecoveryOutcome {
    /** none: no journal; cleaned: committed transaction completed; rolled-back: previous state back; registry-restore: files back, NSIS must restore HKCU and call tx-recover-finish. */
    readonly outcome: "none" | "cleaned" | "rolled-back" | "registry-restore"
    readonly registry: Journal["registry"]
}

/**
 * Everything a rollback would rename, replace or delete, checked against its own evidence before anything
 * is changed. Empty: every target is attributable; otherwise the reasons, and nothing may be changed.
 */
function recoveryBlockers(installDir: string, journal: Journal, payload: BoundPayload | null): string[] {
    const blockers: string[] = []
    const block = (what: string, why: string | null): void => {
        if (why !== null) blockers.push(`${what} (${why})`)
    }
    const prev = journal.previous
    const initial = journal.initial
    const state = stateDir(installDir)
    const version = journal.target.version
    const current = ownDirectory(installDir, LAYOUT.current)
    const previous = ownDirectory(installDir, LAYOUT.previous)
    const staging = ownDirectory(installDir, LAYOUT.staging)
    const unrecognisable = "le cartelle current, previous e .staging non sono in uno stato riconoscibile"
    // trees: the new one is removed (payload), the old one is renamed back (its own inventory)
    if (prev !== null && prev.hadCurrent) {
        if (exists(previous)) {
            block(LAYOUT.previous, initial === undefined ? LEGACY : installedTreeMismatch(previous, initial.current?.inventorySha256 ?? null, prev.version, true))
            if (exists(current)) {
                if (exists(staging)) blockers.push(unrecognisable)
                else block(LAYOUT.current, newTreeMismatch(current, payload, version, false))
            }
        } else if (exists(current)) {
            block(LAYOUT.current, initial === undefined ? LEGACY : installedTreeMismatch(current, initial.current?.inventorySha256 ?? null, prev.version, false))
        } else {
            blockers.push(unrecognisable)
        }
    } else if (prev !== null && exists(current)) {
        if (exists(staging)) blockers.push(unrecognisable)
        else block(LAYOUT.current, newTreeMismatch(current, payload, version, false))
    }
    if (exists(staging)) block(LAYOUT.staging, newTreeMismatch(staging, payload, version, false))
    // uninstallers: the old one comes back; the new one has no reference unless it is identical to the old
    const uninstaller = path.win32.join(installDir, UNINSTALLER)
    const fresh = path.win32.join(state, UNINSTALLER_NEW)
    const saved = path.win32.join(state, UNINSTALLER_PREVIOUS)
    const old = initial?.uninstallerSha256 ?? null
    if (prev !== null && prev.uninstallerExisted) {
        if (initial === undefined) blockers.push(`${UNINSTALLER} (${LEGACY})`)
        else if (exists(saved)) {
            if (sha256Of(saved) !== old) blockers.push(`state\\${UNINSTALLER_PREVIOUS} (non è il disinstallatore che l'installazione aveva all'inizio della transazione)`)
            if (exists(uninstaller) && sha256Of(uninstaller) !== old) blockers.push(`${UNINSTALLER} (${NEW_UNINSTALLER})`)
        } else if (!exists(uninstaller) || sha256Of(uninstaller) !== old) {
            blockers.push(`${UNINSTALLER} (il disinstallatore precedente non si trova né al suo posto né nella copia)`)
        }
    } else if (prev !== null && exists(uninstaller)) {
        blockers.push(`${UNINSTALLER} (${NEW_UNINSTALLER})`)
    } else if (prev === null && exists(saved)) {
        blockers.push(`state\\${UNINSTALLER_PREVIOUS} (non previsto)`)
    }
    if (exists(fresh) && (old === null || sha256Of(fresh) !== old)) blockers.push(`state\\${UNINSTALLER_NEW} (${NEW_UNINSTALLER})`)
    // records: the old one comes back from its copy (never over another file); the new one has no reference
    const record = path.win32.join(installDir, RECORD_NAME)
    const copy = path.win32.join(state, RECORD_COPY)
    if (prev !== null && prev.recordExisted) {
        const anchor = initial?.record ?? null
        if (anchor === null) blockers.push(`${RECORD_NAME} (${LEGACY})`)
        else if (exists(copy)) {
            if (sha256Of(copy) !== anchor.sha256 || !recordBoundAs(copy, installDir, anchor.generation)) blockers.push(`state\\${RECORD_COPY} (non è il registro che l'installazione aveva all'inizio della transazione)`)
            else if (exists(record) && sha256Of(record) !== anchor.sha256) blockers.push(`${RECORD_NAME} (${NEW_RECORD})`)
        } else if (!exists(record) || sha256Of(record) !== anchor.sha256) {
            blockers.push(`${RECORD_NAME} (il registro precedente non si trova né al suo posto né nella copia)`)
        }
    } else {
        if (prev !== null && exists(record)) blockers.push(`${RECORD_NAME} (${NEW_RECORD})`)
        if (exists(copy) && !sameBytes(copy, record)) blockers.push(`state\\${RECORD_COPY} (non previsto)`)
    }
    return blockers
}

/** Puts back what the transaction moved, after recoveryBlockers found every target attributable; each step checked again. */
function restoreFiles(installDir: string, journal: Journal, payload: BoundPayload | null, deps: TxDeps): void {
    const prev = journal.previous
    if (prev === null) return
    const initial = initialOf(journal)
    const state = stateDir(installDir)
    const uninstaller = path.win32.join(installDir, UNINSTALLER)
    const saved = path.win32.join(state, UNINSTALLER_PREVIOUS)
    if (prev.uninstallerExisted && exists(saved)) {
        if (sha256Of(saved) !== initial.uninstallerSha256) throw new SetupRefusal("la copia del disinstallatore precedente è stata alterata")
        if (exists(uninstaller)) {
            if (sha256Of(uninstaller) !== initial.uninstallerSha256) throw new SetupRefusal("uninstall.exe non è il disinstallatore precedente: non viene toccato")
            removeFile(saved, "la copia del disinstallatore precedente, identica a uninstall.exe")
        } else {
            rename(saved, uninstaller, "ripristino del disinstallatore precedente", deps.rename)
        }
    }
    const record = path.win32.join(installDir, RECORD_NAME)
    const copy = path.win32.join(state, RECORD_COPY)
    if (prev.recordExisted && exists(copy) && !exists(record)) {
        const anchor = initial.record
        if (anchor === null || sha256Of(copy) !== anchor.sha256 || !recordBoundAs(copy, installDir, anchor.generation)) throw new SetupRefusal("la copia del registro di installazione precedente è stata alterata")
        fs.copyFileSync(copy, record, fs.constants.COPYFILE_EXCL) // created, never over another file
    }
    deps.checkpoint?.("during-recovery")
    const current = ownDirectory(installDir, LAYOUT.current)
    const previous = ownDirectory(installDir, LAYOUT.previous)
    const staging = ownDirectory(installDir, LAYOUT.staging)
    const check = (what: string, why: string | null): void => {
        if (why !== null) throw new SetupRefusal(`${what} non viene spostata (${why})`)
    }
    if (prev.hadCurrent) {
        if (exists(previous) && exists(current) && !exists(staging)) {
            check("la nuova versione", newTreeMismatch(current, payload, journal.target.version, false))
            check("la versione precedente", installedTreeMismatch(previous, initial.current?.inventorySha256 ?? null, prev.version, true))
            rename(current, staging, "ritiro della nuova versione", deps.rename)
            rename(previous, current, "ripristino della versione precedente", deps.rename)
        } else if (exists(previous) && !exists(current)) {
            check("la versione precedente", installedTreeMismatch(previous, initial.current?.inventorySha256 ?? null, prev.version, true))
            rename(previous, current, "ripristino della versione precedente", deps.rename)
        }
    } else if (exists(current) && !exists(staging)) {
        check("la nuova versione", newTreeMismatch(current, payload, journal.target.version, false))
        rename(current, staging, "ritiro della nuova versione", deps.rename)
    }
}

/** Last part of a rollback: the new tree (payload files only), the new uninstaller and the copy only as duplicates, then the journal. */
function finishRollback(installDir: string, journal: Journal, payload: BoundPayload | null, deps: TxDeps): void {
    const state = stateDir(installDir)
    const staging = ownDirectory(installDir, LAYOUT.staging)
    if (exists(staging)) {
        const why = newTreeMismatch(staging, payload, journal.target.version, false)
        if (why !== null || payload === null) throw new SetupRefusal(`.staging non viene rimossa (${why ?? ""})`)
        const local = path.win32.join(staging, INVENTORY)
        // an extraction stopped before its inventory: the payload's own inventory describes what may go
        if (!exists(local) && !holdsNoFile(staging)) fs.writeFileSync(local, payload.inventoryBytes, { flag: "wx" })
        removeTree(staging, deps.unlink, true)
    }
    const fresh = path.win32.join(state, UNINSTALLER_NEW)
    if (exists(fresh)) {
        const old = journal.initial?.uninstallerSha256 ?? null
        if (old === null || sha256Of(fresh) !== old) throw new SetupRefusal(`state\\${UNINSTALLER_NEW} non viene rimosso (${NEW_UNINSTALLER})`)
        removeFile(fresh, "il nuovo disinstallatore, identico a quello installato")
    }
    if (exists(path.win32.join(state, UNINSTALLER_PREVIOUS))) throw new SetupRefusal("state\\uninstall.exe.previous è ancora presente dopo il ripristino")
    const copy = path.win32.join(state, RECORD_COPY)
    if (exists(copy)) {
        if (!sameBytes(copy, path.win32.join(installDir, RECORD_NAME))) throw new SetupRefusal("la copia del registro precedente non coincide con il registro ripristinato: non viene rimossa")
        removeFile(copy, "la copia del registro precedente, identica al registro")
    }
    deps.checkpoint?.("after-record-copy-removed")
    removeFile(journalPath(installDir), "il journal")
}

/**
 * The start of every installation, and the rollback of a failed one:
 *  - committed transaction: only its cleanup (no old version restored);
 *  - staging/prepared: nothing was swapped; the new tree and copies go;
 *  - swapping/metadata/rolling-back: uninstaller, record and directories
 *    back; if HKCU may have been written, NSIS must restore it from the
 *    journal and confirm with tx-recover-finish.
 * Every target is checked first (recoveryBlockers): one that is not attributable and nothing is changed.
 * The transaction id of the request only correlates. Any failure stops with the journal and every copy kept.
 */
export function txRecover(input: { installDir: string; env: NodeJS.ProcessEnv; session: string | null }, deps: TxDeps): RecoveryOutcome {
    const installDir = installRoot(input.installDir, input.env)
    const journal = readJournal(installDir)
    if (journal === null) return { outcome: "none", registry: null }
    correlate(journal, input.session)
    const incomplete = (error: unknown): never => {
        throw new SetupRefusal(`recupero INCOMPLETO (${error instanceof Error ? error.message : String(error)}): journal e copie di recupero sono conservati, nulla di recuperabile è stato cancellato. Esegui di nuovo il setup dopo aver risolto il problema`)
    }
    try {
        if (journal.phase === "committed") {
            txCleanup(installDir, deps, null)
            return { outcome: "cleaned", registry: null }
        }
        const payload = bindPayload(deps.payloadRoot, installDir)
        const blockers = recoveryBlockers(installDir, journal, payload)
        if (blockers.length > 0) throw blocked("il ripristino automatico", blockers)
        if (journal.phase === "staging" || journal.phase === "prepared") {
            finishRollback(installDir, journal, payload, deps)
            return { outcome: "rolled-back", registry: null }
        }
        restoreFiles(installDir, journal, payload, deps)
        if (journal.phase === "swapping") {
            finishRollback(installDir, journal, payload, deps)
            return { outcome: "rolled-back", registry: null }
        }
        const { checksum: _checksum, ...body } = journal
        writeJournal({ ...body, phase: "rolling-back" })
        return { outcome: "registry-restore", registry: journal.registry }
    } catch (error) {
        return incomplete(error)
    }
}

/** After NSIS restored HKCU from the journal: the rollback is finished only if it confirms it. */
export function txRecoverFinish(input: { installDir: string; env: NodeJS.ProcessEnv; registryRestored: boolean; session: string | null }, deps: TxDeps): void {
    const installDir = installRoot(input.installDir, input.env)
    const journal = readJournal(installDir)
    if (journal === null || journal.phase !== "rolling-back") throw new SetupRefusal("nessun ripristino in attesa dei valori di registro")
    correlate(journal, input.session)
    if (!input.registryRestored) throw new SetupRefusal("recupero INCOMPLETO: i valori di registro di Windows non sono stati ripristinati; journal e copie di recupero sono conservati")
    try {
        const payload = bindPayload(deps.payloadRoot, installDir)
        const blockers = recoveryBlockers(installDir, journal, payload)
        if (blockers.length > 0) throw blocked("il completamento del ripristino", blockers)
        finishRollback(installDir, journal, payload, deps)
    } catch (error) {
        throw new SetupRefusal(`recupero INCOMPLETO (${(error as Error).message}): journal e copie di recupero sono conservati`)
    }
}

/** The HKCU instructions for NSIS: per slot write (type, value) or delete-if-present; per key delete-if-empty when it did not exist. */
export function registryInstructions(registry: NonNullable<Journal["registry"]>): [string, string][] {
    const fields: [string, string][] = []
    for (const v of registry.values) {
        if (v.present) fields.push([`reg${v.id}.action`, "write"], [`reg${v.id}.type`, v.type as string], [`reg${v.id}.value`, v.value as string])
        else fields.push([`reg${v.id}.action`, "delete"])
    }
    fields.push(["key.uninstall.deleteIfEmpty", registry.keys.uninstall ? "no" : "yes"], ["key.settings.deleteIfEmpty", registry.keys.settings ? "no" : "yes"])
    return fields
}
