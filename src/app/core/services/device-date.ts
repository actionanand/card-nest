const IST_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60_000;

export interface LocalCalendar {
  readonly timeZone: string;
  readonly dateIso: string;
  readonly monthIso: string;
  readonly timeOfDay: string;
}

/** Trust a supported device timezone, including UTC. Never infer it from the UTC offset. */
export function resolveDeviceTimeZone(): string {
  try {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof timeZone !== 'string' || !timeZone.trim()) return IST_TIME_ZONE;
    // Validate the reported identifier without reading another current instant.
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return IST_TIME_ZONE;
  }
}

/** One instant and one freshly resolved timezone for a current-calendar decision. */
export function currentLocalCalendar(instant = new Date()): LocalCalendar {
  if (!Number.isFinite(instant.getTime())) throw new RangeError('Invalid calendar instant.');
  const timeZone = resolveDeviceTimeZone();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes): string => {
      const value = parts.find((item) => item.type === type)?.value;
      if (!value) throw new RangeError('Calendar parts are unavailable.');
      return value;
    };
    const monthIso = `${part('year')}-${part('month')}`;
    return {
      timeZone,
      dateIso: `${monthIso}-${part('day')}`,
      monthIso,
      timeOfDay: `${part('hour')}:${part('minute')}:${part('second')}`,
    };
  } catch {
    // Keep the approved fixed IST fallback usable even when Intl itself is unavailable.
    const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
    const two = (value: number) => String(value).padStart(2, '0');
    const monthIso = `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${two(shifted.getUTCMonth() + 1)}`;
    return {
      timeZone: IST_TIME_ZONE,
      dateIso: `${monthIso}-${two(shifted.getUTCDate())}`,
      monthIso,
      timeOfDay: `${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}:${two(shifted.getUTCSeconds())}`,
    };
  }
}
