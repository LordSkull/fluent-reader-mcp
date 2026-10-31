/**
 * FR-MCP-04-BETA-03A2a: the read-only Win32 layer on SIMULATED primitives.
 * No ACL, SID, registry key or profile of this machine is read: native memory
 * is a simulated heap that fails the test on any read outside an allocation,
 * after its release, or on a double or foreign free; handles are counted.
 * The only native call is CompareStringOrdinal on synthetic strings (Windows
 * x64 only), which reads nothing from the system.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { ACE_FLAG, WELL_KNOWN_SID } from "../../installer/setup/location.js"
import {
    bindWin32Primitives, createWin32SecurityApi, dosPathFromFinalPath, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER, ERROR_INVALID_SID, ERROR_MORE_DATA, ERROR_NO_MORE_FILES, ERROR_NO_MORE_ITEMS,
    KNOWN_FOLDER, NativeReleaseError, NO_WIN32_CODE, parseAcl, parseDirectoryBuffer, parseSid, scanWideString,
    type Handle, type Pointer, type Win32Primitives, type Win32Result,
} from "../../installer/setup/win32-security.js"

const COMPILED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
/** Read before any test runs: only the imports above have been evaluated. */
const KOFFI_LOADED_BY_IMPORT = Object.keys(createRequire(import.meta.url).cache).some((k) => /[\\/]koffi[\\/]/.test(k))
const withoutComments = (js: string): string => js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "")
const USER = "S-1-5-21-1111111111-2222222222-3333333333-1001"
const { SYSTEM, ADMINISTRATORS: ADMINS, AUTHENTICATED_USERS: AU } = WELL_KNOWN_SID
const OICI = ACE_FLAG.OBJECT_INHERIT | ACE_FLAG.CONTAINER_INHERIT

// ------------------------------------------------------------------ synthetic bytes

const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff]

function sidBytes(sid: string): number[] {
    const [, , auth, ...subs] = sid.split("-")
    const a = Number(auth)
    return [1, subs.length, 0, 0, (a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff, ...subs.flatMap((s) => le32(Number(s)))]
}
/** `extra` goes before the SID (object ACEs: Flags, GUIDs), `trailing` after it (callback ACEs: application data). */
function aceBytes(type: number, flags: number, mask: number, sid: string, extra: number[] = [], trailing: number[] = []): number[] {
    const body = [...le32(mask), ...extra, ...sidBytes(sid), ...trailing]
    return [type, flags, ...le16(4 + body.length), ...body]
}
function aclBytes(aces: number[][], revision = 2): number[] {
    const body = aces.flat()
    return [revision, 0, ...le16(8 + body.length), ...le16(aces.length), 0, 0, ...body]
}
/** UTF-16LE code units, one by one (lone surrogates kept). */
function utf16le(s: string): number[] {
    return Array.from({ length: s.length }, (_, i) => le16(s.charCodeAt(i))).flat()
}
/** FILE_FULL_DIR_INFO records, each 8-byte aligned, the last with NextEntryOffset 0. */
function dirBuffer(names: string[]): Uint8Array {
    const records = names.map((name, i) => {
        const nameBytes = utf16le(name)
        const size = Math.ceil((68 + nameBytes.length) / 8) * 8
        const r = new Array<number>(size).fill(0)
        r.splice(0, 4, ...le32(i === names.length - 1 ? 0 : size))
        r.splice(60, 4, ...le32(nameBytes.length))
        r.splice(68, nameBytes.length, ...nameBytes)
        return r.slice(0, size)
    })
    return Uint8Array.from(records.flat())
}

// ------------------------------------------------------------------ simulated native heap and handles

type Kind = "local" | "cotask" | "koffi"

class Heap {
    #next = 0x10_0000n
    readonly blocks = new Map<Pointer, { bytes: Uint8Array; kind: Kind; freed: boolean }>()
    /** UTF-16 code units read by wide() (readWideString), all calls together. */
    unitReads = 0
    alloc(bytes: ArrayLike<number> | number, kind: Kind): Pointer {
        const base = this.#next
        this.#next += 0x1_0000n
        this.blocks.set(base, { bytes: typeof bytes === "number" ? new Uint8Array(bytes) : Uint8Array.from(bytes), kind, freed: false })
        return base
    }
    #find(p: Pointer, length: number): { bytes: Uint8Array; offset: number } {
        for (const [base, b] of this.blocks) {
            if (p >= base && p < base + BigInt(Math.max(b.bytes.length, 1))) {
                if (b.freed) throw new Error("read after free")
                const offset = Number(p - base)
                if (offset + length > b.bytes.length) throw new Error("read beyond the allocation")
                return { bytes: b.bytes, offset }
            }
        }
        throw new Error("read outside any allocation")
    }
    read(p: Pointer, length: number): Uint8Array {
        const { bytes, offset } = this.#find(p, length)
        return bytes.slice(offset, offset + length)
    }
    write(p: Pointer, data: ArrayLike<number>): void {
        const { bytes, offset } = this.#find(p, data.length)
        bytes.set(Array.from(data), offset)
    }
    /** As the binding reads it: scanWideString over one 2-byte read per unit (any read outside the allocation fails). */
    wide(p: Pointer, max: number): string | null {
        return scanWideString((i) => {
            this.unitReads++
            const [lo, hi] = this.read(p + BigInt(2 * i), 2) as unknown as [number, number]
            return lo | (hi << 8)
        }, max)
    }
    free(p: Pointer, kind: Kind): void {
        const b = this.blocks.get(p)
        if (b === undefined || b.kind !== kind) throw new Error(`free of a pointer that is not a ${kind} allocation`)
        if (b.freed) throw new Error("double free")
        b.freed = true
    }
    live(kind: Kind): number {
        return [...this.blocks.values()].filter((b) => b.kind === kind && !b.freed).length
    }
    string(s: string, kind: Kind): Pointer {
        return this.alloc([...utf16le(s), 0, 0], kind)
    }
}

class HandleTable {
    #next = 0x100n
    readonly open = new Set<Handle>()
    closes = 0
    create(): Handle {
        const h = this.#next++
        this.open.add(h)
        return h
    }
    close(h: Handle): number {
        if (!this.open.delete(h)) throw new Error("close of a handle that is not open (double close?)")
        this.closes++
        return 0
    }
    use(h: Handle): void {
        if (!this.open.has(h)) throw new Error("use of a closed handle")
    }
}

const unexpected = (name: string) => (): never => {
    throw new Error(`unexpected primitive call: ${name}`)
}

const u16at = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8)

/** The SID's bytes, read as IsValidSid reads them: the whole SID its header announces (the heap fails the test on any read outside the allocation). */
function simSid(heap: Heap, p: Pointer): Uint8Array | null {
    const length = 8 + 4 * (heap.read(p, 8)[1] as number)
    const bytes = heap.read(p, length)
    return parseSid(bytes, 0, length) === null ? null : bytes
}
/** IsValidAcl reads the whole region its header's AclSize declares. */
function simIsValidAcl(heap: Heap, acl: Pointer): boolean {
    heap.read(acl, u16at(heap.read(acl, 8), 2))
    return true
}

/**
 * Primitives over the simulated heap; every primitive not given fails the test when called. `log` records the
 * native calls that read a SID or an ACL (IsValidSid:<pointer>, GetLengthSid, IsValidAcl:<pointer>, GetAclInformation).
 */
