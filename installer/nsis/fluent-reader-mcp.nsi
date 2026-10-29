; FR-MCP-04-BETA-02 — Fluent Reader MCP, per-user installer for Windows x64.
; NSIS 3 Unicode, Modern UI 2. Compiled ONLY through installer/lib/installer-build.ts
; (npm.cmd run installer:win), which verifies the portable bundle, prepares the payload
; and generates defines.nsh; see installer/INSTALLER.md.
;
; The wizard holds no installation logic of its own: every check and every change is made
; by the setup helper (current\setup\installer\setup\fr-setup.js) run by the BUNDLED
; node.exe. Values chosen by the user travel in a UTF-16LE request file, never on a command
; line; the helper answers in a result file. No service, no port, no resident process,
; no HKLM, no Program Files, no elevation.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
; Not solid: the helper's node.exe is extracted on its own before the installation pages.
SetCompressor lzma
SetDatablockOptimize on

!include "defines.nsh"
; generated: the files of the uninstaller's recovery copy of the helper
!include "helper-files.nsh"
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"

!define PRODUCT_KEY "FluentReaderMCP"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}"
!define SETTINGS_KEY "Software\${PRODUCT_KEY}"
!define RECORD_NAME "fluent-reader-mcp.install.json"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION} beta"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\FluentReaderMCP"
InstallDirRegKey HKCU "${SETTINGS_KEY}" "InstallDir"
ShowInstDetails show
ShowUninstDetails show
BrandingText "${PRODUCT_NAME} ${PRODUCT_VERSION} - beta privata"

Var HelperNode
Var HelperScript
Var HelperExit
Var Mode
Var InstalledVersion
Var ProfileDir
Var ConfigureClaude
Var ClaudeExe
Var ClaudeVersion
Var PlanHash
Var PlanAction
Var ReplaceForeign
Var FinishText
Var Dialog
Var ProfileText
Var ConfirmProfile
Var RadioClaude
Var RadioServerOnly
Var ClaudeText
Var ConsentClaude
Var PreviewText
Var ReplaceCheck

; ---------------------------------------------------------------- pages

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${PRODUCT_NAME} ${PRODUCT_VERSION} (beta privata)"
!define MUI_WELCOMEPAGE_TEXT "Questo programma installa Fluent Reader MCP, un server MCP in SOLA LETTURA che permette a Claude Code di consultare un tuo profilo locale di Fluent Reader.$\r$\n$\r$\nLa beta offre sette strumenti di sola lettura (fonti, gruppi, regole e singoli articoli). Include il proprio runtime Node.js: non serve installare altro.$\r$\n$\r$\nNon vengono installati servizi, porte di rete o processi residenti. Puoi scegliere se registrare il server in Claude Code: prima vedrai un'anteprima esatta della modifica."
!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "Cartella proposta: %LOCALAPPDATA%\FluentReaderMCP. Puoi sceglierne un'altra purché sia dentro la tua cartella utente, fuori da OneDrive e dalla cartella Roaming, e vuota (oppure una precedente installazione di Fluent Reader MCP)."
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryLeave
!insertmacro MUI_PAGE_DIRECTORY
Page custom ProfilePageShow ProfilePageLeave
Page custom PrivacyPageShow PrivacyPageLeave
Page custom ClaudePageShow ClaudePageLeave
Page custom PreviewPageShow PreviewPageLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Fluent Reader MCP"
!define MUI_FINISHPAGE_TEXT "$FinishText"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Italian"

VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=${LANG_ITALIAN} "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=${LANG_ITALIAN} "ProductVersion" "${PRODUCT_VERSION} beta"
VIAddVersionKey /LANG=${LANG_ITALIAN} "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=${LANG_ITALIAN} "FileDescription" "${PRODUCT_NAME} - installer per l'utente corrente (beta privata)"
VIAddVersionKey /LANG=${LANG_ITALIAN} "Comments" "Bundle SHA-256 ${BUNDLE_SHA256}"
VIAddVersionKey /LANG=${LANG_ITALIAN} "LegalCopyright" "Beta privata, non distribuire"

; ---------------------------------------------------------------- helper protocol

; Request file: UTF-16LE with BOM, one key=value per line, in $PLUGINSDIR.
!macro RequestBegin
  FileOpen $R9 "$PLUGINSDIR\request.txt" w
  FileWriteUTF16LE /BOM $R9 ""
!macroend
!macro RequestPut KEY VALUE
  FileWriteUTF16LE $R9 "${KEY}=${VALUE}$\r$\n"
!macroend
!macro RequestEnd
  FileClose $R9
!macroend

; Runs a helper command with the given node.exe and script; exit code in $HelperExit
; (0 ok, 1 refused, 2 internal error, or nsExec's "error"/"timeout").
!macro RunHelperWith NODE SCRIPT COMMAND
  Delete "$PLUGINSDIR\result.txt"
  nsExec::Exec '"${NODE}" "${SCRIPT}" ${COMMAND} "$PLUGINSDIR\request.txt" "$PLUGINSDIR\result.txt"'
  Pop $HelperExit
!macroend
!macro RunHelper COMMAND
  !insertmacro RunHelperWith "$HelperNode" "$HelperScript" "${COMMAND}"
!macroend

; Push KEY, Call ResultGet, Pop value: the values of KEY in the result file, joined by CRLF.
!macro ResultGetBody
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrCpy $R4 ""
  StrCpy $R0 "$R0="
  StrLen $R3 $R0
  ClearErrors
  FileOpen $R1 "$PLUGINSDIR\result.txt" r
  IfErrors result_done
  result_loop:
    ClearErrors
    FileReadUTF16LE $R1 $R2
    IfErrors result_close
    StrCpy $R5 $R2 1 -1
    StrCmp $R5 "$\n" 0 +2
      StrCpy $R2 $R2 -1
    StrCpy $R5 $R2 1 -1
    StrCmp $R5 "$\r" 0 +2
      StrCpy $R2 $R2 -1
    StrCpy $R5 $R2 $R3
    StrCmpS $R5 $R0 0 result_loop
    StrCpy $R5 $R2 "" $R3
    StrCmp $R4 "" 0 +3
      StrCpy $R4 $R5
      Goto result_loop
    StrCpy $R4 "$R4$\r$\n$R5"
    Goto result_loop
  result_close:
    FileClose $R1
  result_done:
  StrCpy $R0 $R4
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
!macroend
Function ResultGet
  !insertmacro ResultGetBody
FunctionEnd
Function un.ResultGet
  !insertmacro ResultGetBody
FunctionEnd

!macro HelperMessageBody
  Push "message"
  Call ${UN}ResultGet
  Pop $R0
  ${If} $R0 == ""
    StrCpy $R0 "Il programma di supporto del setup non ha risposto (codice $HelperExit). Nessuna modifica è stata fatta in questo passaggio."
  ${EndIf}
  MessageBox MB_ICONEXCLAMATION|MB_OK "$R0"
!macroend
Function ShowHelperMessage
  !define UN ""
  !insertmacro HelperMessageBody
  !undef UN
FunctionEnd
Function un.ShowHelperMessage
  !define UN "un."
  !insertmacro HelperMessageBody
  !undef UN
FunctionEnd

; The helper used before the installation (directory, profile, Claude checks):
; the payload's own node.exe and setup helper, extracted to $PLUGINSDIR (deleted at exit).
Function EnsureHelper
  ${If} $HelperNode == ""
    SetOutPath "$PLUGINSDIR\helper"
    File "/oname=$PLUGINSDIR\helper\node.exe" "${PAYLOAD_DIR}\app\runtime\node.exe"
    ; the payload's inventory: removes a .staging whose extraction stopped before its own inventory
    File "/oname=$PLUGINSDIR\helper\installer-files.json" "${PAYLOAD_DIR}\installer-files.json"
    SetOutPath "$PLUGINSDIR\helper\setup"
    File /r "${PAYLOAD_DIR}\setup\*"
    SetOutPath "$PLUGINSDIR"
    StrCpy $HelperNode "$PLUGINSDIR\helper\node.exe"
    StrCpy $HelperScript "$PLUGINSDIR\helper\${SETUP_ENTRY}"
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- init

Function .onInit
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_ICONSTOP|MB_OK "Fluent Reader MCP richiede Windows x64."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP|MB_OK "Fluent Reader MCP richiede Windows 10 o 11 (x64)."
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "FluentReaderMCP-Setup") p .r1 ?e'
  Pop $0
  ${If} $0 == 183
    MessageBox MB_ICONEXCLAMATION|MB_OK "Il setup di Fluent Reader MCP è già in esecuzione."
    Abort
  ${EndIf}
  SetRegView 64
  InitPluginsDir
  StrCpy $ConfigureClaude "1"
  StrCpy $ReplaceForeign "no"
