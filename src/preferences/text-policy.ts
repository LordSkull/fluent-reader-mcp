/**
 * What may enter preferences.md and how stored text and third-party names
 * leave it. This is a structural and hygiene control, not a consent control:
 * it cannot tell an instruction typed by the user from one planted by a feed,
 * so instruction-like text only produces a warning.
 */

import { FrMcpError, type ErrorReason } from "../errors.js"

export const PREFERENCE_ITEMS_MAX = 100
export const PREFERENCE_ITEM_CODE_POINTS_MAX = 500
export const PREFERENCE_SECTION_CODE_POINTS_MAX = 4_000
const NAME_CODE_POINTS_MAX = 200

const LINE_BREAKS = /\r\n|[\r\n\t\u2028\u2029]/g
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
/** Bidi controls and invisible characters. ZWJ and ZWNJ stay: real scripts and emoji need them. */
const INVISIBLE = /[\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/
const MARKUP = /<!--|-->|frmcp:|```|~~~|<[a-zA-Z/!?]/i
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.\S/i
const CREDENTIAL = /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[:=]|\bbearer\s+\S{8}/i
const TOOL_NAME = /\b(?:add_rule|update_rule|delete_rule|preview_rule_change|apply_news_preferences_change|preview_news_preferences_change|get_news_preferences|list_sources|get_source|list_groups|get_group|get_article|list_rules|get_rule_chain|list_articles|search_articles)\b/i
const INSTRUCTION_LIKE = /\b(?:ignor[ae]\w*|disregard|forget|dimentica)\b[^.]{0,40}\b(?:instruction|istruzion|prompt|regol|rule)/i

const READ_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi
const READ_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]/g

function rejected(reason: ErrorReason): never {
    throw new FrMcpError("PREFERENCE_TEXT_REJECTED", reason)
}

/** One list item in canonical form, or PREFERENCE_TEXT_REJECTED. The reason never echoes the text. */
export function normalizeItem(raw: string): string {
    if (!raw.isWellFormed()) rejected("text-control")
    const item = raw.normalize("NFC").replace(LINE_BREAKS, " ").trim()
    if (item.length === 0) rejected("text-empty")
    if ([...item].length > PREFERENCE_ITEM_CODE_POINTS_MAX) rejected("text-too-long")
    if (CONTROL.test(item) || INVISIBLE.test(item)) rejected("text-control")
    if (MARKUP.test(item)) rejected("text-markup")
    if (URL_LIKE.test(item)) rejected("text-url")
    if (CREDENTIAL.test(item)) rejected("text-credential")
    return item
}

export function normalizeItems(items: readonly string[]): string[] {
    if (items.length > PREFERENCE_ITEMS_MAX) rejected("text-too-long")
    const normalized = items.map(normalizeItem)
    if ([...normalized.join("")].length > PREFERENCE_SECTION_CODE_POINTS_MAX) rejected("text-too-long")
    return normalized
}

export function listBody(items: readonly string[]): string {
    return items.map((item) => `- ${item}`).join("\n")
}

/** Warnings only: this cannot detect a planted instruction reliably, and must not pretend to. */
export function textWarnings(items: readonly string[]): string[] {
    const warnings = new Set<string>()
    for (const item of items) {
        if (TOOL_NAME.test(item)) warnings.add("textMentionsToolName")
        if (INSTRUCTION_LIKE.test(item)) warnings.add("textLooksLikeInstruction")
    }
    return [...warnings]
}

/** Stored text on its way to a client: the file keeps its bytes, the response does not carry URLs or invisible characters. */
export function sanitizeForRead(text: string): { text: string; urlsRedacted: number } {
    let urlsRedacted = 0
    const redacted = text.replace(READ_URL, () => {
        urlsRedacted++
        return "[url-redacted]"
    })
    return { text: redacted.replace(READ_CONTROL, ""), urlsRedacted }
}

/** A feed or group name: third-party data on one line, without controls or invisible characters. */
export function thirdPartyName(value: string | null | undefined, fallback: string): string {
    if (value === null || value === undefined) return fallback
    const wellFormed = value.isWellFormed() ? value : value.toWellFormed()
    const clean = wellFormed
        .normalize("NFC")
        .replace(READ_CONTROL, " ")
        .replace(LINE_BREAKS, " ")
        .replace(/\s+/g, " ")
        .trim()
    return [...clean].slice(0, NAME_CODE_POINTS_MAX).join("") || fallback
}

/** A third-party name inside a generated heading: it cannot form markup, and Markdown syntax is shown literally. */
export function headingText(name: string): string {
    const plain = thirdPartyName(name, "Senza nome").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim()
    return plain.replace(/[\\`*_[\]()#!|~]/g, "\\$&") || "Senza nome"
}
