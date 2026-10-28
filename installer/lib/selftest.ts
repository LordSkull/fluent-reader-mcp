/**
 * Functional self-test of an EXTRACTED package: its own runtime/node.exe
 * runs its own server/dist/main.js on a synthetic profile (the FR-MCP-02A-06
 * smoke fixture) created in a temporary directory outside the package.
 * Raw JSON-RPC over stdio: initialize, tools/list (exactly the seven tools),
 * list_sources and get_article (SQLite and the Win32/Koffi lock), then stdin
 * EOF and a clean exit. No real profile is ever used.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { buildSmokeProfile } from "../../test/e2e/smoke-fixture.js"
import { BuildError, childEnv } from "./common.js"
import { TOOLS } from "./package-content.js"

const TIMEOUT_MS = 30_000

export interface SelfTestInput {
    readonly nodeExe: string
    readonly entrypoint: string
    readonly env: NodeJS.ProcessEnv
}

export type SelfTestFn = (input: SelfTestInput) => Promise<string[]>

interface Response {
    readonly id?: unknown
    readonly result?: Record<string, unknown>
    readonly error?: unknown
}

/** Runs the self-test; returns the lines of its report, throws BuildError on any failure. */
export const runSelfTest: SelfTestFn = async (input) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "frmcp-package-selftest-"))
    const report: string[] = []
    try {
        const profile = buildSmokeProfile(path.join(temp, "synthetic profile àè"))
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string; responses: Response[] }>((resolve, reject) => {
            const child = spawn(input.nodeExe, [input.entrypoint, "--profile-dir", profile.dir], { cwd: temp, env: childEnv(input.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false })
            let stdout = ""
            let stderr = ""
            const responses: Response[] = []
            const timer = setTimeout(() => {
                child.kill()
                reject(new BuildError("self-test: the packaged server did not answer in time"))
            }, TIMEOUT_MS)
            const send = (message: object): void => {
                child.stdin.write(`${JSON.stringify(message)}\n`)
            }
            const plan: object[] = [
                { jsonrpc: "2.0", id: 2, method: "tools/list" },
                { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sources", arguments: { includeHidden: true } } },
                { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_article", arguments: { articleId: 2 } } },
            ]
            child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
                stdout += chunk
                const lines = stdout.split("\n")
                stdout = lines.pop() ?? ""
                for (const line of lines) {
                    let response: Response
                    try {
                        response = JSON.parse(line) as Response
                    } catch {
                        clearTimeout(timer)
                        child.kill()
                        reject(new BuildError("self-test: stdout carried something other than JSON-RPC"))
                        return
                    }
                    responses.push(response)
                    if (response.id === 1) send({ jsonrpc: "2.0", method: "notifications/initialized" })
                    const next = plan.shift()
                    if (next !== undefined) send(next)
                    else child.stdin.end()
                }
            })
            child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
            child.once("error", (error) => {
                clearTimeout(timer)
                reject(new BuildError(`self-test: could not start the packaged runtime (${error.message})`))
            })
            child.once("close", (code) => {
                clearTimeout(timer)
                resolve({ code, stdout, stderr, responses })
            })
            send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "frmcp-package-selftest", version: "0" } } })
        })
        const byId = (id: number): Response | undefined => result.responses.find((r) => r.id === id)
        if (result.code !== 0) throw new BuildError(`self-test: the packaged server exited with code ${String(result.code)}`)
        if (result.stdout !== "") throw new BuildError("self-test: incomplete JSON-RPC line on stdout")
        for (const line of result.stderr.split(/\r?\n/).filter((l) => l.length > 0)) {
            if (!line.startsWith("fluent-reader-mcp {")) throw new BuildError("self-test: unexpected diagnostic output on stderr")
        }
        if (!/"event":"serving"/.test(result.stderr)) throw new BuildError("self-test: the server did not report serving")
        report.push("self-test: initialize and clean exit on stdin EOF")
        const tools = ((byId(2)?.result?.tools as { name: string }[] | undefined) ?? []).map((t) => t.name).sort()
        if (!isDeepStrictEqual(tools, [...TOOLS])) throw new BuildError(`self-test: tools/list returned ${JSON.stringify(tools)}`)
        report.push("self-test: tools/list returned exactly the seven tools")
        const sources = (byId(3)?.result?.structuredContent as { sources?: { sourceId: number }[] } | undefined)?.sources?.map((s) => s.sourceId)
        if (!isDeepStrictEqual(sources, [1, 2, 3, 4, 5])) throw new BuildError("self-test: list_sources did not read the synthetic profile")
        const article = byId(4)?.result?.structuredContent as { articleId?: number; untrusted?: boolean } | undefined
        if (article?.articleId !== 2 || article.untrusted !== true) throw new BuildError("self-test: get_article did not read the synthetic article")
        report.push("self-test: list_sources and get_article read the synthetic profile (SQLite and Win32 lock)")
        return report
    } finally {
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
}

/** `node --version` and `process.platform process.arch` of the packaged runtime. */
export function runtimeIdentity(nodeExe: string, exec: (file: string, args: readonly string[]) => { status: number | null; stdout: string }): { version: string; platform: string } {
    const version = exec(nodeExe, ["--version"])
    const platform = exec(nodeExe, ["-p", "process.platform + ' ' + process.arch"])
    if (version.status !== 0 || platform.status !== 0) throw new BuildError("the packaged runtime/node.exe does not run")
    return { version: version.stdout.trim(), platform: platform.stdout.trim() }
}
