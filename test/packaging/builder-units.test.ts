/**
 * FR-MCP-04-BETA-01: unit tests of the portable builder, on small synthetic
 * files only. No network, no download, no real runtime and no real package:
 * these tests do not prove that a built bundle starts (the owner's build does).
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { parseArgs } from "../../installer/build-portable.js"
import { assertRelativePath, BuildError, canonicalPath, childEnv, listFiles, overlaps, safeJoin, sha256Bytes } from "../../installer/lib/common.js"
import {
    artifactName,
    assertProductionSet,
    assertServerDist,
    buildManifest,
    ENTRYPOINT,
    expectedProductionPackages,
    forbiddenFiles,
    INFO,
    KOFFI_NATIVE,
    MANIFEST,
    RUNTIME_EXE,
    verifyManifest,
} from "../../installer/lib/package-content.js"
import { acquireRuntimeArchive, extractRuntime, shasumFor, type FetchFn } from "../../installer/lib/runtime.js"
import { parseRuntimeLock, satisfiesRange, type RuntimeLock } from "../../installer/lib/runtime-lock.js"
import { assertBuildPlatform } from "../../installer/lib/pipeline.js"
import { encodeZip, readZip, writeZip } from "../../installer/lib/zip.js"
import { createTempRoot, removeTempRoot } from "../helpers/fixtures.js"
import { PROJECT_ROOT } from "../helpers/process.js"

let root: string
let counter = 0
before(() => {
    root = createTempRoot()
})
after(() => removeTempRoot(root))

function dir(name = "case"): string {
    counter++
    const d = path.join(root, `${name} ${counter} àè 😀`)
    fs.mkdirSync(d, { recursive: true })
    return d
}

const ENGINES = ">=24.15.0 <25"
const EPOCH = 1767225600

function lockFor(version: string, sha256: string): Record<string, unknown> {
    const archiveRoot = `node-v${version}-win-x64`
    return {
        schemaVersion: 1,
        node: {
            version,
            platform: "win-x64",
            archive: `${archiveRoot}.zip`,
            archiveRoot,
            url: `https://nodejs.org/dist/v${version}/${archiveRoot}.zip`,
            shasumsUrl: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
            sha256,
        },
        attestation: { checkedOn: "2026-10-28", release: "synthetic test release", method: "synthetic test attestation" },
    }
}

const SHA = "ab".repeat(32)

describe("platform and runtime lock", () => {
    test("only Windows x64 is accepted as build platform", () => {
        assertBuildPlatform("win32", "x64")
        for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"], ["win32", "arm64"], ["win32", "ia32"]]) {
            assert.throws(() => assertBuildPlatform(platform as string, arch as string), BuildError)
        }
    })

    test("the committed runtime-lock.json is valid for the committed package.json", () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { engines: { node: string } }
        const lock = parseRuntimeLock(JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "installer", "runtime-lock.json"), "utf8")), pkg.engines.node)
        assert.equal(lock.version, "24.22.1")
        assert.equal(lock.url, "https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip")
        assert.match(lock.sha256, /^[0-9a-f]{64}$/)
    })

    test("engines ranges", () => {
        assert.equal(satisfiesRange("24.22.1", ENGINES), true)
        assert.equal(satisfiesRange("24.14.9", ENGINES), false)
        assert.equal(satisfiesRange("25.0.0", ENGINES), false)
        assert.throws(() => satisfiesRange("24.22.1", "^24"), /unsupported engines comparator/)
    })

    const refusals: [string, (lock: any) => void, RegExp][] = [
        ["Node 22", (l) => Object.assign(l, lockFor("22.12.0", SHA)), /not Node 24/],
        ["Node 25", (l) => Object.assign(l, lockFor("25.1.0", SHA)), /not Node 24/],
        ["Node 24 below engines", (l) => Object.assign(l, lockFor("24.10.0", SHA)), /does not satisfy/],
        ["a malformed version", (l) => { l.node.version = "24.22" }, /MAJOR.MINOR.PATCH/],
        ["a different archive", (l) => { l.node.archive = "node-v24.22.1-win-x86.zip" }, /archive must be/],
        ["a non-official host", (l) => { l.node.url = "https://mirror.example.com/dist/v24.22.1/node-v24.22.1-win-x64.zip" }, /official/],
        ["plain http", (l) => { l.node.url = "http://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip" }, /official/],
        ["a missing sha256", (l) => { l.node.sha256 = "" }, /64 lowercase hex/],
        ["an uppercase sha256", (l) => { l.node.sha256 = SHA.toUpperCase() }, /64 lowercase hex/],
        ["a placeholder sha256", (l) => { l.node.sha256 = "0".repeat(64) }, /placeholder/],
        ["an extra field", (l) => { l.node.mirror = "x" }, /exactly the fields/],
        ["no attestation", (l) => { l.attestation = { checkedOn: "", release: "", method: "" } }, /filled in/],
        ["platform win-arm64", (l) => { l.node.platform = "win-arm64" }, /platform must be win-x64/],
    ]
    for (const [name, change, message] of refusals) {
        test(`refuses ${name}`, () => {
            const lock = lockFor("24.22.1", SHA)
            change(lock)
            assert.throws(() => parseRuntimeLock(lock, ENGINES), (error: unknown) => error instanceof BuildError && message.test(error.message))
        })
    }
})

describe("paths, inventory and environment", () => {
    test("unsafe relative paths are refused; spaces and Unicode are fine", () => {
        for (const bad of ["", "../x", "a/../b", "/abs", "C:/x", "a\\b", "a//b", "./a", "a/", "a\0b", "\\\\server\\share"]) {
            assert.throws(() => assertRelativePath(bad), BuildError, JSON.stringify(bad))
        }
        const base = dir()
        assert.equal(safeJoin(base, "server/dist/ é 😀 x.js"), path.join(base, "server", "dist", " é 😀 x.js"))
    })

    test("the inventory is sorted ordinally, stable and \"/\"-separated", () => {
        const base = dir()
        for (const name of ["b/z.txt", "Z.txt", "a b/é.txt", "a b/e.txt", "😀.txt", "a.txt"]) {
            fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true })
            fs.writeFileSync(path.join(base, name), name)
        }
        const files = listFiles(base)
        assert.deepEqual(files, ["Z.txt", "a b/e.txt", "a b/é.txt", "a.txt", "b/z.txt", "😀.txt"])
        assert.deepEqual(listFiles(base), files)
    })

    test("links and junctions in the staging are refused", () => {
        const base = dir()
        const outside = dir("outside")
        fs.symlinkSync(outside, path.join(base, "escape"), "junction")
        assert.throws(() => listFiles(base), /link in the package staging/)
    })

    test("canonical paths resolve junctions for paths that do not exist yet", () => {
        const target = dir("junction target")
        const link = path.join(dir("links"), "link é")
        fs.symlinkSync(target, link, "junction")
        assert.equal(canonicalPath(path.join(link, "new dir", "file ü.zip")), path.join(fs.realpathSync.native(target), "new dir", "file ü.zip"))
        assert.equal(canonicalPath(link.toUpperCase()), fs.realpathSync.native(target))
        assert.throws(() => canonicalPath("relative\\x"), /not an absolute path/)
        const gone = dir("gone")
        const dangling = path.join(dir("links"), "dangling")
        fs.symlinkSync(gone, dangling, "junction")
        fs.rmSync(gone, { recursive: true })
        assert.throws(() => canonicalPath(path.join(dangling, "x")), /cannot resolve/)
    })

    test("overlap is symmetric and case-insensitive on Windows", () => {
        assert.equal(overlaps("C:\\Out\\Work", "c:\\out"), true)
        assert.equal(overlaps("c:\\out", "C:\\OUT\\work\\stage"), true)
        assert.equal(overlaps("C:\\out", "C:\\out"), true)
        assert.equal(overlaps("C:\\out-cache", "C:\\out"), false)
        assert.equal(overlaps("C:\\out\\runtime-cache", "C:\\out\\work-0.1.0"), false)
    })

    test("child environments drop npm_* and module/profile overrides", () => {
        const env = childEnv({ PATH: "p", npm_config_local_prefix: "repo", NPM_EXECPATH: "x", NODE_OPTIONS: "--require evil", NODE_PATH: "x", FLUENT_READER_PROFILE_DIR: "x", INIT_CWD: "x" })
        assert.deepEqual(env, { PATH: "p" })
    })

    test("the package:win script starts no batch file (cmd.exe would then mangle quoted paths)", () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
        const steps = (pkg.scripts["package:win"] ?? "").split("&&").map((step) => step.trim())
        assert.deepEqual(steps.map((step) => step.split(" ")[0]), ["node", "node"])
        assert.equal(steps.at(-1), "node dist-test/installer/build-portable.js", "user arguments reach the builder")
    })

    test("command line options: --out is required, unknown options refused", () => {
        assert.throws(() => parseArgs([], PROJECT_ROOT), /--out is required/)
        assert.throws(() => parseArgs(["--out"], PROJECT_ROOT), /needs a value/)
        assert.throws(() => parseArgs(["--out", "C:\\x", "--force"], PROJECT_ROOT), /unknown argument/)
        assert.deepEqual(parseArgs(["--out", "C:\\out dir é", "--dry-run", "--runtime-cache", "C:\\cache"], PROJECT_ROOT), {
            repoRoot: PROJECT_ROOT, outDir: "C:\\out dir é", runtimeCache: "C:\\cache", dryRun: true, allowDirty: false, keepWork: false,
        })
    })
})

describe("ZIP writer and reader", () => {
    const entries = [
        { name: "FluentReaderMCP/a b/é 😀.txt", data: Buffer.from("unicode ".repeat(50)) },
        { name: "FluentReaderMCP/empty.txt", data: Buffer.alloc(0) },
        { name: "FluentReaderMCP/random.bin", data: Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 256)) },
    ]

    test("round trip with spaces, Unicode, empty and incompressible files", () => {
        const file = path.join(dir(), "out é.zip")
        writeZip(file, entries, EPOCH)
        const read = readZip(fs.readFileSync(file))
        assert.deepEqual(read.map((e) => e.name), entries.map((e) => e.name))
        for (const [i, entry] of read.entries()) assert.deepEqual(entry.read(), entries[i]?.data)
    })

    test("deterministic: same entries and epoch give identical bytes", () => {
        assert.equal(sha256Bytes(encodeZip(entries, EPOCH)), sha256Bytes(encodeZip(entries, EPOCH)))
        assert.notEqual(sha256Bytes(encodeZip(entries, EPOCH)), sha256Bytes(encodeZip(entries, EPOCH + 60)))
    })

    test("the writer refuses unsafe and duplicate names and never overwrites", () => {
        const d = dir()
        assert.throws(() => writeZip(path.join(d, "a.zip"), [{ name: "../evil", data: Buffer.from("x") }], EPOCH), /unsafe/)
        assert.throws(() => writeZip(path.join(d, "b.zip"), [{ name: "A/x", data: Buffer.alloc(1) }, { name: "a/X", data: Buffer.alloc(1) }], EPOCH), /duplicate/)
        writeZip(path.join(d, "c.zip"), entries, EPOCH)
        assert.throws(() => writeZip(path.join(d, "c.zip"), entries, EPOCH), /EEXIST/)
    })

    test("the reader refuses zip-slip names, corrupted data and duplicates", () => {
        for (const name of ["../evil.txt", "C:/evil.txt", "a\\..\\evil.txt", "/abs.txt"]) {
            assert.throws(() => readZip(encodeZip([{ name, data: Buffer.from("x") }], EPOCH)), BuildError, name)
        }
        const zip = encodeZip([{ name: "a.txt", data: Buffer.from("hello hello hello hello") }], EPOCH)
        zip[35] = (zip[35] ?? 0) ^ 0xff
        assert.throws(() => readZip(zip)[0]?.read(), BuildError)
        assert.throws(() => readZip(encodeZip([{ name: "a.txt", data: Buffer.alloc(1) }, { name: "a.txt", data: Buffer.alloc(1) }], EPOCH)), /duplicate/)
        assert.throws(() => readZip(Buffer.from("not a zip")), /end of central directory/)
    })
})

describe("runtime acquisition (fake fetch, no network)", () => {
    const version = "24.22.1"
    const archiveRoot = `node-v${version}-win-x64`
    const archive = encodeZip([
        { name: `${archiveRoot}/node.exe`, data: Buffer.from("synthetic node.exe") },
        { name: `${archiveRoot}/LICENSE`, data: Buffer.from("synthetic Node licence") },
        { name: `${archiveRoot}/npm.cmd`, data: Buffer.from("not shipped") },
    ], EPOCH)
    const lock = (sha = sha256Bytes(archive)): RuntimeLock => parseRuntimeLock(lockFor(version, sha), ENGINES)

    function fakeFetch(files: Record<string, Buffer | string>, calls: string[] = [], finalUrl?: string): FetchFn {
        return async (url) => {
            calls.push(url)
            const body = files[url]
            if (body === undefined) return { ok: false, status: 404, url, body: null, text: async () => "" }
            const bytes = typeof body === "string" ? Buffer.from(body) : body
            return { ok: true, status: 200, url: finalUrl ?? url, body: new Response(bytes).body, text: async () => bytes.toString("utf8") }
        }
    }
    const shasums = (sha: string): string => `${"cd".repeat(32)}  node-v${version}-x64.msi\n${sha}  node-v${version}-win-x64.zip\n`

    test("download, pin and SHASUMS256.txt agree: kept in the cache; a second build uses the cache only", async () => {
        const cache = dir("cache")
        const l = lock()
        const calls: string[] = []
        const files = { [l.url]: archive, [l.shasumsUrl]: shasums(l.sha256) }
        assert.equal((await acquireRuntimeArchive(l, cache, fakeFetch(files, calls), () => undefined)).source, "download")
        assert.deepEqual(fs.readdirSync(cache), [l.archive])
        assert.equal((await acquireRuntimeArchive(l, cache, fakeFetch(files, calls), () => undefined)).source, "cache")
        assert.deepEqual(calls, [l.url, l.shasumsUrl])
        const runtime = path.join(dir("runtime"), "runtime")
        extractRuntime(l, path.join(cache, l.archive), runtime)
        assert.deepEqual(fs.readdirSync(runtime).sort(), ["LICENSE", "node.exe"])
    })

    test("a downloaded archive with another hash is refused and not kept", async () => {
        const cache = dir("cache")
        const l = lock("12".repeat(32))
        await assert.rejects(acquireRuntimeArchive(l, cache, fakeFetch({ [l.url]: archive, [l.shasumsUrl]: shasums(l.sha256) }), () => undefined), /refused/)
        assert.deepEqual(fs.readdirSync(cache), [])
    })

    test("a pin that the official SHASUMS256.txt does not list is refused", async () => {
        const cache = dir("cache")
        const l = lock()
        await assert.rejects(acquireRuntimeArchive(l, cache, fakeFetch({ [l.url]: archive, [l.shasumsUrl]: shasums("34".repeat(32)) }), () => undefined), /does not list the pinned/)
        assert.deepEqual(fs.readdirSync(cache), [])
    })

    test("a download redirected outside nodejs.org/dist is refused", async () => {
        const cache = dir("cache")
        const l = lock()
        await assert.rejects(acquireRuntimeArchive(l, cache, fakeFetch({ [l.url]: archive }, [], "https://evil.example.com/node.zip"), () => undefined), /outside/)
    })

    test("a corrupted cached archive is refused and left in place; nothing is fetched", async () => {
        const cache = dir("cache")
        const l = lock()
        fs.writeFileSync(path.join(cache, l.archive), "tampered")
        const calls: string[] = []
        await assert.rejects(acquireRuntimeArchive(l, cache, fakeFetch({}, calls), () => undefined), /does not match the pinned sha256/)
        assert.equal(fs.readFileSync(path.join(cache, l.archive), "utf8"), "tampered")
        assert.deepEqual(calls, [])
    })

    test("extraction re-checks the hash and requires node.exe and LICENSE", () => {
        const d = dir()
        const l = lock()
        const file = path.join(d, l.archive)
        fs.writeFileSync(file, archive)
        fs.appendFileSync(file, "x")
        assert.throws(() => extractRuntime(l, file, path.join(d, "runtime")), /changed after verification/)
        const incomplete = encodeZip([{ name: `${archiveRoot}/node.exe`, data: Buffer.from("x") }], EPOCH)
        const file2 = path.join(d, "incomplete.zip")
        fs.writeFileSync(file2, incomplete)
        assert.throws(() => extractRuntime(lock(sha256Bytes(incomplete)), file2, path.join(d, "runtime2")), /has no .*LICENSE/)
    })

    test("SHASUMS256.txt parsing requires exactly one line for the archive", () => {
        assert.equal(shasumFor(shasums(SHA), `node-v${version}-win-x64.zip`), SHA)
        assert.throws(() => shasumFor(shasums(SHA) + shasums(SHA), `node-v${version}-win-x64.zip`), /exactly one/)
        assert.throws(() => shasumFor("", `node-v${version}-win-x64.zip`), /exactly one/)
    })
})

describe("package content and manifest", () => {
    test("personal data, credentials, Claude files and fixtures are refused", () => {
        const problems = forbiddenFiles([
            "server/node_modules/x/fluent-reader.db",
            "server/fluent-reader.db-wal",
            "server/node_modules/x/data.sqlite",
            "server/node_modules/x/.env",
            "server/node_modules/x/.env.local",
            "server/node_modules/x/.npmrc",
            "server/.claude.json",
            "server/.claude/settings.json",
            "server/.mcp.json",
            "claude-transcript.jsonl",
            "baseline.json",
            "server/node_modules/x/key.pem",
            "config.json",
            "server/config.json",
        ])
        assert.equal(problems.length, 14)
        assert.deepEqual(forbiddenFiles(["server/node_modules/x/config.json", "server/node_modules/zod/src/index.ts", "server/dist/main.js", "licenses/npm/zod@4.6.7/LICENSE"]), [])
    })

    test("the compiled server must be JavaScript only", () => {
        assertServerDist(["main.js", "tools/a.js"])
        assert.throws(() => assertServerDist(["main.js", "main.js.map"]), /unexpected files/)
        assert.throws(() => assertServerDist(["main.ts", "main.js"]), /unexpected files/)
        assert.throws(() => assertServerDist(["server.js"]), /no main.js/)
    })

    test("the production set of the real package-lock.json on win32 x64", () => {
        assert.deepEqual(expectedProductionPackages(fs.readFileSync(path.join(PROJECT_ROOT, "package-lock.json"), "utf8")), [
            "@koromix/koffi-win32-x64@3.3.4",
            "@modelcontextprotocol/core@2.4.0",
            "@modelcontextprotocol/server@2.4.0",
            "koffi@3.3.4",
            "zod@4.6.7",
        ])
        assert.throws(() => assertProductionSet(["a@1"], ["a@1", "b@2"]), /missing b@2/)
        assert.throws(() => assertProductionSet(["a@1", "c@3"], ["a@1"]), /unexpected c@3/)
    })

    test("artifact name identifies product, version, beta and Windows x64", () => {
        assert.equal(artifactName("0.1.0"), "fluent-reader-mcp-v0.1.0-beta-win-x64.zip")
    })

    function stagedPackage(): string {
        const stage = path.join(dir("stage"), "FluentReaderMCP")
        for (const file of [RUNTIME_EXE, ENTRYPOINT, "server/dist/tools/é x.js", "server/package.json", KOFFI_NATIVE, INFO, "licenses/node/LICENSE"]) {
            fs.mkdirSync(path.dirname(safeJoin(stage, file)), { recursive: true })
            fs.writeFileSync(safeJoin(stage, file), `synthetic ${file}`)
        }
        return stage
    }
    const input = {
        version: "0.1.0",
        gitCommit: "a".repeat(40),
        gitDirty: false,
        sourceDateEpoch: EPOCH,
        lock: parseRuntimeLock(lockFor("24.22.1", SHA), ENGINES),
        projectLicense: null,
        licenses: [],
    }

    test("a manifest verifies its own package and is stable", () => {
        const stage = stagedPackage()
        const manifest = buildManifest(stage, input)
        assert.deepEqual(verifyManifest(stage, manifest), [])
        assert.deepEqual(buildManifest(stage, input), manifest)
        assert.deepEqual(manifest.launch.args, [ENTRYPOINT, "--profile-dir", "{profileDir}"])
        assert.equal(manifest.files.some((f) => f.path === MANIFEST), false, "the manifest does not list itself")
    })

    test("missing files, extra files, hash and size mismatches are reported", () => {
        const stage = stagedPackage()
        const manifest = buildManifest(stage, input)
        fs.writeFileSync(safeJoin(stage, "server/extra.txt"), "x")
        fs.writeFileSync(safeJoin(stage, ENTRYPOINT), "synthetic server/dist/main.jX")
        fs.appendFileSync(safeJoin(stage, INFO), "longer")
        fs.rmSync(safeJoin(stage, "server/dist/tools/é x.js"))
        assert.deepEqual(verifyManifest(stage, manifest).sort(), [
            "file not in manifest: server/extra.txt",
            "missing file: server/dist/tools/é x.js",
            `sha256 mismatch: ${ENTRYPOINT}`,
            `size mismatch: ${INFO}`,
        ])
    })

    test("an incomplete manifest is refused", () => {
        const stage = stagedPackage()
        const manifest = buildManifest(stage, input) as any
        const without = (change: (m: any) => void): string[] => {
            const m = structuredClone(manifest)
            change(m)
            return verifyManifest(stage, m)
        }
        assert.ok(without((m) => delete m.runtime).length > 0)
        assert.ok(without((m) => { m.launch.args = [ENTRYPOINT] }).some((p) => /--profile-dir/.test(p)))
        assert.ok(without((m) => { m.server.tools = ["list_sources"] }).some((p) => /server section/.test(p)))
        assert.ok(without((m) => { m.files = [] }).some((p) => /no files/.test(p)))
        assert.ok(without((m) => { m.files = m.files.filter((f: any) => f.path !== KOFFI_NATIVE) }).some((p) => p.includes(KOFFI_NATIVE)))
        assert.ok(without((m) => { m.files.reverse() }).some((p) => /sorted/.test(p)))
    })
})
