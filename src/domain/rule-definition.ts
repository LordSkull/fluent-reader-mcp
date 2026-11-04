/**
 * A rule as the change tools receive it, converted to the StoredRule of the
 * fork (src/schema-types.ts). Pure. Mirrors the fork's rule editor
 * (components/settings/rules/rule-editor.tsx, models/rule.ts):
 *  - filter: Default | ShowHidden (7), CaseInsensitive unless case sensitive,
 *    FullSearch for "text", CreatorSearch for "creator";
 *  - match: the value testItem's result must equal for the actions to apply.
 *    The editor's "matches" (it.json rules.match: "Risultati") stores true,
 *    "doesn't match" (rules.notMatch: "Non ci sono risultati") stores false.
 *    testItem covers the state conditions too, not only the pattern;
 *  - actions: "<r|s|h|n>-<true|false>" with one value per flag;
 *  - an empty pattern or no action cannot be saved.
 *
 * State conditions are the one thing the editor cannot write: it always stores
 * 7 in the low bits. The app evaluates them as stored (FilterType bits), and
 * saving the rule again from the editor drops them.
 */

import { FrMcpError } from "../errors.js"
import type { StoredRuleEntry } from "../settings/read-settings.js"
import {
    CASE_INSENSITIVE,
    CREATOR_SEARCH,
    FULL_SEARCH,
    REGEX_CHECK_MAX,
    SHOW_HIDDEN,
    SHOW_NOT_STARRED,
    SHOW_READ,
    type ActionFlag,
    type RuleField,
} from "./rules.js"

const ACTION_LETTER: Readonly<Record<ActionFlag, string>> = { read: "r", star: "s", hide: "h", notify: "n" }

export interface RuleDefinition {
    readonly field: RuleField
    readonly pattern: string
    readonly caseSensitive: boolean
    readonly match: boolean
    readonly stateMask?: { readonly requireUnread: boolean; readonly requireStarred: boolean; readonly requireVisible: boolean } | undefined
    readonly actions: readonly { readonly action: ActionFlag; readonly value: boolean }[]
}

/**
 * The stored form of a definition whose shape the input schema already checked.
 * The pattern is only compiled, with the flags the app would use, never executed.
 */
export function storedRuleFrom(definition: RuleDefinition): StoredRuleEntry {
    const { field, pattern, caseSensitive, match, stateMask, actions } = definition
    if ([...pattern].length > REGEX_CHECK_MAX) throw new FrMcpError("INVALID_ARGUMENT", "pattern-too-long")
    try {
        new RegExp(pattern, caseSensitive ? "" : "i")
    } catch {
        throw new FrMcpError("INVALID_ARGUMENT", "invalid-regex")
    }
    if (new Set(actions.map((entry) => entry.action)).size !== actions.length) throw new FrMcpError("INVALID_ARGUMENT", "duplicate-action")
    const filter =
        (stateMask?.requireUnread ? 0 : SHOW_READ) |
        (stateMask?.requireStarred ? 0 : SHOW_NOT_STARRED) |
        (stateMask?.requireVisible ? 0 : SHOW_HIDDEN) |
        (caseSensitive ? 0 : CASE_INSENSITIVE) |
        (field === "text" ? FULL_SEARCH : field === "creator" ? CREATOR_SEARCH : 0)
    return { filter, search: pattern, match, actions: actions.map((entry) => `${ACTION_LETTER[entry.action]}-${String(entry.value)}`) }
}
