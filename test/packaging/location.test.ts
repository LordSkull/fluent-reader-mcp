/**
 * FR-MCP-04-BETA-03A1: the pure location validator on SYNTHETIC facts only.
 * No file system, ACL, registry or profile of this machine is read: every
 * path, SID and DACL below is made up, shaped like what Win32 returns
 * (GetSecurityInfo/GetAce fields, GetDriveTypeW, GetVolumeInformationW).
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { setupClosure } from "../../installer/lib/installer-build.js"
import * as location from "../../installer/setup/location.js"
import {
    ACCESS, ACE_FLAG, compareNames, DEFAULT_LOCATION_POLICY, describeRefusal, evaluateLocation, FILE_ALL_ACCESS, INSTALL_RECORD_NAME, PROTECTED_KINDS, REFUSAL_REASONS, WELL_KNOWN_SID,
    type AceFacts, type ComponentFacts, type DaclFacts, type DestinationContent, type ExistingDestination, type LocationFacts, type LocationPolicy, type LocationRefusal, type LocationVerdict, type NewLeafDestination, type ProtectedDirectoryFacts, type ProvisionalDestination, type ProtectedKind, type RefusalReason, type VolumeFacts,
} from "../../installer/setup/location.js"
import { RECORD_NAME } from "../../installer/setup/record.js"

const COMPILED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

// ------------------------------------------------------------------ synthetic principals and ACLs

const USER = "S-1-5-21-1111111111-2222222222-3333333333-1001"
const OTHER_USER = "S-1-5-21-1111111111-2222222222-3333333333-1002"
const DOMAIN_USERS = "S-1-5-21-3444444444-555555555-666666666-513"
const DOMAIN_ADMINS = "S-1-5-21-3444444444-555555555-666666666-512"
const UNKNOWN_SID = "S-1-5-21-9-9-9-424242"
const { SYSTEM, ADMINISTRATORS: ADMINS, TRUSTED_INSTALLER, AUTHENTICATED_USERS: AU, USERS, EVERYONE, CREATOR_OWNER, CREATOR_GROUP, OWNER_RIGHTS } = WELL_KNOWN_SID

const OICI = ACE_FLAG.OBJECT_INHERIT | ACE_FLAG.CONTAINER_INHERIT
const IO = ACE_FLAG.INHERIT_ONLY
const INH = ACE_FLAG.INHERITED
const FA = FILE_ALL_ACCESS
const MODIFY = 0x1301bf
const RX = 0x1200a9
const AD = ACCESS.FILE_ADD_SUBDIRECTORY

const allow = (sid: string, mask: number, flags = 0): AceFacts => ({ aceType: 0, aceFlags: flags, accessMask: mask, sid })
const deny = (sid: string, mask: number, flags = 0): AceFacts => ({ aceType: 1, aceFlags: flags, accessMask: mask, sid })
const present = (aces: AceFacts[]): DaclFacts => ({ kind: "present", aces })

/** Default ACL of an NTFS volume root formatted by Windows: creation of folders for everyone, Modify on their children only. */
const NTFS_ROOT = [allow(ADMINS, FA, OICI), allow(SYSTEM, FA, OICI), allow(AU, MODIFY, OICI | IO), allow(AU, AD), allow(USERS, RX, OICI)]
/** What a folder created under such a root inherits: every authenticated user can modify it. */
const SHARED_INHERITED = [allow(ADMINS, FA, OICI | INH), allow(SYSTEM, FA, OICI | INH), allow(AU, MODIFY, OICI | INH), allow(USERS, RX, OICI | INH)]
const USERS_DIR = [allow(SYSTEM, FA, OICI), allow(ADMINS, FA, OICI), allow(USERS, RX, OICI), allow(EVERYONE, RX, OICI)]
const PROFILE_ACL = [allow(SYSTEM, FA, OICI), allow(ADMINS, FA, OICI), allow(USER, FA, OICI)]
const PRIVATE_INHERITED = [allow(SYSTEM, FA, OICI | INH), allow(ADMINS, FA, OICI | INH), allow(USER, FA, OICI | INH)]
/** A folder created with the protected descriptor (or made private): nothing inherited. */
const PRIVATE = [allow(USER, FA, OICI), allow(SYSTEM, FA, OICI), allow(ADMINS, FA, OICI)]

const PROFILE = "C:\\Users\\Test User é"
const LOCAL = `${PROFILE}\\AppData\\Local`
const ROAMING = `${PROFILE}\\AppData\\Roaming`
const resolved = (...paths: string[]): { readonly status: "resolved"; readonly paths: readonly string[] } => ({ status: "resolved", paths })
/** Every category resolved, as the native layer would report them for a synthetic user. */
const PROTECTED: ProtectedDirectoryFacts = {
    windows: resolved("C:\\Windows"),
    "program-files": resolved("C:\\Program Files", "C:\\Program Files (x86)"),
    "program-data": resolved("C:\\ProgramData"),
    "users-root": resolved("C:\\Users"),
    "public-profile": resolved("C:\\Users\\Public"),
    "user-profile": resolved(PROFILE),
    "local-appdata": resolved(LOCAL),
    "roaming-appdata": resolved(ROAMING),
    temp: resolved(`${LOCAL}\\Temp`),
    onedrive: resolved(`${PROFILE}\\OneDrive`),
    "claude-code-config": resolved(`${PROFILE}\\.claude`),
    "claude-desktop-data": resolved(`${ROAMING}\\Claude`, `${LOCAL}\\Claude-Data`, `${LOCAL}\\Claude-3p`),
    "msix-packages": resolved(`${LOCAL}\\Packages`),
    "fluent-reader-profile": resolved("D:\\Profili\\Fluent Reader"),
}
const ONEDRIVE_ABSENT = { status: "verified-absent", evidence: { kind: "onedrive-not-configured", knownFolderUnset: true, environmentUnset: true, noAccountUserFolder: true } } as const
const PROFILE_NOT_SELECTED = { status: "not-applicable", evidence: { kind: "profile-not-yet-selected" } } as const

/** PROTECTED without one category (an omission, which must never read as an absence). */
function omitting(kind: ProtectedKind): ProtectedDirectoryFacts {
    const copy: Record<string, unknown> = { ...PROTECTED }
    delete copy[kind]
    return copy as unknown as ProtectedDirectoryFacts
}
/** PROTECTED with one category replaced by an arbitrary (possibly ill-formed) value. */
function replacing(kind: string, value: unknown): ProtectedDirectoryFacts {
    return { ...PROTECTED, [kind]: value } as unknown as ProtectedDirectoryFacts
}

const EMPTY: DestinationContent = { entries: [], record: "absent" }

function prefixes(canonical: string): string[] {
    const root = canonical.slice(0, 3)
    const segments = canonical.slice(3).split("\\").filter((s) => s.length > 0)
    return [root, ...segments.map((_, i) => root + segments.slice(0, i + 1).join("\\"))]
}

/** Owner and DACL of a synthetic component, like Windows would set them by default. */
function defaultSecurity(p: string, depth: number): Pick<ComponentFacts, "owner" | "dacl"> {
    const lower = p.toLowerCase()
    if (depth === 0) return { owner: lower.startsWith("c") ? TRUSTED_INSTALLER : ADMINS, dacl: present(NTFS_ROOT) }
    if (lower === "c:\\users") return { owner: SYSTEM, dacl: present(USERS_DIR) }
    if (lower === PROFILE.toLowerCase()) return { owner: SYSTEM, dacl: present(PROFILE_ACL) }
    if (lower.startsWith(`${PROFILE.toLowerCase()}\\`)) return { owner: USER, dacl: present(PRIVATE_INHERITED) }
    return { owner: USER, dacl: present(SHARED_INHERITED) }
}

interface Options {
    /** Number of trailing segments that do not exist. */
    readonly missing?: number
    /** Overrides of single components, by depth (0 = volume root). */
    readonly at?: Readonly<Record<number, Partial<ComponentFacts>>>
    readonly content?: DestinationContent | null
    readonly volume?: Partial<VolumeFacts>
    readonly requested?: string
    readonly protectedDirectories?: ProtectedDirectoryFacts
    readonly maxRelative?: number
}

/** The installer's real budget is MAX_RELATIVE from the build; any plausible value does for synthetic facts. */
const MAX_RELATIVE = 120

function facts(canonical: string, o: Options = {}): LocationFacts {
    const all = prefixes(canonical)
    const missing = o.missing ?? 0
    const existing = all.slice(0, all.length - missing)
    const components = existing.map((p, depth): ComponentFacts => ({ path: p, isDirectory: true, reparseTag: null, installRecord: "absent", ...defaultSecurity(p, depth), ...(o.at?.[depth] ?? {}) }))
    return {
        requestedPath: o.requested ?? canonical,
        canonicalPath: canonical,
        currentUserSid: USER,
        volume: { rootPath: all[0] as string, driveType: "fixed", fileSystem: "NTFS", persistentAcls: true, ...o.volume },
        components,
        missingSegments: all.slice(all.length - missing).map((p) => p.slice(p.lastIndexOf("\\") + 1)),
        protectedDirectories: o.protectedDirectories ?? PROTECTED,
        destinationContent: o.content !== undefined ? o.content : missing === 0 ? EMPTY : null,
        maxRelative: o.maxRelative ?? MAX_RELATIVE,
    }
}

