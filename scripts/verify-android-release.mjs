import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyPackages({ apk, aab, aapt, bundletool, version }, execute = execFileSync) {
  const run = (command, args) => execute(command, args, { encoding: 'utf8' }).trim();
  const badging = run(aapt, ['dump', 'badging', apk]);
  const apkCode = /^package:.*\bversionCode='(\d+)'/m.exec(badging)?.[1];
  const apkName = /^package:.*\bversionName='([^']+)'/m.exec(badging)?.[1];
  const bundleAttribute = (attribute) =>
    run('java', [
      '-jar',
      bundletool,
      'dump',
      'manifest',
      `--bundle=${aab}`,
      `--xpath=/manifest/@android:${attribute}`,
    ]);
  assert.equal(apkCode, String(version.versionCode), 'APK versionCode mismatch');
  assert.equal(apkName, version.versionName, 'APK versionName mismatch');
  assert.equal(
    bundleAttribute('versionCode'),
    String(version.versionCode),
    'AAB versionCode mismatch',
  );
  assert.equal(bundleAttribute('versionName'), version.versionName, 'AAB versionName mismatch');
  console.log(`Verified APK and AAB: ${version.versionName} (${version.versionCode})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [apk, aab, aapt, bundletool] = process.argv.slice(2);
  assert.ok(apk && aab && aapt && bundletool, 'APK, AAB, aapt and bundletool paths are required');
  verifyPackages({
    apk,
    aab,
    aapt,
    bundletool,
    version: JSON.parse(readFileSync('android-version.json', 'utf8')),
  });
}
