import { currentLocalCalendar, resolveDeviceTimeZone } from './device-date';

describe('device-local calendar with IST fallback', () => {
  const nativeOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  const deviceZone = (timeZone: string | undefined) =>
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...nativeOptions.call(this), timeZone } as Intl.ResolvedDateTimeFormatOptions;
    });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ['Asia/Kolkata', '2026-11-01', '2026-11', '00:30:00'],
    ['UTC', '2026-10-31', '2026-10', '19:00:00'],
    ['America/New_York', '2026-10-31', '2026-10', '15:00:00'],
    ['Pacific/Kiritimati', '2026-11-01', '2026-11', '09:00:00'],
  ])('uses the valid device timezone %s', (timeZone, dateIso, monthIso, timeOfDay) => {
    deviceZone(timeZone);
    expect(resolveDeviceTimeZone()).toBe(timeZone);
    expect(currentLocalCalendar(new Date('2026-10-31T19:00:00.000Z'))).toEqual({
      timeZone,
      dateIso,
      monthIso,
      timeOfDay,
    });
  });

  it.each([undefined, '', 'Invalid/Timezone'])(
    'falls back to IST for unavailable or invalid timezone %s',
    (timeZone) => {
      deviceZone(timeZone);
      expect(resolveDeviceTimeZone()).toBe('Asia/Kolkata');
      expect(currentLocalCalendar(new Date('2026-10-31T19:00:00.000Z'))).toEqual({
        timeZone: 'Asia/Kolkata',
        dateIso: '2026-11-01',
        monthIso: '2026-11',
        timeOfDay: '00:30:00',
      });
    },
  );

  it('falls back when timezone resolution throws', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => {
      throw new Error('Synthetic timezone resolution failure');
    });
    expect(resolveDeviceTimeZone()).toBe('Asia/Kolkata');
    expect(currentLocalCalendar(new Date('2026-12-31T19:00:00.000Z'))).toMatchObject({
      timeZone: 'Asia/Kolkata',
      dateIso: '2027-01-01',
      monthIso: '2027-01',
    });
  });

  it('can derive the IST calendar when Intl is unavailable', () => {
    vi.stubGlobal('Intl', undefined);
    expect(currentLocalCalendar(new Date('2028-02-28T19:00:00.000Z'))).toEqual({
      timeZone: 'Asia/Kolkata',
      dateIso: '2028-02-29',
      monthIso: '2028-02',
      timeOfDay: '00:30:00',
    });
  });

  it('uses IST if timezone-aware formatting throws', () => {
    deviceZone('America/New_York');
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(() => {
      throw new Error('Synthetic formatting failure');
    });
    expect(currentLocalCalendar(new Date('2026-10-31T19:00:00.000Z'))).toEqual({
      timeZone: 'Asia/Kolkata',
      dateIso: '2026-11-01',
      monthIso: '2026-11',
      timeOfDay: '00:30:00',
    });
  });

  it.each([
    ['2026-03-08T06:59:00Z', '2026-03-08', '01:59:00'],
    ['2026-03-08T07:00:00Z', '2026-03-08', '03:00:00'],
    ['2026-11-01T05:30:00Z', '2026-11-01', '01:30:00'],
    ['2026-11-01T06:30:00Z', '2026-11-01', '01:30:00'],
  ])('uses the actual New York DST offset at %s', (instant, dateIso, timeOfDay) => {
    deviceZone('America/New_York');
    expect(currentLocalCalendar(new Date(instant))).toMatchObject({ dateIso, timeOfDay });
  });

  it.each([
    ['2026-12-31T18:29:59Z', '2026-12-31'],
    ['2026-12-31T18:30:00Z', '2027-01-01'],
    ['2028-02-28T18:30:00Z', '2028-02-29'],
    ['2028-02-29T18:30:00Z', '2028-03-01'],
    ['2027-02-28T18:30:00Z', '2027-03-01'],
  ])('handles India calendar boundaries at %s', (instant, dateIso) => {
    deviceZone('Asia/Kolkata');
    expect(currentLocalCalendar(new Date(instant)).dateIso).toBe(dateIso);
  });

  it('resolves time and timezone afresh without a module reload', () => {
    const zone = deviceZone('Asia/Kolkata');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T18:29:59Z'));
    expect(currentLocalCalendar().dateIso).toBe('2026-10-31');
    vi.setSystemTime(new Date('2026-10-31T18:30:00Z'));
    expect(currentLocalCalendar().dateIso).toBe('2026-11-01');
    zone.mockReturnValue({ ...nativeOptions.call(new Intl.DateTimeFormat()), timeZone: 'UTC' });
    expect(currentLocalCalendar()).toMatchObject({ timeZone: 'UTC', dateIso: '2026-10-31' });
  });

  it('does not silently replace an invalid supplied instant with the current date', () => {
    expect(() => currentLocalCalendar(new Date('invalid'))).toThrow(RangeError);
  });
});