/** A chain of private folders on any volume: every level below the root made private. */
function privateChain(depths: number[], extra: Record<number, Partial<ComponentFacts>> = {}): Record<number, Partial<ComponentFacts>> {
    const at: Record<number, Partial<ComponentFacts>> = {}
    for (const d of depths) at[d] = { owner: USER, dacl: present(PRIVATE) }
    for (const [d, v] of Object.entries(extra)) at[Number(d)] = { ...at[Number(d)], ...v }
    return at
}

function allowed(v: LocationVerdict): asserts v is ExistingDestination | NewLeafDestination {
    if (!v.allowed) assert.fail(`expected allowed, got ${JSON.stringify(v)}`)
}

/** The reason of a refusal, or what the verdict is when it is not one. */
function reasonOf(v: LocationVerdict): RefusalReason | "allowed" | "provisional" {
    return v.allowed ? "allowed" : v.state === "provisional" ? "provisional" : v.reason
}

function refused(f: LocationFacts, reason: RefusalReason, match: Partial<LocationRefusal> = {}, policy?: LocationPolicy): LocationRefusal {
    const v = evaluateLocation(f, policy)
    if (v.allowed || v.state === "provisional") assert.fail(`expected ${reason}, got: ${JSON.stringify(v)}`)
    assert.equal(v.reason, reason, JSON.stringify(v))
    for (const [key, value] of Object.entries(match)) assert.deepEqual(v[key as keyof LocationRefusal], value, `${key}: ${JSON.stringify(v)}`)
    return v
}

const APPS = "D:\\Apps\\FluentReaderMCP"

// ------------------------------------------------------------------ tests

describe("location: private directories, on any drive", () => {
    test("the default %LOCALAPPDATA% directory on C: (existing, empty) is accepted", () => {
        const v = evaluateLocation(facts(`${LOCAL}\\FluentReaderMCP`))
        allowed(v)
        assert.deepEqual(v, { allowed: true, state: "existing", canonicalPath: `${LOCAL}\\FluentReaderMCP`, content: "empty", pendingChecks: [] })
    })

    test("a private directory on D:, directly under the root or under a private folder, is accepted", () => {
        const top = evaluateLocation(facts("D:\\FluentReaderMCP", { at: privateChain([1]) }))
        allowed(top)
        assert.equal(top.state, "existing")
        const nested = evaluateLocation(facts(APPS, { at: privateChain([1, 2]) }))
        allowed(nested)
    })

    test("the same structure gets the same verdict on C: and on D: (no drive letter in the rules)", () => {
        for (const letter of ["C", "D", "E"]) {
            allowed(evaluateLocation(facts(`${letter}:\\Apps\\FluentReaderMCP`, { at: privateChain([1, 2]) })))
            refused(facts(`${letter}:\\Apps\\FluentReaderMCP`), "untrusted-access", { component: { role: "ancestor", depth: 1 }, principal: "authenticated-users" })
            refused(facts(`${letter}:\\Apps\\FluentReaderMCP`, { at: privateChain([1]) }), "untrusted-access", { component: { role: "destination", depth: 2 } })
        }
    })

    test("a fixed volume is not enough: a D: folder with the ACL it inherits by default is refused", () => {
        refused(facts("D:\\FluentReaderMCP"), "untrusted-access", { component: { role: "destination", depth: 1 }, principal: "authenticated-users", right: "delete" })
    })

    test("spaces, Unicode, forward slashes, a trailing separator and ASCII letter case in the chosen path are accepted", () => {
        const canonical = "D:\\Programmi utente\\Fluent Reader MCP é 😀"
        allowed(evaluateLocation(facts(canonical, { at: privateChain([1, 2]) })))
        allowed(evaluateLocation(facts(canonical, { at: privateChain([1, 2]), requested: "d:/programmi utente/FLUENT READER MCP é 😀/" })))
    })

    test("PROVISIONAL: a non-ASCII case difference between the chosen and the final path cannot be proven equal: refused", () => {
        const canonical = "D:\\Programmi utente\\Fluent Reader MCP é 😀"
        refused(facts(canonical, { at: privateChain([1, 2]), requested: "D:\\Programmi utente\\Fluent Reader MCP É 😀" }), "path-not-canonical")
    })
})

describe("location: DACL of the destination", () => {
    test("an empty directory with a shared ACL (Users can read, Authenticated Users can modify) is refused", () => {
        refused(facts(APPS, { at: privateChain([1], { 2: { dacl: present(SHARED_INHERITED) } }) }), "untrusted-access", { component: { role: "destination", depth: 2 }, principal: "authenticated-users" })
    })

    test("an explicit Authenticated Users: Modify ACE on the destination is refused", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, allow(AU, MODIFY, OICI)]) } }) }), "untrusted-access", { principal: "authenticated-users", right: "delete" })
    })

    test("an inherit-only ACE on the destination counts: it decides the rights on everything created inside", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, allow(EVERYONE, MODIFY, OICI | IO)]) } }) }), "untrusted-access", { principal: "everyone" })
    })

    test("read access for others is refused by default (private backups will live there), accepted when the policy allows it", () => {
        const f = facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, allow(USERS, RX, OICI)]) } }) })
        refused(f, "destination-readable-by-others", { principal: "users", right: "read" })
        allowed(evaluateLocation(f, { ...DEFAULT_LOCATION_POLICY, privateDestination: false }))
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, allow(USERS, ACCESS.GENERIC_READ, OICI)]) } }) }), "destination-readable-by-others")
    })

    test("generic rights are expanded: GENERIC_ALL or GENERIC_WRITE for others refused, GENERIC_ALL for the user is full control", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, allow(AU, ACCESS.GENERIC_ALL, OICI)]) } }) }), "untrusted-access", { right: "change-permissions" })
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, allow(USERS, ACCESS.GENERIC_WRITE, OICI | IO)]) } }) }), "untrusted-access", { right: "write" })
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([allow(USER, ACCESS.GENERIC_ALL, OICI), allow(SYSTEM, FA, OICI)]) } }) })))
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([allow(USER, (ACCESS.GENERIC_WRITE | ACCESS.GENERIC_READ) >>> 0, OICI)]) } }) }), "destination-access-incomplete")
    })

    test("the user's full control must hold on the directory AND be inherited by files and subdirectories", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([allow(USER, FA), allow(SYSTEM, FA, OICI)]) } }) }), "destination-access-incomplete")
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([allow(USER, FA, OICI | ACE_FLAG.NO_PROPAGATE_INHERIT)]) } }) }), "destination-access-incomplete")
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([allow(USER, MODIFY, OICI)]) } }) }), "destination-access-incomplete")
        // split across two ACEs: one for the directory, one inherited only
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([allow(USER, FA), allow(USER, FA, OICI | IO)]) } }) })))
    })

    test("a NULL DACL is not an empty DACL: null refused as open to everyone, empty refused because the user has no access", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: { kind: "null" } } }) }), "null-dacl", { component: { role: "destination", depth: 2 } })
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([]) } }) }), "destination-access-incomplete")
    })

    test("a deny ACE on the destination is refused: the user's own access could no longer be proven", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, deny(OTHER_USER, ACCESS.DELETE)]) } }) }), "deny-ace-on-destination")
    })

    test("trusted principals: SYSTEM, Administrators, TrustedInstaller, CREATOR OWNER and OWNER RIGHTS may hold any right", () => {
        const aces = [...PRIVATE, allow(TRUSTED_INSTALLER, FA, OICI), allow(CREATOR_OWNER, FA, OICI | IO), allow(OWNER_RIGHTS, ACCESS.READ_CONTROL)]
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present(aces) } }) })))
    })

    test("CREATOR GROUP is not trusted (on a child it becomes the creator's primary group)", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, allow(CREATOR_GROUP, MODIFY, OICI | IO)]) } }) }), "untrusted-access", { principal: "creator-group" })
    })
})

describe("location: owners, unknown principals and domain groups", () => {
    test("an unexpected owner of the destination or of an ancestor is refused", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { owner: OTHER_USER } }) }), "untrusted-owner", { component: { role: "destination", depth: 2 }, principal: "other-principal" })
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { owner: AU } }) }), "untrusted-owner", { component: { role: "ancestor", depth: 1 }, principal: "authenticated-users" })
        refused(facts(APPS, { at: privateChain([1, 2], { 0: { owner: OTHER_USER } }) }), "untrusted-owner", { component: { role: "volume-root", depth: 0 } })
    })

    test("an unknown SID with write access, or with read access to the destination, is refused", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { dacl: present([...PRIVATE, allow(UNKNOWN_SID, ACCESS.FILE_ADD_FILE)]) } }) }), "untrusted-access", { principal: "other-principal", right: "write" })
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, allow(UNKNOWN_SID, ACCESS.FILE_LIST_DIRECTORY)]) } }) }), "destination-readable-by-others", { principal: "other-principal" })
    })

    test("domain groups are not trusted, Domain Admins included (membership cannot be verified)", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { dacl: present([...PRIVATE, allow(DOMAIN_USERS, MODIFY, OICI)]) } }) }), "untrusted-access", { component: { role: "ancestor", depth: 1 } })
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, allow(DOMAIN_ADMINS, FA, OICI)]) } }) }), "untrusted-access", { right: "change-permissions" })
    })
})

