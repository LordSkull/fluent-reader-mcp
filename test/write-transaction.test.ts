/**
 * The transaction files themselves (src/write-transaction.ts), on synthetic
 * folders only: no profile, no tool. Every fault is placed deterministically,
 * by mocking the exact file-system call it must precede.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { beginTransaction, copyStatus, recoverTransactions, removeOwned, setPhase, contentState, type Transaction } from "../src/write-transaction.js"
import { createTempRoot, removeTempRoot, snapshotDir } from "./helpers/fixtures.js"

let root: string
let counter = 0
before(() => { root = createTempRoot() })
after(() => removeTempRoot(root))

const ORIGINAL = Buffer.from('{"previous":"content with a FAKE credential"}\n')
const NEXT = Buffer.from('{"next":"content"}\n')

function dir(): string {
    const d = path.join(root, `tx ${++counter} é`)
    fs.mkdirSync(d)
    return d
}

const journal = (tx: Transaction): { phase: string; reason: string | null } => JSON.parse(fs.readFileSync(path.join(tx.dir, tx.journalName), "utf8"))
const copyPath = (tx: Transaction): string => path.join(tx.dir, tx.copyName as string)
/** Replaces a file by another one (new file id), as another program saving would. */
function replace(file: string, bytes: Buffer | string): void {
    const temp = `${file}.other-${++counter}`
    fs.writeFileSync(temp, bytes)
    fs.renameSync(temp, file)
}
const target = (bytes: Buffer | null) => async (): Promise<Buffer | null> => bytes

