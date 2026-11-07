import crypto from "node:crypto"
import { FrMcpError } from "../errors.js"
import { DB_SCAN_MAX } from "../domain/group-catalog.js"
import { readCandidates, readSidBounds, readSourceRows, RECORD_BYTES_MAX, selectBatch, SourceRecord } from "../domain/sources.js"
import type { ToolContext } from "../tools/context.js"
import { loadGroups } from "../tools/context.js"
import { thirdPartyName } from "./text-policy.js"

export const CATALOG_SOURCES_MAX = DB_SCAN_MAX
export const CATALOG_GROUPS_MAX = 2_000
const CANDIDATE_BATCH = 500

export interface CatalogSource {
    readonly sourceId: number
    readonly name: string
    readonly groupId: number | null
    readonly groupStatus: "grouped" | "ungrouped" | "ambiguous" | "unavailable"
    /** Keyed fingerprint of the feed URL. Null without a key or when the URL cannot be read. */
    readonly binding: string | null
}

export interface CatalogGroup {
    readonly groupId: number
    readonly name: string
    readonly status: "active" | "ambiguous"
    /** Keyed fingerprint of the name. Null without a key. */
    readonly binding: string | null
}

export interface LiveCatalog {
    readonly revision: string
    readonly groups: readonly CatalogGroup[]
    readonly sources: readonly CatalogSource[]
    readonly ambiguousGroups: number
}

function keyed(key: Buffer, domain: string, value: string): string {
    return crypto
        .createHmac("sha256", key)
        .update(`fluent-reader-mcp/news-preferences/${domain}/1\0`)
        .update(value, "utf8")
        .digest()
        .subarray(0, 16)
        .toString("base64url")
}

export const groupBinding = (key: Buffer, name: string): string => `pg1.${keyed(key, "group", name)}`

/** The revision does not depend on the key, so creating the key does not invalidate a preview. Only the overall digest leaves this function. */
function urlDigest(url: string | null): string | null {
    return url === null ? null : crypto.createHash("sha256").update(url, "utf8").digest("base64url")
}

interface LoadedSource {
    readonly source: CatalogSource
    readonly urlDigest: string | null
}

async function loadSources(context: ToolContext, groups: Awaited<ReturnType<typeof loadGroups>>, key?: Buffer): Promise<LoadedSource[]> {
    return context.database.withReadConnection((db) => {
        const bounds = readSidBounds(db)
        if (bounds === null) return []
        const result: LoadedSource[] = []
        const add = (sid: number, name: string | null, url: string | null): void => {
            const group = groups.groupOf(sid)
            result.push({
                source: {
                    sourceId: sid,
                    name: thirdPartyName(name, `Source ${sid}`),
                    groupId: group.groupId,
                    groupStatus: group.groupStatus,
                    binding: key === undefined || url === null ? null : `ps1.${keyed(key, "source", url)}`,
                },
                urlDigest: urlDigest(url),
            })
            if (result.length > CATALOG_SOURCES_MAX) throw new FrMcpError("LIMIT_EXCEEDED", "catalog-too-large")
        }
        let lower = bounds.lo
        while (lower <= bounds.hi) {
            const candidates = readCandidates(db, lower, bounds.hi, CANDIDATE_BATCH)
            const first = candidates[0]
            if (first === undefined) break
            // One oversized row must not take the whole catalog down: it is listed without a verifiable identity.
            if (first.bytes > RECORD_BYTES_MAX) {
                add(first.sid, null, null)
                lower = first.sid + 1
                continue
            }
            const batch = selectBatch(candidates)
            const rows = readSourceRows(db, batch.map((candidate) => candidate.sid))
            for (const candidate of batch) {
                const row = rows.get(candidate.sid)
                if (row === undefined) continue
                const record = new SourceRecord(row)
                add(row.sid, record.name(), record.url())
            }
            const last = batch.at(-1)
            if (last === undefined || last.sid >= bounds.hi) break
            lower = last.sid + 1
        }
        return result
    })
}

export async function loadLiveCatalog(context: ToolContext, key?: Buffer): Promise<LiveCatalog> {
    const groupIndex = await loadGroups(context)
    const catalogGroups: CatalogGroup[] = []
    let ambiguousGroups = 0
    for (const entry of groupIndex.entries()) {
        if (!entry.isMultiple || entry.gid < 0) continue
        const ambiguous = groupIndex.gidCount(entry.gid) !== 1
        if (ambiguous) ambiguousGroups++
        const name = thirdPartyName(entry.name ?? null, `Group ${entry.gid}`)
        catalogGroups.push({
            groupId: entry.gid,
            name,
            status: ambiguous ? "ambiguous" : "active",
            binding: key === undefined ? null : groupBinding(key, name),
        })
        if (catalogGroups.length > CATALOG_GROUPS_MAX) throw new FrMcpError("LIMIT_EXCEEDED", "catalog-too-large")
    }
    const loaded = await loadSources(context, groupIndex, key)
    const revisionMaterial = {
        groups: catalogGroups.map(({ groupId, name, status }) => ({ groupId, name, status })),
        sources: loaded.map(({ source, urlDigest: digest }) => ({ sourceId: source.sourceId, name: source.name, groupId: source.groupId, groupStatus: source.groupStatus, digest })),
    }
    const revision = `pc1.${crypto.createHash("sha256").update(JSON.stringify(revisionMaterial)).digest().subarray(0, 16).toString("base64url")}`
    return { revision, groups: catalogGroups, sources: loaded.map(({ source }) => source), ambiguousGroups }
}
