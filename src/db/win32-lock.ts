/**
 * Preventive protection for FR-REV-001: an SQLite-compatible SHARED lock on
 * the database file, taken and held by this Node.js process itself through
 * Win32 (Koffi FFI), from before the header check until after this process's
 * own SQLite connection is closed.
 *
 * Why: a read-only SQLite connection that finds a WAL header creates -wal and
 * -shm next to the database. Checking the header first is not enough, because
 * another process can switch rollback → WAL between the check and SQLite's
 * first read. The switch writes page 1, which needs SQLite's EXCLUSIVE lock;
 * EXCLUSIVE cannot be obtained while any SHARED lock is held. Holding SHARED
 * across the check therefore makes the checked header the one SQLite reads.
 *
 * Why in-process: the lock belongs to a handle of this process. It cannot be
 * lost while this process keeps running (no helper that can die on its own),
 * and when this process dies the OS closes the handle and releases the lock
 * together with SQLite's own handle.
 *
 * Lock sequence (SQLite 3.53.4 os_win.c, winLock() for SHARED_LOCK on NT):
 *   PENDING byte: LockFileEx(LOCKFILE_FAIL_IMMEDIATELY), a *shared* lock
 *   SHARED range: LockFileEx(LOCKFILE_FAIL_IMMEDIATELY), shared
 *   release the PENDING byte
 * PENDING_BYTE = 0x40000000, SHARED_FIRST = PENDING_BYTE + 2, SHARED_SIZE = 510
 * (os.h). A writer holding PENDING (exclusive) or EXCLUSIVE makes the first or
 * second step fail with ERROR_LOCK_VIOLATION: reported as "busy", nothing held.
 *
 * The file is opened like SQLite opens it (winOpen(), read-only): GENERIC_READ,
 * FILE_SHARE_READ | FILE_SHARE_WRITE (no FILE_SHARE_DELETE), OPEN_EXISTING,
 * FILE_ATTRIBUTE_NORMAL. Without FILE_SHARE_DELETE the file cannot be renamed,
 * replaced or deleted while the handle is open. The handle is synchronous (no
 * FILE_FLAG_OVERLAPPED): LockFileEx with LOCKFILE_FAIL_IMMEDIATELY returns at
 * once, and the OVERLAPPED structure only carries the offset for the duration
 * of the call (no native memory outlives a call).
 *
 * Every Win32 call is synchronous. The handle is a plain integer held by
 * HeldLock: no finalizer is attached, so the garbage collector never releases
 * the lock; only HeldLock.release() (or process exit) does, exactly once.
 */

import { createRequire } from "node:module"
import type * as Koffi from "koffi"
import { FrMcpError, type ErrorReason } from "../errors.js"

// SQLite os.h (unchanged since 3.x; verified against 3.53.4).
export const PENDING_BYTE = 0x40000000
export const RESERVED_BYTE = PENDING_BYTE + 1
export const SHARED_FIRST = PENDING_BYTE + 2
export const SHARED_SIZE = 510

// Win32 constants (fileapi.h, winnt.h, winerror.h).
const GENERIC_READ = 0x80000000
const FILE_SHARE_READ = 0x1
const FILE_SHARE_WRITE = 0x2
const OPEN_EXISTING = 3
const FILE_ATTRIBUTE_NORMAL = 0x80
export const LOCKFILE_FAIL_IMMEDIATELY = 0x1
export const LOCKFILE_EXCLUSIVE_LOCK = 0x2
export const ERROR_FILE_NOT_FOUND = 2
export const ERROR_PATH_NOT_FOUND = 3
export const ERROR_ACCESS_DENIED = 5
export const ERROR_INVALID_HANDLE = 6
export const ERROR_SHARING_VIOLATION = 32
export const ERROR_LOCK_VIOLATION = 33
export const ERROR_NOT_LOCKED = 158

/** 100 ns ticks between 1601-01-01 (FILETIME) and 1970-01-01 (libuv, as used by fs.stat). */
const FILETIME_UNIX_EPOCH = 116444736000000000n

/** Architectures on which the FFI declarations have been verified. */
const VERIFIED_ARCHS: readonly string[] = ["x64"]

/** A Win32 HANDLE value (pointer-sized, unsigned). */
export type Win32Handle = bigint

/** Identity of an open file, in the units of fs.lstat({ bigint: true }). */
export interface HandleIdentity {
    readonly dev: bigint
    readonly ino: bigint
    readonly birthtimeNs: bigint
}

