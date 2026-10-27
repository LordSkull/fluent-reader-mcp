/**
 * Controlled reading of the Fluent Reader config.json (FR-MCP-01 §13.2,
 * §13.3, §13.3.1, §16).
 *
 * Only `sourceGroups`, `sourceRules`, `nextGroupId` and `dbVersion` leave this
 * module, copied into new objects. Everything else (serviceConfigs, pac,
 * passwords, tokens, API keys, other preferences) is dropped.
 *
 * IMPORTANT: JSON parsing reads the whole document, credentials included.
 * The allowlist prevents their exposure through this module, not their
 * initial reading into process memory. The raw byte buffer is zeroed after
 * decoding, but JavaScript strings cannot be wiped.
 *
 * Read sequence, per attempt (conf replaces config.json legitimately with an
 * atomic write + rename, so its identity is not compared with startup):
 *   1. lstat of the canonical path: regular file, not a link, real path in
 *      the profile directory. Otherwise SETTINGS_UNAVAILABLE (suspicious).
 *   2. open.
 *   3. fstat on the descriptor: regular file, size <= CFG_MAX, dev/ino equal
 *      to step 1. A dev/ino mismatch is treated as a transient rename.
 *   4. read at most size + 1 bytes (never more than CFG_MAX + 1).
 * Transient conditions (dev/ino mismatch, size change, file vanished during a
 * rename, sharing violation EBUSY) repeat the whole sequence, at most 3
 * attempts, then SETTINGS_TRANSIENT. A denied permission (EPERM/EACCES) is
 * also retried within the same 3 attempts, because Windows reports a file
 * being replaced (delete pending) as access denied; if it is still denied on
 * the last attempt the result is SETTINGS_UNAVAILABLE ("permission-denied"),
 * not SETTINGS_TRANSIENT. A fixed pause of RETRY_PAUSE_MS separates attempts
 * after an access error. Invalid UTF-8/JSON is retried once after 50 ms (a
 * non-atomic fallback write can be observed half-written), then
 * SETTINGS_INVALID. Parse errors are never forwarded: V8 messages can quote
 * the parsed text.
 */

import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { FrMcpError, systemErrorCode, toSafeError, type ErrorReason } from "../errors.js"
import { logEvent } from "../log.js"

/** Maximum size of config.json in bytes. */
export const CFG_MAX = 8 * 1024 * 1024
export const MAX_READ_ATTEMPTS = 3
export const PARSE_RETRY_DELAY_MS = 50
export const RETRY_PAUSE_MS = 10

/** Structural limits (FR-MCP-01 §13.3.1). */
export const LIMITS = {
    groupEntries: 20_000,
    sidsPerEntry: 20_000,
    sidsTotal: 200_000,
    ruleKeys: 20_000,
    rulesPerKey: 10_000,
    rulesTotal: 100_000,
    actionsPerRule: 64,
    actionLength: 64,
} as const

export interface SourceGroupEntry {
    readonly gid: number
    readonly isMultiple: boolean
    readonly sids: readonly number[]
    readonly name?: string
    readonly expanded?: boolean
}

export interface StoredRuleEntry {
    readonly filter: number
    readonly search: string
    readonly match: boolean
    /** null when the rule is malformed: its actions are not exposed. */
    readonly actions: readonly string[] | null
    readonly malformed?: "actions-limit"
}

export type SectionError = "SETTINGS_INVALID" | "SETTINGS_TOO_LARGE"

/**
 * One section of the settings. Sections fail independently (fail-closed per
 * section). `present: false` means the key is absent; `value` is then the
 * value Fluent Reader reads for an absent key (`store.get(key, default)` in
 * the fork's src/main/settings.ts): [] for sourceGroups, {} for sourceRules,
 * null for dbVersion. For nextGroupId the absent value is null: the stored
 * counter alone is not the next group id (see effectiveNextGroupId).
 */
export type Section<T> =
    | { readonly ok: true; readonly present: boolean; readonly value: T }
    | { readonly ok: false; readonly code: SectionError }

/** A value computed from several sections; unavailable if any input is. */
export type Derived<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: SectionError }

