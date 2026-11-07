; FR-MCP-04-BETA-02 — Fluent Reader MCP, per-user installer for Windows x64.
; NSIS 3 Unicode, Modern UI 2. Compiled ONLY through installer/lib/installer-build.ts
; (npm.cmd run installer:win), which verifies the portable bundle, prepares the payload
; and generates defines.nsh; see installer/INSTALLER.md.
;
; The wizard holds no installation logic of its own: every check and every change is made
; by the setup helper (current\setup\installer\setup\fr-setup.js) run by the BUNDLED
; node.exe. Values chosen by the user travel in a UTF-16LE request file, never on a command
; line; the helper answers in a result file. No service, no port, no resident process,
; no HKLM, no elevation: a folder under Program Files works only if Windows lets this user write there.

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
; The trailing backslash stops NSIS from appending "FluentReaderMCP" to a folder chosen with Browse: the
; helper alone turns the choice into the effective destination (check-install-dir), shown on the page itself.
InstallDir "$LOCALAPPDATA\FluentReaderMCP\"
InstallDirRegKey HKCU "${SETTINGS_KEY}" "InstallDir"
; A drive root may be chosen: the helper never installs there, it proposes <root>\FluentReaderMCP.
AllowRootDirInstall true
ShowInstDetails show
ShowUninstDetails show
BrandingText "${PRODUCT_NAME} ${PRODUCT_VERSION} - beta privata"

Var HelperNode
Var HelperScript
Var HelperExit
Var Mode
Var InstalledVersion
Var ProfileDir
Var ModeText
Var VolumeNote
Var ConfigureDesktop
Var DesktopConfig
Var PlanHash
Var PlanAction
Var ReplaceForeign
Var FinishText
Var Dialog
Var ProfileText
Var ConfirmProfile
Var RadioDesktop
Var RadioServerOnly
Var DesktopText
Var ConsentDesktop
Var PreviewText

; ---------------------------------------------------------------- pages

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${PRODUCT_NAME} ${PRODUCT_VERSION} (beta privata)"
!define MUI_WELCOMEPAGE_TEXT "Questo programma installa Fluent Reader MCP, un server MCP che permette a Claude Desktop di consultare un tuo profilo locale di Fluent Reader e, soltanto su tua richiesta esplicita, di modificare regole RSS e preferenze editoriali.$\r$\n$\r$\nLa beta offre sedici strumenti, tutti disponibili automaticamente: dodici non modificano nulla e quattro possono scrivere, con i controlli e i backup previsti.$\r$\n$\r$\nNon vengono installati servizi, porte di rete o processi residenti. Puoi scegliere se registrare il server in Claude Desktop: prima vedrai il file e la voce esatti da modificare."
!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "Cartella proposta: %LOCALAPPDATA%\FluentReaderMCP. Puoi sceglierne un'altra su qualsiasi unità locale dove il tuo utente può scrivere: il setup non chiede privilegi di amministratore. Se la cartella scelta non può essere usata così com'è (radice di un'unità, altri file già presenti), il campo qui sotto mostrerà la sottocartella FluentReaderMCP prima di continuare."
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryLeave
!insertmacro MUI_PAGE_DIRECTORY
Page custom ProfilePageShow ProfilePageLeave
Page custom PrivacyPageShow PrivacyPageLeave
Page custom DesktopPageShow DesktopPageLeave
Page custom DesktopConfirmPageShow DesktopConfirmPageLeave
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
    StrCpy $R0 "Il programma di supporto del setup non ha restituito un risultato verificabile (codice $HelperExit). Non è possibile sapere se questo passaggio abbia già modificato qualcosa.$\r$\n$\r$\nNon cancellare né modificare file a mano. Esegui di nuovo la stessa operazione (setup o disinstallazione) sulla stessa cartella: all'avvio verifica lo stato e, quando possibile, completa o annulla il passaggio interrotto. Se segnala un ripristino o un recupero INCOMPLETO, fermati e segui le sue indicazioni. Il recupero automatico non è garantito in tutti i casi."
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

