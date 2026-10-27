/**
 * Static verification of the Fluent Reader SQLite schema (FR-MCP-01 §5.2,
 * §16 "Evoluzione dello schema") and of the runtime capabilities.
 *
 * Only schema metadata is read (sqlite_schema, pragma_table_info) plus
 * constant expressions: no row counts, no reads of article data, no scans of
 * `items`, no integrity checks, no EXPLAIN. Extra columns are tolerated
 * (additive migrations); missing or retyped columns and an unexpected primary
 * key are SCHEMA_UNSUPPORTED. Nothing is migrated.
 *
 * Not implemented in this phase: comparison of the last drizzle migration
 * hash in __drizzle_migrations (§16, point 2).
 */

import { FrMcpError, toSafeError } from "../errors.js"
import type { ReadOnlyDatabase } from "./connection.js"

interface TableSpec {
    readonly primaryKey: string
    readonly columns: Readonly<Record<string, "INTEGER" | "TEXT">>
}

/** Columns of dist/drizzle/0000_daily_mandroid.sql in the Fluent Reader fork. */
export const REQUIRED_TABLES: Readonly<Record<"sources" | "items", TableSpec>> = {
    sources: {
        primaryKey: "sid",
        columns: {
            sid: "INTEGER",
            url: "TEXT",
            iconurl: "TEXT",
            name: "TEXT",
            openTarget: "INTEGER",
            lastFetched: "INTEGER",
            serviceRef: "TEXT",
            fetchFrequency: "INTEGER",
            textDir: "INTEGER",
            hidden: "INTEGER",
        },
    },
    items: {
        primaryKey: "_id",
        columns: {
            _id: "INTEGER",
            source: "INTEGER",
            guid: "TEXT",
            title: "TEXT",
            link: "TEXT",
            date: "INTEGER",
            fetchedDate: "INTEGER",
            thumb: "TEXT",
            content: "TEXT",
            snippet: "TEXT",
            creator: "TEXT",
            hasRead: "INTEGER",
            starred: "INTEGER",
            hidden: "INTEGER",
            notify: "INTEGER",
            serviceRef: "TEXT",
        },
    },
}

export interface DatabaseCapabilities {
    readonly sqliteVersion: string
    readonly encoding: string
    readonly octetLength: true
}

interface ColumnInfo {
    name: string
    type: string
    pk: number
}

function verifyTable(db: ReadOnlyDatabase, table: string, spec: TableSpec): void {
    const entry = db
        .prepare("SELECT type FROM sqlite_schema WHERE name = ? AND type = 'table'")
        .get(table)
    if (entry === undefined) throw new FrMcpError("SCHEMA_UNSUPPORTED", "missing-table")

    const rows = db
        .prepare("SELECT name, type, pk FROM pragma_table_info(?)")
        .all(table) as unknown as ColumnInfo[]
    const byName = new Map(rows.map((row) => [row.name, row]))

    for (const [name, type] of Object.entries(spec.columns)) {
        const column = byName.get(name)
        if (column === undefined) throw new FrMcpError("SCHEMA_UNSUPPORTED", "missing-column")
        if (String(column.type).toUpperCase() !== type) {
            throw new FrMcpError("SCHEMA_UNSUPPORTED", "column-type")
        }
    }

    const primaryKey = rows.filter((row) => Number(row.pk) > 0)
    if (primaryKey.length !== 1 || primaryKey[0]?.name !== spec.primaryKey) {
        throw new FrMcpError("SCHEMA_UNSUPPORTED", "primary-key")
    }
}

function readCapabilities(db: ReadOnlyDatabase): DatabaseCapabilities {
    const version = db.prepare("SELECT sqlite_version() AS v").get() as { v?: unknown } | undefined
    const encoding = db.prepare("PRAGMA encoding").get() as { encoding?: unknown } | undefined
    let octets: unknown
    try {
        octets = (db.prepare("SELECT octet_length('é') AS n").get() as { n?: unknown } | undefined)?.n
    } catch (error) {
        // "no such function" is a generic SQLITE_ERROR; lock and I/O errors keep their own code.
        const safe = toSafeError(error)
        if (safe.code !== "INTERNAL_ERROR") throw safe
        throw new FrMcpError("RUNTIME_CAPABILITY_MISSING", "octet-length")
    }
    if (octets !== 2) throw new FrMcpError("RUNTIME_CAPABILITY_MISSING", "octet-length")
    return {
        sqliteVersion: String(version?.v),
        encoding: String(encoding?.encoding),
        octetLength: true,
    }
}

/** Verifies runtime capabilities and the required tables. */
export function verifyDatabase(db: ReadOnlyDatabase): DatabaseCapabilities {
    const capabilities = readCapabilities(db)
    for (const [table, spec] of Object.entries(REQUIRED_TABLES)) verifyTable(db, table, spec)
    return capabilities
}
