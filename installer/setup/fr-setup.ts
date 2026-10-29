/**
 * FR-MCP-04-BETA-02 — setup helper, run by the BUNDLED node.exe on behalf of
 * the NSIS wizard and uninstaller:
 *
 *   node.exe fr-setup.js <command> <request file> <result file>
 *
 * Commands: check-install-dir, check-profile, detect-claude, check-claude,
 * plan, register, verify-tree; tx-recover, tx-recover-finish, tx-begin,
 * tx-prepare, tx-swap, tx-metadata, tx-commit, tx-cleanup (installation
 * transaction); un-status, uninstall-preflight, unregister, un-begin,
 * remove-tree, un-metadata, un-finish (uninstallation).
 * See installer/INSTALLER.md. Exit code 0 = ok, 1 = refused (the result
 * carries the message for the user), 2 = internal error. It prints nothing.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile, type ExecFn } from "../lib/common.js"
import { runSelfTest, type SelfTestFn } from "../lib/selftest.js"
import { HELPER_FILES, readInventory, removalPlan, removeTree, verifyTree } from "./app.js"
import { authorizedTree, checkInstallDir, checkProfile, installRoot, LAYOUT, recordedInstallDir } from "./checks.js"
import { checkClaude, claudeConfigPath, detectClaude, plan, previewLines, register, registrationStatus, unregister, type ClaudeDeps } from "./claude.js"
import { flag, readRequest, required, SetupRefusal, writeResult, type Request, type Result } from "./protocol.js"
import { RECORD_NAME, readRecord } from "./record.js"
import { JOURNAL, parseRegistryBackup, registryInstructions, txBegin, txCleanup, txCommit, txMetadata, txPrepare, txRecover, txRecoverFinish, txSwap, type TxCheckpoint, type TxDeps } from "./transaction.js"
import { finishUninstall, readMarker, uninstallBegin, uninstallFinish, uninstallMetadata, uninstallStatus, verifyHelperCopy, type UninstallCheckpoint } from "./uninstall.js"

export interface HelperDeps {
    readonly env: NodeJS.ProcessEnv
    readonly exec: ExecFn
    readonly selfTest: SelfTestFn
    readonly now: () => Date
    /** Test hooks: concurrent changes and injected failures or crashes at named steps. */
    readonly checkpoint?: ClaudeDeps["checkpoint"]
    readonly txCheckpoint?: ((step: TxCheckpoint) => void) | undefined
    readonly uninstallCheckpoint?: ((step: UninstallCheckpoint) => void) | undefined
    /** Test hook: the file removal used by remove-tree and the cleanups. */
    readonly unlink?: ((file: string) => void) | undefined
    readonly rmdir?: ((dir: string) => void) | undefined
}

function txDeps(deps: HelperDeps): TxDeps {
    return { now: deps.now, checkpoint: deps.txCheckpoint, unlink: deps.unlink }
}

type Fields = [string, string][]

function recordPath(installDir: string): string {
    return path.win32.join(installDir, RECORD_NAME)
}

function claudeDeps(deps: HelperDeps): ClaudeDeps {
    return { env: deps.env, exec: deps.exec, cwd: os.tmpdir(), now: deps.now, ...(deps.checkpoint !== undefined && { checkpoint: deps.checkpoint }) }
}

/** The install directory of a request, re-validated by every command that writes into it. */
function installDirOf(request: Request, deps: HelperDeps): string {
    return checkInstallDir({ installDir: required(request, "installDir"), version: required(request, "version"), maxRelative: Number(request.get("maxRelative") ?? "0"), env: deps.env }).canonical
}

