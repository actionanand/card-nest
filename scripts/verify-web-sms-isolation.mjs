import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const root = 'dist/card-nest/browser';
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const scripts = walk(root).filter((file) => /\.js$/.test(file));
if (!scripts.length) throw new Error('No web build exists to verify.');
for (const file of scripts) {
  if (/CardNestSms|sms-sync|SMS Sync|READ_SMS|RECEIVE_SMS/.test(readFileSync(file, 'utf8')))
    throw new Error(`Android SMS feature leaked into web bundle: ${file}`);
}
console.log(
  `Verified ${scripts.length} web JavaScript files: no SMS route, UI, plugin or permissions.`,
);
