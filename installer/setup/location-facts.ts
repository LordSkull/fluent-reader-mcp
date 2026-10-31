/**
 * FR-MCP-04-BETA-03A2a: collection of the LocationFacts that the pure
 * validator (location.ts, evaluateLocation) decides on, from the read-only
 * Win32 layer (win32-security.ts).
 *
 * PREPARATORY COMPONENT: nothing in the installer calls it (03A3 wires it);
 * the setup helper's closure does not include it. It never creates, changes
 * or removes anything, and it decides nothing: a complete collection is only
 * the input of evaluateLocation(), whose verdict is the authority.
 *
 * Collection is all or nothing. When Windows does not give the proof a fact
 * needs, the result is a failure (incomplete, access-denied, inconsistent,
 * failed...), never facts with a default, an omitted component or a guessed
 * path: a failed collection must NOT be passed to evaluateLocation (see
 * evaluateCollectedLocation). Where the contract itself has an "unreadable"
 * state (owner, DACL, installation record, protected category), that state is
 * reported, and the validator refuses it with its own reason.
 *
 * The walk: from the volume root "X:\" down to the chosen path, every
 * existing component is opened with FILE_FLAG_OPEN_REPARSE_POINT (a link,
 * junction or mount point is seen, not followed) and its final path is read
 * (GetFinalPathNameByHandleW). The walk stops at the first missing component
 * (ERROR_FILE_NOT_FOUND only: an access denial is never an absence; the
 * components below a missing one do not exist either, so the missing segments
 * are always a contiguous suffix), and refuses to go past a reparse point or a
 * non-directory: what lies beyond it could only be reached by following it.
 *
 * What the open handles guarantee, and what they do not (TOCTOU): every
 * component handle is kept open, without FILE_SHARE_DELETE, until the end of
 * the collection, so no component of the chain can be renamed, moved or
 * deleted meanwhile; each final path must extend its parent's exactly, and
 * all are read again at the end. The handles do NOT freeze the DACLs (WRITE_DAC
 * by someone allowed to), the contents of the destination, nor the absence of
 * the leaf (it can be created right after the check: the end-of-collection
 * probe narrows the window, it does not close it). Nothing here makes the
 * facts true later: 03A2b must create the leaf with CREATE_NEW semantics and
 * re-verify, and 03A3 must collect and evaluate again right before every
 * operation that writes.
 *
 * The inventory of an existing destination is checked for what no directory
 * can hold (a name twice; two names differing only in ASCII case where the
 * directory is proven case-insensitive) and against the record lookup; one
 * that fails is "inconsistent", never a normalised list. It is still one
 * enumeration, not a snapshot: a concurrent writer can add, rename or remove
 * entries during or after it. Re-validating the content right before each
 * operation that writes is left to the integration (03A3).
 *
 * Whose data: the current user SID, the known folders and the OneDrive
 * registry readings are those of the identity THIS process runs as (see
 * win32-security.ts, "Whose data"). An installer elevated with another
 * account's credentials collects that account's profile, not the intended
 * user's: 03A3 must verify the identity before relying on these facts.
 */

import {
    compareNames, evaluateLocation, INSTALL_RECORD_NAME,
    type DaclFacts, type DestinationContent, type DriveType, type LocationFacts, type LocationPolicy, type LocationVerdict, type ProtectedDirectoryFacts, type ResolvedLocation, type UnreadableLocation, type VolumeFacts,
} from "./location.js"
import {
    bindWin32Primitives, createWin32SecurityApi, dosPathFromFinalPath, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_INVALID_DRIVE, ERROR_NOT_READY, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION,
    FILE_PERSISTENT_ACLS, KNOWN_FOLDER, NativeReleaseError, VERIFIED_ARCHS,
    type DaclReading, type Handle, type KnownFolderId, type KnownFolderReading, type SecurityReading, type VolumeInformation, type Win32SecurityApi,
} from "./win32-security.js"

// ------------------------------------------------------------------ input and result

/** The Fluent Reader profile: not chosen yet (the wizard asks for the directory first), or the directory given to the setup. */
export type ProfileSelection = { readonly status: "not-selected" } | { readonly status: "selected"; readonly path: string }

