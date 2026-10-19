# Feature 8 Android validation follow-up

Validation: 19–20 October 2026, Asia/Calcutta. Branch: `feature/8-android-sms-transaction-sync`. Starting commit: `6b248a32f65e58e58e241d46f743f0a555f1ad2d`. All seven implementation commits are preserved. No push, merge, release, signing-key creation, or device installation was performed.

## Results

| Gate                        | Result and evidence                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android frontend            | PASS: `production,android` builds the lazy SMS review chunk and native integration. Existing cards stylesheet warning remains 25.04 kB against a 23 kB warning budget, below the 26 kB error budget.                                                                                                                                                                               |
| Fresh generation            | PASS: preserved the old ignored project in `tmp/android-before-validation`, generated a fresh `android/`, then ran the complete `android:sync` pipeline. Kotlin, tests, permissions and plugin registration survive regeneration.                                                                                                                                                  |
| Kotlin/JVM                  | PASS: 107 SMS tests (70 corpus, 14 original, 18 edge, 5 paging/recovery) plus one generated Capacitor sample; zero failures/errors/skips. XML: `android/app/build/test-results/testDebugUnitTest`.                                                                                                                                                                                 |
| Angular                     | PASS: 64 tests in 12 files, zero failures/skips. Includes actual SQLite financial integrity, version-6 migration preservation/replay/constraints, Android startup migration success/failure, serialized manual/SMS writes and approval UI.                                                                                                                                         |
| Android packaging contracts | PASS: 7 tests covering synced assets, manifest permissions/protected entry points, registration before bridge initialization, exact source/resource parity, patch idempotence, API-36 Back/API-qualified themes and Kotlin/R8 configuration. These verify packaging/source contracts, not Android runtime behavior.                                                                |
| Angular lint and compiler   | PASS: `npm run lint`; `npx ngc -p tsconfig.spec.json --noEmit`. Commit hooks also run formatting and lint.                                                                                                                                                                                                                                                                         |
| Web production/isolation    | PASS: normal production build; all 27 emitted JS files exclude SMS route/UI/plugin/permissions. Existing cards stylesheet budget warning only.                                                                                                                                                                                                                                     |
| Android lint                | PASS: final app lint has 0 errors and 33 warnings; all 7 initial errors fixed without baselines/error suppression.                                                                                                                                                                                                                                                                 |
| Debug APK                   | PASS: `android/app/build/outputs/apk/debug/app-debug.apk`, 32,237,881 bytes; debug signature verified with `apksigner`.                                                                                                                                                                                                                                                            |
| Release APK                 | PASS: `android/app/build/outputs/apk/release/app-release-unsigned.apk`, 22,604,152 bytes. Unsigned.                                                                                                                                                                                                                                                                                |
| Release AAB                 | PASS: `android/app/build/outputs/bundle/release/app-release.aab`, 13,134,714 bytes. Unsigned; no release signing credentials used.                                                                                                                                                                                                                                                 |
| R8 and artifacts            | PASS: nonempty release `mapping.txt`; plugin and permission callback retained; receiver/job entry points and 30 JS assets with SMS UI/plugin present in all three archives. No native test classes/corpus packaged. Compiled debug/release manifests retain SMS/boot permissions, protected receiver/job and disabled OS backup.                                                   |
| Privacy/provenance          | PASS: all 70 SMS bodies unchanged from supplied synthetic baseline; original reviewed checksum retained with an explicit metadata-only correction. Added-text/file review found only fictional examples, two allowed fictional plates, and no full 14–19 digit identifiers/private DBs/SMS exports/keystores/build artifacts. Heuristics cannot prove arbitrary data is synthetic. |
| Android runtime             | NOT RUN: `adb devices -l` returned no connected devices. Physical gates below remain open.                                                                                                                                                                                                                                                                                         |

The first offline Gradle build failed because `desugar_jdk_libs:2.1.5` and `desugar_jdk_libs_configuration:2.1.5` JARs were not cached. The online retry downloaded them and built the artifacts; no dependency or R8 suppression change was required. WSL provides Node 24 and the existing Linux dependencies; Windows Java 21, SDK 36, AGP 9.0.1 and Gradle 9.1.0 compile native code. Generated projects, local SDK settings, caches, logs and APK/AABs remain ignored. Local artifacts use the generated default version 1 / 1.0; the CI workflow applies release versions and optional signing separately.

That online aggregate command then failed Android lint with seven errors: two from legacy Back overrides under API 36, two API-27 navigation theme attributes in unqualified resources, two SMS permissions implying required telephony hardware, and one unescaped drive colon in ignored `local.properties`. Generation scripts now use the AndroidX Back dispatcher while preserving the existing dashboard/double-back behavior, emit navigation attributes in API-27 light/dark resources, and declare telephony optional. The local SDK path now escapes its drive colon. No lint baseline or error suppression was introduced. Final artifacts are rebuilt after these corrections.

