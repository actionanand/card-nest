import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { CardNetwork, CreditCard } from '../../core/models/domain';
import {
  daysBetween,
  estimatedGracePeriod,
  paymentDueDate,
  statementDateFor,
  toIsoDate,
} from '../../core/services/billing-cycle';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { CardNetworkLogo } from '../../shared/card-network-logo';

@Component({
  selector: 'app-cards-page',
  imports: [ReactiveFormsModule, CardNetworkLogo],
  templateUrl: './cards.html',
  styleUrl: './cards.scss',
})
export class CardsPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  readonly showForm = signal(this.route.snapshot.queryParamMap.get('add') === 'true');
  readonly editingId = signal<string | null>(null);
  readonly selectedCardId = signal<string | null>(null);
  readonly showArchived = signal(false);
  readonly visibleCards = computed(() =>
    this.store.cards().filter((card) => (this.showArchived() ? card.archived : !card.archived)),
  );
  readonly selectedCard = computed(
    () => this.store.cards().find((card) => card.id === this.selectedCardId()) ?? null,
  );
  readonly networks: readonly { value: CardNetwork; label: string }[] = [
    { value: 'VISA', label: 'Visa' },
    { value: 'MASTERCARD', label: 'Mastercard' },
    { value: 'RUPAY', label: 'RuPay' },
    { value: 'AMERICAN_EXPRESS', label: 'American Express' },
    { value: 'DISCOVER', label: 'Discover' },
    { value: 'DINERS_CLUB', label: 'Diners Club' },
    { value: 'JCB', label: 'JCB' },
    { value: 'UNIONPAY', label: 'UnionPay' },
    { value: 'OTHER', label: 'Other' },
  ];
  readonly form = new FormGroup({
    nickname: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(40)],
    }),
    issuerName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    lastDigits: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^\d{4,5}$/)],
    }),
    network: new FormControl<CardNetwork>('VISA', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    expiryMonth: new FormControl<number | null>(null, [Validators.min(1), Validators.max(12)]),
    expiryYear: new FormControl<number | null>(null, [
      Validators.min(new Date().getFullYear()),
      Validators.max(2200),
    ]),
    statementDay: new FormControl(15, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1), Validators.max(31)],
    }),
    daysAfterStatement: new FormControl(20, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1), Validators.max(60)],
    }),
    creditLimit: new FormControl('', { nonNullable: true }),
  });

  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }
  grace(card: CreditCard): number {
    return estimatedGracePeriod(card);
  }
  utilisation(card: CreditCard): number {
    return card.creditLimitMinor
      ? Math.max(0, Math.round((this.store.cardOutstanding(card.id) / card.creditLimitMinor) * 100))
      : 0;
  }
  expiry(card: CreditCard): string {
    return card.expiryMonth && card.expiryYear
      ? `${String(card.expiryMonth).padStart(2, '0')}/${String(card.expiryYear).slice(-2)}`
      : 'Not set';
  }
  nextStatement(card: CreditCard): Date {
    return statementDateFor(new Date(), card.statementDay);
  }
  dueDate(card: CreditCard): Date {
    return paymentDueDate(this.nextStatement(card), card);
  }
  date(value: Date): string {
    return value.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  dueAmount(card: CreditCard): number {
    return Math.max(0, Math.round(this.store.cardOutstanding(card.id) * 0.62));
  }
  availableCredit(card: CreditCard): number {
    return Math.max(0, (card.creditLimitMinor ?? 0) - this.store.cardOutstanding(card.id));
  }
  paymentStatus(card: CreditCard): string {
    const value = this.store.cardOutstanding(card.id);
    return value < 0
      ? 'Advance credit'
      : value === 0
        ? 'Fully paid'
        : daysBetween(new Date(), this.dueDate(card)) < 0
          ? 'Overdue'
          : 'Payment pending';
  }
  isAmex(): boolean {
    return this.form.controls.network.value === 'AMERICAN_EXPRESS';
  }
  digitsLabel(): string {
    return this.isAmex() ? 'Last five digits' : 'Last four digits';
  }

  selectCard(card: CreditCard): void {
    this.selectedCardId.set(this.selectedCardId() === card.id ? null : card.id);
  }
  openAdd(): void {
    this.editingId.set(null);
    this.resetForm();
    this.showForm.set(true);
  }
  edit(card: CreditCard): void {
    this.editingId.set(card.id);
    this.form.reset({
      nickname: card.nickname,
      issuerName: card.issuerName,
      lastDigits: card.lastDigits,
      network: card.network,
      expiryMonth: card.expiryMonth ?? null,
      expiryYear: card.expiryYear ?? null,
      statementDay: card.statementDay,
      daysAfterStatement: card.daysAfterStatement ?? 20,
      creditLimit: card.creditLimitMinor === undefined ? '' : String(card.creditLimitMinor / 100),
    });
    this.showForm.set(true);
    globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
    this.resetForm();
  }
  networkChanged(): void {
    this.form.controls.lastDigits.setValue('');
    this.form.controls.lastDigits.markAsUntouched();
  }

  save(): void {
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    const expectedDigits = value.network === 'AMERICAN_EXPRESS' ? 5 : 4;
    if (!new RegExp(`^\\d{${expectedDigits}}$`).test(value.lastDigits))
      this.form.controls.lastDigits.setErrors({ cardDigits: true });
    const parsedCreditLimit = value.creditLimit ? parseMoneyToMinor(value.creditLimit) : undefined;
    if (parsedCreditLimit === null) this.form.controls.creditLimit.setErrors({ money: true });
    if (this.form.invalid || parsedCreditLimit === null) return;
    const existing = this.store.cards().find((card) => card.id === this.editingId());
    const timestamp = new Date().toISOString();
    const card: CreditCard = {
      ...existing,
      id: existing?.id ?? crypto.randomUUID(),
      nickname: value.nickname.trim(),
      issuerName: value.issuerName.trim(),
      lastDigits: value.lastDigits,
      network: value.network,
      theme: existing?.theme ?? (this.store.cards().length % 2 ? 'teal' : 'indigo'),
      expiryMonth: value.expiryMonth ?? undefined,
      expiryYear: value.expiryYear ?? undefined,
      statementDay: value.statementDay,
      dueDateMode: existing?.dueDateMode ?? 'DAYS_AFTER_STATEMENT',
      daysAfterStatement: value.daysAfterStatement,
      adjustDueDateOnWeekend: existing?.adjustDueDateOnWeekend ?? true,
      creditLimitMinor: parsedCreditLimit,
      currencyCode: existing?.currencyCode ?? 'INR',
      openingBalanceMinor: existing?.openingBalanceMinor ?? 0,
      remindToSettle: existing?.remindToSettle ?? true,
      annualFeeEnabled: existing?.annualFeeEnabled ?? false,
      annualFee: existing?.annualFee,
      emergencyPhones: existing?.emergencyPhones ?? [],
      supportEmails: existing?.supportEmails ?? [],
      archived: existing?.archived ?? false,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (existing) this.store.updateCard(card);
    else this.store.addCard(card);
    this.selectedCardId.set(card.id);
    this.closeForm();
  }

  cutoff(card: CreditCard): string {
    return toIsoDate(this.nextStatement(card));
  }
  private resetForm(): void {
    this.form.reset({
      network: 'VISA',
      statementDay: 15,
      daysAfterStatement: 20,
      nickname: '',
      issuerName: '',
      lastDigits: '',
      creditLimit: '',
      expiryMonth: null,
      expiryYear: null,
    });
  }
}
