import { DestroyRef, inject, Service, signal } from '@angular/core';

const INDIA_TIME_ZONE = 'Asia/Kolkata';

/** Returns the current calendar date in India, independent of the device time zone. */
export function indiaTodayIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** A noon local Date for safe calendar arithmetic on an ISO calendar date. */
export function indiaTodayDate(now = new Date()): Date {
  const [year, month, day] = indiaTodayIso(now).split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

export function indiaCurrentMonth(now = new Date()): string {
  return indiaTodayIso(now).slice(0, 7);
}

/** HH:mm:ss wall-clock time in India for an instant. */
export function indiaTimeOfDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: INDIA_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('hour')}:${value('minute')}:${value('second')}`;
}

@Service()
export class IndiaTodayClock {
  readonly today = signal(indiaTodayIso());
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    const refresh = () => this.refresh();
    const interval = globalThis.setInterval(refresh, 60_000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh);
    this.destroyRef.onDestroy(() => {
      globalThis.clearInterval(interval);
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', refresh);
    });
  }

  refresh(): void {
    const today = indiaTodayIso();
    if (today !== this.today()) this.today.set(today);
  }
}
