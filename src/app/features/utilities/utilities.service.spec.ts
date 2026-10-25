import { TestBed } from '@angular/core/testing';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { normalizeIndianMobileNumber } from './utilities.service';
import { UtilitiesService } from './utilities.service';
import { addCalendarDays } from './utilities-calculations';

describe('Indian Utilities phone normalization', () => {
  it('stores optional Indian mobile numbers in normalized +91 form', () => {
    expect(normalizeIndianMobileNumber('9876543210')).toBe('+91-9876543210');
    expect(normalizeIndianMobileNumber('+91 98765 43210')).toBe('+91-9876543210');
    expect(normalizeIndianMobileNumber('+91 (98765) 43210')).toBe('+91-9876543210');
    expect(normalizeIndianMobileNumber('+91-98765-43210')).toBe('+91-9876543210');
    expect(normalizeIndianMobileNumber('')).toBeUndefined();
  });

  it('rejects short, long and non-mobile Indian numbers', () => {
    for (const value of [
      '12345',
      '1234567890',
      '+1 9876543210',
      '+91 0123456789',
      '98765432101',
      'name9876543210',
      '+91 abc 98765 43210',
      '91 98765 43210',
      '+91 98765)43210',
      '0091 9876543210',
    ])
      expect(() => normalizeIndianMobileNumber(value)).toThrow();
  });
});