describe("location: ancestors and the volume root", () => {
    test("an ancestor that other users can modify is refused, even when the destination itself is private", () => {
        refused(facts(APPS, { at: privateChain([2]) }), "untrusted-access", { component: { role: "ancestor", depth: 1 }, principal: "authenticated-users", right: "delete" })
    })

    test("deletion rights alone on an ancestor are refused (renaming it would redirect the path)", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { dacl: present([...PRIVATE, allow(AU, ACCESS.DELETE)]) } }) }), "untrusted-access", { right: "delete" })
        refused(facts(APPS, { at: privateChain([1, 2], { 0: { dacl: present([...NTFS_ROOT, allow(AU, ACCESS.FILE_DELETE_CHILD)]) } }) }), "untrusted-access", { component: { role: "volume-root", depth: 0 }, right: "delete" })
    })

    test("the volume root tolerates only the creation of entries by others; the same right on another ancestor is refused", () => {
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2], { 0: { dacl: present([...NTFS_ROOT, allow(USERS, ACCESS.FILE_ADD_FILE)]) } }) })))
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { dacl: present([...PRIVATE, allow(AU, AD)]) } }) }), "untrusted-access", { component: { role: "ancestor", depth: 1 }, right: "write" })
        refused(facts(APPS, { at: privateChain([1, 2], { 0: { dacl: present([...NTFS_ROOT, allow(AU, ACCESS.FILE_WRITE_ATTRIBUTES)]) } }) }), "untrusted-access", { component: { role: "volume-root", depth: 0 } })
        refused(facts(APPS, { at: privateChain([1, 2], { 0: { dacl: present([...NTFS_ROOT, allow(EVERYONE, ACCESS.WRITE_DAC)]) } }) }), "untrusted-access", { right: "change-permissions" })
    })

    test("inherit-only ACEs of an ancestor apply to its children (checked with their own DACL), not to the ancestor itself", () => {
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2], { 1: { dacl: present([...PRIVATE, allow(AU, MODIFY, OICI | IO)]) } }) })))
    })

    test("a deny ACE never protects: allow + deny for the same group is still refused; a deny alone on an ancestor removes rights only", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { dacl: present([deny(AU, MODIFY, OICI), ...PRIVATE, allow(AU, MODIFY, OICI)]) } }) }), "untrusted-access")
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2], { 1: { dacl: present([deny(EVERYONE, ACCESS.DELETE), ...PRIVATE]) } }) })))
    })

    test("an empty DACL on an ancestor grants nothing to anyone: accepted; a NULL DACL there is refused", () => {
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2], { 1: { dacl: present([]) } }) })))
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { dacl: { kind: "null" } } }) }), "null-dacl", { component: { role: "ancestor", depth: 1 } })
    })
})

describe("location: volumes", () => {
    test("remote, removable, optical, RAM and unknown drive types are refused", () => {
        for (const driveType of ["remote", "removable", "cdrom", "ramdisk", "no-root-dir", "unknown"] as const) {
            refused(facts(APPS, { at: privateChain([1, 2]), volume: { driveType } }), "unsupported-volume")
        }
    })

    test("NTFS is required by the default policy (any letter case); FAT32, exFAT and ReFS are refused unless the policy allows them", () => {
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2]), volume: { fileSystem: "ntfs" } })))
        for (const fileSystem of ["FAT32", "exFAT", "ReFS"]) refused(facts(APPS, { at: privateChain([1, 2]), volume: { fileSystem } }), "unsupported-file-system")
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2]), volume: { fileSystem: "ReFS" } }), { ...DEFAULT_LOCATION_POLICY, allowedFileSystems: ["NTFS", "REFS"] }))
    })

    test("a volume without persistent ACLs, or whose properties cannot be read, is refused", () => {
        refused(facts(APPS, { at: privateChain([1, 2]), volume: { persistentAcls: false } }), "volume-without-acls")
        refused(facts(APPS, { at: privateChain([1, 2]), volume: { persistentAcls: null } }), "volume-unverifiable", { state: "unverifiable" })
        refused(facts(APPS, { at: privateChain([1, 2]), volume: { fileSystem: null } }), "volume-unverifiable")
    })
})

describe("location: protected directories", () => {
    test("system directories are refused", () => {
        for (const [dir, kind] of [["C:\\Windows\\FluentReaderMCP", "windows"], ["C:\\Program Files\\FluentReaderMCP", "program-files"], ["C:\\Program Files (x86)\\FluentReaderMCP", "program-files"], ["C:\\ProgramData\\FluentReaderMCP", "program-data"]] as const) {
            refused(facts(dir, { missing: 1 }), "protected-directory", { protectedKind: kind, relation: "inside" })
        }
    })

    test("shared, synchronised and configuration directories of Windows, Claude and Fluent Reader are refused", () => {
        const cases = [
            ["C:\\Users\\Public\\FluentReaderMCP", "public-profile"], [`${ROAMING}\\FluentReaderMCP`, "roaming-appdata"], [`${PROFILE}\\OneDrive\\FluentReaderMCP`, "onedrive"],
            [`${PROFILE}\\.claude\\FluentReaderMCP`, "claude-code-config"], [`${LOCAL}\\Claude-Data\\FluentReaderMCP`, "claude-desktop-data"], [`${LOCAL}\\Packages\\FluentReaderMCP`, "msix-packages"],
            [`${LOCAL}\\Temp\\FluentReaderMCP`, "temp"], ["D:\\Profili\\Fluent Reader\\FluentReaderMCP", "fluent-reader-profile"],
        ] as const
        for (const [dir, kind] of cases) refused(facts(dir, { missing: 1 }), "protected-directory", { protectedKind: kind })
        refused(facts("D:\\Profili", { content: { entries: ["Fluent Reader"], record: "absent" } }), "protected-directory", { protectedKind: "fluent-reader-profile", relation: "contains" })
    })

    test("the user profile, local AppData and the users directory themselves (or above) are refused; another user's profile too", () => {
        refused(facts(PROFILE), "protected-directory", { protectedKind: "user-profile", relation: "equal" })
        refused(facts(LOCAL), "protected-directory", { protectedKind: "local-appdata", relation: "equal" })
        refused(facts("C:\\Users"), "protected-directory")
        refused(facts("C:\\Users\\Other User\\FluentReaderMCP", { missing: 1 }), "other-user-profile")
    })

})

/** For each category, a destination inside (or equal to) one of its synthetic locations, and the expected refusal. */
const INSIDE: Readonly<Record<ProtectedKind, readonly [string, RefusalReason]>> = {
    windows: ["C:\\Windows\\FluentReaderMCP", "protected-directory"],
    "program-files": ["C:\\Program Files (x86)\\FluentReaderMCP", "protected-directory"],
    "program-data": ["C:\\ProgramData\\FluentReaderMCP", "protected-directory"],
    "users-root": ["C:\\Users\\Other User\\FluentReaderMCP", "other-user-profile"],
    "public-profile": ["C:\\Users\\Public\\FluentReaderMCP", "protected-directory"],
    "user-profile": [PROFILE, "protected-directory"],
    "local-appdata": [LOCAL, "protected-directory"],
    "roaming-appdata": [`${ROAMING}\\FluentReaderMCP`, "protected-directory"],
    temp: [`${LOCAL}\\Temp\\FluentReaderMCP`, "protected-directory"],
    onedrive: [`${PROFILE}\\OneDrive\\FluentReaderMCP`, "protected-directory"],
    "claude-code-config": [`${PROFILE}\\.claude\\FluentReaderMCP`, "protected-directory"],
    "claude-desktop-data": [`${LOCAL}\\Claude-3p\\FluentReaderMCP`, "protected-directory"],
    "msix-packages": [`${LOCAL}\\Packages\\FluentReaderMCP`, "protected-directory"],
    "fluent-reader-profile": ["D:\\Profili\\Fluent Reader\\FluentReaderMCP", "protected-directory"],
}
/** As a new leaf when the last segment is a FluentReaderMCP to be created, otherwise existing. */
const insideFacts = (dir: string, protectedDirectories: ProtectedDirectoryFacts = PROTECTED): LocationFacts =>
    facts(dir, { missing: dir.endsWith("\\FluentReaderMCP") ? 1 : 0, protectedDirectories })

