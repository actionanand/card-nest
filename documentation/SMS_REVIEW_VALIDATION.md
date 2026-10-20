# SMS review, matching and approval validation

20 October 2026. Branch `feature/8-android-sms-transaction-sync`; starting commit `4bd3970`.

## Confirmed defects and financial fixes

- `open()` always cleared the source, even for a unique reliable match. Matching also rejected missing issuer names and common aliases. Reliable suffix matching now preselects exactly one existing card, including AMEX last-four against saved last-five. Explicit issuer conflicts, deleted/invalid/currency-mismatched sources and ambiguous collisions cannot be silently selected. Archived cards are suggested only for an event dated before their recorded archival; other archived sources remain available for deliberate historical selection. Account suffixes/references are never substituted for card digits. A meal wallet requires actual suffix evidence; FASTag requires an exact vehicle match for a suggestion.
- New-entry SQL used the original SMS date while JSON/store used the edited date. SQL, JSON and Activity now agree on edited source, amount, category, merchant and date. Wallet repair updates its SQL date/category and JSON together. Existing-entry matching retains the existing record; repair is an explicit separate choice.
- Duplicate checks used only the original amount/date. Both original and edited evidence are now checked inside the serialized transaction. Manual duplicates require matching or deliberate separate-event confirmation. Referenced payment bindings remain protected. Nothing imports on scan or card preselection.
- A bridge/inbox refresh failure after a successful financial commit could be reported as an approval failure. Committed imports now update the store and show durable-success feedback; an inbox refresh warning does not invite a second entry. The current list/count is updated locally before retrying refresh. Native/SQLite replay remains idempotent.
- Category errors are explained before insertion; foreign keys, rollback, reconciliation and the shared write queue remain active. Edited wallet dates cannot bypass the historical balance snapshot: either the original event or an edited date before cutover requires explicit retain-balance approval.

The real SQLite integration test approves a synthetic purchase with INR 678.90, an edited event date of 2026-09-03, category `groceries`, an edited merchant and selected card. It compares SQL columns with JSON, calls the real `CardNestStore.acceptCommittedImport()`, observes the real Activity component's `visibleTransactions()` update without reload, and verifies the card outstanding. Further tests cover issuer-confirmed overpayment/statement settlement, a manually inserted historical duplicate, edited-value duplicate detection, match-existing without insertion, wallet repair/cutover and rollback of ledger/binding/UI on a failing SQLite trigger. Device SQLite execution remains a separate gate.

## UI and parser changes

The screen reuses CardNest's `.page`, `.panel`, `.btn`, theme variables, spacing and the existing export/transaction dialogs' centered desktop / bottom-sheet mobile styling. A native `<dialog>` adds top-layer isolation and modal semantics. Explicit keyboard wrapping, focus return, Escape/Close, root/body scroll locking and a cancelable Android Back event complete the interaction. Native Back consumes a review closure before dashboard/double-back navigation. Saving cannot be dismissed mid-write; locking/backgrounding removes sensitive review content.

Synchronization is compact; access and paste controls are disclosures. Counts, history, progress and last completed sync remain available. Review has search, collapsible type/state/source/date filters, removable chips, clear filters, bounded 200-row pagination, readable local dates, INR amounts, nickname/masked suffix suggestions and unmatched/ambiguous guidance. No-source guidance explains creation through CardNest and the SMS Test package's separate storage. Essential edit fields precede expandable extracted evidence and reconciliation controls. Errors appear inside the open sheet, and successful approval closes it with visible success feedback. Already-bound/evidence-only items expose no Add action.

Browser checks found and corrected the initial status dropdown showing All while the query used Pending, introductory light-text contrast, dark primary-button contrast, and focus escaping past the final control. CSS uses theme variables for both colors; no global theme change was needed.

Kotlin changes are deliberately narrow: discard URL/domain-only and numeric-reference merchant descriptions; remove reference/marketing/security trailers; retain the bounded extracted `merchantEvidence` for review. Older staged descriptions are sanitized for display, including leading long terminal IDs, with meaningful event fallbacks. Existing VPA merchants remain valid. Raw SMS is not added to either queue or backups. Classification, event dates, identity fingerprints, permission engine and scanning remain unchanged. All 70 supplied fixtures retain their existing financial/merchant oracles, including EXTRA-06 as generic bank-debit evidence requiring reconciliation. `codex-spec/` is untouched.

## Count interpretation

Native `scanned` and `found` accumulate provider rows and successfully parsed events across pages/scans; overlap/repeated content is not a unique-candidate count. The encrypted native queue and SQL candidate table deduplicate identities. SQL review state/date/text filters further narrow the visible result count. Rejected, deferred, ignored or imported decisions survive rediscovery. Invalid handoff evidence raises an error and preserves the native queue rather than silently dropping it.

The screen separately labels Messages scanned, Events detected, Candidates saved (all durable rows, including historical tombstones), Pending review, filtered results and handoff replays ignored in this JS session. Counts are not forced to agree. The supplied 185-detected / 181-review observation cannot be attributed to exactly four duplicates or decisions without the device's native queue and persisted state; no personal inbox was inspected. A real SQL test verifies saved/pending/filtered counts independently, including a rejected item and an event whose local date differs from its UTC date. Source searches cannot match unrelated reference digits.

