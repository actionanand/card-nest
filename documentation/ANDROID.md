# CardNest Android build guide

CardNest uses Capacitor and GitHub Actions to package the Angular application as an Android APK and AAB. CI generates the `android/` directory, so it is not committed.

The workflow supports both outcomes:

- When all signing secrets are configured and signing succeeds, it creates a signed APK and signed AAB.
- When the keystore is missing, secrets are incomplete, or signing fails, it creates an unsigned APK and unsigned AAB.

The build log and GitHub job summary explicitly state `SIGNED APK`, `UNSIGNED APK`, `SIGNED AAB`, or `UNSIGNED AAB`, including the artifact path.

No application-login SHA1 hash or password is injected. Android release-signing secrets are used only by `apksigner`, `jarsigner`, and `keytool` during CI.

## Build files

| File                                  | Purpose                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `capacitor.config.ts`                 | App ID, app name, output directory, Android colors, and notification icon configuration |
| `.github/workflows/android-build.yml` | Builds, optionally signs, verifies, summarizes, and uploads APK/AAB files               |
| `android-version.json`                | Stores Android `versionCode` and `versionName`                                          |
| `scripts/bump-android-version.js`     | Updates Android version values                                                          |
| `scripts/patch-android.mjs`           | Adds the native notification icon, secure-window flag, and CardNest system-bar colors   |
| `scripts/generate-keystore.mjs`       | Generates a PKCS12 release keystore                                                     |
| `scripts/detect-keystore-format.mjs`  | Displays the keystore type                                                              |
| `public/card-nest.png`                | Source image for launcher and Play Store icons                                          |

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
5. `scripts/patch-android.mjs` adds the white notification icon, secure-window flag, and native shell colors.
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

CardNest uses `@capacitor/local-notifications` directly. This matches the reliable parts of the reference pattern without its timer-specific native plugin:

1. Notification permission is checked only on Android at launch. CardNest first shows an accessible explanation dialog; the Android system prompt opens only after the user selects **Allow notifications**.
2. A high-importance, private lock-screen channel is created.
3. Card reminders are scheduled with stable IDs so updates replace existing notifications instead of duplicating them.
4. Notifications contain only amount, nickname, masked digits, and due date—never a full card number.
5. Editing/archiving cards or recording payments causes reminders to be cancelled and recalculated.
6. The Capacitor plugin contributes `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, wake-lock support, an Android alarm publisher, and a boot restore receiver through manifest merging.
7. No exact-alarm permission is requested and `allowWhileIdle` is disabled. Android may deliver reminders approximately when battery optimization requires it.

The Android patch script writes the monochrome credit-card small icon to `android/app/src/main/res/drawable/ic_stat_card_nest.xml`. `capacitor.config.ts` configures it as the plugin default, and each scheduled reminder also names `ic_stat_card_nest`. Android requires white artwork on a transparent background for notification small icons and applies the appropriate light or dark system tint in the status bar and notification shade.

The reference app needed extra native scripts because it reacted to live timer thresholds and implemented custom `AlarmManager`/`BroadcastReceiver` behavior, theme bridging, and native PDF export. CardNest has date-based card reminders, so duplicating that native reminder plugin would add competing schedulers and unnecessary permissions. `scripts/patch-android.mjs` therefore handles only CardNest-specific native shell work.

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
