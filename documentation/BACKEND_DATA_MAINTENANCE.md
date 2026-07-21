# Backend data maintenance from the browser console

This document is for development-only maintenance when the normal UI intentionally blocks a change, such as correcting the expiry date of an old archived credit card for history cleanup.

For read-only inspection, start with [`WEB_SQLITE_INDEXEDDB_INSPECTION.md`](./WEB_SQLITE_INDEXEDDB_INSPECTION.md). For table relationships, see [`DATABASE_SCHEMA.md`](./DATABASE_SCHEMA.md).

## Important safety notes

- Take an encrypted CardNest backup before changing rows.
- Prefer the app UI whenever it allows the change.
- Reload CardNest after manual writes so Angular signals hydrate the changed rows again.
- Do not edit `card_secrets` from the console. Full card numbers and CVVs are encrypted application data.
- When changing `credit_cards`, update the JSON `payload` and the normalized columns that mirror it.
- Use parameterized values. Do not concatenate user-entered text into SQL.

CardNest stores many complete domain objects in JSON `payload` columns. For example, expiry month/year, annual fee details, notes, links, benefits, and most card settings live inside `credit_cards.payload`. Some fields, such as `nickname`, `issuer_name`, `last_digits`, `network`, `archived`, and timestamps, are also stored as ordinary columns for fast filtering.

## Connect to the live web database

Open CardNest in the browser, open DevTools Console, then paste:

```js
await customElements.whenDefined('jeep-sqlite');
var cardNestSqlite = document.querySelector('jeep-sqlite');

await cardNestSqlite.isDBOpen({
  database: 'cardnest',
  readonly: false,
});
```

Create two helpers for this console session:

```js
globalThis.cardNestQuery = async function (statement, values = []) {
  var result = await cardNestSqlite.query({
    database: 'cardnest',
    statement,
    values,
    readonly: false,
  });

  return result.values ?? [];
};

globalThis.cardNestRun = async function (statement, values = []) {
  var result = await cardNestSqlite.run({
    database: 'cardnest',
    statement,
    values,
    transaction: false,
  });

  await cardNestSqlite.saveToStore({ database: 'cardnest' });
  return result.changes?.changes ?? 0;
};
```

## View credit cards

List active and archived cards:

```js
console.table(
  await cardNestQuery(`
    SELECT
      id,
      nickname,
      issuer_name,
      network,
      last_digits,
      archived,
      updated_at
    FROM credit_cards
    ORDER BY archived, nickname COLLATE NOCASE
  `),
);
```

Find one card and inspect its editable payload:

```js
var cardRows = await cardNestQuery(
  `
    SELECT id, nickname, payload
    FROM credit_cards
    WHERE lower(nickname) LIKE lower(?)
       OR last_digits = ?
    ORDER BY nickname COLLATE NOCASE
  `,
  ['%axis%', '4001'],
);

console.table(
  cardRows.map(function (row) {
    var card = JSON.parse(row.payload);
    return {
      id: row.id,
      nickname: card.nickname,
      issuerName: card.issuerName,
      network: card.network,
      lastDigits: card.lastDigits,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      archived: card.archived,
    };
  }),
);
```

## Edit an archived card expiry date

This is useful for old cards that cannot be edited through the UI because their expiry year is in the past.

Replace `CARD_ID_HERE`, month, and year:

```js
var rows = await cardNestQuery('SELECT payload FROM credit_cards WHERE id = ?', ['CARD_ID_HERE']);

if (!rows.length) throw new Error('Card not found');

var card = JSON.parse(rows[0].payload);
card.expiryMonth = 6;
card.expiryYear = 2024;
card.updatedAt = new Date().toISOString();

await cardNestRun(
  `
    UPDATE credit_cards
    SET payload = ?,
        updated_at = ?
    WHERE id = ?
  `,
  [JSON.stringify(card), card.updatedAt, card.id],
);

console.table(
  await cardNestQuery(
    `
      SELECT id, nickname, payload, updated_at
      FROM credit_cards
      WHERE id = ?
    `,
    [card.id],
  ),
);
```

Reload CardNest after this update.

## Edit simple card fields safely

For fields mirrored into table columns, change both the payload and the columns.

Example: change an archived card nickname:

```js
var rows = await cardNestQuery('SELECT payload FROM credit_cards WHERE id = ?', ['CARD_ID_HERE']);

if (!rows.length) throw new Error('Card not found');

var card = JSON.parse(rows[0].payload);
card.nickname = 'Old Axis Cashback';
card.updatedAt = new Date().toISOString();

await cardNestRun(
  `
    UPDATE credit_cards
    SET nickname = ?,
        payload = ?,
        updated_at = ?
    WHERE id = ?
  `,
  [card.nickname, JSON.stringify(card), card.updatedAt, card.id],
);
```

Example: mark an old card archived:

