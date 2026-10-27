# Feature 11 Android corrections and final hardening

Branch: `feature/11-split-payment-redesign`

Hardening baseline: `8f5412010416bbbc50daddb4af09a75edb50152d`. Local HEAD and the public HTTPS remote reference matched before editing. SSH verification failed on host-key trust; no SSH trust settings were changed. The baseline passed 670 Angular tests in 55 files.

Version: **1.1.13 / 52**, unchanged, including the application display. No push, merge, signing change, application-ID change, permission change, release-workflow change, APK/AAB generation or version-bump script invocation. The unrelated Windows `NUL` entry is preserved. The ending commit SHA is supplied in the chat delivery; this report is included in that commit.

## Confirmed defects and corrections

- **Theme radio focus hid the FAB.** The original tag-only keyboard check classified every INPUT as text entry. `isTextEntry` now distinguishes editable text/search/tel/url/email/password/number, textareas and nested contenteditable from radio, checkbox, button, range, colour, date and other non-keyboard controls. Readonly/disabled controls are excluded. Focus lookup descends open Shadow DOM. Structural navigation changes refresh stale focus state. A regression clicks and focuses the actual Settings Light/Dark/System radio controls under Android-native mocks, checks both exclusive modes, then verifies text focus/blur. The existing shared colour-token/contrast, restart, lock, modal, snackbar and reduced-motion tests remain intact. Bottom-navigation Add Transaction is unchanged.
- **A committed financial save could look like a failed write.** `saveManualTransaction` keeps its Promise<void> API. Pre-commit failures still reject normally and roll back. Only failures after a successful commit become `CommittedSaveRefreshError`, carrying the original transaction ID and underlying cause. The committed row and balances publish before refresh. Quick Transaction closes and warns that the screen did not fully refresh; it cannot submit a second row. The full transaction editor also distinguishes this outcome, retaining its existing recurring/group flow and avoiding an unsafe new submission. No failure is silently swallowed.
- **Quick Transaction hardcoded INR for foreign cards.** Its form now displays the selected card currency and saves that currency. Bank/Cash/wallet sources retain INR handling. No conversion or exchange-rate logic was added; historical rows are untouched. Real SQLite rejects a mislabeled INR purchase for a USD card and accepts the matching USD amount unchanged.
- **Source edits published optimistic identities and reported success before commit.** `updatePaymentSource` now returns an awaitable Promise, validates the source and changes, merges only the intended fields into the current stored row inside the existing serialized transaction queue, then publishes committed sources. It preserves concurrent changes to other fields, balances and baseline metadata. All Money Sources edit/archive/restore callers await persistence and show failure rather than false success. Failed inline bank edits restore the committed displayed value.
- **Overlapping monitoring reloads could publish an older reconciliation result.** Reloads are serialized/coalesced with a trailing request. A reconciliation result cannot replace a newer source signal publication. The coordinator still reads persisted records transactionally, so concurrent calls cannot create duplicate linked identities. No polling or timeouts were introduced.
- **Completed discovery scans restarted from zero.** The cursor now retains its processed high-water rowid. A repeated completed action checks zero previously processed alerts; new alerts remain discoverable, interrupted pages retry safely and empty pages do not rewrite the cursor. Existing backup restore still resets the local rowid cursor. Retention and fingerprint rules are unchanged.
- **Find Banks lacked an icon.** It now uses the existing decorative search icon and shared button spacing, without another icon library or another action button.
- **Archived bank sources had no explicit UI restoration path.** A linked archived source now produces a clear notice, and Money Sources has a secondary Archived bank accounts section with a guarded Restore action. Restoration reuses the same ID and keeps saved balances, baselines and transactions. Nothing is silently restored or duplicated.
- **Editing oversized malformed legacy phone data silently truncated unselected digits.** Such values now remain visible and invalid while the user deletes/corrects them; full replacement still uses the ten-digit input rules. Tests assert Angular control values, not only DOM text. Normal typing/paste/autofill/IME, fixed +91 prefix, optional empty, normalized persistence and WhatsApp behavior remain unchanged.

## Linked metadata policy

