import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { inject, Service, signal } from '@angular/core';
import { CreditCard } from '../models/domain';
import { paymentDueDate, previousStatementDate, statementDateFor } from './billing-cycle';
import { formatMoney } from './money';
import { SqliteDatabase } from '../data/sqlite-database';
import {
  catchUpReminderToday,
  DEFAULT_REMINDER_DAYS_BEFORE,
  MAX_REMINDER_DAYS_BEFORE,
  normalizedReminderDays,
  paymentReminderOffsets,
  REMINDER_HOUR,
} from './notification-schedule';

const REMINDERS_ENABLED_KEY = 'notifications_payment_reminders';
const REMINDER_DAYS_BEFORE_KEY = 'notifications_reminder_days_before';

interface ReminderTarget {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly at: Date;
  readonly eventDate: Date;
  readonly cardId: string;
  readonly kind: 'PAYMENT' | 'ANNUAL_FEE' | 'EXPIRY';
}

interface NativeReminderBridge {
  replaceReminderSchedule(remindersJson: string): boolean;
  pendingReminderCount(): number;
  reminderChannelEnabled(): boolean;
  reminderScheduleError(): string;
}

interface NativeReminderWindow extends Window {
  CardNestNative?: NativeReminderBridge;
}

@Service()
export class NotificationService {
  private readonly database = inject(SqliteDatabase);
  private readonly channelId = 'card-nest-reminders';
  private rescheduleVersion = 0;
  private rescheduleQueue: Promise<void> = Promise.resolve();
  readonly permission = signal<'unavailable' | 'prompt' | 'denied' | 'granted'>('unavailable');
  readonly enabled = signal(false);
  readonly reminderDaysBefore = signal(DEFAULT_REMINDER_DAYS_BEFORE);
  readonly scheduledCount = signal(0);
  readonly lastError = signal<string | null>(null);

  async initialise(
    cards: readonly CreditCard[],
    outstandingFor: (cardId: string) => number,
  ): Promise<void> {
    if (!this.isAndroid()) return;
    await this.ensureChannel();
    const status = await LocalNotifications.checkPermissions();
    this.permission.set(
      status.display === 'granted' ? 'granted' : status.display === 'denied' ? 'denied' : 'prompt',
    );
    const [preference, reminderDaysBefore] = await Promise.all([
      this.readEnabledPreference(),
      this.readReminderDaysBeforePreference(),
    ]);
    this.reminderDaysBefore.set(reminderDaysBefore);
    this.enabled.set(status.display === 'granted' && (preference ?? true));
    if (this.enabled()) await this.reschedule(cards, outstandingFor);
  }

  async requestPermission(
    cards: readonly CreditCard[],
    outstandingFor: (cardId: string) => number,
  ): Promise<boolean> {
    if (!this.isAndroid()) {
      this.permission.set('unavailable');
      this.enabled.set(false);
      this.lastError.set('Payment notifications are available in the Android app.');
      return false;
    }
    try {
      const status = await LocalNotifications.requestPermissions();
      const granted = status.display === 'granted';
      this.permission.set(granted ? 'granted' : 'denied');
      this.enabled.set(granted);
      if (granted) {
        this.lastError.set(null);
        await this.writeEnabledPreference(true);
        await this.ensureChannel();
        await this.reschedule(cards, outstandingFor);
      } else {
        this.lastError.set('Android notification permission was not granted.');
      }
      return granted;
    } catch {
      this.permission.set('denied');
      this.enabled.set(false);
      this.lastError.set('Android notification permission could not be requested.');
      return false;
    }
  }

  async shouldRequestNotificationPermission(): Promise<boolean> {
    if (!this.isAndroid()) return false;

    try {
      const status = await LocalNotifications.checkPermissions();
      return status.display !== 'granted';
    } catch {
      this.lastError.set('Android notification permission could not be checked.');
      return false;
    }
  }

  async reschedule(
    cards: readonly CreditCard[],
    outstandingFor: (cardId: string) => number,
  ): Promise<void> {
    if (!this.isAndroid() || this.permission() !== 'granted' || !this.enabled()) return;
    const version = ++this.rescheduleVersion;
    const cardBalances = cards.map((card) => ({ card, dueMinor: outstandingFor(card.id) }));
    const operation = this.rescheduleQueue.then(async () => {
      if (version !== this.rescheduleVersion) return;
      await this.performReschedule(cardBalances);
    });
    this.rescheduleQueue = operation.catch(() => undefined);
    await operation;
  }

