/**
 * FR-MCP-04-BETA-02: registration of the server in Claude Code (user scope).
 *
 * Every change goes through the official CLI of the claude.exe the user
 * chose or confirmed: `claude mcp add-json <name> <json> --scope user` and
 * `claude mcp remove <name> --scope user` (forms documented at
 * https://code.claude.com/docs/en/mcp, checked against the client's own help
 * before use). The user configuration (~/.claude.json) is only READ here, to
 * plan, detect conflicts and verify; it is never rewritten by this helper. A
 * file that is not valid JSON stops everything and is left as it is.
 *
 * Nothing read from the configuration is printed, logged or kept in the
 * installation record: previews show only the paths of this installation
 * and, for a foreign "fluent-reader" entry, its command and how many
 * arguments and variables it has.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { childEnv, type ExecFn } from "../lib/common.js"
import { LAYOUT } from "./checks.js"
import { SetupRefusal } from "./protocol.js"
import { canonicalJson, entryFingerprint, readRecord, sameEntry, writeRecord, type InstallRecord, type Registration, type StdioEntry } from "./record.js"

export const SERVER_NAME = "fluent-reader"
export const SCOPE = "user"
const TIMEOUT_MS = 30_000

export interface ClaudeDeps {
    readonly env: NodeJS.ProcessEnv
    readonly exec: ExecFn
    /** Working directory of the claude.exe processes (not a project: the scope is user). */
    readonly cwd: string
    readonly now: () => Date
    /** Test hook: called at the named steps (concurrent changes, injected failures). */
    readonly checkpoint?: (step: ClaudeCheckpoint) => void
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
    return Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
}

/**
 * The file where Claude Code keeps user-scope MCP servers: ~/.claude.json.
 * With CLAUDE_CONFIG_DIR set the location is not documented precisely, so
 * the helper refuses instead of guessing.
 */
export function claudeConfigPath(env: NodeJS.ProcessEnv): string {
    const custom = envValue(env, "CLAUDE_CONFIG_DIR")
    if (custom !== undefined && custom.length > 0) throw new SetupRefusal("Claude Code usa una cartella di configurazione personalizzata (CLAUDE_CONFIG_DIR): la registrazione automatica non è supportata; installa solo il server e registralo a mano (vedi le istruzioni finali)")
    const home = envValue(env, "USERPROFILE")
    if (home === undefined || !/^[A-Za-z]:[\\/]/.test(home)) throw new SetupRefusal("cartella del profilo utente (USERPROFILE) non disponibile")
    return path.win32.join(path.win32.resolve(home), ".claude.json")
}

/** The entry this installation needs: the bundled node.exe, the bundled entrypoint, the chosen profile. */
export function desiredEntry(installDir: string, profileDir: string): StdioEntry {
    const app = path.win32.join(installDir, LAYOUT.current, "app")
    return { type: "stdio", command: path.win32.join(app, "runtime", "node.exe"), args: [path.win32.join(app, "server", "dist", "main.js"), "--profile-dir", profileDir], env: {} }
}

/**
 * Normalised stdio form of a configuration entry (missing type means stdio,
 * missing args/env are empty), or null if it is not a stdio entry. Fields
 * other than type/command/args/env are not compared.
 */
export function normalize(value: unknown): StdioEntry | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const v = value as Record<string, unknown>
    const type = v.type ?? "stdio"
    const args = v.args ?? []
    const env = v.env ?? {}
    if (type !== "stdio" || typeof v.command !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) return null
    if (typeof env !== "object" || env === null || Array.isArray(env) || !Object.values(env).every((x) => typeof x === "string")) return null
    return { type: "stdio", command: v.command, args: args as string[], env: env as Record<string, string> }
}

export interface ConfigState {
    readonly exists: boolean
    /** User-scope servers, as stored (never shown). */
    readonly servers: Readonly<Record<string, unknown>>
    /** Projects whose local-scope "fluent-reader" entry takes precedence over the user scope. */
    readonly shadowingProjects: number
}

