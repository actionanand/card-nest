# CardNest starter guide

This guide introduces the main CardNest workflows. It is intended for users setting up the app for the first time. For developer storage details, see [`DATABASE_SCHEMA.md`](./DATABASE_SCHEMA.md), [`SQLITE.md`](./SQLITE.md), and [`WEB_SQLITE_INDEXEDDB_INSPECTION.md`](./WEB_SQLITE_INDEXEDDB_INSPECTION.md).

## 1. Initial setup

1. Add each credit card from **Cards > Add card**. A nickname, issuer, network, billing dates, and final digits make later transaction entry easier.
2. Add or rename cash, bank/UPI, debit, and meal-card sources under **Cash, Banks & Pluxee**.
3. In **Settings**, choose the currency, date display format, preferred Flash transaction source, theme, PIN, biometric unlock, and reminders.
4. Add or adjust categories and optional spending limits.

Full card number, CVV, and cardholder name are optional protected details. Transaction exports and notifications never contain the full number or CVV.

## 2. Record a transaction

Tap the shopping-cart-plus button in the mobile bottom navigation, or open **Activity** and use Add transaction on a larger screen.

1. Choose Purchase, Adjustment, Card payment, Refund, Cashback, Credit, Fee, or Interest.
2. Choose a card or another payment source.
3. Enter the amount and date.
4. Choose a category and optionally add a merchant, notes, tax amount, repeat rule, or receipt images.
5. Save the transaction.

Refunds can be linked to a purchase from the selected card during the preceding three months. Adjustments can be linked to entries from the chosen day or the previous day. The relationship appears from both transaction detail views.

Receipt images larger than 1 MB are compressed before storage. Use **Activity > Filters > Type > With image** to find entries with attachments.

## 3. Flash transaction

On mobile, the floating lightning button opens a compact purchase form from any main page. The amount is the only new value required when a preferred source is configured. CardNest uses today’s date, Purchase, and the Other category automatically. The preferred source is configured in Settings.

## 4. Transaction details, splits, and EMI

Tap a transaction to see its amount, date, category, payment source, notes, attachments, tax, links, and available actions. From this view you can edit, duplicate, delete, navigate to its source, split a purchase across two to four sources, or convert an eligible purchase to EMI.

An EMI plan keeps its original purchase relationship and installment schedule. Closing an EMI stops future installments while retaining history.

## 5. Cards and statement dues

CardNest separates:

- **Statement amount due**: the billed balance from the latest generated statement, reduced by payments and credits recorded after that statement.
- **Current outstanding**: the full balance, including newer unbilled purchases.

Pay due records the statement amount only. Pay outstanding includes unbilled activity. Archived cards keep their transaction history.

## 6. Reminders

Android reminders are local and contain only a nickname and masked final digits. Payment reminders begin five days before the due date by default.

- Record payment asks for confirmation and uses the statement amount due.
- Snooze is enabled when a reminder enters its five-day reminder window.
- A snoozed reminder disappears immediately, offers Undo for ten seconds, and remains in Snoozed history until restored.
- Cards whose due dates are more than ten days away are folded under Later reminders.

## 7. Reports and exports

Activity filters can search and narrow transactions by source, category, type, date, and attachment presence. On mobile the filters stay folded until opened. PDF and masked CSV are intended for reports; protected card data is omitted.

## 8. Backup, restore, and cloud locations

Create an encrypted `.cnbak` file from **Settings > Backup & data**. The passphrase must have at least eight characters and cannot be recovered. Restore replaces the database only after confirmation.

On Android, CardNest uses the system document picker. If Google Drive, Dropbox, OneDrive, ownCloud, or another document-provider app is installed and signed in, select that provider as the backup destination. This is provider-neutral file storage, not background account synchronization: CardNest does not store cloud credentials and cannot silently overwrite a remote backup.

Keep at least two backup copies and test restoration on non-essential data before relying on a backup workflow.

## 9. Web SQLite and IndexedDB

The web app runs SQLite through WebAssembly. IndexedDB stores the serialized SQLite database so it survives browser restarts; IndexedDB itself is not the relational database interface.

To inspect it:

1. Open DevTools > Application > IndexedDB > `jeepSQLiteStore` to confirm the persisted container exists.
2. Do not use **Delete database** unless you intend to erase web data.
3. Use the live `<jeep-sqlite>` element from the Console to execute read-only SQL.

The exact copy-and-paste queries, table-listing commands, result shapes, troubleshooting steps, and safe export procedure are documented in [`WEB_SQLITE_INDEXEDDB_INSPECTION.md`](./WEB_SQLITE_INDEXEDDB_INSPECTION.md).