describe('Indian Utilities service', () => {
  let utilities: UtilitiesService;
  const database = {
    ready: () => true,
    query: vi.fn(async () => []),
    run: vi.fn(async () => 1),
    atomic: vi.fn(async (work: (tx: { run: () => Promise<number> }) => Promise<unknown>) =>
      work({ run: async () => 1 }),
    ),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [UtilitiesService, { provide: SqliteDatabase, useValue: database }],
    });
    utilities = TestBed.inject(UtilitiesService);
  });

  it('schedules 28-day mobile and 25-day LPG reminders immediately after saving records', async () => {
    const today = '2026-10-26';
    await utilities.setUtilityReminders(true);
    const mobile = await utilities.saveMobileProfile({
      personName: 'Fictional User',
      subscriptionType: 'PREPAID',
      operator: 'JIO',
    });
    const plan = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'VOICE_DATA',
      startDate: today,
      validityDays: 28,
    });
    const lpg = await utilities.saveLpgProfile({
      connectionName: 'Fictional home',
      provider: 'INDANE',
      commercial: false,
      cylinderSize: 'NORMAL',
      estimatedUsageDays: 25,
    });
    await utilities.saveLpgEvent({ profileId: lpg.id, eventType: 'STARTED', eventDate: today });

    const targets = utilities.reminderTargets(today);
    const mobileTargets = targets.filter((target) => target.kind === 'MOBILE_VOICE');
    const lpgTargets = targets.filter((target) => target.kind === 'LPG_ESTIMATE');
    expect(mobileTargets.map((target) => target.scheduleDate)).toEqual([
      addCalendarDays(plan.endDate, -7),
      addCalendarDays(plan.endDate, -3),
      addCalendarDays(plan.endDate, -1),
      plan.endDate,
    ]);
    expect(mobileTargets.every((target) => target.eventDate === plan.endDate)).toBe(true);
    const estimatedCheckDate = addCalendarDays(today, 24);
    expect(lpgTargets.map((target) => target.scheduleDate)).toEqual([
      addCalendarDays(estimatedCheckDate, -7),
      addCalendarDays(estimatedCheckDate, -3),
      addCalendarDays(estimatedCheckDate, -1),
      estimatedCheckDate,
    ]);
    expect(lpgTargets.every((target) => target.title === 'Estimated LPG check')).toBe(true);
    expect(lpgTargets.every((target) => target.body.includes('estimate only'))).toBe(true);
  });

  it('schedules only uninterrupted voice coverage and supports Data-only plan reminders', async () => {
    const today = '2026-10-26';
    await utilities.setUtilityReminders(true);
    const mobile = await utilities.saveMobileProfile({
      personName: 'Fictional User',
      subscriptionType: 'PREPAID',
      operator: 'JIO',
    });
    const firstPlan = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'VOICE_DATA',
      startDate: today,
      validityDays: 28,
    });
    const queuedPlan = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'VOICE_ONLY',
      startDate: addCalendarDays(firstPlan.endDate, 1),
      validityDays: 28,
    });
    const dataPlan = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'DATA_ONLY',
      startDate: today,
      validityDays: 40,
    });

    const targets = utilities.reminderTargets(today);
    expect(
      targets.filter((target) => target.kind === 'MOBILE_VOICE').map((target) => target.eventDate),
    ).toEqual([queuedPlan.endDate, queuedPlan.endDate, queuedPlan.endDate, queuedPlan.endDate]);
    expect(
      targets.filter((target) => target.kind === 'MOBILE_VOICE').map((target) => target.eventDate),
    ).not.toContain(firstPlan.endDate);
    expect(
      targets.filter((target) => target.kind === 'MOBILE_PLAN').map((target) => target.eventDate),
    ).toEqual([dataPlan.endDate, dataPlan.endDate, dataPlan.endDate, dataPlan.endDate]);
  });

  it('schedules queued-only voice reminders without notifying before the plan starts', async () => {
    const today = '2026-10-26';
    await utilities.setUtilityReminders(true);
    const mobile = await utilities.saveMobileProfile({
      personName: 'Fictional User',
      subscriptionType: 'PREPAID',
      operator: 'JIO',
    });
    const plan = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'VOICE_ONLY',
      startDate: addCalendarDays(today, 25),
      validityDays: 3,
    });

    const targets = utilities
      .reminderTargets(today)
      .filter((target) => target.kind === 'MOBILE_VOICE');
    expect(targets.map((target) => target.scheduleDate)).toEqual([
      addCalendarDays(plan.endDate, -1),
      plan.endDate,
    ]);
    expect(targets.every((target) => target.scheduleDate >= plan.startDate)).toBe(true);
  });

  it('validates optional numbers when saving mobile and LPG profiles', async () => {
    const mobile = await utilities.saveMobileProfile({
      personName: 'Fictional User',
      subscriptionType: 'PREPAID',
      operator: 'JIO',
      mobileNumber: '+91 98765 43210',
    });
    expect(mobile.mobileNumber).toBe('+91-9876543210');
    const mobileWithoutNumber = await utilities.saveMobileProfile({
      personName: 'No Number User',
      subscriptionType: 'PREPAID',
      operator: 'JIO',
      mobileNumber: '',
    });
    expect(mobileWithoutNumber.mobileNumber).toBeUndefined();
    await expect(
      utilities.saveMobileProfile({
        personName: 'Another User',
        subscriptionType: 'POSTPAID',
        operator: 'AIRTEL',
        mobileNumber: 'Sam 9876543210',
      }),
    ).rejects.toThrow();
    const lpg = await utilities.saveLpgProfile({
      connectionName: 'Fictional home',
      provider: 'INDANE',
      commercial: false,
      cylinderSize: 'NORMAL',
      estimatedUsageDays: 25,
      distributorContact: '+91-98765-43210',
    });
    expect(lpg.distributorContact).toBe('+91-9876543210');
    const lpgWithoutContact = await utilities.saveLpgProfile({
      connectionName: 'No contact home',
      provider: 'INDANE',
      commercial: false,
      cylinderSize: 'NORMAL',
      estimatedUsageDays: 25,
    });
    expect(lpgWithoutContact.distributorContact).toBeUndefined();
    await expect(
      utilities.saveLpgProfile({
        connectionName: 'Another home',
        provider: 'INDANE',
        commercial: false,
        cylinderSize: 'NORMAL',
        estimatedUsageDays: 25,
        distributorWhatsApp: 'Call 9876543210',
      }),
    ).rejects.toThrow();
  });
});
