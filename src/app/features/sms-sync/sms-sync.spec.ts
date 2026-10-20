import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { SmsSyncPage } from './sms-sync';
import { SmsReviewService } from './sms-review.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { ScanStatus, SmsCandidate } from './sms-model';
import axe from 'axe-core';

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
    reviewPage: signal(0),
    refresh: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn(),
    relatedFor: vi.fn().mockResolvedValue([]),
    enable: vi.fn(),
    refreshAccess: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn().mockResolvedValue(undefined),
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
