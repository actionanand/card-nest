import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CardTransaction, TransactionType } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';

@Component({
  selector: 'app-transactions-page',
  imports: [ReactiveFormsModule, RouterLink, AppIcon],
  templateUrl: './transactions.html',
  styleUrl: './transactions.scss',
})
export class TransactionsPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  private readonly requestedSourceId = this.route.snapshot.queryParamMap.get('source');
  readonly showForm = signal(
    this.route.snapshot.queryParamMap.get('add') === 'true' ||
      this.route.snapshot.queryParamMap.get('payment') === 'true',
  );
  readonly search = signal('');
  readonly typeFilter = signal<TransactionType | 'ALL'>('ALL');
  readonly sourceFilter = signal(this.route.snapshot.queryParamMap.get('source') ?? 'ALL');
  readonly grouping = signal<'MONTH' | 'CYCLE' | 'STATEMENT'>('MONTH');
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
    cardId: new FormControl(
      this.requestedSourceId ??
        this.store.activeCards()[0]?.id ??
        this.store.activePaymentSources()[0]?.id ??
        '',
      {
        nonNullable: true,
        validators: [Validators.required],
      },
    ),
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
    repeat: new FormControl<'NONE' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'>('NONE', {
      nonNullable: true,
    }),
  });
  readonly filtered = computed(() => {
    const term = this.search().trim().toLocaleLowerCase();
    return this.store
      .transactions()
      .filter(
        (item) =>
          (this.typeFilter() === 'ALL' || item.type === this.typeFilter()) &&
          (this.sourceFilter() === 'ALL' || item.cardId === this.sourceFilter()) &&
          (!term ||
            item.merchant?.toLocaleLowerCase().includes(term) ||
            this.cardName(item.cardId).toLocaleLowerCase().includes(term)),
      );
  });
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

  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }
  cardName(cardId: string): string {
    return this.store.sourceName(cardId);
  }
  cardLastDigits(cardId: string): string {
    return this.store.cards().find((card) => card.id === cardId)?.lastDigits ?? '••••';
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
  updateGrouping(event: Event): void {
    this.grouping.set((event.target as HTMLSelectElement).value as 'MONTH' | 'CYCLE' | 'STATEMENT');
  }
  isCreditCardSelected(): boolean {
    return this.store.cards().some((card) => card.id === this.sourceFilter());
  }
  signedMoney(value: number): string {
    return `${value >= 0 ? '+' : '−'}${formatMoney(Math.abs(value), 'INR')}`;
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
    const transaction: CardTransaction = {
      id: crypto.randomUUID(),
      cardId: value.cardId,
      type: value.type,
      amountMinor,
      currencyCode: 'INR',
      transactionDate: value.transactionDate,
      merchant: value.merchant.trim() || undefined,
      categoryId: value.categoryId,
      notes: value.notes.trim() || undefined,
      attachmentIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.addTransaction(transaction);
    if (value.repeat !== 'NONE') {
      this.store.addRecurringRule({
        id: crypto.randomUUID(),
        cardId: value.cardId,
        title: value.merchant.trim() || value.type.replace('_', ' '),
        amountMinor,
        categoryId: value.categoryId,
        frequency: value.repeat,
        startDate: value.transactionDate,
        nextOccurrenceDate: this.nextOccurrence(value.transactionDate, value.repeat),
        status: 'ACTIVE',
      });
    }
    this.form.reset({
      cardId: value.cardId,
      type: 'PURCHASE',
      amount: '',
      transactionDate: new Date().toISOString().slice(0, 10),
      categoryId: this.store.categories()[0]?.id ?? 'other',
      merchant: '',
      notes: '',
      repeat: 'NONE',
    });
    this.showForm.set(false);
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

  private nextOccurrence(dateValue: string, repeat: 'WEEKLY' | 'MONTHLY' | 'YEARLY'): string {
    const date = new Date(`${dateValue}T12:00:00`);
    if (repeat === 'WEEKLY') date.setDate(date.getDate() + 7);
    else if (repeat === 'MONTHLY') date.setMonth(date.getMonth() + 1);
    else date.setFullYear(date.getFullYear() + 1);
    return date.toISOString().slice(0, 10);
  }
}
