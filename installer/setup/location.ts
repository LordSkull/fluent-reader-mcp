/**
 * FR-MCP-04-BETA-03A1: pure, fail-closed rules for an installation directory
 * on Windows, independent of the drive letter.
 *
 * PREPARATORY COMPONENT: nothing in the installer calls it yet. The wizard
 * and every helper command still go through checks.ts (safeInstallRoot);
 * wiring is 03A3, after the native collection of the facts (03A2).
 *
 * Boundary with the native layer (03A2): this module never touches the file
 * system, the registry or a Windows API. It receives LocationFacts, a typed
 * copy of what Win32 returns, field by field and WITHOUT interpretation:
 *   - GetDriveTypeW, GetVolumeInformationW (file system name, FILE_PERSISTENT_ACLS)
 *   - per existing component, from the volume root down: the final path
 *     (GetFinalPathNameByHandleW), directory or not, the reparse tag
 *     (FileAttributeTagInfo), the owner SID and the DACL as GetSecurityInfo +
 *     GetAce give it: AceType, AceFlags, Mask and SID of every ACE, unchanged
 *   - the current user's SID (TokenUser), the known folders (protected
 *     directories), the top-level entries of an existing destination.
 * Every interpretation (rights, inheritance, trust, flags) happens here, so
 * it is testable with synthetic data. Anything not recognised (ACE type,
 * flag or access bit, SID, drive type, missing or inconsistent fact) is a
 * refusal: unknown never becomes allowed.
 *
 * The ACL rule is a SUFFICIENT condition, not a replacement for AccessCheck:
 * no ALLOW ACE grants an untrusted principal a right that can modify,
 * replace, rename, delete or re-permission the destination, its contents or
 * an ancestor. Deny ACEs can only remove rights, so they are never counted
 * as protection (an allow to an untrusted principal is refused even if a
 * deny seems to cancel it); on the destination itself any deny ACE is
 * refused, because the owner's own access could no longer be proven.
 *
 * Protected directories: every category is REQUIRED and carries an explicit
 * status (ProtectedDirectoryFacts). Omitting one, or declaring it unreadable,
 * is a refusal; an absence is accepted only where the category admits it and
 * only with the evidence its type names. See ProtectedDirectoryFacts.
 *
 * Names are compared WITHOUT Windows' upcase table (03A1 is pure), so only
 * what can be proven is decided: names of different UTF-16 length differ
 * (ordinal comparison maps code units one to one); ASCII letters compare
 * case-insensitively; any other difference of code units is UNCERTAIN.
 * Uncertain never helps a destination: it is not "the same path" (canonical
 * form, facts consistency) and it is not "a different path" (protected
 * directories). PROVISIONAL RESTRICTION: a destination that would need a
 * non-ASCII case-insensitive comparison is refused; 03A2 may provide
 * comparisons verified with CompareStringOrdinal(bIgnoreCase = TRUE).
 */

/** ACE_HEADER.AceType values accepted in a DACL; every other type (object, callback, audit, label) is refused. */
export const ACE_TYPE = { ACCESS_ALLOWED: 0x0, ACCESS_DENIED: 0x1 } as const

/** ACE_HEADER.AceFlags bits that are meaningful in a DACL; any other bit (audit flags included) is refused. */
export const ACE_FLAG = { OBJECT_INHERIT: 0x01, CONTAINER_INHERIT: 0x02, NO_PROPAGATE_INHERIT: 0x04, INHERIT_ONLY: 0x08, INHERITED: 0x10 } as const
const KNOWN_ACE_FLAGS = 0x1f

/** Access mask bits for directories (winnt.h); the aliases are the same bits. */
export const ACCESS = {
    FILE_LIST_DIRECTORY: 0x1, // FILE_READ_DATA
    FILE_ADD_FILE: 0x2, // FILE_WRITE_DATA
    FILE_ADD_SUBDIRECTORY: 0x4, // FILE_APPEND_DATA
    FILE_READ_EA: 0x8,
    FILE_WRITE_EA: 0x10,
    FILE_TRAVERSE: 0x20, // FILE_EXECUTE
    FILE_DELETE_CHILD: 0x40,
    FILE_READ_ATTRIBUTES: 0x80,
    FILE_WRITE_ATTRIBUTES: 0x100,
    DELETE: 0x10000,
    READ_CONTROL: 0x20000,
    WRITE_DAC: 0x40000,
    WRITE_OWNER: 0x80000,
    SYNCHRONIZE: 0x100000,
    ACCESS_SYSTEM_SECURITY: 0x1000000,
    MAXIMUM_ALLOWED: 0x2000000,
    GENERIC_ALL: 0x10000000,
    GENERIC_EXECUTE: 0x20000000,
    GENERIC_WRITE: 0x40000000,
    GENERIC_READ: 0x80000000,
} as const
export const FILE_ALL_ACCESS = 0x1f01ff

const u32 = (n: number): number => n >>> 0
const KNOWN_ACCESS = u32(Object.values(ACCESS).reduce((a, b) => a | b, 0))
/** Rights that let a principal change what Claude will start, or remove or re-permission it. */
const WRITE_LIKE = u32(ACCESS.FILE_ADD_FILE | ACCESS.FILE_ADD_SUBDIRECTORY | ACCESS.FILE_WRITE_EA | ACCESS.FILE_DELETE_CHILD | ACCESS.FILE_WRITE_ATTRIBUTES | ACCESS.DELETE | ACCESS.WRITE_DAC | ACCESS.WRITE_OWNER | ACCESS.ACCESS_SYSTEM_SECURITY | ACCESS.MAXIMUM_ALLOWED | ACCESS.GENERIC_ALL | ACCESS.GENERIC_WRITE)
/** Rights that let a principal read the contents (the destination keeps private configuration backups). */
const READ_LIKE = u32(ACCESS.FILE_LIST_DIRECTORY | ACCESS.FILE_READ_EA | ACCESS.MAXIMUM_ALLOWED | ACCESS.GENERIC_ALL | ACCESS.GENERIC_READ)
const PERMISSION_LIKE = u32(ACCESS.WRITE_DAC | ACCESS.WRITE_OWNER | ACCESS.ACCESS_SYSTEM_SECURITY | ACCESS.MAXIMUM_ALLOWED | ACCESS.GENERIC_ALL)
const DELETE_LIKE = u32(ACCESS.DELETE | ACCESS.FILE_DELETE_CHILD)