## Executed validation

Local logs, preview fixtures, screenshots, SDK/cache and generated Android outputs remain ignored.

| Check              | Result                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Angular            | 112 passed across 14 files; 23 matching/title tests, 22 real-SQLite import/filter tests and 14 review UI tests included                                                                                                                                                              |
| Native JVM         | 123 passed: 70 corpus, 21 edge, 14 original parser, 5 paging, 12 permission-flow and 1 template test; no failures/errors                                                                                                                                                             |
| Types / lint       | Application and spec TypeScript checks passed; Angular lint passed                                                                                                                                                                                                                   |
| Web                | Production build and 27-JS-file SMS isolation passed; existing cards stylesheet 25.04 kB budget warning                                                                                                                                                                              |
| Capacitor          | Documented Android build/sync/patch pipeline passed; all 7 generated integration checks passed, including Back dispatch, plugin registration, permissions, protected receivers/job, source parity and patch idempotence                                                              |
| Android            | Debug APK, unsigned release APK/AAB, Kotlin/Java compilation, R8 and debug lint passed; 0 lint errors, 46 existing warnings; Gradle deprecation warnings remain                                                                                                                      |
| Packaged artifacts | Debug signature verified; expected debug ID/label/version and 9 permissions verified; release retains `com.actionanand.cardnest.app`; native entry points retained after R8; all 30 packaged JS assets equal synced inputs byte-for-byte; branded icon verified; tests/corpus absent |
| Browser            | Actual SMS component with synthetic providers at 360/390/430 px; no horizontal sheet overflow; focus entry/return, Tab/Shift+Tab, Escape and scroll lock verified; light/dark screen and sheet AXE WCAG audits have zero violations, including color contrast                        |
| Privacy            | All 70 supplied SMS bodies unchanged; only existing allowed fictional vehicle examples; no new full financial identifiers, inbox exports, private DBs, signing keys or build artifacts committed; manual review confirms added SMS examples are synthetic                            |
| Device             | Not run: `adb devices -l` lists no connected devices                                                                                                                                                                                                                                 |

The version-derived debug artifact is `android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk` (`com.actionanand.cardnest.app.debug`, label CardNest SMS Test, version 1.1.8-sms-test / 48). Unsigned release outputs are `android/app/build/outputs/apk/release/app-release-unsigned.apk` and `android/app/build/outputs/bundle/release/app-release.aab`. These are local validation outputs, not published releases. The test workflow/version/signing configuration remains unchanged.

| Artifact             |      Bytes | SHA-256                                                            |
| -------------------- | ---------: | ------------------------------------------------------------------ |
| Debug APK            | 31,095,214 | `EC5F825954CDE7F445F74DD71BC33EDEBFADF0D61B5CAB6CF79113A64744F600` |
| Unsigned release APK | 22,547,240 | `89B88717D8AA3719644A733B5697C95AE86F9BDBD515F0CA7DA1A79F1CF4D445` |
| Unsigned release AAB | 13,088,920 | `A85B81C0C6705459CFB73C0CE7B52488BB8BFA73E0F45601DE2C975012E877BD` |

Node/npm commands used the existing WSL runtime, from this repository:

```powershell
wsl -d Ubuntu-22.04 -- bash -lc 'set -e; export PATH=/home/actionanand/.nvm/versions/node/v24.16.0/bin:/usr/bin:/bin; cd /mnt/c/AR_Files/code/card-nest; <commands below>'
```

```sh
npm run lint
npx ngc --noEmit -p tsconfig.app.json
npx ngc -p tsconfig.spec.json --noEmit
npm test -- --watch=false
npm run test:sms:fixtures
npm run build -- --configuration production
npm run test:web-isolation
npm run android:sync
node scripts/configure-android-sms-test.mjs
npm run test:android-isolation
node tmp/audit-sms-privacy.mjs
# Ignored synthetic preview of the actual component, with mocked discovery/store only:
npx ng build --configuration development,android --browser tmp/sms-preview/main.ts --ts-config tmp/sms-preview/tsconfig.json --output-path tmp/sms-preview/dist
```

