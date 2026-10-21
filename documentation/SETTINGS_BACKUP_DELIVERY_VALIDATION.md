# Settings, empty budget and encrypted backup delivery

Validated 21 October 2026 on `feature/8-android-sms-transaction-sync`, continuing from `34bb3d5787ce9d8a0b26e5de7578439b7940eedd`. Existing history and financial data are preserved. No push, merge, release, version/signing/application-ID change or new dependency was made.

## Implementation

- Settings checkboxes retain native checkbox semantics and keyboard behavior, with Material-style 20px visuals inside 44px targets, theme colors, disabled states and a native forced-colors fallback. Set/Change PIN uses the compact bordered accent style of the SMS header action. Settings section links have readable spacing. Enlarged-text headings, the source picker and PIN/passphrase forms now fit their viewport; forms scroll when needed.
- The dashboard checks for a finite positive budget before calculating a percentage. An unconfigured budget displays **Not set**, an accessible equivalent label and a finite zero-progress ring. Configured percentages remain correct and the ring remains capped at 100%. The budget summary can stack at large text sizes. No budget, income or transaction values are fabricated or modified.
- Creating a backup encrypts it first and then opens a native HTML bottom-sheet dialog offering **Save locally** and **Share Backup**. No delivery runs before the user chooses. Repeated creation/delivery taps are guarded. Failures retain the encrypted in-memory file for retry. Cancel, route destruction and application locking discard the pending file; sensitive PIN/passphrase fields are cleared after creation, closure, locking and completed restore.
- Android **Save locally** retains the existing `ACTION_CREATE_DOCUMENT` bridge and document-provider behavior. Web local saving downloads the file without automatically invoking sharing. Explicit web sharing uses Web Share only where file sharing is supported; cancellation does not fall back to an unwanted download or report success.
- Android **Share Backup** adds a method to the existing generated `CardNestExport` plugin. It validates the encrypted envelope, writes only encrypted content to a unique `.cnbak` file in private `cache/exports/backups`, and opens `ACTION_SEND` through Android's chooser. The existing nonexported FileProvider supplies a `content://` URI with temporary read permission and ClipData. No broad storage permission, public Downloads copy, passphrase or write grant is introduced. Old files in this dedicated private cache are pruned on a later share once older than 24 hours; OS cache reclamation can also remove them.
- The chooser lists compatible installed apps, including cloud-storage apps where available. Launching it does **not** establish that a cloud upload completed, and the snackbar says to finish saving in the chosen app. Native chooser cancellation/upload completion is not reported by this launch-only API. A dismissed native chooser can be retried by creating another backup; web share cancellation retains the current destination choice.
- A shared typed native-export adapter avoids registering the same Capacitor plugin twice; existing PDF/CSV export logic is unchanged. Backup format versions 1/2, AES-GCM/PBKDF2 creation, decryption/restore logic, SQLite schema, SMS review filters and financial processing are unchanged. No raw SMS is newly exported.

The supplied `C:/AR_Files/code/localtell-data` reference was inspected read-only. It contains data-pack tooling rather than an app sharing implementation. CardNest's existing file-export/provider infrastructure was reused instead.

## Executed tests and commands

