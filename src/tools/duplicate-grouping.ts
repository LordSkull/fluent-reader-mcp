/**
 * groupDuplicates for list_articles and search_articles: the part shared by
 * both tools around scanPage (list-articles.ts), which does the grouping.
 *
 * State along a chain of cursors. The cursor of the next page keeps the
 * DuplicateMemory (scan/duplicate-memory.ts) as it was after the last
 * consumed article, plus the running count of articles that could not be
 * checked. A page never changes the memory of the cursor it was called with:
 * it works on a fork (structural sharing, copy on write), so a failed call
 * (DB_BUSY, CURSOR_STALE, ...) leaves the cursor as it was, and a retry
 * recomputes the same page. Once the page is published for that cursor,
 * replay only needs the published response: the registry drops the cursor's
 * memory (releaseGroupingState) together with its weight (scan/cursors.ts),
 * so a chain holds one memory, never one per page.
 *
 * Memory. Persistent: the memory a cursor keeps is declared to the registry
 * as its state weight (DuplicateMemory.weight) and counted in the global
 * budget with the cursor's other weights, published responses included.
 * Temporary, outside that budget, during one call only (calls run one at a
 * time, CursorRegistry.exclusive, so they never add up across calls), on top
 * of the scan's own windows: see groupingTransientBreakdown(), which lists
 * what can be alive at the same time. It is an indicative estimate from the
 * enforced limits (a baseline, not a guaranteed bound on the V8 heap).
 *
 * Fingerprints: an identity key (publisher, normalized title and snippet,
 * up to hundreds of KiB) is kept only as HMAC-SHA256 under the process key
 * (SourceIdentity.digest), over its exact UTF-16 code units. It is never
 * returned or logged, and no title, snippet, link or GUID is kept.
 */

import {
    IDENTITY_DATE_TEXT_BYTES_MAX,
    IDENTITY_GUID_BYTES_MAX,
    IDENTITY_LINK_BYTES_MAX,
    IDENTITY_SNIPPET_BYTES_MAX,
    IDENTITY_TITLE_BYTES_MAX,
} from "../domain/article-scan.js"
import { CONTRACT_NAME, CONTRACT_VERSION } from "../domain/duplicates.js"
import { FrMcpError } from "../errors.js"
import type { CreateOptions, CursorEntry } from "../scan/cursors.js"
import { DuplicateMemory, GROUP_WEIGHT, MEMBER_WEIGHT } from "../scan/duplicate-memory.js"
import type { ToolContext } from "./context.js"
import type { ScanLimits, ScanState } from "./list-articles.js"
import { RESP_MAX } from "./result.js"
import { GROUPING_SEMANTICS, type GroupingOutput } from "./schemas.js"

/** What a cursor of a grouped listing keeps besides the scan position. */
export interface GroupingState {
    /** Dropped (null) by the registry once the response of the cursor holding it is published. */
    memory: DuplicateMemory | null
    readonly notVerifiableSoFar: number
}

/** The grouping run by one call of scanPage. */
export interface GroupingSpec {
    /** Working memory of this page (mutated as articles are consumed). */
    readonly memory: DuplicateMemory
    readonly fingerprint: (key: string) => string
}

/** What scanPage reports about the grouping of one page. */
export interface PageGrouping<C> {
    readonly earlierCopies: C[]
    readonly copies: number
    readonly notVerifiable: number
    /** Bytes of identity values loaded by this call. */
    readonly identityBytes: number
}

const FINGERPRINT_DOMAIN = "duplicate-key/1"

export function startGrouping(context: ToolContext, entry: CursorEntry<ScanState> | undefined, limits: ScanLimits): GroupingSpec {
    let memory: DuplicateMemory
    if (entry === undefined) {
        memory = new DuplicateMemory({ groupsMax: limits.duplicateGroupsMax, membersMax: limits.duplicateMembersMax, keyGroupsMax: limits.duplicateKeyGroupsMax })
    } else {
        // A cursor without a published response still holds its memory.
        const kept = entry.state.grouping?.memory
        if (kept === undefined || kept === null) throw new FrMcpError("INTERNAL_ERROR", "unexpected")
        memory = kept.fork()
    }
    return {
        memory,
        fingerprint: (key) => context.identity.digest(FINGERPRINT_DOMAIN).update(Buffer.from(key, "utf16le")).digest("base64url"),
    }
}

/** `grouping` with every page-dependent field at its longest serialization (response skeleton). */
export const GROUPING_SKELETON: GroupingOutput = {
    contract: CONTRACT_NAME,
    contractVersion: CONTRACT_VERSION,
    copies: Number.MAX_SAFE_INTEGER,
    notVerifiable: Number.MAX_SAFE_INTEGER,
    notVerifiableSoFar: Number.MAX_SAFE_INTEGER,
    rememberedNews: Number.MAX_SAFE_INTEGER,
    forgottenSoFar: Number.MAX_SAFE_INTEGER,
    complete: false,
    semantics: GROUPING_SEMANTICS,
}

export const NO_PAGE_GROUPING: PageGrouping<never> = { earlierCopies: [], copies: 0, notVerifiable: 0, identityBytes: 0 }

