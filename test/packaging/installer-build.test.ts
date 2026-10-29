/**
 * FR-MCP-04-BETA-02: the installer builder on a SYNTHETIC repository and a
 * SYNTHETIC portable bundle (small files, real ZIP format and manifest),
 * with a simulated makensis.exe that writes a small fake installer. NSIS is
 * not run, nothing is downloaded and no real installer is produced. The
 * setup helper copied into the payload is the real compiled one.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { parseInstallerArgs } from "../../installer/build-installer.js"
import { BuildError, canonicalPath, sha256Bytes, type ExecFn } from "../../installer/lib/common.js"
import { buildInstaller, helperCopyNsh, installerName, NSIS_REQUIREMENTS, nsisString, SETUP_ENTRY, setupClosure, type InstallerDeps, type InstallerOptions } from "../../installer/lib/installer-build.js"
import { helperCopyEntries } from "../../installer/setup/uninstall.js"
import { artifactName, buildManifest, KOFFI_NATIVE, MANIFEST, type Manifest } from "../../installer/lib/package-content.js"
import { parseRuntimeLock } from "../../installer/lib/runtime-lock.js"
import { zipBytes } from "../../installer/lib/zip.js"
import { createTempRoot, removeTempRoot, snapshotDir } from "../helpers/fixtures.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const COMPILED_ROOT = path.resolve(HERE, "..", "..")
const REAL_REPO = path.resolve(COMPILED_ROOT, "..")
const VERSION = "0.1.0"
const COMMIT = "b".repeat(40)

let root: string
let counter = 0
before(() => {
    root = fs.realpathSync.native(createTempRoot())
})
after(() => removeTempRoot(root))

function write(file: string, content: string | Buffer): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
}

interface Fixture {
    readonly repo: string
    readonly bundle: string
    readonly sha: string
    readonly nsisDir: string
    readonly makensis: string
}

interface BundleOptions {
    readonly omit?: string
    readonly extraUnlisted?: boolean
    readonly manifestPatch?: (m: Manifest) => Manifest
    readonly name?: string
    readonly corruptByte?: boolean
}

const lockRaw = JSON.parse(fs.readFileSync(path.join(REAL_REPO, "installer", "runtime-lock.json"), "utf8")) as unknown

/** A synthetic repository (package.json, runtime lock, NSIS template copied read-only) and bundle. */
function fixture(options: BundleOptions = {}): Fixture {
    counter++
    const base = path.join(root, `case ${counter} àè 😀`)
    const repo = path.join(base, "repo é")
    write(path.join(repo, "package.json"), JSON.stringify({ name: "fluent-reader-mcp", version: VERSION, engines: { node: ">=24.15.0 <25" } }))
    write(path.join(repo, "installer", "runtime-lock.json"), JSON.stringify(lockRaw))
    write(path.join(repo, "installer", "nsis", "fluent-reader-mcp.nsi"), fs.readFileSync(path.join(REAL_REPO, "installer", "nsis", "fluent-reader-mcp.nsi")))
    const stage = path.join(base, "stage")
    const files: Record<string, string> = {
        "runtime/node.exe": "synthetic node.exe", "runtime/LICENSE": "node licence", "server/dist/main.js": "// synthetic server", "server/package.json": "{}",
        [KOFFI_NATIVE]: "synthetic native", "PACKAGING-INFO.md": "info", "licenses/node/LICENSE": "licence", "server/dist/tools/list é.js": "// tool",
    }
    for (const [f, content] of Object.entries(files)) if (f !== options.omit) write(path.join(stage, ...f.split("/")), content)
    const lock = parseRuntimeLock(lockRaw, ">=24.15.0 <25")
    let manifest = buildManifest(stage, { version: VERSION, gitCommit: COMMIT, gitDirty: false, sourceDateEpoch: 1767225600, lock, projectLicense: null, licenses: [] })
    if (options.manifestPatch !== undefined) manifest = options.manifestPatch(manifest)
    write(path.join(stage, MANIFEST), JSON.stringify(manifest, null, 2))
    if (options.extraUnlisted === true) write(path.join(stage, "server", "dist", "unlisted.js"), "// not in the manifest")
    const entries = fs.readdirSync(stage, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
        const relative = path.relative(stage, path.join(e.parentPath, e.name)).split(path.sep).join("/")
        return { name: `FluentReaderMCP/${relative}`, data: fs.readFileSync(path.join(e.parentPath, e.name)) }
    }).sort((a, b) => (a.name < b.name ? -1 : 1))
    const bytes = zipBytes(entries, 1767225600)
    if (options.corruptByte === true) {
        const at = bytes.indexOf(Buffer.from("synthetic server"))
        bytes[at] = (bytes[at] as number) ^ 0x01
    }
    const bundle = path.join(base, "portable build ü", options.name ?? artifactName(VERSION))
    write(bundle, bytes)
    const sha = sha256Bytes(bytes)
    write(`${bundle}.sha256`, `${sha} *${path.basename(bundle)}\n`)
    const nsisDir = path.join(base, "NSIS é")
    for (const r of NSIS_REQUIREMENTS) write(path.join(nsisDir, ...r.split("/")), "synthetic")
    const makensis = path.join(nsisDir, "makensis.exe")
    write(makensis, "synthetic makensis")
    return { repo, bundle, sha, nsisDir, makensis }
}

