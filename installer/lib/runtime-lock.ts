/**
 * The pinned Node.js runtime (installer/runtime-lock.json). Fail-closed: the
 * builder refuses to run unless the lock names exactly the official Windows
 * x64 ZIP of a Node 24 version accepted by package.json "engines", at its
 * official nodejs.org URL, with a well-formed SHA-256.
 */

import { isDeepStrictEqual } from "node:util"
import { BuildError } from "./common.js"

export interface RuntimeLock {
    readonly version: string
    readonly platform: "win-x64"
    readonly archive: string
    readonly archiveRoot: string
    readonly url: string
    readonly shasumsUrl: string
    readonly sha256: string
}

const NODE_KEYS = ["version", "platform", "archive", "archiveRoot", "url", "shasumsUrl", "sha256"]
const ATTESTATION_KEYS = ["checkedOn", "release", "method"]

function fail(reason: string): never {
    throw new BuildError(`installer/runtime-lock.json refused: ${reason}`)
}

function parseVersion(value: string): [number, number, number] | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
    return 0
}

/**
 * Whether `version` satisfies a range made of space-separated comparators
 * (>=, >, <=, <, =) with full or major-only versions, as package.json uses.
 * Any other syntax is refused rather than guessed.
 */
export function satisfiesRange(version: string, range: string): boolean {
    const v = parseVersion(version)
    if (v === undefined) throw new BuildError(`not a version: ${JSON.stringify(version)}`)
    const comparators = range.trim().split(/\s+/)
    if (comparators.length === 0 || comparators[0] === "") throw new BuildError("empty engines range")
    return comparators.every((comparator) => {
        const match = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+)\.(\d+))?$/.exec(comparator)
        if (match === null) throw new BuildError(`unsupported engines comparator: ${JSON.stringify(comparator)}`)
        const bound = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)]
        const c = compareVersions(v, bound)
        switch (match[1] ?? "=") {
            case ">=": return c >= 0
            case ">": return c > 0
            case "<=": return c <= 0
            case "<": return c < 0
            default: return c === 0
        }
    })
}

/** Validates the parsed lock against package.json "engines.node". */
export function parseRuntimeLock(raw: unknown, enginesNode: string): RuntimeLock {
    if (typeof raw !== "object" || raw === null) fail("not a JSON object")
    const lock = raw as Record<string, unknown>
    if (!isDeepStrictEqual(Object.keys(lock).sort(), ["attestation", "node", "schemaVersion"])) fail("unexpected top-level fields")
    if (lock.schemaVersion !== 1) fail("unsupported schemaVersion")
    const node = lock.node as Record<string, unknown> | null
    if (typeof node !== "object" || node === null || !isDeepStrictEqual(Object.keys(node).sort(), [...NODE_KEYS].sort())) fail("node must have exactly the fields " + NODE_KEYS.join(", "))
    const attestation = lock.attestation as Record<string, unknown> | null
    if (typeof attestation !== "object" || attestation === null || !isDeepStrictEqual(Object.keys(attestation).sort(), [...ATTESTATION_KEYS].sort())) {
        fail("attestation must record checkedOn, release and method")
    }
    if (ATTESTATION_KEYS.some((key) => typeof attestation[key] !== "string" || (attestation[key] as string).trim().length < 4)) fail("attestation fields must be filled in")

    const version = node.version
    if (typeof version !== "string" || parseVersion(version) === undefined) fail("version must be MAJOR.MINOR.PATCH")
    if (parseVersion(version)?.[0] !== 24) fail(`Node ${version} is not Node 24 (node:sqlite and the approved runtime are Node 24)`)
    if (!satisfiesRange(version, enginesNode)) fail(`Node ${version} does not satisfy package.json engines.node ${JSON.stringify(enginesNode)}`)
    const archiveRoot = `node-v${version}-win-x64`
    const archive = `${archiveRoot}.zip`
    const base = `https://nodejs.org/dist/v${version}/`
    if (node.platform !== "win-x64") fail("platform must be win-x64")
    if (node.archive !== archive) fail(`archive must be ${archive}`)
    if (node.archiveRoot !== archiveRoot) fail(`archiveRoot must be ${archiveRoot}`)
    if (node.url !== `${base}${archive}`) fail(`url must be the official ${base}${archive}`)
    if (node.shasumsUrl !== `${base}SHASUMS256.txt`) fail(`shasumsUrl must be the official ${base}SHASUMS256.txt`)
    const sha256 = node.sha256
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) fail("sha256 must be 64 lowercase hex digits from the official, signed SHASUMS256.txt")
    if (/^(.)\1{63}$/.test(sha256)) fail("sha256 is a placeholder")
    return { version, platform: "win-x64", archive, archiveRoot, url: node.url, shasumsUrl: node.shasumsUrl, sha256 }
}
