/**
 * FR-MCP-04-BETA-01 — Windows x64 portable package builder (owner-run).
 *
 *   npm.cmd run package:win -- --out <absolute dir> [--dry-run] [--runtime-cache <absolute dir>] [--allow-dirty] [--keep-work]
 *
 * See installer/PACKAGING.md. Compiled with the tests (tsconfig.test.json)
 * and run from dist-test/installer/build-portable.js.
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { BuildError, execFile } from "./lib/common.js"
import { buildPortable, type BuildOptions } from "./lib/pipeline.js"
import { runSelfTest } from "./lib/selftest.js"

const USAGE = "usage: npm.cmd run package:win -- --out <absolute dir> [--dry-run] [--runtime-cache <absolute dir>] [--allow-dirty] [--keep-work]"

/** dist-test/installer/build-portable.js → repository root. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

export function parseArgs(argv: readonly string[], repoRoot: string): BuildOptions {
    let outDir: string | undefined
    let runtimeCache: string | undefined
    const flags = new Set<string>()
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string
        if (arg === "--out" || arg === "--runtime-cache") {
            const value = argv[++i]
            if (value === undefined || value.startsWith("--")) throw new BuildError(`${arg} needs a value\n${USAGE}`)
            if (arg === "--out") outDir = value
            else runtimeCache = value
        } else if (["--dry-run", "--allow-dirty", "--keep-work"].includes(arg)) {
            flags.add(arg)
        } else {
            throw new BuildError(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`)
        }
    }
    if (outDir === undefined) throw new BuildError(`--out is required (choose a directory outside the repository)\n${USAGE}`)
    return { repoRoot, outDir, runtimeCache, dryRun: flags.has("--dry-run"), allowDirty: flags.has("--allow-dirty"), keepWork: flags.has("--keep-work") }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2), REPO_ROOT)
    await buildPortable(options, {
        platform: process.platform,
        arch: process.arch,
        nodeExecPath: process.execPath,
        nodeVersion: process.version,
        env: process.env,
        fetch: (url, init) => fetch(url, init),
        exec: execFile,
        selfTest: runSelfTest,
        log: (line) => process.stdout.write(`${line}\n`),
    })
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await main()
    } catch (error) {
        if (!(error instanceof BuildError)) throw error
        process.stderr.write(`package:win: ${error.message}\n`)
        process.exitCode = 1
    }
}
