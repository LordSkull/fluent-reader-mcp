/**
 * preferences.md: format, strict structural scanner and byte-preserving edits.
 *
 * The file is read line by line. A line that mentions a frmcp comment must be
 * exactly one known marker, in a legal position: nesting, overlap, duplicates
 * and markers inside sentences are a damaged document, reported with the line
 * and never rewritten. Every change is a splice of the affected ranges, so text
 * the user wrote anywhere else keeps its bytes. Group and source blocks exist
 * only once they hold a preference: a catalog of any size costs nothing here.
 */

import crypto from "node:crypto"
import { FrMcpError } from "../errors.js"
import { headingText } from "./text-policy.js"

export const PREFERENCES_BYTES_MAX = 256 * 1024
const METADATA_ENTRIES_MAX = 2_000

export const GENERAL_FIELDS = ["interests", "avoid", "importance", "exceptions"] as const
export const GROUP_FIELDS = ["interests", "avoid", "exceptions"] as const
export type GeneralField = (typeof GENERAL_FIELDS)[number]
export type GroupField = (typeof GROUP_FIELDS)[number]

const GENERAL_HEADINGS: Readonly<Record<GeneralField, string>> = {
    interests: "Interessi generali",
    avoid: "Argomenti da evitare",
    importance: "Criteri di importanza",
    exceptions: "Eccezioni generali",
}
const GROUP_HEADINGS: Readonly<Record<GroupField, string>> = {
    interests: "Interessi",
    avoid: "Da evitare",
    exceptions: "Eccezioni",
}

export interface GroupMetadata {
    id: string
    /** Keyed fingerprint of the group's name: the gid alone does not prove it is the same group. */
    binding: string | null
    groupId: number | null
    name: string
}

export interface SourceMetadata {
    id: string
    /** Keyed fingerprint of the feed URL; the URL itself is never stored. */
    binding: string | null
    sourceId: number | null
    name: string
}

export interface DocumentMetadata {
    schemaVersion: 1
    /** Grows with every saved change, so an earlier document revision never comes back. */
    generation: number
    profileBinding: string
    groups: GroupMetadata[]
    sources: SourceMetadata[]
}

interface Span {
    readonly start: number
    readonly end: number
}

interface SectionSpan extends Span {
    readonly body: string
}

interface BlockSpan extends Span {
    readonly heading: Span | null
}

export interface ParsedPreferences {
    readonly metadata: DocumentMetadata
    readonly text: string
    readonly eol: "\n" | "\r\n"
    readonly metadataSpan: Span
    readonly sections: ReadonlyMap<string, SectionSpan>
    readonly blocks: ReadonlyMap<string, BlockSpan>
    readonly areaEnds: { readonly groups: number; readonly sources: number }
}

export interface DocumentIssue {
    readonly code: string
    readonly line: number
}

export type InspectedDocument = { readonly parsed: ParsedPreferences; readonly issue: null } | { readonly parsed: null; readonly issue: DocumentIssue }

const EDITORIAL_ID = "[A-Za-z0-9_-]{8,64}"
const GROUP_ID_RE = new RegExp(`^npg_${EDITORIAL_ID}$`)
const SOURCE_ID_RE = new RegExp(`^nps_${EDITORIAL_ID}$`)
const PROFILE_BINDING = /^pb1\.[A-Za-z0-9_-]{22}$/
const SOURCE_BINDING = /^ps1\.[A-Za-z0-9_-]{22}$/
const GROUP_BINDING = /^pg1\.[A-Za-z0-9_-]{22}$/
const MARKER_MENTION = /<!--\s*frmcp:/i
const METADATA_LINE = /^<!-- frmcp:metadata (\{.*\}) -->$/
const AREA_LINE = /^<!-- frmcp:area (groups|sources):(start|end) -->$/
const BLOCK_LINE = new RegExp(`^<!-- frmcp:block (group|source)=((?:npg|nps)_${EDITORIAL_ID}):(start|end) -->$`)
const SECTION_LINE = new RegExp(
    `^<!-- frmcp:section (general\\.(?:interests|avoid|importance|exceptions)|group=npg_${EDITORIAL_ID} (?:interests|avoid|exceptions)|source=nps_${EDITORIAL_ID} preferences):(start|end) -->$`,
)

