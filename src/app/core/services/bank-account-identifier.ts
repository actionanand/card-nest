import aliases from '../data/bank-aliases.json';

export interface ParsedBankAccountIdentifier {
  readonly suffix: string;
  readonly mask: string;
}

function normalizedCompleteAccount(value: string): string | undefined {
  const compact = value.trim().replace(/[\s-]/g, '');
  return /^\d{6,24}$/.test(compact) ? compact : undefined;
}

/** HMAC fingerprint for a complete number; the caller owns the portable, app-private key. */
export async function fingerprintCompleteBankAccount(
  value: string,
  key: Uint8Array,
): Promise<string | undefined> {
  const compact = normalizedCompleteAccount(value);
  if (!compact || key.length < 32) return undefined;
  const keyBytes = new Uint8Array(key.length);
  keyBytes.set(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(compact)),
  );
  return `hmac-sha256-v1:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Transient compatibility digest for detecting duplicates against pre-HMAC saved fingerprints. */
export async function legacyFingerprintCompleteBankAccount(
  value: string,
): Promise<string | undefined> {
  const compact = normalizedCompleteAccount(value);
  if (!compact) return undefined;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(compact)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fingerprintsMatch(left?: string, right?: string): boolean {
  return !!left && !!right && left === right;
}

/** Values from different schemes cannot be compared; same-scheme values can establish distinction. */
export function fingerprintsProveDistinct(left?: string, right?: string): boolean {
  const keyed = (value: string) => value.startsWith('hmac-sha256-v1:');
  const legacy = (value: string) => /^[a-f0-9]{64}$/.test(value);
  return (
    !!left &&
    !!right &&
    ((keyed(left) && keyed(right)) || (legacy(left) && legacy(right))) &&
    left !== right
  );
}

const MASK_CHARACTERS = /[xX*•●×]/;
const ALLOWED_CHARACTERS = /^[0-9xX*•●×\s-]+$/;

/** Parse a temporary user/SMS identifier into a final-three suffix and a non-secret display mask. */
export function parseBankAccountIdentifier(value: string): ParsedBankAccountIdentifier | null {
  const raw = value.trim();
  if (!raw || raw.length > 60 || !ALLOWED_CHARACTERS.test(raw)) return null;
  const compact = raw.replace(/[\s-]/g, '');
  const lastMask = Math.max(
    ...[...compact].map((character, index) => (MASK_CHARACTERS.test(character) ? index : -1)),
  );
  const trailing = (lastMask < 0 ? compact : compact.slice(lastMask + 1)).replace(/[^0-9]/g, '');
  if (trailing.length < 3) return null;

  const suffix = trailing.slice(-3);
  const firstMask = [...compact].findIndex((character) => MASK_CHARACTERS.test(character));
  const knownPrefix =
    firstMask < 0
      ? compact.length >= 6
        ? compact.slice(0, Math.min(3, compact.length - 4))
        : ''
      : compact
          .slice(0, firstMask)
          .replace(/[^0-9]/g, '')
          .slice(0, 3);
  const hiddenCount =
    firstMask < 0
      ? compact.length >= 6
        ? Math.max(1, compact.length - knownPrefix.length - 3)
        : 3
      : Math.max(1, compact.length - knownPrefix.length - 3);

  return {
    suffix,
    mask: `${knownPrefix}${'•'.repeat(hiddenCount)}${suffix}`,
  };
}

/** Display legacy numeric 3–5 digit suffixes without exposing extra trailing digits. */
export function displayBankAccountIdentifier(mask?: string, suffix?: string): string {
  if (mask) {
    const parsed = parseBankAccountIdentifier(mask);
    if (parsed) return parsed.mask;
  }
  return displayBankAccountSuffix(suffix);
}

/** Labels reveal exactly the final three numeric digits, even when a longer hint is saved. */
export function displayBankAccountSuffix(suffix?: string): string {
  const digits = suffix && /^\d{3,5}$/.test(suffix) ? suffix.slice(-3) : undefined;
  return digits ? `•••${digits}` : '';
}

function bankKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\b(limited|ltd|private|pvt|sms|alerts?)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizedBank(value: string | undefined): string {
  if (!value) return '';
  const key = bankKey(value);
  return aliases.find((row) => row.aliases.some((alias) => bankKey(alias) === key))?.id ?? key;
}

export function bankDisplayName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.trim().slice(0, 80);
  if (/\d{6,}|[\r\n]/.test(clean)) return undefined;
  return aliases.find((row) => row.id === normalizedBank(clean))?.name ?? clean;
}

export function matchesBank(left: string | undefined, right: string | undefined): boolean {
  const a = normalizedBank(left);
  const b = normalizedBank(right);
  return a.length > 1 && a === b;
}

export function recognizedBank(value: string | undefined): boolean {
  if (!value) return false;
  const key = bankKey(value);
  return aliases.some(
    (row) => bankKey(row.id) === key || row.aliases.some((alias) => bankKey(alias) === key),
  );
}
