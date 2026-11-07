/** Helpers to run the built server (dist/main.js) as a child process. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

// dist-test/test/helpers/process.js → project root
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
export const MAIN_JS = path.join(PROJECT_ROOT, "dist", "main.js")

/** Child environment without any inherited profile configuration. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key.toUpperCase() !== "FLUENT_READER_PROFILE_DIR") env[key] = value
    }
    return { ...env, ...extra }
}

export interface ExitResult {
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
    readonly stdout: string
    readonly stderr: string
    readonly elapsedMs: number
}

export interface RunningServer {
    readonly child: ChildProcessWithoutNullStreams
    stdout(): string
    stderr(): string
    /** Resolves when the process exits; rejects after `timeoutMs` (and kills it). */
    exited(timeoutMs: number): Promise<ExitResult>
}

export function startServer(args: readonly string[], env: Record<string, string> = childEnv()): RunningServer {
    const started = Date.now()
    const child = spawn(process.execPath, [MAIN_JS, ...args], { env, stdio: ["pipe", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk))
    const exit = new Promise<ExitResult>((resolve) => {
        child.once("close", (code, signal) =>
            resolve({ code, signal, stdout: out, stderr: err, elapsedMs: Date.now() - started }),
        )
    })
    return {
        child,
        stdout: () => out,
        stderr: () => err,
        exited: (timeoutMs) =>
            new Promise<ExitResult>((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill()
                    reject(new Error(`server did not exit within ${timeoutMs} ms`))
                }, timeoutMs)
                void exit.then((result) => {
                    clearTimeout(timer)
                    resolve(result)
                })
            }),
    }
}

/** Runs the server with stdin closed immediately (bootstrap tests). */
export async function runToExit(args: readonly string[], env?: Record<string, string>, timeoutMs = 15_000): Promise<ExitResult> {
    const server = startServer(args, env)
    server.child.stdin.end()
    return server.exited(timeoutMs)
}

/** Reads newline-delimited JSON-RPC messages written by the server. */
export function parseStdoutLines(stdout: string): unknown[] {
    const lines = stdout.split("\n")
    lines.pop() // incomplete (or empty) trailing segment
    return lines.map((line) => JSON.parse(line) as unknown)
}

/** Sends one JSON-RPC message and waits for the response with the same id. */
export async function request(
    server: RunningServer,
    message: { jsonrpc: "2.0"; id: number; method: string; params?: unknown },
    timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
    server.child.stdin.write(`${JSON.stringify(message)}\n`)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        for (const parsed of parseStdoutLines(server.stdout())) {
            const response = parsed as Record<string, unknown>
            if (response.id === message.id && ("result" in response || "error" in response)) return response
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`no response to ${message.method}`)
}
