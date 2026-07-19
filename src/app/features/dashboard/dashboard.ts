import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardNestStore } from '../../core/services/card-nest-store';
import {
  daysBetween,
  paymentDueDate,
  previousStatementDate,
  statementDateFor,
} from '../../core/services/billing-cycle';
import { formatMoney } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';
import { AppDatePipe } from '../../core/services/date-format.service';

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, AppIcon, AppDatePipe],
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
  readonly upcomingPayments = computed(() =>
    this.store
      .activeCards()
      .map((card) => ({
        card,
        amount: this.store.cardDueAmount(card.id),
        days: this.daysUntilDue(card.id),
      }))
      .filter((payment) => payment.amount > 0)
      .sort((left, right) => left.days - right.days),
  );
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
    const nextStatement = statementDateFor(new Date(), card.statementDay);
    const statement =
      this.store.cardDueAmount(card.id) > 0
        ? previousStatementDate(nextStatement, card.statementDay)
        : nextStatement;
    return daysBetween(new Date(), paymentDueDate(statement, card));
  }
  dueTone(days: number): 'overdue' | 'urgent' | 'soon' | 'comfortable' {
    if (days < 0) return 'overdue';
    if (days <= 3) return 'urgent';
    if (days <= 8) return 'soon';
    return 'comfortable';
  }
}
