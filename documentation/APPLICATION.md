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
npm i @lucide/angular chart.js
npm i -D @capacitor/cli
```

### Angular packages

| Package                     | Purpose                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `@angular/core`             | Components, dependency injection, signals, computed state, and application lifecycle    |
| `@angular/common`           | Common browser utilities and Angular directives                                         |
| `@angular/forms`            | Reactive, validated card/category/transaction forms                                     |
| `@angular/router`           | Lazy feature routing and navigation                                                     |
| `@angular/platform-browser` | Browser bootstrapping, DOM services, and safe rendering of trusted local SVG constants  |
| `rxjs`                      | Observable utilities used by Angular                                                    |
| `tslib`                     | TypeScript runtime helpers                                                              |
| `@lucide/angular`           | Tree-shakeable, accessible SVG icons for navigation, actions, categories, and status UI |
| `chart.js`                  | Responsive doughnut and bar charts for category and payment-source analytics            |

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

Migration 3 adds `monthly_income`. Each row is keyed by the month in which the active budget cycle starts. A 25 Juneâ€“24 July cycle is therefore stored as `2026-06`; changing July's current income does not modify earlier cycle rows.

Migration 4 adds category limits, card benefit notes, important links, linked-card account groups, and encrypted card-secret records. These migrations run automatically during startup.

The current schema stores four trailing digits for most networks and five for American Express. American Express uses a 15-digit `4–6–5` number layout. CVV and PIN values must never be collected.

## Current product areas

- Compact credit-card list with statement cycles, annual-fee waivers, payment actions, and masked card identifiers.
- Card forms open as dialogs and support optional network tier, locally encrypted full number/CVV, important links, benefit pills with conditions, and a linked-account name. Compact lists and notifications continue to use only the last four digits, or the last five for American Express.
- Cash, bank/UPI, and Pluxee sources. The Sources activity tab shows their transactions, tracked balance, spending, and credits/top-ups. Editing an entry can move it between these sources and a credit card while reconciling the old and new balances.
- Calendar-month, custom budget-cycle, and selected-card statement-cycle transaction groups.
- Transaction filters include type, payment source, category, cycle, and free-text search. Entry menus support edit, duplicate, source navigation, and delete while reconciling tracked source balances.
- Monthly repeat rules can run for 1–36 additional months or indefinitely. They preserve the selected day where possible and use the final valid day in shorter months. Rules are materialised when CardNest opens; no exact-alarm permission or background timer is required.
- Pluxee monthly loads are added to the existing carried-forward balance. For example, a ₹2,000 balance plus an ₹8,800 load becomes ₹10,800; users can correct the current balance at any time.
- Income-aware reports use cycle-specific SQLite income and tracked source funds, never credit limits, to calculate available spending. The current income input updates only the active cycle and preserves older amounts for historical reporting.
- Multi-cycle reports include expense-versus-remaining line charts, income-versus-expense grouped bars, a cycle table, category percentages, and click-through monthly category bars.
- Category Spending provides a cycle snapshot, per-category transaction drill-down, and optional SQLite-backed limits. A hidden limit remains stored without showing progress colours or remaining amounts.
- Card Benefits groups cards by searchable benefit and condition notes. Card Usage groups related cards into one bank account and flags accounts unused for three months, six months, one year, beyond one year, or never.
- An optional title and name are stored in SQLite preferences and used for a time-appropriate private dashboard greeting.
- Loan and external EMI commitments include installment amount, debit day, end date, and cancellation state.
- Application PINs are stored in SQLite as salted PBKDF2-SHA-256 hashes; the PIN itself is never stored. Biometric unlock is presented only in the Android app because it requires a native biometric adapter and device enrollment.

CardNest uses Lucide for interface icons so navigation, chevrons, action menus, category choices, and status indicators share the same SVG stroke geometry. Card-network logos remain the local constants in `src/imgData/svg` because brand artwork is intentionally separate from interface icons.

Reports use Chart.js directly rather than an Angular wrapper. This keeps the chart dependency framework-independent and provides responsive, signal-driven doughnut and horizontal bar charts. Each canvas has an accessible label and an adjacent text breakdown, so the information does not depend on colour or graphics alone.

`ng2-charts` is intentionally not installed. CardNest already owns the Chart.js lifecycle in `ReportChart`, including line, grouped bar, column, horizontal bar, and doughnut modes; another Angular wrapper would duplicate that responsibility.

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
