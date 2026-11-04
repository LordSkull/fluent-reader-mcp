/**
 * FR-MCP-04-BETA-UX-01: registration of the server in Claude Desktop.
 *
 * WHICH FILE. No documented way tells which claude_desktop_config.json a Claude
 * Desktop reads: the documented place is %APPDATA%\Claude, a packaged (MSIX,
 * Store, WinGet) app may read a private copy under %LOCALAPPDATA%\Packages and
 * its "Edit Config" may open the other one (anthropics/claude-code#26073), and
 * other places were observed. So nothing here decides which file is active:
 * places are only listed (names and dates, no content read), and the file to
 * change is the one the USER selects, shown with the exact entry before consent.
 * A selection proves nothing about what the client reads: only the client can,
 * and no message of the setup says otherwise. A file is proposed only when it is
 * the only candidate and no packaged app makes another location possible.
 *
 * WHAT CHANGES. Only mcpServers.fluent-reader. The change is made on the file's
 * TEXT: the member is inserted, replaced or removed in place, so every other
 * byte stays (formatting, key order, unknown fields, numbers JSON.parse would
 * round, repeated keys elsewhere). Before the swap the result is parsed and
 * compared with the original. A file that is not valid UTF-8 JSON, has another
 * structure, or repeats the two keys concerned is refused and left as it is.
 *
 * HOW. Backup in the user's private directory (backups.ts); the intent in the
 * record, with the fingerprint of the entry about to be written; a temporary file
 * next to the target, flushed and compared; the target checked unchanged right
 * before the rename (not atomic with it: a change in that instant is not seen).
 * A failure is undone only as far as is provably safe: the old bytes only if the
 * file is still exactly what this run wrote; otherwise only the entry, only if it
 * is still ours. Nothing read from the configuration is printed or recorded,
 * except, for a foreign entry, its command and how many arguments and variables
 * it has.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { ExecFn } from "../lib/common.js"
import { isInside, overlaps, samePath } from "../lib/common.js"
import { createDesktopBackup, describeBackup, privateDesktopBackupDir, recordedDesktopBackup } from "./backups.js"
import { assertLocalPath, canonicalLocal, envDir, LAYOUT } from "./checks.js"
import { legacyCodeNote, normalize, SERVER_NAME } from "./claude.js"
import { SetupRefusal } from "./protocol.js"
import { canonicalJson, entryFingerprint, readRecord, writeRecord, type DesktopEntry, type DesktopRegistration, type DesktopTarget, type InstallRecord } from "./record.js"

export const DESKTOP_CONFIG = "claude_desktop_config.json"
const MAX_CONFIG_BYTES = 16 * 1024 * 1024
/** Directories listed in one place: enough for any real profile, a limit for a pathological one. */
const MAX_LISTED = 500
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const MSIX_PACKAGE = /^(?:[\w-]+\.)*claude_[a-z0-9]+$/i

export type DesktopCheckpoint = "before-replace" | "after-replace" | "before-rollback" | "before-unregister"

export interface DesktopDeps {
    readonly env: NodeJS.ProcessEnv
    readonly exec: ExecFn
    /** Working directory of reg.exe. */
    readonly cwd: string
    readonly now: () => Date
    /** Test hooks: concurrent changes and injected failures at the named steps; the rename that replaces the file. */
    readonly checkpoint?: ((step: DesktopCheckpoint) => void) | undefined
    readonly replace?: ((from: string, to: string) => void) | undefined
}

function sha256(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex")
}

// ------------------------------------------------------------------ which file

export interface DesktopCandidate {
    readonly path: string
    readonly where: "roaming" | "local" | "package"
    readonly modified: Date
}

export interface Discovery {
    readonly candidates: readonly DesktopCandidate[]
    /** A packaged Claude is installed for this user: "Edit Config" may open another file than the one the app reads. */
    readonly packaged: boolean
}

function subdirectories(dir: string): string[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).slice(0, MAX_LISTED)
    } catch {
        return []
    }
}

/**
 * Lists, read-only and without opening them, the files named claude_desktop_config.json in the per-user folders of
 * Claude: under %APPDATA% and %LOCALAPPDATA%, and in a packaged app's private copies of both, in any directory whose
 * name starts with "Claude" or one level below it. No identifier is assumed; links and junctions are not followed.
 */
