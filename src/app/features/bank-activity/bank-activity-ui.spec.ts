import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BankActivityPage } from './bank-activity';
import { BankActivityService } from './bank-activity.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { activityMatch, selectionMatches } from './bank-activity-matching';
import {
  BankActivityCandidate,
  BankActivityProfile,
  bankActivitySummary,
} from './bank-activity-model';
import { PaymentSource } from '../../core/models/domain';
import { Capacitor } from '@capacitor/core';
import axe from 'axe-core';

describe('Bank profile popup and confirmation-only discovery UI', () => {
  it.each(['9123', '45123'])(
    'distinguishes linked sources using nicknames and masked %s identifiers without changing them',
    async (suffix) => {
      sources.set([
        {
          id: 'checking',
          kind: 'DEBIT',
          institution: 'ICICI',
          nickname: 'Checking',
          lastDigits: suffix,
          noLimit: true,
          autoLoad: false,
          archived: false,
        },
        {
          id: 'savings',
          kind: 'DEBIT',
          institution: 'ICICI',
          nickname: 'Savings',
          lastDigits: '123',
          noLimit: true,
          autoLoad: false,
          archived: false,
        },
      ]);
      const fixture = TestBed.createComponent(BankActivityPage);
      const page = fixture.componentInstance;
      page.startProfile();
      page.profileForm.controls.paymentSourceId.setValue('checking');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(page.sourceOptions().find((row) => row.value === 'checking')?.label).toContain(
        'Checking · •••' + suffix,
      );
      expect(page.sourceOptions().find((row) => row.value === 'savings')?.label).toContain(
        'Savings · •••123',
      );
      expect(page.linkedIdentifier()).toContain('activity matching: •••123');
      await page.saveProfile(new Event('submit'));
      expect(activity.saveProfile).toHaveBeenCalledWith(
        expect.objectContaining({ paymentSourceId: 'checking', accountSuffix: '123' }),
      );
      expect(sources()[0].lastDigits).toBe(suffix);
      fixture.destroy();
    },
  );
  const profile: BankActivityProfile = {
    id: 'profile',
    bankName: 'ICICI Bank',
    accountSuffix: '123',
    owner: 'OWN',
    archived: false,
    createdAt: 'before',
    updatedAt: 'before',
  };
  const candidate: BankActivityCandidate = {
    fingerprint: 'fiction',
    bankName: 'ICICI',
    accountSuffix: '123',
    activityDate: '2026-10-27',
    direction: 'DEBIT',
    purposeHint: 'PURCHASE',
    createdAt: 'before',
  };
  const sources = signal<readonly PaymentSource[]>([]);
  const profiles = signal<readonly BankActivityProfile[]>([]);
  const candidates = signal<readonly BankActivityCandidate[]>([]);
  const activity = {
    profiles,
    candidates,
    events: signal([]),
    reviewNotice: signal(''),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    discovering: signal(false),
    discoveryProgress: signal(0),
    saveProfile: vi.fn().mockResolvedValue(profile),
    approveCandidate: vi.fn().mockResolvedValue(null),
    dismissCandidate: vi.fn(),
    dismissCandidates: vi.fn(),
    discoverSavedEvidence: vi.fn().mockResolvedValue(0),
    match: (item: BankActivityCandidate) => activityMatch(item, profiles(), sources()),
    selectionMatches: (item: BankActivityCandidate, id: string) => {
      const selected = profiles().find((row) => row.id === id);
      return !!selected && selectionMatches(item, selected, sources());
    },
    summaryFor: () => bankActivitySummary([], '2026-10-27'),
    eventsFor: () => [],
  };
  beforeEach(() => {
    sources.set([]);
    profiles.set([]);
    candidates.set([]);
    vi.clearAllMocks();
    activity.saveProfile.mockReset().mockResolvedValue(profile);
    activity.approveCandidate.mockReset().mockResolvedValue(null);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    TestBed.configureTestingModule({
      imports: [BankActivityPage],
      providers: [
        { provide: BankActivityService, useValue: activity },
        { provide: CardNestStore, useValue: { paymentSources: sources } },
      ],
    });
  });
  afterEach(() => vi.restoreAllMocks());
  it('renders three accessible tabs, separates unique discoveries and keeps ambiguous identities reviewable', async () => {
    profiles.set([profile]);
    candidates.set([candidate]);
    const fixture = TestBed.createComponent(BankActivityPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    const tabs = fixture.nativeElement.querySelectorAll(
      '[role="tab"]',
    ) as NodeListOf<HTMLButtonElement>;
    expect([...tabs].map((tab) => tab.textContent?.trim())).toEqual([
      'Discovered Accounts',
      'Find Banks',
      'Bank Activities',
    ]);
    expect(page.discoveries()).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('No new bank accounts found');
    tabs[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect(page.activeTab()).toBe(2);
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[2]);
    expect(fixture.nativeElement.querySelector('#bank-panel-0').hidden).toBe(true);
    expect(fixture.nativeElement.querySelector('#bank-panel-2').hidden).toBe(false);
    profiles.set([profile, { ...profile, id: 'other' }]);
    fixture.detectChanges();
    expect(page.discoveries()[0].needsIdentification).toBe(true);
    expect(activity.discoverSavedEvidence).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('requires confirmation for deletion, preserves Cancel, guards repeated taps and keeps failures visible', async () => {
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    const event = {
      id: 'selected',
      profileId: profile.id,
      activityDate: '2026-10-25',
      direction: 'DEBIT',
      origin: 'MANUAL',
      verification: 'USER_CONFIRMED',
      createdAt: '',
      updatedAt: '',
    } as const;
    await page.deleteEvent(event);
    expect(activity.deleteEvent).not.toHaveBeenCalled();
    page.deletion.set(null);
    await page.confirmDeletion();
    expect(activity.deleteEvent).not.toHaveBeenCalled();
    await page.deleteEvent(event);
    let fail!: (reason: Error) => void;
    activity.deleteEvent.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const pending = page.confirmDeletion();
    await page.confirmDeletion();
    expect(activity.deleteEvent).toHaveBeenCalledTimes(1);
    fail(new Error('Persistence failed'));
    await pending;
    expect(page.deletion()?.id).toBe(event.id);
    expect(page.error()).toBe('Persistence failed');
    await page.confirmDeletion();
    expect(activity.deleteEvent).toHaveBeenLastCalledWith(event.id);
    expect(page.deletion()).toBeNull();
    fixture.destroy();
  });
  it('uses a clean add/edit popup, validates exactly three digits and guards repeated saves', async () => {
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    page.startProfile();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Add monitored bank account');
    page.profileForm.patchValue({ bankName: 'ICICI', accountSuffix: '12' });
    await page.saveProfile(new Event('submit'));
    expect(activity.saveProfile).not.toHaveBeenCalled();
    page.profileForm.controls.accountSuffix.setValue('007');
    let release!: (value: BankActivityProfile) => void;
    activity.saveProfile.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const first = page.saveProfile(new Event('submit'));
    await page.saveProfile(new Event('submit'));
    expect(activity.saveProfile).toHaveBeenCalledTimes(1);
    release(profile);
    await first;
    expect(page.profileFormOpen()).toBe(false);
    expect(activity.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ accountSuffix: '007', owner: 'OWN' }),
    );
    page.editProfile({ ...profile, accountSuffix: '45123' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.profileForm.controls.accountSuffix.value).toBe('123');
    expect(fixture.nativeElement.textContent).toContain('Edit monitored bank account');
    page.closeProfile();
    page.startProfile();
    expect(page.profileForm.controls.bankName.value).toBe('');
    fixture.destroy();
  });
  it('opens one provisional discovery for related evidence, prefills only identity and preserves it on Cancel', async () => {
    candidates.set([candidate, { ...candidate, fingerprint: 'second' }]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.discoveries()).toHaveLength(1);
    expect(page.discoveries()[0].events).toHaveLength(2);
    page.reviewDiscovery(candidate);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.profileForm.getRawValue()).toMatchObject({
      bankName: 'ICICI',
      accountSuffix: '123',
      nickname: '',
      owner: '',
      holderName: '',
    });
    page.closeProfile();
    expect(candidates()).toHaveLength(2);
    expect(activity.saveProfile).not.toHaveBeenCalled();
    expect(activity.approveCandidate).not.toHaveBeenCalled();
    expect(activity.discoverSavedEvidence).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('distinguishes a new account candidate from an account that needs identification', async () => {
    candidates.set([candidate]);
    const fixture = TestBed.createComponent(BankActivityPage);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('New account candidate');
    expect(fixture.nativeElement.textContent).toContain('No active profile matches');

    profiles.set([profile]);
    candidates.set([{ ...candidate, fingerprint: 'suffix-conflict', accountSuffix: '456' }]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Account needs identification');
    expect(fixture.nativeElement.textContent).toContain('do not uniquely identify this account');
    expect(activity.saveProfile).not.toHaveBeenCalled();
    expect(activity.approveCandidate).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('preselects only unique accounts, requires a confirmation dialog and preserves Cancel', async () => {
    profiles.set([profile]);
    candidates.set([candidate]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.reviewSelection()[candidate.fingerprint]).toBe(profile.id);
    await page.approveCandidate(candidate.fingerprint);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-confirmation-dialog').textContent).toContain(
      'Record this account activity?',
    );
    expect(activity.approveCandidate).not.toHaveBeenCalled();
    page.confirmation.set(null);
    expect(activity.approveCandidate).not.toHaveBeenCalled();
    await page.approveCandidate(candidate.fingerprint);
    await page.confirmActivity();
    expect(activity.approveCandidate).toHaveBeenCalledTimes(1);
    expect(activity.approveCandidate).toHaveBeenCalledWith(
      candidate.fingerprint,
      profile.id,
      false,
    );
    fixture.destroy();
  });
  it('clears an automatic selection after ambiguity and requires deliberate acknowledgement for mismatch', async () => {
    profiles.set([profile]);
    candidates.set([candidate]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    profiles.set([profile, { ...profile, id: 'second-profile' }]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.reviewSelection()[candidate.fingerprint]).toBeUndefined();
    page.setReviewProfile(candidate.fingerprint, profile.id);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.reviewSelection()[candidate.fingerprint]).toBe(profile.id);
    candidates.set([{ ...candidate, bankName: 'HDFC', accountSuffix: '007' }]);
    fixture.detectChanges();
    await fixture.whenStable();
    await page.approveCandidate(candidate.fingerprint);
    expect(page.error()).toContain('acknowledge');
    expect(page.confirmation()).toBeNull();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    page.acknowledgeMismatch(candidate.fingerprint, { target: checkbox } as unknown as Event);
    await page.approveCandidate(candidate.fingerprint);
    expect(page.confirmation()?.message).toContain('not source-verified');
    await page.confirmActivity();
    expect(activity.approveCandidate).toHaveBeenCalledWith(candidate.fingerprint, profile.id, true);
    fixture.destroy();
  });
  it.each(['light', 'dark'])(
    'labels bank profile inputs and custom controls accessibly in %s theme',
    async (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const fixture = TestBed.createComponent(BankActivityPage);
      fixture.componentInstance.startProfile();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('select')).toBeNull();
      expect(
        (
          await axe.run(fixture.nativeElement, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
            rules: { 'color-contrast': { enabled: false } },
          })
        ).violations,
      ).toEqual([]);
      fixture.destroy();
      document.documentElement.removeAttribute('data-theme');
    },
    30000,
  );
});
