import { ProfileModal } from '../../shared/profile-modal';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { PlatformTools } from '../../shared/platform-tools';
import { Capacitor } from '@capacitor/core';
import { finalThree, profileSuffix, normalizedBank } from './bank-activity-matching';
import { BankActivityCandidate } from './bank-activity-model';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Component, computed, inject, signal, effect } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { AppIcon } from '../../shared/app-icon';
import { CardNestStore } from '../../core/services/card-nest-store';
import { IndiaTodayClock } from '../../core/services/india-date';
import { BankActivityEvent, BankActivityProfile } from './bank-activity-model';
import { BankActivityService } from './bank-activity.service';

@Component({
  selector: 'app-bank-activity-page',
  imports: [
    ProfileModal,
    ConfirmationDialog,
    PlatformTools,
    ReactiveFormsModule,
    AppIcon,
    AppSelectPicker,
  ],
  templateUrl: './bank-activity.html',
  styleUrl: './bank-activity.scss',
})
export class BankActivityPage {
  readonly activity = inject(BankActivityService);
  readonly store = inject(CardNestStore);
  private readonly dateClock = inject(IndiaTodayClock);
  readonly profileFormOpen = signal(false);
  readonly eventProfileId = signal<string | null>(null);
  readonly editingProfileId = signal<string | null>(null);
  readonly editingEventId = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly android = Capacitor.getPlatform() === 'android';
  readonly discoveryNotice = signal('');
  readonly mismatchAcknowledged = signal<Readonly<Record<string, boolean>>>({});
  readonly confirmation = signal<{
    fingerprint: string;
    profileId: string;
    acknowledged: boolean;
    message: string;
  } | null>(null);
  readonly discoveries = computed(() => {
    const groups = new Map<
      string,
      { id: string; bankName: string; accountSuffix?: string; events: BankActivityCandidate[] }
    >();
    for (const candidate of this.activity.candidates()) {
      const match = this.activity.match(candidate);
      if (['UNIQUE', 'AMBIGUOUS', 'ARCHIVED'].includes(match.state)) continue;
      const key =
        candidate.bankName && candidate.accountSuffix
          ? JSON.stringify([normalizedBank(candidate.bankName), candidate.accountSuffix])
          : candidate.fingerprint;
      const group = groups.get(key) ?? {
        id: key,
        bankName: candidate.bankName ?? 'Bank not identified',
        accountSuffix: candidate.accountSuffix,
        events: [],
      };
      group.events.push(candidate);
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({
      ...group,
      lastDate: group.events
        .map((row) => row.activityDate)
        .sort()
        .at(-1)!,
    }));
  });
  readonly reviewCandidates = computed(() => this.activity.candidates());
  readonly reviewLimit = signal(20);
  readonly visibleReviewCandidates = computed(() =>
    this.reviewCandidates().slice(0, this.reviewLimit()),
  );
  private readonly explicitReviewSelections = signal<Readonly<Record<string, boolean>>>({});
  readonly reviewSelection = signal<Readonly<Record<string, string>>>({});
  readonly bankSources = computed(() =>
    this.store.paymentSources().filter((source) => source.kind === 'DEBIT' && !source.archived),
  );
  readonly activeProfiles = computed(() =>
    this.activity.profiles().filter((profile) => !profile.archived),
  );
  readonly archivedProfiles = computed(() =>
    this.activity.profiles().filter((profile) => profile.archived),
  );
  readonly sourceOptions = computed<readonly AppSelectOption[]>(() => [
    { value: '', label: 'Standalone monitored account' },
    ...this.bankSources().map((source) => ({
      value: source.id,
      label: `${source.institution || 'Bank'} · ${source.nickname}${finalThree(source.lastDigits) ? ` · •••${source.lastDigits}` : ' · no saved suffix'}`,
    })),
  ]);
  readonly reviewProfileOptions = computed<readonly AppSelectOption[]>(() => [
    { value: '', label: 'Choose the account this SMS belongs to' },
    ...this.activity
      .profiles()
      .filter((profile) => !profile.archived)
      .map((profile) => ({
        value: profile.id,
        label: this.profileLabel(profile),
        detail:
          profile.owner === 'OWN'
            ? 'My account'
            : `Holder: ${profile.holderName ?? 'Not recorded'}`,
      })),
  ]);
  readonly ownerOptions: readonly AppSelectOption[] = [
    { value: '', label: 'Choose account holder' },
    { value: 'OWN', label: 'My account' },
    { value: 'OTHERS', label: 'Someone else’s account' },
  ];
  readonly directionOptions: readonly AppSelectOption[] = [
    { value: 'DEBIT', label: 'Debit' },
    { value: 'CREDIT', label: 'Credit' },
  ];
  readonly profileForm = new FormGroup({
    paymentSourceId: new FormControl('', { nonNullable: true }),
    bankName: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    nickname: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    accountSuffix: new FormControl('', {
      nonNullable: true,
      validators: Validators.pattern(/^(?:|\d{3})$/),
    }),
    owner: new FormControl<'OWN' | 'OTHERS' | ''>('OWN', { nonNullable: true }),
    holderName: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    manualOnly: new FormControl(false, { nonNullable: true }),
    allowIdentityConflict: new FormControl(false, { nonNullable: true }),
    remarks: new FormControl('', { nonNullable: true, validators: Validators.maxLength(300) }),
  });
  readonly eventForm = new FormGroup({
    activityDate: new FormControl(this.today, {
      nonNullable: true,
      validators: Validators.required,
    }),
    direction: new FormControl<'CREDIT' | 'DEBIT'>('DEBIT', { nonNullable: true }),
    reference: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
  });

