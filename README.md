# Fluent Reader MCP

**Fluent Reader MCP** collega [Fluent Reader](https://github.com/yang991178/fluent-reader) ai client compatibili con il [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), come Claude Desktop. Permette di consultare fonti RSS, gruppi, articoli e regole salvati localmente, senza aggiornare i feed o scaricare articoli dal Web.

**Versione del repository:** `0.1.3` · **Windows x64** · **Beta privata**

Il codice sorgente aggiornato comprende 9 strumenti di consultazione e 7 strumenti da attivare separatamente. L'installer beta 0.1.3 già prodotto è precedente al profilo editoriale personale e include soltanto i 9 strumenti predefiniti e i 4 strumenti opzionali per le regole.

## Installazione Windows

Servono un profilo locale di Fluent Reader contenente `fluent-reader.db` e `config.json` e un client MCP compatibile. Il pacchetto include Node.js: non occorre installarlo separatamente.

1. Chiudi completamente Claude Desktop prima di avviare l'installer `.exe` della beta.
2. Nel wizard scegli la cartella di installazione e il profilo Fluent Reader.
3. Per collegare Claude Desktop, seleziona **il file di configurazione effettivamente utilizzato dall'app**, verificandolo da *Impostazioni → Modifica configurazione*. In alternativa scegli **Installa solo il server**.
4. Riavvia completamente Claude Desktop e verifica che il server `fluent-reader` esponga **9 strumenti**.

L'installer registra soltanto `mcpServers.fluent-reader`, su conferma dell'utente; non configura automaticamente Claude Code e non abilita le scritture. Per aggiornamento, riparazione, disinstallazione e problemi di configurazione consulta [la guida installer](installer/INSTALLER.md).

## Strumenti MCP disponibili

| Strumento | Funzione | Accesso |
| --------- | -------- | ------- |
| `list_sources` | Elenca le fonti RSS configurate | Sempre attivo |
| `get_source` | Mostra i dettagli di una fonte | Sempre attivo |
| `list_groups` | Elenca i gruppi di fonti | Sempre attivo |
| `get_group` | Mostra un gruppo e le sue fonti | Sempre attivo |
| `get_article` | Legge un articolo salvato localmente | Sempre attivo |
| `list_rules` | Elenca le regole configurate | Sempre attivo |
| `get_rule_chain` | Mostra l'ordine delle regole applicabili | Sempre attivo |
| `list_articles` | Elenca gli articoli locali con filtri | Sempre attivo |
| `search_articles` | Cerca testo negli articoli locali | Sempre attivo |
| `preview_rule_change` | Mostra l'effetto di una modifica alle regole | Da attivare |
| `add_rule` | Aggiunge una regola a una fonte o un gruppo | Da attivare |
| `update_rule` | Modifica una regola esistente | Da attivare |
| `delete_rule` | Elimina una regola esistente | Da attivare |
| `get_news_preferences` | Legge il profilo editoriale personale | Da attivare |
| `preview_news_preferences_change` | Mostra l'anteprima di una preferenza | Da attivare |
| `apply_news_preferences_change` | Salva una preferenza già verificata | Da attivare |

## Attivare le funzionalità aggiuntive

I 9 strumenti di consultazione sono disponibili automaticamente. La gestione delle regole e il profilo editoriale personale richiedono due attivazioni distinte, utilizzabili insieme o indipendentemente:

- Nessuna attivazione: **9 strumenti**.
- Solo regole: **13 strumenti**.
- Solo preferenze editoriali: **12 strumenti**.
- Entrambe: **16 strumenti**.

Aggiungi alla **sola** voce `mcpServers.fluent-reader` della configurazione attiva di Claude Desktop una o entrambe le variabili, senza rimuovere `command`, `args` o altre variabili `env` già necessarie:

```json
"env": {
  "FLUENT_READER_MCP_ENABLE_RULE_WRITES": "1",
  "FLUENT_READER_MCP_ENABLE_NEWS_PREFERENCES": "1"
}
```

Solo il valore esatto `1` abilita ciascuna funzione. Riavvia completamente il client dopo la modifica. L'installer beta 0.1.3 non imposta queste variabili e non contiene i tre strumenti delle preferenze editoriali.

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

Secondo il collaudo dichiarato dal proprietario, il **7 novembre 2026** l'installer beta 0.1.3 ha verificato in Claude Desktop tutti i **13 strumenti allora inclusi**, comprese aggiunta, modifica ed eliminazione delle regole. I tre strumenti del profilo editoriale sono presenti soltanto nel codice sorgente aggiornato e la suite del repository ha superato **1222 test su 1222**.

Il proprietario ha confermato la presenza fisica di tre backup delle regole; la loro ripristinabilità non è ancora stata verificata completamente. Restano inoltre necessarie ulteriori prove di aggiornamento e recupero su Windows prima di una distribuzione pubblica; consulta la [checklist Windows](installer/WINDOWS-SMOKE-TEST.md).

## Licenza

Il progetto è distribuito con licenza [MIT](LICENSE). I pacchetti includono le licenze e le notice del runtime e delle dipendenze.