export function discoverDesktopConfigs(env: NodeJS.ProcessEnv): Discovery {
    const found = new Map<string, DesktopCandidate>()
    const look = (file: string, where: DesktopCandidate["where"]): void => {
        const stats = fs.lstatSync(file, { throwIfNoEntry: false })
        if (stats?.isFile() === true) found.set(file.toLowerCase(), { path: file, where, modified: stats.mtime })
    }
    const scan = (base: string, where: DesktopCandidate["where"]): void => {
        for (const name of subdirectories(base).filter((n) => /^claude/i.test(n))) {
            const dir = path.win32.join(base, name)
            look(path.win32.join(dir, DESKTOP_CONFIG), where)
            for (const sub of subdirectories(dir)) look(path.win32.join(dir, sub, DESKTOP_CONFIG), where)
        }
    }
    const roaming = envDir(env, "APPDATA")
    if (roaming !== null) scan(roaming, "roaming")
    let packaged = false
    const local = envDir(env, "LOCALAPPDATA")
    if (local !== null) {
        scan(local, "local")
        for (const name of subdirectories(path.win32.join(local, "Packages")).filter((n) => MSIX_PACKAGE.test(n))) {
            packaged = true
            for (const part of ["Roaming", "Local"]) scan(path.win32.join(local, "Packages", name, "LocalCache", part), "package")
        }
    }
    return { candidates: [...found.values()], packaged }
}

export type CandidateStatus = "recorded" | "single" | "ambiguous" | "none"

/**
 * What the wizard's page starts from. A path is proposed only when there is no doubt to hide: the file of this
 * installation's registration, or the only candidate if no packaged app makes another location possible. Otherwise
 * the user selects. A proposal is not a verification: the user still sees it before any consent.
 */
export function proposeDesktopConfig(discovery: Discovery, record: InstallRecord | null): { status: CandidateStatus; selected: string } {
    const reg = record?.desktop ?? null
    if (reg !== null && reg.state !== "removed" && fs.lstatSync(reg.configPath, { throwIfNoEntry: false })?.isFile() === true) return { status: "recorded", selected: reg.configPath }
    if (discovery.candidates.length === 0) return { status: "none", selected: "" }
    const [only] = discovery.candidates
    if (discovery.candidates.length === 1 && only !== undefined && (!discovery.packaged || only.where === "package")) return { status: "single", selected: only.path }
    return { status: "ambiguous", selected: "" }
}

export function candidateLines(discovery: Discovery): string[] {
    const place = { roaming: "cartella Roaming", local: "cartella Local", package: "copia privata del pacchetto Claude" } as const
    const lines = discovery.candidates.map((c) => `${c.path} (${place[c.where]}, modificato il ${c.modified.toISOString().slice(0, 16).replace("T", " ")} UTC)`)
    if (lines.length === 0) lines.push("Nessun file di configurazione di Claude Desktop trovato nelle cartelle dell'utente.")
    if (discovery.packaged) lines.push("Claude Desktop risulta installato come pacchetto: «Modifica configurazione» può aprire un file diverso da quello che l'app legge davvero.")
    return lines
}

/**
 * The machine's or the user's policy on local MCP servers (isLocalDevMcpEnabled under SOFTWARE\Policies\Claude;
 * https://support.claude.com/en/articles/12622667): read only, the machine's value first. Anything not readable as
 * an explicit 0 does not stop anything.
 */
export function desktopPolicyBlocks(deps: Pick<DesktopDeps, "env" | "exec" | "cwd">): boolean {
    const system = envDir(deps.env, "SystemRoot")
    if (system === null) return false
    for (const hive of ["HKLM", "HKCU"]) {
        const result = deps.exec(path.win32.join(system, "System32", "reg.exe"), ["query", `${hive}\\SOFTWARE\\Policies\\Claude`, "/v", "isLocalDevMcpEnabled"], { cwd: deps.cwd, env: deps.env, timeoutMs: 15_000 })
        const value = result.status === 0 ? /isLocalDevMcpEnabled\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(result.stdout)?.[1] : undefined
        if (value !== undefined) return Number(value) === 0
    }
    return false
}

export const POLICY_REFUSAL = "una policy di questo computer disattiva i server MCP locali in Claude Desktop (isLocalDevMcpEnabled): la configurazione non viene modificata. Puoi installare solo il server"

/**
 * The file the user selected, as a canonical path: a local regular file named claude_desktop_config.json, reached
 * without links or junctions, inside this user's folders, not overlapping the installation. Whether Claude Desktop
 * reads it is not something this can tell.
 */
