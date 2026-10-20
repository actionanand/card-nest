# Android SMS permission diagnosis

20 October 2026. Branch: `feature/8-android-sms-transaction-sync`. Starting commit: `2de6ea6`.

## Confirmed bugs and unverified causes

The supplied screenshot is CardNest's SMS screen. The other permissions screenshot described in the request belongs to Google Play Store and is not evidence about CardNest.

Confirmed source bugs:

- Enable saved `requested=true`, a new cursor, and `more=true` before Android responded. A failed or denied request could reset progress and display pending work that was never authorized.
- Status inferred denial from that attempted-request boolean. It could not establish whether Android actually displayed a dialog or returned denial.
- The screen displayed pending work from `more` alone, and did not explain a no-dialog/blocked response or provide app-settings navigation.
- Scan startup lacked an early permission guard. After adding one, the job must call startup inside its exception handler to avoid an uncaught revocation race.

The previous APK inspected locally had production package `com.actionanand.cardnest.app`; it is not proof of what is installed on the user's phone. The new output is built with the test workflow's `.debug` identity and inspected independently below. Source inspection found the correct two-permission alias, supported Capacitor 8 request API, annotated private callback, and registration before bridge initialization. Capacitor 8 discovers declared private callback methods and makes them accessible; privacy of that method is not itself a bug.

**The reason the system popup did not appear on the user's phone is not confirmed.** No physical Android device was connected to this session. Request/callback logs and installed-package permission flags are needed to distinguish a denied/fixed grant, device policy, installer restriction, missing installed declaration, or a bridge failure. A successful build or mocked grant does not establish that a real popup appears.

