# Device-local date implementation review

Date: 2026-10-28. Baseline: `8adf0bfa6205f226d64e4fa8d2185731744b179b`,
branch `feature/11-split-payment-redesign-extra-attention`.

## Approved implementation only

| Scope               | Files/methods                                                                                                          | Exact change                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared utility      | New `src/app/core/services/device-date.ts`: `resolveDeviceTimeZone`, `currentLocalCalendar`; new `device-date.spec.ts` | Resolve and validate the runtime's device timezone on each call. Valid UTC is accepted. Missing/invalid/throwing timezone resolution uses `Asia/Kolkata`. Return Gregorian date/month and HH:mm:ss from a single supplied/captured instant. If Intl formatting is unavailable or throws, derive the fixed IST fallback from that same instant using UTC getters, not an ISO date substring. Invalid instants are rejected. |
| 2A                  | `src/app/core/services/card-nest-store.ts`: `materializeRecurringTransactions`, `recurringBatch`                       | Capture the instant inside the queued SQLite operation. Derive the persisted-card cutoff from its device-local calendar unless an explicit `asOf` was supplied. Pass that same instant's UTC ISO timestamp into the batch for new audit fields. Recurrence arithmetic, limits, types, amounts, IDs and historical rows are unchanged.                                                                                      |
| 2B                  | Store: `closeEmiPlan`                                                                                                  | Capture one instant; derive the closure comparison month with the device-local utility, retaining that instant's UTC ISO `closedAt` and existing transaction-update timestamps. Existing closure atomicity, calendar-month cancellation rule, formulas, installment rows and paid flags are preserved.                                                                                                                     |
| Regression coverage | `src/app/core/data/bank-cash-tracking.integration.spec.ts`                                                             | Add synthetic SQLite tests for the approved cutoffs/month decisions, rollback, audit timestamps, explicit dates, DST, travel, relaunch, encrypted restore and the deferred non-card boundary. Existing assertions/fixtures remain unchanged.                                                                                                                                                                               |

The device's supported timezone setting is authoritative. No geolocation is used, and UTC
offset zero is never interpreted as missing timezone information. No current timezone or
calendar result is cached. The utility does not attempt to correct an incorrectly set device
clock or an otherwise valid user-selected timezone.

`india-date.ts` is untouched. So are Bank/Cash baselines, Pluxee anchors, SMS parsing/matching,
statement/billing calculations, migrations, backup formats, Android version/application ID,
permissions, signing and release workflows. D3 copying/provenance rules are untouched.

The non-card recurring path intentionally still receives its former default cutoff, or the
explicit cutoff when supplied. It is not switched to the new device-local cutoff. This preserves
the separately deferred behavior; it does not claim global completion of the date policy.

No post-save catch-up invocation, startup-failure containment, timer or foreground scheduling
hook is implemented. Those changes remain outside this approval.

## Tests and financial invariants

Before adding the utility, its test could not compile because the module did not exist.
After the utility was added, its 21 focused tests passed.

Before editing the store, the new financial cases were run against its old behavior:
13 failed and 8 passed (53 existing cases excluded by that focused filter). The failures
identified missed current-date recurrence and incorrectly cancelled current-local-month EMI
charges. After the store changes, all 95 selected utility/financial cases passed. A further
non-card-boundary preservation test was then added for final full-suite validation.

Coverage includes:

- India, valid UTC, New York and an additional UTC+14 utility case.
- Missing, empty, invalid and throwing timezone resolution; absent Intl and formatting failure.
- India midnight, month/year rollover, February 29 and non-leap February rollover.
- New York spring-forward and repeated autumn hour; no duplicate card occurrence.
- Same loaded module across midnight, timezone changes, new store instance and encrypted restore.
- Queue blocked before midnight and released after it: cutoff and new audit timestamps use
  the instant when the financial operation executes, not the earlier request time.