export interface LocationFactsInput {
    /** The path as the user chose it. */
    readonly requestedPath: string
    /** The longest relative path the installation will create (LocationFacts.maxRelative). */
    readonly maxRelative: number
    readonly profile: ProfileSelection
}

/**
 * What the installation record found in an existing destination says. No
 * verifier exists yet (03A3: record.ts readRecord + a comparison of
 * installDir proven with CompareStringOrdinal); without one, a destination
 * with a record is "record-verification-unavailable", never "this-directory".
 */
export type InstallRecordVerdict = "this-directory" | "other-directory" | "unreadable"
export type InstallRecordVerifier = (destination: { readonly canonicalPath: string; readonly rawFinalPath: string }) => InstallRecordVerdict

export interface CollectionLimits {
    /** Entries of the destination listed at most (an installation has a handful): beyond, the listing is incomplete. */
    readonly maxEntries: number
    readonly maxListingCalls: number
    readonly listingBufferBytes: number
    readonly maxOneDriveAccounts: number
}
export const DEFAULT_COLLECTION_LIMITS: CollectionLimits = { maxEntries: 1024, maxListingCalls: 64, listingBufferBytes: 64 * 1024, maxOneDriveAccounts: 64 }

export interface LocationFactsOptions {
    /** The Win32 layer; by default the Koffi binding, created only now (never at import). */
    readonly api?: () => Win32SecurityApi
    /** Environment (TMP, TEMP, OneDrive*, CLAUDE_CONFIG_DIR); default process.env. */
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly platform?: string
    readonly arch?: string
    readonly verifyInstallRecord?: InstallRecordVerifier
    readonly limits?: Partial<CollectionLimits>
}

export type CollectionStep =
    | "current-user" | "volume" | "open" | "attributes" | "final-path" | "volume-serial" | "security" | "case-sensitivity" | "record-lookup"
    | "listing" | "record-verification" | "protected-directories" | "recheck" | "close"

export type IncompleteReason =
    | "volume-unavailable" | "reparse-point-on-path" | "not-a-directory-on-path" | "unsupported-namespace" | "path-alias" | "sharing-violation"
    | "listing-truncated" | "listing-malformed" | "record-verification-unavailable"
export type InconsistentReason = "path-chain" | "volume-mismatch" | "vanished-during-collection" | "record-lookup-mismatch" | "listing-inconsistent" | "changed-during-collection"

/**
 * The outcome of a collection. Only "complete" carries facts (paths and SIDs,
 * as the validator needs them); every other outcome is sanitised: a step, a
 * depth (segments below the volume root), a Win32 code, never a path or a SID.
 */
export type LocationCollection =
    | { readonly status: "complete"; readonly facts: LocationFacts; readonly volume: { readonly maximumComponentLength: number | null } }
    | { readonly status: "incomplete"; readonly reason: IncompleteReason; readonly depth?: number }
    | { readonly status: "invalid-input"; readonly field: "requestedPath" | "maxRelative" | "profile" | "limits"; readonly reason?: "volume-root" }
    | { readonly status: "access-denied"; readonly step: CollectionStep; readonly depth?: number }
    | { readonly status: "api-unavailable" }
    | { readonly status: "unsupported-platform" }
    | { readonly status: "inconsistent"; readonly reason: InconsistentReason; readonly depth?: number }
    | { readonly status: "failed"; readonly step: CollectionStep; readonly error: number | null; readonly depth?: number }

/** The validator's verdict for a complete collection; null for any other outcome (never evaluated on partial facts). */
export function evaluateCollectedLocation(collection: LocationCollection, policy?: LocationPolicy): LocationVerdict | null {
    return collection.status === "complete" ? evaluateLocation(collection.facts, policy) : null
}

// ------------------------------------------------------------------ paths (no node:path: path.resolve proves nothing about a directory)

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
/** MAX_PATH minus the NUL: the validator's maxPath is at most 259, so a longer path can never be allowed (and is not opened without "\\?\"). */
const MAX_INPUT_PATH = 259

interface DrivePath {
    readonly root: string
    readonly segments: readonly string[]
}

const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x20))

/**
 * The forms evaluateLocation accepts (location.ts parseDrivePath: X:\ or X:/,
 * trailing separators, valid Windows names), refused before any Win32 call:
 * UNC, "\\?\" or "\\.\" device paths, relative or drive-relative paths, ".",
 * "..", empty segments, reserved names, trailing dots or spaces.
 */
