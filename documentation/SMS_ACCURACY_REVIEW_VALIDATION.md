# Final SMS accuracy and mobile review validation

Baseline: `147525a61f6dcb73f63870acdb262ef871095738`, branch `feature/8-android-sms-transaction-sync`. Existing commits, corpus messages, signing/version/application IDs and working encrypted backup sharing are preserved. No user database or phone inbox was opened during development. All new messages are fictional equivalents; attached private screenshots are not repository assets.

## Financial classification and dates

The false statement purchase had two code causes: `sent` counted as debit evidence, while statement detection only recognized `statement ... generated`; the first date anywhere in the message could become the event date. Delivery/billing evidence now recognizes sent, generated, issued, available, ready and emailed variants. Actual refund, cashback and issuer receipt evidence retains precedence. Purchase words require genuine completed spending context rather than delivery wording. A statement word in a purchase merchant does not by itself classify the message as a statement.

Total, minimum, statement date, deadline and receipt metadata remain separate. A billing deadline cannot become a transaction event date. Without an explicit statement date, billing evidence uses a clearly identified received-date fallback. Date-only/receipt-fallback results carry `eventTimeExplicit=false`; only genuinely explicit transaction times enter newly approved ledger entries. Existing transaction values are not rewritten. Statement/reminder/bank/loan/initiation evidence cannot create spending, income, settlement or balance changes.

The corpus JSON is unchanged. Earlier Kotlin date oracles for billing notices described their deadlines as event dates. The corpus test now asserts these as `dueDate` and independently requires the receipt fallback (or a genuine explicit statement date). Relative deadlines are not fabricated. All supplied classifications, monetary amounts, source and reference checks remain enforced. The native suite initially caught a receipt precedence regression and an overbroad removal of the word “by” in refund descriptions; both were corrected before final validation.

## Previously staged errors and explicit correction

`Recheck original messages`, under Saved message checks & storage, reparses up to 50 pending items per explicit invocation. It uses the saved provider row ID **and exact received timestamp**, checks permission, performs parameterized provider reads and never changes the scan cursor or original SMS. `SmsRecheckEngine` is independently tested for missing rows, reused provider IDs, duplicate requests, invalid identities, unsupported messages and batch bounds. No raw body is persisted or logged.

Reclassification preserves the candidate ID, read state and deduplication identity. A legacy hash alias handles the switch from a mistakenly explicit due-date fingerprint to a receipt fallback. Only PENDING evidence may be refreshed. Explicit imported/matched/rejected/deferred decisions are not silently undone. A suspect old purchase with a deadline as its event date and no merchant is blocked from Add while its original remains unverified. An unavailable original remains suspect; it is not declared corrected.

**The user's actual staged candidate has not been modified on their phone.** Install the new APK and use the explicit bounded recheck to recover its original if SMS permission and that provider row are still available. Restored payload-free tombstones cannot be safely reconstructed without the old receipt identity. Already imported suspect evidence warns the user and offers View transaction into the existing Activity editor for explicit correction; no automatic deletion, reversal or balance mutation occurs.

## Approval, read state and matching

Approval already had atomic ledger/state/binding writes and repeat-tap idempotence. Three UI/state issues were addressed: approval did not mark the candidate read; asynchronous list refreshes could finish out of order; raw reconciliation decision `PENDING` could be displayed for an actually IMPORTED record. Review state and balance reconciliation choice now have distinct wording. Revision guards discard old snapshots after approval/read changes or lock/background transitions. Success is announced only after the durable financial write; a later refresh failure does not retry that write.

Final review also found that a missing candidate and an already-resolved candidate shared the same no-op success path. A missing candidate now throws a clear unavailable error before any write. An already-resolved candidate explicitly reports that no additional transaction was added. A separate real-SQLite regression verifies the missing-row case.

Real SQLite regression tests approve, recreate the service, reopen active/history views and retry approval: exactly one ledger row and binding remain, the candidate is IMPORTED/read, and it is absent from Needs review. A delayed old pending-page result cannot overwrite the post-approval list. Existing rollback and concurrent approval tests remain.

Comma removal and BigDecimal conversion were already correct. Added tests cover currency prefixes and comma/no-comma spellings without floating point. Product descriptions lacking independent merchant/reference evidence remain possible matches, not automatic matches.

The existing pure matching engine now also returns at most 20 ranked, exact-amount/currency/type/explicit-local-date possibilities when a credit-card suffix is absent. Institution evidence constrains candidates when present; account suffixes and conflicting card suffixes cannot supply identity. Each suggestion displays its source. Choosing Match this transaction populates source and existing record; the normal approval confirmation still performs the atomic link. Missing identity never permits an automatic link. Multiple identical entries remain choices. Trusted-source automatic links retain existing strict evidence and claim safeguards, with zero financial writes.