export function readConfig(file: string): ConfigState {
    if (!fs.existsSync(file)) return { exists: false, servers: {}, shadowingProjects: 0 }
    let raw: unknown
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
        throw new SetupRefusal(`la configurazione di Claude Code non è un JSON valido (${file}): non viene modificata né ricreata. Riparala o ripristina una copia, poi esegui di nuovo il setup; nel frattempo puoi installare solo il server`)
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SetupRefusal(`la configurazione di Claude Code non ha la struttura attesa (${file}): non viene modificata`)
    const doc = raw as Record<string, unknown>
    const servers = doc.mcpServers ?? {}
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new SetupRefusal(`la sezione mcpServers della configurazione di Claude Code non ha la struttura attesa (${file}): non viene modificata`)
    let shadowingProjects = 0
    if (typeof doc.projects === "object" && doc.projects !== null) {
        for (const project of Object.values(doc.projects as Record<string, unknown>)) {
            const local = (project as { mcpServers?: unknown } | null)?.mcpServers
            if (typeof local === "object" && local !== null && Object.hasOwn(local, SERVER_NAME)) shadowingProjects++
        }
    }
    return { exists: true, servers: servers as Record<string, unknown>, shadowingProjects }
}

function others(servers: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(servers).filter(([name]) => name !== SERVER_NAME))
}

/** Candidate claude.exe files, searched only when the user asks: PATH, the native installer, the VS Code extension. */
export function detectClaude(env: NodeJS.ProcessEnv): string[] {
    const found: string[] = []
    const add = (file: string): void => {
        try {
            const stats = fs.lstatSync(file)
            if (stats.isFile() && !found.some((f) => f.toLowerCase() === file.toLowerCase())) found.push(file)
        } catch {
            // not there
        }
    }
    const home = envValue(env, "USERPROFILE")
    if (home !== undefined && /^[A-Za-z]:[\\/]/.test(home)) {
        for (const editor of [".vscode", ".vscode-insiders"]) {
            const extensions = path.win32.join(home, editor, "extensions")
            let names: string[] = []
            try {
                names = fs.readdirSync(extensions)
            } catch {
                continue
            }
            const versions = names
                .map((name) => ({ name, v: /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)-win32-x64$/.exec(name) }))
                .filter((x): x is { name: string; v: RegExpExecArray } => x.v !== null)
                .sort((a, b) => Number(b.v[1]) - Number(a.v[1]) || Number(b.v[2]) - Number(a.v[2]) || Number(b.v[3]) - Number(a.v[3]))
            for (const { name } of versions) add(path.win32.join(extensions, name, "resources", "native-binary", "claude.exe"))
        }
        add(path.win32.join(home, ".local", "bin", "claude.exe"))
    }
    for (const dir of (envValue(env, "PATH") ?? "").split(";")) if (/^[A-Za-z]:[\\/]/.test(dir)) add(path.win32.join(dir, "claude.exe"))
    return found
}

function runClaude(deps: ClaudeDeps, exe: string, args: readonly string[]): { ok: boolean; stdout: string; code: string } {
    const result = deps.exec(exe, args, { cwd: deps.cwd, env: childEnv(deps.env), timeoutMs: TIMEOUT_MS })
    if (result.error !== undefined) return { ok: false, stdout: "", code: "non avviato" }
    return { ok: result.status === 0, stdout: `${result.stdout}\n${result.stderr}`, code: `codice ${String(result.status)}` }
}

/** Checks that `exe` is a Claude Code CLI whose `mcp add-json` and `mcp remove` accept --scope. */
export function checkClaude(exe: string, deps: ClaudeDeps): { version: string } {
    if (!/^[A-Za-z]:[\\/]/.test(exe) || !/\.exe$/i.test(exe)) throw new SetupRefusal("Claude Code: indica il percorso completo di claude.exe")
    let stats: fs.Stats
    try {
        stats = fs.lstatSync(exe)
    } catch {
        throw new SetupRefusal("Claude Code: il file indicato non esiste")
    }
    if (!stats.isFile()) throw new SetupRefusal("Claude Code: il percorso indicato non è un file")
    const version = runClaude(deps, exe, ["--version"])
    const match = /(\d+\.\d+\.\d+) \(Claude Code\)/.exec(version.stdout)
    if (!version.ok || match === null) throw new SetupRefusal("Claude Code: il file indicato non risponde come la CLI di Claude Code (claude --version)")
    for (const sub of ["add-json", "remove"]) {
        const help = runClaude(deps, exe, ["mcp", sub, "--help"])
        if (!help.ok || !help.stdout.includes(sub) || !help.stdout.includes("--scope")) throw new SetupRefusal(`Claude Code ${match[1] as string}: il comando "claude mcp ${sub}" non è disponibile con --scope; aggiorna Claude Code o installa solo il server`)
    }
    return { version: match[1] as string }
}

export type Action = "add" | "none" | "replace-own" | "replace-foreign"

