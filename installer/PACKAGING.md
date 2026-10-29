# FR-MCP-04-BETA-01 — Pacchetto portatile Windows x64 (beta privata)

Builder del pacchetto ZIP autonomo di Fluent Reader MCP, limitato agli otto strumenti read-only (i sette di FR-MCP-02A e `list_articles` di FR-MCP-02B-01).
Il pacchetto non è un installer: non registra nulla, non crea servizi né porte di rete, non legge profili.

> Stato: script pronti per la review. Il pacchetto **non è ancora stato costruito**: lo costruisce il proprietario,
> dopo l'approvazione, con i comandi qui sotto. Distribuzione **solo privata** finché la verifica delle licenze
> (incluso la licenza del progetto, D-13) non è chiusa.

## File

| File | Ruolo |
| --- | --- |
| `installer/build-portable.ts` | CLI del builder (`npm.cmd run package:win`) |
| `installer/runtime-lock.json` | Runtime Node.js fissato: versione, URL ufficiale, SHA-256 attestato |
| `installer/lib/pipeline.ts` | Sequenza di build, controlli e rifiuti |
| `installer/lib/runtime-lock.ts` | Validazione fail-closed del lock |
| `installer/lib/runtime.ts` | Cache, download, verifica SHA-256 ed estrazione di `node.exe` e `LICENSE` |
| `installer/lib/zip.ts` | ZIP deterministico in Node puro (scrittura e lettura verificata) |
| `installer/lib/package-content.ts` | Contenuti ammessi, dipendenze attese, licenze, manifest |
| `installer/lib/selftest.ts` | Auto-test del pacchetto estratto su profilo sintetico |
| `test/packaging/*.test.ts` | Test del builder su file sintetici (nessuna rete) |

Il builder è compilato insieme ai test (`tsconfig.test.json`) ed eseguito da `dist-test/installer/`, come la CLI
dello smoke test. Non usa dipendenze npm aggiuntive.

## Prerequisiti della macchina di build

- Windows 10/11 x64.
- Node.js 24 compatibile con `engines` (`>=24.15.0 <25`), installazione standard (con `npm`).
- Git nel `PATH` e working tree pulito (`git status` senza modifiche).
- Dipendenze di sviluppo della repository installate (`npm.cmd ci`): servono TypeScript e i test.
- Accesso a `https://nodejs.org/dist/` (solo se il runtime non è già in cache) e al registro npm (o alla cache npm)
  per le dipendenze production.

Il PC che userà il pacchetto non ha bisogno di Node, npm, Git o TypeScript.

## Comandi per il proprietario

Da PowerShell, nella repository, **dopo l'APPROVE di Codex**:

```powershell
cd D:\fluent-reader-mcp
git status
npm.cmd run typecheck
npm.cmd test

# 1. Prova a secco (vedi sotto che cosa scrive e che cosa no)
npm.cmd run package:win -- --out "D:\FluentReaderMCP-build" --dry-run

# 2. Build reale
npm.cmd run package:win -- --out "D:\FluentReaderMCP-build"
```

`--out` è obbligatorio: deve essere un percorso assoluto **fuori** dalla repository, anche dopo aver risolto
collegamenti e junction. Spazi e caratteri Unicode sono ammessi (gli argomenti non passano mai per una shell; lo
script npm invoca solo `node`).

### Che cosa scrive il dry-run

- **Il comando npm** `npm.cmd run package:win -- … --dry-run` esegue prima la compilazione TypeScript del builder
  (`node node_modules/typescript/bin/tsc -p tsconfig.test.json`), che **rigenera `dist-test/`** nella repository
  (cartella già ignorata da Git). Questa scrittura è necessaria per eseguire il builder e non viene evitata.
- **Il builder in modalità `--dry-run`**, dopo la compilazione, esegue tutti i controlli preliminari e verifica
  l'eventuale runtime già in cache, poi si ferma: non scarica Node, non esegue `npm ci`, non crea la cartella
  `--out`, la cartella di lavoro, lo staging, la cache, lo ZIP o altri file.