Mark read persists its timestamp, immediately removes a row from the Unread view and offers Undo. Pending read items retain actionable evidence. Mark all uses one atomic update across saved records, not just the loaded page. All-history views may retain read rows. Read changes never alter financial review state or balances.

## Compact review and Settings UX

- Three equal-width inbox segments expose selected `aria-pressed` state. Hide already added defaults on, is saved in `sms_review_filters`, excludes imported/matched records in active/all-history results, and never makes the dedicated Already added view inaccessible. Choosing All history deliberately includes history; the toggle explains its scope.
- Type chips contain names only. Noninteractive OR separators appear only between adjacent type chips; status/read/date/source chips form a separate AND group. Existing parameterized IN/AND SQL and counts/pagination are preserved.
- Multiple selection uses a modal bottom sheet with title, search, selected count, Select all/Clear, scrollable checkbox list and separate Done footer. It locks background scrolling, traps focus, restores the trigger and supports outside dismissal, Escape and Android Back. Safe-area padding and dynamic viewport height keep Done visible. The initial five selections and saved custom choices are unchanged.
- Matched/imported rows have a neutral Review details and primary View transaction action row; pending financial events use Review & add. Reviewed/evidence-only items have no active financial Add action. Missing history amounts display an em dash rather than invented zero.
- Settings navigation is one scrollable compact row on phones, with a selected highlight and existing explicit section focus/scroll behavior. It does not change route/history or navigate Home.

## Optional preferences, swipe and recorded time

Both new settings default OFF and use the serialized SQLite `app_preferences` store (`sms_swipe_actions_enabled`, `show_transaction_time`). Only the exact persisted enabled value is accepted; missing/invalid values default OFF. There is no localStorage counterpart. App initialization (including the existing reload after restore) refreshes signals from SQLite. Real encrypted portable backup tests verify enabled preferences, restart/reload, restoration, invalid values and old backups without either key.

`SmsSwipe` is a separate directive, enabled only for Android when opted in. It ignores edge-start gestures and interactive controls, requires at least 64 horizontal pixels and a 1.8 horizontal/vertical ratio, cancels vertical/interrupted gestures, and retains `pan-y`. Right opens the ordinary review/details dialog; it never approves money. Left marks an unread item read with the same Undo. Visible buttons and keyboard navigation remain available. Automated pointer-path tests cover disabled, both directions, diagonal/vertical, short, edge, cancellation, duplicate-up and wrong-pointer cases. Physical touch/Android Back testing is still required.

Activity displays only `CardTransaction.transactionTime` when enabled. Valid recorded wall-clock times use the locale's 12/24-hour convention without shifting the stored wall-clock value to another timezone. No createdAt or SMS receipt fallback is used. Missing/invalid times stay hidden; genuine midnight is allowed. Time uses a compact secondary line while recurring/EMI badges, amount and source remain intact. No dates or financial values change.

## Memory and storage policy

Angular retains one 200-row candidate page and at most 50 related candidates. Page changes replace references; closing a modal clears selected/related/form references; leaving the route clears the service's page. Discovery handoff processes at most five 200-item batches per refresh and acknowledges only after durable SQLite staging. The separate automatic matcher retains its bounded 200/5,000-row limits. No full historical message list or raw bodies enter an app-wide store.

An explicit cleanup clears at most 200 optional payloads for REJECTED/IGNORED items dismissed more than 90 days ago. IDs, states, read timestamps, kind/event date, decisions and links remain. Pending (including read), deferred, imported and matched evidence is retained. Replay cannot revive a pruned terminal tombstone. Existing backups continue excluding every SMS evidence payload while preserving identities, links and preferences. These are measured/tested batch bounds, not a claimed heap benchmark; no device heap profiling was performed.

## Validation commands and evidence

WSL Ubuntu-22.04, Node 24.16.0, workspace `/mnt/c/AR_Files/code/card-nest`:

```bash
git status -sb
npx tsc -p tsconfig.app.json --noEmit
npm test -- --watch=false
npm run lint
npm run test:sms:fixtures
npm run build
npm run test:web-isolation
npm run android:sync
npm run test:android-isolation
node --test scripts/verify-backup-sharing.mjs
node tmp/audit-sms-privacy.mjs
git diff --check
```

`android:sync` executes `npm run build:android` (`ng build --configuration production,android`), `npx cap sync android` and the documented generation patch. Native commands use the installed local toolchain:

```powershell
$env:JAVA_HOME=(Resolve-Path 'tmp/sms-tools/jdk/jdk-21.0.12.1').Path
$env:GRADLE_USER_HOME=(Resolve-Path 'tmp/sms-tools/gradle-cache').Path
& android/gradlew.bat -p android :app:testDebugUnitTest --rerun --offline --console=plain
& android/gradlew.bat -p android :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
& android/gradlew.bat -p android :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
& ./tmp/verify-refinement-artifacts.ps1
& tmp/sms-tools/android-sdk/platform-tools/adb.exe devices -l
```