export interface Plan {
    readonly configPath: string
    readonly configExists: boolean
    readonly action: Action
    readonly existing: StdioEntry | null
    readonly existingIsStdio: boolean
    readonly desired: StdioEntry
    readonly shadowingProjects: number
    /** Binds a registration to the preview the user approved. */
    readonly hash: string
}

/**
 * Whether a stored entry is still the one this installer registered: its
 * complete canonical JSON equals the one read back after the registration.
 * The name alone, or equal command/args/env, is never enough.
 */
export function isOwnEntry(raw: unknown, reg: Registration | null): boolean {
    return raw !== undefined && reg !== null && reg.fingerprint !== null && entryFingerprint(raw) === reg.fingerprint
}

export function plan(input: { readonly configPath: string; readonly installDir: string; readonly profileDir: string; readonly record: InstallRecord | null }): Plan {
    const config = readConfig(input.configPath)
    const desired = desiredEntry(input.installDir, input.profileDir)
    const present = Object.hasOwn(config.servers, SERVER_NAME)
    const raw = present ? config.servers[SERVER_NAME] : undefined
    const existing = present ? normalize(raw) : null
    const reg = input.record?.claude ?? null
    const ours = isOwnEntry(raw, reg) && reg !== null && ["registered", "rollback-failed"].includes(reg.state)
    const action: Action = !present ? "add"
        : ours && sameEntry(reg.entry, desired) ? "none"
        : !ours && canonicalJson(raw) === canonicalJson(desired) ? "none"
        : ours ? "replace-own"
        : "replace-foreign"
    const hash = crypto.createHash("sha256").update(JSON.stringify({ configPath: input.configPath, action, raw: raw === undefined ? null : entryFingerprint(raw), desired })).digest("hex")
    return { configPath: input.configPath, configExists: config.exists, action, existing, existingIsStdio: existing !== null, desired, shadowingProjects: config.shadowingProjects, hash }
}

/** The preview shown before consent: only this installation's paths, never configuration content. */
export function previewLines(p: Plan, claudeExe: string, claudeVersion: string): string[] {
    const lines = [
        `Server MCP: ${SERVER_NAME} (trasporto stdio)`,
        `Scope: ${SCOPE} (disponibile in tutti i progetti di questo utente Windows)`,
        `Eseguibile: ${p.desired.command}`,
        `Entrypoint: ${p.desired.args[0] as string}`,
        `Profilo Fluent Reader: ${p.desired.args[2] as string}`,
        `Configurazione interessata: ${p.configPath}${p.configExists ? "" : " (non esiste ancora: la crea Claude Code)"}`,
        `Strumento usato: ${claudeExe} (Claude Code ${claudeVersion}), comando ufficiale "claude mcp add-json ... --scope user"`,
    ]
    if (p.action === "add") lines.push(`Modifica: viene aggiunta soltanto la voce "${SERVER_NAME}".`)
    if (p.action === "none") lines.push(`Modifica: nessuna, la voce "${SERVER_NAME}" è già registrata esattamente così.`)
    if (p.action === "replace-own") lines.push(`Modifica: la voce "${SERVER_NAME}" creata da una precedente installazione viene aggiornata.`)
    if (p.action === "replace-foreign") {
        const detail = p.existing === null ? "non è un server stdio" : `comando ${p.existing.command}, ${p.existing.args.length} argomenti, ${Object.keys(p.existing.env).length} variabili`
        lines.push(`ATTENZIONE: esiste già una voce "${SERVER_NAME}" che non è stata creata da questo installer, o è stata modificata dopo (${detail}).`)
        lines.push("Viene sostituita soltanto se lo confermi esplicitamente nella casella sotto; altrimenti torna indietro e scegli di installare solo il server.")
    }
    if (p.action !== "none") lines.push(`Prima della modifica viene salvata una copia della configurazione nella cartella di installazione (state\\claude-config-backups).`)
    lines.push("Gli altri server MCP e le altre impostazioni di Claude Code non vengono toccati; il risultato viene verificato e, in caso di errore, annullato quando è sicuro farlo.")
    if (p.shadowingProjects > 0) lines.push(`Nota: ${p.shadowingProjects} progetti hanno una propria voce "${SERVER_NAME}" (scope local), che in quei progetti ha la precedenza.`)
    lines.push("Chiudi le sessioni di Claude Code aperte prima di continuare.")
    return lines
}