```powershell
node tmp/sms-preview/serve.cjs
& ./tmp/brand-sms-debug-icons.ps1
$env:JAVA_HOME=(Resolve-Path tmp/sms-tools/jdk/jdk-21.0.12.1).Path
$env:GRADLE_USER_HOME=(Resolve-Path tmp/sms-tools/gradle-cache).Path
& android/gradlew.bat -p android :app:testDebugUnitTest --offline --console=plain
& android/gradlew.bat -p android :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
& tmp/sms-tools/android-sdk/platform-tools/adb.exe devices -l
$version=Get-Content -Raw android-version.json | ConvertFrom-Json
$apkName='card-nest-'+$version.versionName.Replace('.','-')+'-debug.apk'
$apkPath=Join-Path 'android/app/build/outputs/apk/debug' $apkName
Copy-Item -LiteralPath android/app/build/outputs/apk/debug/app-debug.apk -Destination $apkPath
node scripts/verify-android-sms-permissions.mjs $apkPath tmp/sms-tools/android-sdk/build-tools/36.0.0/aapt.exe
& tmp/sms-tools/android-sdk/build-tools/36.0.0/apksigner.bat verify --verbose --print-certs $apkPath
& ./tmp/inspect-sms-permission-apk.ps1
& ./tmp/verify-sms-artifacts.ps1
& ./tmp/verify-sms-review-artifacts.ps1
& tmp/sms-tools/android-sdk/build-tools/36.0.0/aapt.exe dump badging android/app/build/outputs/apk/release/app-release-unsigned.apk
rg 'com.actionanand.cardnest.app.sms.CardNestSmsPlugin ->' android/app/build/outputs/mapping/release/mapping.txt
```

Artifact parity was additionally checked inline with PowerShell `System.IO.Compression.ZipFile`: SHA-256 of each of the 30 JS entries in each APK/AAB was compared to its synced `android/app/src/main/assets/public` input. Final test/sync/build logs are `tmp/sms-review-tests-final.log`, `tmp/sms-review-android-sync-final.log`, `tmp/sms-review-android-build-final.log`. Native XML reports are `android/app/build/test-results/testDebugUnitTest`; lint HTML/XML reports are `android/app/build/reports/lint-results-debug.*`.

The final packaging pass runs the same inspection through the ignored `tmp/verify-sms-review-artifacts.ps1`, which fails on any external verification error and records paths, sizes and hashes in `tmp/sms-review-artifacts-final.json`. The final normal web build was run after Android sync; no subsequent Capacitor sync copied the ordinary web assets into Android.

## Changed files and commits

- Matching and safe titles: `src/app/features/sms-sync/sms-model.ts`, new `sms-model.spec.ts`.
- Atomic approval, counts and filters: `sms-review.service.ts`, `sms-review.service.spec.ts` in the same directory.
- Mobile screen/sheet: `sms-sync.ts`, `sms-sync.html`, `sms-sync.scss`, `sms-sync.spec.ts` in the same directory.
- Merchant extraction/evidence and regressions: `native/android/sms-sync/SmsTransactionParser.kt`, `SmsQueue.kt`, `SmsEdgeCaseTest.kt`.
- Native Back generation and generated integration assertions: `scripts/patch-android.mjs`, `scripts/verify-android-sms-integration.mjs`.
- Documentation: this audit and `documentation/SMS_SYNC.md`.

Focused implementation commits are `232bbcf` (matching/persistence/parser), `1eea51b` (review UI/Back) and `ac1e5c3` (repair acknowledgement). Existing history is preserved. Final working-tree/HEAD checks use WSL Git because Windows Git misreads the repository's pre-existing reserved `NUL` filename; it was not staged or modified. Proposed eventual PR: **Improve Android SMS review, card matching and approved transaction persistence**, head `feature/8-android-sms-transaction-sync`, base `main`; no PR was opened or pushed.

Earlier development runs failed on a newly written merchant-regex slash escape, test-only Capacitor module mocking (hoist initialization / missing WebPlugin exports), and the dialog keyboard handler's focusability lint rule. These were corrected without relaxing assertions, expected financial results, lint rules or permission protections. The final SQL filtering test stubs only the empty native handoff and live permission read; all SQL filtering and financial writes use real SQLite. Keyboard handling is declared on the component host/document and checks Tab explicitly, including Shift+Tab.

The first preview server inside the sandbox could not accept browser connections; rerunning `node tmp/sms-preview/serve.cjs` with approved escalation resolved localhost access. Browser validation uses only synthetic fixtures and an isolated build of the actual component, with no real inbox/database or production route-guard bypass. AXE is included only in this ignored preview. Screenshots and viewport results are under `tmp/sms-preview/`.

## Remaining device gates and financial concerns

`adb devices -l` returned an empty list. No app was installed, no permissions were force-granted and no user data was cleared. The user reports that permission and scanning work on their phone; this session does not independently establish runtime behavior of the new APK.

On a physical test phone: verify sheet/keyboard/safe areas/TalkBack/light and dark theme, Android Back before navigation/exit, lock/resume, unique/ambiguous/missing sources (including debug-storage separation), manual duplicate matching, edited purchase and issuer payment in Activity after process restart, a migrated/backup-restored database through the actual Capacitor SQLite plugin, wallet cutover/repair and separate FASTag balances. Existing incoming/background, reboot/Doze/OEM, permission-revocation and process-death/queue replay gates remain relevant. Preserve backups and existing test data when installing updates; resolve signing-key mismatch without uninstalling/clearing storage.

Bank/aggregator/loan/statement evidence still cannot create money. Historical wallet snapshots require explicit retain/repair/adjust choices. Matching an existing entry intentionally retains its recorded financial details; edits apply when adding or explicitly repairing. Relations lacking reliable references and ambiguous card suffixes require human review. The exact four-event device count difference remains unconfirmed. No automatic financial approval, release-signing change, push, merge or publication is part of this task.
