/**
 * FR-MCP-04-BETA-02 — Windows x64 NSIS installer builder (owner-run).
 *
 *   npm.cmd run installer:win -- --bundle <portable ZIP> --bundle-sha256 <hex> --out <absolute dir>
 *       [--makensis <absolute path>] [--dry-run] [--allow-dirty] [--keep-work]
 *
 * See installer/INSTALLER.md. Compiled with the tests (tsconfig.test.json)
 * and run from dist-test/installer/build-installer.js.
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { BuildError, execFile } from "./lib/common.js"
import { buildInstaller, type InstallerOptions } from "./lib/installer-build.js"

const USAGE = "usage: npm.cmd run installer:win -- --bundle <portable ZIP> --bundle-sha256 <hex> --out <absolute dir> [--makensis <absolute path>] [--dry-run] [--allow-dirty] [--keep-work]"

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** dist-test/installer/build-installer.js → repository root and compiled root. */
const REPO_ROOT = path.resolve(HERE, "..", "..")
const COMPILED_ROOT = path.resolve(HERE, "..")

export function parseInstallerArgs(argv: readonly string[], repoRoot: string): InstallerOptions {
    const values = new Map<string, string>()
    const flags = new Set<string>()
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string
        if (["--bundle", "--bundle-sha256", "--out", "--makensis"].includes(arg)) {
            const value = argv[++i]
            if (value === undefined || value.startsWith("--")) throw new BuildError(`${arg} needs a value\n${USAGE}`)
            if (values.has(arg)) throw new BuildError(`${arg} given twice\n${USAGE}`)
            values.set(arg, value)
        } else if (["--dry-run", "--allow-dirty", "--keep-work"].includes(arg)) {
            flags.add(arg)
        } else {
            throw new BuildError(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`)
        }
    }
    for (const required of ["--bundle", "--bundle-sha256", "--out"]) if (!values.has(required)) throw new BuildError(`${required} is required\n${USAGE}`)
    return {
        repoRoot,
        bundle: values.get("--bundle") as string,
        bundleSha256: values.get("--bundle-sha256") as string,
        outDir: values.get("--out") as string,
        makensis: values.get("--makensis"),
        dryRun: flags.has("--dry-run"),
        allowDirty: flags.has("--allow-dirty"),
        keepWork: flags.has("--keep-work"),
    }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await buildInstaller(parseInstallerArgs(process.argv.slice(2), REPO_ROOT), {
            platform: process.platform,
            arch: process.arch,
            env: process.env,
            exec: execFile,
            log: (line) => process.stdout.write(`${line}\n`),
            compiledRoot: COMPILED_ROOT,
        })
    } catch (error) {
        if (!(error instanceof BuildError)) throw error
        process.stderr.write(`installer:win: ${error.message}\n`)
        process.exitCode = 1
    }
}