Opzioni:

| Opzione | Effetto |
| --- | --- |
| `--dry-run` | Il builder esegue i controlli e verifica l'eventuale runtime in cache; non scarica e non crea file (la compilazione npm che lo precede aggiorna `dist-test/`) |
| `--runtime-cache <dir>` | Cache del runtime (default `<out>\runtime-cache`); riusabile fra build; deve essere disgiunta da repository, cartella di lavoro, staging, verifica e artefatti |
| `--allow-dirty` | Consente modifiche non committate; registrato come `gitDirty: true` nel manifest |
| `--keep-work` | Conserva `<out>\work-<versione>` (staging e verifica) per ispezione |

## Cosa fa il builder

1. **Controlli preliminari:** Windows x64; `package.json` (nome, versione `MAJOR.MINOR.PATCH`, `engines`) coerente con
   `package-lock.json`; `runtime-lock.json` valido; Node 24, Git, `npm-cli.js` e TypeScript presenti; working tree
   pulito; output **mai sovrascritto** (ZIP, `.sha256`, report, i loro `.partial` o la cartella di lavoro già
   esistenti fermano la build). I percorsi sono controllati nella forma **canonica**: per `--out` e
   `--runtime-cache` l'antenato esistente è risolto con `realpath` (collegamenti, junction, nomi 8.3, maiuscole) e i
   segmenti mancanti sono aggiunti. `--out` non può stare dentro la repository né contenerla; la cache non può
   sovrapporsi (in nessuno dei due sensi) a repository, `work-<versione>`, `stage\FluentReaderMCP`, `verify` o agli
   artefatti finali o ai loro nomi temporanei `.partial`; un collegamento pendente sul percorso è rifiutato. Tutte le scritture usano poi il percorso
   canonico. Questi controlli avvengono prima di qualsiasi download, `npm ci` o scrittura; non proteggono da un
   processo locale che modifichi le junction durante la build.
2. **Runtime:** usa `runtime-cache\node-v24.22.1-win-x64.zip` solo se il suo SHA-256 è quello fissato (un file in
   cache diverso viene segnalato e lasciato dov'è); altrimenti lo scarica dall'URL ufficiale in un file `.partial`,
   lo accetta solo se l'hash coincide con quello fissato **e** con quello di `SHASUMS256.txt` della stessa versione.
   Nulla viene estratto prima della verifica; vengono estratti solo `node.exe` e `LICENSE`. Poi `node.exe --version`
   deve essere `v24.22.1` e la piattaforma `win32 x64`. Il Node globale non viene mai incluso.
3. **Server:** compilato dai sorgenti con il TypeScript della repository direttamente nello staging, senza source
   map; nello staging entra solo JavaScript.
4. **Dipendenze production:** `npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64` in una cartella separata
   (`<out>\work-<versione>\deps`), con una **configurazione npm isolata** in `<out>\work-<versione>\npm\`:
   `--userconfig npm\user.npmrc` (solo `registry=https://registry.npmjs.org/`, `audit`, `fund` e
   `update-notifier` disattivati), `--globalconfig npm\global.npmrc` (vuoto), `--cache npm\cache`,
   `--logs-dir npm\logs` e `--registry https://registry.npmjs.org/`. L'**ambiente** di npm non è una copia di
   quello del builder: è costruito da una lista chiusa e contiene solo `SystemRoot`, `WINDIR`, `ComSpec` (copiati
   se sono percorsi assoluti), `PATH` minimo (cartella del Node.js della macchina di build, `%SystemRoot%\System32`,
   `%SystemRoot%`), `PATHEXT` fisso, `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` in una home sintetica
   `npm\home` e `TEMP`/`TMP` in `npm\tmp`. Qualsiasi altra variabile (token come `GITHUB_TOKEN` o
   `NODE_AUTH_TOKEN`, `GIT_*`, `SSL_CERT_*`, `OPENSSL_CONF`, proxy, certificati, `npm_*`, variabili personali)
   non raggiunge npm. Node e `npm-cli.js` sono invocati per percorso assoluto. Il `.npmrc` personale, l'`npmrc`
   globale e la cache npm dell'utente non vengono letti né scritti, e nessun token personale raggiunge npm (npm
   legge solo il proprio `npmrc` di installazione, che non è personale). Una rete che richiede una
   configurazione npm privata (registry interno, proxy, certificati) **non è supportata**: `npm ci` fallisce e il
   builder si ferma con un messaggio che lo dice e indica la cartella dei log npm. La cache npm si trova nella
   cartella di lavoro, fuori da `stage\FluentReaderMCP`, e viene cancellata con essa: ogni build riscarica le
   dipendenze dal registro pubblico, che le verifica con gli hash `integrity` del lockfile. Il builder verifica che
   `node_modules\.package-lock.json` e `package-lock.json` della repository non cambino. L'insieme installato deve
   essere esattamente quello del lockfile per win32/x64:
   `@koromix/koffi-win32-x64@3.3.4`, `@modelcontextprotocol/core@2.4.0`, `@modelcontextprotocol/server@2.4.0`,
   `koffi@3.3.4`, `zod@4.6.7`. Koffi 3.3.4 non compila nulla: il modulo nativo arriva precompilato dal pacchetto
   opzionale `@koromix/koffi-win32-x64` (`win32_x64/koffi.node`), che deve essere presente; lo script `install`
   di Koffi (che verificherebbe il binario o ricompilerebbe con CMake) non viene eseguito. Vengono esclusi `.bin` e
   `.package-lock.json`. I pacchetti di terze parti sono inclusi come pubblicati su npm (zod, per esempio,
   contiene i propri sorgenti e test).
