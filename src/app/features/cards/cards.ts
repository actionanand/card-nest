import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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
import { AppIcon } from '../../shared/app-icon';

type CardFilter = 'ALL' | 'DUE' | 'GRACE' | 'FEE' | 'EXPIRING';

@Component({
  selector: 'app-cards-page',
  imports: [ReactiveFormsModule, CardNetworkLogo, RouterLink, AppIcon],
  templateUrl: './cards.html',
  styleUrl: './cards.scss',
})
export class CardsPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly showForm = signal(this.route.snapshot.queryParamMap.get('add') === 'true');
  readonly editingId = signal<string | null>(null);
  readonly selectedCardId = signal<string | null>(this.route.snapshot.queryParamMap.get('open'));
  readonly showArchived = signal(false);
  readonly actionMenuId = signal<string | null>(null);
  readonly cardFilter = signal<CardFilter>('ALL');
  readonly visibleCards = computed(() =>
    this.store
      .cards()
      .filter((card) => (this.showArchived() ? card.archived : !card.archived))
      .filter((card) => this.matchesFilter(card))
      .sort((a, b) =>
        this.cardFilter() === 'GRACE'
          ? this.grace(b) - this.grace(a)
          : this.dueDate(a).getTime() - this.dueDate(b).getTime(),
      ),
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
  readonly months = Array.from({ length: 12 }, (_, index) => index + 1);
  readonly years = Array.from({ length: 16 }, (_, index) => new Date().getFullYear() + index);
  readonly days = Array.from({ length: 31 }, (_, index) => index + 1);
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
    annualFeeEnabled: new FormControl(false, { nonNullable: true }),
    annualFeeAmount: new FormControl('', { nonNullable: true }),
    renewalMonth: new FormControl(1, { nonNullable: true }),
    renewalDay: new FormControl(1, { nonNullable: true }),
    waiverThreshold: new FormControl('', { nonNullable: true }),
    waiverPeriod: new FormControl<'ANNIVERSARY' | 'CALENDAR' | 'FINANCIAL' | 'CUSTOM'>(
      'ANNIVERSARY',
      {
        nonNullable: true,
      },
    ),
    notes: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(500)] }),
    emergencyPhones: new FormControl('', { nonNullable: true }),
    supportEmails: new FormControl('', { nonNullable: true }),
  });

  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }
  twoDigit(value: number): string {
    return value.toString().padStart(2, '0');
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
  statementCountdown(card: CreditCard): string {
    const days = Math.max(0, daysBetween(new Date(), this.nextStatement(card)));
    return days === 0
      ? 'Bill generates today'
      : `Bill generates in ${days} ${days === 1 ? 'day' : 'days'}`;
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
    this.actionMenuId.set(null);
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
      annualFeeEnabled: card.annualFeeEnabled,
      annualFeeAmount: card.annualFee ? String(card.annualFee.amountMinor / 100) : '',
      renewalMonth: card.annualFee?.renewalMonth ?? 1,
      renewalDay: card.annualFee?.renewalDay ?? 1,
      waiverThreshold: card.annualFee?.waiverThresholdMinor
        ? String(card.annualFee.waiverThresholdMinor / 100)
        : '',
      waiverPeriod: card.annualFee?.waiverPeriod ?? 'ANNIVERSARY',
      notes: card.notes ?? '',
      emergencyPhones: card.emergencyPhones.join(', '),
      supportEmails: card.supportEmails.join(', '),
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
    const annualFeeAmount = value.annualFeeAmount
      ? parseMoneyToMinor(value.annualFeeAmount)
      : undefined;
    const waiverThreshold = value.waiverThreshold
      ? parseMoneyToMinor(value.waiverThreshold)
      : undefined;
    if (parsedCreditLimit === null) this.form.controls.creditLimit.setErrors({ money: true });
    if (value.annualFeeEnabled && (!annualFeeAmount || annualFeeAmount < 1))
      this.form.controls.annualFeeAmount.setErrors({ money: true });
    if (waiverThreshold === null) this.form.controls.waiverThreshold.setErrors({ money: true });
    if (this.form.invalid || parsedCreditLimit === null || waiverThreshold === null) return;
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
      dueDateMode: 'DAYS_AFTER_STATEMENT',
      paymentDueDay: undefined,
      daysAfterStatement: value.daysAfterStatement,
      adjustDueDateOnWeekend: existing?.adjustDueDateOnWeekend ?? true,
      creditLimitMinor: parsedCreditLimit,
      currencyCode: existing?.currencyCode ?? 'INR',
      openingBalanceMinor: existing?.openingBalanceMinor ?? 0,
      remindToSettle: existing?.remindToSettle ?? true,
      annualFeeEnabled: value.annualFeeEnabled,
      annualFee:
        value.annualFeeEnabled && annualFeeAmount
          ? {
              amountMinor: annualFeeAmount,
              renewalMonth: value.renewalMonth,
              renewalDay: value.renewalDay,
              frequencyMonths: 12,
              waiverThresholdMinor: waiverThreshold,
              waiverPeriod: value.waiverPeriod,
            }
          : undefined,
      emergencyPhones: this.splitValues(value.emergencyPhones),
      supportEmails: this.splitValues(value.supportEmails),
      notes: value.notes.trim() || undefined,
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
  toggleActionMenu(cardId: string): void {
    this.actionMenuId.set(this.actionMenuId() === cardId ? null : cardId);
  }
  showTransactions(cardId: string): void {
    this.actionMenuId.set(null);
    void this.router.navigate(['/transactions'], { queryParams: { source: cardId } });
  }
  pay(card: CreditCard, amount: number, label: string): void {
    this.store.recordPayment(card.id, Math.max(0, amount), label);
    this.actionMenuId.set(null);
  }
  markSettled(card: CreditCard): void {
    this.pay(card, Math.max(0, this.store.cardOutstanding(card.id)), 'Marked as settled');
  }
  delete(card: CreditCard): void {
    if (!globalThis.confirm?.(`Delete ${card.nickname} and its transactions?`)) return;
    this.store.deleteCard(card.id);
    this.actionMenuId.set(null);
    this.selectedCardId.set(null);
  }
  updateCardFilter(event: Event): void {
    this.cardFilter.set((event.target as HTMLSelectElement).value as CardFilter);
  }
  private matchesFilter(card: CreditCard): boolean {
    const filter = this.cardFilter();
    if (filter === 'ALL' || filter === 'GRACE') return true;
    if (filter === 'DUE') return this.store.cardOutstanding(card.id) > 0;
    if (filter === 'FEE') return Boolean(card.annualFeeEnabled && card.annualFee);
    if (!card.expiryMonth || !card.expiryYear) return false;
    const expiry = new Date(card.expiryYear, card.expiryMonth, 0);
    return expiry.getTime() - Date.now() <= 1000 * 60 * 60 * 24 * 120;
  }
  private splitValues(value: string): readonly string[] {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
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
      annualFeeEnabled: false,
      annualFeeAmount: '',
      renewalMonth: 1,
      renewalDay: 1,
      waiverThreshold: '',
      waiverPeriod: 'ANNIVERSARY',
      notes: '',
      emergencyPhones: '',
      supportEmails: '',
    });
  }
}