interface Fakes {
    readonly deps: InstallerDeps
    readonly calls: { file: string; args: readonly string[]; cwd: string }[]
    readonly lines: string[]
    seen: { defines: string; nsi: string; helperFiles: string; payload: string[] } | null
}

function fakes(fx: Fixture, behaviour: { version?: string; compileFails?: boolean; dirty?: boolean } = {}): Fakes {
    const calls: Fakes["calls"] = []
    const lines: string[] = []
    const state: Fakes = { deps: undefined as unknown as InstallerDeps, calls, lines, seen: null }
    const exec: ExecFn = (file, args, opts) => {
        calls.push({ file, args, cwd: opts.cwd })
        if (file === "git") {
            if (args.includes("rev-parse")) return { status: 0, stdout: `${COMMIT}\n`, stderr: "" }
            if (args.includes("status")) return { status: 0, stdout: behaviour.dirty === true ? " M x\n" : "", stderr: "" }
        }
        if (file === fx.makensis && args[0] === "/VERSION") return { status: 0, stdout: `${behaviour.version ?? "v3.13"}\n`, stderr: "" }
        if (file === fx.makensis) {
            if (behaviour.compileFails === true) return { status: 1, stdout: "Error in script line 12", stderr: "" }
            const defines = fs.readFileSync(path.join(opts.cwd, "defines.nsh"), "utf8")
            const value = (name: string): string => new RegExp(`!define ${name} "([^"]*)"`).exec(defines)?.[1] as string
            const payload = value("PAYLOAD_DIR")
            state.seen = {
                defines,
                nsi: fs.readFileSync(args[args.length - 1] as string, "utf8"),
                helperFiles: fs.readFileSync(path.join(opts.cwd, "helper-files.nsh"), "utf8"),
                payload: fs.readdirSync(payload, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(payload, path.join(e.parentPath, e.name)).split(path.sep).join("/")).sort(),
            }
            write(value("OUTFILE"), Buffer.from("MZ synthetic installer"))
            return { status: 0, stdout: "Output: synthetic", stderr: "" }
        }
        return { status: 1, stdout: "", stderr: `unexpected ${file}` }
    }
    ;(state as { deps: InstallerDeps }).deps = { platform: "win32", arch: "x64", env: { "ProgramFiles(x86)": path.join(root, "no NSIS here") }, exec, log: (l) => lines.push(l), compiledRoot: COMPILED_ROOT }
    return state
}

function options(fx: Fixture, extra: Partial<InstallerOptions> = {}): InstallerOptions {
    counter++
    return { repoRoot: fx.repo, bundle: fx.bundle, bundleSha256: fx.sha, outDir: path.join(root, `installer out ${counter} 📦 é`), makensis: fx.makensis, dryRun: false, allowDirty: false, keepWork: false, ...extra }
}

const EXE = installerName(VERSION)

