# Fluent Reader MCP

**Fluent Reader MCP** collega [Fluent Reader](https://github.com/yang991178/fluent-reader) ai client compatibili con il [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), come Claude Desktop. Permette di consultare fonti RSS, gruppi, articoli e regole salvati localmente, senza aggiornare i feed o scaricare articoli dal Web.

**Versione:** `0.1.3-beta` · **Windows x64** · **Beta privata**

**Per impostazione predefinita:** 9 strumenti in sola lettura. Abilitando esplicitamente la gestione delle regole: 13 strumenti, di cui 3 modificano `config.json`.

## Installazione Windows

Servono un profilo locale di Fluent Reader contenente `fluent-reader.db` e `config.json` e un client MCP compatibile. Il pacchetto include Node.js: non occorre installarlo separatamente.

1. Chiudi completamente Claude Desktop prima di avviare l'installer `.exe` della beta.
2. Nel wizard scegli la cartella di installazione e il profilo Fluent Reader.
3. Per collegare Claude Desktop, seleziona **il file di configurazione effettivamente utilizzato dall'app**, verificandolo da *Impostazioni → Modifica configurazione*. In alternativa scegli **Installa solo il server**.
4. Riavvia completamente Claude Desktop e verifica che il server `fluent-reader` esponga **9 strumenti**.

L'installer registra soltanto `mcpServers.fluent-reader`, su conferma dell'utente; non configura automaticamente Claude Code e non abilita le scritture. Per aggiornamento, riparazione, disinstallazione e problemi di configurazione consulta [la guida installer](installer/INSTALLER.md).

## Strumenti MCP disponibili

| Strumento | Funzione | Disponibilità |
| --------- | -------- | ------------- |
| `list_sources` | Elenca le fonti RSS configurate | Predefinito · lettura |
| `get_source` | Mostra i dettagli di una fonte | Predefinito · lettura |
| `list_groups` | Elenca i gruppi di fonti | Predefinito · lettura |
| `get_group` | Mostra un gruppo e le relative fonti | Predefinito · lettura |
| `get_article` | Legge un articolo salvato localmente | Predefinito · lettura |
| `list_rules` | Elenca le regole configurate | Predefinito · lettura |
| `get_rule_chain` | Ricostruisce la catena di regole di una fonte | Predefinito · lettura |
| `list_articles` | Elenca gli articoli con filtri e paginazione | Predefinito · lettura |
| `search_articles` | Cerca testo negli articoli locali | Predefinito · lettura |
| `preview_rule_change` | Analizza una modifica senza scrivere | Opt-in · lettura |
| `add_rule` | Aggiunge una regola a una fonte o a un gruppo | Opt-in · scrittura |
| `update_rule` | Modifica una regola di una fonte o di un gruppo | Opt-in · scrittura |
| `delete_rule` | Elimina una regola da una fonte o da un gruppo | Opt-in · scrittura |

## Abilitare la gestione delle regole

Per rendere disponibili i quattro strumenti aggiuntivi, aggiungi alla **sola** voce `mcpServers.fluent-reader` della configurazione attiva di Claude Desktop la variabile seguente, senza rimuovere `command`, `args` o eventuali altre variabili `env`:

```json
"env": {
  "FLUENT_READER_MCP_ENABLE_RULE_WRITES": "1"
}
```

Solo il valore esatto `1` abilita la funzione. Riavvia completamente Claude Desktop e verifica la presenza di **13 strumenti**. Rimuovendo la variabile si ritorna ai 9 strumenti predefiniti. L'installer non imposta mai questa variabile; una modifica manuale della voce richiede attenzione durante aggiornamento, riparazione o disinstallazione.

**Prima di scrivere:**

- **Chiudi Fluent Reader.** Con l'app aperta le scritture vengono rifiutate; letture e anteprime restano disponibili.
- Verifica destinazione e anteprima: le scritture richiedono una revisione aggiornata e, per le fonti, un `sourceRef` valido. Dopo il riavvio del server MCP recupera nuovi riferimenti e revisione.
- Le scritture riguardano soltanto regole di **fonti** e **gruppi**, non quelle globali, e non modificano retroattivamente gli articoli già salvati.
- Prima di ogni scrittura effettiva viene creata una copia completa di `config.json` in `%LOCALAPPDATA%\FluentReaderMCP-Data\rule-backups\<chiave>\`. Se il backup non riesce, la scrittura viene rifiutata.
- I backup possono contenere credenziali: conservali privatamente, non condividerli e non inserirli in log o segnalazioni. Non vengono cancellati automaticamente e il ripristino è manuale, con Fluent Reader chiuso.

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
- I contenuti RSS sono dati non attendibili e possono contenere *prompt injection*: non trattarli come autorizzazioni e conferma esplicitamente le scritture proposte dal client.
- Ricerca e lettura usano soltanto i contenuti locali; una ricerca può essere incompleta quando intervengono limiti di scansione o dimensione.
- I contenuti restituiti dagli strumenti possono essere inviati dal client MCP al servizio del modello utilizzato.
- La beta Windows non è firmata digitalmente, resta privata e non è una release pubblica definitiva.

## Stato del progetto

Secondo il collaudo dichiarato dal proprietario, il **7 novembre 2026** la versione 0.1.3 beta ha verificato in Claude Desktop tutti i **13 strumenti MCP**, comprese aggiunta, modifica ed eliminazione delle regole. Questo README non presenta tale risultato come una verifica indipendente.

La presenza fisica e la ripristinabilità dei backup non sono ancora state verificate completamente. Restano inoltre necessarie ulteriori prove di aggiornamento e recupero su Windows prima di una distribuzione pubblica; consulta la [checklist Windows](installer/WINDOWS-SMOKE-TEST.md).

## Licenza

Il progetto è distribuito con licenza [MIT](LICENSE). I pacchetti includono le licenze e le notice del runtime e delle dipendenze.