export function checkDesktopTarget(file: string, env: NodeJS.ProcessEnv, installDir: string | null): string {
    const what = "Configurazione di Claude Desktop"
    const resolved = assertLocalPath(file, what)
    if (path.win32.basename(resolved).toLowerCase() !== DESKTOP_CONFIG) throw new SetupRefusal(`${what}: il file deve chiamarsi ${DESKTOP_CONFIG}`)
    const canonical = canonicalLocal(resolved, what)
    const stats = fs.lstatSync(canonical, { throwIfNoEntry: false })
    if (stats === undefined) throw new SetupRefusal(`${what}: il file ${canonical} non esiste. Aprilo una volta da Claude Desktop (Impostazioni, Modifica configurazione) e riprova, oppure installa solo il server: il setup non lo crea in un percorso ipotizzato`)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new SetupRefusal(`${what}: ${canonical} non è un file normale`)
    const mine = ["USERPROFILE", "APPDATA", "LOCALAPPDATA"].map((name) => envDir(env, name)).filter((d): d is string => d !== null)
    if (!mine.some((dir) => isInside(canonical, dir))) throw new SetupRefusal(`${what}: ${canonical} non è nelle cartelle del tuo utente Windows: non viene modificato`)
    if (installDir !== null && overlaps(canonical, installDir)) throw new SetupRefusal(`${what}: ${canonical} è dentro la cartella di installazione`)
    return canonical
}

// ------------------------------------------------------------------ the file's text

interface Member {
    readonly key: string
    readonly start: number
    readonly valueStart: number
    readonly end: number
}

interface ObjectSpan {
    readonly open: number
    readonly close: number
    readonly members: readonly Member[]
}

function skipSpace(text: string, at: number): number {
    let i = at
    while (" \t\r\n".includes(text.charAt(i)) && i < text.length) i++
    return i
}

function endOfString(text: string, at: number): number {
    let i = at + 1
    while (text.charAt(i) !== '"') i += text.charAt(i) === "\\" ? 2 : 1
    return i + 1
}

function endOfValue(text: string, at: number): number {
    const first = text.charAt(at)
    if (first === '"') return endOfString(text, at)
    let i = at
    if (first === "{" || first === "[") {
        let depth = 0
        for (;;) {
            const c = text.charAt(i)
            if (c === '"') {
                i = endOfString(text, i)
                continue
            }
            if (c === "{" || c === "[") depth++
            if (c === "}" || c === "]") {
                depth--
                if (depth === 0) return i + 1
            }
            i++
        }
    }
    while (i < text.length && !",}] \t\r\n".includes(text.charAt(i))) i++
    return i
}

/** The members of the object starting at `open`, in a text JSON.parse has already accepted. */
function objectAt(text: string, open: number): ObjectSpan {
    const members: Member[] = []
    let i = skipSpace(text, open + 1)
    while (text.charAt(i) !== "}") {
        const keyEnd = endOfString(text, i)
        const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1)
        const end = endOfValue(text, valueStart)
        members.push({ key: JSON.parse(text.slice(i, keyEnd)) as string, start: i, valueStart, end })
        i = skipSpace(text, end)
        if (text.charAt(i) === ",") i = skipSpace(text, i + 1)
    }
    return { open, close: i, members }
}

function eolOf(text: string): string {
    return text.includes("\r\n") ? "\r\n" : "\n"
}

/** The white space that starts the line holding `at`. */
function indentAt(text: string, at: number): string {
    const line = text.slice(text.lastIndexOf("\n", at - 1) + 1, at)
    return /^[ \t]*/.exec(line)?.[0] ?? ""
}

function rendered(value: unknown, indent: string, eol: string): string {
    return JSON.stringify(value, null, 2).split("\n").join(`${eol}${indent}`)
}

function insertMember(text: string, object: ObjectSpan, key: string, value: unknown): string {
    const eol = eolOf(text)
    const first = object.members[0]
    const last = object.members[object.members.length - 1]
    if (first === undefined || last === undefined) {
        const outer = indentAt(text, object.open)
        const indent = `${outer}  `
        return `${text.slice(0, object.open + 1)}${eol}${indent}${JSON.stringify(key)}: ${rendered(value, indent, eol)}${eol}${outer}${text.slice(object.close)}`
    }
    const multiline = text.slice(object.open, first.start).includes("\n")
    const indent = indentAt(text, first.start)
    const member = multiline ? `,${eol}${indent}${JSON.stringify(key)}: ${rendered(value, indent, eol)}` : `, ${JSON.stringify(key)}: ${JSON.stringify(value)}`
    return `${text.slice(0, last.end)}${member}${text.slice(last.end)}`
}

function removeMember(text: string, object: ObjectSpan, member: Member): string {
    const at = object.members.indexOf(member)
    const next = object.members[at + 1]
    const previous = object.members[at - 1]
    if (previous !== undefined) return `${text.slice(0, previous.end)}${text.slice(member.end)}`
    if (next !== undefined) return `${text.slice(0, member.start)}${text.slice(next.start)}`
    return `${text.slice(0, object.open + 1)}${text.slice(object.close)}`
}

