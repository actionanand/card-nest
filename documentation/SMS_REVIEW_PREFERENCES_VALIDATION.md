# SMS review preferences and snackbar follow-up

Continues from `888bc40396f958080501919c092d999f53babb5b` on `feature/8-android-sms-transaction-sync`. Validated 20 October 2026. Existing financial data, approval/reconciliation behavior, package IDs, signing, versions and demo-data rules are unchanged.

## Changes

- Snackbar success/info/warning styles use the existing theme's success/accent/warning and soft-surface tokens with ink text, replacing hardcoded dark colors and white text. Both themes retain readable contrast. Mobile left/right safe-area insets constrain its complete border box. The three-column layout wraps message text, puts optional actions on a second row, preserves a 44px dismiss target and clears bottom navigation/floating add controls. Large messages have a viewport-bounded scroll area instead of overflowing off-screen.
- Applied SMS review filters are persisted as one JSON preference in SQLite `app_preferences`, key `sms_review_filters`. Saved fields: search, source evidence, type, review status, from/through dates and read/unread choice. Opening the page or returning from background loads and applies the saved selection to both controls and results. Pagination starts at page one.
- Installations without that preference retain the existing Pending/Unread defaults and an empty search. Loading does not create a preference. Typing without applying does not save. Search/Apply, chip removal, clear and the inbox selector persist applied choices. Failed writes preserve the last saved selection and use the existing error snackbar.
- Enum, date and text fields from stored/restored JSON are validated, with defaults for absent/invalid values. SQL uses bound parameters. Text inputs accept at most 1000 characters. No candidate decisions, ledger rows, balances or native SMS flags are changed by preference saving.
- The existing portable/native backup infrastructure includes `app_preferences`; no new migration or backup format is needed. User-entered search text is intentionally included in the user's normal backup. Raw SMS payload exclusions remain unchanged. Delete all data removes the preference.

## Executed validation

The following Node commands used WSL Ubuntu-22.04, Node 24.16.0 and the repository directory. Logs are in ignored `tmp/filter-*.log`.

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

- **173 Angular tests passed across 20 files**, including six added cases for default/legacy behavior, applied SQLite filters and recreated-service query results, invalid preferences, failed writes, reactive UI restoration and backup/restore/deletion. The existing on-disk close/reopen test now also verifies search preference durability.
- Strict TypeScript and Angular lint passed. All 70 supplied synthetic fixtures remain unchanged. Web production isolation and all seven Android integration checks passed.
- **44 browser states** passed available AXE WCAG checks and geometry checks: three snackbar tones × light/dark × 320/360/390/412/430/768px (36), plus long text with an action at 320/390px in both themes at normal and 200% root font size (8). No snackbar horizontal overflow or clipped viewport bounds; 44px dismiss targets; bottom navigation clearance. This used actual app components with ignored synthetic preview data, not a personal inbox or database.
- Screenshots: `tmp/final-refinement-preview/screenshots/snackbar-themed-light-390.png` and `snackbar-themed-dark-390.png`. Structured measurements are in `snackbar-results.json` and `snackbar-large-results.json` in that preview directory.

Android commands executed in PowerShell:

```powershell
$env:JAVA_HOME=(Resolve-Path tmp/sms-tools/jdk/jdk-21.0.12.1).Path
$env:GRADLE_USER_HOME=(Resolve-Path tmp/sms-tools/gradle-cache).Path
& ./tmp/brand-sms-debug-icons.ps1
& android/gradlew.bat -p android :app:testDebugUnitTest --rerun :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
& ./tmp/verify-refinement-artifacts.ps1
& tmp/sms-tools/android-sdk/platform-tools/adb.exe devices -l
```

**BUILD SUCCESSFUL**: all 123 JVM tests passed; debug APK, R8 release APK and AAB compiled. Android lint reports zero errors and 46 warnings. The pre-existing Cards stylesheet warning (25.17 kB against a 23 kB warning threshold) and Gradle deprecation warnings remain. Complete packaged JavaScript sets and all 29 asset hashes match the synchronized frontend in all three outputs. Manifest, plugin, certificate, branding and absence of packaged test corpus checks passed. No release signing/distribution was performed.

Updated debug APK: `android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk`, 31,269,177 bytes, SHA-256 `D1255265C3FB5B4464399148F0577673C8647ED3211964E43EE37425E40CFA59`.

There are no unresolved automated failures. Privacy/scope checks confirm unchanged synthetic SMS bodies, unchanged approval/reconciliation/native processing, and no added private SMS, full card/account identifiers or personal vehicle registrations. `adb devices -l` found no connected device.

Physical-device checks remain necessary for native safe-area/IME behavior, actual Android font scaling/TalkBack, upgrade/restore through the Capacitor SDK, and force-stop/reopen. Browser and real SQLite tests cannot establish those phone-specific results.
