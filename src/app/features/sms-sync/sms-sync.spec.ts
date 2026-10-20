import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { SmsSyncPage } from './sms-sync';
import { SmsReviewService } from './sms-review.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { ScanStatus, SmsCandidate } from './sms-model';
import axe from 'axe-core';
import { CreditCard } from '../../core/models/domain';

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
  const sync = {
    lock: { locked, foreground },
    candidates,
    status,
    requestingPermission,
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
    notice: signal(''),
    reviewPage: signal(0),
    refresh: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn(),
    relatedFor: vi.fn().mockResolvedValue([]),
    enable: vi.fn(),
    refreshAccess: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn().mockResolvedValue(undefined),
    filterReview: vi.fn().mockResolvedValue(undefined),
  };
  beforeEach(() => {
    locked.set(false);
    foreground.set(true);
    candidates.set([]);
    status.set(null);
    requestingPermission.set(false);
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [SmsSyncPage],
      providers: [
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
    expect(buttons.find((b) => b.textContent?.includes('Scan now'))?.disabled).toBe(true);
    buttons.find((b) => b.textContent?.includes('Open app settings'))?.click();
    expect(sync.openSettings).toHaveBeenCalledOnce();
  });
  it('disables repeated Enable taps while requesting and shows the actual request state', () => {
    requestingPermission.set(true);
    const fixture = TestBed.createComponent(SmsSyncPage);
    fixture.detectChanges();
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons.find((b) => b.textContent?.includes('Requesting permission'))?.disabled).toBe(
      true,
    );
    expect(fixture.nativeElement.textContent).toContain(
      "Waiting for Android's SMS permission response.",
    );
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
    const trigger = element.querySelector<HTMLButtonElement>('button[aria-haspopup=dialog]')!;
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
    const reviewState = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLSelectElement>(
        '#sms-filters select',
      ),
    ].find((select) => select.closest('label')?.textContent?.includes('Review status'));
    expect(reviewState?.value).toBe('PENDING');
    const page = fixture.componentInstance;
    page.from.set('2026-10-01');
    page.search.set('DEMO');
    page.applyFilters();
    expect(sync.filterReview).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-10-01', search: 'DEMO' }),
    );
    page.removeFilter('from');
    expect(page.from()).toBe('');
    page.clearFilters();
    expect(page.filterChips()).toEqual([]);
    expect(sync.filterReview).toHaveBeenLastCalledWith({
      from: '',
      to: '',
      state: 'ALL',
      kind: 'ALL',
      source: '',
      search: '',
    });
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