- Explicit `asOf` dates remain exact, including when they differ from the local current date.
- Previously selected transaction dates, timestamps and committed occurrences remain unchanged.
- Generation SQL failure rolls back new rows and rule advancement; concurrent retry posts once.
- Closure commit failure leaves plan, ledger and installments unchanged; retry remains safe.
- Advancing the clock while closure reads its ledger does not change its captured decision month.
- Installment payloads and paid flags compare exactly before/after closure.
- Encrypted round-trip/relaunch preserves rows without replay; foreign-key checks remain empty.
- Non-card cutoff behavior is unchanged even after the device calendar/timezone changes.

No historical transaction date or existing closure result is converted or repaired.
An eastward timezone change can make a scheduled date due sooner in absolute time, as required
by the approved device-local policy. Returning west does not undo an already posted occurrence;
persisted occurrence identity prevents reposting it.

## Separate proposal A: immediate recurring catch-up — NOT IMPLEMENTED

### Cause and impact

`TransactionsPage.save()` now atomically commits the initial credit-card entry and its rule
through `saveManualTransaction()`. It skips `addRecurringRule()` for card sources, and therefore
also skips the materialization invocation formerly made there. A backdated schedule can show
only its initial entry until startup or another explicit materialization invocation. Changing
the cutoff utility alone does not fix this missing invocation.

### Minimal proposed correction

File: `src/app/features/transactions/transactions.ts`, method `save()`.

After a successful initial card save (including a known committed-refresh warning), invoke
materialization for the new persisted card schedule, retaining the existing transaction/rule
identity. Hold the saving guard through the operation. If catch-up fails, report that the
initial entry and schedule are already saved, close/reset the completed transaction flow,
and leave the due rule retryable. Do not retry the first entry as a new transaction.

Preserve recurrence formulas, limits, amounts, types, selected dates, currencies and the new
device-local cutoff. Do not invoke the non-card creation path or add automatic timers.

### Tests proposed, not added

1. Through the real transaction editor, save an unlimited monthly card entry dated August 7
   with the local date October 28. After `save()` finishes, assert August 7, September 7 and
   October 7 immediately, with no reload or explicit materializer call in the test.
2. Inject a ledger-write/commit failure only during catch-up, after the initial transaction/rule
   commit. Assert exactly one initial row, a durable due rule, a warning, and no false success.
3. Retry generation and relaunch: assert one row per occurrence, with the initial ID unchanged.
4. Inject a refresh failure after catch-up commits: close the completed UI action and preserve
   all committed rows without offering a new initial submission.
5. Assert fixed limits and two genuinely due concurrent materializers do not over-generate.

Financial impact: restores existing immediate posting of already-due card occurrences; those
entries affect outstanding/spending through unchanged calculations. No migration or backup
format change. Main risk is confusing a catch-up failure with an uncommitted initial entry.
Separate approval is required before editing this flow.

## Separate proposal B: incomplete startup loading — NOT IMPLEMENTED

### Cause and impact

`CardNestStore.initialisePreferences()` awaits materialization before `loadEmiPlans()` and
`loadLoans()`. If generation or its refresh fails, those loaders are skipped. App initialization
uses `Promise.allSettled`, so the app can continue with empty in-memory commitment lists while
the records remain in SQLite. The later app scheduling retry does not load the skipped lists.
The related legacy EMI-normalization failure path can also prevent subsequent loan loading.

### Minimal proposed correction

Primary file/method: `src/app/core/services/card-nest-store.ts`, `initialisePreferences()`.

Contain a materialization failure long enough to complete independent EMI and loan history
loading, then propagate/report the scheduling failure through the existing app warning path.
Do not swallow unrelated load failures, recalculate installments, advance failed rules, or
create financial entries in the error handler. Any app-level warning plumbing needed should
be reviewed explicitly, not implemented as a general initialization rewrite.

### Tests proposed, not added

1. Seed a current-format EMI, installments, a loan, and a due persisted card rule in SQLite.
   On a fresh store, inject recurring ledger-write and commit failures separately during
   initialization. Assert existing histories load exactly; the failed rule/ledger remain safe.
2. Inject a committed recurring refresh failure. Assert histories still load and restarting
   does not repeat the committed occurrence.
3. Exercise the existing legacy EMI-normalization failure path and assert unrelated loan
   history is not concealed. Preserve normalization's existing financial rules.
4. Verify the app exposes the scheduling warning, and subsequent retry/relaunch recovers without
   duplicate entries or changed balances. Round-trip the fixture through encrypted backup.

