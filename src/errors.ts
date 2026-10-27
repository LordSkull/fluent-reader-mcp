/**
 * Domain errors.
 *
 * Every message and hint is a fixed string chosen by `code`. Nothing from the
 * filesystem, SQLite, JSON.parse or the profile (paths, SQL, article data,
 * config contents) is ever interpolated, and no `cause` is attached, so an
 * error can be serialized, logged or returned to an MCP client as-is.
 */

export const ERROR_CODES = [
    "PROFILE_UNAVAILABLE",
    "SETTINGS_UNAVAILABLE",
    "SETTINGS_TRANSIENT",
    "SETTINGS_INVALID",
    "SETTINGS_TOO_LARGE",
    "SCHEMA_UNSUPPORTED",
    "RUNTIME_CAPABILITY_MISSING",
    "DB_BUSY",
    "DB_NEEDS_RECOVERY",
    "DB_REPLACED",
    "DB_WAL_UNSUPPORTED",
    "DB_PROTECTION_UNAVAILABLE",
    "DB_UNREADABLE",
    "INTERNAL_ERROR",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** Fixed, data-free sub-classification used for diagnostics and tests. */
export type ErrorReason =
    // profile
    | "not-configured"
    | "ambiguous"
    | "invalid-argument"
    | "not-absolute"
    | "network-path"
    | "not-local"
    | "not-found"
    | "not-directory"
    | "db-missing"
    | "config-missing"
    | "linked-file"
    | "not-regular-file"
    | "outside-profile"
    | "inaccessible"
    // settings
    | "missing"
    | "permission-denied"
    | "identity-mismatch"
    | "open-failed"
    | "size-changed"
    | "file-too-large"
    | "groups-too-large"
    | "rules-too-large"
    | "not-utf8"
    | "not-json"
    | "not-object"
    // database
    | "not-sqlite"
    | "unsupported-format"
    | "wal-mode"
    | "wal-files-present"
    | "hot-journal"
    | "identity-changed"
    | "missing-table"
    | "missing-column"
    | "column-type"
    | "primary-key"
    | "octet-length"
    | "query-only"
    | "helper-unavailable"
    | "helper-lost"
    | "unsupported-platform"
    | "busy"
    | "io"
    | "corrupt"
    // generic
    | "async-callback"
    | "unexpected"

const TEXT: Readonly<Record<ErrorCode, { message: string; hint: string }>> = {
    PROFILE_UNAVAILABLE: {
        message: "The Fluent Reader profile directory is not configured or is not valid.",
        hint: "Pass one absolute local directory with --profile-dir (or FLUENT_READER_PROFILE_DIR) that contains fluent-reader.db and config.json as regular files.",
    },
    SETTINGS_UNAVAILABLE: {
        message:
            "The profile settings file is missing, cannot be opened with the current permissions, or is not a regular file inside the profile directory.",
        hint: "Check that config.json is a readable regular file (not a link) in the profile directory.",
    },
    SETTINGS_TRANSIENT: {
        message: "The profile settings file kept changing while it was being read.",
        hint: "Retry the request; Fluent Reader may be saving its settings.",
    },
    SETTINGS_INVALID: {
        message: "The profile settings could not be parsed or have an unexpected structure.",
        hint: "Open Fluent Reader to repair its settings; the server never modifies config.json.",
    },
    SETTINGS_TOO_LARGE: {
        message: "The profile settings exceed the supported size or structural limits.",
        hint: "The settings file or one of its sections is larger than this server accepts.",
    },
    SCHEMA_UNSUPPORTED: {
        message: "The profile database does not have a supported Fluent Reader schema.",
        hint: "Use a profile created by a supported Fluent Reader version; the server never migrates the database.",
    },
    RUNTIME_CAPABILITY_MISSING: {
        message: "The SQLite runtime lacks a capability this server requires.",
        hint: "Use the supported Node.js 24 release line.",
    },
    DB_BUSY: {
        message: "The profile database stayed locked longer than the allowed wait.",
        hint: "Retry later; Fluent Reader may be writing to the database.",
    },
    DB_NEEDS_RECOVERY: {
        message: "The profile database has an unfinished transaction that a read-only reader cannot recover.",
        hint: "Open Fluent Reader once so that it can recover the database, then retry.",
    },
    DB_REPLACED: {
        message: "The profile database file was replaced after the server started.",
        hint: "Restart the MCP server to use the new database file.",
    },
    DB_WAL_UNSUPPORTED: {
        message:
            "The profile database is in write-ahead logging mode or has write-ahead log files (-wal/-shm) next to it; it was not opened.",
        hint: "Read-only access is refused in this case because SQLite could create or modify files in the profile directory.",
    },
    DB_PROTECTION_UNAVAILABLE: {
        message: "The lock that keeps the profile database unchanged during reads could not be obtained or was lost.",
        hint: "Retry; the server never reads the database without this protection. It requires Windows PowerShell 5.1 with Add-Type allowed.",
    },
    DB_UNREADABLE: {
        message: "The profile database could not be read.",
        hint: "Check that the database file is accessible and not damaged.",
    },
    INTERNAL_ERROR: {
        message: "An internal error occurred.",
        hint: "Retry the request; if it persists, restart the server.",
    },
}

export class FrMcpError extends Error {
    override readonly name = "FrMcpError"
    readonly code: ErrorCode
    readonly reason: ErrorReason | undefined
    readonly hint: string

    constructor(code: ErrorCode, reason?: ErrorReason) {
        super(TEXT[code].message)
        this.code = code
        this.reason = reason
        this.hint = TEXT[code].hint
    }

    toJSON(): { code: ErrorCode; message: string; hint: string; reason?: ErrorReason } {
        return {
            code: this.code,
            message: this.message,
            hint: this.hint,
            ...(this.reason !== undefined && { reason: this.reason }),
        }
    }
}

export function isFrMcpError(value: unknown): value is FrMcpError {
    return value instanceof FrMcpError
}

/** Node.js `code` of a system error (`ENOENT`, `EBUSY`, ...), if any. */
export function systemErrorCode(error: unknown): string | undefined {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = (error as { code: unknown }).code
        return typeof code === "string" ? code : undefined
    }
    return undefined
}