| Field                                         | Policy                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paymentSourceId`                             | Stable association; never silently reassigned after an identity edit.                                                                                                                                                    |
| Bank identity / suffix                        | Match normalized bank plus compatible final three digits. Source suffix keeps all original 3-5 digits, including leading zeros. A mismatch raises an explicit review/relink conflict.                                    |
| Nicknames                                     | Independently editable; a rename does not overwrite the other screen's customized nickname or break the stable link.                                                                                                     |
| Owner                                         | Automatic enrollment requires OWN. OTHERS to OWN requires explicit confirmation. OWN to OTHERS requires explicit unlinking; the existing financial source/history is retained, and family monitoring is not re-enrolled. |
| Archive state                                 | Independent and explicit on each side. No cascade, unarchive, duplicate or reparenting. Archived sources have an explicit Restore path; archived profiles use their existing Restore action.                             |
| Manual-only / incomplete identity             | Not automatically enrolled. Completing/reviewing identification remains explicit.                                                                                                                                        |
| Cash / Pluxee / meal / FASTag                 | Excluded from bank-identity reconciliation.                                                                                                                                                                              |
| Balances / baselines / transaction references | Outside identity reconciliation. Identity-only writes preserve them exactly.                                                                                                                                             |

Reconciliation triggers remain tracking enablement, committed source enrollment/edits, profile save/archive/restore, navigation/load and backup restore. Turning tracking off deletes nothing. Re-enabling does not derive transactions or invent balances. The coordinator depends on SQLite rather than either domain store/service, so no circular dependency was introduced.

## Investigated behavior retained

No new defect was reproduced in latest debit/credit direction comparisons, stale/same-date rejection, mandatory SMS confirmation, deletion tombstones, ambiguity retention, profile ownership checks, centered profile modal structure, keyboard viewport constraints, nested picker layering, focus trapping/restoration, deletion confirmation busy guards or compact transfer timing. Their existing regressions remain, including cancellation, rollback, idempotency and saved timing selection. No redesign was applied.

Migration 14 and its reconciliation SQL are **unchanged** in this hardening commit. No additional schema version is needed. Tests establish stable profile/source ownership, latest valid debit/credit selection, deterministic same-date ties, malformed/future-date handling, tombstones before pruning and repeat application. A schema-13 encrypted portable backup with redundant monitoring history restores to the correct two latest events and retains the processed fingerprint. A forced restore insertion failure rolls back monitoring and financial tables together; retry then succeeds. Previously discarded events do not reappear when a latest event is deleted. General financial/SMS history is not pruned.

## Regression evidence and financial invariants

The complete final suite passes **705 tests in 56 files**, adding 35 meaningful cases to the 670-test baseline. New coverage includes real Settings radio interactions; editable/non-editable/Shadow DOM focus; pre-commit failure and retry; committed transaction-list and transfer-refresh failures; duplicate taps/API retry; restart; positive/negative currency cases; concurrent source edits and navigation; failed identity writes; source/profile archives and restores; ownership transitions; concurrent reconciliation and failure/retry; custom nicknames and leading zeros; encrypted legacy restore/rollback; completed/interrupted discovery; legacy-phone correction; and source UI feedback/restoration.

SQLite tests compare durable transactions, credit-card data, source transfers, balance adjustments, Split Payment groups/members, SMS associations/decisions, statements and categories. Source balances, cutover dates and snapshots are compared separately from identity metadata, including unrelated wallet/Pluxee balances. A committed purchase retains one row and one balance effect through retry/restart; a funded payment retains one transfer and one funding effect after refresh failure. No real financial database was opened or modified for this work.

The baseline and focused red runs reproduced the reported defects before their fixes. A full-run Capacitor module-cache isolation issue was fixed in the integration-test setup, without relaxing native-platform guards or assertions. Missing jsdom matchMedia and microtask synchronization were supplied in the interaction harness; no arbitrary production delays were added.

## Validation

| Command/check                                    | Result                                            |
| ------------------------------------------------ | ------------------------------------------------- |
| `npm test -- --watch=false`                      | PASS: 705 tests / 56 files                        |
| `npm run lint`                                   | PASS                                              |
| `ngc -p tsconfig.spec.json --noEmit`             | PASS                                              |
| `npm run test:sms:fixtures`                      | PASS: 70 fixtures                                 |
| `npm run build`                                  | PASS                                              |
| `npm run test:web-isolation`                     | PASS: no web SMS route/plugin/permissions         |
| `npm run build:android`                          | PASS                                              |
| Capacitor Android sync                           | PASS                                              |
| `npm run test:android-isolation`                 | PASS: 9 checks                                    |
| `:app:testDebugUnitTest --offline --rerun-tasks` | PASS: 160 tests; zero failures, errors or skipped |
| `git diff --check`                               | PASS                                              |

Angular tooling uses the existing WSL Node 24.16.0 runtime because npm is not on the Windows PATH. Native tests use the existing local JDK, SDK and Gradle cache. No dependencies or test assertions were weakened to obtain a green result.

Warnings are separate from failures: initial bundles exceed the 500 kB warning threshold but remain below 1 MB; existing cards.scss exceeds its 23 kB warning threshold but remains below 26 kB; jsdom lacks scrollTo; native dependencies and Gradle report deprecations. Available semantic AXE checks pass. These checks do not replace rendered/device colour and layout verification.

## Physical Android checklist — still outstanding

No real-device UI validation is claimed. The user will verify:

- Light/Dark/System while theme radio controls retain focus; both FAB modes, colour/position, snackbar clearance, native-only visibility and text-keyboard dismissal.
- Centered profile dialogs, equal safe-area gutters, long-form scrolling, large text, keyboard resizing, nested pickers, focus restoration, TalkBack and Android Back.
- All three Bank Activity tabs at narrow widths, long bank names, Find Banks counts/icon, saved-profile visibility and selected-tab preservation.
- OWN versus OTHERS sync; existing-source editing, conflict review, archive/restore and stable customized names.
- Latest debit/credit replacement, stale evidence suppression and encrypted backup/restore on a physical device.
- Compact timing radios, saved selections, acknowledgement reset and both balance effects on synthetic accounts.

No unresolved automated financial-safety issue is known. Physical Android verification remains the outstanding limitation.

## Task files

- `documentation/ANDROID_DEVICE_CORRECTIONS_VALIDATION.md`
- `src/app/app.html`
- `src/app/app.spec.ts`
- `src/app/app.ts`
- `src/app/core/data/bank-cash-tracking.integration.spec.ts`
- `src/app/core/services/card-nest-store.ts`
- `src/app/core/services/committed-save-refresh-error.ts`
- `src/app/features/bank-activity/bank-account-sync.service.ts`
- `src/app/features/bank-activity/bank-activity-latest.integration.spec.ts`
- `src/app/features/bank-activity/bank-activity.html`
- `src/app/features/bank-activity/bank-activity.service.ts`
- `src/app/features/settings/settings.spec.ts`
- `src/app/features/sources/sources.html`
- `src/app/features/sources/sources.scss`
- `src/app/features/sources/sources.spec.ts`
- `src/app/features/sources/sources.ts`
- `src/app/features/transactions/transactions.ts`
- `src/app/shared/indian-phone-input.spec.ts`
- `src/app/shared/indian-phone-input.ts`
- `src/app/shared/text-entry-focus.spec.ts`
- `src/app/shared/text-entry-focus.ts`
