/**
 * One OS process of the concurrency tests, on a shared synthetic store. Only
 * synthetic paths reach it, through its single argument.
 *
 * edit:  until the deadline, read the revision, preview and apply an edit, and
 *        print every commit as JSON.
 * crash: apply one edit and die at the moment the document would be replaced,
 *        leaving the lock and the temporary file as a real crash does.
 * hold:  apply one edit, stop while holding the lock until told to go on.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { PreferenceStep } from "../../src/preferences/store.js"
import { harness } from "./sources.js"

interface WorkerInput {
    readonly mode: "edit" | "crash" | "hold"
    readonly id: string
    readonly dir: string
    readonly localAppData: string
    readonly userProfile: string
    readonly until: number
    readonly ready?: string
    readonly go?: string
}

const input = JSON.parse(process.argv[2] as string) as WorkerInput

function blockUntil(file: string): void {
    const pause = new Int32Array(new SharedArrayBuffer(4))
    while (!fs.existsSync(file) && Date.now() < input.until) Atomics.wait(pause, 0, 0, 10)
}

let armed = false
function step(name: PreferenceStep): void {
    if (!armed || name !== "before-rename") return
    armed = false
    if (input.mode === "crash") process.exit(9)
    if (input.mode === "hold") {
        fs.writeFileSync(input.ready as string, "")
        blockUntil(input.go as string)
    }
}

const h = await harness(
    { dir: input.dir, dbPath: path.join(input.dir, "fluent-reader.db"), configPath: path.join(input.dir, "config.json") },
    { newsPreferences: { enabled: true, localAppData: input.localAppData, userProfile: input.userProfile, previewKey: crypto.randomBytes(32), usedTokens: new Set(), step } },
)

async function attempt(text: string): Promise<[string, string] | null> {
    const state = await h.call("get_news_preferences")
    if (state.isError) return null
    const expectedRevision = state.payload.revision as string
    const changes = { operation: "set_general", interests: [text] }
    const preview = await h.call("preview_news_preferences_change", { expectedRevision, changes })
    if (preview.isError) return null
    armed = input.mode !== "edit"
    const apply = await h.call("apply_news_preferences_change", { previewToken: preview.payload.previewToken, expectedRevision, changes, confirm: true })
    return apply.isError ? null : [apply.payload.previousRevision, apply.payload.revision]
}

const applied: [string, string][] = []
if (input.mode === "edit") {
    let i = 0
    while (Date.now() < input.until) {
        i++
        const commit = await attempt(`${input.id} ${i}`)
        if (commit !== null) applied.push(commit)
    }
} else {
    const commit = await attempt(`${input.id} tenuto`)
    if (commit !== null) applied.push(commit)
}
await h.close()
console.log(JSON.stringify(applied))
process.exit(0)
