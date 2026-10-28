# Financial safety Phase 2 review

Baseline: `feature/11-split-payment-redesign`, `cceab014652a951cfd64c077d28bf199c248d7f4`.
Date: 2026-10-28 (Asia/Kolkata).

Only 1A, 1B, 2, 3, persisted credit-card D1, D2 and D4 are approved.
D3 and non-card recurrence storage changes remain unapproved and unimplemented.
No commit, push, merge, migration, Android configuration or release change is authorized.

## Implemented scopes and affected files

| Scope | Files and methods                                                                                                                                                                                                                                                | Exact behavior change                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2     | `src/app/features/sources/sources.ts`: `updateBankField`; `src/app/core/services/card-nest-store.ts`: `updatePaymentSource`; Sources and financial integration tests                                                                                             | An explicit empty institution edit on an enrolled bank is rejected with feedback. The saved value remains. Unrelated edits to historical blank institutions remain allowed. No SMS matching or alias changes.                                                                                                                                                                                                |
| 3     | Store: `updatePaymentSource`; financial integration tests                                                                                                                                                                                                        | Generic Bank/Cash updates reject changes to `balanceMinor`, `balanceSnapshotMinor`, `balanceCutoverAt`, `balanceCutoverReason`. Unchanged fields and identity edits retain the existing merge behavior. Wallet operations and dedicated audited operations remain available.                                                                                                                                 |
| 1A    | Store: `duplicateTransaction`, `recordPayment`, new draft/save/refresh helpers; Transactions: `duplicate`; Cards: `confirmPayment`; Reminders: `recordPayment`, `confirmLinkedPayment`; financial and source-cutover tests                                       | Save before publication; await completion; retain failed drafts and IDs for retry; concurrent same-operation submissions share an ID. Linked reminder retries skip already committed cards. Committed refresh failures close completed UI operations with a warning. Duplication's existing copy/reset rules are unchanged.                                                                                  |
| 1B    | Store: `saveEmiPlan`, `closeEmiPlan`, `persistEmiPlan`, shared deletion session helper, `loadEmiPlans`; Transactions: `saveEmi`; Loans: `saveEmiStart`, `confirmCloseEmi`; financial integration tests                                                           | Each conversion/reschedule/closure commits affected ledger rows, plan and installments together. Signals publish after commit. The existing EMI calculator and installment field construction are unchanged.                                                                                                                                                                                                 |
| D1    | Store: `materializeRecurringTransactions`, card rule creation/edit/termination and persistence helpers, `saveManualTransaction`, `initialisePreferences`; `src/app/app.ts` startup; Transactions: `save`; Loans: recurring handlers; financial integration tests | Persisted card generation reads durable rules/occurrences inside the write queue and commits occurrence rows and rule advancement together. Initial card entries and their rules also commit together. Rule edits merge with durable progress so concurrent edits cannot rewind generation. Existing recurrence date/limit formulas remain. Non-card recurrence keeps its previous transient implementation. |
| D2    | Store: `recordPayment`, `recordFundedPayment`, card recurring batch; financial integration tests                                                                                                                                                                 | New unfunded card payments and generated card entries use configured card currency. Non-INR bank-funded card payments are rejected before writes. No currency conversion or historical rewrite.                                                                                                                                                                                                              |
| D4    | Store: `recordPayment`; financial integration tests                                                                                                                                                                                                              | New unfunded payments use `indiaTodayIso` with the captured timestamp. Historical dates remain untouched.                                                                                                                                                                                                                                                                                                    |

The shared refresh helper reads a serialized ledger/group/transfer/source snapshot and reports
`CommittedSaveRefreshError` if refreshing a committed operation fails. This avoids treating a
refresh failure as permission to create another financial event.

No database migration or backup format change is needed for these approved scopes.
Android version remains `1.1.13 / 52`; application ID remains `com.actionanand.cardnest.app`.

## Financial invariants covered

- Failed writes/commits do not publish approved transaction/EMI/card-recurring changes.
- Duplicate and unfunded-payment retries reuse the failed transaction ID.
- Concurrent retries do not post another ledger row or wallet effect.
- Successful commits followed by refresh failure remain visibly committed and identifiable.
- Linked reminder retries do not repay previously completed cards.
- EMI failure at transaction, plan, installment, reschedule and closure stages rolls back the unit.
- EMI amounts/dates match the unchanged `createEmiSchedule` result.
- Card recurring generation and advancement roll back together, including commit failure.
- Month-end recurrence dates, occurrence limits, old rule IDs, retry and restart are preserved.
- Concurrent future-amount edits do not rewind a rule's advanced date.
- Explicit institution rejection preserves saved identity; legacy unrelated edits still work.
- Bank/Cash generic guards preserve audited opening/correction flows and wallet editing.
- Non-INR funding rejection leaves the financial snapshot unchanged.
- New unfunded payments use the card currency and India date across UTC midnight.
- Encrypted restore failure rolls back; successful restore/restart does not replay new EMI or
  recurring entries; `PRAGMA foreign_key_check` remains empty.