describe("location: protected directories are never omissible (Major 1)", () => {
    test("Codex reproduction: %LOCALAPPDATA%\\Temp\\FluentReaderMCP with the temp category omitted was allowed; now refused", () => {
        const dir = `${LOCAL}\\Temp\\FluentReaderMCP`
        refused(insideFacts(dir, omitting("temp")), "incomplete-facts", { protectedKind: "temp", state: "unverifiable" })
        refused(insideFacts(dir), "protected-directory", { protectedKind: "temp", relation: "inside" })
    })

    test("every category, one at a time: resolved → refused inside it; omitted → incomplete; unreadable → incomplete", () => {
        for (const kind of PROTECTED_KINDS) {
            const [dir, reason] = INSIDE[kind]
            refused(insideFacts(dir), reason, reason === "protected-directory" ? { protectedKind: kind } : {})
            refused(insideFacts(dir, omitting(kind)), "incomplete-facts", { protectedKind: kind, state: "unverifiable" })
            refused(insideFacts(dir, replacing(kind, { status: "unreadable" })), "incomplete-facts", { protectedKind: kind })
            // an omission or an unreadable category refuses even an unrelated destination
            refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: omitting(kind) }), "incomplete-facts", { protectedKind: kind })
            refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing(kind, { status: "unreadable" }) }), "incomplete-facts", { protectedKind: kind })
        }
    })

    test("a location is protected even if the directory does not exist yet: .claude as a new leaf is refused", () => {
        refused(facts(`${PROFILE}\\.claude`, { missing: 1 }), "protected-directory", { protectedKind: "claude-code-config", relation: "equal" })
    })

    test("OneDrive: a verified absence (all three pieces of evidence) is accepted; partial evidence is contradictory", () => {
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing("onedrive", ONEDRIVE_ABSENT) })))
        for (const evidence of [
            { ...ONEDRIVE_ABSENT.evidence, knownFolderUnset: false }, { ...ONEDRIVE_ABSENT.evidence, environmentUnset: false }, { ...ONEDRIVE_ABSENT.evidence, noAccountUserFolder: "yes" },
            { kind: "onedrive-not-configured" }, { ...ONEDRIVE_ABSENT.evidence, kind: "assumed" }, { ...ONEDRIVE_ABSENT.evidence, extra: true },
        ]) {
            refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing("onedrive", { status: "verified-absent", evidence }) }), "malformed-facts")
        }
        refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing("onedrive", { status: "verified-absent" }) }), "malformed-facts")
    })

    test("no other category admits an absence: verified-absent there is contradictory, even with OneDrive's evidence", () => {
        for (const kind of PROTECTED_KINDS.filter((k) => k !== "onedrive")) {
            refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing(kind, ONEDRIVE_ABSENT) }), "malformed-facts")
        }
    })

    test("the profile not yet chosen: accepted as a fact only with its evidence (the verdict is provisional, see below)", () => {
        assert.equal(reasonOf(evaluateLocation(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing("fluent-reader-profile", PROFILE_NOT_SELECTED) }))), "provisional")
        refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing("fluent-reader-profile", { status: "not-applicable", evidence: { kind: "not-needed" } }) }), "malformed-facts")
        refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing("fluent-reader-profile", { status: "not-applicable" }) }), "malformed-facts")
        for (const kind of PROTECTED_KINDS.filter((k) => k !== "fluent-reader-profile")) {
            refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing(kind, PROFILE_NOT_SELECTED) }), "malformed-facts")
        }
    })

    test("duplicated, empty, contradictory or unknown entries are refused", () => {
        const cases: [string, ProtectedDirectoryFacts][] = [
            ["the same path twice", replacing("temp", resolved(`${LOCAL}\\Temp`, `${LOCAL}\\Temp`))],
            ["the same path twice, ASCII case variant", replacing("windows", resolved("C:\\Windows", "c:\\WINDOWS"))],
            ["no path", replacing("temp", resolved())],
            ["resolved with evidence", replacing("temp", { status: "resolved", paths: [`${LOCAL}\\Temp`], evidence: {} })],
            ["unreadable with paths", replacing("temp", { status: "unreadable", paths: [`${LOCAL}\\Temp`] })],
            ["unknown status", replacing("temp", { status: "assumed-absent" })],
            ["path not a string", replacing("temp", { status: "resolved", paths: [42] })],
            ["relative path", replacing("temp", resolved("Temp"))],
            ["UNC path (redirected folder)", replacing("roaming-appdata", resolved("\\\\server\\profiles\\Roaming"))],
            ["unknown category", replacing("games", resolved("C:\\Games"))],
            ["not an object", "C:\\Windows" as unknown as ProtectedDirectoryFacts],
        ]
        for (const [label, protectedDirectories] of cases) {
            const v = evaluateLocation(facts(APPS, { at: privateChain([1, 2]), protectedDirectories }))
            assert.equal(reasonOf(v), "malformed-facts", `${label}: ${JSON.stringify(v)}`)
        }
    })
})

describe("location: names compared without Windows' upcase table (Major 2)", () => {
    test("compareNames decides only what is provable", () => {
        const cases: [string, string, string][] = [
            ["Claude", "claude", "equal"], ["CLAUDE", "claude", "equal"], ["é", "é", "equal"], ["😀", "😀", "equal"],
            ["Claude", "ClaudeBackup", "different"], ["a", "b", "different"], ["é", "ée", "different"], ["Σa", "ςb", "different"],
            ["Σ", "ς", "uncertain"], ["σ", "ς", "uncertain"], ["é", "É", "uncertain"], ["ı", "I", "uncertain"], ["\u212a", "K", "uncertain"], ["ſ", "s", "uncertain"], ["😀", "😁", "uncertain"], ["é", "è", "uncertain"],
        ]
        for (const [a, b, expected] of cases) assert.equal(compareNames(a, b), expected, `${a} / ${b}`)
    })

    test("Codex reproduction: a protected directory ending in Σ and a destination with ς: refused, never allowed", () => {
        const protectedDirectories = replacing("fluent-reader-profile", resolved("D:\\Profili\\ArchivioΣ"))
        refused(facts("D:\\Profili\\Archivioς\\FluentReaderMCP", { missing: 1, at: privateChain([1, 2]), protectedDirectories }), "path-comparison-unverifiable", { protectedKind: "fluent-reader-profile" })
        refused(facts("D:\\Profili\\ArchivioΣ\\FluentReaderMCP", { missing: 1, at: privateChain([1, 2]), protectedDirectories }), "protected-directory", { protectedKind: "fluent-reader-profile", relation: "inside" })
    })

    test("ASCII case variants of a protected path are recognised", () => {
        refused(facts("C:\\WINDOWS\\FluentReaderMCP", { missing: 1 }), "protected-directory", { protectedKind: "windows" })
        refused(facts("C:\\Windows\\FluentReaderMCP", { missing: 1, requested: "c:\\windows\\fluentreadermcp" }), "protected-directory", { protectedKind: "windows" })
    })

    test("Unicode protected paths: the same code units are recognised, a non-ASCII case variant is uncertain (refused)", () => {
        allowed(evaluateLocation(facts(`${LOCAL}\\FluentReaderMCP`)))
        refused(facts("C:\\Users\\Test User É\\AppData\\Local\\FluentReaderMCP", { at: privateChain([3, 4, 5, 6]) }), "path-comparison-unverifiable", { protectedKind: "user-profile" })
    })

    test("Unicode in the destination and in its ancestors, with no uncertain comparison: accepted", () => {
        allowed(evaluateLocation(facts("D:\\Dati ŝ\\Ωmega 😀\\FluentReaderMCP", { at: privateChain([1, 2, 3]) })))
        allowed(evaluateLocation(facts("D:\\Dati ŝ\\Ωmega 😀\\FluentReaderMCP", { missing: 1, at: privateChain([1, 2]) })))
    })

    test("non-equivalent Unicode names: provably different (length, ASCII) accepted; not provable refused (provisional)", () => {
        const protectedDirectories = replacing("fluent-reader-profile", resolved("D:\\Profili\\Archivio è"))
        allowed(evaluateLocation(facts("D:\\Profili\\Archivio èè\\FluentReaderMCP", { missing: 1, at: privateChain([1, 2]), protectedDirectories })))
        allowed(evaluateLocation(facts("D:\\Profili\\Archivia è\\FluentReaderMCP", { missing: 1, at: privateChain([1, 2]), protectedDirectories })))
        refused(facts("D:\\Profili\\Archivio é\\FluentReaderMCP", { missing: 1, at: privateChain([1, 2]), protectedDirectories }), "path-comparison-unverifiable")
    })

    test("prefixes are compared segment by segment: Claude is not ClaudeBackup, Program Files is not Program Files (x86)", () => {
        const protectedDirectories = replacing("claude-code-config", resolved(`${PROFILE}\\.claude`, "D:\\Claude"))
        allowed(evaluateLocation(facts("D:\\ClaudeBackup\\FluentReaderMCP", { missing: 1, at: privateChain([1]), protectedDirectories })))
        allowed(evaluateLocation(facts("D:\\Clau\\FluentReaderMCP", { missing: 1, at: privateChain([1]), protectedDirectories })))
        refused(facts("D:\\Claude\\FluentReaderMCP", { missing: 1, at: privateChain([1]), protectedDirectories }), "protected-directory", { protectedKind: "claude-code-config" })
        refused(facts("D:\\Claude", { missing: 1, protectedDirectories }), "protected-directory", { relation: "equal" })
        allowed(evaluateLocation(facts("C:\\Program FilesX\\FluentReaderMCP", { missing: 1, at: privateChain([1]) })))
        allowed(evaluateLocation(facts("D:\\Profili\\Fluent Reader Backup\\FluentReaderMCP", { missing: 1, at: privateChain([1, 2]) })))
    })

    test("components must be PROVEN equal to the canonical prefixes: a non-ASCII case variant in the facts is malformed", () => {
        const f = facts("D:\\Dati é\\FluentReaderMCP", { at: privateChain([1, 2]) })
        const v = evaluateLocation({ ...f, components: f.components.map((c, i) => (i === 1 ? { ...c, path: "D:\\Dati É" } : c)) })
        assert.equal(reasonOf(v), "malformed-facts", JSON.stringify(v))
    })
})