/** A configuration as read: its exact bytes, the two levels this module may touch, located in its text. */
interface ConfigDoc {
    readonly file: string
    readonly bytes: Buffer
    readonly hash: string
    readonly bom: boolean
    readonly text: string
    readonly root: Readonly<Record<string, unknown>>
    readonly servers: Readonly<Record<string, unknown>>
}

export function readDoc(file: string): ConfigDoc {
    const invalid = `il file ${file} non è un JSON valido: non viene modificato né ricreato. Riparalo o ripristina una copia, poi esegui di nuovo il setup; nel frattempo puoi installare solo il server`
    let bytes: Buffer
    try {
        if (fs.statSync(file).size > MAX_CONFIG_BYTES) throw new SetupRefusal(`il file ${file} è troppo grande per essere una configurazione di Claude Desktop: non viene modificato`)
        bytes = fs.readFileSync(file)
    } catch (error) {
        if (error instanceof SetupRefusal) throw error
        throw new SetupRefusal(`il file ${file} non è leggibile (${(error as NodeJS.ErrnoException).code ?? "errore"}): non viene modificato. Puoi installare solo il server`)
    }
    const bom = bytes.subarray(0, 3).equals(UTF8_BOM)
    let text: string
    let raw: unknown
    try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes)
        raw = JSON.parse(text)
    } catch {
        // the parser's message may quote the file: it is not used
        throw new SetupRefusal(invalid)
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SetupRefusal(`il file ${file} non ha la struttura attesa (un oggetto JSON): non viene modificato. Puoi installare solo il server`)
    const root = raw as Record<string, unknown>
    const servers = Object.hasOwn(root, "mcpServers") ? root.mcpServers : {}
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new SetupRefusal(`nel file ${file} la sezione mcpServers non ha la struttura attesa: il file non viene modificato. Puoi installare solo il server`)
    const doc = { file, bytes, hash: sha256(bytes), bom, text, root, servers: servers as Record<string, unknown> }
    locate(doc)
    return doc
}

/** Where the two levels are in the text. The same key twice means the file's meaning depends on who reads it: refused. */
function locate(doc: Pick<ConfigDoc, "file" | "text">): { root: ObjectSpan; section: Member | undefined; servers: ObjectSpan | null; entry: Member | undefined } {
    const ambiguous = (key: string): SetupRefusal => new SetupRefusal(`nel file ${doc.file} la chiave "${key}" è ripetuta: non è chiaro quale valga, il file non viene modificato. Puoi installare solo il server`)
    const root = objectAt(doc.text, skipSpace(doc.text, 0))
    const sections = root.members.filter((m) => m.key === "mcpServers")
    if (sections.length > 1) throw ambiguous("mcpServers")
    const section = sections[0]
    if (section === undefined) return { root, section, servers: null, entry: undefined }
    const servers = objectAt(doc.text, section.valueStart)
    const entries = servers.members.filter((m) => m.key === SERVER_NAME)
    if (entries.length > 1) throw ambiguous(SERVER_NAME)
    return { root, section, servers, entry: entries[0] }
}

function textWithEntry(doc: Pick<ConfigDoc, "file" | "text">, entry: unknown, literal?: string): string {
    const { root, servers, entry: current } = locate(doc)
    const { text } = doc
    if (current !== undefined) return `${text.slice(0, current.valueStart)}${literal ?? rendered(entry, indentAt(text, current.start), eolOf(text))}${text.slice(current.end)}`
    if (servers !== null) return insertMember(text, servers, SERVER_NAME, entry)
    return insertMember(text, root, "mcpServers", { [SERVER_NAME]: entry })
}

function textWithoutEntry(doc: Pick<ConfigDoc, "file" | "text">): string {
    const { servers, entry } = locate(doc)
    return servers === null || entry === undefined ? doc.text : removeMember(doc.text, servers, entry)
}

/** The document without our entry, in a form where an absent or empty mcpServers are the same. */
function everythingElse(root: Readonly<Record<string, unknown>>): string {
    const servers = { ...((root.mcpServers ?? {}) as Record<string, unknown>) }
    delete servers[SERVER_NAME]
    return canonicalJson({ ...root, mcpServers: servers })
}

/** A new text is used only if, parsed, it differs from the old one in our entry alone. */
function encodeVerified(doc: ConfigDoc, text: string, entry: unknown): Buffer {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>
    const entryOk = entry === undefined ? !Object.hasOwn(servers, SERVER_NAME) : Object.hasOwn(servers, SERVER_NAME) && canonicalJson(servers[SERVER_NAME]) === canonicalJson(entry)
    if (!entryOk || everythingElse(parsed) !== everythingElse(doc.root)) throw new SetupRefusal("la modifica preparata altererebbe altri contenuti della configurazione: annullata")
    return Buffer.concat(doc.bom ? [UTF8_BOM, Buffer.from(text, "utf8")] : [Buffer.from(text, "utf8")])
}

