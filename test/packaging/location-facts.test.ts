/**
 * FR-MCP-04-BETA-03A2a: collection of LocationFacts on a SYNTHETIC machine.
 * The Win32SecurityApi is replaced by an in-memory tree (directories, links,
 * owners, DACLs, known folders, OneDrive accounts): no file system, ACL,
 * registry or profile of this machine is read, and no native code is loaded.
 * Every collection checks that each handle it opened was closed exactly once.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { setupClosure } from "../../installer/lib/installer-build.js"
import {
    collectLocationFacts, DEFAULT_COLLECTION_LIMITS, describeCollectionFailure, evaluateCollectedLocation,
    type CollectionLimits, type InstallRecordVerifier, type LocationCollection, type ProfileSelection,
} from "../../installer/setup/location-facts.js"
import { ACE_FLAG, ACCESS, FILE_ALL_ACCESS, PROTECTED_KINDS, WELL_KNOWN_SID, type AceFacts, type LocationFacts, type LocationVerdict, type RefusalReason } from "../../installer/setup/location.js"
import { RECORD_NAME } from "../../installer/setup/record.js"
import {
    ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_NOT_READY, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION, KNOWN_FOLDER, NativeReleaseError,
    type DaclReading, type DirectoryListing, type Handle, type KnownFolderId, type KnownFolderReading, type ListingLimits, type OneDriveAccountsReading, type SecurityReading, type VolumeInformation, type Win32Result, type Win32SecurityApi,
} from "../../installer/setup/win32-security.js"

const COMPILED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const REPO_ROOT = path.resolve(COMPILED_ROOT, "..")

// ------------------------------------------------------------------ synthetic principals and ACLs (as in location.test.ts)

const USER = "S-1-5-21-1111111111-2222222222-3333333333-1001"
const { SYSTEM, ADMINISTRATORS: ADMINS, TRUSTED_INSTALLER, AUTHENTICATED_USERS: AU, USERS, EVERYONE } = WELL_KNOWN_SID
const OICI = ACE_FLAG.OBJECT_INHERIT | ACE_FLAG.CONTAINER_INHERIT
const IO = ACE_FLAG.INHERIT_ONLY
const INH = ACE_FLAG.INHERITED
const FA = FILE_ALL_ACCESS
const MODIFY = 0x1301bf
const RX = 0x1200a9
const allow = (sid: string, mask: number, flags = 0): AceFacts => ({ aceType: 0, aceFlags: flags, accessMask: mask, sid })
const NTFS_ROOT = [allow(ADMINS, FA, OICI), allow(SYSTEM, FA, OICI), allow(AU, MODIFY, OICI | IO), allow(AU, ACCESS.FILE_ADD_SUBDIRECTORY), allow(USERS, RX, OICI)]
const SHARED_INHERITED = [allow(ADMINS, FA, OICI | INH), allow(SYSTEM, FA, OICI | INH), allow(AU, MODIFY, OICI | INH), allow(USERS, RX, OICI | INH)]
const USERS_DIR = [allow(SYSTEM, FA, OICI), allow(ADMINS, FA, OICI), allow(USERS, RX, OICI), allow(EVERYONE, RX, OICI)]
const PROFILE_ACL = [allow(SYSTEM, FA, OICI), allow(ADMINS, FA, OICI), allow(USER, FA, OICI)]
const PRIVATE_INHERITED = [allow(SYSTEM, FA, OICI | INH), allow(ADMINS, FA, OICI | INH), allow(USER, FA, OICI | INH)]
const PRIVATE = [allow(USER, FA, OICI), allow(SYSTEM, FA, OICI), allow(ADMINS, FA, OICI)]

const PROFILE = "C:\\Users\\Test User é"
const LOCAL = `${PROFILE}\\AppData\\Local`
const ROAMING = `${PROFILE}\\AppData\\Roaming`
const APPS = "D:\\Apps\\FluentReaderMCP"
const FR_PROFILE = "D:\\Profili\\Fluent Reader"
const SELECTED: ProfileSelection = { status: "selected", path: FR_PROFILE }

const up = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32))

// ------------------------------------------------------------------ the synthetic machine

interface NodeSpec {
    readonly kind?: "dir" | "file"
    readonly reparseTag?: number
    /** Followed by openProbe(follow): the true path of the target (missing → a dangling link). */
    readonly target?: string
    /** Error of opening THROUGH this entry when following fails (default ERROR_FILE_NOT_FOUND for a dangling link). */
    readonly followError?: number
    /** Error of the probe that does NOT follow this entry. */
    readonly probeError?: number
    /** The raw final path (default "\\?\" + its path); a function gets the number of earlier calls. */
    readonly final?: string | ((call: number) => string)
    readonly owner?: string | null
    readonly aces?: readonly AceFacts[]
    readonly dacl?: DaclReading
    /** true/false, or a Win32 error of the query. */
    readonly caseSensitive?: boolean | number
    readonly entries?: readonly string[]
    readonly listing?: DirectoryListing
    readonly openError?: number
    /** Error of the installation record lookup in this directory. */
    readonly recordError?: number
    readonly serial?: number
    readonly securityThrows?: unknown
}

interface VolumeSpec {
    readonly driveType: number
    readonly info: Win32Result<VolumeInformation>
}
const ntfs = (serial: number, overrides: Partial<VolumeInformation> = {}): Win32Result<VolumeInformation> => ({ ok: true, value: { fileSystemName: "NTFS", fileSystemFlags: 0x8 | 0x2 | 0x1, maximumComponentLength: 255, serialNumber: serial, ...overrides } })

function defaultSecurity(p: string): { owner: string; aces: readonly AceFacts[] } {
    const u = up(p)
    if (/^[A-Z]:\\$/.test(u)) return { owner: u.startsWith("C") ? TRUSTED_INSTALLER : ADMINS, aces: NTFS_ROOT }
    if (u === "C:\\USERS") return { owner: SYSTEM, aces: USERS_DIR }
    if (u === up(PROFILE)) return { owner: SYSTEM, aces: PROFILE_ACL }
    if (u.startsWith(`${up(PROFILE)}\\`)) return { owner: USER, aces: PRIVATE_INHERITED }
    return { owner: USER, aces: PRIVATE }
}

class Machine implements Win32SecurityApi {
    readonly nodes = new Map<string, { path: string; spec: NodeSpec; finalCalls: number }>()
    readonly aliases: [string, string][] = []
    readonly volumes: Record<string, VolumeSpec> = { "C:\\": { driveType: 3, info: ntfs(0xc) }, "D:\\": { driveType: 3, info: ntfs(0xd) } }
    knownFolders: Partial<Record<KnownFolderId, KnownFolderReading>> = {}
    accounts: OneDriveAccountsReading = { kind: "no-accounts-key" }
    user: Win32Result<string> = { ok: true, value: USER }
    readonly handles = new Map<Handle, { path: string; spec: NodeSpec; node: { path: string; spec: NodeSpec; finalCalls: number } }>()
    readonly opened: string[] = []
    /** Every openProbe: [path, follow]. */
    readonly probes: [string, boolean][] = []
    opens = 0
    closes = 0
    closeError = 0
    #next = 1n

