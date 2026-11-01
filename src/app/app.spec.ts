import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { App } from './app';
import { SqliteDatabase } from './core/data/sqlite-database';
import { CardNestStore } from './core/services/card-nest-store';
import { AppLockService } from './core/services/app-lock.service';
import { NotificationService } from './core/services/notification.service';
import { SnackbarMessage, SnackbarService } from './core/services/snackbar.service';
import { UiPreferencesService } from './core/services/ui-preferences.service';
import { UtilitiesService } from './features/utilities/utilities.service';
import { CardTransaction, CreditCard, PaymentSource } from './core/models/domain';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommittedSaveRefreshError } from './core/services/committed-save-refresh-error';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function contrastRatio(first: string, second: string): number {
  const luminance = (colour: string) => {
    const channels = colour.match(/[\da-f]{2}/gi)!.map((part) => parseInt(part, 16) / 255);
    const linear = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function themeHex(theme: string, name: string): string {
  const value = theme.match(new RegExp(`--${name}:\\s*(#[\\da-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`Missing ${name} theme colour`);
  return value;
}

@Component({ template: '<p>SMS Sync destination</p>' })
class SmsSyncDestination {}

const flashCard: CreditCard = {
  id: 'flash-card',
  nickname: 'Synthetic card',
  issuerName: 'Fictional Bank',
  lastDigits: '4321',
  network: 'VISA',
  theme: 'green',
  statementDay: 1,
  dueDateMode: 'DAYS_AFTER_STATEMENT',
  daysAfterStatement: 20,
  adjustDueDateOnWeekend: false,
  currencyCode: 'INR',
  openingBalanceMinor: 0,
  remindToSettle: false,
  annualFeeEnabled: false,
  emergencyPhones: [],
  supportEmails: [],
  archived: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

describe('App', () => {
  const cards = signal<readonly CreditCard[]>([]);
  const sources = signal<readonly PaymentSource[]>([]);
  const transactions = signal<readonly CardTransaction[]>([]);
  const ready = signal(false);
  const locked = signal(false);
  const foreground = signal(true);
  const snackbarMessage = signal<SnackbarMessage | null>(null);
  const snackbarShow = vi.fn();
  const source = (): PaymentSource => ({
    id: 'preferred-source',
    nickname: 'Synthetic bank',
    institution: 'Fictional Bank',
    kind: 'DEBIT',
    lastDigits: '123',
    noLimit: true,
    autoLoad: false,
    archived: false,
  });
  const store = {
    initialisationWarning: signal(''),
    cards,
    bankCashTracking: signal({ enabled: false }),
    transactions,
    paymentSources: sources,
    activeCards: cards,
    alphabeticalActiveCards: cards,
    activePaymentSources: sources,
    flashTransactionSourceId: signal('preferred-source'),
    cardDueAmount: vi.fn(() => 0),
    materializeRecurringTransactions: vi.fn(),
    saveManualTransaction: vi.fn(async (transaction: CardTransaction) => {
      transactions.update((items) => [transaction, ...items]);
    }),
    addTransaction: vi.fn((transaction: CardTransaction) =>
      transactions.update((items) => [transaction, ...items]),
    ),
  };
  const lock = {
    locked,
    foreground,
    biometricEnabled: signal(false),
    biometricAvailable: signal(false),
    biometricAutoAttemptAvailable: signal(false),
    biometricInProgress: signal(false),
    biometricError: signal<string | null>(null),
    unlock: vi.fn().mockResolvedValue(false),
    authenticateWithBiometrics: vi.fn().mockResolvedValue(false),
  };
  beforeEach(async () => {
    localStorage.clear();
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    cards.set([]);
    sources.set([source()]);
    transactions.set([]);
    ready.set(false);
    locked.set(false);
    foreground.set(true);
    snackbarMessage.set(null);
    snackbarShow.mockClear();
    store.initialisationWarning.set('');
    store.saveManualTransaction.mockReset();
    store.saveManualTransaction.mockImplementation(async (transaction) => {
      transactions.update((items) => [transaction, ...items]);
    });
    store.addTransaction.mockClear();
    store.materializeRecurringTransactions.mockClear();
    store.cardDueAmount.mockClear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([
          {
            path: 'sms-sync',
            data: { floatingShortcut: 'SMS_SYNC' },
            component: SmsSyncDestination,
          },
        ]),
        { provide: UiPreferencesService, useFactory: () => new UiPreferencesService() },
        { provide: SqliteDatabase, useValue: { ready, unavailableReason: signal(null) } },
        { provide: CardNestStore, useValue: store },
        { provide: AppLockService, useValue: lock },
        {
          provide: NotificationService,
          useValue: {
            setUtilityReminders: vi.fn(),
            reschedule: vi.fn().mockResolvedValue(undefined),
            shouldRequestNotificationPermission: vi.fn().mockResolvedValue(false),
            refreshPermission: vi.fn().mockResolvedValue(true),
          },
        },
        {
          provide: SnackbarService,
          useValue: { message: snackbarMessage, show: snackbarShow, dismiss: vi.fn() },
        },
        {
          provide: UtilitiesService,
          useValue: { showIndianUtilities: signal(true), reminderTargets: () => [] },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });
  it('completes rendering with a startup history warning and does not immediately retry financial generation', async () => {
    store.initialisationWarning.set(
      'EMI history could not be fully loaded: Synthetic EMI failure. Recurring generation failed: Synthetic schedule failure.',
    );
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance).toBeTruthy();
    expect(snackbarShow).toHaveBeenCalledWith(store.initialisationWarning(), 'WARNING');
    expect(store.materializeRecurringTransactions).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('closes a durably saved Quick Transaction on refresh failure and prevents another submission', async () => {
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const app = fixture.componentInstance;
    app.openFlashTransaction();
    app.flashAmount.set('12.34');
    store.saveManualTransaction.mockImplementationOnce(async (transaction) => {
      transactions.set([transaction]);
      throw new CommittedSaveRefreshError(transaction.id, new Error('Refresh failed'));
    });
    await app.saveFlashTransaction(new Event('submit'));
    await app.saveFlashTransaction(new Event('submit'));
    expect(store.saveManualTransaction).toHaveBeenCalledTimes(1);
    expect(app.flashTransactionOpen()).toBe(false);
    expect(app.flashError()).toBeNull();
    expect(snackbarShow).toHaveBeenCalledWith(
      expect.stringContaining('Transaction saved'),
      'WARNING',
    );
    expect(transactions()).toHaveLength(1);
    fixture.destroy();
  });
  it('labels and saves a non-INR credit-card purchase in its own currency without conversion', async () => {
    ready.set(true);
    cards.set([{ ...flashCard, currencyCode: 'USD' }]);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const app = fixture.componentInstance;
    app.openFlashTransaction();
    app.updateFlashSource(flashCard.id);
    app.flashAmount.set('12.34');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Amount (USD)');
    await app.saveFlashTransaction(new Event('submit'));
    expect(store.saveManualTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ currencyCode: 'USD', amountMinor: 1234 }),
    );
    fixture.destroy();
  });
  it('clears text-entry suppression when a focused shadow control is removed during navigation', async () => {
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    root.append(input);
    document.body.append(host);
    input.focus();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.floatingShortcutVisible()).toBe(false);
    host.remove();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.floatingShortcutVisible()).toBe(true);
    fixture.destroy();
  });

  it('should render the product brand', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.brand')?.textContent).toContain('CardNest');
  });

  it('waits for durable Quick Transaction persistence before closing or showing success', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutEnabled(true);
    preferences.setFloatingShortcutMode('QUICK_TRANSACTION');
    ready.set(true);
    cards.set([flashCard]);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.floating-shortcut-fab')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.flash-transaction-fab')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.sms-sync-fab')).toBeNull();
    expect(fixture.nativeElement.querySelector('.bottom-nav .add-action')).not.toBeNull();

    (fixture.nativeElement.querySelector('.flash-transaction-fab') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.flashTransactionOpen()).toBe(true);
    expect(fixture.componentInstance.flashSourceId()).toBe('preferred-source');
    expect(fixture.nativeElement.querySelector('.floating-shortcut-fab')).toBeNull();

    fixture.componentInstance.flashAmount.set('12.34');
    fixture.componentInstance.flashMerchant.set('Synthetic shop');
    const persistence = deferred<void>();
    store.saveManualTransaction.mockImplementationOnce(async (transaction) => {
      await persistence.promise;
      transactions.update((items) => [transaction, ...items]);
    });
    const saving = fixture.componentInstance.saveFlashTransaction(new Event('submit'));
    fixture.detectChanges();
    expect(store.saveManualTransaction).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.savingFlashTransaction()).toBe(true);
    expect(fixture.componentInstance.flashTransactionOpen()).toBe(true);
    expect(snackbarShow).not.toHaveBeenCalled();
    expect(
      (
        fixture.nativeElement.querySelector(
          '.flash-dialog button[type="submit"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fixture.componentInstance.closeFlashTransaction();
    expect(fixture.componentInstance.flashTransactionOpen()).toBe(true);
    expect(store.saveManualTransaction.mock.calls[0][0]).toMatchObject({
      cardId: 'preferred-source',
      type: 'PURCHASE',
      amountMinor: 1234,
      merchant: 'Synthetic shop',
    });
    persistence.resolve();
    await saving;
    expect(transactions()).toHaveLength(1);
    expect(fixture.componentInstance.flashTransactionOpen()).toBe(false);
    expect(fixture.componentInstance.savingFlashTransaction()).toBe(false);
    expect(snackbarShow).toHaveBeenCalledOnce();
    expect(snackbarShow).toHaveBeenCalledWith('Flash transaction added.');
    expect(store.addTransaction).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('requires an explicit Quick Transaction bank choice when multiple banks are active', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutEnabled(true);
    preferences.setFloatingShortcutMode('QUICK_TRANSACTION');
    ready.set(true);
    sources.set([
      source(),
      { ...source(), id: 'second-bank', nickname: 'Second bank', lastDigits: '456' },
    ]);
    store.flashTransactionSourceId.set('archived-or-removed');
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance.openFlashTransaction();
    expect(fixture.componentInstance.flashSourceId()).toBe('');
    fixture.componentInstance.closeFlashTransaction();

    store.flashTransactionSourceId.set('second-bank');
    fixture.componentInstance.openFlashTransaction();
    expect(fixture.componentInstance.flashSourceId()).toBe('second-bank');
    fixture.destroy();
  });

  it('keeps form data after save failure and retries with the same transaction ID', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutEnabled(true);
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.openFlashTransaction();
    fixture.componentInstance.flashSourceId.set('preferred-source');
    fixture.componentInstance.flashAmount.set('48.75');
    fixture.componentInstance.flashMerchant.set('Synthetic market');
    store.saveManualTransaction.mockRejectedValueOnce(new Error('synthetic SQLite failure'));

    await fixture.componentInstance.saveFlashTransaction(new Event('submit'));
    expect(fixture.componentInstance.flashTransactionOpen()).toBe(true);
    expect(fixture.componentInstance.flashSourceId()).toBe('preferred-source');
    expect(fixture.componentInstance.flashAmount()).toBe('48.75');
    expect(fixture.componentInstance.flashMerchant()).toBe('Synthetic market');
    expect(fixture.componentInstance.flashError()).toContain('Could not save');
    expect(fixture.componentInstance.savingFlashTransaction()).toBe(false);
    expect(transactions()).toEqual([]);
    expect(snackbarShow).not.toHaveBeenCalled();

    const failedId = store.saveManualTransaction.mock.calls[0][0].id;
    await fixture.componentInstance.saveFlashTransaction(new Event('submit'));
    expect(store.saveManualTransaction).toHaveBeenCalledTimes(2);
    expect(store.saveManualTransaction.mock.calls[1][0].id).toBe(failedId);
    expect(transactions()).toHaveLength(1);
    expect(fixture.componentInstance.flashTransactionOpen()).toBe(false);
    expect(snackbarShow).toHaveBeenCalledOnce();
    fixture.destroy();
  });

  it('ignores repeated Quick Transaction submissions while persistence is pending', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutEnabled(true);
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.openFlashTransaction();
    fixture.componentInstance.flashAmount.set('9.99');
    const persistence = deferred<void>();
    store.saveManualTransaction.mockImplementationOnce(async (transaction) => {
      await persistence.promise;
      transactions.update((items) => [transaction, ...items]);
    });

    const first = fixture.componentInstance.saveFlashTransaction(new Event('submit'));
    const second = fixture.componentInstance.saveFlashTransaction(new Event('submit'));
    await second;
    expect(store.saveManualTransaction).toHaveBeenCalledOnce();
    persistence.resolve();
    await first;
    expect(transactions()).toHaveLength(1);
    expect(snackbarShow).toHaveBeenCalledOnce();
    fixture.destroy();
  });

  it('navigates from SMS Sync FAB without scanning or writing transactions', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutEnabled(true);
    preferences.setFloatingShortcutMode('SMS_SYNC');
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('.sms-sync-fab') as HTMLButtonElement;
    expect(fixture.nativeElement.querySelectorAll('.floating-shortcut-fab')).toHaveLength(1);
    expect(button.getAttribute('aria-label')).toBe('Open SMS Sync');
    expect(button.querySelectorAll('app-icon > svg[aria-hidden="true"]')).toHaveLength(2);

    button.click();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/sms-sync');
    expect(store.addTransaction).not.toHaveBeenCalled();
    expect(store.saveManualTransaction).not.toHaveBeenCalled();
    expect(transactions()).toEqual([]);
    expect(fixture.nativeElement.textContent).toContain('SMS Sync destination');
    fixture.destroy();
  });

  it('warns and permits retry when SMS Sync navigation resolves false', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutMode('SMS_SYNC');
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl');
    navigate.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await fixture.componentInstance.openSmsSyncFromShortcut();
    expect(fixture.componentInstance.smsShortcutNavigationPending()).toBe(false);
    expect(snackbarShow).toHaveBeenCalledWith(
      'SMS Sync could not be opened. Please try again.',
      'WARNING',
    );
    await fixture.componentInstance.openSmsSyncFromShortcut();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.smsShortcutNavigationPending()).toBe(false);
    fixture.destroy();
  });

  it('warns and resets pending state when SMS Sync navigation rejects', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutMode('SMS_SYNC');
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockRejectedValue(
      new Error('private navigation detail'),
    );

    await fixture.componentInstance.openSmsSyncFromShortcut();
    expect(fixture.componentInstance.smsShortcutNavigationPending()).toBe(false);
    expect(snackbarShow).toHaveBeenCalledWith(
      'SMS Sync could not be opened. Please try again.',
      'WARNING',
    );
    expect(JSON.stringify(snackbarShow.mock.calls)).not.toContain('private navigation detail');
    fixture.destroy();
  });

  it('warns safely when Android SMS Sync route metadata is unavailable', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutMode('SMS_SYNC');
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const router = TestBed.inject(Router);
    router.resetConfig([]);
    const navigate = vi.spyOn(router, 'navigateByUrl');

    await fixture.componentInstance.openSmsSyncFromShortcut();
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.componentInstance.smsShortcutNavigationPending()).toBe(false);
    expect(snackbarShow).toHaveBeenCalledWith(
      'SMS Sync could not be opened. Please try again.',
      'WARNING',
    );
    fixture.destroy();
  });

  it('prevents duplicate SMS Sync navigation and allows no-op when already at the route', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutMode('SMS_SYNC');
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const router = TestBed.inject(Router);
    const navigation = deferred<boolean>();
    const navigate = vi.spyOn(router, 'navigateByUrl').mockReturnValue(navigation.promise);
    const first = fixture.componentInstance.openSmsSyncFromShortcut();
    const second = fixture.componentInstance.openSmsSyncFromShortcut();
    await second;
    expect(navigate).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.smsShortcutNavigationPending()).toBe(true);
    navigation.resolve(true);
    await first;
    expect(fixture.componentInstance.smsShortcutNavigationPending()).toBe(false);
    navigate.mockRestore();
    await router.navigateByUrl('/sms-sync');
    const alreadyThere = vi.spyOn(router, 'navigateByUrl');
    await fixture.componentInstance.openSmsSyncFromShortcut();
    expect(alreadyThere).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it.each([
    ['Android Chrome', false, 'web'],
    ['desktop web', false, 'web'],
    ['mobile web', false, 'web'],
    ['iOS native', true, 'ios'],
  ] as const)('does not render a FAB on %s', async (_label, native, platform) => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(native);
    vi.mocked(Capacitor.getPlatform).mockReturnValue(platform);
    const preferences = TestBed.inject(UiPreferencesService);
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.floating-shortcut-fab')).toBeNull();
    expect(preferences.setFloatingShortcutEnabled(true)).toBe(false);
    fixture.destroy();
  });

  it('hides the native FAB when disabled, locked, unready, or covered by a dialog', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutEnabled(true);
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.floating-shortcut-fab')).not.toBeNull();
    preferences.setFloatingShortcutEnabled(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.floating-shortcut-fab')).toBeNull();
    preferences.setFloatingShortcutEnabled(true);
    locked.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.floating-shortcut-fab')).toBeNull();
    locked.set(false);
    ready.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.floating-shortcut-fab')).toBeNull();
    ready.set(true);
    fixture.componentInstance.showNotificationPermissionConfirmation.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.floating-shortcut-fab')).toBeNull();
    fixture.destroy();
  });

  it('keeps SMS Sync icon and badge contrast above 3:1 in both themes and preserves motion safeguards', () => {
    const appStyles = readFileSync(join(process.cwd(), 'src/app/app.scss'), 'utf8');
    const themeStyles = readFileSync(join(process.cwd(), 'src/styles.scss'), 'utf8');
    const lightTheme = themeStyles.match(/:root\s*\{([^}]+)\}/)?.[1] ?? '';
    const darkTheme = themeStyles.match(/@mixin dark-theme\s*\{([^}]+)\}/)?.[1] ?? '';
    const message = appStyles.match(/\.sms-sync-fab-message\s*\{([^}]+)\}/)?.[1] ?? '';
    const badge = appStyles.match(/\.sms-sync-fab-badge\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(message).toMatch(/color:\s*inherit/);
    expect(badge).toMatch(/border:\s*2px solid var\(--accent\)/);
    expect(badge).toMatch(/color:\s*var\(--accent\)/);
    expect(badge).toMatch(/background:\s*var\(--on-accent\)/);

    for (const theme of [lightTheme, darkTheme]) {
      const surface = themeHex(theme, 'on-accent');
      const accent = themeHex(theme, 'accent');
      expect(contrastRatio(surface, accent)).toBeGreaterThanOrEqual(3);
    }
    expect(appStyles).toMatch(/\.floating-shortcut-fab:focus-visible\s*\{[^}]*outline:/s);
    expect(appStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(appStyles).toMatch(
      /\.sms-sync-fab:active:not\(:disabled\) \.sms-sync-fab-badge\s*\{[^}]*animation:\s*none/,
    );
    expect(appStyles).toMatch(/\.sms-sync-fab:active:not\(:disabled\)[^{]*\{[^}]*animation:/s);
    expect(appStyles).not.toMatch(/\.sms-sync-fab\s*\{[^}]*animation:\s*[^;]*(?:infinite|spin)/s);
  });
  it('keeps exactly one enabled FAB mounted across themes, snackbar display and mode changes', async () => {
    const preferences = TestBed.inject(UiPreferencesService);
    preferences.setFloatingShortcutEnabled(true);
    ready.set(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    for (const theme of ['LIGHT', 'DARK', 'LIGHT']) {
      document.documentElement.dataset['theme'] = theme;
      snackbarMessage.set({ id: 1, text: 'Theme saved', tone: 'INFO' });
      for (const mode of ['QUICK_TRANSACTION', 'SMS_SYNC'] as const) {
        preferences.setFloatingShortcutMode(mode);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.nativeElement.querySelectorAll('.floating-shortcut-fab')).toHaveLength(1);
        expect(fixture.componentInstance.floatingShortcutVisible()).toBe(true);
      }
    }
    const modal = document.createElement('section');
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.floatingShortcutVisible()).toBe(false);
    modal.remove();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.floatingShortcutVisible()).toBe(true);
    expect(
      TestBed.runInInjectionContext(() => new UiPreferencesService()).floatingShortcutMode(),
    ).toBe('SMS_SYNC');
    fixture.destroy();
    delete document.documentElement.dataset['theme'];
  });
});