export interface RegisterInput {
    readonly claudeExe: string
    readonly installDir: string
    readonly profileDir: string
    readonly recordPath: string
    readonly expectPlan: string
    readonly allowReplaceForeign: boolean
}

export interface RegisterOutcome {
    readonly action: Action
    readonly backup: string | null
}

function backupConfig(configPath: string, installDir: string, now: Date): string {
    const dir = path.win32.join(installDir, LAYOUT.state, "claude-config-backups")
    fs.mkdirSync(dir, { recursive: true })
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
    for (let i = 0; ; i++) {
        const name = `claude.json.${stamp}${i === 0 ? "" : `-${i}`}.bak`
        try {
            fs.copyFileSync(configPath, path.win32.join(dir, name), fs.constants.COPYFILE_EXCL)
            return name
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
    }
}

function updateRegistration(recordPath: string, registration: Registration | null): void {
    const record = readRecord(recordPath)
    if (record === null) throw new SetupRefusal("registro di installazione mancante")
    writeRecord(recordPath, { ...record, claude: registration })
}

/**
 * Registers the server after the user's consent, bound to the approved plan:
 * backup, record the intent ("pending"), remove the replaced entry if any,
 * add ours, READ BACK the entry the CLI saved (it becomes ours only if it is
 * what was approved; its full fingerprint is recorded), verify every other
 * user-scope server unchanged. Any failure leads to a conservative rollback.
 */
export function register(input: RegisterInput, deps: ClaudeDeps): RegisterOutcome {
    const record = readRecord(input.recordPath)
    if (record === null) throw new SetupRefusal("registro di installazione mancante")
    const configPath = claudeConfigPath(deps.env)
    const p = plan({ configPath, installDir: input.installDir, profileDir: input.profileDir, record })
    if (p.hash !== input.expectPlan) throw new SetupRefusal("la configurazione di Claude Code è cambiata dopo l'anteprima: nessuna modifica eseguita; esegui di nuovo il setup per vedere l'anteprima aggiornata")
    if (p.action === "replace-foreign" && !input.allowReplaceForeign) throw new SetupRefusal(`la voce "${SERVER_NAME}" esistente non è di questo installer e la sostituzione non è stata confermata: nessuna modifica eseguita`)
    if (p.action === "none") {
        const reg = record.claude
        if (reg !== null && reg.state !== "registered" && isOwnEntry(readConfig(configPath).servers[SERVER_NAME], reg)) updateRegistration(input.recordPath, { ...reg, state: "registered", updatedAt: deps.now().toISOString() })
        return { action: "none", backup: null }
    }
    const originalRegistration = record.claude
    const before = readConfig(configPath)
    const previousRaw = before.servers[SERVER_NAME]
    const backup = before.exists ? backupConfig(configPath, input.installDir, deps.now()) : null
    const registration: Registration = { state: "pending", name: SERVER_NAME, scope: SCOPE, configPath, claudeExe: input.claudeExe, entry: p.desired, fingerprint: null, backup, updatedAt: deps.now().toISOString() }
    updateRegistration(input.recordPath, registration)
    let removedPrevious = false
    let ownFingerprint: string | null = null
    try {
        if (previousRaw !== undefined) {
            const removed = runClaude(deps, input.claudeExe, ["mcp", "remove", SERVER_NAME, "--scope", SCOPE])
            removedPrevious = !Object.hasOwn(readConfig(configPath).servers, SERVER_NAME)
            if (!removed.ok) throw new SetupRefusal(`claude mcp remove non è riuscito (${removed.code})`)
            if (!removedPrevious) throw new SetupRefusal("la voce precedente non risulta rimossa")
        }
        const added = runClaude(deps, input.claudeExe, ["mcp", "add-json", SERVER_NAME, JSON.stringify(p.desired), "--scope", SCOPE])
        if (!added.ok) throw new SetupRefusal(`claude mcp add-json non è riuscito (${added.code})`)
        const saved = readConfig(configPath)
        const savedRaw = saved.servers[SERVER_NAME]
        if (savedRaw === undefined || !sameEntry(normalize(savedRaw), p.desired)) throw new SetupRefusal("la voce salvata da Claude Code non corrisponde a quella approvata")
        ownFingerprint = entryFingerprint(savedRaw)
        deps.checkpoint?.("after-readback")
        if (!isDeepStrictEqual(others(saved.servers), others(before.servers))) throw new SetupRefusal("altri server MCP risultano cambiati durante la registrazione (Claude Code era aperto?)")
        updateRegistration(input.recordPath, { ...registration, state: "registered", fingerprint: ownFingerprint, updatedAt: deps.now().toISOString() })
    } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        const outcome = rollback(deps, input.claudeExe, configPath, ownFingerprint, previousRaw, removedPrevious)
        const where = backup === null ? "" : ` La copia presa prima della modifica è in ${path.win32.join(input.installDir, LAYOUT.state, "claude-config-backups", backup)}.`
        try {
            updateRegistration(input.recordPath, outcome.complete ? originalRegistration : { ...registration, state: "rollback-failed", fingerprint: outcome.ownStillPresent ? ownFingerprint : null, updatedAt: deps.now().toISOString() })
        } catch {
            // the message below still reports the state of Claude Code
        }
        if (outcome.complete) throw new SetupRefusal(`registrazione non completata (${cause}); la voce "${SERVER_NAME}" di Claude Code è stata riportata allo stato precedente.${where}`)
        throw new SetupRefusal(`registrazione non completata (${cause}) e il ripristino automatico NON è stato completato: ${outcome.reason}. Serve un tuo intervento: controlla la voce con "claude mcp get ${SERVER_NAME}".${where}`)
    }
    return { action: p.action, backup }
}

