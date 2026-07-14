import { Component, computed, inject, signal } from '@angular/core';
import { CardNestStore } from '../../core/services/card-nest-store';
import { daysBetween, paymentDueDate, statementDateFor } from '../../core/services/billing-cycle';
import { formatMoney } from '../../core/services/money';

@Component({
  selector: 'app-reminders-page',
  templateUrl: './reminders.html',
  styleUrl: './reminders.scss',
})
export class RemindersPage {
  readonly store = inject(CardNestStore);
  readonly disabled = signal<readonly string[]>([]);
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
        };
      })
      .filter((item) => !this.disabled().includes(item.id))
      .sort((a, b) => a.days - b.days),
  );
  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }
  snooze(id: string): void {
    this.disabled.update((items) => [...items, id]);
  }
}
