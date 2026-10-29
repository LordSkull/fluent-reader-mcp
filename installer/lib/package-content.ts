/**
 * Content rules of the portable package: what may be shipped, the expected
 * production dependency set, licence collection, the manifest and the
 * generated PACKAGING-INFO.md.
 */

import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { BuildError, compareOrdinal, copyFile, listFiles, safeJoin, sha256FileSync } from "./common.js"
import type { RuntimeLock } from "./runtime-lock.js"

export const PACKAGE_ROOT = "FluentReaderMCP"
export const PRODUCT_ID = "fluent-reader-mcp"
export const PRODUCT_NAME = "Fluent Reader MCP"
export const CHANNEL = "beta"
export const PLATFORM = "win-x64"
export const RUNTIME_EXE = "runtime/node.exe"
export const ENTRYPOINT = "server/dist/main.js"
export const MANIFEST = "manifest.json"
export const INFO = "PACKAGING-INFO.md"
/** P-INS-05; still subject to the owner's approval. */
export const DEFAULT_INSTALL_DIR = "%LOCALAPPDATA%\\FluentReaderMCP"
/** The eight read-only tools (FR-MCP-02A and list_articles of FR-MCP-02B-01), sorted; the self-test requires exactly these. */
export const TOOLS = ["get_article", "get_group", "get_rule_chain", "get_source", "list_articles", "list_groups", "list_rules", "list_sources"] as const
/** Top-level entries owned by the product (for a future uninstaller). */
export const OWNED_ENTRIES = ["runtime/", "server/", "licenses/", MANIFEST, INFO] as const
export const KOFFI_NATIVE = "server/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node"

export function artifactName(version: string): string {
    return `${PRODUCT_ID}-v${version}-${CHANNEL}-${PLATFORM}.zip`
}

/**
 * Files that must never be in the package. A match fails the build rather
 * than being silently dropped: the staging is assembled from an allowlist,
 * so a match means something unexpected reached it.
 */
const FORBIDDEN: readonly [RegExp, string][] = [
    [/(^|\/)fluent-reader\.db([-.].*)?$/i, "Fluent Reader database"],
    [/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i, "database file"],
    [/(^|\/)\.env(\..*)?$/i, "environment file"],
    [/(^|\/)\.npmrc$/i, "npm configuration (may hold tokens)"],
    [/(^|\/)\.claude(\.json)?(\/|$)/i, "Claude configuration"],
    [/(^|\/)\.mcp\.json$/i, "MCP client configuration"],
    [/(^|\/)claude-transcript[^/]*\.jsonl$/i, "Claude transcript"],
    [/(^|\/)(run-metadata|baseline|verify-report)\.json$/i, "smoke test record"],
    [/(^|\/)(id_rsa|id_ed25519)[^/]*$|\.(pem|pfx|p12|key)$/i, "key or certificate"],
    [/^(config\.json|server\/config\.json)$/i, "settings file at the package root"],
]

export function forbiddenFiles(files: readonly string[]): string[] {
    const problems: string[] = []
    for (const file of files) {
        const match = FORBIDDEN.find(([pattern]) => pattern.test(file))
        if (match !== undefined) problems.push(`${file} (${match[1]})`)
    }
    return problems
}

/** Our own server code: only the compiled JavaScript, no maps, declarations or sources. */
export function assertServerDist(files: readonly string[]): void {
    const unexpected = files.filter((file) => !file.endsWith(".js"))
    if (unexpected.length > 0) throw new BuildError(`unexpected files in the compiled server: ${unexpected.slice(0, 5).join(", ")}`)
    if (!files.includes("main.js")) throw new BuildError("the compiled server has no main.js")
}

interface LockPackage {
    readonly version?: string
    readonly dev?: boolean
    readonly license?: string
    readonly os?: string[]
    readonly cpu?: string[]
}

/**
 * name@version of every production package npm installs on win32/x64,
 * from package-lock.json (v3): not dev, and os/cpu compatible.
 */
export function expectedProductionPackages(lockText: string): string[] {
    const lock = JSON.parse(lockText) as { lockfileVersion?: number; packages?: Record<string, LockPackage> }
    if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object") throw new BuildError("package-lock.json must be lockfileVersion 3")
    const result: string[] = []
    for (const [key, value] of Object.entries(lock.packages)) {
        if (key === "" || value.dev === true) continue
        if (!key.startsWith("node_modules/") || key.slice("node_modules/".length).includes("/node_modules/")) {
            throw new BuildError(`nested or unusual lock entry ${key}: the flat layout is required`)
        }
        if (value.os !== undefined && !value.os.includes("win32")) continue
        if (value.cpu !== undefined && !value.cpu.includes("x64")) continue
        result.push(`${key.slice("node_modules/".length)}@${String(value.version)}`)
    }
    return result.sort(compareOrdinal)
}

