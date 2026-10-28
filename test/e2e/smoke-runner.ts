/**
 * FR-MCP-02A-06 owner-run smoke test: work directory, pre-spawn validation,
 * the claude run and the verification of its records. Used by smoke-cli.ts;
 * spawn and exec are injectable so that tests never start Claude Code.
 *
 * Trust: the expected MCP launch is derived from the work directory and this
 * harness (Node running it, dist/main.js, <work>/profile), never from
 * mcp-config.json. Before any process is started, `run` requires that
 * mcp-config.json is exactly that launch, that the profile is a real directory
 * of the work directory (no link, junction or hard link), and that its files
 * are byte-identical both to the baseline written by `prepare` and to a
 * fixture rebuilt now by this harness.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { MAIN_JS, PROJECT_ROOT } from "../helpers/process.js"
import {
    claudeArgs,
    decodeTranscript,
    mcpConfig,
    overallVerdict,
    powershellCommand,
    processCheck,
    psQuote,
    SMOKE_SERVER,
    TOOL_NAMES,
    verifyTranscript,
    type Check,
    type McpLaunch,
    type OverallVerdict,
    type ProcessMetadata,
} from "./smoke-claude.js"
import { buildSmokeProfile, integrityDifferences, integritySnapshot, SMOKE_EXPECTED, type IntegritySnapshot } from "./smoke-fixture.js"
import { CONFIG_NAME, DB_NAME } from "../helpers/fixtures.js"

const RUN_TIMEOUT_MS = 10 * 60_000
/** Wait after claude exits, so that its MCP server can observe stdin EOF and exit. */
const SETTLE_MS = 2000
/** After a timeout kill, how long to wait for the exit event before giving up. */
const KILL_GRACE_MS = 5000
const REQUIRED_OPTIONS = ["--mcp-config", "--strict-mcp-config", "--print", "--no-session-persistence", "--output-format", "--tools", "--allowedTools", "--permission-prompts", "--max-budget-usd", "--verbose"]

/** A local, safe failure: nothing has been started when it is thrown before the spawn. */
export class SmokeError extends Error {
    constructor(
        message: string,
        readonly exitCode = 2,
    ) {
        super(message)
    }
}

export interface WorkDir {
    readonly root: string
    readonly profile: string
    readonly cwd: string
    readonly scratch: string
    readonly config: string
    readonly baseline: string
    readonly transcript: string
    readonly stderr: string
    readonly runMetadata: string
    /** Written by `run`. */
    readonly report: string
    /** Written by `verify`; never overwrites report.json. */
    readonly verifyReport: string
}

export function workDir(root: string): WorkDir {
    return {
        root,
        profile: path.join(root, "profile"),
        cwd: path.join(root, "cwd"),
        scratch: path.join(root, "scratch"),
        config: path.join(root, "mcp-config.json"),
        baseline: path.join(root, "baseline.json"),
        transcript: path.join(root, "claude-transcript.jsonl"),
        stderr: path.join(root, "claude-stderr.txt"),
        runMetadata: path.join(root, "run-metadata.json"),
        report: path.join(root, "report.json"),
        verifyReport: path.join(root, "verify-report.json"),
    }
}