/** Replaces the file with `bytes` through a verified temporary file next to it, only if it still holds what was read. */
function replaceChecked(file: string, bytes: Buffer, expected: string, deps: DesktopDeps): void {
    const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`
    const fd = fs.openSync(temp, "wx")
    try {
        try {
            fs.writeSync(fd, bytes)
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        if (!fs.readFileSync(temp).equals(bytes)) throw new SetupRefusal("il file temporaneo non corrisponde al contenuto preparato")
        deps.checkpoint?.("before-replace")
        if (sha256(fs.readFileSync(file)) !== expected) throw new SetupRefusal(`${file} è stato modificato da un altro programma durante l'operazione`)
        ;(deps.replace ?? fs.renameSync)(temp, file)
    } catch (error) {
        fs.rmSync(temp, { force: true })
        throw error
    }
}

// ------------------------------------------------------------------ plan

/** The entry this installation needs: the bundled node.exe, the bundled entrypoint, the chosen profile. */
export function desiredDesktopEntry(installDir: string, profileDir: string): DesktopEntry {
    const app = path.win32.join(installDir, LAYOUT.current, "app")
    return { command: path.win32.join(app, "runtime", "node.exe"), args: [path.win32.join(app, "server", "dist", "main.js"), "--profile-dir", profileDir] }
}

/** An entry found in `configPath` is this installation's when it has a fingerprint recorded for that very file. */
function isOwnDesktopEntry(raw: unknown, configPath: string, reg: DesktopRegistration | null): boolean {
    if (raw === undefined || reg === null || reg.state === "removed") return false
    const fingerprint = entryFingerprint(raw)
    return (samePath(reg.configPath, configPath) && fingerprint === reg.fingerprint) || (reg.formerTargets ?? []).some((t) => samePath(t.configPath, configPath) && t.fingerprint === fingerprint)
}

export type DesktopAction = "add" | "none" | "replace-own" | "replace-foreign"

export interface DesktopPlan {
    readonly configPath: string
    readonly action: DesktopAction
    readonly desired: DesktopEntry
    readonly doc: ConfigDoc
    /** Binds a registration to the page the user approved: the file, the action, the entry found and the entry to write. */
    readonly hash: string
}

export function planDesktop(input: { readonly configPath: string; readonly installDir: string; readonly profileDir: string; readonly record: InstallRecord | null }): DesktopPlan {
    const doc = readDoc(input.configPath)
    const desired = desiredDesktopEntry(input.installDir, input.profileDir)
    const present = Object.hasOwn(doc.servers, SERVER_NAME)
    const raw = present ? doc.servers[SERVER_NAME] : undefined
    const reg = input.record?.desktop ?? null
    const ours = isOwnDesktopEntry(raw, input.configPath, reg)
    const same = present && entryFingerprint(raw) === entryFingerprint(desired)
    const action: DesktopAction = !present ? "add" : same ? "none" : ours ? "replace-own" : "replace-foreign"
    const hash = sha256(Buffer.from(JSON.stringify({ configPath: input.configPath.toLowerCase(), action, raw: present ? entryFingerprint(raw) : null, desired })))
    return { configPath: input.configPath, action, desired, doc, hash }
}

