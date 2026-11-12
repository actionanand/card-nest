import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ConsumerWallet, FastagPass, PaymentSource } from '../../core/models/domain';
import {
  ConsumerWalletService,
  WalletPurchasePreview,
  UpiLiteReturnPreview,
} from '../../core/services/consumer-wallet.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { indiaTodayIso } from '../../core/services/india-date';
import { AppIcon } from '../../shared/app-icon';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { ProfileModal } from '../../shared/profile-modal';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { AppDatePicker } from '../../shared/app-date-picker';
import {
  CONSUMER_WALLET_PROVIDERS,
  ConsumerWalletProviderId,
  consumerWalletProviderLabel,
} from './consumer-wallet-providers';
import { SnackbarService } from '../../core/services/snackbar.service';

function dateOrdinal(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp / 86_400_000
    : null;
}

function addIsoDays(value: string, days: number): string {
  const timestamp = dateOrdinal(value);
  return timestamp === null
    ? ''
    : new Date((timestamp + days) * 86_400_000).toISOString().slice(0, 10);
}

function addIsoMonths(value: string, months: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const nextMonthIndex = year * 12 + month - 1 + months;
  const nextYear = Math.floor(nextMonthIndex / 12);
  const nextMonth = (nextMonthIndex % 12) + 1;
  const nextDay = Math.min(day, daysInMonth(nextYear, nextMonth));
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

@Component({
  selector: 'app-wallets-page',
  imports: [
    AppIcon,
    AppSelectPicker,
    ProfileModal,
    ConfirmationDialog,
    AppDatePicker,
    ReactiveFormsModule,
    RouterLink,
  ],
  templateUrl: './wallets.html',
  styleUrl: './wallets.scss',
})
export class WalletsPage {
  readonly store = inject(CardNestStore);
  readonly wallets = inject(ConsumerWalletService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackbar = inject(SnackbarService);
  readonly fastagOpen = signal(false);
  readonly editingFastagSourceId = signal<string | null>(null);
  readonly fastagPassSourceId = signal<string | null>(null);
  readonly editingFastagPassId = signal<string | null>(null);
  readonly fastagPassValidityMode = signal<'DAYS' | 'END_DATE'>('DAYS');
  readonly consumerOpen = signal(false);
  readonly historyWalletId = signal<string | null>(null);
  readonly walletActivityId = signal<string | null>(null);
  readonly walletActivityEventId = signal('');
  readonly walletActivityError = signal<string | null>(null);
  readonly walletActivityPurchasePreview = signal<WalletPurchasePreview | null>(null);
  readonly walletActivityPurchaseApprovedFor = signal('');
  readonly walletActivityBalancePreview = signal<{
    readonly previousMinor: number;
    readonly nextMinor: number;
    readonly deltaMinor: number;
    readonly confirmationKey: string;
  } | null>(null);
  readonly walletActivityBalanceApprovedFor = signal('');
  readonly fastagActionSource = signal<PaymentSource | null>(null);
  readonly returnWalletId = signal<string | null>(null);
  readonly returnEventId = signal('');
  readonly returnPreview = signal<UpiLiteReturnPreview | null>(null);
  readonly returnApprovedFor = signal('');
  readonly returnError = signal<string | null>(null);
  readonly returnBalanceTimingNeeded = signal(false);
  readonly balanceTimingOptions: readonly AppSelectOption[] = [
    { value: 'AFTER_BASELINE', label: 'It happened after the confirmed bank balance' },
    { value: 'INCLUDED_IN_BASELINE', label: 'It is already included in that bank balance' },
  ];
  readonly focusedFastagSourceId = signal<string | null>(null);
  readonly focusedFastagTransactionId = signal<string | null>(null);
  readonly restoreTargetId = signal<string | null>(null);
  readonly replacementWalletId = signal('');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly restoreError = signal<string | null>(null);
  readonly pendingAction = signal<
    | { kind: 'ARCHIVE_FASTAG'; source: PaymentSource }
    | { kind: 'RESTORE_FASTAG'; source: PaymentSource }
    | { kind: 'ARCHIVE_CONSUMER'; wallet: ConsumerWallet }
    | { kind: 'RESTORE_CONSUMER'; wallet: ConsumerWallet }
    | { kind: 'DELETE_CONSUMER'; wallet: ConsumerWallet }
    | null
  >(null);
  readonly actionError = signal<string | null>(null);
  readonly fastagWallets = computed(() =>
    this.store
      .paymentSources()
      .filter((source) => source.kind === 'FASTAG')
      .slice()
      .sort(
        (left, right) =>
          Number(left.archived) - Number(right.archived) ||
          left.nickname.localeCompare(right.nickname),
      ),
  );
  readonly activeWallets = this.wallets.activeWallets;
  readonly archivedWallets = this.wallets.archivedWallets;
  readonly eligibleReturnBanks = computed(() =>
    this.store
      .paymentSources()
      .filter(
        (source) =>
          source.kind === 'DEBIT' &&
          !source.archived &&
          !!source.lastDigits &&
          source.id !== 'source-debit' &&
          source.institution !== 'Primary bank',
      )
      .sort(
        (left, right) =>
          Number(right.isPrimaryBank) - Number(left.isPrimaryBank) ||
          left.nickname.localeCompare(right.nickname),
      ),
  );
  readonly providerOptions: readonly AppSelectOption[] = CONSUMER_WALLET_PROVIDERS.map(
    ({ id, label }) => ({ value: id, label }),
  );
  readonly selectedHistoryWallet = computed(() =>
    this.wallets.wallets().find((wallet) => wallet.id === this.historyWalletId()),
  );
  readonly walletActivityWallet = computed(() =>
    this.wallets.wallets().find((wallet) => wallet.id === this.walletActivityId()),
  );
  readonly walletActivityKinds: readonly AppSelectOption[] = [
    { value: 'PURCHASE', label: 'Purchase' },
    { value: 'MANUAL_CREDIT', label: 'Manual credit' },
    { value: 'PROMOTIONAL_CREDIT', label: 'Promotional credit' },
    { value: 'BALANCE', label: 'Set verified balance' },
  ];
  readonly walletActivityCategories = computed(() =>
    this.store.categories().map((category) => ({ value: category.id, label: category.name })),
  );
  readonly walletActivityForm = new FormGroup({
    kind: new FormControl<'PURCHASE' | 'MANUAL_CREDIT' | 'PROMOTIONAL_CREDIT' | 'BALANCE'>(
      'PURCHASE',
      { nonNullable: true },
    ),
    amount: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    eventDate: new FormControl(indiaTodayIso(), {
      nonNullable: true,
      validators: [Validators.required],
    }),
    eventTime: new FormControl('', { nonNullable: true }),
    categoryId: new FormControl('other', { nonNullable: true }),
    merchant: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    memo: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(200)] }),
  });
  readonly returnForm = new FormGroup({
    bankSourceId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    amount: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    eventDate: new FormControl(indiaTodayIso(), {
      nonNullable: true,
      validators: [Validators.required],
    }),
    eventTime: new FormControl('', { nonNullable: true }),
    reference: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    note: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(200)] }),
    existingBankTransactionId: new FormControl('', { nonNullable: true }),
    balanceTiming: new FormControl<'AFTER_BASELINE' | 'INCLUDED_IN_BASELINE' | ''>('', {
      nonNullable: true,
    }),
  });
  readonly selectedHistoryEvents = computed(() => {
    const walletId = this.historyWalletId();
    return walletId ? this.wallets.events().filter((event) => event.walletId === walletId) : [];
  });
  readonly focusedFastagTransaction = computed(() => {
    const sourceId = this.focusedFastagSourceId();
    const transactionId = this.focusedFastagTransactionId();
    if (!sourceId || !transactionId) return null;
    return (
      this.store
        .transactions()
        .find(
          (transaction) => transaction.id === transactionId && transaction.cardId === sourceId,
        ) ?? null
    );
  });
  readonly selectedRestoreTarget = computed(() =>
    this.wallets.wallets().find((wallet) => wallet.id === this.restoreTargetId()),
  );
  readonly selectedReplacement = computed(() =>
    this.activeWallets().find((wallet) => wallet.id === this.replacementWalletId()),
  );
  readonly needsReplacement = computed(
    () => this.activeWallets().length >= this.wallets.activeWalletLimit,
  );
  readonly fastagForm = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    provider: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    plate: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^[A-Za-z0-9 -]{5,16}$/)],
    }),
    fastagId: new FormControl('', {
      nonNullable: true,
      validators: [Validators.pattern(/^\d{0,32}$/)],
    }),
    confirmDuplicateVehicle: new FormControl(false, { nonNullable: true }),
  });
  readonly fastagPassForm = new FormGroup({
    name: new FormControl('Annual Highway Pass', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    amount: new FormControl('3075', { nonNullable: true, validators: [Validators.required] }),
    startDate: new FormControl(indiaTodayIso(), {
      nonNullable: true,
      validators: [Validators.required],
    }),
    durationDays: new FormControl('365', { nonNullable: true }),
    endDate: new FormControl('', { nonNullable: true }),
    totalCrossings: new FormControl('200', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    usedCrossings: new FormControl('0', { nonNullable: true, validators: [Validators.required] }),
    notes: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(300)] }),
  });
  readonly consumerForm = new FormGroup({
    providerId: new FormControl<ConsumerWalletProviderId>('amazon-pay', { nonNullable: true }),
    customName: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    nickname: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    openingBalance: new FormControl('0', {
      nonNullable: true,
      validators: [Validators.pattern(/^\d+(?:\.\d{1,2})?$/)],
    }),
  });

  constructor() {
    this.consumerForm.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.error.set(null));
    this.walletActivityForm.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.walletActivityPurchasePreview.set(null);
      this.walletActivityPurchaseApprovedFor.set('');
      this.walletActivityBalancePreview.set(null);
      this.walletActivityBalanceApprovedFor.set('');
    });
    this.returnForm.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.returnPreview.set(null);
      this.returnApprovedFor.set('');
      this.returnError.set(null);
    });
    this.returnForm.controls.eventDate.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.returnForm.controls.balanceTiming.setValue('', { emitEvent: false }));
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const selectedWalletId = params.get('wallet');
      const selectedWallet = this.wallets.wallets().find((item) => item.id === selectedWalletId);
      if (selectedWallet) this.showHistory(selectedWallet);
      const sourceId = params.get('source');
      const source = this.store
        .paymentSources()
        .find((item) => item.id === sourceId && item.kind === 'FASTAG');
      this.focusedFastagSourceId.set(source?.id ?? null);
      this.focusedFastagTransactionId.set(source ? params.get('transaction') : null);
      if (source)
        queueMicrotask(() => {
          const element = document.getElementById(`fastag-${source.id}`);
          if (element && typeof element.scrollIntoView === 'function')
            element.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      const setupId = params.get('setup');
      const intent = this.wallets.setupIntent();
      if (!setupId || !intent || setupId !== intent.id) return;
      if (intent.kind === 'FASTAG') this.openFastag();
      else this.openConsumerWallet();
    });
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        const path = this.router.parseUrl(event.urlAfterRedirects).root.children['primary']
          ?.segments[0]?.path;
        const intent = this.wallets.setupIntent();
        if (path !== 'wallets' && intent) void this.wallets.cancelSetup(intent.id);
      });
  }

  walletName(wallet: ConsumerWallet): string {
    return wallet.nickname || wallet.customName || consumerWalletProviderLabel(wallet.providerId);
  }

  providerLabel(wallet: ConsumerWallet): string {
    return consumerWalletProviderLabel(wallet.providerId);
  }

  money(amountMinor: number): string {
    return formatMoney(amountMinor, 'INR');
  }

  balance(wallet: ConsumerWallet): number {
    return this.wallets.balances().get(wallet.id) ?? 0;
  }

  fastagWallet(source: PaymentSource): ConsumerWallet | undefined {
    return this.wallets.wallets().find((wallet) => wallet.fastagSourceId === source.id);
  }

  fastagBalance(source: PaymentSource): number {
    const wallet = this.fastagWallet(source);
    return wallet ? (this.wallets.balances().get(wallet.id) ?? 0) : (source.balanceMinor ?? 0);
  }

  duplicateFastagVehicle(): boolean {
    const normalized = this.fastagForm.controls.plate.value.replace(/[\s-]/g, '').toUpperCase();
    if (!normalized) return false;
    const editingId = this.editingFastagSourceId();
    return this.store
      .paymentSources()
      .some(
        (source) =>
          source.kind === 'FASTAG' &&
          source.id !== editingId &&
          source.vehicleNumber?.replace(/[\s-]/g, '').toUpperCase() === normalized,
      );
  }

  openFastagActions(source: PaymentSource): void {
    if (source.archived || this.saving()) return;
    this.fastagActionSource.set(source);
  }

  closeFastagActions(): void {
    if (!this.saving()) this.fastagActionSource.set(null);
  }

  startFastagToll(source: PaymentSource): void {
    const wallet = this.fastagWallet(source);
    if (!wallet) {
      this.error.set('FASTag wallet history is still being prepared. Reload Wallets and retry.');
      this.fastagActionSource.set(null);
      return;
    }
    this.fastagActionSource.set(null);
    this.openWalletActivity(wallet);
    this.walletActivityForm.controls.kind.setValue('PURCHASE');
    this.walletActivityForm.controls.merchant.setValue('');
  }

  startFastagLoad(): void {
    if (this.saving()) return;
    this.fastagActionSource.set(null);
    void this.router.navigate(['/transactions'], { queryParams: { add: true } });
  }

  startFastagBalance(source: PaymentSource): void {
    const wallet = this.fastagWallet(source);
    if (!wallet) {
      this.error.set('FASTag wallet history is still being prepared. Reload Wallets and retry.');
      this.fastagActionSource.set(null);
      return;
    }
    this.fastagActionSource.set(null);
    this.openWalletActivity(wallet);
    this.walletActivityForm.patchValue({
      kind: 'BALANCE',
      amount: (this.wallets.balances().get(wallet.id) ?? source.balanceMinor ?? 0) / 100 + '',
    });
  }

  walletActivityKindsFor(wallet: ConsumerWallet): readonly AppSelectOption[] {
    if (!wallet.fastagSourceId) return this.walletActivityKinds;
    return [
      { value: 'PURCHASE', label: 'Toll payment / debit' },
      { value: 'BALANCE', label: 'Set verified balance' },
    ];
  }

  setWalletActivityKind(wallet: ConsumerWallet, value: string): void {
    if (!this.walletActivityKindsFor(wallet).some((option) => option.value === value)) return;
    if (
      value === 'PURCHASE' ||
      value === 'MANUAL_CREDIT' ||
      value === 'PROMOTIONAL_CREDIT' ||
      value === 'BALANCE'
    )
      this.walletActivityForm.controls.kind.setValue(value);
  }

  confirmWalletActivityBalance(event: Event): void {
    const preview = this.walletActivityBalancePreview();
    this.walletActivityBalanceApprovedFor.set(
      preview && (event.target as HTMLInputElement).checked ? preview.confirmationKey : '',
    );
  }

  openFastag(): void {
    if (this.saving()) return;
    this.error.set(null);
    this.editingFastagSourceId.set(null);
    this.fastagForm.reset({
      name: '',
      provider: '',
      plate: '',
      fastagId: '',
      confirmDuplicateVehicle: false,
    });
    this.fastagOpen.set(true);
  }

  editFastag(source: PaymentSource): void {
    if (this.saving() || source.archived) return;
    this.error.set(null);
    this.editingFastagSourceId.set(source.id);
    this.fastagForm.reset({
      name: source.nickname,
      provider: source.institution ?? '',
      plate: source.vehicleNumber ?? '',
      fastagId: source.fastagId ?? '',
      confirmDuplicateVehicle: false,
    });
    this.fastagOpen.set(true);
  }

  async closeFastag(): Promise<void> {
    if (this.saving()) return;
    this.fastagOpen.set(false);
    this.editingFastagSourceId.set(null);
    this.error.set(null);
    this.fastagForm.reset({
      name: '',
      provider: '',
      plate: '',
      fastagId: '',
      confirmDuplicateVehicle: false,
    });
    await this.cancelMatchingSetup('FASTAG');
  }

  async saveFastag(event: Event): Promise<void> {
    event.preventDefault();
    this.fastagForm.markAllAsTouched();
    if (this.fastagForm.invalid || this.saving()) return;
    const value = this.fastagForm.getRawValue();
    if (!value.name.trim()) {
      this.error.set('Enter a wallet name.');
      return;
    }
    const editing = this.store
      .paymentSources()
      .find((source) => source.id === this.editingFastagSourceId() && source.kind === 'FASTAG');
    const vehicleNumber = value.plate.trim();
    const normalizedVehicle = vehicleNumber.replace(/[\s-]/g, '').toUpperCase();
    const duplicateVehicle = this.store
      .paymentSources()
      .some(
        (source) =>
          source.kind === 'FASTAG' &&
          source.id !== editing?.id &&
          source.vehicleNumber?.replace(/[\s-]/g, '').toUpperCase() === normalizedVehicle,
      );
    if (duplicateVehicle && !value.confirmDuplicateVehicle) {
      this.error.set(
        'Another FASTag uses this vehicle. Confirm that both registrations are intentional.',
      );
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      if (editing) {
        await this.store.updatePaymentSource(
          {
            ...editing,
            nickname: value.name.trim(),
            institution: value.provider.trim() || undefined,
            vehicleNumber,
            fastagId: value.fastagId.trim() || undefined,
          },
          value.confirmDuplicateVehicle,
        );
        await this.wallets.refreshWalletRecords();
      } else {
        await this.wallets.saveFastagWallet(
          {
            id: crypto.randomUUID(),
            nickname: value.name.trim(),
            kind: 'FASTAG',
            institution: value.provider.trim(),
            vehicleNumber,
            fastagId: value.fastagId.trim() || undefined,
            noLimit: false,
            balanceMinor: 0,
            autoLoad: false,
            archived: false,
          },
          this.setupIntentId('FASTAG'),
          value.confirmDuplicateVehicle,
        );
      }
      this.fastagOpen.set(false);
      this.editingFastagSourceId.set(null);
      this.fastagForm.reset({
        name: '',
        provider: '',
        plate: '',
        fastagId: '',
        confirmDuplicateVehicle: false,
      });
      this.clearSetupQuery();
      this.snackbar.show(editing ? 'FASTag wallet updated.' : 'FASTag wallet created.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Wallet could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }

  requestFastagArchive(source: PaymentSource): void {
    this.actionError.set(null);
    this.pendingAction.set({ kind: 'ARCHIVE_FASTAG', source });
  }

  requestFastagRestore(source: PaymentSource): void {
    this.actionError.set(null);
    this.pendingAction.set({ kind: 'RESTORE_FASTAG', source });
  }

  requestConsumerArchive(wallet: ConsumerWallet): void {
    this.actionError.set(null);
    this.pendingAction.set({ kind: 'ARCHIVE_CONSUMER', wallet });
  }

  requestEmptyWalletDelete(wallet: ConsumerWallet): void {
    if (this.wallets.events().some((event) => event.walletId === wallet.id)) return;
    this.actionError.set(null);
    this.pendingAction.set({ kind: 'DELETE_CONSUMER', wallet });
  }

  pendingActionTitle(): string {
    const action = this.pendingAction();
    if (action?.kind === 'DELETE_CONSUMER') return 'Delete empty wallet?';
    if (action?.kind === 'RESTORE_FASTAG' || action?.kind === 'RESTORE_CONSUMER')
      return 'Restore wallet?';
    return 'Archive wallet?';
  }

  pendingActionMessage(): string {
    const action = this.pendingAction();
    if (!action) return '';
    if (action.kind === 'ARCHIVE_FASTAG')
      return `Archive ${action.source.nickname}? Its balance, tolls, top-ups and history will be kept.`;
    if (action.kind === 'RESTORE_FASTAG')
      return `Restore ${action.source.nickname}? It becomes active again with its saved FASTag balance and toll history.`;
    const wallet = action.wallet;
    if (action.kind === 'DELETE_CONSUMER')
      return `Permanently delete empty wallet ${this.walletName(wallet)}? This wallet has no saved events.`;
    if (action.kind === 'RESTORE_CONSUMER')
      return `Restore ${this.walletName(wallet)}? It becomes active again with its balance and history.`;
    return `Archive ${this.walletName(wallet)}? Its balance and financial history will be kept.`;
  }

  pendingActionLabel(): string {
    const action = this.pendingAction();
    if (!action) return 'Confirm';
    if (action.kind === 'DELETE_CONSUMER') return 'Delete wallet';
    if (action.kind === 'ARCHIVE_FASTAG' || action.kind === 'ARCHIVE_CONSUMER')
      return 'Archive wallet';
    return 'Restore wallet';
  }

  cancelPendingAction(): void {
    if (!this.saving()) this.pendingAction.set(null);
  }

  async confirmPendingAction(): Promise<void> {
    const action = this.pendingAction();
    if (!action || this.saving()) return;
    if (
      action.kind !== 'ARCHIVE_FASTAG' &&
      action.kind !== 'RESTORE_FASTAG' &&
      !this.wallets.enabled()
    ) {
      this.actionError.set(
        'Wallets is off. Enable Wallets in Settings before changing consumer wallets.',
      );
      return;
    }
    this.saving.set(true);
    this.actionError.set(null);
    try {
      if (action.kind === 'ARCHIVE_FASTAG' || action.kind === 'RESTORE_FASTAG') {
        const archived = action.kind === 'ARCHIVE_FASTAG';
        await this.store.updatePaymentSource({ ...action.source, archived });
        await this.wallets.refreshWalletRecords();
      } else if (action.kind === 'ARCHIVE_CONSUMER')
        await this.wallets.archiveWallet(action.wallet.id);
      else if (action.kind === 'RESTORE_CONSUMER')
        await this.wallets.restoreWallet(action.wallet.id);
      else await this.wallets.deleteWalletIfEmpty(action.wallet.id);
      this.pendingAction.set(null);
      this.snackbar.show(
        action.kind === 'DELETE_CONSUMER'
          ? 'Empty wallet deleted.'
          : action.kind === 'ARCHIVE_FASTAG'
            ? 'FASTag wallet archived. History is kept.'
            : action.kind === 'RESTORE_FASTAG'
              ? 'FASTag wallet restored.'
              : action.kind === 'RESTORE_CONSUMER'
                ? 'Wallet restored. Its history and balance are kept.'
                : 'Wallet archived. Its history and balance are kept.',
      );
    } catch (error: unknown) {
      this.actionError.set(error instanceof Error ? error.message : 'Wallet could not be updated.');
    } finally {
      this.saving.set(false);
    }
  }

  setFastagArchived(source: PaymentSource, archived: boolean): void {
    if (archived) this.requestFastagArchive(source);
    else this.requestFastagRestore(source);
  }

  openFastagPass(source: PaymentSource, pass?: FastagPass): void {
    if (this.saving() || source.archived) return;
    this.error.set(null);
    this.fastagPassSourceId.set(source.id);
    this.editingFastagPassId.set(pass?.id ?? null);
    this.fastagPassValidityMode.set(pass?.durationDays ? 'DAYS' : pass ? 'END_DATE' : 'DAYS');
    this.fastagPassForm.reset({
      name: pass?.name ?? 'Annual Highway Pass',
      amount: pass ? String(pass.amountMinor / 100) : '3075',
      startDate: pass?.startDate ?? indiaTodayIso(),
      durationDays: String(
        pass?.durationDays ??
          (pass ? (dateOrdinal(pass.endDate) ?? 0) - (dateOrdinal(pass.startDate) ?? 0) + 1 : 365),
      ),
      endDate: pass && !pass.durationDays ? pass.endDate : '',
      totalCrossings: String(pass?.totalCrossings ?? 200),
      usedCrossings: String(pass?.usedCrossings ?? 0),
      notes: pass?.notes ?? '',
    });
  }

  closeFastagPass(): void {
    if (this.saving()) return;
    this.fastagPassSourceId.set(null);
    this.editingFastagPassId.set(null);
    this.error.set(null);
  }

  async saveFastagPass(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.fastagPassForm.markAllAsTouched();
    if (this.fastagPassForm.invalid) return;
    const source = this.store
      .paymentSources()
      .find((item) => item.id === this.fastagPassSourceId() && item.kind === 'FASTAG');
    if (!source || source.archived) return;
    const value = this.fastagPassForm.getRawValue();
    const amountMinor = parseMoneyToMinor(value.amount);
    const startOrdinal = dateOrdinal(value.startDate);
    const totalCrossings = Number(value.totalCrossings);
    const usedCrossings = Number(value.usedCrossings);
    if (!value.name.trim() || amountMinor === null || amountMinor <= 0 || startOrdinal === null) {
      this.error.set('Enter a pass name, positive amount and valid start date.');
      return;
    }
    if (
      !Number.isSafeInteger(totalCrossings) ||
      totalCrossings <= 0 ||
      !Number.isSafeInteger(usedCrossings) ||
      usedCrossings < 0 ||
      usedCrossings > totalCrossings
    ) {
      this.error.set('Used crossings must be between zero and the total allowed crossings.');
      return;
    }
    const explicitEnd = this.fastagPassValidityMode() === 'END_DATE' ? value.endDate.trim() : '';
    const durationDays =
      this.fastagPassValidityMode() === 'DAYS' ? Number(value.durationDays) : undefined;
    if (!explicitEnd && (!Number.isSafeInteger(durationDays) || (durationDays ?? 0) <= 0)) {
      this.error.set('Enter a positive duration or an explicit end date.');
      return;
    }
    const endDate = explicitEnd || addIsoDays(value.startDate, (durationDays ?? 1) - 1);
    const endOrdinal = dateOrdinal(endDate);
    if (endOrdinal === null || endOrdinal < startOrdinal) {
      this.error.set('The pass end date must be on or after its start date.');
      return;
    }
    const timestamp = new Date().toISOString();
    const pass: FastagPass = {
      id: this.editingFastagPassId() ?? crypto.randomUUID(),
      name: value.name.trim().slice(0, 80),
      amountMinor,
      startDate: value.startDate,
      endDate,
      durationDays,
      totalCrossings,
      usedCrossings,
      notes: value.notes.trim().slice(0, 300) || undefined,
      createdAt:
        source.fastagPasses?.find((item) => item.id === this.editingFastagPassId())?.createdAt ??
        timestamp,
      updatedAt: timestamp,
    };
    const editing = !!this.editingFastagPassId();
    const passes = source.fastagPasses ?? [];
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.store.updatePaymentSource({
        ...source,
        fastagPasses: this.editingFastagPassId()
          ? passes.map((item) => (item.id === pass.id ? pass : item))
          : [...passes, pass],
      });
      this.fastagPassSourceId.set(null);
      this.editingFastagPassId.set(null);
      this.snackbar.show(editing ? 'FASTag pass updated.' : 'FASTag pass saved.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'FASTag pass could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }

  fastagPassStatus(pass: FastagPass): 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' | 'EXHAUSTED' {
    if (pass.usedCrossings >= pass.totalCrossings) return 'EXHAUSTED';
    const today = indiaTodayIso();
    if (today < pass.startDate) return 'SCHEDULED';
    return today > pass.endDate ? 'EXPIRED' : 'ACTIVE';
  }

  fastagPassStatusLabel(pass: FastagPass): string {
    const status = this.fastagPassStatus(pass);
    return status === 'SCHEDULED'
      ? 'Scheduled'
      : status === 'ACTIVE'
        ? 'Active'
        : status === 'EXPIRED'
          ? 'Expired'
          : 'Exhausted';
  }

  fastagPassRemaining(pass: FastagPass): number {
    return Math.max(0, pass.totalCrossings - pass.usedCrossings);
  }

  fastagPassValidity(pass: FastagPass): string {
    const today = indiaTodayIso();
    const todayOrdinal = dateOrdinal(today);
    const startOrdinal = dateOrdinal(pass.startDate);
    const endOrdinal = dateOrdinal(pass.endDate);
    if (this.fastagPassStatus(pass) === 'EXHAUSTED') return 'Crossings exhausted';
    if (startOrdinal !== null && todayOrdinal !== null && today < pass.startDate)
      return `Scheduled · starts in ${startOrdinal - todayOrdinal} days`;
    if (todayOrdinal === null || endOrdinal === null || today > pass.endDate) return 'Expired';
    let months = Math.max(
      0,
      (Number(pass.endDate.slice(0, 4)) - Number(today.slice(0, 4))) * 12 +
        Number(pass.endDate.slice(5, 7)) -
        Number(today.slice(5, 7)),
    );
    while (months > 0 && addIsoMonths(today, months) > pass.endDate) months--;
    while (addIsoMonths(today, months + 1) <= pass.endDate) months++;
    const remainingDays = endOrdinal - (dateOrdinal(addIsoMonths(today, months)) ?? todayOrdinal);
    return months > 0
      ? `${months} months, ${remainingDays} days remaining`
      : `${endOrdinal - todayOrdinal} days remaining`;
  }

  async recordFastagCrossing(source: PaymentSource, pass: FastagPass): Promise<void> {
    if (this.saving() || source.archived || this.fastagPassStatus(pass) !== 'ACTIVE') return;
    const timestamp = new Date().toISOString();
    try {
      await this.store.updatePaymentSource({
        ...source,
        fastagPasses: (source.fastagPasses ?? []).map((item) =>
          item.id === pass.id
            ? { ...item, usedCrossings: item.usedCrossings + 1, updatedAt: timestamp }
            : item,
        ),
      });
      this.snackbar.show('Pass crossing recorded. FASTag wallet balance was not changed.');
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'Crossing could not be recorded.',
        'WARNING',
      );
    }
  }

  async toggleFastagBalance(source: PaymentSource): Promise<void> {
    if (source.archived) return;
    try {
      await this.store.updatePaymentSource({ ...source, noLimit: !source.noLimit });
      this.snackbar.show(`${source.nickname} updated.`);
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'FASTag settings could not be updated.',
        'WARNING',
      );
    }
  }

  openConsumerWallet(): void {
    if (this.saving() || (!this.wallets.enabled() && !this.setupIntentId('CONSUMER'))) return;
    this.error.set(null);
    this.consumerForm.reset({
      providerId: 'amazon-pay',
      customName: '',
      nickname: '',
      openingBalance: '0',
    });
    this.consumerOpen.set(true);
  }

  async closeConsumerWallet(): Promise<void> {
    if (this.saving()) return;
    this.consumerOpen.set(false);
    this.error.set(null);
    this.consumerForm.reset({
      providerId: 'amazon-pay',
      customName: '',
      nickname: '',
      openingBalance: '0',
    });
    await this.cancelMatchingSetup('CONSUMER');
  }

  async saveConsumerWallet(event: Event): Promise<void> {
    event.preventDefault();
    this.consumerForm.markAllAsTouched();
    if (this.consumerForm.invalid || this.saving()) return;
    const value = this.consumerForm.getRawValue();
    const openingBalanceMinor = value.openingBalance.trim()
      ? parseMoneyToMinor(value.openingBalance)
      : 0;
    if (openingBalanceMinor === null || openingBalanceMinor < 0) {
      this.consumerForm.controls.openingBalance.setErrors({ amount: true });
      this.error.set('Enter a nonnegative amount with up to two decimal places.');
      return;
    }
    if (value.providerId === 'other' && !value.customName.trim()) {
      this.consumerForm.controls.customName.setErrors({ required: true });
      this.error.set('Enter a custom wallet name.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.wallets.registerWallet({
        providerId: value.providerId,
        customName: value.customName,
        nickname: value.nickname,
        openingBalanceMinor,
        setupIntentId: this.setupIntentId('CONSUMER'),
      });
      this.consumerOpen.set(false);
      this.consumerForm.reset({
        providerId: 'amazon-pay',
        customName: '',
        nickname: '',
        openingBalance: '0',
      });
      this.clearSetupQuery();
      this.snackbar.show('Wallet registered.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Wallet could not be registered.');
    } finally {
      this.saving.set(false);
    }
  }

  archiveConsumerWallet(wallet: ConsumerWallet): void {
    this.requestConsumerArchive(wallet);
  }

  async restoreConsumerWallet(wallet: ConsumerWallet): Promise<void> {
    if (!this.wallets.enabled()) return;
    this.restoreError.set(null);
    if (this.needsReplacement()) {
      this.restoreTargetId.set(wallet.id);
      this.replacementWalletId.set(this.activeWallets()[0]?.id ?? '');
      return;
    }
    this.actionError.set(null);
    this.pendingAction.set({ kind: 'RESTORE_CONSUMER', wallet });
  }

  closeRestore(): void {
    this.restoreTargetId.set(null);
    this.restoreError.set(null);
  }

  async confirmRestoreReplacement(): Promise<void> {
    if (!this.wallets.enabled()) return;
    const targetId = this.restoreTargetId();
    if (!targetId || !this.replacementWalletId()) return;
    this.saving.set(true);
    this.restoreError.set(null);
    try {
      await this.wallets.restoreWallet(targetId, this.replacementWalletId());
      this.closeRestore();
      this.snackbar.show('Wallet restored and replacement archived. Both histories are kept.');
    } catch (error: unknown) {
      this.restoreError.set(
        error instanceof Error ? error.message : 'Wallet replacement could not be saved.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  showHistory(wallet: ConsumerWallet): void {
    this.historyWalletId.set(wallet.id);
  }

  returnBankLabel(sourceId: string): string {
    const source = this.eligibleReturnBanks().find((item) => item.id === sourceId);
    if (!source) return 'Choose a Bank/UPI account';
    return `${source.institution || source.nickname} · ${source.nickname}${source.lastDigits ? ` · ${source.lastDigits.slice(-3)}` : ''}${source.isPrimaryBank ? ' · Primary' : ''}`;
  }

  openReturnToBank(wallet: ConsumerWallet): void {
    if (!this.wallets.enabled() || this.saving() || wallet.kind !== 'UPI_LITE') return;
    const banks = this.eligibleReturnBanks();
    const selected = banks.length === 1 ? banks[0] : banks.find((bank) => bank.isPrimaryBank);
    this.returnWalletId.set(wallet.id);
    this.returnEventId.set(crypto.randomUUID());
    this.returnPreview.set(null);
    this.returnApprovedFor.set('');
    this.returnError.set(null);
    this.returnBalanceTimingNeeded.set(false);
    this.returnForm.reset({
      bankSourceId: selected?.id ?? '',
      amount: '',
      eventDate: indiaTodayIso(),
      eventTime: '',
      reference: '',
      note: '',
      existingBankTransactionId: '',
      balanceTiming: '',
    });
  }

  closeReturnToBank(): void {
    if (this.saving()) return;
    this.returnWalletId.set(null);
    this.returnEventId.set('');
    this.returnPreview.set(null);
    this.returnApprovedFor.set('');
    this.returnError.set(null);
    this.returnBalanceTimingNeeded.set(false);
  }

  existingReturnBankCreditOptions(): readonly AppSelectOption[] {
    const value = this.returnForm.getRawValue();
    const amountMinor = parseMoneyToMinor(value.amount);
    const matching = this.store
      .transactions()
      .filter(
        (transaction) =>
          transaction.type === 'CREDIT' &&
          transaction.cardId === value.bankSourceId &&
          transaction.amountMinor === amountMinor &&
          transaction.transactionDate === value.eventDate &&
          (!value.reference || transaction.reference === value.reference),
      );
    if (!matching.length) return [];
    return matching.map((transaction) => ({
      value: transaction.id,
      label: `${transaction.merchant || 'Bank credit'} · ${transaction.transactionDate}`,
      detail: `${this.money(transaction.amountMinor)}${transaction.reference ? ` · Ref ${transaction.reference}` : ''}`,
    }));
  }

  private returnInput(walletId: string, id: string) {
    const value = this.returnForm.getRawValue();
    const amountMinor = parseMoneyToMinor(value.amount);
    if (!amountMinor || !this.eligibleReturnBanks().some((bank) => bank.id === value.bankSourceId))
      throw new Error('Choose an active Bank/UPI account and a positive return amount.');
    return {
      id,
      walletId,
      bankSourceId: value.bankSourceId,
      amountMinor,
      eventDate: value.eventDate,
      eventTime: value.eventTime || undefined,
      reference: value.reference.trim() || undefined,
      note: value.note.trim() || undefined,
      existingBankTransactionId: value.existingBankTransactionId || undefined,
      balanceTiming: value.balanceTiming || undefined,
    } as const;
  }

  async previewReturnToBank(): Promise<void> {
    const walletId = this.returnWalletId();
    if (!walletId || !this.wallets.enabled() || this.saving()) return;
    this.returnForm.markAllAsTouched();
    if (this.returnForm.invalid) return;
    this.saving.set(true);
    this.returnError.set(null);
    try {
      const input = this.returnInput(walletId, this.returnEventId());
      this.returnPreview.set(await this.wallets.previewUpiLiteReturn(input));
      this.returnApprovedFor.set('');
      this.returnBalanceTimingNeeded.set(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Return could not be previewed.';
      this.returnError.set(message);
      this.returnBalanceTimingNeeded.set(
        message.startsWith('This has no time') || message.startsWith('This entry existed'),
      );
    } finally {
      this.saving.set(false);
    }
  }

  setReturnApproval(event: Event): void {
    const preview = this.returnPreview();
    this.returnApprovedFor.set(
      preview && (event.target as HTMLInputElement).checked ? preview.confirmationKey : '',
    );
  }

  setReturnBalanceTiming(value: string): void {
    if (value === 'AFTER_BASELINE' || value === 'INCLUDED_IN_BASELINE')
      this.returnForm.controls.balanceTiming.setValue(value);
  }

  async confirmReturnToBank(): Promise<void> {
    const walletId = this.returnWalletId();
    const preview = this.returnPreview();
    if (
      !walletId ||
      !preview ||
      !this.wallets.enabled() ||
      this.saving() ||
      this.returnApprovedFor() !== preview.confirmationKey
    )
      return;
    this.saving.set(true);
    this.returnError.set(null);
    try {
      const input = this.returnInput(walletId, this.returnEventId());
      const event = await this.wallets.recordUpiLiteReturn({
        ...input,
        confirmationKey: preview.confirmationKey,
      });
      this.returnWalletId.set(null);
      this.returnEventId.set('');
      this.returnPreview.set(null);
      this.returnApprovedFor.set('');
      this.snackbar.show(`Return to Bank recorded: ${this.money(event.amountMinor)}.`);
    } catch (error: unknown) {
      this.returnError.set(
        error instanceof Error ? error.message : 'Return to Bank could not be recorded.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  openWalletActivity(wallet: ConsumerWallet): void {
    if (!this.wallets.enabled() || this.saving()) return;
    this.walletActivityError.set(null);
    this.walletActivityPurchasePreview.set(null);
    this.walletActivityPurchaseApprovedFor.set('');
    this.walletActivityBalancePreview.set(null);
    this.walletActivityBalanceApprovedFor.set('');
    this.walletActivityId.set(wallet.id);
    this.walletActivityEventId.set(crypto.randomUUID());
    this.walletActivityForm.reset({
      kind: 'PURCHASE',
      amount: '',
      eventDate: indiaTodayIso(),
      categoryId: this.store.categories().find((category) => category.id === 'other')?.id ?? '',
      merchant: '',
      memo: '',
    });
  }

  closeWalletActivity(): void {
    if (this.saving()) return;
    this.walletActivityId.set(null);
    this.walletActivityError.set(null);
    this.walletActivityPurchasePreview.set(null);
    this.walletActivityPurchaseApprovedFor.set('');
    this.walletActivityBalancePreview.set(null);
    this.walletActivityBalanceApprovedFor.set('');
  }

  confirmWalletActivityPurchase(event: Event): void {
    const preview = this.walletActivityPurchasePreview();
    this.walletActivityPurchaseApprovedFor.set(
      preview && (event.target as HTMLInputElement).checked ? preview.confirmationKey : '',
    );
  }

  async saveWalletActivity(event: Event): Promise<void> {
    event.preventDefault();
    const wallet = this.walletActivityWallet();
    if (!wallet || !this.wallets.enabled() || this.saving()) return;
    this.walletActivityForm.markAllAsTouched();
    if (this.walletActivityForm.invalid) return;
    const value = this.walletActivityForm.getRawValue();
    const amountMinor = parseMoneyToMinor(value.amount);
    if (
      amountMinor === null ||
      amountMinor < 0 ||
      (value.kind !== 'BALANCE' && amountMinor === 0) ||
      (value.kind === 'PURCHASE' && !value.categoryId)
    ) {
      this.walletActivityError.set('Enter a valid amount and the required purchase category.');
      return;
    }
    this.saving.set(true);
    this.walletActivityError.set(null);
    try {
      if (value.kind === 'PURCHASE') {
        const input = {
          id: this.walletActivityEventId(),
          walletId: wallet.id,
          amountMinor,
          eventDate: value.eventDate,
          eventTime: value.eventTime || undefined,
          categoryId: value.categoryId,
          merchant: value.merchant,
          notes: value.memo,
        };
        const preview = await this.wallets.previewWalletPurchase(input);
        if (this.walletActivityPurchaseApprovedFor() !== preview.confirmationKey) {
          this.walletActivityPurchasePreview.set(preview);
          this.walletActivityPurchaseApprovedFor.set('');
          return;
        }
        await this.wallets.recordWalletPurchase({
          ...input,
          confirmationKey: preview.confirmationKey,
        });
      } else if (value.kind === 'MANUAL_CREDIT' || value.kind === 'PROMOTIONAL_CREDIT')
        await this.wallets.addWalletCredit({
          id: this.walletActivityEventId(),
          walletId: wallet.id,
          amountMinor,
          eventType: value.kind,
          eventDate: value.eventDate,
          memo: value.memo,
        });
      else {
        const previousMinor = this.wallets.balances().get(wallet.id) ?? 0;
        const confirmationKey = JSON.stringify([
          wallet.id,
          previousMinor,
          amountMinor,
          value.eventDate,
          value.memo.trim(),
        ]);
        if (this.walletActivityBalanceApprovedFor() !== confirmationKey) {
          this.walletActivityBalancePreview.set({
            previousMinor,
            nextMinor: amountMinor,
            deltaMinor: amountMinor - previousMinor,
            confirmationKey,
          });
          this.walletActivityBalanceApprovedFor.set('');
          return;
        }
        await this.wallets.updateWalletBalance({
          id: this.walletActivityEventId(),
          walletId: wallet.id,
          newBalanceMinor: amountMinor,
          eventDate: value.eventDate,
          memo: value.memo,
        });
      }
      this.walletActivityId.set(null);
      this.snackbar.show('Wallet activity recorded.');
    } catch (error: unknown) {
      this.walletActivityError.set(
        error instanceof Error ? error.message : 'Wallet activity could not be saved.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  closeHistory(): void {
    this.historyWalletId.set(null);
  }

  private setupIntentId(kind: 'FASTAG' | 'CONSUMER'): string | undefined {
    const intent = this.wallets.setupIntent();
    return intent?.kind === kind ? intent.id : undefined;
  }

  private async cancelMatchingSetup(kind: 'FASTAG' | 'CONSUMER'): Promise<void> {
    const intent = this.wallets.setupIntent();
    if (intent?.kind !== kind) return;
    try {
      await this.wallets.cancelSetup(intent.id);
      if (this.wallets.enabled()) {
        this.clearSetupQuery();
        return;
      }
      const navigated = await this.router.navigate(['/settings'], { replaceUrl: true });
      if (!navigated) this.error.set('Setup was cancelled, but Settings could not be opened.');
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'Wallet setup could not be cancelled.',
      );
    }
  }

  private clearSetupQuery(): void {
    if (!this.route.snapshot.queryParamMap.has('setup')) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { setup: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
