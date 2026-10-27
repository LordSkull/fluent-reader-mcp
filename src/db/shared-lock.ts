/**
 * Preventive protection for FR-REV-001: an SQLite-compatible SHARED lock on
 * the database file, held by a helper process from before the header check
 * until this server's own SQLite connection holds its SHARED lock.
 *
 * Why: a read-only SQLite connection that finds a WAL header creates -wal and
 * -shm next to the database. Checking the header first is not enough, because
 * another process can switch rollback → WAL between the check and SQLite's
 * first read. The switch writes page 1, which needs SQLite's EXCLUSIVE lock;
 * EXCLUSIVE cannot be obtained while any SHARED lock is held. Holding SHARED
 * across the check therefore makes the checked header the one SQLite reads.
 *
 * How: node:fs exposes neither Win32 share modes nor byte-range locks, so the
 * lock is taken by Windows PowerShell 5.1 (part of Windows) with LockFileEx,
 * exactly as SQLite's win32 VFS does for a reader:
 *   PENDING byte (exclusive, fail-immediately) → SHARED range (shared,
 *   fail-immediately) → release PENDING.
 * PENDING_BYTE = 0x40000000, SHARED_FIRST = PENDING_BYTE + 2, SHARED_SIZE = 510
 * (SQLite os_win.c). The helper opens the file with FILE_SHARE_READ |
 * FILE_SHARE_WRITE (no FILE_SHARE_DELETE), the same share mode SQLite uses, so
 * the file cannot be renamed, replaced or deleted while the lock is held.
 *
 * The helper holds no file handle between requests. It exits when its stdin
 * closes (also when this process dies). Its stderr is discarded: it is never
 * forwarded because PowerShell errors could contain paths.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import readline from "node:readline"
import { FrMcpError } from "../errors.js"

const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FrmcpSqliteSharedLock {
  [StructLayout(LayoutKind.Sequential)]
  struct OVERLAPPED { public IntPtr Internal; public IntPtr InternalHigh; public uint Offset; public uint OffsetHigh; public IntPtr hEvent; }
  [StructLayout(LayoutKind.Sequential)]
  struct BY_HANDLE_FILE_INFORMATION {
    public uint Attributes; public uint CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint VolumeSerial; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool LockFileEx(SafeFileHandle h, uint flags, uint reserved, uint lenLow, uint lenHigh, ref OVERLAPPED o);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UnlockFileEx(SafeFileHandle h, uint reserved, uint lenLow, uint lenHigh, ref OVERLAPPED o);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);
  const uint PENDING_BYTE = 0x40000000, SHARED_FIRST = PENDING_BYTE + 2, SHARED_SIZE = 510;
  const uint FAIL_IMMEDIATELY = 1, EXCLUSIVE_LOCK = 2;
  static FileStream held;
  static bool Lock(SafeFileHandle h, uint offset, uint len, uint flags) { var o = new OVERLAPPED(); o.Offset = offset; return LockFileEx(h, flags, 0, len, 0, ref o); }
  static void Unlock(SafeFileHandle h, uint offset, uint len) { var o = new OVERLAPPED(); o.Offset = offset; UnlockFileEx(h, 0, len, 0, ref o); }
  public static string Acquire(string path) {
    if (held != null) return "ERROR state";
    FileStream fs;
    try { fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite); } catch { return "ERROR open"; }
    SafeFileHandle h = fs.SafeFileHandle;
    if (!Lock(h, PENDING_BYTE, 1, FAIL_IMMEDIATELY | EXCLUSIVE_LOCK)) { fs.Dispose(); return "BUSY"; }
    bool shared = Lock(h, SHARED_FIRST, SHARED_SIZE, FAIL_IMMEDIATELY);
    Unlock(h, PENDING_BYTE, 1);
    if (!shared) { fs.Dispose(); return "BUSY"; }
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(h, out info)) { Unlock(h, SHARED_FIRST, SHARED_SIZE); fs.Dispose(); return "ERROR info"; }
    held = fs;
    ulong index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
    return "LOCKED " + info.VolumeSerial + " " + index;
  }
  public static string Release() {
    if (held != null) { Unlock(held.SafeFileHandle, SHARED_FIRST, SHARED_SIZE); held.Dispose(); held = null; }
    return "RELEASED";
  }
}
'@
} catch { [Console]::Out.WriteLine('FATAL'); exit 2 }
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.StartsWith('ACQUIRE ')) { $r = [FrmcpSqliteSharedLock]::Acquire([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(8)))) }
  elseif ($line -eq 'RELEASE') { $r = [FrmcpSqliteSharedLock]::Release() }
  else { $r = 'ERROR command' }
  [Console]::Out.WriteLine($r)
}
[void][FrmcpSqliteSharedLock]::Release()
`

const START_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 2_000

/** Identity of the file the helper locked (volume serial, file index). */
export interface LockLease {
    readonly dev: bigint
    readonly ino: bigint
}

export interface SharedLockOptions {
    /** Override of the PowerShell executable (tests use it to simulate a missing helper). */
    readonly executable?: string
}