function parseInputPath(input: unknown): DrivePath | null {
    if (typeof input !== "string" || input.length === 0 || input.length > MAX_INPUT_PATH || input.includes("\0") || !/^[A-Za-z]:[\\/]/.test(input)) return null
    const rest = input.slice(3).replace(/[\\/]+$/, "")
    const segments = rest === "" ? [] : rest.split(/[\\/]/)
    for (const s of segments) {
        if (s === "" || s === "." || s === ".." || /[. ]$/.test(s) || RESERVED.test(s) || /[<>:"|?*\x00-\x1f]/.test(s)) return null
    }
    return { root: `${asciiUpper(input.charAt(0))}:\\`, segments }
}

const lexical = (p: DrivePath, depth: number): string => (depth === 0 ? p.root : `${p.root}${p.segments.slice(0, depth).join("\\")}`)
const joinPath = (base: string, segments: readonly string[]): string => (segments.length === 0 ? base : `${base}${base.endsWith("\\") ? "" : "\\"}${segments.join("\\")}`)

/** Two drive paths PROVEN equal by the validator's own rule (compareNames: an uncertain pair is kept as two paths). */
function provenSame(a: string, b: string): boolean {
    const x = parseInputPath(a)
    const y = parseInputPath(b)
    return x !== null && y !== null && x.root === y.root && x.segments.length === y.segments.length && x.segments.every((s, i) => compareNames(s, y.segments[i] as string) === "equal")
}

// ------------------------------------------------------------------ collection

class Stop extends Error {
    constructor(readonly result: LocationCollection) {
        super(result.status)
    }
}

const atDepth = <T extends object>(r: T, depth: number | undefined): T => (depth === undefined ? r : { ...r, depth })

/** A Win32 failure of a step: access denied and sharing violations are told apart, nothing becomes an absence. */
function stopOnError(step: CollectionStep, error: number, depth?: number): never {
    if (error === ERROR_ACCESS_DENIED) throw new Stop(atDepth({ status: "access-denied", step }, depth))
    if (error === ERROR_SHARING_VIOLATION) throw new Stop(atDepth({ status: "incomplete", reason: "sharing-violation" }, depth))
    throw new Stop(atDepth({ status: "failed", step, error }, depth))
}

/** Every handle the collection opens; each closed exactly once (component handles at the very end). */
class Handles {
    readonly #open = new Set<Handle>()
    failures = 0
    constructor(readonly api: Win32SecurityApi) {}
    track(handle: Handle): Handle {
        this.#open.add(handle)
        return handle
    }
    close(handle: Handle): void {
        if (!this.#open.delete(handle)) return
        try {
            if (this.api.close(handle) !== 0) this.failures++
        } catch {
            this.failures++
        }
    }
    closeAll(): void {
        for (const handle of [...this.#open].reverse()) this.close(handle)
    }
}

const DRIVE_TYPES: readonly DriveType[] = ["unknown", "no-root-dir", "removable", "fixed", "remote", "cdrom", "ramdisk"]

interface Walked {
    readonly handle: Handle
    /** The final path exactly as Windows returned it ("\\?\X:\..."). */
    readonly raw: string
    /** The same, in the drive form the validator expects. */
    readonly path: string
    readonly security: SecurityReading
    readonly record: "present" | "absent" | "unreadable"
    /** Proven case-insensitive (FileCaseSensitiveInfo read, flag clear); false when case-sensitive or unknown. */
    readonly caseInsensitive: boolean
}

interface ParsedInput {
    readonly requested: DrivePath
    readonly profile: ProfileSelection
    readonly limits: CollectionLimits
}

function validateInput(input: LocationFactsInput, options: LocationFactsOptions): ParsedInput | LocationCollection {
    const requested = parseInputPath((input as Partial<LocationFactsInput> | null)?.requestedPath)
    if (requested === null) return { status: "invalid-input", field: "requestedPath" }
    if (requested.segments.length === 0) return { status: "invalid-input", field: "requestedPath", reason: "volume-root" }
    if (!Number.isInteger(input.maxRelative) || input.maxRelative < 1 || input.maxRelative > 32767) return { status: "invalid-input", field: "maxRelative" }
    const profile = input.profile as Partial<{ status: unknown; path: unknown }> | null
    if (profile === null || typeof profile !== "object" || !((profile.status === "not-selected" && !("path" in profile)) || (profile.status === "selected" && typeof profile.path === "string"))) return { status: "invalid-input", field: "profile" }
    const limits = { ...DEFAULT_COLLECTION_LIMITS, ...options.limits }
    // a limit may be lowered, never raised or disabled
    if (!(Object.keys(DEFAULT_COLLECTION_LIMITS) as (keyof CollectionLimits)[]).every((k) => Number.isInteger(limits[k]) && limits[k] >= 1 && limits[k] <= DEFAULT_COLLECTION_LIMITS[k])) return { status: "invalid-input", field: "limits" }
    if (limits.listingBufferBytes < 4096) return { status: "invalid-input", field: "limits" }
    return { requested, profile: input.profile, limits }
}

const defaultApi = (): Win32SecurityApi => createWin32SecurityApi(bindWin32Primitives())

/**
 * Collects the facts of `input.requestedPath`. Never throws. Off Windows x64
 * nothing native is loaded; the Win32 binding is created only here, on the
 * first explicit call.
 */
export function collectLocationFacts(input: LocationFactsInput, options: LocationFactsOptions = {}): LocationCollection {
    const parsed = validateInput(input, options)
    if ("status" in parsed) return parsed
    if ((options.platform ?? process.platform) !== "win32" || !VERIFIED_ARCHS.includes(options.arch ?? process.arch)) return { status: "unsupported-platform" }
    let api: Win32SecurityApi
    try {
        api = (options.api ?? defaultApi)()
    } catch {
        return { status: "api-unavailable" }
    }
    const handles = new Handles(api)
    const progress = { step: "current-user" as CollectionStep }
    let result: LocationCollection
    try {
        result = gather(api, handles, input, parsed, options, progress)
    } catch (error) {
        result = error instanceof Stop ? error.result : { status: "failed", step: progress.step, error: error instanceof NativeReleaseError ? error.code : null }
    }
    handles.closeAll()
    // a handle that could not be closed: nothing read through it is trusted
    if (handles.failures > 0) return { status: "failed", step: "close", error: null }
    return result
}

function daclFact(d: DaclReading): DaclFacts {
    switch (d.kind) {
        case "present": return { kind: "present", aces: d.aces }
        // no DACL and a NULL DACL both grant everyone full access: the validator's "null" (refused)
        case "null": case "absent": return { kind: "null" }
        case "unreadable": return { kind: "unreadable" }
    }
}

/**
 * Whether a listing can be the inventory of one directory: no empty name, no "." or ".." (dropped by the listing),
 * no separator, no name twice; in a directory proven case-insensitive, no two names that differ only in ASCII case
 * (Windows keeps one of them). Non-ASCII look-alikes are kept: whether they collide depends on the volume's upcase
 * table, and the validator refuses them as an ambiguous record when they look like it.
 */
function inventoryConsistent(entries: readonly string[], caseInsensitive: boolean): boolean {
    const names = new Set<string>()
    for (const entry of entries) {
        if (entry === "" || entry === "." || entry === ".." || /[\\/\0]/.test(entry)) return false
        // asciiUpper(a) === asciiUpper(b) exactly when compareNames(a, b) is "equal"
        const key = caseInsensitive ? asciiUpper(entry) : entry
        if (names.has(key)) return false
        names.add(key)
    }
    return true
}

function gather(api: Win32SecurityApi, handles: Handles, input: LocationFactsInput, parsed: ParsedInput, options: LocationFactsOptions, progress: { step: CollectionStep }): LocationCollection {
    const { requested, limits } = parsed
    const step = (s: CollectionStep): void => void (progress.step = s)

    step("current-user")
    const user = api.currentUserSid()
    if (!user.ok) stopOnError("current-user", user.error)

    step("volume")
    const root = requested.root
    const driveType = DRIVE_TYPES[api.driveType(root)] ?? "unknown"
    const info = api.volumeInformation(root)
    // a failed call, or an answer without a usable component length, proves nothing about the file system
    const volumeInfo: VolumeInformation | null = info.ok && Number.isInteger(info.value.maximumComponentLength) && info.value.maximumComponentLength >= 1 && info.value.maximumComponentLength <= 32767 ? info.value : null
    const volume: VolumeFacts = { rootPath: root, driveType, fileSystem: volumeInfo?.fileSystemName ?? null, persistentAcls: volumeInfo === null ? null : (volumeInfo.fileSystemFlags & FILE_PERSISTENT_ACLS) !== 0 }

    const n = requested.segments.length
    const walked: Walked[] = []
    let missingFrom = n + 1
    for (let depth = 0; depth <= n; depth++) {
        step("open")
        const opened = api.openComponent(lexical(requested, depth), depth === n)
        if (!opened.ok) {
            if (depth > 0 && opened.error === ERROR_FILE_NOT_FOUND) {
                missingFrom = depth
                break
            }
            // the parent was opened (and is pinned) a moment ago: "path not found" below it is not an absence
            if (depth > 0 && opened.error === ERROR_PATH_NOT_FOUND) throw new Stop({ status: "inconsistent", reason: "vanished-during-collection", depth })
            if (depth === 0 && [ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_INVALID_DRIVE, ERROR_NOT_READY].includes(opened.error)) throw new Stop({ status: "incomplete", reason: "volume-unavailable", depth })
            stopOnError("open", opened.error, depth)
        }
        const handle = handles.track(opened.value)
        step("attributes")
        const attributes = api.attributes(handle)
        if (!attributes.ok) stopOnError("attributes", attributes.error, depth)
        step("final-path")
        const raw = api.finalPath(handle)
        if (!raw.ok) stopOnError("final-path", raw.error, depth)
        const form = dosPathFromFinalPath(raw.value)
        if (form.kind !== "drive") throw new Stop({ status: "incomplete", reason: "unsupported-namespace", depth })
        if (depth === 0) {
            // a SUBST drive (or any alias) opens a directory that is not the root of the letter chosen
            if (form.segments.length !== 0 || asciiUpper(form.root) !== root) throw new Stop({ status: "incomplete", reason: "path-alias", depth })
        } else {
            const parent = (walked[depth - 1] as Walked).raw
            const prefix = parent.endsWith("\\") ? parent : `${parent}\\`
            const name = raw.value.slice(prefix.length)
            if (!raw.value.startsWith(prefix) || name.length === 0 || name.includes("\\")) throw new Stop({ status: "inconsistent", reason: "path-chain", depth })
        }
        if (volumeInfo !== null) {
            step("volume-serial")
            const serial = api.volumeSerial(handle)
            if (!serial.ok) stopOnError("volume-serial", serial.error, depth)
            if (serial.value !== volumeInfo.serialNumber) throw new Stop({ status: "inconsistent", reason: "volume-mismatch", depth })
        }
        // nothing beyond a reparse point or a file can be reached without following or guessing
        if (attributes.value.reparseTag !== null) throw new Stop({ status: "incomplete", reason: "reparse-point-on-path", depth })
        if (!attributes.value.isDirectory) throw new Stop({ status: "incomplete", reason: "not-a-directory-on-path", depth })
        step("security")
        const security = api.security(handle)
        // A lookup by name is case-insensitive only in a case-insensitive directory: in a case-sensitive one (or if
        // that cannot be read) "not found" does not prove that no variant of the record's name is there.
        step("case-sensitivity")
        const caseSensitive = api.caseSensitiveDirectory(handle)
        step("record-lookup")
        let record: Walked["record"] = "unreadable"
        const caseInsensitive = caseSensitive.ok && !caseSensitive.value
        if (caseInsensitive) {
            const found = api.probeChild(raw.value, INSTALL_RECORD_NAME)
            record = found.ok ? found.value : "unreadable"
        }
        walked.push({ handle, raw: raw.value, path: form.path, security, record, caseInsensitive })
    }
    const exists = missingFrom === n + 1
    const deepest = walked[walked.length - 1] as Walked

    let content: DestinationContent | null = null
    if (exists) {
        step("listing")
        const listing = api.listDirectory(deepest.handle, { maxEntries: limits.maxEntries, maxCalls: limits.maxListingCalls, bufferBytes: limits.listingBufferBytes })
        if (listing.kind === "error") stopOnError("listing", listing.error, n)
        if (listing.kind === "truncated") throw new Stop({ status: "incomplete", reason: "listing-truncated", depth: n })
        if (listing.kind === "malformed") throw new Stop({ status: "incomplete", reason: "listing-malformed", depth: n })
        if (listing.kind === "inconsistent" || !inventoryConsistent(listing.entries, deepest.caseInsensitive)) throw new Stop({ status: "inconsistent", reason: "listing-inconsistent", depth: n })
        const matches = listing.entries.map((e) => compareNames(e, INSTALL_RECORD_NAME))
        // two independent proofs (the lookup and the listing) must agree, unless a look-alike name makes the listing
        // ambiguous: then the validator refuses it as such, whatever the lookup said
        if (deepest.record !== "unreadable" && !matches.includes("uncertain") && (deepest.record === "present") !== matches.includes("equal")) throw new Stop({ status: "inconsistent", reason: "record-lookup-mismatch", depth: n })
        let record: DestinationContent["record"] = deepest.record === "present" ? "unreadable" : deepest.record
        if (deepest.record === "present") {
            const verify = options.verifyInstallRecord
            if (verify === undefined) throw new Stop({ status: "incomplete", reason: "record-verification-unavailable", depth: n })
            step("record-verification")
            const verdict: unknown = verify({ canonicalPath: deepest.path, rawFinalPath: deepest.raw })
            if (verdict !== "this-directory" && verdict !== "other-directory" && verdict !== "unreadable") throw new Stop({ status: "failed", step: "record-verification", error: null, depth: n })
            record = verdict
        }
        content = { entries: [...listing.entries], record }
    }

    step("protected-directories")
    const protectedDirectories = resolveProtected(api, handles, options.env ?? process.env, parsed.profile, limits)

    // the chain is pinned, but its final paths are read again; the leaf must still be missing
    step("recheck")
    for (const [depth, w] of walked.entries()) {
        const again = api.finalPath(w.handle)
        if (!again.ok || again.value !== w.raw) throw new Stop({ status: "inconsistent", reason: "changed-during-collection", depth })
    }
    if (!exists) {
        const probe = api.openProbe(lexical(requested, missingFrom), false)
        if (probe.ok) handles.close(handles.track(probe.value))
        if (probe.ok || probe.error !== ERROR_FILE_NOT_FOUND) throw new Stop({ status: "inconsistent", reason: "changed-during-collection", depth: missingFrom })
    }

    const missingSegments = requested.segments.slice(missingFrom - 1)
    const facts: LocationFacts = {
        requestedPath: input.requestedPath,
        canonicalPath: joinPath(deepest.path, missingSegments),
        currentUserSid: user.value,
        volume,
        // only plain directories get here (the walk stops at anything else)
        components: walked.map((w) => ({ path: w.path, isDirectory: true, reparseTag: null, owner: w.security.owner.ok ? w.security.owner.sid : null, dacl: daclFact(w.security.dacl), installRecord: w.record })),
        missingSegments,
        protectedDirectories,
        destinationContent: content,
        maxRelative: input.maxRelative,
    }
    return { status: "complete", facts, volume: { maximumComponentLength: volumeInfo?.maximumComponentLength ?? null } }
}

// ------------------------------------------------------------------ protected directories

/**
 * The canonical location of a protected directory, existing or not: its
 * deepest existing ancestor opened THROUGH links (the protected place is
 * where the data really is), its final path, then the missing segments. Not
 * resolvable (access denied, a dangling link, a network or volume path) → null.
 *
 * A segment is taken as missing only when it is proven absent: not found
 * through links (ERROR_FILE_NOT_FOUND or ERROR_PATH_NOT_FOUND: a dangling
 * junction or symbolic link gives either, depending on what its target lacks)
 * AND not found by a probe that does not follow it. Whatever that probe finds
 * (a link, or an entry that following could not reach) or any other error it
 * gives (access denied included) leaves the location unknown: the lexical
 * path is never taken for a link's target. A no-follow "path not found" means
 * a component above is missing or is a link: the next, shorter prefix is
 * probed the same way, so a dangling link is always met as a final component.
 */
function canonicalLocation(api: Win32SecurityApi, handles: Handles, text: string): string | null {
    const parsed = parseInputPath(text)
    if (parsed === null) return null
    for (let k = parsed.segments.length; k >= 0; k--) {
        const at = lexical(parsed, k)
        const opened = api.openProbe(at, true)
        if (opened.ok) {
            const handle = handles.track(opened.value)
            let raw
            try {
                raw = api.finalPath(handle)
            } finally {
                handles.close(handle)
            }
            if (!raw.ok) return null
            const form = dosPathFromFinalPath(raw.value)
            return form.kind === "drive" ? joinPath(form.path, parsed.segments.slice(k)) : null
        }
        if (opened.error !== ERROR_FILE_NOT_FOUND && opened.error !== ERROR_PATH_NOT_FOUND) return null
        // not found THROUGH links, whichever code: a link whose target is missing still exists itself
        const own = api.openProbe(at, false)
        if (own.ok) {
            handles.close(handles.track(own.value))
            return null
        }
        if (own.error !== ERROR_FILE_NOT_FOUND && own.error !== ERROR_PATH_NOT_FOUND) return null
    }
    return null
}

type EnvValue = { readonly kind: "unset" } | { readonly kind: "set"; readonly value: string } | { readonly kind: "ambiguous" }

/** Windows variable names are case-insensitive (ASCII): two spellings with different values are ambiguous. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): EnvValue {
    const wanted = asciiUpper(name)
    const values = Object.entries(env).filter(([k, v]) => v !== undefined && asciiUpper(k) === wanted).map(([, v]) => v as string)
    if (values.length === 0) return { kind: "unset" }
    return new Set(values).size === 1 ? { kind: "set", value: values[0] as string } : { kind: "ambiguous" }
}

/** null marks a source that is set but cannot be used as a drive path: its category becomes unreadable. */
type Candidate = string | null

function resolveProtected(api: Win32SecurityApi, handles: Handles, env: Readonly<Record<string, string | undefined>>, profile: ProfileSelection, limits: CollectionLimits): ProtectedDirectoryFacts {
    const readings = new Map<KnownFolderId, KnownFolderReading>()
    const reading = (id: KnownFolderId): KnownFolderReading => {
        let r = readings.get(id)
        if (r === undefined) {
            r = api.knownFolder(id)
            readings.set(id, r)
        }
        return r
    }
    /** A known folder every Windows installation defines: not set is as unknown as an error. */
    const known = (id: KnownFolderId): Candidate => {
        const r = reading(id)
        return r.kind === "path" ? r.path : null
    }
    const under = (base: Candidate, name: string): Candidate => (base === null ? null : joinPath(base, [name]))
    const drivePath = (value: string): Candidate => (parseInputPath(value) === null ? null : value)
    const optionalEnv = (name: string): Candidate[] => {
        const v = envValue(env, name)
        return v.kind === "unset" ? [] : v.kind === "set" ? [drivePath(v.value)] : [null]
    }
    const location = (candidates: readonly Candidate[]): ResolvedLocation | UnreadableLocation => {
        const paths: string[] = []
        for (const c of candidates) {
            const canonical = c === null ? null : canonicalLocation(api, handles, c)
            if (canonical === null) return { status: "unreadable" }
            if (!paths.some((p) => provenSame(p, canonical))) paths.push(canonical)
        }
        return paths.length === 0 ? { status: "unreadable" } : { status: "resolved", paths }
    }

    const profileDir = known(KNOWN_FOLDER.Profile)
    const local = known(KNOWN_FOLDER.LocalAppData)
    const roaming = known(KNOWN_FOLDER.RoamingAppData)

    // OneDrive: absent only with all three proofs; any source that cannot be read leaves it unknown, and a partial
    // list of folders would protect only some of them
    const oneDrive = (): ProtectedDirectoryFacts["onedrive"] => {
        const sky = reading(KNOWN_FOLDER.SkyDrive)
        const vars = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].map((name) => envValue(env, name))
        const accounts = api.oneDriveAccounts(limits.maxOneDriveAccounts)
        if (sky.kind === "error" || vars.some((v) => v.kind === "ambiguous") || accounts.kind === "unreadable") return { status: "unreadable" }
        const candidates: Candidate[] = [
            ...(sky.kind === "path" ? [sky.path] : []),
            ...vars.flatMap((v) => (v.kind === "set" ? [drivePath(v.value)] : [])),
            ...(accounts.kind === "accounts" ? accounts.folders.map(drivePath) : []),
        ]
        if (candidates.length > 0) return location(candidates)
        return { status: "verified-absent", evidence: { kind: "onedrive-not-configured", knownFolderUnset: true, environmentUnset: true, noAccountUserFolder: true } }
    }

    return {
        windows: location([known(KNOWN_FOLDER.Windows)]),
        "program-files": location([known(KNOWN_FOLDER.ProgramFiles), known(KNOWN_FOLDER.ProgramFilesX86)]),
        "program-data": location([known(KNOWN_FOLDER.ProgramData)]),
        "users-root": location([known(KNOWN_FOLDER.UserProfiles)]),
        "public-profile": location([known(KNOWN_FOLDER.Public)]),
        "user-profile": location([profileDir]),
        "local-appdata": location([local]),
        "roaming-appdata": location([roaming]),
        temp: location([...optionalEnv("TMP"), ...optionalEnv("TEMP"), under(local, "Temp")]),
        onedrive: oneDrive(),
        // fixed locations named by the contract (A1), protected whether they exist or not; they are NOT the
        // discovery of the configuration Claude actually uses (03C)
        "claude-code-config": location([under(profileDir, ".claude"), ...optionalEnv("CLAUDE_CONFIG_DIR")]),
        "claude-desktop-data": location([under(roaming, "Claude"), under(local, "Claude-Data"), under(local, "Claude-3p")]),
        "msix-packages": location([under(local, "Packages")]),
        "fluent-reader-profile": profile.status === "not-selected" ? { status: "not-applicable", evidence: { kind: "profile-not-yet-selected" } } : location([drivePath(profile.path)]),
    }
}

// ------------------------------------------------------------------ messages (03A3)

const STEPS: Record<CollectionStep, string> = {
    "current-user": "l'utente corrente", volume: "l'unità", open: "una cartella del percorso", attributes: "gli attributi di una cartella", "final-path": "il percorso reale di una cartella",
    "volume-serial": "l'unità di una cartella", security: "i permessi di una cartella", "case-sensitivity": "una cartella del percorso", "record-lookup": "il registro di installazione",
    listing: "il contenuto della cartella", "record-verification": "il registro di installazione", "protected-directories": "le cartelle da proteggere", recheck: "il percorso", close: "le risorse di sistema",
}

/** An Italian message for a collection that is not complete: no path, SID or personal data. */
export function describeCollectionFailure(c: Exclude<LocationCollection, { status: "complete" }>): string {
    const where = "depth" in c && c.depth !== undefined ? ` (livello ${c.depth})` : ""
    switch (c.status) {
        case "invalid-input": return c.reason === "volume-root" ? "La radice di un'unità non può essere la cartella di installazione." : "Serve un percorso assoluto su un'unità locale (X:\\...), con nomi validi per Windows."
        case "unsupported-platform": return "La verifica della cartella è disponibile soltanto su Windows x64."
        case "api-unavailable": return "Le funzioni di Windows necessarie alla verifica della cartella non sono disponibili."
        case "access-denied": return `Accesso negato leggendo ${STEPS[c.step]}${where}: la cartella non può essere verificata.`
        case "inconsistent": return `Il percorso è cambiato o ha dato risposte incoerenti durante la verifica${where}: riprova.`
        case "failed": return `Windows non ha fornito ${STEPS[c.step]}${where}: la cartella non può essere verificata.`
        case "incomplete":
            switch (c.reason) {
                case "volume-unavailable": return "L'unità indicata non è disponibile."
                case "reparse-point-on-path": return `Il percorso passa per un collegamento, una junction o un punto di montaggio${where}.`
                case "not-a-directory-on-path": return `Un elemento del percorso non è una cartella${where}.`
                case "unsupported-namespace": return `Il percorso porta a una cartella di rete o a un volume senza lettera${where}.`
                case "path-alias": return "L'unità indicata è un alias (SUBST) di un'altra cartella: indica direttamente la cartella reale."
                case "sharing-violation": return `Una cartella del percorso è in uso per essere spostata o cancellata${where}: riprova.`
                case "listing-truncated": case "listing-malformed": return "Non è stato possibile leggere per intero il contenuto della cartella."
                case "record-verification-unavailable": return "La cartella contiene un registro di installazione che questo setup non può ancora verificare."
            }
    }
}