describe("location: links, reparse points and canonical form", () => {
    test("a junction or mount point on an ancestor, a symbolic link or a cloud placeholder as destination are refused", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { reparseTag: 0xa0000003 } }) }), "reparse-point", { component: { role: "ancestor", depth: 1 } })
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { reparseTag: 0xa000000c } }) }), "reparse-point", { component: { role: "destination", depth: 2 } })
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { reparseTag: 0x9000001a } }) }), "reparse-point")
    })

    test("a chosen path whose final path differs (link on the way, SUBST, 8.3 name) is refused", () => {
        refused(facts(APPS, { at: privateChain([1, 2]), requested: "D:\\Link\\FluentReaderMCP" }), "path-not-canonical")
        refused(facts(`${LOCAL}\\FluentReaderMCP`, { requested: "C:\\Users\\TESTUS~1\\AppData\\Local\\FluentReaderMCP" }), "path-not-canonical")
        refused(facts(APPS, { at: privateChain([1, 2]), requested: "E:\\Apps\\FluentReaderMCP" }), "path-not-canonical")
    })

    test("a component that is not a directory is refused", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { isDirectory: false } }) }), "not-a-directory", { component: { role: "ancestor", depth: 1 } })
    })

    test("relative, UNC, device, drive-relative and ambiguous forms are refused; a volume root is refused", () => {
        for (const requested of ["relative\\dir", "\\\\server\\share\\FluentReaderMCP", "\\\\?\\D:\\FluentReaderMCP", "\\\\.\\D:\\FluentReaderMCP", "D:FluentReaderMCP", "D:\\Apps\\..\\FluentReaderMCP", "D:\\Apps\\.\\FluentReaderMCP", "D:\\NUL\\FluentReaderMCP", "D:\\COM1.txt\\x", "D:\\trailing.\\x", "D:\\space \\x", "D:\\a\"b", "D:\\a|b", "D:\\a:stream", "D:\\Apps\\\\FluentReaderMCP", "", "D:\\a\0b"]) {
            refused(facts(APPS, { at: privateChain([1, 2]), requested }), "invalid-path-form")
        }
        refused(facts("D:\\", { requested: "D:\\" }), "volume-root")
    })

    test("a path too long for the deepest installed file is refused", () => {
        refused(facts(APPS, { at: privateChain([1, 2]), maxRelative: DEFAULT_LOCATION_POLICY.maxPath - APPS.length }), "path-too-long")
        allowed(evaluateLocation(facts(APPS, { at: privateChain([1, 2]), maxRelative: DEFAULT_LOCATION_POLICY.maxPath - APPS.length - 1 })))
    })
})

describe("location: existing destination or new leaf", () => {
    test("a new leaf under a verified parent is eligible ONLY for protected creation, with the explicit descriptor", () => {
        for (const [dir, depths] of [["D:\\FluentReaderMCP", []], [APPS, [1]], [`${LOCAL}\\FluentReaderMCP`, []]] as const) {
            const v = evaluateLocation(facts(dir, { missing: 1, at: privateChain([...depths]) }))
            allowed(v)
            assert.equal(v.state, "new-leaf")
            if (v.state !== "new-leaf") return
            assert.equal(v.requiresProtectedCreation, true)
            assert.equal(v.leafName, "FluentReaderMCP")
            const parent = dir.slice(0, dir.lastIndexOf("\\"))
            assert.equal(v.parentPath, parent.length === 2 ? `${parent}\\` : parent)
            assert.equal(v.securityDescriptor, `D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`)
            assert.ok(!("content" in v), "a leaf that does not exist has no verified content")
        }
    })

    test("a new leaf under a parent others can modify is refused (the parent could be renamed or replaced)", () => {
        refused(facts(APPS, { missing: 1 }), "untrusted-access", { component: { role: "parent", depth: 1 }, state: "new-leaf" })
    })

    test("more than one missing component: refused, only the leaf may be created", () => {
        refused(facts(APPS, { missing: 2 }), "missing-ancestors", { state: "unverifiable" })
        refused(facts("D:\\A\\B\\C\\FluentReaderMCP", { missing: 3 }), "missing-ancestors")
    })

    test("a directory inside an existing installation is refused", () => {
        refused(facts(`${APPS}\\inner`, { at: privateChain([1, 2, 3], { 2: { installRecord: "present" } }) }), "nested-installation", { component: { role: "ancestor", depth: 2 } })
        refused(facts(`${APPS}\\inner`, { missing: 1, at: privateChain([1, 2], { 2: { installRecord: "present" } }) }), "nested-installation", { component: { role: "parent", depth: 2 } })
    })

    test("Major 3: product-like names without a record prove no ownership: refused", () => {
        const at = privateChain([1, 2])
        for (const entries of [["current"], ["current", "state"], [".staging"], ["current", "state", "uninstall.exe"], ["current", ".staging", "previous", "state", "uninstall.exe"], ["STATE"], ["uninstall.exe"]]) {
            refused(facts(APPS, { at, content: { entries, record: "absent" } }), "foreign-content", { component: { role: "destination", depth: 2 } })
        }
        // a name that is only UNCERTAINLY the record's (non-ASCII look-alike) is not a record either: it is an ambiguity
        refused(facts(APPS, { at, content: { entries: ["fluent-reader-mcp.ınstall.json"], record: "absent" } }), "ambiguous-install-record")
    })

    test("existing content: empty and an installation of this directory accepted; anything else refused", () => {
        const at = privateChain([1, 2])
        const empty = evaluateLocation(facts(APPS, { at }))
        allowed(empty)
        assert.equal(empty.state === "existing" && empty.content, "empty")
        const installed = evaluateLocation(facts(APPS, { at: privateChain([1, 2], { 2: { installRecord: "present" } }), content: { entries: [RECORD_NAME.toUpperCase(), "current", "state", "uninstall.exe"], record: "this-directory" } }))
        allowed(installed)
        assert.equal(installed.state === "existing" && installed.content, "installation")
        refused(facts(APPS, { at, content: { entries: ["notes.txt"], record: "absent" } }), "foreign-content")
        refused(facts(APPS, { at, content: { entries: ["current", "app.exe"], record: "absent" } }), "foreign-content")
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { installRecord: "present" } }), content: { entries: [RECORD_NAME], record: "other-directory" } }), "foreign-installation-record")
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { installRecord: "present" } }), content: { entries: [RECORD_NAME], record: "unreadable" } }), "installation-record-unreadable")
    })
})