export const WELL_KNOWN_SID = {
    SYSTEM: "S-1-5-18",
    ADMINISTRATORS: "S-1-5-32-544",
    TRUSTED_INSTALLER: "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    CREATOR_OWNER: "S-1-3-0",
    CREATOR_GROUP: "S-1-3-1",
    OWNER_RIGHTS: "S-1-3-4",
    EVERYONE: "S-1-1-0",
    AUTHENTICATED_USERS: "S-1-5-11",
    USERS: "S-1-5-32-545",
    GUESTS: "S-1-5-32-546",
    INTERACTIVE: "S-1-5-4",
    NETWORK: "S-1-5-2",
    ANONYMOUS: "S-1-5-7",
} as const

/** Principals that may own a component: the current user and the operating system's own accounts. */
const TRUSTED_OWNERS: readonly string[] = [WELL_KNOWN_SID.SYSTEM, WELL_KNOWN_SID.ADMINISTRATORS, WELL_KNOWN_SID.TRUSTED_INSTALLER]
/**
 * Principals an ACE may grant anything to. CREATOR OWNER becomes the creator
 * of a child (or matches nobody on the object itself); OWNER RIGHTS is the
 * owner, which is verified trusted before any ACE is looked at.
 */
const TRUSTED_ACE_PRINCIPALS: readonly string[] = [...TRUSTED_OWNERS, WELL_KNOWN_SID.CREATOR_OWNER, WELL_KNOWN_SID.OWNER_RIGHTS]

/**
 * The installation record's file name (record.ts RECORD_NAME; a test keeps
 * them equal). It is the ONLY proof that a non-empty directory belongs to
 * this product: names such as current, state or uninstall.exe prove nothing.
 */
export const INSTALL_RECORD_NAME = "fluent-reader-mcp.install.json"

// ------------------------------------------------------------------ facts (filled by the native layer, 03A2)

export type DriveType = "fixed" | "removable" | "remote" | "cdrom" | "ramdisk" | "no-root-dir" | "unknown"
const DRIVE_TYPES: readonly string[] = ["fixed", "removable", "remote", "cdrom", "ramdisk", "no-root-dir", "unknown"]

export interface VolumeFacts {
    /** Root of the volume holding the canonical path, "X:\". */
    readonly rootPath: string
    readonly driveType: DriveType
    /** File system name from GetVolumeInformationW; null = not readable. */
    readonly fileSystem: string | null
    /** FILE_PERSISTENT_ACLS of the volume; null = not readable. */
    readonly persistentAcls: boolean | null
}

/** One ACE exactly as GetAce returns it: header type and flags, access mask, SID string. */
export interface AceFacts {
    readonly aceType: number
    readonly aceFlags: number
    readonly accessMask: number
    readonly sid: string
}

/** A DACL that exists (possibly with no ACE), a NULL DACL (everyone has full access), or one that could not be read. */
export type DaclFacts = { readonly kind: "present"; readonly aces: readonly AceFacts[] } | { readonly kind: "null" } | { readonly kind: "unreadable" }

/** An existing component of the canonical path, from the volume root (first) to the deepest existing one. */
export interface ComponentFacts {
    /** Its canonical full path: the volume root, then one more segment of the canonical path at each level. */
    readonly path: string
    readonly isDirectory: boolean
    /** Reparse tag (FileAttributeTagInfo) or null if it is not a reparse point. */
    readonly reparseTag: number | null
    /** Owner SID; null = not readable. */
    readonly owner: string | null
    readonly dacl: DaclFacts
    /**
     * Whether an installation record (INSTALL_RECORD_NAME) is directly inside
     * it: present, absent (verified: the lookup answered "not found"), or
     * unreadable (the lookup failed: never taken as absent).
     */
    readonly installRecord: "present" | "absent" | "unreadable"
}

/** Every category of directory the destination must not overlap; each one is required in the facts. */
export const PROTECTED_KINDS = [
    "windows", "program-files", "program-data", "users-root", "public-profile", "user-profile", "local-appdata", "roaming-appdata",
    "temp", "onedrive", "claude-code-config", "claude-desktop-data", "msix-packages", "fluent-reader-profile",
] as const
export type ProtectedKind = (typeof PROTECTED_KINDS)[number]

/**
 * The LOCATION of a category: one or more canonical drive paths, as the
 * native layer resolved them (known folder or environment, then canonical
 * form of the deepest existing ancestor + the missing segments). A location
 * is resolved whether or not the directory exists today: a directory that
 * does not exist yet is still protected, because it is where Windows or a
 * client would create it.
 */
export interface ResolvedLocation {
    readonly status: "resolved"
    readonly paths: readonly string[]
}

/** The location could not be determined: always a refusal. */
export interface UnreadableLocation {
    readonly status: "unreadable"
}

/**
 * OneDrive is the only category whose absence can be verified, and only
 * with all three pieces of evidence: the known folder FOLDERID_SkyDrive is
 * not set (SHGetKnownFolderPath fails), none of OneDrive, OneDriveConsumer,
 * OneDriveCommercial is set in the environment, and no account under
 * HKCU\Software\Microsoft\OneDrive\Accounts has a UserFolder.
 */
export interface OneDriveVerifiedAbsent {
    readonly status: "verified-absent"
    readonly evidence: { readonly kind: "onedrive-not-configured"; readonly knownFolderUnset: true; readonly environmentUnset: true; readonly noAccountUserFolder: true }
}

/**
 * The Fluent Reader profile while the user has not chosen it yet (the
 * wizard asks for the directory first). Accepted only with this evidence,
 * and then the best possible answer is a ProvisionalDestination (allowed:
 * false) with the pending check "fluent-reader-profile-overlap": the caller
 * must evaluate again with the chosen profile before anything is written.
 */
export interface ProfileNotYetSelected {
    readonly status: "not-applicable"
    readonly evidence: { readonly kind: "profile-not-yet-selected" }
}

/**
 * The protected directories, by category. Every category is required (an
 * omitted one is a refusal, never an absence). Windows, Program Files,
 * ProgramData, the users directory, Public, the user profile, local and
 * roaming AppData, Temp, Packages, the Claude Code and Claude Desktop data
 * locations ALWAYS have a location (known folders, or fixed names under
 * them: %USERPROFILE%\.claude and CLAUDE_CONFIG_DIR; %APPDATA%\Claude,
 * %LOCALAPPDATA%\Claude-Data and Claude-3p): they must be resolved.
 */
