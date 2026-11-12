import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import {
  CardTransaction,
  ConsumerWallet,
  ConsumerWalletEvent,
  ConsumerWalletEventAllocation,
  FastagPass,
  PaymentSource,
} from '../../core/models/domain';
import {
  ConsumerWalletService,
  WalletSetupIntent,
} from '../../core/services/consumer-wallet.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { SnackbarService } from '../../core/services/snackbar.service';
import { WalletsPage } from './wallets';

const timestamp = '2026-11-02T12:00:00.000Z';

function setup(
  enabled = true,
  setupIntent: WalletSetupIntent | null = null,
  queryParams: Record<string, string> = {},
  sourceRecords: readonly PaymentSource[] = [],
  transactionRecords: readonly CardTransaction[] = [],
) {
  const savedWallets = signal<readonly ConsumerWallet[]>([]);
  const savedEvents = signal<readonly ConsumerWalletEvent[]>([]);
  const featureEnabled = signal(enabled);
  const intent = signal(setupIntent);
  const loadError = signal<string | null>(null);
  const activeWallets = computed(() => savedWallets().filter((wallet) => !wallet.archived));
  const activeLoadDestinations = computed(() =>
    savedWallets().filter((wallet) => !wallet.archived),
  );
  const archivedWallets = computed(() => savedWallets().filter((wallet) => wallet.archived));
  const balances = computed(() => new Map<string, number>());
  const consumerWalletService = {
    wallets: savedWallets,
    events: savedEvents,
    allocations: signal<readonly ConsumerWalletEventAllocation[]>([]),
    enabled: featureEnabled,
    loading: signal(false),
    loadError,
    setupIntent: intent,
    activeWallets,
    activeLoadDestinations,
    archivedWallets,
    activeWalletLimit: 15,
    balances,
    previewWalletPurchase: vi.fn(async () => ({
      walletId: 'purchase-wallet',
      amountMinor: 10000,
      balanceBeforeMinor: 30000,
      balanceAfterMinor: 20000,
      allocations: [{ creditEventId: 'purchase-origin', allocatedMinor: 10000 }],
      confirmationKey: 'synthetic-purchase-approval',
    })),
    recordWalletPurchase: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      eventType: 'PURCHASE',
      balanceDeltaMinor: -Number(input['amountMinor']),
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    archiveWallet: vi.fn(async (id: string) => {
      savedWallets.update((items) =>
        items.map((wallet) => (wallet.id === id ? { ...wallet, archived: true } : wallet)),
      );
    }),
    restoreWallet: vi.fn(async () => undefined),
    refreshWalletRecords: vi.fn(async () => undefined),
    deleteWalletIfEmpty: vi.fn(async () => undefined),
    saveFastagWallet: vi.fn(async (source: PaymentSource) => {
      savedWallets.update((items) => [
        ...items,
        {
          id: source.id,
          providerId: 'fastag',
          kind: 'STANDARD',
          nickname: source.nickname,
          fastagSourceId: source.id,
          vehicleNumber: source.vehicleNumber,
          fastagId: source.fastagId,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]);
    }),
    registerWallet: vi.fn(
      async (input: {
        providerId: ConsumerWallet['providerId'];
        customName?: string;
        nickname?: string;
        setupIntentId?: string;
      }) => {
        const wallet: ConsumerWallet = {
          id: 'synthetic-consumer-wallet',
          providerId: input.providerId,
          kind: input.providerId === 'upi-lite' ? 'UPI_LITE' : 'STANDARD',
          customName: input.customName,
          nickname: input.nickname,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        savedWallets.update((items) => [...items, wallet]);
        featureEnabled.set(true);
        intent.set(null);
        return wallet;
      },
    ),
    cancelSetup: vi.fn(async () => intent.set(null)),
    initialise: vi.fn(async () => loadError.set(null)),
  };
  const paymentSources = signal<readonly PaymentSource[]>(sourceRecords);
  const transactions = signal<readonly CardTransaction[]>(transactionRecords);
  const store = {
    paymentSources,
    transactions,
    categories: signal([{ id: 'other', name: 'Other', icon: 'category', appliesTo: 'BOTH' }]),
    updatePaymentSource: vi.fn(async (source: PaymentSource) => {
      paymentSources.update((items) =>
        items.map((item) => (item.id === source.id ? source : item)),
      );
    }),
  };
  const snackbar = { show: vi.fn() };

  TestBed.configureTestingModule({
    imports: [WalletsPage],
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          queryParamMap: of(convertToParamMap(queryParams)),
          snapshot: { queryParamMap: convertToParamMap(queryParams) },
        },
      },
      { provide: ConsumerWalletService, useValue: consumerWalletService },
      { provide: CardNestStore, useValue: store },
      { provide: SnackbarService, useValue: snackbar },
    ],
  });
  const fixture = TestBed.createComponent(WalletsPage);
  fixture.detectChanges();
  return { fixture, consumerWalletService, paymentSources, transactions, snackbar, store };
}

