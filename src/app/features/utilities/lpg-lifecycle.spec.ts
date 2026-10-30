import { assertLpgTimelineChange, lpgEventChoices, lpgLifecycle } from './lpg-lifecycle';
import { LpgEvent, LpgEventType } from './utilities-model';

const event = (id: string, eventType: LpgEventType, eventDate = '2026-10-01'): LpgEvent => ({
  id,
  profileId: 'connection',
  eventType,
  eventDate,
  createdAt: `2026-10-01T00:00:0${id}Z`,
  updatedAt: 'before',
});

describe('Single-active-cylinder LPG lifecycle', () => {
  it.each([
    [[], ['STARTED', 'REFILL_RECEIVED']],
    [[event('1', 'STARTED')], ['EMPTY']],
    [
      [event('1', 'STARTED'), event('2', 'EMPTY')],
      ['STARTED', 'REFILL_RECEIVED'],
    ],
    [[event('1', 'REFILL_RECEIVED')], ['STARTED']],
  ])('offers only valid next events for %j', (timeline, choices) => {
    expect(lpgEventChoices(timeline as LpgEvent[], '2026-10-02')).toEqual(choices);
  });

  it('keeps receipt and start independent and orders same-day records by original creation time', () => {
    const timeline = [
      event('3', 'REFILL_RECEIVED'),
      event('1', 'STARTED'),
      event('2', 'EMPTY'),
      event('4', 'STARTED'),
    ];
    expect(lpgLifecycle(timeline)).toEqual({ state: 'IN_USE', conflicts: [] });
    expect(lpgLifecycle([event('1', 'REFILL_RECEIVED')]).state).toBe('RECEIVED');
    expect(lpgLifecycle([event('1', 'STARTED'), event('2', 'EMPTY')]).state).toBe('EMPTY');
  });

  it('rejects duplicate starts, empties and receipts, including invalid backdated insertions', () => {
    for (const type of ['STARTED', 'EMPTY', 'REFILL_RECEIVED'] as const) {
      const before =
        type === 'EMPTY' ? [event('1', 'STARTED'), event('2', 'EMPTY')] : [event('1', type)];
      expect(() => assertLpgTimelineChange(before, [...before, event('3', type)], '3')).toThrow();
    }
    const before = [event('2', 'STARTED', '2026-10-02'), event('3', 'EMPTY', '2026-10-03')];
    expect(() => assertLpgTimelineChange(before, [...before, event('1', 'STARTED')], '1')).toThrow(
      '2026-10-02',
    );
    expect(() => assertLpgTimelineChange(before, [before[1]])).toThrow('EMPTY requires');
  });

  it('preserves legacy conflicts but blocks new ones and allows safe explicit corrections', () => {
    const before = [event('1', 'EMPTY'), event('2', 'STARTED', '2026-10-02')];
    expect(() =>
      assertLpgTimelineChange(
        before,
        before.map((row) => ({ ...row, comment: 'Corrected note' })),
        '1',
      ),
    ).not.toThrow();
    expect(() => assertLpgTimelineChange(before, [before[1]])).not.toThrow();
    expect(() =>
      assertLpgTimelineChange(before, [...before, event('3', 'STARTED', '2026-10-03')], '3'),
    ).toThrow('already in use');
    expect(before[0].eventType).toBe('EMPTY');
  });
});
