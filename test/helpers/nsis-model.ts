/**
 * A small interpreter for the NSIS instructions of the uninstaller's last
 * steps, so that tests run the script's REAL text (macros expanded, the
 * generated helper-files.nsh included) on real files, with failures injected
 * into the file operations. It knows only what that part of the script uses
 * and throws on anything else, so it cannot silently skip an instruction.
 *
 * Semantics follow the NSIS 3 reference: Delete sets the error flag only
 * when an existing file cannot be deleted; RMDir (without /r) removes an
 * empty directory and sets the error flag when it cannot; ${FileExists}
 * "dir\*" is true for an existing directory; string comparisons with == and
 * != ignore case, as StrCmp does.
 */

import fs from "node:fs"

export interface NsisFs {
    readonly unlink: (file: string) => void
    readonly rmdir: (dir: string) => void
}

export interface NsisRun {
    readonly outcome: "completed" | "aborted" | "crashed"
    readonly abort: string | null
    readonly messages: string[]
    readonly executed: string[]
}

interface Macro {
    readonly params: string[]
    readonly body: string[]
}

function tokens(text: string): string[] {
    return [...text.matchAll(/"((?:[^"$]|\$\\"|\$(?!\\"))*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : (m[2] as string)))
}

/** Every !macro … !macroend of the given texts. */
export function parseMacros(...texts: string[]): Map<string, Macro> {
    const macros = new Map<string, Macro>()
    for (const text of texts) {
        const lines = text.replace(/^﻿/, "").split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
            const head = /^\s*!macro\s+(\S+)(.*)$/.exec(lines[i] as string)
            if (head === null) continue
            const body: string[] = []
            for (i++; i < lines.length && !/^\s*!macroend\b/.test(lines[i] as string); i++) body.push(lines[i] as string)
            macros.set(head[1] as string, { params: tokens((head[2] ?? "").trim()), body })
        }
    }
    return macros
}

/** The lines of a section from a label to a marker line (exclusive). */
export function sectionLines(script: string, section: string, fromLabel: string, untilLine: string): string[] {
    const start = script.indexOf(`Section "${section}"`)
    const from = script.indexOf(`\n  ${fromLabel}:`, start)
    const until = script.indexOf(`\n  ${untilLine}`, from)
    if (start < 0 || from < 0 || until < 0) throw new Error(`section ${section}: ${fromLabel}..${untilLine} not found`)
    return script.slice(from + 1, until).split(/\r?\n/)
}

function expand(lines: readonly string[], macros: Map<string, Macro>, depth = 0): string[] {
    if (depth > 10) throw new Error("macro recursion")
    const out: string[] = []
    for (const line of lines) {
        const m = /^\s*!insertmacro\s+(\S+)(.*)$/.exec(line)
        if (m === null) {
            out.push(line)
            continue
        }
        const macro = macros.get(m[1] as string)
        if (macro === undefined) throw new Error(`unknown macro ${m[1] as string}`)
        const args = tokens((m[2] ?? "").trim())
        const body = macro.body.map((l) => macro.params.reduce((acc, p, i) => acc.split(`\${${p}}`).join(args[i] ?? ""), l))
        out.push(...expand(body, macros, depth + 1))
    }
    return out
}

export function runNsis(input: {
    readonly lines: readonly string[]
    readonly macros: Map<string, Macro>
    readonly vars: Record<string, string>
    readonly fs: NsisFs
    /** Simulated crash: stop right after the instruction for which it returns true. */
    readonly crashAfter?: (instruction: string) => boolean
}): NsisRun {
    const vars = new Map(Object.entries(input.vars))
    const messages: string[] = []
    const executed: string[] = []
    let errors = false
    const names = (): string[] => [...vars.keys()].sort((a, b) => b.length - a.length)
    const value = (text: string): string => {
        let out = text.split("$\\r$\\n").join("\n").split("$\\\"").join('"')
        for (const name of names()) out = out.split(`$${name}`).join(vars.get(name) as string)
        return out
    }
    const exists = (p: string): boolean => {
        if (p.endsWith("\\*")) return fs.statSync(p.slice(0, -2), { throwIfNoEntry: false })?.isDirectory() === true
        return fs.existsSync(p)
    }
    const condition = (text: string): boolean => {
        const t = tokens(text)
        if (t[0] === "${Errors}") return errors
        if (t[0] === "${FileExists}") return exists(value(t[1] as string))
        if (t[1] === "==" || t[1] === "!=") {
            const equal = value(t[0] as string).toLowerCase() === value(t[2] as string).toLowerCase()
            return t[1] === "==" ? equal : !equal
        }
        throw new Error(`unsupported condition: ${text}`)
    }
    const frames: { parent: boolean; done: boolean; cond: boolean }[] = []
    const active = (): boolean => frames.every((f) => f.parent && !f.done && f.cond) || frames.length === 0
    for (const raw of expand(input.lines, input.macros)) {
        const line = raw.trim()
        if (line === "" || line.startsWith(";") || /^[A-Za-z_][\w.]*:$/.test(line)) continue
        const branch = /^\$\{(If|AndIf|OrIf|ElseIf|Else|EndIf)\}\s*(.*)$/.exec(line)
        if (branch !== null) {
            const [, kind, rest] = branch
            const top = frames[frames.length - 1]
            if (kind === "If") frames.push({ parent: active(), done: false, cond: condition(rest as string) })
            else if (top === undefined) throw new Error(`${kind} without If`)
            else if (kind === "AndIf") top.cond = top.cond && condition(rest as string)
            else if (kind === "OrIf") top.cond = top.cond || condition(rest as string)
            else if (kind === "ElseIf") {
                top.done = top.done || top.cond
                top.cond = condition(rest as string)
            } else if (kind === "Else") {
                top.done = top.done || top.cond
                top.cond = true
            } else frames.pop()
            continue
        }
        if (!active()) continue
        const [op, ...args] = tokens(line)
        executed.push(line)
        switch (op) {
            case "StrCpy":
                vars.set((args[0] as string).replace(/^\$/, ""), value(args[1] ?? ""))
                break
            case "ClearErrors":
                errors = false
                break
            case "Delete": {
                const file = value(args[0] as string)
                if (fs.existsSync(file)) {
                    try {
                        input.fs.unlink(file)
                    } catch {
                        errors = true
                    }
                }
                break
            }
            case "RMDir": {
                if (args[0]?.startsWith("/")) throw new Error(`unsupported RMDir option: ${line}`)
                const dir = value(args[0] as string)
                try {
                    input.fs.rmdir(dir)
                } catch {
                    errors = true
                }
                break
            }
            case "MessageBox":
                if (args.some((a) => /^ID(YES|NO|OK|CANCEL)$/.test(a))) throw new Error(`unsupported jump: ${line}`)
                messages.push(value(args[args.length - 1] as string))
                break
            case "DetailPrint":
                messages.push(value(args[0] as string))
                break
            case "Abort":
                return { outcome: "aborted", abort: value(args[0] ?? ""), messages, executed }
            default:
                throw new Error(`unsupported NSIS instruction in the model: ${line}`)
        }
        if (input.crashAfter?.(line) === true) return { outcome: "crashed", abort: null, messages, executed }
    }
    return { outcome: "completed", abort: null, messages, executed }
}
