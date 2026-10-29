/**
 * FR-MCP-04-BETA-01: the Windows x64 portable package builder.
 *
 * Steps (every failure stops the build; nothing is overwritten):
 *  1. checks: Windows x64, package.json/lock versions, pinned runtime lock,
 *     build-machine prerequisites (Node 24, git, npm CLI, TypeScript), clean
 *     git tree; output paths checked on their CANONICAL form (links and
 *     junctions resolved): outside the repository, runtime cache disjoint
 *     from work/staging/verification/artifacts, nothing already existing;
 *  2. runtime: the pinned official Node ZIP, from cache or nodejs.org, kept
 *     only if its SHA-256 equals the pin; node.exe and LICENSE extracted;
 *  3. server: compiled from the sources with the repository's TypeScript
 *     directly into the staging (only .js, no source maps);
 *  4. dependencies: `npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64`
 *     in a separate directory, with npm user/global config, cache and logs
 *     confined to <work>/npm (the repository's node_modules is checked to be
 *     untouched), the installed set compared with package-lock.json, then
 *     copied without .bin and .package-lock.json;
 *  5. licences, PACKAGING-INFO.md, forbidden-content scan, manifest;
 *  6. ZIP (deterministic), read back, extracted, every file checked against
 *     the manifest, and the extracted runtime started on a synthetic profile;
 *  7. phase A: ZIP, .sha256 and build report prepared under ".partial"
 *     names, each created exclusively and registered as this build's (only
 *     registered files are ever removed), work directory removed (kept with
 *     --keep-work);
 *  8. phase B: ordered promotion to the final names with hard links (never
 *     overwriting), with rollback of everything this run promoted if any
 *     step fails.
 * --dry-run performs step 1 and checks the runtime cache, then stops: the
 * builder downloads nothing and writes nothing.
 */

import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { BuildError, canonicalPath, childEnv, copyFile, listFiles, overlaps, pathExists, safeJoin, samePath, sha256File, sha256FileSync, type ExecFn } from "./common.js"
import {
    artifactName,
    assertProductionSet,
    assertServerDist,
    buildManifest,
    collectLicenses,
    ENTRYPOINT,
    expectedProductionPackages,
    forbiddenFiles,
    INFO,
    installedPackages,
    KOFFI_NATIVE,
    MANIFEST,
    PACKAGE_ROOT,
    packagingInfo,
    PRODUCT_ID,
    RUNTIME_EXE,
    serverPackageJson,
    verifyManifest,
    type Manifest,
} from "./package-content.js"
import { acquireRuntimeArchive, extractRuntime, type FetchFn } from "./runtime.js"
import { parseRuntimeLock, satisfiesRange, type RuntimeLock } from "./runtime-lock.js"
import { runtimeIdentity, type SelfTestFn } from "./selftest.js"
import { readZip, zipBytes } from "./zip.js"

export interface BuildOptions {
    readonly repoRoot: string
    readonly outDir: string
    readonly runtimeCache?: string | undefined
    readonly dryRun: boolean
    readonly allowDirty: boolean
    readonly keepWork: boolean
}

export interface BuildDeps {
    readonly platform: string
    readonly arch: string
    /** The Node.js running the builder (compiles and runs npm; never shipped). */
    readonly nodeExecPath: string
    readonly nodeVersion: string
    readonly env: NodeJS.ProcessEnv
    readonly fetch: FetchFn
    readonly exec: ExecFn
    readonly selfTest: SelfTestFn
    readonly log: (line: string) => void
    /** Called at the named steps of the publication; tests throw from it to inject faults. */
    readonly checkpoint?: (step: CheckpointStep) => void
}

export type CheckpointStep = "before-zip" | "zip-prepared" | "cleanup-work" | "before-publish" | `promote:${ArtifactKind}`
export type ArtifactKind = "zip" | "exe" | "sha256" | "report"

export interface BuildResult {
    readonly dryRun: boolean
    readonly zipPath: string
    readonly sha256: string | null
    readonly manifest: Manifest | null
    readonly warnings: string[]
}

interface ProjectPackage {
    readonly name: string
    readonly version: string
    readonly license?: string
    readonly engines: { node: string }
    readonly dependencies: Record<string, string>
}

export function assertBuildPlatform(platform: string, arch: string): void {
    if (platform !== "win32" || arch !== "x64") throw new BuildError(`the portable package is built on Windows x64 only (this machine: ${platform} ${arch})`)
}