  private readonly profileChanges = toSignal(this.profileForm.valueChanges);
  constructor() {
    effect(() => {
      const candidates = this.reviewCandidates();
      const explicit = this.explicitReviewSelections();
      const activeIds = new Set(
        this.activity
          .profiles()
          .filter((row) => !row.archived)
          .map((row) => row.id),
      );
      this.reviewSelection.update((current) => {
        const next: Record<string, string> = {};
        for (const candidate of candidates)
          if (explicit[candidate.fingerprint]) {
            if (!current[candidate.fingerprint] || activeIds.has(current[candidate.fingerprint]))
              next[candidate.fingerprint] = current[candidate.fingerprint] ?? '';
          } else {
            const match = this.activity.match(candidate);
            if (match.suggestedId) next[candidate.fingerprint] = match.suggestedId;
          }
        return next;
      });
    });
    this.profileForm.controls.paymentSourceId.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((id) => {
        const source = this.store.paymentSources().find((row) => row.id === id);
        if (source) {
          this.profileForm.controls.bankName.setValue(source.institution ?? '');
          this.profileForm.controls.accountSuffix.setValue(finalThree(source.lastDigits) ?? '');
        }
      });
    for (const control of [
      this.profileForm.controls.bankName,
      this.profileForm.controls.accountSuffix,
      this.profileForm.controls.paymentSourceId,
    ])
      control.valueChanges
        .pipe(takeUntilDestroyed())
        .subscribe(() =>
          this.profileForm.controls.allowIdentityConflict.setValue(false, { emitEvent: false }),
        );
  }
  linkedIdentifier(): string {
    this.profileChanges();
    const source = this.store
      .paymentSources()
      .find((row) => row.id === this.profileForm.controls.paymentSourceId.value);
    const suffix = finalThree(source?.lastDigits);
    return suffix
      ? '•••' + source!.lastDigits + ' (activity matching: •••' + suffix + ')'
      : 'No trustworthy suffix saved. Enter the last three digits or choose manual-only monitoring.';
  }
  hasLinkedSuffix(): boolean {
    this.profileChanges();
    return !!finalThree(
      this.store
        .paymentSources()
        .find((row) => row.id === this.profileForm.controls.paymentSourceId.value)?.lastDigits,
    );
  }
  closeProfile(): void {
    if (!this.saving()) this.profileFormOpen.set(false);
  }
  async findAccounts(): Promise<void> {
    if (this.activity.discovering()) return;
    this.error.set(null);
    try {
      const count = await this.activity.discoverSavedEvidence();
      this.discoveryNotice.set(
        count +
          ' saved alerts checked. Suggestions remain pending until you confirm. If a large scan was interrupted, choose Find accounts again to continue.',
      );
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error
          ? error.message
          : 'Account discovery could not complete. Retry to resume.',
      );
    }
  }
  reviewDiscovery(candidate: BankActivityCandidate): void {
    this.startProfile();
    this.profileForm.patchValue({
      bankName: candidate.bankName ?? '',
      accountSuffix: candidate.accountSuffix ?? '',
      owner: '',
      manualOnly: !candidate.accountSuffix,
    });
  }
  async dismissDiscovery(fingerprints: readonly string[]): Promise<void> {
    try {
      await this.activity.dismissCandidates(fingerprints);
      this.discoveryNotice.set(
        'Pending suggestions dismissed. The same evidence will not immediately reappear.',
      );
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Discovery could not be dismissed.');
    }
  }
  discoveryFingerprints(events: readonly BankActivityCandidate[]): string[] {
    return events.map((row) => row.fingerprint);
  }
  reviewWarning(candidate: BankActivityCandidate): string {
    return this.activity.match(candidate).reason;
  }
  selectionConflict(candidate: BankActivityCandidate): boolean {
    const id = this.reviewSelection()[candidate.fingerprint];
    return !!id && !this.activity.selectionMatches(candidate, id);
  }
  acknowledgeMismatch(fingerprint: string, event: Event): void {
    this.mismatchAcknowledged.update((current) => ({
      ...current,
      [fingerprint]: (event.target as HTMLInputElement).checked,
    }));
  }
  get today(): string {
    return this.dateClock.today();
  }

  statusLabel(profile: BankActivityProfile): string {
    const status = this.activity.summaryFor(profile.id, this.today).status;
    return {
      RECENTLY_USED: 'Recently used',
      NOT_USED_RECENTLY: 'Not used recently',
      LONG_INACTIVE: 'Long inactive',
      UNKNOWN: 'Unknown',
    }[status];
  }

  statusClass(profile: BankActivityProfile): string {
    const status = this.activity.summaryFor(profile.id, this.today).status;
    return status === 'RECENTLY_USED'
      ? 'active'
      : status === 'NOT_USED_RECENTLY'
        ? 'attention'
        : status === 'LONG_INACTIVE'
          ? 'inactive'
          : 'unknown';
  }

  profileLabel(profile: BankActivityProfile): string {
    const suffix = profileSuffix(profile, this.store.paymentSources());
    return `${profile.bankName}${suffix ? ` · •••${suffix}` : ' · manual only'}${profile.nickname ? ` · ${profile.nickname}` : ''}`;
  }

  activityText(profile: BankActivityProfile): string {
    const summary = this.activity.summaryFor(profile.id, this.today);
    if (summary.lastActivityDate === undefined) return 'No known qualifying transaction';
    return `${summary.daysSinceActivity} days · ${summary.calendarMonths} calendar months since ${summary.lastActivityDate}`;
  }

  startProfile(): void {
    if (this.saving()) return;
    this.error.set(null);
    this.editingProfileId.set(null);
    this.profileForm.reset({
      paymentSourceId: '',
      bankName: '',
      nickname: '',
      accountSuffix: '',
      owner: 'OWN',
      manualOnly: false,
      allowIdentityConflict: false,
      holderName: '',
      remarks: '',
    });
    this.profileFormOpen.set(true);
  }

  editProfile(profile: BankActivityProfile): void {
    if (this.saving()) return;
    this.error.set(null);
    this.editingProfileId.set(profile.id);
    this.profileForm.reset({
      paymentSourceId: profile.paymentSourceId ?? '',
      bankName: profile.bankName,
      nickname: profile.nickname ?? '',
      accountSuffix: finalThree(profile.accountSuffix) ?? '',
      manualOnly: profile.manualOnly ?? !profileSuffix(profile, this.store.paymentSources()),
      allowIdentityConflict: false,
      owner: profile.owner,
      holderName: profile.holderName ?? '',
      remarks: profile.remarks ?? '',
    });
    this.profileFormOpen.set(true);
  }

  async saveProfile(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.profileForm.markAllAsTouched();
    const value = this.profileForm.getRawValue();
    if (this.profileForm.invalid) {
      this.error.set(
        'Check the form. Last 3 account digits must contain exactly three numbers, such as 007.',
      );
      return;
    }
    if (value.owner !== 'OWN' && value.owner !== 'OTHERS') {
      this.error.set('Choose who owns this account.');
      return;
    }
    if (!value.paymentSourceId && !value.bankName.trim()) {
      this.error.set('Enter a bank name or choose an existing CardNest bank account.');
      return;
    }
    if (value.owner === 'OTHERS' && !value.holderName.trim()) {
      this.error.set('Enter the account holder name.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.activity.saveProfile({
        ...value,
        owner: value.owner,
        id: this.editingProfileId() ?? undefined,
      });
      this.profileFormOpen.set(false);
      this.discoveryNotice.set(
        'Monitoring profile saved. Related message suggestions still need individual review and confirmation.',
      );
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'Bank Activity profile could not be saved.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async archive(profile: BankActivityProfile): Promise<void> {
    await this.activity.setArchived(profile.id, true);
  }

  startEvent(profile: BankActivityProfile): void {
    this.error.set(null);
    this.editingEventId.set(null);
    this.eventProfileId.set(profile.id);
    this.eventForm.reset({ activityDate: this.today, direction: 'DEBIT', reference: '' });
  }

  editEvent(event: BankActivityEvent): void {
    this.error.set(null);
    this.editingEventId.set(event.id);
    this.eventProfileId.set(event.profileId);
    this.eventForm.reset({
      activityDate: event.activityDate,
      direction: event.direction,
      reference: event.reference ?? '',
    });
  }

  async saveEvent(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    const profileId = this.eventProfileId();
    if (!profileId) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.activity.saveManualEvent({
        ...this.eventForm.getRawValue(),
        id: this.editingEventId() ?? undefined,
        profileId,
      });
      this.eventProfileId.set(null);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Activity event could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }

  async deleteEvent(event: BankActivityEvent): Promise<void> {
    await this.activity.deleteEvent(event.id);
  }

  setReviewProfile(fingerprint: string, profileId: string): void {
    this.reviewSelection.update((current) => ({ ...current, [fingerprint]: profileId }));
    this.explicitReviewSelections.update((current) => ({ ...current, [fingerprint]: true }));
    this.mismatchAcknowledged.update((current) => ({ ...current, [fingerprint]: false }));
  }

  async approveCandidate(fingerprint: string): Promise<void> {
    if (this.saving()) return;
    const profileId = this.reviewSelection()[fingerprint];
    if (!profileId) {
      this.error.set('Choose the monitored account before recording this SMS activity.');
      return;
    }
    const candidate = this.activity.candidates().find((row) => row.fingerprint === fingerprint);
    const profile = this.activity.profiles().find((row) => row.id === profileId && !row.archived);
    if (!candidate || !profile) return;
    const conflict = !this.activity.selectionMatches(candidate, profileId);
    const acknowledged = this.mismatchAcknowledged()[fingerprint] === true;
    if (conflict && !acknowledged) {
      this.error.set(
        'Verify the mismatching or unavailable account evidence and acknowledge it before confirmation.',
      );
      return;
    }
    this.confirmation.set({
      fingerprint,
      profileId,
      acknowledged,
      message:
        'Record the ' +
        candidate.direction.toLowerCase() +
        ' activity on ' +
        candidate.activityDate +
        ' for ' +
        this.profileLabel(profile) +
        '? This updates Bank Activity tracking only and will not change balances or transactions.' +
        (conflict
          ? ' Account evidence conflicts or is incomplete. You are confirming the account independently; it is not source-verified.'
          : ''),
    });
  }
  async confirmActivity(): Promise<void> {
    const choice = this.confirmation();
    if (!choice || this.saving()) return;
    this.confirmation.set(null);
    this.error.set(null);
    this.discoveryNotice.set('');
    this.saving.set(true);
    try {
      const event = await this.activity.approveCandidate(
        choice.fingerprint,
        choice.profileId,
        choice.acknowledged,
      );
      this.discoveryNotice.set(
        event
          ? 'Account activity confirmed. Balances and financial transactions are unchanged.'
          : 'This suggestion has already been resolved. No new activity was recorded.',
      );
      queueMicrotask(() => document.getElementById('bank-profile-' + choice.profileId)?.focus());
      this.reviewSelection.update((current) => {
        const next = { ...current };
        delete next[choice.fingerprint];
        return next;
      });
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Activity could not be recorded.');
    } finally {
      this.saving.set(false);
    }
  }

  events(profile: BankActivityProfile): readonly BankActivityEvent[] {
    return this.activity.eventsFor(profile.id);
  }
}