Financial impact: prevents temporarily hidden commitment history; it does not repair or alter
stored balances/history. No migration or backup change is indicated. Main risk is accidentally
masking genuine initialization errors. Separate approval is required.

## Read-only inventory: remaining fixed-IST transaction-related consumers

None of these consumers were changed. Line numbers can move; method/property names identify
the reviewed call sites.

| File / consumer                                                                                                             | Current IST behavior                                                                   | Important boundary for a future proposal                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `app.ts`: Flash transaction creation                                                                                        | `transactionDate: indiaTodayIso()` on creation                                         | New-entry default only; do not shift an explicitly selected date                                       |
| `features/transactions/transactions.ts`: transaction form and `resetForm()`                                                 | New-form/default-reset date uses `indiaTodayIso()`                                     | Preserve user-edited dates and existing transaction dates                                              |
| Same file: `filtered`, `defaultOpenGroupKey`                                                                                | India current month/date controls EMI visibility and default activity group            | Display behavior; should be reviewed together with outstanding filters, not silently changed           |
| Store: `duplicateTransaction()`                                                                                             | Date of the new copy uses `indiaTodayIso()`                                            | D3 remains deferred; no duplication-copy policy change is authorized                                   |
| Store: `recordPayment()`                                                                                                    | New unfunded payment date derives from captured instant in IST                         | Separate approval needed to change this already-implemented payment path                               |
| Store: `recordFundedPayment()`                                                                                              | New bank-funded payment date AND wall-clock time use IST                               | Must remain compatible with unchanged Bank/Cash baseline/timing semantics                              |
| `shared/source-movement-dialog.ts`: `date`                                                                                  | New movement dialog initializes date with `indiaTodayIso()`                            | Explicit selected movement dates and baseline questions must be preserved                              |
| `shared/app-date-picker.ts`: `viewMonth`, `today`, `show()`                                                                 | Initial month/today are IST; today is captured for the instance                        | Update freshness separately; do not convert the selected date string                                   |
| `features/loans/loans.ts`: `currentMonthKey`, `currentMonthLabel`                                                           | Page captures India month; label explicitly formats Asia/Kolkata                       | Can disagree with the newly approved device-local closure decision while this display remains deferred |
| Same file: start-date form/reset; `setEmiStartToCurrentMonth`, `loanProgress`, `nextInstallment`, recurring-month summaries | Uses `indiaTodayIso()` / `indiaCurrentMonth()` for current reference/default decisions | No EMI formula, schedule or paid-history change should be inferred from a date-default change          |
| `features/payables/payables.ts`: `cardStatementDueDate`, `upcomingLoanPayable`                                              | Uses `indiaTodayDate()` as the current calendar reference                              | Billing/statement/payable behavior needs separate approval                                             |
| `india-date.ts`: all helpers and `IndiaTodayClock`                                                                          | Explicit fixed-India date, month, wall-clock time and rolling date signal              | Do not globally replace these semantics                                                                |
| Utilities service/calculations and Utilities page                                                                           | India-date defaults, reminders, summaries and rolling clock                            | Related commitments, but outside the two approved store operations                                     |
| Bank Activity page/service                                                                                                  | India rolling date and current-date validation limit                                   | Monitoring stays separate from actual financial transactions                                           |

### Fixed-IST evidence/balance contracts, not ordinary current-date defaults

- `source-balance.ts`: `baselinePosition()` compares an event with a confirmed balance in India
  time. Changing its calendar could change whether an effect applies; explicitly untouched.
- `wallet-anchor.ts`: verified Pluxee/SMS snapshot date/time comparisons use India time.
  Changing them could replay/exclude historical effects; explicitly untouched.
- SMS parser defaults, explicit IST extraction, matching against source cutovers and receipt
  evidence displays use fixed India interpretation in places. No parser defect is established
  by this inventory, and no SMS-extracted date is changed.
- `transaction-time.ts` uses UTC formatting to display a stored wall-clock value without shifting
  it. That is not a current-date source and must not be replaced mechanically.

### Other UTC/current-date issues remain outside this implementation