## EXTRA-06 financial decision

EXTRA-06 describes an account debit with `InfoBIL*INFT*DEMO`; there is no ECS, mandate, EMI or loan evidence. BASE-41 has identical financial wording with another amount and a security trailer. Neither difference proves loan repayment. Correct behavior is generic bank-debit evidence, no bank-balance change or ledger creation, and explicit matching to an existing record when the reviewer has sufficient evidence.

The JSON and specification annex now annotate EXTRA-06 as `BANK_DEBIT_REVIEW` / `NONE_UNTIL_EXPLICIT_RECONCILIATION`. SMS text is unchanged. `SmsCorpusTest` no longer bypasses the expected kind using a fixture-ID exception. Paired tests vary amounts/trailers and contrast actual ECS/Auto Loan/MerchantMandate markers. Even explicit ECS evidence remains review-only and cannot prove a specific loan was paid.

The provenance record declares the original/corrected annotations. Validation projects only those two fields back before checking the original hash, so every SMS, identifier, note and other annotation remains covered by the unchanged reviewed digest.

## Exact validation commands

Root: `C:\AR_Files\code\card-nest` (WSL `/mnt/c/AR_Files/code/card-nest`). Read-only source inspection is omitted. Node commands used the existing WSL toolchain wrapper:

```powershell
wsl -d Ubuntu-22.04 -- bash -lc 'set -e; export PATH=/home/actionanand/.nvm/versions/node/v24.16.0/bin:/usr/bin:/bin; cd /mnt/c/AR_Files/code/card-nest; <commands below>'
```

Exact inner commands, grouped as executed:

```sh
git status --short --branch
npm run build:android

npm run android:add
npm run android:sync

npx prettier --write scripts/validate-sms-fixtures.mjs scripts/verify-android-sms-integration.mjs native/android/sms-sync/fixture-provenance.json src/app/core/data/migrations.spec.ts package.json documentation/ANDROID.md
npm run test:sms:fixtures
npm run test:android-isolation
npm test -- --watch=false

npm run lint
npx ngc -p tsconfig.spec.json --noEmit
npm run build -- --configuration production
npm run test:web-isolation

npx prettier --write src/app/core/data/sqlite-database.spec.ts codex-spec/CardNest_Codex_Local_Implementation_Prompt.md documentation/SMS_SYNC.md
npm test -- --watch=false
```

The first Angular run passed 62 tests; the final run passed 64 after startup migration tests were added. Native commands ran in PowerShell:

```powershell
Copy-Item -LiteralPath tmp/android-before-validation/local.properties -Destination android/local.properties
$env:JAVA_HOME=(Resolve-Path tmp/sms-tools/jdk/jdk-21.0.12.1).Path
$env:GRADLE_USER_HOME=(Resolve-Path tmp/sms-tools/gradle-cache).Path
# Failed because offline dependencies were absent:
& android/gradlew.bat -p android testDebugUnitTest assembleDebug assembleRelease bundleRelease --offline --console=plain
# Online retry plus Android lint; log: tmp/android-validation-build.log
& android/gradlew.bat -p android testDebugUnitTest assembleDebug assembleRelease bundleRelease lintDebug --console=plain
& tmp/sms-tools/android-sdk/platform-tools/adb.exe devices -l
& tmp/sms-tools/android-sdk/build-tools/36.0.0/apksigner.bat verify --verbose android/app/build/outputs/apk/debug/app-debug.apk
& tmp/sms-tools/android-sdk/build-tools/36.0.0/aapt2.exe dump xmltree android/app/build/outputs/apk/debug/app-debug.apk --file AndroidManifest.xml > tmp/sms-debug-manifest.txt
& tmp/sms-tools/android-sdk/build-tools/36.0.0/aapt2.exe dump xmltree android/app/build/outputs/apk/release/app-release-unsigned.apk --file AndroidManifest.xml > tmp/sms-release-manifest.txt
node scripts/validate-sms-fixtures.mjs
node tmp/audit-sms-privacy.mjs
& ./tmp/verify-sms-artifacts.ps1
```

After the lint corrections, these additional commands were executed:

```sh
npx prettier --write scripts/patch-android.mjs scripts/patch-android-sms.mjs scripts/verify-android-sms-integration.mjs documentation/SMS_SYNC_VALIDATION.md documentation/SMS_SYNC_ANDROID_VALIDATION.md
npm run android:sync
npm run test:android-isolation
npm run test:sms:fixtures
npm test -- --watch=false
npm run lint
npx ngc -p tsconfig.spec.json --noEmit
```

