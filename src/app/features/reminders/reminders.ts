import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CreditCard } from '../../core/models/domain';
import {
  daysBetween,
  gracePeriodEndDate,
  gracePeriodBreakdown,
  paymentDueDate,
  previousStatementDate,
  statementDateFor,
} from '../../core/services/billing-cycle';
import { CardNestStore } from '../../core/services/card-nest-store';
import { DateFormatService } from '../../core/services/date-format.service';
import { CardExpiryService } from '../../core/services/card-expiry.service';
import { formatMoney } from '../../core/services/money';
import { NotificationService } from '../../core/services/notification.service';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';

type ReminderFilter = 'ALL' | 'DUE' | 'CREDIT' | 'GRACE' | 'FEE' | 'EXPIRING';
type LinkedPaymentMode = 'DUE' | 'OUTSTANDING';

interface PaymentReminder {
  readonly id: string;
  readonly card: CreditCard;
  readonly due: Date;
  readonly days: number;
  readonly amount: number;
  readonly outstanding: number;
  readonly grace: number;
  readonly graceStatementDays: number;
  readonly gracePaymentDays: number;
  readonly graceEndDate: Date;
  readonly expiry: Date | null;
  readonly expiryDays: number | null;
  readonly feeDue: Date | null;
  readonly feeDays: number | null;
}

interface DueAmountSummary {
  readonly currencyCode: string;
  readonly total: number;
  readonly totalCount: number;
  readonly immediate: number;
  readonly immediateCount: number;
  readonly withinTenDays: number;
  readonly withinTenDaysCount: number;
  readonly later: number;
  readonly laterCount: number;
}

@Component({
  selector: 'app-reminders-page',
  imports: [AppIcon, ConfirmationDialog, RouterLink, AppSelectPicker],
  templateUrl: './reminders.html',
  styleUrl: './reminders.scss',
})
export class RemindersPage {
  readonly store = inject(CardNestStore);
  readonly notifications = inject(NotificationService);
  private readonly snackbar = inject(SnackbarService);
  private readonly dates = inject(DateFormatService);
  private readonly cardExpiry = inject(CardExpiryService);
  readonly filter = signal<ReminderFilter>('DUE');
  readonly filterOptions: readonly AppSelectOption[] = [
    { value: 'DUE', label: 'Statement amount due' },
    { value: 'CREDIT', label: 'Extra credit at bank' },
    { value: 'GRACE', label: 'Longest grace period' },
    { value: 'FEE', label: 'Annual fee due' },
    { value: 'EXPIRING', label: 'Expiring soon' },
    { value: 'ALL', label: 'All cards' },
  ];
  readonly paymentCandidate = signal<PaymentReminder | null>(null);
  readonly linkedBalanceCard = signal<CreditCard | null>(null);
  readonly linkedPaymentCandidate = signal<{
    readonly card: CreditCard;
    readonly mode: LinkedPaymentMode;
  } | null>(null);
  readonly snoozeCandidate = signal<PaymentReminder | null>(null);
  readonly revealedAction = signal<{
    readonly id: string;
    readonly action: 'PAYMENT' | 'SNOOZE';
  } | null>(null);
  readonly swipeDrag = signal<{ readonly id: string; readonly offset: number } | null>(null);
  private swipeStart: {
    readonly id: string;
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    horizontal: boolean;
  } | null = null;

  readonly allReminders = computed<readonly PaymentReminder[]>(() =>
    this.store
      .activeCards()
      .map((card) => this.toReminder(card))
      .filter((item) => {
        if (this.filter() === 'ALL' || this.filter() === 'GRACE') return true;
        if (this.filter() === 'DUE') return item.amount > 0;
        if (this.filter() === 'CREDIT') return item.outstanding < 0;
        if (this.filter() === 'FEE') return item.feeDue !== null;
        return item.expiryDays !== null && item.expiryDays >= 0 && item.expiryDays <= 90;
      })
      .sort((a, b) => {
        if (this.filter() === 'GRACE') return b.graceEndDate.getTime() - a.graceEndDate.getTime();
        if (this.filter() === 'EXPIRING')
          return (a.expiryDays ?? Infinity) - (b.expiryDays ?? Infinity);
        if (this.filter() === 'FEE') return (a.feeDays ?? Infinity) - (b.feeDays ?? Infinity);
        if (this.filter() === 'CREDIT') return a.outstanding - b.outstanding;
        return a.days - b.days;
      }),
  );