The module-level UTC `today` still feeds dashboard/default data and deferred non-card recurrence.
`cardOutstanding`, outstanding/unbilled transaction filters, Sources current cycle and Categories
current-month calculations also retain UTC-derived current dates/months. Settings retention
cutoffs and backup filename dates are separate UTC consumers. None was changed.

`nextRecurringDate()` and the editor's `nextMonthlyOccurrence()` retain the existing local-noon
calendar arithmetic and UTC serialization. This approval does not authorize changing those
calculations; timezone-extreme behavior needs a separate focused review before modification.

## Validation and physical-device limits

| Check                                                 | Final result                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete Angular suite                                | 761 passed, 0 failed; 57 suites. All previous 718 tests retained; 43 new tests.                                                                   |
| Device-date utility                                   | 21 passed, included in the full suite                                                                                                             |
| Financial SQLite integration                          | 75 passed, included in the full suite; 22 new cases                                                                                               |
| Fresh native JUnit (`:app:testDebugUnitTest --rerun`) | 160 passed, 0 failed/errors/skipped; 9 suites                                                                                                     |
| SMS fixtures                                          | 70 passed                                                                                                                                         |
| Android isolation                                     | 9 passed, 0 failed                                                                                                                                |
| Web isolation                                         | 31 production JavaScript files verified; no Android SMS leakage                                                                                   |
| Strict TypeScript                                     | Application and tests both passed with `--noEmit --strict`                                                                                        |
| Angular ESLint                                        | Passed, 0 errors/warnings                                                                                                                         |
| Production web build                                  | Passed; initial bundle 619.40 kB, over the existing 500 kB warning budget                                                                         |
| Production Android frontend / generated asset copy    | Passed; initial bundle 622.86 kB, over the existing 500 kB warning budget                                                                         |
| Native debug APK build                                | Passed; no release artifact was changed                                                                                                           |
| Android lint                                          | Passed; 0 errors, 43 warnings                                                                                                                     |
| Formatting / `git diff --check`                       | Passed for changed source files / tracked changes excluding the existing NUL entry                                                                |
| Protected-file comparison                             | No changes to India helpers, baseline/anchor logic, SMS, billing/EMI calculations, migrations, app/editor callers or Android/native configuration |

Commands: `ng test --watch=false --progress=false`; strict `tsc` for `tsconfig.app.json`
and `tsconfig.spec.json`; `ng lint`; `validate-sms-fixtures.mjs`; production web and
`production,android` builds; `verify-web-sms-isolation.mjs`; Capacitor Android copy;
`node --test scripts/verify-android-sms-integration.mjs`; offline Gradle
`:app:testDebugUnitTest --rerun assembleDebug :app:lintDebug`.

The optional Angular native cache was unavailable. jsdom reported its unsupported `scrollTo`;
the unchanged Cards stylesheet remained above its warning budget. Native tooling reported
SDK/Gradle warnings. No warning limits, assertions, fixture values or lint rules were weakened.
The initial missing-module failure and the 13 financial failures were intentional pre-fix
regression checks; final failures are zero. A transient formatter file-open failure succeeded
on retry. Existing installed dependencies and the existing offline Android toolchain were used.

Logs: `tmp/device-date-web-build.log`, `tmp/device-date-android-frontend-build.log`,
`tmp/device-date-native-validation.log`. Native test XML:
`android/app/build/test-results/testDebugUnitTest/`. Generated APK:
`android/app/build/outputs/apk/debug/app-debug.apk`.

Tests use synthetic in-memory SQLite only; no user database was read or modified. HEAD remains
the baseline commit, nothing is staged or committed, and upstream comparison remains 0/0
against the local reference. Existing `NUL` remains `0 additions / 1 deletion` with its original
Git short-read diagnostic. No fetch, branch change, reset, clean, stash, commit, push or merge ran.

No physical Android verification is claimed. Still check on-device: India/UTC/New York timezone
changes while running; DST transition/repeated hour; background/relaunch near midnight; SQLite
disk-full/process interruption; EMI closure confirmation and displayed month; backup picker
round-trip; unchanged SMS/baseline/Pluxee timing. A valid but incorrectly configured device clock
remains authoritative under the requested policy.
