import { describe, expect, it } from 'vitest';
import { countryOptionForCurrency } from './currency-display';

describe('display currency country synchronisation', () => {
  it('keeps the selected country when it already uses the currency', () => {
    expect(countryOptionForCurrency('USD', 'EC')?.countryCode).toBe('EC');
  });

  it('uses the representative country when the current country does not use the currency', () => {
    expect(countryOptionForCurrency('USD', 'IN')?.countryCode).toBe('US');
    expect(countryOptionForCurrency('EUR', 'IN')?.countryCode).toBe('DE');
  });

  it('maps a country-specific currency back to its country', () => {
    expect(countryOptionForCurrency('INR', 'US')?.countryCode).toBe('IN');
  });
});
