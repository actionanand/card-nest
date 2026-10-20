import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = 'android/app/src/main';
const plugin = readFileSync(
  `${root}/java/com/actionanand/cardnest/app/CardNestExportPlugin.java`,
  'utf8',
);
const method = plugin.slice(
  plugin.indexOf('public void shareBackup'),
  plugin.indexOf('private File outputFile'),
);

test('backup delivery shares an encrypted private-cache file without writing Downloads', () => {
  assert.ok(method.includes('cardnest-encrypted-backup'));
  assert.ok(method.includes('AES-GCM'));
  assert.ok(method.includes('getContext().getCacheDir(), "exports/backups"'));
  assert.ok(method.includes('File.createTempFile'));
  assert.ok(method.includes('FileProvider.getUriForFile'));
  assert.ok(method.includes('application/octet-stream'));
  assert.ok(!method.includes('saveToDownloads'));
  assert.ok(!method.includes('passphrase'));
});
test('the chooser grants temporary read access through the existing nonexported provider', () => {
  const share = plugin.slice(
    plugin.indexOf('private void share('),
    plugin.indexOf('private void writePdf'),
  );
  assert.ok(share.includes('Intent.ACTION_SEND'));
  assert.ok(share.includes('Intent.EXTRA_STREAM'));
  assert.ok(share.includes('setClipData'));
  assert.ok(share.includes('FLAG_GRANT_READ_URI_PERMISSION'));
  assert.ok(!share.includes('FLAG_GRANT_WRITE_URI_PERMISSION'));
  assert.ok(share.includes('Intent.createChooser'));
  const manifest = readFileSync(`${root}/AndroidManifest.xml`, 'utf8');
  assert.match(
    manifest,
    /android:authorities="\$\{applicationId\}\.exports\.fileprovider"[\s\S]*?android:exported="false"[\s\S]*?android:grantUriPermissions="true"/,
  );
  assert.ok(
    readFileSync(`${root}/res/xml/card_nest_file_paths.xml`, 'utf8').includes('path="exports/"'),
  );
});
