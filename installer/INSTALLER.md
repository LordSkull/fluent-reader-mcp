# Installer Windows (FR-MCP-04-BETA-02)

Installer NSIS per l'utente corrente (Windows 10/11 x64) costruito **a partire dal pacchetto portatile approvato**
(`fluent-reader-mcp-v<versione>-beta-win-x64.zip`, FR-MCP-04-BETA-01). Il server non viene ricompilato: l'installer
contiene esattamente i file del pacchetto, più il programma di supporto del setup.

Beta privata: nove strumenti in sola lettura per impostazione predefinita. Il pacchetto contiene anche quattro strumenti
di regole: `preview_rule_change` è in sola lettura; `add_rule`, `update_rule` e `delete_rule` scrivono solo dopo l'opt-in
manuale. Il wizard non aggiunge mai la variabile di abilitazione. Il builder continua a richiedere nel manifest i nove
strumenti predefiniti e l'auto-test MCP (a build e durante l'installazione, su un profilo sintetico) verifica sia i nove
senza variabile sia tutti i tredici con il valore esatto `1`.

Integrazioni con i client Claude:

- **Claude Desktop:** unico client configurato dal wizard, facoltativo, con selezione assistita del file di configurazione
  e consenso specifico; vedi "Claude Desktop" più sotto. Il collegamento reale va verificato nel client: i test automatici
  non lo provano.
- **Claude Code:** non più gestito dal wizard (né ricerca di `claude.exe`, né registrazione). Le voci create dalle beta
  0.1.0 e 0.1.1 restano al loro posto; vedi "Installazioni delle beta 0.1.x" e "Registrazione manuale".

Questo documento descrive il codice 0.1.3; il wizard Desktop-first esiste dalla versione 0.1.2. La build 0.1.1 già costruita registra invece in Claude
Code e chiede conferma della cartella con una finestra.

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
npm.cmd run installer:win -- --bundle "D:\FluentReaderMCP-build\fluent-reader-mcp-v0.1.3-beta-win-x64.zip" --bundle-sha256 <sha256 del bundle> --out "D:\FluentReaderMCP-build" --dry-run

