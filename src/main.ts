#!/usr/bin/env node
/**
 * Entry point: validate the profile, verify the database, probe the settings,
 * then serve MCP over stdio. stdout carries only JSON-RPC; diagnostics go to
 * stderr through log.ts. Any startup failure exits with code 1 before stdio
 * is served, without writing to stdout.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { resolveProfile, selectProfileInput } from "./config/profile.js"
import { closeAllConnections, DatabaseAccess, fileLock } from "./db/connection.js"
import { verifyDatabase } from "./db/schema.js"
import { toSafeError } from "./errors.js"
import { logEvent } from "./log.js"
import { createServer } from "./server.js"
import { readSettings } from "./settings/read-settings.js"
import { createToolContext, type ToolContext } from "./tools/context.js"

/** Backstop: exit even if some handle keeps the event loop alive. */
const FORCED_EXIT_MS = 1000

function installFatalHandlers(): void {
    const fatal = (error: unknown): void => {
        const safe = toSafeError(error)
        logEvent("fatal", { code: safe.code })
        closeAllConnections()
        // Exiting closes every handle of this process, Win32 lock handles included.
        process.exit(1)
    }
    process.on("uncaughtException", fatal)
    process.on("unhandledRejection", fatal)
}

async function probeSettings(configPath: string, directory: string): Promise<void> {
    try {
        const settings = await readSettings(configPath, directory)
        const status = (s: { ok: boolean; code?: string }): string => (s.ok ? "ok" : (s.code ?? "error"))
        logEvent("settings_ok", {
            sourceGroups: status(settings.sourceGroups),
            sourceRules: status(settings.sourceRules),
            nextGroupId: status(settings.nextGroupId),
            dbVersion: status(settings.dbVersion),
        })
    } catch (error) {
        // Settings failures are per call, not fatal: they may be transient.
        const safe = toSafeError(error)
        logEvent("settings_unavailable", { code: safe.code, ...(safe.reason && { reason: safe.reason }) })
    }
}

async function main(): Promise<void> {
    installFatalHandlers()

    let context: ToolContext
    try {
        const profile = resolveProfile(selectProfileInput(process.argv.slice(2), process.env))
        logEvent("profile_ok", {
            canonicalPathDiffers: profile.canonicalPathDiffers,
            hardLinkWarning: profile.hardLinkWarning,
        })
        const database = new DatabaseAccess(profile.databasePath)
        const capabilities = await database.withReadConnection(verifyDatabase)
        logEvent("database_ok", { sqliteVersion: capabilities.sqliteVersion, encoding: capabilities.encoding })
        await probeSettings(profile.configPath, profile.directory)
        context = createToolContext({ database, configPath: profile.configPath, profileDir: profile.directory })
    } catch (error) {
        const safe = toSafeError(error)
        logEvent("startup_failed", { code: safe.code, ...(safe.reason && { reason: safe.reason }) })
        closeAllConnections()
        fileLock().close()
        process.exitCode = 1
        return
    }

    const handle = serveStdio(() => createServer(context), {
        onerror: (error) => logEvent("transport_error", { kind: error.name }),
    })
    logEvent("serving")

    let shuttingDown = false
    const shutdown = (reason: string): void => {
        if (shuttingDown) return
        shuttingDown = true
        logEvent("shutdown", { reason })
        closeAllConnections()
        fileLock().close()
        setTimeout(() => process.exit(0), FORCED_EXIT_MS).unref()
        handle
            .close()
            .catch(() => undefined)
            .finally(() => {
                process.stdin.pause()
                process.exitCode = 0
            })
    }

    process.stdin.once("end", () => shutdown("stdin-end"))
    process.stdin.once("close", () => shutdown("stdin-close"))
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
        process.once(signal, () => shutdown(signal))
    }
}

void main()