describe("location: malformed or incomplete facts are refused, never allowed", () => {
    const base = (): LocationFacts => facts(APPS, { at: privateChain([1, 2]) })
    const withAce = (ace: unknown): LocationFacts => facts(APPS, { at: privateChain([1, 2], { 2: { dacl: present([...PRIVATE, ace as AceFacts]) } }) })

    test("the valid baseline is accepted", () => {
        allowed(evaluateLocation(base()))
    })

    test("structural problems: malformed-facts, state unverifiable, and evaluateLocation never throws", () => {
        const cases: [string, unknown][] = [
            ["null", null], ["empty object", {}], ["array", []],
            ["no components", { ...base(), components: [] }],
            ["components not an array", { ...base(), components: "x" }],
            ["missing dacl", { ...base(), components: base().components.map((c, i) => (i === 2 ? { ...c, dacl: undefined } : c)) }],
            ["dacl kind unknown", { ...base(), components: base().components.map((c, i) => (i === 2 ? { ...c, dacl: { kind: "empty" } } : c)) }],
            ["negative reparse tag", { ...base(), components: base().components.map((c, i) => (i === 2 ? { ...c, reparseTag: -1 } : c)) }],
            ["one component too few", { ...base(), components: base().components.slice(0, 2) }],
            ["component path of another directory", { ...base(), components: base().components.map((c, i) => (i === 1 ? { ...c, path: "D:\\Other" } : c)) }],
            ["missing segment that is not the leaf", { ...facts(APPS, { missing: 1, at: privateChain([1]) }), missingSegments: ["Other"] }],
            ["volume root of another drive", { ...base(), volume: { ...base().volume, rootPath: "C:\\" } }],
            ["drive type not known", { ...base(), volume: { ...base().volume, driveType: "virtual" } }],
            ["user SID of a group", { ...base(), currentUserSid: AU }],
            ["user SID malformed", { ...base(), currentUserSid: "S-1-5-21-x" }],
            ["SYSTEM as the current user", { ...base(), currentUserSid: SYSTEM }],
            ["owner SID malformed", facts(APPS, { at: privateChain([1, 2], { 2: { owner: "Administrators" } }) })],
            ["ACE SID malformed", withAce({ aceType: 0, aceFlags: 0, accessMask: 1, sid: "S-1-5-32-4294967296" })],
            ["ACE mask NaN", withAce({ aceType: 0, aceFlags: 0, accessMask: Number.NaN, sid: AU })],
            ["ACE mask negative", withAce({ aceType: 0, aceFlags: 0, accessMask: -1, sid: AU })],
            ["ACE mask above 32 bits", withAce({ aceType: 0, aceFlags: 0, accessMask: 2 ** 32, sid: AU })],
            ["ACE type as a string", withAce({ aceType: "0", aceFlags: 0, accessMask: 1, sid: AU })],
            ["content for a missing destination", { ...facts(APPS, { missing: 1, at: privateChain([1]) }), destinationContent: EMPTY }],
            ["no content for an existing destination", { ...base(), destinationContent: null }],
            ["record entry without a record", facts(APPS, { at: privateChain([1, 2]), content: { entries: [RECORD_NAME], record: "absent" } })],
            ["record without its entry", facts(APPS, { at: privateChain([1, 2], { 2: { installRecord: "present" } }), content: { entries: [], record: "this-directory" } })],
            ["protected directory path invalid", { ...base(), protectedDirectories: replacing("temp", resolved("relative")) }],
            ["protected directory kind unknown", { ...base(), protectedDirectories: replacing("games", resolved("C:\\Games")) }],
            ["protected directories as the old list", { ...base(), protectedDirectories: [{ kind: "windows", path: "C:\\Windows" }] }],
            ["installRecord as a boolean", { ...base(), components: base().components.map((c) => ({ ...c, installRecord: false })) }],
            ["installRecord unknown", { ...base(), components: base().components.map((c) => ({ ...c, installRecord: "maybe" })) }],
            ["maxRelative missing", (({ maxRelative: _omit, ...rest }) => rest)(base())],
            ["maxRelative zero", { ...base(), maxRelative: 0 }],
            ["maxRelative negative", { ...base(), maxRelative: -1 }],
            ["maxRelative not an integer", { ...base(), maxRelative: 1.5 }],
            ["maxRelative NaN", { ...base(), maxRelative: Number.NaN }],
            ["maxRelative as a string", { ...base(), maxRelative: "120" }],
            ["maxRelative as large as MAX_PATH (contradictory)", { ...base(), maxRelative: DEFAULT_LOCATION_POLICY.maxPath }],
            ["canonical path invalid", { ...base(), canonicalPath: "\\\\server\\share\\x" }],
        ]
        for (const [label, f] of cases) {
            const v = evaluateLocation(f as LocationFacts)
            assert.equal(v.allowed, false, label)
            assert.equal(reasonOf(v), "malformed-facts", `${label}: ${JSON.stringify(v)}`)
            assert.equal(v.state, "unverifiable", label)
        }
        const hostile = base() as unknown as Record<string, unknown>
        Object.defineProperty(hostile, "components", { get: () => { throw new Error("native layer failure") } })
        assert.deepEqual(evaluateLocation(hostile as unknown as LocationFacts), { allowed: false, state: "unverifiable", reason: "malformed-facts" })
    })

    test("owner or DACL that could not be read: acl-unverifiable, state unverifiable", () => {
        refused(facts(APPS, { at: privateChain([1, 2], { 1: { owner: null } }) }), "acl-unverifiable", { state: "unverifiable", component: { role: "ancestor", depth: 1 } })
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { dacl: { kind: "unreadable" } } }) }), "acl-unverifiable", { state: "unverifiable" })
    })

    test("every ACE type other than allow/deny (object, callback, audit, label…) is refused", () => {
        for (let aceType = 2; aceType <= 0xff; aceType++) {
            refused(withAce({ aceType, aceFlags: 0, accessMask: ACCESS.READ_CONTROL, sid: SYSTEM }), "unsupported-ace")
        }
    })

    test("every unknown ACE flag (audit flags included) is refused, even on a trusted principal", () => {
        for (const flag of [0x20, 0x40, 0x80]) refused(withAce({ aceType: 0, aceFlags: OICI | flag, accessMask: ACCESS.READ_CONTROL, sid: SYSTEM }), "unsupported-ace")
    })

    test("every access bit outside the documented ones is refused, even on a trusted principal", () => {
        const known = Object.values(ACCESS).reduce((a, b) => (a | b) >>> 0, 0)
        let unknownBits = 0
        for (let bit = 0; bit < 32; bit++) {
            const mask = 2 ** bit
            if (((known & mask) >>> 0) !== 0) continue
            unknownBits++
            refused(withAce({ aceType: 0, aceFlags: 0, accessMask: mask, sid: SYSTEM }), "unsupported-ace")
        }
        assert.ok(unknownBits >= 10)
    })

    test("random ACEs on random components: whenever the verdict is allowed, no untrusted principal holds a dangerous right", () => {
        const WRITE = (ACCESS.FILE_ADD_FILE | ACCESS.FILE_ADD_SUBDIRECTORY | ACCESS.FILE_WRITE_EA | ACCESS.FILE_DELETE_CHILD | ACCESS.FILE_WRITE_ATTRIBUTES | ACCESS.DELETE | ACCESS.WRITE_DAC | ACCESS.WRITE_OWNER | ACCESS.ACCESS_SYSTEM_SECURITY | ACCESS.MAXIMUM_ALLOWED | ACCESS.GENERIC_ALL | ACCESS.GENERIC_WRITE) >>> 0
        const READ = (ACCESS.FILE_LIST_DIRECTORY | ACCESS.FILE_READ_EA | ACCESS.MAXIMUM_ALLOWED | ACCESS.GENERIC_ALL | ACCESS.GENERIC_READ) >>> 0
        const trusted = new Set([USER, SYSTEM, ADMINS, TRUSTED_INSTALLER, CREATOR_OWNER, OWNER_RIGHTS])
        const pool = [USER, SYSTEM, ADMINS, TRUSTED_INSTALLER, CREATOR_OWNER, OWNER_RIGHTS, CREATOR_GROUP, EVERYONE, AU, USERS, OTHER_USER, DOMAIN_USERS, DOMAIN_ADMINS, UNKNOWN_SID]
        const masks = [RX, MODIFY, FA, AD, ACCESS.FILE_ADD_FILE, ACCESS.DELETE, ACCESS.FILE_DELETE_CHILD, ACCESS.WRITE_DAC, ACCESS.GENERIC_READ, ACCESS.GENERIC_WRITE, ACCESS.GENERIC_ALL, ACCESS.READ_CONTROL, ACCESS.FILE_TRAVERSE, 0x200, 0]
        let seed = 0x5eed
        const next = (n: number): number => {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
            return (seed >>> 8) % n
        }
        let accepted = 0
        let rejected = 0
        let provisional = 0
        for (let i = 0; i < 3000; i++) {
            const depth = next(3)
            const ace: AceFacts = { aceType: next(4), aceFlags: next(4) === 0 ? next(256) : [0, OICI, OICI | IO, OICI | INH, ACE_FLAG.CONTAINER_INHERIT][next(5)] as number, accessMask: ((masks[next(masks.length)] as number) | (next(6) === 0 ? (masks[next(masks.length)] as number) : 0)) >>> 0, sid: pool[next(pool.length)] as string }
            // one in four: the profile is still to be chosen, so the best possible verdict is provisional
            const notSelected = i % 4 === 0
            const f = facts(APPS, { at: privateChain([1, 2], { [depth]: { dacl: present([...(depth === 0 ? NTFS_ROOT : PRIVATE), ace]) } }), ...(notSelected ? { protectedDirectories: replacing("fluent-reader-profile", PROFILE_NOT_SELECTED) } : {}) })
            const v = evaluateLocation(f)
            if (v.allowed) {
                assert.deepEqual(v.pendingChecks, [], "allowed with a pending check")
                assert.ok(!notSelected, "allowed while the profile is still to be chosen")
                accepted++
            } else if (v.state === "provisional") {
                assert.ok(notSelected && v.pendingChecks.length > 0, "provisional without a pending check")
                provisional++
            } else {
                rejected++
                continue
            }
            const role = depth === 0 ? "volume-root" : depth === 2 ? "destination" : "ancestor"
            assert.ok(ace.aceType === 0 || ace.aceType === 1, `type ${ace.aceType} allowed`)
            assert.equal(ace.aceFlags & ~0x1f, 0, "unknown flags allowed")
            if (role === "destination") assert.equal(ace.aceType, 0, "deny on the destination allowed")
            if (ace.aceType === 0 && !trusted.has(ace.sid) && (role === "destination" || (ace.aceFlags & IO) === 0)) {
                const tolerated = role === "volume-root" ? DEFAULT_LOCATION_POLICY.volumeRootTolerance : 0
                assert.equal((ace.accessMask & WRITE & ~tolerated) >>> 0, 0, `untrusted write allowed: ${JSON.stringify({ ace, role })}`)
                if (role === "destination") assert.equal((ace.accessMask & READ) >>> 0, 0, `untrusted read allowed: ${JSON.stringify(ace)}`)
            }
        }
        assert.ok(accepted > 100 && rejected > 100 && provisional > 20, `${accepted} accepted, ${provisional} provisional, ${rejected} refused`)
    })
})

