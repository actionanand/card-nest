import {
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { CardTransaction, EmiPlan, RecurringRule, TransactionType } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor, transactionEffect } from '../../core/services/money';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { CategoriesPage } from '../categories/categories';
import { ExportDialog, TransactionExportChoice } from '../../shared/export-dialog';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { ExportFormat } from '../../core/models/export';
import { createEmiSchedule } from '../../core/services/emi';
import {
  excludesStatementDayTransactions,
  isTransactionIncludedInStatement,
} from '../../core/services/billing-cycle';
import { AppDatePipe, DateFormatService } from '../../core/services/date-format.service';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { AppDatePicker } from '../../shared/app-date-picker';

type GroupingMode = 'MONTH' | 'CYCLE' | 'STATEMENT';
type TransactionTypeFilter = TransactionType | 'ALL' | 'WITH_IMAGE';
type RepeatChoice = 'NONE' | 'INFINITE' | `${number}`;
type EmiKind = 'NO_COST' | 'STANDARD';
type EmiStartMode = 'THIS_MONTH' | 'NEXT_MONTH' | 'CUSTOM';

interface SelectedFilterSource {
  readonly id: string;
  readonly label: string;
  readonly kind: 'CARD' | 'PAYMENT_SOURCE';
}
const TRANSACTION_PAGE_SIZE = 200;
const MAX_RECEIPT_BYTES = 1_000_000;

function sanitizedMoneyInput(value: string): string {
  const numeric = value.replace(/[^0-9.]/g, '');
  const [whole = '', ...fractions] = numeric.split('.');
  return fractions.length ? `${whole}.${fractions.join('').slice(0, 2)}` : whole;
}

