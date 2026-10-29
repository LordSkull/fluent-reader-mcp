/**
 * FR-MCP-04-BETA-02: a resumable uninstallation.
 *
 *   un-begin     before anything is removed: a verified copy of the helper
 *                (node.exe + setup, with its own inventory) in
 *                state\uninstall-helper, then the marker state\uninstall.json
 *                (phase "files"), bound to the record's generation. From
 *                here every attempt can run the helper again, whatever part
 *                of current is already gone.
 *   remove-tree  the installed trees (record still present)
 *   un-metadata  marker phase "metadata", then the record is removed
 *   NSIS         the product's nine HKCU values, keys only if left empty
 *   un-finish    the final marker state\uninstall-final.marker is written
 *                FIRST (UTF-16LE, readable by NSIS), then the marker goes;
 *                the helper copy is NOT touched here
 *   NSIS         on its own, without the helper: the copy's files (list
 *                compiled into the uninstaller from the payload,
 *                helper-files.nsh), uninstall.exe, the final marker
 *
 * The uninstaller accepts a directory with the record, the marker or the
 * final marker. The markers authorise nothing but this sequence: trees are
 * still removed only through a real record (remove-tree); a marker whose
 * generation is not the record's is refused; the final marker is refused
 * while a record exists and lets NSIS delete only the compiled list of the
 * copy's files, uninstall.exe and itself. A new installation is refused while
 * any of this state is present (checks.ts), so no marker is ever inherited.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { canonicalPath, compareOrdinal, listFiles, safeJoin, samePath, sha256FileSync } from "../lib/common.js"
import { HELPER_FILES, INVENTORY, readInventory, type Inventory } from "./app.js"
import { installRoot, LAYOUT, recordedInstallDir } from "./checks.js"
import { SetupRefusal } from "./protocol.js"
import { canonicalJson, PRODUCT, RECORD_NAME, readRecord } from "./record.js"
import { JOURNAL } from "./transaction.js"

export const UNINSTALL_MARKER = "uninstall.json"
export const FINAL_MARKER = "uninstall-final.marker"
export const HELPER_COPY = "uninstall-helper"

export type UninstallPhase = "files" | "metadata"

interface Marker {
    readonly schemaVersion: 1
    readonly product: typeof PRODUCT
    readonly kind: "uninstall-marker"
    readonly installDir: string
    /** The generation of the record this uninstallation started from. */
    readonly generation: string
    readonly phase: UninstallPhase
    readonly checksum: string
}

/** Test hook: where a crash (or a failing operation) is simulated. */
export type UninstallCheckpoint = "before-record-delete" | "after-record-delete" | "before-marker-delete"

/** The files of the helper copy (relative to the installed tree): the runtime and everything under setup/. */
export function helperCopyEntries(paths: readonly string[]): string[] {
    return paths.filter((p) => p.startsWith("setup/") || (HELPER_FILES as readonly string[]).includes(p)).sort(compareOrdinal)
}

function state(installDir: string): string {
    return path.win32.join(installDir, LAYOUT.state)
}

function markerChecksum(body: Omit<Marker, "checksum">): string {
    return crypto.createHash("sha256").update(canonicalJson(body)).digest("hex")
}

function writeMarker(installDir: string, phase: UninstallPhase, generation: string): void {
    const body: Omit<Marker, "checksum"> = { schemaVersion: 1, product: PRODUCT, kind: "uninstall-marker", installDir, generation, phase }
    const file = path.win32.join(state(installDir), UNINSTALL_MARKER)
    const temp = `${file}.${process.pid}.tmp`
    fs.mkdirSync(state(installDir), { recursive: true })
    fs.rmSync(temp, { force: true })
    fs.writeFileSync(temp, `${JSON.stringify({ ...body, checksum: markerChecksum(body) }, null, 2)}\n`, { flag: "wx" })
    fs.renameSync(temp, file)
}

/**
 * The marker of `installDir` (validated: product, directory, checksum), or
 * null. While the record exists, the marker must carry its generation: the
 * marker of another installation authorises nothing on this one.
 */
