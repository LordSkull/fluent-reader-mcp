/**
 * FR-MCP-02A-06 owner-run smoke test with Claude Code.
 *
 *   node dist-test/test/e2e/smoke-cli.js prepare [<absolute work dir>]
 *   node dist-test/test/e2e/smoke-cli.js run <work dir> [--claude <claude.exe>]
 *   node dist-test/test/e2e/smoke-cli.js verify <work dir> [--legacy-report-metadata]
 *
 * prepare: builds the synthetic profile, the temporary MCP config and the
 *   integrity baseline in a new directory outside the repository (default:
 *   a fresh directory under the system temp directory), and prints the
 *   commands. Nothing is registered in any Claude Code configuration.
 * run: validates the config and the profile before starting any process,
 *   launches `claude -p` with that config only, records the transcript and
 *   the process metadata (run-metadata.json), then verifies (report.json).
 *   Must be started from a terminal that is not itself a Claude Code session:
 *   inside one (CLAUDECODE set) it refuses, and never removes that protection.
 * verify: re-verifies a recorded run (verify-report.json, never report.json).
 *   Without run-metadata.json the process check is NOT_VERIFIED, so the
 *   verdict cannot be PASS. --legacy-report-metadata reads, explicitly, only
 *   the process fields (exit code, timeout, version) from a report.json
 *   written by an earlier `run` of this harness, never its verdict.
 *
 * Exit codes: 0 PASS, 1 FAIL, 5 INCOMPLETE, 2 or 3 refused before any spawn.
 */

import { prepareWorkDir, readProcessMetadata, runSmoke, SmokeError, verifyWorkDir, workDir, type VerifyOutcome } from "./smoke-runner.js"
import path from "node:path"

const EXIT_CODES = { PASS: 0, FAIL: 1, INCOMPLETE: 5 } as const

function finish(outcome: VerifyOutcome): void {
    process.stdout.write(`${outcome.lines.join("\n")}\n`)
    process.exitCode = EXIT_CODES[outcome.verdict]
}

async function main(): Promise<void> {
    const [command, target, ...rest] = process.argv.slice(2)
    if (command === "prepare") {
        process.stdout.write(prepareWorkDir(target).instructions)
        return
    }
    if (target === undefined || !path.isAbsolute(target)) {
        throw new SmokeError("usage: smoke-cli.js prepare [dir] | run <dir> [--claude <exe>] | verify <dir> [--legacy-report-metadata]")
    }
    const dir = workDir(target)
    if (command === "verify") {
        const legacy = rest.includes("--legacy-report-metadata")
        return finish(verifyWorkDir(dir, readProcessMetadata(dir, legacy), dir.verifyReport))
    }
    if (command === "run") {
        const index = rest.indexOf("--claude")
        return finish(await runSmoke(dir, { claude: index >= 0 ? rest[index + 1] : undefined }))
    }
    throw new SmokeError("unknown command")
}

try {
    await main()
} catch (error) {
    if (!(error instanceof SmokeError)) throw error
    process.stderr.write(`smoke: ${error.message}\n`)
    process.exitCode = error.exitCode
}
