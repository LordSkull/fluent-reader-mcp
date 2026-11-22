/**
 * Oracle of the grouped mode: the stored-order grouping of a set of articles
 * computed in one pass, without pagination, scan budgets or SQLite, by the
 * contract's identity (domain/duplicates.ts) and DuplicateMemory. A chain of
 * grouped pages must reconstruct exactly these groups, whatever its pageSize,
 * windows and budgets, as long as no memory limit is reached.
 */

import { identityOf } from "../../src/domain/duplicates.js"
import { DuplicateMemory, type DuplicateMemoryLimits } from "../../src/scan/duplicate-memory.js"
import type { ItemSpec } from "./sources.js"

export const UNLIMITED: DuplicateMemoryLimits = { groupsMax: 1e6, membersMax: 1e7, keyGroupsMax: 1e6 }

export interface Grouping {
    /** Articles that take a position, in stored order. */
    readonly positions: number[]
    /** Representative → members (representative first, stored order), groups of two or more only. */
    readonly groups: Map<number, number[]>
}

/** `items` must be the articles that pass the filters; their stored values are those of the specs. */
export function oracle(items: readonly ItemSpec[], limits: DuplicateMemoryLimits = UNLIMITED): Grouping & { forgotten: number } {
    const memory = new DuplicateMemory(limits)
    const positions: number[] = []
    const all = new Map<number, number[]>()
    for (const item of [...items].sort((a, b) => (b._id as number) - (a._id as number))) {
        const id = item._id as number
        const identity = identityOf({ _id: id, source: item.source, title: item.title, snippet: item.snippet, link: item.link, date: item.date, guid: item.guid })
        const story = identity === null ? undefined : memory.find(identity.key, identity.time, item.source as number)
        if (identity !== null && story !== undefined) {
            memory.join(story, identity.time, item.source as number)
            all.get(story.representativeId)?.push(id)
            continue
        }
        positions.push(id)
        all.set(id, [id])
        if (identity !== null) memory.open(id, identity.key, identity.time, item.source as number)
    }
    return { positions, groups: new Map([...all].filter(([, m]) => m.length > 1)), forgotten: memory.forgotten }
}

interface GroupedPage {
    readonly articles: readonly { readonly articleId: number; readonly duplicates?: { readonly copies: readonly { readonly articleId: number }[] } | undefined }[]
    readonly earlierCopies?: readonly { readonly representativeId: number; readonly articleId: number }[] | undefined
}

/** The grouping reconstructed from a chain of grouped pages; throws if an article appears twice. */
export function reconstruct(pages: readonly GroupedPage[]): Grouping & { seen: number[] } {
    const positions: number[] = []
    const all = new Map<number, number[]>()
    const seen: number[] = []
    const set = new Set<number>()
    const once = (id: number): void => {
        if (set.has(id)) throw new Error(`article ${id} returned twice`)
        set.add(id)
        seen.push(id)
    }
    for (const page of pages) {
        for (const a of page.articles) {
            once(a.articleId)
            positions.push(a.articleId)
            if (a.duplicates === undefined) throw new Error("not a grouped page")
            all.set(a.articleId, [a.articleId])
            for (const c of a.duplicates.copies) {
                once(c.articleId)
                all.get(a.articleId)?.push(c.articleId)
            }
        }
        for (const c of page.earlierCopies ?? []) {
            once(c.articleId)
            const members = all.get(c.representativeId)
            if (members === undefined || members[0] !== c.representativeId) throw new Error(`copy ${c.articleId} of a story not returned earlier`)
            members.push(c.articleId)
        }
    }
    return { positions, groups: new Map([...all].filter(([, m]) => m.length > 1)), seen }
}
