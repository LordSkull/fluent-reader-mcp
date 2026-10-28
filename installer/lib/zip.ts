/**
 * Minimal ZIP support in pure Node (zlib), so that neither tar.exe nor
 * PowerShell is needed and no path is ever quoted for a shell.
 *
 * Writer: deterministic (entries in the given order, fixed DOS timestamp,
 * no extra fields, UTF-8 names flagged with bit 11), deflate or store,
 * classic ZIP only: it refuses anything that would need ZIP64.
 * Reader: central directory based (data descriptors are fine), ZIP64 sizes
 * and offsets accepted, methods store/deflate only, no encryption, CRC-32
 * and sizes checked, every name validated with assertRelativePath.
 */

import fs from "node:fs"
import zlib from "node:zlib"
import { assertRelativePath, BuildError } from "./common.js"

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const FLAG_UTF8 = 0x0800
const FLAG_ENCRYPTED = 0x0001
const MAX32 = 0xffffffff
const MAX16 = 0xffff

export interface ZipInput {
    /** "/"-separated entry name. */
    readonly name: string
    readonly data: Buffer
}

export interface ZipEntry {
    readonly name: string
    readonly size: number
    readonly compressedSize: number
    readonly crc32: number
    readonly method: number
    read(): Buffer
}

/** DOS date/time of a UNIX time in seconds, in UTC, clamped to 1980-01-01. */
export function dosDateTime(epochSeconds: number): { date: number; time: number } {
    const d = new Date(Math.max(epochSeconds, 315532800) * 1000)
    return {
        date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    }
}

