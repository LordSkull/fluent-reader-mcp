import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { FrMcpError } from "../src/errors.js"
import {
    CURSOR_CAPACITY,
    CURSOR_SCAN_MAX_MS,
    CURSOR_TOKEN_LENGTH,
    CURSOR_TTL_MS,
    CURSOR_WEIGHT_CAPACITY,
    CursorRegistry,
    ENTRY_WEIGHT,
    entryWeight,
} from "../src/scan/cursors.js"
import { QUERY_CODE_POINTS_MAX } from "../src/domain/text-match.js"
import { RESP_MAX } from "../src/tools/result.js"
import { ARTICLE_SOURCE_IDS_MAX } from "../src/tools/schemas.js"
import { SOURCE_REF_LENGTH, SourceIdentity } from "../src/scan/identity.js"

function expectCode(fn: () => unknown, code: string, reason?: string): void {
    assert.throws(fn, (error: unknown) => {
        assert.ok(error instanceof FrMcpError, String(error))
        assert.equal(error.code, code)
        if (reason !== undefined) assert.equal(error.reason, reason)
        return true
    })
}

function clock(start = 1_000_000): { now: () => number; advance(ms: number): void } {
    let t = start
    return { now: () => t, advance: (ms) => (t += ms) }
}

const BINDING = { includeHidden: true, groupId: null, query: null, limit: 10 }

describe("cursor registry (D-06)", () => {
    test("tokens are opaque, fixed-length and carry no state", () => {
        const registry = new CursorRegistry()
        const a = registry.create("list_sources", BINDING, { secret: "x" }, Date.now())
        const b = registry.create("list_sources", BINDING, { secret: "x" }, Date.now())
        assert.match(a, /^c1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/)
        assert.equal(a.length, CURSOR_TOKEN_LENGTH)
        assert.notEqual(a, b)
        assert.ok(!Buffer.from(a.slice(3, 25), "base64url").toString("latin1").includes("secret"))
        assert.deepEqual(registry.resolve<{ secret: string }>(a, "list_sources").state, { secret: "x" })
    })

    test("altered, malformed or foreign tokens are CURSOR_INVALID", () => {
        const registry = new CursorRegistry()
        const token = registry.create("list_sources", BINDING, {}, Date.now())
        const flip = (s: string, i: number): string => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1)
        expectCode(() => registry.resolve(flip(token, 5), "list_sources"), "CURSOR_INVALID", "malformed")
        expectCode(() => registry.resolve(flip(token, 40), "list_sources"), "CURSOR_INVALID", "malformed")
        expectCode(() => registry.resolve(`${token}x`, "list_sources"), "CURSOR_INVALID")
        expectCode(() => registry.resolve("", "list_sources"), "CURSOR_INVALID")
        expectCode(() => registry.resolve("c1.' OR 1=1 --", "list_sources"), "CURSOR_INVALID")
        // Issued by another process (another key): rejected, not "expired".
        const other = new CursorRegistry().create("list_sources", BINDING, {}, Date.now())
        expectCode(() => registry.resolve(other, "list_sources"), "CURSOR_INVALID")
        // Non-canonical base64url of the same bytes.
        const lastIdChar = token[24] as string
        if ("AQgw".includes(lastIdChar)) {
            const alt = token.slice(0, 24) + String.fromCharCode(lastIdChar.charCodeAt(0) + 1) + token.slice(25)
            expectCode(() => registry.resolve(alt, "list_sources"), "CURSOR_INVALID")
        }
    })

    test("TTL of 30 minutes after the last use, 2 hours per listing", () => {
        const c = clock()
        const registry = new CursorRegistry({ now: c.now })
        const token = registry.create("list_sources", BINDING, {}, c.now())
        c.advance(CURSOR_TTL_MS)
        registry.resolve(token, "list_sources") // exactly at the TTL: still valid, and refreshed
        c.advance(CURSOR_TTL_MS)
        registry.resolve(token, "list_sources")
        c.advance(CURSOR_TTL_MS + 1)
        expectCode(() => registry.resolve(token, "list_sources"), "CURSOR_EXPIRED", "unknown-or-expired")
        expectCode(() => registry.resolve(token, "list_sources"), "CURSOR_EXPIRED", "unknown-or-expired")

        const started = c.now()
        let current = registry.create("list_sources", BINDING, {}, started)
        while (c.now() - started + 20 * 60 * 1000 <= CURSOR_SCAN_MAX_MS) {
            c.advance(20 * 60 * 1000)
            registry.resolve(current, "list_sources")
            current = registry.create("list_sources", BINDING, {}, started)
        }
        c.advance(20 * 60 * 1000)
        expectCode(() => registry.resolve(current, "list_sources"), "CURSOR_EXPIRED", "scan-expired")
    })

    test("at most 64 cursors: the least recently used is evicted (CURSOR_EXPIRED)", () => {
        const registry = new CursorRegistry()
        const tokens = Array.from({ length: CURSOR_CAPACITY }, () => registry.create("list_sources", BINDING, {}, Date.now()))
        registry.resolve(tokens[0] as string, "list_sources") // now most recently used
        registry.create("list_sources", BINDING, {}, Date.now())
        assert.equal(registry.size, CURSOR_CAPACITY)
        registry.resolve(tokens[0] as string, "list_sources")
        expectCode(() => registry.resolve(tokens[1] as string, "list_sources"), "CURSOR_EXPIRED")
        for (let i = 0; i < 200; i++) registry.create("list_sources", BINDING, {}, Date.now())
        assert.equal(registry.size, CURSOR_CAPACITY)
    })

    test("a cursor of another tool is CURSOR_MISMATCH; invalidate forgets it", () => {
        const registry = new CursorRegistry()
        const token = registry.create("list_groups", BINDING, {}, Date.now())
        expectCode(() => registry.resolve(token, "list_sources"), "CURSOR_MISMATCH", "tool-mismatch")
        registry.invalidate(token)
        expectCode(() => registry.resolve(token, "list_groups"), "CURSOR_EXPIRED")
    })
})

