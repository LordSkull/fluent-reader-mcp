# Contract: copies of the same article across RSS sources (version 1)

This directory specifies how Fluent Reader recognizes copies of the same
article published by different RSS sources, so that another client (for
example Fluent Reader MCP) can reproduce it without sharing code.

- Reference implementation: `src/scripts/duplicates.ts`.
- Conformance data: `conformance.json` (synthetic, no personal data).

A conforming implementation must give the results of `conformance.json`:
`namedEntities`, `whitespace`, `invisible` and `genericPaths` exactly;
every `normalization`, `publishers` and `dates` vector; the `pairs` of every
case; and, when candidates are ordered as Fluent Reader orders feeds, the
`groups` of every case.

Grouping only changes how articles are shown. It never changes, merges or
deletes stored articles, and each copy keeps its own id and states.

## 1. Constants

| Name | Value |
|---|---|
| `MAX_DATE_DIFFERENCE_MS` | `600000` (10 minutes, inclusive) |
| `MIN_SNIPPET_LENGTH` | `60` Unicode code points |
| `MIN_SNIPPET_WORDS` | `8` |
| `SYNTHETIC_GUID_PREFIX` | `urn:fluent-reader:` |
| `GENERIC_PATHS` | `""`, `/index`, `/index.htm`, `/index.html`, `/index.php`, `/index.asp`, `/index.aspx`, `/default.asp`, `/default.aspx`, `/home`, `/home.html`, `/home.php` |

## 2. Input

Each candidate article has: `_id`, `source`, `title`, `snippet`, `link`,
`date` and optionally `guid`, with the values stored by Fluent Reader. A
value of the wrong type makes the article ineligible (section 7). It is not
an error.

## 3. Text normalization

`normalize(value)` is defined only for strings. Any other value gives "no
value". The steps are, in this order:

1. **Character references**, decoded in a single left-to-right pass.
   Decoded text is not scanned again, so `&amp;lt;` becomes `&lt;`. A
   reference is `&` followed by one of the forms below and a mandatory `;`:
   - `#x` or `#X` and 1 to 6 hexadecimal digits;
   - `#` and 1 to 7 decimal digits;
   - an ASCII letter followed by 1 to 31 ASCII letters or digits, a name
     that is case-sensitive.

   A numeric reference is decoded unless its value is 0, a surrogate
   (U+D800 to U+DFFF) or above U+10FFFF. A named reference is decoded only
   if the name is one of the 94 in `namedEntities` of `conformance.json`;
   that table is exact and complete. Any other reference stays as written.
   The names are: `amp lt gt quot apos nbsp shy laquo raquo lsaquo rsaquo
   lsquo rsquo sbquo ldquo rdquo bdquo ndash mdash hellip middot bull deg
   euro pound copy reg trade sect para times divide iexcl iquest ordf ordm
   agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc
   euml igrave iacute icirc iuml ntilde ograve oacute ocirc otilde ouml
   oslash ugrave uacute ucirc uuml yacute yuml szlig Agrave Aacute Acirc
   Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute
   Icirc Iuml Ntilde Ograve Oacute Ocirc Otilde Ouml Oslash Ugrave Uacute
   Ucirc Uuml Yacute`.
2. **Unicode NFKC.** Note that this also maps `…` to `...`, `ﬁ` to `fi` and
   full-width letters to ASCII.
3. **Invisible characters removed**: U+00AD, U+200B, U+200C, U+200D,
   U+2060, U+FEFF (`invisible`).
4. **White space**: every run of the code points in `whitespace` becomes
   one U+0020. These are U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to
   U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF; the set is
   listed explicitly and does not depend on a regular-expression engine.
   U+0085 is not white space.
5. **One leading and one trailing U+0020 removed**; after step 4 there is at
   most one of each.
6. **Lowercase**: the full, locale-independent Unicode lowercase mapping,
   as `String.prototype.toLowerCase` (so `İ` becomes `i` followed by U+0307).

Typographic punctuation is not folded: `’` and `'` stay different.

**Words** are maximal runs of code points of general category L (letters)
or N (numbers); everything else separates words. **Lengths** are counted in
Unicode code points (an unpaired surrogate counts as one).

**Unicode version.** Steps 2 and 6 and the word categories follow the
Unicode version of the runtime. The reference is Unicode 17.0 (Electron
45.1, ICU 78.2). Implementations with another Unicode version can differ only
on characters whose properties changed between the two versions.

## 4. Publisher

`publisher(link)`:

1. The link must be a string. Leading and trailing white space as removed by
   `String.prototype.trim` is removed (the same set as in section 3, step 4).
2. It is parsed with the WHATWG URL Standard parser (`new URL(link)`), as an
   absolute URL without a base. A parse failure means no publisher.
