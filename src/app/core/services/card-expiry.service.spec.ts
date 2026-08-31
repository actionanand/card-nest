import { describe, expect, it } from 'vitest';
import { cardExpiryDate } from './card-expiry.service';

describe('cardExpiryDate', () => {
  it('uses the first day of the expiry month by default', () => {
    const expiry = cardExpiryDate(2026, 9, true);
    expect([expiry.getFullYear(), expiry.getMonth(), expiry.getDate()]).toEqual([2026, 8, 1]);
  });

  it('uses the final day when the first-day option is disabled', () => {
    const expiry = cardExpiryDate(2026, 9, false);
    expect([expiry.getFullYear(), expiry.getMonth(), expiry.getDate()]).toEqual([2026, 8, 30]);
  });

  it('handles leap-year February', () => {
    expect(cardExpiryDate(2028, 2, false).getDate()).toBe(29);
  });
});
