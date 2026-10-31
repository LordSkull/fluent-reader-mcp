/**
 * FR-MCP-04-BETA-03A2a: read-only Win32 layer that reads what the pure
 * validator (location.ts) needs: drive type and volume properties, a
 * directory's attributes, final path, owner and DACL, a bounded listing of
 * one directory, the current user's SID, known folders, OneDrive account
 * folders, CompareStringOrdinal. It applies NO installation policy: it only
 * distinguishes success, verified absence and failure.
 *
 * PREPARATORY COMPONENT: nothing in the installer calls it (03A3 wires it);
 * the setup helper's closure does not include it.
 *
 * Two levels, both injectable:
 *  - Win32Primitives: one Win32 call each (bindWin32Primitives, Koffi), with
 *    that function's own error convention turned into a Win32Result: BOOL and
 *    HANDLE functions → GetLastError(); GetSecurityInfo → the DWORD it
 *    returns; registry functions → the LSTATUS they return; HRESULT
 *    (SHGetKnownFolderPath) kept as an HRESULT, never mixed with Win32 codes.
 *  - Win32SecurityApi (createWin32SecurityApi): typed readings built on the
 *    primitives. Every native allocation it receives is freed exactly once
 *    (LocalFree, CoTaskMemFree, koffi.free) in a finally, after its last read;
 *    every pointer into a structure is bounds-checked against its allocation
 *    before it is read or passed to a native function that reads it. The one
 *    exception, documented on readWideString, is a NUL-terminated string that
 *    Windows returns without its size: its read is capped, not proven in bounds.
 *
 * Nothing here creates, modifies, renames or deletes anything: CreateFileW
 * always uses OPEN_EXISTING, the only rights requested are READ_CONTROL,
 * FILE_READ_ATTRIBUTES, FILE_LIST_DIRECTORY, TOKEN_QUERY, KEY_QUERY_VALUE and
 * KEY_ENUMERATE_SUB_KEYS; no SACL is read and no privilege is enabled.
 * FILE_FLAG_BACKUP_SEMANTICS is needed to open a directory: it bypasses
 * access checks only if SeBackupPrivilege is ALREADY enabled in the token
 * (it is disabled by default even for administrators, and nothing here
 * enables it). Koffi is loaded only by bindWin32Primitives (lazily, once):
 * importing this module loads no native code.
 *
 * Whose data (process identity): every per-user reading is the view of the
 * CALLING PROCESS. TokenUser is the user of the token queried (the process
 * token, OpenProcessToken(GetCurrentProcess())); HKCU is the hive of the
 * process's identity; known folders (SHGetKnownFolderPath with a NULL token)
 * resolve for that same user. An installer elevated with other credentials
 * (UAC with an administrator account that is not the person installing)
 * therefore reads the elevated account's SID, HKCU, profile, AppData and
 * OneDrive, not those of the user who means to install. Nothing here detects
 * or corrects that (no impersonation, no other token): the integration (03A3)
 * must establish that the process identity is the intended user's before it
 * relies on these readings.
 */

import { createRequire } from "node:module"
import type * as Koffi from "koffi"
import type { AceFacts } from "./location.js"

/** A native pointer (Koffi 3 represents pointers as BigInt); 0n is NULL. */
export type Pointer = bigint
/** A Win32 HANDLE or HKEY (pointer-sized, unsigned). */
export type Handle = bigint

/** ok, or the Win32 error code of the failure (never 0: see NO_WIN32_CODE). */
export type Win32Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: number }

// winerror.h
export const ERROR_FILE_NOT_FOUND = 2
export const ERROR_PATH_NOT_FOUND = 3
export const ERROR_ACCESS_DENIED = 5
export const ERROR_INVALID_DATA = 13
export const ERROR_INVALID_DRIVE = 15
export const ERROR_NO_MORE_FILES = 18
export const ERROR_NOT_READY = 21
export const ERROR_SHARING_VIOLATION = 32
export const ERROR_INVALID_PARAMETER = 87
export const ERROR_INSUFFICIENT_BUFFER = 122
export const ERROR_FILENAME_EXCED_RANGE = 206
export const ERROR_MORE_DATA = 234
export const ERROR_NO_MORE_ITEMS = 259
export const ERROR_INVALID_SID = 1337
/** Not a Win32 code: a call failed but GetLastError() said 0, or returned a value its documentation does not allow. */
export const NO_WIN32_CODE = 0xffffffff

// winnt.h / fileapi.h
const READ_CONTROL = 0x20000
const FILE_LIST_DIRECTORY = 0x1
const FILE_READ_ATTRIBUTES = 0x80
const FILE_SHARE_READ = 0x1
const FILE_SHARE_WRITE = 0x2
const FILE_SHARE_DELETE = 0x4
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
export const FILE_ATTRIBUTE_DIRECTORY = 0x10
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
export const FILE_PERSISTENT_ACLS = 0x8
export const FILE_CS_FLAG_CASE_SENSITIVE_DIR = 0x1
const OWNER_SECURITY_INFORMATION = 0x1
const DACL_SECURITY_INFORMATION = 0x4
const TOKEN_QUERY = 0x8
const TOKEN_USER_CLASS = 1
const KEY_QUERY_VALUE = 0x1
const KEY_ENUMERATE_SUB_KEYS = 0x8
/** KF_FLAG_DONT_VERIFY: return the path without checking (or creating) the folder; KF_FLAG_CREATE is never used. */
export const KF_FLAG_DONT_VERIFY = 0x4000
const S_OK = 0
/** HRESULTs taken as "this known folder is not defined": E_INVALIDARG (documented: the KNOWNFOLDERID is not present on the system), HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND). Any other failure (E_FAIL included) is an error. */
export const KNOWN_FOLDER_NOT_SET: readonly number[] = [0x80070057, 0x80070002, 0x80070003]

/** Largest path a final-path or known-folder answer may have (UTF-16 code units, NUL excluded). */
const MAX_LONG_PATH = 32767

/** Architectures on which the FFI declarations have been verified (as win32-lock.ts). */
export const VERIFIED_ARCHS: readonly string[] = ["x64"]

/** KNOWNFOLDERID values (KnownFolders.h) used by the collector. */
export const KNOWN_FOLDER = {
    Windows: "{F38BF404-1D43-42F2-9305-67DE0B28FC23}",
    ProgramFiles: "{905E63B6-C1BF-494E-B29C-65B732D3D21A}",
    ProgramFilesX86: "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}",
    ProgramData: "{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}",
    UserProfiles: "{0762D272-C50A-4BB0-A382-697DCD729B80}",
    Public: "{DFDF76A2-C82A-4D63-906A-5644AC457385}",
    Profile: "{5E6C858F-0E22-4760-9AFE-EA3317B67173}",
    LocalAppData: "{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}",
    RoamingAppData: "{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}",
    SkyDrive: "{A52BBA46-E9E1-435F-B3D9-28DAA648C0F6}",
} as const
export type KnownFolderId = (typeof KNOWN_FOLDER)[keyof typeof KNOWN_FOLDER]

// ------------------------------------------------------------------ primitives (one Win32 call each)

export interface VolumeInformation {
    readonly fileSystemName: string
    readonly fileSystemFlags: number
    readonly maximumComponentLength: number
    readonly serialNumber: number
}

