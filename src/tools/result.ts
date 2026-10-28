/**
 * Common MCP tool result contract (FR-MCP-01 §14.0, D-16).
 *
 * Success: `{ content: [{ type: "text", text: S(P) }], structuredContent: P }`,
 * where S = JSON.stringify without spacing and P is validated by the SDK
 * against the tool's outputSchema. The text is produced once from the same
 * object, so JSON.parse(text) equals structuredContent.
 *
 * Error: `{ content: [{ type: "text", text: S(E) }], isError: true }` with
 * E = { code, message, hint, reason? } from a sanitized FrMcpError. No
 * structuredContent (the SDK skips output validation for isError results).
 *
 * Size: RESP_MAX bounds |S(R)| in UTF-16 code units for the whole result R
 * built here, both copies included. The JSON-RPC envelope added by the SDK
 * (jsonrpc, id, _meta) is outside the measure.
 *
 * Exact accounting (§14.0.3): S(P) contains no raw control characters and no
 * lone surrogates (JSON.stringify escaped them), so serializing S(P) again as
 * a string only adds one backslash per `"` and `\`. Appending an element whose
 * serialization is `s` to an array of P therefore grows |S(R)| by exactly
 * 2·|s| + q(s), plus 2 for the separating commas when the array is not empty,
 * where q(s) counts `"` and `\` in s.
 */

import type { CallToolResult } from "@modelcontextprotocol/server"
import { FrMcpError, toSafeError } from "../errors.js"

/** Maximum |S(R)| in UTF-16 code units (FR-MCP-01 §14.0.2). */
export const RESP_MAX = 48_000

/** Number of characters that gain an escape when a JSON text is serialized again as a string. */
export function quoteCount(json: string): number {
    let n = 0
    for (let i = 0; i < json.length; i++) {
        const c = json.charCodeAt(i)
        if (c === 0x22 || c === 0x5c) n++
    }
    return n
}

function buildSuccess(payload: object): { result: CallToolResult; serialized: string } {
    const result = {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload as Record<string, unknown>,
    }
    return { result, serialized: JSON.stringify(result) }
}

/** |S(R)| of the success result for `payload`. */
export function resultLength(payload: object): number {
    return buildSuccess(payload).serialized.length
}

/**
 * Builds the success result and verifies its real serialized size. A result
 * over RESP_MAX is never returned: LIMIT_EXCEEDED instead.
 */
export function successResult(payload: object): { result: CallToolResult; serialized: string } {
    const built = buildSuccess(payload)
    if (built.serialized.length > RESP_MAX) throw new FrMcpError("LIMIT_EXCEEDED", "response-too-large")
    return built
}

/** Sanitized error result. Raw messages are never forwarded. */
export function errorResult(error: unknown): CallToolResult {
    const safe = toSafeError(error)
    return { content: [{ type: "text", text: JSON.stringify(safe.toJSON()) }], isError: true }
}

/**
 * Incremental, exact accounting of one array of the payload.
 *
 * `skeletonLength` is |S(R)| of the payload with that array empty and every
 * page-dependent field (cursor, flags, counters) at its maximum serialized
 * length, so the final result can only be shorter or equal.
 */
export class PageBudget {
    #used: number
    #count = 0

    constructor(skeletonLength: number) {
        this.#used = skeletonLength
    }

    /** Accounted |S(R)| so far (an upper bound of the final result). */
    get used(): number {
        return this.#used
    }

    /** Exact growth of |S(R)| if an element serialized as `json` were appended. */
    cost(json: string): number {
        return 2 * json.length + quoteCount(json) + (this.#count > 0 ? 2 : 0)
    }

    /** Appends the element if the result stays within RESP_MAX. */
    tryAdd(json: string): boolean {
        const cost = this.cost(json)
        if (this.#used + cost > RESP_MAX) return false
        this.#used += cost
        this.#count++
        return true
    }
}
