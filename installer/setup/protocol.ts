/**
 * FR-MCP-04-BETA-02: how the NSIS wizard talks to the setup helper.
 *
 * Every value chosen by the user (directories, the claude.exe path, consent)
 * travels in a REQUEST file, never on a command line, so no quoting rule of
 * cmd.exe, the C runtime or NSIS applies to it. The helper answers in a
 * RESULT file. Both are UTF-16LE with a BOM (what NSIS reads and writes
 * natively with FileReadUTF16LE/FileWriteUTF16LE), one `key=value` per line;
 * a key may repeat (multi-line messages). The helper writes nothing else:
 * no log, and no configuration content in any result.
 */

import fs from "node:fs"

/** A refusal the wizard shows to the user as is (Italian, like the wizard). */
export class SetupRefusal extends Error {
    override readonly name = "SetupRefusal"

    /** Extra result fields for the wizard (for example what it can offer to do next). */
    constructor(message: string, readonly fields: readonly (readonly [string, string])[] = []) {
        super(message)
    }
}

export type Request = ReadonlyMap<string, string>

/** Parses a request file: UTF-16LE with BOM (NSIS) or UTF-8 (tests, manual use). */
export function readRequest(file: string): Request {
    const bytes = fs.readFileSync(file)
    const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8").replace(/^﻿/, "")
    const request = new Map<string, string>()
    for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue
        const at = line.indexOf("=")
        if (at <= 0) throw new SetupRefusal("richiesta non valida (riga senza chiave)")
        const key = line.slice(0, at)
        if (request.has(key)) throw new SetupRefusal(`richiesta non valida (chiave ripetuta: ${key})`)
        request.set(key, line.slice(at + 1))
    }
    return request
}

export function required(request: Request, key: string): string {
    const value = request.get(key)
    if (value === undefined || value.length === 0) throw new SetupRefusal(`richiesta incompleta: manca ${key}`)
    return value
}

export function flag(request: Request, key: string): boolean {
    const value = request.get(key)
    if (value === undefined || value === "" || value === "no") return false
    if (value === "yes") return true
    throw new SetupRefusal(`richiesta non valida: ${key} deve essere yes o no`)
}

export type Status = "ok" | "refused" | "error"

export interface Result {
    readonly status: Status
    /** Ordered fields; a multi-line value becomes one line per key. */
    readonly fields: readonly (readonly [string, string])[]
}

export function encodeResult(result: Result): Buffer {
    const lines = [`status=${result.status}`]
    for (const [key, value] of result.fields) for (const line of value.split(/\r?\n/)) lines.push(`${key}=${line}`)
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${lines.join("\r\n")}\r\n`, "utf16le")])
}

export function decodeResult(bytes: Buffer): Map<string, string[]> {
    if (bytes[0] !== 0xff || bytes[1] !== 0xfe) throw new Error("result file without UTF-16LE BOM")
    const fields = new Map<string, string[]>()
    for (const line of bytes.subarray(2).toString("utf16le").split("\r\n")) {
        if (line.length === 0) continue
        const at = line.indexOf("=")
        const key = line.slice(0, at)
        fields.set(key, [...(fields.get(key) ?? []), line.slice(at + 1)])
    }
    return fields
}

/** Writes the result file, replacing a previous answer of this helper (the wizard reuses one path in $PLUGINSDIR). */
export function writeResult(file: string, result: Result): void {
    fs.writeFileSync(file, encodeResult(result))
}