/** Extended SQLite result code of a `node:sqlite` error, if any. */
function sqliteErrcode(error: unknown): number | undefined {
    if (systemErrorCode(error) !== "ERR_SQLITE_ERROR") return undefined
    const errcode = (error as { errcode?: unknown }).errcode
    return typeof errcode === "number" ? errcode : undefined
}

// SQLite result codes (https://sqlite.org/rescode.html).
const SQLITE_PERM = 3
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const SQLITE_IOERR = 10
const SQLITE_CORRUPT = 11
const SQLITE_CANTOPEN = 14
const SQLITE_NOTADB = 26
const SQLITE_READONLY_RECOVERY = 264
const SQLITE_READONLY_ROLLBACK = 776

/**
 * Converts any thrown value into a sanitized domain error. Raw messages of
 * filesystem, SQLite or JSON errors are discarded.
 */
export function toSafeError(error: unknown): FrMcpError {
    if (error instanceof FrMcpError) return error
    const errcode = sqliteErrcode(error)
    if (errcode !== undefined) {
        if (errcode === SQLITE_READONLY_ROLLBACK || errcode === SQLITE_READONLY_RECOVERY) {
            return new FrMcpError("DB_NEEDS_RECOVERY", "hot-journal")
        }
        switch (errcode & 0xff) {
            case SQLITE_BUSY:
            case SQLITE_LOCKED:
                return new FrMcpError("DB_BUSY", "busy")
            case SQLITE_CORRUPT:
            case SQLITE_NOTADB:
                return new FrMcpError("DB_UNREADABLE", "corrupt")
            case SQLITE_IOERR:
            case SQLITE_CANTOPEN:
            case SQLITE_PERM:
                return new FrMcpError("DB_UNREADABLE", "io")
        }
    }
    return new FrMcpError("INTERNAL_ERROR", "unexpected")
}