/** The `grouping` of the response and the state of the next cursor. */
export function finishGrouping(
    spec: GroupingSpec,
    page: PageGrouping<unknown>,
    entry: CursorEntry<ScanState> | undefined,
    exhausted: boolean,
): { readonly output: GroupingOutput; readonly state: GroupingState } {
    const notVerifiableSoFar = (entry?.state.grouping?.notVerifiableSoFar ?? 0) + page.notVerifiable
    const forgottenSoFar = spec.memory.forgotten
    return {
        output: {
            contract: CONTRACT_NAME,
            contractVersion: CONTRACT_VERSION,
            copies: page.copies,
            notVerifiable: page.notVerifiable,
            notVerifiableSoFar,
            rememberedNews: exhausted ? 0 : spec.memory.size,
            forgottenSoFar,
            complete: exhausted && notVerifiableSoFar === 0 && forgottenSoFar === 0,
            semantics: GROUPING_SEMANTICS,
        },
        state: { memory: spec.memory, notVerifiableSoFar },
    }
}

/** Drops the memory of a published cursor (CreateOptions.releaseState). */
function releaseGroupingState(state: ScanState): void {
    if (state.grouping !== undefined) state.grouping.memory = null
}

/** Options of the successor cursor: its memory as state weight, released on publication; the cursor it continues. */
export function successorOptions(finished: { readonly state: GroupingState } | undefined, entry: CursorEntry<ScanState> | undefined): CreateOptions<ScanState> {
    return {
        ...(finished !== undefined && { stateWeight: finished.state.memory?.weight ?? 0, releaseState: releaseGroupingState }),
        ...(entry !== undefined && { replacing: entry }),
    }
}

/** Estimated bytes of a full memory under these limits (GROUP_WEIGHT, MEMBER_WEIGHT). */
export function memoryWeightMax(limits: ScanLimits): number {
    return limits.duplicateGroupsMax * GROUP_WEIGHT + limits.duplicateMembersMax * MEMBER_WEIGHT
}

/**
 * Stored bytes of the identity values of one record, at most (classifyIdentitySizes):
 * a window may exceed identityWindowBytes only by its first record.
 */
export const IDENTITY_RECORD_BYTES_MAX =
    IDENTITY_TITLE_BYTES_MAX + IDENTITY_SNIPPET_BYTES_MAX + IDENTITY_LINK_BYTES_MAX + IDENTITY_GUID_BYTES_MAX + IDENTITY_DATE_TEXT_BYTES_MAX

/**
 * UTF-16 units of the longest identity key (publisher, title and snippet
 * joined by two line feeds, identityOfFields) when normalization does not expand the text: a stored
 * UTF-8 byte gives at most one UTF-16 unit, the publisher is part of the
 * link, references only shrink.
 */
export const IDENTITY_KEY_UNITS_MAX = IDENTITY_LINK_BYTES_MAX + IDENTITY_TITLE_BYTES_MAX + IDENTITY_SNIPPET_BYTES_MAX + 2

/** The terms of groupingTransientEstimate(), in bytes. */
export interface GroupingTransientBreakdown {
    /** The working fork: what it copies on write and opens, at most a full memory. */
    readonly fork: number
    /** The predecessor's memory, until the publication releases it (overlap with the successor). */
    readonly predecessor: number
    /** Identity values of one window loaded from SQLite (title, snippet, link, date), as strings at 2 bytes per unit. */
    readonly windowValues: number
    /** The normalized title and snippet and the publisher of one record: the parts of its key. */
    readonly keyParts: number
    /** The key as one flat string (Buffer.from flattens the concatenation of the parts while writing it). */
    readonly key: number
    /** The UTF-16LE Buffer of the key the HMAC is computed over (SourceIdentity.digest), allocated before it is written. */
    readonly hmacBuffer: number
    /** Serialized elements of the page under construction (at most RESP_MAX units in all). */
    readonly page: number
    /** Building the result once the scan is over: payload text and serialized result (successResult), page objects. */
    readonly result: number
}

/**
 * The temporary allocations of a grouped call that can be alive together,
 * from the enforced limits. Two phases never overlap: the identity phase of
 * one record (the values of its window, the parts, flat key and UTF-16LE
 * Buffer of its key, the page so far; one record at a time, only its
 * fingerprint is kept) and the construction of the result (after the scan:
 * the window values and keys are no longer referenced). Fork and predecessor
 * last through both. Normalizing one field keeps at most its input and
 * output with the finished title, less than the key phase.
 */
export function groupingTransientBreakdown(limits: ScanLimits): GroupingTransientBreakdown {
    const memory = memoryWeightMax(limits)
    const keyBytes = 2 * IDENTITY_KEY_UNITS_MAX
    return {
        fork: memory,
        predecessor: memory,
        windowValues: 2 * Math.max(limits.identityWindowBytes, IDENTITY_RECORD_BYTES_MAX),
        keyParts: keyBytes,
        key: keyBytes,
        hmacBuffer: keyBytes,
        page: 2 * RESP_MAX,
        result: 3 * 2 * RESP_MAX,
    }
}

/**
 * Indicative estimate of the temporary bytes of the grouping during one call,
 * outside the persistent budget: fork + predecessor + the larger of the two
 * phases (groupingTransientBreakdown). A baseline, not a guaranteed bound:
 * text that NFKC, the lowercase mapping or the IDNA mapping of the publisher
 * expands takes more, and V8 adds its own object and heap overheads (strings
 * are counted at 2 bytes per unit, whereas V8 stores Latin-1 text at one).
 */
export function groupingTransientEstimate(limits: ScanLimits): number {
    const t = groupingTransientBreakdown(limits)
    return t.fork + t.predecessor + Math.max(t.windowValues + t.keyParts + t.key + t.hmacBuffer + t.page, t.result)
}
