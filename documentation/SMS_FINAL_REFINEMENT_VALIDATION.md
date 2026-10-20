# Final UI, first-run data and SMS attention-state validation

Validated locally on 20 October 2026 on `feature/8-android-sms-transaction-sync`, continuing from `b3db47550376846d02c6192d47efd8953f9395b2`. Existing history is preserved. No push, merge, release, signing change or package/version change was performed.

Changes are grouped into focused local commits for data initialization/read persistence, UI/pickers/feedback, and this documentation. The final commit identity and working-tree status are reported with the delivery message; this audit is included in the documentation commit itself.

## Implementation and data safety

- `environment.model.ts`, both environment files and `app-environment.ts` provide typed `seedDemoData`, default **false** for development, production and the Android production frontend used by debug builds. Initial store signals contain no sample cards, transactions, income or budget.
- `app-initialization.ts`, `sqlite-database.ts` and `card-nest-store.ts` seed only a genuinely empty first installation marked PENDING. Categories remain available; established default money sources remain zero/untracked. Explicit demo mode inserts coherent, labelled demo records atomically. DEMO/EMPTY/EXISTING/RESTORED/CLEARED markers prevent later reseeding. Existing schema, partial initialization, user data created after an interrupted seed, restored backups and deletion are protected. Configuration changes contain no data-deletion operation. Existing demos survive manual transaction creation. Legacy cache recovery cannot overwrite persisted/restored rows or replay wallet balances.
- Migration 8 adds indexed nullable `sms_candidates.read_at`, preserving identities, review states, ledger links and reconciliation. Existing IMPORTED/MATCHED_EXISTING/REJECTED/IGNORED decisions start read; PENDING/DEFERRED/ERROR remain unread. Old portable backups apply the same policy. New backups preserve read flags and continue omitting extracted candidate payloads.
- Read/Unread/All filters are independent of financial status. Individual read actions update only `read_at`. Confirmed bulk marking uses one serialized atomic UPDATE over **all** unread candidates, including records beyond page 200. Confirmation refreshes the database count; the snackbar reports actual affected rows. Repeated taps are guarded. Empty/failure paths are covered. New identities inserted after the operation remain unread, including older event dates; duplicate handoff uses INSERT OR IGNORE and preserves read flags. CardNest never changes the system SMS app's read state.
- Pending read suggestions remain eligible for explicit approval through Read/All. Read actions neither import nor reject transactions. Approval/reconciliation code from `async approve` onward is unchanged from the baseline; parser, native queue, fixture corpus, money, billing and EMI calculations are unchanged. Existing reconciliation constraints still apply: bank/aggregator messages are evidence, ownership requires user selection, and financial import requires explicit approval.

## UI changes

- Category summaries align compact gear Set/Edit limit and chevron actions with the title, retain expansion/amount/limit indicators, and wrap under large fonts without horizontal overflow.
- Budget period label sits above an aligned arrow/picker/arrow group. Normal 320px controls measured 44.8px high with the full period visible.
- Transactions shows a compact green SMS Review action on the right of its header. Deliberate-entry permission handling remains unchanged.
- SMS dropdowns use the existing themed picker with a ControlValueAccessor for reactive forms, search, disabled options and wrapped secondary text. Native top-layer dialogs support nested review overlays, bounded height, keyboard navigation, Back/Escape and restored focus. A shared reference-counted scroll lock handles nested dialogs safely.
- FASTag creation is a styled vehicle action with an aligned expandable form, validation, duplicate-submit protection, success/error snackbar, successful reset/collapse and restored focus. Existing wallet identities and balances are preserved.
- SMS review approval/matching/repair, rejection, deferral, ignore/reopen, evidence confirmation and read actions now provide snackbar feedback after their awaited result. Existing manual transaction add/update/delete feedback remains. After bulk marking, focus returns to the inbox heading if the trigger is disabled.

## Executed commands and results

Node commands used WSL Ubuntu-22.04, repository `/mnt/c/AR_Files/code/card-nest`, with Node 24.16.0 on PATH. Commands below were executed, not merely proposed. Logs and synthetic preview artifacts are ignored under `tmp/`.

```bash
npm test -- --watch=false
npm run lint
npx tsc -p tsconfig.app.json --noEmit
npm run test:sms:fixtures
npm run build
npm run test:web-isolation
npm run android:sync
node scripts/configure-android-sms-test.mjs
npm run test:android-isolation
node tmp/audit-sms-privacy.mjs
node tmp/refinement-scope-audit.mjs
git diff --check
```

`android:sync` executes `npm run build:android` (`ng build --configuration production,android`), `npx cap sync android` and the documented Android regeneration patches. Production and test Kotlin sources, manifest permissions, plugin registration before bridge initialization, protected receiver/job entry points, reflection keep rules and idempotent regeneration all passed integration checks.

PowerShell Android validation used the installed local Java 21 and offline Gradle cache:

