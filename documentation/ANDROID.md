# CardNest Android build guide

CardNest uses Capacitor and GitHub Actions to package the Angular application as an Android APK and AAB. CI generates the `android/` directory, so it is not committed.

The workflow supports both outcomes:

- When all signing secrets are configured and signing succeeds, it creates a signed APK and signed AAB.
- When the keystore is missing, secrets are incomplete, or signing fails, it creates an unsigned APK and unsigned AAB.

The build log and GitHub job summary explicitly state `SIGNED APK`, `UNSIGNED APK`, `SIGNED AAB`, or `UNSIGNED AAB`, including the artifact path.

No application-login SHA1 hash or password is injected. Android release-signing secrets are used only by `apksigner`, `jarsigner`, and `keytool` during CI.

## Build files

| File                                  | Purpose                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `capacitor.config.ts`                 | App ID, app name, output directory, Android colors, and notification icon configuration                |
| `.github/workflows/android-build.yml` | Builds, optionally signs, verifies, summarizes, and uploads APK/AAB files                              |
| `android-version.json`                | Stores Android `versionCode` and `versionName`                                                         |
| `scripts/bump-android-version.js`     | Updates Android version values                                                                         |
| `scripts/patch-android.mjs`           | Adds the native notification icon, secure-window flag, system-bar colors, and invokes the export patch |
| `scripts/patch-android-export.mjs`    | Generates the native PDF/CSV export plugin and private cache `FileProvider`                            |
| `scripts/generate-keystore.mjs`       | Generates a PKCS12 release keystore                                                                    |
| `scripts/detect-keystore-format.mjs`  | Displays the keystore type                                                                             |
| `public/card-nest.png`                | Source image for launcher and Play Store icons                                                         |

## GitHub signing secrets

Add these under **Repository Settings → Secrets and variables → Actions**:

| Secret              | Purpose                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `KEYSTORE_BASE64`   | Base64 text containing the complete release keystore file                                |
| `KEYSTORE_PASSWORD` | Password used to open the keystore                                                       |
| `KEY_ALIAS`         | Alias of the signing key inside the keystore; the included generator uses `cardnest`     |
| `KEY_PASSWORD`      | Password for the private key; for PKCS12 set it to the same value as `KEYSTORE_PASSWORD` |

All four values must be present before CI attempts signing. They are never written to logs. The decoded keystore is removed in an `always()` cleanup step.

## Generate `KEYSTORE_BASE64`

Generate a PKCS12 keystore once:

```bash
npm run generate-keystore
```

Or provide the password non-interactively in a trusted local shell:

```bash
npm run generate-keystore -- --password 'YOUR_STRONG_PASSWORD'
```

The output is `release-keystore.jks` with alias `cardnest`. Despite the `.jks` filename, its internal format is PKCS12.

Verify it:

```bash
npm run keystore:type
keytool -list -v -keystore release-keystore.jks
```

Generate the GitHub secret value in WSL/Linux:

```bash
base64 -w 0 release-keystore.jks > keystore.b64.txt
```

On macOS:

```bash
base64 < release-keystore.jks | tr -d '\n' > keystore.b64.txt
```

Copy the single-line content of `keystore.b64.txt` into `KEYSTORE_BASE64`. Store the original keystore and passwords in a secure offline backup. Never commit the keystore or the text file. Losing the release key can prevent future Play Store updates.

## Build flow

1. GitHub installs Node 24.16, Java 21, and the Android SDK.
2. `npm ci` installs the locked dependencies.
3. Angular builds `dist/card-nest/browser`.
4. Capacitor generates and syncs the Android project.
5. `scripts/patch-android.mjs` adds the white notification icon, secure-window flag, and native shell colors, then applies the PDF/CSV export bridge.
6. CI applies the Android version, minimum SDK 24, and target SDK 35.
7. ImageMagick generates launcher icons from `public/card-nest.png`.
8. Gradle creates unsigned release APK/AAB inputs.
9. If all secrets exist, CI decodes the keystore, detects its type, signs, and verifies both artifacts.
10. If no keystore is available or signing fails, CI copies clearly named unsigned artifacts.
11. The console and GitHub job summary show the signed/unsigned result.
12. APK, AAB, and Play Store icon artifacts are retained for 30 days. A `v*` tag also creates a GitHub Release.

Signed outputs:

```text
releases/card-nest-release.apk
releases/card-nest-release.aab
```

Unsigned fallback outputs:

```text
releases/card-nest-release-unsigned.apk
releases/card-nest-release-unsigned.aab
```

## Notification implementation

CardNest uses the Capacitor notification API for Android permission and channel integration, then uses a small native `AlarmManager` scheduler generated by `scripts/patch-android.mjs` for delivery:

1. Notification permission is checked only on Android at launch. CardNest first shows an accessible explanation dialog; the Android system prompt opens only after the user selects **Allow notifications**.
2. A high-importance, private lock-screen channel is created.
3. Card reminders are scheduled with stable, app-scoped IDs so updates replace existing CardNest notifications instead of duplicating them. Notification IDs from another installed app cannot conflict with CardNest IDs.
4. Notifications contain only amount, nickname, masked digits, and due date—never a full card number.
5. Editing/archiving cards or recording payments replaces the persisted native schedule. The replacement is checked before CardNest reports that notifications are ready.
6. Statement-due reminders run at **9:00 AM local device time** each day from the selected lead day through the due date. The default lead time is five days and can be changed in **Settings > Notifications**.
7. Annual-fee reminders are scheduled for 9:00 AM local device time 30 days before renewal. Card-expiry reminders are scheduled for 9:00 AM 45 days before the calculated expiry date. By default, expiry uses the first day of the MM/YYYY expiry month; users can switch to the month's final day in **Settings > Notifications**. If CardNest is opened after either reminder should already have been scheduled, it catches up the eligible card instead of silently missing the reminder.
8. All notifications that share a delivery time are stored as one native alarm batch. A single 9:00 AM wake-up publishes every eligible card notification. This avoids Android's per-app idle-alarm quota, which can suppress or heavily delay multiple separate alarms registered for the same instant.
9. Android recalculates each notification title at delivery time from the actual due, renewal, or expiry date. A reminder delayed by Doze or an OEM battery manager therefore says **tomorrow**, **in 4 days**, or **overdue** based on the day it appears rather than retaining yesterday's countdown.
10. Native alarm records are independent of the WebView and are restored after restart, app replacement, manual time change, time-zone change, and user unlock. Old Capacitor-plugin alarms are cancelled during migration.
11. No exact-alarm permission is requested. The native batch uses `AlarmManager.setAndAllowWhileIdle`; Android may deliver it shortly after 9:00 AM when battery optimization or Doze mode requires it. Force-stopping the app in Android settings prevents Android alarms until the app is opened again.
12. CardNest verifies that the notification channel is enabled and that Android persisted the complete schedule. Any failure is shown on the Reminders and Settings pages instead of displaying a false “Notifications ready” state.

The Android patch script writes the monochrome credit-card small icon to `android/app/src/main/res/drawable/ic_stat_card_nest.xml`. `capacitor.config.ts` configures it as the plugin default, and each scheduled reminder also names `ic_stat_card_nest`. Android requires white artwork on a transparent background for notification small icons and applies the appropriate light or dark system tint in the status bar and notification shade.

The native scheduler follows the proven reference-app pattern but batches CardNest's many same-time card reminders into one wake alarm. It does not add an exact-alarm permission or a background service. CardNest also reuses the reference app's export pattern through `scripts/patch-android-export.mjs`.

## Native PDF and CSV export

The browser build opens a portrait A4 print-ready report for **Save as PDF** and downloads CSV with the browser download API. Android does not open a browser tab. The generated `CardNestExport` Capacitor plugin:

1. Receives structured report sections from Angular.
2. Draws paginated portrait A4 pages at 595 x 842 PDF points with Android `PdfDocument`.
3. Writes PDF or UTF-8 CSV output only to the app's private cache.
4. Exposes that one file through a non-exported `FileProvider`.
5. Opens Android's native chooser so the user can save or share it.

The cache provider grants read access only to the chosen receiving app. Exports contain masked source/card descriptions and never include full card numbers, CVVs, PINs, encrypted secret fields, or notification data. No storage permission and no additional npm package are required.

## Local Android workflow

From WSL/Linux, ensure the Android SDK and Java 21 are available. First setup:

```bash
npm run build
npm run android:add
npm run android:sync
```

Open the generated project with Android Studio from the appropriate host environment:

```bash
npm run android:open
```

After the Android project exists, `npm run android:sync` rebuilds the web application, synchronizes Capacitor, and reapplies the idempotent native patch.

## Versioning

```bash
npm run android:version
npm run android:version:patch
npm run android:version:minor
npm run android:version:major
```

The plain command increments only `versionCode`; patch/minor/major commands also update `versionName`.

## Trigger the workflow

Push `main-android`, push a `v*` tag, or use **Actions → Android APK and AAB → Run workflow**.

```bash
git checkout main-android
git merge main
git push origin main-android
```

## App icon and security

- `public/card-nest.png` is the canonical launcher and Play Store icon.
- `scripts/patch-android.mjs` supplies the monochrome status-bar notification icon required by Android.
- `FLAG_SECURE` prevents screenshots and recent-app preview capture because CardNest displays financial information.
- SQLite, notifications, camera, and system document pickers do not require broad storage permission.

## SDK versions

```yaml
MIN_SDK_VERSION: 24
TARGET_SDK_VERSION: 35
```

Raise the target when Google Play requirements change and verify Capacitor compatibility before merging.