  async setReminderDaysBefore(
    days: number,
    cards: readonly CreditCard[],
    outstandingFor: (cardId: string) => number,
  ): Promise<void> {
    const safeDays = normalizedReminderDays(days);
    this.reminderDaysBefore.set(safeDays);
    await this.writeReminderDaysBeforePreference(safeDays);
    await this.reschedule(cards, outstandingFor);
  }

  private async performReschedule(
    cardBalances: readonly { readonly card: CreditCard; readonly dueMinor: number }[],
  ): Promise<void> {
    try {
      const now = new Date();
      const targets = cardBalances
        .filter(({ card }) => !card.archived)
        .flatMap(({ card, dueMinor }) => this.targetsForCard(card, dueMinor, now))
        .filter((target) => target.at.getTime() > now.getTime() + 30_000);
      const nativeBridge = this.nativeReminderBridge();
      if (nativeBridge) {
        const accepted = nativeBridge.replaceReminderSchedule(
          JSON.stringify(
            targets.map((target) => ({
              id: target.id,
              title: target.title,
              body: target.body,
              cardId: target.cardId,
              kind: target.kind,
              atMillis: target.at.getTime(),
              year: target.at.getFullYear(),
              month: target.at.getMonth() + 1,
              day: target.at.getDate(),
              hour: target.at.getHours(),
              minute: target.at.getMinutes(),
              eventYear: target.eventDate.getFullYear(),
              eventMonth: target.eventDate.getMonth() + 1,
              eventDay: target.eventDate.getDate(),
            })),
          ),
        );
        if (!accepted) {
          throw new Error(
            nativeBridge.reminderScheduleError() ||
              'Android could not store the CardNest reminder schedule.',
          );
        }
        if (!nativeBridge.reminderChannelEnabled()) {
          throw new Error(
            'The CardNest reminder notification channel is disabled in Android settings.',
          );
        }
        const pendingCount = nativeBridge.pendingReminderCount();
        if (pendingCount !== targets.length) {
          throw new Error('Android did not retain the complete CardNest reminder schedule.');
        }

        await this.cancelLegacyPluginReminders(cardBalances.map(({ card }) => card));
        this.scheduledCount.set(pendingCount);
        this.lastError.set(null);
        return;
      }

      const pending = await LocalNotifications.getPending();
      const pendingCardNestIds = pending.notifications
        .filter((notification) => this.isCardNestExtra(notification.extra))
        .map((notification) => notification.id);
      const knownIds = cardBalances.flatMap(({ card }) => this.notificationIds(card.id));
      const allIds = [...new Set([...pendingCardNestIds, ...knownIds])];
      if (allIds.length) {
        await LocalNotifications.cancel({ notifications: allIds.map((id) => ({ id })) });
      }

      if (targets.length) {
        await LocalNotifications.schedule({
          notifications: targets.map((target) => ({
            id: target.id,
            title: target.title,
            body: target.body,
            channelId: this.channelId,
            smallIcon: 'ic_stat_card_nest',
            largeIcon: 'ic_launcher',
            autoCancel: true,
            schedule: { at: target.at, allowWhileIdle: true },
            extra: { source: 'card-nest', cardId: target.cardId, kind: target.kind },
          })),
        });
      }
      const scheduled = await LocalNotifications.getPending();
      const scheduledIds = new Set(
        scheduled.notifications
          .filter((notification) => this.isCardNestExtra(notification.extra))
          .map((notification) => notification.id),
      );
      if (targets.some((target) => !scheduledIds.has(target.id))) {
        throw new Error('One or more Android reminders were not retained by the scheduler.');
      }
      this.scheduledCount.set(scheduledIds.size);
      this.lastError.set(null);
    } catch (error: unknown) {
      this.lastError.set(
        error instanceof Error && error.message
          ? error.message
          : 'Payment reminders could not be scheduled. Check Android notification settings.',
      );
    }
  }

