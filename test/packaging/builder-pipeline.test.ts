/**
 * FR-MCP-04-BETA-01: the whole builder pipeline on a SYNTHETIC repository,
 * with fakes for git, TypeScript, npm, nodejs.org and the packaged node.exe.
 * Every file is small and synthetic; nothing is downloaded and no real
 * package is produced. This proves the orchestration and its refusals, not
 * that a real bundle starts: that is the owner's build (its self-test).
 *
 * One test runs the real self-test protocol with the build machine's Node
 * and the repository's compiled server on the synthetic smoke profile: it
 * checks the self-test logic, not a packaged runtime.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { BuildError, canonicalPath, isInside, sha256Bytes, type ExecFn } from "../../installer/lib/common.js"
import { assertHardLinks, buildPortable, NPM_REGISTRY, OwnedFiles, promoteArtifacts, type BuildDeps, type BuildOptions, type CheckpointStep } from "../../installer/lib/pipeline.js"
import type { FetchFn } from "../../installer/lib/runtime.js"
import { runSelfTest, type SelfTestFn } from "../../installer/lib/selftest.js"
import { encodeZip, readZip } from "../../installer/lib/zip.js"
import { createTempRoot, removeTempRoot, snapshotDir } from "../helpers/fixtures.js"
import { MAIN_JS } from "../helpers/process.js"

let root: string
let counter = 0
before(() => {
    root = createTempRoot()
})
after(() => removeTempRoot(root))

const VERSION = "24.22.1"
const ARCHIVE_ROOT = `node-v${VERSION}-win-x64`
const EPOCH = 1767225600
const COMMIT = "c0ffee".padEnd(40, "0")
const MARKER = "PERSONAL_MARKER_9f2c"
/** Sentinels of a personal npm setup: registry, token, proxy, certificate. */
const NPM_SENTINEL = "NPM_PERSONAL_SENTINEL_51ab"
/** Personal variables of the parent environment (synthetic values) that must never reach npm. */
const ENV_SENTINELS: Record<string, string> = {
    GITHUB_TOKEN: `${NPM_SENTINEL}_GITHUB_TOKEN`,
    GH_TOKEN: `${NPM_SENTINEL}_GH_TOKEN`,
    GIT_ASKPASS: `C:\\${NPM_SENTINEL}\\askpass.exe`,
    GIT_CONFIG_COUNT: `${NPM_SENTINEL}_1`,
    GIT_CONFIG_KEY_0: `http.https://${NPM_SENTINEL}.example.com/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${NPM_SENTINEL}_GIT`,
    SSL_CERT_FILE: `C:\\${NPM_SENTINEL}\\cert.pem`,
    SSL_CERT_DIR: `C:\\${NPM_SENTINEL}\\certs`,
    OPENSSL_CONF: `C:\\${NPM_SENTINEL}\\openssl.cnf`,
    AWS_ACCESS_KEY_ID: `${NPM_SENTINEL}_AWS`,
    CUSTOM_PRIVATE_SENTINEL: `${NPM_SENTINEL}_CUSTOM`,
}
/** Exactly the variables npm gets (built by the builder, not copied wholesale). */
const NPM_ENV_KEYS = ["APPDATA", "ComSpec", "HOME", "LOCALAPPDATA", "PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR"]

const RUNTIME_ZIP = encodeZip([
    { name: `${ARCHIVE_ROOT}/node.exe`, data: Buffer.from("synthetic node.exe") },
    { name: `${ARCHIVE_ROOT}/LICENSE`, data: Buffer.from("synthetic Node.js licence") },
    { name: `${ARCHIVE_ROOT}/npm.cmd`, data: Buffer.from("never shipped") },
], EPOCH)
const RUNTIME_SHA = sha256Bytes(RUNTIME_ZIP)
const URL = `https://nodejs.org/dist/v${VERSION}/${ARCHIVE_ROOT}.zip`
const SHASUMS_URL = `https://nodejs.org/dist/v${VERSION}/SHASUMS256.txt`

interface Fixture {
    readonly repo: string
    readonly home: string
    readonly npmCli: string
}

function write(file: string, content: string | Buffer): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
}

/** A synthetic repository, plus a synthetic user home with a Claude config and a Fluent Reader profile. */
function fixture(): Fixture {
    counter++
    const base = path.join(root, `case ${counter} àè 😀`)
    const repo = path.join(base, "repo dir é")
    const dependencies = { "fake-dep": "1.0.0", koffi: "3.3.4" }
    write(path.join(repo, "package.json"), JSON.stringify({ name: "fluent-reader-mcp", version: "0.1.0", type: "module", engines: { node: ">=24.15.0 <25" }, dependencies }))
    write(path.join(repo, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: {
            "": { name: "fluent-reader-mcp", version: "0.1.0", dependencies },
            "node_modules/fake-dep": { version: "1.0.0", license: "MIT" },
            "node_modules/koffi": { version: "3.3.4", license: "MIT" },
            "node_modules/@koromix/koffi-win32-x64": { version: "3.3.4", optional: true, os: ["win32"], cpu: ["x64"] },
            "node_modules/@koromix/koffi-linux-x64": { version: "3.3.4", optional: true, os: ["linux"], cpu: ["x64"] },
            "node_modules/typescript": { version: "6.0.3", dev: true },
        },
    }))
    write(path.join(repo, "installer", "runtime-lock.json"), JSON.stringify({
        schemaVersion: 1,
        node: { version: VERSION, platform: "win-x64", archive: `${ARCHIVE_ROOT}.zip`, archiveRoot: ARCHIVE_ROOT, url: URL, shasumsUrl: SHASUMS_URL, sha256: RUNTIME_SHA },
        attestation: { checkedOn: "2026-10-28", release: "synthetic test release", method: "synthetic test attestation" },
    }))
    write(path.join(repo, "tsconfig.json"), "{}")
    write(path.join(repo, "node_modules", "typescript", "bin", "tsc"), "synthetic tsc")
    write(path.join(repo, "node_modules", ".package-lock.json"), "{}")
    const npmCli = path.join(base, "npm tool", "bin", "npm-cli.js")
    write(npmCli, "synthetic npm")
    const home = path.join(base, "home ü")
    write(path.join(home, ".claude.json"), `{"mcpServers":{"other":{"command":"${MARKER}"}}}`)
    write(path.join(home, "AppData", "Roaming", "Fluent Reader", "fluent-reader.db"), MARKER)
    write(path.join(home, "AppData", "Roaming", "Fluent Reader", "config.json"), `{"token":"${MARKER}"}`)
    write(path.join(home, ".npmrc"), `registry=https://${NPM_SENTINEL}.example.com/
//${NPM_SENTINEL}.example.com/:_authToken=${NPM_SENTINEL}_TOKEN
`)
    write(path.join(home, "AppData", "Roaming", "npm", "etc", "npmrc"), `cafile=C:\${NPM_SENTINEL}\ca.pem
`)
    return { repo, home, npmCli }
}