FunctionEnd

; ---------------------------------------------------------------- directory

Function DirectoryLeave
  Call EnsureHelper
  StrCpy $R6 "0"
  directory_check:
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestPut "version" "${PRODUCT_VERSION}"
  !insertmacro RequestPut "maxRelative" "${MAX_RELATIVE}"
  !insertmacro RequestEnd
  !insertmacro RunHelper "check-install-dir"
  ${If} $HelperExit != "0"
    ; the last steps of an earlier uninstallation are left and its uninstaller is gone: offered, never automatic
    Push "pendingUninstall"
    Call ResultGet
    Pop $0
    ${If} $0 == "yes"
    ${AndIf} $R6 == "0"
      Call ShowHelperMessage
      MessageBox MB_ICONQUESTION|MB_YESNO "Completare ora la disinstallazione precedente? Vengono rimossi soltanto i file che quella disinstallazione ha elencato nel suo marcatore finale; qualsiasi altro file ferma l'operazione." IDNO directory_refused
      StrCpy $R6 "1"
      !insertmacro RequestBegin
      !insertmacro RequestPut "installDir" "$INSTDIR"
      !insertmacro RequestEnd
      !insertmacro RunHelper "finish-uninstall"
      ${If} $HelperExit == "0"
        Goto directory_check
      ${EndIf}
      Call ShowHelperMessage
      Abort
    ${EndIf}
    Call ShowHelperMessage
    directory_refused:
    Abort
  ${EndIf}
  Push "canonical"
  Call ResultGet
  Pop $INSTDIR
  Push "mode"
  Call ResultGet
  Pop $Mode
  Push "installedVersion"
  Call ResultGet
  Pop $InstalledVersion
  Push "previousProfile"
  Call ResultGet
  Pop $0
  ${If} $ProfileDir == ""
    StrCpy $ProfileDir $0
  ${EndIf}
  ${If} $Mode == "upgrade"
    MessageBox MB_ICONQUESTION|MB_OKCANCEL "In questa cartella è installata la versione $InstalledVersion: verrà aggiornata alla ${PRODUCT_VERSION}. Se l'aggiornamento non riesce, la versione attuale resta com'è." IDOK +2
    Abort
  ${ElseIf} $Mode == "repair"
    MessageBox MB_ICONQUESTION|MB_OKCANCEL "La versione ${PRODUCT_VERSION} è già installata in questa cartella: i suoi file verranno reinstallati (riparazione). I tuoi dati non vengono toccati." IDOK +2
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- profile

Function ProfilePageShow
  !insertmacro MUI_HEADER_TEXT "Profilo Fluent Reader" "Scegli la cartella del profilo da consultare in sola lettura"
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 52u "Indica la cartella del profilo di Fluent Reader: deve contenere config.json e fluent-reader.db.$\r$\n$\r$\nIl setup non cerca profili da solo. Controlla soltanto la cartella che scegli (tipo dei due file), senza leggere articoli, feed o credenziali e senza modificarla."
  Pop $0
  ${NSD_CreateText} 0 58u 76% 12u "$ProfileDir"
  Pop $ProfileText
  ${NSD_CreateButton} 78% 57u 22% 14u "Sfoglia..."
  Pop $0
  ${NSD_OnClick} $0 ProfileBrowse
  nsDialogs::Show
FunctionEnd

Function ProfileBrowse
  Pop $0
  ${NSD_GetText} $ProfileText $0
  nsDialogs::SelectFolderDialog "Cartella del profilo Fluent Reader" "$0"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $ProfileText "$0"
  ${EndIf}
FunctionEnd

Function ProfilePageLeave
  ${NSD_GetText} $ProfileText $0
  ${If} $0 == ""
    MessageBox MB_ICONINFORMATION|MB_OK "Scegli la cartella del profilo di Fluent Reader."
    Abort
  ${EndIf}
  !insertmacro RequestBegin
  !insertmacro RequestPut "profileDir" "$0"
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "check-profile"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    Abort
  ${EndIf}
  Push "canonical"
  Call ResultGet
  Pop $ProfileDir
FunctionEnd

; ---------------------------------------------------------------- summary and privacy

Function PrivacyPageShow
  !insertmacro MUI_HEADER_TEXT "Riepilogo e privacy" "Conferma il profilo e l'informativa della beta"
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 10u "Profilo scelto:"
  Pop $0
  ${NSD_CreateText} 0 11u 100% 12u "$ProfileDir"
  Pop $0
  SendMessage $0 ${EM_SETREADONLY} 1 0
  ${NSD_CreateLabel} 0 28u 100% 84u "- Fluent Reader MCP legge questo profilo in sola lettura: non modifica il database né la configurazione di Fluent Reader.$\r$\n- Il server non effettua richieste di rete proprie e non resta in esecuzione: lo avvia Claude Code quando serve.$\r$\n- I risultati degli strumenti (per esempio titoli e testi degli articoli richiesti) possono essere inviati da Claude Code al servizio Anthropic come parte della conversazione.$\r$\n- La beta espone soltanto sette strumenti in sola lettura; ricerca e paginazione avanzata degli articoli non sono ancora disponibili.$\r$\n- Nessun servizio Windows viene installato."
  Pop $0
  ${NSD_CreateCheckbox} 0 116u 100% 12u "Confermo il profilo scelto e ho letto l'informativa"
  Pop $ConfirmProfile
  nsDialogs::Show
FunctionEnd

Function PrivacyPageLeave
  ${NSD_GetState} $ConfirmProfile $0
  ${If} $0 != ${BST_CHECKED}
    MessageBox MB_ICONINFORMATION|MB_OK "Per continuare conferma il profilo e l'informativa."
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- Claude Code

