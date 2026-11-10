import { CommittedSaveRefreshError } from '../../core/services/committed-save-refresh-error';
import { suggestCategory } from '../../core/services/category-matcher';
import {
  Component,
  computed,
  effect,
  untracked,
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
import {
  AddOnCardProfile,
  BalanceTiming,
  CardTransaction,
  ConsumerWalletActivityClassification,
  ConsumerWalletEvent,
  EmiPlan,
  FinancialActivity,
  PaymentGroup,
  RecurringRule,
  SourceTransfer,
  TransactionType,
  WalletLoadingDetails,
} from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import {
  ConsumerWalletService,
  WalletPurchaseRefundPreview,
  WalletPurchasePreview,
} from '../../core/services/consumer-wallet.service';
import {
  eligibleWalletLoadingDestinations,
  resolveWalletLoadAmounts,
  walletLoadApprovalMatches,
  walletLoadConfirmationKey,
  WalletLoadingFundingKind,
} from '../../core/services/wallet-loading';
import { displayBankAccountSuffix } from '../../core/services/bank-account-identifier';
import {
  formatMoney,
  parseMoneyToMinor,
  transactionEffect,
  transactionLabel,
} from '../../core/services/money';
import { eligiblePaymentMember } from '../../core/services/payment-groups';
import { PaymentGroupsPanel } from './payment-groups-panel';
import { PaymentBreakdown, WalletGroupBreakdownEntry } from '../../shared/payment-breakdown';
import {
  composeSmsApprovalNotes,
  paymentMethodDetailConfig,
  paymentMethodsFor,
  validateSmsPaymentAnnotation,
} from '../../core/services/payment-method-options';
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
import { DeviceCalendarClock } from '../../core/services/device-date';
import { PlatformTools } from '../../shared/platform-tools';
import { recordedTransactionTime } from '../../core/services/transaction-time';
import {
  transferLabel,
  needsBaselineConfirmation,
  savedTimingAnswer,
} from '../../core/services/source-balance';
import { SourceMovementDialog } from '../../shared/source-movement-dialog';
import { ProfileModal } from '../../shared/profile-modal';
import { consumerWalletProviderLabel } from '../wallets/consumer-wallet-providers';

type GroupingMode = 'MONTH' | 'CYCLE' | 'STATEMENT';
type TransactionTypeFilter =
  | TransactionType
  | 'ALL'
  | 'WITH_IMAGE'
  | 'WALLET_PURCHASE'
  | 'WALLET_REFUND'
  | 'WALLET_CREDIT'
  | 'WALLET_RETURN'
  | 'WALLET_ADJUSTMENT';
type RepeatChoice = 'NONE' | 'INFINITE' | `${number}`;
type EmiKind = 'NO_COST' | 'STANDARD';
type EmiStartMode = 'THIS_MONTH' | 'NEXT_MONTH' | 'CUSTOM';
type PayFromSelection =
  | { readonly kind: 'CARD'; readonly id: string }
  | { readonly kind: 'BANK_UPI' }
  | { readonly kind: 'PAYMENT_SOURCE'; readonly id: string }
  | { readonly kind: 'CONSUMER_WALLET'; readonly walletId: string };

interface SelectedFilterSource {
  readonly id: string;
  readonly label: string;
  readonly kind: 'CARD' | 'PAYMENT_SOURCE' | 'CONSUMER_WALLET';
}
interface TransactionFilterDraft {
  readonly search: string;
  readonly type: TransactionTypeFilter;
  readonly source: string;
  readonly category: string;
  readonly grouping: GroupingMode;
  readonly hideCredits: boolean;
  readonly creditCardsOnly: boolean;
  readonly fromDate: string;
  readonly toDate: string;
}
interface CombinedPurchaseActivity {
  readonly kind: 'PAYMENT_GROUP';
  readonly key: string;
  readonly date: string;
  readonly group: PaymentGroup;
  readonly period: { readonly key: string; readonly label: string };
}
type LedgerActivity = FinancialActivity | CombinedPurchaseActivity;
const TRANSACTION_PAGE_SIZE = 200;
const MAX_RECEIPT_BYTES = 1_000_000;
const CONSUMER_WALLET_SOURCE_PREFIX = 'consumer-wallet:';
const ADD_ON_FILTER_PREFIX = 'add-on:';

function sanitizedMoneyInput(value: string): string {
  const numeric = value.replace(/[^0-9.]/g, '');
  const [whole = '', ...fractions] = numeric.split('.');
  return fractions.length ? `${whole}.${fractions.join('').slice(0, 2)}` : whole;
}

@Component({
  selector: 'app-transactions-page',
  imports: [
    PaymentGroupsPanel,
    PaymentBreakdown,
    ReactiveFormsModule,
    AppIcon,
    AppDatePipe,
    CategoriesPage,
    ExportDialog,
    ConfirmationDialog,
    AppSelectPicker,
    AppDatePicker,
    PlatformTools,
    SourceMovementDialog,
    ProfileModal,
  ],
  templateUrl: './transactions.html',
  styleUrl: './transactions.scss',
  host: {
    '(document:keydown.escape)': 'closeOverlays()',
    '(document:keydown)': 'trapEditorFocus($event)',
    '(window:cardnest:back)': 'androidBack($event)',
    '(document:click)': 'closeMenusFromOutside($event)',
    '(window:beforeunload)': 'protectBrowserUnload($event)',
  },
})
export class TransactionsPage {
  private readonly calendarClock = inject(DeviceCalendarClock);
  readonly store = inject(CardNestStore);
  readonly consumerWallets = inject(ConsumerWalletService);
  readonly walletProviderLabel = consumerWalletProviderLabel;
  recordedTime(transaction: CardTransaction): string {
    return recordedTransactionTime(
      transaction.transactionTime,
      this.store.showTransactionTime?.() ?? false,
    );
  }
  recordedEventTime(transaction: CardTransaction): string {
    return recordedTransactionTime(transaction.transactionTime, true);
  }
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
  readonly detailWalletEventId = signal<string | null>(null);
  readonly detailWalletEvent = computed(
    () =>
      this.consumerWallets.events().find((event) => event.id === this.detailWalletEventId()) ??
      null,
  );
  readonly detailTransaction = computed(
    () => this.store.transactions().find((item) => item.id === this.detailTransactionId()) ?? null,
  );
  readonly showEmiForm = signal(false);
  readonly showSplitForm = signal(false);
  readonly saving = signal(false);
  private pendingCardRecurringIdentity: { transactionId: string; ruleId: string } | null = null;
  readonly splitTimingOptions = [
    { value: '', label: 'Choose only if the balance-confirmation day is ambiguous' },
    { value: 'AFTER_BASELINE', label: 'After the confirmed balance — apply this payment' },
    {
      value: 'INCLUDED_IN_BASELINE',
      label: 'Already included in the confirmed balance — record only',
    },
  ];
  setSplitTiming(index: number, value: string): void {
    if (value === '' || value === 'AFTER_BASELINE' || value === 'INCLUDED_IN_BASELINE')
      this.splitForm.controls.parts.at(index).controls.balanceTiming.setValue(value);
  }
  readonly transactionEditor = viewChild<ElementRef<HTMLElement>>('transactionEditor');
  private editorReturnFocus: HTMLElement | null = null;
  groupTotal(group: PaymentGroup): number {
    const cardTotal = this.groupEntries(group.memberIds).reduce(
      (sum, item) => sum + item.amountMinor,
      0,
    );
    const walletTotal = group.walletMembers
      .filter((member) => member.memberKind === 'WALLET_PURCHASE')
      .reduce(
        (sum, member) =>
          sum +
          (this.consumerWallets.events().find((event) => event.id === member.walletEventId)
            ?.amountMinor ?? 0),
        0,
      );
    return cardTotal + walletTotal;
  }
  groupRefundTotal(group: PaymentGroup): number {
    return group.walletMembers
      .filter((member) => member.memberKind === 'WALLET_REFUND')
      .reduce(
        (sum, member) =>
          sum +
          (this.consumerWallets.events().find((event) => event.id === member.walletEventId)
            ?.amountMinor ?? 0),
        0,
      );
  }
  groupMemberCount(group: PaymentGroup): number {
    return (
      group.memberIds.length +
      group.walletMembers.filter((member) => member.memberKind === 'WALLET_PURCHASE').length
    );
  }
  groupDisplayEntries(
    group: PaymentGroup,
  ): readonly (CardTransaction | WalletGroupBreakdownEntry)[] {
    return [
      ...this.groupEntries(group.memberIds),
      ...group.walletMembers.flatMap((member) => {
        const event = this.consumerWallets
          .events()
          .find((item) => item.id === member.walletEventId);
        return event
          ? [
              {
                id: event.id,
                kind: member.memberKind,
                eventDate: event.eventDate,
                amountMinor: event.amountMinor,
                walletLabel: this.consumerWalletName(event.walletId),
                eventLabel: this.consumerWalletEventLabel(event),
              },
            ]
          : [];
      }),
    ];
  }
  trapEditorFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || document.querySelector('app-select-picker dialog[open]')) return;
    const element = this.transactionEditor()?.nativeElement;
    if (!element) return;
    const nodes = Array.from(
      element.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
      ),
    );
    const first = nodes[0],
      last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  androidBack(event: Event): void {
    if (document.querySelector('app-select-picker dialog[open]')) return;
    if (
      this.filtersOpen() ||
      this.combineOpen() ||
      this.showForm() ||
      this.showSplitForm() ||
      this.detailTransaction() ||
      this.detailWalletEvent()
    ) {
      event.preventDefault();
      this.closeOverlays();
    }
  }
  readonly combineOpen = signal(false);
  readonly manageGroupId = signal('');
  readonly pendingPaymentGroupId = signal('');
  openCombine(transaction?: CardTransaction): void {
    this.closeDetails();
    this.manageGroupId.set(transaction?.splitGroupId ?? '');
    this.combineOpen.set(true);
  }
  openPaymentGroup(groupId: string): void {
    this.closeDetails();
    this.manageGroupId.set(groupId);
    this.combineOpen.set(true);
  }
  openWalletPaymentGroup(event: ConsumerWalletEvent): void {
    const group = this.store
      .paymentGroups()
      .find((item) => item.walletMembers.some((member) => member.walletEventId === event.id));
    this.openPaymentGroup(group?.id ?? `WALLET:${event.id}`);
  }
  closeCombine(): void {
    this.combineOpen.set(false);
    queueMicrotask(() => document.getElementById('combine-payments')?.focus());
  }
  openAddAfterCombine(groupId = ''): void {
    this.closeCombine();
    globalThis.setTimeout(() => {
      this.openAdd();
      this.pendingPaymentGroupId.set(groupId);
    });
  }
  groupEntries(ids: readonly string[]): readonly CardTransaction[] {
    return this.store.transactions().filter((entry) => ids.includes(entry.id));
  }
  relatedPaymentGroup() {
    return (this.store.paymentGroups?.() ?? []).find(
      (group) =>
        group.id === this.form.controls.relatedTransactionId.value ||
        group.memberIds.includes(this.form.controls.relatedTransactionId.value),
    );
  }
  relatedPaymentEntries(): readonly CardTransaction[] {
    const group = this.relatedPaymentGroup();
    return group
      ? this.groupEntries(group.memberIds)
      : this.store
          .transactions()
          .filter((entry) => entry.id === this.form.controls.relatedTransactionId.value);
  }
  paymentDelta(): number {
    const amount = parseMoneyToMinor(this.form.controls.amount.value) ?? 0;
    return (
      amount -
      (this.relatedPaymentEntries().find((entry) => entry.id === this.editingId())?.amountMinor ??
        0)
    );
  }
  legacyAdjustment(): CardTransaction | undefined {
    if (this.form.controls.type.value !== 'ADJUSTMENT') return undefined;
    return this.store
      .transactions()
      .find(
        (entry) =>
          entry.id === this.editingId() &&
          entry.type === 'ADJUSTMENT' &&
          (entry.adjustmentPurpose !== 'SPLIT_PAYMENT' || !entry.splitGroupId),
      );
  }
  groupTypeChange(): boolean {
    return !!this.store
      .transactions()
      .find(
        (entry) =>
          entry.id === this.editingId() &&
          (entry.splitGroupId ||
            (this.store.paymentGroups?.() ?? []).some((group) =>
              group.memberIds.includes(entry.id),
            )) &&
          entry.type !== this.form.controls.type.value,
      );
  }
  readonly helpOpen = signal(false);
  readonly deleteCandidate = signal<CardTransaction | null>(null);
  readonly committedDeleteRefreshPending = signal(false);
  readonly committedDeleteRefreshError = signal<string | null>(null);
  readonly refreshingCommittedDelete = signal(false);
  readonly payFromOpen = signal(false);
  readonly payFromSearch = signal('');
  readonly payFromBankMode = signal(false);
  readonly walletPurchasePreview = signal<WalletPurchasePreview | null>(null);
  readonly walletPurchaseApprovedFor = signal('');
  readonly walletPurchaseEventId = signal('');
  readonly walletPurchaseEditId = signal<string | null>(null);
  readonly walletRefundPreview = signal<WalletPurchaseRefundPreview | null>(null);
  readonly walletRefundApprovedFor = signal('');
  readonly walletRefundPurchaseId = signal('');
  readonly walletRefundEventId = signal('');
  readonly walletRefundError = signal<string | null>(null);
  readonly walletCancellationCandidate = signal<ConsumerWalletEvent | null>(null);
  readonly walletRefundForm = new FormGroup({
    amount: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    eventDate: new FormControl(this.calendarClock.calendar().dateIso, {
      nonNullable: true,
      validators: [Validators.required],
    }),
    eventTime: new FormControl('', { nonNullable: true }),
    reason: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(160)] }),
    reference: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    notes: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(500)] }),
  });
  readonly filtersOpen = signal(false);
  readonly filterDraft = signal<TransactionFilterDraft | null>(null);
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
  readonly fromDate = signal('');
  readonly toDate = signal('');
  readonly grouping = signal<GroupingMode>('MONTH');
  readonly effectiveGrouping = computed<GroupingMode>(() => {
    if (this.isCreditCardSelected()) return 'STATEMENT';
    if (this.sourceFilter().startsWith(CONSUMER_WALLET_SOURCE_PREFIX)) return 'MONTH';
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
    if (id.startsWith(CONSUMER_WALLET_SOURCE_PREFIX)) {
      const walletId = id.slice(CONSUMER_WALLET_SOURCE_PREFIX.length);
      return { id: walletId, label: this.consumerWalletName(walletId), kind: 'CONSUMER_WALLET' };
    }
    if (id.startsWith(ADD_ON_FILTER_PREFIX)) {
      const profileId = id.slice(ADD_ON_FILTER_PREFIX.length);
      const card = this.store
        .cards()
        .find((item) => item.addOnProfiles?.some((profile) => profile.id === profileId));
      const profile = card?.addOnProfiles?.find((item) => item.id === profileId);
      if (card && profile)
        return { id: card.id, label: `${card.nickname} · ${profile.name}`, kind: 'CARD' };
      return null;
    }
    const card = this.store.cards().find((item) => item.id === id);
    if (card) return { id, label: card.nickname, kind: 'CARD' };
    const source = this.store.paymentSources().find((item) => item.id === id);
    return source
      ? {
          id,
          label: `${source.nickname}${source.lastDigits ? ` ${source.kind === 'DEBIT' ? displayBankAccountSuffix(source.lastDigits) : source.lastDigits}` : ''}`,
          kind: 'PAYMENT_SOURCE',
        }
      : null;
  });
  readonly editingArchivedCard = computed(() => {
    this.formChanges();
    const id = this.editingId();
    if (!id) return null;
    const previous = this.store.transactions().find((transaction) => transaction.id === id);
    if (!previous) return null;
    return this.store.cards().find((card) => card.id === previous.cardId && card.archived) ?? null;
  });
  readonly archivedSourceReassignment = computed(() => {
    this.formChanges();
    const original = this.editingArchivedCard();
    return original && original.id !== this.form.controls.cardId.value ? original : null;
  });
  readonly visibleLimit = signal(TRANSACTION_PAGE_SIZE);
  readonly activeFilterCount = computed(
    () =>
      Number(Boolean(this.search().trim())) +
      Number(this.typeFilter() !== 'ALL') +
      Number(this.sourceFilter() !== 'ALL') +
      Number(this.categoryFilter() !== 'ALL') +
      Number(this.grouping() !== 'MONTH') +
      Number(this.hideCredits()) +
      Number(this.creditCardsOnly()) +
      Number(Boolean(this.fromDate())) +
      Number(Boolean(this.toDate())),
  );
  readonly repeatOptions = Array.from({ length: 36 }, (_, index) => index + 1);
  readonly types: readonly { value: TransactionType; label: string }[] = [
    { value: 'PURCHASE', label: 'Purchase' },
    { value: 'ADJUSTMENT', label: 'Split payment' },
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
    { value: 'WALLET_PURCHASE', label: 'Wallet purchase' },
    { value: 'WALLET_REFUND', label: 'Wallet refund' },
    { value: 'WALLET_CREDIT', label: 'Wallet credit' },
    { value: 'WALLET_RETURN', label: 'UPI Lite return' },
    { value: 'WALLET_ADJUSTMENT', label: 'Wallet adjustment' },
  ];
  readonly groupingOptions = computed<readonly AppSelectOption[]>(() => [
    {
      value: 'MONTH',
      label: 'Calendar month',
      disabled: (this.filterDraft()?.source ?? this.sourceFilter()) !== 'ALL',
    },
    {
      value: 'CYCLE',
      label: `Budget cycle (day ${this.store.budgetCycleStartDay()})`,
      disabled: this.store
        .cards()
        .some(
          (card) =>
            card.id ===
            this.primaryCardIdForFilter(this.filterDraft()?.source ?? this.sourceFilter()),
        ),
    },
    {
      value: 'STATEMENT',
      label: 'Selected card statement cycle',
      disabled: !this.primaryCardIdForFilter(this.filterDraft()?.source ?? this.sourceFilter()),
    },
  ]);
  readonly filterDraftGrouping = computed<GroupingMode>(() => {
    const draft = this.filterDraft();
    if (!draft) return this.effectiveGrouping();
    if (this.primaryCardIdForFilter(draft.source)) return 'STATEMENT';
    if (draft.source.startsWith(CONSUMER_WALLET_SOURCE_PREFIX)) return 'MONTH';
    if (
      draft.source !== 'ALL' &&
      this.store.paymentSources().some((source) => source.id === draft.source)
    )
      return 'CYCLE';
    return draft.grouping;
  });
  readonly sourceFilterOptions = computed<readonly AppSelectOption[]>(() => [
    { value: 'ALL', label: 'All cards and sources' },
    ...this.store.cards().map((card) => ({
      value: card.id,
      label: `${card.nickname}${card.archived || card.deletedAt ? ' · Archived' : ''}`,
      detail: `${card.lastDigits} · ${card.issuerName}`,
    })),
    ...this.store.cards().flatMap((card) =>
      (card.addOnProfiles ?? []).map((profile) => ({
        value: `${ADD_ON_FILTER_PREFIX}${profile.id}`,
        label: `${card.nickname} · ${profile.name}${profile.archived ? ' · Archived' : ''}`,
        detail: `Add-On · ${profile.relationship ?? 'Other'}${profile.lastDigits ? ` · •••• ${profile.lastDigits}` : ''}`,
      })),
    ),
    ...this.store.paymentSources().map((source) => ({
      value: source.id,
      label: `${source.nickname}${source.archived ? ' · Archived' : ''}`,
      detail:
        source.kind === 'DEBIT'
          ? source.lastDigits
            ? `•••${source.lastDigits.slice(-3)} · ${source.institution || 'Bank/UPI'}`
            : source.institution || 'Bank/UPI'
          : [source.lastDigits, source.institution || source.kind].filter(Boolean).join(' · '),
    })),
    ...this.consumerWalletSourceOptions(),
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
      label:
        source.kind === 'DEBIT'
          ? `${source.institution || 'Bank/UPI'} · ${source.nickname}`
          : source.nickname,
      detail:
        source.kind === 'DEBIT'
          ? source.lastDigits
            ? `•••${source.lastDigits.slice(-3)}`
            : 'Bank account'
          : [source.lastDigits, source.institution || source.kind].filter(Boolean).join(' · '),
    })),
  ]);
  readonly searchedPayFromCards = computed(() => {
    const terms = this.payFromSearch().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.store.alphabeticalActiveCards().filter((card) => {
      const searchable = `${card.nickname} ${card.lastDigits} ${card.issuerName}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  });
  readonly searchedPayFromSources = computed(() => {
    if (this.editingArchivedCard()) return [];
    const terms = this.payFromSearch().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.store.activePaymentSources().filter((source) => {
      if (source.kind === 'DEBIT') return false;
      const searchable =
        `${source.institution ?? ''} ${source.nickname} ${source.lastDigits ?? ''} ${source.kind}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  });
  readonly searchedPayFromBanks = computed(() => {
    if (this.editingArchivedCard()) return [];
    const terms = this.payFromSearch().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.store.activePaymentSources().filter((source) => {
      if (source.kind !== 'DEBIT') return false;
      const searchable =
        `${source.institution ?? ''} ${source.nickname} ${source.lastDigits ?? ''}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  });
  readonly searchedPayFromConsumerWallets = computed(() => {
    if (
      !this.consumerWallets.enabled() ||
      this.editingId() ||
      this.form.controls.type.value !== 'PURCHASE' ||
      this.editingArchivedCard()
    )
      return [];
    const terms = this.payFromSearch().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.consumerWallets.activeWallets().filter((wallet) => {
      const searchable =
        `${consumerWalletProviderLabel(wallet.providerId)} ${wallet.customName ?? ''} ${wallet.nickname ?? ''}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  });
  readonly consumerWalletSourceOptions = computed<readonly AppSelectOption[]>(() =>
    this.consumerWallets.wallets().map((wallet) => ({
      value: `${CONSUMER_WALLET_SOURCE_PREFIX}${wallet.id}`,
      label: `${wallet.nickname || wallet.customName || consumerWalletProviderLabel(wallet.providerId)}${wallet.archived ? ' · Archived' : ''}`,
      detail: `${consumerWalletProviderLabel(wallet.providerId)} · ${this.money(this.consumerWallets.balances().get(wallet.id) ?? 0, 'INR')}`,
    })),
  );
  readonly bankAccountOptions = computed<readonly AppSelectOption[]>(() => {
    const selectedId = this.form.controls.cardId.value;
    const sources = this.store
      .paymentSources()
      .filter(
        (source) =>
          source.kind === 'DEBIT' &&
          (!source.archived || (this.editingId() && source.id === selectedId)),
      );
    return sources.map((source) => ({
      value: source.id,
      label: `${source.institution || 'Bank/UPI'} · ${source.nickname}`,
      detail: `${source.lastDigits ? `•••${source.lastDigits.slice(-3)}` : 'Bank account'}${source.archived ? ' · Archived' : ''}`,
    }));
  });
  readonly form = new FormGroup({
    cardId: new FormControl(this.defaultSourceId(), {
      nonNullable: true,
      validators: [Validators.required],
    }),
    addOnCardId: new FormControl('', { nonNullable: true }),
    consumerWalletId: new FormControl('', { nonNullable: true }),
    type: new FormControl<TransactionType>(
      this.route.snapshot.queryParamMap.get('payment') === 'true' ? 'PAYMENT' : 'PURCHASE',
      { nonNullable: true, validators: [Validators.required] },
    ),
    amount: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    transactionDate: new FormControl(this.calendarClock.calendar().dateIso, {
      nonNullable: true,
      validators: [Validators.required],
    }),
    transactionTime: new FormControl('', { nonNullable: true }),
    categoryId: new FormControl('other', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    merchant: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    notes: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(500)] }),
    relatedTransactionId: new FormControl('', { nonNullable: true }),
    preserveLegacy: new FormControl(false, { nonNullable: true }),
    unlinkConfirmed: new FormControl(false, { nonNullable: true }),
    archivedSourceReassignmentConfirmedFor: new FormControl('', { nonNullable: true }),
    paymentMethod: new FormControl('NONE', { nonNullable: true }),
    paymentMethodDetail: new FormControl('', { nonNullable: true }),
    walletId: new FormControl('', { nonNullable: true }),
    walletLoadedAmount: new FormControl('', { nonNullable: true }),
    walletLoadConfirmedFor: new FormControl('', { nonNullable: true }),
    paymentMethodCustom: new FormControl('', {
      nonNullable: true,
      validators: Validators.maxLength(80),
    }),
    smsAdditionalComment: new FormControl('', {
      nonNullable: true,
      validators: Validators.maxLength(500),
    }),
    taxIncluded: new FormControl(false, { nonNullable: true }),
    taxAmount: new FormControl('', { nonNullable: true }),
    repeat: new FormControl<RepeatChoice>('NONE', { nonNullable: true }),
    balanceTiming: new FormControl<BalanceTiming | ''>('', { nonNullable: true }),
  });
  /** Asked only where ordering against the confirmed balance is genuinely ambiguous. */
  baselineTimingNeeded(): boolean {
    this.formChanges();
    const value = this.form.getRawValue();
    if (value.consumerWalletId) return false;
    const existing = this.store.transactions().find((item) => item.id === this.editingId());
    if (
      existing &&
      existing.cardId === value.cardId &&
      existing.amountMinor === parseMoneyToMinor(value.amount) &&
      existing.transactionDate === value.transactionDate &&
      transactionEffect(existing) === transactionEffect({ ...existing, type: value.type })
    )
      return false;
    return needsBaselineConfirmation(
      this.store.paymentSources().find((source) => source.id === value.cardId),
      this.store.bankCashTracking(),
      value.transactionDate,
      existing?.transactionDate === value.transactionDate ? existing.transactionTime : undefined,
      existing && { createdAt: existing.createdAt, effects: [existing.balanceEffect] },
    );
  }
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
    forFriendsOrRelatives: new FormControl(false, { nonNullable: true }),
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

  readonly categoryOverridden = signal(false);
  suggestNewCategory(): void {
    if (!this.showForm() || this.editingId() || this.categoryOverridden()) return;
    const value = this.form.getRawValue();
    const group = this.store
      .paymentGroups()
      .find(
        (row) =>
          row.id === value.relatedTransactionId ||
          row.memberIds.includes(value.relatedTransactionId),
      );
    const related = this.store
      .transactions()
      .find((row) => row.id === (group?.anchorId ?? value.relatedTransactionId));
    try {
      const category = suggestCategory(
        {
          purpose: value.type,
          merchant: value.merchant,
          ...(value.type === 'ADJUSTMENT' ? { inheritedId: related?.categoryId ?? '' } : {}),
        },
        this.store.categories(),
        this.store.categoryCatalog?.() ?? [],
      );
      this.form.controls.categoryId.setValue(category, { emitEvent: false });
    } catch {
      this.form.controls.categoryId.setErrors({ integrity: true });
    }
  }
  setCategory(value: string): void {
    this.categoryOverridden.set(true);
    this.form.controls.categoryId.setValue(value);
    this.form.controls.categoryId.markAsDirty();
    this.form.controls.categoryId.markAsTouched();
  }
  manualPaymentContext() {
    const source = this.store
      .paymentSources()
      .find((item) => item.id === this.form.controls.cardId.value);
    return source?.kind === 'DEBIT' ||
      source?.kind === 'CASH' ||
      (this.form.controls.type.value === 'PAYMENT' &&
        !!this.store.fundingFor?.(this.editingId() ?? ''))
      ? ('BANK' as const)
      : ('CARD' as const);
  }
  manualPaymentMethods() {
    this.formChanges();
    const options = paymentMethodsFor(this.manualPaymentContext());
    return this.canLoadConsumerWallet()
      ? [...options, { value: 'WALLET_LOADING', label: 'Wallet loading' }]
      : options;
  }
  readonly walletLoadWalletOptions = computed(() => {
    this.formChanges();
    if (!this.consumerWallets.enabled()) return [];
    return eligibleWalletLoadingDestinations(
      this.consumerWallets.activeLoadDestinations(),
      this.walletLoadingFundingKind(),
    ).map((wallet) => ({
      value: wallet.id,
      label: wallet.nickname || wallet.customName || wallet.providerId,
      detail: wallet.fastagSourceId
        ? 'FASTag wallet'
        : wallet.kind === 'UPI_LITE'
          ? 'UPI Lite'
          : 'Consumer wallet',
    }));
  });
  readonly walletLoadSummary = computed(() => {
    this.formChanges();
    if (this.form.controls.paymentMethod.value !== 'WALLET_LOADING') return null;
    const debitAmountMinor = parseMoneyToMinor(this.form.controls.amount.value);
    if (debitAmountMinor === null) return null;
    const amounts = resolveWalletLoadAmounts(
      debitAmountMinor,
      this.form.controls.walletLoadedAmount.value,
    );
    const wallet = this.walletLoadWalletOptions().find(
      (item) => item.value === this.form.controls.walletId.value,
    );
    if (!amounts || !wallet) return null;
    return {
      confirmationKey: walletLoadConfirmationKey(
        this.form.controls.cardId.value,
        wallet.value,
        this.form.controls.transactionDate.value,
        amounts,
      ),
      fundingSource: this.walletLoadFundingSourceLabel(),
      walletName: wallet.label,
      ...amounts,
    };
  });
  private walletLoadFundingSourceLabel(): string {
    const sourceId = this.form.controls.cardId.value;
    const card = this.store.cards().find((item) => item.id === sourceId);
    if (card) return `${card.nickname} · ${card.lastDigits}`;
    const source = this.store.paymentSources().find((item) => item.id === sourceId);
    if (!source) return this.selectedSourceLabel();
    if (source.kind !== 'DEBIT') return source.nickname;
    const suffix = source.lastDigits ? ` · ${displayBankAccountSuffix(source.lastDigits)}` : '';
    return `${source.institution || 'Bank/UPI'} · ${source.nickname}${suffix}`;
  }
  private walletLoadingFundingKind(): WalletLoadingFundingKind {
    const sourceId = this.form.controls.cardId.value;
    const card = this.store.cards().find((item) => item.id === sourceId && !item.deletedAt);
    if (card && !card.archived && card.currencyCode === 'INR') return 'CARD';
    const source = this.store.paymentSources().find((item) => item.id === sourceId);
    if (source && !source.archived && source.kind === 'DEBIT') return 'BANK_UPI';
    return 'UNSUPPORTED';
  }
  private canLoadConsumerWallet(): boolean {
    if (
      this.form.controls.type.value !== 'PURCHASE' ||
      !this.consumerWallets.enabled() ||
      !this.consumerWallets.activeLoadDestinations().length
    )
      return false;
    return this.walletLoadWalletOptions().length > 0;
  }
  readonly manualPaymentDetail = paymentMethodDetailConfig;
  setManualPaymentMethod(value: string): void {
    if (!this.manualPaymentMethods().some((item) => item.value === value)) return;
    this.form.patchValue({
      paymentMethod: value,
      paymentMethodDetail: '',
      paymentMethodCustom: '',
      walletId: value === 'WALLET_LOADING' ? (this.walletLoadWalletOptions()[0]?.value ?? '') : '',
      walletLoadedAmount: '',
      walletLoadConfirmedFor: '',
    });
  }
  setWalletLoadDestination(walletId: string): void {
    if (!this.walletLoadWalletOptions().some((option) => option.value === walletId)) return;
    this.form.controls.walletId.setValue(walletId);
    this.form.controls.walletLoadConfirmedFor.setValue('');
  }
  confirmWalletLoad(event: Event): void {
    const summary = this.walletLoadSummary();
    this.form.controls.walletLoadConfirmedFor.setValue(
      summary && (event.target as HTMLInputElement).checked ? summary.confirmationKey : '',
    );
  }
  private revalidateWalletLoadSelection(): void {
    if (this.form.controls.paymentMethod.value !== 'WALLET_LOADING') return;
    if (!this.canLoadConsumerWallet()) {
      this.form.patchValue({
        paymentMethod: 'NONE',
        walletId: '',
        walletLoadedAmount: '',
        walletLoadConfirmedFor: '',
      });
      return;
    }
    const selectedWalletId = this.form.controls.walletId.value;
    if (!selectedWalletId && this.form.controls.walletLoadConfirmedFor.value) {
      this.form.controls.walletLoadConfirmedFor.setValue('', { emitEvent: false });
      return;
    }
    if (
      selectedWalletId &&
      !this.walletLoadWalletOptions().some((option) => option.value === selectedWalletId)
    ) {
      this.form.patchValue({ walletId: '', walletLoadConfirmedFor: '' });
    }
  }
  setManualPaymentDetail(value: string): void {
    this.form.controls.paymentMethodDetail.setValue(value);
    if (this.form.controls.paymentMethod.value === 'UPI')
      this.form.controls.paymentMethodCustom.setValue('');
  }
  customManualPayment(): void {
    if (this.form.controls.paymentMethodCustom.value)
      this.form.controls.paymentMethodDetail.setValue('');
  }

  relatedOptions(): readonly AppSelectOption[] {
    return [
      { value: '', label: 'Not linked' },
      ...(this.form.controls.type.value === 'ADJUSTMENT'
        ? (this.store.paymentGroups?.() ?? []).map((group) => ({
            value: group.id,
            label: group.title || 'Existing payment group',
            detail: group.memberIds
              .map((id) => {
                const entry = this.store.transactions().find((row) => row.id === id);
                return entry
                  ? `${entry.merchant ?? ''} ${entry.transactionDate} ${entry.amountMinor / 100} ${this.store.sourceDetail(entry.cardId)}`
                  : '';
              })
              .join(' · '),
          }))
        : []),
      ...this.relatedTransactionOptions().map((transaction) => ({
        value: transaction.id,
        label:
          (this.store.paymentGroups?.() ?? []).find((group) =>
            group.memberIds.includes(transaction.id),
          )?.title ||
          transaction.merchant ||
          transactionLabel(transaction),
        detail: `${transaction.transactionDate} · ${this.money(transaction.amountMinor, transaction.currencyCode)} · ${this.store.sourceName(transaction.cardId)}`,
      })),
    ];
  }

  setRelatedTransaction(value: string): void {
    this.form.controls.relatedTransactionId.setValue(value);
    if (value && this.form.controls.type.value === 'ADJUSTMENT')
      this.form.controls.preserveLegacy.setValue(false);
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
    const currentMonth = this.calendarClock.calendar().monthIso;
    return this.store
      .transactions()
      .filter(
        (item) =>
          !item.emiCancelled &&
          (!this.fromDate() || item.transactionDate >= this.fromDate()) &&
          (!this.toDate() || item.transactionDate <= this.toDate()) &&
          (!item.emiInstallmentNumber ||
            item.emiInstallmentNumber === 1 ||
            item.transactionDate.slice(0, 7) <= currentMonth) &&
          (!this.hideCredits() || !this.isCredit(item)) &&
          (!this.creditCardsOnly() || this.store.cards().some((card) => card.id === item.cardId)) &&
          (this.typeFilter() === 'ALL' ||
            (this.typeFilter() === 'WITH_IMAGE'
              ? item.attachmentIds.length > 0
              : item.type === this.typeFilter())) &&
          (this.sourceFilter() === 'ALL' ||
            item.cardId === this.sourceFilter() ||
            (this.sourceFilter().startsWith(ADD_ON_FILTER_PREFIX) &&
              item.addOnCardId === this.sourceFilter().slice(ADD_ON_FILTER_PREFIX.length))) &&
          (this.categoryFilter() === 'ALL' || item.categoryId === this.categoryFilter()) &&
          (!term ||
            (this.store.paymentGroups?.() ?? []).some(
              (group) =>
                group.memberIds.includes(item.id) && group.title.toLowerCase().includes(term),
            ) ||
            item.merchant?.toLocaleLowerCase().includes(term) ||
            item.bankName?.toLocaleLowerCase().includes(term) ||
            this.cardName(item.cardId).toLocaleLowerCase().includes(term) ||
            this.categoryName(item.categoryId).toLocaleLowerCase().includes(term) ||
            (numericTerm.length > 0 && (item.amountMinor / 100).toFixed(2).includes(numericTerm))),
      );
  });
  readonly exportMonthChoices = computed<readonly TransactionExportChoice[]>(() => {
    const grouped = new Map<string, CardTransaction[]>();
    const walletGrouped = new Map<string, ConsumerWalletEvent[]>();
    for (const transaction of this.filtered()) {
      const key = transaction.transactionDate.slice(0, 7);
      grouped.set(key, [...(grouped.get(key) ?? []), transaction]);
    }
    for (const event of this.projectedWalletActivities().map((activity) => activity.event)) {
      const key = event.eventDate.slice(0, 7);
      walletGrouped.set(key, [...(walletGrouped.get(key) ?? []), event]);
      if (!grouped.has(key)) grouped.set(key, []);
    }
    // A month that holds only own-account transfers is still exportable.
    for (const transfer of this.visibleTransfers()) {
      const key = transfer.transferDate.slice(0, 7);
      if (!grouped.has(key)) grouped.set(key, []);
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
          walletEvents: walletGrouped.get(value) ?? [],
        };
      });
  });
  readonly exportStatementChoices = computed<readonly TransactionExportChoice[]>(() => {
    const selectedSource = this.sourceFilter();
    if (selectedSource === 'ALL' || selectedSource.startsWith(CONSUMER_WALLET_SOURCE_PREFIX))
      return [];
    const selectedCardId = this.primaryCardIdForFilter(selectedSource);
    const selectedCard = this.store.cards().find((card) => card.id === selectedCardId);
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
    this.filtered().reduce((sum, item) => sum - transactionEffect(item), 0),
  );
  readonly activityProjection = computed<readonly FinancialActivity[]>(() => {
    const items: FinancialActivity[] = this.filtered().map((transaction) => ({
      kind: 'CARD_TRANSACTION',
      key: `card:${transaction.id}`,
      date: transaction.transactionDate,
      transaction,
      classification: 'CARD_OR_BANK_LEDGER',
    }));
    const term = this.search().trim().toLocaleLowerCase();
    if (!this.creditCardsOnly())
      for (const event of this.consumerWallets.events()) {
        if (event.eventType === 'FUNDED_LOAD' && this.sourceFilter() === 'ALL') continue;
        if (
          this.sourceFilter() !== 'ALL' &&
          this.sourceFilter() !== `${CONSUMER_WALLET_SOURCE_PREFIX}${event.walletId}`
        )
          continue;
        if (this.fromDate() && event.eventDate < this.fromDate()) continue;
        if (this.toDate() && event.eventDate > this.toDate()) continue;
        const type = this.typeFilter();
        const matchesType =
          type === 'ALL' ||
          (type === 'WITH_IMAGE' && !!event.attachmentIds?.length) ||
          ((type === 'PURCHASE' || type === 'WALLET_PURCHASE') && event.eventType === 'PURCHASE') ||
          ((type === 'REFUND' || type === 'WALLET_REFUND') && event.eventType === 'REFUND') ||
          (type === 'WALLET_RETURN' && event.eventType === 'UPI_LITE_RETURN') ||
          (type === 'WALLET_CREDIT' &&
            ['MANUAL_CREDIT', 'PROMOTIONAL_CREDIT'].includes(event.eventType)) ||
          (type === 'WALLET_ADJUSTMENT' &&
            ['BALANCE_CORRECTION', 'UNKNOWN_BALANCE', 'REVERSAL'].includes(event.eventType));
        if (!matchesType) continue;
        if (this.hideCredits() && event.balanceDeltaMinor > 0) continue;
        if (this.categoryFilter() !== 'ALL' && event.categoryId !== this.categoryFilter()) continue;
        const wallet = this.consumerWallets.wallets().find((item) => item.id === event.walletId);
        const searchable =
          `${wallet?.nickname ?? ''} ${wallet?.customName ?? ''} ${consumerWalletProviderLabel(wallet?.providerId ?? '')} ${event.merchant ?? ''} ${event.memo ?? ''} ${event.notes ?? ''} ${event.eventType} ${this.categoryName(event.categoryId ?? '')} ${(event.amountMinor / 100).toFixed(2)}`.toLocaleLowerCase();
        if (term && !searchable.includes(term)) continue;
        items.push({
          kind: 'CONSUMER_WALLET_EVENT',
          key: `wallet:${event.id}`,
          date: event.eventDate,
          event,
          classification: this.walletActivityClassification(event),
          consolidatedExpenseContributionMinor: 0,
        });
      }
    return items.sort(
      (left, right) =>
        right.date.localeCompare(left.date) ||
        (right.kind === 'CONSUMER_WALLET_EVENT' ? (right.event.eventTime ?? '') : '').localeCompare(
          left.kind === 'CONSUMER_WALLET_EVENT' ? (left.event.eventTime ?? '') : '',
        ) ||
        (right.kind === 'CARD_TRANSACTION'
          ? right.transaction.createdAt
          : right.event.createdAt
        ).localeCompare(
          left.kind === 'CARD_TRANSACTION' ? left.transaction.createdAt : left.event.createdAt,
        ) ||
        right.key.localeCompare(left.key),
    );
  });
  readonly projectedWalletActivities = computed(() =>
    this.activityProjection().filter(
      (item): item is Extract<FinancialActivity, { kind: 'CONSUMER_WALLET_EVENT' }> =>
        item.kind === 'CONSUMER_WALLET_EVENT',
    ),
  );
  readonly projectedWalletEvents = computed(() =>
    this.projectedWalletActivities().map((activity) => activity.event),
  );
  readonly walletActivityBalanceMovement = computed(() =>
    this.projectedWalletEvents().reduce((total, event) => total + event.balanceDeltaMinor, 0),
  );
  private walletActivityClassification(
    event: ConsumerWalletEvent,
  ): ConsumerWalletActivityClassification {
    if (event.eventType === 'PURCHASE') return 'SPENDING_ALREADY_COUNTED';
    if (['REFUND', 'MANUAL_CREDIT', 'PROMOTIONAL_CREDIT'].includes(event.eventType))
      return 'BALANCE_CREDIT_ONLY';
    if (event.eventType === 'REVERSAL') return 'CANCELLATION';
    if (event.eventType === 'UPI_LITE_RETURN') return 'RETURN_TO_BANK';
    return 'BALANCE_ADJUSTMENT';
  }
  consumerWalletName(walletId: string): string {
    const wallet = this.consumerWallets.wallets().find((item) => item.id === walletId);
    if (wallet?.fastagSourceId) return `${this.store.sourceName(wallet.fastagSourceId)} · FASTag`;
    return (
      wallet?.nickname ||
      wallet?.customName ||
      consumerWalletProviderLabel(wallet?.providerId ?? '')
    );
  }
  provenanceLabel(rootCreditEventId: string): string {
    const event = this.consumerWallets.events().find((item) => item.id === rootCreditEventId);
    return event
      ? `${this.consumerWalletEventLabel(event)} · ${this.consumerWalletName(event.walletId)}`
      : 'Unknown original wallet credit';
  }
  consumerWalletEventLabel(event: ConsumerWalletEvent): string {
    const wallet = this.consumerWallets.wallets().find((item) => item.id === event.walletId);
    if (wallet?.fastagSourceId && event.eventType === 'PURCHASE') return 'FASTag toll payment';
    if (wallet?.fastagSourceId && event.eventType === 'FUNDED_LOAD') return 'FASTag top-up';
    if (event.eventType === 'MANUAL_CREDIT' && event.memo === 'Opening balance')
      return 'Opening balance';
    if (event.eventType === 'PURCHASE') return 'Wallet purchase';
    if (event.eventType === 'REFUND') return 'Wallet refund';
    if (event.eventType === 'REVERSAL') return 'Purchase cancellation';
    if (event.eventType === 'UPI_LITE_RETURN') return 'UPI Lite return to Bank';
    return event.eventType
      .replaceAll('_', ' ')
      .toLocaleLowerCase()
      .replace(/^\w/, (value) => value.toUpperCase());
  }
  walletRefundableMinor(purchase: ConsumerWalletEvent): number {
    return Math.max(0, purchase.amountMinor - this.walletRefundTotalMinor(purchase.id));
  }
  walletRefundTotalMinor(purchaseEventId: string): number {
    return this.consumerWallets
      .events()
      .filter(
        (event) =>
          (event.eventType === 'REFUND' || event.eventType === 'REVERSAL') &&
          event.reversalOfEventId === purchaseEventId,
      )
      .reduce((total, event) => total + event.amountMinor, 0);
  }
  relatedWalletPurchase(event: ConsumerWalletEvent): ConsumerWalletEvent | null {
    return event.reversalOfEventId
      ? (this.consumerWallets.events().find((item) => item.id === event.reversalOfEventId) ?? null)
      : null;
  }
  openWalletRefund(purchase: ConsumerWalletEvent): void {
    if (purchase.eventType !== 'PURCHASE' || !this.consumerWallets.enabled() || this.saving())
      return;
    this.walletRefundPurchaseId.set(purchase.id);
    this.walletRefundEventId.set(crypto.randomUUID());
    this.walletRefundPreview.set(null);
    this.walletRefundApprovedFor.set('');
    this.walletRefundError.set(null);
    this.walletRefundForm.reset({
      amount: (this.walletRefundableMinor(purchase) / 100).toFixed(2),
      eventDate: this.calendarClock.calendar().dateIso,
      eventTime: '',
      reason: '',
      reference: '',
      notes: '',
    });
  }
  closeWalletRefund(): void {
    if (this.saving()) return;
    this.walletRefundPurchaseId.set('');
    this.walletRefundEventId.set('');
    this.walletRefundPreview.set(null);
    this.walletRefundApprovedFor.set('');
    this.walletRefundError.set(null);
  }
  confirmWalletRefundApproval(event: Event): void {
    const preview = this.walletRefundPreview();
    this.walletRefundApprovedFor.set(
      preview && (event.target as HTMLInputElement).checked ? preview.confirmationKey : '',
    );
  }
  async saveWalletRefund(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving() || !this.consumerWallets.enabled()) return;
    this.walletRefundForm.markAllAsTouched();
    const amountMinor = parseMoneyToMinor(this.walletRefundForm.controls.amount.value);
    const purchaseEventId = this.walletRefundPurchaseId();
    if (
      !purchaseEventId ||
      amountMinor === null ||
      amountMinor <= 0 ||
      this.walletRefundForm.invalid
    )
      return;
    const value = this.walletRefundForm.getRawValue();
    const input = {
      id: this.walletRefundEventId(),
      purchaseEventId,
      amountMinor,
      eventDate: value.eventDate,
      eventTime: value.eventTime || undefined,
      reason: value.reason.trim() || undefined,
      reference: value.reference.trim() || undefined,
      notes: value.notes.trim() || undefined,
    };
    this.saving.set(true);
    try {
      const preview = await this.consumerWallets.previewWalletPurchaseRefund(input);
      if (preview.confirmationKey !== this.walletRefundApprovedFor()) {
        this.walletRefundPreview.set(preview);
        this.walletRefundApprovedFor.set('');
        return;
      }
      await this.consumerWallets.recordWalletPurchaseRefund({
        ...input,
        confirmationKey: preview.confirmationKey,
      });
      this.closeDetails();
      this.walletRefundPurchaseId.set('');
      this.walletRefundEventId.set('');
      this.walletRefundPreview.set(null);
      this.walletRefundApprovedFor.set('');
      this.walletRefundError.set(null);
      this.snackbar.show('Wallet refund recorded. No Bank or card credit was created.');
    } catch (error: unknown) {
      this.walletRefundError.set(
        error instanceof Error ? error.message : 'Wallet refund could not be saved.',
      );
    } finally {
      this.saving.set(false);
    }
  }
  requestWalletCancellation(purchase: ConsumerWalletEvent): void {
    if (purchase.eventType !== 'PURCHASE' || !this.consumerWallets.enabled() || this.saving())
      return;
    this.walletCancellationCandidate.set(purchase);
  }
  async confirmWalletCancellation(): Promise<void> {
    const purchase = this.walletCancellationCandidate();
    if (!purchase || this.saving() || !this.consumerWallets.enabled()) return;
    const amountMinor = this.walletRefundableMinor(purchase);
    if (!amountMinor) {
      this.walletCancellationCandidate.set(null);
      return;
    }
    const input = {
      id: crypto.randomUUID(),
      purchaseEventId: purchase.id,
      amountMinor,
      eventDate: this.calendarClock.calendar().dateIso,
      reason: 'Purchase cancelled',
    };
    this.saving.set(true);
    try {
      const preview = await this.consumerWallets.previewWalletPurchaseCancellation(input);
      await this.consumerWallets.cancelWalletPurchase({
        ...input,
        confirmationKey: preview.confirmationKey,
      });
      this.walletCancellationCandidate.set(null);
      this.closeDetails();
      this.snackbar.show('Purchase cancelled and remaining wallet value restored.');
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'Purchase could not be cancelled.',
        'WARNING',
      );
    } finally {
      this.saving.set(false);
    }
  }
  fundedWalletLoad(transactionId: string): ConsumerWalletEvent | undefined {
    return this.consumerWallets
      .events()
      .find(
        (event) => event.eventType === 'FUNDED_LOAD' && event.sourceTransactionId === transactionId,
      );
  }
  readonly logicalGroups = computed(() =>
    this.sourceFilter() === 'ALL'
      ? (this.store.paymentGroups?.() ?? []).filter(
          (group) =>
            group.kind === 'PAYMENTS' &&
            this.groupMemberCount(group) > 1 &&
            group.memberIds.every((id) => this.filtered().some((entry) => entry.id === id)) &&
            group.walletMembers.every((member) =>
              this.projectedWalletEvents().some((event) => event.id === member.walletEventId),
            ),
        )
      : [],
  );
  readonly pageableActivities = computed<readonly LedgerActivity[]>(() => {
    const projection = this.activityProjection();
    const logicalGroups = this.logicalGroups();
    const groupedCardIds = new Set(this.logicalGroups().flatMap((group) => group.memberIds));
    const groupedWalletIds = new Set(
      this.logicalGroups().flatMap((group) =>
        group.walletMembers.map((member) => member.walletEventId),
      ),
    );
    const activities: LedgerActivity[] = projection.filter((activity) =>
      activity.kind === 'CARD_TRANSACTION'
        ? !groupedCardIds.has(activity.transaction.id)
        : !groupedWalletIds.has(activity.event.id),
    );
    const combined = logicalGroups.map((group): CombinedPurchaseActivity => {
      const members = projection.filter(
        (activity) =>
          (activity.kind === 'CARD_TRANSACTION' &&
            group.memberIds.includes(activity.transaction.id)) ||
          (activity.kind === 'CONSUMER_WALLET_EVENT' &&
            group.walletMembers.some((member) => member.walletEventId === activity.event.id)),
      );
      const date =
        members
          .map((activity) => activity.date)
          .sort()
          .at(-1) ?? '';
      const anchor = group.anchorId
        ? this.store.transactions().find((transaction) => transaction.id === group.anchorId)
        : undefined;
      const period = anchor ? this.periodFor(anchor) : this.periodForDate(date);
      return { kind: 'PAYMENT_GROUP', key: `payment-group:${group.id}`, date, group, period };
    });
    const createdAt = (activity: LedgerActivity): string =>
      activity.kind === 'CARD_TRANSACTION'
        ? activity.transaction.createdAt
        : activity.kind === 'CONSUMER_WALLET_EVENT'
          ? activity.event.createdAt
          : activity.group.updatedAt;
    const time = (activity: LedgerActivity): string =>
      activity.kind === 'CARD_TRANSACTION'
        ? (activity.transaction.transactionTime ?? '')
        : activity.kind === 'CONSUMER_WALLET_EVENT'
          ? (activity.event.eventTime ?? '')
          : '';
    return [...activities, ...combined].sort(
      (left, right) =>
        right.date.localeCompare(left.date) ||
        time(right).localeCompare(time(left)) ||
        createdAt(right).localeCompare(createdAt(left)) ||
        right.key.localeCompare(left.key),
    );
  });
  readonly visibleActivities = computed(() =>
    this.pageableActivities().slice(0, this.visibleLimit()),
  );
  readonly visibleTransactions = computed(() =>
    this.visibleActivities().flatMap((activity) =>
      activity.kind === 'CARD_TRANSACTION' ? [activity.transaction] : [],
    ),
  );
  readonly remainingTransactions = computed(() =>
    Math.max(0, this.pageableActivities().length - this.visibleActivities().length),
  );
  readonly groups = computed(() => {
    const totals = new Map<string, number>();
    for (const transaction of this.filtered()) {
      const period = this.periodFor(transaction);
      totals.set(period.key, (totals.get(period.key) ?? 0) + -transactionEffect(transaction));
    }
    const grouped = new Map<string, { label: string; activities: LedgerActivity[] }>();
    for (const activity of this.visibleActivities()) {
      const period =
        activity.kind === 'PAYMENT_GROUP'
          ? activity.period
          : activity.kind === 'CARD_TRANSACTION'
            ? this.periodFor(activity.transaction)
            : this.periodForDate(activity.date);
      const group = grouped.get(period.key) ?? { label: period.label, activities: [] };
      group.activities.push(activity);
      grouped.set(period.key, group);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([key, group]) => ({
        key,
        label: group.label,
        activities: group.activities.sort(
          (left, right) =>
            right.date.localeCompare(left.date) ||
            (right.kind === 'CARD_TRANSACTION'
              ? (right.transaction.transactionTime ?? '')
              : right.kind === 'CONSUMER_WALLET_EVENT'
                ? (right.event.eventTime ?? '')
                : ''
            ).localeCompare(
              left.kind === 'CARD_TRANSACTION'
                ? (left.transaction.transactionTime ?? '')
                : left.kind === 'CONSUMER_WALLET_EVENT'
                  ? (left.event.eventTime ?? '')
                  : '',
            ) ||
            right.key.localeCompare(left.key),
        ),
        transactions: group.activities.flatMap((activity) =>
          activity.kind === 'CARD_TRANSACTION' ? [activity.transaction] : [],
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
        transactionDate: this.calendarClock.calendar().dateIso,
        cardId: this.sourceFilter(),
      } as CardTransaction,
      this.effectiveGrouping(),
    ).key;
    const currentOrPast = groups.find((group) => group.key <= todayKey);
    return (currentOrPast ?? groups[groups.length - 1]).key;
  });

  constructor() {
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.walletPurchasePreview.set(null);
      this.walletPurchaseApprovedFor.set('');
    });
    this.walletRefundForm.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.walletRefundPreview.set(null);
      this.walletRefundApprovedFor.set('');
      this.walletRefundError.set(null);
    });
    for (const control of [
      this.form.controls.cardId,
      this.form.controls.amount,
      this.form.controls.transactionDate,
      this.form.controls.walletId,
      this.form.controls.walletLoadedAmount,
    ])
      control.valueChanges
        .pipe(takeUntilDestroyed())
        .subscribe(() =>
          this.form.controls.walletLoadConfirmedFor.setValue('', { emitEvent: false }),
        );
    effect(() => {
      this.formChanges();
      this.showForm();
      this.editingId();
      this.store.categories();
      this.store.categoryCatalog?.();
      this.store.transactions();
      this.store.paymentGroups();
      this.consumerWallets.enabled();
      this.walletLoadWalletOptions();
      untracked(() => this.suggestNewCategory());
      untracked(() => this.revalidateWalletLoadSelection());
    });
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
  addOnProfileOptions(): readonly AppSelectOption[] {
    this.formChanges();
    const card = this.store.cards().find((item) => item.id === this.form.controls.cardId.value);
    if (!card) return [];
    const selectedId = this.form.controls.addOnCardId.value;
    const enabled = card.addOnCardsEnabled ?? !!card.addOnProfiles?.length;
    return [
      { value: '', label: 'Primary cardholder' },
      ...(card.addOnProfiles ?? [])
        .filter(
          (profile) =>
            (enabled && !profile.archived && !profile.deletedAt) || profile.id === selectedId,
        )
        .map((profile) => ({
          value: profile.id,
          label: `${profile.name}${profile.deletedAt ? ' · Deleted' : profile.archived ? ' · Archived' : ''}`,
          disabled: !!profile.deletedAt,
          detail: [
            profile.relationship ?? 'Other',
            profile.lastDigits ? `•••• ${profile.lastDigits}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        })),
    ];
  }
  addOnProfileForTransaction(transaction: CardTransaction): AddOnCardProfile | undefined {
    return this.store
      .cards()
      .find((card) => card.id === transaction.cardId)
      ?.addOnProfiles?.find((profile) => profile.id === transaction.addOnCardId);
  }
  addOnRelationshipForTransaction(transaction: CardTransaction): string {
    return this.addOnProfileForTransaction(transaction)?.relationship ?? 'Other';
  }
  isEditingSmsTransaction(): boolean {
    const editingId = this.editingId();
    return (
      !!editingId &&
      this.store.transactions().find((item) => item.id === editingId)?.origin === 'SMS'
    );
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
  isCredit(value: TransactionType | CardTransaction): boolean {
    return typeof value === 'string'
      ? ['PAYMENT', 'REFUND', 'CASHBACK', 'CREDIT'].includes(value)
      : transactionEffect(value) < 0;
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
    else if (id.startsWith(CONSUMER_WALLET_SOURCE_PREFIX)) this.grouping.set('MONTH');
    else if (this.store.paymentSources().some((source) => source.id === id)) {
      this.grouping.set('CYCLE');
    }
    this.resetVisibleTransactions();
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
    return !!this.primaryCardIdForFilter(this.sourceFilter());
  }
  private primaryCardIdForFilter(source: string): string | undefined {
    const direct = this.store.cards().find((card) => card.id === source);
    if (direct) return direct.id;
    if (!source.startsWith(ADD_ON_FILTER_PREFIX)) return undefined;
    const profileId = source.slice(ADD_ON_FILTER_PREFIX.length);
    return this.store
      .cards()
      .find((card) => card.addOnProfiles?.some((profile) => profile.id === profileId))?.id;
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
    if (selected.kind === 'CONSUMER_WALLET') {
      void this.router.navigate(['/wallets'], { queryParams: { wallet: selected.id } });
      return;
    }
    if (selected.kind === 'CARD') {
      void this.router.navigate(['/cards'], { queryParams: { open: selected.id } });
      return;
    }
    void this.router.navigate(['/sources'], { fragment: selected.id });
  }
  openAdd(): void {
    if (this.saving()) return;
    this.editorReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.editingId.set(null);
    this.resetForm(this.defaultSourceId());
    this.showForm.set(true);
    this.closeMenus();
    globalThis.setTimeout(() =>
      this.transactionEditor()?.nativeElement.querySelector<HTMLElement>('button,input')?.focus(),
    );
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
    if (this.saving()) return;
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
    this.walletPurchaseEditId.set(null);
    this.walletPurchaseEventId.set('');
    this.walletPurchasePreview.set(null);
    this.walletPurchaseApprovedFor.set('');
    this.receiptPreviews.set([]);
    this.receiptDraftDirty.set(false);
    const trigger = this.editorReturnFocus;
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
      else document.getElementById('add-transaction')?.focus();
    });
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
    this.form.controls.addOnCardId.setValue('');
    if (id.startsWith(CONSUMER_WALLET_SOURCE_PREFIX)) {
      const walletId = id.slice(CONSUMER_WALLET_SOURCE_PREFIX.length);
      const wallet = this.consumerWallets.activeWallets().find((item) => item.id === walletId);
      if (
        !wallet ||
        !this.consumerWallets.enabled() ||
        this.form.controls.type.value !== 'PURCHASE'
      )
        return;
      this.form.controls.consumerWalletId.setValue(wallet.id);
      this.form.controls.cardId.setValue('', { emitEvent: false });
      this.form.controls.cardId.clearValidators();
      this.form.controls.cardId.updateValueAndValidity({ emitEvent: false });
      this.form.controls.archivedSourceReassignmentConfirmedFor.setValue('');
      this.payFromBankMode.set(false);
      this.revalidateWalletLoadSelection();
      this.payFromOpen.set(false);
      this.payFromSearch.set('');
      return;
    }
    if (
      this.editingArchivedCard() &&
      (id === 'BANK_SOURCE' || !this.store.activeCards().some((card) => card.id === id))
    )
      return;
    if (id === 'BANK_SOURCE') {
      const currentId = this.form.controls.cardId.value;
      const sources = this.store.activePaymentSources().filter((source) => source.kind === 'DEBIT');
      if (!sources.length) return;
      const current = sources.find((source) => source.id === currentId);
      const primary = sources.find((source) => source.isPrimaryBank);
      const selected = current ?? primary ?? sources[0];
      this.form.controls.consumerWalletId.setValue('');
      this.form.controls.cardId.setValidators(Validators.required);
      this.form.controls.cardId.setValue(selected.id);
      this.form.controls.cardId.updateValueAndValidity({ emitEvent: false });
      this.form.controls.cardId.markAsDirty();
      this.form.controls.archivedSourceReassignmentConfirmedFor.setValue('');
      this.payFromBankMode.set(true);
      this.revalidateWalletLoadSelection();
      this.payFromOpen.set(false);
      this.payFromSearch.set('');
      return;
    }
    this.form.controls.consumerWalletId.setValue('');
    this.form.controls.cardId.setValidators(Validators.required);
    this.payFromBankMode.set(false);
    this.form.controls.cardId.setValue(id);
    this.form.controls.cardId.updateValueAndValidity({ emitEvent: false });
    this.form.controls.cardId.markAsDirty();
    this.form.controls.archivedSourceReassignmentConfirmedFor.setValue('');
    this.revalidateWalletLoadSelection();
    this.payFromOpen.set(false);
    this.payFromSearch.set('');
  }
  selectBankAccount(id: string): void {
    if (this.editingArchivedCard()) return;
    if (!this.bankAccountOptions().some((option) => option.value === id)) return;
    this.form.controls.addOnCardId.setValue('');
    this.form.controls.consumerWalletId.setValue('');
    this.form.controls.cardId.setValidators(Validators.required);
    this.form.controls.cardId.setValue(id);
    this.form.controls.cardId.updateValueAndValidity({ emitEvent: false });
    this.form.controls.cardId.markAsDirty();
    this.form.controls.archivedSourceReassignmentConfirmedFor.setValue('');
    this.revalidateWalletLoadSelection();
  }
  confirmArchivedSourceReassignment(event: Event): void {
    const confirmed = (event.target as HTMLInputElement).checked;
    this.form.controls.archivedSourceReassignmentConfirmedFor.setValue(
      confirmed ? this.form.controls.cardId.value : '',
    );
  }
  openPayFrom(): void {
    this.payFromSearch.set('');
    this.payFromOpen.set(true);
  }
  updatePayFromSearch(event: Event): void {
    this.payFromSearch.set((event.target as HTMLInputElement).value);
  }
  selectedSourceLabel(): string {
    const walletId = this.form.controls.consumerWalletId.value;
    if (walletId) {
      const wallet = this.consumerWallets.wallets().find((item) => item.id === walletId);
      if (wallet)
        return `${consumerWalletProviderLabel(wallet.providerId)} · ${wallet.nickname || wallet.customName || 'Wallet'} · ${this.money(this.consumerWallets.balances().get(wallet.id) ?? 0, 'INR')} available`;
      return 'Select an active consumer wallet';
    }
    if (this.payFromBankMode()) return 'Bank/UPI';
    const id = this.form.controls.cardId.value;
    const card = this.store.cards().find((item) => item.id === id && !item.deletedAt);
    if (card) return `${card.nickname} · ${card.lastDigits}${card.archived ? ' · Archived' : ''}`;
    const source = this.store.activePaymentSources().find((s) => s.id === id);
    if (source)
      return source.kind === 'DEBIT'
        ? `${source.institution || 'Bank/UPI'} · ${source.nickname}${source.lastDigits ? ` · ${displayBankAccountSuffix(source.lastDigits)}` : ''}`
        : `${source.nickname}${source.lastDigits ? ` · ${source.lastDigits}` : ''}`;
    return 'Select source';
  }
  private payFromSelection(): PayFromSelection | null {
    const walletId = this.form.controls.consumerWalletId.value;
    if (walletId) return { kind: 'CONSUMER_WALLET', walletId };
    if (this.payFromBankMode()) return { kind: 'BANK_UPI' };
    const id = this.form.controls.cardId.value;
    if (this.store.cards().some((card) => card.id === id)) return { kind: 'CARD', id };
    if (this.store.paymentSources().some((source) => source.id === id))
      return { kind: 'PAYMENT_SOURCE', id };
    return null;
  }
  selectedSourceIsArchived(): boolean {
    const previous = this.store.transactions().find((item) => item.id === this.editingId());
    return (
      !!previous &&
      previous.cardId === this.form.controls.cardId.value &&
      this.store
        .cards()
        .some((card) => card.id === previous.cardId && card.archived && !card.deletedAt)
    );
  }
  transactionAccountIdentifierLabel(suffix?: string): string {
    return displayBankAccountSuffix(suffix);
  }
  edit(transaction: CardTransaction): void {
    if (this.saving()) return;
    this.editorReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.closeDetails();
    this.editingId.set(transaction.id);
    this.form.controls.cardId.setValidators(Validators.required);
    const walletLoad = this.consumerWallets
      .events()
      .find(
        (event) =>
          event.eventType === 'FUNDED_LOAD' && event.sourceTransactionId === transaction.id,
      );
    this.form.reset({
      cardId: transaction.cardId,
      addOnCardId: transaction.addOnCardId ?? '',
      consumerWalletId: '',
      type: transaction.type,
      amount: String(transaction.amountMinor / 100),
      transactionDate: transaction.transactionDate,
      transactionTime: transaction.transactionTime ?? '',
      categoryId: transaction.categoryId,
      merchant: transaction.merchant ?? '',
      notes: transaction.notes ?? '',
      relatedTransactionId:
        transaction.relatedTransactionId ??
        (transaction.type === 'ADJUSTMENT' ? transaction.splitGroupId : '') ??
        '',
      preserveLegacy:
        transaction.type === 'ADJUSTMENT' &&
        (transaction.adjustmentPurpose !== 'SPLIT_PAYMENT' || !transaction.splitGroupId),
      unlinkConfirmed: false,
      archivedSourceReassignmentConfirmedFor: '',
      paymentMethod: transaction.paymentMethod ?? 'NONE',
      paymentMethodDetail: transaction.paymentMethodDetail ?? '',
      walletId: walletLoad?.walletId ?? '',
      walletLoadedAmount:
        walletLoad?.loadedAmountMinor === undefined
          ? ''
          : String(walletLoad.loadedAmountMinor / 100),
      walletLoadConfirmedFor: '',
      paymentMethodCustom: transaction.paymentMethodCustom ?? '',
      smsAdditionalComment: transaction.smsAdditionalComment ?? '',
      taxIncluded: transaction.taxIncluded ?? false,
      taxAmount: transaction.taxMinor === undefined ? '' : String(transaction.taxMinor / 100),
      repeat: 'NONE',
      balanceTiming:
        savedTimingAnswer(
          this.store.paymentSources().find((source) => source.id === transaction.cardId),
          this.store.bankCashTracking(),
          transaction,
        ) ?? '',
    });
    this.payFromBankMode.set(
      this.store
        .paymentSources()
        .some((source) => source.id === transaction.cardId && source.kind === 'DEBIT'),
    );
    this.receiptPreviews.set(transaction.attachmentIds);
    this.receiptDraftDirty.set(false);
    this.showForm.set(true);
    globalThis.setTimeout(() =>
      this.transactionEditor()?.nativeElement.querySelector<HTMLElement>('button,input')?.focus(),
    );
    this.closeMenus();
    globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  transactionTypeChanged(type: TransactionType): void {
    if (this.form.controls.type.value !== type) this.form.controls.type.setValue(type);
    if (type !== 'PURCHASE' && this.form.controls.consumerWalletId.value) {
      this.form.controls.consumerWalletId.setValue('');
      this.form.controls.cardId.setValidators(Validators.required);
      this.form.controls.cardId.setValue(this.defaultSourceId(), { emitEvent: false });
      this.form.controls.cardId.updateValueAndValidity({ emitEvent: false });
    }
    this.form.controls.preserveLegacy.setValue(false);
    this.form.controls.unlinkConfirmed.setValue(false);
    this.form.controls.relatedTransactionId.setValue('');
    this.revalidateWalletLoadSelection();
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
      return this.store
        .transactions()
        .filter(
          (item) =>
            item.id !== this.editingId() &&
            eligiblePaymentMember(item) &&
            (item.type === 'PURCHASE' || !!item.splitGroupId),
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
    this.detailWalletEventId.set(null);
    this.detailTransactionId.set(transaction.id);
    this.closeMenus();
  }

  closeDetails(): void {
    this.detailWalletEventId.set(null);
    this.detailTransactionId.set(null);
    this.showEmiForm.set(false);
    this.showSplitForm.set(false);
  }

  openWalletDetails(event: ConsumerWalletEvent): void {
    this.detailTransactionId.set(null);
    this.detailWalletEventId.set(event.id);
    this.closeMenus();
  }

  editWalletPurchase(event: ConsumerWalletEvent): void {
    if (event.eventType !== 'PURCHASE' || this.saving()) return;
    this.closeDetails();
    this.walletPurchaseEditId.set(event.id);
    this.walletPurchaseEventId.set(event.id);
    this.form.controls.cardId.clearValidators();
    this.form.controls.cardId.setValue('', { emitEvent: false });
    this.form.controls.cardId.updateValueAndValidity({ emitEvent: false });
    this.form.reset({
      cardId: '',
      consumerWalletId: event.walletId,
      type: 'PURCHASE',
      amount: String(event.amountMinor / 100),
      transactionDate: event.eventDate,
      transactionTime: event.eventTime ?? '',
      categoryId: event.categoryId ?? 'other',
      merchant: event.merchant ?? '',
      notes: event.notes ?? '',
      relatedTransactionId: '',
      preserveLegacy: false,
      unlinkConfirmed: false,
      archivedSourceReassignmentConfirmedFor: '',
      paymentMethod: 'NONE',
      paymentMethodDetail: '',
      walletId: '',
      walletLoadedAmount: '',
      walletLoadConfirmedFor: '',
      paymentMethodCustom: '',
      smsAdditionalComment: '',
      taxIncluded: false,
      taxAmount: '',
      repeat: 'NONE',
      balanceTiming: '',
    });
    this.receiptPreviews.set([...(event.attachmentIds ?? [])]);
    this.receiptDraftDirty.set(false);
    this.walletPurchasePreview.set(null);
    this.walletPurchaseApprovedFor.set('');
    this.showForm.set(true);
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
  paymentGroupDetails(transaction: CardTransaction) {
    return (this.store.paymentGroups?.() ?? []).find((group) =>
      group.memberIds.includes(transaction.id),
    );
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
    return (
      eligiblePaymentMember(transaction) &&
      !transaction.emiPlanId &&
      !transaction.recurringRuleId &&
      !transaction.splitGroupId
    );
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
      forFriendsOrRelatives: false,
    });
    this.showEmiForm.set(true);
  }

  async saveEmi(transaction: CardTransaction): Promise<void> {
    if (this.saving()) return;
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
      forFriendsOrRelatives: value.forFriendsOrRelatives,
    };
    this.saving.set(true);
    let refreshWarning: string | null = null;
    try {
      await this.store.saveEmiPlan(plan, createEmiSchedule(plan, card));
    } catch (error: unknown) {
      if (error instanceof CommittedSaveRefreshError) refreshWarning = error.message;
      else {
        this.snackbar.show(
          error instanceof Error ? error.message : 'Unable to save EMI plan.',
          'WARNING',
        );
        return;
      }
    } finally {
      this.saving.set(false);
    }
    this.showEmiForm.set(false);
    this.snackbar.show(
      refreshWarning ?? `Converted into ${value.months} EMI installments.`,
      refreshWarning ? 'WARNING' : 'SUCCESS',
    );
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
    this.splitForm.controls.parts.push(this.createSplitPart());
  }

  removeSplitPart(index: number): void {
    if (this.splitForm.controls.parts.length > 2) this.splitForm.controls.parts.removeAt(index);
  }

  async saveSplit(transaction: CardTransaction): Promise<void> {
    if (this.saving()) return;
    const parts = this.splitForm.controls.parts.controls.map((part) => ({
      sourceId: part.controls.sourceId.value,
      amountMinor: parseMoneyToMinor(part.controls.amount.value) ?? 0,
      balanceTiming: part.controls.balanceTiming.value || undefined,
    }));
    if (parts.some((part) => !part.sourceId || part.amountMinor <= 0)) {
      this.snackbar.show('Choose a source and valid amount for every split.', 'WARNING');
      return;
    }
    if (parts.reduce((sum, part) => sum + part.amountMinor, 0) !== transaction.amountMinor) {
      this.snackbar.show('Split amounts must equal the original transaction total.', 'WARNING');
      return;
    }
    this.saving.set(true);
    try {
      const created = await this.store.splitTransaction(transaction.id, parts);
      if (!created.length) return;
      this.detailTransactionId.set(created[0].id);
      this.showSplitForm.set(false);
      this.snackbar.show(`Transaction split into ${created.length} payments.`);
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'Unable to divide this payment.',
        'WARNING',
      );
    } finally {
      this.saving.set(false);
    }
  }
  toggleActionMenu(event: MouseEvent, transactionId: string): void {
    event.stopPropagation();
    this.summaryMenuOpen.set(false);
    if (this.actionMenuId() === transactionId) {
      this.actionMenuId.set(null);
      return;
    }
    this.actionMenuId.set(transactionId);
    this.positionMenu(event.currentTarget);
  }
  toggleSummaryMenu(event: MouseEvent): void {
    event.stopPropagation();
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
    if (document.querySelector('app-select-picker dialog[open]')) return;
    if (this.saving()) return;
    if (this.filtersOpen()) {
      this.closeFilterPopup();
      return;
    }
    if (this.deleteTransferCandidate()) {
      this.deleteTransferCandidate.set(null);
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
    if (this.detailTransactionId() || this.detailWalletEventId()) {
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
    if (this.combineOpen()) {
      this.closeCombine();
      return;
    }
    this.closeMenus();
  }
  delete(transaction: CardTransaction): void {
    this.deleteCandidate.set(transaction);
    this.closeMenus();
  }
  deleteMessage(transaction: CardTransaction): string {
    const funding = this.store.fundingFor(transaction.id);
    return `Delete ${transaction.merchant || 'this transaction'}? This action cannot be undone.${
      funding
        ? ` The linked ${formatMoney(funding.amountMinor, 'INR')} deduction from ${this.store.sourceDetail(funding.fromSourceId)} is reversed too.`
        : ''
    }`;
  }
  readonly transferEditing = signal<SourceTransfer | null>(null);
  readonly deleteTransferCandidate = signal<SourceTransfer | null>(null);
  readonly visibleTransfers = computed(() => {
    const source = this.sourceFilter();
    const term = this.search().trim().toLocaleLowerCase();
    return this.store
      .transfers()
      .filter(
        (transfer) =>
          (source === 'ALL' ||
            transfer.fromSourceId === source ||
            transfer.toSourceId === source ||
            transfer.cardId === source) &&
          (!term || this.transferTitle(transfer).toLocaleLowerCase().includes(term)),
      );
  });
  openFilterPopup(): void {
    this.filterDraft.set({
      search: this.search(),
      type: this.typeFilter(),
      source: this.sourceFilter(),
      category: this.categoryFilter(),
      grouping: this.grouping(),
      hideCredits: this.hideCredits(),
      creditCardsOnly: this.creditCardsOnly(),
      fromDate: this.fromDate(),
      toDate: this.toDate(),
    });
    this.filtersOpen.set(true);
  }
  closeFilterPopup(): void {
    this.filtersOpen.set(false);
    this.filterDraft.set(null);
  }
  updateFilterDraft<K extends keyof TransactionFilterDraft>(
    key: K,
    value: TransactionFilterDraft[K],
  ): void {
    this.filterDraft.update((draft) => (draft ? { ...draft, [key]: value } : draft));
  }
  updateDraftType(value: string): void {
    if (
      value === 'ALL' ||
      value === 'WITH_IMAGE' ||
      this.typeFilterOptions.some((item) => item.value === value)
    )
      this.updateFilterDraft('type', value as TransactionTypeFilter);
  }
  updateFilterDraftSource(source: string): void {
    this.filterDraft.update((draft) => {
      if (!draft) return draft;
      const grouping = this.primaryCardIdForFilter(source)
        ? 'STATEMENT'
        : source.startsWith(CONSUMER_WALLET_SOURCE_PREFIX)
          ? 'MONTH'
          : this.store.paymentSources().some((item) => item.id === source)
            ? 'CYCLE'
            : draft.grouping;
      return { ...draft, source, grouping };
    });
  }
  updateDraftGrouping(value: string): void {
    if (value !== 'MONTH' && value !== 'CYCLE' && value !== 'STATEMENT') return;
    this.updateFilterDraft('grouping', value);
  }
  clearFilterDraft(): void {
    this.filterDraft.set({
      search: '',
      type: 'ALL',
      source: 'ALL',
      category: 'ALL',
      grouping: 'MONTH',
      hideCredits: false,
      creditCardsOnly: false,
      fromDate: '',
      toDate: '',
    });
  }
  applyFilterDraft(): void {
    const draft = this.filterDraft();
    if (!draft) return;
    this.search.set(draft.search);
    this.typeFilter.set(draft.type);
    this.sourceFilter.set(draft.source);
    this.categoryFilter.set(draft.category);
    this.grouping.set(draft.grouping);
    this.hideCredits.set(draft.hideCredits);
    this.creditCardsOnly.set(draft.creditCardsOnly);
    this.fromDate.set(draft.fromDate);
    this.toDate.set(draft.toDate);
    this.closeFilterPopup();
    this.resetVisibleTransactions();
  }
  transferTitle(transfer: SourceTransfer): string {
    const to = transfer.toSourceId
      ? this.store.sourceDetail(transfer.toSourceId)
      : transfer.cardId
        ? this.store.sourceName(transfer.cardId)
        : 'Loan repayment';
    return `${transferLabel(transfer.kind)} · ${this.store.sourceDetail(transfer.fromSourceId)} → ${to}`;
  }
  editTransfer(transfer: SourceTransfer): void {
    if (transfer.kind === 'CARD_SETTLEMENT') return;
    this.transferEditing.set(transfer);
  }
  deleteTransferMessage(transfer: SourceTransfer): string {
    return transfer.kind === 'CARD_SETTLEMENT'
      ? `Remove the ${formatMoney(transfer.amountMinor, 'INR')} bank deduction? The card payment itself is kept.`
      : `Delete this ${transferLabel(transfer.kind).toLowerCase()}? Both account balances are reversed together.`;
  }
  async confirmDeleteTransfer(): Promise<void> {
    const transfer = this.deleteTransferCandidate();
    if (!transfer) return;
    this.deleteTransferCandidate.set(null);
    try {
      await this.store.deleteTransfer(transfer.id);
      this.snackbar.show('Transfer deleted. Both balances were reversed.', 'WARNING');
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'The transfer could not be deleted.',
        'WARNING',
      );
    }
  }
  /** Readable kind: the payment source tells a bank purchase from a card purchase. */
  typeLabel(transaction: CardTransaction): string {
    if (transaction.emiPlanId) return 'EMI';
    if (transaction.splitGroupId && eligiblePaymentMember(transaction))
      return `${transactionLabel(transaction)} · Split payment member`;
    const source = this.store.paymentSources().find((item) => item.id === transaction.cardId);
    if (this.store.fundingFor(transaction.id)) return 'Credit-card settlement';
    if (source?.kind === 'DEBIT') {
      if (transaction.type === 'PURCHASE') return 'Bank/UPI purchase';
      if (transaction.type === 'CREDIT') return 'Bank receipt';
    }
    if (source?.kind === 'CASH') {
      if (transaction.type === 'PURCHASE') return 'Cash purchase';
      if (transaction.type === 'CREDIT') return 'Cash received';
    }
    return transactionLabel(transaction);
  }
  transactionTitle(transaction: CardTransaction): string {
    const label = transaction.merchant || transactionLabel(transaction);
    return transaction.bankName ? `${transaction.bankName} · ${label}` : label;
  }
  async confirmDelete(): Promise<void> {
    const transaction = this.deleteCandidate();
    if (!transaction) return;
    try {
      await this.store.deleteRecordedTransaction(transaction.id);
    } catch (error: unknown) {
      if (error instanceof CommittedSaveRefreshError) {
        this.consumerWallets.forgetFundedLoadForTransaction(transaction.id);
        this.finishCommittedDelete(transaction.id);
        this.committedDeleteRefreshPending.set(true);
        this.committedDeleteRefreshError.set(error.message);
        this.snackbar.show(
          'Transaction deleted. Wallet or ledger history still needs a refresh; use the retry action.',
          'WARNING',
        );
        return;
      }
      this.snackbar.show(
        error instanceof Error ? error.message : 'Unable to delete transaction.',
        'WARNING',
      );
      return;
    }
    this.consumerWallets.forgetFundedLoadForTransaction(transaction.id);
    this.finishCommittedDelete(transaction.id);
    try {
      await this.consumerWallets.reloadFinancialHistory();
    } catch (error: unknown) {
      this.committedDeleteRefreshPending.set(true);
      this.committedDeleteRefreshError.set(
        error instanceof Error ? error.message : 'Wallet activity could not be refreshed.',
      );
      this.snackbar.show(
        'Transaction deleted, but wallet activity could not be refreshed. Use the retry action.',
        'WARNING',
      );
      return;
    }
    this.snackbar.show('Transaction deleted.', 'WARNING');
  }
  private finishCommittedDelete(transactionId: string): void {
    if (this.detailTransactionId() === transactionId) this.closeDetails();
    this.deleteCandidate.set(null);
  }
  async retryCommittedDeleteRefresh(): Promise<void> {
    if (!this.committedDeleteRefreshPending() || this.refreshingCommittedDelete()) return;
    this.refreshingCommittedDelete.set(true);
    try {
      await Promise.all([
        this.store.refreshPaymentLedger(),
        this.consumerWallets.reloadFinancialHistory(),
      ]);
      this.committedDeleteRefreshPending.set(false);
      this.committedDeleteRefreshError.set(null);
      this.snackbar.show('Ledger and wallet history refreshed.');
    } catch (error: unknown) {
      this.committedDeleteRefreshError.set(
        error instanceof Error ? error.message : 'Ledger or wallet history could not be refreshed.',
      );
    } finally {
      this.refreshingCommittedDelete.set(false);
    }
  }
  async duplicate(transaction: CardTransaction): Promise<void> {
    if (!this.canDuplicate(transaction) || this.saving()) return;
    this.saving.set(true);
    try {
      const duplicate = await this.store.duplicateTransaction(transaction.id);
      if (duplicate) this.snackbar.show('Transaction duplicated.');
      this.closeMenus();
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'Unable to duplicate transaction.',
        'WARNING',
      );
      if (error instanceof CommittedSaveRefreshError) this.closeMenus();
    } finally {
      this.saving.set(false);
    }
  }
  goToSource(transaction: CardTransaction): void {
    this.closeDetails();
    this.closeMenus();
    if (this.store.cards().some((card) => card.id === transaction.cardId)) {
      void this.router.navigate(['/cards'], { queryParams: { open: transaction.cardId } });
      return;
    }
    if (
      this.store
        .paymentSources()
        .some((source) => source.id === transaction.cardId && source.kind === 'FASTAG')
    ) {
      void this.router.navigate(['/wallets'], {
        queryParams: { source: transaction.cardId, transaction: transaction.id },
      });
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
    this.grouping.set('MONTH');
    this.hideCredits.set(false);
    this.creditCardsOnly.set(false);
    this.fromDate.set('');
    this.toDate.set('');
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
          accepted.push(path.startsWith('data:') ? path : await this.blobToDataUrl(blob));
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

  async save(): Promise<void> {
    if (this.saving()) return;
    const selection = this.payFromSelection();
    if (selection?.kind === 'CONSUMER_WALLET') {
      await this.saveConsumerWalletPurchase(selection.walletId);
      return;
    }
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
    const timingNeeded = this.baselineTimingNeeded();
    if (timingNeeded && !this.form.controls.balanceTiming.value) {
      this.form.controls.balanceTiming.setErrors({ required: true });
      return;
    }
    const value = this.form.getRawValue();
    if (
      this.archivedSourceReassignment() &&
      value.archivedSourceReassignmentConfirmedFor !== value.cardId
    ) {
      this.form.controls.archivedSourceReassignmentConfirmedFor.setErrors({ required: true });
      this.snackbar.show(
        'Confirm moving this transaction from its archived card before saving.',
        'WARNING',
      );
      return;
    }
    if (value.type === 'ADJUSTMENT' && !value.preserveLegacy && !value.relatedTransactionId) {
      this.form.controls.relatedTransactionId.setErrors({ required: true });
      this.snackbar.show('Choose the related purchase or payment group.', 'WARNING');
      return;
    }
    if (value.type === 'ADJUSTMENT' && !value.preserveLegacy && value.repeat !== 'NONE') {
      this.snackbar.show(
        'Each Split payment needs its own confirmed purchase relationship.',
        'WARNING',
      );
      return;
    }
    const timestamp = new Date().toISOString();
    const existing = this.store
      .transactions()
      .find((transaction) => transaction.id === this.editingId());
    let annotation:
      | ReturnType<typeof validateSmsPaymentAnnotation>
      | {
          paymentMethod: 'WALLET_LOADING';
        };
    let walletLoading: WalletLoadingDetails | undefined;
    if (value.paymentMethod === 'WALLET_LOADING') {
      const loadAmounts = resolveWalletLoadAmounts(amountMinor, value.walletLoadedAmount);
      const walletLoadSummary = this.walletLoadSummary();
      if (
        !this.canLoadConsumerWallet() ||
        !this.walletLoadWalletOptions().some((option) => option.value === value.walletId) ||
        !loadAmounts ||
        !walletLoadSummary ||
        !walletLoadApprovalMatches(
          value.walletLoadConfirmedFor,
          walletLoadSummary.confirmationKey,
        ) ||
        value.repeat !== 'NONE'
      ) {
        this.snackbar.show(
          value.repeat !== 'NONE'
            ? 'Wallet loads cannot repeat. Record each real debit separately.'
            : 'Review the wallet-load summary and explicitly approve the current funding source, destination and amounts.',
          'WARNING',
        );
        return;
      }
      annotation = { paymentMethod: 'WALLET_LOADING' };
      walletLoading = {
        walletId: value.walletId,
        loadedAmountMinor: loadAmounts.loadedAmountMinor,
      };
    } else {
      try {
        annotation = validateSmsPaymentAnnotation(value, this.manualPaymentContext());
      } catch (error: unknown) {
        this.snackbar.show(
          error instanceof Error ? error.message : 'Choose valid payment metadata.',
          'WARNING',
        );
        return;
      }
    }
    const newCardRecurrence =
      !existing &&
      value.repeat !== 'NONE' &&
      this.store.cards().some((card) => card.id === value.cardId);
    if (newCardRecurrence && !this.pendingCardRecurringIdentity)
      this.pendingCardRecurringIdentity = {
        transactionId: crypto.randomUUID(),
        ruleId: crypto.randomUUID(),
      };
    const recurringRuleId =
      existing?.recurringRuleId ??
      (value.repeat !== 'NONE'
        ? newCardRecurrence
          ? this.pendingCardRecurringIdentity!.ruleId
          : crypto.randomUUID()
        : undefined);
    const transaction: CardTransaction = {
      ...existing,
      id:
        existing?.id ??
        (newCardRecurrence
          ? this.pendingCardRecurringIdentity!.transactionId
          : crypto.randomUUID()),
      cardId: value.cardId,
      addOnCardId:
        (existing?.origin ?? 'MANUAL') === 'SMS' ? undefined : value.addOnCardId || undefined,
      type: value.type,
      amountMinor,
      currencyCode: existing?.currencyCode ?? 'INR',
      transactionDate: value.transactionDate,
      merchant: value.merchant.trim() || undefined,
      categoryId: value.categoryId,
      notes: value.notes.trim() || undefined,
      ...annotation,
      origin: existing ? existing.origin : 'MANUAL',
      relatedTransactionId: value.relatedTransactionId || undefined,
      taxIncluded: value.taxIncluded,
      taxMinor,
      recurringRuleId,
      generatedOccurrenceDate:
        existing?.generatedOccurrenceDate ?? (recurringRuleId ? value.transactionDate : undefined),
      attachmentIds: this.receiptPreviews(),
      balanceTiming: timingNeeded ? value.balanceTiming || undefined : existing?.balanceTiming,
      balanceTimingAt: timingNeeded ? timestamp : existing?.balanceTimingAt,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    transaction.notes = composeSmsApprovalNotes({
      existingNotes: value.notes,
      previousAnnotation: existing,
      annotation,
      newlyApprovedSms: false,
      preserveSmsMarker: existing?.origin === 'SMS',
    });
    const recurringRule: RecurringRule | undefined =
      !existing && value.repeat !== 'NONE'
        ? {
            id: recurringRuleId!,
            cardId: value.cardId,
            addOnCardId: value.addOnCardId || undefined,
            title: value.merchant.trim() || value.type.replace('_', ' '),
            amountMinor,
            categoryId: value.categoryId,
            transactionType: value.type,
            frequency: 'MONTHLY',
            startDate: value.transactionDate,
            occurrenceLimit: value.repeat === 'INFINITE' ? undefined : Number(value.repeat),
            nextOccurrenceDate: this.nextMonthlyOccurrence(
              value.transactionDate,
              !this.store.cards().some((card) => card.id === value.cardId),
            ),
            status: 'ACTIVE',
          }
        : undefined;
    const persistedCardRecurrence =
      !!recurringRule && this.store.cards().some((card) => card.id === value.cardId);
    this.saving.set(true);
    let refreshWarning: string | null = null;
    try {
      try {
        await this.store.saveManualTransaction(
          transaction,
          value.type === 'ADJUSTMENT' && !value.preserveLegacy
            ? value.relatedTransactionId
            : value.type === 'PURCHASE'
              ? this.pendingPaymentGroupId()
              : '',
          value.unlinkConfirmed,
          persistedCardRecurrence ? recurringRule : undefined,
          value.archivedSourceReassignmentConfirmedFor,
          walletLoading,
        );
      } catch (error: unknown) {
        if (error instanceof CommittedSaveRefreshError) refreshWarning = error.message;
        else {
          this.snackbar.show(
            error instanceof Error ? error.message : 'Unable to save payment.',
            'WARNING',
          );
          return;
        }
      }
      if (walletLoading) {
        try {
          await this.consumerWallets.reloadFinancialHistory();
        } catch {
          refreshWarning ??=
            'Wallet load saved, but wallet activity could not be refreshed. Reopen Transactions to reload it.';
        }
      }
      if (recurringRule && persistedCardRecurrence) {
        try {
          await this.store.materializeRecurringTransactions(undefined, recurringRule.id);
        } catch (error: unknown) {
          refreshWarning =
            error instanceof CommittedSaveRefreshError
              ? error.message
              : 'Transaction and recurring schedule saved, but catch-up is incomplete. Reopen CardNest to retry due occurrences; do not enter the original transaction again.';
        }
      } else if (recurringRule) {
        this.saving.set(false);
        await this.store.addRecurringRule(recurringRule);
      }
      this.resetForm(value.cardId);
      this.saving.set(false);
      this.closeForm();
      if (refreshWarning) this.snackbar.show(refreshWarning, 'WARNING');
      else this.snackbar.show(existing ? 'Transaction updated.' : 'Transaction added.');
    } finally {
      this.saving.set(false);
    }
  }

  confirmWalletPurchaseApproval(event: Event): void {
    const preview = this.walletPurchasePreview();
    this.walletPurchaseApprovedFor.set(
      preview && (event.target as HTMLInputElement).checked ? preview.confirmationKey : '',
    );
  }

  private async saveConsumerWalletPurchase(walletId: string): Promise<void> {
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    const amountMinor = parseMoneyToMinor(value.amount);
    const editingWalletPurchaseId = this.walletPurchaseEditId();
    if (this.editingId() || value.type !== 'PURCHASE' || value.repeat !== 'NONE') {
      this.snackbar.show('Record each wallet purchase separately as a purchase.', 'WARNING');
      return;
    }
    if (amountMinor === null || amountMinor <= 0 || this.form.invalid) {
      this.form.controls.amount.setErrors({ money: true });
      return;
    }
    if (!editingWalletPurchaseId && !this.walletPurchaseEventId())
      this.walletPurchaseEventId.set(crypto.randomUUID());
    const input = {
      id: editingWalletPurchaseId ?? this.walletPurchaseEventId(),
      walletId,
      amountMinor,
      eventDate: value.transactionDate,
      eventTime: value.transactionTime || undefined,
      categoryId: value.categoryId,
      merchant: value.merchant,
      notes: value.notes,
      attachmentIds: this.receiptPreviews(),
      splitTargetId: this.pendingPaymentGroupId() || undefined,
    };
    this.saving.set(true);
    try {
      const preview = editingWalletPurchaseId
        ? await this.consumerWallets.previewWalletPurchaseEdit(input)
        : await this.consumerWallets.previewWalletPurchase(input);
      if (this.walletPurchaseApprovedFor() !== preview.confirmationKey) {
        this.walletPurchasePreview.set(preview);
        this.walletPurchaseApprovedFor.set('');
        return;
      }
      if (editingWalletPurchaseId)
        await this.consumerWallets.updateWalletPurchase({
          ...input,
          confirmationKey: preview.confirmationKey,
        });
      else
        await this.consumerWallets.recordWalletPurchase({
          ...input,
          confirmationKey: preview.confirmationKey,
        });
      this.resetForm(this.defaultSourceId());
      this.saving.set(false);
      this.closeFormImmediately();
      this.snackbar.show(
        editingWalletPurchaseId ? 'Wallet purchase updated.' : 'Wallet purchase recorded.',
      );
    } catch (error: unknown) {
      this.walletPurchasePreview.set(null);
      this.walletPurchaseApprovedFor.set('');
      this.snackbar.show(
        error instanceof Error ? error.message : 'Unable to record wallet purchase.',
        'WARNING',
      );
    } finally {
      this.saving.set(false);
    }
  }

  private periodFor(transaction: CardTransaction): { key: string; label: string } {
    return this.periodForMode(transaction, this.effectiveGrouping());
  }

  private periodForDate(date: string): { key: string; label: string } {
    return this.periodForMode(
      { transactionDate: date, cardId: '' } as CardTransaction,
      this.effectiveGrouping() === 'STATEMENT' ? 'MONTH' : this.effectiveGrouping(),
    );
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
    if (this.requestedSourceId) {
      const card = this.store.cards().find((item) => item.id === this.requestedSourceId);
      if (card) return card.archived || card.deletedAt ? '' : card.id;
      const source = this.store.paymentSources().find((item) => item.id === this.requestedSourceId);
      return source && !source.archived ? source.id : '';
    }
    const firstCardId = this.store.activeCards()[0]?.id;
    if (firstCardId) return firstCardId;
    const sources = this.store.activePaymentSources();
    if (sources.filter((source) => source.kind === 'DEBIT').length > 1) return '';
    return sources[0]?.id ?? '';
  }

  private resetForm(sourceId: string): void {
    this.pendingPaymentGroupId.set('');
    this.pendingCardRecurringIdentity = null;
    this.walletPurchaseEditId.set(null);
    this.walletPurchaseEventId.set(crypto.randomUUID());
    this.walletPurchasePreview.set(null);
    this.walletPurchaseApprovedFor.set('');
    this.form.controls.cardId.setValidators(Validators.required);
    this.categoryOverridden.set(false);
    this.receiptPreviews.set([]);
    this.receiptDraftDirty.set(false);
    this.form.reset({
      cardId: sourceId,
      addOnCardId: '',
      consumerWalletId: '',
      type: 'PURCHASE',
      amount: '',
      transactionDate: this.calendarClock.calendar().dateIso,
      transactionTime: '',
      categoryId: 'other',
      merchant: '',
      notes: '',
      relatedTransactionId: '',
      preserveLegacy: false,
      unlinkConfirmed: false,
      archivedSourceReassignmentConfirmedFor: '',
      paymentMethod: 'NONE',
      paymentMethodDetail: '',
      walletId: '',
      walletLoadedAmount: '',
      walletLoadConfirmedFor: '',
      paymentMethodCustom: '',
      smsAdditionalComment: '',
      taxIncluded: false,
      taxAmount: '',
      repeat: 'NONE',
    });
    this.payFromBankMode.set(
      this.store
        .paymentSources()
        .some((source) => source.id === sourceId && source.kind === 'DEBIT'),
    );
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
      balanceTiming: new FormControl<BalanceTiming | ''>('', { nonNullable: true }),
    });
  }

  private emiStartDate(
    transactionDate: string,
    mode: EmiStartMode,
    customStart: string,
  ): string | null {
    if (mode === 'CUSTOM') return /^\d{4}-\d{2}$/.test(customStart) ? `${customStart}-01` : null;
    const date = new Date(`${transactionDate}T12:00:00Z`);
    date.setUTCDate(1);
    if (mode === 'NEXT_MONTH') date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString().slice(0, 10);
  }

  private nextMonthlyOccurrence(dateValue: string, legacyNonCard = false): string {
    if (legacyNonCard) return this.nextNonCardMonthlyOccurrence(dateValue);
    const date = new Date(`${dateValue}T12:00:00Z`);
    const anchorDay = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    date.setUTCDate(
      Math.min(
        anchorDay,
        new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(),
      ),
    );
    return date.toISOString().slice(0, 10);
  }
  private nextNonCardMonthlyOccurrence(dateValue: string): string {
    // Preserve the deferred non-card path rather than changing its schedule dates here.
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
