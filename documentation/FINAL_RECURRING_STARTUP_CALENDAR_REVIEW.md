# Final recurring, startup and calendar reliability review

Starting HEAD: `4059e0b2e5bbb29036ed5de7e39e08d042f389ff`.
Branch: `feature/11-split-payment-redesign-extra-attention`.
Date: 2026-10-28. Only the three corrections in the user's final reliability request are included.

## Files and exact changes

| File                                                       | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/features/transactions/transactions.ts`            | `save()` retains new card-recurring transaction/rule IDs across an uncommitted retry, holds the saving guard, and invokes scoped catch-up after the initial durable save. `resetForm()` clears that draft identity when the entry flow is reset. `nextMonthlyOccurrence()` and `emiStartDate()` use consistent UTC date-only arithmetic; the original non-card monthly helper remains on its old branch.                                                         |
| `src/app/core/services/card-nest-store.ts`                 | `materializeRecurringTransactions(asOf?, ruleId?)` can select only the new persisted rule and skip unrelated/non-card processing for that call. `initialisePreferences()` attempts EMI and loan history loading independently after generation fails, preserves failures, and exposes a localized `initialisationWarning`. Card `nextRecurringDate()` uses UTC date-only arithmetic; the exact former calculation remains in `nextLegacyNonCardRecurringDate()`. |
| `src/app/app.ts`                                           | Displays the existing store startup warning through the existing snackbar. A failed initialization is not followed by the previous immediate post-render generation invocation; no new retry loop is introduced. The successful-startup path keeps its existing invocation.                                                                                                                                                                                      |
| `src/app/core/data/bank-cash-tracking.integration.spec.ts` | Synthetic SQLite editor/startup/rollback/concurrency/relaunch/backup tests and before/after financial snapshots.                                                                                                                                                                                                                                                                                                                                                 |
| `src/app/app.spec.ts`                                      | Startup-warning rendering and absence of immediate financial retry. Existing mock gains the new store warning signal; existing assertions remain.                                                                                                                                                                                                                                                                                                                |
| New `src/app/app-initialization.spec.ts`                   | Runs the real app initializer configuration with controlled services, verifies completion of independent initialization after store rejection. No production initializer configuration is changed.                                                                                                                                                                                                                                                               |
| New `src/app/core/services/calendar-arithmetic.spec.ts`    | Executes the actual production helper bodies in isolated child processes with real `TZ` settings and verifies identical date-only results across six timezones and within one changing-timezone session.                                                                                                                                                                                                                                                         |
| This document                                              | Review, test evidence, preserved boundaries and remaining checks.                                                                                                                                                                                                                                                                                                                                                                                                |

No code in `device-date.ts`, India helpers, payment defaults, source movement defaults, SMS,
Bank/Cash baselines, Pluxee anchors, Utilities, Bank Activity, Payables, Loans display defaults,
EMI formulas, billing/statement calculations, migrations or backup formats is changed.

## Fix 1: immediate catch-up

The initial transaction and card rule still commit together through `saveManualTransaction()`.
Only after that result is known committed does the editor invoke materialization, passing
the new rule ID. The materializer uses the existing fresh device-local cutoff/IST fallback.
It does not advance an unrelated historical rule or invoke the non-card generator for this
scoped action. Existing unscoped startup/manual materialization responsibilities remain.

The initial transaction counts toward the unchanged total occurrence limit. For an unlimited
August 7 entry saved on local October 28, completion includes August 7, September 7 and
October 7, but not November 7. A limit of one retains only the initial entry.

### Failure outcomes

| Outcome                                         | Result                                                                                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial save fails before commit                | Form/entered values stay open; warning shown; the same transaction and rule IDs are used on retry; no durable initial row/rule or generated effects remain.                                                            |
| Initial save commits, its refresh fails         | Existing `CommittedSaveRefreshError` marks it committed; scoped catch-up can still complete from SQLite; warning remains, and the completed initial flow closes.                                                       |
| Initial save commits, catch-up SQL/commit fails | Initial row and rule remain durable; attempted batch rolls back; warning explicitly says the transaction/schedule were saved but catch-up is incomplete; form resets/closes instead of resubmitting the initial entry. |
| Catch-up commits, refresh fails                 | Existing committed-save error is surfaced as a warning; exact committed occurrence rows/IDs remain; completed initial flow closes.                                                                                     |

For card recurrence, the saving guard covers initial save and catch-up. Rapid taps do not create another initial
row. Concurrent scoped/unscoped generation shares the SQLite write queue and checks persisted
occurrence identity. Failed initial-entry IDs are held in that editor session, not a new
persistent draft format; a pre-commit failure has no posted financial event to replay after
restart. Committed failures close the form and reload from durable data.
The existing non-card editor guard timing is explicitly retained; a separate regression
assertion caught an accidental extension during final review and passed after that boundary
was restored. Its recurrence storage, calculations and posting implementation remain unchanged.

## Fix 2: startup history and warning reliability

After recurring rules load, generation, EMI loading and loan loading are attempted in their
existing order, with independent failure capture. Loan loading reads its own table and can
proceed if EMI loading/normalization fails. Normalization retains its existing implementation;
the error handler does not rewrite, delete or recalculate history.

The store still rejects initialization on failure. A sole error is rethrown as the original
object. Multiple failures use the standard `AggregateError`, retaining each original error;
EMI/loan load failures are ordered before a scheduling failure and explicitly named in the
warning. They are never disguised as a scheduling-only problem. No global error framework or
application initializer redesign is introduced.

The existing initializer's independent-service completion (`Promise.allSettled`) is unchanged.
The root app renders the store warning through its existing snackbar. It does not immediately
retry financial generation after that failed startup; a subsequent normal relaunch or explicit
materialization can recover using persisted rules/occurrences. There are no timers, jobs,
arbitrary delays or retry loops.

## Fix 3: calendar dates are not instants

The three corrected helpers parse the existing date string in a UTC calendar representation,
use UTC calendar getters/setters consistently, and serialize the resulting UTC date-only value.
This is date arithmetic, not selection of the user's current date. It does not replace the
approved device-local-first utility or force today's date to UTC.

Monthly anchors and end-of-month clamping are retained. Daily, weekly, biweekly, yearly,
bimonthly, quarterly, half-yearly and explicit interval choices retain their arithmetic.
The existing yearly February 29 behavior remains March 1 in a non-leap target year.
THIS_MONTH, NEXT_MONTH and explicit custom EMI month options keep their meanings.

Non-card recurrence is deliberately excluded from this correction: its existing local-date
implementation is retained in dedicated private legacy helpers and selected only on that
existing branch. Both store and editor legacy results are compared against the original
calculation in the timezone matrix. No non-card storage/schema change is included.

## Regression evidence

Before production changes:

- Calendar matrix: 3 failed / 4 passed. Kiritimati and Auckland produced previous-day results;
  the same-session timezone-change case also failed.
- Editor/startup financial cases: 11 failed / 1 passed, with the 75 existing cases excluded
  by the focused filter. They exposed missing immediate rows, changed retry IDs, misleading
  success messages, missing guards, and hidden EMI/loan lists.
- Startup-warning rendering: 1 failed; 20 existing app tests excluded by the focused filter.

After the corrections and expanded cases, the focused set passed 119 tests across four suites.
The final non-card guard preservation case was included in the complete 786-test run.
No existing assertion was removed or weakened. One new initializer test initially called an
Angular internal method absent from its public type; it was corrected to use TestBed's actual
automatic initializer execution and public completion promise.

### Financial database invariants tested

- Real editor Save performs immediate catch-up, with no test-side materialization/restart needed.
- Unlimited and fixed limits, including the initial entry, produce exactly the intended dates,
  amounts, types, currencies and card outstanding.
- Rapid Save taps and simultaneous due materializers do not duplicate initial or generated IDs.
- An unrelated durable due rule remains unadvanced by the new-entry action.
- Initial commit failure leaves financial snapshots unchanged and retry reuses both IDs.
- Catch-up SQL failure after an attempted earlier occurrence rolls back the full batch.
- Catch-up commit failure rolls back; post-commit refresh failure retains committed rows.
- Timezone change between initial commit and catch-up execution uses the current device cutoff.
- Restart after failure posts missing occurrences once; restart after success does not replay.
- Two existing EMI plans, six installments and three loans load despite recurring SQL/commit/
  refresh failure. Durable histories compare exactly before/after failure.
- Card outstanding is unchanged after failed generation; after committed generation it changes
  only by the expected occurrence amount.
- Legacy EMI-normalization failure rolls back and still allows unrelated loans to load.
- Simultaneous EMI/loan read failures preserve original errors and receive higher warning priority.
- The actual app initializer completes independent services; root warning is visible and does
  not initiate an immediate generation retry.
- Encrypted backup/restore, including synthetic restore failure, preserves rows/IDs without
  replay. Startup recovery with EMI/loan history also round-trips exactly.
- Foreign-key checks remain empty. Source balances/baselines, transfers, balance adjustments,
  Split groups, SMS decisions, statements and categories remain unchanged by scoped catch-up.

### Actual-timezone calendar matrix

Child processes use `Asia/Kolkata`, `UTC`, `America/New_York`, `America/Los_Angeles`,
`Pacific/Kiritimati` and `Pacific/Auckland`. Each verifies actual `Date.getTimezoneOffset()`;
an Intl mock is not used to stand in for process-local Date behavior.

Each timezone runs the same explicit expectations: January 31 to February 28/29; February to
March with and without a retained January anchor; December/year rollover; yearly leap-date
overflow; daily/weekly/biweekly DST-period dates; bimonthly/quarterly/half-yearly/custom intervals;
and all three EMI start-month choices. Another child changes its timezone within the session.
Identical date-only inputs produce identical corrected results; legacy non-card results remain
the original timezone-specific values.

## Validation results

| Validation                                            | Final result                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Complete Angular suite                                | 786 passed, 0 failed; 59 suites. All 761 prior tests retained; 25 new cases.                                                                                                   |
| Financial SQLite integration, included above          | 91 passed, 0 failed; SQL/commit/refresh/restore failures and concurrency included                                                                                              |
| Calendar process matrix, included above               | 7 passed; six actual process timezones plus same-session timezone changes                                                                                                      |
| App warning and initializer tests, included above     | Passed; root warning visibility, no immediate generation retry, independent initializer completion                                                                             |
| Strict application/test TypeScript compilation        | Both passed with `--noEmit --strict`                                                                                                                                           |
| Angular ESLint                                        | Passed; 0 errors/warnings                                                                                                                                                      |
| SMS fixtures                                          | 70 passed                                                                                                                                                                      |
| Web isolation                                         | 31 production JavaScript files verified                                                                                                                                        |
| Android isolation                                     | 9 passed, 0 failed                                                                                                                                                             |
| Fresh native JUnit (`:app:testDebugUnitTest --rerun`) | 160 passed, 0 failed/errors/skipped; 9 suites, freshly executed after the final asset copy                                                                                     |
| Native `assembleDebug`                                | Passed; APK contains the final frontend assets                                                                                                                                 |
| Android `:app:lintDebug`                              | Passed; 0 errors, 43 warnings                                                                                                                                                  |
| Production web build                                  | Passed; initial bundle 620.76 kB, over the existing 500 kB warning budget                                                                                                      |
| Production Android frontend and generated asset copy  | Passed; initial bundle 624.21 kB, over the existing 500 kB warning budget                                                                                                      |
| Formatting and `git diff --check`                     | Passed for changed code / tracked changes excluding pre-existing NUL                                                                                                           |
| Protected files                                       | No changes to native/Android configuration, device-date/India helpers, baseline/anchor logic, SMS, billing/EMI formulas, migrations, dependencies or initializer configuration |

Logs: `tmp/final-reliability-web-build.log`, `tmp/final-reliability-android-frontend-build.log`,
`tmp/final-reliability-native-validation.log`. Generated APK:
`android/app/build/outputs/apk/debug/app-debug.apk`. Native XML results:
`android/app/build/test-results/testDebugUnitTest/`.

Commands used the installed Angular CLI/dependencies and existing offline Android toolchain.
The optional Angular native cache was unavailable; jsdom reported its unsupported `scrollTo`;
the unchanged Cards stylesheet exceeded its warning budget. No assertion, lint rule, budget
or warning threshold was weakened. Production frontend builds used access to the existing
font stylesheet; Gradle used sandbox-external local daemon access.

Tests use synthetic in-memory SQLite only; no user financial database was opened or modified.
Build output is confined to generated and ignored locations. Existing release artifacts are
not replaced. HEAD stays at the starting commit, nothing is staged, and no commit/push/merge,
branch change, reset, clean or stash operation is performed.

Validation used the installed CLI equivalents of the repository's package scripts:
`ng test --watch=false --progress=false`, strict `tsc` for application/test configurations,
`ng lint`, SMS fixture validation, production web and `production,android` builds,
web/Android isolation checks, Capacitor Android asset copy, and offline Gradle
`:app:testDebugUnitTest --rerun assembleDebug :app:lintDebug`. Final failures: zero.

## Remaining boundaries and device checks

D3, non-card recurrence storage/behavior, remaining fixed-IST defaults, count-label wording,
manual foreign-card creation, and broader startup failures before the reviewed generation/
history stage remain outside these corrections. No additional behavior was changed to address
them. Refer to the earlier audit/inventory for those separately deferred items.

In particular, a failure before the reviewed startup stage (for example, rejection of
`loadRecurringRules()` itself) retains the prior control flow and may still prevent later
loaders. This is a pre-existing, unexpanded boundary, not a regression introduced by these
changes; no new failure-injection case for that earlier stage is claimed. Extending error
containment to those additional responsibilities requires separate review/approval.

Historical transaction/rule dates are not bulk-repaired. Existing schedules advance only when
their normal generation operation runs. The calendar correction prevents new timezone-related
shifts; it does not infer the intended date of an already incorrect historical record.

Physical Android checks are still outstanding: repeated taps and disk-full failures; process
termination around commit; relaunch after incomplete catch-up; startup warning presentation;
India/New York/Kiritimati/Auckland timezone changes; DST and midnight boundaries; real backup
picker/sharing restoration; unchanged SMS, baseline and wallet behavior. No physical-device
verification is claimed by JVM, jsdom or child-process tests.

Android `1.1.13 / 52`, application ID, permissions, signing, workflows, migration 14, schema,
backup formats, branch and existing NUL entry must remain unchanged. No commit, push or merge
is performed.
