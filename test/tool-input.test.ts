/**
 * Tool argument handling (FR-02A02-001): omitted arguments default to {},
 * `null` and other non-objects are invalid. Checked at the three layers a
 * call can come through: the SDK v2 client, raw JSON-RPC (no client-side
 * validation) and the handlers themselves.
 */

import assert from "node:assert/strict"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileLock } from "../src/db/connection.js"
import { FrMcpError } from "../src/errors.js"
import { getSource } from "../src/tools/get-source.js"
import { parseArgs } from "../src/tools/input.js"
import { listSources } from "../src/tools/list-sources.js"
import { errorResult } from "../src/tools/result.js"
import { getSourceInput, listSourcesInput, listSourcesOutput } from "../src/tools/schemas.js"
import { createTempRoot, removeTempRoot, type ProfileFixture } from "./helpers/fixtures.js"
import { createSourcesProfile, harness, rawSession, type Harness, type RawSession } from "./helpers/sources.js"

let root: string
let p: ProfileFixture
let h: Harness
let raw: RawSession

before(async () => {
    root = createTempRoot()
    p = createSourcesProfile(path.join(root, "input"), { sources: [{ sid: 0 }, { sid: 1 }] })
    h = await harness(p)
    raw = await rawSession(p)
})
after(async () => {
    await h.close()
    await raw.close()
    fileLock().close()
    removeTempRoot(root)
})

/** Text fragments of a raw parser (Zod) error, never allowed in a tool result. */
const PARSER_TEXT = ["Invalid input", "expected", "invalid_type", "received", "path"]

function assertSanitizedInvalid(text: string): void {
    const error = JSON.parse(text) as { code: string; reason?: string }
    assert.equal(error.code, "INVALID_ARGUMENT")
    assert.equal(error.reason, "invalid-argument")
    for (const fragment of PARSER_TEXT) assert.ok(!text.includes(fragment), fragment)
}

describe("tool arguments: omitted, {} and null", () => {
    test("parseArgs: only undefined defaults to {}; null is INVALID_ARGUMENT", () => {
        assert.deepEqual(parseArgs(listSourcesInput, undefined), {})
        assert.deepEqual(parseArgs(listSourcesInput, {}), {})
        for (const value of [null, [], "x", 0, false]) {
            assert.throws(
                () => parseArgs(listSourcesInput, value),
                (e: unknown) => e instanceof FrMcpError && e.code === "INVALID_ARGUMENT" && e.reason === "invalid-argument",
            )
        }
        assert.throws(() => parseArgs(getSourceInput, null), (e: unknown) => e instanceof FrMcpError && e.code === "INVALID_ARGUMENT")
        assert.throws(() => parseArgs(getSourceInput, undefined), (e: unknown) => e instanceof FrMcpError && e.code === "INVALID_ARGUMENT")
    })

    test("handlers: null is a sanitized INVALID_ARGUMENT for both tools; undefined lists with defaults", async () => {
        for (const run of [() => listSources(h.context, null), () => getSource(h.context, null), () => getSource(h.context, {})]) {
            const error = await run().then(
                () => assert.fail("expected INVALID_ARGUMENT"),
                (e: unknown) => e,
            )
            assert.ok(error instanceof FrMcpError && error.code === "INVALID_ARGUMENT")
            const result = errorResult(error)
            assert.equal(result.isError, true)
            assert.equal(result.structuredContent, undefined)
            const first = result.content[0]
            assertSanitizedInvalid(first?.type === "text" ? first.text : "")
        }
        const listed = await listSources(h.context, undefined)
        assert.notEqual(listed.isError, true)
        const payload = listSourcesOutput.parse(listed.structuredContent)
        assert.deepEqual(payload.sources.map((s) => s.sourceId), [0, 1])
    })

    test("SDK v2 client: omitted arguments and {} are valid with defaults", async () => {
        const omitted = await h.client.callTool({ name: "list_sources" })
        const empty = await h.call("list_sources", {})
        for (const result of [omitted, empty.result]) {
            assert.notEqual(result.isError, true)
            const payload = listSourcesOutput.parse(result.structuredContent)
            assert.deepEqual(payload.sources.map((s) => s.sourceId), [0, 1])
            assert.equal(payload.hasMore, false)
        }
    })

    test("SDK v2 client: null arguments are refused by the SDK (-32602) before any handler runs", async () => {
        for (const name of ["list_sources", "get_source"]) {
            await assert.rejects(
                h.client.callTool({ name, arguments: null as unknown as Record<string, unknown> }),
                (e: unknown) => (e as { code?: unknown }).code === -32602,
            )
        }
    })

    test("SDK v2 client: get_source without sourceId is a sanitized INVALID_ARGUMENT", async () => {
        for (const args of [{}, { sourceRef: "sr1.AAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA" }, { sourceId: null }]) {
            const r = await h.call("get_source", args)
            assert.equal(r.isError, true)
            assert.equal(r.result.structuredContent, undefined)
            assertSanitizedInvalid(r.text)
        }
        assert.equal((await h.client.callTool({ name: "get_source" })).isError, true)
    })

    test("raw JSON-RPC: omitted and {} list with defaults; null never reaches a handler", async () => {
        for (const params of [{ name: "list_sources" }, { name: "list_sources", arguments: {} }]) {
            const response = await raw.request("tools/call", params)
            assert.equal(response.error, undefined)
            assert.notEqual(response.result.isError, true)
            const payload = listSourcesOutput.parse(response.result.structuredContent)
            assert.deepEqual(payload.sources.map((s) => s.sourceId), [0, 1])
        }
        // SDK 2.4.0 validates params.arguments as an optional record: a JSON-RPC
        // error, not a tool result, and no tool handler is invoked.
        for (const name of ["list_sources", "get_source"]) {
            const response = await raw.request("tools/call", { name, arguments: null })
            assert.equal(response.result, undefined)
            assert.equal(response.error?.code, -32602)
        }
    })

    test("raw JSON-RPC: get_source without sourceId or with invalid fields is a sanitized INVALID_ARGUMENT", async () => {
        for (const params of [
            { name: "get_source" },
            { name: "get_source", arguments: {} },
            { name: "get_source", arguments: { sourceId: "0" } },
            { name: "list_sources", arguments: { limit: 0 } },
            { name: "list_sources", arguments: { unknown: true } },
        ]) {
            const response = await raw.request("tools/call", params)
            assert.equal(response.error, undefined)
            assert.equal(response.result.isError, true)
            assert.equal(response.result.structuredContent, undefined)
            assertSanitizedInvalid(response.result.content[0].text)
        }
    })
})