; The helper used before the installation (directory, profile, Claude Desktop checks):
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
  ; the effective destination: the only path used from here on, by every page and every helper command
  Push "canonical"
  Call ResultGet
  Pop $1
  Push "adjusted"
  Call ResultGet
  Pop $2
  Push "outsideProfile"
  Call ResultGet
  Pop $3
  Push "mode"
  Call ResultGet
  Pop $4
  Push "installedVersion"
  Call ResultGet
  Pop $5
  ; the volume: a network drive is not supported
  StrCpy $6 $1 3
  System::Call 'kernel32::GetDriveTypeW(w r6) i .r7'
  ${If} $7 == 4
    MessageBox MB_ICONSTOP|MB_OK "La cartella $1 è su un'unità di rete: non è supportata. Scegli una cartella su un'unità locale."
    Abort
  ${EndIf}
  ; a destination other than the one chosen never hides behind Next: it replaces the field on this very page,
  ; the page says why and stays, and the next Next goes on with what the field shows (adjusted is then empty)
  ${If} $2 != ""
    FindWindow $R7 "#32770" "" $HWNDPARENT
    GetDlgItem $R8 $R7 1019
    SendMessage $R8 ${WM_SETTEXT} 0 "STR:$1"
    GetDlgItem $R8 $R7 1006
    ${If} $2 == "root"
      SendMessage $R8 ${WM_SETTEXT} 0 "STR:Hai scelto la radice di un'unità: i file non vengono installati direttamente lì. Il campo qui sotto ora mostra la destinazione effettiva: premi Avanti per usarla, oppure scegline un'altra."
    ${ElseIf} $2 == "programs"
      SendMessage $R8 ${WM_SETTEXT} 0 "STR:Hai scelto la cartella dei programmi: i file non vengono installati direttamente lì. Il campo qui sotto ora mostra la destinazione effettiva: premi Avanti per usarla, oppure scegline un'altra."
    ${Else}
      SendMessage $R8 ${WM_SETTEXT} 0 "STR:La cartella scelta contiene già altri file, che non vengono toccati. Il campo qui sotto ora mostra la destinazione effettiva: premi Avanti per usarla, oppure scegline un'altra."
    ${EndIf}
    Abort
  ${EndIf}
  ; what the summary page tells about this destination: no extra window here
  StrCpy $VolumeNote ""
  ${If} $7 == 2
    StrCpy $VolumeNote "L'unità $6 è rimovibile: deve essere collegata, con la stessa lettera, ogni volta che Claude Desktop avvia il server e per aggiornarlo o disinstallarlo."
  ${EndIf}
  ${If} $3 == "yes"
    StrCpy $VolumeNote "$VolumeNote$\r$\nLa cartella è fuori dalla tua cartella utente: a seconda dei permessi di quella posizione, altri account di questo computer potrebbero leggere o modificare i file installati. Il setup non modifica i permessi."
  ${EndIf}
  ${If} $4 == "upgrade"
    StrCpy $ModeText "Vi è installata la versione $5: verrà aggiornata alla ${PRODUCT_VERSION}. Se l'aggiornamento non riesce, la versione attuale resta com'è."
  ${ElseIf} $4 == "repair"
    StrCpy $ModeText "La versione ${PRODUCT_VERSION} vi è già installata: i suoi file verranno reinstallati (riparazione). I tuoi dati non vengono toccati."
  ${Else}
    StrCpy $ModeText "Nuova installazione."
  ${EndIf}
  StrCpy $INSTDIR $1
  StrCpy $Mode $4
  StrCpy $InstalledVersion $5
  Push "previousProfile"
  Call ResultGet
  Pop $0
  ${If} $ProfileDir == ""
    StrCpy $ProfileDir $0
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- profile