3. The scheme must be `http` or `https`, and the URL must have no username
   and no password.
4. The host is the parser's `hostname` (already lowercase and IDNA/ASCII),
   lowercased, with one trailing `.` removed and then one leading `www.`
   removed. It must be non-empty and contain a `.`; this rejects
   `localhost` and IPv6 literals. The registrable domain is not computed:
   `lombardia.ansa.it` and `ansa.it` are different publishers.
5. If the path (`pathname`, without trailing `/`, lowercased) is in
   `GENERIC_PATHS` and the query (`search`) is empty, there is no publisher.
   A fragment does not count as a query.
6. The publisher is the host, followed by `:` and the port if the parser
   reports a non-default port.

The link is used only to identify the publisher. Equal links are no
evidence of identity, and different links do not prevent it. The same holds
for GUIDs, which are never compared.

## 5. Dates

`time(date)` is a number of milliseconds since 1970-01-01T00:00:00Z, or "no
value". It accepts exactly:

- a valid date object (in Fluent Reader, a JavaScript `Date`): its time;
- a number that is a safe integer (as stored in the database);
- a string matching, in full,
  `YYYY-MM-DDTHH:MM:SS[.f{1,3}](Z|±HH:MM)` (digits only; seconds and the
  zone are mandatory; at most three fraction digits, padded on the right to
  milliseconds).

String fields are validated: month 1 to 12; day 1 to the length of that
month in the proleptic Gregorian calendar (February has 29 days when the
year is divisible by 4 and not by 100, or by 400); hour 0 to 23; minute and
second 0 to 59; offset hour 0 to 23 and offset minute 0 to 59. The value is
computed arithmetically: years 0000 to 0099 are not shifted to 19xx. Then
the offset is subtracted.

Every result must be at most 8.64e15 in absolute value. Nothing else is
accepted, in particular none of the other formats of `Date.parse`.

## 6. Eligibility

An article is eligible when all of these hold:

- `_id` is a positive safe integer;
- `source` is a safe integer;
- `guid` is absent or does not start with `SYNTHETIC_GUID_PREFIX`. Articles
  made by Fluent Reader feed normalizers, such as the Camera dei deputati
  agenda, are never grouped;
- `time(date)` has a value;
- `publisher(link)` has a value;
- `normalize(title)` is not empty;
- `normalize(snippet)` is not empty, is different from the normalized
  title, and has at least `MIN_SNIPPET_LENGTH` code points and
  `MIN_SNIPPET_WORDS` words.

The **identity key** is publisher, LF, normalized title, LF, normalized
snippet.

## 7. Copies (pairs)

Two articles A and B are copies when both are eligible, `A._id ≠ B._id`,
`A.source ≠ B.source`, their keys are equal, and
`|time(A) − time(B)| ≤ MAX_DATE_DIFFERENCE_MS`. The relation is symmetric
and does not depend on any order (`pairs` in `conformance.json`).

## 8. Groups

The relation of section 7 is not transitive, so groups are made as follows:

1. Ignore an article whose `_id` was already seen; the first occurrence is
   kept. Keep eligible articles only.
2. Split them by identity key. For each key, order the candidates in **feed
   order**: descending time, then descending `_id`.
3. Repeat until no candidate is left: the first remaining candidate is the
   **representative**. For every other source, the first remaining
   candidate of that source joins the group if `time(representative) −
   time(candidate) ≤ MAX_DATE_DIFFERENCE_MS`. All of them leave the
   remaining candidates. A group of one article is not a group.

As a result, a group holds at most one article per source and spans at most
10 minutes from its representative. A at 16 min, B at 8 min and C at 0 min,
from three sources, give the group {A, B}, and C stays alone. Members are
listed in feed order, representative first. The result does not depend on
the input order. Adding candidates older than all others never changes the
existing groups; it can only complete them.

**Complexity.** Step 3 must not rescan the candidates. The reference keeps
the candidates of each source in feed order. A binary heap holds the first
remaining candidate of each source. The representative is popped from the
heap, the heads within the window are popped next, and the following
candidates of those sources are pushed back. Each candidate is pushed and
popped once: O(k log k) for k candidates of a key, including the sort.

**Other orders.** A client may choose representatives in its own order;
Fluent Reader MCP orders by `_id`. The identity (sections 3 to 7) must stay
identical. To keep every group within 10 minutes when the order is not by
time, a candidate joins only if the group's latest time minus its earliest
time, with the candidate included, stays ≤ `MAX_DATE_DIFFERENCE_MS`. For
feed order this is the same as step 3. With another order, the `groups` of
`conformance.json` must be recomputed; the `pairs` are unchanged.

## 9. Changes

Any change to these rules or to `conformance.json` is a new version of the
contract and must be made in both clients.
