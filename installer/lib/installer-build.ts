/**
 * FR-MCP-04-BETA-02: builder of the Windows x64 NSIS installer from an
 * APPROVED portable ZIP (FR-MCP-04-BETA-01). The server is not rebuilt.
 *
 * Steps (every failure stops the build; nothing is overwritten):
 *  1. checks: Windows x64; the bundle named for this repository's version,
 *     its .sha256 file and the SHA-256 given on the command line all equal
 *     to the bundle's hash; every ZIP entry read back (CRC, safe names);
 *     the manifest complete and equal to the entries (size, SHA-256), the
 *     runtime the pinned Node.js, the server entrypoint, the Koffi module,
 *     no forbidden content; output paths canonical, outside the repository;
 *     makensis.exe (NSIS 3, already installed by the owner: never
 *     downloaded) with the headers and plugins the script uses;
 *  2. payload in <out>\work-installer-<version>: the package extracted to
 *     current\app and checked again on disk, the setup helper (compiled
 *     modules it imports, nothing else) in current\setup, the inventory;
 *  3. makensis on installer\nsis\fluent-reader-mcp.nsi with a generated
 *     defines.nsh (values escaped for NSIS); arguments never pass a shell;
 *  4. publication as in the portable builder: .partial names created
 *     exclusively, then hard links to the final names, rollback on failure.
 * --dry-run performs step 1 only and writes nothing.
 */

import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { INVENTORY, buildInventory } from "../setup/app.js"
import { LAYOUT } from "../setup/checks.js"
import { helperCopyEntries } from "../setup/uninstall.js"
import { assertRelativePath, BuildError, canonicalPath, childEnv, compareOrdinal, listFiles, overlaps, pathExists, safeJoin, sha256Bytes, sha256File, type ExecFn } from "./common.js"
import { artifactName, ENTRYPOINT, forbiddenFiles, INFO, KOFFI_NATIVE, MANIFEST, PACKAGE_ROOT, PRODUCT_ID, PRODUCT_NAME, RUNTIME_EXE, TOOLS, verifyManifest, type Manifest } from "./package-content.js"
import { assertHardLinks, OwnedFiles, preparedName, promoteArtifacts, type CheckpointStep } from "./pipeline.js"
import { parseRuntimeLock } from "./runtime-lock.js"
import { readZip, type ZipEntry } from "./zip.js"

export interface InstallerOptions {
    readonly repoRoot: string
    readonly bundle: string
    readonly bundleSha256: string
    readonly outDir: string
    readonly makensis?: string | undefined
    readonly dryRun: boolean
    readonly allowDirty: boolean
    readonly keepWork: boolean
}

export interface InstallerDeps {
    readonly platform: string
    readonly arch: string
    readonly env: NodeJS.ProcessEnv
    readonly exec: ExecFn
    readonly log: (line: string) => void
    /** Root of the compiled modules (dist-test): the setup helper is copied from here. */
    readonly compiledRoot: string
    readonly checkpoint?: (step: CheckpointStep) => void
}

export interface InstallerResult {
    readonly dryRun: boolean
    readonly exePath: string
    readonly sha256: string | null
    readonly size: number | null
}

/** Entry of the setup helper, relative to the compiled root and to current\setup. */
export const SETUP_ENTRY = "installer/setup/fr-setup.js"
/** NSIS headers and plugins the script needs (checked before compiling). */
export const NSIS_REQUIREMENTS = ["Include/MUI2.nsh", "Include/nsDialogs.nsh", "Include/LogicLib.nsh", "Include/x64.nsh", "Include/WinVer.nsh", "Include/FileFunc.nsh", "Plugins/x86-unicode/nsExec.dll", "Plugins/x86-unicode/nsDialogs.dll", "Plugins/x86-unicode/System.dll"]

export function installerName(version: string): string {
    return `FluentReaderMCP-Setup-v${version}-beta-win-x64.exe`
}

/**
 * A double-quoted NSIS string. Characters NSIS would interpret ($ variables,
 * quotes, backticks, line breaks) are refused rather than escaped, so a path
 * is always used literally.
 */