  async cancelForCard(cardId: string): Promise<void> {
    if (!this.isAndroid()) return;
    await LocalNotifications.cancel({
      notifications: this.notificationIds(cardId).map((id) => ({ id })),
    });
  }

  async cancelAll(cards: readonly CreditCard[]): Promise<void> {
    ++this.rescheduleVersion;
    await this.rescheduleQueue;
    this.enabled.set(false);
    this.scheduledCount.set(0);
    await this.writeEnabledPreference(false);
    if (!this.isAndroid()) return;
    const nativeBridge = this.nativeReminderBridge();
    if (nativeBridge && !nativeBridge.replaceReminderSchedule('[]')) {
      this.lastError.set(
        nativeBridge.reminderScheduleError() || 'Android reminders could not be cleared.',
      );
    }
    const pending = await LocalNotifications.getPending();
    const ids = [
      ...new Set([
        ...cards.flatMap((card) => this.notificationIds(card.id)),
        ...pending.notifications
          .filter((notification) => this.isCardNestExtra(notification.extra))
          .map((notification) => notification.id),
      ]),
    ];
    if (ids.length) await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
  }

  private targetsForCard(
    card: CreditCard,
    outstandingMinor: number,
    now: Date,
  ): readonly ReminderTarget[] {
    const nextStatement = statementDateFor(now, card.statementDay);
    const statement =
      outstandingMinor > 0 && nextStatement.getTime() > now.getTime()
        ? previousStatementDate(nextStatement, card.statementDay)
        : nextStatement;
    const due = paymentDueDate(statement, card);
    const cardLabel = `${card.nickname} ${card.lastDigits}`;
    const amount = formatMoney(Math.max(0, outstandingMinor), card.currencyCode);
    const dueDisplay = due.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
    const baseId = this.baseId(card.id);
    const paymentOffsets = paymentReminderOffsets(this.reminderDaysBefore());
    const paymentTargets =
      card.remindToSettle && outstandingMinor > 0
        ? paymentOffsets.map((daysBefore, index): ReminderTarget => {
            const at = new Date(due);
            at.setDate(at.getDate() - daysBefore);
            const scheduledAt = catchUpReminderToday(at, now);
            return {
              id: baseId + index,
              title: this.countdownTitle('Payment due', daysBefore),
              body: `${amount} is due for ${cardLabel} on ${dueDisplay}.`,
              at: scheduledAt,
              eventDate: due,
              cardId: card.id,
              kind: 'PAYMENT',
            };
          })
        : [];

    const targets: ReminderTarget[] = [...paymentTargets];

    const annualFeeDate = this.nextAnnualFeeDate(card, now);
    if (annualFeeDate && card.annualFee) {
      const at = new Date(annualFeeDate);
      at.setDate(at.getDate() - 30);
      at.setHours(REMINDER_HOUR, 0, 0, 0);
      if (at <= now) at.setTime(now.getTime() + 60_000);
      const daysUntilFee = this.calendarDaysBetween(at, annualFeeDate);
      targets.push({
        id: baseId + 6,
        title: this.countdownTitle('Annual fee due', daysUntilFee),
        body: `${formatMoney(card.annualFee.amountMinor, card.currencyCode)} annual fee is due for ${cardLabel} on ${annualFeeDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}.`,
        at,
        eventDate: annualFeeDate,
        cardId: card.id,
        kind: 'ANNUAL_FEE',
      });
    }

    const expiryDate = this.expiryReminderDate(card, now);
    if (expiryDate && card.expiryMonth && card.expiryYear) {
      const expires = new Date(card.expiryYear, card.expiryMonth, 0, 23, 59, 59);
      const daysUntilExpiry = this.calendarDaysBetween(expiryDate, expires);
      targets.push({
        id: baseId + 7,
        title: this.countdownTitle('Card expires', daysUntilExpiry),
        body: `${cardLabel} expires in ${String(card.expiryMonth).padStart(2, '0')}/${card.expiryYear}.`,
        at: expiryDate,
        eventDate: expires,
        cardId: card.id,
        kind: 'EXPIRY',
      });
    }
    return targets;
  }

  private countdownTitle(subject: string, days: number): string {
    if (days <= 0) return `${subject} today`;
    if (days === 1) return `${subject} tomorrow`;
    return `${subject} in ${days} days`;
  }