interface Fakes {
    readonly deps: BuildDeps
    readonly calls: string[]
    readonly fetched: string[]
    readonly selfTests: string[]
    readonly npmCalls: NpmCall[]
    readonly lines: string[]
}

interface FakeOptions {
    readonly dirty?: boolean
    readonly runtimeBytes?: Buffer
    readonly runtimeVersion?: string
    readonly npmCli?: string | null
    /** Extra effect of the fake npm ci, after the normal install. */
    readonly afterInstall?: (prefix: string, repo: string) => void
    readonly selfTest?: SelfTestFn
    readonly platform?: string
    readonly npmFails?: boolean
    readonly checkpoint?: BuildDeps["checkpoint"]
}

/** What the fake npm saw: arguments, environment, and the content of the config files it resolved. */
interface NpmCall {
    readonly args: readonly string[]
    readonly env: NodeJS.ProcessEnv
    readonly userconfig: string
    readonly userconfigText: string | null
    readonly globalconfig: string
    readonly globalconfigText: string | null
    readonly cache: string
    readonly logsDir: string
}

function fakes(fx: Fixture, options: FakeOptions = {}): Fakes {
    const calls: string[] = []
    const fetched: string[] = []
    const selfTests: string[] = []
    const npmCalls: NpmCall[] = []
    const lines: string[] = []
    const ok = (stdout = ""): ReturnType<ExecFn> => ({ status: 0, stdout, stderr: "" })
    const exec: ExecFn = (file, args, opts) => {
        calls.push(`${path.basename(file)} ${args[0] === undefined ? "" : path.basename(args[0])}`)
        if (opts.env.npm_config_local_prefix !== undefined || opts.env.NODE_OPTIONS !== undefined) throw new Error("child environment not sanitized")
        if (file === "git") {
            if (args[0] === "--version") return ok("git version 2.0")
            if (args.includes("rev-parse")) return ok(`${COMMIT}\n`)
            if (args.includes("status")) return ok(options.dirty === true ? " M src/x.ts\n" : "")
            if (args.includes("log")) return ok(`${EPOCH}\n`)
        }
        if (file.endsWith(path.join("runtime", "node.exe"))) {
            if (args[0] === "--version") return ok(`v${options.runtimeVersion ?? VERSION}\n`)
            return ok("win32 x64\n")
        }
        if (args[0]?.endsWith(path.join("typescript", "bin", "tsc"))) {
            const out = args[args.indexOf("--outDir") + 1] as string
            write(path.join(out, "main.js"), "// synthetic server\n")
            write(path.join(out, "tools", "list é.js"), "// synthetic tool\n")
            return ok()
        }
        if (args[0]?.endsWith("npm-cli.js") && args[1] === "ci") {
            // Simulates npm's configuration resolution: command line, then npm_config_* variables, then the user's defaults.
            const arg = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
            const env = opts.env
            // Like Node and npm on Windows: sockets need SystemRoot; home, AppData and TEMP must be usable directories.
            for (const name of ["SystemRoot", "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
                const value = env[name]
                if (value === undefined) return { status: 1, stdout: "", stderr: `npm error ${name} is not set` }
                if (name !== "SystemRoot" && name !== "PATH" && !fs.statSync(value, { throwIfNoEntry: false })?.isDirectory()) return { status: 1, stdout: "", stderr: `npm error ${name} is not a directory` }
            }
            const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null)
            const userconfig = arg("--userconfig") ?? env.npm_config_userconfig ?? path.join(env.USERPROFILE ?? "", ".npmrc")
            const globalconfig = arg("--globalconfig") ?? env.npm_config_globalconfig ?? path.join(env.APPDATA ?? "", "npm", "etc", "npmrc")
            const cache = arg("--cache") ?? env.npm_config_cache ?? path.join(env.LOCALAPPDATA ?? "", "npm-cache")
            const logsDir = arg("--logs-dir") ?? path.join(cache, "_logs")
            const configs = `${read(userconfig) ?? ""}
${read(globalconfig) ?? ""}`
            const registry = arg("--registry") ?? env.npm_config_registry ?? /^registry=(.*)$/m.exec(configs)?.[1] ?? "https://registry.npmjs.org/"
            npmCalls.push({ args, env, userconfig, userconfigText: read(userconfig), globalconfig, globalconfigText: read(globalconfig), cache, logsDir })
            // Like npm: the cache and a debug log are written, and the log echoes the effective configuration.
            write(path.join(cache, "_cacache", "index-v5", "entry"), registry)
            write(path.join(logsDir, "debug-0.log"), `registry=${registry}
proxy=${env.HTTPS_PROXY ?? ""}
configs=${configs}
env=${JSON.stringify(env)}
`)
            if (options.npmFails === true) return { status: 1, stdout: "", stderr: "npm error code ECONNREFUSED" }
            const prefix = args[args.indexOf("--prefix") + 1] as string
            const nm = path.join(prefix, "node_modules")
            // The effective registry and any token reach the installed tree, as a misconfigured npm would let them.
            write(path.join(nm, "fake-dep", "registry.txt"), `${registry}
${configs.includes("_authToken") ? configs : ""}`)
            write(path.join(nm, "fake-dep", "package.json"), JSON.stringify({ name: "fake-dep", version: "1.0.0", license: "MIT" }))
            write(path.join(nm, "fake-dep", "LICENSE"), "synthetic MIT licence")
            write(path.join(nm, "fake-dep", "index.js"), "export {}")
            write(path.join(nm, "koffi", "package.json"), JSON.stringify({ name: "koffi", version: "3.3.4", license: "MIT" }))
            write(path.join(nm, "koffi", "LICENSE.txt"), "synthetic koffi licence")
            write(path.join(nm, "@koromix", "koffi-win32-x64", "package.json"), JSON.stringify({ name: "@koromix/koffi-win32-x64", version: "3.3.4", license: "MIT" }))
            write(path.join(nm, "@koromix", "koffi-win32-x64", "win32_x64", "koffi.node"), "synthetic native module")
            write(path.join(nm, ".bin", "tool"), "never shipped")
            write(path.join(nm, ".package-lock.json"), "{}")
            options.afterInstall?.(prefix, fx.repo)
            return ok()
        }
        return { status: 1, stdout: "", stderr: `unexpected command ${file}` }
    }
    const fetch: FetchFn = async (url) => {
        fetched.push(url)
        const bytes = url === URL ? (options.runtimeBytes ?? RUNTIME_ZIP) : url === SHASUMS_URL ? Buffer.from(`${RUNTIME_SHA}  ${ARCHIVE_ROOT}.zip\n`) : undefined
        if (bytes === undefined) return { ok: false, status: 404, url, body: null, text: async () => "" }
        return { ok: true, status: 200, url, body: new Response(bytes).body, text: async () => bytes.toString("utf8") }
    }
    const selfTest: SelfTestFn = options.selfTest ?? (async (input) => {
        selfTests.push(input.nodeExe)
        assert.ok(fs.existsSync(input.nodeExe) && fs.existsSync(input.entrypoint), "the self-test runs the EXTRACTED package")
        return ["self-test: synthetic"]
    })
    const env: NodeJS.ProcessEnv = {
        SystemRoot: "C:\\Windows",
        windir: "C:\\Windows",
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
        PATH: `${process.env.PATH ?? ""};C:\\${NPM_SENTINEL}\\bin`,
        PATHEXT: `.COM;.EXE;.BAT;.CMD;.${NPM_SENTINEL}`,
        HOME: fx.home,
        TEMP: path.join(fx.home, "AppData", "Local", "Temp"),
        TMP: path.join(fx.home, "AppData", "Local", "Temp"),
        ...ENV_SENTINELS,
        USERPROFILE: fx.home,
        APPDATA: path.join(fx.home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(fx.home, "AppData", "Local"),
        npm_config_local_prefix: fx.repo,
        npm_config_userconfig: path.join(fx.home, ".npmrc"),
        npm_config_globalconfig: path.join(fx.home, "AppData", "Roaming", "npm", "etc", "npmrc"),
        npm_config_cache: path.join(fx.home, "AppData", "Local", "npm-cache"),
        npm_config_registry: `https://${NPM_SENTINEL}.example.com/`,
        HTTPS_PROXY: `http://${NPM_SENTINEL}.example.com:3128`,
        NODE_AUTH_TOKEN: `${NPM_SENTINEL}_NODE_AUTH_TOKEN`,
        NODE_EXTRA_CA_CERTS: path.join(fx.home, `${NPM_SENTINEL}.pem`),
        NODE_OPTIONS: "--require evil",
        ...(options.npmCli !== null && { npm_execpath: options.npmCli ?? fx.npmCli }),
    }
    const deps: BuildDeps = {
        platform: options.platform ?? "win32",
        arch: "x64",
        nodeExecPath: path.join(fx.repo, "..", "no node here", "node.exe"),
        nodeVersion: `v${VERSION}`,
        env,
        fetch,
        exec,
        selfTest,
        log: (line) => lines.push(line),
        ...(options.checkpoint !== undefined && { checkpoint: options.checkpoint }),
    }
    return { deps, calls, fetched, selfTests, npmCalls, lines }
}

function options(fx: Fixture, extra: Partial<BuildOptions> = {}): BuildOptions {
    counter++
    return { repoRoot: fx.repo, outDir: path.join(root, `out ${counter} 📦 é`), dryRun: false, allowDirty: false, keepWork: false, ...extra }
}

function zipText(file: string): string {
    return readZip(fs.readFileSync(file)).map((e) => `${e.name}\n${e.read().toString("utf8")}`).join("\n")
}

describe("builder pipeline on a synthetic repository", { timeout: 60_000 }, () => {
    test("builds, verifies and publishes a ZIP with manifest, licences and sha256; touches nothing else", async () => {
        const fx = fixture()
        const homeBefore = snapshotDir(fx.home)
        const repoBefore = snapshotDir(fx.repo)
        const f = fakes(fx)
        const opts = options(fx)
        const result = await buildPortable(opts, f.deps)

        assert.equal(path.basename(result.zipPath), "fluent-reader-mcp-v0.1.0-beta-win-x64.zip")
        const bytes = fs.readFileSync(result.zipPath)
        assert.equal(result.sha256, sha256Bytes(bytes))
        assert.equal(fs.readFileSync(`${result.zipPath}.sha256`, "utf8"), `${result.sha256} *fluent-reader-mcp-v0.1.0-beta-win-x64.zip\n`)
        assert.deepEqual(fs.readdirSync(opts.outDir).sort(), [
            "fluent-reader-mcp-v0.1.0-beta-win-x64.zip",
            "fluent-reader-mcp-v0.1.0-beta-win-x64.zip.build-report.json",
            "fluent-reader-mcp-v0.1.0-beta-win-x64.zip.sha256",
            "runtime-cache",
        ], "work directory removed, no partial file")

        const names = readZip(bytes).map((e) => e.name.slice("FluentReaderMCP/".length))
        assert.deepEqual(names, [
            "PACKAGING-INFO.md",
            "licenses/node/LICENSE",
            "licenses/npm/fake-dep@1.0.0/LICENSE",
            "licenses/npm/koffi@3.3.4/LICENSE.txt",
            "manifest.json",
            "runtime/LICENSE",
            "runtime/node.exe",
            "server/dist/main.js",
            "server/dist/tools/list é.js",
            "server/node_modules/@koromix/koffi-win32-x64/package.json",
            "server/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node",
            "server/node_modules/fake-dep/LICENSE",
            "server/node_modules/fake-dep/index.js",
            "server/node_modules/fake-dep/package.json",
            "server/node_modules/fake-dep/registry.txt",
            "server/node_modules/koffi/LICENSE.txt",
            "server/node_modules/koffi/package.json",
            "server/package.json",
        ])
        const manifest = result.manifest
        assert.ok(manifest !== null)
        assert.deepEqual(manifest.files.map((f) => f.path), names.filter((n) => n !== "manifest.json"))
        assert.deepEqual(manifest.source, { gitCommit: COMMIT, gitDirty: false, sourceDateEpoch: EPOCH })
        assert.equal(manifest.runtime.archiveSha256, RUNTIME_SHA)
        assert.deepEqual(manifest.launch, { command: "runtime/node.exe", args: ["server/dist/main.js", "--profile-dir", "{profileDir}"], profileDirRequired: true, profileDirPlaceholder: "{profileDir}" })
        assert.equal(manifest.licenses.review, "required")
        assert.deepEqual(manifest.licenses.records.filter((r) => r.status === "no-license-file").map((r) => r.component), ["@koromix/koffi-win32-x64@3.3.4"])
        assert.ok(result.warnings.some((w) => /declares no license/.test(w)))
        const serverPkg = JSON.parse(readZip(bytes).find((e) => e.name.endsWith("server/package.json"))?.read().toString("utf8") ?? "{}")
        assert.equal(serverPkg.type, "module")
        assert.equal(serverPkg.scripts, undefined)
        assert.equal(serverPkg.devDependencies, undefined)

        assert.equal(f.selfTests.length, 1)
        assert.deepEqual(f.fetched, [URL, SHASUMS_URL])
        assert.equal(zipText(result.zipPath).includes(MARKER), false, "nothing from the user's home reached the package")
        assert.deepEqual(snapshotDir(fx.home), homeBefore, "Claude configuration and Fluent Reader profile untouched")
        assert.deepEqual(snapshotDir(fx.repo), repoBefore, "repository untouched")
    })

    test("deterministic: two builds of the same commit give the same ZIP; the second uses the runtime cache", async () => {
        const fx = fixture()
        const first = options(fx)
        const a = await buildPortable(first, fakes(fx).deps)
        const f = fakes(fx)
        const b = await buildPortable(options(fx, { runtimeCache: path.join(first.outDir, "runtime-cache") }), f.deps)
        assert.equal(a.sha256, b.sha256)
        assert.deepEqual(f.fetched, [])
    })

    test("dry run: every check, no download, nothing written", async () => {
        const fx = fixture()
        const f = fakes(fx)
        const opts = options(fx, { dryRun: true })
        const lines: string[] = []
        const result = await buildPortable(opts, { ...f.deps, log: (line) => lines.push(line) })
        assert.equal(result.dryRun, true)
        assert.equal(fs.existsSync(opts.outDir), false)
        assert.deepEqual(f.fetched, [])
        assert.ok(lines.some((l) => /downloaded nothing and created no file/.test(l)))
        assert.ok(!f.calls.some((c) => /npm-cli|tsc|node\.exe/.test(c)), "no compilation, install or runtime started")
    })
})

describe("builder pipeline refusals", { timeout: 60_000 }, () => {
    async function refused(fx: Fixture, f: Fakes, opts: BuildOptions, message: RegExp): Promise<void> {
        await assert.rejects(buildPortable(opts, f.deps), (error: unknown) => error instanceof BuildError && message.test(error.message))
        const zip = path.join(opts.outDir, "fluent-reader-mcp-v0.1.0-beta-win-x64.zip")
        for (const file of [zip, `${zip}.sha256`, `${zip}.partial`, `${zip}.build-report.json`]) assert.equal(fs.existsSync(file), false, file)
        void fx
    }

    test("an incompatible build platform is refused before anything is written", async () => {
        const fx = fixture()
        const opts = options(fx)
        await refused(fx, fakes(fx, { platform: "linux" }), opts, /Windows x64 only/)
        assert.equal(fs.existsSync(opts.outDir), false)
    })

    test("missing prerequisites: npm CLI, TypeScript, Node 24 on the build machine", async () => {
        const fx = fixture()
        await refused(fx, fakes(fx, { npmCli: null }), options(fx), /npm-cli\.js not found/)
        const f = fakes(fx)
        await refused(fx, { ...f, deps: { ...f.deps, nodeVersion: "v22.12.0" } }, options(fx), /needs Node\.js/)
        fs.rmSync(path.join(fx.repo, "node_modules", "typescript"), { recursive: true })
        await refused(fx, fakes(fx), options(fx), /TypeScript not found/)
    })

    test("output inside the repository, or existing artifacts, are refused", async () => {
        const fx = fixture()
        await refused(fx, fakes(fx), options(fx, { outDir: path.join(fx.repo, "out") }), /outside the repository/)
        const opts = options(fx)
        fs.mkdirSync(opts.outDir, { recursive: true })
        fs.writeFileSync(path.join(opts.outDir, "fluent-reader-mcp-v0.1.0-beta-win-x64.zip"), "previous")
        await assert.rejects(buildPortable(opts, fakes(fx).deps), /nothing is overwritten/)
        assert.equal(fs.readFileSync(path.join(opts.outDir, "fluent-reader-mcp-v0.1.0-beta-win-x64.zip"), "utf8"), "previous")
    })

    test("a dirty working tree is refused unless --allow-dirty, which is recorded", async () => {
        const fx = fixture()
        await refused(fx, fakes(fx, { dirty: true }), options(fx), /--allow-dirty/)
        const result = await buildPortable(options(fx, { allowDirty: true }), fakes(fx, { dirty: true }).deps)
        assert.equal(result.manifest?.source.gitDirty, true)
    })

    test("a runtime whose hash differs from the pin is refused and not cached", async () => {
        const fx = fixture()
        const opts = options(fx)
        await refused(fx, fakes(fx, { runtimeBytes: Buffer.concat([RUNTIME_ZIP, Buffer.from("x")]) }), opts, /refused/)
        assert.deepEqual(fs.readdirSync(path.join(opts.outDir, "runtime-cache")), [])
    })

    test("a runtime that reports another version is refused", async () => {
        const fx = fixture()
        await refused(fx, fakes(fx, { runtimeVersion: "24.21.0" }), options(fx), /reports v24\.21\.0/)
    })

    test("personal data reaching the staging fails the build", async () => {
        const fx = fixture()
        await refused(fx, fakes(fx, { afterInstall: (prefix) => write(path.join(prefix, "node_modules", "fake-dep", ".env"), "TOKEN=x") }), options(fx), /forbidden content.*\.env/)
    })

    test("an install that touches the repository's node_modules fails the build", async () => {
        const fx = fixture()
        await refused(fx, fakes(fx, { afterInstall: (_prefix, repo) => write(path.join(repo, "node_modules", ".package-lock.json"), "{\"changed\":true}") }), options(fx), /repository's node_modules/)
    })

    test("an installed dependency set different from package-lock.json fails the build", async () => {
        const fx = fixture()
        const extra = (prefix: string): void => write(path.join(prefix, "node_modules", "left-pad", "package.json"), JSON.stringify({ name: "left-pad", version: "1.3.0" }))
        await refused(fx, fakes(fx, { afterInstall: extra }), options(fx), /unexpected left-pad@1\.3\.0/)
    })

    test("a failing self-test publishes nothing", async () => {
        const fx = fixture()
        const failing: SelfTestFn = async () => { throw new BuildError("self-test: synthetic failure") }
        await refused(fx, fakes(fx, { selfTest: failing }), options(fx), /synthetic failure/)
    })
})

describe("self-test protocol (build machine Node + repository server, not a package)", { timeout: 60_000 }, () => {
    test("handshake, nine tools, synthetic reads and clean exit", async () => {
        const lines = await runSelfTest({ nodeExe: process.execPath, entrypoint: MAIN_JS, env: process.env })
        assert.equal(lines.length, 3)
    })

    test("a server that is not the MCP server fails the self-test", async () => {
        counter++
        const fake = path.join(root, `not a server ${counter} é.mjs`)
        fs.writeFileSync(fake, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); process.stdout.write('hello\\n')")
        await assert.rejects(runSelfTest({ nodeExe: process.execPath, entrypoint: fake, env: process.env }), BuildError)
    })
})

const ZIP_NAME = "fluent-reader-mcp-v0.1.0-beta-win-x64.zip"
const FINALS = [ZIP_NAME, `${ZIP_NAME}.sha256`, `${ZIP_NAME}.build-report.json`]

function allText(dir: string): string {
    if (!fs.existsSync(dir)) return ""
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
            const file = path.join(e.parentPath, e.name)
            return file.endsWith(".zip") ? zipText(file) : fs.readFileSync(file, "utf8")
        })
        .join("\n")
}