describe("cleanup is ownership-aware: a copy is removed only if it is provably the recorded one", () => {
    test("Codex reproduction: verified phase, copy replaced with foreign content, recovery: nothing removed, nothing claimed", async () => {
        const d = dir()
        const tx = beginTransaction(d, "rules", ORIGINAL, NEXT)
        setPhase(tx, "verified")
        replace(copyPath(tx), "FOREIGN CONTENT, not the copy")
        const report = await recoverTransactions(d, "rules", target(NEXT))
        assert.deepEqual(report, { cleaned: 0, kept: 1 }, "no cleanup declared")
        assert.equal(fs.readFileSync(copyPath(tx), "utf8"), "FOREIGN CONTENT, not the copy", "the foreign file is not removed")
        assert.deepEqual([journal(tx).phase, journal(tx).reason], ["recovery-kept", "copy-unverifiable"], "the journal stays, and says why")
        assert.deepEqual(fs.readdirSync(d).sort(), [tx.journalName, tx.copyName].sort(), "no private name left behind")
        assert.deepEqual(await recoverTransactions(d, "rules", target(NEXT)), { cleaned: 0, kept: 1 }, "and it is left alone afterwards")
    })

    const alterations: [string, (tx: Transaction) => void][] = [
        ["same size, other bytes", (tx) => replace(copyPath(tx), Buffer.alloc(ORIGINAL.length, 0x41))],
        ["other size", (tx) => replace(copyPath(tx), Buffer.concat([ORIGINAL, Buffer.from("x")]))],
        ["identical bytes in another file (file id differs)", (tx) => replace(copyPath(tx), ORIGINAL)],
        ["a directory", (tx) => { fs.unlinkSync(copyPath(tx)); fs.mkdirSync(copyPath(tx)) }],
        ["a junction to another folder", (tx) => { fs.unlinkSync(copyPath(tx)); const other = dir(); fs.writeFileSync(path.join(other, "keep"), "outside"); fs.symlinkSync(other, copyPath(tx), "junction") }],
        ["a second hard link elsewhere", (tx) => fs.linkSync(copyPath(tx), path.join(dir(), "second name"))],
    ]
    for (const [label, alter] of alterations) {
        for (const phase of ["verified", "prepared"] as const) {
            test(`copy that is ${label} (${phase}): kept with its journal, never removed`, async () => {
                const d = dir()
                const tx = beginTransaction(d, "rules", ORIGINAL, NEXT)
                if (phase === "verified") setPhase(tx, "verified")
                alter(tx)
                assert.equal(copyStatus(tx), "unverifiable")
                const before = snapshotDir(d)
                // "prepared" with the target still the original would be removable, if the copy were the recorded one.
                const report = await recoverTransactions(d, "rules", target(ORIGINAL))
                assert.deepEqual(report, { cleaned: 0, kept: 1 })
                const after = snapshotDir(d)
                assert.equal(after.get(tx.copyName as string), before.get(tx.copyName as string), "the file under the copy's name is untouched")
                assert.equal(journal(tx).phase, "recovery-kept")
                assert.deepEqual([...after.keys()].filter((name) => /\.removing$/.test(name)), [])
            })
        }
    }

    test("a file symlink in place of the copy: kept, its target untouched (skipped without the symlink privilege)", async (t) => {
        const d = dir()
        const tx = beginTransaction(d, "rules", ORIGINAL, NEXT)
        setPhase(tx, "verified")
        const elsewhere = path.join(dir(), "precious")
        fs.writeFileSync(elsewhere, ORIGINAL)
        fs.unlinkSync(copyPath(tx))
        try {
            fs.symlinkSync(elsewhere, copyPath(tx), "file")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("this account cannot create file symlinks")
            throw error
        }
        assert.equal(copyStatus(tx), "unverifiable")
        assert.deepEqual(await recoverTransactions(d, "rules", target(ORIGINAL)), { cleaned: 0, kept: 1 })
        assert.ok(fs.lstatSync(copyPath(tx)).isSymbolicLink())
        assert.deepEqual(fs.readFileSync(elsewhere), ORIGINAL)
    })

    test("the copy replaced right after its check, before it is moved aside: the foreign file is put back, nothing removed", (t) => {
        const d = dir()
        const tx = beginTransaction(d, "rules", ORIGINAL, NEXT)
        const real = fs.renameSync
        let swapped = false
        t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike): void => {
            if (!swapped && String(from) === copyPath(tx) && /\.removing$/.test(String(to))) {
                swapped = true
                // Interposition: after the lstat check of removeOwned, before its move aside.
                replace(copyPath(tx), "SWAPPED IN BY ANOTHER PROCESS")
            }
            real(from, to)
        })
        const foreign = (): bigint => fs.statSync(copyPath(tx), { bigint: true }).ino
        const outcome = removeOwned(d, tx.copyName as string, { identity: tx.copyIdentity, state: contentState(ORIGINAL) as never })
        assert.equal(swapped, true, "the interposition happened")
        assert.equal(outcome, "kept")
        assert.equal(fs.readFileSync(copyPath(tx), "utf8"), "SWAPPED IN BY ANOTHER PROCESS", "the foreign file is back under its name")
        assert.ok(foreign() > 0n)
        assert.deepEqual(fs.readdirSync(d).filter((name) => /\.removing$/.test(name)), [], "and not left under a private name")
    })

    test("a removal that fails puts the copy back (retained, still verified); the next recovery finishes it, extra names included", async (t) => {
        const d = dir()
        const tx = beginTransaction(d, "rules", ORIGINAL, NEXT)
        setPhase(tx, "verified")
        const real = fs.unlinkSync
        let refuse = true
        t.mock.method(fs, "unlinkSync", (file: fs.PathLike): void => {
            if (refuse && /\.removing$/.test(String(file))) throw Object.assign(new Error("held"), { code: "EBUSY" })
            real(file)
        })
        assert.equal(removeOwned(d, tx.copyName as string, { identity: tx.copyIdentity, state: contentState(ORIGINAL) as never }), "retained")
        assert.equal(copyStatus(tx), "verified", "the very same copy, back under its name; its leftover private name is recognized by file id")
        assert.equal(fs.readdirSync(d).filter((name) => /\.removing$/.test(name)).length, 1)
        refuse = false
        assert.deepEqual(await recoverTransactions(d, "rules", target(NEXT)), { cleaned: 1, kept: 0 })
        assert.deepEqual(fs.readdirSync(d), [], "every name of the verified copy removed, then its journal")
    })

    test("an extra name that is not this transaction's leftover keeps the copy unverifiable", () => {
        const d = dir()
        const tx = beginTransaction(d, "rules", ORIGINAL, NEXT)
        fs.linkSync(copyPath(tx), path.join(d, `${tx.copyName as string}.zzzz.removing`))
        assert.equal(copyStatus(tx), "unverifiable", "a name not of the form <copy>.<16 hex>.removing does not count")
    })

    test("a missing copy: verified phase finished (journal removed); uncertain phase kept as copy-missing", async () => {
        const verified = dir()
        const a = beginTransaction(verified, "rules", ORIGINAL, NEXT)
        setPhase(a, "verified")
        fs.unlinkSync(copyPath(a))
        assert.equal(copyStatus(a), "missing")
        assert.deepEqual(await recoverTransactions(verified, "rules", target(NEXT)), { cleaned: 1, kept: 0 })
        assert.deepEqual(fs.readdirSync(verified), [])

        const uncertain = dir()
        const b = beginTransaction(uncertain, "rules", ORIGINAL, NEXT)
        fs.unlinkSync(copyPath(b))
        assert.deepEqual(await recoverTransactions(uncertain, "rules", target(NEXT)), { cleaned: 0, kept: 1 })
        assert.deepEqual([journal(b).phase, journal(b).reason], ["recovery-kept", "copy-missing"])
    })

    test("the verified copy and its journal are removed in the normal case; old .bak files and unknown files never", async () => {
        const d = dir()
        const legacy = { "config.json.20251101T090000Z.bak": "old", "notes.txt": "someone's", "tx-0000000000000000.original": "a copy without journal" }
        for (const [name, content] of Object.entries(legacy)) fs.writeFileSync(path.join(d, name), content)
        const tx = beginTransaction(d, "rules", ORIGINAL, NEXT)
        setPhase(tx, "verified")
        assert.deepEqual(await recoverTransactions(d, "rules", target(NEXT)), { cleaned: 1, kept: 0 })
        assert.deepEqual(fs.readdirSync(d).sort(), Object.keys(legacy).sort())
        for (const [name, content] of Object.entries(legacy)) assert.equal(fs.readFileSync(path.join(d, name), "utf8"), content)
    })
})