describe("location: contract", () => {
    test("every refusal reason has an Italian message without paths, SIDs or personal data", () => {
        for (const reason of REFUSAL_REASONS) {
            const message = describeRefusal({ allowed: false, state: "existing", reason, component: { role: "ancestor", depth: 2 }, principal: "other-principal", right: "delete" })
            assert.ok(message.length > 20, reason)
            assert.doesNotMatch(message, /S-1-\d|[A-Za-z]:\\[\p{L}\p{N}]|Test User/u, reason)
        }
        const r = refused(facts(APPS, { at: privateChain([1, 2], { 2: { owner: OTHER_USER } }) }), "untrusted-owner")
        assert.doesNotMatch(JSON.stringify(r), /S-1-\d|Apps|FluentReaderMCP/, "a refusal carries no path or SID")
    })

    test("the record name is the installer's (record.ts); no layout name is exported as a proof of ownership", () => {
        assert.equal(INSTALL_RECORD_NAME, RECORD_NAME)
        assert.ok(!("PRODUCT_ENTRIES" in location))
    })

    test("pure module: no import at all (no file system, process, registry or native API)", () => {
        const compiled = fs.readFileSync(path.join(COMPILED_ROOT, "installer", "setup", "location.js"), "utf8")
        assert.doesNotMatch(compiled, /^\s*import\s|\bimport\(|\brequire\(/m)
    })

    test("preparatory only: the installer's setup helper does not use it yet", () => {
        assert.ok(!setupClosure(COMPILED_ROOT).some((f) => f.endsWith("location.js")), "location.js is not in the helper's closure")
        for (const file of ["checks.js", "fr-setup.js", "transaction.js", "uninstall.js", "claude.js", "record.js", "app.js"]) {
            assert.doesNotMatch(fs.readFileSync(path.join(COMPILED_ROOT, "installer", "setup", file), "utf8"), /location\.js/, file)
        }
    })
})

describe("location: length budget (Minor)", () => {
    test("the total length and every single component are bounded; the budget can neither be omitted nor contradict MAX_PATH", () => {
        const long = (n: number): string => `D:\\${"a".repeat(n)}\\FluentReaderMCP`
        refused(facts(`D:\\${"b".repeat(256)}\\FluentReaderMCP`, { missing: 1, maxRelative: 1 }), "component-too-long")
        allowed(evaluateLocation(facts(long(200), { at: privateChain([1, 2]), maxRelative: 30 })))
        refused(facts(long(200), { at: privateChain([1, 2]), maxRelative: 40 }), "path-too-long")
        refused(facts(long(200), { at: privateChain([1, 2]), maxRelative: 30 }), "component-too-long", {}, { ...DEFAULT_LOCATION_POLICY, maxComponentLength: 100 })
        // the leaf counts too
        refused(facts(`D:\\${"c".repeat(256)}`, { missing: 1, maxRelative: 1 }), "component-too-long")
    })

    test("a policy that would disable or loosen a protection is refused", () => {
        const f = facts(APPS, { at: privateChain([1, 2]) })
        const bad: [string, unknown][] = [
            ["maxPath beyond MAX_PATH (extended paths)", { ...DEFAULT_LOCATION_POLICY, maxPath: 260 }],
            ["maxPath 32767", { ...DEFAULT_LOCATION_POLICY, maxPath: 32767 }],
            ["maxPath missing", { ...DEFAULT_LOCATION_POLICY, maxPath: undefined }],
            ["maxComponentLength 0", { ...DEFAULT_LOCATION_POLICY, maxComponentLength: 0 }],
            ["maxComponentLength 256", { ...DEFAULT_LOCATION_POLICY, maxComponentLength: 256 }],
            ["root tolerance with DELETE_CHILD", { ...DEFAULT_LOCATION_POLICY, volumeRootTolerance: ACCESS.FILE_ADD_SUBDIRECTORY | ACCESS.FILE_DELETE_CHILD }],
            ["no file system", { ...DEFAULT_LOCATION_POLICY, allowedFileSystems: [] }],
            ["file system not upper-case ASCII", { ...DEFAULT_LOCATION_POLICY, allowedFileSystems: ["ntfs"] }],
            ["privateDestination not a boolean", { ...DEFAULT_LOCATION_POLICY, privateDestination: "no" }],
            ["null", null],
        ]
        for (const [label, policy] of bad) {
            const v = evaluateLocation(f, policy as LocationPolicy)
            assert.equal(reasonOf(v), "invalid-policy", `${label}: ${JSON.stringify(v)}`)
        }
        allowed(evaluateLocation(f, { ...DEFAULT_LOCATION_POLICY, maxPath: 200 }))
    })

    test("the file system name is folded as ASCII only (\"ntfſ\" is not NTFS)", () => {
        refused(facts(APPS, { at: privateChain([1, 2]), volume: { fileSystem: "ntfſ" } }), "unsupported-file-system")
    })
})

describe("location: SDDL of the new leaf (Minor)", () => {
    test("the descriptor helper is not exported; a verdict carries it only for a validated user SID", () => {
        assert.ok(!("protectedLeafDescriptor" in location), "no direct way to build a descriptor from an arbitrary string")
        const v = evaluateLocation(facts("D:\\FluentReaderMCP", { missing: 1 }))
        allowed(v)
        assert.match(v.state === "new-leaf" ? v.securityDescriptor : "", /^D:P\(A;OICI;FA;;;S-1-5-21(-\d+){4}\)\(A;OICI;FA;;;SY\)\(A;OICI;FA;;;BA\)$/)
        for (const sid of [`${USER})(A;OICI;FA;;;WD`, `${USER};`, "S-1-5-21-1-2-3-4-5", "WD", "BA", `${USER}\n`]) {
            const r = evaluateLocation({ ...facts("D:\\FluentReaderMCP", { missing: 1 }), currentUserSid: sid })
            assert.equal(reasonOf(r), "malformed-facts", sid)
            assert.ok(!JSON.stringify(r).includes("WD"), "no descriptor in a refusal")
        }
    })
})

describe("location: installation record lookup, three states (Minor)", () => {
    test("an unreadable record lookup is never an absence: refused on an ancestor, the parent and the destination", () => {
        refused(facts(`${APPS}\\inner`, { at: privateChain([1, 2, 3], { 2: { installRecord: "unreadable" } }) }), "install-record-unverifiable", { component: { role: "ancestor", depth: 2 }, state: "unverifiable" })
        refused(facts(`${APPS}\\inner`, { missing: 1, at: privateChain([1, 2], { 2: { installRecord: "unreadable" } }) }), "install-record-unverifiable", { component: { role: "parent", depth: 2 } })
        refused(facts(APPS, { at: privateChain([1, 2], { 0: { installRecord: "unreadable" } }) }), "install-record-unverifiable", { component: { role: "volume-root", depth: 0 } })
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { installRecord: "unreadable" } }) }), "install-record-unverifiable", { component: { role: "destination", depth: 2 } })
    })

    test("present on an ancestor: nested installation; verified absent everywhere: accepted", () => {
        refused(facts(`${APPS}\\inner`, { at: privateChain([1, 2, 3], { 1: { installRecord: "present" } }) }), "nested-installation", { component: { role: "ancestor", depth: 1 } })
        allowed(evaluateLocation(facts(`${APPS}\\inner`, { at: privateChain([1, 2, 3]) })))
    })
})

