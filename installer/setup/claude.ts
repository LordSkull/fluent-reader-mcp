/**
 * FR-MCP-04-BETA-UX-01: what is left of Claude Code in the installer.
 *
 * The wizard configures Claude Desktop only (desktop.ts): it does not search for
 * claude.exe and starts no Claude Code command. The 0.1.x beta did register the
 * server in Claude Code (user scope, ~/.claude.json), and their records still
 * say so. That registration is carried over by upgrades and repairs and is
 * reported, read-only: this module never writes ~/.claude.json, and the entry
 * stays until the user removes it. Nothing read from the configuration is
 * printed, logged or kept.
 */

import fs from "node:fs"
import { SetupRefusal } from "./protocol.js"
import { entryFingerprint, type InstallRecord, type Registration, type StdioEntry } from "./record.js"

export const SERVER_NAME = "fluent-reader"
export const SCOPE = "user"

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

/** User-scope servers of ~/.claude.json, as stored (never shown); a file that is not what it should be is refused and left as it is. */
export function readConfig(file: string): { readonly exists: boolean; readonly servers: Readonly<Record<string, unknown>> } {
    if (!fs.existsSync(file)) return { exists: false, servers: {} }
    let raw: unknown
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
        throw new SetupRefusal(`la configurazione di Claude Code non è un JSON valido (${file}): non viene modificata né ricreata`)
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SetupRefusal(`la configurazione di Claude Code non ha la struttura attesa (${file}): non viene modificata`)
    const servers = (raw as Record<string, unknown>).mcpServers ?? {}
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new SetupRefusal(`la sezione mcpServers della configurazione di Claude Code non ha la struttura attesa (${file}): non viene modificata`)
    return { exists: true, servers: servers as Record<string, unknown> }
}

/**
 * Whether a stored entry is still the one an earlier setup registered: its
 * complete canonical JSON equals the one read back after that registration.
 */
export function isOwnEntry(raw: unknown, reg: Registration | null): boolean {
    return raw !== undefined && reg !== null && reg.fingerprint !== null && entryFingerprint(raw) === reg.fingerprint
}

/**
 * State of the registration an earlier setup made in Claude Code, without changing anything:
 *  not-configured   never registered (or removed by the setup that made it)
 *  absent           registered once, no "fluent-reader" user entry any more
 *  ours             the entry is still exactly the one saved then
 *  modified         an entry exists but its complete JSON differs
 *  not-attributable an entry exists but no saved identity proves it is that one
 *  config-error     the configuration cannot be read
 */
export type RegistrationStatus = "not-configured" | "absent" | "ours" | "modified" | "not-attributable" | "config-error"

export function registrationStatus(record: InstallRecord | null): { status: RegistrationStatus; reason?: string } {
    const reg = record?.claude ?? null
    if (reg === null || reg.state === "removed" || reg.state === "not-registered") return { status: "not-configured" }
    let config: ReturnType<typeof readConfig>
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
 * What to tell the user about a registration made in Claude Code by an earlier setup; empty when there is nothing to
 * say. `leaving`: the server is being uninstalled, so the entry is about to point to files that no longer exist.
 */
export function legacyCodeNote(record: InstallRecord | null, leaving: boolean): string {
    const { status } = registrationStatus(record)
    if (status === "not-configured" || status === "absent") return ""
    const manual = `claude mcp remove ${SERVER_NAME} --scope ${SCOPE}`
    if (leaving) return `Una versione precedente del setup aveva registrato il server anche in Claude Code: quella voce non viene toccata e ora punta a un server non più installato. Per rimuoverla: ${manual}`
    return `Una versione precedente del setup ha registrato il server in Claude Code: quella voce non viene modificata né rimossa, e non implica alcuna registrazione in Claude Desktop. Per rimuoverla a mano: ${manual}`
}
