/**
 * Preview tokens bind an apply to one previewed plan: the normalized changes,
 * the resulting sections, the document and catalog revisions and, when the key
 * already exists, the exact resulting bytes. They prove that this server
 * produced that preview. They do not prove that a person reviewed it.
 */

import crypto from "node:crypto"
import { FrMcpError } from "../errors.js"
import { PREVIEW_TTL_MS, type NewsPreferenceSettings } from "./store.js"

export interface TokenBinding {
    readonly operation: string
    readonly expectedRevision: string
    readonly catalogRevision: string
    readonly planDigest: string
    /** The revision the file will have, or null when the key that shapes it does not exist yet. */
    readonly resultRevision: string | null
}

interface TokenPayload extends TokenBinding {
    readonly v: 1
    readonly iat: number
    readonly exp: number
    readonly nonce: string
    readonly signer: "persistent" | "instance"
}

export function canonicalJson(value: unknown): string {
    const normalize = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(normalize)
        if (typeof v === "object" && v !== null) {
            return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((key) => [key, normalize((v as Record<string, unknown>)[key])]))
        }
        return v
    }
    return JSON.stringify(normalize(value))
}

export function digestOf(value: unknown): string {
    return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("base64url")
}

function mac(key: Buffer, encoded: string): string {
    return crypto.createHmac("sha256", key).update("fluent-reader-mcp/news-preferences/preview/1\0").update(encoded).digest().toString("base64url")
}

export function issuePreviewToken(settings: NewsPreferenceSettings, persistentKey: Buffer | null, now: number, binding: TokenBinding): string {
    const payload: TokenPayload = {
        v: 1,
        iat: now,
        exp: now + PREVIEW_TTL_MS,
        nonce: crypto.randomBytes(12).toString("base64url"),
        signer: persistentKey === null ? "instance" : "persistent",
        ...binding,
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
    return `npp1.${encoded}.${mac(persistentKey ?? settings.previewKey, encoded)}`
}

export function verifyPreviewToken(settings: NewsPreferenceSettings, persistentKey: Buffer | null, token: string, now: number, binding: TokenBinding): void {
    if (settings.usedTokens.has(token)) throw new FrMcpError("PREVIEW_INVALID", "preview-reused")
    const match = /^npp1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token)
    if (match === null) throw new FrMcpError("PREVIEW_INVALID", "preview-invalid")
    const encoded = match[1] as string
    let parsed: unknown
    try {
        parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
    } catch {
        throw new FrMcpError("PREVIEW_INVALID", "preview-invalid")
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new FrMcpError("PREVIEW_INVALID", "preview-invalid")
    const payload = parsed as TokenPayload
    const key = payload.signer === "persistent" ? persistentKey : payload.signer === "instance" ? settings.previewKey : null
    if (key === null) throw new FrMcpError("PREVIEW_INVALID", "preview-invalid")
    // Compared as text, not as decoded bytes: base64url has several spellings of the same bytes, and only the canonical one is the token.
    const expected = Buffer.from(mac(key, encoded), "utf8")
    const received = Buffer.from(match[2] as string, "utf8")
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw new FrMcpError("PREVIEW_INVALID", "preview-invalid")
    if (payload.v !== 1 || payload.exp < now || payload.iat > now || payload.exp - payload.iat !== PREVIEW_TTL_MS) throw new FrMcpError("PREVIEW_EXPIRED", "preview-expired")
    if (
        payload.operation !== binding.operation ||
        payload.expectedRevision !== binding.expectedRevision ||
        payload.catalogRevision !== binding.catalogRevision ||
        payload.planDigest !== binding.planDigest ||
        (payload.resultRevision !== null && binding.resultRevision !== null && payload.resultRevision !== binding.resultRevision)
    ) throw new FrMcpError("PREVIEW_INVALID", "preview-mismatch")
}