const COMMANDS: Record<string, (request: Request, deps: HelperDeps) => Promise<Fields> | Fields> = {
    "check-install-dir": (request, deps) => {
        const maxRelative = Number(required(request, "maxRelative"))
        if (!Number.isSafeInteger(maxRelative) || maxRelative <= 0) throw new SetupRefusal("richiesta non valida: maxRelative")
        const check = checkInstallDir({ installDir: required(request, "installDir"), version: required(request, "version"), maxRelative, env: deps.env })
        return [["canonical", check.canonical], ["mode", check.mode], ["installedVersion", check.installedVersion ?? ""], ["previousProfile", check.previousProfile ?? ""]]
    },
    "check-profile": (request) => [["canonical", checkProfile(required(request, "profileDir"), request.get("installDir") ?? null).canonical]],
    "detect-claude": (_request, deps) => {
        const found = detectClaude(deps.env)
        if (found.length === 0) throw new SetupRefusal("Claude Code (claude.exe) non è stato trovato: indicalo con Sfoglia, oppure installa solo il server")
        return [["claudeExe", found[0] as string], ["candidates", String(found.length)]]
    },
    "check-claude": (request, deps) => [["version", checkClaude(required(request, "claudeExe"), claudeDeps(deps)).version]],
    plan: (request, deps) => {
        const installDir = installDirOf(request, deps)
        const claudeExe = required(request, "claudeExe")
        const { version } = checkClaude(claudeExe, claudeDeps(deps))
        const profileDir = checkProfile(required(request, "profileDir"), installDir).canonical
        const p = plan({ configPath: claudeConfigPath(deps.env), installDir, profileDir, record: readRecord(recordPath(installDir)) })
        return [["action", p.action], ["planHash", p.hash], ...previewLines(p, claudeExe, version).map((line): [string, string] => ["preview", line])]
    },
    // ---------------------------------------------------------------- installation transaction (see transaction.ts)
    "tx-recover": (request, deps) => {
        const { outcome, registry } = txRecover({ installDir: required(request, "installDir"), env: deps.env, fallbackInventory: request.get("payloadInventory") || null }, txDeps(deps))
        return [["outcome", outcome], ...(outcome === "registry-restore" && registry !== null ? registryInstructions(registry) : [])]
    },
    "tx-recover-finish": (request, deps) => {
        txRecoverFinish({ installDir: required(request, "installDir"), env: deps.env, registryRestored: flag(request, "registryRestored"), fallbackInventory: request.get("payloadInventory") || null }, txDeps(deps))
        return [["outcome", "rolled-back"]]
    },
    "tx-begin": (request, deps) => {
        const installDir = installDirOf(request, deps)
        const sha = required(request, "bundleSha256")
        if (!/^[0-9a-f]{64}$/.test(sha)) throw new SetupRefusal("richiesta non valida: bundleSha256")
        const profileDir = checkProfile(required(request, "profileDir"), installDir).canonical
        const journal = txBegin(txDeps(deps), { installDir, version: required(request, "version"), maxRelative: Number(request.get("maxRelative") ?? "0"), bundleSha256: sha, profileDir, env: deps.env })
        return [["transactionId", journal.transactionId]]
    },
    "tx-prepare": (request, deps) => {
        const installDir = installRoot(required(request, "installDir"), deps.env)
        txPrepare(installDir, required(request, "transactionId"), parseRegistryBackup(request))
        return []
    },
    "tx-swap": (request, deps) => {
        txSwap(installRoot(required(request, "installDir"), deps.env), required(request, "transactionId"), txDeps(deps))
        return []
    },
    "tx-metadata": (request, deps) => {
        txMetadata(installRoot(required(request, "installDir"), deps.env), required(request, "transactionId"), txDeps(deps))
        return []
    },
    "tx-commit": (request, deps) => {
        txCommit(installRoot(required(request, "installDir"), deps.env), required(request, "transactionId"), flag(request, "registryWritten"))
        return []
    },
    "tx-cleanup": (request, deps) => {
        txCleanup(installRoot(required(request, "installDir"), deps.env), txDeps(deps))
        return []
    },
    // ---------------------------------------------------------------- uninstallation (see uninstall.ts)
    "un-status": (request, deps) => {
        const status = uninstallStatus(required(request, "installDir"), deps.env)
        return [["phase", status.phase], ["helperCopy", status.helperCopy]]
    },
    "uninstall-preflight": (request, deps) => {
        // Nothing is changed here: every reason to stop is found before the uninstaller removes anything.
        const installDir = recordedInstallDir(required(request, "installDir"), deps.env)
        if (fs.existsSync(path.win32.join(installDir, LAYOUT.state, JOURNAL))) throw new SetupRefusal("un'installazione interrotta non è stata ripristinata: esegui di nuovo il setup prima di disinstallare")
        const marker = readMarker(installDir)
        for (const tree of [LAYOUT.current, LAYOUT.staging, LAYOUT.previous]) {
            if (fs.existsSync(path.win32.join(installDir, tree))) removalPlan(authorizedTree(installDir, tree, deps.env))
        }
        if (marker !== null) {
            // A repeated attempt: the helper is the verified copy, current may already be partly gone.
            if (!verifyHelperCopy(installDir)) throw new SetupRefusal("la copia di recupero del programma di supporto è incompleta o alterata: nulla viene rimosso")
        } else {
            const current = path.win32.join(installDir, LAYOUT.current)
            if (!fs.existsSync(current)) throw new SetupRefusal("la cartella current non esiste: il programma di supporto non è disponibile")
            const listed = new Set(readInventory(current).files.map((f) => f.path))
            for (const helper of HELPER_FILES) if (!listed.has(helper) || !fs.existsSync(path.win32.join(current, ...helper.split("/")))) throw new SetupRefusal(`il programma di supporto è incompleto (${helper})`)
        }
        const status = registrationStatus(readRecord(recordPath(installDir)))
        return [["claude", status.status]]
    },
    "un-begin": (request, deps) => {
        uninstallBegin(required(request, "installDir"), deps.env)
        return []
    },
    "un-metadata": (request, deps) => {
        uninstallMetadata(required(request, "installDir"), deps.env, deps.uninstallCheckpoint)
        return []
    },
    "finish-uninstall": (request, deps) => {
        finishUninstall(required(request, "installDir"), deps.env, deps.unlink, deps.rmdir)
        return []
    },
    "un-finish": (request, deps) => {
        uninstallFinish(required(request, "installDir"), deps.env, deps.uninstallCheckpoint)
        return []
    },
    register: (request, deps) => {
        if (!flag(request, "consent")) throw new SetupRefusal("la registrazione in Claude Code richiede il tuo consenso esplicito: nessuna modifica eseguita")
        const installDir = installDirOf(request, deps)
        const outcome = register({
            claudeExe: required(request, "claudeExe"),
            installDir,
            profileDir: checkProfile(required(request, "profileDir"), installDir).canonical,
            recordPath: recordPath(installDir),
            expectPlan: required(request, "planHash"),
            allowReplaceForeign: flag(request, "replaceForeign"),
        }, claudeDeps(deps))
        return [["action", outcome.action], ["backup", outcome.backup ?? ""]]
    },
    unregister: (request, deps) => {
        const installDir = recordedInstallDir(required(request, "installDir"), deps.env)
        const { outcome, message } = unregister(recordPath(installDir), request.get("claudeExe") || null, claudeDeps(deps))
        return [["outcome", outcome], ["message", message]]
    },
    "verify-tree": async (request, deps) => {
        const root = required(request, "root")
        const lines = await verifyTree(root, { exec: deps.exec, env: deps.env, selfTest: flag(request, "selfTest") ? deps.selfTest : null })
        return lines.map((line): [string, string] => ["report", line])
    },
    "remove-tree": (request, deps) => {
        // Only current, .staging or previous of an authorised installation directory; never a path from the request.
        const target = authorizedTree(required(request, "installDir"), required(request, "tree"), deps.env)
        return [["removed", String(removeTree(target, deps.unlink).removed)]]
    },
}

export const HELPER_COMMANDS: readonly string[] = Object.keys(COMMANDS)

/** Runs one command; never throws. */
export async function main(argv: readonly string[], deps: HelperDeps): Promise<number> {
    const [command, requestFile, resultFile] = argv
    if (command === undefined || requestFile === undefined || resultFile === undefined || argv.length !== 3) return 2
    let result: Result
    let code: number
    try {
        const handler = COMMANDS[command]
        if (handler === undefined) throw new SetupRefusal(`comando sconosciuto: ${command}`)
        result = { status: "ok", fields: await handler(readRequest(requestFile), deps) }
        code = 0
    } catch (error) {
        const refused = error instanceof SetupRefusal
        result = { status: refused ? "refused" : "error", fields: [["message", refused ? error.message : `errore interno del setup: ${error instanceof Error ? error.message : String(error)}`], ...(refused ? error.fields : [])] }
        code = refused ? 1 : 2
    }
    try {
        writeResult(resultFile, result)
    } catch {
        return 2
    }
    return code
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main(process.argv.slice(2), { env: process.env, exec: execFile, selfTest: runSelfTest, now: () => new Date() })
}
