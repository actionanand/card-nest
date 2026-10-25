import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { UtilitiesPage } from './utilities';
import { UtilitiesService } from './utilities.service';
import { WhatsAppService } from './whatsapp.service';
import { SnackbarService } from '../../core/services/snackbar.service';
import { mobileActivitySummary, lpgUsageSummary } from './utilities-calculations';
import { LpgProfile, MobileProfile } from './utilities-model';

describe('Indian Utilities page', () => {
  const state = signal({ showIndianUtilities: true, utilityReminders: false });
  const mobiles = signal<readonly { id: string }[]>([]);
  const lpg = signal<readonly never[]>([]);
  const mock = {
    settings: state,
    showIndianUtilities: computed(() => state().showIndianUtilities),
    utilityReminders: computed(() => state().utilityReminders),
    mobileProfiles: mobiles,
    mobileRecharges: signal<readonly never[]>([]),
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
    rechargesFor: () => [],
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
