# Installer Windows (FR-MCP-04-BETA-02)

Installer NSIS per l'utente corrente (Windows 10/11 x64) costruito **a partire dal pacchetto portatile approvato**
(`fluent-reader-mcp-v<versione>-beta-win-x64.zip`, FR-MCP-04-BETA-01). Il server non viene ricompilato: l'installer
contiene esattamente i file del pacchetto, più il programma di supporto del setup.

Beta privata: otto strumenti in sola lettura (i sette di FR-MCP-02A e `list_articles` di FR-MCP-02B-01). L'installer
registra il server soltanto in **Claude Code** (CLI o binario dell'estensione VS Code). Questa versione beta
dell'installer non configura automaticamente Claude Desktop: il server Fluent Reader MCP è compatibile con Claude
Desktop tramite configurazione manuale. I sette strumenti originari sono stati collaudati con Claude Desktop; il nuovo
`list_articles` è stato verificato tramite test sintetici.

## Prerequisiti (solo per chi costruisce l'installer)

- Windows x64 con il Node.js 24 della repository e `npm.cmd ci` già eseguito.
- **NSIS 3** (Unicode, con Modern UI 2), installato dal proprietario: di solito
  `C:\Program Files (x86)\NSIS\makensis.exe`. Il builder **non scarica mai** NSIS; verifica `makensis /VERSION`
  (3.x) e la presenza di `MUI2.nsh`, `nsDialogs.nsh`, `LogicLib.nsh`, `x64.nsh`, `WinVer.nsh`, `FileFunc.nsh` e dei
  plugin `nsExec`, `nsDialogs`, `System` (`Plugins\x86-unicode`). Un percorso diverso si indica con `--makensis`.
- Il pacchetto portatile, il suo file `.sha256` accanto e il suo SHA-256 (dall'output della build o dal file).
- Albero Git pulito (oppure `--allow-dirty`, annotato nel report).

## Comando

```powershell
# 1. Prova a secco: verifica bundle, checksum, manifest, NSIS e percorsi; non scrive nulla e non avvia makensis
npm.cmd run installer:win -- --bundle "D:\FluentReaderMCP-build\fluent-reader-mcp-v0.1.0-beta-win-x64.zip" --bundle-sha256 <sha256 del bundle> --out "D:\FluentReaderMCP-build" --dry-run

# 2. Installer
npm.cmd run installer:win -- --bundle "D:\FluentReaderMCP-build\fluent-reader-mcp-v0.1.0-beta-win-x64.zip" --bundle-sha256 <sha256 del bundle> --out "D:\FluentReaderMCP-build"
```

Come per il builder portatile, il comando npm compila prima con TypeScript (rigenera `dist-test\`, già ignorata da
Git); il builder poi scrive solo in `--out`, che deve stare fuori dalla repository. Lo SHA-256 del bundle **non** è
fissato negli script: va passato ogni volta con `--bundle-sha256`.

| Opzione | Significato |
|---|---|
| `--bundle <zip>` | Pacchetto portatile (obbligatorio); il nome deve corrispondere alla versione di `package.json` |
| `--bundle-sha256 <hex>` | SHA-256 atteso del pacchetto (obbligatorio); deve coincidere con il file `.sha256` e con il file |
| `--out <dir>` | Cartella di output (obbligatoria), fuori dalla repository; può essere quella del pacchetto |
| `--makensis <exe>` | Percorso di `makensis.exe`, se non è in `Program Files (x86)\NSIS` o `Program Files\NSIS` |
| `--dry-run` | Solo verifiche: niente cartelle, niente makensis |
| `--allow-dirty` | Consente un albero Git con modifiche (annotato nel report) |
| `--keep-work` | Conserva la cartella di lavoro dopo una build riuscita |

### Che cosa verifica il builder

1. Windows x64; nome del pacchetto, file `.sha256` e `--bundle-sha256` tutti uguali allo SHA-256 del file.
2. Ogni voce dello ZIP riletta (CRC, nomi sicuri, nessuna voce fuori da `FluentReaderMCP/`); manifest (schema 1)
   uguale al contenuto, con dimensione e SHA-256 di ogni file; versione uguale a `package.json`; runtime uguale a
   `installer/runtime-lock.json` (Node.js 24.22.1, hash dell'archivio ufficiale); entrypoint e gli otto strumenti;
   presenti `runtime\node.exe`, `server\dist\main.js`, il modulo Koffi win32-x64, le licenze; nessun contenuto
   vietato. Un pacchetto incompleto, alterato o di un'altra versione viene rifiutato prima di scrivere qualsiasi file.
3. Percorsi canonici (collegamenti e junction risolti); `--out` fuori dalla repository; nessun artefatto o cartella
   di lavoro già esistente; i percorsi che finiscono nello script NSIS non possono contenere `$`, virgolette o
   backtick (rifiutati, non "escapati"); il volume deve supportare gli hard link (NTFS).
4. Payload in `<out>\work-installer-<versione>\payload\current`: il pacchetto estratto in `app\` e verificato di
   nuovo sul disco contro il manifest, il programma di supporto in `setup\` (solo i moduli JavaScript compilati che
   importa, calcolati dalle sue `import`), l'inventario `installer-files.json` (ogni file con SHA-256).
5. `makensis /V2 /INPUTCHARSET UTF8 installer\nsis\fluent-reader-mcp.nsi` con un `defines.nsh` generato; nessuna
   shell, argomenti come array.
6. Pubblicazione come nel builder portatile: `.partial` creati in modo esclusivo, poi hard link ai nomi definitivi
   (mai sovrascritti), rollback in caso di errore.

Output:

```text
D:\FluentReaderMCP-build\
  FluentReaderMCP-Setup-v0.1.0-beta-win-x64.exe
  FluentReaderMCP-Setup-v0.1.0-beta-win-x64.exe.sha256
  FluentReaderMCP-Setup-v0.1.0-beta-win-x64.exe.build-report.json
```

Il report contiene SHA-256 e dimensione dell'installer, versione NSIS, commit degli script, e la provenienza del
pacchetto (nome file, SHA-256, commit, data, runtime); **nessun percorso locale**.

## Che cosa fa l'installer

Nessun servizio, nessuna porta, nessun processo residente, nessuna scrittura in `Program Files` o `HKLM`,
`RequestExecutionLevel user` (niente UAC). Il server viene avviato da Claude Code quando serve.

Pagine: benvenuto (beta in sola lettura) → cartella di installazione → profilo Fluent Reader (Sfoglia) → riepilogo e
informativa privacy (conferma obbligatoria) → Claude Code (registrare o installare solo il server; claude.exe con
Sfoglia o "Cerca"; consenso) → anteprima esatta della modifica → installazione → risultato e istruzioni.

Tutta la logica sta nel programma di supporto (`setup\installer\setup\fr-setup.js`), eseguito dal `node.exe`
incluso: i valori scelti dall'utente (percorsi, consenso) passano in un file di richiesta UTF-16LE, mai sulla riga di
comando; la risposta torna in un file di risultato. Prima dell'installazione il supporto gira da `%TEMP%` (cartella
dei plugin NSIS, cancellata alla chiusura).

### Cartella di installazione

Proposta: `%LOCALAPPDATA%\FluentReaderMCP`. Un'altra cartella è accettata solo se è sicura: percorso locale
(`X:\...`, niente rete, UNC o unità mappate), **dentro la cartella dell'utente** (che gli altri utenti non possono
modificare: nessuno può sostituire il `node.exe` che Claude Code avvierà), fuori da `Roaming`, OneDrive e `.claude`,
senza collegamenti, junction o nomi brevi, con nomi validi per Windows, abbastanza corta perché il file più profondo
resti sotto `MAX_PATH`, e vuota oppure una precedente installazione di Fluent Reader MCP (riconosciuta dal registro
`fluent-reader-mcp.install.json`). Il downgrade non è supportato.

```text
%LOCALAPPDATA%\FluentReaderMCP\
  current\app\...                 pacchetto portatile (runtime\node.exe, server\dist\main.js, manifest.json)
  current\setup\...               programma di supporto del setup
  current\installer-files.json    inventario: i file che l'installer possiede
  fluent-reader-mcp.install.json  versione, profilo, registrazione Claude creata dall'installer
  state\claude-config-backups\    copie della configurazione Claude prese prima di ogni modifica
  state\install-journal.json      solo durante un'installazione (con le copie di recupero accanto)
  state\uninstall*.               solo durante una disinstallazione (marcatori, copia del programma di supporto)
  uninstall.exe
```

Voci di registro (solo HKCU): `Software\Microsoft\Windows\CurrentVersion\Uninstall\FluentReaderMCP` e
`Software\FluentReaderMCP`.

### Profilo Fluent Reader

Nessuna ricerca automatica: il profilo si sceglie con Sfoglia. Il supporto controlla solo la cartella scelta:
esistente, locale, senza collegamenti o junction, non sovrapposta alla cartella di installazione, con `config.json`
(file normale, primo carattere `{`) e `fluent-reader.db` (file normale con l'intestazione SQLite). I due file sono
aperti in sola lettura per i primi byte; non vengono letti impostazioni, feed, articoli o credenziali e nulla viene
modificato. Il percorso viene poi mostrato e va confermato. Nessuno strumento MCP viene invocato sul profilo scelto:
la prima prova con i propri dati la fa il proprietario.

### Claude Code

- **Client:** `claude.exe` indicato con Sfoglia o trovato con "Cerca" (solo su richiesta: `PATH`,
  `%USERPROFILE%\.local\bin\claude.exe`, `%USERPROFILE%\.vscode[-insiders]\extensions\anthropic.claude-code-<versione>-win32-x64\resources\native-binary\claude.exe`,
  la versione più recente per prima). Viene verificato con `claude --version` e con l'help di `claude mcp add-json` e
  `claude mcp remove`, che devono offrire `--scope`. Il setup non installa Claude Code.
- **Registrazione:** solo con la CLI ufficiale, mai riscrivendo `~/.claude.json`:
  `claude mcp add-json fluent-reader '{"type":"stdio","command":"<inst>\current\app\runtime\node.exe","args":["<inst>\current\app\server\dist\main.js","--profile-dir","<profilo>"],"env":{}}' --scope user`
  (forma documentata in https://code.claude.com/docs/en/mcp; il JSON passa come un unico argomento, senza shell).
- **Anteprima** (prima del consenso): nome, scope, eseguibile, entrypoint, profilo, file interessato
  (`%USERPROFILE%\.claude.json`), claude.exe e versione, azione (aggiunta, nessuna modifica, aggiornamento della voce
  creata in precedenza, oppure **sostituzione di una voce estranea**, che richiede una seconda conferma specifica).
  L'anteprima non mostra contenuti della configurazione (di una voce estranea solo comando e numero di argomenti e
  variabili) e non modifica nulla.
- **Al momento dell'installazione:** la configurazione deve essere ancora quella dell'anteprima (impronta), altrimenti
  nulla viene cambiato; copia di backup in `state\claude-config-backups`; intento annotato nel registro; eventuale
  `claude mcp remove` della voce sostituita; `claude mcp add-json`; **rilettura della voce effettivamente salvata dalla
  CLI**: diventa "dell'installer" solo se corrisponde a quella approvata, e nel registro si annota l'impronta SHA-256
  del suo JSON canonico **completo** (tutti i campi, anche annidati e sconosciuti; conta solo il contenuto, non l'ordine
  delle chiavi; gli array restano ordinati). Poi la verifica che tutti gli altri server MCP siano invariati.
- **Annullamento conservativo:** in caso di errore la voce viene rimossa solo se la sua impronta completa è ancora
  quella riletta dopo un `add-json` riuscito di questa stessa esecuzione; un `add-json` tentato o fallito non prova
  nulla. Una voce assente non richiede nulla; una voce cambiata, sostituita o non attribuibile resta com'è. La voce
  sostituita viene rimessa (identica) solo se il nome è ancora libero. Se l'annullamento non può completarsi, il
  messaggio lo dice ("serve un tuo intervento") e indica il backup; nulla viene sovrascritto con la forza.
- **JSON corrotto:** tutto si ferma, il file non viene modificato né ricreato.
- **`CLAUDE_CONFIG_DIR` impostata:** la posizione della configurazione non è documentata con precisione, quindi la
  registrazione automatica viene rifiutata (si può installare solo il server).
- Se si sceglie "Installa solo il server", Claude Code non viene toccato; per registrarlo più tardi basta eseguire di
  nuovo il setup (riparazione) e scegliere la registrazione.
- Chiudere le sessioni di Claude Code prima di installare: se un'altra modifica ai server MCP avviene durante la
  registrazione, la registrazione viene annullata e segnalata.

### Installazione, riparazione, aggiornamento

Installazione, riparazione (stessa versione) e aggiornamento (versione più vecchia nel registro) sono la stessa
**transazione**, descritta da un journal persistente `state\install-journal.json` (programma di supporto,
`installer\setup\transaction.ts`). Il journal è legato alla cartella di installazione, ha un identificativo di
transazione e un checksum; viene sostituito sempre tramite un nome temporaneo (rinomina atomica su NTFS). Un journal
illeggibile, alterato o di un'altra cartella non viene mai eseguito: il setup si ferma senza toccare nulla. Non
contiene dati di Claude Code né di Fluent Reader.

| Fase | Che cosa è già persistente quando inizia |
|---|---|
| `staging` | il journal, prima che esista `.staging` |
| `prepared` | `.staging` verificata con il proprio runtime (inventario, manifest, `node --version`, handshake MCP con gli otto strumenti su un profilo **sintetico**); il nuovo disinstallatore in `state\uninstall.exe.new`; copia del registro precedente in `state\install-record.previous.json`; per i nove valori HKCU del prodotto presenza, tipo e valore, e la presenza delle due chiavi |
| `swapping` | inizio delle due rinomine `current` → `previous`, `.staging` → `current` |
| `metadata` | nuova versione in `current`; poi nuovo registro, disinstallatore precedente spostato in `state\uninstall.exe.previous` e nuovo al suo posto, valori HKCU (ciascuno scritto e riletto) |
| `committed` | tutti i controlli superati: la nuova versione è definitiva |

Solo dopo `committed` vengono rimossi `previous`, le copie e il journal; se questa pulizia non riesce, la completa
l'esecuzione successiva del setup (senza mai ripristinare la versione vecchia).

**Recupero.** Ogni esecuzione del setup comincia con il recupero (`tx-recover`), e lo stesso recupero è il rollback
dopo un errore: una transazione non confermata viene annullata riconoscendo lo stato reale delle cartelle (nessuna,
la prima o entrambe le rinomine eseguite), rimettendo disinstallatore e registro precedenti (la copia è verificata
con il suo SHA-256), e poi i valori HKCU dal journal: ciascuno con il suo tipo (`REG_SZ`, `REG_EXPAND_SZ`,
`REG_DWORD`), o rimosso se prima non c'era; una chiave che prima non esisteva viene rimossa solo se è rimasta vuota
(se contiene valori di altri programmi resta, e non è un errore; se doveva sparire e resta, il recupero non è
dichiarato completo). Ogni passo è verificato; se uno non riesce, il journal e tutte le copie restano e il messaggio
dice "recupero INCOMPLETO". Il recupero è ripetibile: registro e disinstallatore precedenti sono riconosciuti dal loro
SHA-256 annotato nel journal, quindi un recupero interrotto dopo aver già rimesso un file e rimosso la sua copia viene
completato dal successivo; un file che non corrisponde all'hash non viene toccato e il recupero si ferma.
`previous` non viene mai cancellata in una transazione non confermata. Un valore HKCU già presente con un tipo che il
setup non sa ripristinare fedelmente (per esempio `REG_BINARY`, `REG_MULTI_SZ`, `REG_QWORD`, una stringa troppo lunga),
illeggibile, o una stringa `REG_SZ`/`REG_EXPAND_SZ` che contiene un a capo (CR o LF: il protocollo a righe non può
trasportarla fedelmente) ferma l'installazione **prima** dello scambio, senza alterare il valore. Una `.staging` o una
`previous` che esistono senza un journal non vengono rimosse automaticamente: il setup chiede di controllarle e
rimuoverle a mano. Ogni registro di installazione ha una **generazione** (l'identificativo della transazione che lo ha
scritto).

**Disinstallazione non conclusa.** Se nella cartella c'è lo stato di una disinstallazione (`state\uninstall.json`,
`state\uninstall-final.marker` o `state\uninstall-helper`), il setup non avvia alcuna installazione: se
`uninstall.exe` esiste ancora va eseguito per completarla; se non esiste più e resta il marcatore finale, il setup
propone di completarla da sé (vedi "Recupero da un nuovo setup"); negli altri casi quegli
elementi vanno cancellati a mano. Così nessuna installazione nuova eredita lo stato di una precedente.

Se la versione installata è in uso (Claude Code aperto) lo scambio non riesce e il recupero riporta tutto com'era. Il
percorso registrato in Claude Code (`current\app\...`) non cambia fra le versioni. Nessun aggiornamento automatico online.

### Disinstallazione

La disinstallazione è riprendibile (`installer\setup\uninstall.ts`):

1. **preflight senza modifiche:** registro (che deve indicare proprio questa cartella), nessuna installazione
   interrotta, inventari, nessun file estraneo né collegamento nelle cartelle dell'installazione, programma di
   supporto completo, stato della voce di Claude Code;
2. **voce di Claude Code:** rimossa solo se la sua impronta completa è ancora quella annotata. Esiti: non
   configurata, già assente, rimossa (si prosegue); modificata, non attribuibile, configurazione illeggibile,
   claude.exe non trovato (dopo l'eventuale ricerca, il disinstallatore spiega che la voce resterebbe in Claude Code
   puntando a file rimossi e chiede se proseguire, con "No" come scelta predefinita); errore della CLI o voce ancora
   presente (ci si ferma);
3. **copia di recupero del programma di supporto** (`node.exe` e `setup\`, con il proprio inventario e gli SHA-256
   dell'installazione) in `state\uninstall-helper`, poi il marcatore `state\uninstall.json` (fase `files`), legato
   alla generazione del registro;
4. **file:** soltanto quelli dell'inventario, tramite il registro di installazione;
5. marcatore in fase `metadata`, poi rimozione del registro di installazione;
6. soltanto i nove valori HKCU del prodotto (ogni errore ferma la disinstallazione); ciascuna delle due chiavi
   viene rimossa solo se è rimasta vuota, verificando l'esito (chiave con valori di altri: resta; chiave vuota che
   non si riesce a rimuovere: errore, la disinstallazione si ferma);
7. `un-finish`: **prima** viene scritto `state\uninstall-final.marker` (prodotto, cartella, generazione, elenco dei
   file della copia di recupero), poi rimosso il marcatore; nulla viene cancellato in questo passo;
8. senza più bisogno del programma di supporto, in quest'ordine: i file della copia di recupero (elenco esatto
   compilato nel disinstallatore dal payload, `helper-files.nsh`) e le sue cartelle, ogni `RMDir` verificato; il
   marcatore residuo `uninstall.json`; il marcatore finale; **per ultimo** `uninstall.exe`. Ogni errore prima
   dell'ultimo passo ferma la disinstallazione lasciando sia il marcatore finale sia il disinstallatore, quindi si può
   ripetere. Se il processo si interrompe dopo la rimozione del marcatore, resta al massimo `uninstall.exe`: non
   autorizza nulla (il disinstallatore non riconosce più la cartella) e non impedisce una nuova installazione, che lo
   sostituisce; se non si riesce a cancellarlo, lo si dice e la disinstallazione è comunque completa.

**Recupero da un nuovo setup.** Se resta il marcatore finale ma `uninstall.exe` non c'è più (per esempio è stato
cancellato a mano), la pagina della cartella del nuovo setup lo segnala e propone di completare la disinstallazione
precedente (`finish-uninstall`, con il programma di supporto del nuovo setup, mai quello cancellato). Lo fa solo se
nella cartella non c'è un'installazione (registro, journal, `current`/`.staging`/`previous`), se il marcatore finale è
valido per questa cartella e un eventuale `uninstall.json` ha la sua stessa generazione; in `state\uninstall-helper`
rimuove soltanto i file elencati nel marcatore finale, e un file non elencato ferma tutto senza toccarlo. Il marcatore
finale viene rimosso per ultimo, quindi anche questo passo si può ripetere.

Un nuovo tentativo è possibile dopo un errore in qualunque passo: il disinstallatore si avvia se trova il registro,
il marcatore o il marcatore finale; usa la copia di recupero verificata quando `current` è già in parte rimossa (prima
la prova eseguendo il programma di supporto); riprende dalla fase registrata nel marcatore; con il marcatore finale
completa da solo i passi 8, anche se la copia di recupero è già in parte cancellata. I marcatori non autorizzano
cancellazioni arbitrarie: le cartelle si rimuovono solo tramite un registro autentico; un marcatore di un'altra
generazione o alterato viene rifiutato; il marcatore finale è accettato solo se indica questa cartella e se non c'è un
registro di installazione, e consente solo di cancellare l'elenco compilato, `uninstall.exe` e se stesso. Se la copia
di recupero è alterata o non può essere creata, la disinstallazione si ferma e lo dice, senza rimuovere altro.

Il programma di supporto rimuove `current`, `.staging` o `previous` soltanto in un'installazione con registro
(percorsi canonici, nessun collegamento o junction, nessun `..`); senza registro rifiuta sempre: le cartelle di
un'installazione non ancora registrata le rimuove solo la transazione che le ha create, tramite il suo journal.
Non vengono toccati il profilo Fluent Reader (`fluent-reader.db`, `config.json`, articoli, feed), gli altri server
MCP, le altre impostazioni di Claude Code, il fork, i valori del registro di altri programmi e i backup della
configurazione in `state\claude-config-backups`, che restano finché l'utente non li cancella.

### Limiti delle verifiche

Il programma di supporto (journal, recupero, marcatori, rimozioni) è provato con test reali su cartelle
sintetiche, comprese le interruzioni in ogni fase. Le parti dello script NSIS (WriteUninstaller, letture e scritture
HKCU con advapi32 e le istruzioni `WriteReg*`/`DeleteReg*`, il controllo degli a capo, la verifica del marcatore
finale, la cancellazione della copia di recupero dall'elenco compilato, CopyFiles) sono verificate solo staticamente
e tramite un modello che le riproduce: vanno provate con l'installer compilato, compreso il caso di un processo
terminato durante l'installazione o la disinstallazione.

### Privacy

Il wizard dichiara che il profilo è letto in sola lettura, che il server non fa richieste di rete proprie, che i
risultati degli strumenti possono essere inviati da Claude Code al servizio Anthropic, che la beta espone otto
strumenti senza ricerca degli articoli e che non viene installato alcun servizio. Il setup non scrive file di log; i
messaggi e i file di risultato non contengono contenuti della configurazione Claude, del
database, URL dei feed, titoli o token. Il registro di installazione e i backup restano sulla macchina dell'utente.

## Registrazione manuale (alternativa)

Se la registrazione automatica non è possibile, da PowerShell 7.3 o successivo (Windows PowerShell 5.1 non passa
correttamente le virgolette ai programmi esterni):

```powershell
$app = "$env:LOCALAPPDATA\FluentReaderMCP\current\app"
$json = @{ type = "stdio"; command = "$app\runtime\node.exe"; args = @("$app\server\dist\main.js", "--profile-dir", "<cartella del profilo>"); env = @{} } | ConvertTo-Json -Compress
claude mcp add-json fluent-reader $json --scope user
claude mcp get fluent-reader
```

Una voce aggiunta a mano non è "dell'installer": il disinstallatore la lascia al suo posto
(`claude mcp remove fluent-reader --scope user` per toglierla).
