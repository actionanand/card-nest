# SMS review mobile sheet and control refinement

Validated 20 October 2026 on `feature/8-android-sms-transaction-sync`, continuing from `1ae44849cef8edb1999736d9ffdd6d23bc124cd3`. Changes are limited to SMS review markup, scoped styles, UI regression tests and this audit. Financial processing, SQLite preferences/backups, native discovery, application IDs, signing and versions are unchanged.

## Fixes

- The mark-all confirmation is an explicit fixed bottom sheet. Its more specific rule prevents the shared `.panel` vertical margins from overriding dialog positioning. Maximum height accounts for the top safe area; content padding accounts for bottom/side safe areas. The native dialog retains its backdrop, focus handling, cancellation and Android Back behavior.
- Mark all as read is a bordered themed button on the right of the SMS Review heading. The unread count is secondary text beneath the title. Zero unread items, loading and an active bulk operation disable the native button and give it neutral gray theme colors. It never acts as a badge. Enlarged text can wrap the header safely.
- Missing-source, evidence-only, reviewed-history and retained-history messages use structured notices with existing icons, short headings and theme surfaces. Missing-source guidance remains actionable. No financial import/evidence restrictions were relaxed.
- Filter buttons retain 44px touch targets around compact 28px visual pills. Tighter padding, smaller icon-pack close icons and restrained rounded corners replace the oversized appearance. Filter removal and saved filter preferences retain their existing behavior.
- SMS disclosure headings now use the existing chevron icon and consistent spacing, while retaining native details/summary keyboard semantics. The visual audit also found and fixed intrinsic date-input and heading sizing at 200% text size in a 320px review sheet.

## Executed automated validation

Node commands ran through WSL Ubuntu-22.04 with Node 24.16.0 in the repository. Logs are ignored under `tmp/mobile-polish-*.log`.

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
node tmp/refinement-scope-audit.mjs
node tmp/audit-sms-privacy.mjs
git diff --check
```

- **176 Angular tests passed in 20 files**, including header placement/disabled interaction, icon-pack chip removal and structured notices retaining explicit approval requirements. SQLite persistence, backup/restore and existing financial tests also passed.
- Angular lint and strict TypeScript passed. All 70 supplied synthetic fixtures are unchanged. Web production isolation passed over 26 JavaScript files; all seven Android integration checks passed after final sync.
- One initial new UI test checked the enabled state before asynchronous filter loading finished. It now explicitly waits for loading to finish before verifying both enabled and disabled states; the assertions were retained.
- One Android frontend build failed downloading the existing Google Fonts stylesheet during font inlining. The same documented sync command succeeded on retry, and the final sync after the large-text fix also succeeded. No build checks or font optimization were disabled.

## Browser audit

Actual Angular components were rendered with ignored synthetic fixtures, without accessing a personal database or inbox. **120 layout/accessibility states** passed available AXE WCAG checks and geometry checks:

- 84 major-page states: Home, Cards, Transactions, Category Spending, Money Sources, SMS and Settings at 320/360/390/412/430/768px in light/dark themes. No horizontal page overflow or additional issues requiring unrelated screen changes.
- 18 normal-text sheet states: confirmation, evidence-only and missing-source at 320/390/768px in both themes. Confirmation bottom equals viewport bottom; all sheets stay within the viewport and their content does not overflow horizontally.
- 12 inbox states: empty and nonempty at 320/390/768px in both themes. Native disabled state and neutral colors verified; the enabled button remains right of the heading at normal phone widths. Visual chip height is 28px and its interactive target is 44px.
- Six 200% text states: the three sheet types at 320px in both themes. The initial date-field overflow was corrected and all six passed on rerun.

Two additional interaction sequences verified Escape closes the confirmation and returns focus to its trigger. Confirmed marking updates the unread count to zero, disables/grays the button, reports the actual count through the snackbar and returns focus to the inbox heading. These use synthetic review flags and do not approve financial entries.

Measurements: `tmp/final-refinement-preview/polish-{routes,popups,inbox,large,interactions}.json`. Screenshots are in that directory's `screenshots/`, prefixed `polish-`, with confirmation, notices, enabled and disabled states in both themes. The preview is deliberately excluded from production and Git.

## Android artifacts

Executed in PowerShell using the cached local SDK/Java toolchain:

```powershell
$env:JAVA_HOME=(Resolve-Path tmp/sms-tools/jdk/jdk-21.0.12.1).Path
$env:GRADLE_USER_HOME=(Resolve-Path tmp/sms-tools/gradle-cache).Path
& ./tmp/brand-sms-debug-icons.ps1
& android/gradlew.bat -p android :app:testDebugUnitTest --rerun :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
& ./tmp/verify-refinement-artifacts.ps1
& tmp/sms-tools/android-sdk/platform-tools/adb.exe devices -l
```

**BUILD SUCCESSFUL**. All 123 JVM tests passed without failures/errors. Debug APK, R8 release APK and AAB compiled. Packaged assets match the complete synchronized set and all 29 JavaScript hashes in each output; identity, permissions, registration, branding and test-corpus exclusion passed. Android lint reports zero errors and 46 warnings. Existing Cards stylesheet budget and Gradle deprecation warnings remain; no budgets or checks were weakened.

Debug APK: `android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk`, 31,096,898 bytes. SHA-256: `E37DCC0F643EEC658097169479C6135F460EC23D1AC18576D70B414F517911DD`.

No device was connected. Physical Android status/navigation bar insets, actual system font scaling, TalkBack, keyboard/Back and upgrade/restore checks remain necessary. No release signing, push, merge or deployment was performed. Financial data and persisted review filters remain unchanged by this refinement.