export interface SettingsSnapshot {
    readonly sourceGroups: Section<readonly SourceGroupEntry[]>
    readonly sourceRules: Section<ReadonlyMap<string, readonly StoredRuleEntry[]>>
    /** The stored `nextGroupId` counter as written; null when absent. Never use it alone to allocate. */
    readonly nextGroupId: Section<number | null>
    /**
     * The id Fluent Reader would allocate next (`nextGroupId()` in the fork's
     * src/main/settings.ts): max(stored counter or 0, gid + 1 of every group
     * entry, gid + 1 of every "group:<gid>" rule key), counting only safe
     * integers >= 0. Unavailable when sourceGroups, sourceRules or nextGroupId
     * is invalid or too large, so that no colliding id can be derived.
     */
    readonly effectiveNextGroupId: Derived<number>
    readonly dbVersion: Section<string | number | null>
    /** Read attempts used by the last successful read (1..MAX_READ_ATTEMPTS). */
    readonly attempts: number
}

/** Test-only seams for deterministic concurrency tests. */
export interface ReadSettingsHooks {
    afterLstat?(attempt: number): void
    afterOpen?(attempt: number, fd: number): void
    afterFstat?(attempt: number): void
}

export interface ReadSettingsOptions {
    readonly hooks?: ReadSettingsHooks
}

class TransientRead {
    constructor(readonly reason: ErrorReason) {}
}

function suspicious(reason: ErrorReason): never {
    logEvent("settings_suspicious", { reason })
    throw new FrMcpError("SETTINGS_UNAVAILABLE", reason)
}

/**
 * EBUSY (sharing or lock violation) is a temporary access conflict; EPERM and
 * EACCES are a denied permission (retried, see above); anything else is
 * SETTINGS_UNAVAILABLE at once.
 */
function accessFailure(code: string | undefined): TransientRead {
    if (code === "EBUSY") return new TransientRead("open-failed")
    if (code === "EPERM" || code === "EACCES") return new TransientRead("permission-denied")
    throw new FrMcpError("SETTINGS_UNAVAILABLE", "inaccessible")
}

function samePath(a: string, b: string): boolean {
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function readAttempt(
    configPath: string,
    profileDir: string,
    attempt: number,
    hooks: ReadSettingsHooks | undefined,
): Buffer | TransientRead {
    let linkStats: fs.BigIntStats
    try {
        linkStats = fs.lstatSync(configPath, { bigint: true })
    } catch (error) {
        const code = systemErrorCode(error)
        if (code === "ENOENT" || code === "ENOTDIR") throw new FrMcpError("SETTINGS_UNAVAILABLE", "missing")
        return accessFailure(code)
    }
    if (linkStats.isSymbolicLink()) suspicious("linked-file")
    if (!linkStats.isFile()) suspicious("not-regular-file")
    let real: string
    try {
        real = fs.realpathSync.native(configPath)
    } catch (error) {
        const code = systemErrorCode(error)
        // Vanished between lstat and realpath: a rename in progress.
        if (code === "ENOENT") return new TransientRead("open-failed")
        return accessFailure(code)
    }
    if (!samePath(path.dirname(real), profileDir) || !samePath(path.basename(real), path.basename(configPath))) {
        suspicious("outside-profile")
    }
    hooks?.afterLstat?.(attempt)

    let fd: number
    try {
        fd = fs.openSync(configPath, "r")
    } catch (error) {
        const code = systemErrorCode(error)
        if (code === "ENOENT") return new TransientRead("open-failed")
        return accessFailure(code)
    }
    try {
        hooks?.afterOpen?.(attempt, fd)
        const stats = fs.fstatSync(fd, { bigint: true })
        if (!stats.isFile()) suspicious("not-regular-file")
        if (stats.dev !== linkStats.dev || stats.ino !== linkStats.ino) {
            return new TransientRead("identity-mismatch")
        }
        if (stats.size > BigInt(CFG_MAX)) throw new FrMcpError("SETTINGS_TOO_LARGE", "file-too-large")
        hooks?.afterFstat?.(attempt)

        const expected = Number(stats.size)
        // One spare byte detects growth after fstat without reading past CFG_MAX + 1.
        const buffer = Buffer.alloc(expected + 1)
        let total = 0
        while (total < buffer.length) {
            const n = fs.readSync(fd, buffer, total, buffer.length - total, total)
            if (n === 0) break
            total += n
        }
        if (total > expected) {
            buffer.fill(0)
            if (total > CFG_MAX) throw new FrMcpError("SETTINGS_TOO_LARGE", "file-too-large")
            return new TransientRead("size-changed")
        }
        if (total !== expected) {
            buffer.fill(0)
            return new TransientRead("size-changed")
        }
        return buffer.subarray(0, total)
    } finally {
        try {
            fs.closeSync(fd)
        } catch {
            // ignore
        }
    }
}

async function readConfigBytes(
    configPath: string,
    profileDir: string,
    hooks: ReadSettingsHooks | undefined,
): Promise<{ bytes: Buffer; attempts: number }> {
    let last: TransientRead | undefined
    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
        if (last !== undefined && (last.reason === "permission-denied" || last.reason === "open-failed")) {
            await sleep(RETRY_PAUSE_MS)
        }
        const outcome = readAttempt(configPath, profileDir, attempt, hooks)
        if (!(outcome instanceof TransientRead)) return { bytes: outcome, attempts: attempt }
        last = outcome
    }
    if (last?.reason === "permission-denied") throw new FrMcpError("SETTINGS_UNAVAILABLE", "permission-denied")
    throw new FrMcpError("SETTINGS_TRANSIENT", last?.reason)
}

