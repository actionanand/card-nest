# Android releases

The Android GitHub Actions workflow writes the latest versioned APK, AAB, and Play Store icon
to this folder on the `main-android` branch.

Generated filenames follow this pattern:

- `card-nest-release-1-1-0.apk`
- `card-nest-release-1-1-0.aab`
- `card-nest-release-1-1-0-playstore-icon.png`

When signing secrets are unavailable or invalid, `-unsigned` is added before the file extension.