/** The page shown before consent: which file, which entry, what happens. Only this installation's paths, never configuration content. */
export function desktopPreview(p: DesktopPlan, installDir: string, record: InstallRecord | null, env: NodeJS.ProcessEnv): string[] {
    const backupDir = p.action === "none" ? null : privateDesktopBackupDir(env, installDir)
    const lines = [
        `File selezionato: ${p.configPath}`,
        `Voce: mcpServers.${SERVER_NAME} (nessun'altra parte del file viene modificata)`,
        `Eseguibile: ${p.desired.command}`,
        `Entrypoint: ${p.desired.args[0] as string}`,
        `Profilo Fluent Reader: ${p.desired.args[2] as string}`,
    ]
    const reg = record?.desktop ?? null
    if (p.action === "add") lines.push(`Modifica: viene aggiunta soltanto la voce "${SERVER_NAME}".`)
    if (p.action === "none") lines.push(`Modifica: nessuna, la voce "${SERVER_NAME}" è già esattamente così.`)
    if (p.action === "none" && !isOwnDesktopEntry(p.doc.servers[SERVER_NAME], p.configPath, reg)) lines.push("Questa voce non è stata scritta da questo installer: non viene considerata sua e la disinstallazione non la rimuoverà.")
    if (p.action === "replace-own") lines.push(`Modifica: la voce "${SERVER_NAME}" scritta da una precedente installazione viene aggiornata.`)
    if (p.action === "replace-foreign") {
        const existing = normalize(p.doc.servers[SERVER_NAME])
        const detail = existing === null ? "non è un server stdio" : `comando ${existing.command}, ${existing.args.length} argomenti, ${Object.keys(existing.env).length} variabili`
        lines.push(`ATTENZIONE: esiste già una voce "${SERVER_NAME}" che non risulta scritta da questo installer, o è stata modificata dopo (${detail}).`)
        lines.push("Viene sostituita soltanto se lo confermi esplicitamente qui sotto; altrimenti torna indietro e scegli di installare solo il server.")
    }
    if (backupDir !== null) lines.push(`Prima della modifica viene salvata una copia del file nella tua cartella personale, fuori dalla cartella di installazione: ${backupDir}`)
    if (reg !== null && reg.state !== "removed" && !samePath(reg.configPath, p.configPath) && p.action !== "none") lines.push(`La voce scritta in precedenza in ${reg.configPath} non viene toccata; la disinstallazione proverà a rimuoverla se sarà ancora quella.`)
    if (reg?.state === "pending" || reg?.state === "rollback-failed") {
        const note = describeBackup(recordedDesktopBackup(installDir, record, env))
        if (note !== null) lines.push(`Una registrazione precedente non si è conclusa. ${note}`)
    }
    lines.push("Hai selezionato tu questo file: il setup non può dimostrare che sia quello letto da Claude Desktop. Dopo l'installazione verifica nell'app che compaia fluent-reader.")
    const legacy = legacyCodeNote(record, false)
    if (legacy !== "") lines.push(legacy)
    lines.push("Chiudi Claude Desktop prima di continuare: la modifica viene letta al riavvio dell'app.")
    return lines
}

// ------------------------------------------------------------------ register

export interface DesktopRegisterInput {
    readonly configPath: string
    readonly installDir: string
    readonly profileDir: string
    readonly recordPath: string
    readonly expectPlan: string
    readonly allowReplaceForeign: boolean
}

function updateRegistration(recordPath: string, registration: DesktopRegistration | null): void {
    const record = readRecord(recordPath)
    if (record === null) throw new SetupRefusal("registro di installazione mancante")
    const { desktop: _dropped, ...rest } = record
    writeRecord(recordPath, registration === null ? rest : { ...rest, desktop: registration })
}

/** The file of the registration being replaced, kept while its entry may still be there; the file now selected is not among them. */
function formerTargets(reg: DesktopRegistration | null, configPath: string): DesktopTarget[] {
    if (reg === null || reg.state === "removed") return []
    const all = [...(reg.formerTargets ?? []), { configPath: reg.configPath, fingerprint: reg.fingerprint }]
    return all.filter((t) => !samePath(t.configPath, configPath))
}

/**
 * Registers the server after the user's consent, bound to the approved plan: backup, the intent in the record, the
 * checked replacement, the entry read back. A later failure is undone conservatively.
 */
