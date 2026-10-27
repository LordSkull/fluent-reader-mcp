import assert from "node:assert/strict"
import { test } from "node:test"
import { ERROR_CODES, FrMcpError, toSafeError } from "../src/errors.js"

function sqliteError(errcode: number, message: string): Error {
    return Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode, errstr: message })
}

test("SQLite result codes map to domain codes and drop the raw message", () => {
    const cases: Array<[number, string]> = [
        [5, "DB_BUSY"],
        [6, "DB_BUSY"],
        [261, "DB_BUSY"],
        [776, "DB_NEEDS_RECOVERY"],
        [264, "DB_NEEDS_RECOVERY"],
        [11, "DB_UNREADABLE"],
        [26, "DB_UNREADABLE"],
        [10, "DB_UNREADABLE"],
        [14, "DB_UNREADABLE"],
        [1, "INTERNAL_ERROR"],
        [8, "INTERNAL_ERROR"],
    ]
    for (const [errcode, code] of cases) {
        const safe = toSafeError(sqliteError(errcode, "near \"SELECT secret FROM C:\\Users\\x\": syntax error"))
        assert.equal(safe.code, code, `errcode ${errcode}`)
        assert.ok(!JSON.stringify(safe).includes("secret"))
        assert.ok(!safe.message.includes("Users"))
    }
})

test("filesystem and JSON errors become INTERNAL_ERROR without their message", () => {
    const fsError = Object.assign(new Error("ENOENT: no such file, open 'C:\\Users\\x\\config.json'"), { code: "ENOENT" })
    let jsonError: unknown
    try {
        JSON.parse('{"password": "hunter2" oops')
    } catch (error) {
        jsonError = error
    }
    for (const error of [fsError, jsonError, "string thrown", undefined]) {
        const safe = toSafeError(error)
        assert.equal(safe.code, "INTERNAL_ERROR")
        const text = JSON.stringify(safe) + String(safe)
        assert.ok(!text.includes("Users") && !text.includes("hunter2"))
    }
})

test("every code has a fixed message and hint, and no cause", () => {
    for (const code of ERROR_CODES) {
        const error = new FrMcpError(code)
        assert.ok(error.message.length > 0 && error.hint.length > 0)
        assert.equal(error.cause, undefined)
        assert.deepEqual(Object.keys(error.toJSON()).sort(), ["code", "hint", "message"])
    }
    assert.equal(toSafeError(new FrMcpError("DB_BUSY", "busy")).reason, "busy")
})
