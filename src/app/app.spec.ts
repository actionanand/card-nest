import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { App } from './app';
import { SqliteDatabase } from './core/data/sqlite-database';
import { CardNestStore } from './core/services/card-nest-store';
import { AppLockService } from './core/services/app-lock.service';
import { NotificationService } from './core/services/notification.service';
import { SnackbarService } from './core/services/snackbar.service';
import { UiPreferencesService } from './core/services/ui-preferences.service';
import { UtilitiesService } from './features/utilities/utilities.service';
import { CardTransaction, CreditCard, PaymentSource } from './core/models/domain';

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
  const snackbarMessage = signal<null>(null);
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
    cards,
    transactions,
    paymentSources: sources,
    activeCards: cards,
    alphabeticalActiveCards: cards,
    activePaymentSources: sources,
    flashTransactionSourceId: signal('preferred-source'),
    cardDueAmount: vi.fn(() => 0),
    materializeRecurringTransactions: vi.fn(),
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
          useValue: { message: snackbarMessage, show: vi.fn(), dismiss: vi.fn() },
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

  it('should render the product brand', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.brand')?.textContent).toContain('CardNest');
  });

  it('renders only the selected native shortcut and preserves Quick Transaction defaults', async () => {
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
    fixture.componentInstance.saveFlashTransaction(new Event('submit'));
    fixture.componentInstance.saveFlashTransaction(new Event('submit'));
    expect(store.addTransaction).toHaveBeenCalledOnce();
    expect(transactions()[0]).toMatchObject({
      cardId: 'preferred-source',
      type: 'PURCHASE',
      amountMinor: 1234,
    });
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
    expect(transactions()).toEqual([]);
    expect(fixture.nativeElement.textContent).toContain('SMS Sync destination');
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
});