export interface ProtectedDirectoryFacts {
    readonly windows: ResolvedLocation | UnreadableLocation
    readonly "program-files": ResolvedLocation | UnreadableLocation
    readonly "program-data": ResolvedLocation | UnreadableLocation
    readonly "users-root": ResolvedLocation | UnreadableLocation
    readonly "public-profile": ResolvedLocation | UnreadableLocation
    readonly "user-profile": ResolvedLocation | UnreadableLocation
    readonly "local-appdata": ResolvedLocation | UnreadableLocation
    readonly "roaming-appdata": ResolvedLocation | UnreadableLocation
    readonly temp: ResolvedLocation | UnreadableLocation
    readonly onedrive: ResolvedLocation | UnreadableLocation | OneDriveVerifiedAbsent
    readonly "claude-code-config": ResolvedLocation | UnreadableLocation
    readonly "claude-desktop-data": ResolvedLocation | UnreadableLocation
    readonly "msix-packages": ResolvedLocation | UnreadableLocation
    readonly "fluent-reader-profile": ResolvedLocation | UnreadableLocation | ProfileNotYetSelected
}

/** Facts the evaluator still needs before it can allow anything (see ProfileNotYetSelected, ProvisionalDestination). */
export type PendingCheck = "fluent-reader-profile-overlap"

/** Top-level content of an existing destination, and what its installation record says. */
export interface DestinationContent {
    readonly entries: readonly string[]
    /** absent; present and naming this very directory; present and naming another one (copied); present but unreadable. */
    readonly record: "absent" | "this-directory" | "other-directory" | "unreadable"
}

export interface LocationFacts {
    /** The path as the user chose it. */
    readonly requestedPath: string
    /** The final path of its deepest existing component, followed by the missing segments. */
    readonly canonicalPath: string
    readonly currentUserSid: string
    readonly volume: VolumeFacts
    readonly components: readonly ComponentFacts[]
    /** Segments of the canonical path that do not exist yet, outermost first. */
    readonly missingSegments: readonly string[]
    readonly protectedDirectories: ProtectedDirectoryFacts
    /** Required when the destination exists, null when it does not. */
    readonly destinationContent: DestinationContent | null
    /**
     * REQUIRED: the longest relative path the installation will create under
     * the destination, in UTF-16 code units, separator included (checks.ts
     * MAX_PATH rule: canonical + 1 + maxRelative ≤ policy.maxPath).
     */
    readonly maxRelative: number
}

export interface LocationPolicy {
    /** File system names accepted (beta: NTFS only). */
    readonly allowedFileSystems: readonly string[]
    /** Reparse tags tolerated on a component (beta: none). */
    readonly allowedReparseTags: readonly number[]
    /** Rights an untrusted principal may hold on the volume root itself (Windows grants creation of folders and files there by default). */
    readonly volumeRootTolerance: number
    /** Refuse a destination whose contents others can read (it keeps copies of private client configurations). */
    readonly privateDestination: boolean
    /** MAX_PATH minus the terminating NUL; extended-length paths are not supported (at most 259). */
    readonly maxPath: number
    /** Longest name of one component (NTFS: 255 UTF-16 code units; at most 255). */
    readonly maxComponentLength: number
}

export const DEFAULT_LOCATION_POLICY: LocationPolicy = {
    allowedFileSystems: ["NTFS"],
    allowedReparseTags: [],
    volumeRootTolerance: ACCESS.FILE_ADD_FILE | ACCESS.FILE_ADD_SUBDIRECTORY,
    privateDestination: true,
    maxPath: 259,
    maxComponentLength: 255,
}

// ------------------------------------------------------------------ verdict

export type DestinationState = "existing" | "new-leaf" | "unverifiable"

/** Stable refusal codes (the wizard maps them to messages: describeRefusal). */
export const REFUSAL_REASONS = [
    "invalid-policy", "malformed-facts", "incomplete-facts", "invalid-path-form", "path-not-canonical", "path-too-long", "component-too-long", "volume-root",
    "unsupported-volume", "unsupported-file-system", "volume-without-acls", "volume-unverifiable",
    "protected-directory", "path-comparison-unverifiable", "other-user-profile", "missing-ancestors", "not-a-directory", "reparse-point", "nested-installation", "install-record-unverifiable",
    "acl-unverifiable", "null-dacl", "untrusted-owner", "unsupported-ace", "untrusted-access", "destination-readable-by-others",
    "deny-ace-on-destination", "destination-access-incomplete", "foreign-content", "foreign-installation-record", "installation-record-unreadable", "ambiguous-install-record",
] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

export type ComponentRole = "volume-root" | "ancestor" | "parent" | "destination"
/** Where the problem is: role and depth (segments below the volume root); never a path or a SID. */
export interface ComponentRef {
    readonly role: ComponentRole
    readonly depth: number
}
export type PrincipalCategory = "everyone" | "authenticated-users" | "users" | "guests" | "interactive" | "network" | "anonymous" | "creator-group" | "other-principal"
export type RightCategory = "change-permissions" | "delete" | "write" | "read"
export type Relation = "equal" | "inside" | "contains"

export interface LocationRefusal {
    readonly allowed: false
    readonly state: DestinationState
    readonly reason: RefusalReason
    readonly component?: ComponentRef
    readonly principal?: PrincipalCategory
    readonly right?: RightCategory
    readonly protectedKind?: ProtectedKind
    readonly relation?: Relation
}

export interface ExistingDestination {
    readonly allowed: true
    readonly state: "existing"
    readonly canonicalPath: string
    /**
     * empty, or an installation whose record names this very directory. A
     * non-empty directory without that record is refused: layout names prove
     * no ownership (recovery of an installation interrupted before its record
     * is checks.ts/transaction.ts business, to be reconciled before wiring).
     */
    readonly content: "empty" | "installation"
    /** Always empty: a verdict with checks still to be made is a ProvisionalDestination, never an allowed one. */
    readonly pendingChecks: readonly []
}

/**
 * The destination does not exist and MAY be created, but only as the single
 * leaf, with this explicit protected descriptor (03A2/03A4). Eligibility is
 * not safety: until the protected creation succeeds and is re-verified,
 * nothing may be written there.
 */
export interface NewLeafDestination {
    readonly allowed: true
    readonly state: "new-leaf"
    readonly canonicalPath: string
    readonly parentPath: string
    readonly leafName: string
    readonly requiresProtectedCreation: true
    /** SDDL of the DACL to create the leaf with: protected (no inheritance), full control to the user, SYSTEM and Administrators only. */
    readonly securityDescriptor: string
    /** Always empty: a verdict with checks still to be made is a ProvisionalDestination, never an allowed one. */
    readonly pendingChecks: readonly []
}