/** Encodes entries as they are, without validating names (tests use it to craft hostile archives). */
export function encodeZip(entries: readonly ZipInput[], epochSeconds: number): Buffer {
    if (entries.length >= MAX16) throw new BuildError("too many ZIP entries (ZIP64 is not supported)")
    const { date, time } = dosDateTime(epochSeconds)
    const locals: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0
    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8")
        const crc = zlib.crc32(entry.data)
        const deflated = zlib.deflateRawSync(entry.data, { level: 9 })
        const stored = deflated.length >= entry.data.length
        const body = stored ? entry.data : deflated
        if (entry.data.length >= MAX32 || body.length >= MAX32 || offset >= MAX32) throw new BuildError("ZIP entry too large (ZIP64 is not supported)")
        const local = Buffer.alloc(30)
        local.writeUInt32LE(LOCAL_SIG, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(FLAG_UTF8, 6)
        local.writeUInt16LE(stored ? 0 : 8, 8)
        local.writeUInt16LE(time, 10)
        local.writeUInt16LE(date, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(body.length, 18)
        local.writeUInt32LE(entry.data.length, 22)
        local.writeUInt16LE(name.length, 26)
        local.writeUInt16LE(0, 28)
        const central = Buffer.alloc(46)
        central.writeUInt32LE(CENTRAL_SIG, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(FLAG_UTF8, 8)
        central.writeUInt16LE(stored ? 0 : 8, 10)
        central.writeUInt16LE(time, 12)
        central.writeUInt16LE(date, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(body.length, 20)
        central.writeUInt32LE(entry.data.length, 24)
        central.writeUInt16LE(name.length, 28)
        central.writeUInt32LE(offset, 42)
        locals.push(local, name, body)
        centrals.push(central, name)
        offset += local.length + name.length + body.length
    }
    const centralDirectory = Buffer.concat(centrals)
    if (offset + centralDirectory.length >= MAX32) throw new BuildError("ZIP too large (ZIP64 is not supported)")
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(EOCD_SIG, 0)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(centralDirectory.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, centralDirectory, eocd])
}

/** The bytes of a ZIP whose entry names are all validated package paths, without duplicates. */
export function zipBytes(entries: readonly ZipInput[], epochSeconds: number): Buffer {
    const seen = new Set<string>()
    for (const entry of entries) {
        assertRelativePath(entry.name)
        const key = entry.name.toLowerCase()
        if (seen.has(key)) throw new BuildError(`duplicate ZIP entry (case-insensitive): ${entry.name}`)
        seen.add(key)
    }
    return encodeZip(entries, epochSeconds)
}

/** Writes zipBytes() to a new file (never overwrites). */
export function writeZip(file: string, entries: readonly ZipInput[], epochSeconds: number): void {
    fs.writeFileSync(file, zipBytes(entries, epochSeconds), { flag: "wx" })
}

function fail(reason: string): never {
    throw new BuildError(`invalid ZIP: ${reason}`)
}

function zip64Extra(extra: Buffer, needs: { size: boolean; compressed: boolean; offset: boolean }): { size?: number; compressed?: number; offset?: number } {
    let at = 0
    while (at + 4 <= extra.length) {
        const id = extra.readUInt16LE(at)
        const length = extra.readUInt16LE(at + 2)
        if (id === 0x0001) {
            let p = at + 4
            const take = (): number => {
                if (p + 8 > at + 4 + length) fail("truncated ZIP64 extra field")
                const value = Number(extra.readBigUInt64LE(p))
                p += 8
                if (!Number.isSafeInteger(value)) fail("ZIP64 value out of range")
                return value
            }
            return {
                ...(needs.size && { size: take() }),
                ...(needs.compressed && { compressed: take() }),
                ...(needs.offset && { offset: take() }),
            }
        }
        at += 4 + length
    }
    return {}
}

/** Parses the central directory of a ZIP held in memory. */
export function readZip(bytes: Buffer): ZipEntry[] {
    let eocd = -1
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - MAX16); i--) {
        if (bytes.readUInt32LE(i) === EOCD_SIG) {
            eocd = i
            break
        }
    }
    if (eocd < 0) fail("end of central directory not found")
    let count = bytes.readUInt16LE(eocd + 10)
    let cdSize = bytes.readUInt32LE(eocd + 12)
    let cdOffset = bytes.readUInt32LE(eocd + 16)
    if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
        const locator = eocd - 20
        if (locator < 0 || bytes.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) fail("ZIP64 locator not found")
        const record = Number(bytes.readBigUInt64LE(locator + 8))
        if (record + 56 > bytes.length || bytes.readUInt32LE(record) !== ZIP64_EOCD_SIG) fail("ZIP64 end of central directory not found")
        count = Number(bytes.readBigUInt64LE(record + 32))
        cdSize = Number(bytes.readBigUInt64LE(record + 40))
        cdOffset = Number(bytes.readBigUInt64LE(record + 48))
    }
    if (cdOffset + cdSize > bytes.length) fail("central directory out of bounds")
    const entries: ZipEntry[] = []
    const names = new Set<string>()
    let at = cdOffset
    for (let i = 0; i < count; i++) {
        if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIG) fail("bad central directory entry")
        const flags = bytes.readUInt16LE(at + 8)
        const method = bytes.readUInt16LE(at + 10)
        const crc = bytes.readUInt32LE(at + 16)
        let compressedSize = bytes.readUInt32LE(at + 20)
        let size = bytes.readUInt32LE(at + 24)
        const nameLength = bytes.readUInt16LE(at + 28)
        const extraLength = bytes.readUInt16LE(at + 30)
        const commentLength = bytes.readUInt16LE(at + 32)
        let localOffset = bytes.readUInt32LE(at + 42)
        const rawName = bytes.subarray(at + 46, at + 46 + nameLength)
        const extra = bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)
        at += 46 + nameLength + extraLength + commentLength
        if ((flags & FLAG_ENCRYPTED) !== 0) fail("encrypted entry")
        if (method !== 0 && method !== 8) fail(`unsupported compression method ${method}`)
        if ((flags & FLAG_UTF8) === 0 && rawName.some((byte) => byte > 0x7e || byte < 0x20)) fail("non-ASCII name without the UTF-8 flag")
        const name = rawName.toString("utf8")
        const big = zip64Extra(extra, { size: size === MAX32, compressed: compressedSize === MAX32, offset: localOffset === MAX32 })
        size = big.size ?? size
        compressedSize = big.compressed ?? compressedSize
        localOffset = big.offset ?? localOffset
        const directory = name.endsWith("/")
        assertRelativePath(directory ? name.slice(0, -1) : name)
        if (names.has(name.toLowerCase())) fail(`duplicate entry ${name}`)
        names.add(name.toLowerCase())
        if (directory) continue
        const offset = localOffset
        entries.push({
            name,
            size,
            compressedSize,
            crc32: crc,
            method,
            read(): Buffer {
                if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== LOCAL_SIG) fail(`bad local header for ${name}`)
                const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28)
                if (start + compressedSize > bytes.length) fail(`data out of bounds for ${name}`)
                const body = bytes.subarray(start, start + compressedSize)
                let data: Buffer
                try {
                    data = method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body, { maxOutputLength: Math.max(size, 1) })
                } catch {
                    fail(`corrupted data for ${name}`)
                }
                if (data.length !== size || zlib.crc32(data) !== crc) fail(`size or CRC-32 mismatch for ${name}`)
                return data
            },
        })
    }
    return entries
}
