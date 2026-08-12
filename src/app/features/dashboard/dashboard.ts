import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardNestStore } from '../../core/services/card-nest-store';
import {
  daysBetween,
  paymentDueDate,
  previousStatementDate,
  statementDateFor,
} from '../../core/services/billing-cycle';
import { formatMoney, transactionEffect } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';
import { AppDatePipe } from '../../core/services/date-format.service';
import { CardNetworkLogo } from '../../shared/card-network-logo';
import { CardTransaction } from '../../core/models/domain';

type BreakdownView = 'OUTSTANDING' | 'STATEMENT' | 'UNBILLED';

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, AppIcon, AppDatePipe, CardNetworkLogo],
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

  readonly breakdownView = signal<BreakdownView | null>(null);
  readonly ignorePaidDues = signal(true);
  readonly breakdownTitle = computed(() => {
    switch (this.breakdownView()) {
      case 'STATEMENT':
        return 'Statement dues';
      case 'UNBILLED':
        return 'Unbilled';
      case 'OUTSTANDING':
        return 'Total outstanding';
      default:
        return '';
    }
  });
  readonly breakdownDescription = computed(() => {
    switch (this.breakdownView()) {
      case 'STATEMENT':
        return 'The latest generated statement of each card — this cycle’s transactions plus any balance carried forward.';
      case 'UNBILLED':
        return 'Purchases made after the latest statement that will appear on the next bill.';
      case 'OUTSTANDING':
        return 'Everything you currently owe across active cards, billed and unbilled.';
      default:
        return '';
    }
  });
  readonly breakdownTotal = computed(() => {
    switch (this.breakdownView()) {
      case 'STATEMENT':
        return this.snapshot().statementDueMinor;
      case 'UNBILLED':
        return this.snapshot().unbilledMinor;
      case 'OUTSTANDING':
        return this.snapshot().outstandingMinor;
      default:
        return 0;
    }
  });
  readonly breakdownGroups = computed(() => {
    const view = this.breakdownView();
    if (!view) return [];
    return this.store
      .activeCards()
      .map((card) => {
        const transactions =
          view === 'STATEMENT'
            ? this.store.cardStatementTransactions(card.id)
            : view === 'UNBILLED'
              ? this.store.cardUnbilledTransactions(card.id)
              : this.store.cardOutstandingTransactions(card.id);
        const carriedForwardMinor =
          view === 'UNBILLED' ? 0 : this.store.cardCarriedForwardMinor(card.id);
        const activity = transactions.reduce((sum, item) => sum + transactionEffect(item), 0);
        const subtotal = Math.max(0, carriedForwardMinor + activity);
        return {
          card,
          subtotal,
          carriedForwardMinor,
          transactions: [...transactions].sort((left, right) =>
            right.transactionDate.localeCompare(left.transactionDate),
          ),
        };
      })
      .filter((group) =>
        this.ignorePaidDues()
          ? group.subtotal > 0
          : group.subtotal > 0 || group.transactions.length > 0,
      );
  });

  /** Whether a row lowers what is owed (payments, refunds, cashbacks). */
  rowReducesBalance(transaction: CardTransaction): boolean {
    return transactionEffect(transaction) < 0;
  }
  rowAmount(transaction: CardTransaction): string {
    const effect = transactionEffect(transaction);
    return `${effect < 0 ? '+' : '−'}${formatMoney(Math.abs(effect), transaction.currencyCode)}`;
  }
  carriedForwardLabel(minor: number): string {
    return `${minor < 0 ? '+' : '−'}${formatMoney(Math.abs(minor), 'INR')}`;
  }

  openBreakdown(view: BreakdownView): void {
    this.breakdownView.set(view);
  }
  closeBreakdown(): void {
    this.breakdownView.set(null);
  }

  money(value: number, currency = 'INR'): string {
    return formatMoney(value, currency);
  }
  cardName(cardId: string): string {
    return this.store.sourceName(cardId);
  }
  categoryName(categoryId: string): string {
    return this.store.categories().find((item) => item.id === categoryId)?.name ?? 'Other';
  }
  category(categoryId: string) {
    return this.store.categories().find((item) => item.id === categoryId);
  }
  isCredit(type: string): boolean {
    return ['PAYMENT', 'REFUND', 'CASHBACK', 'CREDIT'].includes(type);
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