/**
 * NOT an authorisation (allowed: false): every check that could be made has
 * passed, but some facts are still missing (pendingChecks, never empty).
 * Nothing may be written, nor the leaf created; the caller must collect the
 * missing facts (for example the chosen profile) and evaluate again from
 * complete facts. eligibleAs tells what the destination would be.
 */
export interface ProvisionalDestination {
    readonly allowed: false
    readonly state: "provisional"
    readonly eligibleAs: "existing" | "new-leaf"
    readonly canonicalPath: string
    readonly pendingChecks: readonly [PendingCheck, ...PendingCheck[]]
}

/**
 * allowed: true ⇔ ExistingDestination | NewLeafDestination, with no pending
 * check (pendingChecks: readonly [] by type). A ProvisionalDestination
 * (state "provisional") and a LocationRefusal (with a reason) both have
 * allowed: false.
 */
export type LocationVerdict = ExistingDestination | NewLeafDestination | ProvisionalDestination | LocationRefusal

// ------------------------------------------------------------------ helpers

class Refused extends Error {
    constructor(readonly refusal: Omit<LocationRefusal, "allowed" | "state">, readonly state: DestinationState | null = null) {
        super(refusal.reason)
    }
}

function refuse(reason: RefusalReason, extra: Omit<LocationRefusal, "allowed" | "state" | "reason"> = {}, state: DestinationState | null = null): never {
    throw new Refused({ reason, ...extra }, state)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isUint = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

interface DrivePath {
    readonly root: string
    readonly segments: readonly string[]
}

/** A drive-absolute path X:\a\b (either separator, trailing separators allowed), split into valid Windows names; null otherwise. */
function parseDrivePath(input: string): DrivePath | null {
    if (input.length === 0 || input.length > 32767 || input.includes("\0") || !/^[A-Za-z]:[\\/]/.test(input)) return null
    const rest = input.slice(3).replace(/[\\/]+$/, "")
    const segments = rest === "" ? [] : rest.split(/[\\/]/)
    for (const s of segments) {
        if (s === "" || s === "." || s === ".." || /[. ]$/.test(s) || RESERVED.test(s) || /[<>:"|?*\x00-\x1f]/.test(s)) return null
    }
    return { root: `${input.charAt(0).toUpperCase()}:\\`, segments }
}

/** What can be PROVEN about two names under Windows' ordinal case-insensitive comparison, without its upcase table. */
export type NameComparison = "equal" | "different" | "uncertain"

const asciiUpper = (c: number): number => (c >= 0x61 && c <= 0x7a ? c - 0x20 : c)

/**
 * Ordinal case-insensitive comparison maps UTF-16 code units one to one
 * (CompareStringOrdinal, the NTFS $UpCase table), so: different lengths are
 * different; equal code units, or ASCII letters differing only in case, are
 * equal; two ASCII code units that differ otherwise are different; any other
 * pair (a non-ASCII code unit against a different one: "ς" and "Σ", "ı" and
 * "I", the Kelvin sign and "K") is uncertain. Never toLowerCase/toUpperCase.
 */
export function compareNames(a: string, b: string): NameComparison {
    if (a.length !== b.length) return "different"
    let uncertain = false
    for (let i = 0; i < a.length; i++) {
        const x = a.charCodeAt(i)
        const y = b.charCodeAt(i)
        if (x === y) continue
        if (x < 0x80 && y < 0x80) {
            if (asciiUpper(x) !== asciiUpper(y)) return "different"
            continue
        }
        uncertain = true
    }
    return uncertain ? "uncertain" : "equal"
}

/** Combines segment comparisons: one proven difference decides; otherwise any uncertainty stays. */
function compareSegments(a: readonly string[], b: readonly string[]): NameComparison {
    if (a.length !== b.length) return "different"
    let uncertain = false
    for (let i = 0; i < a.length; i++) {
        const c = compareNames(a[i] as string, b[i] as string)
        if (c === "different") return "different"
        if (c === "uncertain") uncertain = true
    }
    return uncertain ? "uncertain" : "equal"
}

/** Only a PROVEN equality counts as the same path (an uncertain one is not). */
const samePath = (a: DrivePath, b: DrivePath): boolean => a.root === b.root && compareSegments(a.segments, b.segments) === "equal"
const format = (p: DrivePath, depth = p.segments.length): string => `${p.root}${p.segments.slice(0, depth).join("\\")}`

/** How `dest` relates to `dir`, segment by segment (never by string prefix: "Claude" is not "ClaudeBackup"); null when proven unrelated. */
function relation(dest: DrivePath, dir: DrivePath): Relation | "uncertain" | null {
    if (dest.root !== dir.root) return null
    const n = Math.min(dest.segments.length, dir.segments.length)
    const prefix = compareSegments(dest.segments.slice(0, n), dir.segments.slice(0, n))
    if (prefix === "different") return null
    if (prefix === "uncertain") return "uncertain"
    return dest.segments.length === dir.segments.length ? "equal" : dest.segments.length > dir.segments.length ? "inside" : "contains"
}

const SID = /^S-1-(\d{1,15})((?:-\d{1,10}){1,15})$/
function wellFormedSid(sid: string): boolean {
    const m = SID.exec(sid)
    return m !== null && (m[2] as string).slice(1).split("-").every((sub) => Number(sub) <= 0xffffffff)
}

/** The current user (TokenUser): a local or domain account (S-1-5-21-…) or a Microsoft Entra ID account (S-1-12-1-…). */
function userSid(sid: string): boolean {
    return wellFormedSid(sid) && /^S-1-(5-21|12-1)(-\d+){4}$/.test(sid)
}

function principalCategory(sid: string): PrincipalCategory {
    switch (sid) {
        case WELL_KNOWN_SID.EVERYONE: return "everyone"
        case WELL_KNOWN_SID.AUTHENTICATED_USERS: return "authenticated-users"
        case WELL_KNOWN_SID.USERS: return "users"
        case WELL_KNOWN_SID.GUESTS: return "guests"
        case WELL_KNOWN_SID.INTERACTIVE: return "interactive"
        case WELL_KNOWN_SID.NETWORK: return "network"
        case WELL_KNOWN_SID.ANONYMOUS: return "anonymous"
        case WELL_KNOWN_SID.CREATOR_GROUP: return "creator-group"
        default: return "other-principal"
    }
}

function rightCategory(mask: number): RightCategory {
    if (u32(mask & PERMISSION_LIKE) !== 0) return "change-permissions"
    if (u32(mask & DELETE_LIKE) !== 0) return "delete"
    return "write"
}

/** GENERIC_ALL maps to FILE_ALL_ACCESS for files and directories (the other generic rights grant less, never DELETE_CHILD and WRITE_DAC together). */
function fileRights(mask: number): number {
    return u32(mask & ACCESS.GENERIC_ALL) !== 0 ? u32(mask | FILE_ALL_ACCESS) : mask
}

// ------------------------------------------------------------------ shape (the facts cross a native boundary)

const hasExactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k))

/** One protected category: only the statuses its type admits, with exactly their fields (anything else is contradictory). */
function protectedFactOk(kind: string, p: unknown): boolean {
    if (!isRecord(p)) return false
    switch (p.status) {
        case "resolved":
            return hasExactKeys(p, ["status", "paths"]) && Array.isArray(p.paths) && p.paths.length > 0 && p.paths.every((s) => typeof s === "string")
        case "unreadable":
            return hasExactKeys(p, ["status"])
        case "verified-absent": {
            const e = p.evidence
            return kind === "onedrive" && hasExactKeys(p, ["status", "evidence"]) && isRecord(e) && hasExactKeys(e, ["kind", "knownFolderUnset", "environmentUnset", "noAccountUserFolder"]) &&
                e.kind === "onedrive-not-configured" && e.knownFolderUnset === true && e.environmentUnset === true && e.noAccountUserFolder === true
        }
        case "not-applicable": {
            const e = p.evidence
            return kind === "fluent-reader-profile" && hasExactKeys(p, ["status", "evidence"]) && isRecord(e) && hasExactKeys(e, ["kind"]) && e.kind === "profile-not-yet-selected"
        }
        default:
            return false
    }
}

function shapeOk(f: unknown): f is LocationFacts {
    if (!isRecord(f)) return false
    if (typeof f.requestedPath !== "string" || typeof f.canonicalPath !== "string" || typeof f.currentUserSid !== "string") return false
    const v = f.volume
    if (!isRecord(v) || typeof v.rootPath !== "string" || typeof v.driveType !== "string" || !(v.fileSystem === null || typeof v.fileSystem === "string") || !(v.persistentAcls === null || typeof v.persistentAcls === "boolean")) return false
    if (!Array.isArray(f.components) || f.components.length === 0 || !Array.isArray(f.missingSegments) || !f.missingSegments.every((s) => typeof s === "string")) return false
    for (const c of f.components as unknown[]) {
        if (!isRecord(c) || typeof c.path !== "string" || typeof c.isDirectory !== "boolean" || !["present", "absent", "unreadable"].includes(c.installRecord as string)) return false
        if (!(c.reparseTag === null || isUint(c.reparseTag, 0xffffffff)) || !(c.owner === null || typeof c.owner === "string")) return false
        const d = c.dacl
        if (!isRecord(d) || !["present", "null", "unreadable"].includes(d.kind as string)) return false
        if (d.kind === "present") {
            if (!Array.isArray(d.aces)) return false
            for (const a of d.aces as unknown[]) if (!isRecord(a) || !isUint(a.aceType, 0xff) || !isUint(a.aceFlags, 0xff) || !isUint(a.accessMask, 0xffffffff) || typeof a.sid !== "string") return false
        }
    }
    // the categories present must be known and well formed; a MISSING category is reported as incomplete-facts by evaluate
    const p = f.protectedDirectories
    if (!isRecord(p) || !Object.entries(p).every(([kind, fact]) => (PROTECTED_KINDS as readonly string[]).includes(kind) && protectedFactOk(kind, fact))) return false
    const content = f.destinationContent
    if (!(content === null || (isRecord(content) && Array.isArray(content.entries) && content.entries.every((e) => typeof e === "string") && ["absent", "this-directory", "other-directory", "unreadable"].includes(content.record as string)))) return false
    if (!isUint(f.maxRelative, 32767) || f.maxRelative === 0) return false
    return true
}

/** A policy that would disable or loosen a protection is refused, not silently clamped. */
function policyOk(p: unknown): p is LocationPolicy {
    if (!isRecord(p)) return false
    return Array.isArray(p.allowedFileSystems) && p.allowedFileSystems.length > 0 && p.allowedFileSystems.every((s) => typeof s === "string" && /^[A-Z0-9]+$/.test(s)) &&
        Array.isArray(p.allowedReparseTags) && p.allowedReparseTags.every((t) => isUint(t, 0xffffffff)) &&
        isUint(p.volumeRootTolerance, 0xffffffff) && u32(p.volumeRootTolerance & ~(ACCESS.FILE_ADD_FILE | ACCESS.FILE_ADD_SUBDIRECTORY)) === 0 &&
        typeof p.privateDestination === "boolean" &&
        isUint(p.maxPath, 259) && p.maxPath >= 4 && isUint(p.maxComponentLength, 255) && p.maxComponentLength >= 1
}

// ------------------------------------------------------------------ ACL

interface AceView {
    readonly allow: boolean
    readonly inheritOnly: boolean
    readonly inheritsToContainersAndObjects: boolean
    readonly mask: number
    readonly sid: string
}

/** Decodes one ACE; any type, flag or access bit not understood is a refusal. */
function decodeAce(ace: AceFacts, at: ComponentRef): AceView {
    if (!wellFormedSid(ace.sid)) refuse("malformed-facts", { component: at }, "unverifiable")
    if (ace.aceType !== ACE_TYPE.ACCESS_ALLOWED && ace.aceType !== ACE_TYPE.ACCESS_DENIED) refuse("unsupported-ace", { component: at })
    if ((ace.aceFlags & ~KNOWN_ACE_FLAGS) !== 0) refuse("unsupported-ace", { component: at })
    if (u32(ace.accessMask & ~KNOWN_ACCESS) !== 0) refuse("unsupported-ace", { component: at })
    const flags = ace.aceFlags
    return {
        allow: ace.aceType === ACE_TYPE.ACCESS_ALLOWED,
        inheritOnly: (flags & ACE_FLAG.INHERIT_ONLY) !== 0,
        inheritsToContainersAndObjects: (flags & ACE_FLAG.OBJECT_INHERIT) !== 0 && (flags & ACE_FLAG.CONTAINER_INHERIT) !== 0 && (flags & ACE_FLAG.NO_PROPAGATE_INHERIT) === 0,
        mask: u32(ace.accessMask),
        sid: ace.sid,
    }
}

/**
 * Owner and DACL of one component.
 *  - volume root and ancestors: only ACEs that apply to the component itself
 *    count (an INHERIT_ONLY ACE applies to its children, which are checked
 *    with their own DACL, where Windows has materialised it as INHERITED);
 *    the volume root tolerates policy.volumeRootTolerance for untrusted
 *    principals, nothing else does;
 *  - destination: every ACE counts, inherit-only ones included (they decide
 *    the rights on everything the installer will create inside); with
 *    privateDestination, untrusted principals may not even read; any deny
 *    ACE is refused; the user must hold full control both on the directory
 *    and inherited by its files and subdirectories.
 */
function checkComponent(c: ComponentFacts, at: ComponentRef, userSidValue: string, policy: LocationPolicy): void {
    if (c.owner === null) refuse("acl-unverifiable", { component: at }, "unverifiable")
    if (!wellFormedSid(c.owner)) refuse("malformed-facts", { component: at }, "unverifiable")
    if (c.owner !== userSidValue && !TRUSTED_OWNERS.includes(c.owner)) refuse("untrusted-owner", { component: at, principal: principalCategory(c.owner) })
    if (c.dacl.kind === "unreadable") refuse("acl-unverifiable", { component: at }, "unverifiable")
    // A NULL DACL grants full access to everyone; it is not an empty DACL (which grants nothing).
    if (c.dacl.kind === "null") refuse("null-dacl", { component: at })
    const destination = at.role === "destination"
    let effective = 0
    let inherited = 0
    for (const raw of c.dacl.aces) {
        const ace = decodeAce(raw, at)
        if (!ace.allow) {
            if (destination) refuse("deny-ace-on-destination", { component: at })
            continue
        }
        if (ace.sid === userSidValue) {
            if (!ace.inheritOnly) effective = u32(effective | fileRights(ace.mask))
            if (ace.inheritsToContainersAndObjects) inherited = u32(inherited | fileRights(ace.mask))
            continue
        }
        if (TRUSTED_ACE_PRINCIPALS.includes(ace.sid)) continue
        if (!destination && ace.inheritOnly) continue
        const tolerated = at.role === "volume-root" ? u32(policy.volumeRootTolerance) : 0
        const dangerous = u32(ace.mask & WRITE_LIKE & ~tolerated)
        if (dangerous !== 0) refuse("untrusted-access", { component: at, principal: principalCategory(ace.sid), right: rightCategory(dangerous) })
        if (destination && policy.privateDestination && u32(ace.mask & READ_LIKE) !== 0) refuse("destination-readable-by-others", { component: at, principal: principalCategory(ace.sid), right: "read" })
    }
    if (destination && (u32(effective & FILE_ALL_ACCESS) !== FILE_ALL_ACCESS || u32(inherited & FILE_ALL_ACCESS) !== FILE_ALL_ACCESS)) refuse("destination-access-incomplete", { component: at })
}

/**
 * The DACL a new leaf must be created with (03A2/03A4): protected, so nothing
 * is inherited from the parent. Private: only a verdict carries it, and the
 * SID is validated here too (digits and dashes only), so no SDDL token can
 * be injected.
 */
function protectedLeafDescriptor(userSidValue: string): string {
    if (!userSid(userSidValue)) refuse("malformed-facts", {}, "unverifiable")
    return `D:P(A;OICI;FA;;;${userSidValue})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`
}

// ------------------------------------------------------------------ evaluation

function evaluate(f: LocationFacts, policy: LocationPolicy): Exclude<LocationVerdict, LocationRefusal> {
    if (!userSid(f.currentUserSid)) refuse("malformed-facts", {}, "unverifiable")

    // path form, canonical form, volume root, lengths
    const requested = parseDrivePath(f.requestedPath)
    if (requested === null) refuse("invalid-path-form", {}, "unverifiable")
    const canonical = parseDrivePath(f.canonicalPath)
    if (canonical === null) refuse("malformed-facts", {}, "unverifiable")
    if (requested.segments.length === 0 || canonical.segments.length === 0) refuse("volume-root", {}, "unverifiable")
    // a link, junction, SUBST drive or 8.3 name on the way makes the final path differ from the chosen one; so does a
    // non-ASCII case difference, which cannot be proven equal here
    if (!samePath(requested, canonical)) refuse("path-not-canonical", {}, "unverifiable")
    if (canonical.segments.some((s) => s.length > policy.maxComponentLength)) refuse("component-too-long", {}, "unverifiable")
    if (f.maxRelative >= policy.maxPath) refuse("malformed-facts", {}, "unverifiable")
    const canonicalText = format(canonical)
    if (canonicalText.length + 1 + f.maxRelative > policy.maxPath) refuse("path-too-long", {}, "unverifiable")

    // the facts must describe exactly the prefixes of the canonical path
    const n = canonical.segments.length
    if (f.components.length + f.missingSegments.length !== n + 1) refuse("malformed-facts", {}, "unverifiable")
    f.components.forEach((c, depth) => {
        const p = parseDrivePath(c.path)
        if (p === null || !samePath(p, { root: canonical.root, segments: canonical.segments.slice(0, depth) })) refuse("malformed-facts", {}, "unverifiable")
    })
    if (compareSegments(f.missingSegments, canonical.segments.slice(f.components.length - 1)) !== "equal") refuse("malformed-facts", {}, "unverifiable")
    const exists = f.missingSegments.length === 0
    const state: DestinationState = exists ? "existing" : f.missingSegments.length === 1 ? "new-leaf" : "unverifiable"
    if (exists !== (f.destinationContent !== null)) refuse("malformed-facts", {}, "unverifiable")

    // volume: fixed, with persistent ACLs, of an accepted file system
    const volumeRoot = parseDrivePath(f.volume.rootPath)
    if (volumeRoot === null || volumeRoot.segments.length !== 0 || volumeRoot.root !== canonical.root || !DRIVE_TYPES.includes(f.volume.driveType)) refuse("malformed-facts", {}, "unverifiable")
    if (f.volume.driveType !== "fixed") refuse("unsupported-volume", {}, state)
    if (f.volume.fileSystem === null || f.volume.persistentAcls === null) refuse("volume-unverifiable", {}, "unverifiable")
    // ASCII-only case folding ("ntfſ".toUpperCase() would be "NTFS")
    if (!/^[A-Za-z0-9]+$/.test(f.volume.fileSystem) || !policy.allowedFileSystems.includes(f.volume.fileSystem.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x20)))) refuse("unsupported-file-system", {}, state)
    if (!f.volume.persistentAcls) refuse("volume-without-acls", {}, state)

    // protected directories: every category stated explicitly (an omitted or unreadable one is never taken as absent)
    const pendingChecks: PendingCheck[] = []
    const protectedDirs: { readonly kind: ProtectedKind; readonly path: DrivePath }[] = []
    for (const kind of PROTECTED_KINDS) {
        if (!Object.hasOwn(f.protectedDirectories, kind)) refuse("incomplete-facts", { protectedKind: kind }, "unverifiable")
        const fact = f.protectedDirectories[kind]
        if (fact.status === "unreadable") refuse("incomplete-facts", { protectedKind: kind }, "unverifiable")
        if (fact.status === "verified-absent") continue
        if (fact.status === "not-applicable") {
            pendingChecks.push("fluent-reader-profile-overlap")
            continue
        }
        const own: DrivePath[] = []
        for (const text of fact.paths) {
            const p = parseDrivePath(text)
            if (p === null) refuse("malformed-facts", { protectedKind: kind }, "unverifiable")
            // uniqueness: equal is a duplicate, uncertain an ambiguity (PROVISIONAL: may be too strict until 03A2 can
            // compare with CompareStringOrdinal), only a proven difference makes two locations of one category
            for (const q of own) {
                const same = q.root === p.root ? compareSegments(q.segments, p.segments) : "different"
                if (same === "equal") refuse("malformed-facts", { protectedKind: kind }, "unverifiable")
                if (same === "uncertain") refuse("path-comparison-unverifiable", { protectedKind: kind }, "unverifiable")
            }
            own.push(p)
            protectedDirs.push({ kind, path: p })
        }
    }
    const relations = protectedDirs.map((p) => ({ ...p, rel: relation(canonical, p.path) }))
    // a relation that cannot be decided without Windows' upcase table is a refusal, never "unrelated"
    for (const r of relations) if (r.rel === "uncertain") refuse("path-comparison-unverifiable", { protectedKind: r.kind }, state)
    const insideProfile = relations.some((r) => r.kind === "user-profile" && r.rel === "inside")
    // the specific kinds first, the generic users-root rule last: the reason does not depend on the order of the facts
    for (const r of [...relations.filter((d) => d.kind !== "users-root"), ...relations.filter((d) => d.kind === "users-root")]) {
        const rel = r.rel
        if (rel === null || rel === "uncertain") continue
        if (r.kind === "users-root") {
            if (rel !== "inside") refuse("protected-directory", { protectedKind: r.kind, relation: rel }, state)
            if (!insideProfile) refuse("other-user-profile", {}, state)
        } else if (r.kind === "user-profile" || r.kind === "local-appdata") {
            // the user's own profile and local AppData: inside them is fine, the folders themselves or above are not
            if (rel !== "inside") refuse("protected-directory", { protectedKind: r.kind, relation: rel }, state)
        } else {
            refuse("protected-directory", { protectedKind: r.kind, relation: rel }, state)
        }
    }

    if (f.missingSegments.length > 1) refuse("missing-ancestors", {}, "unverifiable")

    // every existing component: a real directory, no reparse point, no installation (or unknown record state) above the destination
    const last = f.components.length - 1
    const roleOf = (depth: number): ComponentRole => (depth === 0 ? "volume-root" : depth === last ? (exists ? "destination" : "parent") : "ancestor")
    f.components.forEach((c, depth) => {
        const at: ComponentRef = { role: roleOf(depth), depth }
        if (!c.isDirectory) refuse("not-a-directory", { component: at }, state)
        if (c.reparseTag !== null && !policy.allowedReparseTags.includes(c.reparseTag)) refuse("reparse-point", { component: at }, state)
        if (c.installRecord === "unreadable") refuse("install-record-unverifiable", { component: at }, "unverifiable")
        if (at.role !== "destination" && c.installRecord === "present") refuse("nested-installation", { component: at }, state)
    })

    // owners and DACLs, from the volume root down
    f.components.forEach((c, depth) => checkComponent(c, { role: roleOf(depth), depth }, f.currentUserSid, policy))

    // The final answer: an authorisation only with no pending check (pendingChecks: [] by type); with one, a
    // provisional verdict (allowed: false) that authorises nothing, not even the creation of the leaf.
    const finish = (v: ExistingDestination | NewLeafDestination): ExistingDestination | NewLeafDestination | ProvisionalDestination => {
        const [first, ...rest] = pendingChecks
        return first === undefined ? v : { allowed: false, state: "provisional", eligibleAs: v.state, canonicalPath: canonicalText, pendingChecks: [first, ...rest] }
    }

    if (!exists) {
        const leafName = f.missingSegments[0] as string
        return finish({ allowed: true, state: "new-leaf", canonicalPath: canonicalText, parentPath: format(canonical, n - 1), leafName, requiresProtectedCreation: true, securityDescriptor: protectedLeafDescriptor(f.currentUserSid), pendingChecks: [] })
    }

    // an existing destination: empty, or an installation whose record names this very directory; nothing else proves ownership
    const content = f.destinationContent as DestinationContent
    const destination = f.components[last] as ComponentFacts
    const at: ComponentRef = { role: "destination", depth: last }
    // Exactly ONE entry must be provably the record. A case-sensitive directory can hold several names that a
    // case-insensitive lookup (checks.ts, Windows by default) takes for it, and a non-ASCII look-alike cannot be ruled
    // out here: in both cases the inventory does not prove which file is the record, whatever the lookup reported.
    const matches = content.entries.map((e) => compareNames(e, INSTALL_RECORD_NAME))
    const recordEntries = matches.filter((m) => m === "equal").length
    if (recordEntries > 1 || matches.includes("uncertain")) refuse("ambiguous-install-record", { component: at }, state)
    const recordPresent = destination.installRecord === "present"
    if ((recordEntries === 1) !== recordPresent || recordPresent !== (content.record !== "absent")) refuse("malformed-facts", { component: at }, "unverifiable")
    if (content.record === "unreadable") refuse("installation-record-unreadable", { component: at }, state)
    if (content.record === "other-directory") refuse("foreign-installation-record", { component: at }, state)
    if (content.record === "this-directory") return finish({ allowed: true, state: "existing", canonicalPath: canonicalText, content: "installation", pendingChecks: [] })
    if (content.entries.length === 0) return finish({ allowed: true, state: "existing", canonicalPath: canonicalText, content: "empty", pendingChecks: [] })
    return refuse("foreign-content", { component: at }, state)
}