describe("cursor registry: persistent memory budget", () => {
    /** A state holding a releasable payload, as a grouped listing's memory. */
    type Held = { memory: string | null }
    const held = (): Held => ({ memory: "m" })
    const release = (state: Held): void => {
        state.memory = null
    }
    const response = (units: number): string => "r".repeat(units)
    const base = entryWeight(BINDING, 0, undefined)

    test("entryWeight: the entry, its binding strings, its declared state, then its response", () => {
        assert.equal(entryWeight({}, 0, undefined), ENTRY_WEIGHT)
        assert.equal(entryWeight({ a: 1, b: null, c: true }, 0, undefined), ENTRY_WEIGHT + 3 * 32)
        assert.equal(entryWeight({ q: "abcd" }, 0, undefined), ENTRY_WEIGHT + 32 + 32 + 8)
        assert.equal(entryWeight({}, 5000, undefined), ENTRY_WEIGHT + 5000)
        assert.equal(entryWeight({}, 0, "x".repeat(10)), ENTRY_WEIGHT + 32 + 20)
        // Without groupDuplicates the 64 kept cursors fit the budget even with the largest binding (500 source ids of 16 digits, a query
        // of 200 code points as 400 units) and responses at the limit: the count limit alone applies, as before.
        const largest = {
            sourceIds: JSON.stringify(Array.from({ length: ARTICLE_SOURCE_IDS_MAX }, (_, i) => Number.MAX_SAFE_INTEGER - i)),
            query: "😀".repeat(QUERY_CODE_POINTS_MAX),
            groupId: null,
            dateFrom: "2026-01-01T00:00:00.000+14:00",
            dateTo: "2026-01-02T00:00:00.000+14:00",
            read: "unread",
            starred: "starred",
            hidden: "exclude",
            includeHiddenSources: false,
            pageSize: 100,
            excerptChars: 500,
            sort: "stored",
            fields: "creator",
            groupDuplicates: false,
        }
        const plainMax = entryWeight(largest, 0, response(RESP_MAX))
        assert.ok(plainMax < 116_000, String(plainMax))
        assert.ok(CURSOR_CAPACITY * plainMax < CURSOR_WEIGHT_CAPACITY)
    })

    test("create, publish, replay, invalidate and expiry keep the running total equal to a recount", () => {
        const c = clock()
        const registry = new CursorRegistry({ now: c.now })
        assert.deepEqual(registry.audit(), { entries: 0, weight: 0, stateWeight: 0, responses: 0 })
        const state = held()
        const first = registry.create("list_articles", BINDING, state, c.now(), { stateWeight: 10_000, releaseState: release })
        assert.equal(registry.weight, base + 10_000)
        assert.deepEqual(registry.audit(), { entries: 1, weight: base + 10_000, stateWeight: 10_000, responses: 0 })
        const entry = registry.resolve<Held>(first, "list_articles")
        const second = registry.create("list_articles", BINDING, held(), c.now(), { stateWeight: 12_000, releaseState: release, replacing: entry })
        assert.equal(registry.weight, 2 * base + 22_000, "the overlap of predecessor and successor, until the publication")
        registry.publish(entry, response(1000), second)
        assert.equal(state.memory, null, "the published state is dropped")
        assert.equal(entry.response, response(1000))
        assert.equal(entry.weight, entryWeight(BINDING, 0, response(1000)))
        assert.equal(registry.weight, entryWeight(BINDING, 0, response(1000)) + base + 12_000)
        assert.deepEqual(registry.audit(), { entries: 2, weight: registry.weight, stateWeight: 12_000, responses: 1 })
        assert.throws(() => registry.publish(entry, response(1000), second), /already published/)
        // Replay: resolving the published cursor changes no weight.
        const before = registry.weight
        for (let i = 0; i < 5; i++) assert.equal(registry.resolve(first, "list_articles").response, response(1000))
        assert.equal(registry.weight, before)
        registry.invalidate(second)
        assert.equal(registry.weight, entryWeight(BINDING, 0, response(1000)))
        c.advance(CURSOR_TTL_MS + 1)
        registry.create("list_sources", BINDING, {}, c.now())
        assert.equal(registry.weight, base, "the expired entry was removed with its weight")
        registry.audit()
    })

    test("LRU eviction by weight, grouped and plain cursors together; evicted cursors are CURSOR_EXPIRED", () => {
        const capacity = 4 * base + 3 * 100_000 + 5000
        const registry = new CursorRegistry({ weightCapacity: capacity })
        const grouped = [0, 1, 2].map(() => registry.create("list_articles", BINDING, held(), Date.now(), { stateWeight: 100_000, releaseState: release }))
        const plain = registry.create("list_sources", BINDING, {}, Date.now())
        assert.equal(registry.weight, 4 * base + 300_000)
        registry.resolve(grouped[0] as string, "list_articles") // grouped[1] becomes the least recently used
        registry.create("list_articles", BINDING, held(), Date.now(), { stateWeight: 100_000, releaseState: release })
        expectCode(() => registry.resolve(grouped[1] as string, "list_articles"), "CURSOR_EXPIRED")
        assert.ok(registry.peek(grouped[0] as string) !== undefined && registry.peek(plain) !== undefined)
        assert.ok(registry.weight <= capacity)
        registry.audit()
        // Responses count too: publishing a large response evicts the least recently used entries, never the published one nor its successor.
        const entry = registry.resolve<Held>(grouped[2] as string, "list_articles")
        const successor = registry.create("list_articles", BINDING, held(), Date.now(), { stateWeight: 100_000, releaseState: release, replacing: entry })
        registry.publish(entry, response(30_000), successor)
        assert.ok(registry.weight <= capacity, String(registry.weight - capacity))
        assert.ok(registry.peek(grouped[2] as string)?.response !== undefined && registry.peek(successor) !== undefined)
        expectCode(() => registry.resolve(grouped[0] as string, "list_articles"), "CURSOR_EXPIRED")
        registry.audit()
    })

    test("a chain replacing its own cursor never evicts another chain for the memory it releases", () => {
        const capacity = 2 * base + 2 * 200_000 + 50_000
        const registry = new CursorRegistry({ weightCapacity: capacity })
        const other = registry.create("list_articles", BINDING, held(), Date.now(), { stateWeight: 200_000, releaseState: release })
        let token = registry.create("list_articles", BINDING, held(), Date.now(), { stateWeight: 200_000, releaseState: release })
        for (let page = 0; page < 20; page++) {
            const entry = registry.resolve<Held>(token, "list_articles")
            const next = registry.create("list_articles", BINDING, held(), Date.now(), { stateWeight: 200_000, releaseState: release, replacing: entry })
            assert.ok(registry.peek(other) !== undefined, "not evicted by the overlap")
            assert.ok(registry.weight <= capacity + 200_000, "the overlap exceeds the capacity by at most the released state")
            registry.publish(entry, response(10), next)
            assert.ok(registry.weight <= capacity)
            registry.audit()
            token = next
        }
        assert.ok(registry.peek(other) !== undefined)
        assert.equal(registry.audit().responses, 20)
    })

    test("a failed call: the successor is invalidated, the cursor it was called with keeps its state and weight", () => {
        const registry = new CursorRegistry()
        const state = held()
        const token = registry.create("list_articles", BINDING, state, Date.now(), { stateWeight: 50_000, releaseState: release })
        const before = registry.audit()
        const entry = registry.resolve<Held>(token, "list_articles")
        const next = registry.create("list_articles", BINDING, held(), Date.now(), { stateWeight: 60_000, releaseState: release, replacing: entry })
        registry.invalidate(next) // the response could not be built
        assert.deepEqual(registry.audit(), before)
        assert.deepEqual([entry.response, entry.weight, state.memory], [undefined, base + 50_000, "m"])
        // The retry publishes normally.
        const retry = registry.create("list_articles", BINDING, held(), Date.now(), { stateWeight: 60_000, releaseState: release, replacing: entry })
        registry.publish(entry, response(100), retry)
        assert.equal(registry.audit().stateWeight, 60_000)
    })

    test("64 cursors with responses near the limit: count limit only, within the budget; the 65th evicts the oldest", () => {
        const registry = new CursorRegistry()
        const tokens: string[] = []
        let previous: string | undefined
        for (let i = 0; i < CURSOR_CAPACITY; i++) {
            const entry = previous === undefined ? undefined : registry.resolve(previous, "list_articles")
            const next = registry.create("list_articles", BINDING, {}, Date.now(), entry === undefined ? {} : { replacing: entry })
            if (entry !== undefined) registry.publish(entry, response(RESP_MAX), next)
            tokens.push(next)
            previous = next
        }
        assert.equal(registry.size, CURSOR_CAPACITY)
        assert.ok(registry.weight < CURSOR_WEIGHT_CAPACITY)
        assert.equal(registry.audit().responses, CURSOR_CAPACITY - 1)
        registry.create("list_articles", BINDING, {}, Date.now())
        expectCode(() => registry.resolve(tokens[0] as string, "list_articles"), "CURSOR_EXPIRED")
        registry.audit()
    })

    describe("expiry at publication: publish() checks the entry itself, with or without a successor", () => {
        /** A kept cursor of another listing, which no refusal may touch. */
        const setup = (scanStartedAt?: (now: number) => number) => {
            const c = clock()
            const registry = new CursorRegistry({ now: c.now })
            const other = registry.create("list_sources", BINDING, {}, c.now())
            const state = held()
            const token = registry.create("list_articles", BINDING, state, scanStartedAt?.(c.now()) ?? c.now(), { stateWeight: 1000, releaseState: release })
            const entry = registry.resolve<Held>(token, "list_articles")
            /** Time passes during the call; the other listing stays in use meanwhile. */
            const advance = (ms: number): void => {
                for (let left = ms; left > 0; left -= CURSOR_TTL_MS) {
                    c.advance(Math.min(left, CURSOR_TTL_MS))
                    registry.resolve(other, "list_sources")
                }
            }
            return { advance, registry, other, otherWeight: registry.peek(other)?.weight as number, state, token, entry }
        }
        /** The refusal: CURSOR_EXPIRED, nothing published or released, the entry gone with its weight, the other cursor untouched. */
        const refused = (s: ReturnType<typeof setup>, publish: () => void, reason: string): void => {
            expectCode(publish, "CURSOR_EXPIRED", reason)
            assert.equal(s.entry.response, undefined, "no response published")
            assert.equal(s.state.memory, "m", "the state is not released as if published")
            assert.equal(s.registry.peek(s.token), undefined)
            assert.ok(s.registry.peek(s.other) !== undefined)
            assert.deepEqual(s.registry.audit(), { entries: 1, weight: s.otherWeight, stateWeight: 0, responses: 0 })
            expectCode(() => s.registry.resolve(s.token, "list_articles"), "CURSOR_EXPIRED")
            assert.equal(s.registry.resolve(s.other, "list_sources").response, undefined)
        }

        test("last page (no successor), absolute expiry of the listing during the call", () => {
            // Used recently (no inactivity), but the listing started just within CURSOR_SCAN_MAX_MS.
            const s = setup((now) => now - CURSOR_SCAN_MAX_MS + 1000)
            s.advance(1001)
            refused(s, () => s.registry.publish(s.entry, response(10), null), "scan-expired")
        })

        test("last page (no successor), inactivity expiry during the call", () => {
            const s = setup()
            s.advance(CURSOR_TTL_MS + 1)
            refused(s, () => s.registry.publish(s.entry, response(10), null), "unknown-or-expired")
        })

        test("with a successor: expired before create() (which removed it) or between create() and publish(); the successor is invalidated", () => {
            for (const when of ["before-create", "after-create"] as const) {
                const s = setup()
                if (when === "before-create") s.advance(CURSOR_TTL_MS + 1)
                const next = s.registry.create("list_articles", BINDING, held(), s.entry.scanStartedAt, { stateWeight: 2000, releaseState: release, replacing: s.entry })
                if (when === "after-create") s.advance(CURSOR_TTL_MS + 1)
                refused(s, () => s.registry.publish(s.entry, response(10), next), "unknown-or-expired")
                assert.equal(s.registry.peek(next), undefined, "no reference to the successor is left")
                expectCode(() => s.registry.resolve(next, "list_articles"), "CURSOR_EXPIRED")
            }
        })

        test("before and exactly at each limit the cursor is still live: published, then replayed (same rule as resolve)", () => {
            for (const [label, start, advance] of [
                ["inactivity, 1 ms before", undefined, CURSOR_TTL_MS - 1],
                ["inactivity, exactly at the limit", undefined, CURSOR_TTL_MS],
                ["listing age, exactly at the limit", (now: number) => now - CURSOR_SCAN_MAX_MS + 1000, 1000],
            ] as const) {
                for (const withSuccessor of [false, true]) {
                    const s = setup(start)
                    s.advance(advance)
                    const next = withSuccessor ? s.registry.create("list_articles", BINDING, held(), s.entry.scanStartedAt, { stateWeight: 2000, releaseState: release, replacing: s.entry }) : null
                    s.registry.publish(s.entry, response(10), next)
                    assert.equal(s.entry.response, response(10), label)
                    assert.equal(s.state.memory, null, label)
                    assert.equal(s.registry.resolve(s.token, "list_articles").response, response(10), `${label}: replay`)
                    if (next !== null) assert.ok(s.registry.peek(next) !== undefined, label)
                    assert.equal(s.registry.audit().responses, 1, label)
                }
            }
        })

        test("an entry no longer kept is not published either", () => {
            const s = setup()
            s.registry.invalidate(s.token)
            refused(s, () => s.registry.publish(s.entry, response(10), null), "unknown-or-expired")
        })
    })

    test("a state weight over the capacity is refused", () => {
        const registry = new CursorRegistry({ weightCapacity: 10_000 })
        assert.throws(() => registry.create("list_articles", BINDING, {}, Date.now(), { stateWeight: 10_000 }), RangeError)
        assert.throws(() => registry.create("list_articles", BINDING, {}, Date.now(), { stateWeight: -1 }), RangeError)
        assert.equal(registry.size, 0)
    })
})

describe("sourceRef", () => {
    test("bound to (sid, url) of this process, reveals nothing about the URL", () => {
        const identity = new SourceIdentity()
        const url = "https://user:pass@feed.invalid/private?token=abc"
        const ref = identity.refFor(3, url)
        assert.equal(ref.length, SOURCE_REF_LENGTH)
        assert.match(ref, /^sr1\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{22}$/)
        assert.equal(identity.refFor(3, url), ref, "deterministic within the process")
        assert.ok(!ref.includes("feed") && !ref.includes("token"))
        identity.verify(ref, 3, url)
        expectCode(() => identity.verify(ref, 3, "https://other.invalid/"), "SOURCE_IDENTITY_CHANGED", "ref-mismatch")
        expectCode(() => identity.verify(ref, 4, url), "SOURCE_IDENTITY_CHANGED")
        expectCode(() => identity.verify(ref, 3, null), "SOURCE_IDENTITY_CHANGED")
        expectCode(() => identity.verify("sr1.bad", 3, url), "INVALID_ARGUMENT")
        const other = new SourceIdentity()
        assert.notEqual(other.refFor(3, url), ref)
        expectCode(() => other.verify(ref, 3, url), "SOURCE_REF_EXPIRED", "other-process")
    })
})
