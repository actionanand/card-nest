import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
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
        'Checking · •••' + suffix.slice(-3),
      );
      expect(page.sourceOptions().find((row) => row.value === 'savings')?.label).toContain(
        'Savings · •••123',
      );
      expect(page.linkedIdentifier()).toContain('activity matching: •••123');
      await page.saveProfile(new Event('submit'));
      expect(activity.saveProfile).toHaveBeenCalledWith(
        expect.objectContaining({ paymentSourceId: 'checking', accountIdentifier: '•••123' }),
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
  const requestedSourceId = signal('');
  const requestedDiscoveryFingerprint = signal('');
  const routerNavigate = vi.fn().mockResolvedValue(true);
  const bankCashTracking = signal({ enabled: false, askCardSettlementFunding: false });
  const profiles = signal<readonly BankActivityProfile[]>([]);
  const candidates = signal<readonly BankActivityCandidate[]>([]);
  const activity = {
    profiles,
    candidates,
    events: signal([]),
    reviewNotice: signal(''),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    saveManualEvent: vi.fn().mockResolvedValue(undefined),
    discovering: signal(false),
    discoveryProgress: signal(0),
    saveProfile: vi.fn().mockResolvedValue(profile),
    updateOwnMoneySourceIdentity: vi.fn().mockResolvedValue({
      id: 'checking',
      kind: 'DEBIT',
      institution: 'HDFC Bank',
      nickname: 'Updated checking',
      lastDigits: '00007',
      balanceMinor: 765400,
      balanceCutoverAt: '2026-10-28T10:00:00Z',
      noLimit: true,
      autoLoad: false,
      archived: false,
    }),
    setArchived: vi.fn().mockResolvedValue(undefined),
    confirmCandidateIdentity: vi.fn(async (fingerprint: string, profileId: string) => {
      const current = candidates().find((row) => row.fingerprint === fingerprint);
      if (!current) throw new Error('Candidate not found');
      const resolved = {
        ...current,
        resolvedAt: 'identity-confirmed',
        resolvedProfileId: profileId,
      };
      candidates.update((items) =>
        items.map((row) => (row.fingerprint === fingerprint ? resolved : row)),
      );
      return resolved;
    }),
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
    requestedSourceId.set('');
    requestedDiscoveryFingerprint.set('');
    profiles.set([]);
    candidates.set([]);
    vi.clearAllMocks();
    activity.saveProfile.mockReset().mockResolvedValue(profile);
    activity.updateOwnMoneySourceIdentity.mockReset().mockResolvedValue({
      id: 'checking',
      kind: 'DEBIT',
      institution: 'HDFC Bank',
      nickname: 'Updated checking',
      lastDigits: '00007',
      balanceMinor: 765400,
      balanceCutoverAt: '2026-10-28T10:00:00Z',
      noLimit: true,
      autoLoad: false,
      archived: false,
    });
    activity.confirmCandidateIdentity.mockImplementation(async (fingerprint, profileId) => {
      const current = candidates().find((row) => row.fingerprint === fingerprint);
      if (!current) throw new Error('Candidate not found');
      const resolved = {
        ...current,
        resolvedAt: 'identity-confirmed',
        resolvedProfileId: profileId,
      };
      candidates.update((items) =>
        items.map((row) => (row.fingerprint === fingerprint ? resolved : row)),
      );
      return resolved;
    });
    activity.approveCandidate.mockReset().mockResolvedValue(null);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    TestBed.configureTestingModule({
      imports: [BankActivityPage],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: {
                get: (key: string) =>
                  key === 'source'
                    ? requestedSourceId()
                    : key === 'discoverCandidate'
                      ? requestedDiscoveryFingerprint()
                      : null,
              },
            },
          },
        },
        { provide: Router, useValue: { navigate: routerNavigate } },
        { provide: BankActivityService, useValue: activity },
        {
          provide: CardNestStore,
          useValue: {
            paymentSources: sources,
            bankCashTracking,
            updatePaymentSource: vi.fn().mockResolvedValue(undefined),
          },
        },
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
    page.activeTab.set(1);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Bank identification evidence');
    expect(fixture.nativeElement.textContent).toContain('Suggested match · confirm identity');
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
    expect(fixture.nativeElement.textContent).not.toContain('Activity needs review');
    expect(activity.discoverSavedEvidence).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('shows saved Money Sources and standalone OTHERS profiles on Discovered Accounts without tracked balances', async () => {
    sources.set([
      {
        id: 'own-source',
        kind: 'DEBIT',
        institution: 'ICICI Bank',
        nickname: 'Everyday',
        lastDigits: '45123',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
      {
        id: 'archived-source',
        kind: 'DEBIT',
        institution: 'HDFC Bank',
        nickname: 'Archived reserve',
        lastDigits: '00007',
        noLimit: true,
        autoLoad: false,
        archived: true,
      },
    ]);
    profiles.set([
      { ...profile, paymentSourceId: 'own-source', nickname: 'Monitoring nickname' },
      { ...profile, id: 'family-profile', owner: 'OTHERS', holderName: 'Fiction Family' },
    ]);
    const fixture = TestBed.createComponent(BankActivityPage);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Discovered Accounts');
    expect(fixture.nativeElement.textContent).toContain('ICICI Bank · •••123');
    expect(fixture.nativeElement.textContent).toContain('Everyday');
    expect(fixture.nativeElement.textContent).toContain('Money Source: Linked to monitoring');
    expect(fixture.nativeElement.textContent).toContain('Not tracked');
    expect(fixture.nativeElement.textContent).toContain('OTHERS · monitoring only');
    expect(fixture.nativeElement.textContent).toContain('Fiction Family');
    expect(fixture.nativeElement.textContent).toContain('Archived Money Sources');
    expect(fixture.nativeElement.textContent).toContain('Archived reserve');
    expect(fixture.nativeElement.querySelectorAll('.source-balance')).toHaveLength(0);
    fixture.destroy();
  });
  it('opens the requested Money Source on Discovered Accounts and focuses its card', async () => {
    const source: PaymentSource = {
      id: 'navigate-source',
      kind: 'DEBIT',
      institution: 'ICICI Bank',
      nickname: 'Everyday',
      lastDigits: '45123',
      noLimit: true,
      autoLoad: false,
      archived: false,
    };
    sources.set([source]);
    profiles.set([{ ...profile, paymentSourceId: source.id }]);
    requestedSourceId.set(source.id);
    const fixture = TestBed.createComponent(BankActivityPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const card = fixture.nativeElement.querySelector(
      '#bank-account-navigate-source',
    ) as HTMLElement;
    expect(fixture.componentInstance.activeTab()).toBe(0);
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card);
    fixture.destroy();
  });
  it('opens Find Banks for a requested SMS candidate and returns to that review', async () => {
    const smsCandidate = { ...candidate, fingerprint: 'sms-review-candidate' };
    candidates.set([smsCandidate]);
    requestedDiscoveryFingerprint.set(smsCandidate.fingerprint);
    const fixture = TestBed.createComponent(BankActivityPage);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(activity.discoverSavedEvidence).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fixture.componentInstance.profileFormOpen()).toBe(true));
    expect(fixture.componentInstance.activeTab()).toBe(1);
    expect(fixture.componentInstance.profileForm.controls.accountIdentifier.value).toBe('•••123');
    expect(fixture.componentInstance.returnSmsCandidate).toBe(smsCandidate.fingerprint);

    fixture.componentInstance.returnToSmsReview();
    expect(routerNavigate).toHaveBeenCalledWith(['/sms-sync'], {
      queryParams: { review: smsCandidate.fingerprint },
    });
    fixture.destroy();
  });
  it('distinguishes known, unknown and untracked balances and keeps archive actions independent', async () => {
    const ownSource: PaymentSource = {
      id: 'own-balanced',
      kind: 'DEBIT',
      institution: 'ICICI Bank',
      nickname: 'Everyday',
      lastDigits: '45123',
      balanceMinor: 765400,
      balanceCutoverAt: '2026-10-28T10:00:00Z',
      noLimit: true,
      autoLoad: false,
      archived: false,
    };
    const unknownSource: PaymentSource = {
      id: 'own-unknown',
      kind: 'DEBIT',
      institution: 'HDFC Bank',
      nickname: 'Reserve',
      lastDigits: '00007',
      noLimit: true,
      autoLoad: false,
      archived: false,
    };
    sources.set([ownSource, unknownSource]);
    profiles.set([
      { ...profile, paymentSourceId: ownSource.id },
      { ...profile, id: 'family', owner: 'OTHERS', holderName: 'Fiction Family' },
    ]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    expect(page.accountBalanceLabel(ownSource)).toBe('Not tracked');
    expect(
      page.canSetBalance(page.accountCards().find((card) => card.source?.id === ownSource.id)!),
    ).toBe(false);

    bankCashTracking.set({ enabled: true, askCardSettlementFunding: false });
    fixture.detectChanges();
    expect(page.accountBalanceLabel(ownSource)).toContain('7,654.00');
    expect(page.accountBalanceLabel(unknownSource)).toBe('Balance not set');
    const ownCard = page.accountCards().find((card) => card.source?.id === ownSource.id)!;
    const familyCard = page.accountCards().find((card) => card.profile?.id === 'family')!;
    expect(page.canSetBalance(ownCard)).toBe(true);
    expect(page.canSetBalance(familyCard)).toBe(false);

    const updateSource = vi.spyOn(TestBed.inject(CardNestStore), 'updatePaymentSource');
    await page.archiveMoneySource(ownSource);
    expect(updateSource).toHaveBeenCalledWith({ ...ownSource, archived: true });
    expect(activity.setArchived).not.toHaveBeenCalled();
    await page.archive(profile);
    expect(activity.setArchived).toHaveBeenCalledWith(profile.id, true);
    expect(updateSource).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });
  it('edits OWN bank identity in a dialog without changing its source ID or balance', async () => {
    const source: PaymentSource = {
      id: 'checking',
      kind: 'DEBIT',
      institution: 'ICICI Bank',
      nickname: 'Checking',
      lastDigits: '45123',
      balanceMinor: 765400,
      balanceCutoverAt: '2026-10-28T10:00:00Z',
      noLimit: true,
      autoLoad: false,
      archived: false,
    };
    sources.set([source]);
    profiles.set([{ ...profile, paymentSourceId: source.id }]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    const card = page.accountCards().find((item) => item.source?.id === source.id)!;
    expect(card.suffix).toBe('123');
    page.editMoneySource(source);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).not.toBeNull();
    expect(page.moneySourceForm.getRawValue()).toEqual({
      nickname: 'Checking',
      institution: 'ICICI Bank',
      ifscCode: '',
      accountIdentifier: '•••123',
    });
    page.moneySourceForm.patchValue({
      nickname: 'Updated checking',
      institution: 'HDFC Bank',
      ifscCode: '',
      accountIdentifier: '00007',
    });
    await page.saveMoneySourceIdentity(new Event('submit'));
    expect(activity.updateOwnMoneySourceIdentity).toHaveBeenCalledWith({
      sourceId: 'checking',
      nickname: 'Updated checking',
      institution: 'HDFC Bank',
      ifscCode: '',
      accountIdentifier: '00007',
    });
    expect(page.discoveryNotice()).toContain('baseline and audit history are unchanged');
    expect(source.id).toBe('checking');
    expect(source.balanceMinor).toBe(765400);
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
    page.profileForm.patchValue({ bankName: 'ICICI', accountIdentifier: '12' });
    await page.saveProfile(new Event('submit'));
    expect(activity.saveProfile).not.toHaveBeenCalled();
    page.profileForm.controls.accountIdentifier.setValue('007');
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
      expect.objectContaining({ accountIdentifier: '007', owner: 'OWN' }),
    );
    page.editProfile({ ...profile, accountSuffix: '45123' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.profileForm.controls.accountIdentifier.value).toBe('•••123');
    expect(fixture.nativeElement.textContent).toContain('Edit monitored bank account');
    page.closeProfile();
    page.startProfile();
    expect(page.profileForm.controls.bankName.value).toBe('');
    fixture.destroy();
  });
  it('records account activity in a focused modal without implying a financial transaction', async () => {
    profiles.set([profile]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    page.activeTab.set(2);
    fixture.detectChanges();
    await fixture.whenStable();
    const trigger = [
      ...fixture.nativeElement.querySelectorAll('.activity-profile .profile-actions button'),
    ].find((button: HTMLButtonElement) =>
      button.textContent?.includes('Record activity'),
    ) as HTMLButtonElement;
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const dialog = fixture.nativeElement.querySelector(
      'app-profile-modal dialog[open]',
    ) as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('ICICI Bank · •••123');
    expect(dialog.textContent).toContain('monitoring evidence, not a financial transaction');
    expect(dialog.textContent).toContain('does not change balances, purchases, or imports');
    (dialog.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fixture.destroy();
  });
  it('keeps a failed Record Activity save error inside its popup', async () => {
    profiles.set([profile]);
    activity.saveManualEvent.mockRejectedValueOnce(new Error('Synthetic activity write failure'));
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    page.activeTab.set(2);
    fixture.detectChanges();
    await fixture.whenStable();
    const trigger = [
      ...fixture.nativeElement.querySelectorAll('.activity-profile .profile-actions button'),
    ].find((button: HTMLButtonElement) =>
      button.textContent?.includes('Record activity'),
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    await page.saveEvent(new Event('submit'));
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('app-profile-modal [role="alert"]')?.textContent,
    ).toContain('Synthetic activity write failure');
    expect(fixture.nativeElement.querySelector('.bank-activity-page > p[role="alert"]')).toBeNull();
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
      accountIdentifier: '•••123',
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
  it('labels unidentified bank evidence and keeps it out of saved account cards', async () => {
    candidates.set([candidate]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    page.activeTab.set(1);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Unidentified account');
    expect(fixture.nativeElement.textContent).toContain('No monitored account matches');
    page.activeTab.set(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#bank-panel-0').textContent).not.toContain(
      'Unidentified account',
    );

    profiles.set([profile]);
    candidates.set([{ ...candidate, fingerprint: 'suffix-conflict', accountSuffix: '456' }]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Needs review');
    expect(fixture.nativeElement.textContent).toContain(
      'bank is monitored, but its account suffix does not match',
    );
    expect(activity.saveProfile).not.toHaveBeenCalled();
    expect(activity.approveCandidate).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('filters structured Find Banks evidence without starting a scan', async () => {
    profiles.set([profile]);
    candidates.set([
      candidate,
      { ...candidate, fingerprint: 'unidentified', bankName: undefined, accountSuffix: '999' },
      { ...candidate, fingerprint: 'needs-review', bankName: 'HDFC', accountSuffix: '123' },
      {
        ...candidate,
        fingerprint: 'associated',
        resolvedAt: 'before',
        resolvedProfileId: profile.id,
      },
    ]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    page.activeTab.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.evidenceStatus(candidate)).toBe('SUGGESTED');
    expect(page.evidenceStatus(candidates()[1])).toBe('UNIDENTIFIED');
    expect(page.evidenceStatus(candidates()[2])).toBe('NEEDS_REVIEW');
    expect(page.evidenceStatus(candidates()[3])).toBe('ASSOCIATED');
    expect(page.filteredEvidence().map((item) => item.fingerprint)).toEqual([
      'fiction',
      'unidentified',
      'needs-review',
      'associated',
    ]);
    for (const [filter, expected] of [
      ['SUGGESTED', 'fiction'],
      ['UNIDENTIFIED', 'unidentified'],
      ['NEEDS_REVIEW', 'needs-review'],
      ['ASSOCIATED', 'associated'],
    ] as const) {
      page.evidenceFilter.set(filter);
      expect(page.filteredEvidence().map((item) => item.fingerprint)).toEqual([expected]);
    }
    page.evidenceFilter.set('ALL');
    page.evidenceQuery.set('999');
    expect(page.filteredEvidence().map((item) => item.fingerprint)).toEqual(['unidentified']);
    expect(activity.discoverSavedEvidence).not.toHaveBeenCalled();
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
  it('confirms account identity without recording activity, then keeps activity confirmation separate', async () => {
    profiles.set([profile]);
    candidates.set([{ ...candidate, bankName: undefined }]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    page.activeTab.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.reviewSelection()[candidate.fingerprint]).toBe(profile.id);
    const identityButton = [
      ...fixture.nativeElement.querySelectorAll('.review-candidate button'),
    ].find((button: HTMLButtonElement) =>
      button.textContent?.includes('Confirm account identity'),
    ) as HTMLButtonElement;
    identityButton.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-confirmation-dialog').textContent).toContain(
      'This saves account identity only',
    );
    await page.confirmIdentity();
    fixture.detectChanges();
    expect(activity.confirmCandidateIdentity).toHaveBeenCalledWith(
      candidate.fingerprint,
      profile.id,
    );
    expect(activity.approveCandidate).not.toHaveBeenCalled();
    expect(activity.events()).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('Account identified · activity pending');
    const activityButton = [
      ...fixture.nativeElement.querySelectorAll('.review-candidate button'),
    ].find((button: HTMLButtonElement) =>
      button.textContent?.includes('Review & confirm activity'),
    ) as HTMLButtonElement;
    activityButton.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-confirmation-dialog').textContent).toContain(
      'Record this account activity?',
    );
    expect(activity.approveCandidate).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('does not trust manual-only profiles for automatic or identity-only SMS association', async () => {
    const manualProfile: BankActivityProfile = {
      ...profile,
      id: 'manual-only-profile',
      owner: 'OTHERS',
      holderName: 'Fiction Manual Holder',
      manualOnly: true,
    };
    profiles.set([manualProfile]);
    candidates.set([{ ...candidate, bankName: undefined }]);
    const fixture = TestBed.createComponent(BankActivityPage);
    const page = fixture.componentInstance;
    page.activeTab.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.reviewSelection()[candidate.fingerprint]).toBeUndefined();
    page.setReviewProfile(candidate.fingerprint, manualProfile.id);
    expect(page.canConfirmIdentity(candidates()[0])).toBe(false);
    page.requestIdentityConfirmation(candidate.fingerprint);
    expect(page.identityConfirmation()).toBeNull();
    fixture.destroy();

    candidates.set([
      {
        ...candidate,
        bankName: undefined,
        resolvedAt: 'legacy-association',
        resolvedProfileId: manualProfile.id,
      },
    ]);
    const legacyFixture = TestBed.createComponent(BankActivityPage);
    const legacyPage = legacyFixture.componentInstance;
    legacyPage.activeTab.set(1);
    legacyFixture.detectChanges();
    await legacyFixture.whenStable();
    expect(legacyPage.evidenceStatus(candidates()[0])).toBe('NEEDS_REVIEW');
    expect(legacyPage.reviewSelection()[candidate.fingerprint]).toBeUndefined();
    legacyPage.setReviewProfile(candidate.fingerprint, manualProfile.id);
    expect(legacyPage.selectionConflict(candidates()[0])).toBe(true);
    legacyFixture.destroy();
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
