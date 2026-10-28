/**
 * Acquisition of the pinned official Node.js runtime. Order, fail-closed:
 *  1. a cached archive is used only if its SHA-256 equals the pinned one;
 *     a cached archive that differs is reported and left in place;
 *  2. otherwise the archive is downloaded from the pinned nodejs.org URL to a
 *     .partial file, hashed, and kept only if it matches the pin, and only
 *     if the SHASUMS256.txt published for that version lists the same hash;
 *  3. nothing is extracted before the hash is verified, and only
 *     <archiveRoot>/node.exe and <archiveRoot>/LICENSE are extracted.
 */

import fs from "node:fs"
import path from "node:path"
import { BuildError, sha256Bytes, sha256File } from "./common.js"
import type { RuntimeLock } from "./runtime-lock.js"
import { readZip } from "./zip.js"

/** The part of the WHATWG fetch used here (injectable for tests). */
export type FetchFn = (url: string, init: { redirect: "follow"; signal?: AbortSignal }) => Promise<{
    readonly ok: boolean
    readonly status: number
    readonly url: string
    readonly body: ReadableStream<Uint8Array> | null
    text(): Promise<string>
}>

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_SHASUMS_BYTES = 256 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

function officialResponse(url: string, final: string): void {
    if (!final.startsWith("https://nodejs.org/dist/")) throw new BuildError(`download of ${url} ended outside https://nodejs.org/dist/`)
}

/** The SHA-256 that SHASUMS256.txt lists for `archive`; exactly one line must match. */
export function shasumFor(shasums: string, archive: string): string {
    const lines = shasums.split(/\r?\n/).filter((line) => line.endsWith(`  ${archive}`))
    const match = lines.length === 1 ? /^([0-9a-f]{64}) {2}(.+)$/.exec(lines[0] as string) : null
    if (match === null || match[2] !== archive) throw new BuildError(`SHASUMS256.txt does not list exactly one hash for ${archive}`)
    return match[1] as string
}

async function crossCheck(lock: RuntimeLock, fetchFn: FetchFn): Promise<void> {
    const response = await fetchFn(lock.shasumsUrl, { redirect: "follow", signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new BuildError(`could not read ${lock.shasumsUrl} (HTTP ${response.status})`)
    officialResponse(lock.shasumsUrl, response.url)
    const text = await response.text()
    if (text.length > MAX_SHASUMS_BYTES) throw new BuildError("SHASUMS256.txt is unexpectedly large")
    if (shasumFor(text, lock.archive) !== lock.sha256) throw new BuildError("the official SHASUMS256.txt does not list the pinned sha256: check installer/runtime-lock.json")
}

async function download(lock: RuntimeLock, destination: string, fetchFn: FetchFn): Promise<void> {
    const response = await fetchFn(lock.url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok || response.body === null) throw new BuildError(`download of ${lock.url} failed (HTTP ${response.status})`)
    officialResponse(lock.url, response.url)
    const out = fs.openSync(destination, "wx")
    let total = 0
    try {
        const reader = response.body.getReader()
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.length
            if (total > MAX_ARCHIVE_BYTES) throw new BuildError("runtime archive larger than expected")
            fs.writeSync(out, value)
        }
    } finally {
        fs.closeSync(out)
    }
}

export interface AcquireResult {
    readonly archivePath: string
    readonly source: "cache" | "download"
}

/** Returns the path of a cached archive whose SHA-256 equals the pin, downloading it if needed. */
export async function acquireRuntimeArchive(lock: RuntimeLock, cacheDir: string, fetchFn: FetchFn, log: (line: string) => void): Promise<AcquireResult> {
    const archivePath = path.join(cacheDir, lock.archive)
    if (fs.existsSync(archivePath)) {
        const actual = await sha256File(archivePath)
        if (actual !== lock.sha256) {
            throw new BuildError(`cached ${lock.archive} does not match the pinned sha256 (it is left in place for inspection; delete it to download again): ${archivePath}`)
        }
        log(`Runtime: cached ${lock.archive}, sha256 verified`)
        return { archivePath, source: "cache" }
    }
    fs.mkdirSync(cacheDir, { recursive: true })
    const partial = `${archivePath}.partial`
    fs.rmSync(partial, { force: true })
    log(`Runtime: downloading ${lock.url}`)
    try {
        await download(lock, partial, fetchFn)
        const actual = await sha256File(partial)
        if (actual !== lock.sha256) throw new BuildError(`downloaded ${lock.archive} has sha256 ${actual}, expected ${lock.sha256}: refused`)
        await crossCheck(lock, fetchFn)
        fs.renameSync(partial, archivePath)
    } finally {
        fs.rmSync(partial, { force: true })
    }
    log(`Runtime: ${lock.archive} downloaded, sha256 verified against the pin and SHASUMS256.txt`)
    return { archivePath, source: "download" }
}

/**
 * Extracts node.exe and LICENSE from a VERIFIED archive into `runtimeDir`.
 * The archive bytes are hashed again in memory, so that what is extracted is
 * exactly what was verified.
 */
export function extractRuntime(lock: RuntimeLock, archivePath: string, runtimeDir: string): void {
    const bytes = fs.readFileSync(archivePath)
    if (sha256Bytes(bytes) !== lock.sha256) throw new BuildError(`${lock.archive} changed after verification: refused`)
    const entries = readZip(bytes)
    for (const file of ["node.exe", "LICENSE"]) {
        const entry = entries.find((e) => e.name === `${lock.archiveRoot}/${file}`)
        if (entry === undefined) throw new BuildError(`${lock.archive} has no ${lock.archiveRoot}/${file}`)
        fs.mkdirSync(runtimeDir, { recursive: true })
        fs.writeFileSync(path.join(runtimeDir, file), entry.read(), { flag: "wx" })
    }
}
