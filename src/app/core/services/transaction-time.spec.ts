import { recordedTransactionTime } from './transaction-time';

describe('Recorded transaction wall-clock display', () => {
  it('defaults off and does not invent midnight for missing or invalid times', () => {
    expect(recordedTransactionTime('19:24', false)).toBe('');
    for (const time of [undefined, '', '24:00', '12:99', '2026-10-13T19:24:00Z'])
      expect(recordedTransactionTime(time, true)).toBe('');
  });
  it('formats genuine time, including real midnight, in locale 12/24-hour conventions', () => {
    expect(recordedTransactionTime('19:24:00', true, 'en-US')).toBe('7:24 PM');
    expect(recordedTransactionTime('19:24', true, 'en-GB')).toBe('19:24');
    expect(recordedTransactionTime('00:00', true, 'en-US')).toBe('12:00 AM');
  });
  it('preserves wall-clock evidence rather than shifting it in another device timezone', () => {
    const previous = process.env['TZ'];
    try {
      process.env['TZ'] = 'America/Los_Angeles';
      expect(recordedTransactionTime('19:24', true, 'en-GB')).toBe('19:24');
    } finally {
      if (previous) process.env['TZ'] = previous;
      else delete process.env['TZ'];
    }
  });
});