/**
 * One Win32 call per method; the binding never interprets results beyond the
 * function's documented error convention. Tests replace it with a simulated
 * memory and handle table.
 */
export interface Win32Primitives {
    /** GetDriveTypeW(root): UINT (there is no error code: DRIVE_UNKNOWN 0 and DRIVE_NO_ROOT_DIR 1 are answers). */
    getDriveType(root: string): number
    /** GetVolumeInformationW(root, NULL, 0, &serial, &maxComponentLength, &flags, name, MAX_PATH + 1): BOOL. */
    getVolumeInformation(root: string): Win32Result<VolumeInformation>
    /** CreateFileW(path, access, share, NULL, OPEN_EXISTING, flags, NULL): INVALID_HANDLE_VALUE → GetLastError. */
    createFile(path: string, access: number, share: number, flags: number): Win32Result<Handle>
    /** CloseHandle: 0, or GetLastError. At most once per handle (values are reused). */
    closeHandle(handle: Handle): number
    /** GetFileInformationByHandleEx(FileAttributeTagInfo). */
    getAttributeTag(handle: Handle): Win32Result<{ readonly fileAttributes: number; readonly reparseTag: number }>
    /** GetFileInformationByHandleEx(FileCaseSensitiveInfo): FILE_CASE_SENSITIVE_INFO.Flags. */
    getCaseSensitiveInfo(handle: Handle): Win32Result<number>
    /** GetFileInformationByHandle: dwVolumeSerialNumber. */
    getVolumeSerial(handle: Handle): Win32Result<number>
    /** GetFinalPathNameByHandleW(handle, buf, capacity, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS): 0 → GetLastError; `returned` ≥ capacity is the size needed. */
    getFinalPathName(handle: Handle, capacity: number): Win32Result<{ readonly returned: number; readonly text: string }>
    /** GetFileInformationByHandleEx(restart ? FileFullDirectoryRestartInfo : FileFullDirectoryInfo, buf, capacity): a copy of the buffer. */
    readDirectory(handle: Handle, restart: boolean, capacity: number): Win32Result<Uint8Array>
    /** CompareStringOrdinal(a, a.length, b, b.length, ignoreCase): the raw nonzero result, or 0 → GetLastError. */
    compareStringOrdinal(a: string, b: string, ignoreCase: boolean): Win32Result<number>
    /** GetSecurityInfo(handle, SE_FILE_OBJECT, info, &owner, NULL, &dacl, NULL, &descriptor): the DWORD it returns. */
    getSecurityInfo(handle: Handle, info: number): Win32Result<{ readonly owner: Pointer; readonly dacl: Pointer; readonly descriptor: Pointer }>
    /** GetSecurityDescriptorLength (no error code). */
    getSecurityDescriptorLength(descriptor: Pointer): number
    /** GetSecurityDescriptorDacl: BOOL. */
    getSecurityDescriptorDacl(descriptor: Pointer): Win32Result<{ readonly present: boolean; readonly dacl: Pointer }>
    isValidAcl(acl: Pointer): boolean
    /** GetAclInformation(AclSizeInformation): BOOL. */
    getAclSizeInformation(acl: Pointer): Win32Result<{ readonly aceCount: number; readonly bytesInUse: number }>
    /** GetAce: BOOL. */
    getAce(acl: Pointer, index: number): Win32Result<Pointer>
    isValidSid(sid: Pointer): boolean
    /** GetLengthSid (valid only after IsValidSid). */
    getLengthSid(sid: Pointer): number
    /** ConvertSidToStringSidW: BOOL; the string must be released with LocalFree. */
    convertSidToStringSid(sid: Pointer): Win32Result<Pointer>
    /** LocalFree: 0 when freed, otherwise GetLastError. */
    localFree(memory: Pointer): number
    /** A copy of `length` bytes at `address` (koffi.view): the caller must have checked the bounds. */
    readMemory(address: Pointer, length: number): Uint8Array
    /**
     * A NUL-terminated UTF-16 string that a Windows API returns WITHOUT its size (ConvertSidToStringSidW,
     * SHGetKnownFolderPath): scanWideString over one 2-byte read per code unit, so at most maxChars + 1 units are
     * read and none past the first NUL; null when no NUL comes within that bound. No lstrlenW: its scan has no bound.
     * PRECONDITION, which cannot be checked here (the allocation's size is not returned): the API's documented
     * guarantee that the string is terminated inside its allocation. With it, no byte outside the allocation is
     * read; without it (a corrupt string), the read is still capped at maxChars + 1 units but may cross the
     * allocation's end. Strings in buffers whose size is known (registry, volume name, final path) are decoded from
     * a copy of that size, never through this.
     */
    readWideString(address: Pointer, maxChars: number): string | null
    /** koffi.alloc: stable memory that Win32 may point into after the call. */
    allocate(size: number): Pointer
    /** koffi.free. */
    release(memory: Pointer): void
    /** OpenProcessToken(GetCurrentProcess(), access): BOOL. */
    openProcessToken(access: number): Win32Result<Handle>
    /** GetTokenInformation(token, class, buffer, size, &returnLength): BOOL; returnLength reported on failure too. */
    getTokenInformation(token: Handle, infoClass: number, buffer: Pointer, size: number): { readonly error: number; readonly returnLength: number }
    /** SHGetKnownFolderPath(id, flags, NULL, &path): the HRESULT, and the path pointer to free with CoTaskMemFree in every case. */
    getKnownFolderPath(folderId: KnownFolderId, flags: number): { readonly hresult: number; readonly path: Pointer }
    coTaskMemFree(memory: Pointer): void
    /** RegOpenKeyExW(HKEY_CURRENT_USER, subKey, 0, access): the LSTATUS. */
    regOpenCurrentUserKey(subKey: string, access: number): Win32Result<Handle>
    /** RegEnumKeyExW(key, index, name[256]): the LSTATUS. */
    regEnumKey(key: Handle, index: number): Win32Result<string>
    /** RegGetValueW(key, subKey, value, RRF_RT_REG_SZ, NULL, buf, &capacity): the LSTATUS; on ERROR_MORE_DATA, the size needed. */
    regGetString(key: Handle, subKey: string, valueName: string, capacityBytes: number): Win32Result<string> & { readonly required?: number }
    /** RegCloseKey: the LSTATUS. */
    regCloseKey(key: Handle): number
}

// ------------------------------------------------------------------ pure decoders (synthetic tests feed them bytes)

const u16 = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8)
const u32 = (b: Uint8Array, at: number): number => ((b[at] as number) | ((b[at + 1] as number) << 8) | ((b[at + 2] as number) << 16) | ((b[at + 3] as number) << 24)) >>> 0
const u64 = (b: Uint8Array, at: number): bigint => BigInt(u32(b, at)) | (BigInt(u32(b, at + 4)) << 32n)

/** UTF-16LE code units copied one by one (lone surrogates are kept: a name is compared as Windows stores it). */
function utf16(b: Uint8Array, at: number, units: number): string {
    let s = ""
    for (let i = 0; i < units; i++) s += String.fromCharCode(u16(b, at + 2 * i))
    return s
}

