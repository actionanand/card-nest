import { normalizeIndianMobileNumber } from './utilities.service';

describe('Indian Utilities phone normalization', () => {
  it('stores optional Indian mobile numbers in normalized +91 form', () => {
    expect(normalizeIndianMobileNumber('9876543210')).toBe('+91-9876543210');
    expect(normalizeIndianMobileNumber('+91 98765 43210')).toBe('+91-9876543210');
    expect(normalizeIndianMobileNumber('')).toBeUndefined();
  });

  it('rejects short, long and non-mobile Indian numbers', () => {
    for (const value of ['12345', '1234567890', '+1 9876543210', '+91 0123456789', '98765432101'])
      expect(() => normalizeIndianMobileNumber(value)).toThrow();
  });
});
