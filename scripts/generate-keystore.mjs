#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const outputFile = 'release-keystore.jks';
const alias = 'cardnest';
const passwordIndex = process.argv.indexOf('--password');
const password =
  passwordIndex >= 0 && process.argv[passwordIndex + 1]
    ? process.argv[passwordIndex + 1]
    : process.env.KEYSTORE_PASSWORD || null;

try {
  if (existsSync(outputFile)) rmSync(outputFile);
  const passwordArguments = password ? ['-storepass', password, '-keypass', password] : [];
  execFileSync(
    'keytool',
    [
      '-genkeypair',
      '-v',
      '-storetype',
      'PKCS12',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '36500',
      ...passwordArguments,
      '-alias',
      alias,
      '-keystore',
      outputFile,
      '-dname',
      'CN=CardNest, OU=Mobile, O=CardNest, C=IN',
    ],
    { stdio: 'inherit' },
  );
  console.log(`Created ${outputFile} as PKCS12 with alias ${alias}.`);
  console.log('Back up this file and password securely; never commit them.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Keystore generation failed.');
  process.exit(1);
}
