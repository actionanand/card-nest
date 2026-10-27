# Android device corrections: implementation and validation

Branch: `feature/11-split-payment-redesign`

Starting HEAD: `8bb9293d42ea8991b326aaaed088807d0956e37e`

Version metadata: `1.1.13` / `52`, unchanged. No push, merge, release asset, version bump or signing/workflow changes.

## Completed

- Stable Android-only FAB across theme changes and notifications; shared styling and accessible light/dark icon tokens, snackbar clearance and modal/security suppression.
- Centered safe-area-aware shared profile dialogs with VisualViewport keyboard constraints, internal scrolling, sticky header/actions, nested picker support and focus restoration.
- Existing shared confirmations for activity/recharge/cylinder deletion, exact selected IDs, busy guards and visible persistence errors.
- Fixed `+91-` plus ten national digits, including paste/replacement/autofill/composition and legacy-number normalization. Existing persistence format is unchanged.
- Three accessible Bank Activity tabs, explicit staged-evidence discovery, accurate pending evidence counts, monitored-account filtering and manual identity review.
- Latest debit/latest credit only, direction-specific date comparisons, explicit corrections, obsolete-candidate tombstones and replay suppression.
- OWN-only two-way Money Source identity reconciliation with stable IDs, bank aliases, final-three compatibility, no invented balances, conflict handling and preserved nicknames/archives.
- Compact movement timing radios; applicable new drafts default to AFTER_BASELINE, preserve saved answers and require explicit review when timing is uncertain.

## Database and existing data

Migration 14 atomically saves processed SMS fingerprints as resolved/dismissed tombstones before discarding redundant monitoring rows. It retains the newest valid date per profile and direction, with deterministic ID tie breaking. Malformed JSON and invalid/future dates cannot win. It runs on upgrades, during old portable-backup imports and on monitoring reload. It is idempotent and retains existing profile ownership, IDs and source links. Backup tables/format remain compatible.

Monitoring replacements and confirmations compare persisted rows within the database transaction. Same-date SMS never overwrites a confirmed record. Manual date correction requires the selected existing ID and keeps account/direction fixed. Removing a latest event leaves its direction Unknown, without restoring old history. Unambiguous pending alerts compact durably; ambiguity remains available for review. No raw SMS bodies enter monitoring storage.

The coordinator writes only bank identity preferences and monitoring profiles. Creating a financial identity and linking it commit together; existing source balance/baseline fields are preserved exactly. OTHERS, manual-only, incomplete, cash, meal and archived records are excluded from automatic enrollment. Conflicts direct the user to explicitly select the intended source through an OWN profile. OTHERS-to-OWN changes require explicit confirmation. Tracking off deletes nothing.

## Regression coverage

The full suite passes **670 tests in 55 files**, including **21 new tests** beyond the initial 649. New coverage includes FAB theme/snackbar/mode cycles; shared-modal viewport constraints; busy confirmation; tab semantics/keyboard selection; exact-ID deletion with cancellation/retries; phone input edge cases; compact/default/saved movement timing; and real SQLite migration, stale/equal/new dates, rollback, replay, sync conflicts and idempotency. Existing backup/restore and financial integration assertions were updated for latest-only monitoring without weakening financial table snapshots.

Financial isolation tests compare actual ledger, credit cards, source movements, adjustments, split groups, SMS financial evidence and statements. Existing transaction/balance rollback, Pluxee, split-payment and SMS decision tests remain in the complete suite. No real financial database was opened or modified for validation.

## Checks

| Check                                            | Result                                              |
| ------------------------------------------------ | --------------------------------------------------- |
| `npm test -- --watch=false`                      | PASS: 670 tests / 55 files                          |
| `npm run lint`                                   | PASS                                                |
| `npm run test:sms:fixtures`                      | PASS: 70 synthetic fixtures                         |
| `npm run build`                                  | PASS, budget warnings only                          |
| `npm run test:web-isolation`                     | PASS: no SMS route/plugin/permissions in web assets |
| `npm run build:android`                          | PASS, budget warnings only                          |
| Capacitor Android sync                           | PASS                                                |
| `npm run test:android-isolation`                 | PASS: 9 checks                                      |
| `:app:testDebugUnitTest --offline --rerun-tasks` | PASS: 160 tests, 0 failures/errors/skipped          |
| `git diff --check`                               | PASS                                                |

Windows npm was not on PATH; Angular checks used the existing WSL Node 24.16.0 runtime. WSL required sandbox approval. Native JUnit used the existing local JDK/SDK/cache and succeeded outside the sandbox after its daemon could not connect inside it. Actual assertion failures from changed historical semantics and a selection regression were investigated and fixed. No tests were disabled to obtain a pass.

Warnings are non-failing: initial bundle exceeds the 500 kB warning threshold (below 1 MB error threshold); existing cards.scss is 25.17 kB (23 kB warning / 26 kB error); jsdom lacks scrollTo; native dependencies report deprecated APIs and Gradle features. Full AXE colour/layout verification still needs a rendered browser/device; available jsdom semantic WCAG checks pass.

## Remaining real-device checks

No physical Android UI verification was performed. Verify light/dark cycles and mode persistence, snackbar/FAB clearance, 320/360/390/412px widths, gesture-navigation safe areas, large text, keyboard resizing, long-form action access, nested picker layering, TalkBack, focus restoration and Android Back cancellation. Exercise both timing choices against known confirmed balances on synthetic accounts.

The unrelated pre-existing `NUL` working-tree entry is preserved. Only the following task source/tests/documentation are included in the implementation commit; the final commit SHA is provided in the chat delivery.

## Files

- `documentation/utilities-bank-discovery.md`
- `src/app/app.scss`
- `src/app/app.spec.ts`
- `src/app/app.ts`
- `src/app/core/data/bank-activity-latest.ts`
- `src/app/core/data/bank-cash-tracking.integration.spec.ts`
- `src/app/core/data/migrations.ts`
- `src/app/core/data/sqlite-backup.integration.spec.ts`
- `src/app/core/data/sqlite-database.spec.ts`
- `src/app/core/data/sqlite-database.ts`
- `src/app/features/bank-activity/bank-account-sync.service.ts`
- `src/app/features/bank-activity/bank-activity-latest.integration.spec.ts`
- `src/app/features/bank-activity/bank-activity-ui.spec.ts`
- `src/app/features/bank-activity/bank-activity.html`
- `src/app/features/bank-activity/bank-activity.scss`
- `src/app/features/bank-activity/bank-activity.service.ts`
- `src/app/features/bank-activity/bank-activity.spec.ts`
- `src/app/features/bank-activity/bank-activity.ts`
- `src/app/features/utilities/utilities.html`
- `src/app/features/utilities/utilities.scss`
- `src/app/features/utilities/utilities.spec.ts`
- `src/app/features/utilities/utilities.ts`
- `src/app/shared/confirmation-dialog.spec.ts`
- `src/app/shared/confirmation-dialog.ts`
- `src/app/shared/indian-phone-input.spec.ts`
- `src/app/shared/indian-phone-input.ts`
- `src/app/shared/profile-modal.spec.ts`
- `src/app/shared/profile-modal.ts`
- `src/app/shared/source-movement-dialog.spec.ts`
- `src/app/shared/source-movement-dialog.ts`
- `src/styles.scss`
- `documentation/ANDROID_DEVICE_CORRECTIONS_VALIDATION.md`
