/**
 * FR-MCP-04-BETA-02: verification and removal of an installed tree.
 *
 * An installation keeps each version in one directory (`current`, or
 * `.staging`/`previous` during an install) holding:
 *   app\                 the approved portable package, unchanged (manifest.json)
 *   setup\               this helper
 *   installer-files.json every other file of the tree, with size and SHA-256
 * The inventory is what the installer owns: verification requires the tree to
 * be exactly that, removal deletes only the files it lists.
 */

import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { compareOrdinal, listFiles, safeJoin, sha256FileSync, type ExecFn } from "../lib/common.js"
import { ENTRYPOINT, MANIFEST, RUNTIME_EXE, verifyManifest, type Manifest } from "../lib/package-content.js"
import { runtimeIdentity, type SelfTestFn } from "../lib/selftest.js"
import { SetupRefusal } from "./protocol.js"

export const INVENTORY = "installer-files.json"

export interface Inventory {
    readonly schemaVersion: 1
    readonly version: string
    readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[]
}

/** The inventory of `root`: every file except the inventory itself, sorted. */
export function buildInventory(root: string, version: string): Inventory {
    const files = listFiles(root).filter((f) => f !== INVENTORY).map((f) => {
        const full = safeJoin(root, f)
        return { path: f, size: fs.statSync(full).size, sha256: sha256FileSync(full) }
    })
    return { schemaVersion: 1, version, files }
}

export function readInventory(root: string): Inventory {
    let raw: unknown
    try {
        raw = JSON.parse(fs.readFileSync(path.join(root, INVENTORY), "utf8"))
    } catch {
        throw new SetupRefusal(`inventario dei file installati mancante o danneggiato in ${root}`)
    }
    const inv = raw as Partial<Inventory> | null
    if (inv?.schemaVersion !== 1 || typeof inv.version !== "string" || !Array.isArray(inv.files) || inv.files.length === 0) throw new SetupRefusal(`inventario dei file installati non riconosciuto in ${root}`)
    for (const f of inv.files) {
        try {
            safeJoin(root, f.path)
        } catch {
            throw new SetupRefusal(`inventario dei file installati non valido in ${root} (percorso non ammesso): nulla viene rimosso`)
        }
    }
    return inv as Inventory
}

export interface VerifyDeps {
    readonly exec: ExecFn
    readonly env: NodeJS.ProcessEnv
    /** The MCP self-test on the synthetic fixture; null skips it (a quick check after the swap). */
    readonly selfTest: SelfTestFn | null
}

/**
 * Verifies an installed tree: exactly the inventory (sizes and SHA-256), the
 * package manifest, the bundled runtime's version and platform and,
 * optionally, the MCP handshake with the seven tools on a SYNTHETIC profile.
 * The user's profile is never used. Returns the report lines.
 */
export async function verifyTree(root: string, deps: VerifyDeps): Promise<string[]> {
    const inventory = readInventory(root)
    const listed = inventory.files.map((f) => f.path)
    let actual: string[]
    try {
        actual = listFiles(root).filter((f) => f !== INVENTORY)
    } catch (error) {
        throw new SetupRefusal(`file installati non verificabili: ${(error as Error).message}`)
    }
    if (!isDeepStrictEqual(actual, [...listed].sort(compareOrdinal))) throw new SetupRefusal("i file installati non corrispondono all'inventario (file mancanti o in più)")
    for (const f of inventory.files) {
        const full = safeJoin(root, f.path)
        if (fs.statSync(full).size !== f.size || sha256FileSync(full) !== f.sha256) throw new SetupRefusal(`file installato alterato: ${f.path}`)
    }
    const app = path.join(root, "app")
    const manifest = JSON.parse(fs.readFileSync(path.join(app, MANIFEST), "utf8")) as Manifest
    const problems = verifyManifest(app, manifest)
    if (problems.length > 0) throw new SetupRefusal(`il pacchetto installato non corrisponde al suo manifest: ${problems.slice(0, 3).join("; ")}`)
    const lines = [`Files: ${inventory.files.length} verificati (inventario e manifest)`]
    const node = safeJoin(app, RUNTIME_EXE)
    const identity = runtimeIdentity(node, (file, args) => deps.exec(file, args, { cwd: root, env: deps.env, timeoutMs: 30_000 }))
    if (identity.version !== `v${manifest.runtime.version}` || identity.platform !== "win32 x64") throw new SetupRefusal(`runtime incluso inatteso: ${identity.version} ${identity.platform}`)
    lines.push(`Runtime: Node.js ${identity.version} ${identity.platform}`)
    if (deps.selfTest !== null) {
        for (const line of await deps.selfTest({ nodeExe: node, entrypoint: safeJoin(app, ENTRYPOINT), env: deps.env })) lines.push(line)
    }
    return lines
}

