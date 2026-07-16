# SQLite in CardNest: Angular, Android, WebAssembly, and migrations

For step-by-step browser inspection and live SQL queries against the IndexedDB-backed web database, see [`WEB_SQLITE_INDEXEDDB_INSPECTION.md`](./WEB_SQLITE_INDEXEDDB_INSPECTION.md).

CardNest uses SQLite as its structured application database. Angular signals are the live UI state; they are not the durable storage layer. The same SQL gateway is used on Android and the web, but the engine and physical storage are platform-specific.

## Platform architecture

| Layer            | Android                                                     | Web development and browser build                             |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Angular API      | `SqliteDatabase.query()` and `SqliteDatabase.run()`         | The same methods                                              |
| Capacitor API    | `@capacitor-community/sqlite` native Android implementation | `@capacitor-community/sqlite` web implementation              |
| SQLite engine    | Native SQLite supplied through the Capacitor plugin         | SQLite compiled to WebAssembly by `sql.js`                    |
| Browser adapter  | Not used                                                    | The `jeep-sqlite` Stencil custom element                      |
| Durable location | The application's private Android database storage          | IndexedDB database `jeepSQLiteStore`, table/store `databases` |
| `localStorage`   | Not used for application records                            | Not used for application records                              |

Yes, the web build uses WebAssembly. Android does not use the WASM file; it uses native SQLite.

## Relevant packages

```bash
npm i @capacitor-community/sqlite jeep-sqlite sql.js@1.11.0
```

- `@capacitor-community/sqlite` supplies one Capacitor-facing API and selects the native or web implementation.
- `jeep-sqlite` is a Stencil web component that connects the Capacitor web implementation to `sql.js` and persists the exported database bytes in IndexedDB.
- `sql.js` is SQLite compiled to WebAssembly. CardNest pins version `1.11.0` because its JavaScript glue file and `sql-wasm.wasm` must be from the same release.

`sql.js` is not a second data model and IndexedDB is not being used as a key/value replacement for the application schema. The database remains a real SQLite database with tables, indexes, constraints, foreign keys, transactions, and `PRAGMA user_version`. IndexedDB is the browser container in which `jeep-sqlite` stores the SQLite database bytes.

## Web startup sequence

The web path is established before Angular creates application services:

1. [`src/main.ts`](../src/main.ts) checks `Capacitor.getPlatform()`.
2. On `web`, it calls `defineCustomElements(window)` from `jeep-sqlite/loader`. This registers the Stencil component with the browser custom-element registry.
3. [`src/index.html`](../src/index.html) contains one permanent `<jeep-sqlite autosave="true"></jeep-sqlite>` host. It must not be created repeatedly inside Angular component templates.
4. [`angular.json`](../angular.json) copies `node_modules/sql.js/dist/sql-wasm.wasm` to `assets/sql-wasm.wasm` during every build.
5. [`SqliteDatabase.initialise()`](../src/app/core/data/sqlite-database.ts) waits for `customElements.whenDefined('jeep-sqlite')`.
6. It assigns the deployment-aware assets path to the element's `wasmPath`. Using `document.baseURI` makes both `/` development builds and subdirectory deployments resolve the file correctly.
7. `CapacitorSQLite.initWebStore()` opens the `jeep-sqlite` IndexedDB store.
8. The common connection, open, migration, query, and write sequence then runs.

The `autosave="true"` attribute tells `jeep-sqlite` to export the updated in-memory SQLite database back to IndexedDB after committed write operations. Closing the connection also saves it. Browser DevTools may therefore show IndexedDB rather than an ordinary `.db` file even though the data inside is SQLite.

## Android startup sequence

On Android, the custom-element and WASM steps are skipped:

1. Capacitor loads the native `@capacitor-community/sqlite` Android plugin.
2. `SqliteDatabase.initialise()` creates and opens the private `cardnest` database connection.
3. The app enables `PRAGMA foreign_keys = ON`.
4. Migrations are checked and applied.
5. Angular store services query durable data and publish it through signals.

The Android database is private to CardNest. It is not written to shared media storage, and broad storage permission is not required.

## Angular application initialization

[`app.config.ts`](../src/app/app.config.ts) uses `provideAppInitializer()` so storage setup begins before normal application interaction:

```text
Angular bootstrap
  -> SqliteDatabase.initialise()
     -> web adapter initialization when required
     -> createConnection("cardnest")
     -> open()
     -> enable foreign keys
     -> read PRAGMA user_version
     -> apply pending migrations transactionally
  -> initialize preferences, secrets, theme, PIN, and CardNestStore state
  -> render features using signals and computed values
```

The initializer uses settled promises so the shell can display a storage error rather than leaving a permanently blank page. `SqliteDatabase.ready()` and `unavailableReason()` expose the result to the UI.

## Database gateway

