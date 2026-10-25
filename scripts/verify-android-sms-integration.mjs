import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const root = 'android/app/src';
const java = `${root}/main/java/com/actionanand/cardnest/app`;
const manifest = read(`${root}/main/AndroidManifest.xml`);
const scripts = readdirSync(`${root}/main/assets/public`).filter((name) => name.endsWith('.js'));
const frontend = scripts.map((name) => read(`${root}/main/assets/public/${name}`)).join('\n');

test('synced Android assets contain the guarded review feature and native bridge', () => {
  for (const marker of ['CardNestSms', 'sms-sync', 'SMS Sync'])
    assert.ok(frontend.includes(marker), marker);
  assert.match(
    read('src/app/platform-routes.android.ts'),
    /canMatch:.*getPlatform\(\) === 'android'/,
  );
  assert.match(
    read('src/app/features/sms-sync/sms-review.service.ts'),
    /locked\(\)|foreground\(\)/,
  );
});

test('SMS and persisted-job manifest entry points are permission protected', () => {
  for (const permission of ['READ_SMS', 'RECEIVE_SMS', 'RECEIVE_BOOT_COMPLETED'])
    assert.equal(
      (
        manifest.match(
          new RegExp(`uses-permission android:name="android.permission.${permission}"`, 'g'),
        ) ?? []
      ).length,
      1,
    );
  assert.match(
    manifest,
    /<receiver android:name="\.sms.SmsReceivedReceiver" android:exported="true" android:permission="android.permission.BROADCAST_SMS">/,
  );
  assert.match(
    manifest,
    /<service android:name="\.sms.SmsScanJob" android:exported="true" android:permission="android.permission.BIND_JOB_SERVICE"/,
  );
  assert.match(
    manifest,
    /<receiver android:name="\.sms.SmsRestartReceiver" android:exported="false">/,
  );
  for (const action of ['BOOT_COMPLETED', 'MY_PACKAGE_REPLACED', 'USER_UNLOCKED'])
    assert.ok(manifest.includes(`android.intent.action.${action}`));
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(
    manifest,
    /<uses-feature android:name="android.hardware.telephony" android:required="false"/,
  );
});

test('WhatsApp integration exposes only the two supported packages and validates native launches', () => {
  assert.match(manifest, /<package android:name="com\.whatsapp"\s*\/>/);
  assert.match(manifest, /<package android:name="com\.whatsapp\.w4b"\s*\/>/);
  assert.ok(!manifest.includes('QUERY_ALL_PACKAGES'));
  const activity = read(`${java}/MainActivity.java`);
  assert.match(activity, /availableWhatsAppApps\(\)/);
  assert.match(activity, /openWhatsAppIn\(String number, String message, String packageName\)/);
  assert.match(activity, /openWhatsAppFallback\(String number, String message\)/);
  assert.match(activity, /91\[6-9\]\[0-9\]\{9\}/);
  assert.ok(activity.includes('com.whatsapp.w4b'));
});

test('native reminder scheduler retains utility titles and batches alarms', () => {
  const scheduler = read(`${java}/CardNestReminderScheduler.java`);
  assert.match(scheduler, /kind\.startsWith\("UTILITY_"\)/);
  assert.match(scheduler, /return record\.optString\("title", "CardNest reminder"\)/);
  assert.match(scheduler, /scheduleNextBatch\(context, valid, false\)/);
  assert.match(scheduler, /scheduleAlarm\(context, nextAt, triggerAt\)/);
});

