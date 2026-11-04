# Fluent Reader MCP

**Fluent Reader MCP** è un server [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) locale, indipendente e, **per impostazione predefinita, in sola lettura**, che permette ai client compatibili — come **Claude Desktop** e **Claude Code** — di consultare i dati salvati da [Fluent Reader](https://github.com/yang991178/fluent-reader) attraverso il linguaggio naturale.

Il server espone fonti RSS, gruppi, articoli e regole di filtraggio già presenti nel profilo Fluent Reader. Non modifica il database, non aggiorna i feed, non applica le regole e non scarica da Internet il contenuto degli articoli. Solo se l'utente lo abilita esplicitamente può modificare le regole delle fonti e dei gruppi: vedi [Modifica delle regole](#modifica-delle-regole-disabilitata-per-impostazione-predefinita).

> **Stato:** `v0.1.2-beta` — il codice sorgente attuale implementa **nove strumenti MCP read-only**, compresi l'elenco paginato (`list_articles`) e la ricerca testuale (`search_articles`) degli articoli. I pacchetti Windows costruiti dal codice attuale (ZIP e installer) contengono tutti e nove gli strumenti e lo verificano con un auto-test MCP su un profilo sintetico. Il primo installer `v0.1.0-beta` costruito il 2026-10-29 conteneva invece soltanto i **sette** strumenti iniziali (FR-MCP-02A); il setup `v0.1.2-beta` riconosce le versioni precedenti (`0.1.0`, `0.1.1`) e le aggiorna. Dalla `0.1.2` il wizard configura Claude Desktop invece di Claude Code. Il nuovo installer è in **collaudo**: non è ancora approvato per la distribuzione.

## Come funziona

```text
Claude Desktop / Claude Code / altro client MCP
                     |
                MCP via stdio
                     |
              Fluent Reader MCP
                     |
            Profilo Fluent Reader
              |             |
       fluent-reader.db   config.json
```

- Il client avvia il server MCP come processo locale quando necessario, usando il trasporto **`stdio`**. Non è previsto un servizio permanente né un listener HTTP/TCP.
- Il server richiede la **scelta esplicita del profilo**; non cerca automaticamente profili personali.
- Le letture SQLite sono effettuate in modalità **read-only**; i file del profilo restano gestiti da Fluent Reader.
- I contenuti restituiti al client possono essere trasmessi al modello Claude per rispondere alle richieste. Il server MCP non effettua autonomamente telemetria o fetch remoto degli articoli.

## Requisiti

### Per usare il pacchetto Windows

- **Windows x64** (ambiente principale di sviluppo e collaudo: Windows 11).
- Un profilo locale di Fluent Reader contenente `fluent-reader.db` e `config.json`.
- Un client MCP compatibile, per esempio **Claude Desktop** oppure **Claude Code**, per interrogare il server dall'interfaccia di Claude.

Il pacchetto ZIP Windows e l'installer `.exe` **includono Node.js**: l'utilizzatore finale non deve installare Node.js, TypeScript, Git o Visual Studio Code.

### Per compilare dal codice sorgente

- **Node.js 24**, versione `>=24.15.0 <25` (versione collaudata nel packaging: **24.22.1**).
- **npm** e **Git** (Git serve se si recupera il sorgente tramite clone).
- **Windows PowerShell** per i comandi riportati di seguito. La build TypeScript non richiede NSIS.
- **NSIS 3.x** disponibile nella pipeline Windows **solo se** si vuole costruire anche l'installer `.exe` (beta verificata con NSIS 3.13).
- Accesso alle dipendenze npm e, per il packaging, agli artefatti di runtime richiesti dalla pipeline.

## Compilazione dal sorgente

I seguenti comandi vanno eseguiti nella cartella del repository. Se il repository non è pubblico, occorre disporre dell'accesso necessario per clonarlo. **Questo README descrive il codice sorgente attuale:** una copia remota non ancora aggiornata, o un pacchetto costruito in precedenza, potrebbe avere meno strumenti o script disponibili.

```powershell
# Scarica il progetto, se non è già presente localmente.
git clone https://github.com/LordSkull/fluent-reader-mcp.git
cd fluent-reader-mcp

# Controlla la versione di Node.
node --version

# Installa esattamente le dipendenze del lockfile.
npm.cmd ci

# Controlli e compilazione TypeScript.
npm.cmd run typecheck
npm.cmd run build

# Test automatici, basati su fixture sintetiche.
npm.cmd test
```

Il comando `build` compila `src/` in **`dist/`**; l'entrypoint del server è **`dist/main.js`**. `npm.cmd test` esegue anche la propria fase di precompilazione. Su PowerShell si usa `npm.cmd` per evitare eventuali restrizioni sull'esecuzione di `npm.ps1`.

### Avvio del server compilato

Identifica la cartella del profilo Fluent Reader che contiene **entrambi** i file `config.json` e `fluent-reader.db`. Per un'installazione tipica di Windows il percorso può essere `%APPDATA%\fluent-reader`, ma va verificato sul proprio sistema.

```powershell
$profile = Join-Path $env:APPDATA "fluent-reader"

# Il server comunica via stdin/stdout: va normalmente avviato dal client MCP.
node .\dist\main.js --profile-dir $profile
```

L'avvio manuale **non apre una pagina web né una console interattiva**: il processo resta in attesa dei messaggi JSON-RPC di un client MCP su `stdin`. Per l'utilizzo normale, configura il client MCP in modo che esegua Node con `dist/main.js` e gli argomenti `--profile-dir` e il percorso assoluto del profilo.

### Creare i pacchetti Windows (beta)

Nel checkout locale della beta con gli script di distribuzione sono disponibili i comandi seguenti. Controlla `package.json` della revisione in uso: alcuni checkout precedenti potrebbero non includere ancora gli script di packaging.

**ZIP portatile**, con runtime Node e dipendenze di produzione:

```powershell
npm.cmd run package:win -- --out "D:\FluentReaderMCP-build"
```

**Installer NSIS**, generato a partire dallo ZIP appena costruito e verificato con SHA-256:

```powershell
$zip = "D:\FluentReaderMCP-build\fluent-reader-mcp-v0.1.2-beta-win-x64.zip"
$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()

# Prima verifica senza compilare l'EXE.
npm.cmd run installer:win -- --bundle $zip --bundle-sha256 $sha --out "D:\FluentReaderMCP-build" --dry-run

# Compilazione vera, solo dopo un dry-run riuscito.
npm.cmd run installer:win -- --bundle $zip --bundle-sha256 $sha --out "D:\FluentReaderMCP-build"
```

Gli artefatti generati devono essere verificati tramite i relativi checksum e report di build. L'installer della beta privata **non è firmato digitalmente**.

## Strumenti MCP disponibili

Il codice sorgente attuale implementa **nove strumenti**, tutti in sola lettura: nessuno strumento modifica articoli, feed, gruppi, regole o impostazioni. I pacchetti costruiti dal codice attuale li contengono tutti; il primo installer `v0.1.0-beta` (2026-10-29) conteneva soltanto i primi sette. `list_articles` e `search_articles` sono stati validati con test automatici e smoke MCP su profili sintetici, mentre il collaudo reale con Claude Desktop riguarda finora solo i sette strumenti FR-MCP-02A.

| Strumento | Cosa fa |
|---|---|
| `list_sources` | Elenca le fonti RSS configurate, con paginazione, filtri e informazioni di visibilità. Non espone per impostazione predefinita URL del feed o dell'icona. |
| `get_source` | Recupera i dettagli di una fonte tramite identificativo, inclusi metadati, gruppo e conteggi delle regole. Non calcola automaticamente statistiche complete sugli articoli. |
| `list_groups` | Elenca i gruppi di fonti salvati in Fluent Reader, mantenendo l'ordine e le informazioni di appartenenza. |
| `get_group` | Recupera un gruppo specifico e le relative fonti, segnalando eventuali anomalie negli identificativi o nelle appartenenze. |
| `get_article` | Legge un articolo tramite ID e restituisce i metadati, gli stati e il **contenuto locale disponibile**; può suddividere testi lunghi in segmenti. Non recupera la pagina web originale. |
| `list_rules` | Elenca le regole RSS archiviate per ambito (globale, gruppo o fonte), senza applicarle o modificarle. |
| `get_rule_chain` | Ricostruisce la sequenza delle regole pertinenti a una fonte: **globali → primo gruppo applicabile → fonte**. Espone la configurazione, non simula l'esecuzione sui singoli articoli. |
| `list_articles` | Elenca gli articoli salvati, con filtri, paginazione a cursore e un breve estratto opzionale, senza il corpo dell'articolo. Restituisce gli ID da passare a `get_article`. |
| `search_articles` | Cerca parole o frasi negli articoli salvati localmente: nel titolo, nel titolo oppure nello snippet, o nell'autore. Accetta gli stessi filtri di `list_articles`, usa la paginazione a cursore e restituisce ID da passare a `get_article`. Non scarica né indicizza contenuti remoti. |

### `list_articles`: filtri, paginazione e ordinamento

- **Filtri principali:** fonti (`sourceIds`) oppure gruppo (`groupId`), intervallo di date (`dateFrom`/`dateTo`, sulla data salvata dell'articolo), stato di lettura (`read`), preferiti (`starred`), articoli nascosti nell'app (`hidden`, esclusi per impostazione predefinita) e fonti nascoste da «Tutti gli articoli» (`includeHiddenSources`, escluse per impostazione predefinita).
- **Paginazione:** da 1 a 100 articoli per pagina (predefinito 20). Per la pagina successiva si ripassa `nextCursor` finché `hasMore` è vero. Ogni chiamata esamina un numero limitato di articoli: con filtri molto selettivi una pagina può contenere meno articoli del richiesto, o nessuno, pur avendo `hasMore` vero. L'elenco è concluso solo quando `scan.exhausted` è vero.
- **Ordinamento:** è disponibile soltanto `stored`, cioè per **ID di memorizzazione decrescente** (l'ordine in cui Fluent Reader ha salvato gli articoli nel database). **Non garantisce l'ordine per data di pubblicazione**, che resta disponibile come campo `date` di ciascun articolo.
- Gli articoli salvati dopo la prima pagina non vengono inclusi nell'elenco in corso; URL di articoli, feed, icone e miniature non vengono mai restituiti.

### `search_articles`: ricerca testuale negli articoli locali

- **Query:** il testo da cercare (`query`), obbligatorio nella prima chiamata; con un cursore può essere omesso. Da 1 a **200 code point** Unicode, non composto soltanto da spazi, senza sequenze Unicode malformate. La query non può contenere caratteri di controllo diversi dai controlli di spaziatura ammessi (tab, newline, tab verticale, form feed, carriage return), che vengono normalizzati come spazi; dopo la normalizzazione non deve neppure espandersi oltre un limite interno.
- **Campi (`fields`):**
  - `"title"` (predefinito): solo il titolo;
  - `"text"`: il titolo **oppure** lo snippet, cioè il testo semplice salvato da Fluent Reader;
  - `"creator"`: solo l'autore.

  Ogni campo è confrontato separatamente: una frase deve trovarsi per intero nel titolo o per intero nello snippet. Il risultato indica in `matchedIn` dove è stata trovata (il titolo prevale sullo snippet). Il contenuto HTML (`content`) **non** viene cercato.
- **Natura della ricerca:** sottostringa **letterale**, dopo una normalizzazione deterministica applicata sia alla query sia al testo: minuscole Unicode predefinite, rimozione degli accenti combinanti U+0300–U+036F, sigma finale greca equiparata a σ e riduzione di ogni sequenza di spazi a uno spazio. Per esempio `ECONOMIA` trova `economia` e `citta` trova `città`, ma `ss` non trova `ß` e `oe` non trova `œ`: non è un'equivalenza Unicode universale. Non è una ricerca semantica: niente FTS, ranking per pertinenza, sinonimi, wildcard SQL o espressioni regolari (`%`, `_`, `*` o `[` sono caratteri qualsiasi).
- **Filtri:** gli stessi di `list_articles`, con identico significato e identici valori predefiniti: `sourceIds` oppure `groupId`, `dateFrom`/`dateTo`, `read`, `starred`, `hidden` (articoli nascosti esclusi per default) e `includeHiddenSources` (fonti nascoste escluse per default).
- **Ordinamento:** soltanto `sort: "stored"`, cioè **ID di memorizzazione decrescente**. Non è un ordinamento per data di pubblicazione né per pertinenza.
- **Paginazione e completezza:** la ricerca procede a finestre limitate di articoli e, per chiamata, con un massimo di 8 MiB di valori testuali ricercabili caricati (il budget conta anche i valori di candidati poi esclusi da altri filtri, non solo i testi confrontati o i risultati restituiti). Una pagina può quindi essere vuota o contenere meno risultati di `pageSize` pur avendo `hasMore: true`: non significa che la ricerca sia conclusa, né che esistano altri risultati, ma solo che restano articoli da esaminare; si prosegue ripassando `nextCursor`. `scan.exhausted: true` indica che la scansione è terminata; `search.exhaustive: true` indica che la scansione è terminata e che non risultano omissioni cumulative di campi rilevanti per gli articoli ammissibili secondo i filtri e le regole di visibilità, né record saltati perché troppo grandi: cioè nessuna omissione che possa nascondere corrispondenze.
- **Campi troppo grandi o non testuali:** se un campo ricercabile è troppo grande (titoli e autori oltre 16 KiB, snippet oltre 256 KiB) o non è testuale, non viene esaminato, nemmeno in parte. Con `fields: "text"` l'articolo può comunque essere restituito se l'altro campo ricercato corrisponde: per esempio un titolo troppo grande con uno snippet che contiene la query dà un risultato con `matchedIn: "snippet"`, senza alcuna omissione conteggiata. Se invece nessun campo esaminabile corrisponde e un campo rilevante non è stato esaminato, l'articolo ammissibile (che supera i filtri e le regole di visibilità) viene conteggiato tra le omissioni in `search.notSearchedTooLarge` o `search.notSearchedUnexpectedType`, e `search.exhaustive` resta `false`. Un'omissione non è un risultato negativo accertato: la ricerca può quindi non trovare tutti i risultati presenti in un database.
- **Contenuti locali:** lo snippet è il testo salvato da Fluent Reader e può essere un estratto del feed, non l'articolo integrale. Per leggere un risultato si usa `get_article` con il suo `articleId`, che restituisce il contenuto disponibile localmente.

### Esempi di richieste

- «Mostrami tutte le mie fonti RSS» → `list_sources`.
- «Quali gruppi ho creato in Fluent Reader?» → `list_groups`.
- «Mostrami le fonti di questo gruppo» → `get_group`, dopo aver identificato il gruppo.
- «Quali regole si applicano a questa fonte?» → `get_rule_chain`, dopo aver identificato la fonte.
- «Mostrami gli articoli non letti di questo gruppo» → `list_articles`, dopo aver identificato il gruppo.
- «Cerca gli articoli con "inflazione" nel titolo» → `search_articles` con `{ "query": "inflazione" }`.
- «Cerca "crisi industriale" nei titoli o nei testi degli articoli non letti di queste due fonti» → `search_articles` con `{ "query": "crisi industriale", "fields": "text", "read": "unread", "sourceIds": [3, 7] }`; gli ID `3` e `7` sono **valori illustrativi**: quelli reali si ottengono prima con `list_sources`.
- «Quali articoli ha scritto Mario Rossi?» → `search_articles` con `{ "query": "mario rossi", "fields": "creator" }`.
- «Leggi l'articolo con ID 1234» → `get_article` (l'ID è un esempio e deve esistere nel proprio database).

## Collegamento ai client Claude

### Claude Desktop

Il wizard Windows configura **Claude Desktop** come unico client, in modo facoltativo: si può sempre scegliere **«Installa solo il server»**.

**Quale file.** Nessun metodo documentato dice quale `claude_desktop_config.json` legga davvero una data installazione di Claude Desktop: la posizione documentata è `%APPDATA%\Claude`, ma un'app installata come pacchetto (MSIX, Store, WinGet) può leggere una copia privata sotto `%LOCALAPPDATA%\Packages`, e il suo **Impostazioni → Modifica configurazione** può aprire un file diverso; altre posizioni sono state osservate. Per questo il setup **non decide da solo**: elenca i file trovati nelle cartelle di Claude dell'utente senza aprirli, propone un percorso solo quando non c'è dubbio da nascondere e chiede di indicare il file. Selezionare un file **non dimostra** che Claude Desktop lo legga.

**Che cosa cambia.** Soltanto `mcpServers.fluent-reader`, dopo aver mostrato file e voce e con un consenso specifico. Ogni altro byte del file resta com'è (altri server come `foundry-mcp`, preferenze, campi sconosciuti, `env`, credenziali). Il file viene copiato prima in una cartella personale; un JSON non valido, una struttura diversa o una voce `fluent-reader` non attribuibile non vengono sovrascritti in silenzio.

**Verifica obbligatoria nel client.** Dopo l'installazione chiudi del tutto Claude Desktop (anche dall'area di notifica), riaprilo e controlla che compaia `fluent-reader` con nove strumenti. Se non compare, probabilmente il file selezionato non è quello attivo: esegui di nuovo il setup e seleziona l'altro. Il setup non dichiara mai riuscito il collegamento.

### Claude Code

Il wizard **non** cerca `claude.exe` e non registra il server in Claude Code; una registrazione in Claude Desktop non configura Claude Code. Per usarlo, registra il server a mano (vedi [installer/INSTALLER.md](installer/INSTALLER.md)).

**Se hai usato le beta 0.1.0 o 0.1.1**, che registravano il server in Claude Code: quella voce non viene modificata né rimossa da aggiornamenti, riparazioni e disinstallazione, e non implica una registrazione in Claude Desktop. Continua a funzionare finché il server resta nella stessa cartella; dopo la disinstallazione puoi toglierla con `claude mcp remove fluent-reader --scope user`.

## Installazione e disinstallazione Windows

La descrizione completa è in [installer/INSTALLER.md](installer/INSTALLER.md); in sintesi:

- L'installer NSIS è per l'**utente corrente** (nessun UAC, nessun servizio, nessuna scrittura in `HKLM`), con posizione proposta `%LOCALAPPDATA%\FluentReaderMCP`.
- **Cartella personalizzata:** si può scegliere una cartella su qualsiasi unità **locale** con lettera (`C:`, `D:`, `H:`...), anche fuori dal profilo Windows. Una cartella valida passa direttamente alla pagina successiva, senza finestre di conferma. Se si sceglie la radice di un'unità, la cartella dei programmi stessa o una cartella che contiene già altri file, il campo della pagina mostra la sottocartella `FluentReaderMCP` e serve un secondo Avanti (i file presenti non vengono toccati). `Program Files` e `Program Files (x86)` sono ammesse se il tuo utente può davvero scrivervi: su `D:` di solito sì, in `C:\Program Files` di solito no, e allora il setup lo dice, senza chiedere privilegi di amministratore né modificare permessi.
- **Rifiutate:** unità di rete, unità mappate e SUBST, percorsi UNC, collegamenti simbolici, junction e nomi brevi 8.3, cartelle di Windows e `ProgramData` su qualsiasi unità, cartelle non scrivibili, profili di altri utenti e la cartella pubblica, `Roaming`, OneDrive e `.claude`, cartelle con elementi del prodotto non attribuibili a un'installazione registrata. Le unità **rimovibili** sono accettate con un avviso (devono essere collegate con la stessa lettera ogni volta che il server viene usato). Fuori dalla cartella utente il setup avverte che i permessi della posizione non vengono verificati né modificati.
- **Riparazione e aggiornamento:** rieseguendo il setup sulla stessa cartella; il downgrade non è supportato. Chiudere Claude Desktop prima di aggiornare, riparare o disinstallare.
- **Backup della configurazione:** in `%LOCALAPPDATA%\FluentReaderMCP-Data\desktop-config-backups\<chiave>\`, separati per installazione e **mai** nella cartella di installazione. Possono contenere informazioni riservate (anche token di altri server MCP): non condividerli. Le copie di `.claude.json` delle beta precedenti vengono spostate in `claude-config-backups\<chiave>\` quando sono attribuibili; elementi legacy ambigui bloccano aggiornamento e riparazione finché non vengono controllati. Non vengono cancellati automaticamente, neppure dalla disinstallazione.
- **Recupero:** dopo alcuni errori o crash (in particolare quelli successivi alla scrittura del nuovo disinstallatore) il recupero automatico **può fermarsi e chiedere un intervento manuale** sui soli file elencati nel messaggio; vedi "Limite noto del recupero" in [installer/INSTALLER.md](installer/INSTALLER.md).
- Il profilo Fluent Reader è selezionato separatamente e **non viene copiato, modificato o cancellato** durante installazione/disinstallazione.
- Per la rimozione usa il disinstallatore fornito (`uninstall.exe`), non la cancellazione manuale della cartella; le modifiche alle configurazioni MCP eventualmente fatte **manualmente** vanno rimosse separatamente dal client interessato.

## Modifica delle regole (disabilitata per impostazione predefinita)

Il codice sorgente attuale (FR-MCP-03-RULE-WRITE-01, non ancora in un pacchetto rilasciato) contiene quattro strumenti aggiuntivi: `preview_rule_change` (solo lettura), `add_rule`, `update_rule` e `delete_rule`. Senza abilitazione **non vengono nemmeno elencati**: il server espone gli stessi nove strumenti in sola lettura, e il wizard non cambia.

**Abilitazione.** Aggiungi la variabile alla voce `fluent-reader` del file di configurazione di Claude Desktop, poi riavvia del tutto Claude Desktop. Vale solo il valore esatto `1`; toglierla le disabilita di nuovo.

```json
"env": { "FLUENT_READER_MCP_ENABLE_RULE_WRITES": "1" }
```

Una voce così modificata non è più quella scritta dall'installer: rieseguendo il setup viene segnalata e, se ne confermi la sostituzione, l'abilitazione si perde; la disinstallazione non la rimuove, e va tolta a mano. Non impostare la variabile a livello di sistema: l'auto-test dei pacchetti richiede esattamente nove strumenti.

**Fluent Reader deve essere chiuso.** Con l'app aperta le scritture sono rifiutate (`FLUENT_READER_RUNNING`), mentre anteprima e letture restano disponibili. Il motivo è concreto: l'app salva `config.json` con una lettura-modifica-scrittura che un processo esterno non può coordinare, e tiene le regole in memoria dall'avvio, quindi le ignorerebbe fino al riavvio e, salvando lo stesso obiettivo dal suo editor, le sovrascriverebbe. L'app aperta si riconosce dal file `lockfile` nel profilo; il server non termina mai alcun processo. Se l'app è chiusa ma il file è rimasto (per esempio dopo un'interruzione di corrente), basta aprirla e chiuderla una volta.

**Cosa cambia e cosa no.**

- Solo `source:<id>` e `group:<id>`: le regole globali restano consultabili ma non modificabili, e l'appartenenza delle fonti ai gruppi non cambia.
- Ogni scrittura richiede `expectedRevision` (da `list_rules` o `preview_rule_change`); per le fonti anche `sourceRef`. Se le regole sono cambiate, o la richiesta è un duplicato, viene rifiutata senza scrivere. Revisione e `sourceRef` valgono per l'esecuzione corrente del server.
- Le regole nuove valgono per gli articoli che l'app elaborerà dal successivo avvio: quelli già presenti non cambiano, salvo il comando retroattivo esplicito dell'app. "Salva" significa contrassegnare come preferito, non scaricare il contenuto.
- La condizione invertita (`match: false`, in italiano "Non ci sono risultati") si applica a tutta la condizione, stato dell'articolo compreso. Le condizioni sullo stato sono rispettate dall'app, ma il suo editor non le mostra e le perde se la regola viene risalvata da lì.
- L'anteprima è analisi statica: non esegue i pattern e non prova il comportamento di una regex sugli articoli reali, né autorizza il salvataggio. Una regex con backtracking eccessivo si può salvare come dall'editor dell'app, e rallentare l'elaborazione.

**Scrittura e backup.** Viene sostituita soltanto la porzione di `config.json` relativa all'obiettivo: tutto il resto resta identico byte per byte, campi sconosciuti compresi. Prima della scrittura una copia esatta del file va in `%LOCALAPPDATA%\FluentReaderMCP-Data\rule-backups\<chiave>\config.json.<data>.bak`; se la copia non riesce, non si scrive nulla. Il nuovo contenuto va in un file temporaneo, poi il file viene sostituito con un rename atomico e riletto per conferma.

I backup **contengono l'intera configurazione, credenziali comprese**: non condividerli. Non vengono mai cancellati automaticamente. Per tornare indietro, con Fluent Reader chiuso, copia il backup scelto su `config.json`: nessun ripristino è automatico, perché potrebbe sovrascrivere modifiche successive.

## Sicurezza, privacy e limiti

- **Sola lettura per impostazione predefinita:** il server non segna articoli come letti e non modifica fonti o gruppi; modifica le regole soltanto se abilitato (vedi sopra).
- **Processo locale:** MCP su `stdio`, senza endpoint di rete previsto; ciò non sostituisce i controlli di accesso di Windows ai file del profilo.
- **Dati sensibili:** URL e credenziali non vengono esposti per default; gli output e gli errori sono limitati e sanitizzati secondo le verifiche implementate.
- **Contenuti RSS non attendibili:** titoli e testi possono contenere tentativi di *prompt injection*. Il client deve trattarli come dati, non come istruzioni autorizzate.
- **Completezza degli articoli:** il server restituisce soltanto il contenuto salvato localmente da Fluent Reader, che può essere un estratto e non il testo editoriale completo.
- **Ricerca:** `search_articles` lavora solo sui dati locali, senza accesso a Internet, lasciando il database in sola lettura e senza creare indici, tabelle o file di ricerca. È soggetta a budget di scansione, di valori testuali ricercabili caricati e di memoria per chiamata; i campi troppo grandi possono essere esclusi dall'esame, quindi l'esaustività non è garantita in assoluto ed è dichiarata solo da `search.exhaustive`. Titoli, autori e snippet restituiti restano dati non attendibili.
- **Uso con Claude:** i contenuti restituiti dagli strumenti possono essere inviati dal client ai servizi di Anthropic. Valuta quali informazioni condividere.
- **Beta privata:** il progetto è sotto licenza MIT e i pacchetti includono le licenze e le notice delle dipendenze (`licenses/`); il collaudo di upgrade/recovery su Windows reale e la firma del codice sono ancora necessari prima di una distribuzione pubblica.

## Stato e roadmap

- **FR-MCP-02A (completato):** sette strumenti read-only; ZIP Windows con Node incluso; primo installer NSIS `v0.1.0-beta` (2026-10-29, con questi sette strumenti); test end-to-end dei sette strumenti con Claude Desktop e un profilo reale, più installazione/disinstallazione ordinaria in Windows Sandbox.
- **FR-MCP-02B (completato nel codice sorgente):**
  - `list_articles` (FR-MCP-02B-01) — completato;
  - `search_articles` (FR-MCP-02B-02) — completato.

  Entrambi validati con test automatici, smoke MCP e benchmark su database sintetici; inclusi nei pacchetti costruiti dal codice attuale, non ancora collaudati con un profilo reale.
- **FR-MCP-04-BETA-03A (implementato, in collaudo):** installazione in cartelle personalizzate su unità locali (SIMPLE-01) e backup della configurazione in un'area personale separata (SIMPLE-02).
- **FR-MCP-04-BETA-UX-01 (implementato e approvato in review; non ancora collaudato con Claude Desktop reale):** wizard Desktop-first con selezione assistita del file di configurazione, `Program Files` non rifiutata per il solo nome, nessuna finestra di conferma della cartella. La proposta storica di scelta fra Code, Desktop, entrambi o nessuno è superata. Questi comportamenti sono inclusi dalla `0.1.2`, non nella build 0.1.1 già costruita.
- **FR-MCP-04-BETA-RELEASE-01 (completato):** documentazione e checklist di collaudo Windows ([WINDOWS-SMOKE-TEST.md](installer/WINDOWS-SMOKE-TEST.md)).
- **FR-MCP-04-BETA-RELEASE-02 (completato):** versione 0.1.1, licenza MIT del progetto e notice di Koffi nei pacchetti, build pulita.
- **FR-MCP-04-BETA-RELEASE-03 (in corso):** versione 0.1.2 con il wizard Desktop-first; poi build pulita e collaudo su Windows reale. La distribuzione resta subordinata alla review e all'approvazione del proprietario.
- **FR-MCP-03-RULE-WRITE-01 (implementato, in review):** `add_rule`, `update_rule`, `preview_rule_change` e `delete_rule`, disabilitati per impostazione predefinita; verificati su profili sintetici, non ancora collaudati con Claude Desktop reale né inclusi in un pacchetto.
- **Successivamente:** hardening di sicurezza, benchmark su archivi grandi, miglioramento della distribuzione Windows, CI e release pubblica quando autorizzata.

Il progetto Fluent Reader MCP è indipendente dal fork dell'applicazione e non richiede modifiche a Fluent Reader per le funzionalità read-only attuali.

## Sviluppo e contributi

I test automatici devono utilizzare **profili sintetici**: non utilizzare database personali nei test, nei benchmark o nei log condivisi. Le modifiche al server seguono review indipendente prima dell'integrazione.

Il documento descrive le capacità del codice sorgente attuale, distinguendole da quelle dell'installer già costruito, e non attribuisce alle funzionalità pianificate uno stato di implementazione.

## Licenza

Il codice di Fluent Reader MCP è distribuito con licenza [MIT](LICENSE). Node.js e le dipendenze incluse nei pacchetti Windows restano sotto le proprie licenze, copiate nella cartella `licenses/` del pacchetto.