[`sqlite-database.ts`](../src/app/core/data/sqlite-database.ts) is deliberately small. Feature code does not call the Capacitor plugin directly.

```ts
const cards = await database.query<CardRow>(
  'SELECT payload FROM credit_cards WHERE archived = ?',
  [0],
);

await database.run('UPDATE credit_cards SET archived = ?, updated_at = ? WHERE id = ?', [
  1,
  new Date().toISOString(),
  cardId,
]);
```

Important rules:

- Values are passed separately from SQL text, preventing user input from becoming executable SQL.
- `run()` requests a transaction for each write.
- Multi-statement schema migrations run in one transaction.
- Queries fail immediately when `ready()` is false instead of silently switching to `localStorage`.
- Money is stored as integer minor units. For example, INR 100.50 is stored as `10050`.
- Dates used for grouping are stored in ISO `YYYY-MM-DD` form so lexical and chronological ordering match.

## Migrations

[`migrations.ts`](../src/app/core/data/migrations.ts) is an ordered, append-only list. Each migration has an integer version and SQL statements.

At startup CardNest reads:

```sql
PRAGMA user_version;
```

Only migrations with a greater version are applied. After each migration succeeds, CardNest sets the new `user_version` in the same transaction. If a statement fails, that migration is rolled back and `ready()` remains false.

Current schema areas include:

- preferences;
- credit cards and protected card-secret ciphertext;
- categories and category limits;
- card benefits and important links;
- linked-card relationship groups;
- transactions and transaction indexes;
- statements;
- recurring rules;
- receipt attachment metadata;
- EMI plans and installments;
- cycle-specific monthly income.

New releases must add another migration instead of editing a migration that users may already have applied.

## Store and signal responsibilities

[`CardNestStore`](../src/app/core/services/card-nest-store.ts) is the state adapter between SQL rows and Angular features:

- On initialization it queries durable rows and maps them to strict domain types.
- Writable signals hold the current UI snapshot.
- Computed signals derive outstanding balances, available credit, current-cycle income, category totals, and dashboard figures.
- A command updates the signal promptly and invokes the corresponding SQL persistence method.
- Structured card payloads are stored as JSON alongside indexed columns used for frequent filtering and relational joins.

Signals make the interface reactive, but refreshing or reinstalling the app must recover state from SQLite, not from signals. Every new mutable feature therefore needs all four pieces: a migration/table, a load query, write/update/delete queries, and domain-to-row mapping.

## Current persistence coverage and implementation rule

The existing adapter currently persists preferences, cycle income history, cards, categories, category limits, benefits, important links, linked-card groups, and encrypted card-secret records. The schema also defines transactions, statements, recurring rules, attachments, and EMI records. Any feature whose store command has not yet been connected to its load and write queries remains an in-memory implementation and must not be described as durable until that adapter is completed.

For CardNest's intended production behavior, transactions, cash/bank/Pluxee sources, recurring rules, loans, statements, EMIs, and attachment metadata must all follow the same SQLite load/write/delete pattern. Adding `localStorage` as a fallback is not acceptable because it would create two competing sources of truth and would not scale to large histories.

## Sensitive information

The SQLite connection currently uses `mode: 'no-encryption'`; this describes database-file encryption, not the handling of individual secrets. Optional full card numbers and CVVs are encrypted by the application before their ciphertext is stored. They must never be placed in indexed display columns, logs, CSV/PDF exports, notifications, or exception messages.

Android also enables `FLAG_SECURE` to prevent screenshots and recent-app previews. Browser storage remains protected only by the browser profile and operating-system account, so exported backups require their own encryption and passphrase.

## WebAssembly troubleshooting

No manual database migration command is needed. For a successful web start, the following files and versions must agree:

```text
jeep-sqlite JavaScript component
  -> sql.js JavaScript glue
     -> assets/sql-wasm.wasm
```

If the console reports a `WebAssembly.instantiate()` import error, check:

1. `sql.js` is still the pinned version in `package.json` and the lock file.
2. `assets/sql-wasm.wasm` returns HTTP 200 and is not an HTML error page.
3. The development server was restarted after dependency changes.
4. An old service-worker/browser cache is not serving JavaScript from one version and WASM from another.
5. Only one `<jeep-sqlite>` host exists and it was registered before database initialization.

If the host is reported as unknown to Stencil, do not dynamically recreate it from an Angular component. Keep the static host in `index.html`, call `defineCustomElements(window)` once in `main.ts`, wait for its definition, set `wasmPath`, and then call `initWebStore()`.

## Backup and deletion

A backup should be produced from a consistent SQLite snapshot, encrypted with a user passphrase, and written through the native filesystem/document picker. Restore should validate the backup version and integrity before replacing live data. “Delete all data” must close active connections, delete the SQLite database/store, clear separately stored receipt files, and then recreate an empty migrated database.

Neither backup nor deletion should copy records into `localStorage`.
