/**
 * Replaces one target of sourceRules in the text of a config.json, leaving
 * every other byte as it is: unknown fields, number spellings, key order and
 * the other targets are never parsed and written again. Pure.
 *
 * The input must already be accepted by JSON.parse, so the scanner only has to
 * find where members start and end, and the caller checks the result by parsing
 * it. Fluent Reader writes config.json with tabs (`JSON.stringify(v, undefined,
 * "\t")` in conf); text inserted here is indented the same way.
 *
 * A duplicated "sourceRules" or target key is refused: JSON.parse keeps the
 * last value, so which rules are in force would depend on the reader. Other
 * duplicated keys are left as they are.
 */

import { FrMcpError } from "../errors.js"

interface Member {
    readonly key: string
    readonly start: number
    readonly valueStart: number
    readonly valueEnd: number
}

function skipSpace(text: string, at: number): number {
    let i = at
    while (i < text.length && " \t\r\n".includes(text.charAt(i))) i++
    return i
}

/** `at` is the opening quote; returns the position after the closing quote. */
function skipString(text: string, at: number): number {
    let i = at + 1
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1
    return i + 1
}

function skipValue(text: string, at: number): number {
    const first = text[at]
    if (first === '"') return skipString(text, at)
    if (first === "{" || first === "[") {
        let depth = 0
        let i = at
        for (;;) {
            const c = text[i]
            if (c === '"') {
                i = skipString(text, i)
                continue
            }
            if (c === "{" || c === "[") depth++
            else if (c === "}" || c === "]") depth--
            i++
            if (depth === 0) return i
        }
    }
    let i = at
    while (i < text.length && !",}] \t\r\n".includes(text.charAt(i))) i++
    return i
}

/** The members of the object whose `{` is at `open`. */
function membersOf(text: string, open: number): { members: Member[]; close: number } {
    const members: Member[] = []
    let i = skipSpace(text, open + 1)
    if (text[i] === "}") return { members, close: i }
    for (;;) {
        const start = i
        const keyEnd = skipString(text, start)
        const key = JSON.parse(text.slice(start, keyEnd)) as string
        const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1)
        const valueEnd = skipValue(text, valueStart)
        members.push({ key, start, valueStart, valueEnd })
        i = skipSpace(text, valueEnd)
        if (text[i] === "}") return { members, close: i }
        i = skipSpace(text, i + 1)
    }
}

function single(members: readonly Member[], key: string): Member | undefined {
    const found = members.filter((member) => member.key === key)
    if (found.length > 1) throw new FrMcpError("SETTINGS_INVALID", "duplicate-key")
    return found[0]
}

function serialized(value: unknown, depth: number): string {
    // Raw newlines can only be JSON layout here: inside strings they are escaped.
    return JSON.stringify(value, undefined, "\t").replaceAll("\n", `\n${"\t".repeat(depth)}`)
}

function member(key: string, value: unknown, depth: number): string {
    return `${"\t".repeat(depth)}${JSON.stringify(key)}: ${serialized(value, depth)}`
}

/** `{"key": value}` added at the end of the object at `open`, indented for `depth` (the object's own). */
function added(text: string, open: number, key: string, value: unknown, depth: number): string {
    const { members, close } = membersOf(text, open)
    const line = member(key, value, depth + 1)
    if (members.length === 0) return `${text.slice(0, open + 1)}\n${line}\n${"\t".repeat(depth)}${text.slice(close)}`
    const end = (members.at(-1) as Member).valueEnd
    return `${text.slice(0, end)},\n${line}${text.slice(end)}`
}

function removed(text: string, members: readonly Member[], close: number, index: number): string {
    const target = members[index] as Member
    const next = members[index + 1]
    if (next !== undefined) return text.slice(0, target.start) + text.slice(next.start)
    const previous = members[index - 1]
    if (previous !== undefined) return text.slice(0, previous.valueEnd) + text.slice(target.valueEnd)
    const open = text.lastIndexOf("{", target.start)
    return text.slice(0, open + 1) + text.slice(close)
}

/**
 * The text with sourceRules[key] set to `rules`, or without that key when
 * `rules` is null (as the app does for an empty list; the sourceRules object
 * stays, possibly empty).
 */
export function spliceRuleTarget(text: string, key: string, rules: readonly unknown[] | null): string {
    const open = skipSpace(text, 0)
    const root = membersOf(text, open)
    const section = single(root.members, "sourceRules")
    if (section === undefined) {
        if (rules === null) return text
        return added(text, open, "sourceRules", { [key]: rules }, 0)
    }
    const inner = membersOf(text, section.valueStart)
    const current = single(inner.members, key)
    if (rules === null) return current === undefined ? text : removed(text, inner.members, inner.close, inner.members.indexOf(current))
    if (current === undefined) return added(text, section.valueStart, key, rules, 1)
    return text.slice(0, current.valueStart) + serialized(rules, 2) + text.slice(current.valueEnd)
}