export function nsisString(value: string): string {
    if (/["$`\r\n\0]/.test(value)) throw new BuildError(`value not usable in the NSIS script (no $, quotes, backticks or line breaks): ${JSON.stringify(value)}`)
    return `"${value}"`
}

function readProject(repoRoot: string): { version: string; enginesNode: string } {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { name?: string; version?: string; engines?: { node?: string } }
    if (pkg.name !== PRODUCT_ID || typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version) || typeof pkg.engines?.node !== "string") throw new BuildError("package.json: unexpected name, version or engines")
    return { version: pkg.version, enginesNode: pkg.engines.node }
}

/** Checks the bundle bytes in memory against its manifest and the expectations of this repository. */
export function checkBundleEntries(entries: readonly ZipEntry[], expect: { version: string; runtimeVersion: string; runtimeSha256: string }): { manifest: Manifest; files: Map<string, Buffer> } {
    const files = new Map<string, Buffer>()
    for (const entry of entries) {
        if (!entry.name.startsWith(`${PACKAGE_ROOT}/`)) throw new BuildError(`bundle entry outside ${PACKAGE_ROOT}/: ${entry.name}`)
        files.set(entry.name.slice(PACKAGE_ROOT.length + 1), entry.read())
    }
    const manifestBytes = files.get(MANIFEST)
    if (manifestBytes === undefined) throw new BuildError("the bundle has no manifest.json")
    let manifest: Manifest
    try {
        manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest
    } catch {
        throw new BuildError("the bundle manifest is not valid JSON")
    }
    const problems: string[] = []
    if (manifest.schemaVersion !== 1 || manifest.product?.id !== PRODUCT_ID) problems.push("not a fluent-reader-mcp manifest (schema 1)")
    if (manifest.product?.version !== expect.version) problems.push(`bundle version ${String(manifest.product?.version)}, expected ${expect.version}`)
    if (manifest.product?.channel !== "beta" || manifest.product?.platform !== "win-x64") problems.push("bundle is not the beta win-x64 package")
    if (manifest.runtime?.version !== expect.runtimeVersion || manifest.runtime?.archiveSha256 !== expect.runtimeSha256 || manifest.runtime?.executable !== RUNTIME_EXE) problems.push("bundle runtime differs from installer/runtime-lock.json")
    if (manifest.server?.entrypoint !== ENTRYPOINT || !isDeepStrictEqual(manifest.server?.tools, [...TOOLS])) problems.push("bundle server section differs (entrypoint or the eight tools)")
    const listed = Array.isArray(manifest.files) ? manifest.files : []
    const actual = [...files.keys()].filter((f) => f !== MANIFEST).sort(compareOrdinal)
    if (!isDeepStrictEqual(listed.map((f) => f.path), actual)) problems.push("bundle content differs from its manifest (files missing or not listed)")
    for (const f of listed) {
        const bytes = files.get(f.path)
        if (bytes !== undefined && (bytes.length !== f.size || sha256Bytes(bytes) !== f.sha256)) problems.push(`bundle file altered: ${f.path}`)
    }
    for (const required of [RUNTIME_EXE, ENTRYPOINT, "server/package.json", KOFFI_NATIVE, INFO, "licenses/node/LICENSE"]) if (!files.has(required)) problems.push(`bundle lacks ${required}`)
    const forbidden = forbiddenFiles(actual)
    if (forbidden.length > 0) problems.push(`forbidden content in the bundle: ${forbidden.join("; ")}`)
    if (problems.length > 0) throw new BuildError(`bundle refused: ${problems.slice(0, 5).join("; ")}`)
    return { manifest, files }
}

/**
 * helper-files.nsh: the exact files of the uninstaller's recovery copy of the
 * helper (state\uninstall-helper) and their directories, deepest first. The
 * uninstaller deletes them on its own, after the final marker, without the
 * helper and without any list read at run time.
 */
export function helperCopyNsh(entries: readonly string[]): string {
    const files = [...entries, INVENTORY]
    const dirs = new Set<string>()
    for (const f of files) for (let d = path.posix.dirname(f); d !== "."; d = path.posix.dirname(d)) dirs.add(d)
    const win = (p: string): string => {
        assertRelativePath(p)
        nsisString(p)
        return p.split("/").join("\\")
    }
    const lines = [
        "; generated by installer/lib/installer-build.ts: the files of the uninstaller's recovery copy of the helper",
        "!macro HelperCopyDelete",
        ...files.map((f) => `  !insertmacro DeleteHelperCopyFile "${win(f)}"`),
        ...[...dirs].sort((a, b) => b.split("/").length - a.split("/").length || compareOrdinal(a, b)).map((d) => `  !insertmacro RemoveHelperCopyDir "${win(d)}"`),
        "!macroend",
    ]
    return `﻿${lines.join("\r\n")}\r\n`
}

/** The compiled modules the setup helper imports (relative imports only), from its entry. */
export function setupClosure(compiledRoot: string): string[] {
    const seen = new Set<string>()
    const visit = (relative: string): void => {
        if (seen.has(relative)) return
        const file = safeJoin(compiledRoot, relative)
        if (!fs.existsSync(file)) throw new BuildError(`setup helper module missing (run the TypeScript build first): ${relative}`)
        seen.add(relative)
        const source = fs.readFileSync(file, "utf8")
        for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1] as string))
            if (target.startsWith("..")) throw new BuildError(`setup helper imports outside the compiled root: ${match[1] as string}`)
            visit(target)
        }
    }
    visit(SETUP_ENTRY)
    return [...seen].sort(compareOrdinal)
}