describe("journals are removed only when they are this kind's journals", () => {
    test("an unreadable journal, a journal turned into a junction, a foreign file named like a partial journal: all kept", async () => {
        const d = dir()
        fs.writeFileSync(path.join(d, "tx-0123456789abcdef.journal"), "{not json")
        const junctionTarget = dir()
        fs.symlinkSync(junctionTarget, path.join(d, "tx-1111111111111111.journal"), "junction")
        fs.writeFileSync(path.join(d, "tx-2222222222222222.journal.3333333333333333.partial"), "not a journal at all")
        const before = snapshotDir(d)
        const report = await recoverTransactions(d, "rules", target(ORIGINAL))
        assert.equal(report.cleaned, 0)
        assert.deepEqual(snapshotDir(d), before)
    })

    test("a real unfinished journal replacement is removed; a journal of the other store is not this store's", async () => {
        const d = dir()
        const tx = beginTransaction(d, "rules", ORIGINAL, NEXT)
        const partial = path.join(d, `${tx.journalName}.4444444444444444.partial`)
        fs.copyFileSync(path.join(d, tx.journalName), partial)
        assert.deepEqual(await recoverTransactions(d, "preferences", target(ORIGINAL)), { cleaned: 0, kept: 1 }, "a rules journal read as preferences is not understood: kept")
        assert.ok(fs.existsSync(partial), "nor its partial")
        assert.deepEqual(await recoverTransactions(d, "rules", target(ORIGINAL)), { cleaned: 1, kept: 0 })
        assert.deepEqual(fs.readdirSync(d), [])
    })
})
