/**
 * Child process for the FR-REV-001 termination tests: a Node reader that
 * stops forever at a critical point of a read, with the preventive lock held,
 * so that the parent can terminate it there.
 *
 * argv: <database path> <marker path> <point>
 *   point = "before-first-read": SQLite opened, its first read not yet done
 *   point = "in-callback":       inside the read callback
 * The marker file (outside the profile) is written when the point is reached.
 */

import fs from "node:fs"
import { DatabaseAccess } from "../../src/db/connection.js"

const [dbPath, marker, point] = process.argv.slice(2) as [string, string, string]
const forever = new Int32Array(new SharedArrayBuffer(4))

function stopHere(): void {
    fs.writeFileSync(marker, point)
    for (;;) Atomics.wait(forever, 0, 0)
}

const access = new DatabaseAccess(dbPath, {
    hooks: point === "before-first-read" ? { beforeFirstRead: stopHere } : {},
})
await access.withReadConnection((db) => {
    db.prepare("SELECT count(*) FROM sources").get()
    if (point === "in-callback") stopHere()
})
fs.writeFileSync(marker, "completed")
