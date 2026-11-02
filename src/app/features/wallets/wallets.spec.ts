import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import {
  ConsumerWallet,
  ConsumerWalletEvent,
  ConsumerWalletEventAllocation,
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

function setup(enabled = true, setupIntent: WalletSetupIntent | null = null) {
  const savedWallets = signal<readonly ConsumerWallet[]>([]);
  const savedEvents = signal<readonly ConsumerWalletEvent[]>([]);
  const featureEnabled = signal(enabled);
  const intent = signal(setupIntent);
  const activeWallets = computed(() => savedWallets().filter((wallet) => !wallet.archived));
  const archivedWallets = computed(() => savedWallets().filter((wallet) => wallet.archived));
  const balances = computed(() => new Map<string, number>());
  const consumerWalletService = {
    wallets: savedWallets,
    events: savedEvents,
    allocations: signal<readonly ConsumerWalletEventAllocation[]>([]),
    enabled: featureEnabled,
    setupIntent: intent,
    activeWallets,
    archivedWallets,
    activeWalletLimit: 15,
    balances,
    archiveWallet: vi.fn(async (id: string) => {
      savedWallets.update((items) =>
        items.map((wallet) => (wallet.id === id ? { ...wallet, archived: true } : wallet)),
      );
    }),
    restoreWallet: vi.fn(async () => undefined),
    deleteWalletIfEmpty: vi.fn(async () => undefined),
    saveFastagWallet: vi.fn(async () => undefined),
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
  };
  const paymentSources = signal<readonly PaymentSource[]>([]);
  const store = {
    paymentSources,
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
      { provide: ConsumerWalletService, useValue: consumerWalletService },
      { provide: CardNestStore, useValue: store },
      { provide: SnackbarService, useValue: snackbar },
    ],
  });
  const fixture = TestBed.createComponent(WalletsPage);
  fixture.detectChanges();
  return { fixture, consumerWalletService, paymentSources, snackbar };
}

describe('Wallets page Stage A', () => {
  it('creates FASTag from Wallets with the existing PaymentSource identity shape', async () => {
    const { fixture, consumerWalletService } = setup();
    const page = fixture.componentInstance;
    page.openFastag();
    page.fastagForm.setValue({
      name: 'Synthetic vehicle',
      provider: 'Fictional toll provider',
      plate: 'FICT001',
    });
    fixture.detectChanges();
    await page.saveFastag(new Event('submit'));
    expect(consumerWalletService.saveFastagWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Synthetic vehicle',
        kind: 'FASTAG',
        vehicleNumber: 'FICT001',
        balanceMinor: 0,
      }),
      undefined,
    );
    expect(page.fastagOpen()).toBe(false);
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
    await page.saveConsumerWallet(new Event('submit'));
    expect(consumerWalletService.registerWallet).toHaveBeenCalledWith({
      providerId: 'other',
      customName: 'Synthetic Rewards',
      nickname: 'Rewards',
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
});