function resolveMakensis(options: InstallerOptions, deps: InstallerDeps): { exe: string; version: string } {
    const env = (name: string): string | undefined => Object.entries(deps.env).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1]
    const candidates = options.makensis !== undefined ? [options.makensis] : [env("ProgramFiles(x86)"), env("ProgramFiles")].filter((d): d is string => d !== undefined).map((d) => path.join(d, "NSIS", "makensis.exe"))
    const exe = candidates.find((c) => path.isAbsolute(c) && fs.existsSync(c))
    if (exe === undefined) throw new BuildError("makensis.exe (NSIS 3) not found: install NSIS 3 yourself, or pass --makensis <absolute path>; the builder never downloads it")
    const result = deps.exec(exe, ["/VERSION"], { cwd: path.dirname(exe), env: childEnv(deps.env), timeoutMs: 30_000 })
    const version = /^v(3\.\d+(?:\.\d+)?)/.exec(result.stdout.trim())?.[1]
    if (result.status !== 0 || version === undefined) throw new BuildError(`${exe} is not NSIS 3 (makensis /VERSION: ${result.stdout.trim().slice(0, 40)})`)
    const missing = NSIS_REQUIREMENTS.filter((r) => !fs.existsSync(path.join(path.dirname(exe), ...r.split("/"))))
    if (missing.length > 0) throw new BuildError(`the NSIS installation lacks ${missing.join(", ")} (a standard NSIS 3 installation includes them)`)
    return { exe, version }
}

function gitProvenance(repoRoot: string, deps: InstallerDeps): { commit: string; dirty: boolean } {
    const run = (args: string[]): string => {
        const r = deps.exec("git", ["-C", repoRoot, ...args], { cwd: repoRoot, env: childEnv(deps.env) })
        if (r.status !== 0) throw new BuildError(`git ${args[0] as string} failed`)
        return r.stdout
    }
    const commit = run(["rev-parse", "HEAD"]).trim()
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new BuildError("could not read the git commit")
    return { commit, dirty: run(["status", "--porcelain=v1"]).trim().length > 0 }
}

