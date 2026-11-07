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
    "INVALID_ARGUMENT",
    "NOT_FOUND",
    "GROUP_AMBIGUOUS",
    "ID_RANGE_UNSUPPORTED",
    "LIMIT_EXCEEDED",
    "SOURCE_IDENTITY_CHANGED",
    "SOURCE_REF_EXPIRED",
    "CURSOR_INVALID",
    "CURSOR_EXPIRED",
    "CURSOR_MISMATCH",
    "CURSOR_STALE",
    "FLUENT_READER_RUNNING",
    "REVISION_CONFLICT",
    "RULE_NOT_FOUND",
    "RULE_WRITE_BUSY",
    "RULE_BACKUP_UNAVAILABLE",
    "RULE_WRITE_FAILED",
    "RULE_WRITE_UNVERIFIED",
    "PREFERENCES_UNAVAILABLE",
    "PREFERENCES_INVALID",
    "PROFILE_BINDING_REQUIRED",
    "PREVIEW_INVALID",
    "PREVIEW_EXPIRED",
    "PREFERENCES_REVISION_CONFLICT",
    "PREFERENCES_WRITE_BUSY",
    "PREFERENCES_BACKUP_UNAVAILABLE",
    "PREFERENCES_WRITE_FAILED",
    "PREFERENCES_WRITE_UNVERIFIED",
    "PREFERENCE_TEXT_REJECTED",
    "PREFERENCE_BINDING_REVIEW_REQUIRED",
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
    | "ffi-unavailable"
    | "lock-failed"
    | "lock-release"
    | "closed"
    | "unsupported-platform"
    | "busy"
    | "io"
    | "corrupt"
    // tools
    | "source-not-found"
    | "article-not-found"
    | "too-many-rules"
    | "text-encoding"
    | "group-not-found"
    | "not-a-group"
    | "duplicate-gid"
    | "sid-out-of-range"
    | "article-id-out-of-range"
    | "record-too-large"
    | "response-too-large"
    | "ref-mismatch"
    | "other-process"
    | "malformed"
    | "unknown-or-expired"
    | "scan-expired"
    | "tool-mismatch"
    | "filters-changed"
    | "group-changed"
    | "rules-changed"
    | "schema-changed"
    | "sources-changed"
    | "position-changed"
    | "source-identity-unverifiable"
    // rule writes
    | "lockfile-present"
    | "app-started"
    | "revision-mismatch"
    | "settings-changed"
    | "rule-not-found"
    | "invalid-regex"
    | "pattern-too-long"
    | "duplicate-action"
    | "duplicate-key"
    | "byte-order-mark"
    | "hard-linked"
    | "write-in-progress"
    | "write-guard-orphaned"
    | "write-lock-orphaned"
    | "backup-location"
    | "backup-failed"
    | "write-failed"
    | "replace-failed"
    | "read-back-failed"
    // news preferences
    | "storage-location"
    | "unsafe-storage"
    | "profile-identity"
    | "invalid-markdown"
    | "preferences-too-large"
    | "catalog-too-large"
    | "profile-binding"
    | "already-initialized"
    | "not-initialized"
    | "preview-invalid"
    | "preview-expired"
    | "preview-mismatch"
    | "preview-reused"
    | "catalog-changed"
    | "duplicate-mapping"
    | "invalid-mapping"
    | "preference-target-not-found"
    | "preferences-read-failed"
    | "unmapped-sections"
    | "binding-review-required"
    | "text-empty"
    | "text-too-long"
    | "text-control"
    | "text-markup"
    | "text-url"
    | "text-credential"
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
        hint: "Open Fluent Reader to repair its settings; this server never repairs config.json.",
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
        hint: "Retry; the server never reads the database without this protection. It requires Windows x64 and the bundled Koffi native module.",
    },
    DB_UNREADABLE: {
        message: "The profile database could not be read.",
        hint: "Check that the database file is accessible and not damaged.",
    },
    INVALID_ARGUMENT: {
        message: "The tool arguments are not valid.",
        hint: "Check argument names, types and ranges against the tool's input schema; unknown arguments are rejected.",
    },
    NOT_FOUND: {
        message: "The requested source, group or article does not exist.",
        hint: "Call list_sources or list_groups to obtain current identifiers; a source id can be reused after its source is deleted, and article ids can change after a backup restore.",
    },
    GROUP_AMBIGUOUS: {
        message: "The group id appears more than once in the profile settings, so its members cannot be determined.",
        hint: "Open Fluent Reader so that it can repair its groups; this server never repairs config.json.",
    },
    ID_RANGE_UNSUPPORTED: {
        message:
            "The profile database contains ids outside the supported range (source ids 0 to 2^53-1, article ids 1 to 2^53-1).",
        hint: "The database was probably modified outside Fluent Reader; sources or articles cannot be listed safely.",
    },
    LIMIT_EXCEEDED: {
        message: "A record is too large to be read or returned within the response size limit.",
        hint: "The record is neither truncated nor skipped: pagination stops before it, and list_sources filters (groupId, includeHidden, query) can exclude it. For get_article, metadata that cannot fit even with an empty body is reported this way.",
    },
    SOURCE_IDENTITY_CHANGED: {
        message: "The source with this id is no longer the source that the sourceRef refers to.",
        hint: "The source was deleted and its id reused, or its identifying attributes changed. Call list_sources again.",
    },
    SOURCE_REF_EXPIRED: {
        message: "The sourceRef was issued by another run of the MCP server and cannot be verified.",
        hint: "Call list_sources, or get_source without sourceRef, to obtain a current sourceRef.",
    },
    CURSOR_INVALID: {
        message: "The cursor is malformed or was not issued by this server process.",
        hint: "Pass nextCursor exactly as returned, or start again without a cursor.",
    },
    CURSOR_EXPIRED: {
        message: "The cursor has expired or is no longer kept.",
        hint: "A cursor lasts 30 minutes after its last use (2 hours per listing), at most 64 are kept and all are lost on restart. Start again without a cursor.",
    },
    CURSOR_MISMATCH: {
        message: "The cursor was issued for different arguments or for another tool.",
        hint: "Pass only the cursor, or the same filters that started the listing; start again without a cursor to change them.",
    },
    CURSOR_STALE: {
        message: "The data behind the cursor changed, or can no longer be verified, in a way that invalidates the listing.",
        hint: "Start the listing again without a cursor. A list_articles or search_articles listing filtered on a source whose feed URL cannot be verified (larger than 64 KiB, or not text) cannot be continued past its first page.",
    },
    FLUENT_READER_RUNNING: {
        message: "Fluent Reader is open on this profile, or its lock file is present, so config.json cannot be changed safely; nothing was written.",
        hint: "Close Fluent Reader completely (also from the notification area), then retry; this server never terminates it. If it is already closed, open and close it once: that clears a lock file left by a power loss.",
    },
    REVISION_CONFLICT: {
        message: "The rules or config.json changed since the revision the request is based on; nothing was written.",
        hint: "Call preview_rule_change or list_rules for the current revision, review the rules again and retry only if the change is still wanted. A revision is valid only for the current run of the server.",
    },
    RULE_NOT_FOUND: {
        message: "The target has no rule at this index; nothing was written.",
        hint: "Call list_rules for the target's current rules and indexes.",
    },
    RULE_WRITE_BUSY: {
        message: "Another rule change on this profile is in progress; nothing was written.",
        hint: "Retry shortly; another copy of this server may be saving a change. A guard left by a crash is never removed automatically: if this persists, close Fluent Reader and every MCP client using this profile, then delete config.json.frmcp-write.tmp from the profile folder. config.json was not touched.",
    },
    RULE_BACKUP_UNAVAILABLE: {
        message: "The private backup of config.json could not be created, so no change was made.",
        hint: "Backups are kept only in %LOCALAPPDATA%\\FluentReaderMCP-Data\\rule-backups, which must be made of regular local folders inside the user profile, with free space; they are never saved elsewhere.",
    },
    RULE_WRITE_FAILED: {
        message: "The change could not be saved; config.json was not replaced.",
        hint: "Retry later: another program may be holding the file, or the disk may be full or read-only.",
    },
    RULE_WRITE_UNVERIFIED: {
        message: "config.json was replaced, but the saved result could not be verified; nothing was restored automatically.",
        hint: "Do not retry blindly. Call list_rules to check the rules. A private copy taken before the change is in %LOCALAPPDATA%\\FluentReaderMCP-Data\\rule-backups; it holds the whole configuration, credentials included.",
    },
    PREFERENCES_UNAVAILABLE: {
        message: "The private personal-preferences storage is unavailable or unsafe.",
        hint: "Use the regular local %LOCALAPPDATA% area of the current Windows user; links, junctions, non-regular files and storage outside the user profile are refused.",
    },
    PREFERENCES_INVALID: {
        message: "preferences.md is too large, malformed or does not have the supported managed structure.",
        hint: "Call get_news_preferences for the line of the first problem, then repair the Markdown markers or restore a private backup; the server never rewrites an invalid document automatically.",
    },
    PROFILE_BINDING_REQUIRED: {
        message: "The preferences document is not verified for the current Fluent Reader profile.",
        hint: "Preview and explicitly apply reassociate_profile. Until then all stored preferences, including the general ones, remain non-effective.",
    },
    PREVIEW_INVALID: {
        message: "The preview token is invalid, altered, already used or does not match the submitted change.",
        hint: "Run preview_news_preferences_change again and apply the same changes with the returned token and revision. A preview made before identity.key existed does not survive a server restart.",
    },
    PREVIEW_EXPIRED: {
        message: "The preview token has expired.",
        hint: "Run preview_news_preferences_change again: a preview lasts 15 minutes.",
    },
    PREFERENCES_REVISION_CONFLICT: {
        message: "The preferences document or live catalog changed after the requested revision was observed; nothing was written.",
        hint: "Read the preferences and live catalog again, then obtain a new preview for the intended change.",
    },
    PREFERENCES_WRITE_BUSY: {
        message: "Another personal-preferences update is in progress; nothing was written.",
        hint: "Retry after the other MCP client finishes, starting with a new read and preview. A lock left by a crash is never removed automatically: if get_news_preferences keeps warning writeLockMayBeOrphaned, close every MCP client using this profile, then delete preferences.lock from its storageLocation.",
    },
    PREFERENCES_BACKUP_UNAVAILABLE: {
        message: "The previous preferences.md could not be backed up, so no change was made.",
        hint: "Check the private news-preferences backup directory and available disk space, then obtain a new preview.",
    },
    PREFERENCES_WRITE_FAILED: {
        message: "The personal-preferences change could not be saved; preferences.md was not replaced.",
        hint: "Check the private storage and retry from a new read and preview. preferences.md was not touched.",
    },
    PREFERENCES_WRITE_UNVERIFIED: {
        message: "preferences.md was written but the result or profile binding could not be verified; nothing was restored automatically.",
        hint: "Do not retry blindly. Read the preferences state and inspect a private backup before deciding whether to restore it.",
    },
    PREFERENCE_TEXT_REJECTED: {
        message: "The preference text contains markup, addresses, credentials or control characters that are not stored; nothing was written.",
        hint: "Rephrase it as plain text. HTML comments, tags, code fences, URLs, secrets and invisible or bidirectional characters are refused.",
    },
    PREFERENCE_BINDING_REVIEW_REQUIRED: {
        message: "This section is not associated with a verified group or source; nothing was written.",
        hint: "Read the sections view, then confirm the association with rebind_section or delete the section with remove_section.",
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
