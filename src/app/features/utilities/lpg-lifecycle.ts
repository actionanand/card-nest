import { validCalendarDate } from './utilities-calculations';
import { LpgEvent, LpgEventType } from './utilities-model';

export type LpgLifecycleState = 'UNSTARTED' | 'IN_USE' | 'EMPTY' | 'RECEIVED';

export function lpgLifecycle(events: readonly LpgEvent[]) {
  let state: LpgLifecycleState = 'UNSTARTED';
  const conflicts: { id: string; reason: string; message: string }[] = [];
  const ordered = [...events].sort(
    (left, right) =>
      left.eventDate.localeCompare(right.eventDate) ||
      left.createdAt.localeCompare(right.createdAt),
  );
  for (const event of ordered) {
    let reason = '';
    if (!validCalendarDate(event.eventDate)) reason = 'Invalid event date';
    else if (event.eventType === 'STARTED' && state === 'IN_USE')
      reason = 'A cylinder is already in use; record EMPTY before another STARTED';
    else if (event.eventType === 'EMPTY' && state !== 'IN_USE')
      reason = 'EMPTY requires a preceding cylinder STARTED that has not already been marked empty';
    else if (event.eventType === 'REFILL_RECEIVED' && (state === 'IN_USE' || state === 'RECEIVED'))
      reason =
        state === 'IN_USE'
          ? 'A refill cannot be received while the current cylinder is in use'
          : 'A refill receipt is already recorded; start that cylinder before another receipt';
    if (reason)
      conflicts.push({
        id: event.id,
        reason,
        message: `${event.eventType} on ${event.eventDate}: ${reason}. Correct the affected history first.`,
      });
    if (!validCalendarDate(event.eventDate)) continue;
    if (event.eventType === 'STARTED') state = 'IN_USE';
    else if (event.eventType === 'EMPTY') state = 'EMPTY';
    else if (event.eventType === 'REFILL_RECEIVED' && state !== 'IN_USE') state = 'RECEIVED';
  }
  return { state, conflicts };
}

export function assertLpgTimelineChange(
  before: readonly LpgEvent[],
  after: readonly LpgEvent[],
  changedId?: string,
): void {
  const previous = lpgLifecycle(before).conflicts;
  const original = before.find((event) => event.id === changedId);
  const updated = after.find((event) => event.id === changedId);
  const lifecycleChanged =
    !original ||
    original.eventDate !== updated?.eventDate ||
    original.eventType !== updated?.eventType;
  const conflict = lpgLifecycle(after).conflicts.find(
    (item) =>
      (item.id === changedId && lifecycleChanged) ||
      !previous.some((prior) => prior.id === item.id && prior.reason === item.reason),
  );
  if (conflict) throw new Error(conflict.message);
}

export function lpgEventChoices(
  events: readonly LpgEvent[],
  eventDate: string,
  id?: string,
): readonly LpgEventType[] {
  if (!validCalendarDate(eventDate)) return [];
  const previous = events.find((event) => event.id === id);
  const timestamp = new Date().toISOString();
  return (['STARTED', 'EMPTY', 'REFILL_RECEIVED'] as const).filter((eventType) => {
    const candidate: LpgEvent = {
      id: id ?? 'proposed-lpg-event',
      profileId: previous?.profileId ?? '',
      eventType,
      eventDate,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    try {
      assertLpgTimelineChange(
        events,
        previous
          ? events.map((event) => (event.id === id ? candidate : event))
          : [...events, candidate],
        candidate.id,
      );
      return true;
    } catch {
      return false;
    }
  });
}