/**
 * A NUL-terminated UTF-16 string read one code unit at a time, readUnit(i) giving the i-th: stops at the first NUL
 * and never asks for a unit past it, nor past index maxChars (at most maxChars + 1 reads); null when no NUL comes
 * within that bound. The bound is applied before any unit is read, never after a scan to the terminator.
 */
export function scanWideString(readUnit: (index: number) => number, maxChars: number): string | null {
    if (!Number.isInteger(maxChars) || maxChars < 0) throw new RangeError("scanWideString: maxChars must be a non-negative integer")
    let s = ""
    for (let i = 0; i <= maxChars; i++) {
        const unit = readUnit(i)
        if (unit === 0) return s
        s += String.fromCharCode(unit)
    }
    return null
}

export interface ParsedSid {
    readonly text: string
    readonly length: number
}

/**
 * A SID (winnt.h SID: Revision 1, SubAuthorityCount ≤ 15, 6-byte big-endian
 * IdentifierAuthority, little-endian SubAuthority[]) within bytes[at, limit),
 * as ConvertSidToStringSidW writes it; null when it does not fit or is not a SID.
 */
export function parseSid(bytes: Uint8Array, at = 0, limit: number = bytes.length): ParsedSid | null {
    if (at < 0 || limit > bytes.length || at + 8 > limit) return null
    const count = bytes[at + 1] as number
    if (bytes[at] !== 1 || count > 15) return null
    const length = 8 + 4 * count
    if (at + length > limit) return null
    let authority = 0
    for (let i = 0; i < 6; i++) authority = authority * 256 + (bytes[at + 2 + i] as number)
    const auth = authority < 2 ** 32 ? String(authority) : `0x${[...bytes.subarray(at + 2, at + 8)].map((x) => x.toString(16).padStart(2, "0")).join("")}`
    const subs: number[] = []
    for (let i = 0; i < count; i++) subs.push(u32(bytes, at + 8 + 4 * i))
    return { text: ["S", "1", auth, ...subs.map(String)].join("-"), length }
}

/** ACE types laid out as ACE_HEADER, Mask, SidStart (callback and resource-attribute types carry data after the SID). */
const SIMPLE_ACE_TYPES: readonly number[] = [0x0, 0x1, 0x2, 0x3, 0x9, 0xa, 0xd, 0xe, 0x11, 0x12, 0x13, 0x14, 0x15]
/** Object ACE types: ACE_HEADER, Mask, Flags, [ObjectType GUID], [InheritedObjectType GUID], SidStart. */
const OBJECT_ACE_TYPES: readonly number[] = [0x5, 0x6, 0x7, 0x8, 0xb, 0xc, 0xf, 0x10]
const ACE_OBJECT_TYPE_PRESENT = 0x1
const ACE_INHERITED_OBJECT_TYPE_PRESENT = 0x2

export interface ParsedAce extends AceFacts {
    /** Offset of the ACE in the ACL. */
    readonly offset: number
    /** Offset of its SID in the ACE. */
    readonly sidOffset: number
}

/** bytesInUse: where the AceCount ACEs end (header + their sizes, contiguous); AclSize − bytesInUse is free space. */
export type ParsedAcl = { readonly ok: true; readonly aces: readonly ParsedAce[]; readonly bytesInUse: number } | { readonly ok: false; readonly cause: "malformed" | "unsupported-ace-layout" }

/**
 * Every ACE of an ACL copied whole (bytes.length = AclSize), unchanged: type,
 * flags, mask, SID. An ACE whose layout is not known (ACCESS_ALLOWED_COMPOUND,
 * any type above 0x15) cannot be decoded: the whole ACL is reported as such,
 * never as the ACEs that could be read. Bounds: the ACL header's size must be
 * the buffer's, each ACE (DWORD-aligned) must lie inside it, each SID inside its
 * ACE. Space after the last ACE is free space, which Windows allows: not read.
 */
export function parseAcl(bytes: Uint8Array): ParsedAcl {
    if (bytes.length < 8) return { ok: false, cause: "malformed" }
    const revision = bytes[0] as number
    if ((revision !== 2 && revision !== 4) || u16(bytes, 2) !== bytes.length) return { ok: false, cause: "malformed" }
    const count = u16(bytes, 4)
    const aces: ParsedAce[] = []
    let offset = 8
    for (let i = 0; i < count; i++) {
        if (offset + 4 > bytes.length) return { ok: false, cause: "malformed" }
        const aceType = bytes[offset] as number
        const aceFlags = bytes[offset + 1] as number
        const size = u16(bytes, offset + 2)
        if (size < 16 || size % 4 !== 0 || offset + size > bytes.length) return { ok: false, cause: "malformed" }
        const ace = bytes.subarray(offset, offset + size)
        let sidOffset: number
        if (SIMPLE_ACE_TYPES.includes(aceType)) sidOffset = 8
        else if (OBJECT_ACE_TYPES.includes(aceType)) {
            const flags = u32(ace, 8)
            if ((flags & ~(ACE_OBJECT_TYPE_PRESENT | ACE_INHERITED_OBJECT_TYPE_PRESENT)) !== 0) return { ok: false, cause: "malformed" }
            sidOffset = 12 + ((flags & ACE_OBJECT_TYPE_PRESENT) !== 0 ? 16 : 0) + ((flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) !== 0 ? 16 : 0)
        } else return { ok: false, cause: "unsupported-ace-layout" }
        const sid = parseSid(ace, sidOffset, size)
        if (sid === null) return { ok: false, cause: "malformed" }
        aces.push({ aceType, aceFlags, accessMask: u32(ace, 4), sid: sid.text, offset, sidOffset })
        offset += size
    }
    return { ok: true, aces, bytesInUse: offset }
}

/** FILE_FULL_DIR_INFO (x64): NextEntryOffset 0, FileAttributes 56, FileNameLength 60 (bytes), FileName 68. */
const DIR_NAME_OFFSET = 68

/**
 * The names in one FileFullDirectoryInfo buffer, or null when a record does
 * not fit the buffer, overlaps the next one or has an odd or empty name. "."
 * and ".." are returned like any other name (the caller drops them).
 */
export function parseDirectoryBuffer(bytes: Uint8Array): string[] | null {
    const names: string[] = []
    let offset = 0
    for (;;) {
        if (offset + DIR_NAME_OFFSET > bytes.length) return null
        const next = u32(bytes, offset)
        const nameLength = u32(bytes, offset + 60)
        if (nameLength === 0 || nameLength % 2 !== 0 || offset + DIR_NAME_OFFSET + nameLength > bytes.length) return null
        names.push(utf16(bytes, offset + DIR_NAME_OFFSET, nameLength / 2))
        if (next === 0) return names
        if (next % 8 !== 0 || next < DIR_NAME_OFFSET + nameLength) return null
        offset += next
    }
}

/** What GetFinalPathNameByHandleW(VOLUME_NAME_DOS) returned: a drive path, or a namespace the installer does not support. */
export type FinalPathForm =
    | { readonly kind: "drive"; readonly path: string; readonly root: string; readonly segments: readonly string[] }
    | { readonly kind: "unc" | "volume-guid" | "other" }

/**
 * The ONLY place where "\\?\" is removed, and only from a string Windows
 * returned (user input with that prefix is refused before any API call):
 * "\\?\X:\" becomes "X:\", "\\?\X:\a\b" becomes "X:\a\b". "\\?\UNC\..." (a
 * network path), "\\?\Volume{...}" (a volume without a drive letter) and
 * anything else are reported as such, never turned into a drive path.
 */