async function refused(fx: Fixture, opts: InstallerOptions, message: RegExp, f = fakes(fx)): Promise<void> {
    const outExisted = fs.existsSync(opts.outDir)
    await assert.rejects(buildInstaller(opts, f.deps), (error: unknown) => error instanceof BuildError && message.test(error.message))
    assert.equal(fs.existsSync(opts.outDir), outExisted, "--out not created")
    assert.equal(f.calls.some((c) => c.file === fx.makensis && c.args[0] !== "/VERSION"), false, "makensis did not compile")
}

describe("installer builder: bundle verification", { timeout: 60_000 }, () => {
    test("a valid bundle produces the installer, its .sha256 and a report without local paths", async () => {
        const fx = fixture()
        const repoBefore = snapshotDir(fx.repo)
        const bundleDirBefore = snapshotDir(path.dirname(fx.bundle))
        const f = fakes(fx)
        const opts = options(fx)
        const result = await buildInstaller(opts, f.deps)
        const out = canonicalPath(opts.outDir)
        assert.equal(result.exePath, path.join(out, EXE))
        assert.deepEqual(fs.readdirSync(out).sort(), [EXE, `${EXE}.build-report.json`, `${EXE}.sha256`])
        const exe = fs.readFileSync(result.exePath)
        assert.equal(result.sha256, sha256Bytes(exe))
        assert.equal(fs.readFileSync(`${result.exePath}.sha256`, "utf8"), `${result.sha256} *${EXE}\n`)
        const reportText = fs.readFileSync(`${result.exePath}.build-report.json`, "utf8")
        const report = JSON.parse(reportText) as { installer: { sha256: string; size: number }; bundle: { file: string; sha256: string; source: { gitCommit: string } } }
        assert.equal(report.installer.sha256, result.sha256)
        assert.equal(report.installer.size, exe.length)
        assert.equal(report.bundle.sha256, fx.sha)
        assert.equal(report.bundle.file, artifactName(VERSION))
        assert.equal(report.bundle.source.gitCommit, COMMIT)
        assert.equal(reportText.includes(root.slice(3)), false, "no local path in the report")
        assert.deepEqual(snapshotDir(fx.repo), repoBefore, "repository untouched")
        assert.deepEqual(snapshotDir(path.dirname(fx.bundle)), bundleDirBefore, "bundle and its checksum untouched")
        assert.ok(f.lines.some((l) => l.startsWith("SHA-256: ")) && f.lines.some((l) => /^Bundle: .*sha256 [0-9a-f]{64}.*commit bbbbbbbbbbbb/.test(l)))
    })

    test("the payload is the package unchanged, the compiled setup helper and the inventory", async () => {
        const fx = fixture()
        const f = fakes(fx)
        await buildInstaller(options(fx, { keepWork: true }), f.deps)
        const seen = f.seen
        assert.ok(seen !== null)
        for (const expected of ["app/manifest.json", "app/runtime/node.exe", "app/server/dist/tools/list é.js", `setup/${SETUP_ENTRY}`, "setup/package.json", "setup/installer/lib/selftest.js", "setup/test/e2e/smoke-fixture.js", "installer-files.json"]) {
            assert.ok(seen.payload.includes(expected), expected)
        }
        assert.equal(seen.payload.some((p) => p.startsWith("setup/") && /\.ts$|\.map$|\.test\.js$/.test(p)), false, "no sources, maps or tests in the helper")
        assert.deepEqual(seen.payload.filter((p) => p.startsWith("setup/") && p !== "setup/package.json").map((p) => p.slice(6)), setupClosure(COMPILED_ROOT))
        assert.match(seen.defines, /^\uFEFF/, "UTF-8 with BOM")
        for (const name of ["PRODUCT_NAME", "PRODUCT_VERSION", "BUNDLE_SHA256", "PAYLOAD_DIR", "OUTFILE", "MAX_RELATIVE", "SETUP_ENTRY", "NODE_VERSION"]) assert.match(seen.defines, new RegExp(`!define ${name} "`), name)
        assert.match(seen.defines, new RegExp(`!define BUNDLE_SHA256 "${fx.sha}"`))
        assert.equal(seen.nsi, fs.readFileSync(path.join(REAL_REPO, "installer", "nsis", "fluent-reader-mcp.nsi"), "utf8"))
        // the uninstaller removes exactly the files of the helper copy, as compiled from this payload
        assert.equal(seen.helperFiles, helperCopyNsh(helperCopyEntries(seen.payload.filter((p) => p !== "installer-files.json"))))
        assert.ok(seen.helperFiles.includes('DeleteHelperCopyFile "app\\runtime\\node.exe"'))
        assert.ok(seen.helperFiles.includes('DeleteHelperCopyFile "setup\\installer\\setup\\fr-setup.js"'))
        assert.equal(seen.helperFiles.includes("server\\"), false, "only the helper, never the server files")
        const compile = f.calls.find((c) => c.file === fx.makensis && c.args[0] !== "/VERSION")
        assert.deepEqual(compile?.args.slice(0, 3), ["/V2", "/INPUTCHARSET", "UTF8"])
    })

    const bad: [string, BundleOptions, RegExp][] = [
        ["a byte altered inside the ZIP", { corruptByte: true }, /does not match its \.sha256|invalid ZIP/],
        ["a file missing from the package (Koffi)", { omit: KOFFI_NATIVE }, /lacks .*koffi\.node/],
        ["a file not listed in the manifest", { extraUnlisted: true }, /differs from its manifest/],
        ["another runtime version", { manifestPatch: (m) => ({ ...m, runtime: { ...m.runtime, version: "24.0.0" } }) }, /runtime differs/],
        ["another product version", { manifestPatch: (m) => ({ ...m, product: { ...m.product, version: "0.0.9" } }) }, /bundle version 0\.0\.9, expected 0\.1\.0/],
        ["a manifest without the eight tools", { manifestPatch: (m) => ({ ...m, server: { ...m.server, tools: ["get_article"] } }) }, /eight tools/],
        ["a manifest with only the seven FR-MCP-02A tools", { manifestPatch: (m) => ({ ...m, server: { ...m.server, tools: m.server.tools.filter((t) => t !== "list_articles") } }) }, /eight tools/],
        ["a manifest with an unexpected ninth tool", { manifestPatch: (m) => ({ ...m, server: { ...m.server, tools: [...m.server.tools, "search_articles"] } }) }, /eight tools/],
        ["a file whose hash differs from the manifest", { manifestPatch: (m) => ({ ...m, files: m.files.map((x) => (x.path === "runtime/LICENSE" ? { ...x, sha256: "0".repeat(64) } : x)) }) }, /altered: runtime\/LICENSE/],
    ]
    for (const [label, bundleOptions, message] of bad) {
        test(`refused before writing anything: ${label}`, async () => {
            const fx = fixture(bundleOptions)
            await refused(fx, options(fx), message)
        })
    }

    test("a .sha256 file or --bundle-sha256 that does not match, or a wrong bundle name: refused", async () => {
        const fx = fixture()
        await refused(fx, options(fx, { bundleSha256: "1".repeat(64) }), /does not match --bundle-sha256/)
        await refused(fx, options(fx, { bundleSha256: "not-a-hash" }), /64-character SHA-256/)
        fs.writeFileSync(`${fx.bundle}.sha256`, `${"2".repeat(64)} *${path.basename(fx.bundle)}\n`)
        await refused(fx, options(fx), /does not match its \.sha256 file/)
        fs.rmSync(`${fx.bundle}.sha256`)
        await refused(fx, options(fx), /checksum file is missing/)
        const renamed = fixture({ name: "fluent-reader-mcp-v0.1.0-beta-win-x64 (1).zip" })
        await refused(renamed, options(renamed), /the bundle must be fluent-reader-mcp-v0\.1\.0-beta-win-x64\.zip/)
    })
})