Function ProfilePageShow
  !insertmacro MUI_HEADER_TEXT "Profilo Fluent Reader" "Scegli la cartella del profilo che Fluent Reader MCP potrà consultare"
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

; One line of the page's read-only box.
!macro BoxLine TEXT
  SendMessage $PreviewText ${EM_SETSEL} -1 -1
  SendMessage $PreviewText ${EM_REPLACESEL} 0 "STR:${TEXT}$\r$\n"
!macroend

Function PrivacyPageShow
  !insertmacro MUI_HEADER_TEXT "Riepilogo e privacy" "Controlla la destinazione e il profilo, poi conferma l'informativa della beta"
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 0 100% 112u ""
  Pop $PreviewText
  !insertmacro BoxLine "Destinazione: $INSTDIR"
  !insertmacro BoxLine "$ModeText"
  ${If} $VolumeNote != ""
    !insertmacro BoxLine "$VolumeNote"
  ${EndIf}
  !insertmacro BoxLine "Profilo scelto: $ProfileDir"
  !insertmacro BoxLine ""
  !insertmacro BoxLine "- Fluent Reader MCP legge il profilo senza modificarlo, salvo una tua richiesta esplicita di cambiare le regole RSS. Il database resta sempre in sola lettura."
  !insertmacro BoxLine "- Il server non effettua richieste di rete proprie e non resta in esecuzione: lo avvia Claude Desktop quando serve."
  !insertmacro BoxLine "- I risultati degli strumenti (per esempio titoli e testi degli articoli richiesti) possono essere inviati da Claude Desktop al servizio Anthropic come parte della conversazione."
  !insertmacro BoxLine "- Il server espone sedici strumenti, senza attivazioni. Tre possono cambiare le regole RSS, con Fluent Reader chiuso e dopo un backup; uno salva le preferenze editoriali in un file privato fuori dal profilo. Gli altri non modificano nulla. La ricerca usa solo dati già salvati."
  !insertmacro BoxLine "- Nessun servizio Windows viene installato."
  SendMessage $PreviewText ${EM_SETSEL} 0 0
  ${NSD_CreateCheckbox} 0 116u 100% 12u "Confermo destinazione e profilo e ho letto l'informativa"
  Pop $ConfirmProfile
  nsDialogs::Show
FunctionEnd

Function PrivacyPageLeave
  ${NSD_GetState} $ConfirmProfile $0
  ${If} $0 != ${BST_CHECKED}
    MessageBox MB_ICONINFORMATION|MB_OK "Per continuare conferma destinazione, profilo e informativa."
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- Claude Desktop