export function readMarker(installDir: string): Marker | null {
    const file = path.win32.join(state(installDir), UNINSTALL_MARKER)
    if (!fs.existsSync(file)) return null
    let raw: Partial<Marker>
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Marker>
    } catch {
        throw new SetupRefusal("lo stato della disinstallazione in corso è danneggiato: nessuna operazione automatica")
    }
    const { checksum, ...body } = raw
    if (raw.schemaVersion !== 1 || raw.product !== PRODUCT || raw.kind !== "uninstall-marker" || typeof raw.installDir !== "string" || !samePath(raw.installDir, installDir) || typeof raw.generation !== "string" || !/^[0-9a-f]{32}$/.test(raw.generation) || (raw.phase !== "files" && raw.phase !== "metadata") || checksum !== markerChecksum(body as Omit<Marker, "checksum">)) {
        throw new SetupRefusal("lo stato della disinstallazione in corso non è valido o è stato alterato: nessuna operazione automatica")
    }
    const record = readRecord(path.win32.join(installDir, RECORD_NAME))
    if (record !== null && record.generation !== raw.generation) throw new SetupRefusal("lo stato di disinstallazione presente appartiene a un'altra installazione: non viene usato, nessuna operazione automatica")
    return raw as Marker
}

/** The final marker as NSIS reads it (UTF-16LE with BOM, key=value lines). */
/** `files`: the helper copy's files (relative to state\uninstall-helper), for a setup that finishes without the uninstaller. */
export function encodeFinalMarker(installDir: string, generation: string, files: readonly string[]): Buffer {
    const lines = [`product=${PRODUCT}`, "kind=uninstall-final", `installDir=${installDir}`, `generation=${generation}`, ...files.map((f) => `file=${f}`)]
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${lines.join("\r\n")}\r\n`, "utf16le")])
}

/** Whether a final marker is present; refuses one that is not this directory's, or one next to a record. */
export function readFinalMarker(installDir: string): { generation: string; files: string[] } | null {
    const file = path.win32.join(state(installDir), FINAL_MARKER)
    if (!fs.existsSync(file)) return null
    const bytes = fs.readFileSync(file)
    const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : ""
    const lines = text.split("\r\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const)
    const fields = new Map(lines)
    const files = lines.filter(([k]) => k === "file").map(([, v]) => v)
    const invalid = (): never => {
        throw new SetupRefusal("il marcatore finale della disinstallazione non è valido: nessuna operazione automatica")
    }
    if (fields.get("product") !== PRODUCT || fields.get("kind") !== "uninstall-final" || !samePath(fields.get("installDir") ?? "", installDir) || !/^[0-9a-f]{32}$/.test(fields.get("generation") ?? "")) invalid()
    for (const f of files) {
        try {
            safeJoin(path.win32.join(state(installDir), HELPER_COPY), f)
        } catch {
            invalid()
        }
    }
    if (fs.existsSync(path.win32.join(installDir, RECORD_NAME))) throw new SetupRefusal("è presente un'installazione insieme al marcatore finale di una disinstallazione precedente: nessuna operazione automatica")
    return { generation: fields.get("generation") as string, files }
}

function copyRoot(installDir: string): string {
    const dir = path.win32.join(state(installDir), HELPER_COPY)
    const stats = fs.lstatSync(dir, { throwIfNoEntry: false })
    if (stats !== undefined && (stats.isSymbolicLink() || !stats.isDirectory() || !samePath(canonicalPath(dir), dir))) throw new SetupRefusal("la copia di recupero del programma di supporto non è una cartella normale")
    return dir
}

/** Whether the helper copy is complete: exactly its inventory, every file with the recorded SHA-256. */
export function verifyHelperCopy(installDir: string): boolean {
    const dir = copyRoot(installDir)
    if (!fs.existsSync(path.win32.join(dir, INVENTORY))) return false
    const inventory = readInventory(dir)
    let actual: string[]
    try {
        actual = listFiles(dir).filter((f) => f !== INVENTORY)
    } catch {
        return false
    }
    const listed = inventory.files.map((f) => f.path).sort(compareOrdinal)
    if (actual.join("\n") !== listed.join("\n")) return false
    if (!HELPER_FILES.every((h) => listed.includes(h))) return false
    return inventory.files.every((f) => sha256FileSync(safeJoin(dir, f.path)) === f.sha256)
}

export function uninstallStatus(installDirInput: string, env: NodeJS.ProcessEnv): { phase: UninstallPhase | "final" | "none"; helperCopy: "complete" | "missing" | "incomplete" } {
    const installDir = installRoot(installDirInput, env)
    const final = readFinalMarker(installDir)
    const marker = readMarker(installDir)
    let complete: boolean
    try {
        complete = verifyHelperCopy(installDir)
    } catch {
        complete = false
    }
    return { phase: final !== null ? "final" : marker?.phase ?? "none", helperCopy: complete ? "complete" : fs.existsSync(path.win32.join(state(installDir), HELPER_COPY)) ? "incomplete" : "missing" }
}

/**
 * Before anything is removed: a complete, verified copy of the helper
 * (completed if an earlier attempt stopped half-way; never with a file that
 * does not match the installation's inventory), then the marker.
 */
export function uninstallBegin(installDirInput: string, env: NodeJS.ProcessEnv): void {
    const installDir = recordedInstallDir(installDirInput, env)
    if (fs.existsSync(path.win32.join(state(installDir), JOURNAL))) throw new SetupRefusal("un'installazione interrotta non è stata ripristinata: esegui di nuovo il setup prima di disinstallare")
    if (fs.existsSync(path.win32.join(state(installDir), FINAL_MARKER))) readFinalMarker(installDir)
    const record = readRecord(path.win32.join(installDir, RECORD_NAME))
    if (record === null) throw new SetupRefusal("registro di installazione mancante")
    const marker = readMarker(installDir)
    if (marker !== null && marker.phase !== "files") throw new SetupRefusal("la disinstallazione è già oltre la rimozione dei file")
    const copy = copyRoot(installDir)
    if (!verifyHelperCopy(installDir)) {
        const current = path.win32.join(installDir, LAYOUT.current)
        const source = readInventory(current)
        const wanted = new Set(helperCopyEntries(source.files.map((f) => f.path)))
        const files = source.files.filter((f) => wanted.has(f.path))
        if (!HELPER_FILES.every((h) => wanted.has(h))) throw new SetupRefusal("il programma di supporto non è elencato nell'inventario dell'installazione")
        fs.mkdirSync(copy, { recursive: true })
        const present = new Set(listFiles(copy))
        for (const name of present) if (name !== INVENTORY && !wanted.has(name)) throw new SetupRefusal(`la copia di recupero contiene un file inatteso (${name}): nulla viene rimosso`)
        for (const f of files) {
            const target = safeJoin(copy, f.path)
            if (present.has(f.path) && sha256FileSync(target) === f.sha256) continue
            const from = safeJoin(current, f.path)
            if (!fs.existsSync(from) || sha256FileSync(from) !== f.sha256) throw new SetupRefusal(`impossibile preparare la copia di recupero del programma di supporto (${f.path} mancante o alterato): nulla è stato rimosso`)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.copyFileSync(from, target)
        }
        const inventory: Inventory = { schemaVersion: 1, version: source.version, files }
        fs.writeFileSync(path.win32.join(copy, INVENTORY), `${JSON.stringify(inventory, null, 2)}\n`)
        if (!verifyHelperCopy(installDir)) throw new SetupRefusal("la copia di recupero del programma di supporto non risulta completa: nulla è stato rimosso")
    }
    if (marker === null) writeMarker(installDir, "files", record.generation)
}

/** The installed trees are gone: the marker moves to "metadata", then the record goes. Idempotent. */
export function uninstallMetadata(installDirInput: string, env: NodeJS.ProcessEnv, checkpoint?: (step: UninstallCheckpoint) => void): void {
    const installDir = installRoot(installDirInput, env)
    const marker = readMarker(installDir)
    if (marker === null) throw new SetupRefusal("nessuna disinstallazione in corso")
    for (const tree of [LAYOUT.current, LAYOUT.staging, LAYOUT.previous]) if (fs.existsSync(path.win32.join(installDir, tree))) throw new SetupRefusal(`la cartella ${tree} non è ancora stata rimossa`)
    if (!verifyHelperCopy(installDir)) throw new SetupRefusal("la copia di recupero del programma di supporto non è completa: il registro di installazione resta")
    const record = path.win32.join(installDir, RECORD_NAME)
    if (fs.existsSync(record)) recordedInstallDir(installDir, env)
    if (marker.phase === "files") writeMarker(installDir, "metadata", marker.generation)
    checkpoint?.("before-record-delete")
    fs.rmSync(record, { force: true })
    if (fs.existsSync(record)) throw new SetupRefusal("il registro di installazione non risulta rimosso")
    checkpoint?.("after-record-delete")
}

/**
 * HKCU is clean (NSIS): the final marker is written FIRST, so that from here
 * on the uninstaller can finish on its own; then the marker goes. Nothing
 * is deleted here: the helper copy is removed by NSIS afterwards, from the
 * list compiled into it (helper-files.nsh).
 */
export function uninstallFinish(installDirInput: string, env: NodeJS.ProcessEnv, checkpoint?: (step: UninstallCheckpoint) => void): void {
    const installDir = installRoot(installDirInput, env)
    const marker = readMarker(installDir)
    if (marker?.phase !== "metadata") throw new SetupRefusal("la disinstallazione non è nella fase finale")
    if (fs.existsSync(path.win32.join(installDir, RECORD_NAME))) throw new SetupRefusal("il registro di installazione è ancora presente")
    const copy = copyRoot(installDir)
    const files = fs.existsSync(path.win32.join(copy, INVENTORY)) ? [...readInventory(copy).files.map((f) => f.path), INVENTORY] : []
    const file = path.win32.join(state(installDir), FINAL_MARKER)
    const temp = `${file}.${process.pid}.tmp`
    fs.rmSync(temp, { force: true })
    fs.writeFileSync(temp, encodeFinalMarker(installDir, marker.generation, files), { flag: "wx" })
    fs.renameSync(temp, file)
    if (readFinalMarker(installDir)?.generation !== marker.generation) throw new SetupRefusal("il marcatore finale non risulta scritto")
    checkpoint?.("before-marker-delete")
    fs.rmSync(path.win32.join(state(installDir), UNINSTALL_MARKER), { force: true })
    if (fs.existsSync(path.win32.join(state(installDir), UNINSTALL_MARKER))) throw new SetupRefusal("lo stato della disinstallazione non risulta rimosso")
}

/**
 * Recovery from a NEW setup when the last steps of an uninstallation are
 * left and its uninstaller is gone. Runs with the new setup's own helper and
 * uses only the final marker: no installation (record, journal, trees) and
 * no uninstall.exe may be present; a leftover marker must carry the final
 * marker's generation; in state\uninstall-helper only the files the final
 * marker lists are deleted, and a file it does not list stops everything.
 * The final marker goes last, so any failure can be repeated.
 */
export function finishUninstall(installDirInput: string, env: NodeJS.ProcessEnv, unlink: (file: string) => void = fs.unlinkSync, rmdir: (dir: string) => void = fs.rmdirSync): void {
    const installDir = installRoot(installDirInput, env)
    if (fs.existsSync(path.win32.join(installDir, RECORD_NAME)) || fs.existsSync(path.win32.join(state(installDir), JOURNAL))) throw new SetupRefusal("nella cartella c'è un'installazione: la disinstallazione precedente non viene completata, nulla viene rimosso")
    for (const tree of [LAYOUT.current, LAYOUT.staging, LAYOUT.previous]) if (fs.existsSync(path.win32.join(installDir, tree))) throw new SetupRefusal(`la cartella ${tree} esiste: nulla viene rimosso`)
    if (fs.existsSync(path.win32.join(installDir, "uninstall.exe"))) throw new SetupRefusal("il disinstallatore esiste ancora: eseguilo per completare la disinstallazione")
    const final = readFinalMarker(installDir)
    if (final === null) throw new SetupRefusal("nessuna disinstallazione da completare")
    const leftover = path.win32.join(state(installDir), UNINSTALL_MARKER)
    if (fs.existsSync(leftover)) {
        const marker = readMarker(installDir)
        if (marker === null || marker.generation !== final.generation || marker.phase !== "metadata") throw new SetupRefusal("lo stato della disinstallazione non appartiene a quella del marcatore finale: nulla viene rimosso")
    }
    const copy = copyRoot(installDir)
    if (fs.existsSync(copy)) {
        let present: string[]
        try {
            present = listFiles(copy)
        } catch (error) {
            throw new SetupRefusal(`state\\${HELPER_COPY} non è verificabile (${(error as Error).message}): nulla viene rimosso`)
        }
        const foreign = present.filter((f) => !final.files.includes(f))
        if (foreign.length > 0) throw new SetupRefusal(`in state\\${HELPER_COPY} ci sono file che non appartengono alla disinstallazione: ${foreign.slice(0, 5).join(", ")}. Spostali altrove e riprova: nulla è stato rimosso`)
        for (const f of present) {
            try {
                unlink(safeJoin(copy, f))
            } catch (error) {
                throw new SetupRefusal(`impossibile rimuovere state\\${HELPER_COPY}\\${f} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): riprova più tardi`)
            }
        }
        const dirs = (fs.readdirSync(copy, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((e) => e.isDirectory()).map((e) => path.join(e.parentPath, e.name)).sort((a, b) => b.length - a.length)
        for (const dir of [...dirs, copy]) {
            try {
                rmdir(dir)
            } catch (error) {
                throw new SetupRefusal(`impossibile rimuovere la cartella ${dir} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): riprova più tardi`)
            }
        }
    }
    fs.rmSync(leftover, { force: true })
    fs.rmSync(path.win32.join(state(installDir), FINAL_MARKER), { force: true })
    if (fs.existsSync(leftover) || fs.existsSync(path.win32.join(state(installDir), FINAL_MARKER))) throw new SetupRefusal("lo stato della disinstallazione precedente non risulta rimosso")
}