Function ClaudePageShow
  !insertmacro MUI_HEADER_TEXT "Claude Code" "Registrazione del server MCP (facoltativa, con anteprima)"
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  ${NSD_CreateRadioButton} 0 0 100% 12u "Registra Fluent Reader MCP in Claude Code (scope user)"
  Pop $RadioClaude
  ${NSD_CreateRadioButton} 0 13u 100% 12u "Installa solo il server: lo registrerò più tardi"
  Pop $RadioServerOnly
  ${If} $ConfigureClaude == "1"
    ${NSD_Check} $RadioClaude
  ${Else}
    ${NSD_Check} $RadioServerOnly
  ${EndIf}
  ${NSD_CreateLabel} 0 31u 100% 20u "Percorso di claude.exe (CLI di Claude Code o binario dell'estensione VS Code). Claude Desktop non è supportato da questa beta."
  Pop $0
  ${NSD_CreateText} 0 53u 58% 12u "$ClaudeExe"
  Pop $ClaudeText
  ${NSD_CreateButton} 60% 52u 19% 14u "Sfoglia..."
  Pop $0
  ${NSD_OnClick} $0 ClaudeBrowse
  ${NSD_CreateButton} 81% 52u 19% 14u "Cerca"
  Pop $0
  ${NSD_OnClick} $0 ClaudeDetect
  ${NSD_CreateCheckbox} 0 74u 100% 24u "Autorizzo il setup a registrare il server $\"fluent-reader$\" nella mia configurazione utente di Claude Code, dopo aver visto l'anteprima nella pagina successiva."
  Pop $ConsentClaude
  ${NSD_CreateLabel} 0 102u 100% 30u "Se scegli di installare solo il server, Claude Code non viene modificato: potrai registrarlo eseguendo di nuovo questo setup."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function ClaudeBrowse
  Pop $0
  ${NSD_GetText} $ClaudeText $0
  nsDialogs::SelectFileDialog open "$0" "claude.exe|claude.exe|Programmi (*.exe)|*.exe"
  Pop $0
  ${If} $0 != ""
  ${AndIf} $0 != "error"
    ${NSD_SetText} $ClaudeText "$0"
  ${EndIf}
FunctionEnd

; Searches only when the user presses "Cerca": PATH, the native installer, the VS Code extension.
Function ClaudeDetect
  Pop $0
  !insertmacro RequestBegin
  !insertmacro RequestEnd
  !insertmacro RunHelper "detect-claude"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    Return
  ${EndIf}
  Push "claudeExe"
  Call ResultGet
  Pop $0
  Push "candidates"
  Call ResultGet
  Pop $1
  ${NSD_SetText} $ClaudeText "$0"
  MessageBox MB_ICONINFORMATION|MB_OK "Trovato: $0$\r$\n($1 candidati in tutto). Verifica che sia la Claude Code che usi; puoi sceglierne un'altra con Sfoglia."
FunctionEnd

Function ClaudePageLeave
  ${NSD_GetState} $RadioClaude $0
  ${If} $0 != ${BST_CHECKED}
    StrCpy $ConfigureClaude "0"
    Return
  ${EndIf}
  StrCpy $ConfigureClaude "1"
  ${NSD_GetText} $ClaudeText $ClaudeExe
  ${NSD_GetState} $ConsentClaude $0
  ${If} $0 != ${BST_CHECKED}
    MessageBox MB_ICONINFORMATION|MB_OK "Per registrare il server serve il tuo consenso (casella sotto). Altrimenti scegli $\"Installa solo il server$\"."
    Abort
  ${EndIf}
  ${If} $ClaudeExe == ""
    MessageBox MB_ICONINFORMATION|MB_OK "Indica claude.exe con Sfoglia o Cerca, oppure scegli $\"Installa solo il server$\"."
    Abort
  ${EndIf}
  !insertmacro RequestBegin
  !insertmacro RequestPut "claudeExe" "$ClaudeExe"
  !insertmacro RequestEnd
  !insertmacro RunHelper "check-claude"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    Abort
  ${EndIf}
  Push "version"
  Call ResultGet
  Pop $ClaudeVersion
FunctionEnd

; ---------------------------------------------------------------- preview

; Appends every "preview" line of the result file to the preview box (one line at a time:
; NSIS strings are limited to 1024 characters).
Function AppendPreview
  ClearErrors
  FileOpen $R1 "$PLUGINSDIR\result.txt" r
  IfErrors preview_done
  preview_loop:
    ClearErrors
    FileReadUTF16LE $R1 $R2
    IfErrors preview_close
    StrCpy $R3 $R2 8
    StrCmpS $R3 "preview=" 0 preview_loop
    StrCpy $R2 $R2 "" 8
    StrCpy $R3 $R2 1 -1
    StrCmp $R3 "$\n" 0 +2
      StrCpy $R2 $R2 -1
    StrCpy $R3 $R2 1 -1
    StrCmp $R3 "$\r" 0 +2
      StrCpy $R2 $R2 -1
    SendMessage $PreviewText ${EM_SETSEL} -1 -1
    SendMessage $PreviewText ${EM_REPLACESEL} 0 "STR:$R2$\r$\n"
    Goto preview_loop
  preview_close:
    FileClose $R1
  preview_done:
FunctionEnd

Function PreviewPageShow
  ${If} $ConfigureClaude != "1"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Anteprima delle modifiche a Claude Code" "Controlla esattamente che cosa verrà registrato"
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestPut "version" "${PRODUCT_VERSION}"
  !insertmacro RequestPut "maxRelative" "${MAX_RELATIVE}"
  !insertmacro RequestPut "claudeExe" "$ClaudeExe"
  !insertmacro RequestPut "profileDir" "$ProfileDir"
  !insertmacro RequestEnd
  !insertmacro RunHelper "plan"
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  ${If} $HelperExit != "0"
    StrCpy $PlanAction "error"
    Push "message"
    Call ResultGet
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 100u "La registrazione non è possibile:$\r$\n$\r$\n$0$\r$\n$\r$\nTorna indietro e scegli $\"Installa solo il server$\", oppure risolvi il problema e riprova."
    Pop $0
    nsDialogs::Show
    Return
  ${EndIf}
  Push "planHash"
  Call ResultGet
  Pop $PlanHash
  Push "action"
  Call ResultGet
  Pop $PlanAction
  nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 0 100% 108u ""
  Pop $PreviewText
  Call AppendPreview
  SendMessage $PreviewText ${EM_SETSEL} 0 0
  ${If} $PlanAction == "replace-foreign"
    ${NSD_CreateCheckbox} 0 112u 100% 20u "Sostituisci la voce $\"fluent-reader$\" esistente, che non è stata creata da questo installer"
    Pop $ReplaceCheck
  ${Else}
    ${NSD_CreateLabel} 0 114u 100% 20u "Premendo Installa autorizzi soltanto questa modifica. Se nel frattempo la configurazione cambia, la registrazione viene annullata."
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function PreviewPageLeave
  ${If} $PlanAction == "error"
    MessageBox MB_ICONINFORMATION|MB_OK "Torna indietro e scegli $\"Installa solo il server$\", oppure risolvi il problema indicato."
    Abort
  ${EndIf}
  StrCpy $ReplaceForeign "no"
  ${If} $PlanAction == "replace-foreign"
    ${NSD_GetState} $ReplaceCheck $0
    ${If} $0 != ${BST_CHECKED}
      MessageBox MB_ICONINFORMATION|MB_OK "La voce esistente non viene toccata senza la tua conferma: confermala, oppure torna indietro e scegli $\"Installa solo il server$\"."
      Abort
    ${EndIf}
    StrCpy $ReplaceForeign "yes"
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- installation