- Existing financial suites continue covering Bank/Cash timing, transfers, Split Payments,
  SMS bindings/decisions, statements, Pluxee snapshots, Utilities and older backups.

## D3: separate field-by-field duplication analysis — no implementation approval

`duplicateTransaction` spreads the original `CardTransaction`, then resets selected fields.
The durable replacement preserves that same construction. The table below describes the
existing behavior and a proposal for later review; it does not authorize or implement it.

| Field                      | Current duplicate behavior                                                             | Proposed treatment for a future approved D3 change                                                 |
| -------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                       | New UUID; retained across a failed save retry                                          | Preserve this new-event identity behavior                                                          |
| `cardId`                   | Copied                                                                                 | Preserve selected payment source                                                                   |
| `type`                     | Copied                                                                                 | Preserve classification; do not silently change financial effect                                   |
| `adjustmentDirection`      | Copied                                                                                 | Preserve; any reclassification needs separate rules                                                |
| `adjustmentPurpose`        | Copied                                                                                 | Preserve pending explicit classification review                                                    |
| `amountMinor`              | Copied                                                                                 | Preserve as an editable template amount                                                            |
| `currencyCode`             | Copied                                                                                 | Preserve for duplication; D2 changes payment/generation paths only                                 |
| `originalAmountMinor`      | Copied                                                                                 | Preserve foreign-amount details unless the user edits the new event                                |
| `originalCurrencyCode`     | Copied                                                                                 | Preserve with the corresponding amount                                                             |
| `foreignFeeMinor`          | Copied                                                                                 | Preserve the existing template behavior; do not recalculate                                        |
| `transactionDate`          | Set to current India date                                                              | Preserve existing new-event behavior                                                               |
| `transactionTime`          | Copied                                                                                 | Review separately: an old event time is not evidence of the new event's time                       |
| `reference`                | Copied                                                                                 | Recommend clearing on the new copy only; a network reference identifies the original event         |
| `merchant`                 | Copied                                                                                 | Preserve useful transaction details                                                                |
| `categoryId`               | Copied                                                                                 | Preserve                                                                                           |
| `notes`                    | Copied in full                                                                         | Preserve user prose; any removal of machine-generated SMS markers needs a separately approved rule |
| `relatedTransactionId`     | Cleared                                                                                | Preserve existing reset                                                                            |
| `taxIncluded`              | Copied                                                                                 | Preserve                                                                                           |
| `taxMinor`                 | Copied                                                                                 | Preserve; no tax recalculation                                                                     |
| `splitGroupId`             | Cleared                                                                                | Preserve: duplication does not join the old group                                                  |
| `splitOriginalAmountMinor` | Cleared                                                                                | Preserve existing reset                                                                            |
| `recurringRuleId`          | Cleared                                                                                | Preserve: new copy is not another scheduled occurrence                                             |
| `generatedOccurrenceDate`  | Cleared                                                                                | Preserve existing reset                                                                            |
| `attachmentIds`            | Copied strings; no new attachment-table rows or physical files are created             | Receipt policy requires an explicit decision; see below                                            |
| `emiPlanId`                | Cleared                                                                                | Preserve                                                                                           |
| `emiInstallmentNumber`     | Cleared                                                                                | Preserve                                                                                           |
| `emiTenureMonths`          | Cleared                                                                                | Preserve                                                                                           |
| `emiOriginalAmountMinor`   | Cleared                                                                                | Preserve                                                                                           |
| `emiCancelled`             | Cleared                                                                                | Preserve                                                                                           |
| `createdAt`                | New timestamp                                                                          | Preserve                                                                                           |
| `updatedAt`                | New timestamp                                                                          | Preserve                                                                                           |
| `sourceBalanceApplied`     | Forced true for MEAL; otherwise copied                                                 | Preserve existing historical balance semantics; do not change as a metadata cleanup                |
| `bankName`                 | Copied                                                                                 | Usually preserve source attribution; it is not a new SMS binding                                   |
| `accountSuffix`            | Copied                                                                                 | Usually preserve same-source attribution                                                           |
| `origin`                   | Copied, including `SMS`                                                                | Recommend marking a deliberately created duplicate `MANUAL`, without changing the original         |
| `balanceEffect`            | Copied into draft; existing persistence recomputes Bank/Cash effects for the new event | Keep effect calculation under existing persistence helpers; never copy a posted effect blindly     |
| `balanceTiming`            | Cleared                                                                                | Preserve existing timing reset                                                                     |
| `balanceTimingAt`          | Cleared                                                                                | Preserve existing timing reset                                                                     |
| `paymentMethod`            | Copied                                                                                 | Preserve useful payment-method details                                                             |
| `paymentMethodDetail`      | Copied                                                                                 | Preserve                                                                                           |
| `paymentMethodCustom`      | Copied                                                                                 | Preserve                                                                                           |
| `smsAdditionalComment`     | Copied                                                                                 | Review as provenance-specific text; do not silently erase user-authored content                    |

