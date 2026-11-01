# Category catalog and interactive suggestions

`src/app/core/data/default-categories.json` is the single source of built-in definitions. Registry version 2 contains exactly these 21 categories:

| Stable ID       | Display name     |
| --------------- | ---------------- |
| payment         | Card Payment     |
| contra-expenses | Contra-expenses  |
| dining          | Dining           |
| fuel            | Fuel             |
| groceries       | Pantry Staples   |
| healthcare      | Healthcare       |
| income          | Income           |
| other           | Other            |
| shopping        | Shopping         |
| subscription    | Subscription     |
| travel          | Travel & Lodging |
| utilities       | Utilities        |
| meat-dairy      | Meat & Dairy     |
| fresh-produce   | Fresh Produce    |
| tech-gadgets    | Tech & Gadgets   |
| household       | Household        |
| kids            | Kids             |
| digital-goods   | Digital Goods    |
| snacks-pastry   | Snacks & Pastry  |
| indulgences     | Indulgences      |
| education       | Education        |

The eight financial transaction types and EMI accounting are unchanged. Education describes educational spending; an EMI repayment does not become a second expense.

## Maintaining definitions

Edit a definition's name, supported icon, colour or `appliesTo` (`EXPENSE`, `CREDIT`, `BOTH`) in JSON. Keep its ID stable. Add the previous display name to `aliases` when renaming it. Names and aliases must be unambiguous after Unicode NFKC, case and whitespace normalization; shared words alone do not establish equivalence. Other and Card Payment remain protected.

For a new default, increment registry `version`, assign `introduced` to that version, and add its definition. For example:

```json
{
  "id": "new-category",
  "name": "New Category",
  "aliases": [],
  "icon": "category",
  "colour": "#4e87c7",
  "appliesTo": "BOTH",
  "protected": false,
  "introduced": 3
}
```

Use an icon already supported by `AppIcon`. Updating display definitions changes fresh-install defaults; existing users retain customized icons, colours, applicability and archive state. A versioned upgrade canonicalizes only known names/aliases. It never renames an unrelated custom name. New custom names receive restrained capitalization that preserves acronyms and mixed-case brands.

## Upgrade, collisions and deletion

SQLite schema 13 adds `category_catalog_state` (canonical ID, effective persisted ID, deletion marker) and `category_catalog_conflicts` (preserved collision settings). `category_catalog_version` is stored in application preferences. All three are included in encrypted portable backups.

Fresh installs initialize all 21 categories. Existing installs keep missing version-1 defaults absent, because absence may represent deliberate deletion; only the nine newly introduced defaults are added. Equivalent custom categories are reused with their existing IDs and configuration. For example, a UUID category named `  KIDS  ` becomes `Kids` while keeping that UUID, budget, icon and colour. Rules resolve through the persisted canonical-to-effective mapping.

Groceries becomes Pantry Staples using `groceries`; Travel becomes Travel & Lodging using `travel`. A colliding custom category is reconciled atomically into the existing built-in ID where present, otherwise the deterministic existing equivalent ID. Transactions' indexed category columns and JSON category IDs, recurring templates and saved review drafts are remapped. Amounts, dates, IDs, source balances, references, receipts, SMS audit links and payment-group membership are untouched.

If both categories have budgets, the retained category's limit and visibility remain active. Limits are never added together. If only the merged category has a budget, it is moved intact. Both original category configurations and all budget settings are preserved in a durable migration record visible in Categories, so the user can inspect them and explicitly change the active limit. Neither conflicting configuration is silently discarded. Repeated initialization is idempotent; failed writes roll back.

Deleting an ordinary category requires confirmation. In one transaction, transactions and recurring templates move to active Other, draft references are updated, the category's budget is removed through its foreign key, and canonical deletion markers are saved. Signals refresh only after commit; failures show an error without optimistic financial changes. Restart, catalog upgrades and backup restoration do not recreate deleted defaults. Manually creating a category with that canonical name again explicitly updates its mapping and clears its deletion marker. A complete Delete all data reset intentionally initializes the current full catalog, as before; it is distinct from an ordinary restart.

## Maintaining merchant rules

`src/app/core/data/category-matching-rules.json` is bundled offline and contains no executable patterns. Each rule has a unique ID, canonical target category ID, integer priority, `enabled`, and literal whole words and/or token phrases. For example:

```json
{
  "id": "specific-market",
  "categoryId": "groceries",
  "priority": 100,
  "merchantPhrases": ["specific market"],
  "enabled": true
}
```

Merchant text is normalized for case, Unicode, punctuation and spaces. Whole tokens prevent unsafe substring matches. Longer token phrases beat generic words, then higher priority wins, then longer matched text, then ascending rule ID. This makes Swiggy Instamart select Pantry Staples ahead of Swiggy → Dining. Adding an ordinary merchant rule requires editing JSON, not TypeScript. Validation rejects duplicate IDs, unknown targets, malformed terms and extra executable/regex fields.