/** name@version of the packages actually present in a node_modules directory. */
export function installedPackages(nodeModules: string): string[] {
    const result: string[] = []
    if (!fs.existsSync(nodeModules)) return result
    for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue
        const dirs = entry.name.startsWith("@") ? fs.readdirSync(path.join(nodeModules, entry.name)).map((child) => `${entry.name}/${child}`) : [entry.name]
        for (const dir of dirs) {
            const manifest = path.join(nodeModules, ...dir.split("/"), "package.json")
            if (!fs.existsSync(manifest)) throw new BuildError(`package without package.json: ${dir}`)
            const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string; version?: string }
            if (pkg.name !== dir) throw new BuildError(`package ${dir} declares name ${String(pkg.name)}`)
            result.push(`${dir}@${String(pkg.version)}`)
        }
    }
    return result.sort(compareOrdinal)
}

export function assertProductionSet(installed: readonly string[], expected: readonly string[]): void {
    if (!isDeepStrictEqual([...installed], [...expected])) {
        const missing = expected.filter((p) => !installed.includes(p))
        const extra = installed.filter((p) => !expected.includes(p))
        throw new BuildError(`installed production packages differ from package-lock.json: missing ${missing.join(", ") || "none"}; unexpected ${extra.join(", ") || "none"}`)
    }
}

/** Minimal package.json of the shipped server: ESM resolution and identity only, no scripts. */
export function serverPackageJson(pkg: { name: string; version: string; engines: { node: string }; dependencies: Record<string, string> }): string {
    return `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module", main: "dist/main.js", engines: pkg.engines, dependencies: pkg.dependencies }, null, 2)}\n`
}

export interface LicenseRecord {
    readonly component: string
    readonly declared: string | null
    readonly files: string[]
    readonly status: "file-included" | "no-license-file"
}

const LICENSE_FILE = /^(licen[cs]e|notice|copying)(\.(md|txt))?$/i

/**
 * Copies the licence and notice files of the runtime and of every shipped
 * package into licenses/. Packages without a licence file are recorded, not
 * hidden: the licence review stays open in any case (no public distribution
 * before it).
 */
export function collectLicenses(stage: string): LicenseRecord[] {
    const records: LicenseRecord[] = []
    const runtimeLicense = safeJoin(stage, "runtime/LICENSE")
    copyFile(runtimeLicense, safeJoin(stage, "licenses/node/LICENSE"))
    records.push({ component: "node (runtime, includes the notices of its bundled components)", declared: "MIT and others (see LICENSE)", files: ["licenses/node/LICENSE"], status: "file-included" })
    const nodeModules = safeJoin(stage, "server/node_modules")
    for (const id of installedPackages(nodeModules)) {
        const name = id.slice(0, id.lastIndexOf("@"))
        const dir = path.join(nodeModules, ...name.split("/"))
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { license?: unknown }
        const target = `licenses/npm/${id.replace("/", "+")}`
        const files: string[] = []
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile() || !LICENSE_FILE.test(entry.name)) continue
            copyFile(path.join(dir, entry.name), safeJoin(stage, `${target}/${entry.name}`))
            files.push(`${target}/${entry.name}`)
        }
        files.sort(compareOrdinal)
        records.push({ component: id, declared: typeof pkg.license === "string" ? pkg.license : null, files, status: files.length > 0 ? "file-included" : "no-license-file" })
    }
    return records
}

export interface ManifestFile {
    readonly path: string
    readonly size: number
    readonly sha256: string
}

export interface Manifest {
    readonly schemaVersion: 1
    readonly product: { id: string; name: string; version: string; channel: string; platform: string }
    readonly source: { gitCommit: string; gitDirty: boolean; sourceDateEpoch: number }
    readonly runtime: { name: "node"; version: string; archive: string; archiveSha256: string; executable: string }
    readonly server: { entrypoint: string; transport: "stdio"; tools: string[] }
    readonly launch: { command: string; args: string[]; profileDirRequired: true; profileDirPlaceholder: "{profileDir}" }
    readonly install: { scope: "currentUser"; defaultDirectory: string; approved: false; ownedEntries: string[] }
    readonly licenses: { review: "required"; projectLicense: string | null; records: LicenseRecord[] }
    readonly files: ManifestFile[]
}

export interface ManifestInput {
    readonly version: string
    readonly gitCommit: string
    readonly gitDirty: boolean
    readonly sourceDateEpoch: number
    readonly lock: RuntimeLock
    readonly projectLicense: string | null
    readonly licenses: LicenseRecord[]
}

/** The manifest of `stage`: every file except manifest.json itself, sorted, with size and SHA-256. */
export function buildManifest(stage: string, input: ManifestInput): Manifest {
    const files = listFiles(stage)
        .filter((file) => file !== MANIFEST)
        .map((file) => {
            const full = safeJoin(stage, file)
            return { path: file, size: fs.statSync(full).size, sha256: sha256FileSync(full) }
        })
    return {
        schemaVersion: 1,
        product: { id: PRODUCT_ID, name: PRODUCT_NAME, version: input.version, channel: CHANNEL, platform: PLATFORM },
        source: { gitCommit: input.gitCommit, gitDirty: input.gitDirty, sourceDateEpoch: input.sourceDateEpoch },
        runtime: { name: "node", version: input.lock.version, archive: input.lock.archive, archiveSha256: input.lock.sha256, executable: RUNTIME_EXE },
        server: { entrypoint: ENTRYPOINT, transport: "stdio", tools: [...TOOLS] },
        launch: { command: RUNTIME_EXE, args: [ENTRYPOINT, "--profile-dir", "{profileDir}"], profileDirRequired: true, profileDirPlaceholder: "{profileDir}" },
        install: { scope: "currentUser", defaultDirectory: DEFAULT_INSTALL_DIR, approved: false, ownedEntries: [...OWNED_ENTRIES] },
        licenses: { review: "required", projectLicense: input.projectLicense, records: input.licenses },
        files,
    }
}

