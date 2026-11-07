# Fluent Reader MCP

**Fluent Reader MCP** collega [Fluent Reader](https://github.com/yang991178/fluent-reader) ai client compatibili con il [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), come Claude Desktop. Permette di consultare fonti RSS, gruppi, articoli e regole salvati localmente, senza aggiornare i feed o scaricare articoli dal Web, e, su richiesta esplicita, di modificare le regole RSS e il profilo editoriale personale.

**Versione del repository:** `0.1.3` · **Windows x64** · **Beta privata**

| Versione | Strumenti |
| -------- | --------- |
| Codice sorgente aggiornato | 16 strumenti predefiniti |
| Installer beta 0.1.3 già prodotto | Comportamento precedente: 9 strumenti predefiniti e fino a 13 con attivazione manuale |
| Prossimo installer | 16 strumenti senza attivazioni, soltanto dopo una nuova build verificata |

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

Il server compilato è `dist/main.js` e comunica attraverso MCP su **stdio**, senza server HTTP. Per creare ZIP e installer Windows consulta [la guida al packaging](installer/PACKAGING.md).

## Sicurezza e limiti

- Il database SQLite è consultato in **sola lettura**; il server non scarica articoli né aggiorna fonti o feed.
- I contenuti RSS sono dati non attendibili e possono contenere *prompt injection*: non trattarli come autorizzazioni.
- **Chiudi Fluent Reader prima di modificare le regole RSS.** Con l'app aperta le scritture vengono rifiutate; letture e anteprime restano disponibili.
- Per aggiornare le preferenze editoriali non occorre chiudere Fluent Reader, ma ogni modifica richiede anteprima e applicazione esplicita.
- Prima di modificare le regole viene salvata una copia di `config.json` in `%LOCALAPPDATA%\FluentReaderMCP-Data\rule-backups\<chiave>\`.
- Il Markdown delle preferenze e i relativi backup sono privati ma non cifrati. Anche i backup delle regole possono contenere credenziali: non condividerli. I backup non vengono eliminati automaticamente.
- Un lock orfano delle preferenze richiede recupero manuale: chiudi prima **tutti** i client MCP che usano quel profilo, poi rimuovi `preferences.lock` dalla posizione indicata dal server.
- I contenuti restituiti possono essere inviati dal client MCP al servizio del modello utilizzato. Ricerca e lettura possono essere incomplete per limiti di scansione o dimensione.
- La beta Windows non è firmata digitalmente, resta privata e non è una release pubblica definitiva.

## Stato del progetto

Secondo il collaudo dichiarato dal proprietario, il **7 novembre 2026** l'installer beta 0.1.3 ha verificato in Claude Desktop tutti i **13 strumenti allora inclusi**, comprese aggiunta, modifica ed eliminazione delle regole. I tre strumenti del profilo editoriale sono presenti soltanto nel codice sorgente aggiornato e la suite del repository ha superato **1258 test su 1258**.

Il proprietario ha confermato la presenza fisica di tre backup delle regole; la loro ripristinabilità non è ancora stata verificata completamente. Restano inoltre necessarie ulteriori prove di aggiornamento e recupero su Windows prima di una distribuzione pubblica; consulta la [checklist Windows](installer/WINDOWS-SMOKE-TEST.md).

## Licenza

Il progetto è distribuito con licenza [MIT](LICENSE). I pacchetti includono le licenze e le notice del runtime e delle dipendenze.