5. **Contenuti:** licenze, `PACKAGING-INFO.md`, controllo dei contenuti vietati (database e file SQLite,
   `fluent-reader.db*`, `.env*`, `.npmrc`, `.claude`/`.claude.json`, `.mcp.json`, trascrizioni Claude, record degli
   smoke test, chiavi e certificati, `config.json` in radice): una corrispondenza **ferma** la build invece di
   escludere il file in silenzio. Poi il manifest.
6. **Archivio:** ZIP deterministico (ordine stabile, data del commit, nomi UTF-8), riletto, estratto in
   `work-<versione>\verify`, ogni file confrontato con il manifest; quindi **auto-test** del pacchetto estratto:
   il suo `runtime\node.exe` avvia il suo `server\dist\main.js` su un profilo **sintetico** (la fixture dello smoke
   test) in una cartella temporanea, con handshake MCP, `tools/list` (esattamente otto strumenti), `list_sources`
   e `get_article` (SQLite e lock Win32/Koffi), chiusura con EOF.
7. **Pubblicazione, fase A (preparazione):** ZIP, `.sha256` e report vengono scritti come
   `<nome>.partial`, ciascuno **creato in modo esclusivo** (fallisce se il nome esiste già); un `.partial`
   appartiene alla build solo se questa creazione è riuscita. Dopo tutte le verifiche e l'auto-test la cartella di
   lavoro viene rimossa (salvo `--keep-work`). Nessun file ha ancora il nome definitivo.
8. **Pubblicazione, fase B (promozione):** il builder controlla che nessun nome definitivo esista, poi crea
   nell'ordine ZIP, `.sha256` e report con un **hard link** dal `.partial` al nome definitivo e rimuove il
   `.partial`. L'hard link fallisce in modo atomico se il nome esiste già, anche se il file compare un istante prima:
   un file presente in `--out` non viene **mai sovrascritto** (non si ricorre mai a una rinomina che sovrascrive).
   Se un passo fallisce, il builder rimuove i nomi definitivi creati da questa esecuzione; se il rollback non riesce
   a rimuovere un file, l'errore lo indica per nome ("ROLLBACK FAILED"). Su Windows tre file non si pubblicano in
   un'unica transazione: è una promozione ordinata con rollback.

   **Requisito:** `--out` deve stare su un volume che supporta gli hard link (**NTFS**; FAT32 ed exFAT no). Il
   builder lo verifica subito dopo aver creato la cartella di lavoro, prima di scaricare o installare, e altrimenti
   si ferma con un errore che lo spiega.