describe('Wallets page Stage A', () => {
  it('requires preview approval for wallet purchases and clears approval when values change', async () => {
    const { fixture, consumerWalletService } = setup();
    const wallet: ConsumerWallet = {
      id: 'purchase-wallet',
      providerId: 'amazon-pay',
      kind: 'STANDARD',
      nickname: 'Synthetic Amazon',
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    consumerWalletService.wallets.set([wallet]);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.openWalletActivity(wallet);
    page.walletActivityForm.patchValue({ amount: '100.00', categoryId: 'other' });
    await page.saveWalletActivity(new Event('submit'));
    expect(consumerWalletService.previewWalletPurchase).toHaveBeenCalledOnce();
    expect(consumerWalletService.recordWalletPurchase).not.toHaveBeenCalled();
    expect(page.walletActivityPurchasePreview()?.balanceAfterMinor).toBe(20000);

    page.confirmWalletActivityPurchase({ target: { checked: true } } as unknown as Event);
    page.walletActivityForm.controls.amount.setValue('120.00');
    expect(page.walletActivityPurchaseApprovedFor()).toBe('');
    expect(page.walletActivityPurchasePreview()).toBeNull();
    await page.saveWalletActivity(new Event('submit'));
    expect(consumerWalletService.recordWalletPurchase).not.toHaveBeenCalled();

    page.confirmWalletActivityPurchase({ target: { checked: true } } as unknown as Event);
    await page.saveWalletActivity(new Event('submit'));
    expect(consumerWalletService.recordWalletPurchase).toHaveBeenCalledOnce();
    expect(consumerWalletService.recordWalletPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ confirmationKey: 'synthetic-purchase-approval' }),
    );
    fixture.destroy();
  });

  it('creates FASTag from Wallets with the existing PaymentSource identity shape', async () => {
    const { fixture, consumerWalletService } = setup();
    const page = fixture.componentInstance;
    page.openFastag();
    page.fastagForm.setValue({
      name: 'Synthetic vehicle',
      provider: 'Fictional toll provider',
      plate: 'FICT001',
      fastagId: '00019000098765432',
      confirmDuplicateVehicle: false,
    });
    fixture.detectChanges();
    await page.saveFastag(new Event('submit'));
    expect(consumerWalletService.saveFastagWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Synthetic vehicle',
        kind: 'FASTAG',
        vehicleNumber: 'FICT001',
        fastagId: '00019000098765432',
        balanceMinor: 0,
      }),
      undefined,
      false,
    );
    expect(page.fastagOpen()).toBe(false);
    fixture.destroy();
  });
  it('keeps FASTAG pass crossings independent from wallet balance and retains balance when tracking is disabled', async () => {
    const source: PaymentSource = {
      id: 'fastag-pass-source',
      nickname: 'Synthetic FASTag',
      kind: 'FASTAG',
      vehicleNumber: 'KA05MN4826',
      fastagId: '000123456789',
      noLimit: false,
      balanceMinor: 84500,
      autoLoad: false,
      archived: false,
    };
    const { fixture, paymentSources, consumerWalletService } = setup(true, null, {}, [source]);
    const page = fixture.componentInstance;
    page.openFastagPass(source);
    page.fastagPassForm.patchValue({ usedCrossings: '10' });
    await page.saveFastagPass(new Event('submit'));
    const savedSource = paymentSources().find((item) => item.id === source.id)!;
    expect(savedSource.fastagPasses?.[0]).toMatchObject({
      amountMinor: 307500,
      totalCrossings: 200,
      usedCrossings: 10,
    });
    expect(consumerWalletService.events()).toEqual([]);
    const pass = savedSource.fastagPasses![0];
    await page.recordFastagCrossing(savedSource, pass);
    expect(
      paymentSources().find((item) => item.id === source.id)?.fastagPasses?.[0].usedCrossings,
    ).toBe(11);
    expect(consumerWalletService.events()).toEqual([]);
    await page.toggleFastagBalance(paymentSources().find((item) => item.id === source.id)!);
    expect(paymentSources().find((item) => item.id === source.id)).toMatchObject({
      noLimit: true,
      balanceMinor: 84500,
    });
    fixture.destroy();
  });
  it('marks a future FASTAG pass Scheduled and blocks crossings before its start date', async () => {
    const source: PaymentSource = {
      id: 'fastag-scheduled-pass-source',
      nickname: 'Synthetic FASTag',
      kind: 'FASTAG',
      vehicleNumber: 'FICT001',
      noLimit: false,
      balanceMinor: 0,
      autoLoad: false,
      archived: false,
    };
    const pass: FastagPass = {
      id: 'scheduled-pass',
      name: 'Synthetic upcoming pass',
      amountMinor: 307500,
      startDate: '2999-01-01',
      endDate: '2999-12-31',
      totalCrossings: 200,
      usedCrossings: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const { fixture, store, paymentSources } = setup(true, null, {}, [source]);
    const page = fixture.componentInstance;
    expect(page.fastagPassStatus(pass)).toBe('SCHEDULED');
    expect(page.fastagPassStatusLabel(pass)).toBe('Scheduled');
    expect(page.fastagPassValidity(pass)).toMatch(/^Scheduled · starts in \d+ days$/);
    await page.recordFastagCrossing(source, pass);
    expect(store.updatePaymentSource).not.toHaveBeenCalled();
    expect(paymentSources()[0]).toEqual(source);
    fixture.destroy();
  });

  it('requires an Other name and registers only after a valid consumer-wallet form is saved', async () => {
    const { fixture, consumerWalletService, snackbar } = setup();
    const page = fixture.componentInstance;
    page.openConsumerWallet();
    page.consumerForm.patchValue({ providerId: 'other', customName: '', nickname: 'Rewards' });
    await page.saveConsumerWallet(new Event('submit'));
    expect(consumerWalletService.registerWallet).not.toHaveBeenCalled();
    expect(page.error()).toBe('Enter a custom wallet name.');

    page.consumerForm.controls.customName.setValue('Synthetic Rewards');
    page.consumerForm.controls.openingBalance.setValue('1.234');
    await page.saveConsumerWallet(new Event('submit'));
    expect(consumerWalletService.registerWallet).not.toHaveBeenCalled();
    expect(page.consumerForm.controls.openingBalance.invalid).toBe(true);
    page.consumerForm.controls.openingBalance.setValue('12.34');
    await page.saveConsumerWallet(new Event('submit'));
    expect(consumerWalletService.registerWallet).toHaveBeenCalledWith({
      providerId: 'other',
      customName: 'Synthetic Rewards',
      nickname: 'Rewards',
      openingBalanceMinor: 1234,
      setupIntentId: undefined,
    });
    expect(page.consumerOpen()).toBe(false);
    expect(snackbar.show).toHaveBeenCalledWith('Wallet registered.');
    fixture.destroy();
  });

  it('opens the Settings-launched registration form while activation remains off', () => {
    const intent = { id: 'synthetic-setup', kind: 'CONSUMER' as const, createdAt: timestamp };
    const { fixture } = setup(false, intent);
    const page = fixture.componentInstance;
    page.openConsumerWallet();
    fixture.detectChanges();
    expect(page.wallets.enabled()).toBe(false);
    expect(page.consumerOpen()).toBe(true);
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).not.toBeNull();
    fixture.destroy();
  });

  it('cancels a first-time Settings Wallet setup without enabling and returns to Settings', async () => {
    const intent = {
      id: 'synthetic-consumer-cancel',
      kind: 'CONSUMER' as const,
      createdAt: timestamp,
    };
    const { fixture, consumerWalletService } = setup(false, intent, { setup: intent.id });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const page = fixture.componentInstance;
    page.openConsumerWallet();
    await page.closeConsumerWallet();
    expect(consumerWalletService.cancelSetup).toHaveBeenCalledWith(intent.id);
    expect(consumerWalletService.registerWallet).not.toHaveBeenCalled();
    expect(consumerWalletService.enabled()).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/settings'], { replaceUrl: true });
    expect(page.consumerOpen()).toBe(false);
    fixture.destroy();
  });

  it('completes first-time Settings Wallet setup once and activates only after registration', async () => {
    const intent: WalletSetupIntent = {
      id: 'fresh-consumer-setup',
      kind: 'CONSUMER',
      createdAt: timestamp,
    };
    const { fixture, consumerWalletService } = setup(false, intent, { setup: intent.id });
    const page = fixture.componentInstance;
    page.openConsumerWallet();
    page.consumerForm.patchValue({
      providerId: 'other',
      customName: 'Synthetic gift wallet',
      nickname: 'Rewards',
      openingBalance: '12.50',
    });
    await page.saveConsumerWallet(new Event('submit'));
    expect(consumerWalletService.registerWallet).toHaveBeenCalledWith({
      providerId: 'other',
      customName: 'Synthetic gift wallet',
      nickname: 'Rewards',
      openingBalanceMinor: 1250,
      setupIntentId: intent.id,
    });
    expect(consumerWalletService.enabled()).toBe(true);
    expect(consumerWalletService.setupIntent()).toBeNull();
    expect(page.consumerOpen()).toBe(false);
    fixture.destroy();
  });

  it('cancels first-time Wallet setup, remains disabled, and returns to Settings', async () => {
    const intent: WalletSetupIntent = {
      id: 'cancel-consumer-setup',
      kind: 'CONSUMER',
      createdAt: timestamp,
    };
    const { fixture, consumerWalletService } = setup(false, intent, { setup: intent.id });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const page = fixture.componentInstance;
    page.openConsumerWallet();
    await page.closeConsumerWallet();
    expect(consumerWalletService.cancelSetup).toHaveBeenCalledWith(intent.id);
    expect(consumerWalletService.enabled()).toBe(false);
    expect(consumerWalletService.registerWallet).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/settings'], { replaceUrl: true });
    expect(page.consumerOpen()).toBe(false);
    fixture.destroy();
  });

  it('requires confirmation before archiving a consumer wallet', () => {
    const { fixture, consumerWalletService } = setup();
    const wallet: ConsumerWallet = {
      id: 'archive-confirmation-wallet',
      providerId: 'amazon-pay',
      kind: 'STANDARD',
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    consumerWalletService.wallets.set([wallet]);
    fixture.detectChanges();
    const archive = [...fixture.nativeElement.querySelectorAll('.wallet-actions button')].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Archive',
    ) as HTMLButtonElement;
    archive.click();
    fixture.detectChanges();
    expect(consumerWalletService.archiveWallet).not.toHaveBeenCalled();
    const cancel = [
      ...fixture.nativeElement.querySelectorAll('app-confirmation-dialog button'),
    ].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    cancel.click();
    fixture.detectChanges();
    expect(consumerWalletService.archiveWallet).not.toHaveBeenCalled();

    archive.click();
    fixture.detectChanges();
    const confirm = fixture.nativeElement.querySelector(
      'app-confirmation-dialog .danger-confirm',
    ) as HTMLButtonElement;
    confirm.click();
    fixture.detectChanges();
    expect(consumerWalletService.archiveWallet).toHaveBeenCalledOnce();
    fixture.destroy();
  });

  it('requires confirmation before restoring a FASTag wallet', async () => {
    const source: PaymentSource = {
      id: 'restore-fastag-confirmation',
      nickname: 'Synthetic archived FASTag',
      kind: 'FASTAG',
      vehicleNumber: 'FICT009',
      noLimit: false,
      balanceMinor: 12345,
      autoLoad: false,
      archived: true,
    };
    const { fixture, paymentSources, store, consumerWalletService } = setup(true, null, {}, [
      source,
    ]);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    const restore = [...fixture.nativeElement.querySelectorAll('.wallet-actions button')].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Restore',
    ) as HTMLButtonElement;
    restore.click();
    fixture.detectChanges();
    expect(store.updatePaymentSource).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Restore Synthetic archived FASTag?');
    const cancel = [
      ...fixture.nativeElement.querySelectorAll('app-confirmation-dialog button'),
    ].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    cancel.click();
    fixture.detectChanges();
    expect(store.updatePaymentSource).not.toHaveBeenCalled();
    expect(paymentSources()[0].archived).toBe(true);

    page.requestFastagRestore(source);
    await page.confirmPendingAction();
    expect(store.updatePaymentSource).toHaveBeenCalledWith({ ...source, archived: false });
    expect(consumerWalletService.refreshWalletRecords).toHaveBeenCalledOnce();
    expect(paymentSources()[0].archived).toBe(false);
    fixture.destroy();
  });

  it('keeps disabled consumer wallet history readable but hides mutation controls', () => {
    const { fixture, consumerWalletService } = setup(false);
    const wallet: ConsumerWallet = {
      id: 'disabled-history-wallet',
      providerId: 'amazon-pay',
      kind: 'STANDARD',
      nickname: 'Read-only rewards',
      archived: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    consumerWalletService.wallets.set([wallet]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Read-only rewards');
    expect(fixture.nativeElement.querySelector('.archived-wallets')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Register wallet');
    expect(fixture.nativeElement.querySelector('.wallet-actions button')?.textContent).toContain(
      'History',
    );
    expect(
      Array.from(fixture.nativeElement.querySelectorAll('.wallet-actions button')).map((button) =>
        (button as HTMLButtonElement).textContent?.trim(),
      ),
    ).toEqual(['History']);
    fixture.destroy();
  });

  it('shows a retryable error instead of presenting failed wallet loading as empty data', async () => {
    const { fixture, consumerWalletService } = setup();
    consumerWalletService.loadError.set(
      'Wallet data could not be loaded. Existing data was preserved.',
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Existing data was preserved',
    );
    const retry = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.includes('Retry wallet loading'),
    ) as HTMLButtonElement;
    retry.click();
    await fixture.whenStable();
    expect(consumerWalletService.initialise).toHaveBeenCalledOnce();
    expect(consumerWalletService.loadError()).toBeNull();
    fixture.destroy();
  });

  it('locates and highlights the selected transaction across active and archived FASTag records', () => {
    const sources: PaymentSource[] = [
      {
        id: 'active-fastag-a',
        kind: 'FASTAG',
        nickname: 'Active vehicle A',
        vehicleNumber: 'FICT001',
        noLimit: false,
        balanceMinor: 12000,
        autoLoad: false,
        archived: false,
      },
      {
        id: 'archived-fastag-b',
        kind: 'FASTAG',
        nickname: 'Archived vehicle B',
        vehicleNumber: 'FICT002',
        noLimit: false,
        balanceMinor: 3400,
        autoLoad: false,
        archived: true,
      },
      {
        id: 'active-fastag-c',
        kind: 'FASTAG',
        nickname: 'Active vehicle C',
        vehicleNumber: 'FICT003',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
      {
        id: 'archived-fastag-d',
        kind: 'FASTAG',
        nickname: 'Archived vehicle D',
        vehicleNumber: 'FICT004',
        noLimit: true,
        autoLoad: false,
        archived: true,
      },
    ];
    const toll: CardTransaction = {
      id: 'archived-toll-preserved-transaction',
      cardId: 'archived-fastag-b',
      type: 'PURCHASE',
      amountMinor: 3400,
      currencyCode: 'INR',
      transactionDate: '2025-11-01',
      merchant: 'Synthetic toll plaza',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: '2025-11-01T10:00:00Z',
      updatedAt: '2025-11-01T10:00:00Z',
    };
    const { fixture } = setup(true, null, { source: toll.cardId, transaction: toll.id }, sources, [
      toll,
    ]);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    expect(page.fastagWallets().map((source) => source.id)).toEqual([
      'active-fastag-a',
      'active-fastag-c',
      'archived-fastag-b',
      'archived-fastag-d',
    ]);
    expect(page.focusedFastagSourceId()).toBe(toll.cardId);
    expect(page.focusedFastagTransaction()).toEqual(toll);
    const record = fixture.nativeElement.querySelector(`#fastag-${toll.cardId}`) as HTMLElement;
    expect(record.classList.contains('focused')).toBe(true);
    expect(record.getAttribute('data-source-id')).toBe(toll.cardId);
    expect(record.querySelector('[data-transaction-id]')?.getAttribute('data-transaction-id')).toBe(
      toll.id,
    );
    expect(record.textContent).toContain('Synthetic toll plaza');
    const historyLink = (Array.from(record.querySelectorAll('a')) as HTMLAnchorElement[]).find(
      (link) => link.textContent?.includes('View activity'),
    );
    expect(historyLink).toBeDefined();
    expect(historyLink?.getAttribute('href')).toContain(toll.cardId);
    expect(historyLink?.getAttribute('href')).toContain(toll.id);
    expect(record.querySelector('a[href*="add=true"]')).toBeNull();
    fixture.destroy();
  });
});
