import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Shared by feature CI and local diagnosis; the production workflow does not call this.
const version = JSON.parse(readFileSync('android-version.json', 'utf8'));
if (!/^\d+(?:\.\d+)*$/.test(version.versionName) || !Number.isSafeInteger(version.versionCode))
  throw new Error('Invalid Android version.');
const path = 'android/app/build.gradle';
let gradle = readFileSync(path, 'utf8');
if (!gradle.includes('applicationId "com.actionanand.cardnest.app"'))
  throw new Error('Unexpected base Android identity.');
if (!gradle.includes('applicationIdSuffix ".debug"'))
  gradle = gradle.replace(
    'buildTypes {',
    `buildTypes {
        debug {
            applicationIdSuffix ".debug"
            versionNameSuffix "-sms-test"
        }`,
  );
gradle = gradle
  .replace(/versionCode \d+/, `versionCode ${version.versionCode}`)
  .replace(/versionName "[^"]+"/, `versionName "${version.versionName}"`);
writeFileSync(path, gradle);
mkdirSync('android/app/src/debug', { recursive: true });
writeFileSync(
  'android/app/src/debug/AndroidManifest.xml',
  `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
          xmlns:tools="http://schemas.android.com/tools">
    <application android:label="CardNest SMS Test" tools:replace="android:label">
        <activity android:name="com.actionanand.cardnest.app.MainActivity"
                  android:label="CardNest SMS Test" tools:replace="android:label" />
    </application>
</manifest>
`,
);
console.log(
  `Debug-only identity configured: com.actionanand.cardnest.app.debug; card-nest-${version.versionName.replaceAll('.', '-')}-debug.apk`,
);
