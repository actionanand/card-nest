import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { SmsSyncPage } from './sms-sync';
import { SmsReviewService } from './sms-review.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { ScanStatus, SmsCandidate } from './sms-model';
import axe from 'axe-core';
import { Category, CreditCard, PaymentSource } from '../../core/models/domain';
import { Router } from '@angular/router';
import { By } from '@angular/platform-browser';
import { AppSelectPicker } from '../../shared/app-select-picker';
import { SnackbarService } from '../../core/services/snackbar.service';
import { defaultReviewFilters } from './sms-review-filters';
import { Capacitor } from '@capacitor/core';

const demoCard: CreditCard = {
  id: 'demo-card',
  nickname: 'Synthetic daily',
  issuerName: 'HDFC Bank',
  lastDigits: '4321',
  network: 'VISA',
  currencyCode: 'INR',
  theme: 'green',
  statementDay: 1,
  dueDateMode: 'DAYS_AFTER_STATEMENT',
  daysAfterStatement: 20,
  adjustDueDateOnWeekend: false,
  openingBalanceMinor: 0,
  remindToSettle: false,
  annualFeeEnabled: false,
  emergencyPhones: [],
  supportEmails: [],
  archived: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const demoCandidate = (): SmsCandidate => ({
  id: 'a'.repeat(64),
  state: 'PENDING',
  kind: 'PURCHASE',
  eventAt: '2026-10-18T12:00:00Z',
  item: {
    id: 'a'.repeat(64),
    providerId: 'demo',
    parserVersion: 3,
    kind: 'PURCHASE',
    amountMinor: 10000,
    currency: 'INR',
    eventDate: '2026-10-18',
    eventAt: '2026-10-18T12:00:00Z',
    receivedAt: 1,
    dateFallback: false,
    evidence: 'Synthetic',
    cardDigits: '4321',
  },
});

describe('SMS review privacy and explicit approval UI', () => {
  const locked = signal(false);
  const foreground = signal(true);
  const candidates = signal<readonly SmsCandidate[]>([]);
  const status = signal<ScanStatus | null>(null);
  const requestingPermission = signal(false);
  const changingSync = signal(false);
  const navigation = signal<{ extras: { info?: unknown; state?: Record<string, unknown> } } | null>(
    null,
  );
  const swipePreference = signal(false);
  const setDurableUiPreference = vi.fn().mockResolvedValue(undefined);
  const sync = {
    lock: { locked, foreground },
    candidates,
    status,
    requestingPermission,
    changingSync,
    syncEnabled: computed(() => status()?.permission === 'granted' && status()?.enabled === true),
    canScan: computed(
      () =>
        status()?.permission === 'granted' && status()?.enabled === true && !requestingPermission(),
    ),
    busy: signal(false),
    reconciling: signal(false),
    verificationFailed: signal(false),
    error: signal(''),
    duplicates: signal(0),
    total: signal(0),
    savedTotal: signal(0),
    pendingTotal: signal(0),
    matchedTotal: signal(0),
    importedTotal: signal(0),
    unreadTotal: signal(0),
    markingRead: signal(false),
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(401),
    notice: signal(''),
    reviewPage: signal(0),
    refresh: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn(),
    relatedFor: vi.fn().mockResolvedValue([]),
    enable: vi.fn(),
    refreshAccess: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn().mockResolvedValue(undefined),
    filterReview: vi.fn().mockResolvedValue(undefined),
    loadReviewFilters: vi.fn().mockImplementation(async () => defaultReviewFilters()),
    enterFromReview: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
    undoDismissal: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    scan: vi.fn().mockResolvedValue(undefined),
    turnPage: vi.fn().mockResolvedValue(undefined),
    approveBank: vi.fn().mockResolvedValue(undefined),
  };
  const bankCashTracking = signal({ enabled: false, askCardSettlementFunding: false });
  const paymentSources = signal<readonly PaymentSource[]>([]);
  const store = {
    cards: signal<readonly CreditCard[]>([]),
    paymentSources,
    categories: signal<readonly Category[]>([]),
    transactions: signal([]),
    loans: signal([]),
    emiInstallments: signal([]),
    smsSwipeActionsEnabled: swipePreference,
    setDurableUiPreference,
    sourceDetail: () => 'DEMO',
    bankCashTracking,
    bankAccounts: computed(() => paymentSources().filter((source) => source.kind === 'DEBIT')),
    activePaymentSources: computed(() => paymentSources()),
    alphabeticalActiveCards: signal([]),
    cardSettlementFundingAccounts: signal([]),
    transfers: signal([]),
    fundingFor: () => undefined,
    addBankAccount: vi.fn(),
  };
  it('shows a seven-second dismissal Undo and keeps visible row actions together', async () => {
    const candidate = demoCandidate();
    candidates.set([candidate]);
    const dismissal = {
      id: candidate.id,
      token: 'synthetic',
      at: 'synthetic',
      expires: Date.now() + 7000,
      previous: {},
    };
    sync.dismiss.mockResolvedValue(dismissal);
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    const show = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    fixture.componentInstance.swipeRead(candidate);
    await fixture.whenStable();
    await vi.waitFor(() => expect(show).toHaveBeenCalled());
    expect(sync.dismiss).toHaveBeenCalledWith(candidate.id);
    expect(show).toHaveBeenCalledWith(
      'SMS suggestion dismissed',
      'INFO',
      7000,
      expect.objectContaining({ label: 'Undo' }),
    );
    TestBed.inject(SnackbarService).runAction();
    await fixture.whenStable();
    expect(sync.undoDismissal).toHaveBeenCalledWith(dismissal);
    const buttons = fixture.nativeElement.querySelectorAll('.row-actions button');
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain('Review & add');
    expect(buttons[1].textContent).toContain('Mark read');
  });
  beforeEach(() => {
    locked.set(false);
    foreground.set(true);
    candidates.set([]);
    status.set(null);
    requestingPermission.set(false);
    changingSync.set(false);
    navigation.set(null);
    sync.busy.set(false);
    sync.reconciling.set(false);
    sync.verificationFailed.set(false);
    sync.total.set(0);
    sync.reviewPage.set(0);
    sync.unreadTotal.set(0);
    sync.markingRead.set(false);
    store.cards.set([]);
    store.paymentSources.set([]);
    store.categories.set([]);
    bankCashTracking.set({ enabled: false, askCardSettlementFunding: false });
    store.transactions.set([]);
    store.loans.set([]);
    store.emiInstallments.set([]);
    swipePreference.set(false);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    vi.clearAllMocks();
    sync.loadReviewFilters.mockImplementation(async () => defaultReviewFilters());
    TestBed.configureTestingModule({
      imports: [SmsSyncPage],
      providers: [
        { provide: Router, useValue: { currentNavigation: navigation } },
        { provide: SmsReviewService, useValue: sync },
        {
          provide: CardNestStore,
          useValue: store,
        },
      ],
    });
  });
  it('uses compact icon-labelled swipe actions and keeps explicit row buttons when swipe is off', async () => {
    candidates.set([demoCandidate()]);
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const candidate = fixture.nativeElement.querySelector('.candidate') as HTMLElement;
    expect(candidate.querySelectorAll('.row-actions button')).toHaveLength(2);
    expect(candidate.querySelector('.candidate-menu-trigger')).toBeNull();
  });
  it.each(['light', 'dark'])(
    'spaces swipe actions and announces finite review loading in %s mode',
    async (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const fixture = TestBed.createComponent(SmsSyncPage);
      fixture.detectChanges();
      await fixture.whenStable();
      sync.reconciling.set(true);
      fixture.detectChanges();
      const status = fixture.nativeElement.querySelector('.review-loading-status') as HTMLElement;
      const swipe = fixture.nativeElement.querySelector('.swipe-enable') as HTMLElement;
      expect(status.getAttribute('role')).toBe('status');
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.textContent).toContain('Loading review items…');
      expect(status.textContent).toContain('Checking saved transactions and SMS links…');
      expect(status.querySelector('.review-loading-spinner')?.getAttribute('aria-hidden')).toBe(
        'true',
      );
      expect(swipe.classList.contains('swipe-enable')).toBe(true);
      expect(swipe.contains(status)).toBe(false);
      const audit = await axe.run(status, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(audit.violations).toEqual([]);
      candidates.set([demoCandidate()]);
      sync.reconciling.set(false);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.review-loading-spinner')).toBeNull();
      expect(fixture.nativeElement.querySelector('.candidate')).not.toBeNull();
      document.documentElement.removeAttribute('data-theme');
    },
    30_000,
  );
  it('preselects a suffix-free Pluxee wallet and Dining, with an available-category fallback', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    const actualStore = TestBed.inject(CardNestStore);
    actualStore.paymentSources.set([
      {
        id: 'synthetic-meal',
        kind: 'MEAL',
        nickname: 'Synthetic meal',
        institution: 'Sodexo',
        noLimit: false,
        autoLoad: false,
        archived: false,
        balanceMinor: 10000,
      },
    ]);
    actualStore.categories.set([
      { id: 'dining', name: 'Dining', icon: 'restaurant', archived: false, appliesTo: 'BOTH' },
      { id: 'other', name: 'Other', icon: 'category', archived: false, appliesTo: 'BOTH' },
    ]);
    const original = demoCandidate();
    const candidate: SmsCandidate = {
      ...original,
      kind: 'PLUXEE_PURCHASE',
      item: { ...original.item!, kind: 'PLUXEE_PURCHASE', issuer: 'Pluxee', cardDigits: undefined },
    };
    fixture.componentInstance.open(candidate);
    expect(fixture.componentInstance.editor.controls.source.value).toBe('synthetic-meal');
    expect(fixture.componentInstance.editor.controls.category.value).toBe('dining');
    actualStore.categories.update((categories) =>
      categories.filter((category) => category.id !== 'dining'),
    );
    fixture.componentInstance.open(candidate);
    expect(fixture.componentInstance.editor.controls.category.value).toBe('other');
    fixture.componentInstance.open({
      ...candidate,
      kind: 'PLUXEE_TOPUP',
      item: { ...candidate.item!, kind: 'PLUXEE_TOPUP' },
    });
    expect(fixture.componentInstance.editor.controls.category.value).toBe('other');
    expect(sync.approve).not.toHaveBeenCalled();
    fixture.detectChanges();
    await fixture.whenStable();
  });
  it('compacts Android swipe cards into an accessible actions menu with semantic SVG swipe panels', async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android');
    swipePreference.set(true);
    const candidate = demoCandidate();
    candidates.set([candidate]);
    const fixture = TestBed.createComponent(SmsSyncPage);
    document.body.append(fixture.nativeElement);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('.candidate') as HTMLElement;
    expect(card.querySelector('.row-actions')).toBeNull();
    expect(card.querySelector('.candidate-menu-trigger')).not.toBeNull();
    expect(card.querySelector('.swipe-review-hint app-icon svg')).not.toBeNull();
    expect(card.querySelector('.swipe-read-hint app-icon svg')).not.toBeNull();
    expect(card.querySelector('.swipe-review-hint')?.textContent).toContain('Review');
    expect(card.querySelector('.swipe-read-hint')?.textContent).toContain('Dismiss');
    expect(card.textContent).not.toMatch(/[←→➜]/);
    const trigger = card.querySelector('.candidate-menu-trigger') as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = fixture.nativeElement.querySelector('[role=menu]') as HTMLElement;
    expect(card.contains(menu)).toBe(false);
    expect(menu.classList).toContain('candidate-menu-overlay');
    expect(fixture.nativeElement.querySelector('.review-panel')?.classList).toContain(
      'candidate-menu-open',
    );
    expect(menu.querySelectorAll('[role=menuitem]')).toHaveLength(2);
    expect(menu.textContent).toContain('Review & add');
    expect(menu.textContent).toContain('Mark read');
    expect(card.classList).toContain('candidate-menu-owner');
    trigger.click();
    fixture.detectChanges();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(fixture.nativeElement.querySelector('[role=menu]')).toBeNull();
    trigger.click();
    fixture.detectChanges();
    const reopenedMenu = fixture.nativeElement.querySelector('[role=menu]') as HTMLElement;
    (reopenedMenu.querySelector('[role=menuitem]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selected()?.id).toBe(candidate.id);
    expect(sync.approve).not.toHaveBeenCalled();
    fixture.componentInstance.closeEditor();
    fixture.detectChanges();
    trigger.click();
    fixture.detectChanges();
    fixture.componentInstance.escape();
    await fixture.whenStable();
    expect(fixture.componentInstance.candidateMenuId()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fixture.nativeElement.remove();
  });
  it('keeps matched cards reachable through the compact menu without offering enabled dismissal', async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android');
    swipePreference.set(true);
    const candidate = {
      ...demoCandidate(),
      state: 'MATCHED_EXISTING' as const,
      transactionId: 'tx',
    };
    candidates.set([candidate]);
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const card = fixture.nativeElement.querySelector('.candidate') as HTMLElement;
    expect(card.querySelector('.swipe-read-hint')?.classList).toContain('swipe-action-disabled');
    (card.querySelector('.candidate-menu-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
    const menu = fixture.nativeElement.querySelector('[role=menu]') as HTMLElement;
    expect(menu.textContent).toContain('View transaction');
    expect(menu.textContent).toContain('Review details');
    expect(menu.textContent).toContain('Mark read');
  });
  it('restores applied SQLite filters into the controls without saving them again or approving', async () => {
    sync.loadReviewFilters.mockResolvedValueOnce({
      state: 'DEFERRED',
      kind: 'REFUND',
      search: 'Synthetic shop',
      source: '54321',
      from: '2026-01-01',
      to: '2026-02-28',
      read: 'READ',
    });
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.search()).toBe('Synthetic shop');
    expect(fixture.componentInstance.sourceFilter()).toBe('54321');
    expect(fixture.componentInstance.kind()).toBe('REFUND');
    expect(fixture.componentInstance.state()).toBe('DEFERRED');
    expect(fixture.componentInstance.readFilter()).toBe('READ');
    expect(fixture.componentInstance.from()).toBe('2026-01-01');
    expect(fixture.componentInstance.to()).toBe('2026-02-28');
    expect(sync.filterReview).not.toHaveBeenCalled();
    expect(sync.approve).not.toHaveBeenCalled();
    fixture.componentInstance.search.set('Unapplied edit');
    expect(sync.filterReview).not.toHaveBeenCalled();
    fixture.componentInstance.applyFilters();
    await fixture.whenStable();
    expect(sync.filterReview).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'Unapplied edit' }),
    );
  });
  it('offers exactly two custom sort choices and changing order preserves active filters', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    expect(page.sortOrder()).toBe('RECEIVED_DESC');
    expect(page.sortOrderOptions.map((option) => option.value)).toEqual([
      'RECEIVED_DESC',
      'TRANSACTION_DESC',
    ]);
    expect(fixture.nativeElement.querySelector('select')).toBeNull();

    page.search.set('Synthetic merchant');
    page.sourceFilter.set('4321');
    page.state.set('DEFERRED');
    page.readFilter.set('READ');
    page.from.set('2026-10-01');
    page.to.set('2026-10-31');
    page.changeSortOrder('TRANSACTION_DESC');
    await fixture.whenStable();
    expect(sync.filterReview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        search: 'Synthetic merchant',
        source: '4321',
        state: 'DEFERRED',
        read: 'READ',
        from: '2026-10-01',
        to: '2026-10-31',
        sortOrder: 'TRANSACTION_DESC',
      }),
    );
  });
  it('distinguishes transaction time, SMS receipt time, receipt-date fallback, and paste processing time', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    const base = demoCandidate();

    const explicit = page.reviewTimestamp({
      ...base,
      item: {
        ...base.item!,
        eventDate: '2026-10-25',
        eventAt: '2026-10-25T16:55:00.000Z',
        eventTime: '22:25:00',
        eventTimeExplicit: true,
        dateFallback: false,
      },
    });
    expect(explicit).toMatchObject({
      primaryLabel: 'Transaction',
      primaryValue: 'Oct 25, 2026 · 10:25 PM',
    });
    expect(explicit).not.toHaveProperty('secondary');
    expect(explicit.primaryValue).not.toContain('12:00 AM');

    const dateOnlyCandidate = {
      ...base,
      item: {
        ...base.item!,
        eventDate: '2026-10-26',
        eventAt: '2026-10-26T00:00:00.000Z',
        eventTime: '00:00:00',
        eventTimeExplicit: false,
        receivedAt: Date.parse('2026-10-26T17:37:00.000Z'),
        dateFallback: false,
      },
    };
    const dateOnlySameDay = page.reviewTimestamp(dateOnlyCandidate);
    expect(dateOnlySameDay).toMatchObject({
      primaryLabel: 'Transaction date',
      primaryValue: 'Oct 26, 2026',
      secondary: 'SMS received: 11:07 PM',
    });
    candidates.set([dateOnlyCandidate]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.candidate-timestamp')?.textContent).toContain(
      'SMS received: 11:07 PM',
    );

    const dateOnlyNextDay = page.reviewTimestamp({
      ...base,
      item: {
        ...base.item!,
        eventDate: '2026-10-25',
        eventAt: '2026-10-25T00:00:00.000Z',
        eventTime: '00:00:00',
        eventTimeExplicit: false,
        receivedAt: Date.parse('2026-10-26T21:00:00.000Z'),
        dateFallback: false,
      },
    });
    expect(dateOnlyNextDay.primaryLabel).toBe('Transaction date');
    expect(dateOnlyNextDay.secondary).toContain('SMS received: Oct 27, 2026');
    expect(dateOnlyNextDay.secondary).toContain('2:30 AM');

    const invalidReceivedAt = page.reviewTimestamp({
      ...base,
      item: {
        ...base.item!,
        eventDate: '2026-10-26',
        eventAt: '2026-10-26T00:00:00.000Z',
        eventTime: '00:00:00',
        eventTimeExplicit: false,
        receivedAt: -1,
        dateFallback: false,
      },
    });
    expect(invalidReceivedAt.primaryLabel).toBe('Transaction date');
    expect(invalidReceivedAt.secondary).toBeUndefined();

    const receiptFallback = page.reviewTimestamp({
      ...base,
      item: {
        ...base.item!,
        eventDate: '2026-10-27',
        eventAt: '2026-10-26T21:00:00.000Z',
        eventTime: '02:30:00',
        eventTimeExplicit: false,
        receivedAt: Date.parse('2026-10-26T21:00:00.000Z'),
        dateFallback: true,
      },
    });
    expect(receiptFallback).toMatchObject({
      primaryLabel: 'Date and time',
      secondary: 'Based on SMS received date and time',
    });
    expect(receiptFallback.primaryValue).toContain('Oct 27, 2026');
    expect(receiptFallback.primaryValue).toContain('2:30 AM');

    const pastedFallback = page.reviewTimestamp({
      ...base,
      item: {
        ...base.item!,
        providerId: 'paste',
        eventDate: '2026-10-27',
        eventAt: '2026-10-26T21:00:00.000Z',
        eventTime: '02:30:00',
        eventTimeExplicit: false,
        receivedAt: Date.parse('2026-10-26T21:00:00.000Z'),
        dateFallback: true,
      },
    });
    expect(pastedFallback.secondary).toBe('Based on paste processing time');
    expect(pastedFallback.secondary).not.toContain('SMS received');
  });
  it('does not request permission or approve money when the page opens', () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    expect(sync.enable).not.toHaveBeenCalled();
    expect(sync.approve).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Nothing changes your transactions');
  });
  it('initializes Multiple once, preserves custom selections across mode changes, removes chips and saves them', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.kind.set('REFUND');
    page.changeTypeMode('MULTIPLE');
    expect(page.multipleKinds()).toEqual([
      'PURCHASE',
      'CASHBACK',
      'PLUXEE_PURCHASE',
      'PLUXEE_TOPUP',
      'BANK_DEBIT',
    ]);
    page.multipleKinds.set(['REFUND', 'CASHBACK']);
    page.changeTypeMode('SINGLE');
    expect(page.kind()).toBe('REFUND');
    page.changeTypeMode('MULTIPLE');
    expect(page.multipleKinds()).toEqual(['REFUND', 'CASHBACK']);
    page.removeFilter('type:REFUND');
    await fixture.whenStable();
    expect(sync.filterReview).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'MULTIPLE', kinds: ['CASHBACK'], multipleInitialized: true }),
    );
  });
  it('shows OR only between type chips, selected inbox semantics and an accessible bottom-sheet picker', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.changeTypeMode('MULTIPLE');
    page.multipleKinds.set(['PURCHASE', 'CASHBACK']);
    page.advanced.set(true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.type-chips .or-separator')).toHaveLength(1);
    expect(root.querySelector('.type-chips')?.textContent).not.toContain('(OR)');
    expect(root.querySelector('.inbox-tabs button[aria-pressed="true"]')?.textContent).toContain(
      'Needs review',
    );
    root.querySelector<HTMLButtonElement>('app-sms-type-picker > button')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(root.querySelector('app-sms-type-picker dialog[open]')?.textContent).toContain(
      'Select transaction types',
    );
    const picker = root.querySelector('app-sms-type-picker dialog')!;
    picker.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect(root.querySelector('app-sms-type-picker dialog')).toBeNull();
    expect(sync.approve).not.toHaveBeenCalled();
  });
  it('blocks a legacy deadline-only purchase and releases transient evidence on modal close', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const candidate = demoCandidate();
    candidate.item!.parserVersion = 1;
    candidate.item!.dueDate = candidate.item!.eventDate;
    fixture.componentInstance.open(candidate);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button[type="submit"]')).toBeNull();
    expect(fixture.componentInstance.matchReason(candidate)).toContain('Recheck the original SMS');
    fixture.componentInstance.closeEditor();
    expect(fixture.componentInstance.related()).toEqual([]);
    expect(fixture.componentInstance.selected()).toBeNull();
  });
  it('hides pending work and disables Scan for denied access even with legacy pending fields', () => {
    status.set({
      permission: 'denied',
      enabled: true,
      more: true,
      backgroundPending: true,
      cursorDate: 42,
      cursorId: 17,
      completedAt: 0,
      pages: 0,
      scanned: 0,
      found: 0,
      error: '',
      settingsRecommended: true,
    });
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Background catch-up is pending');
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons.find((b) => b.textContent?.includes('Resume scan'))?.disabled).toBe(true);
    buttons.find((b) => b.textContent?.includes('Open app settings'))?.click();
    expect(sync.openSettings).toHaveBeenCalledOnce();
  });
  it('disables repeated Enable taps while requesting and shows the actual request state', () => {
    requestingPermission.set(true);
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('[role=switch]') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(fixture.nativeElement.textContent).toContain(
      "Waiting for Android's SMS permission response.",
    );
  });
  it('only explicit transient SMS Review navigation invokes first-entry handling', async () => {
    navigation.set({ extras: { info: { smsReviewEntry: true } } });
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(sync.enterFromReview).toHaveBeenCalledExactlyOnceWith(30);
    foreground.set(false);
    fixture.detectChanges();
    foreground.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(sync.enterFromReview).toHaveBeenCalledOnce();
    expect(sync.approve).not.toHaveBeenCalled();
  });
  it('persisted browser state cannot replay a permission request on restart', async () => {
    navigation.set({ extras: { state: { smsReviewEntry: true } } });
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(sync.enterFromReview).not.toHaveBeenCalled();
    expect(sync.enable).not.toHaveBeenCalled();
  });
  const grantedStatus = (enabled: boolean): ScanStatus => ({
    permission: 'granted',
    enabled,
    cursorDate: 42,
    cursorId: 17,
    completedAt: 0,
    pages: 2,
    scanned: 200,
    found: 10,
    more: false,
    error: '',
  });
  it('keeps granted-but-disabled sync OFF and Scan disabled; denial cannot leave an optimistic ON switch', async () => {
    status.set(grantedStatus(false));
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('[role=switch]') as HTMLInputElement;
    expect(input.checked).toBe(false);
    const scan = [
      ...(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>),
    ].find((button) => button.textContent?.includes('Scan now'))!;
    expect(scan.disabled).toBe(true);
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(sync.enable).toHaveBeenCalledWith(30);
    expect(input.checked).toBe(false);
    status.set(grantedStatus(true));
    fixture.detectChanges();
    expect(input.checked).toBe(true);
    expect(scan.disabled).toBe(false);
    input.checked = false;
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(sync.disable).toHaveBeenCalledOnce();
    status.set(grantedStatus(false));
    fixture.detectChanges();
    expect(input.checked).toBe(false);
    expect(scan.disabled).toBe(true);
  });
  it('keeps Cancel functional and prevents a repeated Scan during discovery', async () => {
    status.set(grantedStatus(true));
    sync.busy.set(true);
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    const buttons = [
      ...(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>),
    ];
    expect(buttons.find((button) => button.textContent?.includes('Scanning…'))?.disabled).toBe(
      true,
    );
    buttons.find((button) => button.textContent?.includes('Cancel scan'))?.click();
    await fixture.whenStable();
    expect(sync.cancel).toHaveBeenCalledOnce();
    expect(sync.scan).not.toHaveBeenCalled();
  });
  it('shows balanced pagination only for multiple pages and respects both boundaries', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pagination')).toBeNull();
    sync.total.set(401);
    fixture.detectChanges();
    const previous = fixture.nativeElement.querySelector(
      '[aria-label="Previous page"]',
    ) as HTMLButtonElement;
    const next = fixture.nativeElement.querySelector(
      '[aria-label="Next page"]',
    ) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Page 1 of 3');
    next.click();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    expect(sync.turnPage).toHaveBeenCalledWith(1);
    sync.reviewPage.set(2);
    fixture.detectChanges();
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    previous.click();
    await fixture.whenStable();
    expect(sync.turnPage).toHaveBeenCalledWith(-1);
    sync.total.set(1);
    sync.reviewPage.set(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pagination')).toBeNull();
  });
  it('refreshes permission on settings return without requesting or enabling', () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    fixture.componentInstance.refreshAccess();
    expect(sync.refreshAccess).toHaveBeenCalledOnce();
    expect(sync.enable).not.toHaveBeenCalled();
  });
  it('removes all sensitive review content when locked or backgrounded', () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    fixture.componentInstance.text.setValue('Synthetic private pasted message');
    locked.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Unlock CardNest');
    expect(fixture.nativeElement.querySelector('textarea')).toBeNull();
    expect(fixture.componentInstance.text.value).toBe('');
  });
  it('keeps approval disabled until a source and valid amount are selected', () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    fixture.componentInstance.open({
      id: 'a'.repeat(64),
      state: 'PENDING',
      kind: 'PURCHASE',
      eventAt: '2026-10-18T12:00:00Z',
      item: {
        id: 'a'.repeat(64),
        providerId: '1',
        parserVersion: 3,
        kind: 'PURCHASE',
        amountMinor: 100,
        currency: 'INR',
        eventDate: '2026-10-18',
        eventAt: '2026-10-18T12:00:00Z',
        receivedAt: 1,
        dateFallback: false,
        evidence: 'Synthetic evidence',
      },
    });
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(sync.approve).not.toHaveBeenCalled();
  });
  it('opens a modal immediately and preselects one reliable card without approving', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    TestBed.inject(CardNestStore).cards.set([demoCard]);
    fixture.detectChanges();
    fixture.componentInstance.open(demoCandidate());
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('dialog[open]')).not.toBeNull();
    expect(fixture.componentInstance.editor.controls.source.value).toBe(demoCard.id);
    expect(fixture.nativeElement.textContent).toContain('Synthetic daily');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(sync.approve).not.toHaveBeenCalled();
    fixture.componentInstance.closeEditor();
    fixture.detectChanges();
    expect(document.body.style.overflow).not.toBe('hidden');
    expect(document.documentElement.style.overflow).not.toBe('hidden');
  });
  it('requires explicit source selection when same-suffix cards are ambiguous', () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    TestBed.inject(CardNestStore).cards.set([
      demoCard,
      { ...demoCard, id: 'second', nickname: 'Synthetic second' },
    ]);
    fixture.detectChanges();
    fixture.componentInstance.open(demoCandidate());
    fixture.detectChanges();
    expect(fixture.componentInstance.editor.controls.source.value).toBe('');
    expect(fixture.nativeElement.querySelector('dialog').textContent).toContain('Ambiguous');
    expect(
      (fixture.nativeElement.querySelector('button[type=submit]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it('returns focus to the triggering review button and consumes Android Back', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    candidates.set([demoCandidate()]);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    document.body.appendChild(element);
    const trigger = element.querySelector<HTMLButtonElement>('button[id^="review-"]')!;
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('sms-review-heading');
    const buttons = [
      ...element.querySelectorAll<HTMLButtonElement>('dialog button:not([disabled])'),
    ];
    for (const button of buttons)
      vi.spyOn(button, 'getClientRects').mockReturnValue([
        new DOMRect(0, 0, 44, 44),
      ] as unknown as DOMRectList);
    buttons.at(-1)!.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    buttons.at(-1)!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(buttons.at(-1));
    const back = new Event('cardnest:back', { cancelable: true });
    window.dispatchEvent(back);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(back.defaultPrevented).toBe(true);
    expect(element.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    element.remove();
  });
  it('shows approval failures inside the open dialog and success only after approval resolves', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    TestBed.inject(CardNestStore).cards.set([demoCard]);
    fixture.detectChanges();
    fixture.componentInstance.open(demoCandidate());
    fixture.detectChanges();
    sync.approve.mockRejectedValueOnce(new Error('Possible existing transaction. Match it.'));
    fixture.componentInstance.approve(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog [role=alert]').textContent).toContain(
      'Match it',
    );
    expect(fixture.componentInstance.selected()).not.toBeNull();
    sync.approve.mockResolvedValueOnce(undefined);
    fixture.componentInstance.approve(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('approved and saved');
  });
  it('cannot add evidence-only messages or already imported items', () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    const candidate = demoCandidate();
    candidate.kind = 'STATEMENT';
    candidate.item!.kind = 'STATEMENT';
    fixture.componentInstance.open(candidate);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog button[type=submit]')).toBeNull();
    expect(fixture.nativeElement.querySelector('dialog').textContent).toContain('evidence only');
    const imported = demoCandidate();
    imported.state = 'IMPORTED';
    imported.decision = 'PENDING'; // Balance reconciliation choice is not the financial review state.
    fixture.componentInstance.open(imported);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog button[type=submit]')).toBeNull();
    expect(sync.approve).not.toHaveBeenCalled();
    expect(fixture.componentInstance.sourceLabel(imported)).toContain('Recorded transaction');
    expect(fixture.componentInstance.matchReason(imported)).not.toContain('PENDING');
  });
  it('applies and clears filter chips including the original event-date range', () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    const reviewState = fixture.debugElement
      .queryAll(By.directive(AppSelectPicker))
      .map((element) => element.componentInstance as AppSelectPicker)
      .find((picker) => picker.label() === 'Review status');
    expect(reviewState?.currentValue()).toBe('PENDING');
    const page = fixture.componentInstance;
    page.from.set('2026-10-01');
    page.search.set('DEMO');
    page.applyFilters();
    expect(sync.filterReview).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-10-01', search: 'DEMO' }),
    );
    page.removeFilter('from');
    expect(page.from()).toBe('');
    page.removeFilter('read');
    expect(page.readFilter()).toBe('ALL');
    page.clearFilters();
    expect(page.filterChips()).toEqual([]);
    expect(sync.filterReview).toHaveBeenLastCalledWith({
      ...defaultReviewFilters(),
      from: '',
      to: '',
      state: 'ALL',
      kind: 'ALL',
      source: '',
      search: '',
      read: 'ALL',
    });
  });
  it('confirms the actual unread count before bulk marking and shows success only after persistence', async () => {
    sync.unreadTotal.set(401);
    sync.markAllRead.mockImplementationOnce(async () => {
      sync.unreadTotal.set(0);
      return 401;
    });
    const snackbar = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    const fixture = TestBed.createComponent(SmsSyncPage);
    const element = fixture.nativeElement as HTMLElement;
    document.body.append(element);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.componentInstance.requestMarkAllRead();
    await vi.waitFor(() => expect(fixture.componentInstance.confirmReadCount()).toBe(401));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.read-confirmation').textContent).toContain(
      '401 saved SMS suggestions',
    );
    expect(sync.markAllRead).not.toHaveBeenCalled();
    fixture.componentInstance.confirmMarkAllRead();
    await fixture.whenStable();
    expect(sync.markAllRead).toHaveBeenCalledOnce();
    expect(sync.approve).not.toHaveBeenCalled();
    expect(snackbar).toHaveBeenCalledWith('401 saved SMS suggestions marked as read.', 'INFO');
    fixture.detectChanges();
    expect(document.activeElement?.id).toBe('sms-inbox-title');
    element.remove();
  });
  it('keeps bulk read in the review header and disables its button for empty/read or busy inboxes', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector(
      '.review-heading #mark-all-read',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
    const refreshes = sync.refresh.mock.calls.length;
    button.click();
    expect(sync.refresh).toHaveBeenCalledTimes(refreshes);
    expect(fixture.componentInstance.confirmReadCount()).toBeNull();
    sync.unreadTotal.set(3);
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    sync.markingRead.set(true);
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    expect(sync.markAllRead).not.toHaveBeenCalled();
  });
  it('renders compact filter bodies with icon-pack close controls and keeps filter removal functional', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.kind.set('PURCHASE');
    fixture.detectChanges();
    const chip = fixture.nativeElement.querySelector(
      'button[aria-label="Remove Purchase filter"]',
    ) as HTMLButtonElement;
    expect(chip.querySelector('.chip-body .chip-label')?.textContent).toBe('Purchase');
    expect(chip.querySelector('app-icon svg')).not.toBeNull();
    chip.click();
    await fixture.whenStable();
    expect(sync.filterReview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'ALL' }));
    expect(sync.approve).not.toHaveBeenCalled();
  });
  it('presents missing sources and evidence-only limitations as structured notices without bypassing approval', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.open(demoCandidate());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.source-notice strong')?.textContent).toBe(
      'Add a source first',
    );
    expect(fixture.nativeElement.querySelector('.source-notice app-icon svg')).not.toBeNull();
    const statement = demoCandidate();
    statement.kind = 'STATEMENT';
    statement.item!.kind = 'STATEMENT';
    fixture.componentInstance.open(statement);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('aside[aria-label="Evidence only"] strong')?.textContent,
    ).toBe('Evidence only');
    expect(fixture.nativeElement.querySelector('dialog button[type=submit]')).toBeNull();
    expect(sync.approve).not.toHaveBeenCalled();
  });
  it('shows a warning snackbar on failed read persistence and does not show success', async () => {
    sync.markRead.mockRejectedValueOnce(new Error('Synthetic read write failed'));
    const snackbar = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    fixture.componentInstance.markRead(demoCandidate());
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(snackbar).toHaveBeenCalledWith('Synthetic read write failed', 'WARNING'),
    );
    expect(sync.approve).not.toHaveBeenCalled();
  });
  it('uses reactive custom pickers for SMS editors and leaves the review open when a nested picker handles Back', async () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    TestBed.inject(CardNestStore).cards.set([demoCard]);
    TestBed.inject(CardNestStore).categories.set([
      { id: 'other', name: 'Other', icon: 'category', appliesTo: 'BOTH', archived: false },
    ]);
    fixture.detectChanges();
    fixture.componentInstance.open(demoCandidate());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('select,datalist')).toBeNull();
    const source = fixture.debugElement
      .queryAll(By.directive(AppSelectPicker))
      .map((element) => element.componentInstance as AppSelectPicker)
      .find((picker) => picker.label() === 'Choose source (required)')!;
    source.show();
    fixture.detectChanges();
    const event = new Event('cardnest:back', { cancelable: true });
    window.dispatchEvent(event);
    fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true);
    expect(source.open()).toBe(false);
    expect(fixture.componentInstance.selected()?.id).toBe(demoCandidate().id);
    source.select(demoCard.id);
    fixture.detectChanges();
    expect(fixture.componentInstance.editor.controls.source.value).toBe(demoCard.id);
    expect(fixture.componentInstance.editor.controls.source.touched).toBe(true);
  });
  it.each(['light', 'dark'])(
    'passes AXE WCAG rules available in jsdom in %s mode',
    async (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const fixture = TestBed.createComponent(SmsSyncPage);
      fixture.detectChanges();
      await fixture.whenStable();
      const empty = await axe.run(fixture.nativeElement as HTMLElement, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(empty.violations).toEqual([]);
      fixture.componentInstance.open({
        id: 'a'.repeat(64),
        state: 'PENDING',
        kind: 'PURCHASE',
        eventAt: '2026-10-18T12:00:00Z',
        item: {
          id: 'a'.repeat(64),
          providerId: '1',
          parserVersion: 3,
          kind: 'PURCHASE',
          amountMinor: 100,
          currency: 'INR',
          eventDate: '2026-10-18',
          eventAt: '2026-10-18T12:00:00Z',
          receivedAt: 1,
          dateFallback: false,
          evidence: 'Synthetic evidence',
        },
      });
      fixture.detectChanges();
      await fixture.whenStable();
      const editor = await axe.run(fixture.nativeElement as HTMLElement, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(editor.violations).toEqual([]);
      // jsdom cannot evaluate rendered colour contrast. A real WebView AXE pass remains a release gate.
      document.documentElement.removeAttribute('data-theme');
    },
    // Two real AXE audits can exceed Vitest's 5s default during native/R8 builds.
    // Keep every rule/assertion and allow the awaited audit to finish before the next theme.
    30_000,
  );
  it('reviews a Bank/UPI debit as a purchase with tracking off, without guessing a tracked account', async () => {
    paymentSources.set([
      {
        id: 'source-debit',
        nickname: 'Bank / UPI',
        kind: 'DEBIT',
        institution: 'Primary bank',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
    ]);
    store.categories.set([
      { id: 'groceries', name: 'Groceries', icon: 'groceries', appliesTo: 'BOTH', archived: false },
      { id: 'other', name: 'Other', icon: 'other', appliesTo: 'BOTH', archived: false },
    ]);
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const bank = demoCandidate();
    bank.kind = 'BANK_DEBIT';
    bank.item = {
      ...bank.item!,
      kind: 'BANK_DEBIT',
      direction: 'DEBIT',
      purposeHint: 'PURCHASE',
      cardDigits: undefined,
      accountDigits: '417',
      issuer: 'ICICI',
      merchant: 'HILL FARM MEATS',
      amountMinor: 45000,
    };
    fixture.componentInstance.open(bank);
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLElement;
    expect(dialog.textContent).toContain('ICICI Bank');
    expect(dialog.textContent).toContain('Record Bank/UPI purchase');
    expect(dialog.querySelector('aside[aria-label="Evidence only"]')).toBeNull();
    const page = fixture.componentInstance;
    expect(page.bankEditor.getRawValue()).toMatchObject({
      purpose: 'PURCHASE',
      source: 'source-debit',
      description: 'HILL FARM MEATS',
      category: 'groceries',
    });
    page.approveBankEvent(new Event('submit'));
    await fixture.whenStable();
    expect(sync.approveBank).toHaveBeenCalledWith(
      bank,
      expect.objectContaining({
        purpose: 'PURCHASE',
        sourceId: 'source-debit',
        amountMinor: 45000,
        categoryId: 'groceries',
      }),
    );
    expect(sync.approve).not.toHaveBeenCalled();
    bankCashTracking.set({ enabled: true, askCardSettlementFunding: false });
    page.open(bank);
    expect(page.bankEditor.controls.source.value).toBe('');
    const credit = demoCandidate();
    credit.kind = 'BANK_CREDIT';
    credit.item = {
      ...bank.item,
      kind: 'BANK_CREDIT',
      direction: 'CREDIT',
      purposeHint: 'INCOMING',
    };
    page.open(credit);
    expect(page.bankEditor.controls.purpose.value).toBe('');
  });

  it('uses the configured card picker, keeps comments across method changes and resets a new SMS', async () => {
    store.cards.set([demoCard]);
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.open(demoCandidate());
    fixture.detectChanges();
    expect(page.cardAnnotationsVisible()).toBe(true);
    expect(page.editor.controls.paymentMethod.value).toBe('NONE');
    page.editor.controls.source.setValue('');
    fixture.detectChanges();
    expect(page.cardAnnotationsVisible()).toBe(true);
    expect(page.editor.controls.source.valid).toBe(false);
    page.editor.controls.source.setValue(demoCard.id);
    expect(page.cardPaymentMethods.map((item) => item.label)).toEqual([
      'None',
      'UPI',
      'UPI Global',
      'Card',
      'Card tap',
    ]);
    expect(fixture.nativeElement.querySelectorAll('.sms-additional-comment textarea')).toHaveLength(
      1,
    );
    expect(fixture.nativeElement.querySelector('dialog select')).toBeNull();

    page.setCardPaymentMethod('UPI');
    page.editor.controls.paymentMethodDetail.setValue('BHIM_APP');
    page.clearCardPresetForCustomApp();
    page.editor.controls.paymentMethodCustom.setValue('Custom Wallet');
    expect(page.editor.controls.paymentMethodDetail.value).toBe('');
    page.setCardPaymentMethodDetail('GPAY');
    expect(page.editor.controls.paymentMethodCustom.value).toBe('');
    page.editor.controls.paymentMethodCustom.setValue('Custom Wallet');
    page.clearCardPresetForCustomApp();
    page.editor.controls.smsAdditionalComment.setValue('Keep this comment');
    page.setCardPaymentMethod('CARD_TAP');
    fixture.detectChanges();
    expect(page.editor.controls.paymentMethodDetail.value).toBe('');
    expect(page.editor.controls.paymentMethodCustom.value).toBe('');
    expect(page.editor.controls.smsAdditionalComment.value).toBe('Keep this comment');
    expect(page.paymentMethodDetailConfig('CARD_TAP')?.label).toBe('Tap method');

    const next = demoCandidate();
    next.id = 'b'.repeat(64);
    page.open(next);
    fixture.detectChanges();
    expect(page.editor.controls.paymentMethod.value).toBe('NONE');
    expect(page.editor.controls.paymentMethodDetail.value).toBe('');
    expect(page.editor.controls.paymentMethodCustom.value).toBe('');
    expect(page.editor.controls.smsAdditionalComment.value).toBe('');
  });

  it('keeps Bank-only methods in Bank review and always renders its comment field', async () => {
    paymentSources.set([
      {
        id: 'source-debit',
        nickname: 'Synthetic bank',
        kind: 'DEBIT',
        institution: 'Fictional Bank',
        lastDigits: '417',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
    ]);
    bankCashTracking.set({ enabled: true, askCardSettlementFunding: false });
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const candidate = demoCandidate();
    candidate.kind = 'BANK_DEBIT';
    candidate.item = {
      ...candidate.item!,
      kind: 'BANK_DEBIT',
      direction: 'DEBIT',
      purposeHint: 'PURCHASE',
      accountDigits: '417',
      issuer: 'ICICI',
    };
    const page = fixture.componentInstance;
    page.open(candidate);
    fixture.detectChanges();
    expect(page.bankEditor.controls.paymentMethod.value).toBe('NONE');
    expect(page.bankPaymentMethods).toHaveLength(8);
    expect(page.bankPaymentMethods.slice(-3).map((item) => item.label)).toEqual([
      'NEFT',
      'Cheque',
      'SWIFT/ WIRE',
    ]);
    expect(page.paymentMethodDetailConfig('NEFT')).toBeUndefined();
    expect(fixture.nativeElement.querySelectorAll('.sms-additional-comment textarea')).toHaveLength(
      1,
    );
    page.bankEditor.controls.smsAdditionalComment.setValue('Keep comment');
    page.setBankPaymentMethod('CHEQUE');
    expect(page.bankEditor.controls.paymentMethodDetail.value).toBe('');
    expect(page.bankEditor.controls.paymentMethodCustom.value).toBe('');
    expect(page.bankEditor.controls.smsAdditionalComment.value).toBe('Keep comment');
  });
});
