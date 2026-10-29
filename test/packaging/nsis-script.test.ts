/**
 * FR-MCP-04-BETA-02: static checks on installer/nsis/fluent-reader-mcp.nsi.
 * NSIS is not run (the owner compiles the installer): these tests pin the
 * properties of the script that matter for safety and privacy, and its
 * contract with the setup helper and the generated defines.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { HELPER_COMMANDS } from "../../installer/setup/fr-setup.js"

const SCRIPT = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "installer", "nsis", "fluent-reader-mcp.nsi"), "utf8")
const CODE = SCRIPT.split(/\r?\n/).filter((line) => !/^\s*;/.test(line)).join("\n")

describe("NSIS script", () => {
    test("NSIS 3 Unicode, Modern UI 2, per-user, no elevation", () => {
        for (const required of ["Unicode true", "RequestExecutionLevel user", '!include "MUI2.nsh"', 'InstallDir "$LOCALAPPDATA\\FluentReaderMCP"', "${IsNativeAMD64}", "${AtLeastWin10}"]) {
            assert.ok(CODE.includes(required), required)
        }
        assert.doesNotMatch(CODE, /\bHKLM\b|HKEY_LOCAL_MACHINE|\$PROGRAMFILES|\$WINDIR|\$SYSDIR|RequestExecutionLevel (admin|highest)|UAC/i)
    })

    test("no service, no shortcut, no network, no shell execution: only the bundled helper is started", () => {
        assert.doesNotMatch(CODE, /\bExecShell\b|\bExecWait\b|(^|\s)Exec\s|CreateShortCut|NSISdl|inetc|Services|sc\.exe|netsh|SimpleSC/im)
        const launches = CODE.split("\n").filter((line) => /nsExec::/.test(line))
        assert.deepEqual(launches.map((l) => l.trim()), [`nsExec::Exec '"\${NODE}" "\${SCRIPT}" \${COMMAND} "$PLUGINSDIR\\request.txt" "$PLUGINSDIR\\result.txt"'`], "user values never reach a command line")
    })

    test("pages in the required order", () => {
        const pages = [...CODE.matchAll(/^(?:!insertmacro (MUI_PAGE_\w+)|Page custom (\w+))/gm)].map((m) => m[1] ?? m[2])
        assert.deepEqual(pages, ["MUI_PAGE_WELCOME", "MUI_PAGE_DIRECTORY", "ProfilePageShow", "PrivacyPageShow", "ClaudePageShow", "PreviewPageShow", "MUI_PAGE_INSTFILES", "MUI_PAGE_FINISH"])
    })

    test("every helper command used exists in the helper; registration only with consent and the approved plan", () => {
        const used = new Set([...CODE.matchAll(/RunHelper(?:With "[^"]*" "[^"]*")? "([a-z-]+)"/g)].map((m) => m[1] as string))
        for (const command of used) assert.ok(HELPER_COMMANDS.includes(command), command)
        assert.ok(used.has("remove-tree") && used.has("unregister") && used.has("register") && used.has("plan"))
        const register = CODE.slice(CODE.indexOf('RunHelper "register"') - 900, CODE.indexOf('RunHelper "register"'))
        for (const key of ['"consent" "yes"', '"planHash" "$PlanHash"', '"replaceForeign" "$ReplaceForeign"']) assert.ok(register.includes(key), key)
        assert.match(CODE, /\$\{If\} \$ConfigureClaude == "1"\s+DetailPrint "Registrazione in Claude Code/)
    })

    test("the generated defines are exactly those the builder writes", () => {
        const used = new Set([...CODE.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1] as string))
        const local = new Set([...CODE.matchAll(/^!define (\w+)/gm)].map((m) => m[1] as string))
        const fromHeaders = ["IsNativeAMD64", "AtLeastWin10", "Silent", "If", "IfNot", "ElseIf", "Else", "EndIf", "AndIf", "OrIf", "Errors", "FileExists", "GetSize", "BST_CHECKED", "EM_SETREADONLY", "EM_SETSEL", "EM_REPLACESEL", "DEFAULT_STYLES", "WS_TABSTOP", "WS_VSCROLL", "ES_MULTILINE", "ES_READONLY", "ES_AUTOVSCROLL", "WS_EX_CLIENTEDGE", "LANG_ITALIAN", "NODE", "SCRIPT", "COMMAND", "KEY", "VALUE", "TREE", "ID", "NAME", "TYPE", "REL", "UN"]
        const generated = [...used].filter((name) => !local.has(name) && !fromHeaders.includes(name)).sort()
        assert.deepEqual(generated, ["BUNDLE_SHA256", "MAX_RELATIVE", "NODE_VERSION", "OUTFILE", "PAYLOAD_DIR", "PRODUCT_NAME", "PRODUCT_VERSION", "SETUP_ENTRY"])
    })

    const MAIN = CODE.slice(CODE.indexOf('Section "Fluent Reader MCP"'), CODE.indexOf("SectionEnd", CODE.indexOf('Section "Fluent Reader MCP"')))
    const inOrder = (text: string, markers: readonly string[]): void => {
        let at = -1
        for (const marker of markers) {
            const next = text.indexOf(marker, at + 1)
            assert.ok(next > at, `in order: ${marker}`)
            at = next
        }
    }

    test("installation: recovery first, journal before .staging, uninstaller written aside, HKCU saved before the swap, commit before cleanup", () => {
        inOrder(MAIN, [
            "!insertmacro TxRecover", 'RunHelper "tx-begin"', 'File "${PAYLOAD_DIR}\\installer-files.json"', 'File /r "${PAYLOAD_DIR}\\*"', '"selfTest" "yes"',
            'WriteUninstaller "$INSTDIR\\state\\uninstall.exe.new"', "RegBackupPut 9", 'RunHelper "tx-prepare"', 'RunHelper "tx-swap"', 'RunHelper "tx-metadata"',
            'RegWrite "${SETTINGS_KEY}"', 'RunHelper "tx-commit"', 'RunHelper "tx-cleanup"', 'RunHelper "register"', "install_rollback:",
        ])
        const beforeCommit = MAIN.slice(0, MAIN.indexOf('RunHelper "tx-commit"'))
        assert.equal(beforeCommit.includes("$FinishText"), false, "nothing is declared installed before the commit")
        assert.doesNotMatch(MAIN, /\bRename\b|\bRMDir\b|\bDeleteRegKey\b|\bDelete\b/, "no direct rename, delete or key removal in the install section: only the journal-driven helper")
        assert.doesNotMatch(MAIN, /RemoveOwnTree/, "no tree is removed by name during the installation")
    })

    test("every failure after tx-begin goes to the rollback, which is the recovery; success is never declared there", () => {
        const region = MAIN.slice(MAIN.indexOf('RunHelper "tx-begin"'), MAIN.indexOf('RunHelper "tx-cleanup"'))
        const lines = region.split("\n")
        const checks = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => /^\$\{(If|IfNot)\} (\$HelperExit != "0"|\$\{Errors\}|\$\{FileExists\} "\$INSTDIR\\state\\uninstall\.exe\.new")$/.test(l))
        assert.ok(checks.length >= 7, `failure checks: ${checks.length}`)
        for (const [line, i] of checks.slice(1)) assert.match(lines.slice(i, i + 5).join("\n"), /Goto install_rollback/, `${line} (line ${i})`)
        const writes = CODE.slice(CODE.indexOf("!macro RegWrite"), CODE.indexOf("!macroend", CODE.indexOf("!macro RegWrite")))
        assert.equal(writes.match(/Goto install_rollback/g)?.length, 2, "write error and read-back mismatch")
        const rollback = MAIN.slice(MAIN.indexOf("install_rollback:"), MAIN.indexOf("install_done:"))
        assert.match(rollback, /^install_rollback:\s+DetailPrint [^\n]+\s+!insertmacro TxRecover\s+\$\{If\} \$0 == "ok"/)
        assert.equal(rollback.match(/^\s*Abort /gm)?.length, 2, "both outcomes abort")
        assert.match(rollback, /ripristino INCOMPLETO/)
        assert.equal(rollback.includes("$FinishText"), false)
    })

    test("HKCU: type and presence read through advapi32 (64-bit view), each type restored with its own instruction, keys removed only if empty", () => {
        const type = CODE.slice(CODE.indexOf("!macro RegValueType"), CODE.indexOf("!macroend", CODE.indexOf("!macro RegValueType")))
        assert.match(type, /RegOpenKeyExW\(p 0x80000001, w "\$\{KEY\}", i 0, i 0x20119,/, "HKCU, KEY_READ | KEY_WOW64_64KEY")
        assert.match(type, /RegQueryValueExW\(p r6, w "\$\{NAME\}", p 0, \*i \.r8, p 0, \*i \.r9\)/)
        assert.match(type, /\$8 == 1\s+StrCpy \$5 "REG_SZ"[\s\S]*\$8 == 2\s+StrCpy \$5 "REG_EXPAND_SZ"[\s\S]*\$8 == 4\s+StrCpy \$5 "REG_DWORD"[\s\S]*StrCpy \$5 "TYPE_\$8"/)
        assert.match(type, /StrCpy \$5 "TOO_LONG"/)
        assert.match(type, /\$\{ElseIf\} \$7 != 2\s+StrCpy \$5 "ERROR_\$7"/, "an error is not taken for an absent value")
        const restore = CODE.slice(CODE.indexOf("!macro RegApplyRestore"), CODE.indexOf("!macroend", CODE.indexOf("!macro RegApplyRestore")))
        assert.match(restore, /"REG_SZ"\s+WriteRegStr[\s\S]*"REG_EXPAND_SZ"\s+WriteRegExpandStr[\s\S]*"REG_DWORD"\s+WriteRegDWORD[\s\S]*\$\{Else\}\s+SetErrors/)
        assert.match(restore, /\$\{If\} \$5 != "absent"\s+ClearErrors\s+DeleteRegValue/, "a value is deleted only if present")
        const keyRestore = CODE.slice(CODE.indexOf("!macro RegKeyApplyRestore"), CODE.indexOf("!macroend", CODE.indexOf("!macro RegKeyApplyRestore")))
        assert.match(keyRestore, /\$\{If\} \$6 == "yes"\s+!insertmacro RegDeleteKeyIfEmpty "\$\{KEY\}"\s+\$\{If\} \$5 == "error"\s+StrCpy \$RestoreOk "0"/)
        assert.equal(CODE.match(/DeleteRegKey /g)?.length, 1, "DeleteRegKey appears once, inside RegDeleteKeyIfEmpty")
        assert.doesNotMatch(CODE, /DeleteRegKey (?!\/ifempty)/, "never a whole key")
    })

    test("RegDeleteKeyIfEmpty distinguishes absent, deleted, kept (others' values or subkeys) and error, and verifies the result (Minor)", () => {
        const m = CODE.slice(CODE.indexOf("!macro RegDeleteKeyIfEmpty"), CODE.indexOf("!macroend", CODE.indexOf("!macro RegDeleteKeyIfEmpty")))
        assert.match(m, /^!macro RegDeleteKeyIfEmpty KEY\s+StrCpy \$5 "absent"/)
        assert.match(m, /RegQueryInfoKeyW\(p r6, p 0, p 0, p 0, \*i \.r8, p 0, p 0, \*i \.r9, p 0, p 0, p 0, p 0\) i \.r7/, "subkey and value counts")
        assert.match(m, /\$\{If\} \$7 != 0\s+StrCpy \$5 "error"\s+\$\{ElseIf\} \$8 != 0\s+\$\{OrIf\} \$9 != 0\s+StrCpy \$5 "kept"/)
        assert.match(m, /DeleteRegKey \/ifempty HKCU "\$\{KEY\}"\s+System::Call 'advapi32::RegOpenKeyExW[^\n]+\s+\$\{If\} \$7 == 2\s+StrCpy \$5 "deleted"\s+\$\{Else\}[\s\S]*StrCpy \$5 "error"/, "the key is opened again: gone = deleted, still there = error")
        const uninstall = CODE.slice(CODE.indexOf('Section "Uninstall"'))
        for (const key of ["UNINSTALL_KEY", "SETTINGS_KEY"]) assert.match(uninstall, new RegExp(`RegDeleteKeyIfEmpty "\\$\\{${key}\\}"\\s+\\$\\{If\\} \\$5 == "error"\\s+StrCpy \\$RegFail "1"`), key)
        assert.match(uninstall, /\$\{If\} \$RegFail != "0"\s+MessageBox[^\n]+\s+Abort/)
    })

    test("RegBackupPut: a REG_SZ or REG_EXPAND_SZ with CR or LF is reported as MULTILINE, never sent (Major 4)", () => {
        const m = CODE.slice(CODE.indexOf("!macro RegBackupPut"), CODE.indexOf("!macroend", CODE.indexOf("!macro RegBackupPut")))
        assert.match(m, /ReadRegStr \$6 HKCU "\$\{KEY\}" "\$\{NAME\}"\s+StrLen \$7 \$6\s+StrCpy \$8 0\s+\$\{While\} \$8 < \$7\s+StrCpy \$9 \$6 1 \$8\s+\$\{If\} \$9 == "\$\\r"\s+\$\{OrIf\} \$9 == "\$\\n"\s+StrCpy \$5 "MULTILINE"\s+StrCpy \$6 ""/)
        assert.ok(m.indexOf('StrCpy $5 "MULTILINE"') < m.indexOf('RequestPut "reg${ID}.type" "$5"'), "the type is sent after the check")
        assert.ok(m.indexOf("${EndWhile}") < m.indexOf('RequestPut "reg${ID}.value" "$6"'), "the value is sent only after the check")
    })

    test("uninstallation removes only its own entries: no recursive delete, profile, backups and other MCP untouched", () => {
        assert.doesNotMatch(CODE, /RMDir \/r|Delete \/REBOOTOK|\$APPDATA/i)
        const fileOperations = CODE.split("\n").filter((line) => /^\s*(Delete|RMDir|Rename|CopyFiles|FileOpen|File|SetOutPath|CreateDirectory|WriteUninstaller)\b/.test(line))
        for (const line of fileOperations) assert.doesNotMatch(line, /\.claude|fluent-reader\.db|config\.json|ProfileDir|ClaudeExe/i, line)
        const uninstall = CODE.slice(CODE.indexOf('Section "Uninstall"'))
        assert.deepEqual([...uninstall.matchAll(/^\s*(Delete|RMDir|DeleteRegKey)\s+(.*)$/gm)].map((m) => `${m[1] as string} ${m[2] as string}`), [
            'RMDir "$INSTDIR\\state\\uninstall-helper"',
            'Delete "$INSTDIR\\state\\uninstall.json"',
            'Delete "$INSTDIR\\state\\uninstall-final.marker"',
            'Delete "$INSTDIR\\uninstall.exe"',
            'RMDir "$INSTDIR\\state"',
            'RMDir "$INSTDIR"',
        ])
        const copyMacros = CODE.slice(CODE.indexOf("!macro DeleteHelperCopyFile"), CODE.indexOf("Function un.FinalMarkerValid"))
        assert.match(copyMacros, /Delete "\$INSTDIR\\state\\uninstall-helper\\\$\{REL\}"\s+\$\{If\} \$\{Errors\}\s+StrCpy \$CleanFail "1"/)
        assert.match(copyMacros, /ClearErrors\s+RMDir "\$INSTDIR\\state\\uninstall-helper\\\$\{REL\}"\s+\$\{If\} \$\{Errors\}\s+\$\{OrIf\} \$\{FileExists\} "\$INSTDIR\\state\\uninstall-helper\\\$\{REL\}\\\*"\s+StrCpy \$CleanFail "1"/, "every RMDir of the copy is checked")
        assert.match(CODE, /!define UNINSTALL_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\$\{PRODUCT_KEY\}"/)
    })

    test("uninstallation is resumable: final marker checked first (never next to a record), helper from the verified copy, no helper after un-finish", () => {
        const init = CODE.slice(CODE.indexOf("Function un.onInit"), CODE.indexOf("FunctionEnd", CODE.indexOf("Function un.onInit")))
        assert.match(init, /\$\{IfNot\} \$\{FileExists\} "\$INSTDIR\\\$\{RECORD_NAME\}"\s+\$\{AndIfNot\} \$\{FileExists\} "\$INSTDIR\\state\\uninstall\.json"\s+\$\{AndIfNot\} \$\{FileExists\} "\$INSTDIR\\state\\uninstall-final\.marker"/)
        const uninstall = CODE.slice(CODE.indexOf('Section "Uninstall"'))
        assert.match(uninstall, /^Section "Uninstall"\s+!define UN "un\."\s+\$\{If\} \$\{FileExists\} "\$INSTDIR\\state\\uninstall-final\.marker"\s+\$\{If\} \$\{FileExists\} "\$INSTDIR\\\$\{RECORD_NAME\}"\s+MessageBox[^\n]+\s+Abort[^\n]+\s+\$\{EndIf\}\s+Call un\.FinalMarkerValid\s+\$\{If\} \$0 != "ok"\s+MessageBox[^\n]+\s+Abort[^\n]+\s+\$\{EndIf\}\s+Goto uninstall_last/)
        inOrder(uninstall, [
            '"$INSTDIR\\state\\uninstall-helper\\${SETUP_ENTRY}"', 'StrCpy $HelperSource "$INSTDIR\\current"',
            'RunHelper "un-status"', '$UnPhase == "metadata"\n    Goto uninstall_metadata', 'RunHelper "uninstall-preflight"', 'RunHelper "unregister"', 'RunHelper "un-begin"',
            '"$HelperScript" "current"', "uninstall_metadata:", 'RunHelper "un-metadata"', "RegDeleteOwn", 'RunHelper "un-finish"',
            "uninstall_last:", "!insertmacro HelperCopyDelete", 'Delete "$INSTDIR\\state\\uninstall.json"', 'Delete "$INSTDIR\\state\\uninstall-final.marker"', 'Delete "$INSTDIR\\uninstall.exe"',
        ])
        assert.doesNotMatch(uninstall.slice(uninstall.indexOf("uninstall_last:")), /RunHelper|\$HelperNode|\$HelperScript/, "after the final marker nothing needs the helper")
        for (const step of ['RunHelper "un-status"', 'RunHelper "uninstall-preflight"', 'RunHelper "un-begin"', 'RunHelper "un-metadata"', 'RunHelper "un-finish"']) {
            assert.match(uninstall.slice(uninstall.indexOf(step)), /^RunHelper "[a-z-]+"\s+\$\{If\} \$HelperExit != "0"\s+Call un\.ShowHelperMessage\s+Abort/, `${step} stops on failure`)
        }
        assert.match(uninstall, /!insertmacro HelperCopyDelete\s+\$\{If\} \$\{FileExists\} "\$INSTDIR\\state\\uninstall-helper\\\*"\s+ClearErrors\s+RMDir "\$INSTDIR\\state\\uninstall-helper"\s+\$\{If\} \$\{Errors\}\s+\$\{OrIf\} \$\{FileExists\} "\$INSTDIR\\state\\uninstall-helper\\\*"\s+StrCpy \$CleanFail "1"\s+\$\{EndIf\}\s+\$\{EndIf\}\s+\$\{If\} \$CleanFail != "0"\s+MessageBox[^\n]+\s+Abort/)
        // the final marker goes before the uninstaller, and its failure stops with both still there
        assert.match(uninstall, /Delete "\$INSTDIR\\state\\uninstall-final\.marker"\s+\$\{If\} \$\{Errors\}\s+\$\{OrIf\} \$\{FileExists\} "\$INSTDIR\\state\\uninstall-final\.marker"\s+MessageBox[^\n]+\s+Abort[^\n]+\s+\$\{EndIf\}\s+ClearErrors\s+Delete "\$INSTDIR\\uninstall\.exe"/)
        const last = uninstall.slice(uninstall.indexOf('Delete "$INSTDIR\\uninstall.exe"'))
        assert.doesNotMatch(last.slice(0, last.indexOf("!undef UN")), /Abort|uninstall-final\.marker|uninstall\.json|uninstall-helper/, "after the uninstaller nothing of the uninstall state is left to remove")
        const valid = CODE.slice(CODE.indexOf("Function un.FinalMarkerValid"), CODE.indexOf("FunctionEnd", CODE.indexOf("Function un.FinalMarkerValid")))
        for (const line of ['StrCmpS $5 "product=fluent-reader-mcp"', 'StrCmpS $5 "kind=uninstall-final"', 'StrCmp $5 "installDir=$INSTDIR"']) assert.ok(valid.includes(line), line)
        assert.match(CODE, /^!include "defines\.nsh"\s+!include "helper-files\.nsh"/m)
    })

    test("a new setup completes a pending uninstallation only when offered (pendingUninstall), with consent, once, through finish-uninstall", () => {
        const leave = CODE.slice(CODE.indexOf("Function DirectoryLeave"), CODE.indexOf("FunctionEnd", CODE.indexOf("Function DirectoryLeave")))
        assert.match(leave, /directory_check:\s+!insertmacro RequestBegin[\s\S]*RunHelper "check-install-dir"\s+\$\{If\} \$HelperExit != "0"\s+Push "pendingUninstall"\s+Call ResultGet\s+Pop \$0\s+\$\{If\} \$0 == "yes"\s+\$\{AndIf\} \$R6 == "0"/)
        assert.match(leave, /MessageBox MB_ICONQUESTION\|MB_YESNO "[^"]+" IDNO directory_refused\s+StrCpy \$R6 "1"[\s\S]*RunHelper "finish-uninstall"\s+\$\{If\} \$HelperExit == "0"\s+Goto directory_check\s+\$\{EndIf\}\s+Call ShowHelperMessage\s+Abort/)
        assert.match(leave, /directory_refused:\s+Abort/)
    })

    test("leaving the Claude Code entry: the consequences are explained and No is the default (Minor)", () => {
        const uninstall = CODE.slice(CODE.indexOf('Section "Uninstall"'))
        const box = /MessageBox MB_ICONQUESTION\|MB_YESNO\|MB_DEFBUTTON2 "([^\n]*)" IDYES claude_left\s+Abort "Disinstallazione interrotta: nulla è stato rimosso\."/.exec(uninstall)
        assert.ok(box !== null, "Yes/No with No as default; No aborts with nothing removed")
        const text = box[1] as string
        for (const fact of ["NON viene rimossa da Claude Code", "il server installato viene rimosso", "punterà a file che non esistono più e non funzionerà", "Claude Code non sarà stato ripulito completamente", "Scegli No (consigliato)"]) assert.ok(text.includes(fact), fact)
    })

    test("remove-tree requests name the installation and the tree, never a path (Major 5)", () => {
        const macro = CODE.slice(CODE.indexOf("!macro RemoveOwnTree"), CODE.indexOf("!macroend", CODE.indexOf("!macro RemoveOwnTree")))
        assert.match(macro, /RequestPut "installDir" "\$INSTDIR"\s+!insertmacro RequestPut "tree" "\$\{TREE\}"/)
        assert.doesNotMatch(macro, /"root"/)
        for (const m of CODE.matchAll(/RemoveOwnTree "[^"]*" "[^"]*" "([^"]*)"/g)) assert.ok(["current", ".staging", "previous"].includes(m[1] as string), m[0])
    })

    test("the wizard states the privacy facts and the beta limits", () => {
        for (const fact of ["sola lettura", "non effettua richieste di rete proprie", "servizio Anthropic", "otto strumenti", "la ricerca degli articoli non è ancora disponibile", "Nessun servizio Windows", "Claude Desktop va configurato a mano", "questo installer non lo registra"]) {
            assert.ok(SCRIPT.includes(fact), fact)
        }
        assert.match(SCRIPT, /non cerca profili da solo/)
        assert.doesNotMatch(SCRIPT, /LogSet|LogText/, "no setup log file")
    })
})