  readonly reminders = computed(() =>
    this.allReminders().filter(
      (item) =>
        !this.store.snoozedReminderCardIds().includes(item.id) &&
        (this.filter() !== 'DUE' || item.days <= 10),
    ),
  );
  readonly upcomingReminders = computed(() =>
    this.filter() === 'DUE'
      ? this.allReminders().filter(
          (item) => !this.store.snoozedReminderCardIds().includes(item.id) && item.days > 10,
        )
      : [],
  );
  readonly snoozedReminders = computed(() =>
    this.allReminders().filter((item) => this.store.snoozedReminderCardIds().includes(item.id)),
  );
  readonly overdueCount = computed(
    () => this.allReminders().filter((item) => item.amount > 0 && item.days < 0).length,
  );
  readonly annualFeeCount = computed(
    () => this.store.activeCards().filter((card) => card.annualFeeEnabled).length,
  );
  readonly dueAmountSummary = computed<DueAmountSummary>(() => {
    const dueItems = this.allReminders().filter((item) => item.amount > 0);
    const immediateItems = dueItems.filter((item) => item.days <= 3);
    const withinTenDaysItems = dueItems.filter((item) => item.days > 3 && item.days <= 10);
    const laterItems = dueItems.filter((item) => item.days > 10);
    const sum = (items: readonly PaymentReminder[]) =>
      items.reduce((total, item) => total + item.amount, 0);

    return {
      currencyCode: dueItems[0]?.card.currencyCode ?? 'INR',
      total: sum(dueItems),
      totalCount: dueItems.length,
      immediate: sum(immediateItems),
      immediateCount: immediateItems.length,
      withinTenDays: sum(withinTenDaysItems),
      withinTenDaysCount: withinTenDaysItems.length,
      later: sum(laterItems),
      laterCount: laterItems.length,
    };
  });

  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }

  date(value: Date): string {
    return this.dates.format(value);
  }

  linkedAccountCards(card: CreditCard): readonly CreditCard[] {
    if (!card.relationshipGroupId) return [card];
    return this.store
      .cards()
      .filter(
        (candidate) =>
          !candidate.deletedAt && candidate.relationshipGroupId === card.relationshipGroupId,
      )
      .sort((left, right) =>
        left.nickname.localeCompare(right.nickname, undefined, { sensitivity: 'base' }),
      );
  }

  hasLinkedAccount(card: CreditCard): boolean {
    return this.linkedAccountCards(card).length > 1;
  }

  linkedCardDue(card: CreditCard): number {
    return this.store.cardDueAmount(card.id);
  }

  linkedCardOutstanding(card: CreditCard): number {
    return Math.max(0, this.store.cardOutstanding(card.id));
  }

  linkedDueTotal(card: CreditCard): number {
    return this.linkedAccountCards(card).reduce(
      (total, linkedCard) => total + this.linkedCardDue(linkedCard),
      0,
    );
  }

  linkedOutstandingTotal(card: CreditCard): number {
    return this.linkedAccountCards(card).reduce(
      (total, linkedCard) => total + this.linkedCardOutstanding(linkedCard),
      0,
    );
  }

  openLinkedBalance(card: CreditCard): void {
    if (this.hasLinkedAccount(card)) this.linkedBalanceCard.set(card);
  }

  closeLinkedBalanceFromBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.linkedBalanceCard.set(null);
  }

  requestLinkedPayment(card: CreditCard, mode: LinkedPaymentMode): void {
    const amount = mode === 'DUE' ? this.linkedDueTotal(card) : this.linkedOutstandingTotal(card);
    if (amount <= 0) return;
    this.linkedPaymentCandidate.set({ card, mode });
  }

  confirmLinkedPayment(): void {
    const candidate = this.linkedPaymentCandidate();
    if (!candidate) return;
    let recordedTotal = 0;
    let paidCards = 0;
    for (const card of this.linkedAccountCards(candidate.card)) {
      const amount =
        candidate.mode === 'DUE' ? this.linkedCardDue(card) : this.linkedCardOutstanding(card);
      if (amount <= 0) continue;
      this.store.recordPayment(
        card.id,
        amount,
        candidate.mode === 'DUE' ? 'Linked account due payment' : 'Linked account outstanding paid',
      );
      recordedTotal += amount;
      paidCards += 1;
    }
    this.linkedPaymentCandidate.set(null);
    this.linkedBalanceCard.set(null);
    this.snackbar.show(
      `${this.money(recordedTotal, candidate.card.currencyCode)} recorded across ${paidCards} ${paidCards === 1 ? 'card' : 'cards'}.`,
    );
  }

  urgency(item: PaymentReminder): 'overdue' | 'urgent' | 'soon' | 'comfortable' {
    if (item.days < 0) return 'overdue';
    if (item.days <= 3) return 'urgent';
    if (item.days <= 8) return 'soon';
    return 'comfortable';
  }

  timingLabel(item: PaymentReminder): string {
    if (item.days < 0)
      return `${Math.abs(item.days)} ${Math.abs(item.days) === 1 ? 'day' : 'days'} overdue`;
    if (item.days === 0) return 'Due today';
    return `${item.days} ${item.days === 1 ? 'day' : 'days'} left`;
  }

  reminderTitle(item: PaymentReminder): string {
    return item.card.nickname;
  }

  reminderHeading(): string {
    switch (this.filter()) {
      case 'DUE':
        return 'Statement due reminders';
      case 'CREDIT':
        return 'Cards with extra bank credit';
      case 'GRACE':
        return 'Grace-period overview';
      case 'FEE':
        return 'Annual fee reminders';
      case 'EXPIRING':
        return 'Card expiry reminders';
      default:
        return 'Current card reminders';
    }
  }

  reminderDetail(item: PaymentReminder): string {
    if (this.filter() === 'EXPIRING' && item.expiry) return `Expires ${this.date(item.expiry)}`;
    if (this.filter() === 'FEE' && item.feeDue) return `Renews ${this.date(item.feeDue)}`;
    if (this.filter() === 'GRACE') {
      return `Pay by ${this.date(item.graceEndDate)} · ${this.graceLabel(item)}`;
    }
    return `•••• ${item.card.lastDigits} · Due ${this.date(item.due)}`;
  }

  displayDate(item: PaymentReminder): Date {
    if (this.filter() === 'EXPIRING' && item.expiry) return item.expiry;
    if (this.filter() === 'FEE' && item.feeDue) return item.feeDue;
    return item.due;
  }

  reminderValue(item: PaymentReminder): string {
    if (this.filter() === 'EXPIRING') return 'Review or replace this card before expiry';
    if (this.filter() === 'FEE') {
      return item.card.annualFee
        ? `${this.money(item.card.annualFee.amountMinor, item.card.currencyCode)} annual fee`
        : 'Annual fee date tracked';
    }
    if (this.filter() === 'GRACE') {
      return `A purchase made today would be payable by ${this.date(item.graceEndDate)}`;
    }
    if (item.outstanding < 0) {
      return `${this.money(Math.abs(item.outstanding), item.card.currencyCode)} extra credit at bank`;
    }
    if (item.amount <= 0) return 'No due for this month';
    return `${this.money(item.amount, item.card.currencyCode)} statement amount due`;
  }

  pillLabel(item: PaymentReminder): string {
    if (this.filter() === 'EXPIRING') return this.dayCountLabel(item.expiryDays, 'to expiry');
    if (this.filter() === 'FEE') return this.dayCountLabel(item.feeDays, 'to renewal');
    if (this.filter() === 'GRACE') return this.graceLabel(item);
    if (this.filter() === 'CREDIT' || (this.filter() === 'ALL' && item.outstanding < 0)) {
      return `${this.money(Math.abs(item.outstanding), item.card.currencyCode)} extra`;
    }
    if (item.amount <= 0) return 'No due';
    return this.timingLabel(item);
  }

  pillTone(item: PaymentReminder): 'overdue' | 'urgent' | 'soon' | 'comfortable' {
    if (this.filter() === 'GRACE') {
      if (item.grace >= 40) return 'comfortable';
      if (item.grace >= 25) return 'soon';
      return 'urgent';
    }
    if (this.filter() === 'CREDIT' || (this.filter() === 'ALL' && item.outstanding < 0)) {
      return 'comfortable';
    }
    const days =
      this.filter() === 'EXPIRING'
        ? item.expiryDays
        : this.filter() === 'FEE'
          ? item.feeDays
          : item.days;
    if (days === null) return 'comfortable';
    if ((this.filter() === 'DUE' || this.filter() === 'ALL') && item.amount <= 0)
      return 'comfortable';
    if (days < 0) return 'overdue';
    if (days <= 7) return 'urgent';
    if (days <= 30) return 'soon';
    return 'comfortable';
  }

  canSnooze(item: PaymentReminder): boolean {
    return (
      this.filter() === 'DUE' &&
      this.notifications.enabled() &&
      item.card.remindToSettle &&
      item.amount > 0 &&
      item.days <= 5
    );
  }

  canRecordPayment(item: PaymentReminder): boolean {
    return this.filter() === 'DUE' && item.amount > 0;
  }

  startSwipe(item: PaymentReminder, event: PointerEvent): void {
    if (event.pointerType === 'mouse') return;
    if (!this.canRecordPayment(item) && !this.canSnooze(item)) return;
    this.swipeStart = {
      id: item.id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      horizontal: false,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.swipeDrag.set({ id: item.id, offset: 0 });
  }

  moveSwipe(item: PaymentReminder, event: PointerEvent): void {
    const start = this.swipeStart;
    if (!start || start.id !== item.id || start.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (!start.horizontal && Math.abs(deltaY) > Math.abs(deltaX) + 6) {
      this.cancelSwipe();
      return;
    }
    if (Math.abs(deltaX) < 6) return;
    start.horizontal = true;
    const allowed = deltaX > 0 ? this.canRecordPayment(item) : this.canSnooze(item);
    const resisted = allowed ? Math.sign(deltaX) * Math.min(120, Math.abs(deltaX) * 0.9) : 0;
    this.swipeDrag.set({ id: item.id, offset: resisted });
  }

  finishSwipe(item: PaymentReminder, event: PointerEvent): void {
    const start = this.swipeStart;
    if (!start || start.id !== item.id || start.pointerId !== event.pointerId) return;
    const offset = this.swipeDrag()?.offset ?? 0;
    this.swipeStart = null;
    this.swipeDrag.set(null);
    if (offset >= 55 && this.canRecordPayment(item)) {
      this.requestPayment(item);
      return;
    }
    if (offset <= -55 && this.canSnooze(item)) {
      this.requestSnooze(item);
      return;
    }
    this.revealedAction.set(null);
  }

  swipeTransform(item: PaymentReminder): string {
    const drag = this.swipeDrag();
    if (drag?.id === item.id) return `translate3d(${drag.offset}px, 0, 0)`;
    if (this.isRevealed(item, 'PAYMENT')) return 'translate3d(7.5rem, 0, 0)';
    if (this.isRevealed(item, 'SNOOZE')) return 'translate3d(-7.5rem, 0, 0)';
    return 'translate3d(0, 0, 0)';
  }

  isRevealed(item: PaymentReminder, action: 'PAYMENT' | 'SNOOZE'): boolean {
    const revealed = this.revealedAction();
    return revealed?.id === item.id && revealed.action === action;
  }

  requestSnooze(item: PaymentReminder): void {
    if (!this.canSnooze(item)) return;
    this.snoozeCandidate.set(item);
    this.revealedAction.set(null);
  }

  async confirmSnooze(): Promise<void> {
    const item = this.snoozeCandidate();
    if (!item || !this.canSnooze(item)) return;
    await this.store.setReminderSnoozed(item.id, true);
    this.snoozeCandidate.set(null);
    this.revealedAction.set(null);
    this.snackbar.show('Reminder snoozed.', 'INFO', 10_000, {
      label: 'Undo',
      run: () => void this.restore(item.id),
    });
  }

  async restore(id: string): Promise<void> {
    await this.store.setReminderSnoozed(id, false);
    this.snackbar.show('Reminder restored.', 'INFO');
  }

  async enableNotifications(): Promise<void> {
    await this.notifications.requestPermission(this.store.cards(), (cardId) =>
      this.store.cardDueAmount(cardId),
    );
  }

  async toggleNotifications(event: Event): Promise<void> {
    const checkbox = event.target as HTMLInputElement;
    if (this.notifications.enabled()) {
      await this.notifications.cancelAll(this.store.cards());
      checkbox.checked = false;
      this.snackbar.show('Payment reminders disabled.', 'INFO');
      return;
    }
    const granted = await this.notifications.requestPermission(this.store.cards(), (cardId) =>
      this.store.cardDueAmount(cardId),
    );
    checkbox.checked = granted;
    const schedulingError = this.notifications.lastError();
    this.snackbar.show(
      granted && !schedulingError
        ? 'Payment reminders enabled and scheduled.'
        : (schedulingError ?? 'Notification permission denied.'),
      granted && !schedulingError ? 'SUCCESS' : 'WARNING',
    );
  }

  updateFilter(value: string): void {
    this.filter.set(value as ReminderFilter);
  }

  requestPayment(item: PaymentReminder): void {
    if (item.amount > 0) {
      this.paymentCandidate.set(item);
      this.revealedAction.set(null);
    }
  }

  recordPayment(): void {
    const item = this.paymentCandidate();
    if (!item || item.amount <= 0) return;
    this.store.recordPayment(item.card.id, item.amount, 'Reminder payment');
    this.paymentCandidate.set(null);
    this.snackbar.show(`${this.money(item.amount, item.card.currencyCode)} payment recorded.`);
  }

  private toReminder(card: CreditCard): PaymentReminder {
    const now = new Date();
    const nextStatement = statementDateFor(now, card.statementDay);
    const latestStatement =
      nextStatement.getTime() > now.getTime()
        ? previousStatementDate(nextStatement, card.statementDay)
        : nextStatement;
    const due = paymentDueDate(latestStatement, card);
    const expiry =
      card.expiryMonth && card.expiryYear
        ? this.cardExpiry.date(card.expiryYear, card.expiryMonth)
        : null;
    const feeDue = this.nextAnnualFeeDate(card, now);
    const grace = gracePeriodBreakdown(card, now);
    return {
      id: card.id,
      card,
      due,
      days: daysBetween(now, due),
      amount: this.store.cardDueAmount(card.id, now),
      outstanding: this.store.cardOutstanding(card.id),
      grace: grace.totalDays,
      graceStatementDays: grace.statementDays,
      gracePaymentDays: grace.paymentDays,
      graceEndDate: gracePeriodEndDate(card, now),
      expiry,
      expiryDays: expiry ? daysBetween(now, expiry) : null,
      feeDue,
      feeDays: feeDue ? daysBetween(now, feeDue) : null,
    };
  }

  private graceLabel(item: PaymentReminder): string {
    return `${item.grace} days (${item.graceStatementDays} + ${item.gracePaymentDays})`;
  }

  cancelSwipe(): void {
    this.swipeStart = null;
    this.swipeDrag.set(null);
  }

  private dayCountLabel(days: number | null, suffix: string): string {
    if (days === null) return 'Date not set';
    if (days < 0) return `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} overdue`;
    if (days === 0) return suffix === 'to expiry' ? 'Expires today' : 'Renews today';
    return `${days} ${days === 1 ? 'day' : 'days'} ${suffix}`;
  }

  private nextAnnualFeeDate(card: CreditCard, reference: Date): Date | null {
    const fee = card.annualFee;
    if (!card.annualFeeEnabled || !fee) return null;
    const candidate = new Date(reference.getFullYear(), fee.renewalMonth - 1, fee.renewalDay);
    const frequency = Math.max(1, fee.frequencyMonths);
    while (candidate < reference) candidate.setMonth(candidate.getMonth() + frequency);
    return candidate;
  }
}
