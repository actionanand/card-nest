import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { SmsSyncPage } from './sms-sync';
import { SmsReviewService } from './sms-review.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { ScanStatus, SmsCandidate } from './sms-model';
import axe from 'axe-core';
import { CreditCard } from '../../core/models/domain';
import { Router } from '@angular/router';
import { By } from '@angular/platform-browser';
import { AppSelectPicker } from '../../shared/app-select-picker';
import { SnackbarService } from '../../core/services/snackbar.service';
import { defaultReviewFilters } from './sms-review-filters';

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
    error: signal(''),
    duplicates: signal(0),
    total: signal(0),
    savedTotal: signal(0),
    pendingTotal: signal(0),
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
    disable: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    scan: vi.fn().mockResolvedValue(undefined),
    turnPage: vi.fn().mockResolvedValue(undefined),
  };
  beforeEach(() => {
    locked.set(false);
    foreground.set(true);
    candidates.set([]);
    status.set(null);
    requestingPermission.set(false);
    changingSync.set(false);
    navigation.set(null);
    sync.busy.set(false);
    sync.total.set(0);
    sync.reviewPage.set(0);
    sync.unreadTotal.set(0);
    sync.markingRead.set(false);
    vi.clearAllMocks();
    sync.loadReviewFilters.mockImplementation(async () => defaultReviewFilters());
    TestBed.configureTestingModule({
      imports: [SmsSyncPage],
      providers: [
        { provide: Router, useValue: { currentNavigation: navigation } },
        { provide: SmsReviewService, useValue: sync },
        {
          provide: CardNestStore,
          useValue: {
            cards: signal([]),
            paymentSources: signal([]),
            categories: signal([]),
            transactions: signal([]),
            loans: signal([]),
            emiInstallments: signal([]),
            sourceDetail: () => 'DEMO',
          },
        },
      ],
    });
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
  it('does not request permission or approve money when the page opens', () => {
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    expect(sync.enable).not.toHaveBeenCalled();
    expect(sync.approve).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Nothing changes your transactions');
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
    fixture.componentInstance.open(imported);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog button[type=submit]')).toBeNull();
    expect(sync.approve).not.toHaveBeenCalled();
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
});