; The installation is a transaction kept by the helper in state\install-journal.json
; (installer\setup\transaction.ts): phases staging, prepared, swapping, metadata, committed.
; A failure, or a crash before the next start, is undone by the same recovery (tx-recover).
; NSIS does only what the helper cannot: WriteUninstaller and the HKCU values.

Var TxId
Var FailStep
Var RestoreOk
Var RegFail
Var EstimatedSize
Var HelperSource
Var UnPhase
Var CleanFail

; Removes one of this installer's own trees (current, .staging or previous of $INSTDIR) through
; the helper, which accepts nothing else and requires the installation record; $0 = "ok" or "fail".
!macro RemoveOwnTree NODE SCRIPT TREE
  StrCpy $0 "ok"
  ${If} ${FileExists} "$INSTDIR\${TREE}\*"
    !insertmacro RequestBegin
    !insertmacro RequestPut "installDir" "$INSTDIR"
    !insertmacro RequestPut "tree" "${TREE}"
    !insertmacro RequestEnd
    !insertmacro RunHelperWith "${NODE}" "${SCRIPT}" "remove-tree"
    ${If} $HelperExit != "0"
      StrCpy $0 "fail"
    ${EndIf}
  ${EndIf}
!macroend

; Type of HKCU\KEY\NAME in $5: REG_SZ, REG_EXPAND_SZ, REG_DWORD, absent, or a code the helper
; refuses (TYPE_n for another type, TOO_LONG, ERROR_n). Reads with KEY_WOW64_64KEY.
!macro RegValueType KEY NAME
  StrCpy $5 "absent"
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${KEY}", i 0, i 0x20119, *p .r6) i .r7'
  ${If} $7 == 0
    System::Call 'advapi32::RegQueryValueExW(p r6, w "${NAME}", p 0, *i .r8, p 0, *i .r9) i .r7'
    ${If} $7 == 0
      ${If} $8 == 1
        StrCpy $5 "REG_SZ"
      ${ElseIf} $8 == 2
        StrCpy $5 "REG_EXPAND_SZ"
      ${ElseIf} $8 == 4
        StrCpy $5 "REG_DWORD"
      ${Else}
        StrCpy $5 "TYPE_$8"
      ${EndIf}
      ${If} $9 > 2000
        StrCpy $5 "TOO_LONG"
      ${EndIf}
    ${ElseIf} $7 != 2
      StrCpy $5 "ERROR_$7"
    ${EndIf}
    System::Call 'advapi32::RegCloseKey(p r6)'
  ${ElseIf} $7 != 2
    StrCpy $5 "ERROR_$7"
  ${EndIf}
!macroend

; Whether HKCU\KEY exists, in $5: 1, 0, or an error code (refused by the helper).
!macro RegKeyExists KEY
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${KEY}", i 0, i 0x20119, *p .r6) i .r7'
  ${If} $7 == 0
    StrCpy $5 "1"
    System::Call 'advapi32::RegCloseKey(p r6)'
  ${ElseIf} $7 == 2
    StrCpy $5 "0"
  ${Else}
    StrCpy $5 "ERROR_$7"
  ${EndIf}
!macroend

; Puts the current state of one value (presence, type, value) into the tx-prepare request.
!macro RegBackupPut ID KEY NAME
  !insertmacro RegValueType "${KEY}" "${NAME}"
  ${If} $5 == "absent"
    !insertmacro RequestPut "reg${ID}.present" "0"
  ${Else}
    StrCpy $6 ""
    ${If} $5 == "REG_DWORD"
      ReadRegDWORD $6 HKCU "${KEY}" "${NAME}"
    ${ElseIf} $5 == "REG_SZ"
    ${OrIf} $5 == "REG_EXPAND_SZ"
      ReadRegStr $6 HKCU "${KEY}" "${NAME}"
      ; a CR or LF cannot travel in the key=value request: the value is reported as MULTILINE (the helper
      ; refuses it before the swap), never sent truncated or altered
      StrLen $7 $6
      StrCpy $8 0
      ${While} $8 < $7
        StrCpy $9 $6 1 $8
        ${If} $9 == "$\r"
        ${OrIf} $9 == "$\n"
          StrCpy $5 "MULTILINE"
          StrCpy $6 ""
          ${ExitWhile}
        ${EndIf}
        IntOp $8 $8 + 1
      ${EndWhile}
    ${EndIf}
    !insertmacro RequestPut "reg${ID}.present" "1"
    !insertmacro RequestPut "reg${ID}.type" "$5"
    !insertmacro RequestPut "reg${ID}.value" "$6"
  ${EndIf}
!macroend

; Removes HKCU\KEY only if it is empty, and checks the outcome; $5 = absent, deleted, kept (values or
; subkeys of others are in it: preserved, not an error) or error (it should have gone and did not).
!macro RegDeleteKeyIfEmpty KEY
  StrCpy $5 "absent"
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${KEY}", i 0, i 0x20119, *p .r6) i .r7'
  ${If} $7 == 0
    System::Call 'advapi32::RegQueryInfoKeyW(p r6, p 0, p 0, p 0, *i .r8, p 0, p 0, *i .r9, p 0, p 0, p 0, p 0) i .r7'
    System::Call 'advapi32::RegCloseKey(p r6)'
    ${If} $7 != 0
      StrCpy $5 "error"
    ${ElseIf} $8 != 0
    ${OrIf} $9 != 0
      StrCpy $5 "kept"
    ${Else}
      ClearErrors
      DeleteRegKey /ifempty HKCU "${KEY}"
      System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${KEY}", i 0, i 0x20119, *p .r6) i .r7'
      ${If} $7 == 2
        StrCpy $5 "deleted"
      ${Else}
        ${If} $7 == 0
          System::Call 'advapi32::RegCloseKey(p r6)'
        ${EndIf}
        StrCpy $5 "error"
      ${EndIf}
    ${EndIf}
  ${ElseIf} $7 != 2
    StrCpy $5 "error"
  ${EndIf}
!macroend

; Writes a value and reads it back; any difference is a failure of the installation.
!macro RegWrite KEY NAME TYPE VALUE
  ClearErrors
  WriteReg${TYPE} HKCU "${KEY}" "${NAME}" "${VALUE}"
  ${If} ${Errors}
    StrCpy $FailStep "scrittura del registro di Windows (${NAME})"
    Goto install_rollback
  ${EndIf}
  ClearErrors
  ReadReg${TYPE} $R8 HKCU "${KEY}" "${NAME}"
  ${If} ${Errors}
  ${OrIf} $R8 != "${VALUE}"
    StrCpy $FailStep "verifica del registro di Windows (${NAME})"
    Goto install_rollback
  ${EndIf}
!macroend

