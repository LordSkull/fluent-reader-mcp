# Fluent Reader MCP

**Fluent Reader MCP** è un server [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) locale, indipendente e **in sola lettura**, che permette ai client compatibili — come **Claude Desktop** e **Claude Code** — di consultare i dati salvati da [Fluent Reader](https://github.com/yang991178/fluent-reader) attraverso il linguaggio naturale.

Il server espone fonti RSS, gruppi, articoli e regole di filtraggio già presenti nel profilo Fluent Reader. Non modifica il database, non aggiorna i feed, non applica le regole e non scarica da Internet il contenuto degli articoli.

> **Stato:** `v0.1.0-beta` — il codice sorgente attuale implementa **nove strumenti MCP read-only**, compresi l'elenco paginato (`list_articles`) e la ricerca testuale (`search_articles`) degli articoli. L'installer Windows `v0.1.0-beta` già costruito e collaudato contiene invece i **sette** strumenti iniziali (FR-MCP-02A): i due strumenti sugli articoli saranno inclusi soltanto in un nuovo pacchetto, non ancora costruito.

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
$zip = "D:\FluentReaderMCP-build\fluent-reader-mcp-v0.1.0-beta-win-x64.zip"
$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()

# Prima verifica senza compilare l'EXE.
npm.cmd run installer:win -- --bundle $zip --bundle-sha256 $sha --out "D:\FluentReaderMCP-build" --dry-run

# Compilazione vera, solo dopo un dry-run riuscito.
npm.cmd run installer:win -- --bundle $zip --bundle-sha256 $sha --out "D:\FluentReaderMCP-build"
```

Gli artefatti generati devono essere verificati tramite i relativi checksum e report di build. L'installer della beta privata **non è firmato digitalmente**.

## Strumenti MCP disponibili

Il codice sorgente attuale implementa **nove strumenti**, tutti in sola lettura. L'installer `v0.1.0-beta` già distribuito contiene soltanto i primi sette (senza `list_articles` e `search_articles`); questi due sono stati validati con test automatici e smoke MCP su profili sintetici, mentre il collaudo reale con Claude Desktop riguarda finora solo i sette strumenti FR-MCP-02A.

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

### Claude Code

L'installer Windows `v0.1.0-beta` già costruito può proporre la registrazione del server **`fluent-reader`** in Claude Code, nello scope **`user`**, **solo dopo un consenso esplicito**. È possibile installare il server senza registrarlo.

### Claude Desktop

Il server è compatibile con **Claude Desktop**: la registrazione **manuale** è stata verificata con i sette strumenti FR-MCP-02A su un profilo reale. **La beta già costruita non configura automaticamente Claude Desktop.** Per usarlo occorre aggiungere manualmente una voce `fluent-reader` nella sezione `mcpServers` del file di configurazione **effettivamente utilizzato** dal client, indicando l'eseguibile Node incluso o quello di sviluppo, `dist/main.js` e `--profile-dir`.

**Attenzione ai percorsi Windows:** la configurazione attiva di Claude Desktop può trovarsi in posizioni diverse secondo la distribuzione e la versione (per esempio sotto `%LOCALAPPDATA%\Claude-Data\...`), non necessariamente in `%APPDATA%\Claude`. Verifica sempre il percorso tramite **Claude Desktop → Impostazioni → Server MCP locali → Modifica configurazione**. Crea un backup e preserva tutte le altre entry MCP e preferenze.

Non presumere che `%APPDATA%\Claude` sia sempre la directory effettiva. L'individuazione affidabile del file attivo e una scelta esplicita tra **Claude Code**, **Claude Desktop**, **entrambi** oppure **nessuna registrazione** sono obiettivi del prossimo installer (FR-MCP-04-BETA-03), **non ancora implementati**.

## Installazione e disinstallazione Windows

- L'installer NSIS è progettato per l'**utente corrente**, con posizione predefinita sotto `%LOCALAPPDATA%\FluentReaderMCP`.
- Nella beta attuale le posizioni personalizzate **fuori dal profilo Windows** possono essere rifiutate, anche se si trovano su un disco locale sicuro come `D:`. Il supporto a directory personalizzate validate tramite permessi è pianificato; **non è ancora disponibile**.
- Il profilo Fluent Reader è selezionato separatamente e **non viene copiato o cancellato** durante installazione/disinstallazione.
- Per la rimozione usa il disinstallatore fornito (`uninstall.exe`), non la cancellazione manuale della cartella; le modifiche alle configurazioni MCP eventualmente fatte **manualmente** vanno rimosse separatamente dal client interessato.

## Sicurezza, privacy e limiti

- **Sola lettura:** il server non segna articoli come letti e non modifica fonti, gruppi o regole.
- **Processo locale:** MCP su `stdio`, senza endpoint di rete previsto; ciò non sostituisce i controlli di accesso di Windows ai file del profilo.
- **Dati sensibili:** URL e credenziali non vengono esposti per default; gli output e gli errori sono limitati e sanitizzati secondo le verifiche implementate.
- **Contenuti RSS non attendibili:** titoli e testi possono contenere tentativi di *prompt injection*. Il client deve trattarli come dati, non come istruzioni autorizzate.
- **Completezza degli articoli:** il server restituisce soltanto il contenuto salvato localmente da Fluent Reader, che può essere un estratto e non il testo editoriale completo.
- **Ricerca:** `search_articles` lavora solo sui dati locali, senza accesso a Internet, lasciando il database in sola lettura e senza creare indici, tabelle o file di ricerca. È soggetta a budget di scansione, di valori testuali ricercabili caricati e di memoria per chiamata; i campi troppo grandi possono essere esclusi dall'esame, quindi l'esaustività non è garantita in assoluto ed è dichiarata solo da `search.exhaustive`. Titoli, autori e snippet restituiti restano dati non attendibili.
- **Uso con Claude:** i contenuti restituiti dagli strumenti possono essere inviati dal client ai servizi di Anthropic. Valuta quali informazioni condividere.
- **Beta privata:** la revisione delle licenze, delle notice delle dipendenze, dei test di upgrade/recovery su Windows reale e della firma del codice è ancora necessaria prima di una distribuzione pubblica.

## Stato e roadmap

- **FR-MCP-02A (completato):** sette strumenti read-only; ZIP Windows con Node incluso; primo installer NSIS `v0.1.0-beta` (con questi sette strumenti); test end-to-end dei sette strumenti con Claude Desktop e un profilo reale, più installazione/disinstallazione ordinaria in Windows Sandbox.
- **FR-MCP-02B (completato nel codice sorgente):**
  - `list_articles` (FR-MCP-02B-01) — completato;
  - `search_articles` (FR-MCP-02B-02) — completato.

  Entrambi validati con test automatici, smoke MCP e benchmark su database sintetici; non ancora inclusi in un installer costruito né collaudati con Claude Desktop su un profilo reale.
- **FR-MCP-04-BETA-03 (prossima attività, non ancora implementata):** miglioramento dell'installer Windows.
  - **03A:** installazione in directory personalizzate sicure, anche su `D:`;
  - **03B:** scelta esplicita tra Claude Code, Claude Desktop, entrambi o nessuno;
  - **03C:** individuazione affidabile del file di configurazione realmente attivo di Claude Desktop;
  - **03D:** rollback, repair, upgrade e disinstallazione sicuri con più client.
- **Successivamente:** hardening di sicurezza, benchmark su archivi grandi, miglioramento della distribuzione Windows, licenze, CI e release pubblica quando autorizzata.

Il progetto Fluent Reader MCP è indipendente dal fork dell'applicazione e non richiede modifiche a Fluent Reader per le funzionalità read-only attuali.

## Sviluppo e contributi

I test automatici devono utilizzare **profili sintetici**: non utilizzare database personali nei test, nei benchmark o nei log condivisi. Le modifiche al server seguono review indipendente prima dell'integrazione.

Il documento descrive le capacità del codice sorgente attuale, distinguendole da quelle dell'installer già costruito, e non attribuisce alle funzionalità pianificate uno stato di implementazione.