export const generalKey = (field: GeneralField): string => `general.${field}`
export const groupKey = (id: string, field: GroupField): string => `group=${id} ${field}`
export const sourceKey = (id: string): string => `source=${id} preferences`

/** Editorial ids depend only on the change being made, so a preview and its apply produce the same bytes. */
export function editorialId(prefix: "npg" | "nps", seed: string): string {
    return `${prefix}_${crypto.createHash("sha256").update(`${prefix}\0${seed}`, "utf8").digest("base64url").slice(0, 20)}`
}

/** JSON that cannot close or open a comment and stays on one line, whatever a feed calls itself. */
export function serializeMetadata(metadata: DocumentMetadata): string {
    return JSON.stringify(metadata).replace(/[<>\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

function metadataFrom(json: string): DocumentMetadata | string {
    if (/[<>]/.test(json)) return "metadata-unsafe"
    let value: unknown
    try {
        value = JSON.parse(json)
    } catch {
        return "metadata-malformed"
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "metadata-malformed"
    const m = value as Partial<DocumentMetadata>
    if (typeof m.schemaVersion === "number" && m.schemaVersion > 1) return "unsupported-version"
    if (
        m.schemaVersion !== 1 ||
        !Number.isSafeInteger(m.generation) ||
        (m.generation as number) < 0 ||
        typeof m.profileBinding !== "string" ||
        !PROFILE_BINDING.test(m.profileBinding) ||
        !Array.isArray(m.groups) ||
        !Array.isArray(m.sources) ||
        m.groups.length > METADATA_ENTRIES_MAX ||
        m.sources.length > METADATA_ENTRIES_MAX
    ) return "metadata-malformed"
    const ids = new Set<string>()
    const nullableId = (v: unknown): boolean => v === null || (Number.isSafeInteger(v) && (v as number) >= 0)
    for (const group of m.groups as unknown[]) {
        const g = group as Partial<GroupMetadata> | null
        if (
            typeof g !== "object" || g === null ||
            typeof g.id !== "string" || !GROUP_ID_RE.test(g.id) || ids.has(g.id) ||
            !(g.binding === null || (typeof g.binding === "string" && GROUP_BINDING.test(g.binding))) ||
            !nullableId(g.groupId) ||
            typeof g.name !== "string"
        ) return "metadata-malformed"
        ids.add(g.id)
    }
    for (const source of m.sources as unknown[]) {
        const s = source as Partial<SourceMetadata> | null
        if (
            typeof s !== "object" || s === null ||
            typeof s.id !== "string" || !SOURCE_ID_RE.test(s.id) || ids.has(s.id) ||
            !(s.binding === null || (typeof s.binding === "string" && SOURCE_BINDING.test(s.binding))) ||
            !nullableId(s.sourceId) ||
            typeof s.name !== "string"
        ) return "metadata-malformed"
        ids.add(s.id)
    }
    return m as DocumentMetadata
}

function decodeUtf8(bytes: Buffer): string | null {
    const text = bytes.toString("utf8")
    return Buffer.from(text, "utf8").equals(bytes) && !text.includes("\0") ? text : null
}

/** Strict scan: never throws on content, reports the first structural problem and its line. */
export function inspectPreferences(bytes: Buffer): InspectedDocument {
    const fail = (code: string, line: number): InspectedDocument => ({ parsed: null, issue: { code, line } })
    if (bytes.length > PREFERENCES_BYTES_MAX) return fail("file-too-large", 0)
    const text = decodeUtf8(bytes)
    if (text === null) return fail("encoding", 0)

    let metadata: DocumentMetadata | null = null
    let metadataSpan: Span | null = null
    let area: "groups" | "sources" | null = null
    let block: { kind: "group" | "source"; id: string; start: number; heading: Span | null; firstSectionSeen: boolean } | null = null
    let section: { key: string; start: number } | null = null
    const sections = new Map<string, SectionSpan>()
    const blocks = new Map<string, BlockSpan>()
    const areaEnds: { groups: number | null; sources: number | null } = { groups: null, sources: null }
    const areasSeen = new Set<string>()
    let crlf = 0
    let lf = 0
    let groupIds = new Set<string>()
    let sourceIds = new Set<string>()

    let lineNo = 0
    let position = 0
    while (position < text.length) {
        lineNo++
        const newline = text.indexOf("\n", position)
        const contentEnd = newline < 0 ? text.length : newline
        const next = newline < 0 ? text.length : newline + 1
        const hasCr = contentEnd > position && text.charCodeAt(contentEnd - 1) === 13
        if (newline >= 0) {
            if (hasCr) crlf++
            else lf++
        }
        const bomAt = lineNo === 1 && text.charCodeAt(0) === 0xfeff ? 1 : 0
        const lineStart = position + bomAt
        const line = text.slice(lineStart, hasCr ? contentEnd - 1 : contentEnd)

        if (MARKER_MENTION.test(line)) {
            const meta = METADATA_LINE.exec(line)
            const areaMatch = AREA_LINE.exec(line)
            const blockMatch = BLOCK_LINE.exec(line)
            const sectionMatch = SECTION_LINE.exec(line)
            if (meta !== null) {
                if (metadata !== null || sections.size > 0 || blocks.size > 0 || areasSeen.size > 0 || section !== null) return fail("marker-order", lineNo)
                const parsedMeta = metadataFrom(meta[1] as string)
                if (typeof parsedMeta === "string") return fail(parsedMeta, lineNo)
                metadata = parsedMeta
                const jsonStart = lineStart + line.indexOf("{")
                metadataSpan = { start: jsonStart, end: jsonStart + (meta[1] as string).length }
                groupIds = new Set(parsedMeta.groups.map((g) => g.id))
                sourceIds = new Set(parsedMeta.sources.map((s) => s.id))
            } else if (metadata === null) {
                return fail("marker-order", lineNo)
            } else if (areaMatch !== null) {
                const name = areaMatch[1] as "groups" | "sources"
                if (section !== null || block !== null) return fail("marker-order", lineNo)
                if (areaMatch[2] === "start") {
                    if (area !== null) return fail("marker-order", lineNo)
                    if (areasSeen.has(name)) return fail("marker-duplicate", lineNo)
                    areasSeen.add(name)
                    area = name
                } else {
                    if (area !== name) return fail("marker-order", lineNo)
                    area = null
                    areaEnds[name] = position
                }
            } else if (blockMatch !== null) {
                const kind = blockMatch[1] as "group" | "source"
                const id = blockMatch[2] as string
                if (section !== null) return fail("marker-order", lineNo)
                if (blockMatch[3] === "start") {
                    if (block !== null || area !== (kind === "group" ? "groups" : "sources")) return fail("marker-order", lineNo)
                    if (blocks.has(id)) return fail("marker-duplicate", lineNo)
                    if (!(kind === "group" ? groupIds : sourceIds).has(id)) return fail("marker-unknown", lineNo)
                    block = { kind, id, start: position, heading: null, firstSectionSeen: false }
                } else {
                    if (block === null || block.id !== id || block.kind !== kind) return fail("marker-order", lineNo)
                    blocks.set(id, { start: block.start, end: next, heading: block.heading })
                    block = null
                }
            } else if (sectionMatch !== null) {
                const key = sectionMatch[1] as string
                if (sectionMatch[2] === "start") {
                    if (section !== null) return fail("marker-order", lineNo)
                    if (sections.has(key)) return fail("marker-duplicate", lineNo)
                    if (key.startsWith("general.")) {
                        if (block !== null || area !== null) return fail("marker-order", lineNo)
                    } else {
                        const owner = key.slice(key.indexOf("=") + 1).split(" ")[0] as string
                        const kind = key.startsWith("group=") ? "group" : "source"
                        if (block === null || block.id !== owner || block.kind !== kind) return fail("marker-order", lineNo)
                        block.firstSectionSeen = true
                    }
                    section = { key, start: next }
                } else {
                    if (section === null || section.key !== key) return fail("marker-order", lineNo)
                    const region = text.slice(section.start, position)
                    sections.set(key, { start: section.start, end: position, body: region.replace(/\r?\n$/, "") })
                    section = null
                }
            } else {
                return fail("marker-malformed", lineNo)
            }
        } else if (block !== null && section === null && !block.firstSectionSeen && block.heading === null && line.startsWith("### ")) {
            block.heading = { start: lineStart, end: lineStart + line.length }
        }
        position = next
    }

    const endLine = lineNo + 1
    if (metadata === null || metadataSpan === null) return fail("marker-missing", endLine)
    if (section !== null || block !== null || area !== null) return fail("marker-order", endLine)
    if (areaEnds.groups === null || areaEnds.sources === null) return fail("marker-missing", endLine)
    for (const field of GENERAL_FIELDS) if (!sections.has(generalKey(field))) return fail("marker-missing", endLine)
    for (const group of metadata.groups) {
        if (!blocks.has(group.id)) return fail("marker-missing", endLine)
        for (const field of GROUP_FIELDS) if (!sections.has(groupKey(group.id, field))) return fail("marker-missing", endLine)
    }
    for (const source of metadata.sources) {
        if (!blocks.has(source.id) || !sections.has(sourceKey(source.id))) return fail("marker-missing", endLine)
    }
    return {
        parsed: {
            metadata,
            text,
            eol: crlf > lf ? "\r\n" : "\n",
            metadataSpan,
            sections,
            blocks,
            areaEnds: { groups: areaEnds.groups, sources: areaEnds.sources },
        },
        issue: null,
    }
}

export function parsePreferences(bytes: Buffer): ParsedPreferences {
    const { parsed, issue } = inspectPreferences(bytes)
    if (parsed === null) throw new FrMcpError("PREFERENCES_INVALID", issue.code === "file-too-large" ? "file-too-large" : "invalid-markdown")
    return parsed
}

const sectionText = (key: string, body: string, eol: string): string =>
    `<!-- frmcp:section ${key}:start -->${eol}${body === "" ? "" : `${body.replaceAll("\n", eol)}${eol}`}<!-- frmcp:section ${key}:end -->${eol}`

export const groupHeading = (name: string): string => `### Gruppo: ${headingText(name)}`
export const sourceHeading = (name: string): string => `### Fonte: ${headingText(name)}`

function groupBlock(group: GroupMetadata, bodies: Readonly<Partial<Record<GroupField, string>>>, eol: string): string {
    const parts = [`<!-- frmcp:block group=${group.id}:start -->${eol}${groupHeading(group.name)}${eol}`]
    for (const field of GROUP_FIELDS) {
        parts.push(`${eol}#### ${GROUP_HEADINGS[field]}${eol}${eol}${sectionText(groupKey(group.id, field), bodies[field] ?? "", eol)}`)
    }
    parts.push(`<!-- frmcp:block group=${group.id}:end -->${eol}`)
    return parts.join("")
}

function sourceBlock(source: SourceMetadata, body: string, eol: string): string {
    return `<!-- frmcp:block source=${source.id}:start -->${eol}${sourceHeading(source.name)}${eol}${eol}${sectionText(sourceKey(source.id), body, eol)}<!-- frmcp:block source=${source.id}:end -->${eol}`
}

/** A new document: general sections only. */
export function renderNewDocument(profileBinding: string, general: Readonly<Partial<Record<GeneralField, string>>>): Buffer {
    const metadata: DocumentMetadata = { schemaVersion: 1, generation: 0, profileBinding, groups: [], sources: [] }
    const lines = [
        `<!-- frmcp:metadata ${serializeMetadata(metadata)} -->`,
        "",
        "# Preferenze editoriali",
        "",
        "Puoi modificare il testo fra le righe di commento. Non cambiare i commenti: il server rifiuta di scrivere su un documento con la struttura alterata. Il testo fuori dalle sezioni viene conservato, ma non viene usato come preferenza.",
        "",
    ]
    const out = [lines.join("\n"), "\n"]
    for (const field of GENERAL_FIELDS) out.push(`## ${GENERAL_HEADINGS[field]}\n\n${sectionText(generalKey(field), general[field] ?? "", "\n")}\n`)
    out.push("## Preferenze per gruppo\n\n<!-- frmcp:area groups:start -->\n<!-- frmcp:area groups:end -->\n\n")
    out.push("## Preferenze per fonte\n\n<!-- frmcp:area sources:start -->\n<!-- frmcp:area sources:end -->\n")
    return Buffer.from(out.join(""), "utf8")
}

interface Splice extends Span {
    readonly text: string
}

/** Collects splices over a parsed document. Nothing outside them changes. */
export class DocumentEdit {
    readonly #parsed: ParsedPreferences
    readonly #splices: Splice[] = []
    readonly touched = new Set<string>()
    readonly metadata: DocumentMetadata

    constructor(parsed: ParsedPreferences) {
        this.#parsed = parsed
        this.metadata = {
            ...parsed.metadata,
            groups: parsed.metadata.groups.map((group) => ({ ...group })),
            sources: parsed.metadata.sources.map((source) => ({ ...source })),
        }
    }

    body(key: string): string {
        const section = this.#parsed.sections.get(key)
        if (section === undefined) throw new FrMcpError("PREFERENCES_INVALID", "invalid-markdown")
        return section.body
    }

    /** Returns false when the section already holds exactly this text. */
    setBody(key: string, body: string): boolean {
        const eol = this.#parsed.eol
        const wanted = body.replaceAll("\n", eol)
        const section = this.#parsed.sections.get(key)
        if (section === undefined) throw new FrMcpError("PREFERENCES_INVALID", "invalid-markdown")
        if (section.body === wanted) return false
        this.#splices.push({ start: section.start, end: section.end, text: wanted === "" ? "" : `${wanted}${eol}` })
        this.touched.add(key)
        return true
    }

    setHeading(id: string, line: string): void {
        const heading = this.#parsed.blocks.get(id)?.heading
        if (heading === undefined || heading === null) return
        if (this.#parsed.text.slice(heading.start, heading.end) === line) return
        this.#splices.push({ start: heading.start, end: heading.end, text: line })
    }

    addGroup(group: GroupMetadata, bodies: Readonly<Partial<Record<GroupField, string>>>): void {
        const at = this.#parsed.areaEnds.groups
        this.#splices.push({ start: at, end: at, text: groupBlock(group, bodies, this.#parsed.eol) })
        this.metadata.groups.push(group)
        for (const field of GROUP_FIELDS) this.touched.add(groupKey(group.id, field))
    }

    addSource(source: SourceMetadata, body: string): void {
        const at = this.#parsed.areaEnds.sources
        this.#splices.push({ start: at, end: at, text: sourceBlock(source, body, this.#parsed.eol) })
        this.metadata.sources.push(source)
        this.touched.add(sourceKey(source.id))
    }

    removeGroup(id: string): void {
        const block = this.#parsed.blocks.get(id)
        if (block === undefined) throw new FrMcpError("PREFERENCES_INVALID", "invalid-markdown")
        this.#splices.push({ start: block.start, end: block.end, text: "" })
        this.metadata.groups = this.metadata.groups.filter((group) => group.id !== id)
        for (const field of GROUP_FIELDS) this.touched.add(groupKey(id, field))
    }

    removeSource(id: string): void {
        const block = this.#parsed.blocks.get(id)
        if (block === undefined) throw new FrMcpError("PREFERENCES_INVALID", "invalid-markdown")
        this.#splices.push({ start: block.start, end: block.end, text: "" })
        this.metadata.sources = this.metadata.sources.filter((source) => source.id !== id)
        this.touched.add(sourceKey(id))
    }

    /** The new document text, or the original text when nothing changed. */
    finish(): string {
        const original = this.#parsed
        const metadataChanged = serializeMetadata(this.metadata) !== serializeMetadata(original.metadata)
        if (this.#splices.length === 0 && !metadataChanged) return original.text
        const metadata: DocumentMetadata = { ...this.metadata, generation: original.metadata.generation + 1 }
        const splices = [...this.#splices, { ...original.metadataSpan, text: serializeMetadata(metadata) }].sort((a, b) => b.start - a.start)
        let text = original.text
        for (const splice of splices) text = `${text.slice(0, splice.start)}${splice.text}${text.slice(splice.end)}`
        return text
    }
}

/**
 * The invariant every write passes before any backup or key is created: the
 * result is a valid document within the limit, and only the planned sections
 * differ from the current ones.
 */
export function verifyResult(before: ParsedPreferences | null, next: Buffer, touched: ReadonlySet<string>): ParsedPreferences {
    if (next.length > PREFERENCES_BYTES_MAX) throw new FrMcpError("LIMIT_EXCEEDED", "preferences-too-large")
    const after = parsePreferences(next)
    if (before === null) return after
    for (const [key, section] of before.sections) {
        if (touched.has(key)) continue
        if (after.sections.get(key)?.body !== section.body) throw new FrMcpError("PREFERENCES_INVALID", "invalid-markdown")
    }
    for (const key of after.sections.keys()) {
        if (!before.sections.has(key) && !touched.has(key)) throw new FrMcpError("PREFERENCES_INVALID", "invalid-markdown")
    }
    return after
}
