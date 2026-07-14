import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { Service, signal } from '@angular/core';
import { CreditCard } from '../models/domain';
import { paymentDueDate, statementDateFor } from './billing-cycle';
import { formatMoney } from './money';

interface ReminderTarget {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly at: Date;
  readonly cardId: string;
  readonly kind: 'PAYMENT' | 'STATEMENT' | 'ANNUAL_FEE' | 'EXPIRY';
}

@Service()
export class NotificationService {
  private readonly channelId = 'card-nest-reminders';
  private readonly paymentOffsets = [10, 7, 3, 1, 0] as const;
  readonly permission = signal<'unavailable' | 'prompt' | 'denied' | 'granted'>('unavailable');
  readonly enabled = signal(false);
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
    this.enabled.set(status.display === 'granted');
    if (this.enabled()) await this.reschedule(cards, outstandingFor);
  }

  async requestPermission(
    cards: readonly CreditCard[],
    outstandingFor: (cardId: string) => number,
  ): Promise<boolean> {
    if (!this.isAndroid()) {
      this.permission.set('unavailable');
      return false;
    }
    try {
      const status = await LocalNotifications.requestPermissions();
      const granted = status.display === 'granted';
      this.permission.set(granted ? 'granted' : 'denied');
      this.enabled.set(granted);
      if (granted) {
        await this.ensureChannel();
        await this.reschedule(cards, outstandingFor);
      }
      this.lastError.set(null);
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
    try {
      const allIds = cards.flatMap((card) => this.notificationIds(card.id));
      if (allIds.length)
        await LocalNotifications.cancel({ notifications: allIds.map((id) => ({ id })) });

      const now = new Date();
      const targets = cards
        .filter((card) => !card.archived && card.remindToSettle)
        .flatMap((card) => this.targetsForCard(card, outstandingFor(card.id), now))
        .filter((target) => target.at.getTime() > now.getTime() + 30_000);

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
            schedule: { at: target.at, allowWhileIdle: false },
            extra: { source: 'card-nest', cardId: target.cardId, kind: target.kind },
          })),
        });
      }
      this.lastError.set(null);
    } catch {
      this.lastError.set(
        'Payment reminders could not be scheduled. Check Android notification settings.',
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
    this.enabled.set(false);
    if (!this.isAndroid()) return;
    const ids = cards.flatMap((card) => this.notificationIds(card.id));
    if (ids.length) await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
  }

  private targetsForCard(
    card: CreditCard,
    outstandingMinor: number,
    now: Date,
  ): readonly ReminderTarget[] {
    const statement = statementDateFor(now, card.statementDay);
    const due = paymentDueDate(statement, card);
    const maskedCard = `${card.nickname} ${card.network === 'AMERICAN_EXPRESS' ? '•••••' : '••••'} ${card.lastDigits}`;
    const amount = formatMoney(Math.max(0, outstandingMinor), card.currencyCode);
    const dueDisplay = due.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
    const baseId = this.baseId(card.id);

    const paymentTargets =
      outstandingMinor > 0
        ? this.paymentOffsets.map((daysBefore, index): ReminderTarget => {
            const at = new Date(due);
            at.setDate(at.getDate() - daysBefore);
            at.setHours(9, 0, 0, 0);
            return {
              id: baseId + index,
              title: daysBefore === 0 ? 'Payment due today' : 'Payment reminder',
              body: `${amount} is due for ${maskedCard} on ${dueDisplay}.`,
              at,
              cardId: card.id,
              kind: 'PAYMENT',
            };
          })
        : [];

    const statementAt = new Date(statement);
    statementAt.setHours(9, 0, 0, 0);
    const targets: ReminderTarget[] = [
      ...paymentTargets,
      {
        id: baseId + 5,
        title: 'Statement date',
        body: `A new statement is expected for ${maskedCard}.`,
        at: statementAt,
        cardId: card.id,
        kind: 'STATEMENT',
      },
    ];

    const annualFeeDate = this.nextAnnualFeeDate(card, now);
    if (annualFeeDate && card.annualFee) {
      const at = new Date(annualFeeDate);
      at.setDate(at.getDate() - 30);
      at.setHours(9, 0, 0, 0);
      if (at <= now) at.setTime(now.getTime() + 60_000);
      targets.push({
        id: baseId + 6,
        title: 'Annual fee reminder',
        body: `${formatMoney(card.annualFee.amountMinor, card.currencyCode)} annual fee is expected for ${maskedCard} on ${annualFeeDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}.`,
        at,
        cardId: card.id,
        kind: 'ANNUAL_FEE',
      });
    }

    const expiryDate = this.expiryReminderDate(card, now);
    if (expiryDate) {
      targets.push({
        id: baseId + 7,
        title: 'Card expiry reminder',
        body: `${maskedCard} expires in ${String(card.expiryMonth).padStart(2, '0')}/${card.expiryYear}.`,
        at: expiryDate,
        cardId: card.id,
        kind: 'EXPIRY',
      });
    }
    return targets;
  }

  private notificationIds(cardId: string): readonly number[] {
    const baseId = this.baseId(cardId);
    return Array.from({ length: 8 }, (_, index) => baseId + index);
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
      description: 'Masked payment, statement, annual-fee, and expiry reminders',
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
        9,
      );
    const thisYear = createDate(now.getFullYear());
    return thisYear > now ? thisYear : createDate(now.getFullYear() + 1);
  }

  private expiryReminderDate(card: CreditCard, now: Date): Date | null {
    if (!card.expiryMonth || !card.expiryYear) return null;
    const expires = new Date(card.expiryYear, card.expiryMonth, 0, 23, 59, 59);
    if (expires <= now) return null;
    const at = new Date(card.expiryYear, card.expiryMonth - 1, 1, 9);
    at.setMonth(at.getMonth() - 3);
    if (at <= now) at.setTime(now.getTime() + 60_000);
    return at;
  }

  private isAndroid(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  }
}