; Restores one value as the journal recorded it (instructions in the tx-recover result);
; $RestoreOk becomes 0 on any failure.
!macro RegApplyRestore ID KEY NAME
  Push "reg${ID}.action"
  Call ResultGet
  Pop $6
  ${If} $6 == "write"
    Push "reg${ID}.type"
    Call ResultGet
    Pop $7
    Push "reg${ID}.value"
    Call ResultGet
    Pop $8
    ClearErrors
    ${If} $7 == "REG_SZ"
      WriteRegStr HKCU "${KEY}" "${NAME}" "$8"
    ${ElseIf} $7 == "REG_EXPAND_SZ"
      WriteRegExpandStr HKCU "${KEY}" "${NAME}" "$8"
    ${ElseIf} $7 == "REG_DWORD"
      WriteRegDWORD HKCU "${KEY}" "${NAME}" "$8"
    ${Else}
      SetErrors
    ${EndIf}
    ${If} ${Errors}
      StrCpy $RestoreOk "0"
    ${EndIf}
  ${ElseIf} $6 == "delete"
    !insertmacro RegValueType "${KEY}" "${NAME}"
    ${If} $5 != "absent"
      ClearErrors
      DeleteRegValue HKCU "${KEY}" "${NAME}"
      ${If} ${Errors}
        StrCpy $RestoreOk "0"
      ${EndIf}
    ${EndIf}
  ${Else}
    StrCpy $RestoreOk "0"
  ${EndIf}
!macroend

; A key that did not exist before is removed only if nothing (values, subkeys) is left in it.
!macro RegKeyApplyRestore ID KEY
  Push "key.${ID}.deleteIfEmpty"
  Call ResultGet
  Pop $6
  ${If} $6 == "yes"
    !insertmacro RegDeleteKeyIfEmpty "${KEY}"
    ${If} $5 == "error"
      StrCpy $RestoreOk "0"
    ${EndIf}
  ${EndIf}
!macroend

; Recovery of an interrupted or failed transaction (no journal: nothing to do); $0 = "ok" or "fail".
!macro TxRecover
  StrCpy $0 "ok"
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestPut "payloadInventory" "$PLUGINSDIR\helper\installer-files.json"
  !insertmacro RequestEnd
  !insertmacro RunHelper "tx-recover"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    StrCpy $0 "fail"
  ${Else}
    Push "outcome"
    Call ResultGet
    Pop $1
    ${If} $1 == "registry-restore"
      StrCpy $RestoreOk "1"
      !insertmacro RegApplyRestore 1 "${UNINSTALL_KEY}" "DisplayName"
      !insertmacro RegApplyRestore 2 "${UNINSTALL_KEY}" "DisplayVersion"
      !insertmacro RegApplyRestore 3 "${UNINSTALL_KEY}" "Publisher"
      !insertmacro RegApplyRestore 4 "${UNINSTALL_KEY}" "InstallLocation"
      !insertmacro RegApplyRestore 5 "${UNINSTALL_KEY}" "UninstallString"
      !insertmacro RegApplyRestore 6 "${UNINSTALL_KEY}" "NoModify"
      !insertmacro RegApplyRestore 7 "${UNINSTALL_KEY}" "NoRepair"
      !insertmacro RegApplyRestore 8 "${UNINSTALL_KEY}" "EstimatedSize"
      !insertmacro RegApplyRestore 9 "${SETTINGS_KEY}" "InstallDir"
      !insertmacro RegKeyApplyRestore "uninstall" "${UNINSTALL_KEY}"
      !insertmacro RegKeyApplyRestore "settings" "${SETTINGS_KEY}"
      !insertmacro RequestBegin
      !insertmacro RequestPut "installDir" "$INSTDIR"
      !insertmacro RequestPut "payloadInventory" "$PLUGINSDIR\helper\installer-files.json"
      ${If} $RestoreOk == "1"
        !insertmacro RequestPut "registryRestored" "yes"
      ${Else}
        !insertmacro RequestPut "registryRestored" "no"
      ${EndIf}
      !insertmacro RequestEnd
      !insertmacro RunHelper "tx-recover-finish"
      ${If} $HelperExit != "0"
        Call ShowHelperMessage
        StrCpy $0 "fail"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