function isInside(child: string, parent: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child))
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function samePath(a: string, b: string): boolean {
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The MCP launch this harness expects for a work directory. */
export function expectedLaunch(dir: WorkDir): McpLaunch {
    return { node: process.execPath, mainJs: MAIN_JS, profileDir: dir.profile }
}

export function prepareWorkDir(requested?: string): { dir: WorkDir; instructions: string } {
    const root = requested ?? fs.mkdtempSync(path.join(os.tmpdir(), "frmcp-smoke-"))
    if (!path.isAbsolute(root)) throw new SmokeError("the work directory must be an absolute path")
    if (isInside(root, PROJECT_ROOT)) throw new SmokeError("the work directory must be outside the repository")
    if (fs.existsSync(root) && fs.readdirSync(root).length > 0) throw new SmokeError("the work directory must be new or empty")
    if (!fs.existsSync(MAIN_JS)) throw new SmokeError("dist/main.js is missing: run npm.cmd run build first")
    const dir = workDir(root)
    buildSmokeProfile(dir.profile)
    fs.mkdirSync(dir.cwd, { recursive: true })
    fs.writeFileSync(dir.config, `${JSON.stringify(mcpConfig(expectedLaunch(dir)), null, 2)}\n`)
    const baseline = integritySnapshot(dir.profile, dir.scratch)
    if (!isDeepStrictEqual(baseline.hasRead, SMOKE_EXPECTED.hasRead)) throw new SmokeError("fixture hasRead states differ from the documented ones", 1)
    fs.writeFileSync(dir.baseline, `${JSON.stringify(baseline, null, 2)}\n`)

    const cli = path.join(PROJECT_ROOT, "dist-test", "test", "e2e", "smoke-cli.js")
    const instructions = [
        `Work directory:  ${dir.root}`,
        `Profile:         ${dir.profile}`,
        `MCP config:      ${dir.config}`,
        "",
        "From a separate PowerShell window (not inside Claude Code), run:",
        "",
        `  ${powershellCommand(process.execPath, [cli, "run", dir.root])}`,
        "",
        "Add --claude <path to claude.exe> if claude is not on PATH.",
        "Only `run` validates the configuration before starting claude and records the exit code and timeout;",
        "the raw command below is for diagnosis only: `verify` on its transcript cannot give PASS (process NOT_VERIFIED).",
        "",
        `  Set-Location ${psQuote(dir.cwd)}`,
        `  ${powershellCommand("claude", claudeArgs(dir.config))} > ${psQuote(dir.transcript)}`,
        `  ${powershellCommand(process.execPath, [cli, "verify", dir.root])}`,
        "",
    ].join("\n")
    return { dir, instructions }
}

function describeConfigDifference(actual: unknown, expected: Record<string, unknown>): string {
    const actualRecord = typeof actual === "object" && actual !== null && !Array.isArray(actual) ? (actual as Record<string, unknown>) : undefined
    if (actualRecord === undefined) return "not a JSON object"
    if (!isDeepStrictEqual(Object.keys(actualRecord), ["mcpServers"])) return "unexpected top-level fields"
    const servers = actualRecord.mcpServers
    if (typeof servers !== "object" || servers === null || !isDeepStrictEqual(Object.keys(servers), [SMOKE_SERVER])) return `MCP servers must be exactly ${SMOKE_SERVER}`
    const entry = (servers as Record<string, unknown>)[SMOKE_SERVER] as Record<string, unknown> | null
    const wanted = (expected.mcpServers as Record<string, Record<string, unknown>>)[SMOKE_SERVER] as Record<string, unknown>
    if (typeof entry !== "object" || entry === null) return "server entry is not an object"
    const extra = Object.keys(entry).filter((k) => !(k in wanted))
    if (extra.length > 0) return `unexpected server fields: ${extra.join(", ")}`
    const differing = Object.keys(wanted).filter((k) => !isDeepStrictEqual(entry[k], wanted[k]))
    return `server fields differ from the prepared launch: ${differing.join(", ")}`
}

/** Hashes of the profile files as this harness builds them now (same SQLite version). */
function referenceFiles(dir: WorkDir): IntegritySnapshot["files"] {
    const reference = path.join(dir.scratch, `reference-${crypto.randomUUID()}`)
    try {
        buildSmokeProfile(path.join(reference, "profile"))
        return integritySnapshot(path.join(reference, "profile"), dir.scratch).files
    } finally {
        fs.rmSync(reference, { recursive: true, force: true })
    }
}

function readBaseline(dir: WorkDir): IntegritySnapshot {
    if (!fs.existsSync(dir.baseline)) throw new SmokeError("baseline.json not found: run prepare first")
    try {
        return JSON.parse(fs.readFileSync(dir.baseline, "utf8")) as IntegritySnapshot
    } catch {
        throw new SmokeError("baseline.json is not valid JSON")
    }
}

/**
 * Problems that make the profile unverifiable as the prepared synthetic
 * fixture (empty when it is). Used before the spawn and again after the run.
 */
export function profileIdentityProblems(dir: WorkDir): string[] {
    const problems: string[] = []
    let realRoot: string
    try {
        realRoot = fs.realpathSync.native(dir.root)
    } catch {
        return ["work directory not found"]
    }
    if (!samePath(realRoot, path.resolve(dir.root))) problems.push("the work directory path is redirected (link or junction)")
    let profileStat: fs.Stats
    try {
        profileStat = fs.lstatSync(dir.profile)
    } catch {
        return [...problems, "profile directory not found"]
    }
    if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) return [...problems, "profile is a link, junction or not a directory"]
    if (!samePath(fs.realpathSync.native(dir.profile), path.join(realRoot, "profile"))) problems.push("profile resolves outside the work directory")
    const entries = fs.readdirSync(dir.profile).sort()
    if (!isDeepStrictEqual(entries, [CONFIG_NAME, DB_NAME].sort())) problems.push("profile inventory differs from config.json + fluent-reader.db")
    for (const name of [CONFIG_NAME, DB_NAME]) {
        const file = path.join(dir.profile, name)
        if (!fs.existsSync(file)) continue
        const stat = fs.lstatSync(file)
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) problems.push(`${name} is a link or not a single regular file`)
    }
    if (problems.length > 0) return problems
    const baseline = readBaseline(dir)
    if (!isDeepStrictEqual(baseline.hasRead, SMOKE_EXPECTED.hasRead)) problems.push("baseline hasRead differs from the documented fixture")
    const current = integritySnapshot(dir.profile, dir.scratch)
    problems.push(...integrityDifferences(baseline, current).map((d) => `differs from baseline: ${d}`))
    if (!isDeepStrictEqual(current.files, referenceFiles(dir))) problems.push("profile files differ from the fixture rebuilt by this harness")
    return problems
}