/**
 * The Win32 calls used by the lock. Each method makes exactly one Win32 call
 * and returns its GetLastError() value on failure (0 on success). Tests wrap
 * the real implementation to inject failures.
 */
export interface Win32FileApi {
    /** CreateFileW for locking (parameters in the module comment). */
    open(filePath: string): { readonly handle: Win32Handle } | { readonly error: number }
    /** LockFileEx(handle, flags, 0, length, 0, OVERLAPPED{Offset: offset}). */
    lock(handle: Win32Handle, flags: number, offset: number, length: number): number
    /** UnlockFileEx(handle, 0, length, 0, OVERLAPPED{Offset: offset}). */
    unlock(handle: Win32Handle, offset: number, length: number): number
    /** GetFileInformationByHandle → volume serial, file index, creation time. */
    identity(handle: Win32Handle): HandleIdentity | { readonly error: number }
    /** CloseHandle. Must be called at most once per handle: handle values are reused. */
    close(handle: Win32Handle): number
}

function unavailable(reason: ErrorReason): FrMcpError {
    return new FrMcpError("DB_PROTECTION_UNAVAILABLE", reason)
}

let kernel32Api: Win32FileApi | undefined

/**
 * The kernel32 binding through Koffi, created once per process. Throws if
 * Koffi or its native module cannot be loaded, or a layout check fails.
 */
export function bindKernel32(): Win32FileApi {
    kernel32Api ??= createKernel32Api()
    return kernel32Api
}