const INVALID = Symbol("invalid")

function decodeAndParse(bytes: Buffer): unknown {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        return JSON.parse(text) as unknown
    } catch {
        return INVALID
    } finally {
        bytes.fill(0)
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeInt(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value)
}

class SectionFailure {
    constructor(readonly code: SectionError) {}
}

function invalid(): never {
    throw new SectionFailure("SETTINGS_INVALID")
}

function tooLarge(): never {
    throw new SectionFailure("SETTINGS_TOO_LARGE")
}

function section<T>(
    root: Record<string, unknown>,
    key: string,
    fallback: T,
    extract: (value: unknown) => T,
): Section<T> {
    if (!Object.hasOwn(root, key)) return { ok: true, present: false, value: fallback }
    try {
        return { ok: true, present: true, value: extract(root[key]) }
    } catch (error) {
        if (error instanceof SectionFailure) return { ok: false, code: error.code }
        throw error
    }
}

function extractGroups(value: unknown): readonly SourceGroupEntry[] {
    if (!Array.isArray(value)) invalid()
    if (value.length > LIMITS.groupEntries) tooLarge()
    let totalSids = 0
    for (const entry of value) {
        if (!isPlainObject(entry) || !Array.isArray(entry.sids)) invalid()
        totalSids += entry.sids.length
        if (entry.sids.length > LIMITS.sidsPerEntry || totalSids > LIMITS.sidsTotal) tooLarge()
    }
    return value.map((entry: Record<string, unknown>) => {
        const { gid, isMultiple, sids, name, expanded } = entry
        if (!isSafeInt(gid) || typeof isMultiple !== "boolean") invalid()
        if (name !== undefined && typeof name !== "string") invalid()
        if (expanded !== undefined && typeof expanded !== "boolean") invalid()
        const sidList = (sids as unknown[]).map((sid) => (isSafeInt(sid) ? sid : invalid()))
        return {
            gid,
            isMultiple,
            sids: sidList,
            ...(name !== undefined && { name }),
            ...(expanded !== undefined && { expanded }),
        }
    })
}

