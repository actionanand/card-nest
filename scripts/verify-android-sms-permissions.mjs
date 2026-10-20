import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [apk, aapt] = process.argv.slice(2);
if (!apk || !aapt)
  throw new Error('Usage: node scripts/verify-android-sms-permissions.mjs APK_PATH AAPT_PATH');
const run = (...args) => execFileSync(aapt, args, { encoding: 'utf8' });
const permissions = run('dump', 'permissions', apk);
const actual = [...permissions.matchAll(/^uses-permission: name='([^']+)'/gm)]
  .map((m) => m[1])
  .sort();
// Every permission in this test APK needs an explicit feature justification.
const expected = [
  'READ_SMS',
  'RECEIVE_SMS',
  'RECEIVE_BOOT_COMPLETED',
  'INTERNET',
  'WAKE_LOCK',
  'POST_NOTIFICATIONS',
  'USE_BIOMETRIC',
  'USE_FINGERPRINT',
].map((name) => `android.permission.${name}`);
expected.push('com.actionanand.cardnest.app.debug.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION');
assert.deepEqual(
  actual,
  expected.sort(),
  'Unexpected/missing permission in compiled APK; review its manifest-merger origin.',
);
const badging = run('dump', 'badging', apk);
const version = JSON.parse(readFileSync('android-version.json', 'utf8'));
assert.ok(badging.includes("package: name='com.actionanand.cardnest.app.debug'"));
assert.ok(badging.includes("application-label:'CardNest SMS Test'"));
assert.ok(/launchable-activity:.*label='CardNest SMS Test'/.test(badging));
assert.ok(badging.includes(`versionName='${version.versionName}-sms-test'`));
const manifest = run('dump', 'xmltree', apk, 'AndroidManifest.xml');
for (const marker of [
  'SmsReceivedReceiver',
  'SmsRestartReceiver',
  'SmsScanJob',
  'android.permission.BROADCAST_SMS',
  'android.permission.BIND_JOB_SERVICE',
])
  assert.ok(manifest.includes(marker), `Missing compiled native entry point: ${marker}`);
console.log(
  'PASS compiled isolated debug APK: identity, label, version, 9 justified permissions, protected SMS/job entry points.',
);
console.log(actual.join('\n'));