### SMS association risk

Duplicating does not clone `sms_candidates` or `sms_reconciliation` rows and does not create a
new evidence binding. The strongest verified association problem is the copied `reference`:
SMS purchase reconciliation rejects a reference found on a different ledger ID, so an
intentional copy can prevent matching the real original. Copied `origin: SMS` and SMS-marked
notes/comments can also misrepresent provenance, even without a database binding.

Bank identity and payment-method details are not interchangeable with network references.
Clearing them wholesale would discard useful same-source information and is not recommended.

### Receipt attachments: actual storage and intended behavior

Despite its name, `attachmentIds` currently holds displayable image strings: picker/web URLs
or data URLs. `prepareReceiptImages` keeps small input URLs and converts oversized accepted
images to data URLs after compression. Transaction details render these strings directly.
The Phase 1 phrase “receipt IDs” was therefore imprecise for the active UI path.

The duplicate receives the same string values. For a URL this means both rows point to the
same resource; no independent physical copy or new attachment ownership record is created.
For an embedded data URL, the image content is present in each serialized payload. Removing
a receipt from the duplicate editor replaces that transaction's array; it does not remove
the original transaction's receipt. Existing URL lifetime/portability limitations are not
repaired by duplication and are outside the approved scope.

A receipt may legitimately document one invoice shared across payments. It can also wrongly
appear to substantiate a distinct new purchase. Neither assumption should be imposed silently.
Two policy choices for separate approval are:

1. Preserve the existing receipt-copy behavior, while separately fixing SMS-specific reference
   and provenance fields. This is the least disruptive receipt policy.
2. Make a new duplicate receipt-free, or offer an explicit copy-receipts choice. Either changes
   user-facing duplication behavior and needs separate approval, tests and a UI decision.

Recommendation: keep receipt copying unchanged unless you explicitly choose another policy.
No receipt, reference, provenance, note, or metadata-copy policy change is included in Phase 2.

## Non-card recurrence: discovered defect and separate proposal

### Root cause and current user impact

The transaction editor offers monthly repetition for Bank/Cash/Wallet sources. `RecurringRule`
uses `cardId` for both cards and sources, but `recurring_rules.card_id` is `NOT NULL` with a
foreign key to `credit_cards`. `persistRecurringRule` deliberately returns without writing
when the identifier is not a credit card. The old in-memory generation path still operates
in that session and saves generated ledger rows separately.

Yes: a user can currently see an in-memory non-card recurring schedule that disappears after
restart. Rules are reloaded only from `recurring_rules`, where that schedule was never saved.
Already committed transactions remain; future occurrences are not generated from the lost
schedule. Edits to its future amount/termination state are likewise not durable as a rule.
Encrypted backups cannot preserve a schedule that never reached durable storage. This does
not imply that the source balance or previously committed payment is automatically reversed.

Existing transaction payloads may retain the orphan `recurringRuleId` and occurrence date,
but they cannot reliably reconstruct the intended future amount, remaining limit, status,
or next date. Do not infer and replay missing occurrences automatically.

### Storage options requiring separate approval

| Option                                              | Migration and compatibility                                                                                                                                                                      | Tradeoffs                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: separate `source_recurring_rules` table          | New additive migration, never edit migration 14; add table to portable export/restore/clear ordering. Preserve existing rule/source IDs. Old backups omit the new table and continue to restore. | Keeps credit-card foreign keys unchanged. Source IDs reference JSON-stored Money Sources, so validate source existence in the same transaction; no honest SQL FK exists to the JSON array. Requires explicit backup-version/downgrade policy. |
| B: dedicated `app_preferences` key for source rules | No schema migration; existing portable preferences backup already carries it. Older clients ignore the unknown key; they cannot execute the new schedules.                                       | Smallest storage change. Must transactionally merge rule JSON, generation and source balances; needs corruption/size handling and clear source-archiving policies. Avoid using a shared whole-preferences replacement.                        |
| C: generalize existing recurring table              | New table-rebuild migration to allow generic source identities while preserving card constraints where applicable; never alter migration 14.                                                     | Affects existing card rules and foreign-key behavior, so has the largest regression and restore risk. Not recommended as a quick correction.                                                                                                  |

