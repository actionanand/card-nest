import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { UtilitiesPage } from './utilities';
import { UtilitiesService } from './utilities.service';
import { WhatsAppService } from './whatsapp.service';
import { SnackbarService } from '../../core/services/snackbar.service';
import { addCalendarDays, mobileActivitySummary, lpgUsageSummary } from './utilities-calculations';
import {
  LpgEvent,
  LpgProfile,
  MobileProfile,
  MobileRecharge,
  TvProfile,
  TvRecharge,
} from './utilities-model';
import { ProfileModal } from '../../shared/profile-modal';
import { By } from '@angular/platform-browser';
import { readFileSync } from 'node:fs';

describe('Indian Utilities page', () => {
  const timestamp = '2026-11-11T12:00:00.000Z';
  const state = signal({ showIndianUtilities: true, utilityReminders: false });
  const mobiles = signal<readonly { id: string }[]>([]);
  const lpg = signal<readonly LpgProfile[]>([]);
  const lpgEvents = signal<readonly LpgEvent[]>([]);
  const recharges = signal<readonly MobileRecharge[]>([]);
  const tvProfiles = signal<readonly TvProfile[]>([]);
  const tvRecharges = signal<readonly TvRecharge[]>([]);
  const tvProviderOptions = [
    { value: 'SUN', label: 'Sun' },
    { value: 'OTHER', label: 'Other' },
  ];
  const snackbar = { show: vi.fn() };
  const mock = {
    deleteMobileProfile: vi.fn().mockResolvedValue(undefined),
    deleteRecharge: vi.fn().mockResolvedValue(undefined),
    deleteLpgEvent: vi.fn().mockResolvedValue(undefined),
    deleteLpgProfile: vi.fn().mockResolvedValue(undefined),
    saveLpgEvent: vi.fn().mockResolvedValue({ id: 'saved-event' }),
    saveRecharge: vi.fn().mockResolvedValue({ id: 'saved-recharge' }),
    saveMobileProfile: vi.fn().mockResolvedValue({ id: 'saved-mobile' }),
    saveLpgProfile: vi.fn().mockResolvedValue({ id: 'saved-lpg' }),
    saveTvProfile: vi.fn(),
    saveTvRecharge: vi.fn(),
    deleteTvProfile: vi.fn().mockResolvedValue(undefined),
    deleteTvRecharge: vi.fn().mockResolvedValue(undefined),
    setTvArchived: vi.fn().mockResolvedValue(undefined),
    settings: state,
    showIndianUtilities: computed(() => state().showIndianUtilities),
    utilityReminders: computed(() => state().utilityReminders),
    mobileProfiles: mobiles,
    mobileRecharges: recharges,
    lpgProfiles: lpg,
    lpgEvents,
    tvProfiles,
    tvRechargesFor: (profileId: string) =>
      tvRecharges().filter((row) => row.profileId === profileId),
    tvProviderOptions,
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
    mobilePlanOptions: [
      { value: 'VOICE_DATA', label: 'Voice + Data' },
      { value: 'VOICE_ONLY', label: 'Voice Only' },
      { value: 'DATA_ONLY', label: 'Data only' },
    ],
    lpgProviderOptions: [{ value: 'HPCL', label: 'HPCL' }],
    cylinderOptions: [{ value: 'NORMAL', label: 'Normal' }],
    lpgEventOptions: [
      { value: 'STARTED', label: 'Cylinder installed / started using' },
      { value: 'EMPTY', label: 'Cylinder became empty' },
      { value: 'REFILL_RECEIVED', label: 'Refill / replacement received' },
    ],
    rechargesFor: (profileId: string) => recharges().filter((row) => row.profileId === profileId),
    suggestedRechargeStart: () => '2026-10-28',
    eventsFor: (profileId: string) => lpgEvents().filter((event) => event.profileId === profileId),
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
    mock.saveTvProfile.mockReset();
    mock.saveTvRecharge.mockReset();
    mock.deleteTvProfile.mockReset().mockResolvedValue(undefined);
    mock.deleteTvRecharge.mockReset().mockResolvedValue(undefined);
    mock.setTvArchived.mockReset().mockResolvedValue(undefined);
    snackbar.show.mockReset();
    mock.saveRecharge.mockReset().mockResolvedValue({ id: 'saved-recharge' });
    mock.deleteMobileProfile.mockReset().mockResolvedValue(undefined);
    mock.deleteRecharge.mockReset().mockResolvedValue(undefined);
    mock.setMobileArchived.mockClear();
    recharges.set([]);
    tvProfiles.set([]);
    tvRecharges.set([]);
    state.set({ showIndianUtilities: true, utilityReminders: false });
    mobiles.set([]);
    lpg.set([]);
    lpgEvents.set([]);
    mock.saveLpgEvent.mockReset().mockResolvedValue({ id: 'saved-event' });
    mock.deleteLpgProfile.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      imports: [UtilitiesPage],
      providers: [
        { provide: UtilitiesService, useValue: mock },
        { provide: WhatsAppService, useValue: { open: vi.fn(), choose: vi.fn() } },
        { provide: SnackbarService, useValue: snackbar },
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
      'images/utilities-mobile.jpg',
      'images/utilities-lpg.jpg',
      'images/utilities-electricity.jpg',
      'images/utilities-broadband.jpg',
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
  it('prefers the active TV recharge over a future one and reports scheduled, expired and same-day states', async () => {
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    const profile: TvProfile = {
      id: 'synthetic-tv',
      kind: 'TV',
      displayName: 'Living room',
      provider: 'SUN',
      archived: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const today = page.today;
    const current: TvRecharge = {
      id: 'tv-current',
      profileId: profile.id,
      amountMinor: 25000,
      startDate: addCalendarDays(today, -10),
      endDate: addCalendarDays(today, 19),
      durationDays: 30,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const scheduled: TvRecharge = {
      ...current,
      id: 'tv-scheduled',
      startDate: addCalendarDays(today, 20),
      endDate: addCalendarDays(today, 50),
      durationDays: 31,
    };
    tvProfiles.set([profile]);
    tvRecharges.set([scheduled, current]);
    fixture.detectChanges();
    page.setSection('TV');
    fixture.detectChanges();
    expect(page.currentTvRecharge(profile)?.id).toBe(current.id);
    expect(page.scheduledTvRecharge(profile)?.id).toBe(scheduled.id);
    expect(page.latestTvRecharge(profile)?.id).toBe(current.id);
    expect(page.tvProfileStatus(profile)).toBe('Active');
    expect(page.tvRechargePeriod(profile)).toBe('19 days remaining');
    const [year, month, day] = scheduled.startDate.split('-');
    expect(fixture.nativeElement.textContent).toContain(
      `Next recharge scheduled: ${day}-${month}-${year}`,
    );

    tvRecharges.set([scheduled]);
    expect(page.tvProfileStatus(profile)).toBe('Scheduled');
    expect(page.tvRechargePeriod(profile)).toContain('Scheduled · starts in 20 days');

    tvRecharges.set([{ ...current, id: 'tv-same-day', endDate: today }]);
    expect(page.tvProfileStatus(profile)).toBe('Active');
    expect(page.tvRechargePeriod(profile)).toBe('0 days remaining');

    tvRecharges.set([{ ...current, id: 'tv-expired', endDate: addCalendarDays(today, -1) }]);
    expect(page.tvProfileStatus(profile)).toBe('Expired');
    expect(page.tvRechargePeriod(profile)).toBe('Expired 1 days ago');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    fixture.destroy();
  });

  it('closes TV profile and recharge popups only after successful saves and preserves failed drafts', async () => {
    const profile: TvProfile = {
      id: 'tv-save-lifecycle',
      kind: 'TV',
      displayName: 'Synthetic television',
      provider: 'SUN',
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const recharge: TvRecharge = {
      id: 'tv-recharge-lifecycle',
      profileId: profile.id,
      amountMinor: 12300,
      startDate: '2026-11-12',
      endDate: '2026-12-11',
      durationDays: 30,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    mock.saveTvProfile
      .mockRejectedValueOnce(new Error('Synthetic TV profile write failure'))
      .mockResolvedValueOnce(profile);
    page.startAddTvProfile();
    page.tvForm.patchValue({ displayName: profile.displayName });
    fixture.detectChanges();
    await page.saveTvProfile(new Event('submit'));
    fixture.detectChanges();
    expect(page.tvProfileFormOpen()).toBe(true);
    expect(page.tvForm.controls.displayName.value).toBe(profile.displayName);
    expect(fixture.nativeElement.textContent).toContain('Synthetic TV profile write failure');
    await page.saveTvProfile(new Event('submit'));
    fixture.detectChanges();
    expect(page.tvProfileFormOpen()).toBe(false);
    expect(page.saving()).toBe(false);

    tvProfiles.set([profile]);
    mock.saveTvRecharge
      .mockRejectedValueOnce(new Error('Synthetic TV recharge write failure'))
      .mockResolvedValueOnce(recharge);
    page.startTvRecharge(profile);
    page.tvRechargeForm.patchValue({ amount: '123', startDate: recharge.startDate });
    fixture.detectChanges();
    await page.saveTvRecharge(new Event('submit'));
    fixture.detectChanges();
    expect(page.tvRechargeProfileId()).toBe(profile.id);
    expect(page.tvRechargeForm.controls.amount.value).toBe('123');
    expect(fixture.nativeElement.textContent).toContain('Synthetic TV recharge write failure');
    await page.saveTvRecharge(new Event('submit'));
    fixture.detectChanges();
    expect(page.tvRechargeProfileId()).toBeNull();
    expect(page.editingTvRechargeId()).toBeNull();
    expect(page.saving()).toBe(false);
    expect(snackbar.show).toHaveBeenCalledWith('TV profile saved.');
    expect(snackbar.show).toHaveBeenCalledWith('TV recharge record saved.');
    fixture.destroy();
  });

  it('limits displayed TV recharge history to ten without trimming stored records', () => {
    const profile: TvProfile = {
      id: 'tv-history-limit',
      kind: 'TV',
      displayName: 'Synthetic history profile',
      provider: 'SUN',
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const records: TvRecharge[] = Array.from({ length: 12 }, (_, index) => ({
      id: `tv-history-${index}`,
      profileId: profile.id,
      startDate: `2026-${String(12 - index).padStart(2, '0')}-01`,
      endDate: `2026-${String(12 - index).padStart(2, '0')}-20`,
      durationDays: 20,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    tvProfiles.set([profile]);
    tvRecharges.set(records);
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    page.setSection('TV');
    fixture.detectChanges();
    expect(page.tvProfileRecharges(profile)).toHaveLength(12);
    expect(page.tvRechargeHistory(profile)).toHaveLength(10);
    expect(fixture.nativeElement.textContent).toContain('Recharge history (12)');
    expect(fixture.nativeElement.textContent).toContain(
      'Showing the 10 most recent of 12 records.',
    );
    fixture.destroy();
  });

  it('requires confirmation before archiving or restoring utility profiles', async () => {
    const profile: MobileProfile = {
      id: 'archive-mobile-profile',
      kind: 'MOBILE',
      personName: 'Synthetic mobile',
      operator: 'JIO',
      subscriptionType: 'PREPAID',
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    };
    mobiles.set([profile]);
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    page.archiveMobile(profile);
    expect(mock.setMobileArchived).not.toHaveBeenCalled();
    expect(page.deletion()?.kind).toBe('MOBILE_ARCHIVE');
    page.cancelDeletion();
    expect(mock.setMobileArchived).not.toHaveBeenCalled();
    page.requestMobileArchive(profile, true);
    await page.confirmDeletion();
    expect(mock.setMobileArchived).toHaveBeenCalledWith(profile.id, true);
    expect(page.deletion()).toBeNull();
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
  it('clones the latest eligible voice recharge into a fresh editable India-today draft', async () => {
    const profile: MobileProfile = {
      id: 'clone-mobile',
      kind: 'MOBILE',
      personName: 'Fiction Clone',
      operator: 'JIO',
      subscriptionType: 'PREPAID',
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    };
    const dataOnlyProfile = { ...profile, id: 'data-only-mobile', personName: 'Fiction Data' };
    mobiles.set([profile, dataOnlyProfile]);
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    const today = page.today;
    const source = {
      id: 'eligible-voice-data',
      profileId: profile.id,
      planType: 'VOICE_DATA' as const,
      amountMinor: 34900,
      startDate: addCalendarDays(today, -28),
      endDate: addCalendarDays(today, -1),
      comment: 'Synthetic eligible plan',
      createdAt: `${today}T10:00:00Z`,
      updatedAt: `${today}T10:00:00Z`,
    };
    recharges.set([
      {
        ...source,
        id: 'older-voice',
        planType: 'VOICE_ONLY',
        amountMinor: 19900,
        startDate: addCalendarDays(today, -60),
        endDate: addCalendarDays(today, -33),
        createdAt: `${today}T09:00:00Z`,
      },
      source,
      {
        ...source,
        id: 'newer-data-only',
        profileId: dataOnlyProfile.id,
        planType: 'DATA_ONLY',
        startDate: addCalendarDays(today, -2),
        endDate: addCalendarDays(today, 27),
      },
      {
        ...source,
        id: 'future-voice',
        planType: 'VOICE_ONLY',
        startDate: addCalendarDays(today, 1),
        endDate: addCalendarDays(today, 28),
      },
    ]);
    fixture.detectChanges();
    expect(page.cloneRechargeSource(profile)?.id).toBe(source.id);
    const profiles = Array.from(
      fixture.nativeElement.querySelectorAll('.mobile-profile'),
    ) as HTMLElement[];
    const cloneCard = profiles.find((item) => item.textContent?.includes(profile.personName))!;
    const dataCard = profiles.find((item) =>
      item.textContent?.includes(dataOnlyProfile.personName),
    )!;
    const cloneButton = Array.from(cloneCard.querySelectorAll('.profile-actions button'))
      .map((button) => button as HTMLButtonElement)
      .find((button) => button.textContent?.includes('Clone Recharge'));
    expect(cloneButton).toBeDefined();
    expect(dataCard.textContent).not.toContain('Clone Recharge');

    cloneButton!.click();
    fixture.detectChanges();
    expect(page.editingRechargeId()).toBeNull();
    expect(page.rechargeForm.getRawValue()).toMatchObject({
      planType: 'VOICE_DATA',
      amount: '349',
      startDate: today,
      validityDays: '28',
      comment: 'Synthetic eligible plan',
    });
    expect(fixture.nativeElement.textContent).not.toContain('Another');
    expect(mock.saveRecharge).not.toHaveBeenCalled();

    await page.saveRecharge(new Event('submit'));
    expect(mock.saveRecharge).toHaveBeenCalledWith({
      id: undefined,
      profileId: profile.id,
      planType: 'VOICE_DATA',
      amountMinor: 34900,
      startDate: today,
      validityDays: 28,
      endDate: undefined,
      comment: 'Synthetic eligible plan',
    });
    expect(recharges().find((item) => item.id === source.id)).toEqual(source);
    fixture.destroy();
  });

  it('warns before saving a clone when a same-profile plan already starts today', () => {
    const profile: MobileProfile = {
      id: 'duplicate-clone-mobile',
      kind: 'MOBILE',
      personName: 'Fiction Duplicate',
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
    recharges.set([
      {
        id: 'voice-starting-today',
        profileId: profile.id,
        planType: 'VOICE_ONLY',
        amountMinor: 12000,
        startDate: today,
        endDate: addCalendarDays(today, 27),
        createdAt: `${today}T10:00:00Z`,
        updatedAt: `${today}T10:00:00Z`,
      },
    ]);
    fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('.mobile-profile') as HTMLElement;
    const cloneButton = [...card.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Clone Recharge'),
    ) as HTMLButtonElement;
    cloneButton.click();
    fixture.detectChanges();
    expect(page.cloneDuplicateWarning()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain(
      'Another VOICE ONLY recharge already starts today.',
    );
    expect(mock.saveRecharge).not.toHaveBeenCalled();
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

  it('uses LPG event popups, disables invalid choices, retains errors and guards repeated saves', async () => {
    const profile: LpgProfile = {
      id: 'lpg-dialog',
      kind: 'LPG',
      connectionName: 'Fiction kitchen',
      provider: 'INDANE',
      commercial: true,
      cylinderSize: 'SMALL',
      estimatedUsageDays: 25,
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    };
    lpg.set([profile]);
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    page.setSection('GAS');
    fixture.detectChanges();
    await fixture.whenStable();
    const buttons = [
      ...fixture.nativeElement.querySelectorAll('.lpg-profile button'),
    ] as HTMLButtonElement[];
    expect(buttons.find((button) => button.textContent?.includes('Record empty'))!.disabled).toBe(
      true,
    );
    expect(fixture.nativeElement.textContent).toContain('Commercial');
    expect(fixture.nativeElement.textContent).toContain('Small cylinder');
    expect(page.lpgStatus(profile)).toBe('No cylinder started');
    page.startLpgEvent(profile);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.lpg-event-form').textContent).toContain(
      'Fiction kitchen',
    );
    expect(page.lpgEventOptions().find((option) => option.value === 'EMPTY')?.disabled).toBe(true);
    page.lpgEventForm.controls.eventType.setValue('EMPTY');
    await page.saveLpgEvent(new Event('submit'));
    expect(mock.saveLpgEvent).not.toHaveBeenCalled();
    page.lpgEventForm.patchValue({ eventType: 'STARTED', comment: 'Keep event draft' });
    let reject!: (error: Error) => void;
    mock.saveLpgEvent.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = page.saveLpgEvent(new Event('submit'));
    await page.saveLpgEvent(new Event('submit'));
    page.closeLpgEvent();
    expect(page.lpgEventProfileId()).toBe(profile.id);
    expect(mock.saveLpgEvent).toHaveBeenCalledTimes(1);
    reject(new Error('Synthetic LPG save failure'));
    await pending;
    fixture.detectChanges();
    expect(page.lpgEventForm.controls.comment.value).toBe('Keep event draft');
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'Synthetic LPG save failure',
    );
    await page.saveLpgEvent(new Event('submit'));
    expect(page.lpgEventProfileId()).toBeNull();
    lpgEvents.set([
      {
        id: 'started',
        profileId: profile.id,
        eventType: 'STARTED',
        eventDate: page.today,
        // Recorded before now: `${today}T00:00:00Z` is in the future during 18:30–24:00 UTC.
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: 'before',
      },
    ]);
    fixture.detectChanges();
    expect(page.canRecordLpgEvent(profile, 'STARTED')).toBe(false);
    expect(page.canRecordLpgEvent(profile, 'REFILL_RECEIVED')).toBe(false);
    expect(page.canRecordLpgEvent(profile, 'EMPTY')).toBe(true);
    fixture.destroy();
  });

  it.each([false, true])(
    'keeps complete LPG history and confirmed connection deletion available (archived=%s)',
    async (archived) => {
      const profile: LpgProfile = {
        id: 'lpg-history',
        kind: 'LPG',
        connectionName: 'History kitchen',
        provider: 'HPCL',
        commercial: false,
        cylinderSize: 'NORMAL',
        estimatedUsageDays: 25,
        archived,
        createdAt: 'before',
        updatedAt: 'before',
      };
      lpg.set([profile]);
      const events: LpgEvent[] = [
        {
          id: 'start',
          profileId: profile.id,
          eventType: 'STARTED',
          eventDate: '2026-09-01',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: 'before',
          comment: 'Old start note',
        },
        {
          id: 'empty',
          profileId: profile.id,
          eventType: 'EMPTY',
          eventDate: '2026-09-20',
          createdAt: '2026-09-20T00:00:00Z',
          updatedAt: 'before',
        },
        {
          id: 'receipt',
          profileId: profile.id,
          eventType: 'REFILL_RECEIVED',
          eventDate: '2026-09-22',
          createdAt: '2026-09-22T00:00:00Z',
          updatedAt: 'before',
          amountMinor: 95000,
          cylinderSize: 'NORMAL',
          comment: 'Receipt note',
        },
      ];
      lpgEvents.set(events);
      const fixture = TestBed.createComponent(UtilitiesPage);
      const page = fixture.componentInstance;
      page.setSection('GAS');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.lpg-profile .history-list')).toBeNull();
      const trigger = [...fixture.nativeElement.querySelectorAll('button')].find(
        (button: HTMLButtonElement) => button.textContent?.includes('Cylinder history'),
      ) as HTMLButtonElement;
      trigger.focus();
      trigger.click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelectorAll('.lpg-history li')).toHaveLength(3);
      expect(fixture.nativeElement.querySelector('.lpg-history').textContent).toContain(
        'Old start note',
      );
      if (!archived) {
        page.editLpgEvent(events[2]);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(page.editingLpgEventId()).toBe('receipt');
        expect(page.lpgEventForm.getRawValue()).toMatchObject({
          amount: '950',
          eventDate: '2026-09-22',
          comment: 'Receipt note',
        });
        page.closeLpgEvent();
        fixture.detectChanges();
        await fixture.whenStable();
        expect(document.activeElement?.id).toBe('lpg-history-edit-receipt');
      } else {
        expect(
          (fixture.nativeElement.querySelector('#lpg-history-edit-receipt') as HTMLButtonElement)
            .disabled,
        ).toBe(true);
      }
      await page.deleteLpgEvent(events[0]);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-profile-modal')).toBeNull();
      page.cancelDeletion();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(document.activeElement?.matches(':disabled')).toBe(false);
      page.closeLpgHistory();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(document.activeElement).toBe(trigger);
      page.requestLpgDeletion(profile);
      expect(page.deletion()?.message).toContain('History kitchen (HPCL)');
      expect(page.deletion()?.message).toContain('all 3 saved cylinder events');
      mock.deleteLpgProfile.mockRejectedValueOnce(new Error('Synthetic connection failure'));
      await page.confirmDeletion();
      expect(page.deletion()?.id).toBe(profile.id);
      await page.confirmDeletion();
      expect(mock.deleteLpgProfile).toHaveBeenLastCalledWith(profile.id);
      expect(page.deletion()).toBeNull();
      expect(lpgEvents()).toEqual(events);
      fixture.destroy();
    },
  );

  it('clears stale recharge focus when changing profiles and explains expired-only plans', async () => {
    const first: MobileProfile = {
      id: 'first-mobile',
      kind: 'MOBILE',
      personName: 'First',
      operator: 'JIO',
      subscriptionType: 'PREPAID',
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    };
    const second = { ...first, id: 'second-mobile', personName: 'Second', archived: true };
    mobiles.set([first, second]);
    recharges.set(
      [first, second].map((profile) => ({
        id: profile.id + '-plan',
        profileId: profile.id,
        planType: 'VOICE_DATA',
        startDate: '2026-01-01',
        endDate: '2026-01-30',
        createdAt: 'before',
        updatedAt: 'before',
      })),
    );
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Previous plans remain available through Recharge history',
    );
    page.openRechargeHistory(first);
    page.editRecharge(recharges()[0]);
    page.closeRecharge();
    page.closeRechargeHistory();
    page.openRechargeHistory(second);
    fixture.detectChanges();
    await fixture.whenStable();
    await page.deleteRecharge(recharges()[1]);
    page.cancelDeletion();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement?.matches(':disabled')).toBe(false);
    expect(document.activeElement?.closest('.recharge-history')).not.toBeNull();
    fixture.destroy();
  });

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

  it('shows optional LPG mobile validation after blur or submit and clears it when corrected', async () => {
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    page.setSection('GAS');
    page.startAddLpg();
    page.lpgForm.controls.connectionName.setValue('Fiction kitchen');
    page.lpgForm.controls.mobileNumber.setValue('1234567890');
    page.lpgForm.controls.mobileNumber.markAsTouched();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Enter exactly 10 digits starting with 6, 7, 8 or 9',
    );
    const save = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.includes('Save connection'),
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await page.saveLpg(new Event('submit'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
    expect(mock.saveLpgProfile).not.toHaveBeenCalled();
    page.lpgForm.controls.mobileNumber.setValue('9876543210');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Enter exactly 10 digits');
    expect(page.lpgForm.controls.mobileNumber.valid).toBe(true);
    page.lpgForm.controls.mobileNumber.setValue('');
    expect(page.lpgForm.controls.mobileNumber.valid).toBe(true);
    fixture.destroy();
  });

  it('uses a fixed +91 ten-digit linked mobile while keeping distributor contacts international', async () => {
    const fixture = TestBed.createComponent(UtilitiesPage);
    const page = fixture.componentInstance;
    page.setSection('GAS');
    page.startAddLpg();
    fixture.detectChanges();
    await fixture.whenStable();
    const mobile = fixture.nativeElement.querySelector(
      'input[formControlName="mobileNumber"]',
    ) as HTMLInputElement;
    expect(mobile.maxLength).toBe(10);
    expect(mobile.parentElement?.textContent).toContain('+91');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => '+91 98765 43210' },
    });
    mobile.dispatchEvent(paste);
    expect(page.lpgForm.controls.mobileNumber.value).toBe('9876543210');

    page.lpgForm.patchValue({
      distributorContact: '+1 (800) 555-0199',
      distributorWhatsApp: '1800-123-4567',
    });
    expect(page.lpgForm.controls.distributorContact.valid).toBe(true);
    expect(page.lpgForm.controls.distributorWhatsApp.valid).toBe(true);
    expect(page.hasWhatsAppNumber('+44 20 7946 0958')).toBe(true);
    expect(page.hasWhatsAppNumber('Call 1800-123-4567')).toBe(false);
    const longContact = '1800-1234-5678-9012-3456';
    page.editLpg({
      id: 'long-contact',
      kind: 'LPG',
      connectionName: 'Fictional contact',
      provider: 'INDANE',
      commercial: false,
      cylinderSize: 'NORMAL',
      estimatedUsageDays: 25,
      archived: false,
      distributorContact: longContact,
      distributorWhatsApp: longContact,
      createdAt: 'before',
      updatedAt: 'before',
    });
    fixture.detectChanges();
    const contact = fixture.nativeElement.querySelector(
      'input[formControlName="distributorContact"]',
    ) as HTMLInputElement;
    expect(contact.maxLength).toBe(80);
    expect(contact.value).toBe(longContact);
    contact.value = '+44 (20) 7946-0958';
    contact.dispatchEvent(new Event('input', { bubbles: true }));
    expect(page.lpgForm.controls.distributorContact.value).toBe('+44 (20) 7946-0958');
    expect(page.hasWhatsAppNumber(longContact)).toBe(false);
    expect(page.lpgForm.controls.distributorWhatsApp.valid).toBe(true);
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
