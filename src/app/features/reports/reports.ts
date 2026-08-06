import { Component, computed, inject, signal } from '@angular/core';
import { TransactionType } from '../../core/models/domain';
import { ExportPeriod } from '../../core/models/export';
import { CardNestStore } from '../../core/services/card-nest-store';
import { ExportService } from '../../core/services/export.service';
import { formatMoney } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { ReportChart } from '../../shared/report-chart';

interface ReportCycle {
  readonly key: string;
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly offset: number;
}

const EXPENSE_TYPES: readonly TransactionType[] = ['PURCHASE', 'FEE', 'INTEREST'];

@Component({
  selector: 'app-reports-page',
  imports: [ReportChart, AppIcon, AppSelectPicker],
  templateUrl: './reports.html',
  styleUrl: './reports.scss',
})
export class ReportsPage {
  readonly store = inject(CardNestStore);
  private readonly exporter = inject(ExportService);
  readonly selectedCycleKey = signal('');
  readonly selectedCategoryId = signal<string | null>(null);
  readonly pastCyclePickerOpen = signal(false);
  readonly pastCycleYear = signal(new Date().getFullYear());

  readonly availableCycles = computed<readonly ReportCycle[]>(() => {
    const current = this.cycleForOffset(0);
    const datedRecords = [
      ...this.store.transactions().map((item) => item.transactionDate),
      ...this.store.incomeHistory().map((item) => item.cycleStartDate),
    ].filter(Boolean);
    const earliestCycle = this.cycleContaining(datedRecords.sort()[0] ?? current.startDate);
    const cycleCount = Math.min(
      240,
      Math.max(1, this.monthDistance(earliestCycle.startDate, current.startDate) + 1),
    );
    return Array.from({ length: cycleCount }, (_, offset) => this.cycleForOffset(offset));
  });

  readonly selectedCycle = computed(
    () =>
      this.availableCycles().find((cycle) => cycle.key === this.selectedCycleKey()) ??
      this.availableCycles()[0] ??
      this.cycleForOffset(0),
  );

  readonly selectedRangePeriod = computed<ExportPeriod | null>(() => {
    const value = this.selectedCycleKey();
    if (!value.startsWith('RANGE:')) return null;
    const period = value.slice(6);
    return ['THREE', 'SIX', 'YEAR', 'ALL'].includes(period)
      ? (period as ExportPeriod)
      : null;
  });

  readonly selectedReportCycles = computed<readonly ReportCycle[]>(() => {
    const period = this.selectedRangePeriod();
    if (!period) return [this.selectedCycle()];
    const count = period === 'ALL' ? this.availableCycles().length : this.periodCount(period);
    return this.availableCycles().slice(0, count).reverse();
  });

  readonly selectedPeriodLabel = computed(() => {
    const cycles = this.selectedReportCycles();
    if (cycles.length === 1) return cycles[0].label;
    const lastCycle = cycles.at(-1) ?? cycles[0];
    return `${this.displayIsoDate(cycles[0].startDate, false)} - ${this.displayIsoDate(lastCycle.endDate, true)}`;
  });

  readonly historicalCycles = computed(() =>
    this.availableCycles().slice(1).filter((cycle) =>
      this.store.transactions().some(
        (item) =>
          item.transactionDate >= cycle.startDate && item.transactionDate <= cycle.endDate,
      ) ||
      this.store.incomeHistory().some(
        (item) => item.cycleStartDate >= cycle.startDate && item.cycleStartDate <= cycle.endDate,
      ),
    ),
  );

  readonly pastCycleYears = computed(() =>
    [...new Set(this.historicalCycles().map((cycle) => Number(cycle.startDate.slice(0, 4))))].sort(
      (left, right) => right - left,
    ),
  );

  readonly pastCycleMonths = computed(() => {
    const year = this.pastCycleYear();
    return Array.from({ length: 12 }, (_, month) => {
      const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
      const cycle = this.historicalCycles().find((item) => item.startDate.startsWith(monthKey));
      return {
        month,
        name: new Date(year, month, 1, 12).toLocaleDateString('en-IN', { month: 'short' }),
        cycle,
      };
    });
  });

  readonly periodPickerValue = computed(() => {
    if (this.selectedRangePeriod()) return this.selectedCycleKey();
    const currentCycle = this.availableCycles()[0];
    return this.selectedCycle().key === currentCycle.key ? currentCycle.key : 'PAST';
  });