Both [READ_SMS and RECEIVE_SMS are hard-restricted permissions](https://developer.android.com/reference/android/Manifest.permission). Android requires installer eligibility as well as a runtime grant. Repeated denial can also [stop further permission dialogs](https://developer.android.com/training/permissions/requesting). Code does not override installer allowlists, Play Protect, device policy, or OS permission controls. A false rationale result alone does not distinguish first request from blocked access. The new “unavailable” message describes possibilities; it does not claim a particular flag was observed. Public app APIs do not expose all PackageManager fixed/restriction flags; inspect them through ADB on the actual phone.

## Revised native and Angular flow

`SmsPermissionFlow` is a small testable coordinator used by `CardNestSmsPlugin`, with mocked OS observations in JVM tests. Both grants are checked independently using Android's actual grant checks. Manifest declarations, rationale availability, supported telephony, and the public policy-revocation check inform diagnostics. A denied **completed callback**, rather than an attempted-request boolean, supplies outcome history. Legacy `requested` flags are ignored.

Only a user action calls `requestPermissionForAlias("sms", call, "permissionsReady")`. The request runs on the activity thread. Repeated requests are guarded in both native and Angular code. The callback checks both grants afresh. Only confirmed access enables discovery and initializes first-time scan settings. Re-enabling preserves existing cursors and staged candidates. Neither denial nor settings navigation opens the financial database or clears queues/tombstones. Existing records from the old premature-initialization bug are retained; they are not represented as authorized pending work.

The status method returns current individual grants, a descriptive state, settings guidance, and an effective enabled/pending state. Revocation suspends discovery and cancels its job without deleting progress. Resume and screen focus/unlock refresh current OS access. A grant from Settings does not override a disabled opt-in: the user still chooses Enable. Page consumption stops when permission disappears, and startup rejects denied access before modifying a cursor.

Missing/failed request completion is bounded by a two-minute native timeout; failure rejects the promise and clears only the in-flight request. Late callbacks cannot activate an expired request. Debug-only `CardNestSmsPermission` messages contain event names, state names, and two grant booleans. They contain no SMS bodies, senders, card details, records or identifiers.

The UI distinguishes not requested, requesting, granted/enabled, granted/temporarily disabled, denied, unavailable/restricted and revoked. Scan requires effective granted/enabled access. Pending messaging additionally requires a valid native pending-work flag. Request failures become actionable alerts. Open app settings uses `ACTION_APPLICATION_DETAILS_SETTINGS` for the current package and never changes settings itself. Notification requests remain separate.

## Final merged APK permission audit

Build/manifest validation results are filled from actual commands before completion. The audit checks the compiled APK, not only the main source manifest. `scripts/verify-android-sms-permissions.mjs` fails on any additional or missing permission and checks package/name/version and protected native entry points. No speculative `tools:node="remove"` rules were added: the unexpected dangerous permissions in the request were absent.

| Declared permission                                                           | Protection/runtime behavior          | Origin and justification                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `android.permission.READ_SMS`                                                 | Dangerous/runtime; hard restricted   | `patch-android-sms.mjs`: opt-in historical inbox discovery.                                             |
| `android.permission.RECEIVE_SMS`                                              | Dangerous/runtime; hard restricted   | `patch-android-sms.mjs`: incoming discovery without an active WebView.                                  |
| `android.permission.POST_NOTIFICATIONS`                                       | Dangerous/runtime on API 33+         | `@capacitor/local-notifications`: existing reminders; requested separately.                             |
| `android.permission.RECEIVE_BOOT_COMPLETED`                                   | Normal                               | SMS patch and local-notifications manifests: persisted discovery/reminder recovery.                     |
| `android.permission.WAKE_LOCK`                                                | Normal                               | Local-notifications manifest: existing reminder delivery.                                               |
| `android.permission.INTERNET`                                                 | Normal                               | Capacitor's generated app manifest: existing WebView/network functionality.                             |
| `android.permission.USE_BIOMETRIC`                                            | Normal                               | Native shell and AndroidX biometric: existing biometric unlock.                                         |
| `android.permission.USE_FINGERPRINT`                                          | Normal; deprecated compatibility API | Native shell and AndroidX biometric: fingerprint unlock on older supported devices.                     |
| `com.actionanand.cardnest.app.debug.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | App-specific signature               | AndroidX Core's merged manifest: protects internal dynamically registered receivers; not a user prompt. |

No contacts, location, microphone, phone state/call, Bluetooth, SEND_SMS/WRITE_SMS/call-log or broad storage permissions appear. The camera plugin delegates capture/picking to system activities and declares intent queries, not a CAMERA permission; that functionality and plugin are retained. Document imports use the existing system picker, and SQLite uses private storage.

## Build and automated validation

| Check                         | Executed result                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Angular                       | PASS: 76 tests in 13 files, zero failures/skips. Includes 9 bridge/permission-service tests and 8 UI tests (including existing light/dark AXE). Rendered contrast and actual Android UI remain physical gates.                                       |
| Native unit tests             | PASS: 120 tests, zero failures/errors/skips: 119 SMS tests (all 70 corpus cases, original/edge/paging cases, 12 permission-flow tests) plus one generated sample.                                                                                    |
| Angular lint/type compilation | PASS: `npm run lint`; `ngc -p tsconfig.spec.json --noEmit`.                                                                                                                                                                                          |
| Fixture validation            | PASS: all 70 synthetic fixtures and reviewed provenance checksum. No corpus/spec cleanup or edits.                                                                                                                                                   |
| Web production/isolation      | PASS: 27 emitted JS files contain no SMS route/UI/plugin/permissions. Existing cards stylesheet budget warning (25.04 kB vs 23 kB warning budget) remains below the 26 kB error threshold.                                                           |
| Android frontend/sync         | PASS: `npm run android:sync` executes `build:android`, Capacitor sync and reproducible native patches; the final APK contains the revised permission UI.                                                                                             |
| Android isolation             | PASS: 7 generated integration/manifest/source/registration/theme/R8 checks.                                                                                                                                                                          |
| Kotlin/Java/debug assembly    | PASS: final `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug --offline --console=plain`, completed in 55 seconds.                                                                                                                           |
| Android lint                  | PASS: zero errors, 46 warnings. Remaining warnings include style/dependency suggestions, explicit durable preferences, existing export locale/manifest ordering, and branded legacy icon duplicates/shape/resources. No lint errors were suppressed. |
| Compiled APK audit            | PASS: exactly the 9 justified permissions in the table above; package `com.actionanand.cardnest.app.debug`; application **and launcher activity** label `CardNest SMS Test`; version `1.1.8-sms-test`, code 48. Native SMS/job protections verified. |
| Signature/branding            | PASS: APK Signature Scheme v2 verified; certificate `CN=Android Debug`, no production key used. Packaged launcher PNG matches the generated CardNest icon. No synthetic corpus is packaged.                                                          |
| Scope                         | PASS: financial staging/approval/reconciliation methods remain byte-identical after line-ending normalization; parser, native encrypted queue, wallet store, schema/backups, corpus and production workflow unchanged.                               |
| Actual device                 | NOT RUN: elevated `adb devices -l` returned an empty device list. No OS prompt, installed-phone permission flags or real callback could be observed.                                                                                                 |

No project test or build gate failed in this task. Windows sandbox ADB could not start its local daemon; the approved rerun succeeded and found no device. Direct exploratory imports of optional YAML modules (`yaml`, `js-yaml`) were unavailable; Prettier successfully parsed/formatted the workflow without installing dependencies. Local branded icon generation used Windows System.Drawing because ImageMagick was unavailable; CI retains its existing ImageMagick step. The remote GitHub Actions job has not been executed or pushed by this task.

Output: `android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk` (30,938,112 bytes).
SHA-256: `9CC446EC3C13B77740A440D3F6C004364C3D42BA363E91BC04AC2D0638104FC6`.
The unversioned `app-debug.apk` is also retained. Release APK/AAB compilation was not repeated in this permission-diagnosis task; no release readiness claim is made.

The feature-only test workflow retains its feature-branch trigger, read-only GitHub permissions, version-derived filename, `.debug` package, `CardNest SMS Test` label, branded launcher generation, debug-only signing and Actions artifact upload. The production workflow is unchanged. Identity configuration is shared through `configure-android-sms-test.mjs`. Added gates check native lint and the final APK permissions. No GitHub Release publication step was added.

Commands executed from the repository root (Node/npm uses the existing WSL Node 24 toolchain):

```sh
npm test -- --watch=false
npm run lint
npx ngc -p tsconfig.spec.json --noEmit
npm run test:sms:fixtures
npm run build -- --configuration production
npm run test:web-isolation
npm run android:sync
node scripts/configure-android-sms-test.mjs
npm run test:android-isolation
```

```powershell
$env:JAVA_HOME=(Resolve-Path tmp/sms-tools/jdk/jdk-21.0.12.1).Path
$env:GRADLE_USER_HOME=(Resolve-Path tmp/sms-tools/gradle-cache).Path
& android/gradlew.bat -p android :app:testDebugUnitTest :app:compileDebugKotlin --offline --console=plain
& ./tmp/brand-sms-debug-icons.ps1
& android/gradlew.bat -p android :app:testDebugUnitTest :app:assembleDebug :app:lintDebug --offline --console=plain
Copy-Item -LiteralPath android/app/build/outputs/apk/debug/app-debug.apk -Destination android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk
node scripts/verify-android-sms-permissions.mjs android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk tmp/sms-tools/android-sdk/build-tools/36.0.0/aapt.exe
& tmp/sms-tools/android-sdk/build-tools/36.0.0/apksigner.bat verify --verbose --print-certs android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk
& tmp/sms-tools/android-sdk/build-tools/36.0.0/aapt.exe dump xmltree android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk AndroidManifest.xml > tmp/sms-permission-final-manifest.txt
& ./tmp/inspect-sms-permission-apk.ps1
node tmp/verify-sms-permission-scope.mjs
```

The initial native unit/compile run also passed. Native logs: `tmp/sms-permission-kotlin.log` and `tmp/sms-permission-debug-build.log`. Final XML reports: `android/app/build/test-results/testDebugUnitTest`; lint report: `android/app/build/reports/lint-results-debug.html`; permission origins: `android/app/build/outputs/logs/manifest-merger-debug-report.txt`. Local diagnostic/icon helper scripts and generated outputs stay ignored.

## Changed sources

- Native: `CardNestSmsPlugin.kt`, `SmsDiscovery.kt`, new `SmsPermissionFlow.kt` and `SmsPermissionFlowTest.kt`.
- Angular: SMS model, permission/discovery portion of the review service, screen component/template/tests, and new `sms-permission.service.spec.ts`. Financial methods are unchanged.
- Build: new `configure-android-sms-test.mjs` and `verify-android-sms-permissions.mjs`; generated integration assertions and the feature-only test workflow.
- Documentation: this diagnosis and the corrected enable/resume description in `SMS_SYNC.md`.

## Actual-device checks still required

Connect an authorized Android phone with USB debugging and select this **test package**, not Play Store or the production app. These PowerShell commands read package-specific, non-SMS diagnostics:

```powershell
$adb=(Resolve-Path tmp/sms-tools/android-sdk/platform-tools/adb.exe).Path
& $adb devices -l
& $adb shell getprop ro.build.version.release
& $adb shell getprop ro.build.version.sdk
& $adb shell dumpsys package com.actionanand.cardnest.app.debug |
  Select-String 'versionCode=|versionName=|targetSdk=|installerPackageName=|android.permission.READ_SMS|android.permission.RECEIVE_SMS'
# Only on an authorized test device, with a compatible existing debug key:
& $adb install -r android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk
& $adb shell am start -n com.actionanand.cardnest.app.debug/com.actionanand.cardnest.app.MainActivity
# Observe only our safe permission tag while pressing Enable SMS access once:
& $adb logcat -v time -s 'CardNestSmsPermission:D' '*:S'
# Open the correct app settings explicitly if Android cannot prompt:
& $adb shell am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:com.actionanand.cardnest.app.debug
```

Confirm `granted=...` and runtime flags such as `USER_SET`, `USER_FIXED`, `POLICY_FIXED`, `SYSTEM_FIXED` or restriction/exemption flags in the actual dump. Compare “request launched” and “callback completed” booleans to the screen and the actual system prompt. Do not infer a particular restriction solely from an immediate denied callback or absent dialog.

Exercise fresh opt-in, denial, no-dialog/blocked access, partial grants, revocation during/after scanning, Settings return, disabled opt-in, repeated taps, process restart and permission-free paste. Confirm no pending work while denied and unchanged cursor/queue/approved/rejected records. Verify incoming/background discovery and TalkBack/focus on the phone. **Physical permission behavior remains pending until these actions are observed.**

Do not clear app data, reset permission flags, force-grant permissions, change installer allowlists, uninstall the test app, or bypass Play Protect as a diagnostic shortcut. If a debug-key mismatch prevents updating an existing test install, preserve its data and resolve the signing/update path before proceeding. No phone SMS inbox, raw SMS logs or unrelated application logs are needed for this diagnosis.
