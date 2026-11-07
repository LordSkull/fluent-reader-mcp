# Collaudo manuale dell'installer Windows (FR-MCP-04-BETA-UX-01)

Checklist per il proprietario della repository: collaudo del wizard NSIS **compilato** di Fluent Reader MCP prima di
qualsiasi distribuzione. I test automatici (`npm.cmd test`) provano il programma di supporto su cartelle e configurazioni
sintetiche e lo script NSIS solo staticamente; questa checklist copre ciò che resta: il wizard reale, Windows, **Claude
Desktop reale**.

Vale per il wizard Desktop-first della build **0.1.3** (comportamento introdotto nella 0.1.2). **Non si applica alla build 0.1.1 già costruita**, che registra in Claude Code e conferma
la cartella con una finestra: per quella resta la versione di questo documento al commit `bd3337d`.

Riferimenti per il comportamento atteso: [INSTALLER.md](INSTALLER.md) (installer, recupero, disinstallazione) e
[PACKAGING.md](PACKAGING.md) (pacchetto portatile). In caso di differenza fra questa checklist e il comportamento
osservato, annota la differenza: non adattare l'esito atteso a quello osservato.

## Percorso rapido (da qui si comincia)

Non serve eseguire tutte le prove una alla volta. Queste otto, in quest'ordine, coprono i percorsi principali e danno una
risposta utile. Le altre si eseguono se una di queste fallisce, o quando serve una verifica più ampia prima di una
distribuzione.