function primitives(heap: Heap, handles: HandleTable, given: Partial<Win32Primitives> = {}, log: string[] = []): Win32Primitives {
    const base: Win32Primitives = {
        getDriveType: unexpected("getDriveType"), getVolumeInformation: unexpected("getVolumeInformation"), createFile: unexpected("createFile"),
        closeHandle: (h) => handles.close(h), getAttributeTag: unexpected("getAttributeTag"), getCaseSensitiveInfo: unexpected("getCaseSensitiveInfo"),
        getVolumeSerial: unexpected("getVolumeSerial"), getFinalPathName: unexpected("getFinalPathName"), readDirectory: unexpected("readDirectory"),
        compareStringOrdinal: unexpected("compareStringOrdinal"), getSecurityInfo: unexpected("getSecurityInfo"),
        getSecurityDescriptorLength: (sd) => (heap.blocks.get(sd) as { bytes: Uint8Array }).bytes.length,
        getSecurityDescriptorDacl: unexpected("getSecurityDescriptorDacl"),
        isValidAcl: (acl) => (log.push(`IsValidAcl:${acl}`), simIsValidAcl(heap, acl)),
        // as RtlQueryInformationAcl: AclBytesInUse is the end of the AceCount ACEs (where the first free ACE would go)
        getAclSizeInformation: (acl) => {
            log.push("GetAclInformation")
            const h = heap.read(acl, 8)
            const count = u16at(h, 4)
            let used = 8
            for (let i = 0; i < count && used + 4 <= u16at(h, 2); i++) used += u16at(heap.read(acl + BigInt(used), 4), 2)
            return { ok: true, value: { aceCount: count, bytesInUse: used } }
        },
        getAce: (acl, index) => {
            const size = (() => { const h = heap.read(acl, 8); return (h[2] as number) | ((h[3] as number) << 8) })()
            let offset = 8
            for (let i = 0; i < index; i++) {
                const h = heap.read(acl + BigInt(offset), 4)
                offset += (h[2] as number) | ((h[3] as number) << 8)
            }
            return offset < size ? { ok: true, value: acl + BigInt(offset) } : { ok: false, error: ERROR_INVALID_PARAMETER }
        },
        isValidSid: (p) => (log.push(`IsValidSid:${p}`), simSid(heap, p) !== null),
        getLengthSid: (p) => (log.push("GetLengthSid"), 8 + 4 * (heap.read(p, 2)[1] as number)),
        convertSidToStringSid: (p) => {
            const bytes = simSid(heap, p)
            const parsed = bytes === null ? null : parseSid(bytes)
            return parsed === null ? { ok: false, error: 1337 } : { ok: true, value: heap.string(parsed.text, "local") }
        },
        localFree: (p) => (heap.free(p, "local"), 0),
        readMemory: (p, length) => heap.read(p, length),
        readWideString: (p, max) => heap.wide(p, max),
        allocate: (size) => heap.alloc(size, "koffi"),
        release: (p) => heap.free(p, "koffi"),
        openProcessToken: unexpected("openProcessToken"), getTokenInformation: unexpected("getTokenInformation"),
        getKnownFolderPath: unexpected("getKnownFolderPath"), coTaskMemFree: (p) => heap.free(p, "cotask"),
        regOpenCurrentUserKey: unexpected("regOpenCurrentUserKey"), regEnumKey: unexpected("regEnumKey"), regGetString: unexpected("regGetString"),
        regCloseKey: (k) => handles.close(k),
    }
    return { ...base, ...given }
}

/** A self-relative-like descriptor: owner SID at 0, DACL after it, all in one LocalAlloc'ed block. */
function descriptor(heap: Heap, owner: string | null, acl: number[] | null, options: { present?: boolean } = {}): { sd: Pointer; owner: Pointer; dacl: Pointer; present: boolean } {
    const ownerBytes = owner === null ? [] : sidBytes(owner)
    const sd = heap.alloc([...ownerBytes, ...(acl ?? [])], "local")
    return { sd, owner: owner === null ? 0n : sd, dacl: acl === null ? 0n : sd + BigInt(ownerBytes.length), present: options.present ?? true }
}

function securityApi(heap: Heap, handles: HandleTable, d: ReturnType<typeof descriptor>, given: Partial<Win32Primitives> = {}) {
    const calls: string[] = []
    const p = primitives(heap, handles, {
        getSecurityInfo: (h, info) => {
            handles.use(h)
            calls.push(`GetSecurityInfo:${info}`)
            return { ok: true, value: { owner: d.owner, dacl: d.dacl, descriptor: d.sd } }
        },
        getSecurityDescriptorDacl: () => ({ ok: true, value: { present: d.present, dacl: d.dacl } }),
        ...given,
    })
    return { api: createWin32SecurityApi(p), calls }
}

// ------------------------------------------------------------------ decoders

describe("win32-security: SID and ACL decoding (pure)", () => {
    test("SIDs decode like ConvertSidToStringSidW; a wrong revision, too many sub-authorities or a truncated SID are refused", () => {
        assert.deepEqual(parseSid(Uint8Array.from(sidBytes(USER))), { text: USER, length: 28 })
        assert.equal(parseSid(Uint8Array.from(sidBytes(SYSTEM)))?.text, SYSTEM)
        assert.equal(parseSid(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 5]))?.text, "S-1-5")
        assert.equal(parseSid(Uint8Array.from([1, 1, 0, 0x10, 0, 0, 0, 0, ...le32(1)]))?.text, "S-1-0x001000000000-1", "authority ≥ 2^32 in hexadecimal")
        assert.equal(parseSid(Uint8Array.from([2, ...sidBytes(USER).slice(1)])), null)
        assert.equal(parseSid(Uint8Array.from([1, 16, 0, 0, 0, 0, 0, 5, ...new Array<number>(64).fill(0)])), null)
        assert.equal(parseSid(Uint8Array.from(sidBytes(USER).slice(0, 27))), null)
        assert.equal(parseSid(Uint8Array.from(sidBytes(USER)), 0, 20), null, "a SID crossing the limit")
    })

    test("allow, deny, inherit-only and inherited ACEs keep type, flags, mask and SID unchanged", () => {
        const acl = parseAcl(Uint8Array.from(aclBytes([aceBytes(0, OICI, 0x1f01ff, USER), aceBytes(1, 0, 0x10000, AU), aceBytes(0, OICI | ACE_FLAG.INHERIT_ONLY, 0x1301bf, AU), aceBytes(0, OICI | ACE_FLAG.INHERITED, 0x1200a9, ADMINS)])))
        assert.ok(acl.ok)
        assert.deepEqual(acl.aces.map(({ aceType, aceFlags, accessMask, sid }) => ({ aceType, aceFlags, accessMask, sid })), [
            { aceType: 0, aceFlags: OICI, accessMask: 0x1f01ff, sid: USER },
            { aceType: 1, aceFlags: 0, accessMask: 0x10000, sid: AU },
            { aceType: 0, aceFlags: OICI | ACE_FLAG.INHERIT_ONLY, accessMask: 0x1301bf, sid: AU },
            { aceType: 0, aceFlags: OICI | ACE_FLAG.INHERITED, accessMask: 0x1200a9, sid: ADMINS },
        ])
        const empty = parseAcl(Uint8Array.from(aclBytes([])))
        assert.deepEqual(empty, { ok: true, aces: [], bytesInUse: 8 })
        assert.ok(parseAcl(Uint8Array.from(aclBytes([aceBytes(0, 0, 1, USER)], 4))).ok, "ACL_REVISION_DS")
    })

    test("unsupported ACE types and unknown masks or flags are kept (the validator refuses them), never dropped", () => {
        const acl = parseAcl(Uint8Array.from(aclBytes([aceBytes(0x11, 0, 0x1, "S-1-16-12288"), aceBytes(0x9, 0, 0x1f01ff, AU, [], [0xde, 0xad, 0xbe, 0xef]), aceBytes(0x2, 0xc0, 0x00f00000, USER), aceBytes(0x5, 0, 0x100, AU, [...le32(1), ...new Array<number>(16).fill(7)])])))
        assert.ok(acl.ok)
        assert.deepEqual(acl.aces.map((a) => [a.aceType, a.aceFlags, a.accessMask, a.sid]), [[0x11, 0, 1, "S-1-16-12288"], [0x9, 0, 0x1f01ff, AU], [0x2, 0xc0, 0x00f00000, USER], [0x5, 0, 0x100, AU]])
        assert.equal(acl.aces[3]?.sidOffset, 28, "object ACE: Flags and one GUID before the SID")
    })

    test("an ACE whose layout is unknown makes the whole ACL undecodable, never a shorter safe-looking ACL", () => {
        for (const type of [0x4, 0x16, 0xff]) assert.deepEqual(parseAcl(Uint8Array.from(aclBytes([aceBytes(0, OICI, 0x1f01ff, USER), aceBytes(type, 0, 1, AU)]))), { ok: false, cause: "unsupported-ace-layout" }, `type ${type}`)
    })

    test("incomplete or inconsistent buffers are malformed: no read past the ACL, an ACE or a SID", () => {
        const good = aclBytes([aceBytes(0, 0, 1, USER)])
        const cases: [string, number[]][] = [
            ["ACL size larger than the buffer", [...good.slice(0, 2), ...le16(good.length + 4), ...good.slice(4)]],
            ["ACL size smaller than the buffer", [...good.slice(0, 2), ...le16(good.length - 4), ...good.slice(4)]],
            ["more ACEs announced than present", [...good.slice(0, 4), ...le16(2), ...good.slice(6)]],
            ["ACE size past the end", [...good.slice(0, 10), ...le16(200), ...good.slice(12)]],
            ["ACE size not DWORD-aligned", [...good.slice(0, 10), ...le16(37), ...good.slice(12)]],
            ["ACE too small for mask and SID", [...good.slice(0, 10), ...le16(8), ...good.slice(12)]],
            ["SID crossing its ACE", [...good.slice(0, 17), 9, ...good.slice(18)]],
            ["object ACE with unknown flags", aclBytes([aceBytes(0x5, 0, 1, AU, le32(4))])],
            ["unknown revision", aclBytes([aceBytes(0, 0, 1, USER)], 3)],
            ["truncated header", good.slice(0, 6)],
        ]
        for (const [label, bytes] of cases) assert.equal(parseAcl(Uint8Array.from(bytes)).ok, false, label)
    })
})