In caso di errore la build termina con un messaggio `package:win: …` e non lascia artefatti con il nome definitivo.
Rimuove solo i file temporanei che ha creato lei stessa (registrati al momento della creazione esclusiva e ancora
identici): un `.partial` con lo stesso nome creato da altri resta intatto (la build si ferma con "already exists");
uno sostituito dopo la creazione resta dov'è ed è segnalato nel log ("Cleanup: …"), senza nascondere l'errore che
ha fermato la build.
Se l'errore avviene prima della pulizia, la cartella `work-<versione>` resta per l'ispezione: non è un artefatto e
va cancellata prima della build successiva.

## Output

```text
D:\FluentReaderMCP-build\
  fluent-reader-mcp-v0.1.0-beta-win-x64.zip
  fluent-reader-mcp-v0.1.0-beta-win-x64.zip.sha256
  fluent-reader-mcp-v0.1.0-beta-win-x64.zip.build-report.json
  runtime-cache\node-v24.22.1-win-x64.zip
```

Il nome deriva da `package.json` (`0.1.0`) più l'etichetta di canale `beta` e la piattaforma `win-x64`.
Non esiste ancora una politica per numerare le beta (`0.1.0-beta.1`, …): due build della stessa versione hanno lo
stesso nome, e la seconda viene rifiutata se la prima è ancora nella cartella di output. La decisione spetta al
proprietario.

Struttura dello ZIP:

```text
FluentReaderMCP/
  PACKAGING-INFO.md          avvio manuale, contenuto, privacy
  manifest.json              versione e SHA-256 di ogni altro file
  runtime/node.exe           Node.js 24.22.1 ufficiale
  runtime/LICENSE
  server/package.json        minimo: nome, versione, "type": "module", dipendenze
  server/dist/**/*.js
  server/node_modules/...    sole dipendenze production
  licenses/node/LICENSE
  licenses/npm/<pacchetto>@<versione>/LICENSE...
```

## Verifica manuale

```powershell
$zip = "D:\FluentReaderMCP-build\fluent-reader-mcp-v0.1.0-beta-win-x64.zip"
(Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
Get-Content -LiteralPath "$zip.sha256"
```

I due valori devono coincidere. Dopo l'estrazione, `manifest.json` elenca SHA-256 e dimensione di ogni file.

Avvio manuale del pacchetto estratto (il server parla MCP su stdin/stdout; si usa da un client MCP):

```powershell
& "<cartella>\FluentReaderMCP\runtime\node.exe" "<cartella>\FluentReaderMCP\server\dist\main.js" --profile-dir "<profilo Fluent Reader>"
```

## Pulizia

- `<out>\work-<versione>`: resta solo dopo un errore o con `--keep-work` (contiene staging, verifica, dipendenze,
  configurazione, cache e log npm); si può cancellare.