function createKernel32Api(): Win32FileApi {
    const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi
    const kernel32 = koffi.load("kernel32.dll")

    // Anonymous types: Koffi type names are global to the process.
    // HANDLE is `void *`: 8 bytes on 64-bit Windows; Koffi represents pointers as BigInt.
    const HANDLE = koffi.pointer(koffi.opaque())
    if (koffi.sizeof(HANDLE) !== 8) throw new Error("unexpected HANDLE size")
    // INVALID_HANDLE_VALUE = (HANDLE)(LONG_PTR)-1, read back as an unsigned 64-bit value.
    const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn

    // minwinbase.h, 64-bit layout: 8 + 8 + 4 + 4 + 8 = 32 bytes. The anonymous
    // union { struct { Offset, OffsetHigh }; PVOID Pointer } is declared as its
    // DWORD view, the one SQLite fills.
    const OVERLAPPED = koffi.struct({
        Internal: "uintptr_t",
        InternalHigh: "uintptr_t",
        Offset: "uint32_t",
        OffsetHigh: "uint32_t",
        hEvent: "void *",
    })
    const FILETIME = koffi.struct({ dwLowDateTime: "uint32_t", dwHighDateTime: "uint32_t" })
    // fileapi.h: 52 bytes, 4-byte alignment.
    const BY_HANDLE_FILE_INFORMATION = koffi.struct({
        dwFileAttributes: "uint32_t",
        ftCreationTime: FILETIME,
        ftLastAccessTime: FILETIME,
        ftLastWriteTime: FILETIME,
        dwVolumeSerialNumber: "uint32_t",
        nFileSizeHigh: "uint32_t",
        nFileSizeLow: "uint32_t",
        nNumberOfLinks: "uint32_t",
        nFileIndexHigh: "uint32_t",
        nFileIndexLow: "uint32_t",
    })
    if (
        koffi.sizeof(OVERLAPPED) !== 32 ||
        koffi.offsetof(OVERLAPPED, "Offset") !== 16 ||
        koffi.offsetof(OVERLAPPED, "hEvent") !== 24 ||
        koffi.sizeof(BY_HANDLE_FILE_INFORMATION) !== 52 ||
        koffi.offsetof(BY_HANDLE_FILE_INFORMATION, "dwVolumeSerialNumber") !== 28 ||
        koffi.offsetof(BY_HANDLE_FILE_INFORMATION, "nFileIndexLow") !== 48
    ) {
        throw new Error("unexpected structure layout")
    }

    // WINAPI is __stdcall; on x64 there is a single calling convention and Koffi ignores the tag.
    const CreateFileW = kernel32.func("__stdcall", "CreateFileW", HANDLE, [
        "str16", // LPCWSTR lpFileName (UTF-16, NUL-terminated by Koffi)
        "uint32_t", // DWORD dwDesiredAccess
        "uint32_t", // DWORD dwShareMode
        "void *", // LPSECURITY_ATTRIBUTES (NULL)
        "uint32_t", // DWORD dwCreationDisposition
        "uint32_t", // DWORD dwFlagsAndAttributes
        HANDLE, // HANDLE hTemplateFile (NULL)
    ])
    const LockFileEx = kernel32.func("__stdcall", "LockFileEx", "int", [
        HANDLE,
        "uint32_t", // dwFlags
        "uint32_t", // dwReserved (0)
        "uint32_t", // nNumberOfBytesToLockLow
        "uint32_t", // nNumberOfBytesToLockHigh
        koffi.inout(koffi.pointer(OVERLAPPED)),
    ])
    const UnlockFileEx = kernel32.func("__stdcall", "UnlockFileEx", "int", [
        HANDLE,
        "uint32_t", // dwReserved (0)
        "uint32_t", // nNumberOfBytesToUnlockLow
        "uint32_t", // nNumberOfBytesToUnlockHigh
        koffi.inout(koffi.pointer(OVERLAPPED)),
    ])
    const GetFileInformationByHandle = kernel32.func("__stdcall", "GetFileInformationByHandle", "int", [
        HANDLE,
        koffi.out(koffi.pointer(BY_HANDLE_FILE_INFORMATION)),
    ])
    const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "int", [HANDLE])
    // Koffi saves the thread's last-error value after each call and restores it
    // before the next one, so GetLastError() right after a call reports that call.
    const GetLastError = kernel32.func("__stdcall", "GetLastError", "uint32_t", [])

    const overlapped = (offset: number): Record<string, unknown> => ({
        Internal: 0,
        InternalHigh: 0,
        Offset: offset,
        OffsetHigh: 0,
        hEvent: null,
    })
    const lastError = (): number => (GetLastError() as number) || ERROR_INVALID_HANDLE

    return {
        open(filePath) {
            const handle = CreateFileW(
                filePath,
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null,
            ) as unknown
            if (typeof handle !== "bigint" || handle === INVALID_HANDLE_VALUE || handle === 0n) {
                return { error: lastError() }
            }
            return { handle }
        },
        lock(handle, flags, offset, length) {
            return LockFileEx(handle, flags, 0, length, 0, overlapped(offset)) ? 0 : lastError()
        },
        unlock(handle, offset, length) {
            return UnlockFileEx(handle, 0, length, 0, overlapped(offset)) ? 0 : lastError()
        },
        identity(handle) {
            const info: Record<string, unknown> = {}
            if (!GetFileInformationByHandle(handle, info)) return { error: lastError() }
            const created = info.ftCreationTime as { dwLowDateTime: number; dwHighDateTime: number }
            const ft = (BigInt(created.dwHighDateTime) << 32n) | BigInt(created.dwLowDateTime)
            return {
                dev: BigInt(info.dwVolumeSerialNumber as number),
                ino: (BigInt(info.nFileIndexHigh as number) << 32n) | BigInt(info.nFileIndexLow as number),
                birthtimeNs: (ft - FILETIME_UNIX_EPOCH) * 100n,
            }
        },
        close(handle) {
            return CloseHandle(handle) ? 0 : lastError()
        },
    }
}

/**
 * An SQLite-compatible SHARED lock held by this process on one file.
 * release() unlocks and closes the handle exactly once.
 */
export class HeldLock implements HandleIdentity {
    readonly dev: bigint
    readonly ino: bigint
    readonly birthtimeNs: bigint
    readonly #api: Win32FileApi
    readonly #onRelease: (lock: HeldLock) => void
    #handle: Win32Handle | undefined

    /** @internal Created only by SqliteFileLock.acquire(). */
    constructor(api: Win32FileApi, handle: Win32Handle, identity: HandleIdentity, onRelease: (lock: HeldLock) => void) {
        this.#api = api
        this.#handle = handle
        this.dev = identity.dev
        this.ino = identity.ino
        this.birthtimeNs = identity.birthtimeNs
        this.#onRelease = onRelease
    }

    /** True until release() is called. */
    get held(): boolean {
        return this.#handle !== undefined
    }