describe("win32-security: owner and DACL through simulated GetSecurityInfo/GetAce", () => {
    const run = (owner: string | null, acl: number[] | null, options: { present?: boolean } = {}, given: Partial<Win32Primitives> = {}) => {
        const heap = new Heap()
        const handles = new HandleTable()
        const h = handles.create()
        const d = descriptor(heap, owner, acl, options)
        const { api, calls } = securityApi(heap, handles, d, given)
        return { heap, handles, h, api, calls, d }
    }

    test("valid owner and DACL; only owner + DACL requested (no group, no SACL); the descriptor and every SID string freed once", () => {
        const { heap, h, api, calls } = run(USER, aclBytes([aceBytes(0, OICI, 0x1f01ff, USER), aceBytes(0, OICI, 0x1f01ff, SYSTEM), aceBytes(1, 0, 0x10000, AU)]))
        const r = api.security(h)
        assert.deepEqual(r, { owner: { ok: true, sid: USER }, dacl: { kind: "present", aces: [{ aceType: 0, aceFlags: OICI, accessMask: 0x1f01ff, sid: USER }, { aceType: 0, aceFlags: OICI, accessMask: 0x1f01ff, sid: SYSTEM }, { aceType: 1, aceFlags: 0, accessMask: 0x10000, sid: AU }] } })
        assert.deepEqual(calls, ["GetSecurityInfo:5"], "OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION")
        assert.equal(heap.live("local"), 0)
    })

    test("NULL DACL, no DACL, empty DACL: three different readings", () => {
        const nullDacl = run(USER, null)
        assert.deepEqual(nullDacl.api.security(nullDacl.h).dacl, { kind: "null" })
        const absent = run(USER, null, { present: false })
        assert.deepEqual(absent.api.security(absent.h).dacl, { kind: "absent" })
        const empty = run(USER, aclBytes([]))
        assert.deepEqual(empty.api.security(empty.h).dacl, { kind: "present", aces: [] })
        for (const r of [nullDacl, absent, empty]) assert.equal(r.heap.live("local"), 0)
    })

    test("GetSecurityInfo failing: unreadable owner and DACL, never an empty DACL; nothing to free", () => {
        const heap = new Heap()
        const handles = new HandleTable()
        const api = createWin32SecurityApi(primitives(heap, handles, { getSecurityInfo: () => ({ ok: false, error: ERROR_ACCESS_DENIED }) }))
        assert.deepEqual(api.security(handles.create()), { owner: { ok: false, cause: "absent" }, dacl: { kind: "unreadable", cause: "query-failed" } })
        assert.equal(heap.blocks.size, 0)
    })

    test("an ACE that cannot be read correctly makes the DACL unreadable; the descriptor is still freed once", () => {
        const acl = aclBytes([aceBytes(0, OICI, 0x1f01ff, USER), aceBytes(0, 0, 0x1, AU)])
        const variants: [string, Partial<Win32Primitives>, string][] = [
            ["GetAce fails on the second ACE", { getAce: (a, i) => (i === 1 ? { ok: false, error: ERROR_INVALID_PARAMETER } : { ok: true, value: a + 8n }) }, "query-failed"],
            ["GetAce points elsewhere", { getAce: (a) => ({ ok: true, value: a + 8n }) }, "mismatch"],
            ["IsValidAcl false", { isValidAcl: () => false }, "invalid"],
            ["GetAclInformation fails", { getAclSizeInformation: () => ({ ok: false, error: 87 }) }, "query-failed"],
            ["GetAclInformation disagrees on the count", { getAclSizeInformation: () => ({ ok: true, value: { aceCount: 1, bytesInUse: 8 } }) }, "inconsistent"],
            ["ConvertSidToStringSidW fails", { convertSidToStringSid: () => ({ ok: false, error: 1337 }) }, "sid-conversion-failed"],
            ["GetSecurityDescriptorDacl fails", { getSecurityDescriptorDacl: () => ({ ok: false, error: 87 }) }, "query-failed"],
        ]
        for (const [label, given, cause] of variants) {
            const r = run(USER, acl, {}, given)
            const dacl = r.api.security(r.h).dacl
            assert.deepEqual(dacl, { kind: "unreadable", cause }, label)
            assert.equal(r.heap.live("local"), 0, `${label}: everything freed`)
        }
    })

    test("a native SID string that differs from the decoded bytes is a mismatch (unreadable), not a choice", () => {
        const heap = new Heap()
        const handles = new HandleTable()
        const d = descriptor(heap, USER, aclBytes([aceBytes(0, 0, 1, AU)]))
        const { api } = securityApi(heap, handles, d, { convertSidToStringSid: () => ({ ok: true, value: heap.string(SYSTEM, "local") }) })
        const r = api.security(handles.create())
        assert.deepEqual(r.owner, { ok: false, cause: "mismatch" })
        assert.deepEqual(r.dacl, { kind: "unreadable", cause: "sid-mismatch" })
        assert.equal(heap.live("local"), 0)
    })

    test("pointers outside the descriptor are never read: owner and DACL out of bounds are unreadable", () => {
        const heap = new Heap()
        const handles = new HandleTable()
        const d = descriptor(heap, USER, aclBytes([aceBytes(0, 0, 1, AU)]))
        const elsewhere = heap.alloc(sidBytes(SYSTEM), "koffi")
        const { api } = securityApi(heap, handles, { ...d, owner: elsewhere, dacl: elsewhere }, { getSecurityDescriptorDacl: () => ({ ok: true, value: { present: true, dacl: elsewhere } }) })
        const r = api.security(handles.create())
        assert.deepEqual(r, { owner: { ok: false, cause: "out-of-bounds" }, dacl: { kind: "unreadable", cause: "out-of-bounds" } })
        assert.equal(heap.live("local"), 0)
    })

    test("GetSecurityDescriptorDacl and GetSecurityInfo disagreeing on the DACL: unreadable", () => {
        const r = run(USER, aclBytes([aceBytes(0, 0, 1, AU)]), {}, { getSecurityDescriptorDacl: () => ({ ok: true, value: { present: true, dacl: 0n } }) })
        assert.deepEqual(r.api.security(r.h).dacl, { kind: "unreadable", cause: "mismatch" })
    })

    test("an invalid owner SID, or a missing owner, is not readable", () => {
        const heap = new Heap()
        const handles = new HandleTable()
        const sd = heap.alloc([2, 1, 0, 0, 0, 0, 0, 5, ...le32(18), ...aclBytes([])], "local")
        const { api } = securityApi(heap, handles, { sd, owner: sd, dacl: sd + 12n, present: true })
        assert.deepEqual(api.security(handles.create()).owner, { ok: false, cause: "invalid" })
        const none = run(null, aclBytes([]))
        assert.deepEqual(none.api.security(none.h).owner, { ok: false, cause: "absent" })
    })

    test("an exception in the middle (FFI failure) propagates after the descriptor and the strings are freed", () => {
        const r = run(USER, aclBytes([aceBytes(0, 0, 1, AU), aceBytes(0, 0, 1, SYSTEM)]), {}, {
            getAce: (a, i) => {
                if (i === 1) throw new Error("native failure")
                return { ok: true, value: a + 8n }
            },
        })
        assert.throws(() => r.api.security(r.h), /native failure/)
        assert.equal(r.heap.live("local"), 0)
    })

    test("LocalFree failing is reported (NativeReleaseError), never ignored", () => {
        const r = run(USER, aclBytes([]), {}, {})
        const heap = r.heap
        const failing = createWin32SecurityApi(primitives(heap, r.handles, {
            getSecurityInfo: () => ({ ok: true, value: { owner: r.d.owner, dacl: r.d.dacl, descriptor: r.d.sd } }),
            getSecurityDescriptorDacl: () => ({ ok: true, value: { present: true, dacl: r.d.dacl } }),
            localFree: (p) => (p === r.d.sd ? 6 : (heap.free(p, "local"), 0)),
        }))
        assert.throws(() => failing.security(r.h), (e: unknown) => e instanceof NativeReleaseError && e.code === 6)
    })
})

