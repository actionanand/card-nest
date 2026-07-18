import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Category } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { AppDatePipe } from '../../core/services/date-format.service';

interface SpendingPeriod {
  readonly offset: number;
  readonly key: string;
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
}

@Component({
  selector: 'app-category-spending-page',
  imports: [ReactiveFormsModule, AppIcon, AppDatePipe],
  templateUrl: './category-spending.html',
  styleUrl: './category-spending.scss',
})
export class CategorySpendingPage {
  readonly store = inject(CardNestStore);
  private readonly snackbar = inject(SnackbarService);
  readonly periodOffset = signal(0);
  readonly selectedCategoryId = signal<string | null>(null);
  readonly limitCategoryId = signal<string | null>(null);
  readonly limitCategory = computed(() =>
    this.store.categories().find((category) => category.id === this.limitCategoryId()),
  );
  readonly periods = computed(() => {
    const candidates = Array.from({ length: 120 }, (_, index) => this.periodForOffset(index));
    const transactionDates = this.store
      .transactions()
      .map((transaction) => transaction.transactionDate);
    const incomePeriods = new Set(this.store.incomeHistory().map((income) => income.periodKey));
    const available = candidates.filter(
      (period) =>
        incomePeriods.has(period.key) ||
        transactionDates.some((date) => date >= period.startDate && date <= period.endDate),
    );
    return available.length ? available : [candidates[0]];
  });
  readonly period = computed(
    () =>
      this.periods().find((period) => period.offset === this.periodOffset()) ?? this.periods()[0],
  );
  readonly transactions = computed(() => {
    const period = this.period();
    return this.store
      .transactions()
      .filter(
        (transaction) =>
          transaction.transactionDate >= period.startDate &&
          transaction.transactionDate <= period.endDate &&
          ['PURCHASE', 'FEE', 'INTEREST'].includes(transaction.type),
      );
  });
  readonly spentMinor = computed(() =>
    this.transactions().reduce((sum, transaction) => sum + transaction.amountMinor, 0),
  );
  readonly incomeMinor = computed(
    () =>
      this.store.incomeHistory().find((income) => income.periodKey === this.period().key)
        ?.amountMinor ?? (this.period().offset === 0 ? this.store.monthlyIncomeMinor() : 0),
  );
  readonly remainingMinor = computed(() => this.incomeMinor() - this.spentMinor());
  readonly overallPercent = computed(() =>
    this.store.monthlyBudgetMinor()
      ? Math.round((this.spentMinor() / this.store.monthlyBudgetMinor()) * 100)
      : 0,
  );
  readonly categoryRows = computed(() =>
    this.store
      .categories()
      .filter((category) => category.appliesTo !== 'CREDIT' && category.id !== 'payment')
      .map((category) => {
        const transactions = this.transactions().filter(
          (transaction) => transaction.categoryId === category.id,
        );
        const spent = transactions.reduce((sum, transaction) => sum + transaction.amountMinor, 0);
        const limit = category.showLimit ? category.monthlyLimitMinor : undefined;
        return {
          category,
          transactions,
          spent,
          configuredLimit: category.monthlyLimitMinor,
          limit,
          remaining: limit === undefined ? undefined : limit - spent,
          percent: limit ? Math.round((spent / limit) * 100) : 0,
        };
      })
      .sort((a, b) => b.spent - a.spent),
  );
  readonly limitForm = new FormGroup({
    amount: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    showLimit: new FormControl(true, { nonNullable: true }),
  });

  money(value: number): string {
    return formatMoney(value, 'INR');
  }

  selectPeriod(event: Event): void {
    this.periodOffset.set(Number((event.target as HTMLSelectElement).value));
    this.selectedCategoryId.set(null);
  }

  movePeriod(direction: -1 | 1): void {
    const periods = this.periods();
    const index = periods.findIndex((period) => period.offset === this.periodOffset());
    const target = periods[index + direction];
    if (target) this.periodOffset.set(target.offset);
    this.selectedCategoryId.set(null);
  }

  canMovePeriod(direction: -1 | 1): boolean {
    const index = this.periods().findIndex((period) => period.offset === this.periodOffset());
    return Boolean(this.periods()[index + direction]);
  }

  toggleCategory(categoryId: string): void {
    this.selectedCategoryId.set(this.selectedCategoryId() === categoryId ? null : categoryId);
  }

  openLimit(category: Category): void {
    this.limitCategoryId.set(category.id);
    this.limitForm.reset({
      amount:
        category.monthlyLimitMinor === undefined ? '' : String(category.monthlyLimitMinor / 100),
      showLimit: category.showLimit ?? true,
    });
  }

  closeLimit(): void {
    this.limitCategoryId.set(null);
  }

  async saveLimit(): Promise<void> {
    const categoryId = this.limitCategoryId();
    const amount = parseMoneyToMinor(this.limitForm.controls.amount.value);
    if (!categoryId || amount === null || amount <= 0) {
      this.limitForm.controls.amount.setErrors({ money: true });
      return;
    }
    await this.store.setCategoryLimit(categoryId, amount, this.limitForm.controls.showLimit.value);
    this.snackbar.show('Category limit saved.');
    this.closeLimit();
  }

  async removeLimit(): Promise<void> {
    const categoryId = this.limitCategoryId();
    if (!categoryId) return;
    await this.store.setCategoryLimit(categoryId, undefined, false);
    this.snackbar.show('Category limit removed.', 'INFO');
    this.closeLimit();
  }

  private periodForOffset(offset: number): SpendingPeriod {
    const startDay = this.store.budgetCycleStartDay();
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), startDay);
    if (now.getDate() < startDay) start.setMonth(start.getMonth() - 1);
    start.setMonth(start.getMonth() - offset);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, startDay - 1);
    return {
      offset,
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      label: `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      startDate: this.localDate(start),
      endDate: this.localDate(end),
    };
  }

  private localDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}