Prefer an additive design (A for explicit queryable rule storage, or B if avoiding a schema
migration is the priority). The choice is intentionally not implemented.

### Required financial-safety rules for a future approved implementation

- Validate source existence and intended source kind against stored Money Sources inside the
  same transaction as occurrence creation and rule advancement.
- Keep card schedules and IDs compatible; preserve non-card IDs for rules that can actually
  be recovered from a still-running session.
- Offer explicit recovery/recreation for orphan transactions. Ask for next date and limits;
  never backfill past occurrences or reapply existing source effects automatically.
- Preserve current Bank/Cash baseline questions and timing decisions, wallet snapshot rules,
  tracking-off semantics, currencies and occurrence limits.
- Specify archived-source and unknown-balance behavior before implementing it; those business
  decisions are not authorized by the current task.
- Add SQLite write/commit failure injection, same-occurrence concurrent generation, restart,
  source-edit race, old-backup import, encrypted round-trip and downgrade tests.
- Include an explicit preview showing existing posted payments versus future scheduled events.

Approval is required for the storage choice, any new migration, recovery policy and any new
archived-source/timing behavior. The current non-card path remains unchanged meanwhile.

## Validation and remaining physical checks

| Validation                                                        | Final result                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Complete Angular suite (`ng test --watch=false --progress=false`) | 718 passed, 0 failed; 56 suites                                                               |
| Financial SQLite integration suite (included above)               | 53 passed, 0 failed; includes write/commit/refresh/restore failure injection                  |
| Native JUnit (`:app:testDebugUnitTest --rerun`)                   | 160 passed, 0 failed, 0 errors, 0 skipped; 9 suites; freshly executed                         |
| SMS synthetic fixtures                                            | 70 passed                                                                                     |
| Android isolation                                                 | 9 passed, 0 failed                                                                            |
| Web isolation                                                     | 31 production JavaScript files checked; no Android SMS leakage                                |
| Strict TypeScript application compilation                         | Passed (`tsc -p tsconfig.app.json --noEmit --strict`)                                         |
| Strict TypeScript test compilation                                | Passed (`tsc -p tsconfig.spec.json --noEmit --strict`)                                        |
| Angular ESLint                                                    | Passed, 0 errors / 0 warnings                                                                 |
| Production web build                                              | Passed; initial bundle 618.24 kB, over the 500 kB warning budget                              |
| Production Android frontend build and Capacitor copy              | Passed; initial bundle 621.70 kB, over the 500 kB warning budget                              |
| Native `assembleDebug`                                            | Passed; generated debug APK, no release artifacts changed                                     |
| Native `:app:lintDebug`                                           | Passed; 0 errors, 43 warnings; no native source/configuration changed                         |
| Formatting and `git diff --check`                                 | Passed for changed source files                                                               |
| Protected-file diff                                               | No changes to Android/native sources/configuration, version metadata, workflows or migrations |

Commands used the installed repository dependencies and existing offline Android toolchain;
no dependencies were added/upgraded. Frontend builds needed sandbox-external access for the
already-configured Google Fonts stylesheet. Gradle needed sandbox-external local daemon
access. Both retries completed successfully. The optional Angular native cache was unavailable;
jsdom reported unsupported `scrollTo`; the existing Cards stylesheet exceeded its warning
budget. Native tooling also reported SDK/Gradle deprecation warnings. No warning thresholds,
assertions or lint rules were weakened.

Intermediate failures were resolved before these final results: two unused variables in a
new test assertion; one new encrypted-roundtrip fixture omitted the existing normalized
`excludeStatementDayTransactions` field (the fixture was made canonical, preserving complete
snapshot equality); initial sandbox font/Gradle/temp-file limitations. Final test failures: zero.

Build logs: `tmp/financial-safety-web-build.log`,
`tmp/financial-safety-android-web-build.log`, `tmp/financial-safety-native-validation.log`.
Native XML results: `android/app/build/test-results/testDebugUnitTest/`.
Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

Tests use synthetic, in-memory SQLite databases; no user database was opened or modified.
HEAD remains the baseline commit; nothing is staged or committed. The pre-existing `NUL`
entry still reports `0 additions / 1 deletion`, unchanged from Phase 1. Git still emits its
existing NUL short-read diagnostic. No fetch, push, merge, clean, reset or stash operation ran.

Physical Android checks still require a device: disk-full/native SQLite failure, process
termination around commit, relaunch after a committed refresh failure, rapid repeated taps,
real receipt URL survival, and encrypted backup sharing/restoration through Android's picker.
Verify Bank/Cash timing prompts, Pluxee/FASTag snapshots, EMI actions, and SMS review on-device.
No physical Android result is claimed by JVM or jsdom tests.