  readonly periodOptions = computed<readonly AppSelectOption[]>(() => [
    {
      value: this.availableCycles()[0].key,
      label: this.availableCycles()[0].label,
      detail: `Current budget cycle - starts on day ${this.store.budgetCycleStartDay()}`,
    },
    { value: 'RANGE:THREE', label: 'Last 3 budget cycles', detail: 'Combined totals' },
    { value: 'RANGE:SIX', label: 'Last 6 budget cycles', detail: 'Combined totals' },
    { value: 'RANGE:YEAR', label: 'Last 1 year', detail: '12 budget cycles combined' },
    { value: 'RANGE:ALL', label: 'All recorded cycles', detail: 'All available report data' },
    {
      value: 'PAST',
      label:
        this.periodPickerValue() === 'PAST'
          ? `Past cycle: ${this.selectedCycle().label}`
          : 'Choose a past cycle',
      detail: 'Open month and year calendar',
      disabled: this.historicalCycles().length === 0,
    },
  ]);

  readonly periodTransactions = computed(() => {
    const cycles = this.selectedReportCycles();
    const firstCycle = cycles[0];
    const lastCycle = cycles.at(-1) ?? firstCycle;
    return this.store
      .transactions()
      .filter(
        (item) =>
          item.transactionDate >= firstCycle.startDate &&
          item.transactionDate <= lastCycle.endDate,
      );
  });
  readonly expenses = computed(() =>
    this.periodTransactions().filter((item) => EXPENSE_TYPES.includes(item.type)),
  );
  readonly totalSpent = computed(() =>
    this.expenses().reduce((sum, item) => sum + item.amountMinor, 0),
  );
  readonly incomingPayments = computed(() =>
    this.periodTransactions()
      .filter((item) => item.type === 'PAYMENT')
      .reduce((sum, item) => sum + item.amountMinor, 0),
  );
  readonly nonCardSpent = computed(() => {
    const sourceIds = new Set(this.store.paymentSources().map((source) => source.id));
    return this.expenses()
      .filter((item) => sourceIds.has(item.cardId))
      .reduce((sum, item) => sum + item.amountMinor, 0);
  });
  readonly recurringAndEmi = computed(() =>
    this.expenses()
      .filter((item) => item.recurringRuleId || item.emiPlanId)
      .reduce((sum, item) => sum + item.amountMinor, 0),
  );
  readonly loanCommitments = computed(() =>
    this.selectedReportCycles().reduce(
      (total, cycle) =>
        total +
        this.store
          .loans()
          .filter(
            (loan) =>
              loan.status === 'ACTIVE' &&
              this.loanRunsInCycle(loan.startDate, loan.endDate, loan.debitDay, cycle),
          )
          .reduce((sum, loan) => sum + loan.installmentMinor, 0),
      0,
    ),
  );
  readonly monthlyLoans = computed(() => this.recurringAndEmi() + this.loanCommitments());
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
  readonly periodIncome = computed(() =>
    this.selectedReportCycles().reduce((total, cycle) => {
      const record = this.store
        .incomeHistory()
        .find(
          (income) =>
            income.cycleStartDate === cycle.startDate || income.periodKey === cycle.key,
        );
      return (
        total +
        (record?.amountMinor ?? (cycle.offset === 0 ? this.store.monthlyIncomeMinor() : 0))
      );
    }, 0),
  );
  readonly availableThisMonth = computed(() =>
    Math.max(
      0,
      this.periodIncome() +
        this.pluxeeLoad() +
        this.trackedSourceFunds() -
        this.totalSpent() -
        this.loanCommitments(),
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
        name: `${source.nickname}${'lastDigits' in source && source.lastDigits ? ` ${source.lastDigits}` : ''}`,
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
  readonly trend = computed(() =>
    this.selectedReportCycles().map((cycle) => {
      const income =
        this.store
          .incomeHistory()
          .find(
            (item) => item.cycleStartDate === cycle.startDate || item.periodKey === cycle.key,
          )?.amountMinor ?? (cycle.offset === 0 ? this.store.monthlyIncomeMinor() : 0);
      const expense = this.store
        .transactions()
        .filter(
          (item) =>
            item.transactionDate >= cycle.startDate &&
            item.transactionDate <= cycle.endDate &&
            EXPENSE_TYPES.includes(item.type),
        )
        .reduce((sum, item) => sum + item.amountMinor, 0);
      return { ...cycle, income, expense, remaining: income - expense };
    }),
  );
  readonly trendLabels = computed(() => this.trend().map((item) => item.label));
  readonly expenseTrendValues = computed(() => this.trend().map((item) => item.expense / 100));
  readonly remainingTrendValues = computed(() => this.trend().map((item) => item.remaining / 100));
  readonly incomeTrendValues = computed(() => this.trend().map((item) => item.income / 100));
  readonly selectedCategory = computed(() =>
    this.byCategory().find((category) => category.id === this.selectedCategoryId()),
  );
  readonly selectedCategoryValues = computed(() => {
    const categoryId = this.selectedCategoryId();
    return this.selectedReportCycles().map((cycle) =>
      this.store
        .transactions()
        .filter(
          (item) =>
            item.categoryId === categoryId &&
            item.transactionDate >= cycle.startDate &&
            item.transactionDate <= cycle.endDate &&
            EXPENSE_TYPES.includes(item.type),
        )
        .reduce((sum, item) => sum + item.amountMinor / 100, 0),
    );
  });

  money(value: number): string {
    return formatMoney(value, 'INR');
  }

  updatePeriodValue(value: string): void {
    if (value === 'PAST') {
      this.openPastCyclePicker();
      return;
    }
    this.selectedCycleKey.set(value);
    this.selectedCategoryId.set(null);
  }

  exportPdf(): void {
    const period = this.selectedRangePeriod();
    if (period) {
      this.exporter.exportStatistics(period);
      return;
    }
    this.exporter.exportStatisticsForCycle(this.selectedCycle());
  }

  selectCategory(categoryId: string): void {
    this.selectedCategoryId.set(this.selectedCategoryId() === categoryId ? null : categoryId);
  }

  savingsRate(income: number, expense: number): number {
    return income ? Math.round(((income - expense) / income) * 100) : 0;
  }

  openPastCyclePicker(): void {
    const selectedYear = Number(this.selectedCycle().startDate.slice(0, 4));
    this.pastCycleYear.set(
      this.pastCycleYears().includes(selectedYear)
        ? selectedYear
        : (this.pastCycleYears()[0] ?? new Date().getFullYear()),
    );
    this.pastCyclePickerOpen.set(true);
  }

  closePastCyclePicker(): void {
    this.pastCyclePickerOpen.set(false);
  }

  choosePastCycle(cycle: ReportCycle): void {
    this.selectedCycleKey.set(cycle.key);
    this.selectedCategoryId.set(null);
    this.closePastCyclePicker();
  }

  changePastCycleYear(direction: -1 | 1): void {
    const years = this.pastCycleYears();
    const index = years.indexOf(this.pastCycleYear());
    const nextYear = years[index - direction];
    if (nextYear !== undefined) this.pastCycleYear.set(nextYear);
  }

  canChangePastCycleYear(direction: -1 | 1): boolean {
    const years = this.pastCycleYears();
    const index = years.indexOf(this.pastCycleYear());
    return years[index - direction] !== undefined;
  }

  private periodCount(period: ExportPeriod): number {
    if (period === 'THREE') return 3;
    if (period === 'SIX') return 6;
    if (period === 'YEAR') return 12;
    return 1;
  }

  private loanRunsInCycle(
    startDate: string,
    endDate: string,
    debitDay: number,
    cycle: ReportCycle,
  ): boolean {
    const cycleStart = new Date(`${cycle.startDate}T12:00:00`);
    for (let monthOffset = 0; monthOffset <= 1; monthOffset += 1) {
      const month = new Date(
        cycleStart.getFullYear(),
        cycleStart.getMonth() + monthOffset,
        1,
        12,
      );
      const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12).getDate();
      const debitDate = this.localDate(
        new Date(month.getFullYear(), month.getMonth(), Math.min(debitDay, lastDay), 12),
      );
      if (
        debitDate >= cycle.startDate &&
        debitDate <= cycle.endDate &&
        debitDate >= startDate &&
        debitDate <= endDate
      ) {
        return true;
      }
    }
    return false;
  }

  private cycleForOffset(offset: number): ReportCycle {
    const startDay = this.store.budgetCycleStartDay();
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), startDay, 12);
    if (now.getDate() < startDay) start.setMonth(start.getMonth() - 1);
    start.setMonth(start.getMonth() - offset);
    return this.cycleFromStart(start, offset);
  }

  private cycleContaining(isoDate: string): ReportCycle {
    const date = new Date(`${isoDate}T12:00:00`);
    const startDay = this.store.budgetCycleStartDay();
    const start = new Date(date.getFullYear(), date.getMonth(), startDay, 12);
    if (date.getDate() < startDay) start.setMonth(start.getMonth() - 1);
    const current = this.cycleForOffset(0);
    return this.cycleFromStart(start, this.monthDistance(this.localDate(start), current.startDate));
  }

  private cycleFromStart(start: Date, offset: number): ReportCycle {
    const startDay = this.store.budgetCycleStartDay();
    const end = new Date(start.getFullYear(), start.getMonth() + 1, startDay - 1, 12);
    const startDate = this.localDate(start);
    return {
      offset,
      key: startDate,
      label: `${this.displayCycleDate(start, false)} - ${this.displayCycleDate(end, true)}`,
      startDate,
      endDate: this.localDate(end),
    };
  }

  private monthDistance(startDate: string, endDate: string): number {
    const start = new Date(`${startDate}T12:00:00`);
    const end = new Date(`${endDate}T12:00:00`);
    return Math.max(
      0,
      (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth(),
    );
  }

  private displayCycleDate(date: Date, includeYear: boolean): string {
    return date.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      ...(includeYear ? { year: 'numeric' as const } : {}),
    });
  }

  private displayIsoDate(isoDate: string, includeYear: boolean): string {
    return this.displayCycleDate(new Date(`${isoDate}T12:00:00`), includeYear);
  }

  private localDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}