function readJson(file: string, what: string): unknown {
    if (!fs.existsSync(file)) throw new BuildError(`${what} not found: ${file}`)
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as unknown
    } catch {
        throw new BuildError(`${what} is not valid JSON`)
    }
}

function readProject(repoRoot: string): { pkg: ProjectPackage; lockText: string; lock: RuntimeLock } {
    const pkg = readJson(path.join(repoRoot, "package.json"), "package.json") as Partial<ProjectPackage>
    if (pkg.name !== PRODUCT_ID) throw new BuildError(`package.json name is ${String(pkg.name)}, expected ${PRODUCT_ID}`)
    if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
        throw new BuildError("package.json version must be MAJOR.MINOR.PATCH (no versioning policy for pre-release tags has been decided)")
    }
    if (typeof pkg.engines?.node !== "string" || typeof pkg.dependencies !== "object") throw new BuildError("package.json needs engines.node and dependencies")
    const lockPath = path.join(repoRoot, "package-lock.json")
    if (!fs.existsSync(lockPath)) throw new BuildError("package-lock.json not found")
    const lockText = fs.readFileSync(lockPath, "utf8")
    const root = (JSON.parse(lockText) as { packages?: Record<string, { version?: string; dependencies?: unknown }> }).packages?.[""]
    if (root?.version !== pkg.version || !isDeepStrictEqual(root.dependencies, pkg.dependencies)) throw new BuildError("package-lock.json is out of date with package.json")
    const lock = parseRuntimeLock(readJson(path.join(repoRoot, "installer", "runtime-lock.json"), "installer/runtime-lock.json"), pkg.engines.node)
    return { pkg: pkg as ProjectPackage, lockText, lock }
}