- `<out>\*.partial`: quelli creati dalla build sono rimossi automaticamente in caso di errore; se ne restano (per
  esempio dopo un'interruzione del processo, o se il log "Cleanup: …" li elenca), vanno controllati e cancellati a
  mano: la build successiva si ferma finché esistono.
- `<out>\runtime-cache`: si può conservare per le build successive (viene riverificata ogni volta) o cancellare.
- Per rimuovere tutto: cancellare la cartella `--out`. Il builder non scrive altrove, salvo una cartella
  temporanea `frmcp-package-selftest-*` in `%TEMP%`, rimossa al termine dell'auto-test.

## Runtime Node.js fissato

`runtime-lock.json` fissa Node.js **24.22.1** (`node-v24.22.1-win-x64.zip`, ultima 24.x il 2026-10-28, LTS
"Krypton", release di sicurezza del 2026-10-20) con SHA-256
`d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5`.

Attestazione, eseguita il 2026-10-28 senza scaricare Node: `SHASUMS256.txt.asc` di v24.22.1 da nodejs.org è
firmato dalla chiave del releaser `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356` (Antoine du Hamel), presente in
`keys.list` di [nodejs/release-keys](https://github.com/nodejs/release-keys); `gpg --verify` in un keyring temporaneo
ha dato `GOODSIG`/`VALIDSIG` e il contenuto firmato coincide con `SHASUMS256.txt`.

Il lock viene rifiutato se la versione non è Node 24 compatibile con `engines`, se nome, URL o radice dell'archivio
non sono quelli ufficiali di quella versione, o se lo SHA-256 manca, non è esadecimale minuscolo o è un segnaposto.

Per cambiare versione: aggiornare i campi del lock **solo** con un hash ottenuto da `SHASUMS256.txt.asc` verificato
con la chiave di un releaser elencato in `nodejs/release-keys`, aggiornare `attestation`, poi far revisionare il diff.

## Licenze

- `runtime/LICENSE` (copiato in `licenses/node/`) contiene la licenza di Node.js e le notice dei componenti inclusi.
- Per ogni pacchetto production vengono copiati i file `LICENSE`/`LICENCE`/`NOTICE`/`COPYING` presenti e registrati
  licenza dichiarata e stato in `manifest.json` (`licenses.records`) e nel report di build. Licenze dichiarate
  oggi: Apache-2.0 (`@modelcontextprotocol/core`, `@modelcontextprotocol/server`), MIT (`koffi`, `zod`,
  `@koromix/koffi-win32-x64`).
- `@koromix/koffi-win32-x64` non contiene un file di licenza (dichiara MIT; la licenza è nel pacchetto `koffi`
  dello stesso autore): viene segnalato come avviso.
- `package.json` non dichiara una licenza del progetto (D-13): il builder lo segnala e il manifest riporta
  `licenses.review: "required"`. Nessuna distribuzione pubblica prima della verifica.

## Integrazione con il futuro installer NSIS (FR-MCP-04-BETA-02)

Il manifest (`schemaVersion: 1`) è l'interfaccia per l'installer:

| Campo | Valore |
| --- | --- |
| `product` | `fluent-reader-mcp`, versione, canale `beta`, piattaforma `win-x64` |
| `runtime.executable` | `runtime/node.exe` |
| `server.entrypoint` | `server/dist/main.js`, trasporto `stdio`, gli otto strumenti |
| `launch` | `runtime/node.exe` + `["server/dist/main.js", "--profile-dir", "{profileDir}"]`, `profileDirRequired: true` |
| `install` | `scope: currentUser`, `defaultDirectory: %LOCALAPPDATA%\FluentReaderMCP` (P-INS-05), `approved: false` |
| `install.ownedEntries` | `runtime/`, `server/`, `licenses/`, `manifest.json`, `PACKAGING-INFO.md`: ciò che l'installer potrà rimuovere |
| `files` | percorso (separatore `/`), dimensione, SHA-256 di ogni file installabile; il manifest non elenca sé stesso |

Il percorso di installazione resta da approvare. Non sono anticipati: installer `.exe`, scelta del profilo,
registrazione in Claude Code, backup/rollback, rimozione selettiva e relativi test.

## Limiti dei test automatici

`test/packaging/` verifica il builder con file sintetici (runtime finto, npm/git/TypeScript simulati, fetch
simulato): **non** prova che un pacchetto reale si avvii. L'unico test che esegue il protocollo dell'auto-test usa il
Node della macchina e il server della repository. La prova reale è l'auto-test eseguito dalla build del
proprietario sul pacchetto estratto, con il runtime scaricato.