const MANIFEST_KEYS = ["files", "install", "launch", "licenses", "product", "runtime", "schemaVersion", "server", "source"]

/**
 * Verifies a package directory against its manifest: required fields, the
 * file list exactly equal to the directory content (minus manifest.json),
 * sorted and unique, sizes and SHA-256. Returns the problems found.
 */
export function verifyManifest(root: string, manifest: unknown): string[] {
    const problems: string[] = []
    const m = manifest as Partial<Manifest> | null
    if (typeof m !== "object" || m === null) return ["manifest is not an object"]
    if (!isDeepStrictEqual(Object.keys(m).sort(), MANIFEST_KEYS)) problems.push("manifest fields differ from schema 1")
    if (m.schemaVersion !== 1) problems.push("unsupported schemaVersion")
    if (m.product?.id !== PRODUCT_ID || typeof m.product.version !== "string" || m.product.version.length === 0) problems.push("product identity incomplete")
    if (m.runtime?.executable !== RUNTIME_EXE || !/^[0-9a-f]{64}$/.test(m.runtime.archiveSha256 ?? "")) problems.push("runtime section incomplete")
    if (m.server?.entrypoint !== ENTRYPOINT || !isDeepStrictEqual(m.server.tools, [...TOOLS])) problems.push("server section incomplete")
    if (m.launch?.profileDirRequired !== true || !isDeepStrictEqual(m.launch.args, [ENTRYPOINT, "--profile-dir", "{profileDir}"])) problems.push("launch section must require --profile-dir")
    if (!Array.isArray(m.files) || m.files.length === 0) return [...problems, "manifest lists no files"]
    const listed = m.files.map((f) => f.path)
    if (!isDeepStrictEqual(listed, [...listed].sort(compareOrdinal)) || new Set(listed).size !== listed.length) problems.push("manifest files are not sorted and unique")
    for (const required of [RUNTIME_EXE, ENTRYPOINT, "server/package.json", KOFFI_NATIVE, INFO, "licenses/node/LICENSE"]) {
        if (!listed.includes(required)) problems.push(`manifest does not list ${required}`)
    }
    let actual: string[]
    try {
        actual = listFiles(root).filter((file) => file !== MANIFEST)
    } catch (error) {
        return [...problems, (error as Error).message]
    }
    for (const file of actual) if (!listed.includes(file)) problems.push(`file not in manifest: ${file}`)
    for (const entry of m.files) {
        if (!actual.includes(entry.path)) {
            problems.push(`missing file: ${entry.path}`)
            continue
        }
        const full = safeJoin(root, entry.path)
        if (fs.statSync(full).size !== entry.size) problems.push(`size mismatch: ${entry.path}`)
        else if (sha256FileSync(full) !== entry.sha256) problems.push(`sha256 mismatch: ${entry.path}`)
    }
    return problems
}

export function packagingInfo(version: string, lock: RuntimeLock): string {
    return [
        `# ${PRODUCT_NAME} ${version} — private beta (Windows x64)`,
        "",
        "Read-only MCP server (stdio) for one local Fluent Reader profile.",
        `Tools: ${TOOLS.join(", ")}. No write tools; Fluent Reader data is never modified.`,
        "",
        "This beta is limited to eight read-only tools: the seven of FR-MCP-02A and list_articles (FR-MCP-02B-01); article search is not included.",
        "It is not an installer: nothing is registered, no service or network port is created.",
        "",
        "## Contents",
        "",
        `- \`runtime/node.exe\`: official Node.js ${lock.version} for Windows x64 (${lock.archive}, sha256 ${lock.sha256}).`,
        "- `server/`: the compiled server and its production dependencies.",
        "- `licenses/`: licence and notice files of the runtime and of the dependencies.",
        "- `manifest.json`: version and SHA-256 of every file.",
        "",
        "## Manual start",
        "",
        "The server needs the explicit path of a Fluent Reader profile directory (the folder holding",
        "`fluent-reader.db` and `config.json`). It is never searched for.",
        "",
        "```powershell",
        `& "<package>\\runtime\\node.exe" "<package>\\server\\dist\\main.js" --profile-dir "<profile directory>"`,
        "```",
        "",
        "The process speaks MCP over stdin/stdout and ends when its client closes stdin; it is meant to be",
        "started by an MCP client such as Claude Code, not used interactively.",
        "",
        "## Privacy",
        "",
        "The server makes no network request. Data it reads locally can enter the context of the model when",
        "the MCP client asks for it.",
        "",
    ].join("\n")
}