describe("win32-security: whole SID and ACL bounds proven BEFORE IsValidSid / IsValidAcl (spied native calls)", () => {
    /** One LocalAlloc'ed descriptor block; owner and DACL at the given offsets in it (null: none). */
    const spied = (block: number[], ownerAt: number | null, daclAt: number | null, given: Partial<Win32Primitives> = {}) => {
        const heap = new Heap()
        const handles = new HandleTable()
        const log: string[] = []
        const sd = heap.alloc(block, "local")
        const owner = ownerAt === null ? 0n : sd + BigInt(ownerAt)
        const dacl = daclAt === null ? 0n : sd + BigInt(daclAt)
        const api = createWin32SecurityApi(primitives(heap, handles, {
            getSecurityInfo: () => ({ ok: true, value: { owner, dacl, descriptor: sd } }),
            getSecurityDescriptorDacl: () => ({ ok: true, value: { present: true, dacl } }),
            ...given,
        }, log))
        return { heap, api, h: handles.create(), log, owner, dacl }
    }
    const sidCalls = (log: string[]): string[] => log.filter((c) => c.startsWith("IsValidSid") || c === "GetLengthSid")
    const aclCalls = (log: string[]): string[] => log.filter((c) => c.startsWith("IsValidAcl") || c === "GetAclInformation")
    const SYSTEM_SID = sidBytes(SYSTEM)

    test("SID: header and body inside the descriptor → IsValidSid called once, on that SID, then GetLengthSid", () => {
        const r = spied(sidBytes(USER), 0, null)
        assert.deepEqual(r.api.security(r.h).owner, { ok: true, sid: USER })
        assert.deepEqual(sidCalls(r.log), [`IsValidSid:${r.owner}`, "GetLengthSid"])
        assert.equal(r.heap.live("local"), 0)
    })

    test("SID: valid header whose SubAuthorityCount needs bytes past the allocation → out-of-bounds, IsValidSid never called", () => {
        const r = spied([1, 5, 0, 0, 0, 0, 0, 5, ...le32(21)], 0, null)
        // what the premature native call would do: read 28 bytes of a 12-byte allocation
        assert.throws(() => simSid(r.heap, r.owner), /read beyond the allocation/)
        assert.deepEqual(r.api.security(r.h).owner, { ok: false, cause: "out-of-bounds" })
        assert.deepEqual(sidCalls(r.log), [], "no native call on a SID whose length is not proven")
        assert.equal(r.heap.live("local"), 0)
    })

    test("SID: truncated header (fewer than 8 bytes left) → out-of-bounds, IsValidSid never called", () => {
        const r = spied([1, 1, 0, 0, 0], 0, null)
        assert.deepEqual(r.api.security(r.h).owner, { ok: false, cause: "out-of-bounds" })
        assert.deepEqual(sidCalls(r.log), [])
    })

    test("SID: SubAuthorityCount above 15, or a wrong revision → invalid, IsValidSid never called", () => {
        for (const head of [[1, 16], [1, 255], [2, 1]]) {
            const r = spied([...head, 0, 0, 0, 0, 0, 5, ...new Array<number>(1100).fill(0)], 0, null)
            assert.deepEqual(r.api.security(r.h).owner, { ok: false, cause: "invalid" }, JSON.stringify(head))
            assert.deepEqual(sidCalls(r.log), [], JSON.stringify(head))
        }
    })

    test("SID: the bound is the descriptor's reported length, not whatever memory follows it", () => {
        const r = spied(sidBytes(USER), 0, null, { getSecurityDescriptorLength: () => 20 })
        assert.deepEqual(r.api.security(r.h).owner, { ok: false, cause: "out-of-bounds" })
        assert.deepEqual(sidCalls(r.log), [])
    })

    test("SID: GetLengthSid disagreeing with the length the header gives → invalid", () => {
        const r = spied(sidBytes(USER), 0, null, { getLengthSid: () => 24 })
        assert.deepEqual(r.api.security(r.h).owner, { ok: false, cause: "invalid" })
    })

    test("SID: a TokenUser SID crossing the token buffer → ERROR_INVALID_SID, IsValidSid never called; buffer released, token closed", () => {
        const heap = new Heap()
        const handles = new HandleTable()
        const log: string[] = []
        const sid = [1, 5, 0, 0, 0, 0, 0, 5, ...le32(21)]
        const api = createWin32SecurityApi(primitives(heap, handles, {
            openProcessToken: () => ({ ok: true, value: handles.create() }),
            getTokenInformation: (_t, _c, buffer, length) => {
                if (length === 0) return { error: ERROR_INSUFFICIENT_BUFFER, returnLength: 16 + sid.length }
                heap.write(buffer, [...le32(Number((buffer + 16n) & 0xffffffffn)), ...le32(Number((buffer + 16n) >> 32n)), ...le32(0), ...le32(0), ...sid])
                return { error: 0, returnLength: 16 + sid.length }
            },
        }, log))
        assert.deepEqual(api.currentUserSid(), { ok: false, error: ERROR_INVALID_SID })
        assert.deepEqual(sidCalls(log), [])
        assert.equal(heap.live("koffi"), 0)
        assert.equal(handles.open.size, 0)
    })

    test("ACL: header and AclSize inside the descriptor → IsValidAcl called once, before GetAclInformation", () => {
        const r = spied([...SYSTEM_SID, ...aclBytes([aceBytes(0, 0, 1, AU)])], 0, SYSTEM_SID.length)
        assert.deepEqual(r.api.security(r.h).dacl, { kind: "present", aces: [{ aceType: 0, aceFlags: 0, accessMask: 1, sid: AU }] })
        assert.deepEqual(aclCalls(r.log), [`IsValidAcl:${r.dacl}`, "GetAclInformation"])
        assert.equal(r.heap.live("local"), 0)
    })

    test("ACL: valid header whose AclSize runs past the allocation → out-of-bounds, IsValidAcl never called", () => {
        const acl = aclBytes([aceBytes(0, 0, 1, AU)])
        const r = spied([...SYSTEM_SID, ...acl.slice(0, 2), ...le16(acl.length + 64), ...acl.slice(4)], 0, SYSTEM_SID.length)
        assert.throws(() => simIsValidAcl(r.heap, r.dacl), /read beyond the allocation/, "what the premature native call would read")
        assert.deepEqual(r.api.security(r.h).dacl, { kind: "unreadable", cause: "out-of-bounds" })
        assert.deepEqual(aclCalls(r.log), [], "no native call on an ACL whose region is not proven")
        assert.equal(r.heap.live("local"), 0)
    })

    test("ACL: truncated header (fewer than 8 bytes left in the descriptor) → out-of-bounds, IsValidAcl never called", () => {
        const r = spied([...SYSTEM_SID, 2, 0, 8, 0], 0, SYSTEM_SID.length)
        assert.deepEqual(r.api.security(r.h).dacl, { kind: "unreadable", cause: "out-of-bounds" })
        assert.deepEqual(aclCalls(r.log), [])
    })

    test("ACL: AclSize smaller than the header, or an AceCount that cannot fit in AclSize → malformed, IsValidAcl never called", () => {
        const tooSmall = spied([...SYSTEM_SID, 2, 0, ...le16(4), 0, 0, 0, 0], 0, SYSTEM_SID.length)
        assert.deepEqual(tooSmall.api.security(tooSmall.h).dacl, { kind: "unreadable", cause: "malformed" })
        assert.deepEqual(aclCalls(tooSmall.log), [])
        const acl = aclBytes([aceBytes(0, 0, 1, AU)])
        const crowded = spied([...SYSTEM_SID, ...acl.slice(0, 4), ...le16(10), ...acl.slice(6)], 0, SYSTEM_SID.length)
        assert.deepEqual(crowded.api.security(crowded.h).dacl, { kind: "unreadable", cause: "malformed" })
        assert.deepEqual(aclCalls(crowded.log), [])
    })

    test("ACL: malformed ACEs inside an ACL whose bounds are valid → IsValidAcl may run; the DACL is never present, no ACE SID reaches IsValidSid", () => {
        const good = aclBytes([aceBytes(0, 0, 1, USER)])
        const cases: [string, number[], Partial<Win32Primitives>, string][] = [
            ["ACE size past the ACL", [...good.slice(0, 10), ...le16(200), ...good.slice(12)], {}, "malformed"],
            ["SID crossing its ACE", [...good.slice(0, 17), 9, ...good.slice(18)], {}, "malformed"],
            ["unknown ACE layout", aclBytes([aceBytes(0x16, 0, 1, USER)]), {}, "unsupported-ace-layout"],
            ["IsValidAcl refusing it", [...good.slice(0, 10), ...le16(200), ...good.slice(12)], { isValidAcl: () => false }, "invalid"],
        ]
        for (const [label, acl, given, cause] of cases) {
            const r = spied([...SYSTEM_SID, ...acl], 0, SYSTEM_SID.length, given)
            const reading = r.api.security(r.h)
            assert.deepEqual(reading.dacl, { kind: "unreadable", cause }, label)
            assert.deepEqual(r.log.filter((c) => c.startsWith("IsValidSid")), [`IsValidSid:${r.owner}`], `${label}: only the owner's SID`)
            assert.equal(r.heap.live("local"), 0, label)
        }
    })
})

