import { Component, computed, inject, signal } from '@angular/core';
import { CreditCard } from '../../core/models/domain';
import {
  daysBetween,
  estimatedGracePeriod,
  paymentDueDate,
  previousStatementDate,
  statementDateFor,
} from '../../core/services/billing-cycle';
import { CardNestStore } from '../../core/services/card-nest-store';
import { DateFormatService } from '../../core/services/date-format.service';
import { formatMoney } from '../../core/services/money';
import { NotificationService } from '../../core/services/notification.service';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';

type ReminderFilter = 'ALL' | 'DUE' | 'GRACE' | 'FEE' | 'EXPIRING';

interface PaymentReminder {
  readonly id: string;
  readonly card: CreditCard;
  readonly due: Date;
  readonly days: number;
  readonly amount: number;
  readonly grace: number;
}

@Component({
  selector: 'app-reminders-page',
  imports: [AppIcon, ConfirmationDialog],
  templateUrl: './reminders.html',
  styleUrl: './reminders.scss',
})
export class RemindersPage {
  readonly store = inject(CardNestStore);
  readonly notifications = inject(NotificationService);
  private readonly snackbar = inject(SnackbarService);
  private readonly dates = inject(DateFormatService);
  readonly filter = signal<ReminderFilter>('DUE');
  readonly paymentCandidate = signal<PaymentReminder | null>(null);
  readonly revealedAction = signal<{
    readonly id: string;
    readonly action: 'PAYMENT' | 'SNOOZE';
  } | null>(null);
  private swipeStartX: number | null = null;

  readonly allReminders = computed<readonly PaymentReminder[]>(() =>
    this.store
      .activeCards()
      .map((card) => this.toReminder(card))
      .filter((item) => {
        if (this.filter() === 'ALL' || this.filter() === 'GRACE') return true;
        if (this.filter() === 'DUE') return item.amount > 0;
        if (this.filter() === 'FEE') return item.card.annualFeeEnabled;
        if (!item.card.expiryMonth || !item.card.expiryYear) return false;
        return (
          new Date(item.card.expiryYear, item.card.expiryMonth, 0).getTime() - Date.now() <
          10_368_000_000
        );
      })
      .sort((a, b) => (this.filter() === 'GRACE' ? b.grace - a.grace : a.days - b.days)),
  );

  readonly reminders = computed(() =>
    this.allReminders().filter(
      (item) => !this.store.snoozedReminderCardIds().includes(item.id) && item.days <= 10,
    ),
  );
  readonly upcomingReminders = computed(() =>
    this.allReminders().filter(
      (item) => !this.store.snoozedReminderCardIds().includes(item.id) && item.days > 10,
    ),
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

  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }

  date(value: Date): string {
    return this.dates.format(value);
  }

  urgency(item: PaymentReminder): 'overdue' | 'urgent' | 'soon' | 'comfortable' {
    if (item.days < 0) return 'overdue';
    if (item.days <= 2) return 'urgent';
    if (item.days <= 5) return 'soon';
    return 'comfortable';
  }

  canSnooze(item: PaymentReminder): boolean {
    return item.card.remindToSettle && item.amount > 0 && item.days <= 5;
  }

  startSwipe(event: TouchEvent): void {
    this.swipeStartX = event.changedTouches[0]?.clientX ?? null;
  }

  finishSwipe(item: PaymentReminder, event: TouchEvent): void {
    const endX = event.changedTouches[0]?.clientX;
    if (this.swipeStartX === null || endX === undefined) return;
    const distance = endX - this.swipeStartX;
    this.swipeStartX = null;
    if (distance >= 55 && item.amount > 0) {
      this.revealedAction.set({ id: item.id, action: 'PAYMENT' });
      return;
    }
    if (distance <= -55 && this.canSnooze(item)) {
      this.revealedAction.set({ id: item.id, action: 'SNOOZE' });
      return;
    }
    this.revealedAction.set(null);
  }

  isRevealed(item: PaymentReminder, action: 'PAYMENT' | 'SNOOZE'): boolean {
    const revealed = this.revealedAction();
    return revealed?.id === item.id && revealed.action === action;
  }

  async snooze(item: PaymentReminder): Promise<void> {
    if (!this.canSnooze(item)) return;
    await this.store.setReminderSnoozed(item.id, true);
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
    this.snackbar.show(
      granted
        ? 'Payment reminders enabled and scheduled.'
        : (this.notifications.lastError() ?? 'Notification permission denied.'),
      granted ? 'SUCCESS' : 'WARNING',
    );
  }

  updateFilter(event: Event): void {
    this.filter.set((event.target as HTMLSelectElement).value as ReminderFilter);
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
    return {
      id: card.id,
      card,
      due,
      days: daysBetween(now, due),
      amount: this.store.cardDueAmount(card.id, now),
      grace: estimatedGracePeriod(card),
    };
  }
}