export function registerDesktop(input: DesktopRegisterInput, deps: DesktopDeps): { action: DesktopAction; backup: string | null } {
    if (desktopPolicyBlocks(deps)) throw new SetupRefusal(POLICY_REFUSAL)
    const record = readRecord(input.recordPath)
    if (record === null) throw new SetupRefusal("registro di installazione mancante")
    const { configPath } = input
    const p = planDesktop({ configPath, installDir: input.installDir, profileDir: input.profileDir, record })
    if (p.hash !== input.expectPlan) throw new SetupRefusal("la configurazione di Claude Desktop è cambiata dopo la conferma: nessuna modifica eseguita; esegui di nuovo il setup per rivedere la modifica")
    if (p.action === "replace-foreign" && !input.allowReplaceForeign) throw new SetupRefusal(`la voce "${SERVER_NAME}" esistente non è di questo installer e la sostituzione non è stata confermata: nessuna modifica eseguita`)
    const original = record.desktop ?? null
    if (p.action === "none") {
        if (original !== null && original.state !== "registered" && isOwnDesktopEntry(p.doc.servers[SERVER_NAME], configPath, original)) updateRegistration(input.recordPath, { ...original, state: "registered", updatedAt: deps.now().toISOString() })
        return { action: "none", backup: null }
    }
    const { doc } = p
    const fingerprint = entryFingerprint(p.desired)
    const backup = createDesktopBackup(configPath, doc.hash, input.installDir, deps.env, deps.now())
    const former = formerTargets(original, configPath)
    const pending: DesktopRegistration = {
        state: "pending", name: SERVER_NAME, configPath, entry: p.desired, fingerprint, ...(former.length > 0 && { formerTargets: former }),
        backup: backup.name, backupDir: backup.dir, backupSha256: backup.sha256, updatedAt: deps.now().toISOString(),
    }
    const backupPath = path.win32.join(backup.dir, backup.name)
    updateRegistration(input.recordPath, pending)
    let written: Buffer | null = null
    try {
        const bytes = encodeVerified(doc, textWithEntry(doc, p.desired), p.desired)
        replaceChecked(configPath, bytes, doc.hash, deps)
        written = bytes
        deps.checkpoint?.("after-replace")
        const saved = readDoc(configPath).servers
        if (!Object.hasOwn(saved, SERVER_NAME) || entryFingerprint(saved[SERVER_NAME]) !== fingerprint) throw new SetupRefusal("la voce riletta dal file non corrisponde a quella scritta")
        updateRegistration(input.recordPath, { ...pending, state: "registered", updatedAt: deps.now().toISOString() })
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const cause = error instanceof SetupRefusal ? error.message : `errore di scrittura ${code ?? (error as Error).message}`
        const outcome = rollback(deps, doc, written, fingerprint)
        try {
            updateRegistration(input.recordPath, outcome.complete ? original : { ...pending, state: "rollback-failed", updatedAt: deps.now().toISOString() })
        } catch {
            // the message below still reports the state of the configuration
        }
        const where = ` La copia presa prima della modifica è in ${backupPath}.`
        if (outcome.complete) throw new SetupRefusal(`registrazione non completata (${cause}); la voce "${SERVER_NAME}" di Claude Desktop è stata riportata allo stato precedente.${where}`)
        throw new SetupRefusal(`registrazione non completata (${cause}) e il ripristino automatico NON è stato completato: ${outcome.reason}. Serve un tuo intervento: controlla la voce "${SERVER_NAME}" in ${configPath}.${where}`)
    }
    return { action: p.action, backup: backupPath }
}

/**
 * Undoes a registration only as far as it is provably safe:
 *  - nothing written by this run: nothing to undo;
 *  - the file is still exactly what this run wrote: its previous bytes go back;
 *  - others changed the file but the entry is still ours: only the entry changes back, their changes stay;
 *  - the entry is absent or changed by others: left as it is, reported as incomplete (unless it is already what it was).
 */
function rollback(deps: DesktopDeps, before: ConfigDoc, written: Buffer | null, fingerprint: string): { complete: boolean; reason: string } {
    const done = { complete: true, reason: "" }
    if (written === null) return done
    try {
        deps.checkpoint?.("before-rollback")
        const current = readDoc(before.file)
        if (current.hash === sha256(written)) {
            replaceChecked(before.file, before.bytes, current.hash, deps)
            return done
        }
        const present = Object.hasOwn(current.servers, SERVER_NAME)
        const had = Object.hasOwn(before.servers, SERVER_NAME)
        const previous = locate(before).entry
        const literal = previous === undefined ? undefined : before.text.slice(previous.valueStart, previous.end)
        const raw = current.servers[SERVER_NAME]
        if (!present && !had) return done
        if (present && had && entryFingerprint(raw) === entryFingerprint(before.servers[SERVER_NAME])) return done
        if (present && entryFingerprint(raw) !== fingerprint) return { complete: false, reason: `la voce "${SERVER_NAME}" attuale non è attribuibile con certezza a questa operazione (modificata o scritta da altri): non viene toccata` }
        // ours (or, with an entry to give back, a name left free by someone else): the entry alone, on the current text
        const previousValue = before.servers[SERVER_NAME]
        const bytes = encodeVerified(current, had ? textWithEntry(current, previousValue, literal) : textWithoutEntry(current), had ? previousValue : undefined)
        replaceChecked(before.file, bytes, current.hash, deps)
        return done
    } catch (error) {
        return { complete: false, reason: error instanceof Error ? error.message : String(error) }
    }
}

// ------------------------------------------------------------------ uninstall

/**
 * State of this installer's registration, without changing anything:
 *  not-configured  the installer never registered the server in Claude Desktop (or it was removed)
 *  config-missing  the file is gone: there is no entry left to remove
 *  absent          the file is there, without a "fluent-reader" entry
 *  ours            the entry is still exactly the one written
 *  modified        an entry exists and is not that one
 *  config-error    the file cannot be read or is no longer acceptable
 */
export type DesktopStatus = "not-configured" | "config-missing" | "absent" | "ours" | "modified" | "config-error"