describe("npm configuration isolation", { timeout: 60_000 }, () => {
    test("user/global config, cache and logs are confined to <work>/npm; personal npm settings have no effect", async () => {
        const fx = fixture()
        const homeBefore = snapshotDir(fx.home)
        const f = fakes(fx)
        const opts = options(fx)
        const result = await buildPortable(opts, f.deps)
        assert.equal(f.npmCalls.length, 1)
        const call = f.npmCalls[0]!
        const npmDir = path.join(canonicalPath(opts.outDir), "work-0.1.0", "npm")
        for (const flag of ["--userconfig", "--globalconfig", "--cache", "--logs-dir", "--registry", "--prefix"]) {
            assert.equal(call.args.filter((a) => a === flag).length, 1, `${flag} passed exactly once`)
        }
        assert.equal(call.userconfig, path.join(npmDir, "user.npmrc"))
        assert.equal(call.globalconfig, path.join(npmDir, "global.npmrc"))
        assert.equal(call.cache, path.join(npmDir, "cache"))
        assert.equal(call.logsDir, path.join(npmDir, "logs"))
        for (const p of [call.userconfig, call.globalconfig, call.cache, call.logsDir]) assert.equal(isInside(p, fx.home), false, p)
        assert.equal(call.userconfigText, `registry=${NPM_REGISTRY}\naudit=false\nfund=false\nupdate-notifier=false\n`)
        assert.equal(call.globalconfigText, "")
        assert.equal(call.args[call.args.indexOf("--registry") + 1], NPM_REGISTRY)
        for (const flag of ["--omit=dev", "--ignore-scripts", "--os=win32", "--cpu=x64"]) assert.ok(call.args.includes(flag), flag)

        assert.deepEqual(Object.keys(call.env).sort(), [...NPM_ENV_KEYS].sort(), "npm got exactly the allowlist, not a copy of the parent environment")
        for (const name of [...Object.keys(ENV_SENTINELS), "HTTPS_PROXY", "NODE_AUTH_TOKEN", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "npm_config_userconfig", "npm_execpath"]) {
            assert.equal(Object.keys(call.env).some((k) => k.toUpperCase() === name.toUpperCase()), false, `${name} not passed to npm`)
        }
        for (const [name, value] of Object.entries(call.env)) {
            assert.equal(value?.includes(NPM_SENTINEL), false, `${name} carries no sentinel`)
            assert.equal(value?.toLowerCase().includes(fx.home.toLowerCase()), false, `${name} does not point into the personal home`)
        }
        assert.equal(call.env.SystemRoot, "C:\\Windows")
        assert.equal(call.env.WINDIR, "C:\\Windows")
        assert.equal(call.env.ComSpec, "C:\\Windows\\system32\\cmd.exe")
        assert.equal(call.env.PATH, [path.dirname(f.deps.nodeExecPath), "C:\\Windows\\System32", "C:\\Windows"].join(";"))
        assert.equal(call.env.PATHEXT, ".COM;.EXE;.BAT;.CMD")
        for (const name of ["HOME", "USERPROFILE"]) assert.equal(call.env[name], path.join(npmDir, "home"))
        assert.equal(call.env.APPDATA, path.join(npmDir, "home", "AppData", "Roaming"))
        assert.equal(call.env.LOCALAPPDATA, path.join(npmDir, "home", "AppData", "Local"))
        for (const name of ["TEMP", "TMP"]) assert.equal(call.env[name], path.join(npmDir, "tmp"))
        assert.equal(call.args[0], fx.npmCli, "npm-cli.js by absolute path")
        assert.ok(path.isAbsolute(call.args[0]!))

        const entries = readZip(fs.readFileSync(result.zipPath))
        assert.equal(entries.find((e) => e.name.endsWith("fake-dep/registry.txt"))?.read().toString("utf8"), `${NPM_REGISTRY}\n`, "the effective registry was the public one, no token")
        assert.ok(!entries.some((e) => /_cacache|debug-0\.log|\.npmrc/.test(e.name)), "no npm cache or log in the package")
        assert.equal(allText(opts.outDir).includes(NPM_SENTINEL), false, "no sentinel in the ZIP, .sha256 or report")
        assert.equal(f.lines.join("\n").includes(NPM_SENTINEL), false, "no sentinel in the builder log")
        assert.deepEqual(snapshotDir(fx.home), homeBefore, "personal .npmrc, npm cache and logs untouched")
    })

    test("a failing npm reports the isolated configuration; its logs stay in the work directory, without sentinels", async () => {
        const fx = fixture()
        const homeBefore = snapshotDir(fx.home)
        const opts = options(fx)
        const f = fakes(fx, { npmFails: true })
        await assert.rejects(buildPortable(opts, f.deps), (error: unknown) => {
            assert.ok(error instanceof BuildError)
            assert.match(error.message, /isolated configuration .*registry\.npmjs\.org.*private npm configuration is not supported/)
            assert.ok(error.message.includes(path.join("work-0.1.0", "npm", "logs")))
            assert.equal(error.message.includes(NPM_SENTINEL), false)
            return true
        })
        const log = fs.readFileSync(path.join(canonicalPath(opts.outDir), "work-0.1.0", "npm", "logs", "debug-0.log"), "utf8")
        assert.ok(log.includes("env="), "the fake npm logged the environment it received")
        assert.equal(log.includes(NPM_SENTINEL), false, "npm never saw the personal configuration or environment")
        assert.equal(log.toLowerCase().includes(fx.home.toLowerCase().replaceAll("\\", "\\\\")), false, "nor the personal home")
        assert.deepEqual(snapshotDir(fx.home), homeBefore)
        for (const name of FINALS) assert.equal(fs.existsSync(path.join(opts.outDir, name)), false)
    })
})

