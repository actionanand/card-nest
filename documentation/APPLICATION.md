# CardNest application and package guide

CardNest is an offline-first Angular application for tracking credit cards, transactions, billing cycles, payments, budgets, reminders, recurring expenses, annual fees, and EMIs. Its application data is stored in SQLite. It does not use `localStorage` as a persistence substitute and does not require a cloud account.

## Application structure

| Area                    | Responsibility                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/app/core/models`   | Strict TypeScript domain models for cards, transactions, statements, categories, recurrence, and EMIs |
| `src/app/core/services` | Integer money calculations, statement/due-date rules, EMI schedules, and app state                    |
| `src/app/core/data`     | SQLite connection gateway and ordered database migrations                                             |
| `src/app/features`      | Lazy-loaded dashboard, cards, categories, transactions, reminders, reports, and settings              |
| `src/imgData/svg`       | Local card-network and default-card SVG constants                                                     |
| `public/card-nest.png`  | Android launcher and Play Store source icon                                                           |
| `capacitor.config.ts`   | Capacitor application ID, name, web output, and Android shell settings                                |

All money is represented as integer minor units. For example, ₹100.50 is stored as `10050`, avoiding floating-point rounding errors.

## Installed runtime packages

The native and SQLite dependencies were installed with:

```bash
npm i @capacitor/core @capacitor/android @capacitor/camera @capacitor/filesystem @capacitor/local-notifications @capacitor-community/sqlite jeep-sqlite sql.js@1.11.0 --save-exact
npm i -D @capacitor/cli
```

### Angular packages

| Package                     | Purpose                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `@angular/core`             | Components, dependency injection, signals, computed state, and application lifecycle   |
| `@angular/common`           | Common browser utilities and Angular directives                                        |
| `@angular/forms`            | Reactive, validated card/category/transaction forms                                    |
| `@angular/router`           | Lazy feature routing and navigation                                                    |
| `@angular/platform-browser` | Browser bootstrapping, DOM services, and safe rendering of trusted local SVG constants |
| `rxjs`                      | Observable utilities used by Angular                                                   |
| `tslib`                     | TypeScript runtime helpers                                                             |

### Capacitor and device packages

| Package                          | Purpose in CardNest                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@capacitor/core`                | Runtime bridge between Angular and Android/native plugins                                                                      |
| `@capacitor/android`             | Generates and maintains the native Android shell                                                                               |
| `@capacitor/camera`              | Captures receipt photos using the Android camera or system photo picker                                                        |
| `@capacitor/filesystem`          | Stores receipt images and encrypted backups in app-controlled files                                                            |
| `@capacitor/local-notifications` | Schedules masked payment, statement, annual-fee, expiry, recurring, and budget reminders                                       |
| `@capacitor-community/sqlite`    | Native Android SQLite access and the common SQLite API used by the data layer                                                  |
| `jeep-sqlite`                    | SQLite WebAssembly component for the browser build; it keeps the same relational SQLite model in web previews                  |
| `sql.js`                         | Pinned SQLite WASM runtime used by `jeep-sqlite`; version 1.11.0 must remain exact so its JavaScript and WASM interfaces match |
| `@capacitor/cli`                 | Development-only commands such as `cap add`, `cap sync`, and `cap open`                                                        |

`@capacitor/cli` is a development dependency because it is needed to build the Android project, not while the application is running.

CardNest uses the notification plugin's standard Android scheduler and boot-restoration receiver. It does not request exact-alarm permission. Reminder IDs are deterministic, so editing a card or recording a payment cancels and replaces stale schedules rather than creating duplicates.

## Development packages

| Package group              | Purpose                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| Angular CLI/build/compiler | Development server, production compilation, and strict Angular template checking |
| TypeScript                 | Strict static type checking                                                      |
| Angular ESLint and ESLint  | TypeScript and Angular template quality/accessibility rules                      |
| Vitest and jsdom           | Unit tests and DOM-based component tests                                         |
| Prettier and pretty-quick  | Consistent source formatting                                                     |
| Husky and npm-run-all      | Pre-commit automation                                                            |

## SQLite lifecycle

`SqliteDatabase` registers `jeep-sqlite` in a browser and uses the Capacitor SQLite plugin on Android. On startup it:

- Registers the `jeep-sqlite` Stencil runtime before Angular bootstraps and uses the static host in `index.html`.
- Resolves the WASM directory from the document base URL, so local development and GitHub Pages builds use the same setup.
- Runs every database migration newer than `PRAGMA user_version` automatically; no manual migration command is required.

1. Opens the `cardnest` database.
2. Enables foreign-key enforcement.
3. Reads `PRAGMA user_version`.
4. Applies every later migration inside a transaction.
5. Creates indexes for card/date, category, statement-cycle, recurring, and EMI queries.

The current schema stores four trailing digits for most networks and five for American Express. American Express uses a 15-digit `4–6–5` number layout. CVV and PIN values must never be collected.

## Common commands

```bash
npm run develop
npm run build
npm test
npm run lint
npm run android:add
npm run android:sync
npm run android:open
npm run generate-keystore
npm run keystore:type
```

See [ANDROID.md](./ANDROID.md) for local and GitHub Android builds.
