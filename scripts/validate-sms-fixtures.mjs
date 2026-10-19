import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const corpus = JSON.parse(
  readFileSync('codex-spec/CardNest_SMS_Synthetic_Test_Corpus.json', 'utf8'),
);
const digest = createHash('sha256').update(JSON.stringify(corpus.fixtures)).digest('hex');
const provenance = JSON.parse(
  readFileSync('native/android/sms-sync/fixture-provenance.json', 'utf8'),
);
if (corpus.fixtures.length !== 70 || !corpus.policy.includes('No genuine personal identifiers'))
  throw new Error('Synthetic fixture policy/count changed.');
if (digest !== provenance.sha256)
  throw new Error(
    'Fixture contents changed: synthetic provenance requires explicit human review before updating its checksum.',
  );
const ids = new Set();
for (const fixture of corpus.fixtures) {
  if (ids.has(fixture.id) || !/^(BASE|EXTRA)-\d{2}$/.test(fixture.id))
    throw new Error('Invalid/duplicate fixture identity.');
  ids.add(fixture.id);
  for (const plate of fixture.sms.match(/\b[A-Z]{2}\d{2}[A-Z]{2}\d{4}\b/g) ?? []) {
    if (!provenance.fictionalVehicles.includes(plate))
      throw new Error('Unreviewed vehicle registration.');
  }
  if (/\b\d{13,19}\b/.test(fixture.sms))
    throw new Error('Potential full financial identifier in fixture.');
}
console.log(
  '70 supplied synthetic fixtures passed provenance, identity and identifier checks. Heuristics do not establish that arbitrary new messages are synthetic.',
);
