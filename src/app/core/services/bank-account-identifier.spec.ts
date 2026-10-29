import {
  displayBankAccountIdentifier,
  displayBankAccountSuffix,
  parseBankAccountIdentifier,
} from './bank-account-identifier';

describe('Bank account identifier masking', () => {
  it.each([
    ['432xxxxx765', { suffix: '765', mask: '432•••••765' }],
    ['1xxxx7650', { suffix: '650', mask: '1•••••650' }],
    ['xxxx980', { suffix: '980', mask: '••••980' }],
    ['xxx007', { suffix: '007', mask: '•••007' }],
    ['765', { suffix: '765', mask: '•••765' }],
    ['123456', { suffix: '456', mask: '12•456' }],
    ['432123456700', { suffix: '700', mask: '432••••••700' }],
    ['432-123-456-700', { suffix: '700', mask: '432••••••700' }],
    ['XXX007', { suffix: '007', mask: '•••007' }],
    ['***007', { suffix: '007', mask: '•••007' }],
    ['•••007', { suffix: '007', mask: '•••007' }],
    ['●●●007', { suffix: '007', mask: '•••007' }],
    ['×××007', { suffix: '007', mask: '•••007' }],
  ])('normalizes %s without losing leading zeros', (value, expected) => {
    expect(parseBankAccountIdentifier(value)).toEqual(expected);
  });

  it.each(['', '12', '123x45', 'account 432123456700', '432xxxx', '1'.repeat(61)])(
    'rejects incomplete or non-identifier input %s',
    (value) => expect(parseBankAccountIdentifier(value)).toBeNull(),
  );

  it('masks legacy 3–5 digit suffixes to the final three for display', () => {
    expect(displayBankAccountIdentifier(undefined, '417')).toBe('•••417');
    expect(displayBankAccountIdentifier(undefined, '00417')).toBe('•••417');
    expect(displayBankAccountIdentifier(undefined, '00007')).toBe('•••007');
    expect(displayBankAccountSuffix('45123')).toBe('•••123');
    expect(displayBankAccountSuffix('00007')).toBe('•••007');
  });
});
