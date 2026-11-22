/**
 * Identity of copies of the same article across RSS sources: the Fluent
 * Reader contract `fluent-reader/cross-source-duplicates`, version 1
 * (sections 3 to 7). A copy of the contract and its conformance data, with
 * their provenance, is in test/fixtures/cross-source-duplicates/v1.
 *
 * Pure functions: nothing here reads the database, and no value is logged or
 * returned by the tools (links and GUIDs only decide eligibility and the
 * publisher; the identity key is only hashed, see list-articles.ts).
 *
 * Every rule is the contract's, unchanged; where the contract describes the
 * reference implementation through a runtime facility, the facility is
 * replaced by the set the contract lists, so that the result does not depend
 * on the JavaScript engine:
 *  - white space (normalization step 4 and the trim of a link) is the 25
 *    code points of `whitespace`, not `\s` or String.prototype.trim;
 *  - invisible characters are the 6 code points of `invisible`;
 *  - named references are exactly the 94 names of `namedEntities`.
 * NFKC (String.prototype.normalize), the lowercase mapping
 * (String.prototype.toLowerCase), the word categories (\p{L}, \p{N}) and the
 * URL parser (WHATWG, node:url's URL) are those of the runtime, as in the
 * contract: Node.js 24 ships Unicode 17.0, the contract's reference version.
 *
 * The grouping of section 8 lives in scan/duplicate-memory.ts.
 */

export const CONTRACT_NAME = "fluent-reader/cross-source-duplicates"
export const CONTRACT_VERSION = 1

export const MAX_DATE_DIFFERENCE_MS = 600_000
export const MIN_SNIPPET_LENGTH = 60
export const MIN_SNIPPET_WORDS = 8
export const SYNTHETIC_GUID_PREFIX = "urn:fluent-reader:"
/** Paths that identify a site rather than an article (after removing trailing slashes and lowercasing). */
export const GENERIC_PATHS: readonly string[] = [
    "",
    "/index",
    "/index.htm",
    "/index.html",
    "/index.php",
    "/index.asp",
    "/index.aspx",
    "/default.asp",
    "/default.aspx",
    "/home",
    "/home.html",
    "/home.php",
]

/** The 94 named character references decoded, and nothing else (contract `namedEntities`). */
export const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    shy: "­",
    laquo: "«",
    raquo: "»",
    lsaquo: "‹",
    rsaquo: "›",
    lsquo: "‘",
    rsquo: "’",
    sbquo: "‚",
    ldquo: "“",
    rdquo: "”",
    bdquo: "„",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    middot: "·",
    bull: "•",
    deg: "°",
    euro: "€",
    pound: "£",
    copy: "©",
    reg: "®",
    trade: "™",
    sect: "§",
    para: "¶",
    times: "×",
    divide: "÷",
    iexcl: "¡",
    iquest: "¿",
    ordf: "ª",
    ordm: "º",
    agrave: "à",
    aacute: "á",
    acirc: "â",
    atilde: "ã",
    auml: "ä",
    aring: "å",
    aelig: "æ",
    ccedil: "ç",
    egrave: "è",
    eacute: "é",
    ecirc: "ê",
    euml: "ë",
    igrave: "ì",
    iacute: "í",
    icirc: "î",
    iuml: "ï",
    ntilde: "ñ",
    ograve: "ò",
    oacute: "ó",
    ocirc: "ô",
    otilde: "õ",
    ouml: "ö",
    oslash: "ø",
    ugrave: "ù",
    uacute: "ú",
    ucirc: "û",
    uuml: "ü",
    yacute: "ý",
    yuml: "ÿ",
    szlig: "ß",
    Agrave: "À",
    Aacute: "Á",
    Acirc: "Â",
    Atilde: "Ã",
    Auml: "Ä",
    Aring: "Å",
    AElig: "Æ",
    Ccedil: "Ç",
    Egrave: "È",
    Eacute: "É",
    Ecirc: "Ê",
    Euml: "Ë",
    Igrave: "Ì",
    Iacute: "Í",
    Icirc: "Î",
    Iuml: "Ï",
    Ntilde: "Ñ",
    Ograve: "Ò",
    Oacute: "Ó",
    Ocirc: "Ô",
    Otilde: "Õ",
    Ouml: "Ö",
    Oslash: "Ø",
    Ugrave: "Ù",
    Uacute: "Ú",
    Ucirc: "Û",
    Uuml: "Ü",
    Yacute: "Ý",
})

/** Contract `whitespace`: U+0009..U+000D, U+0020, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. */
export const WHITESPACE_CODE_POINTS: readonly number[] = [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
    0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]
/** Contract `invisible`: soft hyphen, zero width space, non-joiner, joiner, word joiner, byte order mark. */
export const INVISIBLE_CODE_POINTS: readonly number[] = [0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]

const REFERENCE = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g
const INVISIBLE = /[­​‌‍⁠﻿]/g
const SPACE_SET = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
const SPACES = new RegExp(`[${SPACE_SET}]+`, "g")
const TRIM = new RegExp(`^[${SPACE_SET}]+|[${SPACE_SET}]+$`, "g")
const WORD = /[\p{L}\p{N}]+/gu

/** Character references decoded in one left-to-right pass: "&amp;lt;" becomes "&lt;". Unknown names and invalid code points stay as written. */
export function decodeEntities(text: string): string {
    return text.replace(REFERENCE, (match: string, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
        if (name !== undefined) return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? (NAMED_ENTITIES[name] as string) : match
        const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10)
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match
        return String.fromCodePoint(code)
    })
}