describe("canonical output paths", { timeout: 60_000 }, () => {
    async function refusedBeforeWriting(fx: Fixture, opts: BuildOptions, message: RegExp): Promise<void> {
        const repoBefore = snapshotDir(fx.repo)
        const outExisted = fs.existsSync(opts.outDir)
        const cacheExisted = opts.runtimeCache !== undefined && fs.existsSync(opts.runtimeCache)
        const f = fakes(fx)
        await assert.rejects(buildPortable(opts, f.deps), (error: unknown) => error instanceof BuildError && message.test(error.message))
        assert.equal(fs.existsSync(opts.outDir), outExisted, "--out not created")
        if (opts.runtimeCache !== undefined) assert.equal(fs.existsSync(opts.runtimeCache), cacheExisted, "cache not created")
        assert.deepEqual(f.fetched, [], "nothing downloaded")
        assert.equal(f.npmCalls.length, 0, "npm not started")
        assert.deepEqual(snapshotDir(fx.repo), repoBefore, "repository untouched")
    }

    function junction(target: string): string {
        counter++
        const link = path.join(root, `junction ${counter} é`)
        fs.symlinkSync(target, link, "junction")
        return link
    }

    test("--out directly inside the repository, or a case variant of it: refused", async () => {
        const fx = fixture()
        await refusedBeforeWriting(fx, options(fx, { outDir: path.join(fx.repo, "out") }), /outside the repository/)
        await refusedBeforeWriting(fx, options(fx, { outDir: path.join(fx.repo.toUpperCase(), "OUT É") }), /outside the repository/)
    })

    test("--out through a junction that leads into the repository, or contains it: refused", async () => {
        const fx = fixture()
        await refusedBeforeWriting(fx, options(fx, { outDir: path.join(junction(fx.repo), "out é") }), /outside the repository .*links and junctions resolved/)
        await refusedBeforeWriting(fx, options(fx, { outDir: junction(path.dirname(fx.repo)) }), /must not contain it/)
    })

    test("--out through a junction to an external directory: accepted, written at the real target", async () => {
        const fx = fixture()
        counter++
        const target = path.join(root, `real out ${counter} 😀`)
        fs.mkdirSync(target)
        const f = fakes(fx)
        const result = await buildPortable(options(fx, { outDir: junction(target) }), f.deps)
        assert.equal(result.zipPath, path.join(canonicalPath(target), ZIP_NAME))
        assert.ok(fs.existsSync(path.join(target, ZIP_NAME)))
        assert.ok(f.lines.some((l) => /--out resolves/.test(l)))
    })

    test("a runtime cache overlapping work, staging, verification, the output root, an artifact or the repository: refused", async () => {
        const fx = fixture()
        const cases: [(o: BuildOptions) => string, RegExp][] = [
            [(o) => path.join(o.outDir, "work-0.1.0"), /overlap the work directory/],
            [(o) => path.join(o.outDir, "work-0.1.0", "stage", "FluentReaderMCP", "cache é"), /overlap the work directory/],
            [(o) => path.join(o.outDir, "work-0.1.0", "verify"), /overlap the work directory/],
            [(o) => o.outDir, /overlap the work directory/],
            [(o) => path.dirname(o.outDir), /overlap/],
            [(o) => path.join(o.outDir, ZIP_NAME), /overlap the ZIP/],
            [(o) => path.join(o.outDir, `${ZIP_NAME}.partial`), /overlap the prepared ZIP/],
            [(o) => path.join(o.outDir, `${ZIP_NAME}.sha256.partial`), /overlap the prepared \.sha256 file/],
            [() => path.join(fx.repo, "cache"), /overlap the repository/],
            [() => path.join(junction(fx.repo), "cache"), /overlap the repository .*links and junctions resolved/],
            [(o) => path.join(o.outDir.toUpperCase(), "WORK-0.1.0", "x"), /overlap the work directory/],
        ]
        for (const [cache, message] of cases) {
            const o = options(fx)
            await refusedBeforeWriting(fx, { ...o, runtimeCache: cache(o) }, message)
        }
    })

    test("a dangling junction on the way is refused (ambiguous destination)", async () => {
        const fx = fixture()
        counter++
        const gone = path.join(root, `gone ${counter}`)
        fs.mkdirSync(gone)
        const link = junction(gone)
        fs.rmSync(gone, { recursive: true })
        await refusedBeforeWriting(fx, options(fx, { runtimeCache: path.join(link, "cache") }), /cannot resolve/)
    })

    test("a separate external cache with spaces and Unicode: accepted and used", async () => {
        const fx = fixture()
        counter++
        const cache = path.join(root, `runtime cache ${counter} ü 📦`)
        const result = await buildPortable(options(fx, { runtimeCache: cache }), fakes(fx).deps)
        assert.ok(result.sha256 !== null)
        assert.deepEqual(fs.readdirSync(cache), [`${ARCHIVE_ROOT}.zip`])
    })
})

