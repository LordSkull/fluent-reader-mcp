import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { FrMcpError } from "../src/errors.js"
import {
    CURSOR_CAPACITY,
    CURSOR_SCAN_MAX_MS,
    CURSOR_TOKEN_LENGTH,
    CURSOR_TTL_MS,
    CursorRegistry,
} from "../src/scan/cursors.js"
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