describe("win32-security: AclBytesInUse reconciled with the decoded ACEs", () => {
    /** One ACE, then `free` bytes of free space inside AclSize. */
    const withFreeSpace = (free: number): number[] => {
        const acl = aclBytes([aceBytes(0, 0, 1, USER), aceBytes(1, 0, 0x10000, AU)])
        return [...acl.slice(0, 2), ...le16(acl.length + free), ...acl.slice(4), ...new Array<number>(free).fill(0)]
    }
    const read = (acl: number[], bytesInUse?: (size: number, used: number) => number, aceCount?: number) => {
        const heap = new Heap()
        const handles = new HandleTable()
        const d = descriptor(heap, USER, acl)
        const used = 8 + aceBytes(0, 0, 1, USER).length + aceBytes(1, 0, 0x10000, AU).length
        const given: Partial<Win32Primitives> = bytesInUse === undefined && aceCount === undefined ? {} : { getAclSizeInformation: () => ({ ok: true, value: { aceCount: aceCount ?? 2, bytesInUse: bytesInUse?.(acl.length, used) ?? used } }) }
        const dacl = securityApi(heap, handles, d, given).api.security(handles.create()).dacl
        assert.equal(heap.live("local"), 0)
        return dacl
    }

    test("consistent: AclBytesInUse at the end of the ACEs, with or without free space after them (Windows allows it)", () => {
        assert.equal(read(withFreeSpace(0)).kind, "present")
        assert.equal(read(withFreeSpace(16)).kind, "present")
        const parsed = parseAcl(Uint8Array.from(withFreeSpace(16)))
        assert.ok(parsed.ok && parsed.bytesInUse === withFreeSpace(16).length - 16, "the free space is not decoded")
    })

    test("inconsistent: AclBytesInUse = AclSize over free space, short of the ACEs, inside an ACE, past AclSize; AceCount different", () => {
        const cases: [string, (size: number, used: number) => number, number?][] = [
            ["AclSize although 16 bytes are free", (size) => size],
            ["header only", () => 8],
            ["inside the second ACE", (_size, used) => used - 4],
            ["past AclSize", (size) => size + 4],
            ["AceCount one short", (_size, used) => used, 1],
        ]
        for (const [label, bytesInUse, aceCount] of cases) assert.deepEqual(read(withFreeSpace(16), bytesInUse, aceCount), { kind: "unreadable", cause: "inconsistent" }, label)
    })
})

describe("win32-security: wide strings returned without a size (bounded scan, no lstrlenW)", () => {
    const units = (s: string): number[] => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i))
    const scan = (data: number[], max: number) => {
        const reads: number[] = []
        const text = scanWideString((i) => {
            reads.push(i)
            if (i >= data.length) throw new Error("read past the test data")
            return data[i] as number
        }, max)
        return { text, reads }
    }

    test("stops at the first NUL; never reads a unit past it", () => {
        assert.deepEqual(scan([...units("S-1-5-18"), 0, 0x41, 0x42], 200), { text: "S-1-5-18", reads: [0, 1, 2, 3, 4, 5, 6, 7, 8] })
        assert.deepEqual(scan([0], 0), { text: "", reads: [0] })
        assert.deepEqual(scan([0xd800, 0x41, 0], 10).text, "\ud800A", "lone surrogates kept")
    })

    test("a string longer than the bound is refused after maxChars + 1 reads, before any scan to its terminator", () => {
        const long = [...new Array<number>(5000).fill(0x41), 0]
        const r = scan(long, 200)
        assert.equal(r.text, null)
        assert.equal(r.reads.length, 201, "maxChars units, plus one to see that no NUL ends them")
        assert.deepEqual(scan([0x41], 0), { text: null, reads: [0] })
        assert.deepEqual(scan([...units("abc"), 0], 3).text, "abc", "exactly maxChars is accepted")
        assert.throws(() => scan([0], -1), RangeError)
        assert.throws(() => scan([0], 1.5), RangeError)
    })

    test("through the API: an over-long SID string or known-folder path is refused with a bounded number of reads, and still freed", () => {
        const heap = new Heap()
        const handles = new HandleTable()
        const d = descriptor(heap, USER, null)
        const { api } = securityApi(heap, handles, d, { convertSidToStringSid: () => ({ ok: true, value: heap.alloc(new Array<number>(2 * 4000).fill(0x41), "local") }) })
        assert.deepEqual(api.security(handles.create()).owner, { ok: false, cause: "conversion-failed" })
        assert.equal(heap.unitReads, 201, "ConvertSidToStringSidW: maxChars 200, no NUL in 4000 units: 201 reads, not 4000")
        assert.equal(heap.live("local"), 0)

        const folders = new Heap()
        const path = folders.alloc(new Array<number>(2 * 40000).fill(0x43), "cotask")
        const known = createWin32SecurityApi(primitives(folders, new HandleTable(), { getKnownFolderPath: () => ({ hresult: 0, path }) }))
        assert.deepEqual(known.knownFolder(KNOWN_FOLDER.Profile), { kind: "error", hresult: 0 })
        assert.equal(folders.unitReads, 32768, "SHGetKnownFolderPath: MAX_LONG_PATH + 1 reads at most")
        assert.equal(folders.live("cotask"), 0)
    })

    test("the binding has no unbounded native scan: lstrlenW is neither declared nor called", () => {
        const compiled = withoutComments(fs.readFileSync(path.join(COMPILED_ROOT, "installer", "setup", "win32-security.js"), "utf8"))
        assert.doesNotMatch(compiled, /lstrlen|wcslen|strlen/i)
        assert.match(compiled, /readWideString: \(address, maxChars\) => scanWideString\(/)
    })
})