describe("two-phase publication with rollback", { timeout: 120_000 }, () => {
    function withOwnerFiles(fx: Fixture): { opts: BuildOptions; owner: Record<string, string> } {
        const opts = options(fx)
        fs.mkdirSync(opts.outDir, { recursive: true })
        const owner = { "owner notes é.txt": "owner", "fluent-reader-mcp-v0.0.9-beta-win-x64.zip": "older release" }
        for (const [name, content] of Object.entries(owner)) fs.writeFileSync(path.join(opts.outDir, name), content)
        return { opts, owner }
    }

    function assertNothingPublished(opts: BuildOptions, owner: Record<string, string>): void {
        for (const name of FINALS) assert.equal(fs.existsSync(path.join(opts.outDir, name)), false, `${name} not published`)
        for (const name of FINALS) assert.equal(fs.existsSync(path.join(opts.outDir, `${name}.partial`)), false, `${name}.partial removed`)
        for (const [name, content] of Object.entries(owner)) assert.equal(fs.readFileSync(path.join(opts.outDir, name), "utf8"), content, `${name} unchanged`)
    }

    const faults: [CheckpointStep, boolean, RegExp][] = [
        ["zip-prepared", true, /injected/],
        ["cleanup-work", true, /injected/],
        ["before-publish", false, /injected/],
        ["promote:zip", false, /publication failed .*every artifact published by this run was removed/],
        ["promote:sha256", false, /publication failed .*every artifact published by this run was removed/],
        ["promote:report", false, /publication failed .*every artifact published by this run was removed/],
    ]
    for (const [step, workKept, message] of faults) {
        test(`a fault at ${step}: error, nothing published, owner files unchanged`, async () => {
            const fx = fixture()
            const { opts, owner } = withOwnerFiles(fx)
            const seen: string[] = []
            const f = fakes(fx, { checkpoint: (s) => { seen.push(s); if (s === step) throw new Error(`injected fault at ${s}`) } })
            await assert.rejects(buildPortable(opts, f.deps), message)
            assert.ok(seen.includes(step))
            assertNothingPublished(opts, owner)
            assert.equal(fs.existsSync(path.join(opts.outDir, "work-0.1.0")), workKept, "work directory kept only if the failure came before its cleanup")
            if (workKept) assert.ok(f.lines.some((l) => /Work directory kept for inspection, it is not an artifact/.test(l)))
            assert.deepEqual(fs.readdirSync(opts.outDir).filter((n) => !Object.keys(owner).includes(n)).sort(), workKept ? ["runtime-cache", "work-0.1.0"] : ["runtime-cache"])
        })
    }

    test("a final name that appears before the promotion: refused, the existing file untouched", async () => {
        const fx = fixture()
        const { opts, owner } = withOwnerFiles(fx)
        const sha = path.join(opts.outDir, `${ZIP_NAME}.sha256`)
        const f = fakes(fx, { checkpoint: (s) => { if (s === "before-publish") fs.writeFileSync(sha, "owner content") } })
        await assert.rejects(buildPortable(opts, f.deps), /already exists, nothing is overwritten/)
        assert.equal(fs.readFileSync(sha, "utf8"), "owner content")
        for (const name of [ZIP_NAME, `${ZIP_NAME}.build-report.json`]) assert.equal(fs.existsSync(path.join(opts.outDir, name)), false)
        for (const name of FINALS) assert.equal(fs.existsSync(path.join(opts.outDir, `${name}.partial`)), false)
        for (const [name, content] of Object.entries(owner)) assert.equal(fs.readFileSync(path.join(opts.outDir, name), "utf8"), content)
    })

    for (const [kind, name] of [["zip", ZIP_NAME], ["report", `${ZIP_NAME}.build-report.json`]] as const) {
        test(`the former check-then-rename window (${kind}): an owner file created right before the link is never overwritten`, async () => {
            const fx = fixture()
            const { opts, owner } = withOwnerFiles(fx)
            const out = canonicalPath(opts.outDir)
            const target = path.join(out, name)
            const ownerBytes = Buffer.concat([Buffer.from([0x00, 0xff, 0x0d, 0x0a]), Buffer.from(`OWNER_${kind}_BYTES é`)])
            let finalsAtInjection: boolean[] = []
            const f = fakes(fx, {
                checkpoint: (s) => {
                    if (s !== `promote:${kind}`) return
                    // After every existence check of the builder, immediately before its atomic link.
                    finalsAtInjection = FINALS.map((n) => fs.existsSync(path.join(out, n)))
                    fs.writeFileSync(target, ownerBytes, { flag: "wx" })
                },
            })
            await assert.rejects(buildPortable(opts, f.deps), (error: unknown) =>
                error instanceof BuildError && /publication failed \(already exists, nothing is overwritten: .*\); every artifact published by this run was removed/.test(error.message))
            assert.deepEqual(finalsAtInjection, kind === "zip" ? [false, false, false] : [true, true, false], "the earlier artifacts were already promoted: the preflight was behind")
            assert.deepEqual(fs.readFileSync(target), ownerBytes, "the owner's bytes are unchanged")
            for (const n of FINALS) if (n !== name) assert.equal(fs.existsSync(path.join(out, n)), false, `${n} rolled back`)
            for (const n of FINALS) assert.equal(fs.existsSync(path.join(out, `${n}.partial`)), false, `${n}.partial removed`)
            for (const [n, content] of Object.entries(owner)) assert.equal(fs.readFileSync(path.join(out, n), "utf8"), content)
            assert.equal(f.lines.some((l) => /^Package:/.test(l)), false, "no PASS line")
        })
    }

    function promotionDir(label: string): string {
        counter++
        const d = path.join(root, `${label} ${counter} é`)
        fs.mkdirSync(d)
        return d
    }

    type Kind = "zip" | "sha256" | "report"
    function prepare(owned: OwnedFiles, d: string, kind: Kind): readonly [Kind, string, string] {
        owned.create(path.join(d, `${kind}.partial`), kind)
        return [kind, path.join(d, `${kind}.partial`), path.join(d, kind)]
    }
    const fsOps = { link: fs.linkSync, unlink: fs.unlinkSync, checkpoint: () => undefined }

    test("this Windows volume: a hard link adds a name to the same file and refuses an existing name with EEXIST (rename would replace it)", () => {
        const d = promotionDir("link semantics")
        const a = path.join(d, "a.partial")
        const b = path.join(d, "b ü")
        fs.writeFileSync(a, "prepared")
        fs.linkSync(a, b)
        assert.equal(fs.readFileSync(b, "utf8"), "prepared")
        assert.equal(fs.statSync(a, { bigint: true }).ino, fs.statSync(b, { bigint: true }).ino)
        fs.unlinkSync(a)
        assert.equal(fs.readFileSync(b, "utf8"), "prepared", "removing the prepared name keeps the final one")

        fs.writeFileSync(a, "another prepared")
        fs.writeFileSync(path.join(d, "owner"), "owner")
        assert.throws(() => fs.linkSync(a, path.join(d, "owner")), (error: NodeJS.ErrnoException) => error.code === "EEXIST")
        assert.equal(fs.readFileSync(path.join(d, "owner"), "utf8"), "owner", "the existing name is untouched")
        fs.renameSync(a, path.join(d, "owner"))
        assert.equal(fs.readFileSync(path.join(d, "owner"), "utf8"), "another prepared", "renameSync replaces an existing file: why it is no longer used")
    })

    test("assertHardLinks: passes on this volume leaving nothing behind; a volume without hard links stops the build", () => {
        const d = promotionDir("probe")
        assertHardLinks(d)
        assert.deepEqual(fs.readdirSync(d), [])
        const e = promotionDir("probe fat")
        assert.throws(
            () => assertHardLinks(e, () => { throw Object.assign(new Error("not supported"), { code: "EISDIR" }) }),
            (error: unknown) => error instanceof BuildError && /does not support hard links \(EISDIR\).*NTFS/.test(error.message),
        )
    })

    test("promoteArtifacts: a name that appears right before the link: EEXIST, nothing overwritten, the prepared file kept", () => {
        const d = promotionDir("promotion race")
        const owned = new OwnedFiles()
        const artifact = prepare(owned, d, "zip")
        assert.throws(
            () => promoteArtifacts([artifact], owned, { ...fsOps, checkpoint: () => fs.writeFileSync(artifact[2], "owner") }),
            /already exists, nothing is overwritten/,
        )
        assert.equal(fs.readFileSync(artifact[2], "utf8"), "owner")
        assert.equal(fs.readFileSync(artifact[1], "utf8"), "zip")
        assert.equal(owned.owns(artifact[2]), false, "the owner's file is never registered as the build's")
        assert.equal(owned.owns(artifact[1]), true)
    })

    test("promoteArtifacts: a volume where the link fails stops the publication, with no rename fallback", () => {
        const d = promotionDir("no links")
        const owned = new OwnedFiles()
        const artifact = prepare(owned, d, "zip")
        assert.throws(
            () => promoteArtifacts([artifact], owned, { ...fsOps, link: () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }) } }),
            (error: unknown) => error instanceof BuildError && /hard link failed \(EPERM\); --out must be on an NTFS volume, no overwriting fallback/.test(error.message),
        )
        assert.deepEqual(fs.readdirSync(d), ["zip.partial"], "no final name created by any other means")
    })

    test("promoteArtifacts: ordered links; a failed rollback names the file left behind", () => {
        const d = promotionDir("promote")
        const owned = new OwnedFiles()
        promoteArtifacts([prepare(owned, d, "zip"), prepare(owned, d, "sha256"), prepare(owned, d, "report")], owned, fsOps)
        assert.deepEqual(fs.readdirSync(d).sort(), ["report", "sha256", "zip"])
        assert.deepEqual(owned.list("temporary"), [], "prepared names released once published")
        assert.deepEqual(owned.list("final").sort(), ["report", "sha256", "zip"].map((n) => path.join(d, n)).sort())

        const e = promotionDir("promote failing")
        const again = new OwnedFiles()
        const failing = [prepare(again, e, "zip"), prepare(again, e, "sha256"), prepare(again, e, "report")]
        assert.throws(
            () => promoteArtifacts(failing, again, {
                link: (from, to) => { if (to.endsWith("report")) throw new Error("disk full"); fs.linkSync(from, to) },
                unlink: (file) => { if (file.endsWith("sha256")) throw new Error("locked"); fs.unlinkSync(file) },
                checkpoint: () => undefined,
            }),
            (error: unknown) => error instanceof BuildError && /disk full.*ROLLBACK FAILED: check these files by hand: .*sha256 \(locked\)$/.test(error.message),
        )
        assert.equal(fs.existsSync(path.join(e, "zip")), false, "rolled back")
        assert.equal(fs.existsSync(path.join(e, "sha256")), true, "the file the rollback could not remove is reported")
    })
})

