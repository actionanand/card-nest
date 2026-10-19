import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = 'android/app';
const source = 'native/android/sms-sync';
const target = `${root}/src/main/java/com/actionanand/cardnest/app/sms`;
const tests = `${root}/src/test/java/com/actionanand/cardnest/app/sms`;
mkdirSync(target, { recursive: true });
mkdirSync(tests, { recursive: true });
for (const name of readdirSync(source).filter((name) => name.endsWith('.kt'))) {
  copyFileSync(join(source, name), join(name.endsWith('Test.kt') ? tests : target, name));
}
const resources = `${root}/src/test/resources`;
mkdirSync(resources, { recursive: true });
copyFileSync('codex-spec/CardNest_SMS_Synthetic_Test_Corpus.json', `${resources}/sms-corpus.json`);
const activityPath = `${root}/src/main/java/com/actionanand/cardnest/app/MainActivity.java`;
let activity = readFileSync(activityPath, 'utf8');
if (
  !activity.includes('registerPlugin(com.actionanand.cardnest.app.sms.CardNestSmsPlugin.class)')
) {
  activity = activity.replace(
    'super.onCreate(savedInstanceState);',
    'registerPlugin(com.actionanand.cardnest.app.sms.CardNestSmsPlugin.class);\n    super.onCreate(savedInstanceState);',
  );
}
writeFileSync(activityPath, activity);
const manifestPath = `${root}/src/main/AndroidManifest.xml`;
let manifest = readFileSync(manifestPath, 'utf8');
for (const permission of ['READ_SMS', 'RECEIVE_SMS', 'RECEIVE_BOOT_COMPLETED']) {
  if (!manifest.includes(`android.permission.${permission}`))
    manifest = manifest.replace(
      '<application',
      `<uses-permission android:name="android.permission.${permission}" />\n    <application`,
    );
}
if (!manifest.includes('.sms.SmsReceivedReceiver'))
  manifest = manifest.replace(
    '</application>',
    `
    <receiver android:name=".sms.SmsReceivedReceiver" android:exported="true" android:permission="android.permission.BROADCAST_SMS">
      <intent-filter><action android:name="android.provider.Telephony.SMS_RECEIVED" /></intent-filter>
    </receiver>
    <service android:name=".sms.SmsScanJob" android:exported="true" android:permission="android.permission.BIND_JOB_SERVICE" />
  </application>`,
  );
if (!manifest.includes('.sms.SmsRestartReceiver'))
  manifest = manifest.replace(
    '</application>',
    `<receiver android:name=".sms.SmsRestartReceiver" android:exported="false">
      <intent-filter><action android:name="android.intent.action.BOOT_COMPLETED" /><action android:name="android.intent.action.MY_PACKAGE_REPLACED" /><action android:name="android.intent.action.USER_UNLOCKED" /></intent-filter>
    </receiver></application>`,
  );
// Keystore-encrypted queues must never be restored to a device without their key.
manifest = manifest.replace(/android:allowBackup="[^"]*"/g, 'android:allowBackup="false"');
if (!manifest.includes('android:allowBackup='))
  manifest = manifest.replace('<application', '<application android:allowBackup="false"');
writeFileSync(manifestPath, manifest);
const gradlePath = `${root}/build.gradle`;
let gradle = readFileSync(gradlePath, 'utf8');
if (!gradle.includes('// CardNest SMS integration'))
  gradle += `
// CardNest SMS integration. AGP 9 supplies Kotlin; do not apply kotlin-android again.
android {
    compileOptions { coreLibraryDesugaringEnabled true }
}
dependencies {
    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'
    testImplementation 'junit:junit:4.13.2'
    testImplementation 'org.json:json:20250517'
}
`;
writeFileSync(gradlePath, gradle);
console.log('CardNest Kotlin SMS sources, tests, manifest and plugin registered.');
