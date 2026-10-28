/**
 * FR-MCP-04-BETA-01: shared helpers of the Windows portable builder.
 * Paths are handled with node:path only; no command line is ever built as a
 * string, so spaces and Unicode in paths need no quoting.
 */

import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/** A build failure with a clear, actionable message. Nothing is published when it is thrown. */
export class BuildError extends Error {
    override readonly name = "BuildError"
}

export function sha256Bytes(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex")
}

/** Streaming SHA-256 of a file (the runtime archive is tens of MB). */
export async function sha256File(file: string): Promise<string> {
    const hash = crypto.createHash("sha256")
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer)
    return hash.digest("hex")
}

export function sha256FileSync(file: string): string {
    return sha256Bytes(fs.readFileSync(file))
}

/** Ordinal comparison, independent of locale: the inventory order must be stable everywhere. */
export function compareOrdinal(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

export function samePath(a: string, b: string): boolean {
    const x = path.resolve(a)
    const y = path.resolve(b)
    return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** Whether `child` is `parent` or inside it (lexically, case-insensitive on Windows). */
export function isInside(child: string, parent: string): boolean {
    const p = path.resolve(parent)
    const c = path.resolve(child)
    const relative = process.platform === "win32" ? path.relative(p.toLowerCase(), c.toLowerCase()) : path.relative(p, c)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Whether `a` and `b` are the same path or one contains the other. */
export function overlaps(a: string, b: string): boolean {
    return isInside(a, b) || isInside(b, a)
}

/** Whether something exists at `p`, a dangling link or junction included. */
export function pathExists(p: string): boolean {
    try {
        fs.lstatSync(p)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw new BuildError(`cannot inspect ${p}: ${(error as Error).message}`)
    }
}

/**
 * Canonical form of an absolute path that may not exist yet: its nearest
 * existing ancestor is resolved with realpath (links, junctions, 8.3 names,
 * letter case), then the missing segments are appended (they cannot be links,
 * since they do not exist). A dangling link on the way is refused.
 */
export function canonicalPath(p: string): string {
    if (!path.isAbsolute(p)) throw new BuildError(`not an absolute path: ${p}`)
    let current = path.resolve(p)
    const missing: string[] = []
    while (!pathExists(current)) {
        const parent = path.dirname(current)
        if (parent === current) throw new BuildError(`no existing ancestor for ${p}`)
        missing.unshift(path.basename(current))
        current = parent
    }
    let real: string
    try {
        real = fs.realpathSync.native(current)
    } catch {
        throw new BuildError(`cannot resolve ${current} (dangling link or junction, or not accessible)`)
    }
    return path.join(real, ...missing)
}

/**
 * Validates a package-relative path written with "/" separators: no empty,
 * "." or ".." segment, no backslash, drive, colon, NUL or leading slash.
 * Every file of the package and every ZIP entry name goes through it.
 */
export function assertRelativePath(relative: string): void {
    const bad =
        relative.length === 0 ||
        relative.includes("\\") ||
        relative.includes(":") ||
        relative.includes("\0") ||
        relative.startsWith("/") ||
        relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    if (bad) throw new BuildError(`unsafe package path: ${JSON.stringify(relative)}`)
}

/** Joins a validated relative path to `root` and checks the result stays inside it. */
export function safeJoin(root: string, relative: string): string {
    assertRelativePath(relative)
    const joined = path.join(root, ...relative.split("/"))
    if (!isInside(joined, root) || samePath(joined, root)) throw new BuildError(`path escapes its root: ${JSON.stringify(relative)}`)
    return joined
}

export function toPosix(relative: string): string {
    return relative.split(path.sep).join("/")
}

/**
 * Every regular file under `root`, as sorted "/"-separated relative paths.
 * Links and junctions are refused: the package must not reach outside its staging.
 */
export function listFiles(root: string): string[] {
    const files: string[] = []
    const walk = (dir: string, prefix: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
            const full = path.join(dir, entry.name)
            if (entry.isSymbolicLink()) throw new BuildError(`link in the package staging: ${relative}`)
            if (entry.isDirectory()) walk(full, relative)
            else if (entry.isFile()) files.push(relative)
            else throw new BuildError(`not a regular file in the package staging: ${relative}`)
        }
    }
    walk(root, "")
    for (const file of files) assertRelativePath(file)
    return files.sort(compareOrdinal)
}

/** Copies a file to `destination`, creating its parent directories. */
export function copyFile(source: string, destination: string): void {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
}

export interface ExecResult {
    readonly status: number | null
    readonly stdout: string
    readonly stderr: string
    readonly error?: Error | undefined
}

/** Runs an executable with an argument array, never through a shell. */
export type ExecFn = (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }) => ExecResult

export const execFile: ExecFn = (file, args, options) => {
    const result = spawnSync(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? 15 * 60_000,
    })
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error }
}

/**
 * Environment for child tools: npm_* variables inherited from `npm run` are
 * removed (npm_config_local_prefix would point npm at the repository), and
 * so are variables that change how Node or the server resolve modules or the
 * profile.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(env)) {
        const upper = key.toUpperCase()
        if (value === undefined || upper.startsWith("NPM_") || ["NODE_OPTIONS", "NODE_PATH", "FLUENT_READER_PROFILE_DIR", "INIT_CWD"].includes(upper)) continue
        result[key] = value
    }
    return result
}
