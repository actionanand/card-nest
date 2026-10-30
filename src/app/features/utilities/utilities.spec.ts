import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { UtilitiesPage } from './utilities';
import { UtilitiesService } from './utilities.service';
import { WhatsAppService } from './whatsapp.service';
import { SnackbarService } from '../../core/services/snackbar.service';
import { addCalendarDays, mobileActivitySummary, lpgUsageSummary } from './utilities-calculations';
import { LpgProfile, MobileProfile, MobileRecharge } from './utilities-model';
import { ProfileModal } from '../../shared/profile-modal';
import { By } from '@angular/platform-browser';
import { readFileSync } from 'node:fs';

describe('Indian Utilities page', () => {
  const state = signal({ showIndianUtilities: true, utilityReminders: false });
  const mobiles = signal<readonly { id: string }[]>([]);
  const lpg = signal<readonly never[]>([]);
  const recharges = signal<readonly MobileRecharge[]>([]);
  const mock = {
    deleteMobileProfile: vi.fn().mockResolvedValue(undefined),
    deleteRecharge: vi.fn().mockResolvedValue(undefined),
    deleteLpgEvent: vi.fn().mockResolvedValue(undefined),
    saveRecharge: vi.fn().mockResolvedValue({ id: 'saved-recharge' }),
    saveMobileProfile: vi.fn().mockResolvedValue({ id: 'saved-mobile' }),
    saveLpgProfile: vi.fn().mockResolvedValue({ id: 'saved-lpg' }),
    settings: state,
    showIndianUtilities: computed(() => state().showIndianUtilities),
    utilityReminders: computed(() => state().utilityReminders),
    mobileProfiles: mobiles,
    mobileRecharges: recharges,
    lpgProfiles: lpg,
    lpgEvents: signal<readonly never[]>([]),
    operatorOptions: [
      { value: 'BSNL', label: 'BSNL' },
      { value: 'JIO', label: 'JIO' },
      { value: 'AIRTEL', label: 'Airtel' },
      { value: 'VI', label: 'VI' },
    ],
    subscriptionOptions: [
      { value: 'PREPAID', label: 'Prepaid' },
      { value: 'POSTPAID', label: 'Postpaid' },
    ],
    mobilePlanOptions: [{ value: 'VOICE_DATA', label: 'Voice + Data' }],
    lpgProviderOptions: [{ value: 'HPCL', label: 'HPCL' }],
    cylinderOptions: [{ value: 'NORMAL', label: 'Normal' }],
    lpgEventOptions: [{ value: 'STARTED', label: 'Cylinder installed / started using' }],
    rechargesFor: (profileId: string) => recharges().filter((row) => row.profileId === profileId),
    suggestedRechargeStart: () => '2026-10-28',
    eventsFor: () => [],
    mobileSummary: (profile: Pick<MobileProfile, 'id' | 'subscriptionType'>, today: string) =>
      mobileActivitySummary(
        [
          {
            id: 'midnight-mobile-plan',
            profileId: profile.id,
            planType: 'VOICE_DATA',
            startDate: '2026-10-01',
            endDate: '2026-10-25',
            createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-01T00:00:00Z',
          },
        ],
        profile.subscriptionType,
        today,
      ),
    lpgSummary: (_profile: Pick<LpgProfile, 'id' | 'estimatedUsageDays'>, today: string) =>
      lpgUsageSummary(
        [
          {
            id: 'midnight-lpg-start',
            profileId: _profile.id,
            eventType: 'STARTED',
            eventDate: '2026-10-01',
            createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-01T00:00:00Z',
          },
        ],
        _profile.estimatedUsageDays,
        today,
      ),
    setShowIndianUtilities: vi.fn(async (enabled: boolean) =>
      state.update((current) => ({ ...current, showIndianUtilities: enabled })),
    ),
    setUtilityReminders: vi.fn(async (enabled: boolean) =>
      state.update((current) => ({ ...current, utilityReminders: enabled })),
    ),
    setMobileArchived: vi.fn(),
    setLpgArchived: vi.fn(),
  };

  beforeEach(() => {
    mock.saveMobileProfile.mockReset().mockResolvedValue({ id: 'saved-mobile' });
    mock.saveLpgProfile.mockReset().mockResolvedValue({ id: 'saved-lpg' });
    mock.saveRecharge.mockReset().mockResolvedValue({ id: 'saved-recharge' });
    mock.deleteMobileProfile.mockReset().mockResolvedValue(undefined);
    mock.deleteRecharge.mockReset().mockResolvedValue(undefined);
    mock.setMobileArchived.mockClear();
    recharges.set([]);
    state.set({ showIndianUtilities: true, utilityReminders: false });
    mobiles.set([]);
    lpg.set([]);
    TestBed.configureTestingModule({
      imports: [UtilitiesPage],
      providers: [
        { provide: UtilitiesService, useValue: mock },
        { provide: WhatsAppService, useValue: { open: vi.fn(), choose: vi.fn() } },
        { provide: SnackbarService, useValue: { show: vi.fn() } },
      ],
    });
  });

  it('shows the four offline categories and keeps every selection on the custom picker', async () => {
    const fixture = TestBed.createComponent(UtilitiesPage);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.utility-image-card')).toHaveLength(4);
    expect(fixture.nativeElement.textContent).toContain('Coming Soon');
    expect(fixture.nativeElement.querySelector('select')).toBeNull();
    expect(
      [...fixture.nativeElement.querySelectorAll('.utility-image-card img')].map(
        (image: HTMLImageElement) => image.getAttribute('ngSrc'),
      ),
    ).toEqual([
      '/images/utilities-mobile.jpg',
      '/images/utilities-lpg.jpg',
      '/images/utilities-electricity.jpg',
      '/images/utilities-broadband.jpg',
    ]);
    fixture.componentInstance.setSection('GAS');
    fixture.detectChanges();
    expect(fixture.componentInstance.gasServiceOptions.map((option) => option.label)).toEqual([
      'LPG',
      'PNG',
    ]);
    fixture.componentInstance.setGasType('PNG');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('PNG · Coming Soon');
    expect(fixture.nativeElement.textContent).not.toContain('Add LPG connection');
    fixture.destroy();
  });
  it('requires confirmation for recharge and cylinder deletion, preserves Cancel and reports persistence failure', async () => {
    mock.deleteRecharge.mockClear();
    mock.deleteLpgEvent.mockClear();
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    await page.deleteRecharge({
      id: 'recharge',
      profileId: 'mobile',
      startDate: '2026-10-25',
      endDate: '2026-11-24',
      planType: 'VOICE_DATA',
      createdAt: '',
      updatedAt: '',
    });
    expect(mock.deleteRecharge).not.toHaveBeenCalled();
    page.deletion.set(null);
    await page.confirmDeletion();
    expect(mock.deleteRecharge).not.toHaveBeenCalled();
    await page.deleteLpgEvent({
      id: 'cylinder',
      profileId: 'lpg',
      eventDate: '2026-10-25',
      eventType: 'STARTED',
      createdAt: '',
      updatedAt: '',
    });
    mock.deleteLpgEvent.mockRejectedValueOnce(new Error('Disk write failed'));
    await page.confirmDeletion();
    expect(page.deletion()?.id).toBe('cylinder');
    expect(page.error()).toBe('Disk write failed');
    await page.confirmDeletion();
    expect(mock.deleteLpgEvent).toHaveBeenLastCalledWith('cylinder');
    expect(page.deletion()).toBeNull();
    expect(mock.deleteRecharge).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('layers every photo below its scrim and caption with contrast even over a white photo', () => {
    const styles = readFileSync('src/app/features/utilities/utilities.scss', 'utf8');
    expect(styles).toMatch(/\.utility-image-card::after\s*\{[^}]*z-index:\s*1/s);
    expect(styles).toMatch(/\.utility-image-card img\s*\{[^}]*z-index:\s*0/s);
    expect(styles).toMatch(/\.utility-image-card > span\s*\{[^}]*z-index:\s*2/s);
    expect(styles).toContain('outline: 2px solid var(--accent)');
    const rgb = [8, 19, 15].map((channel) => (channel * 0.6 + 255 * 0.4) / 255);
    const linear = rgb.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
  it('adds and edits mobile profiles through the modal, guards duplicate saves and retains errors inside it', async () => {
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    page.startAddMobile();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Add mobile profile');
    await page.saveMobile(new Event('submit'));
    expect(mock.saveMobileProfile).not.toHaveBeenCalled();
    page.mobileForm.controls.personName.setValue('Fiction Alex');
    let release!: (value: { id: string }) => void;
    mock.saveMobileProfile.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const first = page.saveMobile(new Event('submit'));
    await page.saveMobile(new Event('submit'));
    expect(mock.saveMobileProfile).toHaveBeenCalledTimes(1);
    release({ id: 'saved-mobile' });
    await first;
    expect(page.mobileFormOpen()).toBe(false);
    const profile: MobileProfile = {
      id: 'existing',
      kind: 'MOBILE',
      personName: 'Fiction Jamie',
      operator: 'JIO',
      subscriptionType: 'POSTPAID',
      mobileNumber: '9876543210',
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    };
    page.editMobile(profile);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Edit mobile profile');
    expect(page.mobileForm.controls.personName.value).toBe(profile.personName);
    mock.saveMobileProfile.mockRejectedValueOnce(new Error('Synthetic profile failure'));
    await page.saveMobile(new Event('submit'));
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('app-profile-modal [role="alert"]').textContent,
    ).toContain('Synthetic profile failure');
    expect(page.mobileFormOpen()).toBe(true);
    const before = mock.saveMobileProfile.mock.calls.length;
    (
      Array.from(
        fixture.nativeElement.querySelectorAll('app-profile-modal button'),
      ) as HTMLButtonElement[]
    )
      .find((button) => button.textContent?.trim() === 'Cancel')!
      .click();
    fixture.detectChanges();
    expect(page.mobileFormOpen()).toBe(false);
    expect(mock.saveMobileProfile).toHaveBeenCalledTimes(before);
    page.startAddMobile();
    expect(page.mobileForm.controls.personName.value).toBe('');
    fixture.destroy();
  });
  it('adds and edits recharge records in a popup while preserving validation and saved values', async () => {
    const profile: MobileProfile = {
      id: 'mobile-for-recharge',
      kind: 'MOBILE',
      personName: 'Fiction Morgan',
      operator: 'JIO',
      subscriptionType: 'PREPAID',
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    };
    mobiles.set([profile]);
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    const trigger = [...fixture.nativeElement.querySelectorAll('.profile-actions button')].find(
      (button: HTMLButtonElement) => button.textContent?.includes('Add recharge'),
    ) as HTMLButtonElement;
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Add recharge');
    expect(page.rechargeForm.controls.startDate.value).toBeTruthy();
    expect(page.validityMode()).toBe('DAYS');
    page.rechargeForm.controls.amount.setValue('10');
    await page.saveRecharge(new Event('submit'));
    expect(mock.saveRecharge).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: profile.id, amountMinor: 1000, validityDays: 30 }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    page.editRecharge({
      id: 'existing-recharge',
      profileId: profile.id,
      planType: 'DATA_ONLY',
      amountMinor: 25000,
      startDate: '2026-10-01',
      endDate: '2026-10-30',
      comment: 'Synthetic plan note',
      createdAt: 'before',
      updatedAt: 'before',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Edit recharge');
    expect(page.rechargeForm.getRawValue()).toMatchObject({
      planType: 'DATA_ONLY',
      amount: '250',
      startDate: '2026-10-01',
      endDate: '2026-10-30',
      comment: 'Synthetic plan note',
    });
    page.closeRecharge();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).toBeNull();
    fixture.destroy();
  });
  it('shows active and scheduled recharges separately and keeps every expired record in history', async () => {
    const profile: MobileProfile = {
      id: 'history-mobile',
      kind: 'MOBILE',
      personName: 'Fiction History',
      operator: 'JIO',
      subscriptionType: 'PREPAID',
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    };
    mobiles.set([profile]);
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    const today = page.today;
    const plan = (
      id: string,
      startDate: string,
      endDate: string,
      planType: MobileRecharge['planType'] = 'VOICE_DATA',
    ): MobileRecharge => ({
      id,
      profileId: profile.id,
      planType,
      startDate,
      endDate,
      amountMinor: 12345,
      comment: id,
      createdAt: 'before',
      updatedAt: 'before',
    });
    const expired = plan(
      'expired-only-record',
      addCalendarDays(today, -30),
      addCalendarDays(today, -1),
    );
    recharges.set([
      expired,
      plan('active-voice', today, addCalendarDays(today, 10)),
      plan('active-data', today, today, 'DATA_ONLY'),
      plan('future-plan', addCalendarDays(today, 11), addCalendarDays(today, 40)),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    const main = fixture.nativeElement.querySelector('.mobile-profile') as HTMLElement;
    expect(main.querySelectorAll('.active-recharges li')).toHaveLength(2);
    expect(main.querySelectorAll('.scheduled-recharges li')).toHaveLength(1);
    expect(main.textContent).not.toContain(expired.comment);
    const historyTrigger = [...main.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Recharge history'),
    )!;
    historyTrigger.focus();
    historyTrigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.recharge-history li')).toHaveLength(4);
    expect(fixture.nativeElement.querySelector('.recharge-history').textContent).toContain(
      'Expired',
    );
    expect(fixture.nativeElement.querySelector('.recharge-history').textContent).toContain(
      'Scheduled',
    );
    expect(fixture.nativeElement.querySelector('.recharge-history').textContent).toContain(
      'Active',
    );
    (
      fixture.nativeElement.querySelector(
        `[aria-label="Edit recharge starting ${expired.startDate}"]`,
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.rechargeHistoryProfileId()).toBe(profile.id);
    expect(page.editingRechargeId()).toBe(expired.id);
    expect(page.rechargeForm.getRawValue()).toMatchObject({
      startDate: expired.startDate,
      endDate: expired.endDate,
      amount: '123.45',
      comment: expired.comment,
    });
    expect(fixture.nativeElement.querySelector('.recharge-history')).toBeNull();
    page.closeRecharge();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.recharge-history li')).toHaveLength(4);
    expect(document.activeElement?.id).toBe('recharge-history-edit-' + expired.id);
    await page.deleteRecharge(expired);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-confirmation-dialog')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-profile-modal')).toBeNull();
    await page.confirmDeletion();
    expect(mock.deleteRecharge).toHaveBeenCalledWith(expired.id);
    expect(recharges()).toHaveLength(4);
    page.closeRechargeHistory();
    recharges.set([expired]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(historyTrigger);
    expect(main.textContent).toContain('No active recharge recorded');
    expect(main.textContent).not.toContain(expired.comment);
    fixture.destroy();
  });

  it('keeps recharge drafts and dialog context on failed saves and blocks dismissal or duplicate submissions while saving', async () => {
    const profile: MobileProfile = {
      id: 'draft-mobile',
      kind: 'MOBILE',
      personName: 'Fiction Draft',
      operator: 'JIO',
      subscriptionType: 'PREPAID',
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    };
    mobiles.set([profile]);
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    page.startRecharge(profile);
    fixture.detectChanges();
    await fixture.whenStable();
    page.rechargeForm.patchValue({ amount: '250', comment: 'Keep my draft' });
    let reject!: (error: Error) => void;
    mock.saveRecharge.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const save = page.saveRecharge(new Event('submit'));
    await page.saveRecharge(new Event('submit'));
    fixture.detectChanges();
    const modal = fixture.debugElement.query(By.directive(ProfileModal))
      .componentInstance as ProfileModal;
    const closed = vi.spyOn(modal.closed, 'emit');
    modal.cancel(new Event('cancel', { cancelable: true }));
    modal.back(new Event('cardnest:back', { cancelable: true }));
    page.closeRecharge();
    expect(closed).not.toHaveBeenCalled();
    expect(page.rechargeProfileId()).toBe(profile.id);
    expect(mock.saveRecharge).toHaveBeenCalledTimes(1);
    reject(new Error('Synthetic recharge write failure'));
    await save;
    fixture.detectChanges();
    expect(page.rechargeProfileId()).toBe(profile.id);
    expect(page.rechargeForm.getRawValue()).toMatchObject({
      amount: '250',
      comment: 'Keep my draft',
    });
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'Synthetic recharge write failure',
    );
    await page.saveRecharge(new Event('submit'));
    expect(page.rechargeProfileId()).toBeNull();
    fixture.destroy();
  });

  it.each([false, true])(
    'confirms permanent mobile deletion with dependent count and keeps archive separate (archived=%s)',
    async (archived) => {
      const profile: MobileProfile = {
        id: 'delete-mobile',
        kind: 'MOBILE',
        personName: 'Fiction Delete',
        operator: 'JIO',
        subscriptionType: 'PREPAID',
        archived,
        createdAt: 'before',
        updatedAt: 'before',
      };
      mobiles.set([profile]);
      recharges.set(
        [1, 2].map((number) => ({
          id: `dependent-${number}`,
          profileId: profile.id,
          planType: 'VOICE_DATA',
          startDate: '2026-10-01',
          endDate: '2026-10-30',
          createdAt: 'before',
          updatedAt: 'before',
        })),
      );
      const fixture = TestBed.createComponent(UtilitiesPage);
      const page = fixture.componentInstance;
      fixture.detectChanges();
      await fixture.whenStable();
      const button = fixture.nativeElement.querySelector('.delete-mobile') as HTMLButtonElement;
      expect(button).not.toBeNull();
      button.click();
      fixture.detectChanges();
      expect(page.deletion()?.message).toContain('Fiction Delete');
      expect(page.deletion()?.message).toContain('all 2 saved recharge records');
      expect(page.deletion()?.message).toContain('permanently deleted');
      expect(mock.deleteMobileProfile).not.toHaveBeenCalled();
      page.deletion.set(null);
      await page.confirmDeletion();
      expect(mock.deleteMobileProfile).not.toHaveBeenCalled();
      page.requestMobileDeletion(profile);
      mock.deleteMobileProfile.mockRejectedValueOnce(new Error('Synthetic deletion failure'));
      await page.confirmDeletion();
      expect(page.deletion()?.id).toBe(profile.id);
      expect(page.error()).toBe('Synthetic deletion failure');
      await page.confirmDeletion();
      expect(mock.deleteMobileProfile).toHaveBeenLastCalledWith(profile.id);
      expect(page.deletion()).toBeNull();
      expect(mock.setMobileArchived).not.toHaveBeenCalled();
      fixture.destroy();
    },
  );

  it('uses the same popup for LPG creation and editing without changing cylinder-event controls', async () => {
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    page.setSection('GAS');
    page.startAddLpg();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog')).not.toBeNull();
    page.lpgForm.controls.connectionName.setValue('Fiction kitchen');
    await page.saveLpg(new Event('submit'));
    expect(mock.saveLpgProfile).toHaveBeenCalledTimes(1);
    expect(page.lpgFormOpen()).toBe(false);
    page.editLpg({
      id: 'connection',
      kind: 'LPG',
      connectionName: 'Existing kitchen',
      provider: 'INDANE',
      commercial: false,
      cylinderSize: 'NORMAL',
      estimatedUsageDays: 25,
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.editingLpgId()).toBe('connection');
    expect(fixture.nativeElement.textContent).toContain('Edit LPG connection');
    expect(page.lpgForm.controls.connectionName.value).toBe('Existing kitchen');
    fixture.destroy();
  });

  it('shows the disabled direct-route state without clearing profile signals', async () => {
    const retainedMobile = [{ id: 'kept-mobile' }];
    mobiles.set(retainedMobile);
    state.set({ showIndianUtilities: false, utilityReminders: true });
    const fixture = TestBed.createComponent(UtilitiesPage);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Indian Utilities is hidden');
    expect(fixture.nativeElement.textContent).toContain('Enable Indian Utilities');
    expect(mobiles()).toEqual(retainedMobile);
    expect(fixture.nativeElement.querySelector('.utility-category-grid')).toBeNull();
    fixture.destroy();
  });

  it('refreshes mobile and LPG statuses across midnight in India without reloading the page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T18:29:00Z'));
    const fixture = TestBed.createComponent(UtilitiesPage);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    const mobile = { id: 'midnight-mobile', subscriptionType: 'PREPAID' } as MobileProfile;
    const lpg = { id: 'midnight-lpg', estimatedUsageDays: 25 } as LpgProfile;
    expect(page.today).toBe('2026-10-25');
    expect(page.statusLabel(mobile)).toBe('Active');
    expect(page.lpgDaysToCheck(lpg)).toBe(0);

    vi.setSystemTime(new Date('2026-10-25T18:31:00Z'));
    await vi.advanceTimersByTimeAsync(60_000);
    fixture.detectChanges();
    expect(page.today).toBe('2026-10-26');
    expect(page.statusLabel(mobile)).toBe('No active subscription');
    expect(page.lpgDaysToCheck(lpg)).toBe(-1);
    fixture.destroy();
    vi.useRealTimers();
  });
});