describe("win32-security: current user (OpenProcessToken + GetTokenInformation(TokenUser))", () => {
    function token(heap: Heap, handles: HandleTable, sid: number[], given: Partial<Win32Primitives> = {}) {
        const calls: string[] = []
        const size = 16 + sid.length
        const p = primitives(heap, handles, {
            openProcessToken: (access) => (calls.push(`open:${access}`), { ok: true, value: handles.create() }),
            getTokenInformation: (t, cls, buffer, length) => {
                handles.use(t)
                calls.push(`info:${cls}:${length}`)
                if (length < size) return { error: ERROR_INSUFFICIENT_BUFFER, returnLength: size }
                heap.write(buffer, [...le32(Number((buffer + 16n) & 0xffffffffn)), ...le32(Number((buffer + 16n) >> 32n)), ...le32(0), ...le32(0), ...sid])
                return { error: 0, returnLength: size }
            },
            ...given,
        })
        return { api: createWin32SecurityApi(p), calls }
    }

    test("the SID is read inside the token buffer, the buffer released and the token closed exactly once", () => {
        const heap = new Heap()
        const handles = new HandleTable()
        const { api, calls } = token(heap, handles, sidBytes(USER))
        assert.deepEqual(api.currentUserSid(), { ok: true, value: USER })
        assert.deepEqual(calls, ["open:8", "info:1:0", "info:1:44"], "TOKEN_QUERY only; size query, then the read")
        assert.equal(heap.live("koffi"), 0)
        assert.equal(heap.live("local"), 0)
        assert.equal(handles.open.size, 0)
        assert.equal(handles.closes, 1)
    })

    test("failures: OpenProcessToken, the size query, the read, a SID pointer outside the buffer; everything cleaned", () => {
        const heap = new Heap()
        const handles = new HandleTable()
        const denied = createWin32SecurityApi(primitives(heap, handles, { openProcessToken: () => ({ ok: false, error: ERROR_ACCESS_DENIED }) }))
        assert.deepEqual(denied.currentUserSid(), { ok: false, error: ERROR_ACCESS_DENIED })
        const noSize = token(heap, handles, sidBytes(USER), { getTokenInformation: () => ({ error: 0, returnLength: 0 }) })
        assert.equal(noSize.api.currentUserSid().ok, false, "a size query that 'succeeds' is not trusted")
        const second = token(heap, handles, sidBytes(USER), { getTokenInformation: (_t, _c, _b, length) => (length === 0 ? { error: ERROR_INSUFFICIENT_BUFFER, returnLength: 44 } : { error: ERROR_ACCESS_DENIED, returnLength: 0 }) })
        assert.deepEqual(second.api.currentUserSid(), { ok: false, error: ERROR_ACCESS_DENIED })
        const outside = token(heap, handles, sidBytes(USER), {
            getTokenInformation: (_t, _c, buffer, length) => {
                if (length === 0) return { error: ERROR_INSUFFICIENT_BUFFER, returnLength: 44 }
                heap.write(buffer, [...le32(0x1234), ...le32(0), ...le32(0), ...le32(0)])
                return { error: 0, returnLength: 44 }
            },
        })
        assert.deepEqual(outside.api.currentUserSid(), { ok: false, error: 1337 })
        assert.equal(heap.live("koffi"), 0)
        assert.equal(handles.open.size, 0)
    })
})