describe("installer builder: NSIS, outputs and publication", { timeout: 60_000 }, () => {
    test("makensis missing, not NSIS 3 or without a required plugin: refused, nothing downloaded", async () => {
        const fx = fixture()
        await refused(fx, options(fx, { makensis: undefined }), /not found: install NSIS 3 yourself.*never downloads it/)
        await refused(fx, options(fx), /is not NSIS 3/, fakes(fx, { version: "v2.51" }))
        fs.rmSync(path.join(fx.nsisDir, "Plugins", "x86-unicode", "nsExec.dll"))
        await refused(fx, options(fx), /lacks Plugins\/x86-unicode\/nsExec\.dll/)
    })

    test("--out inside the repository, a path NSIS would interpret, or an existing artifact: refused", async () => {
        const fx = fixture()
        await refused(fx, options(fx, { outDir: path.join(fx.repo, "out") }), /outside the repository/)
        await refused(fx, options(fx, { outDir: path.join(root, `out $INSTDIR ${counter}`) }), /not usable in the NSIS script/)
        const opts = options(fx)
        fs.mkdirSync(opts.outDir, { recursive: true })
        fs.writeFileSync(path.join(opts.outDir, EXE), "owner's file")
        await refused(fx, opts, /already exists, nothing is overwritten/)
        assert.equal(fs.readFileSync(path.join(opts.outDir, EXE), "utf8"), "owner's file")
    })

    test("a dirty tree is refused unless --allow-dirty; dry-run checks everything and writes nothing", async () => {
        const fx = fixture()
        await refused(fx, options(fx), /working tree has changes/, fakes(fx, { dirty: true }))
        const f = fakes(fx)
        const opts = options(fx, { dryRun: true })
        const result = await buildInstaller(opts, f.deps)
        assert.equal(result.dryRun, true)
        assert.equal(fs.existsSync(opts.outDir), false)
        assert.deepEqual(f.calls.filter((c) => c.file === fx.makensis).map((c) => c.args), [["/VERSION"]])
        assert.ok(f.lines.some((l) => /Dry run: all checks passed; the builder wrote nothing and did not run makensis/.test(l)))
    })

    test("a failing compilation publishes nothing and keeps the work directory for inspection", async () => {
        const fx = fixture()
        const f = fakes(fx, { compileFails: true })
        const opts = options(fx)
        await assert.rejects(buildInstaller(opts, f.deps), /makensis failed \(exit 1\): .*Error in script line 12/)
        assert.deepEqual(fs.readdirSync(opts.outDir), [`work-installer-${VERSION}`])
        assert.ok(f.lines.some((l) => /Work directory kept for inspection/.test(l)))
    })

    test("a fault during publication: rolled back, nothing published", async () => {
        const fx = fixture()
        const f = fakes(fx)
        const opts = options(fx)
        await assert.rejects(buildInstaller(opts, { ...f.deps, checkpoint: (s) => { if (s === "promote:report") throw new Error("injected") } }), /publication failed .*every artifact published by this run was removed/)
        assert.deepEqual(fs.readdirSync(opts.outDir), [])
    })

    test("NSIS strings: values are used literally or refused", () => {
        assert.equal(nsisString("C:\\Users\\Zoë\\out 📦\\setup.exe"), "\"C:\\Users\\Zoë\\out 📦\\setup.exe\"")
        for (const bad of ["a$b", "a\"b", "a`b", "a\nb"]) assert.throws(() => nsisString(bad), BuildError)
    })

    test("command line: --bundle, --bundle-sha256 and --out are required; unknown options refused", () => {
        assert.throws(() => parseInstallerArgs(["--bundle", "C:\\b.zip", "--out", "C:\\o"], "C:\\r"), /--bundle-sha256 is required/)
        assert.throws(() => parseInstallerArgs(["--bundle", "C:\\b.zip", "--bundle-sha256", "x", "--out", "C:\\o", "--yes"], "C:\\r"), /unknown argument/)
        const parsed = parseInstallerArgs(["--bundle", "C:\\b c.zip", "--bundle-sha256", "ab", "--out", "C:\\o é", "--dry-run"], "C:\\r")
        assert.equal(parsed.bundle, "C:\\b c.zip")
        assert.equal(parsed.dryRun, true)
        assert.equal(parsed.makensis, undefined)
    })
})
