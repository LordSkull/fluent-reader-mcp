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
import { canonicalPath, samePath } from "../lib/common.js"
import { INVENTORY, readInventory, removeTree } from "./app.js"
import { checkInstallDir, installRoot, LAYOUT, UNINSTALLER } from "./checks.js"
import { SetupRefusal, type Request } from "./protocol.js"
import { canonicalJson, PRODUCT, RECORD_NAME, readRecord, writeRecord } from "./record.js"

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
    readonly checksum: string
}

type JournalBody = Omit<Journal, "checksum">

/** Test hook: the named points where a crash (process killed) is simulated. */
export type TxCheckpoint = "after-first-rename" | "after-second-rename" | "after-record" | "after-uninstaller" | "during-recovery" | "after-record-copy-removed" | "during-cleanup"

export interface TxDeps {
    readonly now: () => Date
    readonly checkpoint?: ((step: TxCheckpoint) => void) | undefined
    readonly unlink?: ((file: string) => void) | undefined
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

/**
 * The journal of `installDir`, or null. A journal that is unreadable, of
 * another product or directory, or whose checksum does not match is never
 * acted upon: the caller stops without changing anything.
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

function rename(from: string, to: string, what: string): void {
    try {
        fs.renameSync(from, to)
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

/** Removes a tree created by this transaction, through its inventory (the one of the payload when the extraction stopped before it). */
function removeOwnTree(installDir: string, name: string, deps: TxDeps, fallbackInventory: string | null): void {
    const dir = ownDirectory(installDir, name)
    if (!exists(dir)) return
    if (!exists(path.win32.join(dir, INVENTORY)) && fallbackInventory !== null && exists(fallbackInventory)) {
        // .staging interrupted during the extraction: only the payload's own files may go.
        readInventory(path.win32.dirname(fallbackInventory))
        fs.copyFileSync(fallbackInventory, path.win32.join(dir, INVENTORY), fs.constants.COPYFILE_EXCL)
    }
    removeTree(dir, deps.unlink)
}

// ------------------------------------------------------------------ transaction steps

/** Before the extraction: the journal makes `.staging` an artifact of this transaction. */
export function txBegin(deps: TxDeps, input: { installDir: string; version: string; maxRelative: number; bundleSha256: string; profileDir: string; env: NodeJS.ProcessEnv }): Journal {
    const installDir = checkInstallDir({ installDir: input.installDir, version: input.version, maxRelative: input.maxRelative, env: input.env }).canonical
    fs.mkdirSync(stateDir(installDir), { recursive: true })
    if (readJournal(installDir) !== null) throw new SetupRefusal("una transazione di installazione precedente non è stata risolta: va eseguito prima il recupero")
    for (const name of [LAYOUT.staging, LAYOUT.previous]) {
        if (exists(path.win32.join(installDir, name))) throw new SetupRefusal(`la cartella ${name} esiste senza una transazione che la descriva: non viene rimossa automaticamente; spostala o cancellala a mano dopo averla controllata`)
    }
    for (const file of [RECORD_COPY, UNINSTALLER_NEW, UNINSTALLER_PREVIOUS]) {
        if (exists(path.win32.join(stateDir(installDir), file))) throw new SetupRefusal(`state\\${file} esiste senza una transazione che lo descriva: controllalo e rimuovilo a mano`)
    }
    return writeJournal({
        schemaVersion: 1, product: PRODUCT, kind: "install-journal", installDir, transactionId: crypto.randomBytes(16).toString("hex"), createdAt: deps.now().toISOString(),
        phase: "staging", target: { version: input.version, bundleSha256: input.bundleSha256, profileDir: input.profileDir }, previous: null, registry: null,
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

/** After the verification of .staging and WriteUninstaller: everything needed to go back is persisted. */
export function txPrepare(installDir: string, transactionId: string, registry: NonNullable<Journal["registry"]>): Journal {
    const journal = requireJournal(installDir, transactionId, "staging")
    const staging = ownDirectory(installDir, LAYOUT.staging)
    if (!exists(path.win32.join(staging, INVENTORY))) throw new SetupRefusal(".staging non è completa")
    if (!exists(path.win32.join(stateDir(installDir), UNINSTALLER_NEW))) throw new SetupRefusal("il nuovo disinstallatore non è stato scritto")
    const recordPath = path.win32.join(installDir, RECORD_NAME)
    const record = readRecord(recordPath)
    let recordSha256: string | null = null
    if (record !== null) {
        const text = fs.readFileSync(recordPath, "utf8")
        fs.writeFileSync(path.win32.join(stateDir(installDir), RECORD_COPY), text, { flag: "wx" })
        recordSha256 = sha256Text(text)
    }
    const uninstaller = path.win32.join(installDir, UNINSTALLER)
    const uninstallerExisted = exists(uninstaller)
    const { checksum: _checksum, ...body } = journal
    return writeJournal({
        ...body, phase: "prepared", registry,
        previous: {
            version: record?.version ?? null, hadCurrent: exists(ownDirectory(installDir, LAYOUT.current)), recordExisted: record !== null, recordSha256,
            uninstallerExisted, uninstallerSha256: uninstallerExisted ? sha256Of(uninstaller) : null, newUninstallerSha256: sha256Of(path.win32.join(stateDir(installDir), UNINSTALLER_NEW)),
        },
    })
}

export function txSwap(installDir: string, transactionId: string, deps: TxDeps): Journal {
    const journal = requireJournal(installDir, transactionId, "prepared")
    const { checksum: _checksum, ...body } = journal
    writeJournal({ ...body, phase: "swapping" })
    const current = ownDirectory(installDir, LAYOUT.current)
    if (journal.previous?.hadCurrent === true) rename(current, ownDirectory(installDir, LAYOUT.previous), "spostamento della versione installata in previous")
    deps.checkpoint?.("after-first-rename")
    rename(ownDirectory(installDir, LAYOUT.staging), current, "attivazione della nuova versione")
    deps.checkpoint?.("after-second-rename")
    return writeJournal({ ...body, phase: "metadata" })
}

/** The new record and the new uninstaller (the previous one kept in state\uninstall.exe.previous). */
export function txMetadata(installDir: string, transactionId: string, deps: TxDeps): void {
    const journal = requireJournal(installDir, transactionId, "metadata")
    const recordPath = path.win32.join(installDir, RECORD_NAME)
    const previousRecord = readRecord(recordPath)
    writeRecord(recordPath, { schemaVersion: 1, product: PRODUCT, installDir, generation: journal.transactionId, version: journal.target.version, bundleSha256: journal.target.bundleSha256, installedAt: deps.now().toISOString(), profileDir: journal.target.profileDir, claude: previousRecord?.claude ?? null })
    deps.checkpoint?.("after-record")
    const uninstaller = path.win32.join(installDir, UNINSTALLER)
    if (journal.previous?.uninstallerExisted === true) rename(uninstaller, path.win32.join(stateDir(installDir), UNINSTALLER_PREVIOUS), "conservazione del disinstallatore precedente")
    rename(path.win32.join(stateDir(installDir), UNINSTALLER_NEW), uninstaller, "attivazione del nuovo disinstallatore")
    deps.checkpoint?.("after-uninstaller")
}

/** The completion point: the new installation is coherent (tree, record, uninstaller, HKCU written and read back by NSIS). */
export function txCommit(installDir: string, transactionId: string, registryWritten: boolean): Journal {
    const journal = requireJournal(installDir, transactionId, "metadata")
    if (!registryWritten) throw new SetupRefusal("i valori di registro non risultano scritti e verificati")
    const current = ownDirectory(installDir, LAYOUT.current)
    if (readInventory(current).version !== journal.target.version) throw new SetupRefusal("current non contiene la nuova versione")
    const record = readRecord(path.win32.join(installDir, RECORD_NAME))
    if (record === null || record.version !== journal.target.version || !samePath(record.installDir, installDir)) throw new SetupRefusal("il registro di installazione non corrisponde alla nuova versione")
    if (!exists(path.win32.join(installDir, UNINSTALLER)) || exists(path.win32.join(stateDir(installDir), UNINSTALLER_NEW))) throw new SetupRefusal("il disinstallatore non è nella posizione attesa")
    const { checksum: _checksum, ...body } = journal
    return writeJournal({ ...body, phase: "committed" })
}

/** After the commit: removes only what this committed transaction kept (previous, copies), then the journal. */
export function txCleanup(installDir: string, deps: TxDeps): void {
    const journal = readJournal(installDir)
    if (journal === null) return
    if (journal.phase !== "committed") throw new SetupRefusal("la transazione non è confermata: nessuna pulizia")
    removeOwnTree(installDir, LAYOUT.previous, deps, null)
    deps.checkpoint?.("during-cleanup")
    removeFile(path.win32.join(stateDir(installDir), UNINSTALLER_PREVIOUS), "il disinstallatore precedente")
    removeFile(path.win32.join(stateDir(installDir), RECORD_COPY), "la copia del registro precedente")
    removeFile(journalPath(installDir), "il journal")
}

// ------------------------------------------------------------------ recovery (also the rollback after an error)

export interface RecoveryOutcome {
    /** none: no journal; cleaned: committed transaction completed; rolled-back: previous state back; registry-restore: files back, NSIS must restore HKCU and call tx-recover-finish. */
    readonly outcome: "none" | "cleaned" | "rolled-back" | "registry-restore"
    readonly registry: Journal["registry"]
}

/** Puts the files of a non-committed transaction back as they were; each step verified, idempotent when repeated. */
function restoreFiles(installDir: string, journal: Journal, deps: TxDeps): void {
    const prev = journal.previous
    if (prev === null) return
    const state = stateDir(installDir)
    // uninstaller: recognised by content (SHA-256 recorded at tx-prepare), so a repeated recovery finds it already back
    const uninstaller = path.win32.join(installDir, UNINSTALLER)
    const saved = path.win32.join(state, UNINSTALLER_PREVIOUS)
    const isNew = (file: string): boolean => exists(file) && sha256Of(file) === prev.newUninstallerSha256
    if (prev.uninstallerExisted) {
        if (exists(saved)) {
            if (sha256Of(saved) !== prev.uninstallerSha256) throw new SetupRefusal("la copia del disinstallatore precedente è stata alterata")
            if (exists(uninstaller)) {
                if (!isNew(uninstaller)) throw new SetupRefusal("uninstall.exe non è né il precedente né il nuovo disinstallatore: non viene toccato")
                removeFile(uninstaller, "il nuovo disinstallatore")
            }
            rename(saved, uninstaller, "ripristino del disinstallatore precedente")
        } else if (!exists(uninstaller) || sha256Of(uninstaller) !== prev.uninstallerSha256) {
            throw new SetupRefusal("il disinstallatore precedente non si trova né al suo posto né nella copia")
        }
    } else if (exists(uninstaller)) {
        if (!isNew(uninstaller)) throw new SetupRefusal("uninstall.exe non è il disinstallatore di questa transazione: non viene toccato")
        removeFile(uninstaller, "il nuovo disinstallatore")
    }
    // record: from the copy while it exists; once the copy is gone (a recovery interrupted after removing it), the
    // record must already be the previous one, byte for byte (SHA-256 recorded at tx-prepare)
    const recordPath = path.win32.join(installDir, RECORD_NAME)
    const copy = path.win32.join(state, RECORD_COPY)
    if (prev.recordExisted) {
        if (exists(copy)) {
            const text = fs.readFileSync(copy, "utf8")
            if (sha256Text(text) !== prev.recordSha256) throw new SetupRefusal("la copia del registro di installazione precedente è stata alterata")
            if (!exists(recordPath) || fs.readFileSync(recordPath, "utf8") !== text) {
                const temp = `${recordPath}.${process.pid}.tmp`
                fs.rmSync(temp, { force: true })
                fs.writeFileSync(temp, text, { flag: "wx" })
                fs.renameSync(temp, recordPath)
            }
        }
        if (!exists(recordPath)) throw new SetupRefusal("il registro di installazione precedente manca e la sua copia non c'è più")
        if (sha256Of(recordPath) !== prev.recordSha256) throw new SetupRefusal("il registro di installazione non corrisponde a quello precedente (SHA-256) e la sua copia non c'è più: non viene toccato")
    } else if (exists(recordPath)) {
        const record = readRecord(recordPath)
        if (record?.generation !== journal.transactionId) throw new SetupRefusal("il registro di installazione presente non è quello scritto da questa transazione: non viene toccato")
        removeFile(recordPath, "il registro della nuova installazione")
    }
    deps.checkpoint?.("during-recovery")
    // directories: the first, both or no rename of the swap may have happened
    const current = ownDirectory(installDir, LAYOUT.current)
    const previous = ownDirectory(installDir, LAYOUT.previous)
    const staging = ownDirectory(installDir, LAYOUT.staging)
    if (prev.hadCurrent) {
        if (exists(previous) && exists(current) && !exists(staging)) {
            rename(current, staging, "ritiro della nuova versione")
            rename(previous, current, "ripristino della versione precedente")
        } else if (exists(previous) && !exists(current)) {
            rename(previous, current, "ripristino della versione precedente")
        } else if (!(exists(current) && !exists(previous))) {
            throw new SetupRefusal("le cartelle current, previous e .staging non sono in uno stato riconoscibile")
        }
        const version = readInventory(current).version
        if (prev.version !== null && version !== prev.version) throw new SetupRefusal(`current contiene la versione ${version}, attesa ${prev.version}`)
    } else if (exists(current)) {
        if (exists(staging)) throw new SetupRefusal("le cartelle current e .staging non sono in uno stato riconoscibile")
        rename(current, staging, "ritiro della nuova versione")
    }
}

/** Last part of a rollback: the new tree and the copies go, then the journal. */
function finishRollback(installDir: string, deps: TxDeps, fallbackInventory: string | null): void {
    removeOwnTree(installDir, LAYOUT.staging, deps, fallbackInventory)
    removeFile(path.win32.join(stateDir(installDir), UNINSTALLER_NEW), "il nuovo disinstallatore non usato")
    if (exists(path.win32.join(stateDir(installDir), UNINSTALLER_PREVIOUS))) throw new SetupRefusal("state\\uninstall.exe.previous è ancora presente dopo il ripristino")
    removeFile(path.win32.join(stateDir(installDir), RECORD_COPY), "la copia del registro precedente")
    deps.checkpoint?.("after-record-copy-removed")
    removeFile(journalPath(installDir), "il journal")
}

/**
 * The start of every installation, and the rollback of a failed one:
 *  - committed transaction: only its cleanup (no old version restored);
 *  - staging/prepared: nothing was swapped; the new tree and copies go;
 *  - swapping/metadata/rolling-back: uninstaller, record and directories
 *    back (each step verified); if HKCU may have been written, NSIS must
 *    restore it from the journal and confirm with tx-recover-finish.
 * Any failure stops with the journal and every copy kept.
 */
export function txRecover(input: { installDir: string; env: NodeJS.ProcessEnv; fallbackInventory: string | null }, deps: TxDeps): RecoveryOutcome {
    const installDir = installRoot(input.installDir, input.env)
    const journal = readJournal(installDir)
    if (journal === null) return { outcome: "none", registry: null }
    const incomplete = (error: unknown): never => {
        throw new SetupRefusal(`recupero INCOMPLETO (${error instanceof Error ? error.message : String(error)}): journal e copie di recupero sono conservati, nulla di recuperabile è stato cancellato. Esegui di nuovo il setup dopo aver risolto il problema`)
    }
    try {
        if (journal.phase === "committed") {
            txCleanup(installDir, deps)
            return { outcome: "cleaned", registry: null }
        }
        if (journal.phase === "staging" || journal.phase === "prepared") {
            finishRollback(installDir, deps, input.fallbackInventory)
            return { outcome: "rolled-back", registry: null }
        }
        restoreFiles(installDir, journal, deps)
        if (journal.phase === "swapping") {
            finishRollback(installDir, deps, input.fallbackInventory)
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
export function txRecoverFinish(input: { installDir: string; env: NodeJS.ProcessEnv; registryRestored: boolean; fallbackInventory: string | null }, deps: TxDeps): void {
    const installDir = installRoot(input.installDir, input.env)
    const journal = readJournal(installDir)
    if (journal === null || journal.phase !== "rolling-back") throw new SetupRefusal("nessun ripristino in attesa dei valori di registro")
    if (!input.registryRestored) throw new SetupRefusal("recupero INCOMPLETO: i valori di registro di Windows non sono stati ripristinati; journal e copie di recupero sono conservati")
    try {
        finishRollback(installDir, deps, input.fallbackInventory)
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