@Component({
  selector: 'app-transactions-page',
  imports: [
    ReactiveFormsModule,
    AppIcon,
    AppDatePipe,
    CategoriesPage,
    ExportDialog,
    ConfirmationDialog,
    AppSelectPicker,
    AppDatePicker,
  ],
  templateUrl: './transactions.html',
  styleUrl: './transactions.scss',
  host: {
    '(document:keydown.escape)': 'closeOverlays()',
    '(document:click)': 'closeMenusFromOutside($event)',
    '(window:beforeunload)': 'protectBrowserUnload($event)',
  },
})
export class TransactionsPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackbar = inject(SnackbarService);
  private readonly dates = inject(DateFormatService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly requestedSourceId = this.route.snapshot.queryParamMap.get('source');
  private readonly requestedEditId = this.route.snapshot.queryParamMap.get('edit');
  readonly showForm = signal(
    this.route.snapshot.queryParamMap.get('add') === 'true' ||
      this.route.snapshot.queryParamMap.get('payment') === 'true' ||
      this.requestedEditId !== null,
  );
  readonly editingId = signal<string | null>(null);
  readonly receiptPreviews = signal<readonly string[]>([]);
  readonly receiptDraftDirty = signal(false);
  readonly discardConfirmationOpen = signal(false);
  readonly cameraAvailable = signal(Capacitor.getPlatform() !== 'web');
  readonly webCameraOpen = signal(false);
  readonly webCameraVideo = viewChild<ElementRef<HTMLVideoElement>>('webCameraVideo');
  private webCameraStream: MediaStream | null = null;
  private deactivateResolver: ((allow: boolean) => void) | null = null;
  private discardClosesEditor = false;
  readonly detailTransactionId = signal<string | null>(null);
  readonly detailTransaction = computed(
    () => this.store.transactions().find((item) => item.id === this.detailTransactionId()) ?? null,
  );
  readonly showEmiForm = signal(false);
  readonly showSplitForm = signal(false);
  readonly helpOpen = signal(false);
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
  readonly effectiveGrouping = computed<GroupingMode>(() => {
    if (this.isCreditCardSelected()) return 'STATEMENT';
    if (
      this.sourceFilter() !== 'ALL' &&
      this.store.paymentSources().some((source) => source.id === this.sourceFilter())
    ) {
      return 'CYCLE';
    }
    return this.grouping();
  });
  readonly selectedFilterSource = computed<SelectedFilterSource | null>(() => {
    const id = this.sourceFilter();
    if (id === 'ALL') return null;
    const card = this.store.cards().find((item) => item.id === id);
    if (card) return { id, label: card.nickname, kind: 'CARD' };
    const source = this.store.paymentSources().find((item) => item.id === id);
    return source
      ? {
          id,
          label: `${source.nickname}${source.lastDigits ? ` ${source.lastDigits}` : ''}`,
          kind: 'PAYMENT_SOURCE',
        }
      : null;
  });
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
  readonly categoryOptions = computed<readonly AppSelectOption[]>(() =>
    this.store.categories().map((category) => ({
      value: category.id,
      label: category.name,
      icon: category.icon,
      iconColour: category.colour ?? '#28684e',
    })),
  );
  readonly categoryFilterOptions = computed<readonly AppSelectOption[]>(() => [
    { value: 'ALL', label: 'All categories' },
    ...this.categoryOptions(),
  ]);
  readonly typeFilterOptions: readonly AppSelectOption[] = [
    { value: 'ALL', label: 'All transaction types' },
    ...this.types,
    { value: 'WITH_IMAGE', label: 'With image' },
  ];
  readonly groupingOptions = computed<readonly AppSelectOption[]>(() => [
    {
      value: 'MONTH',
      label: 'Calendar month',
      disabled: this.sourceFilter() !== 'ALL',
    },
    {
      value: 'CYCLE',
      label: `Budget cycle (day ${this.store.budgetCycleStartDay()})`,
      disabled: this.isCreditCardSelected(),
    },
    {
      value: 'STATEMENT',
      label: 'Selected card statement cycle',
      disabled: !this.isCreditCardSelected(),
    },
  ]);
  readonly alphabeticalPaymentSources = computed(() =>
    [...this.store.activePaymentSources()].sort((left, right) =>
      left.nickname.localeCompare(right.nickname, undefined, { sensitivity: 'base' }),
    ),
  );
  readonly repeatChoiceOptions: readonly AppSelectOption[] = [
    { value: 'NONE', label: 'Do not repeat' },
    ...this.repeatOptions.map((count) => ({
      value: String(count),
      label: `${count} more ${count === 1 ? 'month' : 'months'}`,
    })),
    { value: 'INFINITE', label: 'Every month · no end date' },
  ];
  readonly emiKindOptions: readonly AppSelectOption[] = [
    { value: 'NO_COST', label: 'No-cost EMI' },
    { value: 'STANDARD', label: 'Standard EMI with interest' },
  ];
  readonly emiStartOptions: readonly AppSelectOption[] = [
    { value: 'THIS_MONTH', label: "This month's statement" },
    { value: 'NEXT_MONTH', label: "Next month's statement" },
    { value: 'CUSTOM', label: 'Custom month' },
  ];
  readonly monthOptions: readonly AppSelectOption[] = Array.from({ length: 60 }, (_, index) => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() + index);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return {
      value,
      label: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(date),
    };
  });
  readonly paymentSourceOptions = computed<readonly AppSelectOption[]>(() => [
    ...this.store.alphabeticalActiveCards().map((card) => ({
      value: card.id,
      label: card.nickname,
      detail: `${card.lastDigits} · ${card.issuerName}`,
    })),
    ...this.alphabeticalPaymentSources().map((source) => ({
      value: source.id,
      label: source.nickname,
      detail: [source.lastDigits, source.institution || source.kind].filter(Boolean).join(' · '),
    })),
  ]);
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
    notes: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(200)] }),
  });
  readonly splitForm = new FormGroup({
    parts: new FormArray([this.createSplitPart(), this.createSplitPart()]),
  });
  private readonly emiFormChanges = toSignal(this.emiForm.valueChanges);
  readonly emiPreview = computed(() => {
    this.emiFormChanges();
    const transaction = this.detailTransaction();
    if (!transaction) return null;
    const value = this.emiForm.getRawValue();
    const months = Number(value.months);
    if (!Number.isInteger(months) || months < 2 || months > 36) return null;
    const rate = value.kind === 'NO_COST' ? 0 : Number(value.annualRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null;
    const card = this.store.cards().find((item) => item.id === transaction.cardId);
    const startDate = this.emiStartDate(
      transaction.transactionDate,
      value.startMode,
      value.customStart,
    );
    if (!card || !startDate) return null;
    const schedule = createEmiSchedule(
      {
        id: 'preview',
        transactionId: transaction.id,
        cardId: transaction.cardId,
        convertedAmountMinor: transaction.amountMinor,
        remainingPurchaseMinor: 0,
        tenureMonths: months,
        annualRateBasisPoints: Math.round(rate * 100),
        interestType: value.kind,
        processingFeeMinor: 0,
        taxMinor: 0,
        startDate,
        status: 'ACTIVE',
      },
      card,
    );
    if (!schedule.length) return null;
    const totalMinor = schedule.reduce((sum, item) => sum + item.totalMinor, 0);
    return {
      monthlyMinor: schedule[0].totalMinor,
      totalMinor,
      extraMinor: totalMinor - transaction.amountMinor,
      currencyCode: transaction.currencyCode,
    };
  });
  private readonly formChanges = toSignal(this.form.valueChanges);
  readonly taxBreakdown = computed(() => {
    this.formChanges();
    if (!this.form.controls.taxIncluded.value) return null;
    const amountMinor = parseMoneyToMinor(this.form.controls.amount.value);
    const taxMinor = parseMoneyToMinor(this.form.controls.taxAmount.value);
    if (amountMinor === null || amountMinor <= 0) return null;
    if (taxMinor === null || taxMinor <= 0 || taxMinor >= amountMinor) return null;
    return { baseMinor: amountMinor - taxMinor, taxMinor };
  });

  setTransactionDate(value: string): void {
    this.form.controls.transactionDate.setValue(value);
    this.form.controls.transactionDate.markAsDirty();
    this.form.controls.transactionDate.markAsTouched();
  }

  setCategory(value: string): void {
    this.form.controls.categoryId.setValue(value);
    this.form.controls.categoryId.markAsDirty();
    this.form.controls.categoryId.markAsTouched();
  }

  relatedOptions(): readonly AppSelectOption[] {
    return [
      { value: '', label: 'Not linked' },
      ...this.relatedTransactionOptions().map((transaction) => ({
        value: transaction.id,
        label: transaction.merchant || transaction.type,
        detail: `${transaction.transactionDate} · ${this.money(transaction.amountMinor, transaction.currencyCode)} · ${this.store.sourceName(transaction.cardId)}`,
      })),
    ];
  }

  setRelatedTransaction(value: string): void {
    this.form.controls.relatedTransactionId.setValue(value);
    this.form.controls.relatedTransactionId.markAsDirty();
  }

  setRepeatChoice(value: string): void {
    this.form.controls.repeat.setValue(value as RepeatChoice);
    this.form.controls.repeat.markAsDirty();
  }

  setEmiKind(value: string): void {
    this.emiForm.controls.kind.setValue(value as EmiKind);
  }

  setEmiStart(value: string): void {
    this.emiForm.controls.startMode.setValue(value as EmiStartMode);
  }

  setCustomStart(value: string): void {
    this.emiForm.controls.customStart.setValue(value);
  }

  setSplitSource(index: number, value: string): void {
    this.splitForm.controls.parts.at(index).controls.sourceId.setValue(value);
  }
  readonly filtered = computed(() => {
    const term = this.search().trim().toLocaleLowerCase();
    const numericTerm = term.replace(/[^0-9.]/g, '');
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
            this.categoryName(item.categoryId).toLocaleLowerCase().includes(term) ||
            (numericTerm.length > 0 && (item.amountMinor / 100).toFixed(2).includes(numericTerm))),
      );
  });
  readonly exportMonthChoices = computed<readonly TransactionExportChoice[]>(() => {
    const grouped = new Map<string, CardTransaction[]>();
    for (const transaction of this.filtered()) {
      const key = transaction.transactionDate.slice(0, 7);
      grouped.set(key, [...(grouped.get(key) ?? []), transaction]);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([value, transactions]) => {
        const [year, month] = value.split('-').map(Number);
        return {
          value,
          label: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(
            new Date(year, month - 1, 1),
          ),
          transactions,
        };
      });
  });
  readonly exportStatementChoices = computed<readonly TransactionExportChoice[]>(() => {
    const selectedSource = this.sourceFilter();
    if (selectedSource === 'ALL') return [];
    const selectedCard = this.store.cards().find((card) => card.id === selectedSource);
    const transactions = this.filtered();
    return Array.from({ length: 60 }, (_, offset) => {
      const statementMonth = new Date();
      statementMonth.setDate(1);
      statementMonth.setMonth(statementMonth.getMonth() - offset);
      const value = `${statementMonth.getFullYear()}-${String(statementMonth.getMonth() + 1).padStart(2, '0')}`;
      return {
        value,
        label: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(
          statementMonth,
        ),
        transactions: transactions.filter((transaction) =>
          selectedCard
            ? this.statementMonthFor(transaction) === value
            : transaction.transactionDate.slice(0, 7) === value,
        ),
      };
    });
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

  /** Opens the current period by default, or the latest past period — never a future one. */
  readonly defaultOpenGroupKey = computed(() => {
    const groups = this.groups();
    if (!groups.length) return null;
    const todayKey = this.periodForMode(
      {
        transactionDate: new Date().toISOString().slice(0, 10),
        cardId: this.sourceFilter(),
      } as CardTransaction,
      this.effectiveGrouping(),
    ).key;
    const currentOrPast = groups.find((group) => group.key <= todayKey);
    return (currentOrPast ?? groups[groups.length - 1]).key;
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.closeWebCamera());
    if (Capacitor.getPlatform() === 'web') void this.detectWebCamera();
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
  mobileSourceDetail(sourceId: string): string {
    const card = this.store.cards().find((item) => item.id === sourceId);
    if (card) return `${card.nickname} · ${card.lastDigits}`;
    return this.store.sourceName(sourceId);
  }
  categoryName(categoryId: string): string {
    return this.store.categories().find((item) => item.id === categoryId)?.name ?? 'Other';
  }
  category(categoryId: string) {
    return this.store.categories().find((item) => item.id === categoryId);
  }
  isCredit(type: TransactionType): boolean {
    return ['PAYMENT', 'REFUND', 'CASHBACK', 'CREDIT'].includes(type);
  }
  updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.resetVisibleTransactions();
  }
  updateType(value: string): void {
    this.typeFilter.set(value as TransactionTypeFilter);
    this.resetVisibleTransactions();
  }
  selectSourceFilter(id: string): void {
    this.sourceFilter.set(id);
    if (this.store.cards().some((card) => card.id === id)) this.grouping.set('STATEMENT');
    else if (this.store.paymentSources().some((source) => source.id === id)) {
      this.grouping.set('CYCLE');
    }
    this.sourceFilterOpen.set(false);
    this.resetVisibleTransactions();
  }
  sourceFilterLabel(): string {
    if (this.sourceFilter() === 'ALL') return 'All cards and sources';
    const card = this.store.activeCards().find((item) => item.id === this.sourceFilter());
    if (card) return `${card.nickname} · ${card.lastDigits}`;
    const source = this.store
      .activePaymentSources()
      .find((item) => item.id === this.sourceFilter());
    return source
      ? `${source.nickname}${source.lastDigits ? ` · ${source.lastDigits}` : ''}`
      : 'All cards and sources';
  }
  updateCategory(value: string): void {
    this.categoryFilter.set(value);
    this.resetVisibleTransactions();
  }
  updateGrouping(value: string): void {
    if (this.sourceFilter() !== 'ALL') return;
    this.grouping.set(value as GroupingMode);
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
  goToSelectedSource(): void {
    const selected = this.selectedFilterSource();
    if (!selected) return;
    if (selected.kind === 'CARD') {
      void this.router.navigate(['/cards'], { queryParams: { open: selected.id } });
      return;
    }
    void this.router.navigate(['/sources'], { fragment: selected.id });
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
      if (processed.length) {
        this.receiptPreviews.update((current) => [...current, ...processed]);
        this.receiptDraftDirty.set(true);
      }
    } catch {
      // Picker was dismissed by the user — nothing to attach.
    }
  }
  async captureReceipt(): Promise<void> {
    if (Capacitor.getPlatform() === 'web') {
      await this.openWebCamera();
      return;
    }
    try {
      const photo = await Camera.getPhoto({
        source: CameraSource.Camera,
        resultType: CameraResultType.Uri,
        quality: 70,
      });
      if (photo.webPath) {
        const processed = await this.prepareReceiptImages([photo.webPath]);
        if (processed.length) {
          this.receiptPreviews.update((current) => [...current, ...processed]);
          this.receiptDraftDirty.set(true);
        }
      }
    } catch {
      // Camera was dismissed by the user.
    }
  }
  async captureWebReceipt(): Promise<void> {
    const video = this.webCameraVideo()?.nativeElement;
    if (!video || !video.videoWidth || !video.videoHeight) {
      this.snackbar.show('The camera is not ready yet.', 'WARNING');
      return;
    }
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const processed = await this.prepareReceiptImages([canvas.toDataURL('image/jpeg', 0.82)]);
    if (processed.length) {
      this.receiptPreviews.update((current) => [...current, ...processed]);
      this.receiptDraftDirty.set(true);
    }
    this.closeWebCamera();
  }
  closeWebCamera(): void {
    this.webCameraStream?.getTracks().forEach((track) => track.stop());
    this.webCameraStream = null;
    this.webCameraOpen.set(false);
  }
  removeReceipt(index: number): void {
    this.receiptPreviews.update((current) => current.filter((_, position) => position !== index));
    this.receiptDraftDirty.set(true);
  }
  closeForm(): void {
    if (this.hasUnsavedDraft()) {
      this.discardClosesEditor = true;
      this.discardConfirmationOpen.set(true);
      return;
    }
    this.closeFormImmediately();
  }

  canDeactivate(): boolean | Promise<boolean> {
    if (!this.hasUnsavedDraft()) return true;
    this.discardClosesEditor = false;
    this.discardConfirmationOpen.set(true);
    return new Promise<boolean>((resolve) => {
      this.deactivateResolver = resolve;
    });
  }

  confirmDiscard(): void {
    this.discardConfirmationOpen.set(false);
    const resolver = this.deactivateResolver;
    this.deactivateResolver = null;
    if (resolver) {
      resolver(true);
      return;
    }
    if (this.discardClosesEditor) this.closeFormImmediately();
  }

  cancelDiscard(): void {
    this.discardConfirmationOpen.set(false);
    this.discardClosesEditor = false;
    this.deactivateResolver?.(false);
    this.deactivateResolver = null;
  }

  protectBrowserUnload(event: BeforeUnloadEvent): void {
    if (!this.hasUnsavedDraft()) return;
    event.preventDefault();
    event.returnValue = '';
  }

  sanitizeAmountInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const sanitized = sanitizedMoneyInput(input.value);
    input.value = sanitized;
    this.form.controls.amount.setValue(sanitized);
  }

  private closeFormImmediately(): void {
    this.closeWebCamera();
    this.showForm.set(false);
    this.editingId.set(null);
    this.receiptPreviews.set([]);
    this.receiptDraftDirty.set(false);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { add: null, payment: null, edit: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private async detectWebCamera(): Promise<void> {
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!mediaDevices?.enumerateDevices || !mediaDevices.getUserMedia) {
      this.cameraAvailable.set(false);
      return;
    }
    try {
      const devices = await mediaDevices.enumerateDevices();
      this.cameraAvailable.set(devices.some((device) => device.kind === 'videoinput'));
    } catch {
      this.cameraAvailable.set(false);
    }
  }

  private async openWebCamera(): Promise<void> {
    if (!this.cameraAvailable()) return;
    try {
      this.webCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      this.webCameraOpen.set(true);
      globalThis.setTimeout(() => {
        const video = this.webCameraVideo()?.nativeElement;
        if (!video || !this.webCameraStream) return;
        video.srcObject = this.webCameraStream;
        void video.play();
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        this.cameraAvailable.set(false);
      }
      this.snackbar.show('The browser could not open the camera.', 'WARNING');
      this.closeWebCamera();
    }
  }
  selectPayFrom(id: string): void {
    this.form.controls.cardId.setValue(id);
    this.form.controls.cardId.markAsDirty();
    this.payFromOpen.set(false);
  }
  selectedSourceLabel(): string {
    const id = this.form.controls.cardId.value;
    const card = this.store.activeCards().find((c) => c.id === id);
    if (card) return `${card.nickname} · ${card.lastDigits}`;
    const source = this.store.activePaymentSources().find((s) => s.id === id);
    if (source) return `${source.nickname}${source.lastDigits ? ` · ${source.lastDigits}` : ''}`;
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
    this.receiptDraftDirty.set(false);
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

  recurringRule(transaction: CardTransaction): RecurringRule | null {
    if (!transaction.recurringRuleId) return null;
    return (
      this.store.recurringRules().find((rule) => rule.id === transaction.recurringRuleId) ?? null
    );
  }

  recurringTransactions(transaction: CardTransaction): readonly CardTransaction[] {
    if (!transaction.recurringRuleId) return [];
    return this.store
      .transactions()
      .filter((item) => item.recurringRuleId === transaction.recurringRuleId)
      .sort((a, b) =>
        (a.generatedOccurrenceDate ?? a.transactionDate).localeCompare(
          b.generatedOccurrenceDate ?? b.transactionDate,
        ),
      );
  }

  recurringProgressLabel(transaction: CardTransaction): string {
    const transactions = this.recurringTransactions(transaction);
    const position = Math.max(1, transactions.findIndex((item) => item.id === transaction.id) + 1);
    return `(${position}/${this.recurringRule(transaction)?.occurrenceLimit ?? '∞'})`;
  }

  recurringRemaining(transaction: CardTransaction): string {
    const rule = this.recurringRule(transaction);
    if (!rule?.occurrenceLimit)
      return rule?.status === 'ACTIVE' ? 'Continues until stopped' : 'Ended';
    return `${Math.max(0, rule.occurrenceLimit - this.recurringTransactions(transaction).length)} remaining`;
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
      !transaction.recurringRuleId &&
      transaction.amountMinor >= this.store.emiMinimumMinor() &&
      this.store.cards().some((card) => card.id === transaction.cardId) &&
      !this.isChargeCleared(transaction)
    );
  }

  /** True when payments/refunds have already settled this charge (FIFO, oldest first). */
  private isChargeCleared(transaction: CardTransaction): boolean {
    const chargeEffect = transactionEffect(transaction);
    if (chargeEffect <= 0) return false;
    const card = this.store.cards().find((item) => item.id === transaction.cardId);
    const cardTransactions = this.store
      .transactions()
      .filter((item) => item.cardId === transaction.cardId && !item.emiCancelled)
      .sort(
        (left, right) =>
          left.transactionDate.localeCompare(right.transactionDate) ||
          left.createdAt.localeCompare(right.createdAt),
      );
    let creditPool = cardTransactions.reduce((pool, item) => {
      const effect = transactionEffect(item);
      return effect < 0 ? pool - effect : pool;
    }, 0);
    creditPool = Math.max(0, creditPool - Math.max(0, card?.openingBalanceMinor ?? 0));
    for (const item of cardTransactions) {
      const effect = transactionEffect(item);
      if (effect <= 0) continue;
      const covered = Math.min(creditPool, effect);
      creditPool -= covered;
      if (item.id === transaction.id) return covered >= effect;
    }
    return false;
  }

  canSplit(transaction: CardTransaction): boolean {
    return !transaction.emiPlanId && !transaction.recurringRuleId && !transaction.splitGroupId;
  }

  canDuplicate(transaction: CardTransaction): boolean {
    return !transaction.emiPlanId && !transaction.recurringRuleId;
  }

  openEmi(transaction: CardTransaction): void {
    if (!this.canConvertToEmi(transaction)) return;
    this.emiForm.reset({
      kind: 'NO_COST',
      months: 3,
      annualRate: '15',
      startMode: 'THIS_MONTH',
      customStart: transaction.transactionDate.slice(0, 7),
      notes: '',
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
      notes: value.notes.trim() || undefined,
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
    if (!this.canDuplicate(transaction)) return;
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

  goToRecurring(ruleId: string): void {
    this.closeDetails();
    void this.router.navigate(['/loans'], { queryParams: { repeat: ruleId } });
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
    const recurringRuleId =
      existing?.recurringRuleId ?? (value.repeat !== 'NONE' ? crypto.randomUUID() : undefined);
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
      recurringRuleId,
      generatedOccurrenceDate:
        existing?.generatedOccurrenceDate ?? (recurringRuleId ? value.transactionDate : undefined),
      attachmentIds: this.receiptPreviews(),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (existing) this.store.updateTransaction(transaction);
    else this.store.addTransaction(transaction);

    if (!existing && value.repeat !== 'NONE') {
      const occurrenceLimit = value.repeat === 'INFINITE' ? undefined : Number(value.repeat);
      this.store.addRecurringRule({
        id: recurringRuleId!,
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
    return this.periodForMode(transaction, this.effectiveGrouping());
  }

  private statementMonthFor(transaction: CardTransaction): string | null {
    const card = this.store.cards().find((item) => item.id === transaction.cardId);
    if (!card) return null;
    const date = new Date(`${transaction.transactionDate}T12:00:00`);
    const statementFor = (year: number, month: number) =>
      new Date(year, month, Math.min(card.statementDay, new Date(year, month + 1, 0).getDate()));
    const currentStatement = statementFor(date.getFullYear(), date.getMonth());
    const belongsToCurrentStatement = isTransactionIncludedInStatement(
      transaction.transactionDate,
      currentStatement,
      card,
    );
    const statementEnd = belongsToCurrentStatement
      ? currentStatement
      : statementFor(date.getFullYear(), date.getMonth() + 1);
    return `${statementEnd.getFullYear()}-${String(statementEnd.getMonth() + 1).padStart(2, '0')}`;
  }

  private periodForMode(
    transaction: CardTransaction,
    grouping: GroupingMode,
  ): { key: string; label: string } {
    const date = new Date(`${transaction.transactionDate}T12:00:00`);
    if (grouping === 'MONTH') {
      return {
        key: transaction.transactionDate.slice(0, 7),
        label: date.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
      };
    }
    const selectedCard = this.store.cards().find((card) => card.id === this.sourceFilter());
    if (grouping === 'STATEMENT' && selectedCard) {
      const statementFor = (year: number, month: number) =>
        new Date(
          year,
          month,
          Math.min(selectedCard.statementDay, new Date(year, month + 1, 0).getDate()),
        );
      const currentStatement = statementFor(date.getFullYear(), date.getMonth());
      const closesBeforeStatementDay = excludesStatementDayTransactions(selectedCard);
      const belongsToCurrentStatement = isTransactionIncludedInStatement(
        transaction.transactionDate,
        currentStatement,
        selectedCard,
      );
      let start: Date;
      let end: Date;
      if (belongsToCurrentStatement) {
        const previousStatement = statementFor(date.getFullYear(), date.getMonth() - 1);
        start = new Date(previousStatement);
        if (!closesBeforeStatementDay) start.setDate(start.getDate() + 1);
        end = currentStatement;
      } else {
        start = new Date(currentStatement);
        if (!closesBeforeStatementDay) start.setDate(start.getDate() + 1);
        end = statementFor(date.getFullYear(), date.getMonth() + 1);
      }
      return {
        key: start.toISOString().slice(0, 10),
        label: this.dates.format(end),
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
    this.receiptDraftDirty.set(false);
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

  private hasUnsavedDraft(): boolean {
    return this.showForm() && (this.form.dirty || this.receiptDraftDirty());
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
