#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('Usage: node scripts/detect-keystore-format.mjs <keystore>');
  process.exit(1);
}

try {
  const output = execFileSync('keytool', ['-list', '-keystore', file], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const type = output.match(/Keystore type:\s*(\S+)/i)?.[1] ?? 'unknown';
  console.log(`Keystore type: ${type}`);
} catch {
  console.error('Unable to read the keystore. Check the password and file format.');
  process.exit(1);
}
