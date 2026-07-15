import { Component, computed, inject, signal } from '@angular/core';
import { CardNestStore } from '../../core/services/card-nest-store';
import { daysBetween, paymentDueDate, statementDateFor } from '../../core/services/billing-cycle';
import { estimatedGracePeriod } from '../../core/services/billing-cycle';
import { formatMoney } from '../../core/services/money';
import { NotificationService } from '../../core/services/notification.service';
import { AppIcon } from '../../shared/app-icon';
import { SnackbarService } from '../../core/services/snackbar.service';

type ReminderFilter = 'ALL' | 'DUE' | 'GRACE' | 'FEE' | 'EXPIRING';

@Component({
  selector: 'app-reminders-page',
  imports: [AppIcon],
  templateUrl: './reminders.html',
  styleUrl: './reminders.scss',
})
export class RemindersPage {
  readonly store = inject(CardNestStore);
  readonly notifications = inject(NotificationService);
  private readonly snackbar = inject(SnackbarService);
  readonly disabled = signal<readonly string[]>([]);
  readonly filter = signal<ReminderFilter>('DUE');
  readonly reminders = computed(() =>
    this.store
      .activeCards()
      .map((card) => {
        const statement = statementDateFor(new Date(), card.statementDay);
        const due = paymentDueDate(statement, card);
        return {
          id: card.id,
          card,
          due,
          days: daysBetween(new Date(), due),
          amount: Math.max(0, this.store.cardOutstanding(card.id)),
          grace: estimatedGracePeriod(card),
        };
      })
      .filter((item) => !this.disabled().includes(item.id))
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
  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }
  snooze(id: string): void {
    this.disabled.update((items) => [...items, id]);
  }

  async enableNotifications(): Promise<void> {
    await this.notifications.requestPermission(this.store.cards(), (cardId) =>
      this.store.cardOutstanding(cardId),
    );
  }
  async toggleNotifications(): Promise<void> {
    if (this.notifications.enabled()) {
      await this.notifications.cancelAll(this.store.cards());
      this.snackbar.show('Payment reminders disabled.', 'INFO');
    } else {
      const granted = await this.notifications.requestPermission(this.store.cards(), (cardId) =>
        this.store.cardOutstanding(cardId),
      );
      this.snackbar.show(
        granted ? 'Payment reminders enabled and scheduled.' : 'Notification permission denied.',
        granted ? 'SUCCESS' : 'WARNING',
      );
    }
  }
  updateFilter(event: Event): void {
    this.filter.set((event.target as HTMLSelectElement).value as ReminderFilter);
  }
  recordPayment(cardId: string, amount: number): void {
    this.store.recordPayment(cardId, amount, 'Reminder payment');
    this.snackbar.show('Payment recorded.');
  }
}