```powershell
$env:JAVA_HOME=(Resolve-Path tmp/sms-tools/jdk/jdk-21.0.12.1).Path
$env:GRADLE_USER_HOME=(Resolve-Path tmp/sms-tools/gradle-cache).Path
& ./tmp/brand-sms-debug-icons.ps1
& android/gradlew.bat -p android :app:testDebugUnitTest --rerun :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
& ./tmp/verify-refinement-artifacts.ps1
& tmp/sms-tools/android-sdk/platform-tools/adb.exe devices -l
```

| Validation                            | Result                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Angular/Vitest                        | **167 passed, 20 files**, no failures                                                                                                                                                    |
| TypeScript and Angular lint           | Passed                                                                                                                                                                                   |
| Synthetic fixture provenance          | All **70** supplied bodies unchanged; passed                                                                                                                                             |
| Kotlin/JVM                            | **123 passed**: corpus 70, edge cases 21, page engine 5, permission flow 12, parser 14, Android scaffold 1; no failures/errors                                                           |
| SQLite integration                    | 18 tests within Angular total: first-run modes, existing/partial schema, interrupted seed, restart, legacy cache, migration, backup/restore, deletion and rollback                       |
| SMS service                           | 31 tests within Angular total; includes 451-row bulk update, rollback, concurrent inserts, replay, independent filters and later approval                                                |
| Web production/isolation              | Passed; **26** JavaScript files contain no SMS route/UI/plugin/permission leakage                                                                                                        |
| Android frontend/generation/isolation | Passed; **7** integration checks                                                                                                                                                         |
| Debug APK, release APK and AAB        | Gradle BUILD SUCCESSFUL; packaged asset hashes match all **29** synced JavaScript files in each artifact                                                                                 |
| Android lint                          | **0 errors, 46 warnings**; warnings remain a release-review item                                                                                                                         |
| Artifact audit                        | Correct existing isolated debug ID/label/version, debug certificate, nine justified permissions, protected entry points, DEX/plugin registration, branded icons, no packaged test corpus |
| Privacy/scope                         | No private screenshot text or SMS copied; no new full card/account numbers or personal plates; fictional test identifiers only. Heuristic scanning alone cannot establish provenance     |

Build warnings: existing `cards.scss` is 25.17 kB against a 23 kB warning threshold; build budgets were not changed. Gradle reports deprecated features for eventual Gradle 10 migration. No unresolved automated failure remains.

## Browser and accessibility verification

The actual Angular components were rendered with an ignored, synthetic preview adapter; browser checks do not substitute for native SQLite or physical Android tests. All rendered AXE WCAG checks reported zero violations:

- 84 route states: Home, Cards, Transactions, Category Spending, Money Sources, SMS and Settings at 320/360/390/412/430/768px in light and dark themes; no horizontal overflow.
- 32 popup states: review, bulk confirmation, history/type pickers, nested source picker, category limit, expanded FASTag form and transaction editor at 320/768px in both themes; contained overlays, correct stacking.
- Six 200% root-font states across SMS/category/sources at 320px; six empty first-install Home/Cards/category states in both themes.
- Interactive read/unread checks in both themes: actual-count snackbar, unread disappearance, unchanged pending count, history availability, later approval eligibility, mark unread, nested Escape/focus and safe bulk-confirmation focus.

That is **128 layout/accessibility states**, plus the two theme interaction sequences. Meaningful screenshots and JSON results are under `tmp/final-refinement-preview/` and are deliberately not committed as user data or build outputs.

## Final artifacts

Debug APK: `android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk` (31,096,725 bytes).

SHA-256: `551AC39831548401BF14AC8B14FD022CE733838398AD0E7C81EC40AE46959E70`.

Release compilation outputs: `android/app/build/outputs/apk/release/app-release-unsigned.apk` and `android/app/build/outputs/bundle/release/app-release.aab`. Release signing/distribution was not performed. R8 release compilation and mapping generation passed.

## Remaining physical-device checks

`adb devices -l` returned an empty device list. No phone was installed, reset, granted permissions or read during this work. Before release, verify on Android:

1. Upgrade an existing installation and import representative backups; confirm real native SQLite migration 8, legacy native import and unchanged finances. Automated tests exercise real SQLite behind a mocked Capacitor boundary, not the SDK on a phone.
2. Permission first request, denial/permanent denial/settings return and explicit opt-in; confirm ordinary launch never prompts.
3. Incoming SMS, historical rescan, interrupted background catch-up, force-stop/reopen, reboot and OEM Doze/battery restrictions; confirm persisted read flags and late evidence.
4. Native keyboard/IME, Android Back, actual safe-area insets, system font scaling and TalkBack on nested pickers/forms. Browser AXE/geometry checks do not establish every manual WCAG criterion.
5. Approve synthetic purchases and wallet events explicitly, reopen Activity, then edit/delete and verify on-device reconciliation/balances. Existing evidence-only and ownership safeguards must remain in effect.

The first-run flag affects only eligible initialization. It never removes existing or imported cards, transactions, balances or settings.