/**
 * Whether the facts describe a safe installation directory. Never throws:
 * every problem, unexpected ones included, is a refusal with a stable,
 * sanitised reason (no path, no SID, no configuration content).
 */
export function evaluateLocation(facts: LocationFacts, policy: LocationPolicy = DEFAULT_LOCATION_POLICY): LocationVerdict {
    try {
        if (!policyOk(policy)) refuse("invalid-policy", {}, "unverifiable")
        if (!shapeOk(facts)) refuse("malformed-facts", {}, "unverifiable")
        return evaluate(facts, policy)
    } catch (error) {
        if (error instanceof Refused) {
            const state = error.state ?? (shapeOk(facts) ? (facts.missingSegments.length === 0 ? "existing" : facts.missingSegments.length === 1 ? "new-leaf" : "unverifiable") : "unverifiable")
            return { allowed: false, state, ...error.refusal }
        }
        return { allowed: false, state: "unverifiable", reason: "malformed-facts" }
    }
}

// ------------------------------------------------------------------ messages for the wizard (03A3)

const PRINCIPALS: Record<PrincipalCategory, string> = {
    everyone: "Everyone (tutti)", "authenticated-users": "Authenticated Users (tutti gli utenti autenticati)", users: "Users (tutti gli utenti locali)", guests: "Guests",
    interactive: "INTERACTIVE", network: "NETWORK", anonymous: "ANONYMOUS LOGON", "creator-group": "CREATOR GROUP", "other-principal": "un altro utente o gruppo non verificabile",
}
const RIGHTS: Record<RightCategory, string> = { "change-permissions": "cambiarne i permessi o il proprietario", delete: "cancellare o rinominare elementi", write: "creare o modificare file", read: "leggerne il contenuto" }
const ROLES: Record<ComponentRole, string> = { "volume-root": "la radice dell'unità", ancestor: "una cartella che la contiene", parent: "la cartella in cui verrebbe creata", destination: "la cartella scelta" }