; The helper lists the candidate files (names and dates only) and proposes one only when there is no doubt to hide;
; the file to change is always the one in the field when the user goes on, and it is shown again before consent.
Function DesktopPageShow
  !insertmacro MUI_HEADER_TEXT "Claude Desktop" "Collegamento del server a Claude Desktop (facoltativo)"
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "desktop-candidates"
  StrCpy $1 "none"
  StrCpy $2 ""
  StrCpy $3 "allowed"
  ${If} $HelperExit == "0"
    Push "proposal"
    Call ResultGet
    Pop $1
    Push "selected"
    Call ResultGet
    Pop $2
    Push "policy"
    Call ResultGet
    Pop $3
  ${EndIf}
  ${If} $DesktopConfig == ""
    StrCpy $DesktopConfig $2
  ${EndIf}
  ${If} $ConfigureDesktop == ""
    StrCpy $ConfigureDesktop "1"
    ${If} $1 == "none"
      StrCpy $ConfigureDesktop "0"
    ${EndIf}
  ${EndIf}
  ${If} $3 == "blocked"
    StrCpy $ConfigureDesktop "0"
  ${EndIf}
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  ${NSD_CreateRadioButton} 0 0 100% 12u "Registra Fluent Reader MCP in Claude Desktop"
  Pop $RadioDesktop
  ${NSD_CreateRadioButton} 0 13u 100% 12u "Installa solo il server: Claude Desktop non viene modificato"
  Pop $RadioServerOnly
  ${If} $ConfigureDesktop == "1"
    ${NSD_Check} $RadioDesktop
  ${Else}
    ${NSD_Check} $RadioServerOnly
  ${EndIf}
  ${If} $3 == "blocked"
    EnableWindow $RadioDesktop 0
    ${NSD_CreateLabel} 0 28u 100% 24u "Una policy di questo computer disattiva i server MCP locali in Claude Desktop (isLocalDevMcpEnabled): la registrazione automatica non è disponibile, il server può essere installato comunque."
  ${Else}
    ${NSD_CreateLabel} 0 28u 100% 24u "Indica il file di configurazione che Claude Desktop usa davvero: in Claude Desktop apri Impostazioni, poi Modifica configurazione. File trovati nelle tue cartelle (nessuno è stato aperto):"
  ${EndIf}
  Pop $0
  nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 53u 100% 40u ""
  Pop $PreviewText
  Call AppendPreview
  SendMessage $PreviewText ${EM_SETSEL} 0 0
  ${NSD_CreateText} 0 96u 78% 12u "$DesktopConfig"
  Pop $DesktopText
  ${NSD_CreateButton} 80% 95u 20% 14u "Sfoglia..."
  Pop $0
  ${NSD_OnClick} $0 DesktopBrowse
  ${NSD_CreateLabel} 0 112u 100% 20u "Nessuna modifica in questa pagina: nella prossima vedrai file e voce e potrai autorizzare la modifica. Se non sei sicuro di quale sia il file giusto, installa solo il server."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function DesktopBrowse
  Pop $0
  ${NSD_GetText} $DesktopText $0
  nsDialogs::SelectFileDialog open "$0" "claude_desktop_config.json|claude_desktop_config.json"
  Pop $0
  ${If} $0 != ""
  ${AndIf} $0 != "error"
    ${NSD_SetText} $DesktopText "$0"
  ${EndIf}
FunctionEnd

Function DesktopPageLeave
  ${NSD_GetState} $RadioDesktop $0
  ${If} $0 != ${BST_CHECKED}
    StrCpy $ConfigureDesktop "0"
    Return
  ${EndIf}
  StrCpy $ConfigureDesktop "1"
  ${NSD_GetText} $DesktopText $DesktopConfig
  ${If} $DesktopConfig == ""
    MessageBox MB_ICONINFORMATION|MB_OK "Indica il file claude_desktop_config.json con Sfoglia, oppure scegli $\"Installa solo il server$\"."
    Abort
  ${EndIf}
  !insertmacro RequestBegin
  !insertmacro RequestPut "configPath" "$DesktopConfig"
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "desktop-check"
  ${If} $HelperExit != "0"
    Call ShowHelperMessage
    Abort
  ${EndIf}
  Push "canonical"
  Call ResultGet
  Pop $DesktopConfig
FunctionEnd

; ---------------------------------------------------------------- the change to Claude Desktop's configuration

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

