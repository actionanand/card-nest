#!/usr/bin/env node

const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const file = resolve(process.cwd(), 'android-version.json');
const appVersionFile = resolve(process.cwd(), 'src/app/core/app-version.ts');
const version = JSON.parse(readFileSync(file, 'utf8'));
const bump = process.argv.find((argument) => ['--patch', '--minor', '--major'].includes(argument));
const parts = String(version.versionName).split('.').map(Number);
const previousCodeArgument = process.argv.find((argument) =>
  argument.startsWith('--after-version-code='),
);
const previousCode = previousCodeArgument ? Number(previousCodeArgument.split('=')[1]) : 0;
if (!Number.isSafeInteger(previousCode) || previousCode < 0) {
  throw new Error('The previous Android versionCode must be a non-negative integer.');
}
if (!Number.isSafeInteger(version.versionCode) || version.versionCode < 1) {
  throw new Error('The stored Android versionCode must be a positive integer.');
}

version.versionCode = Math.max(version.versionCode, previousCode) + 1;
if (version.versionCode > 2100000000) {
  throw new Error('Android versionCode exceeds the Google Play limit.');
}
if (bump === '--major') version.versionName = `${parts[0] + 1}.0.0`;
if (bump === '--minor') version.versionName = `${parts[0]}.${parts[1] + 1}.0`;
if (bump === '--patch') version.versionName = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;

writeFileSync(file, `${JSON.stringify(version, null, 2)}\n`);
writeFileSync(
  appVersionFile,
  `// Updated automatically by scripts/bump-android-version.js.\nexport const APP_VERSION = '${version.versionName}';\n`,
);
console.log(`Android version: ${version.versionName} (${version.versionCode})`);