    add(p: string, spec: NodeSpec = {}): this {
        this.nodes.set(up(p), { path: p, spec, finalCalls: 0 })
        return this
    }
    set(p: string, spec: NodeSpec): this {
        const n = this.nodes.get(up(p))
        if (n === undefined) throw new Error(`no node ${p}`)
        this.nodes.set(up(p), { ...n, spec: { ...n.spec, ...spec } })
        return this
    }
    remove(p: string): this {
        this.nodes.delete(up(p))
        return this
    }
    alias(from: string, to: string): this {
        this.aliases.push([from, to])
        return this
    }
    #resolve(p: string): { path: string; spec: NodeSpec; finalCalls: number } | undefined {
        let q = p
        for (const [from, to] of this.aliases) if (up(q) === up(from) || up(q).startsWith(`${up(from)}\\`)) q = to + q.slice(from.length)
        return this.nodes.get(up(q))
    }
    #missing(p: string): number {
        const parent = p.slice(0, p.lastIndexOf("\\")) || p
        const node = this.#resolve(parent.length === 2 ? `${parent}\\` : parent)
        if (node === undefined || node.spec.kind === "file") return ERROR_PATH_NOT_FOUND
        // a path through a link whose target is missing cannot be walked
        if (node.spec.target !== undefined && this.#resolve(node.spec.target) === undefined) return ERROR_PATH_NOT_FOUND
        return ERROR_FILE_NOT_FOUND
    }
    #handle(node: { path: string; spec: NodeSpec; finalCalls: number }): Win32Result<Handle> {
        this.opens++
        const h = this.#next++
        this.handles.set(h, { path: node.path, spec: node.spec, node })
        return { ok: true, value: h }
    }
    #h(h: Handle) {
        const x = this.handles.get(h)
        if (x === undefined) throw new Error("use of a closed handle")
        return x
    }

    driveType(root: string): number {
        return this.volumes[root]?.driveType ?? 1
    }
    volumeInformation(root: string): Win32Result<VolumeInformation> {
        return this.volumes[root]?.info ?? { ok: false, error: ERROR_NOT_READY }
    }
    openComponent(p: string): Win32Result<Handle> {
        this.opened.push(p)
        const node = this.#resolve(p)
        if (node === undefined) return { ok: false, error: this.#missing(p) }
        if (node.spec.openError !== undefined) return { ok: false, error: node.spec.openError }
        return this.#handle(node)
    }
    openProbe(p: string, follow: boolean): Win32Result<Handle> {
        this.probes.push([p, follow])
        const node = this.#resolve(p)
        if (node === undefined) return { ok: false, error: this.#missing(p) }
        if (!follow && node.spec.probeError !== undefined) return { ok: false, error: node.spec.probeError }
        if (node.spec.openError !== undefined) return { ok: false, error: node.spec.openError }
        if (follow && node.spec.target !== undefined) {
            const target = this.#resolve(node.spec.target)
            return target === undefined ? { ok: false, error: node.spec.followError ?? ERROR_FILE_NOT_FOUND } : this.#handle(target)
        }
        // an entry that exists but cannot be reached by following it (it changed between two calls)
        if (follow && node.spec.followError !== undefined) return { ok: false, error: node.spec.followError }
        return this.#handle(node)
    }
    close(h: Handle): number {
        if (!this.handles.delete(h)) throw new Error("double close")
        this.closes++
        return this.closeError
    }
    attributes(h: Handle): Win32Result<{ isDirectory: boolean; reparseTag: number | null }> {
        const { spec } = this.#h(h)
        return { ok: true, value: { isDirectory: spec.kind !== "file", reparseTag: spec.reparseTag ?? null } }
    }
    caseSensitiveDirectory(h: Handle): Win32Result<boolean> {
        const v = this.#h(h).spec.caseSensitive ?? false
        return typeof v === "number" ? { ok: false, error: v } : { ok: true, value: v }
    }
    volumeSerial(h: Handle): Win32Result<number> {
        const x = this.#h(h)
        const info = this.volumes[`${x.path.slice(0, 2)}\\`]?.info
        return { ok: true, value: x.spec.serial ?? (info?.ok === true ? info.value.serialNumber : 0) }
    }
    finalPath(h: Handle): Win32Result<string> {
        const { node } = this.#h(h)
        const f = node.spec.final
        const call = node.finalCalls++
        if (f === "error") return { ok: false, error: 1 }
        return { ok: true, value: typeof f === "function" ? f(call) : (f ?? `\\\\?\\${node.path}`) }
    }
    security(h: Handle): SecurityReading {
        const { path: p, spec } = this.#h(h)
        if (spec.securityThrows !== undefined) throw spec.securityThrows
        const d = defaultSecurity(p)
        const owner = spec.owner === undefined ? d.owner : spec.owner
        return { owner: owner === null ? { ok: false, cause: "invalid" } : { ok: true, sid: owner }, dacl: spec.dacl ?? { kind: "present", aces: spec.aces ?? d.aces } }
    }
    listDirectory(h: Handle, limits: ListingLimits): DirectoryListing {
        const { path: p, spec } = this.#h(h)
        if (spec.listing !== undefined) return spec.listing
        const entries = spec.entries ?? [...this.nodes.values()].filter((n) => n.path.slice(0, n.path.lastIndexOf("\\")) === p.replace(/\\$/, "") && n.path !== p).map((n) => n.path.slice(n.path.lastIndexOf("\\") + 1))
        return entries.length > limits.maxEntries ? { kind: "truncated" } : { kind: "complete", entries }
    }
    probeChild(rawParent: string, name: string): Win32Result<"present" | "absent"> {
        assert.ok(rawParent.startsWith("\\\\?\\"), "the record is looked up from a system final path only")
        const parentPath = rawParent.slice(4)
        const parent = this.#resolve(parentPath)
        if (parent?.spec.recordError !== undefined) return { ok: false, error: parent.spec.recordError }
        return { ok: true, value: this.#resolve(`${parentPath.replace(/\\$/, "")}\\${name}`) === undefined ? "absent" : "present" }
    }
    currentUserSid(): Win32Result<string> {
        return this.user
    }
    knownFolder(id: KnownFolderId): KnownFolderReading {
        return this.knownFolders[id] ?? { kind: "not-set", hresult: 0x80070002 }
    }
    oneDriveAccounts(): OneDriveAccountsReading {
        return this.accounts
    }
    compareOrdinal(): Win32Result<"less" | "equal" | "greater"> {
        throw new Error("not used by the collector in 03A2a")
    }
}

const kf = (p: string): KnownFolderReading => ({ kind: "path", path: p })

/** A synthetic user on C:, a private D:\Apps\FluentReaderMCP, a Fluent Reader profile on D:. */
function machine(): Machine {
    const m = new Machine()
    for (const p of ["C:\\", "C:\\Users", PROFILE, `${PROFILE}\\AppData`, LOCAL, ROAMING, `${LOCAL}\\Temp`, `${LOCAL}\\Packages`, `${ROAMING}\\Claude`, `${PROFILE}\\OneDrive`, `${PROFILE}\\.claude`, "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData", "C:\\Users\\Public", "D:\\", "D:\\Apps", APPS, "D:\\Profili", FR_PROFILE]) m.add(p)
    m.knownFolders = {
        [KNOWN_FOLDER.Windows]: kf("C:\\Windows"), [KNOWN_FOLDER.ProgramFiles]: kf("C:\\Program Files"), [KNOWN_FOLDER.ProgramFilesX86]: kf("C:\\Program Files (x86)"),
        [KNOWN_FOLDER.ProgramData]: kf("C:\\ProgramData"), [KNOWN_FOLDER.UserProfiles]: kf("C:\\Users"), [KNOWN_FOLDER.Public]: kf("C:\\Users\\Public"), [KNOWN_FOLDER.Profile]: kf(PROFILE),
        [KNOWN_FOLDER.LocalAppData]: kf(LOCAL), [KNOWN_FOLDER.RoamingAppData]: kf(ROAMING), [KNOWN_FOLDER.SkyDrive]: kf(`${PROFILE}\\OneDrive`),
    }
    return m
}

interface Run {
    readonly profile?: ProfileSelection
    readonly env?: Record<string, string | undefined>
    readonly verify?: InstallRecordVerifier
    readonly limits?: Partial<CollectionLimits>
    readonly maxRelative?: number
}

function collect(m: Machine, requestedPath: string, o: Run = {}): LocationCollection {
    const r = collectLocationFacts({ requestedPath, maxRelative: o.maxRelative ?? 120, profile: o.profile ?? SELECTED }, {
        api: () => m, platform: "win32", arch: "x64", env: o.env ?? {}, ...(o.verify !== undefined ? { verifyInstallRecord: o.verify } : {}), ...(o.limits !== undefined ? { limits: o.limits } : {}),
    })
    assert.equal(m.handles.size, 0, "every handle closed")
    if (r.status !== "complete") {
        const text = JSON.stringify(r)
        assert.doesNotMatch(text, /S-1-\d|[A-Za-z]:\\|Test User|Apps/, "a failure carries no path or SID")
        assert.doesNotMatch(describeCollectionFailure(r), /S-1-\d|[A-Za-z]:\\[\p{L}\p{N}]|Test User/u)
        assert.equal(evaluateCollectedLocation(r), null, "a failed collection is never evaluated")
    }
    return r
}

function complete(r: LocationCollection): LocationFacts {
    if (r.status !== "complete") assert.fail(`expected complete facts, got ${JSON.stringify(r)}`)
    assert.deepEqual(Object.keys(r.facts.protectedDirectories).sort(), [...PROTECTED_KINDS].sort(), "the 14 categories, always")
    return r.facts
}

function verdict(r: LocationCollection): LocationVerdict {
    complete(r)
    return evaluateCollectedLocation(r) as LocationVerdict
}
const reasonOf = (v: LocationVerdict): RefusalReason | "allowed" | "provisional" => (v.allowed ? "allowed" : v.state === "provisional" ? "provisional" : v.reason)

function failure(r: LocationCollection, expected: Partial<Record<string, unknown>>): void {
    assert.notEqual(r.status, "complete", JSON.stringify(r))
    for (const [k, v] of Object.entries(expected)) assert.deepEqual((r as unknown as Record<string, unknown>)[k], v, `${k}: ${JSON.stringify(r)}`)
}

// ------------------------------------------------------------------ tests

describe("location-facts: complete collections, field by field (contract A1)", () => {
    test("an existing private directory on D:: every LocationFacts field, and the validator allows it", () => {
        const m = machine()
        const r = collect(m, APPS)
        const f = complete(r)
        assert.equal(f.requestedPath, APPS)
        assert.equal(f.canonicalPath, APPS)
        assert.equal(f.currentUserSid, USER)
        assert.deepEqual(f.volume, { rootPath: "D:\\", driveType: "fixed", fileSystem: "NTFS", persistentAcls: true })
        assert.deepEqual(f.components.map((c) => c.path), ["D:\\", "D:\\Apps", APPS], "final paths without Windows' \\\\?\\ prefix")
        assert.deepEqual(f.components[0], { path: "D:\\", isDirectory: true, reparseTag: null, owner: ADMINS, dacl: { kind: "present", aces: NTFS_ROOT }, installRecord: "absent" })
        assert.deepEqual(f.missingSegments, [])
        assert.deepEqual(f.destinationContent, { entries: [], record: "absent" })
        assert.equal(f.maxRelative, 120)
        assert.deepEqual(r.status === "complete" && r.volume, { maximumComponentLength: 255 })
        assert.deepEqual(evaluateCollectedLocation(r), { allowed: true, state: "existing", canonicalPath: APPS, content: "empty", pendingChecks: [] })
        assert.deepEqual(m.opened, ["D:\\", "D:\\Apps", APPS])
    })

    test("a new leaf in %LOCALAPPDATA% on C:: the missing leaf as a segment, no content, eligible only for protected creation", () => {
        const r = collect(machine(), `${LOCAL}\\FluentReaderMCP`)
        const f = complete(r)
        assert.deepEqual(f.missingSegments, ["FluentReaderMCP"])
        assert.equal(f.destinationContent, null)
        assert.deepEqual(f.components.map((c) => c.path), ["C:\\", "C:\\Users", PROFILE, `${PROFILE}\\AppData`, LOCAL])
        const v = evaluateCollectedLocation(r)
        assert.ok(v?.allowed === true && v.state === "new-leaf" && v.requiresProtectedCreation)
    })

    test("several missing components: a contiguous suffix, nothing below the first missing one is opened; the validator refuses", () => {
        const m = machine()
        const r = collect(m, "D:\\A\\B\\FluentReaderMCP")
        assert.deepEqual(complete(r).missingSegments, ["A", "B", "FluentReaderMCP"])
        assert.deepEqual(m.opened, ["D:\\", "D:\\A"])
        assert.equal(reasonOf(verdict(r)), "missing-ancestors")
    })

    test("Unicode, spaces, forward slashes and ASCII case in the chosen path: the final path gives the on-disk names", () => {
        const dir = "D:\\Programmi utente\\Fluent Reader MCP é 😀"
        const m = machine().add("D:\\Programmi utente").add(dir)
        const r = collect(m, "d:/programmi utente/FLUENT READER MCP é 😀/")
        const f = complete(r)
        assert.equal(f.requestedPath, "d:/programmi utente/FLUENT READER MCP é 😀/")
        assert.equal(f.canonicalPath, dir)
        assert.equal(reasonOf(verdict(r)), "allowed")
    })

    test("an 8.3 short name on the way: the canonical path is the long one, and the validator refuses the chosen form", () => {
        const m = machine().alias("C:\\Users\\TESTUS~1", PROFILE).add(`${LOCAL}\\FluentReaderMCP`)
        const r = collect(m, "C:\\Users\\TESTUS~1\\AppData\\Local\\FluentReaderMCP")
        assert.equal(complete(r).canonicalPath, `${LOCAL}\\FluentReaderMCP`)
        assert.equal(reasonOf(verdict(r)), "path-not-canonical")
    })

    test("the profile not chosen yet: a provisional verdict, never an authorisation", () => {
        const r = collect(machine(), APPS, { profile: { status: "not-selected" } })
        assert.deepEqual(complete(r).protectedDirectories["fluent-reader-profile"], { status: "not-applicable", evidence: { kind: "profile-not-yet-selected" } })
        const v = verdict(r)
        assert.equal(v.allowed, false)
        assert.equal(reasonOf(v), "provisional")
    })
})

describe("location-facts: volume", () => {
    const withVolume = (driveType: number, info: Win32Result<VolumeInformation>): LocationCollection => {
        const m = machine()
        m.volumes["D:\\"] = { driveType, info }
        return collect(m, APPS)
    }

    test("NTFS with FILE_PERSISTENT_ACLS; without the flag: false (never inferred from the name)", () => {
        assert.equal(complete(withVolume(3, ntfs(0xd))).volume.persistentAcls, true)
        const r = withVolume(3, ntfs(0xd, { fileSystemFlags: 0x3 }))
        assert.deepEqual(complete(r).volume, { rootPath: "D:\\", driveType: "fixed", fileSystem: "NTFS", persistentAcls: false })
        assert.equal(reasonOf(verdict(r)), "volume-without-acls")
    })

    test("FAT32, exFAT, ReFS: the name as Windows gives it; the validator decides", () => {
        for (const [fileSystemName, flags] of [["FAT32", 0x2], ["exFAT", 0x2], ["ReFS", 0x8]] as const) {
            const r = withVolume(3, ntfs(0xd, { fileSystemName, fileSystemFlags: flags }))
            assert.equal(complete(r).volume.fileSystem, fileSystemName)
            assert.equal(reasonOf(verdict(r)), "unsupported-file-system")
        }
    })

    test("remote, removable, optical, RAM, no root, unknown and undocumented drive types are never fixed", () => {
        for (const [code, name] of [[4, "remote"], [2, "removable"], [5, "cdrom"], [6, "ramdisk"], [1, "no-root-dir"], [0, "unknown"], [9, "unknown"]] as const) {
            const r = withVolume(code, ntfs(0xd))
            assert.equal(complete(r).volume.driveType, name)
            assert.equal(reasonOf(verdict(r)), "unsupported-volume")
        }
    })

    test("GetVolumeInformationW failing, or an incoherent answer: file system and ACL support unknown (null), never a default", () => {
        for (const info of [{ ok: false, error: ERROR_ACCESS_DENIED } as const, ntfs(0xd, { maximumComponentLength: 0 }), ntfs(0xd, { maximumComponentLength: 70000 })]) {
            const r = withVolume(3, info)
            const f = complete(r)
            assert.deepEqual([f.volume.fileSystem, f.volume.persistentAcls], [null, null])
            assert.deepEqual(r.status === "complete" && r.volume, { maximumComponentLength: null })
            assert.equal(reasonOf(verdict(r)), "volume-unverifiable")
        }
    })

    test("a component on another volume than the root's (serial number): inconsistent; an unavailable drive: incomplete", () => {
        failure(collect(machine().set("D:\\Apps", { serial: 0x99 }), APPS), { status: "inconsistent", reason: "volume-mismatch", depth: 1 })
        failure(collect(machine(), "E:\\FluentReaderMCP"), { status: "incomplete", reason: "volume-unavailable", depth: 0 })
        failure(collect(machine().set("D:\\", { openError: ERROR_NOT_READY }), APPS), { status: "incomplete", reason: "volume-unavailable" })
    })
})

describe("location-facts: paths, links and namespaces", () => {
    test("a mapped network drive (final path \\\\?\\UNC\\...) or a volume without a letter: unsupported namespace", () => {
        failure(collect(machine().set("D:\\", { final: "\\\\?\\UNC\\server\\share" }), APPS), { status: "incomplete", reason: "unsupported-namespace", depth: 0 })
        failure(collect(machine().set(APPS, { final: "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x" }), APPS), { status: "incomplete", reason: "unsupported-namespace", depth: 2 })
    })

    test("a SUBST drive: its root is another directory: path alias, nothing below it is opened", () => {
        const m = machine().set("D:\\", { final: "\\\\?\\C:\\Subst" })
        failure(collect(m, APPS), { status: "incomplete", reason: "path-alias", depth: 0 })
        assert.deepEqual(m.opened, ["D:\\"])
        failure(collect(machine().set("D:\\", { final: "\\\\?\\E:\\" }), APPS), { status: "incomplete", reason: "path-alias" })
    })

    test("junction, mount point or symbolic link on an ancestor or as the destination: never followed, the walk stops there", () => {
        for (const [tag, at, depth] of [[0xa0000003, "D:\\Apps", 1], [0xa000000c, "D:\\Apps", 1], [0xa000000c, APPS, 2], [0x9000001a, APPS, 2], [0, "D:\\Apps", 1]] as const) {
            const m = machine().set(at, { reparseTag: tag })
            failure(collect(m, APPS), { status: "incomplete", reason: "reparse-point-on-path", depth })
            assert.equal(m.opened.length, depth + 1, "nothing beyond it is opened")
        }
    })

    test("a component that is a file: reported, never treated as a missing directory", () => {
        const m = machine().set("D:\\Apps", { kind: "file" })
        failure(collect(m, APPS), { status: "incomplete", reason: "not-a-directory-on-path", depth: 1 })
        failure(collect(machine().set(APPS, { kind: "file" }), APPS), { status: "incomplete", reason: "not-a-directory-on-path", depth: 2 })
    })

    test("a directory that cannot be opened is access denied, never absent; a sharing violation is not an absence either", () => {
        failure(collect(machine().set("D:\\Apps", { openError: ERROR_ACCESS_DENIED }), APPS), { status: "access-denied", step: "open", depth: 1 })
        failure(collect(machine().set(APPS, { openError: ERROR_ACCESS_DENIED }), APPS), { status: "access-denied", step: "open", depth: 2 })
        failure(collect(machine().set(APPS, { openError: ERROR_SHARING_VIOLATION }), APPS), { status: "incomplete", reason: "sharing-violation", depth: 2 })
        failure(collect(machine().set(APPS, { openError: 1234 }), APPS), { status: "failed", step: "open", error: 1234, depth: 2 })
    })

    test("ERROR_PATH_NOT_FOUND below a parent that was just opened: inconsistent, not missing", () => {
        failure(collect(machine().set(APPS, { openError: ERROR_PATH_NOT_FOUND }), APPS), { status: "inconsistent", reason: "vanished-during-collection", depth: 2 })
    })

    test("canonicalization failing: no canonical path is produced", () => {
        failure(collect(machine().set("D:\\Apps", { final: "error" }), APPS), { status: "failed", step: "final-path", depth: 1 })
        failure(collect(machine().set("D:\\Apps", { final: "D:\\Apps" }), APPS), { status: "incomplete", reason: "unsupported-namespace" })
    })

    test("a final path that does not extend its parent's exactly: inconsistent (a rename or a link appeared)", () => {
        failure(collect(machine().set(APPS, { final: "\\\\?\\D:\\Other\\FluentReaderMCP" }), APPS), { status: "inconsistent", reason: "path-chain", depth: 2 })
        failure(collect(machine().set(APPS, { final: "\\\\?\\D:\\Apps\\Fluent\\ReaderMCP" }), APPS), { status: "inconsistent", reason: "path-chain", depth: 2 })
        failure(collect(machine().set(APPS, { final: "\\\\?\\D:\\APPS\\FluentReaderMCP" }), APPS), { status: "inconsistent", reason: "path-chain", depth: 2 }, )
    })
})

describe("location-facts: owner and DACL readings, mapped to the contract without loosening", () => {
    const withSecurity = (spec: NodeSpec): LocationVerdict => verdict(collect(machine().set(APPS, spec), APPS))

    test("valid owner and DACL: allowed; an owner that cannot be read: null (acl-unverifiable)", () => {
        assert.equal(reasonOf(withSecurity({})), "allowed")
        assert.equal(reasonOf(withSecurity({ owner: null })), "acl-unverifiable")
    })

    test("NULL DACL and no DACL both become the contract's null (refused as open to everyone); unreadable stays unreadable", () => {
        for (const kind of ["null", "absent"] as const) {
            const f = complete(collect(machine().set(APPS, { dacl: { kind } }), APPS))
            assert.deepEqual(f.components[2]?.dacl, { kind: "null" })
            assert.equal(reasonOf(withSecurity({ dacl: { kind } })), "null-dacl")
        }
        assert.equal(reasonOf(withSecurity({ dacl: { kind: "unreadable", cause: "sid-invalid" } })), "acl-unverifiable")
    })

    test("an empty DACL is present with no ACE (grants nothing), not a NULL DACL", () => {
        assert.deepEqual(complete(collect(machine().set(APPS, { dacl: { kind: "present", aces: [] } }), APPS)).components[2]?.dacl, { kind: "present", aces: [] })
        assert.equal(reasonOf(withSecurity({ dacl: { kind: "present", aces: [] } })), "destination-access-incomplete")
    })

    test("allow, deny, inherit-only, unknown type and unknown mask ACEs reach the validator unchanged", () => {
        assert.equal(reasonOf(withSecurity({ aces: [...PRIVATE, allow(AU, MODIFY, OICI)] })), "untrusted-access")
        assert.equal(reasonOf(withSecurity({ aces: [...PRIVATE, { aceType: 1, aceFlags: 0, accessMask: ACCESS.DELETE, sid: AU }] })), "deny-ace-on-destination")
        assert.equal(reasonOf(withSecurity({ aces: [...PRIVATE, allow(EVERYONE, MODIFY, OICI | IO)] })), "untrusted-access")
        assert.equal(reasonOf(withSecurity({ aces: [...PRIVATE, { aceType: 0x11, aceFlags: 0, accessMask: 1, sid: "S-1-16-12288" }] })), "unsupported-ace")
        assert.equal(reasonOf(withSecurity({ aces: [...PRIVATE, allow(SYSTEM, 0x00400000)] })), "unsupported-ace")
        const aces = [...PRIVATE, { aceType: 0x11, aceFlags: 0x40, accessMask: 0x00400000, sid: "S-1-16-12288" }]
        assert.deepEqual(complete(collect(machine().set(APPS, { aces }), APPS)).components[2]?.dacl, { kind: "present", aces })
    })

    test("an ancestor others can modify (the default D: ACL) is refused by the validator", () => {
        assert.equal(reasonOf(verdict(collect(machine().set("D:\\Apps", { aces: SHARED_INHERITED }), APPS))), "untrusted-access")
    })
})

describe("location-facts: the 14 protected categories", () => {
    test("all resolved, canonical, on the synthetic machine; a directory that does not exist yet is still protected", () => {
        const p = complete(collect(machine(), APPS)).protectedDirectories
        assert.deepEqual(p, {
            windows: { status: "resolved", paths: ["C:\\Windows"] },
            "program-files": { status: "resolved", paths: ["C:\\Program Files", "C:\\Program Files (x86)"] },
            "program-data": { status: "resolved", paths: ["C:\\ProgramData"] },
            "users-root": { status: "resolved", paths: ["C:\\Users"] },
            "public-profile": { status: "resolved", paths: ["C:\\Users\\Public"] },
            "user-profile": { status: "resolved", paths: [PROFILE] },
            "local-appdata": { status: "resolved", paths: [LOCAL] },
            "roaming-appdata": { status: "resolved", paths: [ROAMING] },
            temp: { status: "resolved", paths: [`${LOCAL}\\Temp`] },
            onedrive: { status: "resolved", paths: [`${PROFILE}\\OneDrive`] },
            "claude-code-config": { status: "resolved", paths: [`${PROFILE}\\.claude`] },
            "claude-desktop-data": { status: "resolved", paths: [`${ROAMING}\\Claude`, `${LOCAL}\\Claude-Data`, `${LOCAL}\\Claude-3p`] },
            "msix-packages": { status: "resolved", paths: [`${LOCAL}\\Packages`] },
            "fluent-reader-profile": { status: "resolved", paths: [FR_PROFILE] },
        })
        // .claude removed: still at its location, and refused as a destination
        const m = machine().remove(`${PROFILE}\\.claude`)
        const r = collect(m, `${PROFILE}\\.claude`)
        assert.deepEqual(complete(r).protectedDirectories["claude-code-config"], { status: "resolved", paths: [`${PROFILE}\\.claude`] })
        assert.equal(reasonOf(verdict(r)), "protected-directory")
    })

    test("a known folder that cannot be read: its categories are unreadable (the validator refuses), never omitted", () => {
        const cases: [KnownFolderId, KnownFolderReading, string[]][] = [
            [KNOWN_FOLDER.Windows, { kind: "error", hresult: 0x80004005 }, ["windows"]],
            [KNOWN_FOLDER.ProgramFilesX86, { kind: "not-set", hresult: 0x80070002 }, ["program-files"]],
            [KNOWN_FOLDER.RoamingAppData, { kind: "error", hresult: 0x80004005 }, ["roaming-appdata", "claude-desktop-data"]],
            [KNOWN_FOLDER.LocalAppData, { kind: "not-set", hresult: 0x80070057 }, ["local-appdata", "temp", "claude-desktop-data", "msix-packages"]],
            [KNOWN_FOLDER.Profile, { kind: "error", hresult: 0x80004005 }, ["user-profile", "claude-code-config"]],
        ]
        for (const [id, reading, kinds] of cases) {
            const m = machine()
            m.knownFolders[id] = reading
            const r = collect(m, APPS)
            const p = complete(r).protectedDirectories
            assert.deepEqual(PROTECTED_KINDS.filter((k) => p[k].status === "unreadable"), kinds, id)
            assert.equal(reasonOf(verdict(r)), "incomplete-facts")
        }
    })

    test("a known folder redirected to the network, or not openable, cannot be located: unreadable", () => {
        const m = machine()
        m.knownFolders[KNOWN_FOLDER.RoamingAppData] = kf("\\\\server\\profiles\\Roaming")
        assert.equal(complete(collect(m, APPS)).protectedDirectories["roaming-appdata"].status, "unreadable")
        const denied = machine().set("C:\\ProgramData", { openError: ERROR_ACCESS_DENIED })
        assert.equal(complete(collect(denied, APPS)).protectedDirectories["program-data"].status, "unreadable")
    })

    test("protected locations follow links to where the data is; a dangling link is unreadable", () => {
        const m = machine().add("D:\\ClaudeData").set(`${ROAMING}\\Claude`, { reparseTag: 0xa0000003, target: "D:\\ClaudeData" })
        const r = collect(m, "D:\\ClaudeData\\FluentReaderMCP")
        assert.deepEqual(complete(r).protectedDirectories["claude-desktop-data"], { status: "resolved", paths: ["D:\\ClaudeData", `${LOCAL}\\Claude-Data`, `${LOCAL}\\Claude-3p`] })
        assert.equal(reasonOf(verdict(r)), "protected-directory")
        const dangling = machine().set(`${ROAMING}\\Claude`, { reparseTag: 0xa000000c, target: "D:\\Gone" })
        assert.equal(complete(collect(dangling, APPS)).protectedDirectories["claude-desktop-data"].status, "unreadable")
    })

    test("TMP and TEMP: canonicalized (8.3 names), duplicates removed by proven equality; unusable or ambiguous values unreadable", () => {
        const m = machine().alias("C:\\Users\\TESTUS~1", PROFILE)
        const p = complete(collect(m, APPS, { env: { TEMP: "C:\\Users\\TESTUS~1\\AppData\\Local\\Temp", tmp: `${up(LOCAL)}\\TEMP` } })).protectedDirectories
        assert.deepEqual(p.temp, { status: "resolved", paths: [`${LOCAL}\\Temp`] })
        const other = complete(collect(machine().add("D:\\Tmp"), APPS, { env: { TMP: "D:\\Tmp" } })).protectedDirectories
        assert.deepEqual(other.temp, { status: "resolved", paths: ["D:\\Tmp", `${LOCAL}\\Temp`] })
        for (const env of [{ TEMP: "\\\\server\\tmp" }, { TEMP: "relative" }, { TEMP: "" }, { TEMP: "D:\\A", temp: "D:\\B" }]) {
            assert.equal(complete(collect(machine(), APPS, { env })).protectedDirectories.temp.status, "unreadable", JSON.stringify(env))
        }
    })

    test("OneDrive: verified absent only with the three proofs; any folder found is protected; any unreadable source leaves it unknown", () => {
        const absent = (): Machine => {
            const m = machine()
            m.knownFolders[KNOWN_FOLDER.SkyDrive] = { kind: "not-set", hresult: 0x80070002 }
            return m
        }
        const onedrive = (m: Machine, env: Record<string, string> = {}) => complete(collect(m, APPS, { env })).protectedDirectories.onedrive
        const evidence = { status: "verified-absent", evidence: { kind: "onedrive-not-configured", knownFolderUnset: true, environmentUnset: true, noAccountUserFolder: true } }
        assert.deepEqual(onedrive(absent()), evidence)
        const noFolders = absent()
        noFolders.accounts = { kind: "accounts", folders: [] }
        assert.deepEqual(onedrive(noFolders), evidence, "accounts without a UserFolder")
        assert.equal(reasonOf(verdict(collect(absent(), APPS))), "allowed")

        assert.deepEqual(onedrive(absent().add("D:\\OneDrive - Contoso"), { OneDriveCommercial: "D:\\OneDrive - Contoso" }), { status: "resolved", paths: ["D:\\OneDrive - Contoso"] })
        const account = absent().add("D:\\OD")
        account.accounts = { kind: "accounts", folders: ["D:\\OD"] }
        assert.deepEqual(onedrive(account), { status: "resolved", paths: ["D:\\OD"] })
        assert.deepEqual(onedrive(machine(), { OneDrive: `${PROFILE}\\OneDrive` }), { status: "resolved", paths: [`${PROFILE}\\OneDrive`] }, "same folder from two sources")

        const skyError = absent()
        skyError.knownFolders[KNOWN_FOLDER.SkyDrive] = { kind: "error", hresult: 0x80004005 }
        const registry = machine()
        registry.accounts = { kind: "unreadable", error: ERROR_ACCESS_DENIED }
        for (const [label, status] of [
            ["known folder error", onedrive(skyError).status], ["registry unreadable while the known folder is set", onedrive(registry).status],
            ["variable on the network", onedrive(absent(), { OneDrive: "\\\\server\\od" }).status], ["variable ambiguous", onedrive(absent(), { OneDrive: "D:\\A", ONEDRIVE: "D:\\B" }).status],
            ["variable empty", onedrive(absent(), { OneDriveConsumer: "" }).status],
        ] as const) {
            assert.equal(status, "unreadable", label)
        }
    })

    test("Fluent Reader profile: not selected → not-applicable; selected → its canonical location; unresolvable → unreadable", () => {
        assert.deepEqual(complete(collect(machine(), APPS, { profile: { status: "selected", path: "d:\\profili\\FLUENT READER\\" } })).protectedDirectories["fluent-reader-profile"], { status: "resolved", paths: [FR_PROFILE] })
        const linked = machine().add("D:\\Real").set(FR_PROFILE, { reparseTag: 0xa0000003, target: "D:\\Real" })
        assert.deepEqual(complete(collect(linked, APPS)).protectedDirectories["fluent-reader-profile"], { status: "resolved", paths: ["D:\\Real"] })
        for (const p of ["relative\\profile", "\\\\server\\profile", "D:\\a\\..\\b"]) {
            const r = collect(machine(), APPS, { profile: { status: "selected", path: p } })
            assert.deepEqual(complete(r).protectedDirectories["fluent-reader-profile"], { status: "unreadable" }, p)
            assert.equal(reasonOf(verdict(r)), "incomplete-facts")
        }
        assert.equal(reasonOf(verdict(collect(machine(), `${FR_PROFILE}\\FluentReaderMCP`))), "protected-directory")
    })

    test("Claude locations: CLAUDE_CONFIG_DIR added when usable; not determinable → unreadable, never a guessed path", () => {
        const added = complete(collect(machine().add("D:\\ClaudeCfg"), APPS, { env: { CLAUDE_CONFIG_DIR: "D:\\ClaudeCfg" } })).protectedDirectories["claude-code-config"]
        assert.deepEqual(added, { status: "resolved", paths: [`${PROFILE}\\.claude`, "D:\\ClaudeCfg"] })
        for (const value of ["relative", "\\\\server\\claude", "~\\.claude"]) {
            const r = collect(machine(), APPS, { env: { CLAUDE_CONFIG_DIR: value } })
            assert.equal(complete(r).protectedDirectories["claude-code-config"].status, "unreadable", value)
            assert.equal(reasonOf(verdict(r)), "incomplete-facts")
        }
    })
})

describe("location-facts: dangling links on protected locations are never replaced by their lexical path", () => {
    const JUNCTION = 0xa0000003
    const SYMLINK = 0xa000000c
    const PROFILI = "D:\\Profili"
    /** The Fluent Reader profile category for `profilePath`, the probes made under D:\Profili, and the verdict on D:\Apps\FluentReaderMCP. */
    const profileCategory = (m: Machine, profilePath: string = FR_PROFILE) => {
        const r = collect(m, APPS, { profile: { status: "selected", path: profilePath } })
        assert.equal(m.opens, m.closes, "every handle opened (walk and probes) closed exactly once")
        return { r, category: complete(r).protectedDirectories["fluent-reader-profile"], probes: m.probes.filter(([q]) => up(q).startsWith(up(PROFILI))) }
    }

    for (const [code, followError] of [["ERROR_FILE_NOT_FOUND", ERROR_FILE_NOT_FOUND], ["ERROR_PATH_NOT_FOUND", ERROR_PATH_NOT_FOUND]] as const) {
        test(`dangling junction, following it fails with ${code}: the no-follow probe finds the link → unreadable, its parent never opened`, () => {
            const m = machine().set(FR_PROFILE, { reparseTag: JUNCTION, target: "E:\\Gone\\Profile", followError })
            const { r, category, probes } = profileCategory(m)
            assert.deepEqual(category, { status: "unreadable" })
            assert.deepEqual(probes, [[FR_PROFILE, true], [FR_PROFILE, false]], "the link probed without following it; D:\\Profili never taken as the location")
            assert.doesNotMatch(JSON.stringify(complete(r).protectedDirectories), /Fluent Reader/, "the lexical path is not reported as the protected location")
            // with the lexical path, the profile would look resolved and the destination would be allowed
            assert.equal(reasonOf(verdict(r)), "incomplete-facts")
        })
    }

    test("a protected path BELOW a dangling link: no-follow 'path not found' on the child, then the link found one level up → unreadable", () => {
        const m = machine().set(FR_PROFILE, { reparseTag: SYMLINK, target: "D:\\Gone", followError: ERROR_PATH_NOT_FOUND })
        const { category, probes } = profileCategory(m, `${FR_PROFILE}\\Sub`)
        assert.deepEqual(category, { status: "unreadable" })
        assert.deepEqual(probes, [[`${FR_PROFILE}\\Sub`, true], [`${FR_PROFILE}\\Sub`, false], [FR_PROFILE, true], [FR_PROFILE, false]])
    })

    test("the no-follow probe denied (or failing otherwise): unreadable, never an absence", () => {
        for (const followError of [ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND]) {
            for (const probeError of [ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, 1234]) {
                const m = machine().set(FR_PROFILE, { reparseTag: JUNCTION, target: "D:\\Gone", followError, probeError })
                const { category, probes } = profileCategory(m)
                assert.deepEqual(category, { status: "unreadable" }, `${followError}/${probeError}`)
                assert.deepEqual(probes, [[FR_PROFILE, true], [FR_PROFILE, false]], `${followError}/${probeError}`)
            }
        }
    })

    test("an entry that exists but cannot be reached by following it (no reparse tag): unreadable as well", () => {
        const m = machine().set(FR_PROFILE, { followError: ERROR_PATH_NOT_FOUND })
        assert.deepEqual(profileCategory(m).category, { status: "unreadable" })
    })

    test("no link, a segment really missing: the no-follow probe confirms it (FILE_NOT_FOUND) → the existing parent's final path + the segment", () => {
        const m = machine()
        const { category, probes } = profileCategory(m, `${PROFILI}\\Nuovo`)
        assert.deepEqual(category, { status: "resolved", paths: [`${PROFILI}\\Nuovo`] })
        assert.deepEqual(probes, [[`${PROFILI}\\Nuovo`, true], [`${PROFILI}\\Nuovo`, false], [PROFILI, true]])
    })

    test("no link, several segments missing: PATH_NOT_FOUND confirmed by the no-follow probe at each level, then FILE_NOT_FOUND, then the parent", () => {
        const m = machine()
        const deep = `${PROFILI}\\Mancante\\Nuovo`
        const { category, probes } = profileCategory(m, deep)
        assert.deepEqual(category, { status: "resolved", paths: [deep] })
        assert.deepEqual(probes, [[deep, true], [deep, false], [`${PROFILI}\\Mancante`, true], [`${PROFILI}\\Mancante`, false], [PROFILI, true]])
    })

    test("a link whose target exists is followed to it (the protected place is where the data is)", () => {
        const m = machine().add("D:\\Real").set(FR_PROFILE, { reparseTag: JUNCTION, target: "D:\\Real" })
        const { category, probes } = profileCategory(m)
        assert.deepEqual(category, { status: "resolved", paths: ["D:\\Real"] })
        assert.deepEqual(probes, [[FR_PROFILE, true]])
    })
})

describe("location-facts: content of the destination and installation record", () => {
    const record = (m: Machine, dir = APPS): Machine => m.add(`${dir}\\${RECORD_NAME}`, { kind: "file" })

    test("empty: allowed; foreign content: refused by the validator; names of the layout prove nothing", () => {
        assert.equal(reasonOf(verdict(collect(machine(), APPS))), "allowed")
        const foreign = machine().add(`${APPS}\\notes.txt`, { kind: "file" })
        assert.deepEqual(complete(collect(foreign, APPS)).destinationContent, { entries: ["notes.txt"], record: "absent" })
        assert.equal(reasonOf(verdict(collect(foreign, APPS))), "foreign-content")
        const layout = machine().set(APPS, { entries: ["current", "state", ".staging", "previous", "uninstall.exe"] })
        assert.equal(reasonOf(verdict(collect(layout, APPS))), "foreign-content")
    })

    test("a record is present: without a verifier the collection is incomplete; with one, its verdict is used", () => {
        failure(collect(record(machine()), APPS), { status: "incomplete", reason: "record-verification-unavailable", depth: 2 })
        const seen: unknown[] = []
        const r = collect(record(machine()), APPS, { verify: (d) => (seen.push(d), "this-directory") })
        assert.deepEqual(seen, [{ canonicalPath: APPS, rawFinalPath: `\\\\?\\${APPS}` }])
        assert.deepEqual(complete(r).destinationContent, { entries: [RECORD_NAME], record: "this-directory" })
        const v = verdict(r)
        assert.ok(v.allowed && v.state === "existing" && v.content === "installation")
        assert.equal(reasonOf(verdict(collect(record(machine()), APPS, { verify: () => "other-directory" }))), "foreign-installation-record")
        assert.equal(reasonOf(verdict(collect(record(machine()), APPS, { verify: () => "unreadable" }))), "installation-record-unreadable")
        failure(collect(record(machine()), APPS, { verify: () => "yes" as never }), { status: "failed", step: "record-verification" })
        failure(collect(record(machine()), APPS, { verify: () => { throw new Error("verifier crash") } }), { status: "failed", step: "record-verification" })
    })

    test("two ASCII-equivalent records: impossible in a case-insensitive directory (inconsistent), refused where case-sensitive; a Unicode look-alike: ambiguous", () => {
        const pair = [RECORD_NAME, up(RECORD_NAME)]
        failure(collect(record(machine()).set(APPS, { entries: pair }), APPS, { verify: () => "this-directory" }), { status: "inconsistent", reason: "listing-inconsistent", depth: 2 })
        const sensitive = record(machine()).set(APPS, { entries: pair, caseSensitive: true })
        const r = collect(sensitive, APPS, { verify: () => "this-directory" })
        assert.deepEqual(complete(r).destinationContent, { entries: pair, record: "unreadable" }, "both kept, the record not proven")
        assert.equal(verdict(r).allowed, false)
        const lookalike = machine().set(APPS, { entries: ["fluent-reader-mcp.ınstall.json"] })
        assert.equal(reasonOf(verdict(collect(lookalike, APPS))), "ambiguous-install-record")
    })

    test("inventory: a really empty directory and a valid one are complete, entries unchanged and in order", () => {
        assert.deepEqual(complete(collect(machine(), APPS)).destinationContent, { entries: [], record: "absent" })
        const entries = ["notes.txt", "Dati é 😀", "B", "b.txt"]
        const r = collect(machine().set(APPS, { entries }), APPS)
        assert.deepEqual(complete(r).destinationContent, { entries, record: "absent" })
        assert.equal(reasonOf(verdict(r)), "foreign-content")
        const withRecord = collect(record(machine()), APPS, { verify: () => "this-directory" })
        assert.deepEqual(complete(withRecord).destinationContent, { entries: [RECORD_NAME], record: "this-directory" })
    })

    test("inventory: the same name twice, '.', '..', an empty or multi-component name → inconsistent, never a de-duplicated list", () => {
        for (const entries of [["a", "a"], ["notes.txt", "b", "notes.txt"], ["."], ["..", "a"], [""], ["a\\b"], ["a/b"]]) {
            failure(collect(machine().set(APPS, { entries }), APPS), { status: "inconsistent", reason: "listing-inconsistent", depth: 2 })
            failure(collect(machine().set(APPS, { entries, caseSensitive: true }), APPS), { status: "inconsistent", reason: "listing-inconsistent", depth: 2 })
        }
        failure(collect(record(machine()).set(APPS, { entries: [RECORD_NAME, RECORD_NAME] }), APPS, { verify: () => "this-directory" }), { status: "inconsistent", reason: "listing-inconsistent", depth: 2 })
    })

    test("inventory: names differing only in ASCII case → inconsistent where the directory is proven case-insensitive; kept where it is case-sensitive or unknown", () => {
        failure(collect(machine().set(APPS, { entries: ["Notes.txt", "notes.TXT"] }), APPS), { status: "inconsistent", reason: "listing-inconsistent", depth: 2 })
        for (const caseSensitive of [true, ERROR_ACCESS_DENIED]) {
            const f = complete(collect(machine().set(APPS, { entries: ["Notes.txt", "notes.TXT"], caseSensitive }), APPS))
            assert.deepEqual(f.destinationContent?.entries, ["Notes.txt", "notes.TXT"], String(caseSensitive))
        }
        // non-ASCII case pairs depend on the volume's upcase table: kept, the validator decides
        assert.deepEqual(complete(collect(machine().set(APPS, { entries: ["é", "É"] }), APPS)).destinationContent?.entries, ["é", "É"])
    })

    test("inventory: an enumeration the Win32 layer reports as inconsistent is never a content", () => {
        failure(collect(machine().set(APPS, { listing: { kind: "inconsistent" } }), APPS), { status: "inconsistent", reason: "listing-inconsistent", depth: 2 })
    })

    test("a record lookup that fails, or a case-sensitive (or unknown) directory: unreadable, never absent", () => {
        const failed = machine().set(APPS, { recordError: ERROR_ACCESS_DENIED })
        const f = complete(collect(failed, APPS))
        assert.equal(f.components[2]?.installRecord, "unreadable")
        assert.deepEqual(f.destinationContent, { entries: [], record: "unreadable" })
        assert.equal(reasonOf(verdict(collect(failed, APPS))), "install-record-unverifiable")
        for (const caseSensitive of [true, ERROR_ACCESS_DENIED]) {
            const r = collect(machine().set("D:\\Apps", { caseSensitive }), APPS)
            assert.equal(complete(r).components[1]?.installRecord, "unreadable")
            assert.equal(reasonOf(verdict(r)), "install-record-unverifiable")
        }
    })

    test("a record on an ancestor: nested installation (no verifier needed to refuse)", () => {
        const r = collect(record(machine(), "D:\\Apps"), APPS)
        assert.equal(complete(r).components[1]?.installRecord, "present")
        assert.equal(reasonOf(verdict(r)), "nested-installation")
    })

    test("the lookup and the listing disagreeing: inconsistent", () => {
        failure(collect(record(machine()).set(APPS, { entries: [] }), APPS), { status: "inconsistent", reason: "record-lookup-mismatch", depth: 2 })
        failure(collect(machine().set(APPS, { entries: [RECORD_NAME] }), APPS), { status: "inconsistent", reason: "record-lookup-mismatch" })
    })

    test("listing failed, partial or malformed: never a complete content", () => {
        failure(collect(machine().set(APPS, { listing: { kind: "error", error: ERROR_ACCESS_DENIED } }), APPS), { status: "access-denied", step: "listing", depth: 2 })
        failure(collect(machine().set(APPS, { listing: { kind: "error", error: 1117 } }), APPS), { status: "failed", step: "listing", error: 1117 })
        failure(collect(machine().set(APPS, { listing: { kind: "truncated" } }), APPS), { status: "incomplete", reason: "listing-truncated" })
        failure(collect(machine().set(APPS, { listing: { kind: "malformed" } }), APPS), { status: "incomplete", reason: "listing-malformed" })
        failure(collect(machine().set(APPS, { entries: ["a", "b", "c"] }), APPS, { limits: { maxEntries: 2 } }), { status: "incomplete", reason: "listing-truncated" })
    })
})

describe("location-facts: resources, races and errors", () => {
    test("every handle is closed exactly once, on success and on every failure path (checked by each collection)", () => {
        const m = machine()
        complete(collect(m, APPS))
        assert.ok(m.closes >= 3)
        const failing = machine().set(APPS, { securityThrows: new Error("native failure") })
        failure(collect(failing, APPS), { status: "failed", step: "security", error: null })
    })

    test("a handle that cannot be closed, or a native release failure, fails the whole collection", () => {
        const m = machine()
        m.closeError = 6
        failure(collect(m, APPS), { status: "failed", step: "close" })
        failure(collect(machine().set(APPS, { securityThrows: new NativeReleaseError("LocalFree", 87) }), APPS), { status: "failed", step: "security", error: 87 })
    })

    test("a final path changing during the collection, or the leaf appearing: inconsistent", () => {
        failure(collect(machine().set("D:\\Apps", { final: (call) => (call === 0 ? "\\\\?\\D:\\Apps" : "\\\\?\\D:\\Moved") }), APPS), { status: "inconsistent", reason: "changed-during-collection", depth: 1 })
        const m = machine()
        let created = false
        const api = new Proxy(m, {
            get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver) as unknown
                if (prop === "knownFolder" && !created) {
                    created = true
                    target.add(`${LOCAL}\\FluentReaderMCP`)
                }
                return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
            },
        })
        const r = collectLocationFacts({ requestedPath: `${LOCAL}\\FluentReaderMCP`, maxRelative: 120, profile: SELECTED }, { api: () => api, platform: "win32", arch: "x64", env: {} })
        assert.deepEqual(r, { status: "inconsistent", reason: "changed-during-collection", depth: 5 })
        assert.equal(m.handles.size, 0)
    })

    test("the current user cannot be read: no facts", () => {
        const m = machine()
        m.user = { ok: false, error: ERROR_ACCESS_DENIED }
        failure(collect(m, APPS), { status: "access-denied", step: "current-user" })
        m.user = { ok: false, error: 1337 }
        failure(collect(m, APPS), { status: "failed", step: "current-user", error: 1337 })
    })

    test("the API has no mutating method: nothing is created, changed or removed", () => {
        const m = machine()
        const before = JSON.stringify([...m.nodes.keys()])
        collect(m, `${LOCAL}\\FluentReaderMCP`)
        assert.equal(JSON.stringify([...m.nodes.keys()]), before)
        const methods: (keyof Win32SecurityApi)[] = ["driveType", "volumeInformation", "openComponent", "openProbe", "close", "attributes", "caseSensitiveDirectory", "volumeSerial", "finalPath", "security", "listDirectory", "probeChild", "currentUserSid", "knownFolder", "oneDriveAccounts", "compareOrdinal"]
        const declared = fs.readFileSync(path.join(REPO_ROOT, "installer", "setup", "win32-security.ts"), "utf8")
        const body = declared.slice(declared.indexOf("export interface Win32SecurityApi {"), declared.indexOf("const fail ="))
        assert.deepEqual([...body.matchAll(/^ {4}(\w+)\(/gm)].map((x) => x[1]), methods)
    })

    test("describeCollectionFailure has a message for every failure, without paths or SIDs", () => {
        const failures: Exclude<LocationCollection, { status: "complete" }>[] = [
            { status: "invalid-input", field: "requestedPath" }, { status: "invalid-input", field: "requestedPath", reason: "volume-root" }, { status: "unsupported-platform" }, { status: "api-unavailable" },
            { status: "access-denied", step: "open", depth: 2 }, { status: "inconsistent", reason: "path-chain", depth: 1 }, { status: "failed", step: "final-path", error: 5, depth: 1 },
            ...(["volume-unavailable", "reparse-point-on-path", "not-a-directory-on-path", "unsupported-namespace", "path-alias", "sharing-violation", "listing-truncated", "listing-malformed", "record-verification-unavailable"] as const).map((reason) => ({ status: "incomplete" as const, reason, depth: 1 })),
        ]
        for (const f of failures) {
            const message = describeCollectionFailure(f)
            assert.ok(message.length > 20, JSON.stringify(f))
            assert.doesNotMatch(message, /S-1-\d|[A-Za-z]:\\[\p{L}\p{N}]/u)
        }
    })
})

describe("location-facts: input, platform and lazy native binding", () => {
    test("invalid input is refused before anything native is loaded", () => {
        let loads = 0
        const run = (input: unknown, limits?: Partial<CollectionLimits>) => collectLocationFacts(input as never, { api: () => (loads++, machine()), platform: "win32", arch: "x64", env: {}, ...(limits !== undefined ? { limits } : {}) })
        const base = { requestedPath: APPS, maxRelative: 120, profile: SELECTED }
        for (const requestedPath of ["\\\\server\\share\\x", "\\\\?\\D:\\x", "\\\\.\\D:\\x", "relative\\x", "D:x", "D:\\a\\..\\b", "D:\\a\\.\\b", "D:\\NUL\\x", "D:\\a.\\x", "D:\\a \\x", "D:\\a\\\\b", "D:\\a|b", "", "D:\\a\0b", `D:\\${"x".repeat(300)}`, 42]) {
            assert.deepEqual(run({ ...base, requestedPath }), { status: "invalid-input", field: "requestedPath" }, JSON.stringify(requestedPath))
        }
        assert.deepEqual(run({ ...base, requestedPath: "D:\\" }), { status: "invalid-input", field: "requestedPath", reason: "volume-root" })
        for (const maxRelative of [0, -1, 1.5, Number.NaN, "120", 40000]) assert.deepEqual(run({ ...base, maxRelative }), { status: "invalid-input", field: "maxRelative" })
        for (const profile of [null, {}, { status: "selected" }, { status: "selected", path: 1 }, { status: "not-selected", path: "D:\\x" }, { status: "maybe" }]) assert.deepEqual(run({ ...base, profile }), { status: "invalid-input", field: "profile" })
        for (const limits of [{ maxEntries: 0 }, { maxEntries: DEFAULT_COLLECTION_LIMITS.maxEntries + 1 }, { listingBufferBytes: 100 }, { maxOneDriveAccounts: 1.5 }]) assert.deepEqual(run(base, limits), { status: "invalid-input", field: "limits" })
        assert.equal(loads, 0)
    })

    test("other platforms and architectures: unsupported, the provider is never loaded; a loader failure is api-unavailable", () => {
        let loads = 0
        const input = { requestedPath: APPS, maxRelative: 120, profile: SELECTED }
        const api = (): Win32SecurityApi => (loads++, machine())
        assert.deepEqual(collectLocationFacts(input, { api, platform: "linux", arch: "x64" }), { status: "unsupported-platform" })
        assert.deepEqual(collectLocationFacts(input, { api, platform: "win32", arch: "ia32" }), { status: "unsupported-platform" })
        assert.deepEqual(collectLocationFacts(input, { api, platform: "win32", arch: "arm64" }), { status: "unsupported-platform" })
        assert.equal(loads, 0)
        assert.deepEqual(collectLocationFacts(input, { api: () => { throw new Error("koffi missing") }, platform: "win32", arch: "x64" }), { status: "api-unavailable" })
        if (process.platform !== "win32") assert.deepEqual(collectLocationFacts(input), { status: "unsupported-platform" }, "the default provider is not even created")
    })
})

describe("location-facts: isolation (preparatory only)", () => {
    test("not in the setup helper's closure; no installer file, NSIS script or command refers to the new modules", () => {
        const closure = setupClosure(COMPILED_ROOT)
        for (const file of ["win32-security.js", "location-facts.js", "location.js"]) assert.ok(!closure.some((f) => f.endsWith(file)), file)
        for (const file of ["checks.js", "fr-setup.js", "transaction.js", "uninstall.js", "claude.js", "record.js", "app.js", "protocol.js"]) {
            assert.doesNotMatch(fs.readFileSync(path.join(COMPILED_ROOT, "installer", "setup", file), "utf8"), /win32-security|location-facts/, file)
        }
        assert.doesNotMatch(fs.readFileSync(path.join(REPO_ROOT, "installer", "nsis", "fluent-reader-mcp.nsi"), "utf8"), /win32-security|location-facts/)
        for (const dir of ["src"]) {
            for (const file of fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true }) as string[]) {
                if (file.endsWith(".ts")) assert.doesNotMatch(fs.readFileSync(path.join(REPO_ROOT, dir, file), "utf8"), /win32-security|location-facts/, file)
            }
        }
    })
})
