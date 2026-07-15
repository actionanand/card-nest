import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardNestStore } from '../../core/services/card-nest-store';
import { daysBetween, paymentDueDate, statementDateFor } from '../../core/services/billing-cycle';
import { formatMoney } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, AppIcon],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class DashboardPage {
  readonly store = inject(CardNestStore);
  readonly snapshot = this.store.dashboard;
  readonly greeting = computed(() => {
    const hour = new Date().getHours();
    const salutation = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const name = this.store.profileDisplayName();
    return `${salutation}${name ? `, ${name}` : ''}.`;
  });
  readonly recentTransactions = computed(() => this.store.transactions().slice(0, 4));
  readonly budgetPercent = computed(() =>
    Math.min(
      100,
      Math.round((this.snapshot().monthlySpendMinor / this.store.monthlyBudgetMinor()) * 100),
    ),
  );

  money(value: number, currency = 'INR'): string {
    return formatMoney(value, currency);
  }
  cardName(cardId: string): string {
    return this.store.sourceName(cardId);
  }
  categoryName(categoryId: string): string {
    return this.store.categories().find((item) => item.id === categoryId)?.name ?? 'Other';
  }
  daysUntilDue(cardId: string): number {
    const card = this.store.cards().find((item) => item.id === cardId);
    if (!card) return 0;
    const statement = statementDateFor(new Date(), card.statementDay);
    return daysBetween(new Date(), paymentDueDate(statement, card));
  }
}