Function DesktopConfirmPageShow
  ${If} $ConfigureDesktop != "1"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Modifica di Claude Desktop" "Controlla il file e la voce, poi autorizza la modifica"
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestPut "version" "${PRODUCT_VERSION}"
  !insertmacro RequestPut "maxRelative" "${MAX_RELATIVE}"
  !insertmacro RequestPut "configPath" "$DesktopConfig"
  !insertmacro RequestPut "profileDir" "$ProfileDir"
  !insertmacro RequestEnd
  !insertmacro RunHelper "desktop-plan"
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
  ${If} $PlanAction == "none"
    ${NSD_CreateLabel} 0 114u 100% 20u "Il file non viene modificato: la voce è già presente così."
    Pop $0
  ${ElseIf} $PlanAction == "replace-foreign"
    ${NSD_CreateCheckbox} 0 112u 100% 20u "Autorizzo la modifica di questo file e la sostituzione della voce $\"fluent-reader$\" esistente, che non risulta scritta da questo installer"
    Pop $ConsentDesktop
  ${Else}
    ${NSD_CreateCheckbox} 0 112u 100% 20u "Autorizzo il setup a modificare questo file, soltanto per la voce $\"fluent-reader$\""
    Pop $ConsentDesktop
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function DesktopConfirmPageLeave
  ${If} $PlanAction == "error"
    MessageBox MB_ICONINFORMATION|MB_OK "Torna indietro e scegli $\"Installa solo il server$\", oppure risolvi il problema indicato."
    Abort
  ${EndIf}
  StrCpy $ReplaceForeign "no"
  ${If} $PlanAction == "none"
    Return
  ${EndIf}
  ${NSD_GetState} $ConsentDesktop $0
  ${If} $0 != ${BST_CHECKED}
    MessageBox MB_ICONINFORMATION|MB_OK "Il file non viene toccato senza la tua autorizzazione: spunta la casella, oppure torna indietro e scegli $\"Installa solo il server$\"."
    Abort
  ${EndIf}
  ${If} $PlanAction == "replace-foreign"
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
Var BackupNote

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
  ; empty before tx-begin: only a journal created by this run of the setup is trusted as such
  !insertmacro RequestPut "sessionTransactionId" "$TxId"
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
      !insertmacro RequestPut "sessionTransactionId" "$TxId"
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
  ${IfNot} ${FileExists} "$INSTDIR\*.*"
    MessageBox MB_ICONSTOP|MB_OK "Impossibile creare la cartella di installazione $INSTDIR (accesso negato, unità scollegata o di sola lettura). Nulla è stato installato: esegui di nuovo il setup e scegli un'altra cartella. Il setup non modifica i permessi delle cartelle."
    Abort "Installazione non avviata: cartella di installazione non disponibile."
  ${EndIf}
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
  ; what the user confirmed: a directory that changed since then is not used (checked again before any write)
  !insertmacro RequestPut "expectMode" "$Mode"
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
    StrCpy $FailStep "attivazione della nuova versione (chiudi Claude Desktop se è aperto)"
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

  ; 11. Claude Desktop, only with consent and bound to the page the user approved
  StrCpy $FinishText "Fluent Reader MCP ${PRODUCT_VERSION} è installato e verificato."
  ${If} $ConfigureDesktop == "1"
    DetailPrint "Registrazione in Claude Desktop..."
    !insertmacro RequestBegin
    !insertmacro RequestPut "installDir" "$INSTDIR"
    !insertmacro RequestPut "version" "${PRODUCT_VERSION}"
    !insertmacro RequestPut "maxRelative" "${MAX_RELATIVE}"
    !insertmacro RequestPut "configPath" "$DesktopConfig"
    !insertmacro RequestPut "profileDir" "$ProfileDir"
    !insertmacro RequestPut "planHash" "$PlanHash"
    !insertmacro RequestPut "replaceForeign" "$ReplaceForeign"
    !insertmacro RequestPut "consent" "yes"
    !insertmacro RequestEnd
    !insertmacro RunHelper "desktop-register"
    ${If} $HelperExit == "0"
      StrCpy $FinishText "$FinishText$\r$\n$\r$\nLa voce $\"fluent-reader$\" è nel file che hai selezionato:$\r$\n$DesktopConfig$\r$\n$\r$\nIl setup non può dimostrare che Claude Desktop legga proprio questo file. Chiudi del tutto Claude Desktop (anche dall'area di notifica), riaprilo e controlla che compaia fluent-reader con sedici strumenti. Se non compare, esegui di nuovo il setup e seleziona l'altro file."
    ${Else}
      Call ShowHelperMessage
      StrCpy $FinishText "$FinishText$\r$\n$\r$\nIl server è installato ma NON è registrato in Claude Desktop (vedi il messaggio mostrato). Puoi registrarlo eseguendo di nuovo questo setup."
    ${EndIf}
  ${Else}
    StrCpy $FinishText "$FinishText$\r$\n$\r$\nClaude Desktop non è stato modificato. Per registrare il server esegui di nuovo questo setup e scegli la registrazione."
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
  ; where the copies of the Claude configurations stay (the user's private directory, never deleted here), and an
  ; entry an earlier setup left in Claude Code (never touched here): told at the end
  Push "backups"
  Call un.ResultGet
  Pop $BackupNote
  ${If} $UnPhase == "metadata"
    Goto uninstall_metadata
  ${EndIf}

  ; 1. preflight, without changes: record, inventories, foreign files, helper, Claude Desktop entry
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "uninstall-preflight"
  ${If} $HelperExit != "0"
    Call un.ShowHelperMessage
    Abort "Disinstallazione interrotta prima di qualsiasi modifica."
  ${EndIf}

  ; 2. the Claude Desktop entry, only if it is still exactly the one this installer wrote
  !insertmacro RequestBegin
  !insertmacro RequestPut "installDir" "$INSTDIR"
  !insertmacro RequestEnd
  !insertmacro RunHelper "desktop-unregister"
  Push "outcome"
  Call un.ResultGet
  Pop $1
  Push "message"
  Call un.ResultGet
  Pop $2
  ${If} $1 == "removed"
  ${OrIf} $1 == "absent"
  ${OrIf} $1 == "config-missing"
  ${OrIf} $1 == "not-configured"
    DetailPrint "$2"
  ${ElseIf} $1 == "modified"
  ${OrIf} $1 == "config-error"
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "$2$\r$\n$\r$\nLa voce $\"fluent-reader$\" NON viene rimossa da Claude Desktop. Se prosegui, il server installato viene rimosso: una voce rimasta che punta a questa cartella non funzionerà più, e Claude Desktop non sarà stato ripulito completamente (potrai rimuoverla a mano).$\r$\n$\r$\nDisinstallare comunque il server lasciando la voce? Scegli No (consigliato) per non rimuovere nulla e ripetere dopo averla sistemata." IDYES desktop_left
    Abort "Disinstallazione interrotta: nulla è stato rimosso."
    desktop_left:
    DetailPrint "La voce $\"fluent-reader$\" è stata lasciata in Claude Desktop su tua scelta."
  ${Else}
    ${If} $2 == ""
      StrCpy $2 "La voce $\"fluent-reader$\" di Claude Desktop non è stata rimossa (codice $HelperExit)."
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
    MessageBox MB_ICONINFORMATION|MB_OK "Fluent Reader MCP è stato rimosso. Il file $INSTDIR\uninstall.exe non è stato cancellato: non serve più, cancellalo a mano. Finché è presente, senza un registro di installazione il setup non lo considera suo e non riusa questa cartella per una nuova installazione."
  ${EndIf}
  RMDir "$INSTDIR\state"
  RMDir "$INSTDIR"
  ${If} $BackupNote != ""
    MessageBox MB_ICONINFORMATION|MB_OK "$BackupNote"
  ${EndIf}
  ; copies left by an earlier version of the setup in the installation directory
  ${If} ${FileExists} "$INSTDIR\state\claude-config-backups\*"
    MessageBox MB_ICONINFORMATION|MB_OK "Le copie della configurazione di Claude Code prese da una versione precedente del setup restano in $INSTDIR\state\claude-config-backups: contengono la tua configurazione, compresa quella di altri server MCP. Spostale nella tua cartella personale o cancellale quando non ti servono più. Finché sono presenti, il setup non riusa questa cartella per una nuova installazione."
  ${EndIf}
  !undef UN
SectionEnd
