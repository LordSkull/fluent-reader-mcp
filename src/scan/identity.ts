/**
 * Source identity references (FR-MCP-01 §11.5.1).
 *
 * `sid` is not a permanent identity: Fluent Reader assigns MAX(sid)+1, so a
 * deleted source's id can be given to a different source. The feed URL cannot
 * be edited from the app's interface, so (sid, url) identifies one source for
 * its lifetime, except for a restore or the same feed being added again.
 *
 * sourceRef = `sr1.<epoch>.<mac>`:
 *  - epoch: 48 random bits chosen when this process starts;
 *  - mac: HMAC-SHA256(process key, domain ‖ sid ‖ 0x00 ‖ url), truncated to
 *    128 bits. The key is random and never leaves the process, so the ref
 *    reveals nothing about the URL and cannot be tested against guessed URLs.
 *
 * Guarantees: a ref issued for (sid, url) matches the current row only if the
 * row has the same sid and exactly the same URL text. Not detectable: the same
 * feed URL deleted and re-added with the same sid, a backup restore that
 * brings back the same (sid, url), changes to other attributes (name, icon,
 * flags), and anything across server restarts (the key is lost: such refs are
 * SOURCE_REF_EXPIRED, never silently accepted).
 */

import crypto from "node:crypto"
import { FrMcpError } from "../errors.js"

const REF_PATTERN = /^sr1\.([A-Za-z0-9_-]{8})\.([A-Za-z0-9_-]{22})$/
const MAC_BYTES = 16
const DOMAIN = "fluent-reader-mcp/source/1\0"

/** Length of every sourceRef (`sr1.` + 8 + `.` + 22). */
export const SOURCE_REF_LENGTH = 35

export class SourceIdentity {
    readonly #key = crypto.randomBytes(32)
    readonly #epoch = crypto.randomBytes(6).toString("base64url")

    #mac(sid: number, url: string): Buffer {
        return crypto
            .createHmac("sha256", this.#key)
            .update(DOMAIN)
            .update(String(sid))
            .update("\0")
            .update(url, "utf8")
            .digest()
            .subarray(0, MAC_BYTES)
    }

    /** The ref of the source currently stored as (sid, url). */
    refFor(sid: number, url: string): string {
        return `sr1.${this.#epoch}.${this.#mac(sid, url).toString("base64url")}`
    }

    /**
     * Verifies that `ref` designates the source currently stored with `sid`.
     * `url` is null when the current row has no textual URL (it cannot be the
     * source the ref was issued for, since refs are only issued for text URLs).
     */
    verify(ref: string, sid: number, url: string | null): void {
        const match = REF_PATTERN.exec(ref)
        if (match === null) throw new FrMcpError("INVALID_ARGUMENT", "malformed")
        const [, epoch, mac] = match as unknown as [string, string, string]
        const macBytes = Buffer.from(mac, "base64url")
        if (macBytes.length !== MAC_BYTES || macBytes.toString("base64url") !== mac) {
            throw new FrMcpError("INVALID_ARGUMENT", "malformed")
        }
        if (epoch !== this.#epoch) throw new FrMcpError("SOURCE_REF_EXPIRED", "other-process")
        if (url === null || !crypto.timingSafeEqual(macBytes, this.#mac(sid, url))) {
            throw new FrMcpError("SOURCE_IDENTITY_CHANGED", "ref-mismatch")
        }
    }
}