function statusOf(configPath: string, fingerprint: string, env: NodeJS.ProcessEnv): { status: DesktopStatus; reason?: string; doc?: ConfigDoc } {
    try {
        if (fs.lstatSync(configPath, { throwIfNoEntry: false }) === undefined) return { status: "config-missing" }
        const doc = readDoc(checkDesktopTarget(configPath, env, null))
        if (!Object.hasOwn(doc.servers, SERVER_NAME)) return { status: "absent", doc }
        return { status: entryFingerprint(doc.servers[SERVER_NAME]) === fingerprint ? "ours" : "modified", doc }
    } catch (error) {
        return { status: "config-error", reason: (error as Error).message }
    }
}

export function desktopStatus(record: InstallRecord | null, env: NodeJS.ProcessEnv): DesktopStatus {
    const reg = record?.desktop ?? null
    if (reg === null || reg.state === "removed") return "not-configured"
    return statusOf(reg.configPath, reg.fingerprint, env).status
}

/** Only not-configured, config-missing, absent and removed let the uninstaller go on by itself. */
export type DesktopUnregisterOutcome = DesktopStatus | "removed" | "write-error"

/** Removes the entry from one file: the text of that member alone, on the file as it is now. */
function removeEntry(doc: ConfigDoc, deps: DesktopDeps): void {
    replaceChecked(doc.file, encodeVerified(doc, textWithoutEntry(doc), undefined), doc.hash, deps)
    if (Object.hasOwn(readDoc(doc.file).servers, SERVER_NAME)) throw new SetupRefusal(`la voce "${SERVER_NAME}" risulta ancora presente`)
}

export function unregisterDesktop(recordPath: string, deps: DesktopDeps): { outcome: DesktopUnregisterOutcome; message: string } {
    const record = readRecord(recordPath)
    const reg = record?.desktop ?? null
    if (record === null || reg === null || reg.state === "removed") return { outcome: "not-configured", message: "Nessuna registrazione di Claude Desktop creata da questo installer." }
    const manual = `Per rimuoverla a mano: togli soltanto la voce "${SERVER_NAME}" dalla sezione mcpServers di ${reg.configPath}.`
    const state = statusOf(reg.configPath, reg.fingerprint, deps.env)
    const mark = (): string => {
        // a file the registration was moved away from: its entry goes too if it is still that one, never anything else
        const left: string[] = []
        for (const target of reg.formerTargets ?? []) {
            const former = statusOf(target.configPath, target.fingerprint, deps.env)
            try {
                if (former.status === "ours" && former.doc !== undefined) removeEntry(former.doc, deps)
                else if (former.status !== "absent" && former.status !== "config-missing") left.push(target.configPath)
            } catch {
                left.push(target.configPath)
            }
        }
        writeRecord(recordPath, { ...record, desktop: { ...reg, state: "removed", updatedAt: deps.now().toISOString() } })
        return left.length === 0 ? "" : ` Una voce "${SERVER_NAME}" può essere rimasta anche in ${left.join(", ")}: controllala tu.`
    }
    switch (state.status) {
        case "not-configured":
            return { outcome: "not-configured", message: "" }
        case "config-missing":
            return { outcome: "config-missing", message: `Il file ${reg.configPath} non c'è più: nessuna voce da rimuovere.${mark()}` }
        case "absent":
            return { outcome: "absent", message: `La voce "${SERVER_NAME}" non è più presente in ${reg.configPath}.${mark()}` }
        case "config-error":
            return { outcome: "config-error", message: `${state.reason ?? "Configurazione di Claude Desktop non leggibile"}. La voce "${SERVER_NAME}" non è stata toccata. ${manual}` }
        case "modified":
            return { outcome: "modified", message: `La voce "${SERVER_NAME}" in ${reg.configPath} è diversa da quella scritta da questo installer (modificata o sostituita dopo l'installazione): non viene rimossa automaticamente. ${manual}` }
        case "ours":
            break
    }
    try {
        deps.checkpoint?.("before-unregister")
        // the state read above may be old by now: the file as it is, checked again by the same rule
        const fresh = statusOf(reg.configPath, reg.fingerprint, deps.env)
        if (fresh.status === "modified") return { outcome: "modified", message: `La voce "${SERVER_NAME}" in ${reg.configPath} è appena cambiata: non viene rimossa automaticamente. ${manual}` }
        if (fresh.status === "ours" && fresh.doc !== undefined) removeEntry(fresh.doc, deps)
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return { outcome: "write-error", message: `La voce "${SERVER_NAME}" non è stata rimossa (${error instanceof SetupRefusal ? error.message : code ?? "errore di scrittura"}). ${manual}` }
    }
    return { outcome: "removed", message: `Voce "${SERVER_NAME}" rimossa da ${reg.configPath}; il resto del file è invariato.${mark()}` }
}
