import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { CreditCard } from '../models/domain';
import { SqliteDatabase } from '../data/sqlite-database';
import { NotificationService, UtilityNotificationTarget } from './notification.service';
import { CardExpiryService } from './card-expiry.service';

vi.hoisted(() => vi.resetModules());
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    createChannel: vi.fn(),
    checkPermissions: vi.fn(),
    cancel: vi.fn(),
    schedule: vi.fn(),
    getPending: vi.fn(),
  },
}));

describe('NotificationService combined card and utility schedule', () => {
  const card: CreditCard = {
    id: 'notification-fiction-card',
    nickname: 'Fictional card',
    issuerName: 'Fictional Bank',
    lastDigits: '4321',
    network: 'VISA',
    theme: 'green',
    statementDay: 1,
    dueDateMode: 'DAYS_AFTER_STATEMENT',
    daysAfterStatement: 45,
    adjustDueDateOnWeekend: false,
    currencyCode: 'INR',
    openingBalanceMinor: 0,
    remindToSettle: true,
    annualFeeEnabled: false,
    emergencyPhones: [],
    supportEmails: [],
    archived: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  let pending: { id: number; extra?: unknown; at?: Date }[] = [];
  let service: NotificationService;

  beforeEach(() => {
    pending = [];
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.mocked(LocalNotifications.createChannel).mockResolvedValue();
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue({ display: 'granted' });
    vi.mocked(LocalNotifications.cancel).mockImplementation(async ({ notifications }) => {
      const ids = new Set(notifications.map((item) => item.id));
      pending = pending.filter((item) => !ids.has(item.id));
    });
    vi.mocked(LocalNotifications.schedule).mockImplementation(async ({ notifications }) => {
      pending = notifications.map((item) => ({
        id: item.id,
        extra: item.extra,
        at: item.schedule?.at,
      }));
      return { notifications: pending as never };
    });
    vi.mocked(LocalNotifications.getPending).mockImplementation(async () => ({
      notifications: pending as never,
    }));
    TestBed.configureTestingModule({
      providers: [
        NotificationService,
        {
          provide: SqliteDatabase,
          useValue: {
            ready: () => true,
            query: async (_statement: string, values: readonly unknown[]) => [
              { encrypted_value: values[0] === 'notifications_payment_reminders' ? '1' : '5' },
            ],
            run: async () => 1,
          },
        },
        { provide: CardExpiryService, useValue: { date: () => new Date() } },
      ],
    });
    service = TestBed.inject(NotificationService);
  });

  afterEach(() => vi.restoreAllMocks());

  function localDateAfter(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  it('keeps card reminders when adding utilities and keeps utilities when card reminders are disabled', async () => {
    await service.initialise([card], () => 100_000);
    const scheduleDate = localDateAfter(3);
    const eventDate = localDateAfter(10);
    const utility: UtilityNotificationTarget = {
      id: `utility-profile:MOBILE_VOICE:${eventDate}:7`,
      profileId: 'utility-profile',
      kind: 'MOBILE_VOICE',
      scheduleDate,
      eventDate,
      title: 'Outgoing calling plan ending',
      body: 'Fictional Sam: recorded voice coverage ends soon.',
    };
    service.setUtilityReminders([utility]);
    await service.reschedule([card], () => 100_000);
    expect(
      pending.some((item) => (item.extra as { source?: string })?.source === 'card-nest'),
    ).toBe(true);
    expect(
      pending.some((item) => (item.extra as { source?: string })?.source === 'card-nest-utility'),
    ).toBe(true);
    const scheduledUtility = pending.find(
      (item) => (item.extra as { source?: string })?.source === 'card-nest-utility',
    );
    expect(
      `${scheduledUtility?.at?.getFullYear()}-${String((scheduledUtility?.at?.getMonth() ?? 0) + 1).padStart(2, '0')}-${String(scheduledUtility?.at?.getDate()).padStart(2, '0')}`,
    ).toBe(scheduleDate);
    expect(new Set(pending.map((item) => item.id)).size).toBe(pending.length);

    await service.cancelAll([card]);
    expect(service.enabled()).toBe(false);
    expect(pending).toHaveLength(1);
    expect((pending[0].extra as { source: string }).source).toBe('card-nest-utility');

    service.setUtilityReminders([]);
    await service.reschedule([card], () => 100_000);
    expect(pending).toEqual([]);
  });

  it('limits plugin-backed utility targets below the Android alarm ceiling without dropping card reminders', async () => {
    await service.initialise([card], () => 100_000);
    const targets = Array.from({ length: 500 }, (_, index) => {
      const scheduleDate = localDateAfter(10 + Math.floor(index / 4));
      return {
        id: `utility-profile-${index}:MOBILE_PLAN:${scheduleDate}:7`,
        profileId: `utility-profile-${index}`,
        kind: 'MOBILE_PLAN' as const,
        scheduleDate,
        eventDate: localDateAfter(17 + Math.floor(index / 4)),
        title: 'Mobile plan reminder',
        body: 'A recorded recharge plan is approaching its last active day. Check CardNest.',
      };
    });
    service.setUtilityReminders(targets);
    await service.reschedule([card], () => 100_000);

    expect(pending).toHaveLength(450);
    expect(
      pending.some((item) => (item.extra as { source?: string })?.source === 'card-nest'),
    ).toBe(true);
    expect(new Set(pending.map((item) => item.id)).size).toBe(pending.length);
  });
});
