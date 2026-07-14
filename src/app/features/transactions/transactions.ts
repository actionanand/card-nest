import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { CardTransaction, TransactionType } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';

@Component({
  selector: 'app-transactions-page',
  imports: [ReactiveFormsModule],
  templateUrl: './transactions.html',
  styleUrl: './transactions.scss',
})
export class TransactionsPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  readonly showForm = signal(
    this.route.snapshot.queryParamMap.get('add') === 'true' ||
      this.route.snapshot.queryParamMap.get('payment') === 'true',
  );
  readonly search = signal('');
  readonly typeFilter = signal<TransactionType | 'ALL'>('ALL');
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
    cardId: new FormControl(this.store.activeCards()[0]?.id ?? '', {
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
  });
  readonly filtered = computed(() => {
    const term = this.search().trim().toLocaleLowerCase();
    return this.store
      .transactions()
      .filter(
        (item) =>
          (this.typeFilter() === 'ALL' || item.type === this.typeFilter()) &&
          (!term ||
            item.merchant?.toLocaleLowerCase().includes(term) ||
            this.cardName(item.cardId).toLocaleLowerCase().includes(term)),
      );
  });

  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }
  cardName(cardId: string): string {
    return this.store.cards().find((card) => card.id === cardId)?.nickname ?? 'Archived card';
  }
  cardLastFour(cardId: string): string {
    return this.store.cards().find((card) => card.id === cardId)?.lastFourDigits ?? '••••';
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
    this.form.reset({
      cardId: value.cardId,
      type: 'PURCHASE',
      amount: '',
      transactionDate: new Date().toISOString().slice(0, 10),
      categoryId: this.store.categories()[0]?.id ?? 'other',
      merchant: '',
      notes: '',
    });
    this.showForm.set(false);
  }
}
