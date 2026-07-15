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
  readonly selectedCategoryId = signal<string | null>(null);
  readonly periodTransactions = computed(() => {
    const start = this.periodStart();
    return this.store.transactions().filter((item) => !start || item.transactionDate >= start);
  });
  readonly expenses = computed(() =>
    this.periodTransactions().filter((item) => ['PURCHASE', 'FEE', 'INTEREST'].includes(item.type)),
  );
  readonly totalSpent = computed(() =>
    this.expenses().reduce((sum, item) => sum + item.amountMinor, 0),
  );
  readonly incomingPayments = computed(() =>
    this.store
      .activeCards()
      .reduce((sum, card) => sum + Math.max(0, this.store.cardOutstanding(card.id)), 0),
  );
  readonly monthlyLoans = computed(() =>
    this.store
      .loans()
      .filter((loan) => loan.status === 'ACTIVE')
      .reduce((sum, loan) => sum + loan.installmentMinor, 0),
  );
  readonly pluxeeLoad = computed(() =>
    this.store
      .paymentSources()
      .filter((source) => source.kind === 'MEAL' && source.autoLoad)
      .reduce((sum, source) => sum + (source.loadAmountMinor ?? 0), 0),
  );
  readonly trackedSourceFunds = computed(() =>
    this.store
      .paymentSources()
      .filter((source) => source.kind !== 'MEAL' && !source.noLimit)
      .reduce((sum, source) => sum + (source.balanceMinor ?? 0), 0),
  );
  readonly periodIncome = computed(() => {
    const start = this.periodStart();
    const records = this.store
      .incomeHistory()
      .filter((income) => !start || income.cycleStartDate >= start);
    return records.length
      ? records.reduce((sum, income) => sum + income.amountMinor, 0)
      : this.store.monthlyIncomeMinor();
  });
  readonly availableThisMonth = computed(() =>
    Math.max(
      0,
      this.periodIncome() +
        this.pluxeeLoad() +
        this.trackedSourceFunds() -
        this.totalSpent() -
        this.monthlyLoans(),
    ),
  );
  readonly expenseRatio = computed(() =>
    this.periodIncome() ? Math.round((this.totalSpent() / this.periodIncome()) * 100) : 0,
  );
  readonly byCategory = computed(() => {
    const total = this.totalSpent();
    return this.store
      .categories()
      .map((category) => {
        const amount = this.expenses()
          .filter((item) => item.categoryId === category.id)
          .reduce((sum, item) => sum + item.amountMinor, 0);
        return { ...category, amount, percent: total ? Math.round((amount / total) * 100) : 0 };
      })
      .filter((item) => item.amount > 0)
      .sort((a, b) => b.amount - a.amount);
  });
  readonly bySource = computed(() =>
    [...this.store.activeCards(), ...this.store.activePaymentSources()]
      .map((source) => ({
        id: source.id,
        name: source.nickname,
        amount: this.expenses()
          .filter((item) => item.cardId === source.id)
          .reduce((sum, item) => sum + item.amountMinor, 0),
      }))
      .filter((item) => item.amount > 0)
      .sort((a, b) => b.amount - a.amount),
  );
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
  readonly trend = computed(() => {
    const count = this.periodCount();
    return Array.from({ length: count }, (_, index) => count - index - 1).map((offset) => {
      const cycle = this.cycleForOffset(offset);
      const income =
        this.store.incomeHistory().find((item) => item.periodKey === cycle.key)?.amountMinor ??
        (offset === 0 ? this.store.monthlyIncomeMinor() : 0);
      const expense = this.store
        .transactions()
        .filter(
          (item) =>
            item.transactionDate >= cycle.startDate &&
            item.transactionDate <= cycle.endDate &&
            ['PURCHASE', 'FEE', 'INTEREST'].includes(item.type),
        )
        .reduce((sum, item) => sum + item.amountMinor, 0);
      return { ...cycle, income, expense, remaining: income - expense };
    });
  });
  readonly trendLabels = computed(() => this.trend().map((item) => item.label));
  readonly expenseTrendValues = computed(() => this.trend().map((item) => item.expense / 100));
  readonly remainingTrendValues = computed(() => this.trend().map((item) => item.remaining / 100));
  readonly incomeTrendValues = computed(() => this.trend().map((item) => item.income / 100));
  readonly selectedCategory = computed(() =>
    this.byCategory().find((category) => category.id === this.selectedCategoryId()),
  );
  readonly selectedCategoryValues = computed(() => {
    const categoryId = this.selectedCategoryId();
    return this.trend().map((cycle) =>
      this.store
        .transactions()
        .filter(
          (item) =>
            item.categoryId === categoryId &&
            item.transactionDate >= cycle.startDate &&
            item.transactionDate <= cycle.endDate &&
            ['PURCHASE', 'FEE', 'INTEREST'].includes(item.type),
        )
        .reduce((sum, item) => sum + item.amountMinor / 100, 0),
    );
  });

  money(value: number): string {
    return formatMoney(value, 'INR');
  }

  updatePeriod(event: Event): void {
    this.period.set((event.target as HTMLSelectElement).value as ReportPeriod);
    this.selectedCategoryId.set(null);
  }

  selectCategory(categoryId: string): void {
    this.selectedCategoryId.set(this.selectedCategoryId() === categoryId ? null : categoryId);
  }

  savingsRate(income: number, expense: number): number {
    return income ? Math.round(((income - expense) / income) * 100) : 0;
  }

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
    return this.localDate(date);
  }

  private periodCount(): number {
    const period = this.period();
    if (period === 'MONTH') return 1;
    if (period === 'THREE') return 3;
    if (period === 'SIX') return 6;
    if (period === 'YEAR') return 12;
    return Math.max(1, Math.min(36, this.store.incomeHistory().length || 12));
  }

  private cycleForOffset(offset: number) {
    const startDay = this.store.budgetCycleStartDay();
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), startDay);
    if (now.getDate() < startDay) start.setMonth(start.getMonth() - 1);
    start.setMonth(start.getMonth() - offset);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, startDay - 1);
    return {
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      label: `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}–${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`,
      startDate: this.localDate(start),
      endDate: this.localDate(end),
    };
  }

  private localDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}