Section "Fluent Reader MCP" SectionMain
  SectionIn RO
  !define UN ""
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"

  ; 0. an earlier transaction that did not finish: undone (or, if committed, only cleaned up).
  ;    Nothing is ever deleted without the journal that describes it.
  !insertmacro TxRecover
  ${If} $0 != "ok"
    Abort "Lo stato di una installazione precedente non è stato recuperato: nulla è stato cambiato in questo passaggio."
  ${EndIf}

  ; 1. phase "staging": the journal exists before .staging is created
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestPut "version" "${PRODUCT_VERSION}"
  !insertmacro RequestPut "maxRelative" "${MAX_RELATIVE}"
  !insertmacro RequestPut "bundleSha256" "${BUNDLE_SHA256}"
  !insertmacro RequestPut "profileDir" "$ProfileDir"
  !insertmacro RequestEnd
  !insertmacro RunHelper "tx-begin"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    Abort "Installazione non avviata: nulla è stato cambiato."
  ${EndIf}
  Push "transactionId"
  Call ResultGet
  Pop $TxId

  ; 2. the new version, staged next to the installed one (its inventory first)
  DetailPrint "Copia dei file in una cartella temporanea dell'installazione..."
  SetDetailsPrint textonly
  SetOutPath "$INSTDIR\.staging"
  File "${PAYLOAD_DIR}\installer-files.json"
  File /r "${PAYLOAD_DIR}\*"
  SetOutPath "$INSTDIR"
  SetDetailsPrint both

  ; 3. verification of the staged tree with its own runtime, MCP self-test on a SYNTHETIC profile
  DetailPrint "Verifica dei file, del runtime Node.js ${NODE_VERSION} e del server MCP (profilo di prova sintetico)..."
  !insertmacro RequestBegin
  !insertmacro RequestPut "root" "$INSTDIR\.staging"
  !insertmacro RequestPut "selfTest" "yes"
  !insertmacro RequestEnd
  !insertmacro RunHelperWith "$INSTDIR\.staging\app\runtime\node.exe" "$INSTDIR\.staging\${SETUP_ENTRY}" "verify-tree"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    StrCpy $FailStep "verifica dei file installati"
    Goto install_rollback
  ${EndIf}

  ; 4. the new uninstaller, written aside (it replaces the installed one only in phase metadata)
  CreateDirectory "$INSTDIR\state"
  WriteUninstaller "$INSTDIR\state\uninstall.exe.new"
  ${IfNot} ${FileExists} "$INSTDIR\state\uninstall.exe.new"
    StrCpy $FailStep "scrittura del disinstallatore"
    Goto install_rollback
  ${EndIf}

  ; 5. phase "prepared": previous record copied, the nine HKCU values and the two keys saved in the journal;
  ;    a value of a type that cannot be restored exactly stops here, before the swap
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestPut "transactionId" "$TxId"
  !insertmacro RegBackupPut 1 "${UNINSTALL_KEY}" "DisplayName"
  !insertmacro RegBackupPut 2 "${UNINSTALL_KEY}" "DisplayVersion"
  !insertmacro RegBackupPut 3 "${UNINSTALL_KEY}" "Publisher"
  !insertmacro RegBackupPut 4 "${UNINSTALL_KEY}" "InstallLocation"
  !insertmacro RegBackupPut 5 "${UNINSTALL_KEY}" "UninstallString"
  !insertmacro RegBackupPut 6 "${UNINSTALL_KEY}" "NoModify"
  !insertmacro RegBackupPut 7 "${UNINSTALL_KEY}" "NoRepair"
  !insertmacro RegBackupPut 8 "${UNINSTALL_KEY}" "EstimatedSize"
  !insertmacro RegBackupPut 9 "${SETTINGS_KEY}" "InstallDir"
  !insertmacro RegKeyExists "${UNINSTALL_KEY}"
  !insertmacro RequestPut "key.uninstall" "$5"
  !insertmacro RegKeyExists "${SETTINGS_KEY}"
  !insertmacro RequestPut "key.settings" "$5"
  !insertmacro RequestEnd
  !insertmacro RunHelper "tx-prepare"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    StrCpy $FailStep "preparazione della transazione"
    Goto install_rollback
  ${EndIf}

  ; 6. phase "swapping" then "metadata": current -> previous, .staging -> current
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestPut "transactionId" "$TxId"
  !insertmacro RequestEnd
  !insertmacro RunHelper "tx-swap"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    StrCpy $FailStep "attivazione della nuova versione (chiudi Claude Code se è aperto)"
    Goto install_rollback
  ${EndIf}

  ; 7. new record and new uninstaller (the previous ones kept in state\)
  !insertmacro RunHelper "tx-metadata"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    StrCpy $FailStep "registro di installazione e disinstallatore"
    Goto install_rollback
  ${EndIf}

  ; 8. per-user registry entries, each written and read back
  ${GetSize} "$INSTDIR\current" "/S=0K" $EstimatedSize $2 $3
  !insertmacro RegWrite "${UNINSTALL_KEY}" "DisplayName" Str "${PRODUCT_NAME} (beta)"
  !insertmacro RegWrite "${UNINSTALL_KEY}" "DisplayVersion" Str "${PRODUCT_VERSION}"
  !insertmacro RegWrite "${UNINSTALL_KEY}" "Publisher" Str "Fluent Reader MCP - beta privata"
  !insertmacro RegWrite "${UNINSTALL_KEY}" "InstallLocation" Str "$INSTDIR"
  !insertmacro RegWrite "${UNINSTALL_KEY}" "UninstallString" Str "$\"$INSTDIR\uninstall.exe$\""
  !insertmacro RegWrite "${UNINSTALL_KEY}" "NoModify" DWORD "1"
  !insertmacro RegWrite "${UNINSTALL_KEY}" "NoRepair" DWORD "1"
  !insertmacro RegWrite "${UNINSTALL_KEY}" "EstimatedSize" DWORD "$EstimatedSize"
  !insertmacro RegWrite "${SETTINGS_KEY}" "InstallDir" Str "$INSTDIR"

  ; 9. phase "committed": the completion point, persisted in the journal
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestPut "transactionId" "$TxId"
  !insertmacro RequestPut "registryWritten" "yes"
  !insertmacro RequestEnd
  !insertmacro RunHelper "tx-commit"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    StrCpy $FailStep "completamento dell'installazione"
    Goto install_rollback
  ${EndIf}

  ; 10. cleanup of the committed transaction (previous, copies, journal); if it fails, the next start finishes it
  !insertmacro RunHelper "tx-cleanup"
  ${If} $HelperExit != "0"
    DetailPrint "Attenzione: la versione precedente e le copie di recupero non sono state ancora rimosse (lo saranno alla prossima esecuzione del setup)."
  ${EndIf}

  ; 11. Claude Code, only with consent and bound to the approved preview
  StrCpy $FinishText "Fluent Reader MCP ${PRODUCT_VERSION} è installato e verificato."
  ${If} $ConfigureClaude == "1"
    DetailPrint "Registrazione in Claude Code (scope user)..."
    !insertmacro RequestBegin
    !insertmacro RequestPut "installDir" "$INSTDIR"
    !insertmacro RequestPut "version" "${PRODUCT_VERSION}"
    !insertmacro RequestPut "maxRelative" "${MAX_RELATIVE}"
    !insertmacro RequestPut "claudeExe" "$ClaudeExe"
    !insertmacro RequestPut "profileDir" "$ProfileDir"
    !insertmacro RequestPut "planHash" "$PlanHash"
    !insertmacro RequestPut "replaceForeign" "$ReplaceForeign"
    !insertmacro RequestPut "consent" "yes"
    !insertmacro RequestEnd
    !insertmacro RunHelper "register"
    ${If} $HelperExit == "0"
      StrCpy $FinishText "$FinishText$\r$\n$\r$\nIl server $\"fluent-reader$\" è registrato in Claude Code. Apri Visual Studio Code, avvia Claude Code e digita /mcp: deve comparire fluent-reader con sette strumenti in sola lettura. La prima prova con i tuoi dati la fai tu, per esempio chiedendo di elencare le fonti."
    ${Else}
      Call ShowHelperMessage
      StrCpy $FinishText "$FinishText$\r$\n$\r$\nIl server è installato ma NON è registrato in Claude Code (vedi il messaggio mostrato). Puoi registrarlo eseguendo di nuovo questo setup."
    ${EndIf}
  ${Else}
    StrCpy $FinishText "$FinishText$\r$\n$\r$\nClaude Code non è stato modificato. Per registrare il server esegui di nuovo questo setup e scegli la registrazione."
  ${EndIf}
  Goto install_done

  ; Any failure: the same recovery as at the next start; success is never declared here.
  install_rollback:
  DetailPrint "Errore ($FailStep): ripristino dello stato precedente..."
  !insertmacro TxRecover
  ${If} $0 == "ok"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Installazione non completata ($FailStep). La versione precedente, il suo registro di installazione, il disinstallatore e i valori di Windows sono stati ripristinati."
    Abort "Installazione non completata: stato precedente ripristinato."
  ${EndIf}
  MessageBox MB_ICONSTOP|MB_OK "Installazione non completata ($FailStep) e ripristino INCOMPLETO (vedi il messaggio precedente). Il journal e le copie di recupero sono conservati in $INSTDIR\state: esegui di nuovo questo setup dopo aver risolto il problema, non il disinstallatore."
  Abort "Installazione non completata e ripristino incompleto."

  install_done:
  !undef UN
SectionEnd

; ---------------------------------------------------------------- uninstallation

; Deletes one of the product's values if present; $RegFail becomes 1 on failure.
!macro RegDeleteOwn KEY NAME
  !insertmacro RegValueType "${KEY}" "${NAME}"
  ${If} $5 != "absent"
    ClearErrors
    DeleteRegValue HKCU "${KEY}" "${NAME}"
    ${If} ${Errors}
      StrCpy $RegFail "1"
    ${EndIf}
  ${EndIf}
!macroend

; One file of the helper's recovery copy (the list is compiled into the uninstaller: helper-files.nsh).
!macro DeleteHelperCopyFile REL
  ClearErrors
  Delete "$INSTDIR\state\uninstall-helper\${REL}"
  ${If} ${Errors}
    StrCpy $CleanFail "1"
  ${EndIf}
!macroend
!macro RemoveHelperCopyDir REL
  ${If} ${FileExists} "$INSTDIR\state\uninstall-helper\${REL}\*"
    ClearErrors
    RMDir "$INSTDIR\state\uninstall-helper\${REL}"
    ${If} ${Errors}
    ${OrIf} ${FileExists} "$INSTDIR\state\uninstall-helper\${REL}\*"
      StrCpy $CleanFail "1"
    ${EndIf}
  ${EndIf}
!macroend

