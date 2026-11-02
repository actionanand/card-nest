import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ConsumerWallet, PaymentSource } from '../../core/models/domain';
import { ConsumerWalletService } from '../../core/services/consumer-wallet.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { indiaTodayIso } from '../../core/services/india-date';
import { AppIcon } from '../../shared/app-icon';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { ProfileModal } from '../../shared/profile-modal';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import {
  CONSUMER_WALLET_PROVIDERS,
  ConsumerWalletProviderId,
  consumerWalletProviderLabel,
} from './consumer-wallet-providers';
import { SnackbarService } from '../../core/services/snackbar.service';

@Component({
  selector: 'app-wallets-page',
  imports: [
    AppIcon,
    AppSelectPicker,
    ProfileModal,
    ConfirmationDialog,
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
  readonly consumerOpen = signal(false);
  readonly historyWalletId = signal<string | null>(null);
  readonly walletActivityId = signal<string | null>(null);
  readonly walletActivityEventId = signal('');
  readonly walletActivityError = signal<string | null>(null);
  readonly focusedFastagSourceId = signal<string | null>(null);
  readonly focusedFastagTransactionId = signal<string | null>(null);
  readonly restoreTargetId = signal<string | null>(null);
  readonly replacementWalletId = signal('');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly restoreError = signal<string | null>(null);
  readonly pendingAction = signal<
    | { kind: 'ARCHIVE_FASTAG'; source: PaymentSource }
    | { kind: 'ARCHIVE_CONSUMER'; wallet: ConsumerWallet }
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
    categoryId: new FormControl('other', { nonNullable: true }),
    merchant: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    memo: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(200)] }),
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
  });
  readonly consumerForm = new FormGroup({
    providerId: new FormControl<ConsumerWalletProviderId>('amazon-pay', { nonNullable: true }),
    customName: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    nickname: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
  });

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
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

  openFastag(): void {
    if (this.saving()) return;
    this.error.set(null);
    this.fastagForm.reset({ name: '', provider: '', plate: '' });
    this.fastagOpen.set(true);
  }

  closeFastag(): void {
    if (this.saving()) return;
    this.fastagOpen.set(false);
    this.error.set(null);
    void this.cancelMatchingSetup('FASTAG');
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
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.wallets.saveFastagWallet(
        {
          id: crypto.randomUUID(),
          nickname: value.name.trim(),
          kind: 'FASTAG',
          institution: value.provider.trim(),
          vehicleNumber: value.plate.replace(/[ -]/g, '').toUpperCase(),
          noLimit: false,
          balanceMinor: 0,
          autoLoad: false,
          archived: false,
        },
        this.setupIntentId('FASTAG'),
      );
      this.fastagOpen.set(false);
      this.fastagForm.reset({ name: '', provider: '', plate: '' });
      this.clearSetupQuery();
      this.snackbar.show('FASTag wallet created.');
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
    return action?.kind === 'DELETE_CONSUMER' ? 'Delete empty wallet?' : 'Archive wallet?';
  }

  pendingActionMessage(): string {
    const action = this.pendingAction();
    if (!action) return '';
    if (action.kind === 'ARCHIVE_FASTAG')
      return `Archive ${action.source.nickname}? Its balance, tolls, top-ups and history will be kept.`;
    const wallet = action.wallet;
    return action.kind === 'DELETE_CONSUMER'
      ? `Permanently delete empty wallet ${this.walletName(wallet)}? This wallet has no saved events.`
      : `Archive ${this.walletName(wallet)}? Its balance and financial history will be kept.`;
  }

  cancelPendingAction(): void {
    if (!this.saving()) this.pendingAction.set(null);
  }

  async confirmPendingAction(): Promise<void> {
    const action = this.pendingAction();
    if (!action || this.saving()) return;
    if (action.kind !== 'ARCHIVE_FASTAG' && !this.wallets.enabled()) {
      this.actionError.set(
        'Wallets is off. Enable Wallets in Settings before changing consumer wallets.',
      );
      return;
    }
    this.saving.set(true);
    this.actionError.set(null);
    try {
      if (action.kind === 'ARCHIVE_FASTAG')
        await this.store.updatePaymentSource({ ...action.source, archived: true });
      else if (action.kind === 'ARCHIVE_CONSUMER')
        await this.wallets.archiveWallet(action.wallet.id);
      else await this.wallets.deleteWalletIfEmpty(action.wallet.id);
      this.pendingAction.set(null);
      this.snackbar.show(
        action.kind === 'DELETE_CONSUMER'
          ? 'Empty wallet deleted.'
          : action.kind === 'ARCHIVE_FASTAG'
            ? 'FASTag wallet archived. History is kept.'
            : 'Wallet archived. Its history and balance are kept.',
      );
    } catch (error: unknown) {
      this.actionError.set(error instanceof Error ? error.message : 'Wallet could not be updated.');
    } finally {
      this.saving.set(false);
    }
  }

  async setFastagArchived(source: PaymentSource, archived: boolean): Promise<void> {
    try {
      await this.store.updatePaymentSource({ ...source, archived });
      this.snackbar.show(
        archived ? 'FASTag wallet archived. History is kept.' : 'FASTag wallet restored.',
      );
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'FASTag wallet could not be updated.',
        'WARNING',
      );
    }
  }

  async updateFastagBalance(source: PaymentSource, event: Event): Promise<void> {
    const amountMinor = parseMoneyToMinor((event.target as HTMLInputElement).value);
    if (amountMinor === null || amountMinor < 0 || source.archived) return;
    try {
      await this.store.updatePaymentSource({ ...source, balanceMinor: amountMinor });
      this.snackbar.show(`${source.nickname} balance updated.`);
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'FASTag balance could not be updated.',
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
    this.consumerForm.reset({ providerId: 'amazon-pay', customName: '', nickname: '' });
    this.consumerOpen.set(true);
  }

  closeConsumerWallet(): void {
    if (this.saving()) return;
    this.consumerOpen.set(false);
    this.error.set(null);
    void this.cancelMatchingSetup('CONSUMER');
  }

  async saveConsumerWallet(event: Event): Promise<void> {
    event.preventDefault();
    this.consumerForm.markAllAsTouched();
    if (this.consumerForm.invalid || this.saving()) return;
    const value = this.consumerForm.getRawValue();
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
        setupIntentId: this.setupIntentId('CONSUMER'),
      });
      this.consumerOpen.set(false);
      this.consumerForm.reset({ providerId: 'amazon-pay', customName: '', nickname: '' });
      this.clearSetupQuery();
      this.snackbar.show('Wallet registered.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Wallet could not be registered.');
    } finally {
      this.saving.set(false);
    }
  }

  async archiveConsumerWallet(wallet: ConsumerWallet): Promise<void> {
    if (!this.wallets.enabled()) return;
    try {
      await this.wallets.archiveWallet(wallet.id);
      this.snackbar.show('Wallet archived. Its history and balance are kept.');
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'Wallet could not be archived.',
        'WARNING',
      );
    }
  }

  async restoreConsumerWallet(wallet: ConsumerWallet): Promise<void> {
    if (!this.wallets.enabled()) return;
    this.restoreError.set(null);
    if (this.needsReplacement()) {
      this.restoreTargetId.set(wallet.id);
      this.replacementWalletId.set(this.activeWallets()[0]?.id ?? '');
      return;
    }
    try {
      await this.wallets.restoreWallet(wallet.id);
      this.snackbar.show('Wallet restored.');
    } catch (error: unknown) {
      this.restoreError.set(
        error instanceof Error ? error.message : 'Wallet could not be restored.',
      );
    }
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

  openWalletActivity(wallet: ConsumerWallet): void {
    if (!this.wallets.enabled() || this.saving()) return;
    this.walletActivityError.set(null);
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
      if (value.kind === 'PURCHASE')
        await this.wallets.recordWalletPurchase({
          id: this.walletActivityEventId(),
          walletId: wallet.id,
          amountMinor,
          eventDate: value.eventDate,
          categoryId: value.categoryId,
          merchant: value.merchant,
          notes: value.memo,
        });
      else if (value.kind === 'MANUAL_CREDIT' || value.kind === 'PROMOTIONAL_CREDIT')
        await this.wallets.addWalletCredit({
          id: this.walletActivityEventId(),
          walletId: wallet.id,
          amountMinor,
          eventType: value.kind,
          eventDate: value.eventDate,
          memo: value.memo,
        });
      else
        await this.wallets.updateWalletBalance({
          id: this.walletActivityEventId(),
          walletId: wallet.id,
          newBalanceMinor: amountMinor,
          eventDate: value.eventDate,
          memo: value.memo,
        });
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
    await this.wallets.cancelSetup(intent.id);
    this.clearSetupQuery();
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