export function dosPathFromFinalPath(raw: string): FinalPathForm {
    if (!raw.startsWith("\\\\?\\")) return { kind: "other" }
    const rest = raw.slice(4)
    if (/^UNC\\/i.test(rest)) return { kind: "unc" }
    if (/^Volume\{/i.test(rest)) return { kind: "volume-guid" }
    const m = /^([A-Za-z]):\\([\s\S]*)$/.exec(rest)
    if (m === null || raw.includes("\0") || raw.includes("/")) return { kind: "other" }
    const root = `${m[1] as string}:\\`
    const tail = m[2] as string
    const segments = tail === "" ? [] : tail.split("\\")
    if (segments.some((s) => s === "" || s === "." || s === "..")) return { kind: "other" }
    return { kind: "drive", path: root + segments.join("\\"), root, segments }
}

// ------------------------------------------------------------------ typed readings (Win32SecurityApi)

/** An owner or ACE SID: read and cross-checked (bytes decoded here = ConvertSidToStringSidW), or why not. */
export type SidReading = { readonly ok: true; readonly sid: string } | { readonly ok: false; readonly cause: "absent" | "out-of-bounds" | "invalid" | "conversion-failed" | "mismatch" }

/**
 * The four DACL states Windows distinguishes. "absent" (SE_DACL_PRESENT not
 * set) and "null" (present, NULL pointer) both grant everyone full access;
 * "present" with no ACE grants nothing; "unreadable" is never an empty DACL.
 */
export type DaclReading =
    | { readonly kind: "present"; readonly aces: readonly AceFacts[] }
    | { readonly kind: "null" }
    | { readonly kind: "absent" }
    | { readonly kind: "unreadable"; readonly cause: string }

export interface SecurityReading {
    readonly owner: SidReading
    readonly dacl: DaclReading
}

/** "inconsistent": the enumeration returned the same name twice ("." and ".." included), which no directory holds. */
export type DirectoryListing =
    | { readonly kind: "complete"; readonly entries: readonly string[] }
    | { readonly kind: "truncated" }
    | { readonly kind: "malformed" }
    | { readonly kind: "inconsistent" }
    | { readonly kind: "error"; readonly error: number }

export interface ListingLimits {
    readonly maxEntries: number
    readonly maxCalls: number
    readonly bufferBytes: number
}

export type KnownFolderReading = { readonly kind: "path"; readonly path: string } | { readonly kind: "not-set"; readonly hresult: number } | { readonly kind: "error"; readonly hresult: number }

/** HKCU\Software\Microsoft\OneDrive\Accounts: key absent, or the UserFolder of each account that has one, or unreadable. */
export type OneDriveAccountsReading = { readonly kind: "no-accounts-key" } | { readonly kind: "accounts"; readonly folders: readonly string[] } | { readonly kind: "unreadable"; readonly error: number }

export type OrdinalComparison = "less" | "equal" | "greater"

/** A native memory or handle could not be released: the reading it belongs to is not trusted. */
export class NativeReleaseError extends Error {
    constructor(readonly operation: string, readonly code: number) {
        super(`${operation} failed`)
    }
}

export interface Win32SecurityApi {
    /** GetDriveTypeW on an explicit "X:\" root (never NULL: no implicit current directory). */
    driveType(root: string): number
    volumeInformation(root: string): Win32Result<VolumeInformation>
    /**
     * A component of the destination path, NOT following a final reparse
     * point (FILE_FLAG_OPEN_REPARSE_POINT), with READ_CONTROL and
     * FILE_READ_ATTRIBUTES (+ FILE_LIST_DIRECTORY when list). Shared for read
     * and write but NOT for delete: while the handle is open nobody can open
     * the directory for DELETE, so it cannot be renamed, moved or removed; a
     * handle already open for DELETE makes this fail (ERROR_SHARING_VIOLATION).
     */
    openComponent(path: string, list: boolean): Win32Result<Handle>
    /** A probe with FILE_READ_ATTRIBUTES only, shared for everything (nothing is pinned); follow = through reparse points. */
    openProbe(path: string, follow: boolean): Win32Result<Handle>
    /** CloseHandle: 0 or the error. */
    close(handle: Handle): number
    /** Directory flag, and the reparse tag when FILE_ATTRIBUTE_REPARSE_POINT is set (even a 0 tag: never taken as "no reparse point"). */
    attributes(handle: Handle): Win32Result<{ readonly isDirectory: boolean; readonly reparseTag: number | null }>
    caseSensitiveDirectory(handle: Handle): Win32Result<boolean>
    volumeSerial(handle: Handle): Win32Result<number>
    /** The raw final path (with Windows' "\\?\" prefix): convert it with dosPathFromFinalPath. */
    finalPath(handle: Handle): Win32Result<string>
    security(handle: Handle): SecurityReading
    listDirectory(handle: Handle, limits: ListingLimits): DirectoryListing
    /** Whether `name` exists directly in the directory whose raw final path is `rawParent` (no link followed). */
    probeChild(rawParent: string, name: string): Win32Result<"present" | "absent">
    currentUserSid(): Win32Result<string>
    knownFolder(id: KnownFolderId): KnownFolderReading
    oneDriveAccounts(maxAccounts: number): OneDriveAccountsReading
    /** CompareStringOrdinal; the ordinal case mapping is Windows', never toLowerCase/toUpperCase. */
    compareOrdinal(a: string, b: string, ignoreCase: boolean): Win32Result<OrdinalComparison>
}

const fail = (error: number): { readonly ok: false; readonly error: number } => ({ ok: false, error: error === 0 ? NO_WIN32_CODE : error })

/** winnt.h: SID_REVISION, SID_MAX_SUB_AUTHORITIES; a SID is an 8-byte header and 4 bytes per sub-authority. */
const SID_REVISION = 1
const SID_MAX_SUB_AUTHORITIES = 15
const SID_HEADER = 8
/** sizeof(ACL); the smallest ACE is ACE_HEADER + Mask + an 8-byte SID. */
const ACL_HEADER = 8
const MIN_ACE_SIZE = 16

/**
 * Every SID read, inside [start, end): the allocation that holds it. IsValidSid and GetLengthSid read the whole SID
 * and are NOT a bounds check, so before either sees the pointer: the 8-byte header must fit, its SubAuthorityCount
 * must be ≤ 15, and the length that count gives (≤ 68 bytes) must fit too. Then IsValidSid, GetLengthSid equal to
 * that length, and the bytes decoded here and by ConvertSidToStringSidW must agree.
 */
function readSid(p: Win32Primitives, sid: Pointer, start: Pointer, end: Pointer): SidReading {
    if (sid === 0n) return { ok: false, cause: "absent" }
    if (sid < start || sid + BigInt(SID_HEADER) > end) return { ok: false, cause: "out-of-bounds" }
    const header = p.readMemory(sid, SID_HEADER)
    const count = header[1] as number
    if (header[0] !== SID_REVISION || count > SID_MAX_SUB_AUTHORITIES) return { ok: false, cause: "invalid" }
    const length = SID_HEADER + 4 * count
    if (sid + BigInt(length) > end) return { ok: false, cause: "out-of-bounds" }
    if (!p.isValidSid(sid)) return { ok: false, cause: "invalid" }
    if (p.getLengthSid(sid) !== length) return { ok: false, cause: "invalid" }
    const parsed = parseSid(p.readMemory(sid, length), 0, length)
    if (parsed === null || parsed.length !== length) return { ok: false, cause: "invalid" }
    const converted = p.convertSidToStringSid(sid)
    if (!converted.ok || converted.value === 0n) return { ok: false, cause: "conversion-failed" }
    let text: string | null
    let freed: number
    try {
        text = p.readWideString(converted.value, 200)
    } finally {
        freed = p.localFree(converted.value)
    }
    if (freed !== 0) throw new NativeReleaseError("LocalFree", freed)
    if (text === null) return { ok: false, cause: "conversion-failed" }
    return text === parsed.text ? { ok: true, sid: text } : { ok: false, cause: "mismatch" }
}

function readDacl(p: Win32Primitives, descriptor: Pointer, end: Pointer, reported: Pointer): DaclReading {
    const got = p.getSecurityDescriptorDacl(descriptor)
    if (!got.ok) return { kind: "unreadable", cause: "query-failed" }
    if (!got.value.present) return { kind: "absent" }
    const dacl = got.value.dacl
    if (dacl === 0n) return reported === 0n ? { kind: "null" } : { kind: "unreadable", cause: "mismatch" }
    if (dacl !== reported) return { kind: "unreadable", cause: "mismatch" }
    // IsValidAcl walks the ACEs up to the AclSize it finds in the header: it is not a bounds check either. The header,
    // then the whole region AclSize declares, must lie inside the descriptor before it is called.
    if (dacl < descriptor || dacl + BigInt(ACL_HEADER) > end) return { kind: "unreadable", cause: "out-of-bounds" }
    const header = p.readMemory(dacl, ACL_HEADER)
    const size = u16(header, 2)
    if (size < ACL_HEADER || ACL_HEADER + MIN_ACE_SIZE * u16(header, 4) > size) return { kind: "unreadable", cause: "malformed" }
    if (dacl + BigInt(size) > end) return { kind: "unreadable", cause: "out-of-bounds" }
    if (!p.isValidAcl(dacl)) return { kind: "unreadable", cause: "invalid" }
    const info = p.getAclSizeInformation(dacl)
    if (!info.ok) return { kind: "unreadable", cause: "query-failed" }
    const parsed = parseAcl(p.readMemory(dacl, size))
    if (!parsed.ok) return { kind: "unreadable", cause: parsed.cause }
    // AclBytesInUse is where the first free ACE would go (RtlFirstFreeAce): the end of the AceCount ACEs, contiguous
    // from the header. Space after them, up to AclSize, is free space Windows allows: AclSize itself is not required.
    if (info.value.aceCount !== parsed.aces.length || info.value.bytesInUse !== parsed.bytesInUse) return { kind: "unreadable", cause: "inconsistent" }
    const aces: AceFacts[] = []
    for (const [index, ace] of parsed.aces.entries()) {
        const at = p.getAce(dacl, index)
        if (!at.ok) return { kind: "unreadable", cause: "query-failed" }
        if (at.value !== dacl + BigInt(ace.offset)) return { kind: "unreadable", cause: "mismatch" }
        const aceEnd = at.value + BigInt(u16(p.readMemory(at.value, 4), 2))
        const sid = readSid(p, at.value + BigInt(ace.sidOffset), at.value, aceEnd)
        if (!sid.ok) return { kind: "unreadable", cause: `sid-${sid.cause}` }
        if (sid.sid !== ace.sid) return { kind: "unreadable", cause: "mismatch" }
        aces.push({ aceType: ace.aceType, aceFlags: ace.aceFlags, accessMask: ace.accessMask, sid: ace.sid })
    }
    return { kind: "present", aces }
}

/** Owner and DACL (no group, no SACL); the descriptor is released with LocalFree exactly once, after the last read. */
function readSecurity(p: Win32Primitives, handle: Handle): SecurityReading {
    const got = p.getSecurityInfo(handle, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION)
    if (!got.ok || got.value.descriptor === 0n) return { owner: { ok: false, cause: "absent" }, dacl: { kind: "unreadable", cause: "query-failed" } }
    const { descriptor, owner, dacl } = got.value
    let reading: SecurityReading
    let freed: number
    try {
        const end = descriptor + BigInt(p.getSecurityDescriptorLength(descriptor))
        reading = { owner: readSid(p, owner, descriptor, end), dacl: readDacl(p, descriptor, end, dacl) }
    } finally {
        freed = p.localFree(descriptor)
    }
    if (freed !== 0) throw new NativeReleaseError("LocalFree", freed)
    return reading
}

function listDirectory(p: Win32Primitives, handle: Handle, limits: ListingLimits): DirectoryListing {
    const entries: string[] = []
    // exact UTF-16 names: two names that differ only in case can coexist in a case-sensitive directory, the same name cannot
    const seen = new Set<string>()
    for (let call = 0; call < limits.maxCalls; call++) {
        const r = p.readDirectory(handle, call === 0, limits.bufferBytes)
        if (!r.ok) return r.error === ERROR_NO_MORE_FILES ? { kind: "complete", entries } : { kind: "error", error: r.error }
        const names = parseDirectoryBuffer(r.value)
        if (names === null) return { kind: "malformed" }
        for (const name of names) {
            if (seen.has(name)) return { kind: "inconsistent" }
            seen.add(name)
            if (name === "." || name === "..") continue
            entries.push(name)
            if (entries.length > limits.maxEntries) return { kind: "truncated" }
        }
    }
    return { kind: "truncated" }
}

/** The user of THIS process's token (see "Whose data" above): not necessarily the person who means to install. */
function currentUserSid(p: Win32Primitives): Win32Result<string> {
    const token = p.openProcessToken(TOKEN_QUERY)
    if (!token.ok) return token
    let result: Win32Result<string>
    let closed: number
    try {
        const probe = p.getTokenInformation(token.value, TOKEN_USER_CLASS, 0n, 0)
        // TOKEN_USER (x64): PSID Sid at 0, DWORD Attributes at 8, the SID itself after it, all in the same buffer
        if (probe.error !== ERROR_INSUFFICIENT_BUFFER || probe.returnLength < 24 || probe.returnLength > 4096) {
            result = fail(probe.error)
        } else {
            const size = probe.returnLength
            const buffer = p.allocate(size)
            try {
                const got = p.getTokenInformation(token.value, TOKEN_USER_CLASS, buffer, size)
                if (got.error !== 0) result = fail(got.error)
                else {
                    const sidPointer = u64(p.readMemory(buffer, 16), 0)
                    const sid = readSid(p, sidPointer, buffer + 16n, buffer + BigInt(size))
                    result = sid.ok ? { ok: true, value: sid.sid } : fail(ERROR_INVALID_SID)
                }
            } finally {
                p.release(buffer)
            }
        }
    } finally {
        closed = p.closeHandle(token.value)
    }
    if (closed !== 0) throw new NativeReleaseError("CloseHandle", closed)
    return result
}

function knownFolder(p: Win32Primitives, id: KnownFolderId): KnownFolderReading {
    const r = p.getKnownFolderPath(id, KF_FLAG_DONT_VERIFY)
    const hresult = r.hresult >>> 0
    try {
        if (hresult === S_OK) {
            const text = r.path === 0n ? null : p.readWideString(r.path, MAX_LONG_PATH)
            return text === null || text.length === 0 ? { kind: "error", hresult } : { kind: "path", path: text }
        }
        return KNOWN_FOLDER_NOT_SET.includes(hresult) ? { kind: "not-set", hresult } : { kind: "error", hresult }
    } finally {
        // documented: the buffer is freed with CoTaskMemFree whether the call succeeded or not
        if (r.path !== 0n) p.coTaskMemFree(r.path)
    }
}

const ONEDRIVE_ACCOUNTS = "Software\\Microsoft\\OneDrive\\Accounts"

/** One key, its direct subkeys and their UserFolder value: no other part of the registry is read. */
function oneDriveAccounts(p: Win32Primitives, maxAccounts: number): OneDriveAccountsReading {
    const opened = p.regOpenCurrentUserKey(ONEDRIVE_ACCOUNTS, KEY_QUERY_VALUE | KEY_ENUMERATE_SUB_KEYS)
    if (!opened.ok) return opened.error === ERROR_FILE_NOT_FOUND ? { kind: "no-accounts-key" } : { kind: "unreadable", error: opened.error }
    let reading: OneDriveAccountsReading | null = null
    let closed: number
    try {
        const folders: string[] = []
        for (let index = 0; reading === null; index++) {
            const name = p.regEnumKey(opened.value, index)
            if (!name.ok) {
                reading = name.error === ERROR_NO_MORE_ITEMS ? { kind: "accounts", folders } : { kind: "unreadable", error: name.error }
                break
            }
            // more accounts than the bound: not all of them would be read
            if (index === maxAccounts) {
                reading = { kind: "unreadable", error: ERROR_MORE_DATA }
                break
            }
            let value = p.regGetString(opened.value, name.value, "UserFolder", 1024)
            if (!value.ok && value.error === ERROR_MORE_DATA && value.required !== undefined && value.required <= 65536) value = p.regGetString(opened.value, name.value, "UserFolder", value.required)
            if (!value.ok) {
                if (value.error !== ERROR_FILE_NOT_FOUND) reading = { kind: "unreadable", error: value.error }
                continue
            }
            if (value.value.length === 0) reading = { kind: "unreadable", error: ERROR_INVALID_DATA }
            else folders.push(value.value)
        }
    } finally {
        closed = p.regCloseKey(opened.value)
    }
    if (closed !== 0) throw new NativeReleaseError("RegCloseKey", closed)
    return reading ?? { kind: "unreadable", error: NO_WIN32_CODE }
}

const CSTR = { 1: "less", 2: "equal", 3: "greater" } as const

/** The typed readings over a set of primitives (the Koffi binding, or a simulation in tests). */
export function createWin32SecurityApi(p: Win32Primitives): Win32SecurityApi {
    return {
        driveType(root) {
            if (!/^[A-Z]:\\$/.test(root)) throw new TypeError("driveType: an explicit X:\\ root is required")
            return p.getDriveType(root)
        },
        volumeInformation(root) {
            if (!/^[A-Z]:\\$/.test(root)) throw new TypeError("volumeInformation: an explicit X:\\ root is required")
            return p.getVolumeInformation(root)
        },
        openComponent(path, list) {
            return p.createFile(path, READ_CONTROL | FILE_READ_ATTRIBUTES | (list ? FILE_LIST_DIRECTORY : 0), FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        },
        openProbe(path, follow) {
            return p.createFile(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_FLAG_BACKUP_SEMANTICS | (follow ? 0 : FILE_FLAG_OPEN_REPARSE_POINT))
        },
        close(handle) {
            return p.closeHandle(handle)
        },
        attributes(handle) {
            const r = p.getAttributeTag(handle)
            if (!r.ok) return r
            const reparse = (r.value.fileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
            return { ok: true, value: { isDirectory: (r.value.fileAttributes & FILE_ATTRIBUTE_DIRECTORY) !== 0, reparseTag: reparse ? r.value.reparseTag >>> 0 : null } }
        },
        caseSensitiveDirectory(handle) {
            const r = p.getCaseSensitiveInfo(handle)
            return r.ok ? { ok: true, value: (r.value & FILE_CS_FLAG_CASE_SENSITIVE_DIR) !== 0 } : r
        },
        volumeSerial(handle) {
            return p.getVolumeSerial(handle)
        },
        finalPath(handle) {
            let capacity = 512
            for (let attempt = 0; attempt < 2; attempt++) {
                const r = p.getFinalPathName(handle, capacity)
                if (!r.ok) return r
                if (r.value.returned < capacity) return r.value.text.length === r.value.returned ? { ok: true, value: r.value.text } : fail(ERROR_INVALID_DATA)
                if (r.value.returned > MAX_LONG_PATH + 1) return fail(ERROR_FILENAME_EXCED_RANGE)
                capacity = r.value.returned
            }
            // the path grew between the two calls
            return fail(ERROR_INSUFFICIENT_BUFFER)
        },
        security(handle) {
            return readSecurity(p, handle)
        },
        listDirectory(handle, limits) {
            return listDirectory(p, handle, limits)
        },
        probeChild(rawParent, name) {
            if (!rawParent.startsWith("\\\\?\\") || !/^[^\\/:*?"<>|\0]+$/.test(name)) throw new TypeError("probeChild: a final path returned by Windows and a plain name are required")
            const opened = p.createFile(`${rawParent}${rawParent.endsWith("\\") ? "" : "\\"}${name}`, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            if (!opened.ok) return opened.error === ERROR_FILE_NOT_FOUND ? { ok: true, value: "absent" } : opened
            const closed = p.closeHandle(opened.value)
            if (closed !== 0) throw new NativeReleaseError("CloseHandle", closed)
            return { ok: true, value: "present" }
        },
        currentUserSid() {
            return currentUserSid(p)
        },
        knownFolder(id) {
            return knownFolder(p, id)
        },
        oneDriveAccounts(maxAccounts) {
            return oneDriveAccounts(p, maxAccounts)
        },
        compareOrdinal(a, b, ignoreCase) {
            if (a.includes("\0") || b.includes("\0") || a.length > MAX_LONG_PATH || b.length > MAX_LONG_PATH) return fail(ERROR_INVALID_PARAMETER)
            const r = p.compareStringOrdinal(a, b, ignoreCase)
            if (!r.ok) return r
            const value = CSTR[r.value as 1 | 2 | 3] as OrdinalComparison | undefined
            return value === undefined ? fail(NO_WIN32_CODE) : { ok: true, value }
        },
    }
}

// ------------------------------------------------------------------ Koffi binding (loaded on first use only)

let primitives: Win32Primitives | undefined

/** The real primitives, created once per process. Throws if Koffi or a DLL cannot be loaded, or a layout check fails. */
export function bindWin32Primitives(): Win32Primitives {
    primitives ??= createPrimitives()
    return primitives
}

function guidFields(text: string): Record<string, unknown> {
    const m = /^\{([0-9A-F]{8})-([0-9A-F]{4})-([0-9A-F]{4})-([0-9A-F]{4})-([0-9A-F]{12})\}$/i.exec(text)
    if (m === null) throw new TypeError("malformed GUID")
    const tail = `${m[4] as string}${m[5] as string}`
    return { Data1: parseInt(m[1] as string, 16), Data2: parseInt(m[2] as string, 16), Data3: parseInt(m[3] as string, 16), Data4: [...Array(8).keys()].map((i) => parseInt(tail.slice(2 * i, 2 * i + 2), 16)) }
}

function createPrimitives(): Win32Primitives {
    const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi
    const kernel32 = koffi.load("kernel32.dll")
    const advapi32 = koffi.load("advapi32.dll")
    const shell32 = koffi.load("shell32.dll")
    const ole32 = koffi.load("ole32.dll")

    // Anonymous types (Koffi type names are global to the process). HANDLE/HKEY/PVOID: 8 bytes on x64, BigInt.
    const HANDLE = koffi.pointer(koffi.opaque())
    if (koffi.sizeof(HANDLE) !== 8 || koffi.sizeof("void *") !== 8) throw new Error("unexpected pointer size")
    const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn
    // HKEY_CURRENT_USER = (HKEY)(ULONG_PTR)((LONG)0x80000001): sign-extended to 64 bits
    const HKEY_CURRENT_USER = 0xffff_ffff_8000_0001n
    const GUID = koffi.struct({ Data1: "uint32_t", Data2: "uint16_t", Data3: "uint16_t", Data4: koffi.array("uint8_t", 8) })
    if (koffi.sizeof(GUID) !== 16) throw new Error("unexpected GUID layout")
    const outPointer = koffi.out(koffi.pointer("void *"))
    const outDword = koffi.out(koffi.pointer("uint32_t"))
    const inoutDword = koffi.inout(koffi.pointer("uint32_t"))

    // WINAPI is __stdcall; on x64 there is a single calling convention and Koffi ignores the tag.
    type NativeFn = (...args: unknown[]) => unknown
    const fn = (lib: Koffi.LibraryHandle, name: string, result: unknown, args: unknown[]): NativeFn => lib.func("__stdcall", name, result as never, args as never) as NativeFn
    const GetLastError = fn(kernel32, "GetLastError", "uint32_t", [])
    const GetDriveTypeW = fn(kernel32, "GetDriveTypeW", "uint32_t", ["str16"])
    const GetVolumeInformationW = fn(kernel32, "GetVolumeInformationW", "int", ["str16", "void *", "uint32_t", outDword, outDword, outDword, "void *", "uint32_t"])
    const CreateFileW = fn(kernel32, "CreateFileW", HANDLE, ["str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", HANDLE])
    const CloseHandle = fn(kernel32, "CloseHandle", "int", [HANDLE])
    const GetFileInformationByHandleEx = fn(kernel32, "GetFileInformationByHandleEx", "int", [HANDLE, "int", "void *", "uint32_t"])
    const GetFileInformationByHandle = fn(kernel32, "GetFileInformationByHandle", "int", [HANDLE, "void *"])
    const GetFinalPathNameByHandleW = fn(kernel32, "GetFinalPathNameByHandleW", "uint32_t", [HANDLE, "void *", "uint32_t", "uint32_t"])
    const CompareStringOrdinal = fn(kernel32, "CompareStringOrdinal", "int", ["str16", "int", "str16", "int", "int"])
    const LocalFree = fn(kernel32, "LocalFree", "void *", ["void *"])
    const GetCurrentProcess = fn(kernel32, "GetCurrentProcess", HANDLE, [])
    const GetSecurityInfo = fn(advapi32, "GetSecurityInfo", "uint32_t", [HANDLE, "int", "uint32_t", outPointer, "void *", outPointer, "void *", outPointer])
    const GetSecurityDescriptorLength = fn(advapi32, "GetSecurityDescriptorLength", "uint32_t", ["void *"])
    const GetSecurityDescriptorDacl = fn(advapi32, "GetSecurityDescriptorDacl", "int", ["void *", koffi.out(koffi.pointer("int")), outPointer, koffi.out(koffi.pointer("int"))])
    const IsValidAcl = fn(advapi32, "IsValidAcl", "int", ["void *"])
    const GetAclInformation = fn(advapi32, "GetAclInformation", "int", ["void *", "void *", "uint32_t", "int"])
    const GetAce = fn(advapi32, "GetAce", "int", ["void *", "uint32_t", outPointer])
    const IsValidSid = fn(advapi32, "IsValidSid", "int", ["void *"])
    const GetLengthSid = fn(advapi32, "GetLengthSid", "uint32_t", ["void *"])
    const ConvertSidToStringSidW = fn(advapi32, "ConvertSidToStringSidW", "int", ["void *", outPointer])
    const OpenProcessToken = fn(advapi32, "OpenProcessToken", "int", [HANDLE, "uint32_t", koffi.out(koffi.pointer(HANDLE))])
    const GetTokenInformation = fn(advapi32, "GetTokenInformation", "int", [HANDLE, "int", "void *", "uint32_t", outDword])
    const RegOpenKeyExW = fn(advapi32, "RegOpenKeyExW", "int32_t", [HANDLE, "str16", "uint32_t", "uint32_t", koffi.out(koffi.pointer(HANDLE))])
    const RegEnumKeyExW = fn(advapi32, "RegEnumKeyExW", "int32_t", [HANDLE, "uint32_t", "void *", inoutDword, "void *", "void *", "void *", "void *"])
    const RegGetValueW = fn(advapi32, "RegGetValueW", "int32_t", [HANDLE, "str16", "str16", "uint32_t", "void *", "void *", inoutDword])
    const RegCloseKey = fn(advapi32, "RegCloseKey", "int32_t", [HANDLE])
    const SHGetKnownFolderPath = fn(shell32, "SHGetKnownFolderPath", "int32_t", [koffi.pointer(GUID), "uint32_t", HANDLE, outPointer])
    const CoTaskMemFree = fn(ole32, "CoTaskMemFree", "void", ["void *"])

    // Koffi saves the thread's last-error value after each call and restores it before the next one.
    const lastError = (): number => (GetLastError() as number) || NO_WIN32_CODE
    const pointer = (v: unknown): Pointer => {
        if (v === null || v === undefined) return 0n
        if (typeof v === "bigint") return v
        throw new TypeError("unexpected pointer value")
    }
    const buffer = (bytes: number): Buffer => Buffer.alloc(bytes)
    const zString = (b: Buffer, maxUnits: number): string => {
        let units = 0
        while (units < maxUnits && b.readUInt16LE(2 * units) !== 0) units++
        return utf16(b, 0, units)
    }
    const ATTRIBUTE_TAG_INFO = 9
    const CASE_SENSITIVE_INFO = 23
    const FULL_DIRECTORY_INFO = 14
    const FULL_DIRECTORY_RESTART_INFO = 15
    const OPEN_EXISTING = 3
    const SE_FILE_OBJECT = 1
    const ACL_SIZE_INFORMATION = 2
    const RRF_RT_REG_SZ = 0x2
    const MAX_PATH = 260

    return {
        getDriveType: (root) => GetDriveTypeW(root) as number,
        getVolumeInformation(root) {
            const serial = [0], maxComponent = [0], flags = [0]
            const name = buffer(2 * (MAX_PATH + 1))
            if (!GetVolumeInformationW(root, null, 0, serial, maxComponent, flags, name, MAX_PATH + 1)) return fail(lastError())
            return { ok: true, value: { fileSystemName: zString(name, MAX_PATH + 1), fileSystemFlags: (flags[0] as number) >>> 0, maximumComponentLength: (maxComponent[0] as number) >>> 0, serialNumber: (serial[0] as number) >>> 0 } }
        },
        createFile(path, access, share, flags) {
            const h = CreateFileW(path, access, share, null, OPEN_EXISTING, flags, null) as unknown
            if (typeof h !== "bigint" || h === INVALID_HANDLE_VALUE || h === 0n) return fail(lastError())
            return { ok: true, value: h }
        },
        closeHandle: (h) => (CloseHandle(h) ? 0 : lastError()),
        getAttributeTag(h) {
            const b = buffer(8)
            if (!GetFileInformationByHandleEx(h, ATTRIBUTE_TAG_INFO, b, 8)) return fail(lastError())
            return { ok: true, value: { fileAttributes: b.readUInt32LE(0), reparseTag: b.readUInt32LE(4) } }
        },
        getCaseSensitiveInfo(h) {
            const b = buffer(4)
            return GetFileInformationByHandleEx(h, CASE_SENSITIVE_INFO, b, 4) ? { ok: true, value: b.readUInt32LE(0) } : fail(lastError())
        },
        getVolumeSerial(h) {
            // BY_HANDLE_FILE_INFORMATION: 52 bytes, dwVolumeSerialNumber at 28 (as verified in win32-lock.ts)
            const b = buffer(52)
            return GetFileInformationByHandle(h, b) ? { ok: true, value: b.readUInt32LE(28) } : fail(lastError())
        },
        getFinalPathName(h, capacity) {
            const b = buffer(2 * capacity)
            const returned = GetFinalPathNameByHandleW(h, b, capacity, 0) as number
            if (returned === 0) return fail(lastError())
            return { ok: true, value: { returned, text: returned < capacity ? utf16(b, 0, returned) : "" } }
        },
        readDirectory(h, restart, capacity) {
            const b = buffer(capacity)
            if (!GetFileInformationByHandleEx(h, restart ? FULL_DIRECTORY_RESTART_INFO : FULL_DIRECTORY_INFO, b, capacity)) return fail(lastError())
            return { ok: true, value: new Uint8Array(b) }
        },
        compareStringOrdinal(a, b, ignoreCase) {
            const r = CompareStringOrdinal(a, a.length, b, b.length, ignoreCase ? 1 : 0) as number
            return r === 0 ? fail(lastError()) : { ok: true, value: r }
        },
        getSecurityInfo(h, info) {
            const owner: unknown[] = [null], dacl: unknown[] = [null], descriptor: unknown[] = [null]
            const status = GetSecurityInfo(h, SE_FILE_OBJECT, info, owner, null, dacl, null, descriptor) as number
            if (status !== 0) return fail(status)
            return { ok: true, value: { owner: pointer(owner[0]), dacl: pointer(dacl[0]), descriptor: pointer(descriptor[0]) } }
        },
        getSecurityDescriptorLength: (sd) => GetSecurityDescriptorLength(sd) as number,
        getSecurityDescriptorDacl(sd) {
            const present = [0], dacl: unknown[] = [null], defaulted = [0]
            if (!GetSecurityDescriptorDacl(sd, present, dacl, defaulted)) return fail(lastError())
            return { ok: true, value: { present: present[0] !== 0, dacl: pointer(dacl[0]) } }
        },
        isValidAcl: (acl) => IsValidAcl(acl) !== 0,
        getAclSizeInformation(acl) {
            // ACL_SIZE_INFORMATION: AceCount, AclBytesInUse, AclBytesFree (3 DWORDs)
            const b = buffer(12)
            return GetAclInformation(acl, b, 12, ACL_SIZE_INFORMATION) ? { ok: true, value: { aceCount: b.readUInt32LE(0), bytesInUse: b.readUInt32LE(4) } } : fail(lastError())
        },
        getAce(acl, index) {
            const ace: unknown[] = [null]
            return GetAce(acl, index, ace) ? { ok: true, value: pointer(ace[0]) } : fail(lastError())
        },
        isValidSid: (sid) => IsValidSid(sid) !== 0,
        getLengthSid: (sid) => GetLengthSid(sid) as number,
        convertSidToStringSid(sid) {
            const out: unknown[] = [null]
            return ConvertSidToStringSidW(sid, out) ? { ok: true, value: pointer(out[0]) } : fail(lastError())
        },
        localFree: (memory) => (pointer(LocalFree(memory)) === 0n ? 0 : lastError()),
        readMemory: (address, length) => (length === 0 ? new Uint8Array(0) : new Uint8Array(koffi.view(address, length)).slice()),
        // one code unit per view: nothing past the NUL, nothing past maxChars + 1 units (see Win32Primitives.readWideString)
        readWideString: (address, maxChars) => scanWideString((i) => u16(new Uint8Array(koffi.view(address + BigInt(2 * i), 2)), 0), maxChars),
        allocate: (size) => pointer(koffi.alloc("uint8_t", size)),
        release: (memory) => koffi.free(memory),
        openProcessToken(access) {
            const out: unknown[] = [null]
            return OpenProcessToken(GetCurrentProcess(), access, out) ? { ok: true, value: pointer(out[0]) } : fail(lastError())
        },
        getTokenInformation(token, infoClass, memory, size) {
            const returned = [0]
            const ok = GetTokenInformation(token, infoClass, memory === 0n ? null : memory, size, returned) !== 0
            return { error: ok ? 0 : lastError(), returnLength: (returned[0] as number) >>> 0 }
        },
        getKnownFolderPath(folderId, flags) {
            const out: unknown[] = [null]
            const hresult = SHGetKnownFolderPath(guidFields(folderId), flags, null, out) as number
            return { hresult: hresult >>> 0, path: pointer(out[0]) }
        },
        coTaskMemFree: (memory) => void CoTaskMemFree(memory),
        regOpenCurrentUserKey(subKey, access) {
            const out: unknown[] = [null]
            const status = RegOpenKeyExW(HKEY_CURRENT_USER, subKey, 0, access, out) as number
            return status === 0 ? { ok: true, value: pointer(out[0]) } : fail(status)
        },
        regEnumKey(key, index) {
            const name = buffer(2 * 256)
            const size = [256]
            const status = RegEnumKeyExW(key, index, name, size, null, null, null, null) as number
            return status === 0 ? { ok: true, value: utf16(name, 0, Math.min(size[0] as number, 255)) } : fail(status)
        },
        regGetString(key, subKey, valueName, capacityBytes) {
            const data = buffer(capacityBytes)
            const size = [capacityBytes]
            const status = RegGetValueW(key, subKey, valueName, RRF_RT_REG_SZ, null, data, size) as number
            if (status === ERROR_MORE_DATA) return { ok: false, error: status, required: size[0] as number }
            return status === 0 ? { ok: true, value: zString(data, Math.floor(Math.min(size[0] as number, capacityBytes) / 2)) } : fail(status)
        },
        regCloseKey: (key) => RegCloseKey(key) as number,
    }
}