/** A message in Italian (like the wizard) that names the failed control; no path, SID or personal data. */
export function describeRefusal(r: LocationRefusal): string {
    const where = r.component === undefined ? "" : ` (${ROLES[r.component.role]}, livello ${r.component.depth})`
    const who = r.principal === undefined ? "" : PRINCIPALS[r.principal]
    switch (r.reason) {
        case "invalid-policy": return "La configurazione dei controlli di sicurezza del setup non è valida: per sicurezza la cartella non viene usata."
        case "malformed-facts": return "Le informazioni sulla cartella sono incomplete o incoerenti: per sicurezza la cartella non viene usata."
        case "incomplete-facts": return "Non è stato possibile individuare tutte le cartelle di sistema, del profilo e dei client Claude da proteggere: per sicurezza la cartella non viene usata."
        case "invalid-path-form": return "Serve un percorso assoluto su un'unità locale (X:\\...), con nomi validi per Windows: percorsi di rete, relativi, di dispositivo o con \".\" e \"..\" non sono ammessi."
        case "path-not-canonical": return "Il percorso passa per un collegamento, una junction, un'unità SUBST o un nome breve: indica direttamente la cartella reale."
        case "path-too-long": return "Il percorso è troppo lungo per i file dell'installazione."
        case "component-too-long": return "Il nome di una cartella del percorso è troppo lungo (al massimo 255 caratteri)."
        case "volume-root": return "La radice di un'unità non può essere la cartella di installazione: scegli o crea una sottocartella."
        case "unsupported-volume": return "L'unità non è un disco locale fisso (unità di rete, rimovibile, ottica o RAM disk)."
        case "unsupported-file-system": return "Il file system dell'unità non è NTFS."
        case "volume-without-acls": return "L'unità non conserva i permessi dei file (ACL): non può proteggere l'installazione."
        case "volume-unverifiable": return "Non è stato possibile verificare il tipo di unità o il suo file system."
        case "protected-directory": return "La cartella coincide con una cartella di sistema, condivisa, sincronizzata o di configurazione (di Windows, di Claude o di Fluent Reader), la contiene o vi è contenuta."
        case "path-comparison-unverifiable": return "Non è possibile stabilire con certezza se il percorso coincide con una cartella protetta (lettere non ASCII con maiuscole e minuscole diverse): scegli la cartella con Sfoglia o un nome diverso."
        case "other-user-profile": return "La cartella si trova nel profilo di un altro utente o nella cartella comune degli utenti."
        case "missing-ancestors": return "Mancano più cartelle del percorso: il setup crea soltanto l'ultima, dentro una cartella esistente e verificata."
        case "not-a-directory": return `Un elemento del percorso non è una cartella${where}.`
        case "reparse-point": return `Il percorso contiene un collegamento, una junction o un altro reparse point${where}.`
        case "nested-installation": return `La cartella si trova dentro un'altra installazione di Fluent Reader MCP${where}.`
        case "install-record-unverifiable": return `Non è stato possibile verificare se una cartella del percorso contiene un'installazione di Fluent Reader MCP${where}.`
        case "acl-unverifiable": return `Non è stato possibile leggere il proprietario o i permessi${where}.`
        case "null-dacl": return `Una cartella del percorso non ha alcuna protezione: chiunque può modificarla${where}.`
        case "untrusted-owner": return `Il proprietario di una cartella del percorso non sei tu né il sistema${where}.`
        case "unsupported-ace": return `I permessi di una cartella del percorso contengono voci che il setup non sa valutare${where}.`
        case "untrusted-access": return `${who} può ${RIGHTS[r.right ?? "write"]}${where}: un altro utente potrebbe sostituire i programmi che Claude avvierà.`
        case "destination-readable-by-others": return `${who} può ${RIGHTS.read}${where}: la cartella conterrà copie private di configurazioni.`
        case "deny-ace-on-destination": return `La cartella scelta ha permessi di negazione: il setup non può verificare di poterla gestire${where}.`
        case "destination-access-incomplete": return `Sulla cartella scelta non hai il controllo completo, anche sui file che vi verranno creati${where}.`
        case "foreign-content": return "La cartella contiene già altri file: scegli una cartella vuota o nuova."
        case "foreign-installation-record": return "La cartella contiene il registro di installazione di un'altra cartella (copiato?): scegli una cartella vuota o nuova."
        case "installation-record-unreadable": return "Il registro di installazione presente nella cartella non è leggibile."
        case "ambiguous-install-record": return "La cartella contiene più file che potrebbero essere il registro di installazione (nomi che differiscono solo per maiuscole o per lettere simili): non è possibile stabilire quale sia quello autentico."
    }
}