test('plugin registration precedes Capacitor bridge initialization', () => {
  const activity = read(`${java}/MainActivity.java`);
  const registration = 'registerPlugin(com.actionanand.cardnest.app.sms.CardNestSmsPlugin.class);';
  assert.equal(activity.split(registration).length, 2);
  assert.ok(
    activity.indexOf(registration) < activity.indexOf('super.onCreate(savedInstanceState);'),
  );
  const plugin = read(`${java}/sms/CardNestSmsPlugin.kt`);
  assert.match(
    plugin,
    /Permission\(alias = "sms", strings = \[Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS\]\)/,
  );
  const discovery = read(`${java}/sms/SmsDiscovery.kt`);
  assert.match(discovery, /setPersisted\(true\)/);
  assert.match(
    discovery,
    /!settings\(context\).getBoolean\("enabled", false\) \|\| !permitted\(context\)/,
  );
  assert.match(discovery, /repeat\(10\)/);
  assert.match(discovery, /try \{\s+SmsDiscovery.begin\(this\)/);
  assert.match(plugin, /Settings.ACTION_APPLICATION_DETAILS_SETTINGS/);
});

test('generated Kotlin production and test sources match tracked inputs exactly', () => {
  for (const name of readdirSync('native/android/sms-sync').filter((name) =>
    name.endsWith('.kt'),
  )) {
    const target = name.endsWith('Test.kt')
      ? `${root}/test/java/com/actionanand/cardnest/app/sms/${name}`
      : `${java}/sms/${name}`;
    assert.equal(read(target), read(`native/android/sms-sync/${name}`), name);
  }
  assert.equal(
    read(`${root}/test/resources/sms-corpus.json`),
    read('codex-spec/CardNest_SMS_Synthetic_Test_Corpus.json'),
  );
  assert.ok(!readdirSync(`${java}/sms`).some((name) => name.endsWith('Test.kt')));
});

test('complete regeneration patch is idempotent', () => {
  const paths = [
    `${java}/MainActivity.java`,
    `${root}/main/AndroidManifest.xml`,
    'android/app/build.gradle',
    'android/app/proguard-rules.pro',
    ...['values', 'values-night', 'values-v27', 'values-night-v27', 'values-v31'].map(
      (qualifier) => `${root}/main/res/${qualifier}/styles.xml`,
    ),
  ];
  const before = paths.map(read);
  execFileSync(process.execPath, ['scripts/patch-android.mjs'], { stdio: 'pipe' });
  assert.deepEqual(paths.map(read), before);
});

test('API-36 Back dispatcher and API-qualified navigation themes survive generation', () => {
  const activity = read(`${java}/MainActivity.java`);
  assert.match(
    activity,
    /getOnBackPressedDispatcher\(\)\.addCallback\(this, new OnBackPressedCallback\(true\)/,
  );
  assert.ok(!activity.includes('public void onBackPressed()'));
  assert.ok(activity.includes("new Event('cardnest:back', {cancelable:true})"));
  assert.ok(activity.includes('if (!"true".equals(handled)) handleCardNestNavigationBack();'));
  for (const qualifier of ['values', 'values-night'])
    assert.ok(
      !read(`${root}/main/res/${qualifier}/styles.xml`).includes(
        'android:windowLightNavigationBar',
      ),
    );
  for (const [qualifier, enabled] of [
    ['values-v27', true],
    ['values-night-v27', false],
  ])
    assert.ok(
      read(`${root}/main/res/${qualifier}/styles.xml`).includes(
        `<item name="android:windowLightNavigationBar">${enabled}</item>`,
      ),
    );
});

test('AGP builtin Kotlin and Capacitor reflection keep rules are retained', () => {
  const gradle = read('android/app/build.gradle');
  assert.ok(!/apply plugin: ['"](?:kotlin-android|org.jetbrains.kotlin.android)['"]/.test(gradle));
  assert.match(gradle, /coreLibraryDesugaringEnabled true/);
  assert.match(gradle, /minifyEnabled true/);
  assert.match(gradle, /shrinkResources true/);
  const rules = read(join('node_modules', '@capacitor/android/capacitor/proguard-rules.pro'));
  for (const annotation of ['CapacitorPlugin', 'PermissionCallback', 'PluginMethod'])
    assert.ok(rules.includes(annotation));
});
