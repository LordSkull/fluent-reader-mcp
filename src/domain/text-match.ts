/**
 * Literal text matching of search_articles (FR-MCP-01 §12.2, FR-MCP-02B-02).
 *
 * A query matches a field when normalize(query) is a substring of
 * normalize(field). No regex, no SQL pattern, no wildcard: `%`, `_`, `*`,
 * `(` or `[` are ordinary characters. No ranking, stemming or synonyms.
 *
 * normalize(s), in this order:
 *  1. String.prototype.toLowerCase(): the default, locale-independent Unicode
 *     lowercase mapping (no Turkish or Lithuanian tailoring);
 *  2. canonical decomposition, NFD;
 *  3. removal of every code point of the Combining Diacritical Marks block,
 *     U+0300..U+036F (grave, acute, circumflex, tilde, diaeresis, cedilla,
 *     ring, ogonek, caron, ...);
 *  4. U+03C2 GREEK SMALL LETTER FINAL SIGMA becomes U+03C3 (the lowercase
 *     mapping of step 1 chooses between them by context);
 *  5. every run of whitespace (JavaScript `\s`: Unicode White_Space and
 *     U+FEFF) becomes one U+0020.
 *
 * Equivalences this gives, and only these: upper/lower case under the
 * default mapping (ECONOMIA = economia, İ = i); a letter with diacritics from
 * U+0300..U+036F and the same letter without them (città = citta, perché =
 * perche, ç = c, ñ = n), precomposed or decomposed alike; σ = ς; any
 * whitespace sequence = one space. NOT equivalent: ß and ss, æ/œ and ae/oe,
 * ø/ł/đ and o/l/d (no canonical decomposition), ligatures, full-width or
 * other compatibility forms (no NFKD), the Turkish dotless ı and i, marks
 * outside U+0300..U+036F (e.g. Japanese voiced marks, Hebrew or Arabic
 * points), quotes or dashes of different shapes. This is not full Unicode
 * case folding.
 *
 * Size: step 1 maps one code point to at most two UTF-16 units (U+0130 only),
 * and NFD expands one UTF-16 unit to at most four (UAX #15, e.g. U+1F82);
 * steps 3-5 only shrink. A normalized string therefore has at most
 * NORMALIZED_EXPANSION_MAX times the UTF-16 units of its input, and a value
 * loaded from SQLite has at most as many UTF-16 units as UTF-8 bytes.
 */

/** normalize(s).length <= NORMALIZED_EXPANSION_MAX * s.length. */
export const NORMALIZED_EXPANSION_MAX = 4

const COMBINING_DIACRITICS = /[̀-ͯ]/g
const FINAL_SIGMA = /ς/g
const WHITESPACE_RUN = /\s+/g

export function normalizeForSearch(text: string): string {
    return text.toLowerCase().normalize("NFD").replace(COMBINING_DIACRITICS, "").replace(FINAL_SIGMA, "σ").replace(WHITESPACE_RUN, " ")
}

/** Query limits: code points of the query as given, UTF-16 units once normalized. */
export const QUERY_CODE_POINTS_MAX = 200
export const QUERY_NORMALIZED_UNITS_MAX = 800

/** C0/C1 control characters that are not whitespace (whitespace is collapsed by normalize). */
const CONTROL = /(?![\t\n\v\f\r])\p{Cc}/u

/**
 * The normalized query, trimmed, or null when the query is not acceptable:
 * not well-formed UTF-16 (a lone surrogate), a control character other than
 * whitespace, more than QUERY_CODE_POINTS_MAX code points, nothing left after
 * normalization (only spaces or only combining marks), or more than
 * QUERY_NORMALIZED_UNITS_MAX UTF-16 units after it.
 */
export function normalizeQuery(query: string): string | null {
    if (!query.isWellFormed() || CONTROL.test(query)) return null
    let codePoints = 0
    for (const _ of query) if (++codePoints > QUERY_CODE_POINTS_MAX) return null
    const normalized = normalizeForSearch(query).trim()
    if (normalized.length === 0 || normalized.length > QUERY_NORMALIZED_UNITS_MAX) return null
    return normalized
}