/** Files the uninstaller needs to run the helper again: removed last, after everything else. */
export const HELPER_FILES = ["app/runtime/node.exe", "setup/installer/setup/fr-setup.js"] as const

/**
 * Non-destructive check that a tree can be removed completely: inventory
 * readable and safe, no link or junction anywhere inside (listFiles refuses
 * them), and no file that the inventory does not list. Returns the files to
 * delete in removal order: everything else first, then the helper ("setup/"
 * and the runtime), the inventory last, so that a failure part-way leaves a
 * helper and an inventory for the next attempt.
 */
export function removalPlan(root: string): string[] {
    let actual: string[]
    try {
        actual = listFiles(root)
    } catch (error) {
        throw new SetupRefusal(`la cartella ${path.basename(root)} non è verificabile: ${(error as Error).message}`)
    }
    // An earlier attempt removed every file, the inventory last: only empty directories are left.
    if (actual.length === 0) return []
    const inventory = readInventory(root)
    const listed = new Set([...inventory.files.map((f) => f.path), INVENTORY])
    const foreign = actual.filter((f) => !listed.has(f))
    if (foreign.length > 0) throw new SetupRefusal(`in ${path.basename(root)} ci sono file che non appartengono all'installazione: ${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ` e altri ${foreign.length - 5}` : ""}. Spostali altrove e ripeti: nulla è stato rimosso`)
    const present = actual.filter((f) => f !== INVENTORY)
    const helper = (f: string): boolean => f.startsWith("setup/") || (HELPER_FILES as readonly string[]).includes(f)
    return [...present.filter((f) => !helper(f)), ...present.filter(helper), ...(actual.includes(INVENTORY) ? [INVENTORY] : [])]
}

/**
 * Removes a tree of this installer: refuses (deleting nothing) if
 * removalPlan finds anything that is not inventoried; otherwise deletes the
 * files in plan order and stops at the first failure, then removes the
 * directories left empty.
 */
export function removeTree(root: string, unlink: (file: string) => void = fs.unlinkSync): { removed: number } {
    const order = removalPlan(root)
    let removed = 0
    for (const f of order) {
        try {
            unlink(safeJoin(root, f))
        } catch (error) {
            const helperKept = HELPER_FILES.every((h) => fs.existsSync(safeJoin(root, h))) && fs.existsSync(path.join(root, INVENTORY))
            throw new SetupRefusal(`impossibile rimuovere ${path.basename(root)}/${f} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); ${removed} file rimossi.${helperKept ? " Il programma di supporto e l'inventario sono intatti: l'operazione può essere ripetuta." : ""}`)
        }
        removed++
    }
    // Directories left (also empty ones from an earlier, interrupted attempt): removalPlan found no
    // foreign file and no link in the tree, and rmdir only removes empty directories.
    const dirs = (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((e) => e.isDirectory()).map((e) => path.join(e.parentPath, e.name))
    for (const dir of dirs.sort((a, b) => b.length - a.length)) tryRmdir(dir)
    tryRmdir(root)
    if (fs.existsSync(root)) throw new SetupRefusal(`la cartella ${path.basename(root)} non risulta rimossa`)
    return { removed }
}

function tryRmdir(dir: string): void {
    try {
        fs.rmdirSync(dir)
    } catch {
        // already gone, or not empty (checked by the caller for the root)
    }
}