; $0 = "ok" if state\uninstall-final.marker is a final marker of this product for this very directory.
Function un.FinalMarkerValid
  StrCpy $0 "invalid"
  StrCpy $1 "0"
  StrCpy $2 "0"
  StrCpy $3 "0"
  ClearErrors
  FileOpen $4 "$INSTDIR\state\uninstall-final.marker" r
  IfErrors final_done
  final_loop:
    ClearErrors
    FileReadUTF16LE $4 $5
    IfErrors final_close
    StrCpy $6 $5 1 -1
    StrCmp $6 "$\n" 0 +2
      StrCpy $5 $5 -1
    StrCpy $6 $5 1 -1
    StrCmp $6 "$\r" 0 +2
      StrCpy $5 $5 -1
    StrCmpS $5 "product=fluent-reader-mcp" 0 +2
      StrCpy $1 "1"
    StrCmpS $5 "kind=uninstall-final" 0 +2
      StrCpy $2 "1"
    StrCmp $5 "installDir=$INSTDIR" 0 +2
      StrCpy $3 "1"
    Goto final_loop
  final_close:
    FileClose $4
  final_done:
  ${If} $1 == "1"
  ${AndIf} $2 == "1"
  ${AndIf} $3 == "1"
    StrCpy $0 "ok"
  ${EndIf}
FunctionEnd

Function un.onInit
  ${If} ${Silent}
    Abort
  ${EndIf}
  SetRegView 64
  InitPluginsDir
  ; an installation, an uninstallation in progress, or only its last two steps left
  ${IfNot} ${FileExists} "$INSTDIR\${RECORD_NAME}"
  ${AndIfNot} ${FileExists} "$INSTDIR\state\uninstall.json"
  ${AndIfNot} ${FileExists} "$INSTDIR\state\uninstall-final.marker"
    MessageBox MB_ICONSTOP|MB_OK "Questa cartella non contiene un'installazione riconosciuta di Fluent Reader MCP: nulla viene rimosso."
    Abort
  ${EndIf}
FunctionEnd