/**
 * Everything `run` requires before starting any process. Throws SmokeError
 * on the first category of problem; returns only when the launch is exactly
 * the prepared one on the prepared synthetic profile.
 */
export function validateBeforeSpawn(dir: WorkDir): void {
    if (!fs.existsSync(dir.config)) throw new SmokeError("mcp-config.json not found: run prepare first")
    let config: unknown
    try {
        config = JSON.parse(fs.readFileSync(dir.config, "utf8")) as unknown
    } catch {
        throw new SmokeError("mcp-config.json is not valid JSON")
    }
    const expected = mcpConfig(expectedLaunch(dir))
    if (!isDeepStrictEqual(config, expected)) throw new SmokeError(`mcp-config.json is not the prepared configuration: ${describeConfigDifference(config, expected)}`)
    const problems = profileIdentityProblems(dir)
    if (problems.length > 0) throw new SmokeError(`the profile is not the prepared synthetic fixture: ${problems.join("; ")}`, 1)
}

export function findClaude(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
    if (explicit !== undefined) {
        if (!path.isAbsolute(explicit) || !fs.existsSync(explicit)) throw new SmokeError("--claude must be the absolute path of an existing claude executable")
        return explicit
    }
    const names = process.platform === "win32" ? ["claude.exe"] : ["claude"]
    for (const entry of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
        for (const name of names) {
            const candidate = path.join(entry, name)
            if (entry.length > 0 && fs.existsSync(candidate)) return candidate
        }
    }
    throw new SmokeError("claude.exe not found on PATH: pass --claude <absolute path to claude.exe> (claude.cmd shims are not supported, they need a shell)")
}

/** Node processes still running the smoke server on this profile; null when it cannot be checked. */
export function orphanServers(profileDir: string): number | null {
    if (process.platform !== "win32") return null
    try {
        const out = execFileSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"],
            { encoding: "utf8", windowsHide: true },
        )
        return out.split(/\r?\n/).filter((line) => line.includes(MAIN_JS) && line.includes(profileDir)).length
    } catch {
        return null
    }
}