The winning rule is selected before its target is resolved. If it is disabled, missing, deleted, archived, incompatible or ambiguous, the result is **Other**; CardNest never falls through to a weaker match, creates a category or reactivates one. Missing purpose categories similarly go directly to Other. Corrupted databases lacking active, compatible Other raise an integrity error.

Rules include the supplied Swiggy, Instamart, Zomato, Blinkit, Indian Oil and Netflix examples and conservative recognizable vendor descriptions such as pharmacies, toy stores and vegetable markets. Generic Amazon, banks, card networks and payment apps supply no product evidence and remain Other. Indulgences has no automatic rule. Broad grocery merchants do not imply a particular food line item.

## Interactive scope and precedence

Merchant suggestions run only during manual Add Transaction and pending/deferred SMS Review. Scanning, loading transactions, reports, exports and saved-transaction editing do not run merchant matching. Approval persists the final reviewed category; legacy direct approval callers retain safe purpose-only fallbacks.

Precedence is explicit user selection, purpose-specific category, inherited category for a new Split Payment, merchant rule, then Other. Refund/cashback and wallet top-up purposes use Contra-expenses, card repayments use Card Payment, and incoming income uses Income. Categorization never changes the underlying financial purpose or amount.

Custom pickers mark an explicit override independently of reactive form emissions. Typing and purpose changes cannot overwrite that choice. New linked Split Payments inherit the anchor/group category without recategorizing existing members. Saved transaction editing retains its category. SMS drafts retain category override state and bank purpose; older drafts conservatively retain the saved choice. Reopening a draft whose category is unavailable selects Other and explains why. Split continuity, duplicate choices and SMS identity are preserved.

## SMS Review filter restoration

Clear filters broadens results. Restore default filters is a separate action in SMS Review only and uses the existing reusable confirmation dialog. Cancel makes no preference changes. Confirm obtains every field from `defaultReviewFilters()`, serializes persistence behind earlier filter writes, resets pagination and refreshes results. Component signals and the success notification update after persistence completes; errors do not announce success. Repeated confirmation is guarded. Messages, review decisions and financial rows remain untouched.

The shared confirmation dialog provides initial focus, a Tab loop, Escape/Android Back cancellation and focus restoration. It uses existing theme variables and touch-friendly controls. Automated AXE coverage runs in light and dark modes; jsdom cannot verify physical layout, touch or colour contrast. Verify narrow Android WebView layouts, TalkBack, nested pickers/Back, long names, collision notices, and native backup delivery on a real device.

## Validation

Run `npm test -- --watch=false`, `npm run lint`, `npm run test:sms:fixtures`, `npm run build`, `npm run build:android`, and `git diff --check`. The suites cover the catalog, matching, real SQLite collisions/deletion/rollback, old and encrypted backups, manual and SMS overrides, filter restoration, the 13 SMS split-continuity cases, and existing payment-group/accounting regressions. Also run web SMS isolation, Capacitor sync, Android integration checks and native JUnit when tooling is available.

No Android version or release/signing workflow changes are required.

Local validation on 27 October 2026 passed: 551 Angular tests in 48 files, all 160 freshly rerun native JUnit tests (zero skipped), 70 SMS fixtures, 9 Android integration checks, lint, TypeScript, whitespace and the all-template native-select scan. Production web and Android builds, web SMS isolation and Capacitor sync passed. Both initial bundles exceed the existing 500 kB warning budget but remain below the error limit. The existing cards stylesheet warning, optional Windows compiler-cache warning, jsdom scrollTo notice and Gradle deprecations are non-failing. Real-device checks listed above were not run locally. Version metadata remains 1.1.12 / 52.

## Changed files

Implementation and regression files (this document is also new):

- `src/app/core/data/bank-cash-tracking.integration.spec.ts`
- `src/app/core/data/category-catalog.spec.ts`
- `src/app/core/data/category-catalog.ts`
- `src/app/core/data/category-definitions.ts`
- `src/app/core/data/category-matching-rules.json`
- `src/app/core/data/default-categories.json`
- `src/app/core/data/migrations.ts`
- `src/app/core/data/sqlite-backup.integration.spec.ts`
- `src/app/core/data/sqlite-database.ts`
- `src/app/core/services/card-nest-store.ts`
- `src/app/core/services/category-matcher.spec.ts`
- `src/app/core/services/category-matcher.ts`
- `src/app/features/categories/categories.html`
- `src/app/features/categories/categories.ts`
- `src/app/features/category-spending/category-spending.spec.ts`
- `src/app/features/sms-sync/sms-bank.spec.ts`
- `src/app/features/sms-sync/sms-model.ts`
- `src/app/features/sms-sync/sms-review.service.ts`
- `src/app/features/sms-sync/sms-sync.html`
- `src/app/features/sms-sync/sms-sync.spec.ts`
- `src/app/features/sms-sync/sms-sync.ts`
- `src/app/features/transactions/transactions.ts`
- `src/app/shared/confirmation-dialog.spec.ts`
- `src/app/shared/confirmation-dialog.ts`
- `tsconfig.json`