function defaultExecutable(): string | undefined {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (systemRoot === undefined) return undefined
    return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

function unavailable(reason: "helper-unavailable" | "helper-lost" | "unsupported-platform"): FrMcpError {
    return new FrMcpError("DB_PROTECTION_UNAVAILABLE", reason)
}

export class SqliteSharedLock {
    readonly #executable: string | undefined
    #child: ChildProcessWithoutNullStreams | undefined
    #exited = true
    #lines: string[] = []
    #waiter: (() => void) | undefined
    #starting: Promise<void> | undefined
    #closed = false

    constructor(options: SharedLockOptions = {}) {
        this.#executable = options.executable ?? defaultExecutable()
    }

    /** PID of the current helper, if one is running. */
    get pid(): number | undefined {
        return this.#exited ? undefined : this.#child?.pid
    }

    /**
     * Synchronous liveness check. While this process holds the ChildProcess
     * handle (until its exit event is processed) the PID cannot be reused, so a
     * live PID is the helper itself. A live helper has not released the lock:
     * it releases only on RELEASE, on stdin EOF or by terminating.
     */
    isAliveSync(): boolean {
        const pid = this.pid
        if (pid === undefined) return false
        try {
            process.kill(pid, 0)
            return true
        } catch {
            return false
        }
    }

    async #start(): Promise<void> {
        if (process.platform !== "win32") throw unavailable("unsupported-platform")
        if (this.#executable === undefined) throw unavailable("helper-unavailable")
        const encoded = Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64")
        let child: ChildProcessWithoutNullStreams
        try {
            child = spawn(this.#executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            })
        } catch {
            throw unavailable("helper-unavailable")
        }
        this.#child = child
        this.#exited = false
        this.#lines = []
        child.stderr.resume() // discarded, never logged
        child.stdin.on("error", () => undefined)
        const onExit = (): void => {
            if (this.#child !== child) return
            this.#exited = true
            this.#child = undefined
            this.#waiter?.()
        }
        child.once("exit", onExit)
        child.once("error", onExit)
        readline.createInterface({ input: child.stdout }).on("line", (line) => {
            if (this.#child !== child) return
            this.#lines.push(line.trim())
            this.#waiter?.()
        })
        // PowerShell may print banners or progress before the script runs.
        const deadline = Date.now() + START_TIMEOUT_MS
        for (;;) {
            const line = await this.#nextLine(deadline - Date.now())
            if (line === "READY") return
            if (line === undefined || line === "FATAL") {
                this.#kill()
                throw unavailable("helper-unavailable")
            }
        }
    }

    async #ensureStarted(): Promise<void> {
        // After close() no helper is started again: a late call must not leave a process behind.
        if (this.#closed) throw unavailable("helper-unavailable")
        if (!this.#exited && this.#child !== undefined) return
        this.#starting ??= this.#start().finally(() => (this.#starting = undefined))
        await this.#starting
    }

    /** Next protocol line; undefined on timeout or helper exit. */
    async #nextLine(timeoutMs: number): Promise<string | undefined> {
        const deadline = Date.now() + timeoutMs
        while (this.#lines.length === 0) {
            if (this.#exited || Date.now() >= deadline) return undefined
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
                this.#waiter = () => {
                    clearTimeout(timer)
                    resolve()
                }
            })
            this.#waiter = undefined
        }
        return this.#lines.shift()
    }

    async #request(command: string): Promise<string> {
        const child = this.#child
        if (child === undefined || this.#exited) throw unavailable("helper-lost")
        this.#lines = []
        child.stdin.write(`${command}\n`)
        const line = await this.#nextLine(REQUEST_TIMEOUT_MS)
        if (line === undefined) {
            // Unknown state: terminating the helper guarantees the lock is released.
            this.#kill()
            throw unavailable("helper-lost")
        }
        return line
    }

    /**
     * Takes the SHARED lock on `filePath`. Returns "busy" when a writer holds
     * PENDING or EXCLUSIVE, "unopenable" when the helper cannot open the file
     * (no lock is held). Throws DB_PROTECTION_UNAVAILABLE otherwise.
     */
    async acquire(filePath: string): Promise<LockLease | "busy" | "unopenable"> {
        await this.#ensureStarted()
        const reply = await this.#request(`ACQUIRE ${Buffer.from(filePath, "utf8").toString("base64")}`)
        if (reply === "BUSY") return "busy"
        if (reply === "ERROR open") return "unopenable"
        const match = /^LOCKED (\d+) (\d+)$/.exec(reply)
        if (match === null) {
            this.#kill()
            throw unavailable("helper-unavailable")
        }
        return { dev: BigInt(match[1] as string), ino: BigInt(match[2] as string) }
    }

    /** Releases the lock. If the helper does not confirm, it is terminated. */
    async release(): Promise<void> {
        if (this.#exited || this.#child === undefined) return
        let reply: string | undefined
        try {
            reply = await this.#request("RELEASE")
        } catch {
            return // helper gone or killed: the OS released the lock
        }
        if (reply !== "RELEASED") this.#kill()
    }

    #kill(): void {
        const child = this.#child
        if (child === undefined) return
        try {
            child.kill()
        } catch {
            // already gone
        }
    }

    /** Terminates the helper immediately (fatal errors; tests simulate an external kill). */
    terminate(): void {
        this.#kill()
    }

    /**
     * Stops the helper (stdin EOF), terminating it if it does not exit in
     * time. Final: later acquisitions fail with DB_PROTECTION_UNAVAILABLE.
     */
    async close(): Promise<void> {
        this.#closed = true
        await this.#starting?.catch(() => undefined)
        const child = this.#child
        if (child === undefined || this.#exited) return
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.#kill()
                resolve()
            }, CLOSE_TIMEOUT_MS)
            child.once("exit", () => {
                clearTimeout(timer)
                resolve()
            })
            child.stdin.end()
        })
    }
}