export async function buildInstaller(options: InstallerOptions, deps: InstallerDeps): Promise<InstallerResult> {
    const log = deps.log
    if (deps.platform !== "win32" || deps.arch !== "x64") throw new BuildError(`the installer is built on Windows x64 only (this machine: ${deps.platform} ${deps.arch})`)
    const { version, enginesNode } = readProject(options.repoRoot)
    const lock = parseRuntimeLock(JSON.parse(fs.readFileSync(path.join(options.repoRoot, "installer", "runtime-lock.json"), "utf8")), enginesNode)
    const git = gitProvenance(options.repoRoot, deps)
    if (git.dirty && !options.allowDirty) throw new BuildError("the git working tree has changes: commit them, or pass --allow-dirty (recorded in the build report)")

    // 1a. bundle identity: name, .sha256 file, explicit hash
    if (!path.isAbsolute(options.bundle)) throw new BuildError("--bundle must be an absolute path")
    const expected = options.bundleSha256.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new BuildError("--bundle-sha256 must be the 64-character SHA-256 of the bundle (from its .sha256 file or build output)")
    const bundle = canonicalPath(options.bundle)
    if (path.basename(bundle) !== artifactName(version)) throw new BuildError(`the bundle must be ${artifactName(version)} (the portable package of this repository's version)`)
    const bundleStats = fs.statSync(bundle, { throwIfNoEntry: false })
    if (bundleStats === undefined || !bundleStats.isFile()) throw new BuildError(`bundle not found: ${bundle}`)
    const shaFile = `${bundle}.sha256`
    if (!fs.existsSync(shaFile)) throw new BuildError(`the bundle's checksum file is missing: ${shaFile}`)
    const shaLine = /^([0-9a-f]{64}) \*(.+)\r?\n?$/.exec(fs.readFileSync(shaFile, "utf8"))
    if (shaLine === null || shaLine[2] !== path.basename(bundle)) throw new BuildError("the bundle's .sha256 file is not in the expected format")
    const bundleBytes = fs.readFileSync(bundle)
    const actualSha = sha256Bytes(bundleBytes)
    if (shaLine[1] !== actualSha) throw new BuildError("the bundle does not match its .sha256 file: refused")
    if (expected !== actualSha) throw new BuildError("the bundle does not match --bundle-sha256: refused")

    // 1b. bundle content
    const { manifest, files } = checkBundleEntries(readZip(bundleBytes), { version, runtimeVersion: lock.version, runtimeSha256: lock.sha256 })
    log(`Bundle: ${path.basename(bundle)} sha256 ${actualSha}, ${manifest.files.length} files, commit ${manifest.source.gitCommit.slice(0, 12)}${manifest.source.gitDirty ? " (dirty)" : ""}, Node.js ${manifest.runtime.version}`)

    // 1c. outputs
    if (!path.isAbsolute(options.outDir)) throw new BuildError("--out must be an absolute path")
    const repo = canonicalPath(options.repoRoot)
    const out = canonicalPath(options.outDir)
    if (overlaps(out, repo)) throw new BuildError(`--out must be outside the repository and must not contain it (links and junctions resolved: ${out})`)
    const work = path.join(out, `work-installer-${version}`)
    const exePath = path.join(out, installerName(version))
    const shaPath = `${exePath}.sha256`
    const reportPath = `${exePath}.build-report.json`
    if (overlaps(bundle, work)) throw new BuildError("the bundle must not be inside the work directory")
    // Paths that end up in the NSIS script must be literal there.
    nsisString(path.join(work, "payload", LAYOUT.current))
    nsisString(path.join(work, installerName(version)))
    for (const existing of [exePath, shaPath, reportPath, preparedName(exePath), preparedName(shaPath), preparedName(reportPath), work]) {
        if (pathExists(existing)) throw new BuildError(`already exists, nothing is overwritten: ${existing}`)
    }
    const closure = setupClosure(deps.compiledRoot)
    const template = path.join(options.repoRoot, "installer", "nsis", "fluent-reader-mcp.nsi")
    if (!fs.existsSync(template)) throw new BuildError("installer/nsis/fluent-reader-mcp.nsi not found")
    const nsis = resolveMakensis(options, deps)
    log(`NSIS: makensis ${nsis.version}`)
    log(`Output: ${exePath}`)
    if (options.dryRun) {
        log("Dry run: all checks passed; the builder wrote nothing and did not run makensis")
        return { dryRun: true, exePath, sha256: null, size: null }
    }

    fs.mkdirSync(out, { recursive: true })
    fs.mkdirSync(work)
    const owned = new OwnedFiles()
    const checkpoint = deps.checkpoint ?? (() => undefined)
    try {
        assertHardLinks(work)
        // 2. payload
        const current = path.join(work, "payload", LAYOUT.current)
        const app = path.join(current, "app")
        for (const [relative, bytes] of files) {
            const target = safeJoin(app, relative)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, bytes, { flag: "wx" })
        }
        const problems = verifyManifest(app, manifest)
        if (problems.length > 0) throw new BuildError(`the extracted bundle does not match its manifest: ${problems.slice(0, 5).join("; ")}`)
        const setup = path.join(current, "setup")
        for (const relative of closure) {
            const target = safeJoin(setup, relative)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.copyFileSync(safeJoin(deps.compiledRoot, relative), target, fs.constants.COPYFILE_EXCL)
        }
        fs.writeFileSync(path.join(setup, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`, { flag: "wx" })
        const forbidden = forbiddenFiles(listFiles(setup))
        if (forbidden.length > 0) throw new BuildError(`forbidden content in the setup helper: ${forbidden.join("; ")}`)
        const inventory = buildInventory(current, version)
        fs.writeFileSync(path.join(current, INVENTORY), `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" })
        const maxRelative = Math.max(...[...inventory.files.map((f) => f.path), INVENTORY].map((f) => `${LAYOUT.previous}\\${f.replace(/\//g, "\\")}`.length))
        log(`Payload: ${inventory.files.length} files (package ${manifest.files.length + 1}, setup helper ${closure.length + 1})`)

        // 3. NSIS
        const nsisDir = path.join(work, "nsis")
        fs.mkdirSync(nsisDir)
        fs.writeFileSync(path.join(nsisDir, "helper-files.nsh"), helperCopyNsh(helperCopyEntries(inventory.files.map((f) => f.path))), { flag: "wx" })
        fs.copyFileSync(template, path.join(nsisDir, "fluent-reader-mcp.nsi"), fs.constants.COPYFILE_EXCL)
        const built = path.join(work, installerName(version))
        const defines = [
            ["PRODUCT_NAME", PRODUCT_NAME], ["PRODUCT_VERSION", version], ["BUNDLE_SHA256", actualSha],
            ["PAYLOAD_DIR", current], ["OUTFILE", built], ["MAX_RELATIVE", String(maxRelative)],
            ["SETUP_ENTRY", `setup\\${SETUP_ENTRY.replace(/\//g, "\\")}`], ["NODE_VERSION", manifest.runtime.version],
        ].map(([name, value]) => `!define ${name as string} ${nsisString(value as string)}`)
        fs.writeFileSync(path.join(nsisDir, "defines.nsh"), `﻿; generated by installer/lib/installer-build.ts\r\n${defines.join("\r\n")}\r\n`, { flag: "wx" })
        const compile = deps.exec(nsis.exe, ["/V2", "/INPUTCHARSET", "UTF8", path.join(nsisDir, "fluent-reader-mcp.nsi")], { cwd: nsisDir, env: childEnv(deps.env), timeoutMs: 20 * 60_000 })
        if (compile.error !== undefined || compile.status !== 0) throw new BuildError(`makensis failed (exit ${String(compile.status)}): ${`${compile.stdout}\n${compile.stderr}`.trim().split(/\r?\n/).slice(-6).join(" | ")}`)
        const exeStats = fs.statSync(built, { throwIfNoEntry: false })
        if (exeStats === undefined || !exeStats.isFile() || exeStats.size === 0) throw new BuildError("makensis reported success but produced no installer")
        log(`NSIS: installer compiled (${exeStats.size} bytes)`)

        // 4. publication, phase A
        const exeBytes = fs.readFileSync(built)
        const sha256 = sha256Bytes(exeBytes)
        owned.create(preparedName(exePath), exeBytes)
        if ((await sha256File(preparedName(exePath))) !== sha256) throw new BuildError("the prepared installer differs from the compiled one")
        const report = {
            product: { id: PRODUCT_ID, name: PRODUCT_NAME, version, channel: "beta", platform: "win-x64" },
            installer: { file: path.basename(exePath), sha256, size: exeStats.size, nsis: nsis.version, scriptsCommit: git.commit, scriptsDirty: git.dirty },
            bundle: { file: path.basename(bundle), sha256: actualSha, files: manifest.files.length, source: manifest.source, runtime: { version: manifest.runtime.version, archiveSha256: manifest.runtime.archiveSha256 } },
            distribution: "private beta only: licence review required before any public distribution",
        }
        owned.create(preparedName(shaPath), `${sha256} *${path.basename(exePath)}\n`)
        owned.create(preparedName(reportPath), `${JSON.stringify(report, null, 2)}\n`)
        if (!options.keepWork) {
            checkpoint("cleanup-work")
            fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
        checkpoint("before-publish")
        // phase B
        promoteArtifacts(
            [["exe", preparedName(exePath), exePath], ["sha256", preparedName(shaPath), shaPath], ["report", preparedName(reportPath), reportPath]],
            owned,
            { link: fs.linkSync, unlink: fs.unlinkSync, checkpoint },
        )
        log(`Installer: ${exePath}`)
        log(`SHA-256: ${sha256}`)
        log(`Size: ${exeStats.size} bytes`)
        return { dryRun: false, exePath, sha256, size: exeStats.size }
    } catch (error) {
        const problems = owned.list("temporary").map((file) => owned.remove(file)).filter((problem) => problem !== null)
        if (problems.length > 0) log(`Cleanup: these temporary files of this build could not be removed, delete them by hand: ${problems.join("; ")}`)
        if (pathExists(work)) log(`Not published. Work directory kept for inspection, it is not an artifact (delete it before the next build): ${work}`)
        else log("Not published.")
        throw error
    }
}
