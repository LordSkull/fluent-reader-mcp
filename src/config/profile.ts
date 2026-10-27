/**
 * Explicit Fluent Reader profile configuration (FR-MCP-01, D-11 and §13.2).
 *
 * - One input only: `--profile-dir <absolute path>` or FLUENT_READER_PROFILE_DIR.
 * - No autodiscovery, no separate --db/--config overrides, no defaults.
 * - The directory is canonicalized once; links and junctions in the directory
 *   or its ancestors are accepted if the canonical target is local.
 * - fluent-reader.db and config.json must be regular files, not links, whose
 *   real path is inside the canonical directory.
 * - Nothing is ever created. Every failure is a PROFILE_UNAVAILABLE error
 *   whose message carries no path.
 */

import fs from "node:fs"
import path from "node:path"
import { FrMcpError, systemErrorCode, type ErrorReason } from "../errors.js"

export const PROFILE_ARG = "--profile-dir"
export const PROFILE_ENV_VAR = "FLUENT_READER_PROFILE_DIR"
export const DB_FILE_NAME = "fluent-reader.db"
export const CONFIG_FILE_NAME = "config.json"

export interface ProfilePaths {
    /** Canonical (real) path of the profile directory. */
    readonly directory: string
    readonly databasePath: string
    readonly configPath: string
    /** The canonical directory differs from the path that was given. */
    readonly canonicalPathDiffers: boolean
    /** A profile file reports more than one hard link (warning only). */
    readonly hardLinkWarning: boolean
}

const isWindows = process.platform === "win32"

function fail(reason: ErrorReason): never {
    throw new FrMcpError("PROFILE_UNAVAILABLE", reason)
}

/**
 * Selects the single profile directory input from the command line and the
 * environment. Any other argument, a repeated flag, or a conflicting
 * environment value is rejected.
 */
export function selectProfileInput(
    argv: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
): string {
    let fromArgs: string | undefined
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string
        let value: string | undefined
        if (arg === PROFILE_ARG) {
            value = argv[i + 1]
            i++
            if (value === undefined || value.startsWith("--")) fail("invalid-argument")
        } else if (arg.startsWith(`${PROFILE_ARG}=`)) {
            value = arg.slice(PROFILE_ARG.length + 1)
        } else {
            fail("invalid-argument")
        }
        if (fromArgs !== undefined) fail("ambiguous")
        if (value.length === 0) fail("invalid-argument")
        fromArgs = value
    }
    const envValue = env[PROFILE_ENV_VAR]
    const fromEnv = envValue !== undefined && envValue.length > 0 ? envValue : undefined
    if (fromArgs !== undefined && fromEnv !== undefined && fromArgs !== fromEnv) fail("ambiguous")
    const selected = fromArgs ?? fromEnv
    if (selected === undefined) fail("not-configured")
    return selected
}

type PathClass = "local" | "network" | "device" | "relative"

/**
 * Purely lexical classification, done before any filesystem call so that a
 * network path is never touched.
 */
function classifyPath(p: string): PathClass {
    if (p.includes("\0")) return "relative"
    if (!isWindows) return path.isAbsolute(p) ? "local" : "relative"
    if (/^[\\/]{2}[?.][\\/]/.test(p)) {
        // \\?\X:\... is a local drive path in long form; \\?\UNC\..., \\.\...,
        // \\?\Volume{...}\... are not accepted.
        if (/^[\\/]{2}\?[\\/][A-Za-z]:[\\/]/.test(p)) return "local"
        if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(p)) return "network"
        return "device"
    }
    if (/^[\\/]{2}/.test(p)) return "network"
    if (/^[A-Za-z]:[\\/]/.test(p)) return "local"
    return "relative"
}

function stripLongPrefix(p: string): string {
    return isWindows ? p.replace(/^[\\/]{2}\?[\\/](?=[A-Za-z]:[\\/])/, "") : p
}

function samePath(a: string, b: string): boolean {
    return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b
}

function checkProfileFile(
    directory: string,
    name: string,
    missing: ErrorReason,
): { path: string; hardLinked: boolean } {
    const filePath = path.join(directory, name)
    let stats: fs.BigIntStats
    try {
        stats = fs.lstatSync(filePath, { bigint: true })
    } catch (error) {
        const code = systemErrorCode(error)
        fail(code === "ENOENT" || code === "ENOTDIR" ? missing : "inaccessible")
    }
    if (stats.isSymbolicLink()) fail("linked-file")
    if (!stats.isFile()) fail("not-regular-file")
    let real: string
    try {
        real = fs.realpathSync.native(filePath)
    } catch {
        fail("inaccessible")
    }
    if (!samePath(path.dirname(real), directory) || !samePath(path.basename(real), name)) {
        fail("outside-profile")
    }
    return { path: filePath, hardLinked: stats.nlink > 1n }
}

/** Validates the profile directory and its two files. Creates nothing. */
export function resolveProfile(input: string): ProfilePaths {
    const inputClass = classifyPath(input)
    if (inputClass === "relative") fail("not-absolute")
    if (inputClass === "network") fail("network-path")
    if (inputClass === "device") fail("not-local")

    const given = path.resolve(stripLongPrefix(input))
    let directory: string
    try {
        directory = fs.realpathSync.native(given)
    } catch (error) {
        const code = systemErrorCode(error)
        fail(code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "inaccessible")
    }
    directory = stripLongPrefix(directory)
    const canonicalClass = classifyPath(directory)
    if (canonicalClass === "network") fail("network-path")
    if (canonicalClass !== "local") fail("not-local")

    let stats: fs.Stats
    try {
        stats = fs.statSync(directory)
    } catch {
        fail("inaccessible")
    }
    if (!stats.isDirectory()) fail("not-directory")

    const database = checkProfileFile(directory, DB_FILE_NAME, "db-missing")
    const config = checkProfileFile(directory, CONFIG_FILE_NAME, "config-missing")

    return {
        directory,
        databasePath: database.path,
        configPath: config.path,
        canonicalPathDiffers: !samePath(given, directory),
        hardLinkWarning: database.hardLinked || config.hardLinked,
    }
}