| # | Che cosa | Prove | Dove | Tempo |
|---|---|---|---|---|
| 1 | Si prepara una copia di sicurezza indipendente e si annota quale file apre **Modifica configurazione** | C.3, C.4, C.5 | Qualsiasi | 10 min |
| 2 | Cartelle: valida senza finestre, `D:\` mostrata nel campo, `D:\Windows` rifiutata, `D:\Program Files (x86)\FRMCP` accettata, `C:\Program Files\FRMCP` rifiutata con messaggio chiaro; poi **Annulla** | N-03, N-04, N-08, N-19 | Anche la macchina personale: non installa nulla | 5 min |
| 3 | Installazione con registrazione nel file giusto | N-13 | Account di prova o VM | 5 min |
| 4 | **La prova che conta:** Claude Desktop reale mostra `fluent-reader` con sedici strumenti e le altre voci, come `foundry-mcp`, funzionano ancora | N-14, N-15 | Come il passo 3 | 5 min |
| 5 | Più file candidati: il setup non sceglie da solo e tocca solo quello selezionato | N-20 | Come il passo 3 | 5 min |
| 6 | Riparazione ripetuta: nessuna modifica al file, nessun nuovo backup | U-02 | Come il passo 3 | 5 min |
| 7 | Sopra un'installazione Code-first, se ne hai una di prova: Code intatto | U-08 | Come il passo 3 | 5 min |
| 8 | Disinstallazione: via solo `fluent-reader`, gli altri server e i backup restano | D-01, D-05 | Solo VM, snapshot o account di prova | 5 min |

**Automatiche: non vanno ripetute a mano.** JSON vuoto, non valido o con struttura diversa; voce estranea; modifica
concorrente; errore di scrittura; annullamento conservativo; voce modificata da terzi alla disinstallazione; BOM, CRLF e
byte invariati; policy; proposte con più candidati. Sono in `test/packaging/setup-helper.test.ts`, `setup-lifecycle.test.ts`
e `nsis-script.test.ts`, su sole fixture sintetiche. **Non dimostrano che Claude Desktop reale legga il file selezionato**:
per questo esiste il passo 4.

**Manuali avanzate:** le altre prove delle categorie 1 e 2 (sezioni D ed E). **Solo in ambiente isolato:** categoria 3
(interruzioni, file bloccati, recupero manuale, sezioni F e G).

## A. Scopo e prerequisiti

| Elemento | Che cosa annotare |
|---|---|
| Installer | Nome del file (`FluentReaderMCP-Setup-v<versione>-beta-win-x64.exe`), versione dichiarata, commit e `scriptsDirty` dal `.build-report.json` accanto |
| Identità dell'EXE | SHA-256 calcolato sul file (`Get-FileHash -Algorithm SHA256 <exe>`), confrontato con il `.sha256` e con il report accanto all'EXE |
| Windows | Edizione, versione e build (`winver`), architettura x64 |
| Claude Desktop | Presente o no; versione (Guida o Informazioni); tipo di installazione (`Get-AppxPackage *Claude*` per sapere se è un pacchetto: annota solo se presente e il nome) |
| Claude Code | Solo per U-08: presente o no; versione (`claude --version`) |
| Profilo Fluent Reader | Presente o no; si usa **una copia** (vedi C) |
| Unità secondarie | Lettere disponibili (`D:`, `H:`...), tipo (fisso, rimovibile), file system. **Facoltative**: le prove che ne hanno bisogno si segnano NON ESEGUITO se l'unità non c'è |
| Ambiente | Macchina personale, account Windows di prova, VM o snapshot: indicarlo per ogni prova (sezione H) |

**Quale EXE.** Il collaudo che vale è quello su una build pulita **0.1.3** (`FluentReaderMCP-Setup-v0.1.3-beta-win-x64.exe`,
`gitDirty: false` e `scriptsDirty: false` nei report). Sopra una 0.1.0, 0.1.1 o 0.1.2 il setup propone un **aggiornamento**, sopra
la stessa 0.1.3 una **riparazione**; una versione più recente viene rifiutata. Lo SHA-256 dell'EXE si **annota a
ogni collaudo** dal file effettivamente provato: non esiste un valore fisso in questo documento, perché cambia a ogni
ricompilazione.

## B. Classificazione delle prove

Ogni prova ha una categoria. **Non eseguire una prova in un ambiente meno isolato di quello richiesto dalla sua
categoria.**

**Categoria 1 — reversibili.** Non installano nulla: apertura del wizard, navigazione fra le pagine, scelta e rifiuto
delle cartelle, lettura dei messaggi, annullamento prima dell'installazione, verifica dei sedici strumenti su un ambiente
di prova. L'unica scrittura è la prova che il controllo della cartella crea e rimuove subito (un file nella cartella
esistente, oppure una sottocartella di prova nella cartella esistente più vicina). Ambiente: anche la macchina personale.

**Categoria 2 — modificano configurazioni.** Registrazione in Claude Desktop, nuova installazione, riparazione,
aggiornamento, creazione e migrazione dei backup. Scrivono file, valori HKCU e (con il consenso) il
`claude_desktop_config.json` selezionato. Ambiente: preferibilmente un **account Windows di prova** o una VM, con copie di
sicurezza indipendenti (sezione C) fatte prima di iniziare. Sulla macchina personale, solo con la tua decisione esplicita e
con la copia indipendente del punto C.4.

**Categoria 3 — intenzionalmente distruttive.** Disinstallazione, simulazione di errori, interruzione dei processi,
recupero manuale, file bloccati, artefatti residui. Ambiente: **solo** VM, snapshot o installazione sacrificabile.
Nessuna di queste prove va eseguita sul profilo personale reale né sulla configurazione di Claude di uso quotidiano.

## C. Preparazione dell'ambiente

1. **Snapshot o account di prova.** Per le categorie 2 e 3: crea uno snapshot della VM (annota nome e data) oppure
   usa un account Windows dedicato, dove la configurazione di Claude Desktop è quella dell'account di prova.
2. **Configurazione Claude Desktop sintetica.** Nell'ambiente di prova apri Claude Desktop una volta, chiudilo, e
   annota **quale file apre Impostazioni → Modifica configurazione**. Aggiungi a mano una o due voci MCP fittizie senza
   segreti, per verificare che restino invariate. Nessun token, nessuna chiave; `foundry-mcp` è il caso di regressione
   da conservare, se presente:

   ```json
   { "mcpServers": { "smoke-other": { "command": "C:\\Windows\\System32\\cmd.exe", "args": ["/c", "exit"] } } }
   ```

   Non usare negli esempi o nelle evidenze chiavi API, token, URL privati o voci della propria configurazione reale.
3. **Copia del profilo Fluent Reader.** Chiudi Fluent Reader e copia la cartella del profilo (con `config.json` e
   `fluent-reader.db`) in una cartella di prova, per esempio `D:\FRMCP-smoke\profilo`. Il setup va puntato sulla
   copia, non sul profilo originale.
4. **Copie di sicurezza indipendenti.** Prima di ogni prova di categoria 2 o 3, copia in una **cartella personale
   sicura** dell'account (per esempio `%USERPROFILE%\FRMCP-smoke\backup-<data>`, non condivisa, non sincronizzata):
   **ogni** `claude_desktop_config.json` presente (`%APPDATA%\Claude`, le copie sotto `%LOCALAPPDATA%\Packages\Claude_*`,
   eventuali altre cartelle `Claude*`), `%USERPROFILE%\.claude.json` se esiste, la cartella del profilo usata e, se esiste,
   `%LOCALAPPDATA%\FluentReaderMCP-Data`. Queste copie contengono dati riservati: non vanno condivise né allegate a
   segnalazioni. **Il contenuto di quei file non va mai inviato** a nessuno, nemmeno per la review.
5. **Hash iniziali.** Con Claude Desktop e Fluent Reader chiusi, registra gli SHA-256 degli elementi verificati in una
   cartella di evidenze personale:

   ```powershell
   $ev = "$env:USERPROFILE\FRMCP-smoke\evidence"
   New-Item -ItemType Directory -Force $ev | Out-Null
   Get-ChildItem -LiteralPath "D:\FRMCP-smoke\profilo" -Recurse -File | Get-FileHash -Algorithm SHA256 |
       Select-Object Hash, Path | Export-Csv "$ev\profilo-prima.csv" -NoTypeInformation
   # sostituisci con il file annotato al punto 2
   $cfg = "$env:APPDATA\Claude\claude_desktop_config.json"
   Get-FileHash -Algorithm SHA256 $cfg | Select-Object Hash, Path | Export-Csv "$ev\desktop-config-prima.csv" -NoTypeInformation
   ```

   Il confronto si fa con
   `Compare-Object (Import-Csv "$ev\profilo-prima.csv") (Import-Csv "$ev\profilo-dopo.csv") -Property Hash, Path`.
   Claude Desktop può riscrivere il proprio file (preferenze): l'hash serve a confrontare il backup del setup con lo stato
   subito prima dell'installazione; l'invarianza delle altre voci si verifica confrontando il JSON nell'ambiente sintetico:
   `(Get-Content -Raw $cfg | ConvertFrom-Json).mcpServers | ConvertTo-Json -Depth 10`.
6. **Chiusura delle applicazioni.** Prima di installare, riparare, aggiornare o disinstallare: chiudi del tutto Claude
   Desktop (anche dall'area di notifica) e Fluent Reader, salvo nelle prove che richiedono esplicitamente un'applicazione
   aperta. Il setup non termina processi.
7. **Installazioni principali e secondarie.** Usa cartelle di prova dedicate e annotale (per esempio installazione
   principale nella cartella predefinita, secondaria in `D:\FRMCP-smoke\inst2`). Non installare due prove nella stessa
   cartella se la prova non lo chiede. Le copie della configurazione sono separate per cartella di installazione.
8. **Ripristino dello snapshot.** Dopo le prove di categoria 3, e ogni volta che un esito è FAIL o incerto, ripristina
   lo snapshot (o elimina l'account di prova) invece di riparare a mano; annota quando lo hai fatto. Sulla macchina
   personale, dopo una prova di categoria 2, ripristina dalla copia del punto 4 solo i file che hai salvato tu.

## D. Nuova installazione

Formato di ogni prova: **Preparazione** · **Azione** · **Atteso** · **Fallimento** · **Evidenza**. Le prove di
categoria 1 si fermano con **Annulla** prima della pagina di installazione.

**N-01 — Avvio del wizard** (cat. 1)
- Preparazione: EXE identificato (sezione A).
- Azione: avvia l'EXE; avvialo una seconda volta mentre il primo è aperto.
- Atteso: nessuna richiesta UAC; pagina di benvenuto con i sedici strumenti e le modifiche solo su richiesta esplicita; la seconda istanza dice che il setup è
  già in esecuzione.
- Fallimento: richiesta di elevazione, avvio di due wizard, errore all'avvio.
- Evidenza: screenshot della pagina di benvenuto; versione mostrata.

**N-02 — Informativa sui sedici strumenti e sulle modifiche** (cat. 1)
- Preparazione: wizard aperto.
- Azione: leggi benvenuto e pagina di riepilogo/informativa.
- Atteso: sedici strumenti senza attivazioni; tre possono cambiare le regole RSS, con Fluent Reader chiuso e dopo un backup,
  e uno salva le preferenze in un file privato fuori dal profilo, soltanto su richiesta esplicita; il database resta in sola
  lettura; la ricerca degli articoli lavora solo sui dati già salvati;
  nessun servizio Windows; il server non fa richieste di rete proprie; i risultati possono essere inviati da Claude
  Desktop al servizio Anthropic.
- Fallimento: "sette" o "otto" strumenti, ricerca "non disponibile", affermazioni diverse da INSTALLER.md.
- Evidenza: screenshot delle due pagine.

**N-03 — Cartella predefinita, nessuna finestra** (cat. 1)
- Preparazione: `%LOCALAPPDATA%\FluentReaderMCP` assente.
- Azione: pagina della cartella, Avanti senza cambiare nulla.
- Atteso: **nessuna finestra** «Continuare con questa cartella?»; si passa direttamente alla pagina del profilo; il
  riepilogo mostra destinazione `%LOCALAPPDATA%\FluentReaderMCP` e "Nuova installazione". Tornando indietro la cartella è
  ancora assente.
- Fallimento: finestra di conferma; destinazione diversa da quella mostrata; cartella creata prima dell'installazione.
- Evidenza: screenshot del riepilogo; `Test-Path` della cartella dopo Annulla.

**N-04 — Radice `D:\`** (cat. 1, se `D:` esiste)
- Azione: Sfoglia → `D:\`, Avanti.
- Atteso: la pagina **resta**; il campo ora mostra `D:\FluentReaderMCP` e il testo dice perché; nessuna finestra. Un secondo
  Avanti prosegue con quella destinazione.
- Fallimento: si passa alla pagina successiva senza che il campo sia cambiato; proposta di installare direttamente in
  `D:\`; testo tagliato o illeggibile.
- Evidenza: screenshot della pagina dopo il primo Avanti.

**N-05 — Unità `H:\`** (cat. 1, solo se disponibile; altrimenti NON ESEGUITO)
- Azione: Sfoglia → `H:\`, poi una sottocartella nuova.
- Atteso: come N-04; se `H:` è rimovibile, il riepilogo avverte che l'unità deve avere sempre la stessa lettera.
- Fallimento: accettazione della radice; avviso mancante su unità rimovibile.
- Evidenza: tipo di unità (`Get-Volume -DriveLetter H`), screenshot del riepilogo.

**N-06 — Cartella nuova e cartella vuota** (cat. 1)
- Preparazione: `D:\FRMCP-smoke\vuota` creata vuota; `D:\FRMCP-smoke\nuova` inesistente.
- Azione: scegli l'una e poi l'altra.
- Atteso: entrambe accettate senza finestre; quella inesistente non viene creata finché l'installazione non parte; nessun
  residuo del controllo di scrittura; nel riepilogo, fuori dalla cartella utente, avviso sui permessi della posizione.
- Fallimento: rifiuto; creazione anticipata; elementi `.fluent-reader-mcp-check-*` residui; avviso mancante.
- Evidenza: screenshot del riepilogo; `Get-ChildItem -Force D:\FRMCP-smoke` dopo Annulla.

**N-07 — Cartella estranea non vuota** (cat. 1)
- Preparazione: `D:\FRMCP-smoke\estranea` con un file di testo qualsiasi.
- Azione: scegli `estranea`, Avanti; poi crea `estranea\FluentReaderMCP` con un file e riprova; poi scegli direttamente una
  cartella chiamata `FluentReaderMCP` non vuota.
- Atteso: al primo Avanti la pagina resta e il campo mostra `estranea\FluentReaderMCP`, file esistenti mai toccati; se anche
  la sottocartella contiene file, o se la cartella scelta si chiama già `FluentReaderMCP`, un errore chiede di sceglierne
  un'altra.
- Fallimento: uso della cartella non vuota; cambio di destinazione non visibile; qualsiasi file estraneo modificato.
- Evidenza: screenshot, messaggi; hash dei file di prova prima e dopo.

**N-08 — Cartelle riservate e profili** (cat. 1)
- Azione: prova `C:\Windows`, `D:\Windows`, `C:\ProgramData\FRMCP`, `D:\ProgramData`, `%USERPROFILE%` (atteso: il campo mostra
  `%USERPROFILE%\FluentReaderMCP`), `%APPDATA%\FRMCP`, `C:\Users\Public\FRMCP`, una cartella OneDrive se presente,
  `%USERPROFILE%\.claude\FRMCP`.
- Atteso: rifiuto con motivo per ciascuna (salvo la proposta per `%USERPROFILE%`).
- Fallimento: una qualsiasi accettata così com'è.
- Evidenza: elenco percorso → messaggio.

**N-09 — Collegamento simbolico e junction** (cat. 1)
- Preparazione: `New-Item -ItemType Directory D:\FRMCP-smoke\reale`;
  `New-Item -ItemType Junction -Path D:\FRMCP-smoke\junction -Target D:\FRMCP-smoke\reale`; un collegamento simbolico
  solo se il sistema lo consente (modalità sviluppatore o diritti adeguati), altrimenti NON ESEGUITO.
- Azione: scegli `junction` e una sottocartella di `junction`.
- Atteso: rifiuto; il messaggio indica la cartella reale da scegliere.
- Fallimento: accettazione; scrittura attraverso il collegamento.
- Evidenza: messaggio; al termine rimuovi solo la junction creata da te (`Remove-Item D:\FRMCP-smoke\junction`, che
  non tocca il contenuto della destinazione).

**N-10 — Unità di rete e SUBST** (cat. 1)
- Preparazione: `subst T: D:\FRMCP-smoke\reale`; un'unità di rete mappata solo se ne esiste già una o se è disponibile
  una condivisione di prova (altrimenti NON ESEGUITO); un percorso UNC `\\<computer>\<condivisione>\FRMCP` se esiste.
- Azione: scegli `T:\FRMCP`, l'unità di rete, il percorso UNC.
- Atteso: tutti rifiutati (non locali o percorso reale diverso da quello scelto).
- Fallimento: uno qualsiasi accettato.
- Evidenza: messaggi; al termine `subst T: /D`.

**N-11 — Unità rimovibile** (cat. 1, solo se disponibile)
- Azione: scegli una cartella su chiavetta USB classificata da Windows come rimovibile.
- Atteso: accettata con avviso sulla lettera di unità nel riepilogo.
- Fallimento: avviso assente; rifiuto senza motivo.
- Evidenza: `Get-Volume` (DriveType), screenshot del riepilogo.

**N-12 — Installazione del solo server** (cat. 2)
- Preparazione: sezione C completa; cartella nuova di prova; copia del profilo.
- Azione: profilo con Sfoglia → conferma informativa → "Installa solo il server" → installazione.
- Atteso: la pagina di conferma della modifica non compare; installazione completata; struttura come in INSTALLER.md
  (`current\app`, `current\setup`, `current\installer-files.json`, `fluent-reader-mcp.install.json`, `uninstall.exe`); nessun
  `state\install-journal.json` residuo; voce in "App installate" per l'utente corrente; `claude_desktop_config.json` non
  modificato (hash uguale); nessuna cartella `desktop-config-backups`.
- Fallimento: errori; journal o `.staging`/`previous` residui; voce MCP aggiunta.
- Evidenza: elenco della cartella (`Get-ChildItem -Force`), hash del file prima/dopo.

**N-13 — Registrazione in Claude Desktop** (cat. 2, solo ambiente di prova)
- Preparazione: Claude Desktop chiuso; hash del file annotato in C.2 registrato subito prima; voci fittizie presenti.
- Azione: pagina Claude Desktop: lascia il percorso proposto o indica il file annotato in C.2 con Sfoglia → Avanti →
  leggi la pagina di conferma → spunta l'autorizzazione → Installa.
- Atteso: nessuna ricerca di `claude.exe`, nessuna menzione di Claude Code come client; la pagina di conferma mostra il
  file selezionato, `mcpServers.fluent-reader`, eseguibile `<installazione>\current\app\runtime\node.exe`, entrypoint, profilo,
  la cartella delle copie e l'avviso che la selezione non è una verifica; nessun contenuto della configurazione. Senza
  spunta non si prosegue. Alla fine il messaggio non dichiara il collegamento riuscito e chiede di verificarlo nell'app.
  Nel file: la voce come da pagina, le voci fittizie e il resto identici (byte per byte fuori dalla voce).
- Fallimento: voce diversa dalla pagina; altre voci, preferenze o formattazione cambiate; un altro file modificato; contenuti
  mostrati; collegamento dichiarato riuscito.
- Evidenza: screenshot della pagina (senza dati personali), confronto del file nell'ambiente sintetico.

**N-14 — Sedici strumenti in Claude Desktop reale** (cat. 1 sull'ambiente di prova già installato)
- Preparazione: installazione di N-13; copia del profilo.
- Azione: chiudi del tutto Claude Desktop (anche dall'area di notifica), riaprilo, guarda i server MCP locali nelle
  impostazioni e l'elenco degli strumenti di `fluent-reader`.
- Atteso: server connesso; esattamente `add_rule`, `apply_news_preferences_change`, `delete_rule`, `get_article`, `get_group`, `get_news_preferences`, `get_rule_chain`, `get_source`, `list_articles`, `list_groups`, `list_rules`, `list_sources`, `preview_news_preferences_change`, `preview_rule_change`, `search_articles`, `update_rule`; le voci fittizie ancora presenti.
  Nessuna variabile di attivazione nella voce. Controlla anche che il client chieda conferma per gli strumenti che scrivono, secondo le sue impostazioni.
- Fallimento: uno strumento in meno o in più; altre voci sparite. **Server assente:** non è ancora un difetto
  dell'installer: controlla se il file selezionato è quello attivo (C.2, N-20), ed è comunque un'osservazione da annotare,
  con la versione e il tipo di installazione di Claude Desktop.
- Evidenza: elenco dei nomi (non risultati con dati personali); file selezionato; tipo di installazione.

**N-15 — Lettura dei dati Fluent Reader** (cat. 1 su copia del profilo)
- Azione: in Claude Desktop chiedi l'elenco delle fonti (`list_sources`), un articolo (`get_article`), una ricerca
  (`search_articles`).
- Atteso: risposte coerenti con il profilo; nessun errore di database o di lock.
- Fallimento: errori; dati di un altro profilo.
- Evidenza: esito (sì/no) e codici di errore; **non** annotare titoli, URL o contenuti degli articoli.

**N-16 — Profilo non modificato** (cat. 1)
- Azione: chiudi Claude Desktop; ricalcola `profilo-dopo.csv` come in C.5 e confrontalo.
- Atteso: nessuna differenza di hash, nessun file nuovo o rimosso.
- Fallimento: qualsiasi differenza non spiegata da un uso di Fluent Reader fra le due misure.
- Evidenza: output di `Compare-Object` (vuoto se PASS).

**N-17 — Backup nella cartella privata** (cat. 2)
- Azione: dopo N-13, elenca `%LOCALAPPDATA%\FluentReaderMCP-Data\desktop-config-backups\`.
- Atteso: una sottocartella `<chiave>` (32 caratteri esadecimali) con `claude_desktop_config.json.<data UTC>.bak`; il suo
  SHA-256 coincide con l'hash del file preso subito prima dell'installazione (C.5).
- Fallimento: backup assente, in un'altra cartella, o con hash diverso.
- Evidenza: nome del file e confronto degli hash. Non aprire né allegare il backup.

**N-18 — Nessun backup sotto la cartella di installazione** (cat. 1)
- Azione: `Get-ChildItem -LiteralPath "<installazione>" -Recurse -Force -Filter *.bak`.
- Atteso: nessun file.
- Fallimento: qualsiasi copia della configurazione nella cartella di installazione.
- Evidenza: output del comando.

**N-19 — Program Files** (cat. 1)
- Azione: prova `D:\Program Files\FRMCP` e `D:\Program Files (x86)\FRMCP` (se `D:` esiste e il tuo utente può scrivervi),
  `C:\Program Files\FRMCP`, `D:\Program Files`; poi **Annulla**.
- Atteso: quelle su `D:` accettate, senza finestre e senza residui; `C:\Program Files\FRMCP` rifiutata (per un utente non
  amministratore) con un messaggio sui permessi di scrittura, **senza richiesta UAC**; `D:\Program Files` non usata
  direttamente: il campo mostra `D:\Program Files\FluentReaderMCP`. Il rifiuto non deve mai essere "cartella di Windows".
- Fallimento: rifiuto per il solo nome su `D:`; richiesta di elevazione; permessi modificati; accettazione in `C:\Program Files`
  seguita da un errore tardivo non spiegato.
- Evidenza: elenco percorso → messaggio; `Get-ChildItem -Force` delle cartelle dopo Annulla.

**N-20 — Più file di configurazione** (cat. 2, solo ambiente di prova)
- Preparazione: oltre al file attivo annotato in C.2, crea un secondo file sintetico con contenuto `{}` in una cartella di
  prova, per esempio `%LOCALAPPDATA%\Claude-Smoke\claude_desktop_config.json`.
- Azione: pagina Claude Desktop. Prima lascia il campo vuoto e premi Avanti; poi seleziona il file **non** attivo, installa e
  verifica come in N-14; poi riesegui il setup (riparazione) selezionando quello attivo e verifica di nuovo.
- Atteso: i due file sono elencati e il campo resta vuoto (se il secondo file è l'unico candidato con un'app non in
  pacchetto, viene invece proposto: annotalo); campo vuoto rifiutato con invito a scegliere o a installare solo il server;
  dopo la prima installazione Claude Desktop **non** mostra `fluent-reader` e il setup non aveva dichiarato il contrario;
  ogni esecuzione modifica soltanto il file selezionato; dopo la seconda il server compare. Alla disinstallazione (D-01) la
  voce viene rimossa da entrambi. Al termine rimuovi la cartella di prova che hai creato.
- Fallimento: file scelto dal setup in presenza di più candidati; più file modificati in una sola esecuzione; collegamento
  dichiarato riuscito.
- Evidenza: elenco mostrato (solo percorsi), hash dei due file dopo ogni esecuzione. **Annota anche se Modifica
  configurazione ha aperto il file che l'app legge davvero**: è il dato che i test automatici non possono dare.

## E. Aggiornamento e riparazione

**Versioni.** Il setup riconosce l'installazione esistente dal registro e confronta le versioni: versione più vecchia →
**aggiornamento**, stessa versione → **riparazione**. Lo dice il **riepilogo**, non più una finestra ("Vi è installata la
versione X: verrà aggiornata alla Y. Se l'aggiornamento non riesce, la versione attuale resta com'è." oppure "La versione Y
vi è già installata: i suoi file verranno reinstallati (riparazione)"). Annota il testo effettivamente mostrato.

**U-01 — Installazione sopra una beta precedente** (cat. 2)
- Preparazione: VM o account di prova con una beta precedente installata (di norma nella cartella predefinita); hash del
  file di Claude Desktop registrati.
- Azione: avvia il nuovo setup, stessa cartella.
- Atteso: riepilogo di **aggiornamento** dalla versione trovata a quella della build in prova; al termine
  sedici strumenti (N-14, se registri); profilo e altre voci MCP invariati; registro di installazione e "App installate" con
  la nuova versione.
- Fallimento: rifiuto senza motivo; versione precedente persa senza nuova versione; altre voci cambiate.
- Evidenza: screenshot del riepilogo, elenco strumenti dopo.

**U-02 — Riparazione della stessa build** (cat. 2)
- Azione: riesegui lo stesso setup sulla stessa cartella; una volta mantenendo la registrazione, una volta scegliendo
  la registrazione dopo un'installazione "solo server".
- Atteso: riepilogo di riparazione; il file già registrato viene riproposto; la pagina di conferma dice "Modifica: nessuna" e
  il file resta identico (hash), senza nuovo backup; registrazione aggiunta solo con il consenso e, se modifica il file,
  nuovo backup nella stessa `<chiave>`.
- Fallimento: chiave diversa per la stessa cartella; voce duplicata; file riscritto senza motivo; journal residuo.
- Evidenza: elenco della cartella dei backup, hash del file.

**U-03 — Riparazione con configurazione Claude non banale** (cat. 2)
- Preparazione: configurazione sintetica con più voci MCP fittizie (C.2), anche con variabili `env` fittizie e chiavi non
  standard; una voce `fluent-reader` scritta a mano e diversa.
- Azione: riparazione con registrazione; prima senza spuntare l'autorizzazione, poi spuntandola.
- Atteso: la pagina indica la voce come **non scritta da questo installer**, ne mostra solo comando e numero di argomenti e
  variabili; senza autorizzazione nulla cambia; con l'autorizzazione solo `fluent-reader` cambia e la vecchia voce resta nel
  backup; tutte le altre voci identiche.
- Fallimento: voce estranea sostituita in silenzio; altra voce modificata o rimossa; valori mostrati.
- Evidenza: confronto del JSON nell'ambiente sintetico, prima/dopo.

**U-04 — Migrazione di un backup legacy esattamente referenziato** (cat. 2)
- Preparazione: installazione della beta 0.1.0 con registrazione in Claude Code, quindi con la sua copia in
  `<installazione>\state\claude-config-backups\`; annota nome e SHA-256 di quella copia.
- Azione: aggiornamento con il nuovo setup.
- Atteso: **solo** la copia indicata dal registro di installazione viene spostata in
  `%LOCALAPPDATA%\FluentReaderMCP-Data\claude-config-backups\<chiave>\` con lo stesso SHA-256; l'originale viene rimosso
  solo dopo la verifica. Non è prevista la migrazione automatica di altre copie.
- Fallimento: hash diverso; copia persa; copia lasciata in entrambi i posti dopo un esito riuscito.
- Evidenza: nomi e hash prima/dopo.

**U-05 — Rifiuto conservativo di backup legacy non attribuibili** (cat. 2, solo ambiente di prova)
- Preparazione: come U-04, poi aggiungi in `<installazione>\state\claude-config-backups\` un secondo file creato da te
  e senza dati (per esempio `extra.bak` con testo `test`).
- Azione: aggiornamento con il nuovo setup.
- Atteso: il setup elenca gli elementi non attribuibili e **non parte**; nulla viene spostato, modificato o cancellato.
- Fallimento: migrazione parziale; cancellazione; aggiornamento che procede.
- Evidenza: testo del messaggio; hash dei file prima/dopo. Ripristino: rimuovi soltanto `extra.bak`, che hai creato tu,
  e ripeti U-04.

**U-06 — Interruzione di una riparazione o di un aggiornamento su un'installazione esistente** (cat. 3, solo
VM/snapshot)

Diversa da R-02: qui c'è sempre una versione **già installata e funzionante** prima dell'interruzione, e la prova
verifica che cosa ne resta. Da R-02 valgono soltanto le regole comuni (sezione F: "Regole" e "Che cosa annotare").
U-06 e R-02 hanno risultati separati nel modulo (sezione H).

- Preparazione:
  - solo VM o installazione sacrificabile, con snapshot ripristinabile preso **dopo** la preparazione qui sotto;
  - un'installazione valida e funzionante: una beta precedente (sette, nove o tredici strumenti, come in U-01) oppure questa build
    (sedici strumenti, come in U-02), registrata o no in Claude Desktop; Claude Desktop e Fluent Reader chiusi;
  - annota la versione iniziale (0.1.0 con sette strumenti, oppure 0.1.1 o 0.1.2 con nove, oppure 0.1.3 con nove per default: annota anche il numero di
    strumenti visto con N-14), il percorso di installazione e lo stato dei file gestiti: nomi in `current`,
    `state\` e nella radice (`Get-ChildItem -Force -Name`) e SHA-256 di `current\installer-files.json`,
    `fluent-reader-mcp.install.json` e `uninstall.exe`; `.staging`, `previous` e `state\install-journal.json` devono
    essere assenti;
  - copia indipendente del profilo di prova e dei dati della sezione C.4, presa prima della prova;
  - interruzione controllata: si usano solo i mezzi già previsti da questa checklist, cioè terminare da Gestione
    attività il processo dell'EXE del setup (come in R-02) oppure il `node.exe` del programma di supporto (come in
    R-01). Nessun altro mezzo di simulazione.
- Azione:
  1. avvia il nuovo setup sulla **stessa cartella** dell'installazione esistente e annota il testo del riepilogo
     (riparazione o aggiornamento, vedi sopra);
  2. durante l'installazione, mentre la barra avanza, termina il processo scelto; annota il momento
     (inizio, metà, fine della barra) e l'ultima fase mostrata;
  3. annota il messaggio eventualmente mostrato e lo stato della cartella (tabella della sezione F);
  4. riavvia lo stesso setup sulla stessa cartella e osserva il percorso di recupero che si attiva (recupero
     completato, ripristino o recupero INCOMPLETO con elenco, richiesta di controllo a mano);
  5. se il setup prosegue, fermati con **Annulla** prima di una nuova installazione; ripristina lo snapshot prima di
     ripetere la prova con un altro momento o un altro processo.
- Atteso:
  - la versione preesistente non viene cancellata né sostituita in modo non attribuibile: `previous` non viene mai
    cancellata in una transazione non confermata;
  - quando ogni elemento è attribuibile con certezza, il recupero rimette la versione preesistente (stessi SHA-256 dei
    file annotati, stesso numero di strumenti) oppure, se la transazione era già confermata, completa la nuova;
  - quando il recupero non può essere completato (vedi "Limite noto del recupero" in INSTALLER.md), il setup lo
    dichiara **INCOMPLETO**, elenca gli elementi non attribuibili e non rimuove, sostituisce o sposta nient'altro; il
    recupero automatico **non è garantito** in ogni momento di interruzione;
  - la riparazione o l'aggiornamento non risultano riusciti solo perché il setup si riapre: un successo si dichiara
    solo dopo il recupero o un'installazione completata;
  - dopo la prova è possibile dire quale versione è effettivamente in `current` (hash annotati, numero di strumenti
    con N-14 se il recupero è completo) o che nessuna versione è utilizzabile finché il recupero manuale (R-03) non è
    concluso.
- Fallimento: versione preesistente persa senza un messaggio riconoscibile; file non attribuibili sostituiti o
  cancellati; recupero dichiarato riuscito con uno stato delle cartelle non coerente (per esempio `.staging` o
  `previous` residue senza spiegazione, hash diversi da quelli di una delle due versioni); ripristino incompleto non
  segnalato; versione disponibile non identificabile dopo la procedura.
- Evidenza: versione e build prima della prova; versione o stato dopo l'interruzione e dopo il tentativo di recupero;
  processo terminato, momento e fase dell'errore; codice e messaggio completi; presenza del journal e i soli campi
  `phase` e `target.version` (sezione F), mai il file; nomi in `current`, `previous`, `.staging`, `state\` e nella
  radice, con gli SHA-256 annotati nella preparazione; esito del nuovo avvio; se serve un intervento manuale, il motivo
  indicato dal messaggio.

**U-07 — File bloccato con Claude Desktop attivo** (cat. 3, solo ambiente isolato)
- Preparazione: installazione registrata; Claude Desktop aperto con il server `fluent-reader` connesso.
- Azione: riparazione senza chiudere Claude Desktop.
- Atteso: errore nella fase `attivazione della nuova versione (chiudi Claude Desktop se è aperto)`; il setup non termina
  processi; la versione installata resta al suo posto; poi o un ripristino completo, o un **ripristino INCOMPLETO** che
  elenca gli elementi non attribuibili (per esempio `state\uninstall.exe.new`), come descritto in "Limite noto del recupero"
  di INSTALLER.md.
- Fallimento: successo dichiarato; versione installata danneggiata; elementi non elencati modificati.
- Evidenza: messaggi completi, fase, elenco degli elementi (vedi F).

**U-08 — Installazione Code-first** (cat. 2, solo ambiente di prova; se non hai una beta 0.1.x registrata, NON ESEGUITO)
- Preparazione: installazione 0.1.0 o 0.1.1 registrata in Claude Code; `claude mcp list` e hash di `.claude.json` annotati, con
  Claude Code chiuso.
- Azione: nuovo setup sulla stessa cartella, con registrazione in Claude Desktop; poi controlla Claude Code; infine
  disinstalla (solo se l'ambiente lo consente, categoria 3).
- Atteso: nessuna ricerca di `claude.exe`; la pagina di conferma segnala la voce di Claude Code, che non viene toccata e non
  implica una voce in Claude Desktop; `claude mcp get fluent-reader` come prima e il server continua a funzionare in Claude
  Code. Alla disinstallazione: la voce Desktop va via, quella di Code resta e un messaggio indica come rimuoverla.
- Fallimento: `.claude.json` modificato dal setup (conta il confronto con `claude mcp get`, perché Claude Code riscrive il file
  da solo); voce di Code rimossa; registrazione in Desktop data per implicita.
- Evidenza: `claude mcp list` prima/dopo, screenshot dei messaggi, senza contenuti della configurazione.

## F. Recupero

Il recupero **non è garantito** in ogni condizione: è automatico solo quando ogni elemento è attribuibile con certezza.
Queste prove sono di categoria 3 e si eseguono solo su VM o snapshot.

**Che cosa annotare dopo ogni errore**

| Dato | Dove |
|---|---|
| Fase | `<passo>` nel messaggio `Installazione non completata (<passo>)`, oppure il passo della disinstallazione |
| Codice | `codice N` nel messaggio del programma di supporto, se presente |
| Messaggio | Testo completo (screenshot), senza modificarlo |
| Cartella di installazione | Percorso scelto |
| Stato del journal | Solo presenza di `state\install-journal.json` e i campi `phase` e `target.version` (`(Get-Content -Raw <file> \| ConvertFrom-Json).phase`); **non** allegare il file, che contiene percorsi personali |
| Elementi presenti | Solo i nomi in `state\`, `current`, `previous`, `.staging` (`Get-ChildItem -Force -Name`) |
| Tentativo successivo | Esito del nuovo avvio dello stesso setup sulla stessa cartella |

**Regole.** Non eliminare mai `state`, `previous`, `.staging`, il journal o i backup "per sbloccare" il setup. Un file
residuo come `state\uninstall.exe.new` si tocca solo se compare nell'elenco del messaggio, dopo averlo identificato
(nome, data e ora coincidenti con il tentativo fallito, provenienza da questa installazione); in caso di dubbio si
sposta in una cartella personale invece di cancellarlo. Un elemento non elencato non si tocca.

**R-01 — Programma di supporto senza risultato verificabile** (cat. 3; solo sulla build finale, che contiene il nuovo
messaggio)
- Preparazione: VM con snapshot; installazione in corso su una cartella di prova.
- Azione: durante l'installazione termina il processo `node.exe` del programma di supporto (Gestione attività).
- Atteso: messaggio "Il programma di supporto del setup non ha restituito un risultato verificabile (codice N)": esito
  incerto, nessun invito a cancellare file, invito a rieseguire la stessa operazione sulla stessa cartella, recupero
  non garantito. Rieseguendo il setup: controllo iniziale e completamento o annullamento, oppure un messaggio di
  ripristino INCOMPLETO con l'elenco degli elementi.
- Fallimento: il messaggio garantisce che nulla è cambiato; il nuovo avvio dichiara successo con file residui non
  spiegati; elementi non elencati modificati.
- Evidenza: messaggi, dati della tabella sopra.

**R-02 — Interruzione del setup** (cat. 3)
- Azione: termina l'EXE del setup in momenti diversi dell'installazione (inizio, metà, fine della barra); dopo ciascuno
  riavvia il setup sulla stessa cartella; ripristina lo snapshot fra un tentativo e l'altro.
- Atteso: il nuovo avvio esegue prima il recupero; o ripristino completo (versione precedente o nessuna installazione),
  o ripristino INCOMPLETO con elenco; `previous` mai cancellata in una transazione non confermata.
- Fallimento: setup che riparte ignorando il journal; perdita della versione precedente senza messaggio.
- Evidenza: momento dell'interruzione, dati della tabella, esito del nuovo avvio.

**R-03 — Recupero manuale guidato** (cat. 3)
- Preparazione: un esito di ripristino INCOMPLETO da U-07, R-01 o R-02.
- Azione: segui solo le istruzioni del messaggio e di "Limite noto del recupero" in INSTALLER.md: identifica gli
  elementi elencati, spostali in una cartella personale, riesegui il setup sulla stessa cartella.
- Atteso: recupero completato dal journal oppure un nuovo messaggio esplicito; mai una rimozione silenziosa.
- Fallimento: istruzioni che richiedono di cancellare elementi non elencati; perdita di dati.
- Evidenza: elementi spostati (nomi), esito.

## G. Disinstallazione

Tutte le prove di questa sezione sono di categoria 3: solo su installazioni di prova (VM, snapshot o account di prova).

**D-01 — Disinstallazione normale**
- Preparazione: installazione registrata (N-13), con backup privati (N-17); Claude Desktop chiuso.
- Azione: "App installate" → Fluent Reader MCP → Disinstalla (oppure `uninstall.exe`).
- Atteso: file dell'inventario rimossi; soltanto la voce `fluent-reader` rimossa dal file di Claude Desktop, se è ancora quella
  scritta; il resto del file identico; valori HKCU del prodotto rimossi; messaggio finale con la cartella in cui restano i
  backup privati.
- Fallimento: file dell'inventario residui senza messaggio; altre voci MCP o preferenze cambiate; il vecchio file rimesso al
  posto di quello attuale.
- Evidenza: elenco della cartella dopo, confronto del JSON prima/dopo, testo dei messaggi finali.

**D-02 — File estraneo nella radice della cartella di installazione**
- Preparazione: un file di testo creato da te **direttamente nella radice** della cartella di installazione (non in
  `current`, `.staging` o `previous`: un file dentro una cartella gestita è il caso di D-03), per esempio `nota-smoke.txt` con una riga di testo
  qualsiasi; annota il suo SHA-256 e il suo contenuto (`Get-Content -Raw`).
- Azione: disinstalla.
- Atteso: il controllo iniziale riguarda le cartelle gestite, quindi il file nella radice **non** ferma la
  disinstallazione; i file gestiti attribuibili all'installazione vengono rimossi come in D-01; il file estraneo non
  viene modificato né cancellato (stesso contenuto e stesso SHA-256); la cartella di installazione resta, perché
  contiene ancora quel file.
- Fallimento: file estraneo cancellato, spostato o con contenuto diverso; cartella di installazione rimossa;
  disinstallazione rifiutata nel controllo iniziale a causa del file nella radice; file gestiti lasciati senza
  messaggio.
- Evidenza: SHA-256 e contenuto del file prima/dopo; elenco della cartella dopo (`Get-ChildItem -Force -Name`);
  messaggi.

**D-03 — File inatteso in una cartella gestita**
- Preparazione: un file creato da te in `current\app\` (per esempio `extra.txt`).
- Azione: disinstalla.
- Atteso: la disinstallazione si ferma nel preflight, **prima di qualsiasi rimozione**, e indica il file.
- Fallimento: rimozione parziale; file estraneo cancellato.
- Evidenza: messaggio; elenco della cartella prima/dopo (identico). Ripristino: sposta `extra.txt` e ripeti D-01.

**D-04 — Voce di Claude Desktop modificata**
- Preparazione: dopo l'installazione modifica a mano la voce `fluent-reader` nell'ambiente sintetico (per esempio aggiungi un
  argomento), con Claude Desktop chiuso.
- Azione: disinstalla.
- Atteso: la voce non è più attribuibile all'installer e non viene rimossa né ripristinata; il disinstallatore spiega che
  resterebbe in Claude Desktop e chiede se proseguire, con "No" come scelta predefinita. Con "No" la disinstallazione si
  ferma; con "Sì" prosegue lasciando la voce com'è.
- Fallimento: voce modificata rimossa o sovrascritta; "Sì" come scelta predefinita.
- Evidenza: il JSON della voce prima/dopo.

**D-05 — Backup privati conservati**
- Azione: dopo D-01, elenca `%LOCALAPPDATA%\FluentReaderMCP-Data\desktop-config-backups\<chiave>\` (e `claude-config-backups`, se
  presente).
- Atteso: tutti i backup ancora presenti con hash invariati; il messaggio finale indica la cartella. Se nella cartella
  di installazione restano copie di una versione precedente (`state\claude-config-backups`), un messaggio dedicato lo
  dice.
- Fallimento: backup cancellati o spostati.
- Evidenza: nomi e hash prima/dopo.

**D-06 — Messaggio finale NSIS**
- Atteso: completamento senza errori; se `uninstall.exe` non può essere cancellato, il messaggio "Fluent Reader MCP è
  stato rimosso. Il file ...\uninstall.exe non è stato cancellato ..." e nessun altro residuo.
- Evidenza: screenshot.

**D-07 — Disinstallazione ripetuta**
- Azione: dopo D-01, prova a eseguire di nuovo il disinstallatore (se ne resta uno) o a cercare la voce in "App
  installate".
- Atteso: voce assente; un disinstallatore residuo dice che la cartella non contiene un'installazione riconosciuta e
  non rimuove nulla.
- Fallimento: rimozione di qualsiasi file.
- Evidenza: messaggio.

**D-08 — Disinstallazione incompleta**
- Azione: termina il disinstallatore durante la rimozione (snapshot prima!); riavvia `uninstall.exe`; in un secondo
  tentativo, dopo l'interruzione cancella **solo** `uninstall.exe` se è rimasto il marcatore finale
  `state\uninstall-final.marker`, poi avvia il nuovo setup sulla stessa cartella.
- Atteso: il disinstallatore riprende dalla fase registrata; nel secondo caso la pagina della cartella del nuovo setup
  propone di completare la disinstallazione precedente e rimuove solo i file elencati nel marcatore finale.
- Fallimento: disinstallatore che non riparte; rimozione di file non elencati; nuova installazione sopra lo stato di
  una disinstallazione non conclusa.
- Evidenza: messaggi, elenco della cartella dopo ogni passo.

## H. Modulo dei risultati

Compila una riga per ogni prova. **PASS** e **FAIL** solo per prove effettivamente eseguite; una prova non eseguita
(unità assente, ambiente non disponibile, rinviata) è **NON ESEGUITO**, con il motivo nelle note. Una riga vuota
significa "soltanto pianificata".

Intestazione del collaudo: data · operatore · EXE (nome e SHA-256 calcolato) · commit e `scriptsDirty` dal report ·
Windows (versione e build) · Claude Desktop (versione e tipo di installazione) · file di configurazione realmente letto
dall'app, se accertato · snapshot usati.

| ID | Categoria | Ambiente | Risultato (PASS / FAIL / NON ESEGUITO) | Evidenza | Note | Issue |
|---|---|---|---|---|---|---|
| N-01 | 1 | | | | | |
| N-02 | 1 | | | | | |
| N-03 | 1 | | | | | |
| N-04 | 1 | | | | | |
| N-05 | 1 | | | | | |
| N-06 | 1 | | | | | |
| N-07 | 1 | | | | | |
| N-08 | 1 | | | | | |
| N-09 | 1 | | | | | |
| N-10 | 1 | | | | | |
| N-11 | 1 | | | | | |
| N-12 | 2 | | | | | |
| N-13 | 2 | | | | | |
| N-14 | 1 | | | | | |
| N-15 | 1 | | | | | |
| N-16 | 1 | | | | | |
| N-17 | 2 | | | | | |
| N-18 | 1 | | | | | |
| N-19 | 1 | | | | | |
| N-20 | 2 | | | | | |
| U-01 | 2 | | | | | |
| U-02 | 2 | | | | | |
| U-03 | 2 | | | | | |
| U-04 | 2 | | | | | |
| U-05 | 2 | | | | | |
| U-06 | 3 | | | | | |
| U-07 | 3 | | | | | |
| U-08 | 2 | | | | | |
| R-01 | 3 | | | | | |
| R-02 | 3 | | | | | |
| R-03 | 3 | | | | | |
| D-01 | 3 | | | | | |
| D-02 | 3 | | | | | |
| D-03 | 3 | | | | | |
| D-04 | 3 | | | | | |
| D-05 | 3 | | | | | |
| D-06 | 3 | | | | | |
| D-07 | 3 | | | | | |
| D-08 | 3 | | | | | |

Nelle evidenze annotare solo nomi di file, hash, testi dei messaggi e screenshot senza dati personali: mai contenuti di
`claude_desktop_config.json`, `.claude.json`, dei backup, del database o degli articoli.
