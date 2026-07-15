import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { CardTransaction, TransactionType } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { CategoriesPage } from '../categories/categories';
import { ExportDialog } from '../../shared/export-dialog';
import { ExportFormat } from '../../core/models/export';

type GroupingMode = 'MONTH' | 'CYCLE' | 'STATEMENT';
type RepeatChoice = 'NONE' | 'INFINITE' | `${number}`;

@Component({
  selector: 'app-transactions-page',
  imports: [ReactiveFormsModule, AppIcon, CategoriesPage, ExportDialog],
  templateUrl: './transactions.html',
  styleUrl: './transactions.scss',
  host: { '(document:keydown.escape)': 'closeOverlays()' },
})
export class TransactionsPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackbar = inject(SnackbarService);
  private readonly requestedSourceId = this.route.snapshot.queryParamMap.get('source');
  private readonly requestedEditId = this.route.snapshot.queryParamMap.get('edit');
  readonly showForm = signal(
    this.route.snapshot.queryParamMap.get('add') === 'true' ||
      this.route.snapshot.queryParamMap.get('payment') === 'true' ||
      this.requestedEditId !== null,
  );
  readonly editingId = signal<string | null>(null);
  readonly actionMenuId = signal<string | null>(null);
  readonly summaryMenuOpen = signal(false);
  readonly manageCategoriesOpen = signal(false);
  readonly exportOpen = signal(false);
  readonly exportFormat = signal<ExportFormat>('PDF');
  readonly hideCredits = signal(false);
  readonly creditCardsOnly = signal(false);
  readonly search = signal('');
  readonly typeFilter = signal<TransactionType | 'ALL'>('ALL');
  readonly sourceFilter = signal(this.requestedSourceId ?? 'ALL');
  readonly categoryFilter = signal('ALL');
  readonly grouping = signal<GroupingMode>('MONTH');
  readonly repeatOptions = Array.from({ length: 36 }, (_, index) => index + 1);
  readonly types: readonly { value: TransactionType; label: string }[] = [
    { value: 'PURCHASE', label: 'Purchase' },
    { value: 'PAYMENT', label: 'Card payment' },
    { value: 'REFUND', label: 'Refund' },
    { value: 'CASHBACK', label: 'Cashback' },
    { value: 'CREDIT', label: 'Credit' },
    { value: 'FEE', label: 'Fee' },
    { value: 'INTEREST', label: 'Interest' },
    { value: 'ADJUSTMENT', label: 'Adjustment' },
  ];
  readonly form = new FormGroup({
    cardId: new FormControl(this.defaultSourceId(), {
      nonNullable: true,
      validators: [Validators.required],
    }),
    type: new FormControl<TransactionType>(
      this.route.snapshot.queryParamMap.get('payment') === 'true' ? 'PAYMENT' : 'PURCHASE',
      { nonNullable: true, validators: [Validators.required] },
    ),
    amount: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    transactionDate: new FormControl(new Date().toISOString().slice(0, 10), {
      nonNullable: true,
      validators: [Validators.required],
    }),
    categoryId: new FormControl(this.store.categories()[0]?.id ?? 'other', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    merchant: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    notes: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(500)] }),
    repeat: new FormControl<RepeatChoice>('NONE', { nonNullable: true }),
  });
  readonly filtered = computed(() => {
    const term = this.search().trim().toLocaleLowerCase();
    return this.store
      .transactions()
      .filter(
        (item) =>
          (!this.hideCredits() || !this.isCredit(item.type)) &&
          (!this.creditCardsOnly() || this.store.cards().some((card) => card.id === item.cardId)) &&
          (this.typeFilter() === 'ALL' || item.type === this.typeFilter()) &&
          (this.sourceFilter() === 'ALL' || item.cardId === this.sourceFilter()) &&
          (this.categoryFilter() === 'ALL' || item.categoryId === this.categoryFilter()) &&
          (!term ||
            item.merchant?.toLocaleLowerCase().includes(term) ||
            this.cardName(item.cardId).toLocaleLowerCase().includes(term) ||
            this.categoryName(item.categoryId).toLocaleLowerCase().includes(term)),
      );
  });
  readonly visibleTotal = computed(() =>
    this.filtered().reduce(
      (sum, item) => sum + (this.isCredit(item.type) ? item.amountMinor : -item.amountMinor),
      0,
    ),
  );
  readonly groups = computed(() => {
    const grouped = new Map<string, { label: string; transactions: CardTransaction[] }>();
    for (const transaction of this.filtered()) {
      const period = this.periodFor(transaction);
      const group = grouped.get(period.key) ?? { label: period.label, transactions: [] };
      group.transactions.push(transaction);
      grouped.set(period.key, group);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([key, group]) => ({
        key,
        label: group.label,
        transactions: group.transactions.sort((a, b) =>
          b.transactionDate.localeCompare(a.transactionDate),
        ),
        totalMinor: group.transactions.reduce(
          (sum, item) => sum + (this.isCredit(item.type) ? item.amountMinor : -item.amountMinor),
          0,
        ),
      }));
  });

  constructor() {
    const transaction = this.store.transactions().find((item) => item.id === this.requestedEditId);
    if (transaction) this.edit(transaction);
  }

  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }
  cardName(cardId: string): string {
    return this.store.sourceName(cardId);
  }
  categoryName(categoryId: string): string {
    return this.store.categories().find((item) => item.id === categoryId)?.name ?? 'Other';
  }
  isCredit(type: TransactionType): boolean {
    return ['PAYMENT', 'REFUND', 'CASHBACK', 'CREDIT'].includes(type);
  }
  updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }
  updateType(event: Event): void {
    this.typeFilter.set((event.target as HTMLSelectElement).value as TransactionType | 'ALL');
  }
  updateSource(event: Event): void {
    this.sourceFilter.set((event.target as HTMLSelectElement).value);
  }
  updateCategory(event: Event): void {
    this.categoryFilter.set((event.target as HTMLSelectElement).value);
  }
  updateGrouping(event: Event): void {
    this.grouping.set((event.target as HTMLSelectElement).value as GroupingMode);
  }
  isCreditCardSelected(): boolean {
    return this.store.cards().some((card) => card.id === this.sourceFilter());
  }
  signedMoney(value: number): string {
    return `${value >= 0 ? '+' : '−'}${formatMoney(Math.abs(value), 'INR')}`;
  }
  openExport(format: ExportFormat): void {
    this.exportFormat.set(format);
    this.exportOpen.set(true);
    this.closeMenus();
  }
  openAdd(): void {
    this.editingId.set(null);
    this.resetForm(this.defaultSourceId());
    this.showForm.set(true);
    this.closeMenus();
  }
  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
  }
  edit(transaction: CardTransaction): void {
    this.editingId.set(transaction.id);
    this.form.reset({
      cardId: transaction.cardId,
      type: transaction.type,
      amount: String(transaction.amountMinor / 100),
      transactionDate: transaction.transactionDate,
      categoryId: transaction.categoryId,
      merchant: transaction.merchant ?? '',
      notes: transaction.notes ?? '',
      repeat: 'NONE',
    });
    this.showForm.set(true);
    this.closeMenus();
    globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  toggleActionMenu(transactionId: string): void {
    this.summaryMenuOpen.set(false);
    this.actionMenuId.set(this.actionMenuId() === transactionId ? null : transactionId);
  }
  closeMenus(): void {
    this.actionMenuId.set(null);
    this.summaryMenuOpen.set(false);
  }
  closeOverlays(): void {
    if (this.exportOpen()) {
      this.exportOpen.set(false);
      return;
    }
    if (this.manageCategoriesOpen()) {
      this.manageCategoriesOpen.set(false);
      return;
    }
    if (this.showForm()) {
      this.closeForm();
      return;
    }
    this.closeMenus();
  }
  delete(transaction: CardTransaction): void {
    if (!globalThis.confirm?.(`Delete ${transaction.merchant || 'this transaction'}?`)) return;
    this.store.deleteTransaction(transaction.id);
    this.snackbar.show('Transaction deleted.', 'WARNING');
    this.closeMenus();
  }
  duplicate(transaction: CardTransaction): void {
    this.store.duplicateTransaction(transaction.id);
    this.snackbar.show('Transaction duplicated.');
    this.closeMenus();
  }
  goToSource(transaction: CardTransaction): void {
    this.closeMenus();
    if (this.store.cards().some((card) => card.id === transaction.cardId)) {
      void this.router.navigate(['/cards'], { queryParams: { open: transaction.cardId } });
      return;
    }
    void this.router.navigate(['/sources'], { fragment: transaction.cardId });
  }
  clearFilters(): void {
    this.search.set('');
    this.typeFilter.set('ALL');
    this.sourceFilter.set('ALL');
    this.categoryFilter.set('ALL');
    this.hideCredits.set(false);
    this.creditCardsOnly.set(false);
    this.closeMenus();
  }

  save(): void {
    this.form.markAllAsTouched();
    const amountMinor = parseMoneyToMinor(this.form.controls.amount.value);
    if (amountMinor === null || amountMinor <= 0) {
      this.form.controls.amount.setErrors({ money: true });
      return;
    }
    if (this.form.invalid) return;
    const value = this.form.getRawValue();
    const timestamp = new Date().toISOString();
    const existing = this.store
      .transactions()
      .find((transaction) => transaction.id === this.editingId());
    const transaction: CardTransaction = {
      ...existing,
      id: existing?.id ?? crypto.randomUUID(),
      cardId: value.cardId,
      type: value.type,
      amountMinor,
      currencyCode: existing?.currencyCode ?? 'INR',
      transactionDate: value.transactionDate,
      merchant: value.merchant.trim() || undefined,
      categoryId: value.categoryId,
      notes: value.notes.trim() || undefined,
      attachmentIds: existing?.attachmentIds ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (existing) this.store.updateTransaction(transaction);
    else this.store.addTransaction(transaction);

    if (!existing && value.repeat !== 'NONE') {
      const occurrenceLimit = value.repeat === 'INFINITE' ? undefined : Number(value.repeat);
      this.store.addRecurringRule({
        id: crypto.randomUUID(),
        cardId: value.cardId,
        title: value.merchant.trim() || value.type.replace('_', ' '),
        amountMinor,
        categoryId: value.categoryId,
        transactionType: value.type,
        frequency: 'MONTHLY',
        startDate: value.transactionDate,
        occurrenceLimit,
        nextOccurrenceDate: this.nextMonthlyOccurrence(value.transactionDate),
        status: 'ACTIVE',
      });
    }
    this.resetForm(value.cardId);
    this.closeForm();
    this.snackbar.show(existing ? 'Transaction updated.' : 'Transaction added.');
  }

  private periodFor(transaction: CardTransaction): { key: string; label: string } {
    const date = new Date(`${transaction.transactionDate}T12:00:00`);
    if (this.grouping() === 'MONTH') {
      return {
        key: transaction.transactionDate.slice(0, 7),
        label: date.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
      };
    }
    const selectedCard = this.store.cards().find((card) => card.id === this.sourceFilter());
    if (this.grouping() === 'STATEMENT' && selectedCard) {
      const statementFor = (year: number, month: number) =>
        new Date(
          year,
          month,
          Math.min(selectedCard.statementDay, new Date(year, month + 1, 0).getDate()),
        );
      const currentStatement = statementFor(date.getFullYear(), date.getMonth());
      let start: Date;
      let end: Date;
      if (date <= currentStatement) {
        const previousStatement = statementFor(date.getFullYear(), date.getMonth() - 1);
        start = new Date(previousStatement);
        start.setDate(start.getDate() + 1);
        end = currentStatement;
      } else {
        start = new Date(currentStatement);
        start.setDate(start.getDate() + 1);
        end = statementFor(date.getFullYear(), date.getMonth() + 1);
      }
      return {
        key: start.toISOString().slice(0, 10),
        label: `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      };
    }
    const startDay = this.store.budgetCycleStartDay();
    const start = new Date(date.getFullYear(), date.getMonth(), startDay);
    if (date < start) start.setMonth(start.getMonth() - 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, startDay - 1);
    return {
      key: start.toISOString().slice(0, 10),
      label: `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    };
  }

  private defaultSourceId(): string {
    return (
      this.requestedSourceId ??
      this.store.activeCards()[0]?.id ??
      this.store.activePaymentSources()[0]?.id ??
      ''
    );
  }

  private resetForm(sourceId: string): void {
    this.form.reset({
      cardId: sourceId,
      type: 'PURCHASE',
      amount: '',
      transactionDate: new Date().toISOString().slice(0, 10),
      categoryId: this.store.categories()[0]?.id ?? 'other',
      merchant: '',
      notes: '',
      repeat: 'NONE',
    });
  }

  private nextMonthlyOccurrence(dateValue: string): string {
    const date = new Date(`${dateValue}T12:00:00`);
    const anchorDay = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    date.setDate(
      Math.min(anchorDay, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()),
    );
    return date.toISOString().slice(0, 10);
  }
}
