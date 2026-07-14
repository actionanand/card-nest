# CardNest

Detailed guides: [application and packages](documentation/APPLICATION.md) · [Android builds](documentation/ANDROID.md)

CardNest is a private, offline-first credit-card ledger built with Angular 22. Data is designed to remain on the device in SQLite. The project intentionally has no analytics, advertising, cloud account, or browser key/value persistence fallback.

## Current web implementation

- Mobile-first, accessible application shell with lazy-loaded routes
- Dashboard for total outstanding, statement dues, unbilled spend, available credit, utilisation, budget, upcoming payments, and recent activity
- Active/archived card views, masked identifiers, credit limits, billing dates, estimated grace periods, and card entry validation
- Transaction entry and history for purchases, payments, refunds, cashback, credits, fees, interest, and adjustments
- Integer minor-unit money calculations; no floating-point values are stored for currency
- Statement-cycle calculations with leap years, short months, configurable due-day modes, and optional weekend adjustment
- Reminder centre, annual-fee estimate, report charts with accessible table equivalents, budget summary, and masked export entry points
- Versioned SQLite migrations for cards, categories, transactions, statements, recurring rules, attachments, preferences, and EMI plans/installments
- Reducing-balance and no-cost EMI calculation/schedule services
- Security, notification, appearance, currency, backup, export, and destructive-data settings UI

The sample dashboard records are in-memory preview data only. They are not persisted to `localStorage` or IndexedDB. Native records must go through the SQLite gateway.

## Prerequisites

- Node.js `24.16.0` (see `.nvmrc`)
- npm `11.13.0`

```bash
nvm install 24.16.0
nvm use 24.16.0
npm install
```

Install the native packages requested for the next integration step:

```bash
npm i @capacitor/core @capacitor/android @capacitor/camera @capacitor/filesystem @capacitor/local-notifications @capacitor-community/sqlite jeep-sqlite sql.js@1.11.0 --save-exact
npm i -D @capacitor/cli
```

`npm install` must run on the target operating system. A `node_modules` folder copied from Linux cannot build on Windows because esbuild, Rollup, and related packages contain platform-specific binaries.

## Development

```bash
npm run develop
```

Open `http://localhost:3028`.

```bash
npm run build
npm test
npm run lint
```

## Architecture

```text
src/app/
  core/
    data/       SQLite gateway and ordered migrations
    models/     Strict domain contracts
    services/   Pure money, billing-cycle, EMI, and state logic
  features/     Lazy dashboard, cards, transactions, reminders, reports, settings
  shared/       Reusable presentation building blocks
```

All persisted monetary amounts use integer minor units (`₹100.50` → `10050`). Full card numbers, notes, emergency contacts, secure preferences, attachments, and backup payloads must be encrypted by the native security adapter before storage. CVV and PIN fields must never be added.

## Native integration sequence

Android packaging is deliberately deferred until the web application is complete, as requested. The next native pass will:

1. Register `@capacitor-community/sqlite` and initialise the bundled `jeep-sqlite` web component where appropriate.
2. Replace preview state with repositories backed by the existing migrations and transactional SQLite operations.
3. Add Android Keystore-backed key management, PIN hashing, biometric unlock, screenshot protection, and inactivity/background locking.
4. Implement local-notification rescheduling, private receipt files/camera capture, encrypted authenticated backups, restore rollback, and masked CSV/PDF exports.
5. Initialise Capacitor Android and add the GitHub Actions Android build workflow. No Android build workflow should be added before this stage.

## Security boundaries

- Never log card numbers, PIN values, passphrases, notes, or attachment metadata.
- Display full card numbers only after re-authentication and mask them immediately afterward.
- Notifications and exports use nickname plus `•••• 1234` only.
- Backups require a unique random salt, a password-based KDF, authenticated encryption, version checks, integrity validation, a safety backup, and transactional restore.
- Automatic deletion after failed unlock attempts remains disabled unless explicitly enabled and reconfirmed by the user.