/** Steps where tests inject concurrent changes or failures. */
export type ClaudeCheckpoint = "after-readback" | "before-rollback" | "before-rollback-restore" | "before-unregister"

interface RollbackOutcome {
    readonly complete: boolean
    readonly ownStillPresent: boolean
    readonly reason: string
}

/**
 * Undoes a registration through the CLI, only as far as it is provably safe:
 *  - the current entry is removed only if its complete fingerprint is the
 *    one read back after this run's successful add-json (an attempted or
 *    failed add-json proves nothing);
 *  - a replaced entry is put back only while the name is free;
 *  - an entry that is absent, changed or replaced by someone else is left
 *    as it is and the rollback is reported as incomplete.
 */
function rollback(deps: ClaudeDeps, exe: string, configPath: string, ownFingerprint: string | null, previousRaw: unknown, removedPrevious: boolean): RollbackOutcome {
    const incomplete = (reason: string, ownStillPresent = false): RollbackOutcome => ({ complete: false, ownStillPresent, reason })
    try {
        deps.checkpoint?.("before-rollback")
        const current = readConfig(configPath)
        if (Object.hasOwn(current.servers, SERVER_NAME)) {
            const raw = current.servers[SERVER_NAME]
            if (ownFingerprint !== null && entryFingerprint(raw) === ownFingerprint) {
                const removed = runClaude(deps, exe, ["mcp", "remove", SERVER_NAME, "--scope", SCOPE])
                const after = readConfig(configPath)
                if (Object.hasOwn(after.servers, SERVER_NAME)) return incomplete(removed.ok ? "la voce risulta ancora presente dopo claude mcp remove" : `claude mcp remove non è riuscito (${removed.code})`, entryFingerprint(after.servers[SERVER_NAME]) === ownFingerprint)
            } else if (previousRaw !== undefined && isDeepStrictEqual(raw, previousRaw)) {
                return { complete: true, ownStillPresent: false, reason: "" }
            } else {
                return incomplete(`la voce "${SERVER_NAME}" attuale non è attribuibile con certezza a questa operazione (modificata, sostituita o scritta da altri): non viene toccata`)
            }
        }
        if (removedPrevious) {
            deps.checkpoint?.("before-rollback-restore")
            if (Object.hasOwn(readConfig(configPath).servers, SERVER_NAME)) return incomplete(`nel frattempo è comparsa un'altra voce "${SERVER_NAME}": quella precedente non viene ripristinata sopra di essa`)
            const restored = runClaude(deps, exe, ["mcp", "add-json", SERVER_NAME, JSON.stringify(previousRaw), "--scope", SCOPE])
            if (!restored.ok) return incomplete(`il ripristino della voce precedente non è riuscito (${restored.code})`)
            if (!isDeepStrictEqual(readConfig(configPath).servers[SERVER_NAME], previousRaw)) return incomplete("la voce ripristinata non corrisponde a quella precedente")
        }
        return { complete: true, ownStillPresent: false, reason: "" }
    } catch (error) {
        return incomplete(error instanceof Error ? error.message : String(error))
    }
}

