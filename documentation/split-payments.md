# Split payments and adjustment compatibility

The eight transaction enum values are unchanged. `ADJUSTMENT` has an optional purpose:

- `SPLIT_PAYMENT`: a positive, genuine additional merchant payment.
- `LEGACY_MANUAL`: the default for historical adjustments without positive balance-only provenance. Its saved increase/decrease direction determines its signed spending contribution.
- `BALANCE_RECONCILIATION`: a verified correction, excluded from merchant spending but retaining its original financial effect.

Migration 12 adds purpose metadata without changing transaction IDs, financial columns, references, dates or balances. An old wallet correction is identified only when its `sms-adjustment-<candidate ID>` ledger ID, `transaction_links` relationship, resolved candidate binding and `sms_reconciliation` decision `ADJUST_BALANCE` agree. Merchant text is never evidence of a correction. Ambiguous entries remain Legacy adjustments and stay editable. The same compatibility classification runs when restoring old portable backups, whose raw SMS payloads are intentionally absent.

## Accounting

`spendingContribution()` is the shared classification for dashboard spending, reports, category budgets and statistical exports. Purchases, positive split payments, fees and interest increase spending; refunds, cashback and decreasing legacy adjustments reduce it. Repayments, ordinary credits and verified balance corrections contribute zero. `transactionEffect()` remains the separate signed account-balance rule. Reporting classification alone does not reverse or reapply an account effect.

## Group relationships

The existing `transaction_split_groups` and `transaction_split_members` tables are extended, rather than replaced. A stable group has a kind (`PAYMENTS` or historical/allocation `DIVISION`), an anchor transaction, optional title and bill amount, currency and created/updated timestamps. The unique member constraint prevents simultaneous membership in two groups. A group is not a ledger entry.

Selecting any member resolves the full group. Third and later payments append to that same ID. Members retain their IDs, amounts, sources, references, receipt ownership, SMS origins and payment metadata. Changing groups requires an explicit unlink first. Removing a member or dissolving a group keeps the real payments and changes no source balance. Deleting a payment follows normal financial reversal rules and reanchors the remaining group. A bill difference is displayed as overpaid or remaining/unresolved; it creates neither a transaction nor a debt.

Division of an ungrouped positive purchase/payment adjustment remains available, without the previous four-part cap. EMI, recurring, grouped, credit and balance-correction entries cannot be divided by this merchant-payment workflow. The original allocation retains the original ID and audit metadata; additional allocations are manual records with no cloned reference, receipts or SMS annotations. Division, memberships, balances and existing SMS bindings commit together. Its explicit division audit prevents a previously resolved SMS from being reopened just because the original amount is now represented by several parts.

## SMS continuity

`SMS_SPLIT_GAP_MS` is **30 minutes**, inclusive, between consecutive distinct financial alerts. It is independent of the unchanged 18-hour proximity rule for duplicates.

The algorithm orders financial candidates by immutable SMS receipt timestamps, collapses events with proven common ledger/reference identity, and examines the immediately preceding distinct financial event. An unrelated purchase, transfer, repayment, refund, top-up or income alert breaks the sequence. Statements, reminders, OTPs and promotional/informational messages do not represent completed payments and do not break it.

Both proposed members must be genuine eligible purchases, have compatible currency and supporting merchant descriptions, use different confirmed/selected sources, and occur on the same Indian local date. Receipt gaps over 30 minutes, receipt ties, invalid times, delayed dates and contradictory explicit transaction ordering prevent a suggestion. Explicit transaction timestamps strengthen the proposal; absent times are labelled approximate receipt timing. Equal references are never separate payment members; equal amounts without independent references are treated conservatively. Missing evidence inside the observed sequence is a barrier. Queries cover the relevant receipt interval, not just the visible inbox page.

The preceding payment must already exist in the ledger. Scanning and selecting a suggestion create no group or financial effect. Final atomic approval recomputes continuity and duplicate/reference eligibility, records the new genuine payment once, and attaches it to the confirmed purchase/group. A stale saved choice is cleared on reopening. Explicit match, separate purchase and split-member decisions stay distinct in reconciliation history. Existing classified split payments remain compatible with purchase identity checks, using the same source, amount, reference and timing rules; the internal enum is not rewritten to match an SMS.

## Validation and device checks

Run `npm test -- --watch=false`, `npm run lint`, `npm run test:sms:fixtures`, `git diff --check`, production web/Android bundle builds and the native SMS suite. SQLite tests cover migration, rollback, repeated approval, multi-source balances, type changes, group growth and encrypted backup/restore. Angular tests cover custom pickers, pagination, decisions and the AXE rules available in jsdom.

Real Android WebView checks should include narrow light/dark layouts, TalkBack, keyboard and Back handling with nested pickers, photo receipts, many-member groups, interrupted/delayed SMS sequences and native CSV/PDF delivery. jsdom cannot validate actual layout or colour contrast. Version metadata and release/signing workflows are not part of this feature.

Local validation completed on 27 October 2026: 489 Angular tests across 45 files, 160 native Android tests, 70 SMS fixtures and 9 Android integration checks passed. Lint, TypeScript checking, whitespace checks, the all-template native-select scan, production web/Android builds, Capacitor sync and web SMS isolation passed. Builds retain initial-bundle and existing cards stylesheet budget warnings; optional Windows compiler cache, jsdom scrollTo and Gradle deprecation notices are non-failing. No real-device checks were performed.

## Changed files

Implementation and regression files for this feature:

- `src/app/core/data/bank-cash-tracking.integration.spec.ts`
- `src/app/core/data/migrations.spec.ts`
- `src/app/core/data/migrations.ts`
- `src/app/core/data/sqlite-backup.integration.spec.ts`
- `src/app/core/data/sqlite-database.ts`
- `src/app/core/models/domain.ts`
- `src/app/core/services/card-nest-store.ts`
- `src/app/core/services/export.service.spec.ts`
- `src/app/core/services/export.service.ts`
- `src/app/core/services/money.spec.ts`
- `src/app/core/services/money.ts`
- `src/app/core/services/payment-groups.spec.ts`
- `src/app/core/services/payment-groups.ts`
- `src/app/core/services/payment-method-options.ts`
- `src/app/features/category-spending/category-spending.ts`
- `src/app/features/dashboard/dashboard.html`
- `src/app/features/dashboard/dashboard.ts`
- `src/app/features/reports/reports.html`
- `src/app/features/reports/reports.ts`
- `src/app/features/sms-sync/sms-matching.ts`
- `src/app/features/sms-sync/sms-model.ts`
- `src/app/features/sms-sync/sms-payment-method-options.ts`
- `src/app/features/sms-sync/sms-purchase-matching.spec.ts`
- `src/app/features/sms-sync/sms-purchase-matching.ts`
- `src/app/features/sms-sync/sms-review.service.ts`
- `src/app/features/sms-sync/sms-split-continuity.spec.ts`
- `src/app/features/sms-sync/sms-split-continuity.ts`
- `src/app/features/sms-sync/sms-split-suggestion.ts`
- `src/app/features/sms-sync/sms-sync.html`
- `src/app/features/sms-sync/sms-sync.spec.ts`
- `src/app/features/sms-sync/sms-sync.ts`
- `src/app/features/transactions/payment-groups-panel.spec.ts`
- `src/app/features/transactions/payment-groups-panel.ts`
- `src/app/features/transactions/transactions.html`
- `src/app/features/transactions/transactions.scss`
- `src/app/features/transactions/transactions.ts`
- `src/app/shared/payment-breakdown.ts`