; Resumable: state\uninstall.json (phases files, metadata) and state\uninstall-final.marker tell a
; repeated attempt where to continue; the helper always runs from a verified copy.
Section "Uninstall"
  !define UN "un."
  ; only the last steps are left: accepted only if the final marker is this directory's and no installation exists
  ${If} ${FileExists} "$INSTDIR\state\uninstall-final.marker"
    ${If} ${FileExists} "$INSTDIR\${RECORD_NAME}"
      MessageBox MB_ICONSTOP|MB_OK "In questa cartella c'è un'installazione insieme al marcatore finale di una disinstallazione precedente: il marcatore non viene usato e nulla viene rimosso. Cancella $INSTDIR\state\uninstall-final.marker solo se sei certo che appartenga alla disinstallazione precedente."
      Abort "Disinstallazione interrotta: nulla è stato rimosso."
    ${EndIf}
    Call un.FinalMarkerValid
    ${If} $0 != "ok"
      MessageBox MB_ICONSTOP|MB_OK "Il marcatore finale della disinstallazione ($INSTDIR\state\uninstall-final.marker) non è valido per questa cartella: nulla viene rimosso."
      Abort "Disinstallazione interrotta: nulla è stato rimosso."
    ${EndIf}
    Goto uninstall_last
  ${EndIf}

  ; 0. the helper: from the verified recovery copy if an attempt already started, else from current
  ${If} ${FileExists} "$INSTDIR\state\uninstall-helper\${SETUP_ENTRY}"
  ${AndIf} ${FileExists} "$INSTDIR\state\uninstall-helper\app\runtime\node.exe"
    StrCpy $HelperSource "$INSTDIR\state\uninstall-helper"
  ${ElseIf} ${FileExists} "$INSTDIR\current\${SETUP_ENTRY}"
  ${AndIf} ${FileExists} "$INSTDIR\current\app\runtime\node.exe"
    StrCpy $HelperSource "$INSTDIR\current"
  ${Else}
    MessageBox MB_ICONSTOP|MB_OK "Il programma di supporto della disinstallazione non è disponibile (né in current né nella copia di recupero): la disinstallazione automatica non può verificare che cosa rimuovere. Nulla è stato rimosso."
    Abort "Disinstallazione interrotta: nulla è stato rimosso."
  ${EndIf}
  CreateDirectory "$PLUGINSDIR\helper"
  ClearErrors
  CopyFiles /SILENT "$HelperSource\app\runtime\node.exe" "$PLUGINSDIR\helper"
  CopyFiles /SILENT "$HelperSource\setup" "$PLUGINSDIR\helper"
  ${If} ${Errors}
  ${OrIfNot} ${FileExists} "$PLUGINSDIR\helper\${SETUP_ENTRY}"
    MessageBox MB_ICONSTOP|MB_OK "Non è stato possibile preparare il programma di supporto della disinstallazione. Nulla è stato rimosso."
    Abort "Disinstallazione interrotta: nulla è stato rimosso."
  ${EndIf}
  StrCpy $HelperNode "$PLUGINSDIR\helper\node.exe"
  StrCpy $HelperScript "$PLUGINSDIR\helper\${SETUP_ENTRY}"
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "un-status"
  ${If} $HelperExit != "0"
    Call un.ShowHelperMessage
    Abort "Disinstallazione interrotta: il programma di supporto non risponde, nulla è stato rimosso."
  ${EndIf}
  Push "phase"
  Call un.ResultGet
  Pop $UnPhase
  ${If} $UnPhase == "metadata"
    Goto uninstall_metadata
  ${EndIf}

  ; 1. preflight, without changes: record, inventories, foreign files, helper, Claude Code entry
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "uninstall-preflight"
  ${If} $HelperExit != "0"
    Call un.ShowHelperMessage
    Abort "Disinstallazione interrotta prima di qualsiasi modifica."
  ${EndIf}

  ; 2. the Claude Code entry, only if it is still exactly the one this installer saved
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "unregister"
  Push "outcome"
  Call un.ResultGet
  Pop $1
  ${If} $1 == "claude-missing"
    MessageBox MB_ICONQUESTION|MB_YESNO "Claude Code non si trova più nel percorso usato durante l'installazione (l'estensione VS Code cambia cartella quando si aggiorna). Cercarlo ora per rimuovere la voce $\"fluent-reader$\"?" IDNO claude_search_done
    !insertmacro RequestBegin
    !insertmacro RequestEnd
    !insertmacro RunHelper "detect-claude"
    ${If} $HelperExit == "0"
      Push "claudeExe"
      Call un.ResultGet
      Pop $2
      !insertmacro RequestBegin
      !insertmacro RequestPut "installDir" "$INSTDIR"
      !insertmacro RequestPut "claudeExe" "$2"
      !insertmacro RequestEnd
      !insertmacro RunHelper "unregister"
      Push "outcome"
      Call un.ResultGet
      Pop $1
    ${EndIf}
    claude_search_done:
  ${EndIf}
  Push "message"
  Call un.ResultGet
  Pop $2
  ${If} $1 == "removed"
  ${OrIf} $1 == "absent"
  ${OrIf} $1 == "not-configured"
    DetailPrint "$2"
  ${ElseIf} $1 == "modified"
  ${OrIf} $1 == "not-attributable"
  ${OrIf} $1 == "config-error"
  ${OrIf} $1 == "claude-missing"
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "$2$\r$\n$\r$\nLa voce $\"fluent-reader$\" NON viene rimossa da Claude Code. Se prosegui, il server installato viene rimosso: la voce rimasta punterà a file che non esistono più e non funzionerà, e Claude Code non sarà stato ripulito completamente (potrai rimuoverla a mano).$\r$\n$\r$\nDisinstallare comunque il server lasciando la voce? Scegli No (consigliato) per non rimuovere nulla e ripetere dopo averla sistemata." IDYES claude_left
    Abort "Disinstallazione interrotta: nulla è stato rimosso."
    claude_left:
    DetailPrint "La voce $\"fluent-reader$\" è stata lasciata in Claude Code su tua scelta: punterà a un server non più installato."
  ${Else}
    ${If} $2 == ""
      StrCpy $2 "La voce $\"fluent-reader$\" di Claude Code non è stata rimossa (codice $HelperExit)."
    ${EndIf}
    MessageBox MB_ICONEXCLAMATION|MB_OK "$2$\r$\n$\r$\nLa disinstallazione si ferma: file, registro e disinstallatore restano per poterla ripetere."
    Abort "Disinstallazione interrotta: nulla è stato rimosso."
  ${EndIf}

  ; 3. phase "files": a verified recovery copy of the helper outside current, then the marker
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "un-begin"
  ${If} $HelperExit != "0"
    Call un.ShowHelperMessage
    Abort "Disinstallazione interrotta prima di rimuovere file."
  ${EndIf}

  ; 4. installed files: only inventoried ones, through the record
  !insertmacro RemoveOwnTree "$HelperNode" "$HelperScript" ".staging"
  ${If} $0 != "ok"
    Call un.ShowHelperMessage
    Abort "Disinstallazione incompleta: può essere ripetuta (il programma di supporto è conservato in state\uninstall-helper)."
  ${EndIf}
  !insertmacro RemoveOwnTree "$HelperNode" "$HelperScript" "previous"
  ${If} $0 != "ok"
    Call un.ShowHelperMessage
    Abort "Disinstallazione incompleta: può essere ripetuta (il programma di supporto è conservato in state\uninstall-helper)."
  ${EndIf}
  !insertmacro RemoveOwnTree "$HelperNode" "$HelperScript" "current"
  ${If} $0 != "ok"
    Call un.ShowHelperMessage
    Abort "Disinstallazione incompleta: può essere ripetuta (il programma di supporto è conservato in state\uninstall-helper)."
  ${EndIf}

  ; 5. phase "metadata": the record goes (the marker keeps the uninstallation resumable)
  uninstall_metadata:
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "un-metadata"
  ${If} $HelperExit != "0"
    Call un.ShowHelperMessage
    Abort "Disinstallazione incompleta: può essere ripetuta."
  ${EndIf}

  ; 6. only the product's nine HKCU values; a key goes only if nothing else is left in it
  StrCpy $RegFail "0"
  !insertmacro RegDeleteOwn "${UNINSTALL_KEY}" "DisplayName"
  !insertmacro RegDeleteOwn "${UNINSTALL_KEY}" "DisplayVersion"
  !insertmacro RegDeleteOwn "${UNINSTALL_KEY}" "Publisher"
  !insertmacro RegDeleteOwn "${UNINSTALL_KEY}" "InstallLocation"
  !insertmacro RegDeleteOwn "${UNINSTALL_KEY}" "UninstallString"
  !insertmacro RegDeleteOwn "${UNINSTALL_KEY}" "NoModify"
  !insertmacro RegDeleteOwn "${UNINSTALL_KEY}" "NoRepair"
  !insertmacro RegDeleteOwn "${UNINSTALL_KEY}" "EstimatedSize"
  !insertmacro RegDeleteOwn "${SETTINGS_KEY}" "InstallDir"
  ${If} $RegFail == "0"
    !insertmacro RegDeleteKeyIfEmpty "${UNINSTALL_KEY}"
    ${If} $5 == "error"
      StrCpy $RegFail "1"
    ${EndIf}
    !insertmacro RegDeleteKeyIfEmpty "${SETTINGS_KEY}"
    ${If} $5 == "error"
      StrCpy $RegFail "1"
    ${EndIf}
  ${EndIf}
  ${If} $RegFail != "0"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Alcuni valori o chiavi di Fluent Reader MCP nel registro di Windows non sono stati rimossi. La disinstallazione può essere ripetuta."
    Abort "Disinstallazione incompleta: può essere ripetuta."
  ${EndIf}

  ; 7. the final marker is written first, then the marker goes: from here the uninstaller finishes on its own
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "un-finish"
  ${If} $HelperExit != "0"
    Call un.ShowHelperMessage
    Abort "Disinstallazione incompleta: può essere ripetuta."
  ${EndIf}

  ; 8. without the helper: its recovery copy (the list compiled into this uninstaller), the leftover marker,
  ;    the uninstaller, the final marker last; the profile, other MCP servers and the backups stay
  ; Every failure before the last step stops with the final marker AND the uninstaller still present: the
  ; uninstallation can be repeated. If the uninstaller is gone (deleted by hand), a new setup finishes from the
  ; final marker (finish-uninstall). The uninstaller goes last: left behind, it authorises nothing and does not
  ; block a new installation, which replaces it.
  uninstall_last:
  StrCpy $CleanFail "0"
  !insertmacro HelperCopyDelete
  ${If} ${FileExists} "$INSTDIR\state\uninstall-helper\*"
    ClearErrors
    RMDir "$INSTDIR\state\uninstall-helper"
    ${If} ${Errors}
    ${OrIf} ${FileExists} "$INSTDIR\state\uninstall-helper\*"
      StrCpy $CleanFail "1"
    ${EndIf}
  ${EndIf}
  ${If} $CleanFail != "0"
    MessageBox MB_ICONEXCLAMATION|MB_OK "La copia di recupero del programma di supporto ($INSTDIR\state\uninstall-helper) non è stata rimossa del tutto: è in uso, oppure contiene file che non appartengono all'installazione (che non vengono toccati: spostali altrove). Poi ripeti la disinstallazione, che riprenderà da qui."
    Abort "Disinstallazione quasi completa: può essere ripetuta."
  ${EndIf}
  ClearErrors
  Delete "$INSTDIR\state\uninstall.json"
  ${If} ${Errors}
    MessageBox MB_ICONEXCLAMATION|MB_OK "Lo stato della disinstallazione (state\uninstall.json) non è stato rimosso: ripeti la disinstallazione."
    Abort "Disinstallazione quasi completa: può essere ripetuta."
  ${EndIf}
  ClearErrors
  Delete "$INSTDIR\state\uninstall-final.marker"
  ${If} ${Errors}
  ${OrIf} ${FileExists} "$INSTDIR\state\uninstall-final.marker"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Il marcatore finale della disinstallazione ($INSTDIR\state\uninstall-final.marker) non è stato rimosso: ripeti la disinstallazione, che riprenderà da qui."
    Abort "Disinstallazione quasi completa: può essere ripetuta."
  ${EndIf}
  ClearErrors
  Delete "$INSTDIR\uninstall.exe"
  ${If} ${Errors}
    MessageBox MB_ICONINFORMATION|MB_OK "Fluent Reader MCP è stato rimosso. Il file $INSTDIR\uninstall.exe non è stato cancellato: puoi cancellarlo a mano; non impedisce una nuova installazione e non serve più."
  ${EndIf}
  RMDir "$INSTDIR\state"
  RMDir "$INSTDIR"
  ${If} ${FileExists} "$INSTDIR\state\claude-config-backups\*"
    MessageBox MB_ICONINFORMATION|MB_OK "Le copie della configurazione di Claude Code prese durante l'installazione restano in $INSTDIR\state\claude-config-backups: cancellale quando non ti servono più."
  ${EndIf}
  !undef UN
SectionEnd
