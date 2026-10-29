# Fluent Reader MCP

**Fluent Reader MCP** è un server [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) locale, indipendente e **in sola lettura**, che permette ai client compatibili — come **Claude Desktop** e **Claude Code** — di consultare i dati salvati da [Fluent Reader](https://github.com/yang991178/fluent-reader) attraverso il linguaggio naturale.

Il server espone fonti RSS, gruppi, articoli e regole di filtraggio già presenti nel profilo Fluent Reader. Non modifica il database, non aggiorna i feed, non applica le regole e non scarica da Internet il contenuto degli articoli.

> **Stato:** `v0.1.0-beta` — sette strumenti MCP read-only disponibili. L'elenco e la ricerca autonoma degli articoli (`list_articles` e `search_articles`) **non sono ancora implementati**.

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

I seguenti comandi vanno eseguiti nella cartella del repository. Se il repository non è pubblico, occorre disporre dell'accesso necessario per clonarlo. **Questo README descrive la beta locale collaudata:** una copia remota non ancora aggiornata potrebbe avere meno strumenti o script disponibili.

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

La versione attuale implementa **sette strumenti**, tutti in sola lettura.

| Strumento | Cosa fa |
|---|---|
| `list_sources` | Elenca le fonti RSS configurate, con paginazione, filtri e informazioni di visibilità. Non espone per impostazione predefinita URL del feed o dell'icona. |
| `get_source` | Recupera i dettagli di una fonte tramite identificativo, inclusi metadati, gruppo e conteggi delle regole. Non calcola automaticamente statistiche complete sugli articoli. |
| `list_groups` | Elenca i gruppi di fonti salvati in Fluent Reader, mantenendo l'ordine e le informazioni di appartenenza. |
| `get_group` | Recupera un gruppo specifico e le relative fonti, segnalando eventuali anomalie negli identificativi o nelle appartenenze. |
| `get_article` | Legge un articolo tramite ID e restituisce i metadati, gli stati e il **contenuto locale disponibile**; può suddividere testi lunghi in segmenti. Non recupera la pagina web originale. |
| `list_rules` | Elenca le regole RSS archiviate per ambito (globale, gruppo o fonte), senza applicarle o modificarle. |
| `get_rule_chain` | Ricostruisce la sequenza delle regole pertinenti a una fonte: **globali → primo gruppo applicabile → fonte**. Espone la configurazione, non simula l'esecuzione sui singoli articoli. |

**Limite importante:** al momento non esistono `list_articles` e `search_articles`. Per usare `get_article` bisogna conoscere l'ID dell'articolo. Le due funzionalità sono previste nella roadmap **FR-MCP-02B**.

### Esempi di richieste

- «Mostrami tutte le mie fonti RSS» → `list_sources`.
- «Quali gruppi ho creato in Fluent Reader?» → `list_groups`.
- «Mostrami le fonti di questo gruppo» → `get_group`, dopo aver identificato il gruppo.
- «Quali regole si applicano a questa fonte?» → `get_rule_chain`, dopo aver identificato la fonte.
- «Leggi l'articolo con ID 1234» → `get_article` (l'ID è un esempio e deve esistere nel proprio database).

## Collegamento ai client Claude

### Claude Code

L'installer Windows attuale può proporre la registrazione del server **`fluent-reader`** in Claude Code, nello scope **`user`**, **solo dopo un consenso esplicito**. È possibile installare il server senza registrarlo.

### Claude Desktop

Il server è stato collaudato con successo anche con **Claude Desktop**, ma **la beta attuale non ne configura automaticamente la registrazione**. Per usarlo occorre aggiungere manualmente una voce `fluent-reader` nella sezione `mcpServers` del file di configurazione **effettivamente utilizzato** dal client, indicando l'eseguibile Node incluso o quello di sviluppo, `dist/main.js` e `--profile-dir`.

**Attenzione ai percorsi Windows:** la configurazione attiva di Claude Desktop può trovarsi in posizioni diverse secondo la distribuzione e la versione (per esempio sotto `%LOCALAPPDATA%\Claude-Data\...`), non necessariamente in `%APPDATA%\Claude`. Verifica sempre il percorso tramite **Claude Desktop → Impostazioni → Server MCP locali → Modifica configurazione**. Crea un backup e preserva tutte le altre entry MCP e preferenze.

Una futura versione dell'installer prevede una scelta esplicita tra **Claude Code**, **Claude Desktop**, **entrambi** oppure **nessuna registrazione**.

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
- **Uso con Claude:** i contenuti restituiti dagli strumenti possono essere inviati dal client ai servizi di Anthropic. Valuta quali informazioni condividere.
- **Beta privata:** la revisione delle licenze, delle notice delle dipendenze, dei test di upgrade/recovery su Windows reale e della firma del codice è ancora necessaria prima di una distribuzione pubblica.

## Stato e roadmap

- **Completato:** sette strumenti read-only; ZIP Windows con Node incluso; primo installer NSIS; test end-to-end dei sette strumenti con Claude Desktop e un profilo reale, più installazione/disinstallazione ordinaria in Windows Sandbox.
- **FR-MCP-02B (prossima fase):** `list_articles`, poi `search_articles`, con paginazione, filtri, limiti prestazionali e test su database sintetici.
- **FR-MCP-04-BETA-03:** scelta di un percorso di installazione locale sicuro anche fuori da `C:`, supporto alla registrazione Claude Desktop e identificazione affidabile del suo file di configurazione attivo.
- **Successivamente:** hardening di sicurezza, benchmark su archivi grandi, miglioramento della distribuzione Windows, licenze, CI e release pubblica quando autorizzata.

Il progetto Fluent Reader MCP è indipendente dal fork dell'applicazione e non richiede modifiche a Fluent Reader per le funzionalità read-only attuali.

## Sviluppo e contributi

I test automatici devono utilizzare **profili sintetici**: non utilizzare database personali nei test, nei benchmark o nei log condivisi. Le modifiche al server seguono review indipendente prima dell'integrazione.

Il documento descrive le capacità della beta attuale e non attribuisce alle funzionalità pianificate uno stato di implementazione.