```js
var rows = await cardNestQuery('SELECT payload FROM credit_cards WHERE id = ?', ['CARD_ID_HERE']);

if (!rows.length) throw new Error('Card not found');

var now = new Date().toISOString();
var card = JSON.parse(rows[0].payload);
card.archived = true;
card.archivedAt = card.archivedAt || now;
card.updatedAt = now;

await cardNestRun(
  `
    UPDATE credit_cards
    SET archived = 1,
        payload = ?,
        updated_at = ?
    WHERE id = ?
  `,
  [JSON.stringify(card), card.updatedAt, card.id],
);
```

## Add a category from the console

The `categories` table is normalized and does not have a JSON payload. This makes a simple insert easier.

```js
var now = new Date().toISOString();
var categoryId = crypto.randomUUID();

await cardNestRun(
  `
    INSERT INTO categories
      (id, name, icon, colour, applies_to, archived)
    VALUES
      (?, ?, ?, ?, ?, 0)
  `,
  [categoryId, 'Legacy travel', 'plane', '#4f86c6', 'BOTH'],
);

console.table(
  await cardNestQuery(
    'SELECT id, name, icon, colour, applies_to, archived FROM categories WHERE id = ?',
    [categoryId],
  ),
);
```

If a monthly category limit is also needed:

```js
await cardNestRun(
  `
    INSERT INTO category_limits
      (category_id, limit_minor, show_limit, updated_at)
    VALUES
      (?, ?, 1, ?)
    ON CONFLICT(category_id) DO UPDATE SET
      limit_minor = excluded.limit_minor,
      show_limit = excluded.show_limit,
      updated_at = excluded.updated_at
  `,
  [categoryId, 1500000, new Date().toISOString()],
);
```

`1500000` means `15000.00` in INR because money is stored in minor units.

## Add a backend-only card for history

Use this only when the UI cannot create the historical archived card. It intentionally creates the card as archived.

```js
var now = new Date().toISOString();
var card = {
  id: crypto.randomUUID(),
  nickname: 'Old HDFC Platinum',
  issuerName: 'HDFC',
  lastDigits: '1234',
  network: 'VISA',
  theme: 'teal',
  expiryMonth: 4,
  expiryYear: 2021,
  statementDay: 15,
  dueDateMode: 'DAYS_AFTER_STATEMENT',
  daysAfterStatement: 20,
  adjustDueDateOnWeekend: false,
  currencyCode: 'INR',
  openingBalanceMinor: 0,
  remindToSettle: false,
  annualFeeEnabled: false,
  emergencyPhones: [],
  supportEmails: [],
  archived: true,
  archivedAt: now,
  createdAt: now,
  updatedAt: now,
};

await cardNestRun(
  `
    INSERT INTO credit_cards
      (
        id,
        nickname,
        issuer_name,
        last_digits,
        encrypted_full_number,
        network,
        payload,
        archived,
        created_at,
        updated_at
      )
    VALUES
      (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)
  `,
  [
    card.id,
    card.nickname,
    card.issuerName,
    card.lastDigits,
    card.network,
    JSON.stringify(card),
    card.createdAt,
    card.updatedAt,
  ],
);
```

Reload the app, then verify the card appears under `/cards` -> Archived.

## Add a transaction for a historical card

First find a valid category:

```js
console.table(
  await cardNestQuery(`
    SELECT id, name
    FROM categories
    WHERE archived = 0
    ORDER BY name COLLATE NOCASE
  `),
);
```

Then insert the transaction:

```js
var now = new Date().toISOString();
var transaction = {
  id: crypto.randomUUID(),
  cardId: 'CARD_ID_HERE',
  type: 'PURCHASE',
  amountMinor: 99900,
  currencyCode: 'INR',
  transactionDate: '2021-04-12',
  merchant: 'Historical purchase',
  categoryId: 'CATEGORY_ID_HERE',
  attachmentIds: [],
  createdAt: now,
  updatedAt: now,
};

await cardNestRun(
  `
    INSERT INTO card_transactions
      (
        id,
        card_id,
        type,
        amount_minor,
        currency_code,
        transaction_date,
        category_id,
        payload,
        created_at,
        updated_at
      )
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  [
    transaction.id,
    transaction.cardId,
    transaction.type,
    transaction.amountMinor,
    transaction.currencyCode,
    transaction.transactionDate,
    transaction.categoryId,
    JSON.stringify(transaction),
    transaction.createdAt,
    transaction.updatedAt,
  ],
);
```

## Validate after manual changes

Run:

```js
console.table(await cardNestQuery('PRAGMA integrity_check'));
console.table(await cardNestQuery('PRAGMA foreign_key_check'));
```

Expected:

- `integrity_check` returns `ok`.
- `foreign_key_check` returns no rows.

Then reload the app and confirm the screen shows the expected data.
