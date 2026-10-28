import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { FrMcpError } from "../src/errors.js"
import { errorResult, PageBudget, quoteCount, RESP_MAX, resultLength, successResult } from "../src/tools/result.js"
import { SECRET_SENTINEL } from "./helpers/fixtures.js"

const SAMPLES = [
    "plain ascii",
    'quotes " and backslashes \\ and \\" mixed',
    "control \u0000\u0001\u0008\u0009\n\r\u001f end",
    "unicode àèì 中文 😀 \u2028\u2029",
    "lone surrogates \ud800 x \udfff",
    "",
    "</script><!-- & ' `",
]

describe("result size accounting (FR-MCP-01 §14.0.3)", () => {
    test("quoteCount counts only quotes and backslashes", () => {
        assert.equal(quoteCount('a"b\\c'), 2)
        assert.equal(quoteCount(JSON.stringify("\u0001")), 3) // "\u0001" → 2 quotes + 1 backslash
    })

    test("the incremental cost equals the real growth of |S(R)|, element by element", () => {
        const items: unknown[] = []
        const budget = new PageBudget(resultLength({ items, tail: true }))
        for (let round = 0; round < 3; round++) {
            for (const sample of SAMPLES) {
                const item = { name: sample, n: round, flag: sample.length % 2 === 0 }
                const json = JSON.stringify(item)
                const before = resultLength({ items, tail: true })
                const cost = budget.cost(json)
                assert.ok(budget.tryAdd(json))
                items.push(item)
                assert.equal(resultLength({ items, tail: true }) - before, cost, `cost of ${JSON.stringify(sample)}`)
                assert.equal(budget.used, resultLength({ items, tail: true }))
            }
        }
    })

    test("tryAdd refuses the element that would cross RESP_MAX", () => {
        const items: string[] = []
        const budget = new PageBudget(resultLength({ items }))
        const element = "x".repeat(997)
        while (budget.tryAdd(JSON.stringify(element))) items.push(element)
        const length = resultLength({ items })
        assert.ok(length <= RESP_MAX)
        assert.ok(length + budget.cost(JSON.stringify(element)) > RESP_MAX)
        assert.equal(budget.used, length)
    })

    test("successResult duplicates the payload and never exceeds RESP_MAX", () => {
        const payload = { a: "é\"\\\u0001😀", b: [1, 2] }
        const { result, serialized } = successResult(payload)
        assert.equal(result.content.length, 1)
        const first = result.content[0]
        assert.ok(first?.type === "text")
        assert.deepEqual(JSON.parse(first.text), result.structuredContent)
        assert.equal(serialized, JSON.stringify(result))
        assert.throws(
            () => successResult({ big: "y".repeat(RESP_MAX / 2) }),
            (error: unknown) => error instanceof FrMcpError && error.code === "LIMIT_EXCEEDED" && error.reason === "response-too-large",
        )
    })

    test("errorResult carries only code, message, hint and reason", () => {
        const raw = Object.assign(new Error(`SELECT * FROM sources -- C:\\Users\\x\\${SECRET_SENTINEL}`), { stack: SECRET_SENTINEL })
        const result = errorResult(raw)
        assert.equal(result.isError, true)
        assert.equal(result.structuredContent, undefined)
        const text = (result.content[0] as { text: string }).text
        assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["code", "hint", "message", "reason"])
        assert.equal(JSON.parse(text).code, "INTERNAL_ERROR")
        assert.ok(!text.includes(SECRET_SENTINEL) && !text.includes("SELECT") && !text.includes("Users"))
        const busy = errorResult(Object.assign(new Error(SECRET_SENTINEL), { code: "ERR_SQLITE_ERROR", errcode: 5 }))
        assert.equal(JSON.parse((busy.content[0] as { text: string }).text).code, "DB_BUSY")
    })
})