    /**
     * Unlocks the SHARED range and closes the handle. Idempotent. The handle is
     * forgotten before CloseHandle, so it can never be closed twice. Closing a
     * handle releases its locks even if UnlockFileEx failed; any failure is
     * reported as INTERNAL_ERROR after the handle is closed.
     */
    release(): void {
        const handle = this.#handle
        if (handle === undefined) return
        this.#handle = undefined
        let unlockError = 0
        let closeError = 0
        try {
            unlockError = this.#api.unlock(handle, SHARED_FIRST, SHARED_SIZE)
        } catch {
            unlockError = -1
        } finally {
            try {
                closeError = this.#api.close(handle)
            } catch {
                closeError = -1
            }
            this.#onRelease(this)
        }
        if ((unlockError !== 0 && unlockError !== ERROR_NOT_LOCKED) || closeError !== 0) {
            throw new FrMcpError("INTERNAL_ERROR", "lock-release")
        }
    }
}

export interface SqliteFileLockOptions {
    /** Replaces the Koffi binding (tests inject failures or a missing FFI). */
    readonly api?: () => Win32FileApi
    /** Overrides process.platform / process.arch (tests). */
    readonly platform?: string
    readonly arch?: string
}

/**
 * Factory of in-process SHARED locks. The Win32 binding is loaded on first use.
 * close() is final: later acquisitions fail; locks already held stay held
 * until their owner releases them (never released early).
 */
export class SqliteFileLock {
    readonly #loadApi: () => Win32FileApi
    readonly #platform: string
    readonly #arch: string
    #api: Win32FileApi | undefined
    #closed = false
    readonly #held = new Set<HeldLock>()

    constructor(options: SqliteFileLockOptions = {}) {
        this.#loadApi = options.api ?? bindKernel32
        this.#platform = options.platform ?? process.platform
        this.#arch = options.arch ?? process.arch
    }

    /** Number of locks (open handles) currently held through this instance. */
    get heldCount(): number {
        return this.#held.size
    }

    get closed(): boolean {
        return this.#closed
    }

    #ensureApi(): Win32FileApi {
        if (this.#closed) throw unavailable("closed")
        if (this.#platform !== "win32" || !VERIFIED_ARCHS.includes(this.#arch)) throw unavailable("unsupported-platform")
        if (this.#api === undefined) {
            try {
                this.#api = this.#loadApi()
            } catch {
                throw unavailable("ffi-unavailable")
            }
        }
        return this.#api
    }

    /**
     * Opens `filePath` and takes the SHARED lock, synchronously. Returns
     * "busy" when a writer holds PENDING or EXCLUSIVE, "unopenable" when the
     * file cannot be opened (nothing is held in either case). Throws
     * DB_PROTECTION_UNAVAILABLE on any other failure, after closing the handle.
     */
    acquire(filePath: string): HeldLock | "busy" | "unopenable" {
        const api = this.#ensureApi()
        const opened = api.open(filePath)
        if ("error" in opened) {
            return opened.error === ERROR_SHARING_VIOLATION ? "busy" : "unopenable"
        }
        const handle = opened.handle
        let owned = true // until handed over to a HeldLock
        try {
            const pending = api.lock(handle, LOCKFILE_FAIL_IMMEDIATELY, PENDING_BYTE, 1)
            if (pending === ERROR_LOCK_VIOLATION) return "busy"
            if (pending !== 0) throw unavailable("lock-failed")

            const shared = api.lock(handle, LOCKFILE_FAIL_IMMEDIATELY, SHARED_FIRST, SHARED_SIZE)
            // PENDING is held only while taking SHARED, as in winLock().
            if (api.unlock(handle, PENDING_BYTE, 1) !== 0) throw unavailable("lock-failed")
            if (shared === ERROR_LOCK_VIOLATION) return "busy"
            if (shared !== 0) throw unavailable("lock-failed")

            const identity = api.identity(handle)
            if ("error" in identity) throw unavailable("lock-failed")

            const held = new HeldLock(api, handle, identity, (lock) => this.#held.delete(lock))
            this.#held.add(held)
            owned = false
            return held
        } catch (error) {
            if (error instanceof FrMcpError) throw error
            throw unavailable("lock-failed")
        } finally {
            // Any exit without a HeldLock closes the handle (and so drops its locks).
            if (owned) {
                try {
                    api.close(handle)
                } catch {
                    // nothing else can be done with this handle
                }
            }
        }
    }

    /** Refuses further acquisitions. Locks still held are released by their owners. */
    close(): void {
        this.#closed = true
    }
}