function extractRules(value: unknown): ReadonlyMap<string, readonly StoredRuleEntry[]> {
    if (!isPlainObject(value)) invalid()
    const keys = Object.keys(value)
    if (keys.length > LIMITS.ruleKeys) tooLarge()
    let totalRules = 0
    for (const key of keys) {
        const rules = value[key]
        if (!Array.isArray(rules)) invalid()
        totalRules += rules.length
        if (rules.length > LIMITS.rulesPerKey || totalRules > LIMITS.rulesTotal) tooLarge()
    }
    // A Map keeps keys such as "__proto__" inert.
    const result = new Map<string, readonly StoredRuleEntry[]>()
    for (const key of keys) {
        const rules = value[key] as unknown[]
        result.set(
            key,
            rules.map((rule): StoredRuleEntry => {
                if (!isPlainObject(rule)) invalid()
                const { filter, search, match, actions } = rule
                if (!isSafeInt(filter) || typeof search !== "string" || typeof match !== "boolean") invalid()
                if (!Array.isArray(actions) || !actions.every((a) => typeof a === "string")) invalid()
                const withinLimits =
                    actions.length <= LIMITS.actionsPerRule &&
                    actions.every((a: string) => a.length <= LIMITS.actionLength)
                return withinLimits
                    ? { filter, search, match, actions: [...(actions as string[])] }
                    : { filter, search, match, actions: null, malformed: "actions-limit" }
            }),
        )
    }
    return result
}

function extractNextGroupId(value: unknown): number | null {
    return isSafeInt(value) ? value : invalid()
}

/** Mirror of nextGroupId() in the fork's src/main/settings.ts. */
function computeEffectiveNextGroupId(
    groups: Section<readonly SourceGroupEntry[]>,
    rules: Section<ReadonlyMap<string, readonly StoredRuleEntry[]>>,
    stored: Section<number | null>,
): Derived<number> {
    if (!groups.ok) return { ok: false, code: groups.code }
    if (!rules.ok) return { ok: false, code: rules.code }
    if (!stored.ok) return { ok: false, code: stored.code }
    const ids = groups.value.map((group) => group.gid)
    for (const key of rules.value.keys()) {
        if (key.startsWith("group:")) ids.push(Number(key.slice(6)))
    }
    let next = stored.value ?? 0
    for (const id of ids) {
        if (Number.isSafeInteger(id) && id >= 0 && id + 1 > next) next = id + 1
    }
    return { ok: true, value: next }
}

function extractDbVersion(value: unknown): string | number | null {
    if (value === null || typeof value === "string" || isSafeInt(value)) return value
    return invalid()
}

/**
 * Reads config.json from the canonical profile path and returns only the
 * allowlisted settings. Whole-file failures throw a FrMcpError
 * (SETTINGS_UNAVAILABLE, SETTINGS_TRANSIENT, SETTINGS_TOO_LARGE,
 * SETTINGS_INVALID); section failures are reported per section.
 */
export async function readSettings(
    configPath: string,
    profileDir: string,
    options: ReadSettingsOptions = {},
): Promise<SettingsSnapshot> {
    try {
        return await readAllowlisted(configPath, profileDir, options)
    } catch (error) {
        throw toSafeError(error)
    }
}

async function readAllowlisted(
    configPath: string,
    profileDir: string,
    options: ReadSettingsOptions,
): Promise<SettingsSnapshot> {
    let read = await readConfigBytes(configPath, profileDir, options.hooks)
    let parsed = decodeAndParse(read.bytes)
    if (parsed === INVALID) {
        await sleep(PARSE_RETRY_DELAY_MS)
        read = await readConfigBytes(configPath, profileDir, options.hooks)
        parsed = decodeAndParse(read.bytes)
    }
    if (parsed === INVALID) throw new FrMcpError("SETTINGS_INVALID", "not-json")
    if (!isPlainObject(parsed)) throw new FrMcpError("SETTINGS_INVALID", "not-object")

    const sourceGroups = section(parsed, "sourceGroups", [], extractGroups)
    const sourceRules = section<ReadonlyMap<string, readonly StoredRuleEntry[]>>(
        parsed,
        "sourceRules",
        new Map(),
        extractRules,
    )
    const nextGroupId = section<number | null>(parsed, "nextGroupId", null, extractNextGroupId)
    return {
        sourceGroups,
        sourceRules,
        nextGroupId,
        effectiveNextGroupId: computeEffectiveNextGroupId(sourceGroups, sourceRules, nextGroupId),
        dbVersion: section(parsed, "dbVersion", null, extractDbVersion),
        attempts: read.attempts,
    }
}
