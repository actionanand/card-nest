/** Recorded wall-clock time has no UTC offset. Never substitute receipt/creation time. */
export function recordedTransactionTime(
  time: string | undefined,
  enabled: boolean,
  locale?: string,
): string {
  if (!enabled || !time || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(time))
    return '';
  const [hours, minutes] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
}
