import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { CardTransaction, EmiPlan, TransactionType } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { CategoriesPage } from '../categories/categories';
import { ExportDialog } from '../../shared/export-dialog';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { ExportFormat } from '../../core/models/export';
import { createEmiSchedule } from '../../core/services/emi';
import { AppDatePipe } from '../../core/services/date-format.service';

type GroupingMode = 'MONTH' | 'CYCLE' | 'STATEMENT';
type TransactionTypeFilter = TransactionType | 'ALL' | 'WITH_IMAGE';
type RepeatChoice = 'NONE' | 'INFINITE' | `${number}`;
type EmiKind = 'NO_COST' | 'STANDARD';
type EmiStartMode = 'THIS_MONTH' | 'NEXT_MONTH' | 'CUSTOM';
const TRANSACTION_PAGE_SIZE = 200;
const MAX_RECEIPT_BYTES = 1_000_000;

@Component({
  selector: 'app-transactions-page',
  imports: [
    ReactiveFormsModule,
    AppIcon,
    AppDatePipe,
    CategoriesPage,
    ExportDialog,
    ConfirmationDialog,
  ],
  templateUrl: './transactions.html',
  styleUrl: './transactions.scss',
  host: {
    '(document:keydown.escape)': 'closeOverlays()',
    '(document:click)': 'closeMenusFromOutside($event)',
  },
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
  readonly receiptPreviews = signal<readonly string[]>([]);
  readonly detailTransactionId = signal<string | null>(null);
  readonly detailTransaction = computed(
    () => this.store.transactions().find((item) => item.id === this.detailTransactionId()) ?? null,
  );
  readonly showEmiForm = signal(false);
  readonly showSplitForm = signal(false);
  readonly deleteCandidate = signal<CardTransaction | null>(null);
  readonly payFromOpen = signal(false);
  readonly sourceFilterOpen = signal(false);
  readonly filtersOpen = signal(false);
  readonly actionMenuId = signal<string | null>(null);
  readonly actionMenuOpensUp = signal(false);
  readonly summaryMenuOpen = signal(false);
  readonly summaryMenuOpensUp = signal(false);
  readonly manageCategoriesOpen = signal(false);
  readonly exportOpen = signal(false);
  readonly exportFormat = signal<ExportFormat>('PDF');
  readonly hideCredits = signal(false);
  readonly creditCardsOnly = signal(false);
  readonly search = signal('');
  readonly typeFilter = signal<TransactionTypeFilter>('ALL');
  readonly sourceFilter = signal(this.requestedSourceId ?? 'ALL');
  readonly categoryFilter = signal('ALL');
  readonly grouping = signal<GroupingMode>('MONTH');
  readonly visibleLimit = signal(TRANSACTION_PAGE_SIZE);
  readonly activeFilterCount = computed(
    () =>
      Number(Boolean(this.search().trim())) +
      Number(this.typeFilter() !== 'ALL') +
      Number(this.sourceFilter() !== 'ALL') +
      Number(this.categoryFilter() !== 'ALL') +
      Number(this.grouping() !== 'MONTH'),
  );
  readonly repeatOptions = Array.from({ length: 36 }, (_, index) => index + 1);
  readonly types: readonly { value: TransactionType; label: string }[] = [
    { value: 'PURCHASE', label: 'Purchase' },
    { value: 'ADJUSTMENT', label: 'Adjustment' },
    { value: 'PAYMENT', label: 'Card payment' },
    { value: 'REFUND', label: 'Refund' },
    { value: 'CASHBACK', label: 'Cashback' },
    { value: 'CREDIT', label: 'Credit' },
    { value: 'FEE', label: 'Fee' },
    { value: 'INTEREST', label: 'Interest' },
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
    categoryId: new FormControl('other', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    merchant: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    notes: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(500)] }),
    relatedTransactionId: new FormControl('', { nonNullable: true }),
    taxIncluded: new FormControl(false, { nonNullable: true }),
    taxAmount: new FormControl('', { nonNullable: true }),
    repeat: new FormControl<RepeatChoice>('NONE', { nonNullable: true }),
  });
  readonly emiForm = new FormGroup({
    kind: new FormControl<EmiKind>('NO_COST', { nonNullable: true }),
    months: new FormControl(3, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(2), Validators.max(36)],
    }),
    annualRate: new FormControl('15', { nonNullable: true }),
    startMode: new FormControl<EmiStartMode>('THIS_MONTH', { nonNullable: true }),
    customStart: new FormControl('', { nonNullable: true }),
  });
  readonly splitForm = new FormGroup({
    parts: new FormArray([this.createSplitPart(), this.createSplitPart()]),
  });
  readonly filtered = computed(() => {
    const term = this.search().trim().toLocaleLowerCase();
    const currentMonth = new Date().toISOString().slice(0, 7);
    return this.store
      .transactions()
      .filter(
        (item) =>
          !item.emiCancelled &&
          (!item.emiInstallmentNumber ||
            item.emiInstallmentNumber === 1 ||
            item.transactionDate.slice(0, 7) <= currentMonth) &&
          (!this.hideCredits() || !this.isCredit(item.type)) &&
          (!this.creditCardsOnly() || this.store.cards().some((card) => card.id === item.cardId)) &&
          (this.typeFilter() === 'ALL' ||
            (this.typeFilter() === 'WITH_IMAGE'
              ? item.attachmentIds.length > 0
              : item.type === this.typeFilter())) &&
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
  readonly visibleTransactions = computed(() => this.filtered().slice(0, this.visibleLimit()));
  readonly remainingTransactions = computed(() =>
    Math.max(0, this.filtered().length - this.visibleTransactions().length),
  );
  readonly groups = computed(() => {
    const totals = new Map<string, number>();
    for (const transaction of this.filtered()) {
      const period = this.periodFor(transaction);
      totals.set(
        period.key,
        (totals.get(period.key) ?? 0) +
          (this.isCredit(transaction.type) ? transaction.amountMinor : -transaction.amountMinor),
      );
    }
    const grouped = new Map<string, { label: string; transactions: CardTransaction[] }>();
    for (const transaction of this.visibleTransactions()) {
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
        totalMinor: totals.get(key) ?? 0,
      }));
  });

  constructor() {
    // Handle edit requested via query param on first load.
    const transaction = this.store.transactions().find((item) => item.id === this.requestedEditId);
    if (transaction) this.edit(transaction);

    // When the nav-bar FAB navigates to /transactions?add=true while Angular reuses
    // this component (same route), the constructor doesn't re-run. Subscribe to
    // queryParamMap so we detect the param change and open the form.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      if ((params.get('add') === 'true' || params.get('payment') === 'true') && !this.showForm()) {
        this.openAdd();
      }
    });
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
    this.resetVisibleTransactions();
  }
  updateType(event: Event): void {
    this.typeFilter.set((event.target as HTMLSelectElement).value as TransactionTypeFilter);
    this.resetVisibleTransactions();
  }
  selectSourceFilter(id: string): void {
    this.sourceFilter.set(id);
    this.sourceFilterOpen.set(false);
    this.resetVisibleTransactions();
  }
  sourceFilterLabel(): string {
    if (this.sourceFilter() === 'ALL') return 'All cards and sources';
    const card = this.store.activeCards().find((item) => item.id === this.sourceFilter());
    if (card) return `${card.nickname} · ${card.lastDigits}`;
    return (
      this.store.activePaymentSources().find((item) => item.id === this.sourceFilter())?.nickname ??
      'All cards and sources'
    );
  }
  updateCategory(event: Event): void {
    this.categoryFilter.set((event.target as HTMLSelectElement).value);
    this.resetVisibleTransactions();
  }
  updateGrouping(event: Event): void {
    this.grouping.set((event.target as HTMLSelectElement).value as GroupingMode);
    this.resetVisibleTransactions();
  }
  loadMoreTransactions(): void {
    this.visibleLimit.update((value) => value + TRANSACTION_PAGE_SIZE);
  }
  toggleHideCredits(): void {
    this.hideCredits.update((value) => !value);
    this.resetVisibleTransactions();
    this.closeMenus();
  }
  toggleCreditCardsOnly(): void {
    this.creditCardsOnly.update((value) => !value);
    this.resetVisibleTransactions();
    this.closeMenus();
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
  async pickReceipts(): Promise<void> {
    try {
      // Android's system photo picker intentionally does not require broad gallery permission.
      const selection = await Camera.pickImages({ quality: 70, limit: 10 });
      const paths = selection.photos
        .map((photo) => photo.webPath)
        .filter((path): path is string => Boolean(path));
      const processed = await this.prepareReceiptImages(paths);
      if (processed.length) this.receiptPreviews.update((current) => [...current, ...processed]);
    } catch {
      // Picker was dismissed by the user — nothing to attach.
    }
  }
  async captureReceipt(): Promise<void> {
    try {
      const photo = await Camera.getPhoto({
        source: CameraSource.Camera,
        resultType: CameraResultType.Uri,
        quality: 70,
      });
      if (photo.webPath) {
        const processed = await this.prepareReceiptImages([photo.webPath]);
        if (processed.length) this.receiptPreviews.update((current) => [...current, ...processed]);
      }
    } catch {
      // Camera was dismissed by the user.
    }
  }
  removeReceipt(index: number): void {
    this.receiptPreviews.update((current) => current.filter((_, position) => position !== index));
  }
  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
    this.receiptPreviews.set([]);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { add: null, payment: null, edit: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
  selectPayFrom(id: string): void {
    this.form.controls.cardId.setValue(id);
    this.payFromOpen.set(false);
  }
  selectedSourceLabel(): string {
    const id = this.form.controls.cardId.value;
    const card = this.store.activeCards().find((c) => c.id === id);
    if (card) return `${card.nickname} · ${card.lastDigits}`;
    const source = this.store.activePaymentSources().find((s) => s.id === id);
    if (source) return source.nickname;
    return 'Select source';
  }
  edit(transaction: CardTransaction): void {
    this.closeDetails();
    this.editingId.set(transaction.id);
    this.form.reset({
      cardId: transaction.cardId,
      type: transaction.type,
      amount: String(transaction.amountMinor / 100),
      transactionDate: transaction.transactionDate,
      categoryId: transaction.categoryId,
      merchant: transaction.merchant ?? '',
      notes: transaction.notes ?? '',
      relatedTransactionId: transaction.relatedTransactionId ?? '',
      taxIncluded: transaction.taxIncluded ?? false,
      taxAmount: transaction.taxMinor === undefined ? '' : String(transaction.taxMinor / 100),
      repeat: 'NONE',
    });
    this.receiptPreviews.set(transaction.attachmentIds);
    this.showForm.set(true);
    this.closeMenus();
    globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  transactionTypeChanged(type: TransactionType): void {
    if (type === 'REFUND' || type === 'CASHBACK') {
      this.form.controls.categoryId.setValue('contra-expenses');
    } else if (type === 'CREDIT' || type === 'PAYMENT') {
      this.form.controls.categoryId.setValue('payment');
    } else {
      this.form.controls.categoryId.setValue('other');
    }
    this.form.controls.relatedTransactionId.setValue('');
  }

  relatedTransactionOptions(): readonly CardTransaction[] {
    const type = this.form.controls.type.value;
    const selectedDate = new Date(`${this.form.controls.transactionDate.value}T12:00:00`);
    if (type === 'REFUND') {
      const cutoff = new Date(selectedDate);
      cutoff.setMonth(cutoff.getMonth() - 3);
      return this.store
        .transactions()
        .filter(
          (item) =>
            item.id !== this.editingId() &&
            item.cardId === this.form.controls.cardId.value &&
            item.type === 'PURCHASE' &&
            new Date(`${item.transactionDate}T12:00:00`) >= cutoff &&
            new Date(`${item.transactionDate}T12:00:00`) <= selectedDate,
        )
        .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
    }
    if (type === 'ADJUSTMENT') {
      const previousDate = new Date(selectedDate);
      previousDate.setDate(previousDate.getDate() - 1);
      const previous = previousDate.toISOString().slice(0, 10);
      const current = this.form.controls.transactionDate.value;
      return this.store
        .transactions()
        .filter(
          (item) =>
            item.id !== this.editingId() &&
            (item.transactionDate === current || item.transactionDate === previous),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return [];
  }

  taxPercentage(transaction: CardTransaction): number {
    if (!transaction.taxMinor || transaction.amountMinor <= transaction.taxMinor) return 0;
    return (
      Math.round(
        (transaction.taxMinor / (transaction.amountMinor - transaction.taxMinor)) * 10000,
      ) / 100
    );
  }

  openDetails(transaction: CardTransaction): void {
    this.detailTransactionId.set(transaction.id);
    this.closeMenus();
  }

  closeDetails(): void {
    this.detailTransactionId.set(null);
    this.showEmiForm.set(false);
    this.showSplitForm.set(false);
  }

  relatedTransaction(transaction: CardTransaction): CardTransaction | null {
    return (
      this.store.transactions().find((item) => item.id === transaction.relatedTransactionId) ?? null
    );
  }

  linkedTransactions(transaction: CardTransaction): readonly CardTransaction[] {
    return this.store
      .transactions()
      .filter(
        (item) =>
          item.id !== transaction.id &&
          (item.id === transaction.relatedTransactionId ||
            item.relatedTransactionId === transaction.id),
      );
  }

  splitSiblings(transaction: CardTransaction): readonly CardTransaction[] {
    if (!transaction.splitGroupId) return [];
    return this.store
      .transactions()
      .filter((item) => item.splitGroupId === transaction.splitGroupId);
  }

  emiPlan(transaction: CardTransaction): EmiPlan | null {
    return this.store.emiPlans().find((plan) => plan.id === transaction.emiPlanId) ?? null;
  }

  emiInstallments(transaction: CardTransaction) {
    return this.store
      .emiInstallments()
      .filter((installment) => installment.emiPlanId === transaction.emiPlanId)
      .sort((a, b) => a.installmentNumber - b.installmentNumber);
  }

  canConvertToEmi(transaction: CardTransaction): boolean {
    return (
      transaction.type === 'PURCHASE' &&
      !transaction.emiPlanId &&
      transaction.amountMinor >= this.store.emiMinimumMinor() &&
      this.store.cards().some((card) => card.id === transaction.cardId)
    );
  }

  canSplit(transaction: CardTransaction): boolean {
    return !transaction.emiPlanId && !transaction.splitGroupId;
  }

  openEmi(transaction: CardTransaction): void {
    if (!this.canConvertToEmi(transaction)) return;
    this.emiForm.reset({
      kind: 'NO_COST',
      months: 3,
      annualRate: '15',
      startMode: 'THIS_MONTH',
      customStart: transaction.transactionDate.slice(0, 7),
    });
    this.showEmiForm.set(true);
  }

  saveEmi(transaction: CardTransaction): void {
    this.emiForm.markAllAsTouched();
    if (this.emiForm.invalid) return;
    const card = this.store.cards().find((item) => item.id === transaction.cardId);
    if (!card) return;
    const value = this.emiForm.getRawValue();
    const rate = value.kind === 'NO_COST' ? 0 : Number(value.annualRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      this.emiForm.controls.annualRate.setErrors({ rate: true });
      return;
    }
    const startDate = this.emiStartDate(
      transaction.transactionDate,
      value.startMode,
      value.customStart,
    );
    if (!startDate) {
      this.emiForm.controls.customStart.setErrors({ required: true });
      return;
    }
    const plan: EmiPlan = {
      id: crypto.randomUUID(),
      transactionId: transaction.id,
      cardId: transaction.cardId,
      convertedAmountMinor: transaction.amountMinor,
      remainingPurchaseMinor: 0,
      tenureMonths: value.months,
      annualRateBasisPoints: Math.round(rate * 100),
      interestType: value.kind,
      processingFeeMinor: 0,
      taxMinor: 0,
      startDate,
      status: 'ACTIVE',
      originalTransactionDate: transaction.transactionDate,
      originalMerchant: transaction.merchant,
    };
    this.store.saveEmiPlan(plan, createEmiSchedule(plan, card));
    this.showEmiForm.set(false);
    this.snackbar.show(`Converted into ${value.months} EMI installments.`);
  }

  openSplit(transaction: CardTransaction): void {
    if (!this.canSplit(transaction)) return;
    const half = Math.floor(transaction.amountMinor / 2);
    this.splitForm.setControl(
      'parts',
      new FormArray([
        this.createSplitPart(transaction.cardId, half),
        this.createSplitPart(transaction.cardId, transaction.amountMinor - half),
      ]),
    );
    this.showSplitForm.set(true);
  }

  addSplitPart(): void {
    if (this.splitForm.controls.parts.length < 4)
      this.splitForm.controls.parts.push(this.createSplitPart());
  }

  removeSplitPart(index: number): void {
    if (this.splitForm.controls.parts.length > 2) this.splitForm.controls.parts.removeAt(index);
  }

  saveSplit(transaction: CardTransaction): void {
    const parts = this.splitForm.controls.parts.controls.map((part) => ({
      sourceId: part.controls.sourceId.value,
      amountMinor: parseMoneyToMinor(part.controls.amount.value) ?? 0,
    }));
    if (parts.some((part) => !part.sourceId || part.amountMinor <= 0)) {
      this.snackbar.show('Choose a source and valid amount for every split.', 'WARNING');
      return;
    }
    if (parts.reduce((sum, part) => sum + part.amountMinor, 0) !== transaction.amountMinor) {
      this.snackbar.show('Split amounts must equal the original transaction total.', 'WARNING');
      return;
    }
    const created = this.store.splitTransaction(transaction.id, parts);
    if (!created.length) return;
    this.detailTransactionId.set(created[0].id);
    this.showSplitForm.set(false);
    this.snackbar.show(`Transaction split into ${created.length} payments.`);
  }
  toggleActionMenu(event: MouseEvent, transactionId: string): void {
    this.summaryMenuOpen.set(false);
    if (this.actionMenuId() === transactionId) {
      this.actionMenuId.set(null);
      return;
    }
    this.actionMenuId.set(transactionId);
    this.positionMenu(event.currentTarget);
  }
  toggleSummaryMenu(event: MouseEvent): void {
    this.actionMenuId.set(null);
    if (this.summaryMenuOpen()) {
      this.summaryMenuOpen.set(false);
      return;
    }
    this.summaryMenuOpen.set(true);
    this.positionMenu(event.currentTarget, true);
  }
  closeMenusFromOutside(event: Event): void {
    if (!(event.target instanceof Element) || !event.target.closest('[data-action-menu]')) {
      this.closeMenus();
    }
  }
  closeMenus(): void {
    this.actionMenuId.set(null);
    this.summaryMenuOpen.set(false);
  }

  private positionMenu(target: EventTarget | null, summary = false): void {
    if (!(target instanceof HTMLElement)) return;
    requestAnimationFrame(() => {
      const menu = target.parentElement?.querySelector<HTMLElement>('.action-menu');
      if (!menu) return;
      const trigger = target.getBoundingClientRect();
      const spaceBelow = globalThis.innerHeight - trigger.bottom;
      const opensUp = spaceBelow < menu.offsetHeight + 8 && trigger.top > spaceBelow;
      (summary ? this.summaryMenuOpensUp : this.actionMenuOpensUp).set(opensUp);
    });
  }
  closeOverlays(): void {
    if (this.sourceFilterOpen()) {
      this.sourceFilterOpen.set(false);
      return;
    }
    if (this.payFromOpen()) {
      this.payFromOpen.set(false);
      return;
    }
    if (this.deleteCandidate()) {
      this.deleteCandidate.set(null);
      return;
    }
    if (this.showEmiForm()) {
      this.showEmiForm.set(false);
      return;
    }
    if (this.showSplitForm()) {
      this.showSplitForm.set(false);
      return;
    }
    if (this.detailTransactionId()) {
      this.closeDetails();
      return;
    }
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
    this.deleteCandidate.set(transaction);
    this.closeMenus();
  }
  confirmDelete(): void {
    const transaction = this.deleteCandidate();
    if (!transaction) return;
    this.store.deleteTransaction(transaction.id);
    if (this.detailTransactionId() === transaction.id) this.closeDetails();
    this.deleteCandidate.set(null);
    this.snackbar.show('Transaction deleted.', 'WARNING');
  }
  duplicate(transaction: CardTransaction): void {
    this.store.duplicateTransaction(transaction.id);
    this.snackbar.show('Transaction duplicated.');
    this.closeMenus();
  }
  goToSource(transaction: CardTransaction): void {
    this.closeDetails();
    this.closeMenus();
    if (this.store.cards().some((card) => card.id === transaction.cardId)) {
      void this.router.navigate(['/cards'], { queryParams: { open: transaction.cardId } });
      return;
    }
    void this.router.navigate(['/sources'], { fragment: transaction.cardId });
  }
  goToEmi(planId: string): void {
    this.closeDetails();
    void this.router.navigate(['/loans'], { queryParams: { emi: planId } });
  }
  clearFilters(): void {
    this.search.set('');
    this.typeFilter.set('ALL');
    this.sourceFilter.set('ALL');
    this.categoryFilter.set('ALL');
    this.hideCredits.set(false);
    this.creditCardsOnly.set(false);
    this.resetVisibleTransactions();
    this.closeMenus();
  }

  private async prepareReceiptImages(paths: readonly string[]): Promise<readonly string[]> {
    const accepted: string[] = [];
    let rejected = 0;
    for (const path of paths) {
      try {
        const blob = await fetch(path).then((response) => response.blob());
        if (blob.size <= MAX_RECEIPT_BYTES) {
          accepted.push(path);
          continue;
        }
        const compressed = await this.compressReceipt(blob);
        if (!compressed || compressed.size > MAX_RECEIPT_BYTES) {
          rejected += 1;
          continue;
        }
        accepted.push(await this.blobToDataUrl(compressed));
      } catch {
        rejected += 1;
      }
    }
    if (rejected) {
      this.snackbar.show(
        `${rejected} receipt image${rejected === 1 ? '' : 's'} could not be reduced below 1 MB.`,
        'WARNING',
      );
    }
    return accepted;
  }

  private async compressReceipt(source: Blob): Promise<Blob | null> {
    const bitmap = await createImageBitmap(source);
    try {
      let width = Math.min(bitmap.width, 1800);
      let height = Math.round((bitmap.height * width) / bitmap.width);
      if (height > 1800) {
        height = 1800;
        width = Math.round((bitmap.width * height) / bitmap.height);
      }
      for (const quality of [0.82, 0.7, 0.58, 0.46, 0.36]) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
        const result = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', quality),
        );
        if (result && result.size <= MAX_RECEIPT_BYTES) return result;
        width = Math.max(640, Math.round(width * 0.82));
        height = Math.max(640, Math.round(height * 0.82));
      }
      return null;
    } finally {
      bitmap.close();
    }
  }

  private blobToDataUrl(value: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result)));
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsDataURL(value);
    });
  }

  private resetVisibleTransactions(): void {
    this.visibleLimit.set(TRANSACTION_PAGE_SIZE);
  }

  save(): void {
    this.form.markAllAsTouched();
    const amountMinor = parseMoneyToMinor(this.form.controls.amount.value);
    if (amountMinor === null || amountMinor <= 0) {
      this.form.controls.amount.setErrors({ money: true });
      return;
    }
    const parsedTaxMinor = this.form.controls.taxIncluded.value
      ? parseMoneyToMinor(this.form.controls.taxAmount.value)
      : undefined;
    const taxMinor = parsedTaxMinor ?? undefined;
    if (this.form.controls.taxIncluded.value && (!taxMinor || taxMinor >= amountMinor)) {
      this.form.controls.taxAmount.setErrors({ money: true });
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
      relatedTransactionId: value.relatedTransactionId || undefined,
      taxIncluded: value.taxIncluded,
      taxMinor,
      attachmentIds: this.receiptPreviews(),
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
    this.receiptPreviews.set([]);
    this.form.reset({
      cardId: sourceId,
      type: 'PURCHASE',
      amount: '',
      transactionDate: new Date().toISOString().slice(0, 10),
      categoryId: 'other',
      merchant: '',
      notes: '',
      relatedTransactionId: '',
      taxIncluded: false,
      taxAmount: '',
      repeat: 'NONE',
    });
  }

  private createSplitPart(sourceId = this.defaultSourceId(), amountMinor = 0) {
    return new FormGroup({
      sourceId: new FormControl(sourceId, { nonNullable: true, validators: [Validators.required] }),
      amount: new FormControl(amountMinor ? String(amountMinor / 100) : '', {
        nonNullable: true,
        validators: [Validators.required],
      }),
    });
  }

  private emiStartDate(
    transactionDate: string,
    mode: EmiStartMode,
    customStart: string,
  ): string | null {
    if (mode === 'CUSTOM') return /^\d{4}-\d{2}$/.test(customStart) ? `${customStart}-01` : null;
    const date = new Date(`${transactionDate}T12:00:00`);
    date.setDate(1);
    if (mode === 'NEXT_MONTH') date.setMonth(date.getMonth() + 1);
    return date.toISOString().slice(0, 10);
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
