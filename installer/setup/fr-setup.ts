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
import { authorizedTree, checkInstallDir, checkProfile, installRoot, LAYOUT, INSTALL_MODES, recordedInstallDir, resolveInstallDir, type InstallDirCheck } from "./checks.js"
import { checkClaude, claudeConfigPath, detectClaude, plan, previewLines, register, registrationStatus, unregister, type ClaudeDeps } from "./claude.js"
import { flag, readRequest, required, SetupRefusal, writeResult, type Request, type Result } from "./protocol.js"
import { RECORD_NAME, readRecord } from "./record.js"
import { JOURNAL, parseRegistryBackup, registryInstructions, txBegin, txCleanup, txCommit, txMetadata, txPrepare, txRecover, txRecoverFinish, txStage, txSwap, type TxCheckpoint, type TxDeps } from "./transaction.js"
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
    /** Test hook: the rename primitive of the installation transaction (called once per rename). */
    readonly rename?: ((from: string, to: string) => void) | undefined
    /** Test hook: the write check of an existing destination (check-install-dir). */
    readonly writeProbe?: ((dir: string) => void) | undefined
    /** Where this helper runs with its payload's inventory (installer-files.json next to setup\): the only payload reference. */
    readonly payloadRoot?: string | null | undefined
}

function txDeps(deps: HelperDeps): TxDeps {
    return { now: deps.now, checkpoint: deps.txCheckpoint, unlink: deps.unlink, rename: deps.rename, payloadRoot: deps.payloadRoot ?? null }
}

type Fields = [string, string][]

function recordPath(installDir: string): string {
    return path.win32.join(installDir, RECORD_NAME)
}

function claudeDeps(deps: HelperDeps): ClaudeDeps {
    return { env: deps.env, exec: deps.exec, cwd: os.tmpdir(), now: deps.now, ...(deps.checkpoint !== undefined && { checkpoint: deps.checkpoint }) }
}

/** The install directory of a request, re-validated by every command that writes into it (never redirected: no proposal here). */
function installCheckOf(request: Request, deps: HelperDeps): InstallDirCheck {
    return checkInstallDir({ installDir: required(request, "installDir"), version: required(request, "version"), maxRelative: Number(request.get("maxRelative") ?? "0"), env: deps.env })
}

function installDirOf(request: Request, deps: HelperDeps): string {
    return installCheckOf(request, deps).canonical
}

const COMMANDS: Record<string, (request: Request, deps: HelperDeps) => Promise<Fields> | Fields> = {
    "check-install-dir": (request, deps) => {
        const maxRelative = Number(required(request, "maxRelative"))
        if (!Number.isSafeInteger(maxRelative) || maxRelative <= 0) throw new SetupRefusal("richiesta non valida: maxRelative")
        // the wizard's choice -> the effective destination it shows for confirmation (the only command that may propose one)
        const check = resolveInstallDir({ installDir: required(request, "installDir"), version: required(request, "version"), maxRelative, env: deps.env }, deps.writeProbe)
        return [["canonical", check.canonical], ["mode", check.mode], ["installedVersion", check.installedVersion ?? ""], ["previousProfile", check.previousProfile ?? ""], ["adjusted", check.adjusted ?? ""], ["outsideProfile", check.outsideProfile ? "yes" : "no"]]
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
        // a payloadInventory path in the request is never used: the payload is the one this helper runs from;
        // sessionTransactionId only correlates (a journal of another transaction is refused), it authorises nothing
        const { outcome, registry } = txRecover({ installDir: required(request, "installDir"), env: deps.env, session: request.get("sessionTransactionId") || null }, txDeps(deps))
        return [["outcome", outcome], ...(outcome === "registry-restore" && registry !== null ? registryInstructions(registry) : [])]
    },
    "tx-recover-finish": (request, deps) => {
        txRecoverFinish({ installDir: required(request, "installDir"), env: deps.env, registryRestored: flag(request, "registryRestored"), session: request.get("sessionTransactionId") || null }, txDeps(deps))
        return [["outcome", "rolled-back"]]
    },
    "tx-begin": (request, deps) => {
        // the mode the user confirmed in the wizard is part of the contract: never optional, never a proof of anything;
        // the directory and its record are checked again here, and a directory that changed since then is not used
        const expectMode = required(request, "expectMode")
        if (!(INSTALL_MODES as readonly string[]).includes(expectMode)) throw new SetupRefusal(`richiesta non valida: expectMode deve essere ${INSTALL_MODES.join(", ")}`)
        const check = installCheckOf(request, deps)
        if (expectMode !== check.mode) throw new SetupRefusal(`la cartella di installazione è cambiata dopo la conferma (attesa: ${expectMode}, trovata: ${check.mode}): installazione non avviata, nulla è stato cambiato. Esegui di nuovo il setup`)
        const installDir = check.canonical
        const sha = required(request, "bundleSha256")
        if (!/^[0-9a-f]{64}$/.test(sha)) throw new SetupRefusal("richiesta non valida: bundleSha256")
        const profileDir = checkProfile(required(request, "profileDir"), installDir).canonical
        const journal = txBegin(txDeps(deps), { installDir, version: required(request, "version"), maxRelative: Number(request.get("maxRelative") ?? "0"), bundleSha256: sha, profileDir, env: deps.env })
        return [["transactionId", journal.transactionId]]
    },
    "tx-prepare": (request, deps) => {
        const installDir = installRoot(required(request, "installDir"), deps.env)
        const transactionId = required(request, "transactionId")
        // what NSIS staged is noted first (change detection for the later steps)
        txStage(installDir, transactionId)
        txPrepare(installDir, transactionId, parseRegistryBackup(request), txDeps(deps))
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
        txCommit(installRoot(required(request, "installDir"), deps.env), required(request, "transactionId"), flag(request, "registryWritten"), txDeps(deps))
        return []
    },
    "tx-cleanup": (request, deps) => {
        // the request is tx-commit's: its transaction id must be the journal's (correlation only)
        txCleanup(installRoot(required(request, "installDir"), deps.env), txDeps(deps), request.get("transactionId") || null)
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
    // <root>\setup\installer\setup\fr-setup.js: <root> holds the payload's installer-files.json ($PLUGINSDIR\helper, or an installed tree)
    const payloadRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
    process.exitCode = await main(process.argv.slice(2), { env: process.env, exec: execFile, selfTest: runSelfTest, now: () => new Date(), payloadRoot })
}
