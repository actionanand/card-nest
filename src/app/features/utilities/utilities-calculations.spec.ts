import { LpgEvent, MobileRecharge } from './utilities-model';
import {
  addCalendarDays,
  calendarDaysBetween,
  lpgUsageSummary,
  mobileActivitySummary,
  suggestedVoicePlanStart,
} from './utilities-calculations';

const recharge = (id: string, changes: Partial<MobileRecharge> = {}): MobileRecharge => ({
  id,
  profileId: 'mobile-one',
  planType: 'VOICE_DATA',
  startDate: '2026-10-01',
  endDate: '2026-10-25',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...changes,
});
const lpgEvent = (id: string, eventType: LpgEvent['eventType'], eventDate: string): LpgEvent => ({
  id,
  profileId: 'lpg-one',
  eventType,
  eventDate,
  createdAt: `${eventDate}T10:00:00Z`,
  updatedAt: `${eventDate}T10:00:00Z`,
});

describe('Indian utility calendar calculations', () => {
  it('treats endDate as the inclusive last-active day and validity as whole active days', () => {
    expect(addCalendarDays('2026-10-01', 29)).toBe('2026-10-30');
    expect(calendarDaysBetween('2026-10-01', '2026-10-30')).toBe(29);
    const twentyFiveDays = addCalendarDays('2026-10-01', 25 - 1);
    expect(twentyFiveDays).toBe('2026-10-25');
    expect(mobileActivitySummary([recharge('today')], 'PREPAID', '2026-10-25').status).toBe(
      'ACTIVE',
    );
    expect(mobileActivitySummary([recharge('expired')], 'PREPAID', '2026-10-26').status).toBe(
      'NO_ACTIVE',
    );
  });

  it('distinguishes data from voice and does not mark postpaid inactive without recorded validity', () => {
    const dataOnly = recharge('data', { planType: 'DATA_ONLY', endDate: '2026-10-31' });
    const dataSummary = mobileActivitySummary([dataOnly], 'PREPAID', '2026-10-25');
    expect(dataSummary.status).toBe('ACTIVE');
    expect(dataSummary.dataActive).toBe(true);
    expect(dataSummary.callingCoverageActive).toBe(false);
    expect(
      mobileActivitySummary(
        [recharge('postpaid-old', { endDate: '2026-10-01' })],
        'POSTPAID',
        '2026-10-25',
      ),
    ).toMatchObject({
      status: 'UNKNOWN',
      daysWithoutCalling: null,
    });
  });

  it('merges queued voice plans across overlaps and consecutive days without a false early expiry', () => {
    const plans = [
      recharge('voice-a', { endDate: '2026-10-25' }),
      recharge('voice-b', { startDate: '2026-10-25', endDate: '2026-11-03' }),
      recharge('voice-c', { startDate: '2026-11-04', endDate: '2026-11-13' }),
      recharge('data', { planType: 'DATA_ONLY', startDate: '2026-10-25', endDate: '2026-11-30' }),
    ];
    const summary = mobileActivitySummary(plans, 'PREPAID', '2026-10-25');
    expect(summary.callingCoverageActive).toBe(true);
    expect(summary.callingCoverageEnd).toBe('2026-11-13');
    expect(summary.daysUntilCallingEnd).toBe(19);
    expect(suggestedVoicePlanStart(plans, '2026-10-25')).toBe('2026-11-14');
  });

  it('reports elapsed calling-plan gaps and scheduled-only coverage with recorded wording', () => {
    const expired = recharge('old', { endDate: '2026-10-20' });
    expect(mobileActivitySummary([expired], 'PREPAID', '2026-10-25')).toMatchObject({
      daysWithoutCalling: 5,
      daysSinceLastExpiredPlan: 5,
    });
    const scheduled = recharge('future', { startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(mobileActivitySummary([scheduled], 'PREPAID', '2026-10-25')).toMatchObject({
      status: 'SCHEDULED',
      callingCoverageActive: false,
      scheduledVoiceStart: '2026-11-01',
    });
  });

  it('starts outgoing-calling countdown on day ten and does not call it SIM disconnection', () => {
    const plan = recharge('voice-expiring', { startDate: '2026-10-01', endDate: '2026-10-30' });
    const summary = mobileActivitySummary([plan], 'PREPAID', '2026-10-20');
    expect(summary).toMatchObject({
      callingCoverageActive: true,
      callingCoverageEnd: '2026-10-30',
      daysUntilCallingEnd: 10,
    });
  });

  it('estimates LPG checks without confirming an empty cylinder and pairs empty/replacement separately', () => {
    const events = [
      lpgEvent('start', 'STARTED', '2026-10-01'),
      lpgEvent('delivery', 'REFILL_RECEIVED', '2026-10-10'),
    ];
    expect(lpgUsageSummary(events, 25, '2026-10-25')).toMatchObject({
      currentUsageDays: 25,
      estimatedDaysToCheck: 0,
      currentCylinderEmpty: false,
    });
    const completed = lpgUsageSummary(
      [
        ...events,
        lpgEvent('empty', 'EMPTY', '2026-10-25'),
        lpgEvent('replacement', 'REFILL_RECEIVED', '2026-10-27'),
      ],
      25,
      '2026-10-28',
    );
    expect(completed.currentUsageDays).toBeNull();
    expect(completed.currentCylinderEmpty).toBe(true);
    expect(completed.completedCylinderDurations).toEqual([25]);
    expect(completed.emptyToReplacementDays).toEqual([2]);
    expect(completed.refillsThisYear).toBe(2);
  });
});
