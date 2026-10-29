export interface ParsedBankAccountIdentifier {
  readonly suffix: string;
  readonly mask: string;
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