describe("ownership of the temporary files", { timeout: 120_000 }, () => {
    const late: [CheckpointStep, string][] = [
        ["before-zip", `${ZIP_NAME}.partial`],
        ["zip-prepared", `${ZIP_NAME}.sha256.partial`],
        ["zip-prepared", `${ZIP_NAME}.build-report.json.partial`],
    ]
    for (const [step, name] of late) {
        test(`an owner's ${name} appearing after the preflight (at ${step}): EEXIST, kept byte for byte; only the build's own temporaries removed`, async () => {
            const fx = fixture()
            const opts = options(fx)
            const out = canonicalPath(opts.outDir)
            const ownerBytes = Buffer.concat([Buffer.from(`OWNER_PARTIAL ${name} `), Buffer.from([0x00, 0x01, 0xfe])])
            const f = fakes(fx, {
                checkpoint: (s) => {
                    if (s !== step) return
                    assert.equal(fs.existsSync(path.join(out, "work-0.1.0")), true, "the preflight is behind")
                    fs.writeFileSync(path.join(out, name), ownerBytes, { flag: "wx" })
                },
            })
            await assert.rejects(buildPortable(opts, f.deps), (error: unknown) => error instanceof BuildError && error.message === `already exists, nothing is overwritten: ${path.join(out, name)}`)
            assert.deepEqual(fs.readFileSync(path.join(out, name)), ownerBytes, "the owner's file keeps its bytes")
            for (const own of FINALS.map((n) => `${n}.partial`).filter((n) => n !== name)) assert.equal(fs.existsSync(path.join(out, own)), false, `${own} (the build's, when created) removed`)
            for (const n of FINALS) assert.equal(fs.existsSync(path.join(out, n)), false)
            assert.equal(f.lines.some((l) => /^Cleanup:/.test(l)), false, "no cleanup problem")
        })
    }

    test("a temporary of the build replaced before the cleanup is left in place and reported; the build's error is kept", async () => {
        const fx = fixture()
        const opts = options(fx)
        const out = canonicalPath(opts.outDir)
        const sha = path.join(out, `${ZIP_NAME}.sha256.partial`)
        const f = fakes(fx, {
            checkpoint: (s) => {
                if (s !== "cleanup-work") return
                fs.unlinkSync(sha)
                fs.writeFileSync(sha, "OWNER_REPLACEMENT", { flag: "wx" })
                throw new Error("injected fault after the replacement")
            },
        })
        await assert.rejects(buildPortable(opts, f.deps), (error: unknown) => error instanceof Error && !(error instanceof BuildError) && error.message === "injected fault after the replacement")
        assert.equal(fs.readFileSync(sha, "utf8"), "OWNER_REPLACEMENT")
        assert.equal(fs.existsSync(path.join(out, `${ZIP_NAME}.partial`)), false, "the build's ZIP .partial removed")
        assert.equal(fs.existsSync(path.join(out, `${ZIP_NAME}.build-report.json.partial`)), false, "the build's report .partial removed")
        assert.ok(f.lines.some((l) => /^Cleanup: .*sha256\.partial \(replaced by another file since this build created it: left in place\)/.test(l)))
    })

    test("OwnedFiles: ownership only from a successful exclusive creation; removal only of registered, unchanged files", () => {
        counter++
        const d = path.join(root, `owned ${counter} é`)
        fs.mkdirSync(d)
        const owned = new OwnedFiles()
        const mine = path.join(d, "mine.partial")
        const theirs = path.join(d, "theirs.partial")
        fs.writeFileSync(theirs, "OWNER")
        owned.create(mine, "build")
        assert.throws(() => owned.create(theirs, "build"), (error: unknown) => error instanceof BuildError && /already exists, nothing is overwritten/.test(error.message))
        assert.equal(owned.owns(theirs), false)
        assert.equal(fs.readFileSync(theirs, "utf8"), "OWNER")
        assert.match(owned.remove(theirs) ?? "", /not created by this build: left in place/)
        assert.equal(fs.existsSync(theirs), true)
        assert.match(owned.remove(mine, () => { throw new Error("locked") }) ?? "", /\(locked\)$/)
        assert.equal(owned.owns(mine), true, "still the build's after a failed removal")
        assert.equal(owned.remove(mine), null)
        assert.equal(fs.existsSync(mine), false)
        assert.deepEqual(owned.list("temporary"), [])
    })
})