describe("location: a pending check is never an authorisation (residual Major 1)", () => {
    const notSelected = replacing("fluent-reader-profile", PROFILE_NOT_SELECTED)

    test("Codex reproduction: safe existing empty directory, profile not chosen: provisional, allowed false", () => {
        const v = evaluateLocation(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: notSelected }))
        assert.deepEqual(v, { allowed: false, state: "provisional", eligibleAs: "existing", canonicalPath: APPS, pendingChecks: ["fluent-reader-profile-overlap"] })
        assert.ok(!v.allowed, "if (verdict.allowed) cannot authorise it")
    })

    test("eligible new leaf, profile not chosen: provisional, and no descriptor to create the leaf with", () => {
        const v = evaluateLocation(facts(APPS, { missing: 1, at: privateChain([1]), protectedDirectories: notSelected }))
        assert.deepEqual(v, { allowed: false, state: "provisional", eligibleAs: "new-leaf", canonicalPath: APPS, pendingChecks: ["fluent-reader-profile-overlap"] })
        assert.ok(!("securityDescriptor" in v) && !("requiresProtectedCreation" in v))
    })

    test("re-evaluation with the chosen profile: allowed (existing or new leaf) only if it does not overlap; overlap refused", () => {
        const chosen = (profile: string): ProtectedDirectoryFacts => replacing("fluent-reader-profile", resolved(profile))
        const existing = evaluateLocation(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: chosen("D:\\Profili\\Fluent Reader") }))
        allowed(existing)
        assert.equal(existing.state, "existing")
        assert.deepEqual(existing.pendingChecks, [])
        const leaf = evaluateLocation(facts(APPS, { missing: 1, at: privateChain([1]), protectedDirectories: chosen("D:\\Profili\\Fluent Reader") }))
        allowed(leaf)
        assert.equal(leaf.state === "new-leaf" && leaf.requiresProtectedCreation, true, "a new leaf still requires the protected creation")
        refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: chosen(`${APPS}\\Profilo`) }), "protected-directory", { protectedKind: "fluent-reader-profile", relation: "contains" })
        refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: chosen(APPS) }), "protected-directory", { protectedKind: "fluent-reader-profile", relation: "equal" })
        refused(facts(`${APPS}\\Dentro`, { missing: 1, at: privateChain([1, 2]), protectedDirectories: chosen(APPS) }), "protected-directory", { protectedKind: "fluent-reader-profile", relation: "inside" })
    })

    test("an unreadable profile stays a refusal, never provisional; a provisional verdict needs every other check passed", () => {
        refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing("fluent-reader-profile", { status: "unreadable" }) }), "incomplete-facts", { protectedKind: "fluent-reader-profile" })
        refused(facts(APPS, { protectedDirectories: notSelected }), "untrusted-access")
        refused(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: notSelected, content: { entries: ["current"], record: "absent" } }), "foreign-content")
        refused(facts(`${LOCAL}\\Temp\\FluentReaderMCP`, { missing: 1, protectedDirectories: replacing("fluent-reader-profile", PROFILE_NOT_SELECTED) }), "protected-directory", { protectedKind: "temp" })
    })

    test("type contract: an authorising verdict cannot carry a pending check, a provisional one is never allowed; narrowing", () => {
        // @ts-expect-error pendingChecks of an allowed verdict is the empty tuple
        const withPending: ExistingDestination = { allowed: true, state: "existing", canonicalPath: APPS, content: "empty", pendingChecks: ["fluent-reader-profile-overlap"] }
        // @ts-expect-error a provisional verdict is never allowed
        const allowedProvisional: ProvisionalDestination = { allowed: true, state: "provisional", eligibleAs: "existing", canonicalPath: APPS, pendingChecks: ["fluent-reader-profile-overlap"] }
        // @ts-expect-error a provisional verdict always names what is pending
        const nothingPending: ProvisionalDestination = { allowed: false, state: "provisional", eligibleAs: "new-leaf", canonicalPath: APPS, pendingChecks: [] }
        void [withPending, allowedProvisional, nothingPending]
        const summary = (v: LocationVerdict): string => {
            if (v.allowed) {
                const none: readonly [] = v.pendingChecks
                return `${v.state}:${none.length}`
            }
            if (v.state === "provisional") return `provisional:${v.eligibleAs}:${v.pendingChecks[0]}`
            return v.reason
        }
        assert.equal(summary(evaluateLocation(facts(APPS, { at: privateChain([1, 2]) }))), "existing:0")
        assert.equal(summary(evaluateLocation(facts(APPS, { missing: 1, at: privateChain([1]) }))), "new-leaf:0")
        assert.equal(summary(evaluateLocation(facts(APPS, { at: privateChain([1, 2]), protectedDirectories: notSelected }))), "provisional:existing:fluent-reader-profile-overlap")
        assert.equal(summary(evaluateLocation(facts(APPS))), "untrusted-access")
    })
})

describe("location: exactly one installation record (residual Major 2)", () => {
    const at = privateChain([1, 2], { 2: { installRecord: "present" } })
    const installation = (entries: string[], record: DestinationContent["record"] = "this-directory"): LocationFacts => facts(APPS, { at, content: { entries, record } })

    test("Codex reproduction: the record twice in two letter cases, lookup present, record of this directory: refused", () => {
        refused(installation(["fluent-reader-mcp.install.json", "FLUENT-READER-MCP.INSTALL.JSON", "current"]), "ambiguous-install-record", { component: { role: "destination", depth: 2 } })
    })

    test("one record with the exact name, or one ASCII case variant (case-insensitive lookup, as Windows does by default): accepted", () => {
        for (const name of [INSTALL_RECORD_NAME, "FLUENT-READER-MCP.INSTALL.JSON", "Fluent-Reader-MCP.Install.json"]) {
            const v = evaluateLocation(installation([name, "current", "state", "uninstall.exe"]))
            allowed(v)
            assert.equal(v.state === "existing" && v.content, "installation", name)
        }
    })

    test("two, three or more provably equivalent names: refused, whatever the lookup and the record say", () => {
        refused(installation([INSTALL_RECORD_NAME, "Fluent-Reader-MCP.Install.json"]), "ambiguous-install-record")
        refused(installation([INSTALL_RECORD_NAME, "FLUENT-READER-MCP.INSTALL.JSON", "Fluent-Reader-MCP.Install.JSON", "current"]), "ambiguous-install-record")
        refused(facts(APPS, { at: privateChain([1, 2]), content: { entries: [INSTALL_RECORD_NAME, "FLUENT-READER-MCP.INSTALL.JSON"], record: "absent" } }), "ambiguous-install-record")
    })

    test("the exact record next to an uncertain look-alike (dotless ı, long ſ): refused", () => {
        refused(installation([INSTALL_RECORD_NAME, "fluent-reader-mcp.ınstall.json"]), "ambiguous-install-record")
        refused(installation([INSTALL_RECORD_NAME, "fluent-reader-mcp.in\u017Ftall.json"]), "ambiguous-install-record")
    })

    test("unchanged boundaries: unreadable record or lookup, another installation's record, empty, layout names only", () => {
        refused(installation([INSTALL_RECORD_NAME, "current"], "unreadable"), "installation-record-unreadable")
        refused(facts(APPS, { at: privateChain([1, 2], { 2: { installRecord: "unreadable" } }), content: { entries: [INSTALL_RECORD_NAME], record: "this-directory" } }), "install-record-unverifiable")
        refused(installation([INSTALL_RECORD_NAME, "current"], "other-directory"), "foreign-installation-record")
        const empty = evaluateLocation(facts(APPS, { at: privateChain([1, 2]) }))
        allowed(empty)
        assert.equal(empty.state === "existing" && empty.content, "empty")
        refused(facts(APPS, { at: privateChain([1, 2]), content: { entries: ["current", ".staging", "previous", "state", "uninstall.exe"], record: "absent" } }), "foreign-content")
        refused(facts(APPS, { at: privateChain([1, 2]), content: { entries: ["notes.txt"], record: "absent" } }), "foreign-content")
    })
})

describe("location: uniqueness of protected locations (Minor)", () => {
    const withTemp = (...paths: string[]): LocationFacts => facts(APPS, { at: privateChain([1, 2]), protectedDirectories: replacing("temp", resolved(...paths)) })

    test("Σ / ς in two locations of one category: an ambiguity, refused (PROVISIONAL until CompareStringOrdinal in 03A2)", () => {
        refused(withTemp("C:\\TempΣ", "C:\\Tempς"), "path-comparison-unverifiable", { protectedKind: "temp", state: "unverifiable" })
        refused(withTemp("D:\\Dati é\\Temp", "D:\\Dati É\\Temp"), "path-comparison-unverifiable", { protectedKind: "temp" })
    })

    test("the same path twice, or an ASCII case variant of it: a duplicate, refused", () => {
        refused(withTemp(`${LOCAL}\\Temp`, `${LOCAL}\\Temp`), "malformed-facts", { protectedKind: "temp" })
        refused(withTemp(`${LOCAL}\\Temp`, "C:\\USERS\\TEST USER é\\APPDATA\\LOCAL\\TEMP"), "malformed-facts", { protectedKind: "temp" })
    })

    test("provably distinct locations are accepted: Unicode of other lengths or with an ASCII difference, similar prefixes, nesting, other drive", () => {
        for (const paths of [
            ["C:\\Tempé", "C:\\Tempée"], ["C:\\Ωa", "C:\\Ωb"], ["C:\\Temp", "C:\\TempX"], ["C:\\Temp", "C:\\Temp\\Sub"], ["C:\\Tempς", "D:\\TempΣ"], [`${LOCAL}\\Temp`, "C:\\Claude", "C:\\ClaudeBackup"],
        ]) {
            allowed(evaluateLocation(withTemp(...paths)))
        }
    })
})