/** Contract section 3: references, NFKC, invisible characters, white space, one leading and trailing space, lowercase. Not a string: null. */
export function normalizeText(value: unknown): string | null {
    if (typeof value !== "string") return null
    return decodeEntities(value).normalize("NFKC").replace(INVISIBLE, "").replace(SPACES, " ").replace(/^ | $/g, "").toLowerCase()
}

/** Length in Unicode code points (an unpaired surrogate counts as one); counting stops at `cap`. */
export function codePointLength(text: string, cap = Infinity): number {
    let length = 0
    for (let i = 0; i < text.length && length < cap; i++) {
        const unit = text.charCodeAt(i)
        length++
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(i + 1)
            if (next >= 0xdc00 && next <= 0xdfff) i++
        }
    }
    return length
}

/** Words: maximal runs of letters (L) and numbers (N); counting stops at `cap`. */
export function countWords(text: string, cap = Infinity): number {
    let count = 0
    WORD.lastIndex = 0
    while (count < cap && WORD.exec(text) !== null) count++
    WORD.lastIndex = 0
    return count
}

/** Contract section 4: the publisher of an article link, or null when the link cannot identify one. */
export function publisherOf(link: unknown): string | null {
    if (typeof link !== "string") return null
    let url: URL
    try {
        url = new URL(link.replace(TRIM, ""))
    } catch {
        return null
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username !== "" || url.password !== "") return null
    let host = url.hostname.toLowerCase().replace(/\.$/, "")
    if (host.startsWith("www.")) host = host.slice(4)
    if (host === "" || !host.includes(".")) return null
    const path = url.pathname.replace(/\/+$/, "").toLowerCase()
    if (GENERIC_PATHS.includes(path) && url.search === "") return null
    return url.port !== "" ? `${host}:${url.port}` : host
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/
const MAX_TIME = 8.64e15

const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysInMonth = (y: number, m: number): number => (m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31)

/** Milliseconds of a strict `YYYY-MM-DDTHH:MM:SS[.f{1,3}](Z|±HH:MM)` string, computed arithmetically, or null. */
export function parseIsoDate(text: string): number | null {
    const m = ISO_DATE.exec(text)
    if (m === null) return null
    const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
    const ms = m[7] !== undefined ? Number(m[7].padEnd(3, "0")) : 0
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
    if (hour > 23 || minute > 59 || second > 59) return null
    let offset = 0
    if (m[8] !== undefined) {
        const hours = Number(m[9])
        const minutes = Number(m[10])
        if (hours > 23 || minutes > 59) return null
        offset = (m[8] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000
    }
    // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, ms)
    const time = date.getTime() - offset
    return Number.isFinite(time) && Math.abs(time) <= MAX_TIME ? time : null
}

/** Contract section 5: a valid Date, a safe-integer number or a strict date string; anything else is no value. */
export function timeOf(date: unknown): number | null {
    const time = date instanceof Date ? date.getTime() : typeof date === "number" ? date : typeof date === "string" ? parseIsoDate(date) : null
    return time !== null && Number.isSafeInteger(time) && Math.abs(time) <= MAX_TIME ? time : null
}

/** The fields compared, as stored (contract section 2). Wrong types make the article ineligible. */
export interface DuplicateCandidate {
    readonly _id: unknown
    readonly source: unknown
    readonly title: unknown
    readonly snippet: unknown
    readonly link: unknown
    readonly date: unknown
    readonly guid?: unknown
}

/** What an eligible article is compared by: the identity key (publisher LF title LF snippet) and its time. */
export interface DuplicateIdentity {
    readonly key: string
    readonly time: number
}

/**
 * Contract section 6. `synthetic` is whether the GUID is a string starting
 * with SYNTHETIC_GUID_PREFIX (the scan decides it in SQL without loading the
 * GUID into JavaScript). Snippet length and words are only counted up to the
 * minimum they must reach.
 */
export function identityOfFields(fields: {
    readonly id: unknown
    readonly source: unknown
    readonly synthetic: boolean
    readonly time: number | null
    readonly link: unknown
    readonly title: unknown
    readonly snippet: unknown
}): DuplicateIdentity | null {
    if (typeof fields.id !== "number" || !Number.isSafeInteger(fields.id) || fields.id <= 0) return null
    if (typeof fields.source !== "number" || !Number.isSafeInteger(fields.source)) return null
    if (fields.synthetic || fields.time === null) return null
    const publisher = publisherOf(fields.link)
    if (publisher === null) return null
    const title = normalizeText(fields.title)
    if (!title) return null
    const snippet = normalizeText(fields.snippet)
    if (
        !snippet ||
        snippet === title ||
        codePointLength(snippet, MIN_SNIPPET_LENGTH) < MIN_SNIPPET_LENGTH ||
        countWords(snippet, MIN_SNIPPET_WORDS) < MIN_SNIPPET_WORDS
    ) {
        return null
    }
    return { key: `${publisher}\n${title}\n${snippet}`, time: fields.time }
}

/** The identity of a candidate (contract section 6), or null when it cannot be grouped. */
export function identityOf(item: DuplicateCandidate): DuplicateIdentity | null {
    return identityOfFields({
        id: item._id,
        source: item.source,
        synthetic: typeof item.guid === "string" && item.guid.startsWith(SYNTHETIC_GUID_PREFIX),
        time: timeOf(item.date),
        link: item.link,
        title: item.title,
        snippet: item.snippet,
    })
}

/** Contract section 7: whether two articles are copies of each other, independently of any order. */
export function isSameArticle(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
    if (a._id === b._id || a.source === b.source) return false
    const ia = identityOf(a)
    const ib = identityOf(b)
    return ia !== null && ib !== null && ia.key === ib.key && Math.abs(ia.time - ib.time) <= MAX_DATE_DIFFERENCE_MS
}