  private calendarDaysBetween(from: Date, to: Date): number {
    const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
    const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.max(0, Math.round((toDay - fromDay) / 86_400_000));
  }

  private notificationIds(cardId: string): readonly number[] {
    const baseId = this.baseId(cardId);
    return Array.from({ length: MAX_REMINDER_DAYS_BEFORE + 3 }, (_, index) => baseId + index);
  }

  private isCardNestExtra(extra: unknown): boolean {
    return (
      typeof extra === 'object' &&
      extra !== null &&
      (extra as Record<string, unknown>)['source'] === 'card-nest'
    );
  }

  private baseId(cardId: string): number {
    let hash = 0;
    for (const character of cardId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
    return 1_000_000_000 + (Math.abs(hash) % 100_000_000) * 10;
  }

  private async ensureChannel(): Promise<void> {
    await LocalNotifications.createChannel({
      id: this.channelId,
      name: 'Card and payment reminders',
      description: 'Masked statement-due, annual-fee, and expiry reminders',
      importance: 4,
      visibility: 0,
      lights: true,
      lightColor: '#28684e',
      vibration: true,
    });
  }

  private nextAnnualFeeDate(card: CreditCard, now: Date): Date | null {
    if (!card.annualFeeEnabled || !card.annualFee) return null;
    const { renewalMonth, renewalDay } = card.annualFee;
    const createDate = (year: number) =>
      new Date(
        year,
        renewalMonth - 1,
        Math.min(renewalDay, new Date(year, renewalMonth, 0).getDate()),
        23,
        59,
        59,
        999,
      );
    const thisYear = createDate(now.getFullYear());
    return thisYear > now ? thisYear : createDate(now.getFullYear() + 1);
  }

  private expiryReminderDate(card: CreditCard, now: Date): Date | null {
    if (!card.expiryMonth || !card.expiryYear) return null;
    const expires = new Date(card.expiryYear, card.expiryMonth, 0, 23, 59, 59);
    if (expires <= now) return null;
    const at = new Date(expires);
    at.setDate(at.getDate() - 45);
    at.setHours(REMINDER_HOUR, 0, 0, 0);
    if (at <= now) at.setTime(now.getTime() + 60_000);
    return at;
  }

  private isAndroid(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  }

  private nativeReminderBridge(): NativeReminderBridge | undefined {
    return (globalThis.window as NativeReminderWindow | undefined)?.CardNestNative;
  }

  private async cancelLegacyPluginReminders(cards: readonly CreditCard[]): Promise<void> {
    try {
      const pending = await LocalNotifications.getPending();
      const ids = [
        ...new Set([
          ...cards.flatMap((card) => this.notificationIds(card.id)),
          ...pending.notifications
            .filter((notification) => this.isCardNestExtra(notification.extra))
            .map((notification) => notification.id),
        ]),
      ];
      if (ids.length) {
        await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
      }
    } catch {
      // The native schedule is authoritative. A legacy-plugin cleanup failure must not disable it.
    }
  }

  private async readEnabledPreference(): Promise<boolean | null> {
    if (!this.database.ready()) return null;
    const rows = await this.database.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key = ?',
      [REMINDERS_ENABLED_KEY],
    );
    const value = rows[0]?.encrypted_value;
    return value === undefined ? null : value === '1';
  }

  private async writeEnabledPreference(enabled: boolean): Promise<void> {
    if (!this.database.ready()) return;
    await this.database.run(
      `INSERT INTO app_preferences (key, encrypted_value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
      [REMINDERS_ENABLED_KEY, enabled ? '1' : '0'],
    );
  }

  private async readReminderDaysBeforePreference(): Promise<number> {
    if (!this.database.ready()) return DEFAULT_REMINDER_DAYS_BEFORE;
    const rows = await this.database.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key = ?',
      [REMINDER_DAYS_BEFORE_KEY],
    );
    return normalizedReminderDays(Number(rows[0]?.encrypted_value));
  }

  private async writeReminderDaysBeforePreference(days: number): Promise<void> {
    if (!this.database.ready()) return;
    await this.database.run(
      `INSERT INTO app_preferences (key, encrypted_value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
      [REMINDER_DAYS_BEFORE_KEY, String(days)],
    );
  }
}