# 2. Installer
npm.cmd run installer:win -- --bundle "D:\FluentReaderMCP-build\fluent-reader-mcp-v0.1.3-beta-win-x64.zip" --bundle-sha256 <sha256 del bundle> --out "D:\FluentReaderMCP-build"
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
   `installer/runtime-lock.json` (Node.js 24.22.1, hash dell'archivio ufficiale); entrypoint, nove strumenti predefiniti
   nel manifest e auto-test dei tredici dopo opt-in;
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
  FluentReaderMCP-Setup-v0.1.3-beta-win-x64.exe
  FluentReaderMCP-Setup-v0.1.3-beta-win-x64.exe.sha256
  FluentReaderMCP-Setup-v0.1.3-beta-win-x64.exe.build-report.json
```

Il report contiene SHA-256 e dimensione dell'installer, versione NSIS, commit degli script, e la provenienza del
pacchetto (nome file, SHA-256, commit, data, runtime); **nessun percorso locale**.

## Che cosa fa l'installer

Nessun servizio, nessuna porta, nessun processo residente, nessuna scrittura in `HKLM`, `RequestExecutionLevel user`
(niente UAC). Il server viene avviato da Claude Desktop quando serve.

Pagine: benvenuto (beta in sola lettura per impostazione predefinita) → cartella di installazione → profilo Fluent Reader (Sfoglia) → riepilogo
(destinazione, tipo di operazione, avvisi sulla posizione, profilo) e informativa privacy (conferma obbligatoria) →
Claude Desktop (registrare o installare solo il server; file di configurazione) → file e voce esatti, con il consenso
alla modifica → installazione → risultato e istruzioni.

Tutta la logica sta nel programma di supporto (`setup\installer\setup\fr-setup.js`), eseguito dal `node.exe`
incluso: i valori scelti dall'utente (percorsi, consenso) passano in un file di richiesta UTF-16LE, mai sulla riga di
comando; la risposta torna in un file di risultato. Prima dell'installazione il supporto gira da `%TEMP%` (cartella
dei plugin NSIS, cancellata alla chiusura).

### Cartella di installazione

Proposta: `%LOCALAPPDATA%\FluentReaderMCP`. Con **Sfoglia** si può scegliere un'altra cartella su qualsiasi unità
**locale** con lettera (`C:`, `D:`, `H:`...), anche fuori dalla cartella utente (FR-MCP-04-BETA-03A-SIMPLE-01). Il
controllo è del programma di supporto (`installer\setup\checks.ts`, `check-install-dir`).

Il flusso è **scelta → Avanti → controllo → pagina successiva**, senza finestre di conferma (DEC-B03). Una finestra
compare solo per un errore. Se il programma di supporto propone una destinazione diversa da quella scelta (`adjusted`:
radice, cartella dei programmi, cartella non vuota), il **campo della pagina** viene aggiornato con la destinazione
effettiva, il testo spiega perché e la pagina **resta aperta**: si prosegue con un secondo Avanti, oppure si sceglie
altro. Una destinazione diversa non viene mai usata dietro il pulsante Avanti. La pagina di riepilogo mostra poi
destinazione, tipo di operazione (nuova, riparazione, aggiornamento) e avvisi.

Lo stesso controllo viene ripetuto prima di ogni scrittura: se nel frattempo la cartella è cambiata (per esempio da
"nuova" a "riparazione"), l'installazione non parte.

| Scelta | Comportamento |
|---|---|
| Cartella nuova (non esiste) o vuota | Accettata se scrivibile; una cartella nuova viene creata solo all'inizio dell'installazione |
| Radice di un'unità (`D:\`) | Mai usata direttamente: viene proposta `D:\FluentReaderMCP`, controllata con tutte le regole |
| Sotto `Program Files` o `Program Files (x86)`, su qualsiasi unità (`D:\Program Files\FluentReaderMCP`) | Stesse regole di ogni altra cartella: decide il controllo di scrittura. In `C:\Program Files` un utente normale di solito non può scrivere: il setup lo dice, non si eleva e non modifica permessi |
| La cartella dei programmi stessa (`D:\Program Files`, o quella di `%ProgramFiles%`) | Mai usata direttamente: viene proposta la sottocartella `FluentReaderMCP` |
| Cartella estranea non vuota | I file presenti non vengono toccati: viene proposta la sottocartella `<cartella>\FluentReaderMCP`. Se anche quella contiene altri file, o se la cartella scelta si chiama già `FluentReaderMCP`, il setup chiede di sceglierne un'altra |
| La propria cartella utente (`%USERPROFILE%`) | Mai usata direttamente: viene proposta `%USERPROFILE%\FluentReaderMCP` |
| Installazione esistente di questo prodotto | Riconosciuta **solo** dal registro `fluent-reader-mcp.install.json` legato a quella cartella (o dal journal valido di un'installazione interrotta): stessa versione → **riparazione**, versione precedente → **aggiornamento**, versione più recente → rifiuto (downgrade non supportato) |
| Elementi con i nomi del prodotto (`current`, `state`, `uninstall.exe`...) senza registro né journal | Rifiuto: non vengono usati, sostituiti né rimossi; vanno controllati e spostati a mano |
| Registro copiato da un'altra cartella | Rifiuto |
| Cartella dentro un'altra installazione di Fluent Reader MCP | Rifiuto |
| Stato di una disinstallazione non conclusa | Rifiuto (vedi "Disinstallazione non conclusa") |

Sono **sempre rifiutati**:

- percorsi non locali: UNC (`\\server\...`), relativi, di dispositivo, con `.`/`..`, con nomi non validi o ambigui per
  Windows (nomi riservati come `CON`, segmenti che finiscono con punto o spazio);
- **unità di rete mappate** (il percorso reale porta a una cartella di rete; inoltre il wizard rifiuta le unità che
  Windows classifica come di rete) e **unità SUBST** (il percorso reale non coincide con quello scelto);
- **collegamenti simbolici, junction e nomi brevi 8.3** lungo il percorso: il setup chiede di scegliere direttamente la
  cartella reale, che indica nel messaggio;
- unità non disponibili (scollegate, inesistenti o non pronte);
- le cartelle riservate a Windows o ai dati comuni in radice di **ogni** unità (`Windows`, `ProgramData`,
  `System Volume Information`, `Recovery`, `$Recycle.Bin` e le cartelle di lavoro di setup e ripristino di Windows), e
  le cartelle indicate dalle variabili `SystemRoot`, `ProgramData`, `PUBLIC`;
- **profili Windows**: la propria cartella utente direttamente, la cartella di un altro utente o quella pubblica,
  `X:\Users` e `X:\Users\<account>\...` su qualsiasi unità (controllo sulla **forma** del percorso, non sui permessi:
  un profilo reindirizzato altrove con un nome diverso non viene riconosciuto);
- `Roaming` (`%APPDATA%`), OneDrive e `%USERPROFILE%\.claude`, sia dentro sia come contenitore;
- percorsi troppo lunghi perché il file più profondo resti sotto `MAX_PATH`;
- cartelle in cui non si può scrivere (DEC-C12): in una cartella esistente il setup crea e rimuove un file di prova;
  per una cartella nuova crea e rimuove, nella cartella esistente più vicina, una sottocartella di prova con dentro un
  file, perché Windows può permettere nuove cartelle ma non nuovi file (tipicamente nella radice di `C:`). Nessun
  permesso viene letto o modificato e nessuna elevazione viene chiesta.

**Unità rimovibili** (chiavette, dischi USB che Windows classifica come rimovibili): accettate, con un avviso nel
riepilogo: l'unità deve essere collegata **con la stessa lettera** ogni volta che Claude Desktop avvia il server e per
aggiornare o disinstallare. Un disco esterno che Windows classifica come fisso non riceve questo avviso.

**Fuori dalla cartella utente** il riepilogo avverte che, secondo i permessi di quella posizione, altri account del
computer potrebbero leggere o modificare i file installati. Il setup **non legge e non modifica permessi o ACL** e non
garantisce che una cartella fuori dal profilo sia protetta: la scelta della posizione resta dell'utente.

Non sono provati come destinazione supportata: unità ottiche, RAM disk, volumi FAT32/exFAT, cartelle sincronizzate da
programmi diversi da OneDrive, profili reindirizzati.

```text
%LOCALAPPDATA%\FluentReaderMCP\
  current\app\...                 pacchetto portatile (runtime\node.exe, server\dist\main.js, manifest.json)
  current\setup\...               programma di supporto del setup
  current\installer-files.json    inventario: i file che l'installer possiede
  fluent-reader-mcp.install.json  versione, profilo, registrazione in Claude Desktop (e quella storica in Claude Code)
  state\install-journal.json      solo durante un'installazione (con le copie di recupero accanto)
  state\uninstall*.               solo durante una disinstallazione (marcatori, copia del programma di supporto)
  uninstall.exe
```

#### Copie (backup) della configurazione

Prima di modificare un file di configurazione di Claude Desktop il setup ne salva una copia in:

```text
%LOCALAPPDATA%\FluentReaderMCP-Data\desktop-config-backups\<chiave>\claude_desktop_config.json.<data UTC>[-n].bak
```

Le copie di `%USERPROFILE%\.claude.json` prese dalle beta 0.1.x stanno, con le stesse regole, in
`%LOCALAPPDATA%\FluentReaderMCP-Data\claude-config-backups\<chiave>\claude.json.<data UTC>[-n].bak`: il nuovo wizard non
ne crea altre.

- **Non** nella cartella di installazione (che può stare su un volume o in una cartella leggibile da altri utenti) e
  non in `%LOCALAPPDATA%\FluentReaderMCP` (la cartella di installazione predefinita), ma in `FluentReaderMCP-Data`.
- **Possono contenere informazioni riservate**: l'intera configurazione del client, compresi token, chiavi API e
  variabili di altri server MCP. Non vanno condivise né allegate a segnalazioni.
- **Separate per installazione**: la `<chiave>` (32 caratteri esadecimali) deriva dalla cartella di installazione; è la
  stessa fra riparazioni e aggiornamenti della stessa cartella, diversa per due installazioni.
- Se `%LOCALAPPDATA%` manca, non è locale o non sta dentro il profilo utente, oppure se una delle cartelle è un
  collegamento o una junction, la modifica della configurazione viene **rifiutata**: nessuna copia viene salvata altrove (si
  può installare solo il server).
- Il setup non legge né modifica permessi: è l'archivio locale standard dell'utente Windows, non una garanzia di
  riservatezza su un sistema alterato. Il contenuto delle copie non viene mai mostrato né annotato (il registro di
  installazione conserva solo nome, cartella e SHA-256).
- **Migrazione dei backup precedenti:** le beta precedenti salvavano la copia in `<installazione>\state\claude-config-backups`.
  All'inizio di una riparazione o di un aggiornamento la copia che il registro di installazione indica esattamente viene
  spostata nella cartella personale (copia temporanea, confronto byte per byte, rinomina, nuovo confronto, annotazione
  nel registro, solo allora rimozione dell'originale); uno spostamento interrotto viene completato dal tentativo
  successivo.
- **Elementi legacy ambigui:** se in quella cartella c'è qualsiasi altro elemento (un'altra copia, un file con un nome
  qualsiasi, un collegamento), oppure se nella cartella personale esiste già un file con lo stesso nome e contenuto
  diverso, **nulla viene spostato, modificato o cancellato** e l'aggiornamento o la riparazione **non partono**. Il
  messaggio elenca gli elementi. Prima di intervenire: controllali e, se ti servono, **conservali in una cartella
  personale sicura del tuo account Windows** (non in una cartella condivisa); poi esegui di nuovo il setup. Non
  cancellarli senza averli controllati.
- **Mai cancellati automaticamente**: né da installazione, riparazione e aggiornamento, né dalla disinstallazione, che
  alla fine indica la cartella in cui restano.

Voci di registro (solo HKCU): `Software\Microsoft\Windows\CurrentVersion\Uninstall\FluentReaderMCP` e
`Software\FluentReaderMCP`.

### Profilo Fluent Reader

Nessuna ricerca automatica: il profilo si sceglie con Sfoglia. Il supporto controlla solo la cartella scelta:
esistente, locale, senza collegamenti o junction, non sovrapposta alla cartella di installazione, con `config.json`
(file normale, primo carattere `{`) e `fluent-reader.db` (file normale con l'intestazione SQLite). I due file sono
aperti in sola lettura per i primi byte; non vengono letti impostazioni, feed, articoli o credenziali e nulla viene
modificato. Il percorso viene poi mostrato e va confermato. Nessuno strumento MCP viene invocato sul profilo scelto:
la prima prova con i propri dati la fa il proprietario.

### Claude Desktop

Scelta tecnica (DEC-DESKTOP): integrazione conservativa del file JSON, compatibile con l'installer NSIS esistente. Un
pacchetto `.mcpb` resta un'alternativa futura. Modulo: `installer\setup\desktop.ts`.

**Quale file: selezione assistita.** Nessun metodo documentato stabilisce quale `claude_desktop_config.json` legga una
data installazione: la documentazione indica `%APPDATA%\Claude`, ma un'app in pacchetto (MSIX, Store, WinGet) può leggere
una copia privata in `%LOCALAPPDATA%\Packages\<pacchetto>\LocalCache\Roaming\Claude`, e **Modifica configurazione** può
aprire l'altro file (segnalazioni `anthropics/claude-code#26073` e `#25579`, senza risposta ufficiale al 2026-11-04); è
stata osservata anche una cartella `%LOCALAPPDATA%\Claude-Data\<identificatore>`. Quindi:

- `desktop-candidates` **elenca** in sola lettura i file con quel nome esatto: sotto `%APPDATA%`, `%LOCALAPPDATA%` e nelle
  copie private di un pacchetto, nelle cartelle il cui nome comincia con `Claude` e un livello sotto. Nessun percorso,
  famiglia di pacchetto o identificatore è scritto nel codice; i file non vengono aperti; collegamenti e junction non
  vengono seguiti.
- **Propone** un percorso solo se è quello della registrazione di questa installazione, oppure se è l'unico trovato e
  nessuna app in pacchetto rende possibile un altro file. Altrimenti il campo resta vuoto e l'utente indica il file.
- `desktop-check` accetta solo un file normale con quel nome, locale, raggiunto senza collegamenti, nelle cartelle
  dell'utente, fuori dalla cartella di installazione, con JSON valido. **Un file che non esiste non viene creato**:
  si apre una volta da Claude Desktop, oppure si installa solo il server.
- Nessun file viene modificato "per tentativi": cambia solo quello selezionato. Se poi non è quello giusto, si esegue di
  nuovo il setup e se ne seleziona un altro; la voce nel primo resta attribuibile e la disinstallazione la rimuove se è
  ancora quella.
- Selezionare non è verificare: né il wizard né la pagina finale dichiarano il collegamento riuscito. La prova è nel
  client (riavvio completo, `fluent-reader` con nove strumenti predefiniti; tredici soltanto dopo l'opt-in manuale).
- Se una policy ha `isLocalDevMcpEnabled` a 0 (`HKLM` poi `HKCU`, `SOFTWARE\Policies\Claude`; lettura con `reg query`),
  la registrazione non è disponibile e il server si installa comunque.

**Voce scritta:** esclusivamente `mcpServers.fluent-reader`, nella forma documentata per Claude Desktop:
`{"command":"<inst>\current\app\runtime\node.exe","args":["<inst>\current\app\server\dist\main.js","--profile-dir","<profilo>"]}`.

**Pagina di conferma** (`desktop-plan`, prima del consenso, senza modifiche): file selezionato, voce, eseguibile,
entrypoint, profilo, azione (aggiunta, nessuna modifica, aggiornamento della voce scritta in precedenza, oppure
**sostituzione di una voce estranea**, con una casella di autorizzazione specifica), cartella delle copie e avviso che la
selezione non è una verifica. Non mostra contenuti della configurazione (di una voce estranea solo comando e numero di
argomenti e variabili).

**Al momento dell'installazione** (dopo il commit della transazione: un errore qui non annulla il server):

1. la voce e il file devono essere ancora quelli della pagina (impronta), altrimenti nulla cambia;
2. copia nella cartella personale, confrontata con il contenuto letto;
3. intento annotato nel registro, con l'impronta SHA-256 del JSON canonico **completo** della voce che sta per essere
   scritta (così una voce trovata dopo un crash resta riconoscibile);
4. la modifica è fatta **sul testo**: il membro viene inserito o sostituito sul posto e ogni altro byte resta
   (formattazione, ordine delle chiavi, numeri che `JSON.parse` arrotonderebbe, BOM, chiavi ripetute altrove); il testo
   risultante viene analizzato e confrontato con l'originale: se differisce per altro, tutto si ferma;
5. file temporaneo accanto al target, scritto su disco e riletto; il target deve essere ancora identico a quanto letto,
   poi la rinomina. Il controllo non è atomico con la rinomina: una modifica in quell'istante non si vede;
6. rilettura della voce, poi stato `registered` nel registro.

**Annullamento conservativo:** se nulla è stato scritto non c'è nulla da annullare; se il file è ancora esattamente quello
scritto da questa esecuzione tornano i suoi byte precedenti; se altri l'hanno cambiato ma la voce è ancora nostra cambia
**solo la voce** (il vecchio file intero non viene mai rimesso sopra le modifiche di terzi); se la voce è stata cambiata
da altri resta com'è e il messaggio chiede un intervento, indicando la copia.

**Rifiuti senza modifiche:** JSON non valido o UTF-8 non valido (anche file vuoto), struttura diversa da un oggetto,
`mcpServers` che non è un oggetto, `mcpServers` o `fluent-reader` ripetute, file oltre 16 MiB. In tutti i casi si può
installare solo il server.

**Voce già presente:** è "dell'installer" solo se ha un'impronta annotata per quel file. Una voce estranea non viene
sostituita senza la casella specifica. Una voce identica a quella voluta ma non scritta dall'installer non cambia, non
viene considerata sua e la disinstallazione la lascia.

Prima di installare va chiusa Claude Desktop: il setup non termina processi, e sia il server in uso sia una riscrittura
del file da parte dell'app possono interferire. "Installa solo il server" non tocca Claude Desktop; per registrarlo più
tardi basta eseguire di nuovo il setup (riparazione).

### Installazioni delle beta 0.1.x

Le beta 0.1.0 e 0.1.1 registravano il server in Claude Code. Politica attuale:

- il campo `claude` del registro continua a essere letto e viene riportato da riparazioni e aggiornamenti (anche una
  transazione annullata lo ripristina); il nuovo campo `desktop` è facoltativo, e un registro senza di esso significa
  "nessuna registrazione in Claude Desktop";
- `~/.claude.json` è **solo letto**, per dire se la voce esiste ancora; il setup non avvia `claude.exe` e non migra nulla;
- la voce di Claude Code non viene modificata né rimossa, nemmeno dalla disinstallazione, e non implica una voce in
  Claude Desktop. La pagina di conferma e la fine della disinstallazione lo segnalano, indicando
  `claude mcp remove fluent-reader --scope user`;
- finché il server resta nella stessa cartella la voce continua a funzionare (`current\app\...` non cambia); un cambio di
  profilo fatto col nuovo wizard non la aggiorna.

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
| `prepared` | `.staging` verificata con il proprio runtime (inventario, manifest, `node --version`, handshake MCP con nove strumenti predefiniti e tredici dopo opt-in su un profilo **sintetico**); il nuovo disinstallatore in `state\uninstall.exe.new`; copia del registro precedente in `state\install-record.previous.json`; per i nove valori HKCU del prodotto presenza, tipo e valore, e la presenza delle due chiavi |
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

Se la versione installata è in uso (Claude Desktop aperto, oppure una sessione di Claude Code che usa la voce storica)
lo scambio non riesce (`attivazione della nuova versione (chiudi Claude Desktop se è aperto)`): la versione installata
resta al suo posto, ma il recupero automatico può fermarsi per il limite descritto sotto. Chiudere i client **prima** di
riparare o aggiornare. Il percorso registrato nel client (`current\app\...`) non cambia fra le versioni. Nessun
aggiornamento automatico online.

#### Limite noto del recupero

Il recupero **non è completamente automatico**. È automatico quando ogni elemento da rimettere a posto è attribuibile
con certezza (file del payload, copie verificate con lo SHA-256 annotato nel journal). Dopo `WriteUninstaller` (passo
4, scrittura di `state\uninstall.exe.new`) esistono invece file creati da questa transazione per i quali non c'è un
riferimento indipendente: il nuovo disinstallatore (`state\uninstall.exe.new` o, dopo la fase `metadata`,
`uninstall.exe`) e, se già scritto, il nuovo `fluent-reader-mcp.install.json`. Il nuovo disinstallatore viene rimosso
automaticamente solo se è identico a quello installato prima. Negli altri casi, dopo un errore o un crash successivo a
quel passo (per esempio nella preparazione, nello scambio bloccato da un file in uso, nella scrittura del registro di
Windows), il recupero **si ferma prima di qualsiasi modifica** e chiede un intervento manuale.

Come riconoscerlo:

- durante l'installazione: `Installazione non completata (<passo>) e ripristino INCOMPLETO`, preceduto dal messaggio del
  programma di supporto; `<passo>` è la fase in cui l'errore è avvenuto (per esempio `scrittura del disinstallatore`,
  `preparazione della transazione`, `attivazione della nuova versione`, `registro di installazione e disinstallatore`,
  `scrittura del registro di Windows (<valore>)`, `completamento dell'installazione`);
- al successivo avvio del setup: `il ripristino automatico non è possibile: questi elementi non sono attribuibili con
  certezza a Fluent Reader MCP ...: <elenco>`, poi `Nulla è stato rimosso, sostituito o spostato; il journal
  (state\install-journal.json) resta per la diagnosi`;
- `Il programma di supporto del setup non ha restituito un risultato verificabile (codice N)`: il programma di
  supporto è terminato (codice di uscita N) senza un file di risultato leggibile. **L'esito è incerto**: il passaggio
  può essersi fermato prima di qualsiasi scrittura oppure dopo aver già modificato qualcosa (per esempio dopo aver
  aperto la transazione e scritto il journal, se l'errore è avvenuto mentre scriveva il risultato); dal solo messaggio
  non si può stabilire quale dei due. Che cosa fare: non cancellare né modificare file a mano solo perché manca la
  risposta (in particolare `state\`, il journal, `current`, `previous`, `.staging` e i backup); esegui di nuovo la stessa
  operazione (setup o disinstallazione) sulla **stessa cartella**, così il controllo iniziale (`tx-recover` per il
  setup, i marcatori per la disinstallazione) riconosce lo stato reale e, quando può farlo con certezza, completa o
  annulla il passaggio interrotto. Se il nuovo tentativo segnala un ripristino o un recupero INCOMPLETO, fermati,
  controlla gli elementi che elenca e segui le indicazioni di questa sezione. Un nuovo avvio non garantisce il recupero
  automatico in tutte le condizioni;
- `recupero INCOMPLETO (...)`: un passo del recupero non è riuscito; journal e copie restano.

Come leggere l'elenco: ogni voce è un percorso **relativo alla cartella di installazione** mostrata nella conferma,
seguito tra parentesi dal motivo (per esempio `state\uninstall.exe.new (nuovo disinstallatore scritto da questa
transazione: ...)` o `fluent-reader-mcp.install.json (registro scritto da questa transazione ...)`). Che cosa fare:

1. non eseguire il disinstallatore e non cancellare `state\`, il journal, `current`, `previous` o `.staging`;
2. controlla **solo** gli elementi elencati: se sono stati creati da questa installazione interrotta di Fluent Reader MCP
   (data e ora coincidono con il tentativo appena fallito) puoi rimuoverli; se non sei sicuro, spostali in una cartella
   personale invece di cancellarli;
3. esegui di nuovo il setup e scegli la stessa cartella: il recupero riparte dal journal.

Un elemento non elencato non va toccato. Se il messaggio indica altro (una cartella `.staging` o `previous` senza
journal, una copia alterata), il setup non lo rimuove: va controllato a mano prima di riprovare.

### Disinstallazione

La disinstallazione è riprendibile (`installer\setup\uninstall.ts`):

1. **preflight senza modifiche:** registro (che deve indicare proprio questa cartella), nessuna installazione
   interrotta, inventari, nessun file estraneo né collegamento nelle cartelle dell'installazione, programma di
   supporto completo, stato della voce di Claude Desktop;
2. **voce di Claude Desktop:** rimossa, sul testo del file così com'è in quel momento, solo se la sua impronta completa è
   ancora quella annotata; nessuna copia viene ripristinata sopra il file. Esiti: non configurata, già assente, file non
   più presente, rimossa (si prosegue); modificata da altri o file illeggibile/non più accettabile (il disinstallatore
   spiega che la voce resterebbe in Claude Desktop e chiede se proseguire, con "No" come scelta predefinita); errore di
   scrittura o file cambiato in quell'istante (ci si ferma, si può ripetere). La voce lasciata in un file selezionato in
   precedenza viene rimossa alle stesse condizioni, oppure segnalata. La voce storica di Claude Code non viene toccata;
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
MCP, le altre impostazioni di Claude Desktop, Claude Code, il fork, i valori del registro di altri programmi e le copie
della configurazione in `%LOCALAPPDATA%\FluentReaderMCP-Data\`, che restano finché l'utente non
decide che cosa farne (alla fine il disinstallatore mostra la cartella in cui sono). Un file estraneo nelle cartelle
dell'installazione ferma la disinstallazione nel preflight, prima di qualsiasi rimozione.

### Limiti delle verifiche

Il programma di supporto (journal, recupero, marcatori, rimozioni) è provato con test reali su cartelle
sintetiche, comprese le interruzioni in ogni fase. Le parti dello script NSIS (WriteUninstaller, letture e scritture
HKCU con advapi32 e le istruzioni `WriteReg*`/`DeleteReg*`, il controllo degli a capo, la verifica del marcatore
finale, la cancellazione della copia di recupero dall'elenco compilato, CopyFiles) sono verificate solo staticamente
e tramite un modello che le riproduce: vanno provate con l'installer compilato, compreso il caso di un processo
terminato durante l'installazione o la disinstallazione. La modifica del file di Claude Desktop è provata con fixture
sintetiche: **nessun test automatico dimostra che Claude Desktop reale legga il file selezionato o carichi i nove
strumenti predefiniti o i tredici opt-in**. Vanno provati anche l'aspetto delle pagine (testo aggiornato in pagina, lunghezza delle righe) e il
comportamento su `LocalCache` di un'app in pacchetto. La checklist del collaudo manuale (con le prove distruttive
riservate a una VM o a un ambiente sacrificabile) è in [WINDOWS-SMOKE-TEST.md](WINDOWS-SMOKE-TEST.md).

### Privacy

Il wizard dichiara che il server usa il profilo in sola lettura **per impostazione predefinita**, che non fa richieste di
rete proprie, che i risultati possono essere inviati da Claude Desktop al servizio Anthropic, che la beta espone nove
strumenti in sola lettura per default e tredici solo dopo opt-in manuale (tre possono allora modificare regole), e che
non viene installato alcun servizio. Il setup non scrive file di log; i
messaggi e i file di risultato non contengono contenuti della configurazione Claude, del
database, URL dei feed, titoli o token. Il registro di installazione e i backup restano sulla macchina dell'utente.

## Registrazione manuale

**Claude Desktop**, se la registrazione del wizard non è possibile: dopo una copia di sicurezza, aggiungi nella sezione
`mcpServers` del file che Claude Desktop usa davvero la voce `fluent-reader` indicata in "Claude Desktop" (nel JSON le
barre rovesciate vanno raddoppiate), lasciando intatto il resto, poi riavvia del tutto l'app.

Per abilitare le tre scritture di regole, aggiungi manualmente alla stessa voce `"env": {"FLUENT_READER_MCP_ENABLE_RULE_WRITES":"1"}` e riavvia del tutto il client. Il setup non lo fa e una voce modificata a mano non è più attribuibile all'installer: riparazione e disinstallazione restano conservative. Per scrivere regole Fluent Reader deve essere chiuso; togliendo la variabile e riavviando si torna ai nove strumenti in sola lettura.

**Claude Code**, che il wizard non configura: da PowerShell 7.3 o successivo (Windows PowerShell 5.1 non passa
correttamente le virgolette ai programmi esterni):

```powershell
$app = "$env:LOCALAPPDATA\FluentReaderMCP\current\app"
$json = @{ type = "stdio"; command = "$app\runtime\node.exe"; args = @("$app\server\dist\main.js", "--profile-dir", "<cartella del profilo>"); env = @{} } | ConvertTo-Json -Compress
claude mcp add-json fluent-reader $json --scope user
claude mcp get fluent-reader
```

Una voce aggiunta a mano non è "dell'installer": il disinstallatore la lascia al suo posto (in Claude Code,
`claude mcp remove fluent-reader --scope user` per toglierla).