/** Reads process metadata; "malformed" when the file exists but does not hold exactly the recorded fields. */
export function readProcessMetadata(dir: WorkDir, legacyReport: boolean): ProcessMetadata | "malformed" | undefined {
    const file = legacyReport ? dir.report : dir.runMetadata
    if (!fs.existsSync(file)) return undefined
    let raw: Record<string, unknown>
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    } catch {
        return "malformed"
    }
    const nullableInt = (v: unknown): boolean => v === null || Number.isInteger(v)
    const nullableString = (v: unknown): boolean => v === null || typeof v === "string"
    // The version is required: a missing, null or empty claudeVersion is malformed, never a compatible one.
    const version = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0
    if (legacyReport) {
        // report.json written by the FR-MCP-02A-06 run: only its process fields are read, never its verdict.
        // That runner resolved a spawn error or a timeout with claudeExitCode null and did not record the signal.
        if (!nullableInt(raw.claudeExitCode) || typeof raw.timedOut !== "boolean" || !version(raw.claudeVersion)) return "malformed"
        if (raw.claudeExitCode !== 0) return { source: "legacy-report", claudeVersion: raw.claudeVersion, exitCode: raw.claudeExitCode as number | null, signal: null, timedOut: raw.timedOut, spawnError: raw.claudeExitCode === null && !raw.timedOut }
        // Exit code 0 is reported by Node only for a normal exit, never for a signal.
        return { source: "legacy-report", claudeVersion: raw.claudeVersion, exitCode: 0, signal: null, timedOut: raw.timedOut, spawnError: false }
    }
    if (raw.source !== "run" || !version(raw.claudeVersion) || !nullableInt(raw.exitCode) || !nullableString(raw.signal) || typeof raw.timedOut !== "boolean" || typeof raw.spawnError !== "boolean") {
        return "malformed"
    }
    return { source: "run", claudeVersion: raw.claudeVersion, exitCode: raw.exitCode as number | null, signal: raw.signal as string | null, timedOut: raw.timedOut, spawnError: raw.spawnError }
}

export interface VerifyOutcome {
    readonly verdict: OverallVerdict
    readonly checks: Check[]
    readonly reportPath: string
    readonly lines: string[]
}

/**
 * Verifies the transcript and process metadata of a work directory, plus
 * the profile identity and orphan processes, and writes `reportPath`.
 */
export function verifyWorkDir(dir: WorkDir, meta: ProcessMetadata | "malformed" | undefined, reportPath: string): VerifyOutcome {
    if (!fs.existsSync(dir.transcript)) throw new SmokeError("claude-transcript.jsonl not found")
    if (fs.existsSync(reportPath)) throw new SmokeError(`${path.basename(reportPath)} already exists: it is never overwritten`)
    const report = verifyTranscript(decodeTranscript(fs.readFileSync(dir.transcript)), meta === "malformed" ? undefined : meta)
    const checks = report.checks.map((c) =>
        c.id === "process.claude-exit" && meta === "malformed" ? { id: c.id, verdict: "FAIL" as const, detail: "process metadata file is malformed" } : c,
    )
    const problems = profileIdentityProblems(dir)
    const orphans = orphanServers(dir.profile)
    checks.push(
        { id: "fixture.integrity", verdict: problems.length === 0 ? "PASS" : "FAIL", detail: problems.length === 0 ? "baseline and rebuilt-fixture hashes, inventory, no -wal/-shm/-journal, hasRead unchanged" : problems.join("; ") },
        { id: "process.no-orphan-server", verdict: orphans === null ? "NOT_VERIFIED" : orphans === 0 ? "PASS" : "FAIL", detail: orphans === null ? "could not be checked" : `${orphans} server process(es) still running` },
    )
    const verdict = overallVerdict(checks)
    const calls = report.calls.map((c) => ({
        order: c.order,
        tool: c.tool,
        input: c.input,
        status: c.status,
        isError: c.isError ?? null,
        errorCode: c.status === "applicationError" ? (c.payload?.code ?? null) : null,
        ...(c.issue !== undefined && { issue: c.issue }),
    }))
    fs.writeFileSync(reportPath, `${JSON.stringify({ verdict, processMetadata: meta ?? null, checks, calls }, null, 2)}\n`)
    const lines = [
        ...checks.map((c) => `${c.verdict.padEnd(12)} ${c.id}: ${c.detail}`),
        "",
        `Tool calls observed: ${calls.length} (${TOOL_NAMES.filter((t) => calls.some((c) => c.tool.endsWith(`__${t}`) && c.status === "success")).length}/7 tools with a schema-valid result)`,
        `Report: ${reportPath}`,
        `Claude Code smoke: ${verdict}`,
    ]
    return { verdict, checks, reportPath, lines }
}