```powershell
Set-Content -LiteralPath android/local.properties -Value 'sdk.dir=C\:/AR_Files/code/card-nest/tmp/sms-tools/android-sdk' -Encoding ascii
node scripts/patch-android.mjs
node --check scripts/patch-android.mjs
node --check scripts/patch-android-sms.mjs
node --check scripts/verify-android-sms-integration.mjs
node tmp/audit-sms-privacy.mjs
node --test scripts/verify-android-sms-integration.mjs
# Final app-scoped gates; dependencies were already compiled/linted in the aggregate run:
& android/gradlew.bat -p android :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
```

Final native log: `tmp/android-validation-final.log`. Artifact inspection/signature/compiled-manifest commands are repeated against the rebuilt files before completion.

After the final normal web build, `$env:CAPACITOR_PLATFORM_NAME='android'; node scripts/capacitor-sync-before.mjs` was executed with an expected nonzero result and the environment variable cleared afterward. PASS: it rejected the ordinary web assets with “Android SMS frontend is missing”. The earlier invocation during the build still saw the Android output and was deferred; the completed web build was checked explicitly.

One concurrent Angular/native run had 62 passing tests and two failures: the light-mode AXE audit exceeded Vitest's 5-second default, then the dark-mode audit found the previous AXE call still running. Only these two multi-audit tests now use a 30-second timeout; rules and assertions are unchanged. This lets each awaited audit complete under native/R8 CPU load. The following final regression group was executed after that test-harness correction:

```sh
npx prettier --write src/app/features/sms-sync/sms-sync.spec.ts
npm test -- --watch=false
npm run lint
npx ngc -p tsconfig.spec.json --noEmit
npm run build -- --configuration production
npm run test:web-isolation
```

The ignored local audit helpers compare supplied SMS bodies, scan added text/files, inspect ZIP frontend/DEX contents and compute hashes. The initial privacy comparison used `cc9228e`, which predates the JSON file and failed; rerunning against its first committed version `81ead6e` passed. The original provenance checksum independently verifies unchanged corpus messages.

| Artifact             | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Debug APK            | `4D8A435322EE0197F2D312DB1BF11294A37B591AA148BDF373BF0E451908FAD3` |
| Unsigned release APK | `62FE2DFAFDDD0580063C01EF2B87B170713D9151CA64DD3D59B12FC714D5C3E5` |
| Unsigned release AAB | `90C8240757E0FE28E281396AB2C9E45BBBF227ED8B6396A2BD762F68F90420ED` |

## Remaining physical gates and financial qualifications

Automated coverage verifies all 70 supplied cases, strict fields, explicit approval, deduplication/rollback/crash replay, manual reconciliation, exact overpayment amounts, separate wallets/vehicles, legacy balance cutover, rejection tombstones, backup payload exclusion, retention/deletion and additive schema integrity. Native entry points/initialization are checked in generated and packaged outputs; OS execution is unverified.

Before release, use an authorized physical Android device with synthetic messages to verify:

- Opt-in, denial/permanent denial, revocation, disabled discovery, permission-free paste and no launch-time SMS prompt.
- Inbox provider pagination, incoming/multipart SMS without a WebView, locked device, reboot/update, Doze/OEM restrictions, force-stop/restart, cancel/retry.
- Keystore encryption and process death between native stage/cursor, ledger commit and ack; full queue/storage/provider failures.
- Existing databases and old/new backups through the actual Capacitor SQLite plugin; retention/delete while native work is pending; meal balances, manual edits/deletes, separate FASTag vehicles, statements, refunds and EMI matching.
- Real WebView light/dark AXE including rendered color contrast, TalkBack, focus/keyboard, Android Back and lock/recent-app privacy. jsdom AXE excludes color contrast and does not prove device WCAG AA.

Unknown bank/ECS notices cannot invent payments or loans. Relations without shared references require manual matching. Old pre-feature backups lack SMS tombstones and need existing-entry review; historic wallet snapshots require explicit retain/repair/adjust decisions. No new financial-engine defect was found in this validation. Optional sender/category rule editing and SMS notifications remain absent. Play restricted-permission eligibility and release signing remain distribution gates.

Windows Git misreads the repository's pre-existing tracked reserved filename `NUL`; WSL Git reports the actual tree. That file was not staged or changed.

Proposed eventual draft PR: **Feature 8: Android Smart SMS Transaction Sync with explicit approval**, head `feature/8-android-sms-transaction-sync`, base `main`. No PR was opened and nothing was pushed. Build validation does not close the physical-device release gates.