function resolveNpmCli(deps: BuildDeps): string {
    const candidates = [deps.env.npm_execpath, path.join(path.dirname(deps.nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js")]
    for (const candidate of candidates) {
        if (typeof candidate === "string" && path.isAbsolute(candidate) && /npm-cli\.js$/i.test(candidate) && fs.existsSync(candidate)) return candidate
    }
    throw new BuildError("npm-cli.js not found: run the builder with `npm.cmd run package:win` from a standard Node.js 24 installation")
}

function run(deps: BuildDeps, file: string, args: readonly string[], cwd: string, what: string, env = childEnv(deps.env), hint = ""): string {
    const result = deps.exec(file, args, { cwd, env })
    if (result.error !== undefined) throw new BuildError(`${what}: could not start ${path.basename(file)} (${result.error.message})`)
    if (result.status !== 0) throw new BuildError(`${what} failed (exit ${String(result.status)}): ${result.stderr.trim().split(/\r?\n/).slice(-5).join(" | ")}${hint}`)
    return result.stdout
}

/** The only registry used for the production dependencies. */
export const NPM_REGISTRY = "https://registry.npmjs.org/"

export interface NpmIsolation {
    readonly userconfig: string
    readonly globalconfig: string
    readonly cache: string
    readonly logsDir: string
    /** Synthetic home (HOME, USERPROFILE, APPDATA, LOCALAPPDATA) and temporary directory given to npm. */
    readonly home: string
    readonly tmp: string
}

/**
 * npm configuration confined to <work>/npm: its own user and global npmrc
 * (only the public registry and quiet defaults), cache, logs, home and
 * temporary directory. No personal .npmrc, global npmrc, cache, proxy or
 * certificate is read or written.
 */
export function prepareNpmIsolation(work: string): NpmIsolation {
    const base = path.join(work, "npm")
    const isolation = {
        userconfig: path.join(base, "user.npmrc"),
        globalconfig: path.join(base, "global.npmrc"),
        cache: path.join(base, "cache"),
        logsDir: path.join(base, "logs"),
        home: path.join(base, "home"),
        tmp: path.join(base, "tmp"),
    }
    for (const dir of [isolation.cache, isolation.logsDir, path.join(isolation.home, "AppData", "Roaming"), path.join(isolation.home, "AppData", "Local"), isolation.tmp]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(isolation.userconfig, `registry=${NPM_REGISTRY}\naudit=false\nfund=false\nupdate-notifier=false\n`, { flag: "wx" })
    fs.writeFileSync(isolation.globalconfig, "", { flag: "wx" })
    return isolation
}

export function npmCiArgs(npmCli: string, prefix: string, isolation: NpmIsolation): string[] {
    return [
        npmCli, "ci", "--omit=dev", "--ignore-scripts", "--os=win32", "--cpu=x64", "--no-audit", "--no-fund", "--no-update-notifier",
        "--prefix", prefix,
        "--userconfig", isolation.userconfig,
        "--globalconfig", isolation.globalconfig,
        "--cache", isolation.cache,
        "--logs-dir", isolation.logsDir,
        "--registry", NPM_REGISTRY,
    ]
}

/** System variables Node and npm need on Windows (sockets, child processes); copied only if absolute paths. */
const NPM_SYSTEM_ENV = ["SystemRoot", "WINDIR", "ComSpec"] as const

/**
 * The whole environment of npm, built from an allowlist instead of copying
 * the parent's: the system variables above, a minimal PATH (the build
 * machine's Node and the Windows system directories), PATHEXT, and a
 * synthetic home and TEMP under <work>/npm. Nothing else of the parent (tokens,
 * git, proxy, certificate, npm_* or arbitrary variables) reaches npm.
 */
export function npmEnv(parent: NodeJS.ProcessEnv, nodeExecPath: string, isolation: NpmIsolation): NodeJS.ProcessEnv {
    const lookup = (name: string): string | undefined => Object.entries(parent).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    const env: NodeJS.ProcessEnv = {}
    for (const name of NPM_SYSTEM_ENV) {
        const value = lookup(name)
        if (value !== undefined && path.win32.isAbsolute(value)) env[name] = value
    }
    const systemRoot = env.SystemRoot
    env.PATH = [path.dirname(nodeExecPath), ...(systemRoot === undefined ? [] : [path.join(systemRoot, "System32"), systemRoot])].join(path.delimiter)
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD"
    env.HOME = isolation.home
    env.USERPROFILE = isolation.home
    env.APPDATA = path.join(isolation.home, "AppData", "Roaming")
    env.LOCALAPPDATA = path.join(isolation.home, "AppData", "Local")
    env.TEMP = isolation.tmp
    env.TMP = isolation.tmp
    return env
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function fileIdentity(stats: fs.BigIntStats): string {
    return `${stats.dev}:${stats.ino}`
}

type Ownership = "temporary" | "final"

/**
 * The files this build created in --out. A file becomes the build's only
 * when its exclusive creation succeeded (open "wx", or a hard link, which
 * also fails if the name exists): a name that merely did not exist at the
 * preflight, or whose creation failed with EEXIST, is never the build's.
 * Only registered files are removed, and only while they are still the same
 * file (volume and file id) the build created.
 */
export class OwnedFiles {
    private readonly entries = new Map<string, { readonly ownership: Ownership; readonly identity: string }>()

    /** Creates `file` exclusively and writes `data`; the file is registered as soon as its creation succeeded. */
    create(file: string, data: string | Uint8Array): void {
        let fd: number
        try {
            fd = fs.openSync(file, "wx")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BuildError(`already exists, nothing is overwritten: ${file}`)
            throw error
        }
        try {
            this.entries.set(file, { ownership: "temporary", identity: fileIdentity(fs.fstatSync(fd, { bigint: true })) })
            fs.writeFileSync(fd, data)
        } finally {
            fs.closeSync(fd)
        }
    }

    /** Registers a final name this build has just created with a hard link. */
    adoptFinal(file: string): void {
        this.entries.set(file, { ownership: "final", identity: fileIdentity(fs.lstatSync(file, { bigint: true })) })
    }

    owns(file: string): boolean {
        return this.entries.has(file)
    }

    /** Registered files of one kind, most recently registered first. */
    list(ownership: Ownership): string[] {
        return [...this.entries].filter(([, entry]) => entry.ownership === ownership).map(([file]) => file).reverse()
    }

    /**
     * Removes a registered file if it is still the one this build created,
     * and updates the registry. Returns null, or why the file was left in place.
     */
    remove(file: string, unlink: (file: string) => void = fs.unlinkSync): string | null {
        const entry = this.entries.get(file)
        if (entry === undefined) return `${file} (not created by this build: left in place)`
        let stats: fs.BigIntStats
        try {
            stats = fs.lstatSync(file, { bigint: true })
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `${file} (${errorText(error)})`
            this.entries.delete(file)
            return null
        }
        if (fileIdentity(stats) !== entry.identity) {
            this.entries.delete(file)
            return `${file} (replaced by another file since this build created it: left in place)`
        }
        try {
            unlink(file)
        } catch (error) {
            return `${file} (${errorText(error)})`
        }
        this.entries.delete(file)
        return null
    }
}

export interface PromoteOps {
    /** Creates `newPath` as a hard link to `existing`; fails with EEXIST, without touching it, if `newPath` exists. */
    readonly link: (existing: string, newPath: string) => void
    readonly unlink: (file: string) => void
    readonly checkpoint: (step: CheckpointStep) => void
}

/** Fails early, in a directory of the build, if the output volume cannot hold the hard links the promotion needs. */
export function assertHardLinks(dir: string, link: (existing: string, newPath: string) => void = fs.linkSync): void {
    const probe = path.join(dir, "hardlink-probe")
    fs.writeFileSync(probe, "", { flag: "wx" })
    try {
        link(probe, `${probe}.link`)
    } catch (error) {
        throw new BuildError(`the --out volume does not support hard links (${(error as NodeJS.ErrnoException).code ?? errorText(error)}): the publication needs them to never overwrite a file; choose --out on an NTFS volume`)
    }
    fs.unlinkSync(`${probe}.link`)
    fs.unlinkSync(probe)
}

/**
 * Phase B of the publication: each prepared file (owned by this build) gets
 * its final name through a hard link, which fails atomically with EEXIST if
 * the name exists, so a file that appears at any moment is never
 * overwritten; then the prepared name is removed. There is no fallback to
 * rename. If any step fails, the final names this call created are removed
 * (only while still the build's files); a rollback that cannot remove one
 * names it. The three files are not published in one transaction.
 */
export function promoteArtifacts(artifacts: readonly (readonly [ArtifactKind, string, string])[], owned: OwnedFiles, ops: PromoteOps): void {
    for (const [, prepared, final] of artifacts) {
        if (!owned.owns(prepared)) throw new BuildError(`not prepared by this build: ${prepared}`)
        if (pathExists(final)) throw new BuildError(`already exists, nothing is overwritten: ${final}`)
    }
    const promoted: string[] = []
    try {
        for (const [kind, prepared, final] of artifacts) {
            // Right before the link: no existence check follows, the link itself refuses an existing name.
            ops.checkpoint(`promote:${kind}`)
            try {
                ops.link(prepared, final)
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code === "EEXIST") throw new BuildError(`already exists, nothing is overwritten: ${final}`)
                throw new BuildError(`cannot create ${final} safely: the hard link failed (${code ?? errorText(error)}); --out must be on an NTFS volume, no overwriting fallback is used`)
            }
            owned.adoptFinal(final)
            promoted.push(final)
            const problem = owned.remove(prepared, ops.unlink)
            if (problem !== null) throw new BuildError(`could not remove the prepared file once published: ${problem}`)
        }
    } catch (error) {
        const problems = promoted.reverse().map((final) => owned.remove(final, ops.unlink)).filter((problem) => problem !== null)
        if (problems.length > 0) throw new BuildError(`publication failed (${errorText(error)}) and the ROLLBACK FAILED: check these files by hand: ${problems.join("; ")}`)
        throw new BuildError(`publication failed (${errorText(error)}); every artifact published by this run was removed`)
    }
}

interface Prerequisites {
    readonly npmCli: string
    readonly tsc: string
}

function prerequisites(repoRoot: string, pkg: ProjectPackage, deps: BuildDeps): Prerequisites {
    if (!satisfiesRange(deps.nodeVersion.replace(/^v/, ""), pkg.engines.node)) {
        throw new BuildError(`the builder needs Node.js ${pkg.engines.node} on the build machine (found ${deps.nodeVersion})`)
    }
    const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc")
    if (!fs.existsSync(tsc)) throw new BuildError("TypeScript not found in the repository: run `npm.cmd ci` in the repository first")
    const npmCli = resolveNpmCli(deps)
    run(deps, "git", ["--version"], repoRoot, "git (prerequisite)")
    return { npmCli, tsc }
}

interface GitState {
    readonly commit: string
    readonly dirty: boolean
    readonly epoch: number
}

function gitState(repoRoot: string, deps: BuildDeps): GitState {
    const commit = run(deps, "git", ["-C", repoRoot, "rev-parse", "HEAD"], repoRoot, "git rev-parse").trim()
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new BuildError("could not read the git commit")
    const dirty = run(deps, "git", ["-C", repoRoot, "status", "--porcelain=v1"], repoRoot, "git status").trim().length > 0
    const epoch = Number(run(deps, "git", ["-C", repoRoot, "log", "-1", "--format=%ct"], repoRoot, "git log").trim())
    if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new BuildError("could not read the commit date")
    return { commit, dirty, epoch }
}

interface Outputs {
    /** Canonical --out: every write goes through it. */
    readonly out: string
    readonly redirected: boolean
    readonly zipPath: string
    readonly shaPath: string
    readonly reportPath: string
    readonly work: string
    readonly stage: string
    readonly verify: string
    readonly cache: string
}

/** Prepared (temporary) name of a final artifact. */
export function preparedName(final: string): string {
    return `${final}.partial`
}

/**
 * Output layout from CANONICAL paths (links and junctions resolved), checked
 * before anything is downloaded or written: --out neither inside nor
 * containing the repository; the runtime cache disjoint from the repository,
 * the work, staging and verification directories and the artifacts; no
 * final or prepared artifact and no work directory already present.
 */
function outputs(options: BuildOptions, version: string): Outputs {
    if (!path.isAbsolute(options.outDir)) throw new BuildError("--out must be an absolute path")
    if (options.runtimeCache !== undefined && !path.isAbsolute(options.runtimeCache)) throw new BuildError("--runtime-cache must be an absolute path")
    const repo = canonicalPath(options.repoRoot)
    const out = canonicalPath(options.outDir)
    if (overlaps(out, repo)) throw new BuildError(`--out must be outside the repository and must not contain it (links and junctions resolved: ${out})`)
    const work = path.join(out, `work-${version}`)
    const stage = path.join(work, "stage", PACKAGE_ROOT)
    const verify = path.join(work, "verify")
    const zipPath = path.join(out, artifactName(version))
    const shaPath = `${zipPath}.sha256`
    const reportPath = `${zipPath}.build-report.json`
    const cache = canonicalPath(options.runtimeCache ?? path.join(out, "runtime-cache"))
    const protectedPaths: [string, string][] = [
        [repo, "the repository"],
        [work, "the work directory"],
        [stage, "the staging directory"],
        [verify, "the verification directory"],
        [zipPath, "the ZIP"],
        [shaPath, "the .sha256 file"],
        [reportPath, "the build report"],
        [preparedName(zipPath), "the prepared ZIP"],
        [preparedName(shaPath), "the prepared .sha256 file"],
        [preparedName(reportPath), "the prepared build report"],
    ]
    for (const [protectedPath, what] of protectedPaths) {
        if (overlaps(cache, protectedPath)) throw new BuildError(`--runtime-cache must not overlap ${what} (links and junctions resolved: ${cache})`)
    }
    for (const existing of [zipPath, shaPath, reportPath, preparedName(zipPath), preparedName(shaPath), preparedName(reportPath), work]) {
        if (pathExists(existing)) throw new BuildError(`already exists, nothing is overwritten: ${existing}`)
    }
    return { out, redirected: !samePath(out, options.outDir), zipPath, shaPath, reportPath, work, stage, verify, cache }
}

/** Copies a production node_modules tree, refusing links and leaving out .bin and the hidden lockfile. */
function copyNodeModules(source: string, destination: string): void {
    for (const file of listFiles(source)) {
        if (file === ".package-lock.json" || file.split("/").includes(".bin")) continue
        copyFile(safeJoin(source, file), safeJoin(destination, file))
    }
}

function fileHashOrNull(file: string): string | null {
    return fs.existsSync(file) ? sha256FileSync(file) : null
}

export async function buildPortable(options: BuildOptions, deps: BuildDeps): Promise<BuildResult> {
    const log = deps.log
    assertBuildPlatform(deps.platform, deps.arch)
    const { pkg, lockText, lock } = readProject(options.repoRoot)
    const tools = prerequisites(options.repoRoot, pkg, deps)
    const git = gitState(options.repoRoot, deps)
    if (git.dirty && !options.allowDirty) throw new BuildError("the git working tree has changes: commit them, or pass --allow-dirty (recorded in the manifest)")
    const out = outputs(options, pkg.version)
    const warnings: string[] = []
    if (git.dirty) warnings.push("built from a working tree with uncommitted changes (gitDirty: true)")
    if (pkg.license === undefined) warnings.push("package.json declares no license: decide the project licence (D-13) before any distribution")
    log(`${PRODUCT_ID} ${pkg.version} (${git.commit.slice(0, 12)}${git.dirty ? ", dirty" : ""}), runtime Node.js ${lock.version} ${lock.platform}`)
    log(`Output: ${out.zipPath}`)
    if (out.redirected) log(`Output: --out resolves (links, junctions or 8.3 names) to ${out.out}`)

    const cached = path.join(out.cache, lock.archive)
    if (options.dryRun) {
        if (fs.existsSync(cached)) {
            if ((await sha256File(cached)) !== lock.sha256) throw new BuildError(`cached ${lock.archive} does not match the pinned sha256: ${cached}`)
            log(`Dry run: cached runtime verified (${cached})`)
        } else {
            log(`Dry run: the runtime would be downloaded from ${lock.url} and checked against sha256 ${lock.sha256}`)
        }
        log("Dry run: all checks passed; the builder downloaded nothing and created no file")
        return { dryRun: true, zipPath: out.zipPath, sha256: null, manifest: null, warnings }
    }

    fs.mkdirSync(out.out, { recursive: true })
    fs.mkdirSync(out.work)
    const stage = out.stage
    const depsDir = path.join(out.work, "deps")
    const verifyDir = out.verify
    const partial = preparedName(out.zipPath)
    const owned = new OwnedFiles()
    const checkpoint = deps.checkpoint ?? (() => undefined)
    try {
        assertHardLinks(out.work)

        // 2. runtime
        const acquired = await acquireRuntimeArchive(lock, out.cache, deps.fetch, log)
        extractRuntime(lock, acquired.archivePath, path.join(stage, "runtime"))
        const identity = runtimeIdentity(safeJoin(stage, RUNTIME_EXE), (file, args) => deps.exec(file, args, { cwd: out.work, env: childEnv(deps.env) }))
        if (identity.version !== `v${lock.version}` || identity.platform !== "win32 x64") throw new BuildError(`runtime/node.exe reports ${identity.version} ${identity.platform}, expected v${lock.version} win32 x64`)
        log(`Runtime: node.exe ${identity.version} ${identity.platform}`)

        // 3. server
        const dist = path.join(stage, "server", "dist")
        run(deps, deps.nodeExecPath, [tools.tsc, "-p", path.join(options.repoRoot, "tsconfig.json"), "--outDir", dist, "--sourceMap", "false"], options.repoRoot, "TypeScript compilation")
        assertServerDist(listFiles(dist))
        fs.writeFileSync(path.join(stage, "server", "package.json"), serverPackageJson(pkg), { flag: "wx" })
        log("Server: compiled from the sources")

        // 4. dependencies
        fs.mkdirSync(depsDir)
        copyFile(path.join(options.repoRoot, "package.json"), path.join(depsDir, "package.json"))
        copyFile(path.join(options.repoRoot, "package-lock.json"), path.join(depsDir, "package-lock.json"))
        const repoState = [fileHashOrNull(path.join(options.repoRoot, "node_modules", ".package-lock.json")), fileHashOrNull(path.join(options.repoRoot, "package-lock.json"))]
        const npm = prepareNpmIsolation(out.work)
        run(deps, deps.nodeExecPath, npmCiArgs(tools.npmCli, depsDir, npm), depsDir, "npm ci (production dependencies)", npmEnv(deps.env, deps.nodeExecPath, npm),
            ` — npm ran with an isolated configuration (${NPM_REGISTRY} only; no personal .npmrc, proxy or certificates); a network that needs a private npm configuration is not supported by this builder. npm logs: ${npm.logsDir}`)
        const repoAfter = [fileHashOrNull(path.join(options.repoRoot, "node_modules", ".package-lock.json")), fileHashOrNull(path.join(options.repoRoot, "package-lock.json"))]
        if (!isDeepStrictEqual(repoState, repoAfter)) throw new BuildError("the repository's node_modules or package-lock.json changed during the dependency install: refused")
        assertProductionSet(installedPackages(path.join(depsDir, "node_modules")), expectedProductionPackages(lockText))
        copyNodeModules(path.join(depsDir, "node_modules"), path.join(stage, "server", "node_modules"))
        if (!fs.existsSync(safeJoin(stage, KOFFI_NATIVE))) throw new BuildError(`Koffi native module for win32 x64 missing: ${KOFFI_NATIVE}`)
        log("Dependencies: production set equal to package-lock.json, Koffi win32-x64 native module present")

        // 5. content
        fs.writeFileSync(path.join(stage, INFO), packagingInfo(pkg.version, lock), { flag: "wx" })
        const licenses = collectLicenses(stage)
        for (const record of licenses) if (record.status === "no-license-file") warnings.push(`no licence file in ${record.component} (declared ${String(record.declared)})`)
        const forbidden = forbiddenFiles(listFiles(stage))
        if (forbidden.length > 0) throw new BuildError(`forbidden content in the package: ${forbidden.join("; ")}`)
        const manifest = buildManifest(stage, { version: pkg.version, gitCommit: git.commit, gitDirty: git.dirty, sourceDateEpoch: git.epoch, lock, projectLicense: pkg.license ?? null, licenses })
        const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
        fs.writeFileSync(path.join(stage, MANIFEST), manifestText, { flag: "wx" })
        log(`Manifest: ${manifest.files.length} files`)

        // 6. archive and verification
        const files = listFiles(stage)
        const zip = zipBytes(files.map((file) => ({ name: `${PACKAGE_ROOT}/${file}`, data: fs.readFileSync(safeJoin(stage, file)) })), git.epoch)
        checkpoint("before-zip")
        owned.create(partial, zip)
        const entries = readZip(fs.readFileSync(partial))
        const names = entries.map((e) => e.name)
        if (!isDeepStrictEqual(names, files.map((file) => `${PACKAGE_ROOT}/${file}`))) throw new BuildError("the ZIP entries differ from the staging")
        for (const entry of entries) {
            const target = safeJoin(verifyDir, entry.name)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, entry.read(), { flag: "wx" })
        }
        const extracted = path.join(verifyDir, PACKAGE_ROOT)
        if (fs.readFileSync(path.join(extracted, MANIFEST), "utf8") !== manifestText) throw new BuildError("the extracted manifest differs from the staged one")
        const problems = verifyManifest(extracted, JSON.parse(manifestText))
        if (problems.length > 0) throw new BuildError(`the extracted package does not match its manifest: ${problems.join("; ")}`)
        log("Archive: read back and extracted; every file matches the manifest")
        for (const line of await deps.selfTest({ nodeExe: safeJoin(extracted, RUNTIME_EXE), entrypoint: safeJoin(extracted, ENTRYPOINT), env: deps.env })) log(line)

        checkpoint("zip-prepared")

        // 7. publication, phase A: every artifact prepared under a temporary name, work cleaned up
        const sha256 = await sha256File(partial)
        const report = {
            product: manifest.product,
            source: manifest.source,
            artifact: { file: path.basename(out.zipPath), sha256, files: manifest.files.length },
            runtime: { ...manifest.runtime, acquiredFrom: acquired.source },
            licenses: manifest.licenses,
            warnings,
            distribution: "private beta only: licence review required before any public distribution",
        }
        owned.create(preparedName(out.shaPath), `${sha256} *${path.basename(out.zipPath)}\n`)
        owned.create(preparedName(out.reportPath), `${JSON.stringify(report, null, 2)}\n`)
        if (!options.keepWork) {
            checkpoint("cleanup-work")
            fs.rmSync(out.work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
        checkpoint("before-publish")

        // 8. publication, phase B: ordered promotion with rollback
        promoteArtifacts(
            [["zip", partial, out.zipPath], ["sha256", preparedName(out.shaPath), out.shaPath], ["report", preparedName(out.reportPath), out.reportPath]],
            owned,
            { link: fs.linkSync, unlink: fs.unlinkSync, checkpoint },
        )
        log(`Package: ${out.zipPath}`)
        log(`SHA-256: ${sha256}`)
        for (const warning of warnings) log(`Warning: ${warning}`)
        return { dryRun: false, zipPath: out.zipPath, sha256, manifest, warnings }
    } catch (error) {
        // Only the temporary files whose exclusive creation succeeded in this run; a name that matches is not enough.
        const problems = owned.list("temporary").map((file) => owned.remove(file)).filter((problem) => problem !== null)
        if (problems.length > 0) log(`Cleanup: these temporary files of this build could not be removed, delete them by hand: ${problems.join("; ")}`)
        if (pathExists(out.work)) log(`Not published. Work directory kept for inspection, it is not an artifact (delete it before the next build): ${out.work}`)
        else log("Not published.")
        throw error
    }
}
