import { Component, computed, inject, signal } from '@angular/core';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney } from '../../core/services/money';
import { ReportChart } from '../../shared/report-chart';

type ReportPeriod = 'MONTH' | 'THREE' | 'SIX' | 'YEAR' | 'ALL';

@Component({
  selector: 'app-reports-page',
  imports: [ReportChart],
  templateUrl: './reports.html',
  styleUrl: './reports.scss',
})
export class ReportsPage {
  readonly store = inject(CardNestStore);
  readonly period = signal<ReportPeriod>('MONTH');
  readonly periodTransactions = computed(() => {
    const start = this.periodStart();
    return this.store.transactions().filter((item) => !start || item.transactionDate >= start);
  });
  readonly expenses = computed(() => this.periodTransactions().filter((item) => ['PURCHASE', 'FEE', 'INTEREST'].includes(item.type)));
  readonly totalSpent = computed(() => this.expenses().reduce((sum, item) => sum + item.amountMinor, 0));
  readonly incomingPayments = computed(() => this.store.activeCards().reduce((sum, card) => sum + Math.max(0, this.store.cardOutstanding(card.id)), 0));
  readonly monthlyLoans = computed(() => this.store.loans().filter((loan) => loan.status === 'ACTIVE').reduce((sum, loan) => sum + loan.installmentMinor, 0));
  readonly pluxeeLoad = computed(() => this.store.paymentSources().filter((source) => source.kind === 'MEAL' && source.autoLoad).reduce((sum, source) => sum + (source.loadAmountMinor ?? 0), 0));
  readonly trackedSourceFunds = computed(() => this.store.paymentSources().filter((source) => source.kind !== 'MEAL' && !source.noLimit).reduce((sum, source) => sum + (source.balanceMinor ?? 0), 0));
  readonly availableThisMonth = computed(() => Math.max(0, this.store.monthlyIncomeMinor() + this.pluxeeLoad() + this.trackedSourceFunds() - this.totalSpent() - this.monthlyLoans()));
  readonly byCategory = computed(() => {
    const total = this.totalSpent();
    return this.store.categories().map((category) => {
      const amount = this.expenses().filter((item) => item.categoryId === category.id).reduce((sum, item) => sum + item.amountMinor, 0);
      return { ...category, amount, percent: total ? Math.round(amount / total * 100) : 0 };
    }).filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount);
  });
  readonly bySource = computed(() => [...this.store.activeCards(), ...this.store.activePaymentSources()].map((source) => ({ id: source.id, name: source.nickname, amount: this.expenses().filter((item) => item.cardId === source.id).reduce((sum, item) => sum + item.amountMinor, 0) })).filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount));
  readonly categoryLabels = computed(() => this.byCategory().map((item) => item.name));
  readonly categoryValues = computed(() => this.byCategory().map((item) => item.amount / 100));
  readonly categoryColours = computed(() =>
    this.byCategory().map((item) => item.colour ?? '#28684e'),
  );
  readonly sourceLabels = computed(() => this.bySource().map((item) => item.name));
  readonly sourceValues = computed(() => this.bySource().map((item) => item.amount / 100));
  readonly sourceColours = computed(() =>
    this.bySource().map((_, index) => ['#28684e', '#3d7d65', '#6b9f88', '#d69b3c'][index % 4]),
  );
  money(value: number): string { return formatMoney(value, 'INR'); }
  updatePeriod(event: Event): void { this.period.set((event.target as HTMLSelectElement).value as ReportPeriod); }
  private periodStart(): string | null {
    const period = this.period();
    if (period === 'ALL') return null;
    const offsets: Readonly<Record<Exclude<ReportPeriod, 'ALL'>, number>> = {
      MONTH: 0,
      THREE: 2,
      SIX: 5,
      YEAR: 11,
    };
    const now = new Date();
    const date = new Date(now.getFullYear(), now.getMonth(), this.store.budgetCycleStartDay());
    if (now < date) date.setMonth(date.getMonth() - 1);
    date.setMonth(date.getMonth() - offsets[period]);
    return date.toISOString().slice(0, 10);
  }
}
