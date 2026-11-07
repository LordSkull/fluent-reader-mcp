/**
 * One OS process of the rule guard tests, on a synthetic profile and backup
 * folder that reach it through its single argument.
 *
 * edit:  until the deadline, read the revision and add a rule with a unique
 *        pattern; print every commit as JSON.
 * crash: add one rule and die at the moment config.json would be replaced,
 *        leaving behind what a real crash leaves.
 * hold:  add one rule, stopping while it holds the guard until told to go on.
 */

import fs from "node:fs"
import path from "node:path"
import type { RuleWriteStep } from "../../src/settings/rule-store.js"
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

export interface WorkerCommit {
    readonly pattern: string
}

const input = JSON.parse(process.argv[2] as string) as WorkerInput

function blockUntil(file: string): void {
    const pause = new Int32Array(new SharedArrayBuffer(4))
    while (!fs.existsSync(file) && Date.now() < input.until) Atomics.wait(pause, 0, 0, 10)
}

let armed = false
function step(name: RuleWriteStep): void {
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
    { ruleWrites: { localAppData: input.localAppData, userProfile: input.userProfile, step } },
)

async function attempt(pattern: string): Promise<WorkerCommit | null> {
    const rules = await h.call("list_rules", { limit: 1, scope: "group", groupId: 0 })
    if (rules.isError) return null
    armed = input.mode !== "edit"
    const added = await h.call("add_rule", {
        scope: "group",
        groupId: 0,
        expectedRevision: rules.payload.revision,
        rule: { field: "title", pattern, caseSensitive: false, match: true, actions: [{ action: "hide", value: true }] },
    })
    if (added.isError) return null
    return { pattern }
}

const commits: WorkerCommit[] = []
if (input.mode === "edit") {
    let i = 0
    while (Date.now() < input.until) {
        i++
        const commit = await attempt(`^${input.id}x${i}$`)
        if (commit !== null) commits.push(commit)
    }
} else {
    const commit = await attempt(`^${input.id}$`)
    if (commit !== null) commits.push(commit)
}
await h.close()
console.log(JSON.stringify(commits))
process.exit(0)