/** The part of ChildProcess used by `run`. */
export type ChildLike = Pick<ChildProcess, "once" | "kill">
export type SpawnLike = (command: string, args: string[], options: { cwd: string; stdio: ["ignore", number, number]; windowsHide: boolean }) => ChildLike
export type ExecLike = (file: string, args: string[]) => string

export interface RunOptions {
    readonly claude?: string | undefined
    readonly env?: NodeJS.ProcessEnv
    readonly spawn?: SpawnLike
    readonly exec?: ExecLike
    readonly timeoutMs?: number
    readonly settleMs?: number
    readonly log?: (line: string) => void
}

const realSpawn: SpawnLike = (command, args, options) => spawn(command, args, options)
const realExec: ExecLike = (file, args) => execFileSync(file, args, { encoding: "utf8", windowsHide: true })

interface ExitRecord {
    readonly exitCode: number | null
    readonly signal: string | null
    readonly timedOut: boolean
    readonly spawnError: boolean
}

function awaitExit(child: ChildLike, timeoutMs: number): Promise<ExitRecord> {
    return new Promise((resolve) => {
        let timedOut = false
        let settled = false
        let grace: NodeJS.Timeout | undefined
        const done = (record: ExitRecord): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (grace !== undefined) clearTimeout(grace)
            resolve(record)
        }
        const timer = setTimeout(() => {
            timedOut = true
            child.kill()
            grace = setTimeout(() => done({ exitCode: null, signal: null, timedOut: true, spawnError: false }), KILL_GRACE_MS)
        }, timeoutMs)
        child.once("error", () => done({ exitCode: null, signal: null, timedOut, spawnError: true }))
        child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => done({ exitCode: code, signal, timedOut, spawnError: false }))
    })
}

/**
 * The owner-run smoke: refuses inside a Claude Code session, validates
 * everything before any process is started, runs claude with the prepared
 * configuration only, records the process metadata, then verifies.
 */
export async function runSmoke(dir: WorkDir, options: RunOptions = {}): Promise<VerifyOutcome> {
    const env = options.env ?? process.env
    const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`))
    if (env.CLAUDECODE !== undefined) {
        throw new SmokeError("this terminal is a Claude Code session (CLAUDECODE is set): run this command from a separate PowerShell window. The protection is not bypassed.", 3)
    }
    for (const file of [dir.transcript, dir.runMetadata, dir.report]) {
        if (fs.existsSync(file)) throw new SmokeError(`${path.basename(file)} already exists: prepare a new work directory`)
    }
    validateBeforeSpawn(dir)
    const claude = findClaude(options.claude, env)
    const exec = options.exec ?? realExec
    const version = exec(claude, ["--version"]).trim()
    const help = exec(claude, ["--help"])
    const missing = REQUIRED_OPTIONS.filter((option) => !help.includes(option))
    if (missing.length > 0) throw new SmokeError(`this Claude Code version lacks: ${missing.join(", ")}`, 1)
    log(`Claude Code ${version}`)
    log("Running the smoke session (synthetic data only; tool results are sent to the Anthropic service)...")

    const out = fs.openSync(dir.transcript, "w")
    const err = fs.openSync(dir.stderr, "w")
    const started = Date.now()
    let exit: ExitRecord
    try {
        let child: ChildLike | undefined
        try {
            child = (options.spawn ?? realSpawn)(claude, claudeArgs(dir.config), { cwd: dir.cwd, stdio: ["ignore", out, err], windowsHide: true })
        } catch {
            child = undefined
        }
        exit = child === undefined ? { exitCode: null, signal: null, timedOut: false, spawnError: true } : await awaitExit(child, options.timeoutMs ?? RUN_TIMEOUT_MS)
    } finally {
        fs.closeSync(out)
        fs.closeSync(err)
    }
    const metadata = { source: "run" as const, claudeVersion: version, ...exit, elapsedMs: Date.now() - started }
    fs.writeFileSync(dir.runMetadata, `${JSON.stringify(metadata, null, 2)}\n`)
    await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? SETTLE_MS))
    return verifyWorkDir(dir, readProcessMetadata(dir, false), dir.report)
}