describe("win32-security: paths, attributes, listing", () => {
    test("final paths: only Windows' own \\\\?\\ prefix is removed, and only from a drive path", () => {
        assert.deepEqual(dosPathFromFinalPath("\\\\?\\C:\\"), { kind: "drive", path: "C:\\", root: "C:\\", segments: [] })
        assert.deepEqual(dosPathFromFinalPath("\\\\?\\D:\\Dati é\\Fluent Reader MCP 😀"), { kind: "drive", path: "D:\\Dati é\\Fluent Reader MCP 😀", root: "D:\\", segments: ["Dati é", "Fluent Reader MCP 😀"] })
        assert.equal(dosPathFromFinalPath("\\\\?\\UNC\\server\\share\\x").kind, "unc")
        assert.equal(dosPathFromFinalPath("\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x").kind, "volume-guid")
        for (const raw of ["C:\\Users", "\\\\.\\C:\\x", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x", "\\\\?\\C:\\a\\\\b", "\\\\?\\C:\\a\\", "\\\\?\\C:\\a\\..\\b", "\\\\?\\C:", "\\\\?\\\\\\?\\C:\\x", "\\\\?\\C:\\a/b", ""]) {
            assert.equal(dosPathFromFinalPath(raw).kind, "other", JSON.stringify(raw))
        }
    })

    test("GetFinalPathNameByHandleW: a larger buffer when asked, an error when it keeps growing or the length is incoherent", () => {
        const handles = new HandleTable()
        const long = `\\\\?\\D:\\${"x".repeat(600)}`
        const capacities: number[] = []
        const api = createWin32SecurityApi(primitives(new Heap(), handles, { getFinalPathName: (_h, capacity) => (capacities.push(capacity), { ok: true, value: capacity > long.length ? { returned: long.length, text: long } : { returned: long.length + 1, text: "" } }) }))
        assert.deepEqual(api.finalPath(handles.create()), { ok: true, value: long })
        assert.deepEqual(capacities, [512, long.length + 1], "the size asked for, NUL included")
        const growing = createWin32SecurityApi(primitives(new Heap(), handles, { getFinalPathName: (_h, capacity) => ({ ok: true, value: { returned: capacity + 10, text: "" } }) }))
        assert.equal(growing.finalPath(handles.create()).ok, false)
        const incoherent = createWin32SecurityApi(primitives(new Heap(), handles, { getFinalPathName: () => ({ ok: true, value: { returned: 3, text: "\\\\?\\C:\\" } }) }))
        assert.equal(incoherent.finalPath(handles.create()).ok, false)
        const failing = createWin32SecurityApi(primitives(new Heap(), handles, { getFinalPathName: () => ({ ok: false, error: ERROR_ACCESS_DENIED }) }))
        assert.deepEqual(failing.finalPath(handles.create()), { ok: false, error: ERROR_ACCESS_DENIED })
    })

    test("attributes: the reparse tag is reported whenever FILE_ATTRIBUTE_REPARSE_POINT is set (a 0 tag included)", () => {
        const handles = new HandleTable()
        const cases: [number, number, { isDirectory: boolean; reparseTag: number | null }][] = [
            [0x10, 0, { isDirectory: true, reparseTag: null }],
            [0x10 | 0x400, 0xa0000003, { isDirectory: true, reparseTag: 0xa0000003 }],
            [0x10 | 0x400, 0, { isDirectory: true, reparseTag: 0 }],
            [0x20, 0, { isDirectory: false, reparseTag: null }],
            [0x10, 0xa000000c, { isDirectory: true, reparseTag: null }],
        ]
        for (const [fileAttributes, reparseTag, expected] of cases) {
            const api = createWin32SecurityApi(primitives(new Heap(), handles, { getAttributeTag: () => ({ ok: true, value: { fileAttributes, reparseTag } }) }))
            assert.deepEqual(api.attributes(handles.create()), { ok: true, value: expected })
        }
    })

    test("openComponent never follows a final reparse point and does not share delete; probes request attributes only", () => {
        const calls: [string, number, number, number][] = []
        const handles = new HandleTable()
        const api = createWin32SecurityApi(primitives(new Heap(), handles, { createFile: (p, access, share, flags) => (calls.push([p, access, share, flags]), { ok: true, value: handles.create() }) }))
        api.openComponent("D:\\Apps", false)
        api.openComponent("D:\\Apps\\FluentReaderMCP", true)
        api.openProbe("C:\\Users\\x", true)
        api.openProbe("C:\\Users\\x", false)
        assert.deepEqual(calls, [
            ["D:\\Apps", 0x20080, 0x3, 0x02200000],
            ["D:\\Apps\\FluentReaderMCP", 0x20081, 0x3, 0x02200000],
            ["C:\\Users\\x", 0x80, 0x7, 0x02000000],
            ["C:\\Users\\x", 0x80, 0x7, 0x02200000],
        ])
    })

    test("probeChild: present (handle closed once), absent only on ERROR_FILE_NOT_FOUND, any other error kept; only system paths", () => {
        const handles = new HandleTable()
        const seen: string[] = []
        const answers: Win32Result<Handle>[] = [{ ok: true, value: 0n }, { ok: false, error: ERROR_FILE_NOT_FOUND }, { ok: false, error: ERROR_ACCESS_DENIED }]
        let i = 0
        const api = createWin32SecurityApi(primitives(new Heap(), handles, {
            createFile: (p) => {
                seen.push(p)
                const a = answers[i++] as Win32Result<Handle>
                return a.ok ? { ok: true, value: handles.create() } : a
            },
        }))
        assert.deepEqual(api.probeChild("\\\\?\\D:\\Apps", "fluent-reader-mcp.install.json"), { ok: true, value: "present" })
        assert.deepEqual(api.probeChild("\\\\?\\D:\\", "fluent-reader-mcp.install.json"), { ok: true, value: "absent" })
        assert.deepEqual(api.probeChild("\\\\?\\D:\\Apps", "fluent-reader-mcp.install.json"), { ok: false, error: ERROR_ACCESS_DENIED })
        assert.deepEqual(seen, ["\\\\?\\D:\\Apps\\fluent-reader-mcp.install.json", "\\\\?\\D:\\fluent-reader-mcp.install.json", "\\\\?\\D:\\Apps\\fluent-reader-mcp.install.json"])
        assert.equal(handles.open.size, 0)
        assert.throws(() => api.probeChild("D:\\Apps", "x"), TypeError, "a user path is never prefixed")
        assert.throws(() => api.probeChild("\\\\?\\D:\\Apps", "..\\x"), TypeError)
    })

    test("volume root APIs take an explicit X:\\ root only (no NULL, no current directory)", () => {
        const api = createWin32SecurityApi(primitives(new Heap(), new HandleTable(), { getDriveType: () => 3, getVolumeInformation: () => ({ ok: false, error: 21 }) }))
        assert.equal(api.driveType("D:\\"), 3)
        for (const root of ["", "D:", "D:\\x", "d:\\", "\\\\server\\share\\"]) {
            assert.throws(() => api.driveType(root), TypeError, root)
            assert.throws(() => api.volumeInformation(root), TypeError, root)
        }
    })

    test("directory listing: several calls, . and .. dropped, Unicode names exact, end on ERROR_NO_MORE_FILES", () => {
        const handles = new HandleTable()
        const pages = [dirBuffer([".", "..", "current", "Fluent é 😀"]), dirBuffer(["state", "ı\ud800"])]
        const restarts: boolean[] = []
        const api = createWin32SecurityApi(primitives(new Heap(), handles, { readDirectory: (_h, restart) => (restarts.push(restart), pages.length > 0 ? { ok: true, value: pages.shift() as Uint8Array } : { ok: false, error: ERROR_NO_MORE_FILES }) }))
        assert.deepEqual(api.listDirectory(handles.create(), { maxEntries: 10, maxCalls: 10, bufferBytes: 4096 }), { kind: "complete", entries: ["current", "Fluent é 😀", "state", "ı\ud800"] })
        assert.deepEqual(restarts, [true, false, false])
        const empty = createWin32SecurityApi(primitives(new Heap(), handles, { readDirectory: () => ({ ok: false, error: ERROR_NO_MORE_FILES }) }))
        assert.deepEqual(empty.listDirectory(handles.create(), { maxEntries: 10, maxCalls: 10, bufferBytes: 4096 }), { kind: "complete", entries: [] })
    })

    test("directory listing: bounded (entries, calls), malformed buffers and errors are never a complete listing", () => {
        const handles = new HandleTable()
        const listing = (pages: (Uint8Array | number)[], limits = { maxEntries: 3, maxCalls: 3, bufferBytes: 4096 }) => {
            const api = createWin32SecurityApi(primitives(new Heap(), handles, {
                readDirectory: () => {
                    const page = pages.shift() ?? ERROR_NO_MORE_FILES
                    return typeof page === "number" ? { ok: false, error: page } : { ok: true, value: page }
                },
            }))
            return api.listDirectory(handles.create(), limits)
        }
        assert.deepEqual(listing([dirBuffer(["a", "b", "c", "d"])]), { kind: "truncated" })
        assert.deepEqual(listing([dirBuffer(["a"]), dirBuffer(["b"]), dirBuffer(["c"]), dirBuffer(["d"])]), { kind: "truncated" }, "more pages than calls")
        assert.deepEqual(listing([dirBuffer(["a"]), ERROR_ACCESS_DENIED]), { kind: "error", error: ERROR_ACCESS_DENIED })
        const bad = dirBuffer(["a", "b"])
        assert.deepEqual(listing([bad.slice(0, bad.length - 4)]), { kind: "malformed" })
        assert.equal(parseDirectoryBuffer(Uint8Array.from([...le32(0), ...new Array<number>(56).fill(0), ...le32(3), 0, 0, 0, 0, 0x61, 0, 0])), null, "odd name length")
        assert.equal(parseDirectoryBuffer(Uint8Array.from([...le32(0), ...new Array<number>(56).fill(0), ...le32(0), 0, 0, 0, 0])), null, "empty name")
        const overlapping = dirBuffer(["abc", "d"])
        overlapping.set(le32(8), 0)
        assert.equal(parseDirectoryBuffer(overlapping), null, "next record overlapping the name")
        const unaligned = dirBuffer(["abc", "d"])
        unaligned.set(le32(76), 0)
        assert.equal(parseDirectoryBuffer(unaligned), null, "next record not 8-byte aligned")
        assert.equal(parseDirectoryBuffer(new Uint8Array(10)), null, "shorter than a record header")
    })

    test("directory listing: the same name twice (on one page, across pages, '.' or '..') is inconsistent, never de-duplicated; case variants are kept", () => {
        const handles = new HandleTable()
        const listing = (pages: Uint8Array[]) => createWin32SecurityApi(primitives(new Heap(), handles, {
            readDirectory: () => (pages.length > 0 ? { ok: true, value: pages.shift() as Uint8Array } : { ok: false, error: ERROR_NO_MORE_FILES }),
        })).listDirectory(handles.create(), { maxEntries: 10, maxCalls: 10, bufferBytes: 4096 })
        assert.deepEqual(listing([dirBuffer([".", "..", "a", "b", "a"])]), { kind: "inconsistent" })
        assert.deepEqual(listing([dirBuffer([".", "..", "a"]), dirBuffer(["b", "a"])]), { kind: "inconsistent" }, "across pages (an entry renamed during the enumeration)")
        assert.deepEqual(listing([dirBuffer([".", "..", "a"]), dirBuffer(["."])]), { kind: "inconsistent" })
        assert.deepEqual(listing([dirBuffer([".", "..", "..", "a"])]), { kind: "inconsistent" })
        // whether "A" and "a" can coexist depends on the directory's case sensitivity: decided by the collector, not here
        assert.deepEqual(listing([dirBuffer([".", "..", "A", "a"])]), { kind: "complete", entries: ["A", "a"] })
    })
})

describe("win32-security: known folders and OneDrive accounts", () => {
    test("SHGetKnownFolderPath: the path, freed with CoTaskMemFree; not-set HRESULTs; E_FAIL is an error; freed on failure too", () => {
        const heap = new Heap()
        const calls: string[] = []
        const answer = (hresult: number, text: string | null) => createWin32SecurityApi(primitives(heap, new HandleTable(), {
            getKnownFolderPath: (id, flags) => (calls.push(`${id}:${flags}`), { hresult, path: text === null ? 0n : heap.string(text, "cotask") }),
        }))
        assert.deepEqual(answer(0, "C:\\Users\\Test User é").knownFolder(KNOWN_FOLDER.Profile), { kind: "path", path: "C:\\Users\\Test User é" })
        assert.deepEqual(calls, [`${KNOWN_FOLDER.Profile}:16384`], "KF_FLAG_DONT_VERIFY, never KF_FLAG_CREATE")
        for (const hresult of [0x80070057, 0x80070002, 0x80070003]) assert.equal(answer(hresult | 0, null).knownFolder(KNOWN_FOLDER.SkyDrive).kind, "not-set")
        assert.deepEqual(answer(0x80004005 | 0, null).knownFolder(KNOWN_FOLDER.SkyDrive), { kind: "error", hresult: 0x80004005 })
        assert.equal(answer(0x80004005 | 0, "leftover").knownFolder(KNOWN_FOLDER.SkyDrive).kind, "error")
        assert.equal(answer(0, null).knownFolder(KNOWN_FOLDER.Windows).kind, "error", "S_OK without a path")
        assert.equal(answer(0, "").knownFolder(KNOWN_FOLDER.Windows).kind, "error", "S_OK with an empty path")
        assert.equal(heap.live("cotask"), 0)
    })

    test("OneDrive accounts: only HKCU\\...\\OneDrive\\Accounts and the UserFolder of its subkeys; key closed once", () => {
        const handles = new HandleTable()
        const opened: [string, number][] = []
        const reads: [string, string, number][] = []
        const accounts = (names: string[], values: Record<string, Win32Result<string> & { required?: number }>, open: Win32Result<Handle> | null = null) => createWin32SecurityApi(primitives(new Heap(), handles, {
            regOpenCurrentUserKey: (sub, access) => (opened.push([sub, access]), open ?? { ok: true, value: handles.create() }),
            regEnumKey: (k, i) => (handles.use(k), i < names.length ? { ok: true, value: names[i] as string } : { ok: false, error: ERROR_NO_MORE_ITEMS }),
            regGetString: (_k, sub, value, capacity) => (reads.push([sub, value, capacity]), values[`${sub}:${capacity}`] ?? values[sub] ?? { ok: false, error: ERROR_FILE_NOT_FOUND }),
        })).oneDriveAccounts(4)
        assert.deepEqual(accounts([], {}, { ok: false, error: ERROR_FILE_NOT_FOUND }), { kind: "no-accounts-key" })
        assert.deepEqual(opened, [["Software\\Microsoft\\OneDrive\\Accounts", 0x9]])
        assert.deepEqual(accounts(["Personal", "Business1"], { Personal: { ok: true, value: "C:\\Users\\T\\OneDrive" } }), { kind: "accounts", folders: ["C:\\Users\\T\\OneDrive"] })
        assert.deepEqual(reads.map(([s, v]) => `${s}\\${v}`), ["Personal\\UserFolder", "Business1\\UserFolder"])
        assert.deepEqual(accounts(["Personal"], { "Personal:1024": { ok: false, error: ERROR_MORE_DATA, required: 4000 }, "Personal:4000": { ok: true, value: "D:\\OneDrive" } }), { kind: "accounts", folders: ["D:\\OneDrive"] })
        assert.deepEqual(accounts(["Personal"], { Personal: { ok: false, error: ERROR_ACCESS_DENIED } }), { kind: "unreadable", error: ERROR_ACCESS_DENIED })
        assert.deepEqual(accounts(["Personal"], { Personal: { ok: true, value: "" } }).kind, "unreadable")
        assert.deepEqual(accounts(["a", "b", "c", "d", "e"], {}).kind, "unreadable", "more accounts than the bound")
        assert.deepEqual(accounts([], {}, { ok: false, error: ERROR_ACCESS_DENIED }), { kind: "unreadable", error: ERROR_ACCESS_DENIED })
        assert.equal(handles.open.size, 0)
    })
})

describe("win32-security: CompareStringOrdinal", () => {
    const scripted = (answer: (a: string, b: string, ignoreCase: boolean) => Win32Result<number>) => {
        const calls: [string, string, boolean][] = []
        const api = createWin32SecurityApi(primitives(new Heap(), new HandleTable(), { compareStringOrdinal: (a, b, ignoreCase) => (calls.push([a, b, ignoreCase]), answer(a, b, ignoreCase)) }))
        return { api, calls }
    }

    test("return values: CSTR_LESS_THAN 1, CSTR_EQUAL 2, CSTR_GREATER_THAN 3; 0 is an error with its code; anything else is an error", () => {
        for (const [raw, expected] of [[1, "less"], [2, "equal"], [3, "greater"]] as const) assert.deepEqual(scripted(() => ({ ok: true, value: raw })).api.compareOrdinal("a", "b", true), { ok: true, value: expected })
        assert.deepEqual(scripted(() => ({ ok: false, error: ERROR_INVALID_PARAMETER })).api.compareOrdinal("a", "b", true), { ok: false, error: ERROR_INVALID_PARAMETER })
        for (const raw of [4, -1, 99]) assert.deepEqual(scripted(() => ({ ok: true, value: raw })).api.compareOrdinal("a", "b", true), { ok: false, error: NO_WIN32_CODE })
    })

    test("strings are passed unchanged (Unicode, lengths in UTF-16 code units, path components); Windows decides, nothing is folded here", () => {
        const pairs: [string, string][] = [["CLAUDE", "claude"], ["Σ", "ς"], ["ı", "I"], ["\u212a", "K"], ["é", "É"], ["è", "é"], ["abc", "abcd"], ["😀", "😁"], ["C:\\Users\\Σ\\x", "c:\\users\\ς\\X"]]
        const { api, calls } = scripted(() => ({ ok: true, value: 2 }))
        for (const [a, b] of pairs) assert.deepEqual(api.compareOrdinal(a, b, true), { ok: true, value: "equal" })
        assert.deepEqual(calls, pairs.map(([a, b]) => [a, b, true]), "the exact strings, ignoreCase TRUE")
    })

    test("an embedded NUL or an over-long string is refused before the call", () => {
        const { api, calls } = scripted(() => ({ ok: true, value: 2 }))
        assert.deepEqual(api.compareOrdinal("a\0b", "a", true), { ok: false, error: ERROR_INVALID_PARAMETER })
        assert.deepEqual(api.compareOrdinal("a", "x".repeat(40000), true), { ok: false, error: ERROR_INVALID_PARAMETER })
        assert.equal(calls.length, 0)
    })

    test("native (Windows x64 only, synthetic strings, nothing read from the system): ASCII case folded, lengths distinct, symmetric", { skip: process.platform !== "win32" || process.arch !== "x64" }, () => {
        const api = createWin32SecurityApi(bindWin32Primitives())
        assert.deepEqual(api.compareOrdinal("Fluent-Reader-MCP.Install.JSON", "fluent-reader-mcp.install.json", true), { ok: true, value: "equal" })
        assert.notDeepEqual(api.compareOrdinal("Claude", "claude", false), { ok: true, value: "equal" })
        assert.notDeepEqual(api.compareOrdinal("Claude", "ClaudeBackup", true), { ok: true, value: "equal" })
        assert.deepEqual(api.compareOrdinal("é 😀", "é 😀", true), { ok: true, value: "equal" })
        const flip = { less: "greater", equal: "equal", greater: "less" } as const
        for (const [a, b] of [["Σ", "ς"], ["σ", "ς"], ["ı", "I"], ["\u212a", "K"], ["é", "É"], ["è", "é"], ["Σa", "ςb"]] as const) {
            const ab = api.compareOrdinal(a, b, true)
            const ba = api.compareOrdinal(b, a, true)
            assert.ok(ab.ok && ba.ok, `${a}/${b}`)
            assert.equal(flip[ab.value], ba.value, `${a}/${b} symmetric`)
        }
    })
})

describe("win32-security: module boundaries", () => {
    test("importing the module loads no native code (Koffi is required only by bindWin32Primitives)", () => {
        assert.equal(KOFFI_LOADED_BY_IMPORT, false, "koffi not loaded by importing win32-security and location")
        const compiled = fs.readFileSync(path.join(COMPILED_ROOT, "installer", "setup", "win32-security.js"), "utf8")
        const top = compiled.slice(0, compiled.indexOf("function createPrimitives"))
        assert.doesNotMatch(top, /require\(\s*"koffi"\s*\)/, "no top-level require of koffi")
        assert.match(compiled, /function createPrimitives\(\) \{\s*const koffi = createRequire\(import\.meta\.url\)\("koffi"\)/)
    })

    test("read-only: no mutating Win32 API, only OPEN_EXISTING, no privilege, no SACL, no case folding by JavaScript", () => {
        for (const file of ["win32-security.js", "location-facts.js"]) {
            const compiled = withoutComments(fs.readFileSync(path.join(COMPILED_ROOT, "installer", "setup", file), "utf8"))
            assert.doesNotMatch(compiled, /CreateDirectory|SetSecurityInfo|SetNamedSecurityInfo|SetFileSecurity|SetKernelObjectSecurity|RegSetValue|RegCreateKey|RegDeleteKey|DeleteFile|RemoveDirectory|MoveFile|ReplaceFile|SetFileInformationByHandle|DeviceIoControl|AdjustTokenPrivileges|LookupPrivilegeValue|SACL_SECURITY_INFORMATION|ACCESS_SYSTEM_SECURITY|KF_FLAG_CREATE|CREATE_ALWAYS|CREATE_NEW|OPEN_ALWAYS|TRUNCATE_EXISTING/, file)
            assert.doesNotMatch(compiled, /\.toLowerCase\(|\.toUpperCase\(|toLocale(Lower|Upper)Case|localeCompare/, file)
            assert.doesNotMatch(compiled, /node:fs|node:path|node:child_process/, file)
        }
        const binding = fs.readFileSync(path.join(COMPILED_ROOT, "installer", "setup", "win32-security.js"), "utf8")
        assert.match(binding, /CreateFileW\(path, access, share, null, OPEN_EXISTING, flags, null\)/)
    })
})
