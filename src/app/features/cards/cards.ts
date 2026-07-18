import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CardBenefit, CardImportantLink, CardNetwork, CreditCard } from '../../core/models/domain';
import {
  daysBetween,
  estimatedGracePeriod,
  paymentDueDate,
  previousStatementDate,
  statementDateFor,
  toIsoDate,
} from '../../core/services/billing-cycle';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { SensitiveCardDataService } from '../../core/services/sensitive-card-data.service';
import { SnackbarService } from '../../core/services/snackbar.service';
import { CardNetworkLogo } from '../../shared/card-network-logo';
import { AppIcon } from '../../shared/app-icon';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { DateFormatService } from '../../core/services/date-format.service';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';

type CardFilter = 'ALL' | 'DUE' | 'GRACE' | 'FEE' | 'EXPIRING';
type PaymentMode = 'DUE' | 'OUTSTANDING' | 'CUSTOM';
type ArchiveAction = 'ARCHIVE' | 'RESTORE';

@Component({
  selector: 'app-cards-page',
  imports: [
    ReactiveFormsModule,
    CardNetworkLogo,
    RouterLink,
    AppIcon,
    ConfirmationDialog,
    AppSelectPicker,
  ],
  templateUrl: './cards.html',
  styleUrl: './cards.scss',
  host: {
    '(document:keydown.escape)': 'closeForm()',
    '(document:click)': 'closeMenuFromOutside($event)',
  },
})
export class CardsPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly secrets = inject(SensitiveCardDataService);
  private readonly snackbar = inject(SnackbarService);
  private readonly dates = inject(DateFormatService);
  private readonly requestedEditId = this.route.snapshot.queryParamMap.get('edit');
  private requestedEditHandled = false;
  readonly showForm = signal(this.route.snapshot.queryParamMap.get('add') === 'true');
  readonly editingId = signal<string | null>(null);
  readonly selectedCardId = signal<string | null>(this.route.snapshot.queryParamMap.get('open'));
  readonly showArchived = signal(false);
  readonly actionMenuId = signal<string | null>(null);
  readonly actionMenuOpensUp = signal(false);
  readonly deleteCandidate = signal<CreditCard | null>(null);
  readonly archiveCandidate = signal<{ card: CreditCard; action: ArchiveAction } | null>(null);
  readonly paymentCard = signal<CreditCard | null>(null);
  readonly paymentMode = signal<PaymentMode>('CUSTOM');
  readonly paymentAmount = signal('');
  readonly paymentError = signal<string | null>(null);
  readonly paymentConfirmationOpen = signal(false);
  readonly search = signal('');
  readonly formError = signal<string | null>(null);
  readonly draftBenefits = signal<readonly CardBenefit[]>([]);
  readonly revealedCardId = signal<string | null>(null);
  readonly revealedNumber = signal('');
  readonly revealedCvv = signal('');
  readonly cardFilter = signal<CardFilter>('ALL');
  readonly visibleCards = computed(() =>
    this.store
      .cards()
      .filter((card) => !card.deletedAt)
      .filter((card) => (this.showArchived() ? card.archived : !card.archived))
      .filter((card) => this.matchesFilter(card))
      .filter((card) => {
        const term = this.search().trim().toLocaleLowerCase();
        return (
          !term ||
          card.nickname.toLocaleLowerCase().includes(term) ||
          card.issuerName.toLocaleLowerCase().includes(term) ||
          card.network.replaceAll('_', ' ').toLocaleLowerCase().includes(term) ||
          card.subtype?.toLocaleLowerCase().includes(term) ||
          card.lastDigits.includes(term)
        );
      })
      .sort((a, b) =>
        this.cardFilter() === 'GRACE'
          ? this.grace(b) - this.grace(a)
          : this.dueDate(a).getTime() - this.dueDate(b).getTime(),
      ),
  );
  readonly selectedCard = computed(
    () => this.store.cards().find((card) => card.id === this.selectedCardId()) ?? null,
  );
  readonly editingCard = computed(
    () => this.store.cards().find((card) => card.id === this.editingId()) ?? null,
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
  readonly years = Array.from(
    { length: 2100 - new Date().getFullYear() + 1 },
    (_, index) => new Date().getFullYear() + index,
  );
  readonly days = Array.from({ length: 31 }, (_, index) => index + 1);
  readonly networkOptions: readonly AppSelectOption[] = this.networks;
  readonly expiryMonthOptions: readonly AppSelectOption[] = [
    { value: '', label: 'Month' },
    ...this.months.map((month) => ({ value: String(month), label: this.twoDigit(month) })),
  ];
  readonly expiryYearOptions: readonly AppSelectOption[] = [
    { value: '', label: 'Year' },
    ...this.years.map((year) => ({ value: String(year), label: String(year) })),
  ];
  readonly statementDayOptions: readonly AppSelectOption[] = this.days.map((day) => ({
    value: String(day),
    label: `Day ${day}`,
  }));
  readonly cardFilterOptions: readonly AppSelectOption[] = [
    { value: 'ALL', label: 'All cards' },
    { value: 'DUE', label: 'Incoming payment due' },
    { value: 'GRACE', label: 'Longest grace period' },
    { value: 'FEE', label: 'Annual fee due' },
    { value: 'EXPIRING', label: 'Expiring soon' },
  ];
  readonly renewalMonthOptions: readonly AppSelectOption[] = this.months.map((month) => ({
    value: String(month),
    label: String(month),
  }));
  readonly renewalDayOptions: readonly AppSelectOption[] = this.days.map((day) => ({
    value: String(day),
    label: String(day),
  }));
  readonly waiverPeriodOptions: readonly AppSelectOption[] = [
    { value: 'ANNIVERSARY', label: 'Card anniversary' },
    { value: 'CALENDAR', label: 'Calendar year' },
    { value: 'FINANCIAL', label: 'Financial year' },
    { value: 'CUSTOM', label: 'Custom issuer period' },
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
    }),
    network: new FormControl<CardNetwork>('VISA', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    subtype: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(60)] }),
    cardholderName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(80)],
    }),
    fullNumber: new FormControl('', { nonNullable: true }),
    cvv: new FormControl('', { nonNullable: true }),
    expiryMonth: new FormControl<number | null>(null, [
      Validators.required,
      Validators.min(1),
      Validators.max(12),
    ]),
    expiryYear: new FormControl<number | null>(null, [
      Validators.required,
      Validators.min(new Date().getFullYear()),
      Validators.max(2100),
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
    emergencyPhones: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(300), Validators.pattern(/^[+\d\s(),-]*$/)],
    }),
    supportEmails: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(500)],
    }),
    importantLinks: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(1000)],
    }),
    benefitName: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(40)] }),
    benefitNote: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(240)],
    }),
    relationshipGroup: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(80)],
    }),
  });

  setNetwork(value: string): void {
    this.form.controls.network.setValue(value as CardNetwork);
    this.form.controls.network.markAsDirty();
    this.networkChanged();
  }

  setExpiryMonth(value: string): void {
    this.form.controls.expiryMonth.setValue(value ? Number(value) : null);
    this.form.controls.expiryMonth.markAsDirty();
    this.form.controls.expiryMonth.markAsTouched();
  }

  setExpiryYear(value: string): void {
    this.form.controls.expiryYear.setValue(value ? Number(value) : null);
    this.form.controls.expiryYear.markAsDirty();
    this.form.controls.expiryYear.markAsTouched();
  }

  setStatementDay(value: string): void {
    this.form.controls.statementDay.setValue(Number(value));
    this.form.controls.statementDay.markAsDirty();
  }

  setRenewalMonth(value: string): void {
    this.form.controls.renewalMonth.setValue(Number(value));
    this.form.controls.renewalMonth.markAsDirty();
  }

  setRenewalDay(value: string): void {
    this.form.controls.renewalDay.setValue(Number(value));
    this.form.controls.renewalDay.markAsDirty();
  }

  setWaiverPeriod(value: string): void {
    this.form.controls.waiverPeriod.setValue(
      value as 'ANNIVERSARY' | 'CALENDAR' | 'FINANCIAL' | 'CUSTOM',
    );
    this.form.controls.waiverPeriod.markAsDirty();
  }

  setRelationshipGroup(value: string): void {
    this.form.controls.relationshipGroup.setValue(value);
    this.form.controls.relationshipGroup.markAsDirty();
  }

  relationshipOptions(): readonly AppSelectOption[] {
    return [
      { value: '', label: 'Not linked' },
      ...this.linkableCards().map((card) => ({
        value: card.id,
        label: card.nickname,
        detail: `${card.lastDigits} · ${card.network.replace('_', ' ')}${card.archived ? ' · Archived' : ''}`,
      })),
    ];
  }

  constructor() {
    effect(() => {
      if (!this.requestedEditId || this.requestedEditHandled) return;
      const card = this.store.cards().find((item) => item.id === this.requestedEditId);
      if (!card) return;
      this.requestedEditHandled = true;
      queueMicrotask(() => this.edit(card));
    });
  }

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
    const nextStatement = this.nextStatement(card);
    const statement =
      this.dueAmount(card) > 0
        ? previousStatementDate(nextStatement, card.statementDay)
        : nextStatement;
    return paymentDueDate(statement, card);
  }
  statementCountdown(card: CreditCard): string {
    const days = Math.max(0, daysBetween(new Date(), this.nextStatement(card)));
    return days === 0
      ? 'Bill generates today'
      : `Bill generates in ${days} ${days === 1 ? 'day' : 'days'}`;
  }
  date(value: Date): string {
    return this.dates.format(value);
  }
  dueAmount(card: CreditCard): number {
    return this.store.cardDueAmount(card.id);
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
  updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }
  digitsOnly(event: Event, control: 'lastDigits' | 'cvv'): void {
    const input = event.target as HTMLInputElement;
    const limit = control === 'lastDigits' ? (this.isAmex() ? 5 : 4) : this.isAmex() ? 4 : 3;
    const value = input.value.replace(/\D/g, '').slice(0, limit);
    input.value = value;
    this.form.controls[control].setValue(value);
    if (control === 'lastDigits') this.form.controls.fullNumber.setErrors(null);
  }
  formatCardNumberInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const digits = input.value.replace(/\D/g, '').slice(0, this.isAmex() ? 15 : 16);
    const formatted = this.formatCardNumber(digits, this.form.controls.network.value);
    input.value = formatted;
    this.form.controls.fullNumber.setValue(formatted);
    const expectedLength = this.isAmex() ? 15 : 16;
    if (digits.length === expectedLength) {
      const finalDigitCount = this.isAmex() ? 5 : 4;
      this.form.controls.lastDigits.setValue(digits.slice(-finalDigitCount));
      this.form.controls.lastDigits.setErrors(null);
    }
    this.form.controls.fullNumber.setErrors(null);
    this.formError.set(null);
  }
  formatCardNumber(value: string, network: CardNetwork): string {
    const digits = value.replace(/\D/g, '');
    const groups = network === 'AMERICAN_EXPRESS' ? [4, 6, 5] : [4, 4, 4, 4];
    const parts: string[] = [];
    let offset = 0;
    for (const size of groups) {
      const part = digits.slice(offset, offset + size);
      if (part) parts.push(part);
      offset += size;
    }
    return parts.join('-');
  }

  selectCard(card: CreditCard): void {
    this.actionMenuId.set(null);
    this.selectedCardId.set(this.selectedCardId() === card.id ? null : card.id);
  }
  openAdd(): void {
    this.editingId.set(null);
    this.resetForm();
    this.draftBenefits.set([]);
    this.showForm.set(true);
  }
  edit(card: CreditCard): void {
    const linkedCard = this.relatedCardFor(card);
    this.editingId.set(card.id);
    this.form.reset({
      nickname: card.nickname,
      issuerName: card.issuerName,
      lastDigits: card.lastDigits,
      network: card.network,
      subtype: card.subtype ?? '',
      cardholderName: card.cardholderName ?? '',
      fullNumber: '',
      cvv: '',
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
      importantLinks: (card.importantLinks ?? [])
        .map((link) => `${link.label} | ${link.url}`)
        .join('\n'),
      benefitName: '',
      benefitNote: '',
      relationshipGroup: linkedCard?.id ?? '',
    });
    this.draftBenefits.set(card.benefits ?? []);
    this.showForm.set(true);
    globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  closeForm(): void {
    if (this.deleteCandidate()) {
      this.deleteCandidate.set(null);
      return;
    }
    if (this.archiveCandidate()) {
      this.archiveCandidate.set(null);
      return;
    }
    if (this.paymentConfirmationOpen()) {
      this.paymentConfirmationOpen.set(false);
      return;
    }
    if (this.paymentCard()) {
      this.paymentCard.set(null);
      return;
    }
    this.showForm.set(false);
    this.editingId.set(null);
    this.resetForm();
    this.formError.set(null);
  }
  networkChanged(): void {
    this.form.controls.lastDigits.setValue('');
    this.form.controls.lastDigits.markAsUntouched();
    const fullNumber = this.form.controls.fullNumber.value;
    if (fullNumber) {
      const digits = fullNumber.replace(/\D/g, '').slice(0, this.isAmex() ? 15 : 16);
      this.form.controls.fullNumber.setValue(
        this.formatCardNumber(digits, this.form.controls.network.value),
      );
      if (digits.length === (this.isAmex() ? 15 : 16)) {
        this.form.controls.lastDigits.setValue(digits.slice(this.isAmex() ? -5 : -4));
      }
    }
    this.form.controls.fullNumber.setErrors(null);
  }

  issuerChanged(): void {
    const selectedCardId = this.form.controls.relationshipGroup.value;
    if (!selectedCardId) return;
    const selectedCard = this.store.cards().find((card) => card.id === selectedCardId);
    if (
      !selectedCard ||
      this.normaliseIssuer(selectedCard.issuerName) !==
        this.normaliseIssuer(this.form.controls.issuerName.value)
    ) {
      this.form.controls.relationshipGroup.setValue('');
    }
  }

  linkableCards(): readonly CreditCard[] {
    const issuer = this.normaliseIssuer(this.form.controls.issuerName.value);
    if (!issuer) return [];
    return this.store
      .cards()
      .filter(
        (card) =>
          !card.deletedAt &&
          card.id !== this.editingId() &&
          this.normaliseIssuer(card.issuerName) === issuer,
      )
      .sort((left, right) => left.nickname.localeCompare(right.nickname));
  }

  addBenefit(): void {
    const name = this.form.controls.benefitName.value.trim();
    const note = this.form.controls.benefitNote.value.trim();
    if (!name) return;
    const existing = this.draftBenefits().find(
      (benefit) => benefit.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (existing) {
      this.form.controls.benefitName.setErrors({ duplicate: true });
      return;
    }
    this.draftBenefits.update((benefits) => [
      ...benefits,
      { id: crypto.randomUUID(), name, note: note || undefined },
    ]);
    this.form.controls.benefitName.reset('');
    this.form.controls.benefitNote.reset('');
  }

  removeBenefit(benefitId: string): void {
    this.draftBenefits.update((benefits) => benefits.filter((benefit) => benefit.id !== benefitId));
  }

  async save(): Promise<void> {
    this.formError.set(null);
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    const expectedDigits = value.network === 'AMERICAN_EXPRESS' ? 5 : 4;
    const fullNumber = value.fullNumber.replace(/\D/g, '');
    const lastDigits = fullNumber ? fullNumber.slice(-expectedDigits) : value.lastDigits;
    this.form.controls.lastDigits.setValue(lastDigits);
    this.form.controls.lastDigits.setErrors(null);
    if (!new RegExp(`^\\d{${expectedDigits}}$`).test(lastDigits)) {
      this.form.controls.lastDigits.setErrors({ cardDigits: true });
    }
    const parsedCreditLimit = value.creditLimit ? parseMoneyToMinor(value.creditLimit) : undefined;
    const annualFeeAmount = value.annualFeeAmount
      ? parseMoneyToMinor(value.annualFeeAmount)
      : undefined;
    const waiverThreshold = value.waiverThreshold
      ? parseMoneyToMinor(value.waiverThreshold)
      : undefined;
    if (parsedCreditLimit === null || (parsedCreditLimit !== undefined && parsedCreditLimit <= 0))
      this.form.controls.creditLimit.setErrors({ money: true });
    if (value.annualFeeEnabled && (!annualFeeAmount || annualFeeAmount < 1))
      this.form.controls.annualFeeAmount.setErrors({ money: true });
    if (waiverThreshold === null || (waiverThreshold !== undefined && waiverThreshold <= 0))
      this.form.controls.waiverThreshold.setErrors({ money: true });
    const cvv = value.cvv.replace(/\D/g, '');
    const validFullNumber = value.network === 'AMERICAN_EXPRESS' ? /^\d{15}$/ : /^\d{16}$/;
    const validCvv = value.network === 'AMERICAN_EXPRESS' ? /^\d{4}$/ : /^\d{3}$/;
    this.form.controls.fullNumber.setErrors(null);
    if (fullNumber) {
      if (!validFullNumber.test(fullNumber)) {
        this.form.controls.fullNumber.setErrors({ cardLength: true });
      } else if (!this.passesLuhn(fullNumber)) {
        this.form.controls.fullNumber.setErrors({ cardChecksum: true });
      }
    }
    if (cvv && !validCvv.test(cvv)) this.form.controls.cvv.setErrors({ cvv: true });
    const expiryIncomplete = (value.expiryMonth === null) !== (value.expiryYear === null);
    const expiryDate =
      value.expiryMonth && value.expiryYear
        ? new Date(value.expiryYear, value.expiryMonth, 0, 23, 59, 59)
        : null;
    if (expiryIncomplete || (expiryDate && expiryDate < new Date())) {
      this.form.controls.expiryMonth.setErrors({ expiry: true });
      this.form.controls.expiryYear.setErrors({ expiry: true });
    }
    const invalidEmails = this.splitValues(value.supportEmails).some(
      (email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    );
    if (invalidEmails) this.form.controls.supportEmails.setErrors({ email: true });
    const importantLinks = this.parseImportantLinks(value.importantLinks);
    if (importantLinks === null) this.form.controls.importantLinks.setErrors({ links: true });
    const linkedCard = value.relationshipGroup
      ? this.store.cards().find((card) => card.id === value.relationshipGroup)
      : undefined;
    if (
      value.relationshipGroup &&
      (!linkedCard ||
        linkedCard.id === this.editingId() ||
        this.normaliseIssuer(linkedCard.issuerName) !== this.normaliseIssuer(value.issuerName))
    ) {
      this.form.controls.relationshipGroup.setErrors({ issuerMismatch: true });
    }
    if (this.form.invalid || parsedCreditLimit === null || waiverThreshold === null) {
      this.formError.set('Check the fields marked in red before saving the card.');
      queueMicrotask(() =>
        globalThis.document
          ?.querySelector<HTMLElement>('.card-form')
          ?.scrollTo({ top: 0, behavior: 'smooth' }),
      );
      return;
    }
    const existing = this.store.cards().find((card) => card.id === this.editingId());
    const timestamp = new Date().toISOString();
    const relationshipGroupId = linkedCard
      ? (linkedCard.relationshipGroupId ?? existing?.relationshipGroupId ?? crypto.randomUUID())
      : undefined;
    const card: CreditCard = {
      ...existing,
      id: existing?.id ?? crypto.randomUUID(),
      nickname: value.nickname.trim(),
      issuerName: value.issuerName.trim(),
      lastDigits,
      encryptedFullNumber: fullNumber
        ? await this.secrets.encrypt(fullNumber)
        : existing?.encryptedFullNumber,
      encryptedCvv: cvv ? await this.secrets.encrypt(cvv) : existing?.encryptedCvv,
      network: value.network,
      subtype: value.subtype.trim() || undefined,
      cardholderName: value.cardholderName.trim() || undefined,
      benefits: this.draftBenefits(),
      importantLinks: importantLinks ?? [],
      relationshipGroupId,
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
    if (linkedCard && linkedCard.relationshipGroupId !== relationshipGroupId) {
      this.store.updateCard({
        ...linkedCard,
        relationshipGroupId,
        updatedAt: timestamp,
      });
    }
    if (existing) this.store.updateCard(card);
    else this.store.addCard(card);
    this.snackbar.show(existing ? `${card.nickname} updated.` : `${card.nickname} added.`);
    this.selectedCardId.set(card.id);
    this.closeForm();
  }

  cutoff(card: CreditCard): string {
    return toIsoDate(this.nextStatement(card));
  }
  toggleActionMenu(event: MouseEvent, cardId: string): void {
    if (this.actionMenuId() === cardId) {
      this.actionMenuId.set(null);
      return;
    }
    this.actionMenuId.set(cardId);
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const trigger = event.currentTarget;
    requestAnimationFrame(() => {
      const menu = trigger.parentElement?.querySelector<HTMLElement>('.action-menu');
      if (!menu) return;
      const triggerRect = trigger.getBoundingClientRect();
      const spaceBelow = globalThis.innerHeight - triggerRect.bottom;
      this.actionMenuOpensUp.set(
        spaceBelow < menu.offsetHeight + 8 && triggerRect.top > spaceBelow,
      );
    });
  }
  closeMenuFromOutside(event: Event): void {
    if (!(event.target instanceof Element) || !event.target.closest('[data-action-menu]')) {
      this.actionMenuId.set(null);
    }
  }
  showTransactions(cardId: string): void {
    this.actionMenuId.set(null);
    void this.router.navigate(['/transactions'], { queryParams: { source: cardId } });
  }
  openPayment(card: CreditCard, mode: PaymentMode): void {
    const outstanding = Math.max(0, this.store.cardOutstanding(card.id));
    const amount = mode === 'DUE' ? this.dueAmount(card) : outstanding;
    if (amount <= 0) return;
    this.paymentCard.set(card);
    this.paymentMode.set(mode);
    this.paymentAmount.set(String(amount / 100));
    this.paymentError.set(null);
    this.actionMenuId.set(null);
  }
  reviewPayment(event: Event): void {
    event.preventDefault();
    const amount = parseMoneyToMinor(this.paymentAmount());
    if (!amount || amount <= 0) {
      this.paymentError.set('Enter a valid payment amount.');
      return;
    }
    this.paymentError.set(null);
    this.paymentConfirmationOpen.set(true);
  }
  paymentMinor(): number {
    return parseMoneyToMinor(this.paymentAmount()) ?? 0;
  }
  confirmPayment(): void {
    const card = this.paymentCard();
    const amount = parseMoneyToMinor(this.paymentAmount());
    if (!card || !amount) return;
    const label =
      this.paymentMode() === 'DUE'
        ? 'Due amount paid'
        : this.paymentMode() === 'OUTSTANDING'
          ? 'Outstanding paid'
          : 'Card payment';
    this.store.recordPayment(card.id, amount, label);
    this.paymentConfirmationOpen.set(false);
    this.paymentCard.set(null);
    this.snackbar.show(`${this.money(amount, card.currencyCode)} payment recorded.`);
  }
  delete(card: CreditCard): void {
    this.deleteCandidate.set(card);
    this.actionMenuId.set(null);
  }
  confirmDelete(): void {
    const card = this.deleteCandidate();
    if (!card) return;
    this.store.deleteCard(card.id);
    this.deleteCandidate.set(null);
    this.actionMenuId.set(null);
    this.selectedCardId.set(null);
    this.snackbar.show(`${card.nickname} deleted.`, 'WARNING');
  }
  linkedCardsFor(card: CreditCard): readonly CreditCard[] {
    if (!card.relationshipGroupId) return [];
    return this.store
      .cards()
      .filter(
        (candidate) =>
          !candidate.deletedAt &&
          candidate.id !== card.id &&
          candidate.relationshipGroupId === card.relationshipGroupId,
      );
  }
  requestArchive(card: CreditCard): void {
    this.archiveCandidate.set({ card, action: card.archived ? 'RESTORE' : 'ARCHIVE' });
    this.actionMenuId.set(null);
  }
  confirmArchive(): void {
    const candidate = this.archiveCandidate();
    if (!candidate) return;
    if (candidate.action === 'RESTORE') {
      this.store.restoreCard(candidate.card.id);
      this.snackbar.show(`${candidate.card.nickname} restored.`);
    } else {
      this.store.archiveCard(candidate.card.id);
      this.snackbar.show(`${candidate.card.nickname} archived.`, 'INFO');
    }
    this.archiveCandidate.set(null);
  }
  archivedDate(card: CreditCard): string {
    return card.archivedAt ? this.date(new Date(card.archivedAt)) : 'Date unavailable';
  }
  waiverDeadline(card: CreditCard): Date | null {
    const fee = card.annualFee;
    if (!fee?.waiverThresholdMinor) return null;
    const now = new Date();
    if (fee.waiverPeriod === 'CALENDAR') return new Date(now.getFullYear(), 11, 31);
    if (fee.waiverPeriod === 'FINANCIAL') {
      return now.getMonth() < 3
        ? new Date(now.getFullYear(), 2, 31)
        : new Date(now.getFullYear() + 1, 2, 31);
    }
    const thisYear = new Date(now.getFullYear(), fee.renewalMonth - 1, fee.renewalDay);
    return thisYear >= now
      ? thisYear
      : new Date(now.getFullYear() + 1, fee.renewalMonth - 1, fee.renewalDay);
  }
  waiverSpent(card: CreditCard): number {
    const deadline = this.waiverDeadline(card);
    if (!deadline) return 0;
    const start = new Date(deadline);
    start.setFullYear(start.getFullYear() - 1);
    const startDate = toIsoDate(start);
    const now = new Date();
    const endDate = toIsoDate(now < deadline ? now : deadline);
    return Math.max(
      0,
      this.store
        .transactions()
        .filter(
          (item) =>
            item.cardId === card.id &&
            ['PURCHASE', 'REFUND', 'CASHBACK'].includes(item.type) &&
            item.transactionDate > startDate &&
            item.transactionDate <= endDate,
        )
        .reduce(
          (sum, item) => sum + (item.type === 'PURCHASE' ? item.amountMinor : -item.amountMinor),
          0,
        ),
    );
  }
  waiverRemaining(card: CreditCard): number {
    return Math.max(0, (card.annualFee?.waiverThresholdMinor ?? 0) - this.waiverSpent(card));
  }
  waiverProgress(card: CreditCard): number {
    const threshold = card.annualFee?.waiverThresholdMinor ?? 0;
    return threshold ? Math.min(100, Math.round((this.waiverSpent(card) / threshold) * 100)) : 0;
  }
  async revealSecrets(card: CreditCard): Promise<void> {
    if (this.revealedCardId() === card.id) {
      this.revealedCardId.set(null);
      this.revealedNumber.set('');
      this.revealedCvv.set('');
      return;
    }
    try {
      const [number, cvv] = await Promise.all([
        card.encryptedFullNumber ? this.secrets.decrypt(card.encryptedFullNumber) : '',
        card.encryptedCvv ? this.secrets.decrypt(card.encryptedCvv) : '',
      ]);
      this.revealedNumber.set(this.formatCardNumber(number, card.network));
      this.revealedCvv.set(cvv);
      this.revealedCardId.set(card.id);
    } catch {
      this.snackbar.show('The protected card details could not be revealed.', 'WARNING');
    }
  }
  removeCardBenefit(card: CreditCard, benefitId: string): void {
    this.store.updateCard({
      ...card,
      benefits: (card.benefits ?? []).filter((benefit) => benefit.id !== benefitId),
      updatedAt: new Date().toISOString(),
    });
    this.snackbar.show('Card benefit removed.', 'INFO');
  }
  updateCardFilter(value: string): void {
    this.cardFilter.set(value as CardFilter);
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
  private relatedCardFor(card: CreditCard): CreditCard | undefined {
    if (!card.relationshipGroupId) return undefined;
    const issuer = this.normaliseIssuer(card.issuerName);
    return this.store
      .cards()
      .find(
        (candidate) =>
          !candidate.deletedAt &&
          candidate.id !== card.id &&
          candidate.relationshipGroupId === card.relationshipGroupId &&
          this.normaliseIssuer(candidate.issuerName) === issuer,
      );
  }
  private normaliseIssuer(value: string): string {
    return value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }
  private passesLuhn(value: string): boolean {
    let sum = 0;
    let double = false;
    for (let index = value.length - 1; index >= 0; index -= 1) {
      let digit = Number(value[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    return sum % 10 === 0;
  }
  private resetForm(): void {
    this.form.reset({
      network: 'VISA',
      subtype: '',
      cardholderName: '',
      fullNumber: '',
      cvv: '',
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
      importantLinks: '',
      benefitName: '',
      benefitNote: '',
      relationshipGroup: '',
    });
  }

  private parseImportantLinks(value: string): readonly CardImportantLink[] | null {
    const links: CardImportantLink[] = [];
    for (const line of value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)) {
      const [labelPart, urlPart] = line.includes('|')
        ? line.split('|', 2).map((item) => item.trim())
        : ['', line];
      try {
        const parsed = new URL(urlPart);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        links.push({
          id: crypto.randomUUID(),
          label: labelPart || parsed.hostname,
          url: parsed.toString(),
        });
      } catch {
        return null;
      }
    }
    return links;
  }
}