Node commands ran in WSL Ubuntu-22.04 with Node 24.16.0 from the repository. Logs are ignored under `tmp/backup-ui-*.log`.

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
node --test scripts/verify-backup-sharing.mjs
node tmp/backup-ui-scope-audit.mjs
node tmp/audit-sms-privacy.mjs
git diff --check
```

- **191 Angular tests passed across 23 files.** Added tests cover empty/configured/over-budget rendering; real encrypted v1/v2 round trips and incorrect passphrases; explicit native share dispatch; unchanged native document saving; local web download; unsupported/cancelled sharing; destination gating; PIN rejection; retry; duplicate taps; locking cleanup; and explicit restore confirmation with credential cleanup.
- Strict TypeScript and Angular lint passed. All 70 supplied synthetic SMS fixtures remain unchanged. Production web isolation passed over 26 JavaScript files. All seven Android integration checks and both new native-sharing contract checks passed.
- Tests initially exposed cross-realm `AbortError` handling, which was corrected without treating cancellation as success. Test setup now supplies Node's standard Blob/crypto APIs for real compression/encryption rather than relying on jsdom's incomplete Blob implementation. A typed injection token replaced a global plugin mock, and dashboard tests use real store transaction signals. All final tests pass; no expectations were weakened.
- The scope audit confirms byte-identical encryption/create and decryption/restore implementations, preserved existing PDF/CSV logic, unchanged SQLite/ledger/balances/SMS processing and unchanged versions/dependencies. Privacy checks found no copied personal SMS, full card/account identifiers or personal vehicle registrations.

## Browser results

Actual app components were rendered with ignored synthetic fixtures and a mocked delivery service; no real backup was uploaded, downloaded or shared during browser tests. **44 states** passed available AXE WCAG rules and geometry checks:

- 24 empty Home/Settings states: 320/360/390/412/430/768px in light/dark themes, with no NaN/Infinity, no clipped controls and checkbox target/visual sizes checked.
- 12 destination sheets: the same six widths in both themes, reached by filling the creation form and pressing Create backup. All sheets stay inside the viewport, anchor at the bottom and retain 44px controls.
- Six 200% text states: Settings, empty Home and creation-to-destination at 320px in both themes. The discovered intrinsic-width and fixed-form overflow issues were corrected and these states passed on rerun.
- Two configured Home states verify the synthetic budget correctly reports 2% used in both themes.

Evidence is under `tmp/final-refinement-preview/backup-{pages,sheets,large,configured}.json`; screenshots are prefixed `backup-` in that directory's `screenshots/`. The synthetic preview is excluded from production and Git.

## Android build

```powershell
$env:JAVA_HOME=(Resolve-Path tmp/sms-tools/jdk/jdk-21.0.12.1).Path
$env:GRADLE_USER_HOME=(Resolve-Path tmp/sms-tools/gradle-cache).Path
& ./tmp/brand-sms-debug-icons.ps1
& android/gradlew.bat -p android :app:testDebugUnitTest --rerun :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
& ./tmp/verify-refinement-artifacts.ps1
& tmp/sms-tools/android-sdk/platform-tools/adb.exe devices -l
```

**BUILD SUCCESSFUL**, including native Java/Kotlin compilation, debug APK, R8 release APK and AAB. All 123 JVM tests passed with zero failures/errors. Android lint reports **0 errors, 45 warnings**. Existing Cards stylesheet size and Gradle deprecation warnings remain. Packaged JavaScript sets and all 29 asset hashes match the final synced frontend in all three artifacts. Manifest, certificate, branding, plugin registration and test-corpus exclusion audits passed. The release R8 mapping explicitly retains `shareBackup(com.getcapacitor.PluginCall)` by name.

Updated debug APK: `android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk`, 31,096,940 bytes. SHA-256: `FCE3A32D2D65EF6DA06F5AEE24667D841E572BC40CDE3F3429B4B68C680CE63F`.

No device was connected. Remaining physical checks: native document-save success/cancellation; chooser app availability; cloud apps actually consuming the read-granted URI and completing an upload; restoring a shared encrypted file; app lock/unlock around external pickers; system insets/keyboard/TalkBack and actual Android font scaling. The browser preview and source-contract tests do not establish those device/provider outcomes. No release signing or distribution was performed.

## Android share-handoff follow-up

The Android share flow was reviewed again after a physical report of a blank white screen around the external backup handoff. No phone or usable ADB daemon was available in this environment, so the exact on-device root cause remains **unconfirmed**. The report must be reproduced with logcat before attributing it to Android, Google Drive, or the WebView.

Two static lifecycle defects were corrected without changing encryption or backup compatibility:

- The previous Angular flow removed the destination dialog as soon as `shareBackup()` returned. Android returns at chooser launch, before the selected recipient has finished or the user has returned. The dialog now stays available with a clear “Sharing opened” state until the user dismisses it, while the existing application lock still clears it on background locking.
- The generated plugin now creates the handoff file off the UI thread, writes and fsyncs a private `.partial` file, atomically renames it to a unique `cardnest-backup-YYYY-MM-DD-<suffix>.cnbak` filename, then launches the chooser on the UI thread. The FileProvider XML now maps only `cache/exports/backups/` for the backup handoff, rather than the broader exports cache root. The authority remains `${applicationId}.exports.fileprovider`, which resolves to `com.actionanand.cardnest.app.debug.exports.fileprovider` for debug and preserves the production application ID for release.

The native method accepts only CardNest format versions 1/2 with the existing PBKDF2-SHA256/AES-GCM envelope fields and structurally valid salt, IV and ciphertext. It writes only that encrypted envelope; it does not receive a passphrase, key, plaintext database, or raw SMS. The common binary MIME type remains `application/octet-stream` for broad chooser compatibility. Web local downloads and Web Share files now use that same MIME type, while restore continues to accept legacy JSON MIME selections for existing `.cnbak` files.

The share call still intentionally reports only that the Android chooser was opened. It never claims that Drive or any other recipient completed an upload. If preparing or launching fails, the in-memory encrypted backup remains available for retry or for the independent Save locally action.

Follow-up validation performed after regeneration:

```bash
node scripts/patch-android-export.mjs
node --test scripts/verify-backup-sharing.mjs
npm test -- --watch=false
npm run lint
npx tsc -p tsconfig.app.json --noEmit
npm run build:android
npx cap sync android
node scripts/patch-android.mjs
npm run test:android-isolation
android/gradlew.bat -p android :app:compileDebugJavaWithJavac :app:testDebugUnitTest --rerun-tasks --offline --no-daemon --console=plain
```

The focused native contract suite passed (2/2). The forced Java compilation and JVM test run completed successfully after stopping a stale Gradle daemon that had held a generated `R.jar` file open. The encrypted restore suite now also verifies damaged ciphertext is rejected before the database restore call. Physical checks still required: open the chooser, select Google Drive, verify the displayed `.cnbak` filename and granted `content://` URI, cancel and return to Settings, enable lock-on-background and repeat, save locally, and restore a synthetic shared file with both correct and incorrect passphrases.