/**
 * State of this installer's registration, without changing anything:
 *  not-configured   the installer never registered the server (or it was removed)
 *  absent           registered once, no "fluent-reader" user entry any more
 *  ours             the entry is still exactly the one saved for this installer
 *  modified         an entry exists but its complete JSON differs
 *  not-attributable an entry exists but no saved identity proves it is ours
 *  config-error     the configuration cannot be read
 */
export type RegistrationStatus = "not-configured" | "absent" | "ours" | "modified" | "not-attributable" | "config-error"

export function registrationStatus(record: InstallRecord | null): { status: RegistrationStatus; reason?: string } {
    const reg = record?.claude ?? null
    if (reg === null || reg.state === "removed" || reg.state === "not-registered") return { status: "not-configured" }
    let config: ConfigState
    try {
        config = readConfig(reg.configPath)
    } catch (error) {
        return { status: "config-error", reason: (error as Error).message }
    }
    if (!Object.hasOwn(config.servers, SERVER_NAME)) return { status: "absent" }
    if (reg.fingerprint === null) return { status: "not-attributable" }
    return { status: isOwnEntry(config.servers[SERVER_NAME], reg) ? "ours" : "modified" }
}

/**
 * Uninstall outcome. Only not-configured, absent and removed let the
 * uninstaller go on by itself; any other outcome leaves files, record and
 * uninstaller in place unless the user explicitly decides otherwise.
 */
export type UnregisterOutcome = "not-configured" | "absent" | "removed" | "modified" | "not-attributable" | "config-error" | "claude-missing" | "cli-error" | "still-present"

export function unregister(recordPath: string, claudeExe: string | null, deps: ClaudeDeps): { outcome: UnregisterOutcome; message: string } {
    const record = readRecord(recordPath)
    const manual = `Per rimuoverla a mano: claude mcp remove ${SERVER_NAME} --scope ${SCOPE}`
    const state = registrationStatus(record)
    const mark = (): void => {
        if (record !== null && record.claude !== null) writeRecord(recordPath, { ...record, claude: { ...record.claude, state: "removed", updatedAt: deps.now().toISOString() } })
    }
    switch (state.status) {
        case "not-configured":
            return { outcome: "not-configured", message: "Nessuna registrazione di Claude Code creata da questo installer." }
        case "absent":
            mark()
            return { outcome: "absent", message: `La voce "${SERVER_NAME}" non è più presente in Claude Code.` }
        case "config-error":
            return { outcome: "config-error", message: `${state.reason ?? "configurazione di Claude Code non leggibile"}. La voce "${SERVER_NAME}" non è stata toccata.` }
        case "modified":
            return { outcome: "modified", message: `La voce "${SERVER_NAME}" è stata modificata dopo l'installazione: non viene rimossa automaticamente. ${manual}` }
        case "not-attributable":
            return { outcome: "not-attributable", message: `Una voce "${SERVER_NAME}" esiste, ma non è possibile stabilire che sia quella creata da questo installer (registrazione interrotta): non viene rimossa automaticamente. ${manual}` }
        case "ours":
            break
    }
    const reg = record?.claude as Registration
    const exe = claudeExe ?? reg.claudeExe
    if (!fs.existsSync(exe)) return { outcome: "claude-missing", message: `Claude Code non è stato trovato (${exe}): la voce "${SERVER_NAME}" non è stata rimossa. ${manual}` }
    const before = readConfig(reg.configPath)
    deps.checkpoint?.("before-unregister")
    const removed = runClaude(deps, exe, ["mcp", "remove", SERVER_NAME, "--scope", SCOPE])
    let after: ConfigState
    try {
        after = readConfig(reg.configPath)
    } catch (error) {
        return { outcome: "config-error", message: `${(error as Error).message}. Esito della rimozione non verificabile.` }
    }
    if (Object.hasOwn(after.servers, SERVER_NAME)) {
        return removed.ok
            ? { outcome: "still-present", message: `La voce "${SERVER_NAME}" risulta ancora presente dopo la rimozione. ${manual}` }
            : { outcome: "cli-error", message: `La rimozione della voce "${SERVER_NAME}" non è riuscita (${removed.code}). ${manual}` }
    }
    mark()
    if (!isDeepStrictEqual(others(after.servers), others(before.servers))) return { outcome: "removed", message: `Voce "${SERVER_NAME}" rimossa, ma altri server MCP risultano cambiati nel frattempo: controlla Claude Code.` }
    return { outcome: "removed", message: `Voce "${SERVER_NAME}" rimossa da Claude Code; gli altri server MCP sono invariati.` }
}