Logs are under ignored `tmp/final-accuracy-*.log`. Visual validation uses only `tmp/final-refinement-preview` synthetic data, actual components and AXE. A preview is not proof of device SMS/gesture behavior.

Final Angular run: **255 tests passed across 26 files**. The real encrypted-backup test initially required Node's streaming Blob and a harmless native-export mock in the jsdom environment; those test adapters were corrected without changing backup delivery code. Earlier AXE findings required a role for the type-chip group; lint required a focusable dialog declaration. Both were corrected and rechecked. No remaining test failure is accepted as a successful validation.

The Kotlin/JVM XML reports **132 tests, zero failures/errors/skips**, including all 70 supplied corpus cases, 36 statement-delivery/minimum/deadline combinations within the added parameter loop, amount/time cases and five provider-recovery tests. Final TypeScript, Angular lint, 70-fixture provenance, web build/isolation (26 JavaScript files), seven Android integration checks and two backup-sharing contracts passed. The normal web build retains the existing Cards stylesheet budget warning (25.17 kB against 23 kB). Android lint reports zero errors and 45 warnings; Gradle reports existing deprecations.

Final Android packaging passed in 24 seconds after refreshing the final approval guard assets. Debug APK, unsigned release APK and release AAB compiled successfully. The artifact audit verified identity/version/signature, compiled permissions/protected entry points, R8 plugin retention, absence of test corpus/classes and byte parity for all 29 frontend JavaScript assets in all three packages. No release signing/distribution claim is made.

| Artifact              | Location relative to repository                                  |      Bytes | SHA-256                                                            |
| --------------------- | ---------------------------------------------------------------- | ---------: | ------------------------------------------------------------------ |
| Installable debug APK | `android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk`  | 31,097,074 | `D97F8C87F0B86FCE1A0F4215590503201BECC09906B5DC5A33CC6B6A67862820` |
| Unsigned release APK  | `android/app/build/outputs/apk/release/app-release-unsigned.apk` | 22,584,207 | `B99D569366C7A39C67313FD017AF543F76EB897A375F8E73A389BF4F537BBA9C` |
| Release AAB           | `android/app/build/outputs/bundle/release/app-release.aab`       | 13,116,228 | `9E51D6D71523A6772151F27416C9B72D5EEE84B582D21C8AA1083C575BB48E26` |

Browser checks: sheet bounds and no horizontal overflow at 320/360/390/430 px in LIGHT/DARK; Done has a 44px target and stays within a 430px-high viewport. Search narrows to Pluxee choices; Done restores its trigger. AXE reports zero violations in tested light/dark sheet, dark Settings and dark Activity states and at 320px/200% text. Settings tabs stay within a horizontally scrollable container; Backup & data focus remains on `/settings` at approximately 72px below the header. Activity previews retain recurring/EMI badges and three genuine time labels while a fourth date-only row has none; disabling the setting hides every time label. Evidence is under `tmp/final-refinement-preview/accuracy-viewport-audit.json` and its `screenshots/accuracy-*.png` files. No device was attached (`adb devices -l` was empty).

## Changed tracked files

- Native (7): `CardNestSmsPlugin.kt`, `SmsTransactionParser.kt`, `SmsQueue.kt`, `SmsCorpusTest.kt`, `SmsEdgeCaseTest.kt`, new `SmsRecheckEngine.kt` and `SmsRecheckEngineTest.kt` under `native/android/sms-sync/`.
- Core (4): `src/app/core/services/card-nest-store.ts`, new `transaction-time.ts` and `transaction-time.spec.ts`, and `src/app/core/data/sqlite-backup.integration.spec.ts`.
- SMS (12): `sms-model.ts`, `sms-matching.ts`, `sms-review-filters.ts`, `sms-review.service.ts` and its spec, `sms-sync.ts/html/scss/spec.ts`, `sms-type-picker.ts`, new `sms-swipe.ts` and `sms-swipe.spec.ts` under `src/app/features/sms-sync/`.
- Settings (3): `src/app/features/settings/settings.ts/html/scss`.
- Activity (3): `src/app/features/transactions/transactions.ts/html/scss`.
- This validation audit (1). No migration, corpus JSON, backup-sharing implementation, dependency, signing or application-version file changed.

## Remaining physical-device checks

Reparse the actual suspect statement with permission; verify missing/reused provider outcomes and old processed states. Approve/reopen/restart/rescan a synthetic event and confirm one ledger insertion. Exercise touch swipes, scroll/diagonal/edge Back and cancellation; verify system keyboard, safe areas, TalkBack and font scaling. Confirm type-sheet outside/Back dismissal, saved filters/settings after force-stop, encrypted restore on another install, and recurring/EMI Activity time layouts. No physical device result is claimed without an attached device.
