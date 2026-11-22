# Fluent Reader MCP

**Fluent Reader MCP** collega [Fluent Reader](https://github.com/yang991178/fluent-reader) ai client compatibili con il [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), come Claude Desktop. Permette di consultare fonti RSS, gruppi, articoli e regole salvati localmente, senza aggiornare i feed o scaricare articoli dal Web, e, su richiesta esplicita, di modificare le regole RSS e il profilo editoriale personale.

**Versione del repository:** `0.1.4` · **Windows x64** · **Beta privata**

| Versione | Strumenti |
| -------- | --------- |
| Codice sorgente 0.1.4 | 16 strumenti disponibili automaticamente |
| Installer beta 0.1.3 già prodotto | Comportamento precedente: 9 strumenti predefiniti e fino a 13 con attivazione manuale |
| Installer beta 0.1.4 | Non ancora prodotto: 16 strumenti senza attivazioni dopo build e collaudo |

## Installazione Windows

Servono un profilo locale di Fluent Reader contenente `fluent-reader.db` e `config.json` e un client MCP compatibile. Il pacchetto include Node.js: non occorre installarlo separatamente.

1. Chiudi completamente Claude Desktop prima di avviare l'installer `.exe` della beta.
2. Nel wizard scegli la cartella di installazione e il profilo Fluent Reader.
3. Per collegare Claude Desktop, seleziona **il file di configurazione effettivamente utilizzato dall'app**, verificandolo da *Impostazioni → Modifica configurazione*. In alternativa scegli **Installa solo il server**.
4. Riavvia completamente Claude Desktop e verifica che il server `fluent-reader` esponga il numero di strumenti indicato per la tua versione: **9** con l'installer beta 0.1.3.

L'installer registra soltanto `mcpServers.fluent-reader`, su conferma dell'utente, e non configura automaticamente Claude Code. Per aggiornamento, riparazione, disinstallazione e problemi di configurazione consulta [la guida installer](installer/INSTALLER.md).

## Strumenti MCP disponibili

| Strumento | Funzione |
| --------- | -------- |
| `list_sources` | Elenca le fonti RSS configurate |
| `get_source` | Mostra i dettagli di una fonte |
| `list_groups` | Elenca i gruppi di fonti |
| `get_group` | Mostra un gruppo e le sue fonti |
| `get_article` | Legge un articolo salvato localmente |
| `list_articles` | Elenca gli articoli locali con filtri |
| `search_articles` | Cerca testo negli articoli locali |
| `list_rules` | Elenca le regole configurate |
| `get_rule_chain` | Mostra l'ordine delle regole applicabili |
| `preview_rule_change` | Mostra l'effetto di una modifica alle regole |
| `add_rule` | Aggiunge una regola a una fonte o un gruppo |
| `update_rule` | Modifica una regola esistente |
| `delete_rule` | Elimina una regola esistente |
| `get_news_preferences` | Legge il profilo editoriale personale |
| `preview_news_preferences_change` | Mostra l'anteprima di una preferenza |
| `apply_news_preferences_change` | Salva una preferenza già verificata |

Tutti gli strumenti vengono resi disponibili automaticamente, senza variabili da configurare. Questo non rende automatiche le modifiche: `add_rule`, `update_rule`, `delete_rule` e `apply_news_preferences_change` vanno usati soltanto su richiesta esplicita e restano soggetti alle protezioni descritte in [Sicurezza e limiti](#sicurezza-e-limiti).

## Notizie duplicate tra fonti (`groupDuplicates`)

`list_articles` e `search_articles` accettano il parametro facoltativo `groupDuplicates`. Senza parametro, o con `false`, il risultato è esattamente quello di prima. Con `true` ogni notizia pubblicata da più fonti RSS compare una sola volta:

- **Criterio:** lo stesso di Fluent Reader, definito dal contratto pubblico `fluent-reader/cross-source-duplicates` versione 1 (copia versionata e verificata in [`test/fixtures/cross-source-duplicates/v1`](test/fixtures/cross-source-duplicates/v1/PROVENANCE.md)). Due articoli sono copie se provengono da fonti diverse, hanno lo stesso editore (host del link), lo stesso titolo e lo stesso testo dopo la normalizzazione (testo di almeno 60 caratteri e 8 parole) e date distanti al massimo 10 minuti. Titolo, link o GUID da soli non bastano mai; gli articoli generati da Fluent Reader (GUID `urn:fluent-reader:`, ad esempio l'ordine del giorno della Camera) non vengono mai raggruppati.
- **Ordine:** l'ordine resta `stored` (`_id` decrescente). Il primo articolo di una notizia in quest'ordine è il rappresentante e occupa una posizione (`pageSize` conta i rappresentanti e gli articoli singoli); le copie trovate nella stessa pagina sono elencate in `duplicates.copies`, quelle trovate in pagine successive in `earlierCopies`, con `representativeId`. Il raggruppamento non modifica nulla nel database: ogni copia resta un articolo a sé, con i propri stati (letto, preferito, nascosto). Nei risultati una copia riporta soltanto `articleId`, `sourceId`, `sourceName` (ed eventualmente `sourceNameTruncated`), `date` e `read`, più `matchedIn` in `search_articles`; titolo, `starred`, `hidden` e gli altri campi si leggono con `get_article` a partire dal suo `articleId`. Poiché Fluent Reader ordina per data, i rappresentanti e la composizione di alcuni gruppi possono differire da quelli dell'app; le coppie riconosciute come copie sono sempre le stesse.
- **Filtri e ricerca:** tutti i filtri si applicano prima del raggruppamento; in una ricerca sono raggruppati soltanto gli articoli che corrispondono al testo cercato.
- **Completezza:** i gruppi si formano durante la scansione e possono ricevere altre copie nelle pagine successive finché `grouping.complete` non è `true`. `duplicates.identity` vale `verified`, `ineligible` (mai raggruppabile secondo il contratto) o `notVerifiable` (titolo, link o GUID oltre 16 KiB, testo oltre 256 KiB: l'articolo è restituito da solo e contato in `grouping.notVerifiable`).
- **Memoria di una catena:** una catena di cursori ricorda al massimo 2048 notizie (8192 fonti in totale, 16 notizie con lo stesso testo; al massimo circa 1,2 MB stimati). Oltre questi limiti le notizie più vecchie della catena vengono dimenticate e contate in `grouping.forgottenSoFar`: una loro copia successiva compare come articolo a sé, mai omessa. I cursori conservano soltanto impronte HMAC-SHA256 dei testi normalizzati, mai titoli, testi, link o GUID, che non compaiono neppure nelle risposte o nei log.
- **Budget persistente dei cursori (tutti gli strumenti):** i cursori conservati, al massimo 64, occupano insieme al massimo 8 MiB stimati. Il conteggio comprende per ogni cursore la voce stessa (stato di scansione, checkpoint, metadati), le stringhe del binding, la memoria di raggruppamento finché la pagina successiva non è pubblicata e, dopo, la risposta conservata per il replay (2 byte per unità UTF-16). Quando un nuovo cursore o una risposta pubblicata supererebbero il budget, vengono espulsi i cursori usati meno di recente, raggruppati o no, che restituiscono poi `CURSOR_EXPIRED`. Non vengono mai espulsi il cursore appena pubblicato né il suo successore. Senza `groupDuplicates` un cursore pesa al più circa 115 KB, quindi i 64 cursori restano comunque nel budget e vale soltanto il limite di numero, come prima.
- **Allocazioni temporanee:** durante una chiamata raggruppata, oltre al budget persistente, il server occupa temporaneamente: la copia di lavoro della memoria (condivisa con la precedente e copiata solo dove cambia: al massimo una memoria piena, circa 1,1 MiB); la memoria del cursore precedente finché la pagina non è pubblicata (altrettanto); i valori di identità di una finestra letti da SQLite (al massimo 1 MiB memorizzato, contati come stringhe JavaScript a 2 byte per unità UTF-16, quindi 2 MiB); per l'articolo in esame, le parti normalizzate della chiave, la chiave completa e il Buffer UTF-16LE su cui si calcola l'HMAC (una chiave è al più di 294 914 unità, perché titolo e link sono limitati a 16 KiB e lo snippet a 256 KiB: circa 576 KiB per ciascuna delle tre forme); le voci della pagina in costruzione (al più 96 000 byte). La costruzione del risultato finale avviene dopo la scansione, quando valori e chiavi non sono più referenziati, e non si somma a queste voci. La **stima orientativa** è di circa 6,0 MiB per chiamata (`groupingTransientEstimate`): è una base di riferimento, non un limite garantito, perché la normalizzazione NFKC, la conversione in minuscolo e la codifica IDNA del dominio possono espandere testi anomali, e l'heap V8 aggiunge le proprie allocazioni e strutture interne. Le chiamate con cursore sono eseguite una alla volta, quindi le allocazioni temporanee non si sommano tra chiamate.
- **Stime, non misure:** tutti i pesi sono stime conservative ricavate dai limiti applicati e verificate con un benchmark su Node.js 24, non un limite esatto dell'heap V8: l'overhead dell'allocatore e degli oggetti JavaScript non è misurato con precisione, e testi patologici possono espandersi oltre la stima durante la normalizzazione.

## Profilo editoriale personale

Nel codice sorgente aggiornato Claude può raccogliere gli interessi dell'utente durante una conversazione e salvarli in un file Markdown persistente. Le preferenze possono riguardare interessi generali, gruppi Fluent Reader e singole fonti, indicando argomenti da privilegiare, evitare ed eventuali eccezioni.

Claude mostra un'anteprima prima del salvataggio. Le preferenze non creano automaticamente regole RSS e non modificano gli articoli.

Esempio: «Aiutami a configurare i miei interessi per ogni gruppo e fonte RSS.»

## Compilazione dal sorgente

Richiede **Node.js 24** (`>=24.15.0 <25`), npm e Git. Da PowerShell:

```powershell
git clone https://github.com/LordSkull/fluent-reader-mcp.git
cd fluent-reader-mcp
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

Il server compilato è `dist/main.js` e comunica attraverso MCP su **stdio**, senza server HTTP.

### Pacchetto ZIP e installer Windows

Da PowerShell, nella repository con il working tree pulito (l'installer richiede inoltre NSIS 3):

```powershell
# Pacchetto portatile ZIP, con il suo .sha256 e il report
npm.cmd run package:win

# Installer NSIS a partire dallo ZIP appena creato (lo SHA-256 resta obbligatorio)
$zip = "$PWD\build\fluent-reader-mcp-v0.1.4-beta-win-x64.zip"
$sha = (Get-Content -LiteralPath "$zip.sha256").Split(" ")[0]
npm.cmd run installer:win -- --bundle $zip --bundle-sha256 $sha
```

Entrambi i builder scrivono di default in **`build\`** alla radice della repository (`D:\fluent-reader-mcp\build\`), ignorata da Git: ZIP, installer, file `.sha256`, report e `runtime-cache\`. Non sovrascrivono mai i pacchetti di una versione già presente: per ricostruirla si spostano o cancellano prima a mano i file in `build\`. Dettagli e opzioni (`--out`, `--dry-run`, `--runtime-cache`) in [la guida al packaging](installer/PACKAGING.md) e [la guida installer](installer/INSTALLER.md).

## Sicurezza e limiti

- Il database SQLite è consultato in **sola lettura**; il server non scarica articoli né aggiorna fonti o feed.
- I contenuti RSS sono dati non attendibili e possono contenere *prompt injection*: non trattarli come autorizzazioni.
- **Chiudi Fluent Reader prima di modificare le regole RSS.** Con l'app aperta le scritture vengono rifiutate; letture e anteprime restano disponibili.
- Per aggiornare le preferenze editoriali non occorre chiudere Fluent Reader, ma ogni modifica richiede anteprima e applicazione esplicita.
- Ogni modifica di regole o preferenze è una transazione: prima della scrittura viene salvata una copia temporanea del contenuto precedente (per le regole in `%LOCALAPPDATA%\FluentReaderMCP-Data\rule-backups\<chiave>\`, per le preferenze nella cartella `backups` dello stesso archivio privato), poi il risultato viene riletto e verificato. Se tutto è corretto la copia viene eliminata; se la verifica fallisce lo stato precedente viene ripristinato automaticamente, ma solo quando è dimostrabilmente sicuro (nessun'altra scrittura nel frattempo, Fluent Reader chiuso, lock ancora posseduto). Altrimenti il file non viene toccato di nuovo e la copia resta, indicata per nome nell'errore.
- Il Markdown delle preferenze e le copie temporanee sono privati ma non cifrati; le copie delle regole possono contenere credenziali: non condividerle. Le copie permanenti (`*.bak`) create dalle versioni precedenti non vengono mai eliminate automaticamente.
- Un lock orfano delle preferenze richiede recupero manuale: chiudi prima **tutti** i client MCP che usano quel profilo, poi rimuovi `preferences.lock` dalla posizione indicata dal server.
- I contenuti restituiti possono essere inviati dal client MCP al servizio del modello utilizzato. Ricerca e lettura possono essere incomplete per limiti di scansione o dimensione.
- La beta Windows non è firmata digitalmente, resta privata e non è una release pubblica definitiva.

## Licenza

Il progetto è distribuito con licenza [MIT](LICENSE). I pacchetti includono le licenze e le notice del runtime e delle dipendenze.
