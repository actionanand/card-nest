import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { AppIcon } from '../../shared/app-icon';
import { CardNestStore } from '../../core/services/card-nest-store';
import { IndiaTodayClock } from '../../core/services/india-date';
import { BankActivityEvent, BankActivityProfile } from './bank-activity-model';
import { BankActivityService } from './bank-activity.service';

@Component({
  selector: 'app-bank-activity-page',
  imports: [ReactiveFormsModule, AppIcon, AppSelectPicker],
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
      label: `${source.institution || source.nickname}${source.lastDigits ? ` · xx${source.lastDigits.slice(-3)}` : ''}`,
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
      validators: Validators.pattern(/^(?:|\d{3,5})$/),
    }),
    owner: new FormControl<'OWN' | 'OTHERS'>('OWN', { nonNullable: true }),
    holderName: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
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
    return `${profile.bankName}${profile.accountSuffix ? ` · xx${profile.accountSuffix}` : ''}${profile.nickname ? ` · ${profile.nickname}` : ''}`;
  }

  activityText(profile: BankActivityProfile): string {
    const summary = this.activity.summaryFor(profile.id, this.today);
    if (summary.lastActivityDate === undefined) return 'No known qualifying transaction';
    return `${summary.daysSinceActivity} days · ${summary.calendarMonths} calendar months since ${summary.lastActivityDate}`;
  }

  startProfile(): void {
    this.error.set(null);
    this.editingProfileId.set(null);
    this.profileForm.reset({
      paymentSourceId: '',
      bankName: '',
      nickname: '',
      accountSuffix: '',
      owner: 'OWN',
      holderName: '',
      remarks: '',
    });
    this.profileFormOpen.set(true);
  }

  editProfile(profile: BankActivityProfile): void {
    this.error.set(null);
    this.editingProfileId.set(profile.id);
    this.profileForm.reset({
      paymentSourceId: profile.paymentSourceId ?? '',
      bankName: profile.bankName,
      nickname: profile.nickname ?? '',
      accountSuffix: profile.accountSuffix ?? '',
      owner: profile.owner,
      holderName: profile.holderName ?? '',
      remarks: profile.remarks ?? '',
    });
    this.profileFormOpen.set(true);
  }

  async saveProfile(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    const value = this.profileForm.getRawValue();
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
      await this.activity.saveProfile({ ...value, id: this.editingProfileId() ?? undefined });
      this.profileFormOpen.set(false);
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
  }

  async approveCandidate(fingerprint: string): Promise<void> {
    const profileId = this.reviewSelection()[fingerprint];
    if (!profileId) {
      this.error.set('Choose the monitored account before recording this SMS activity.');
      return;
    }
    this.error.set(null);
    this.saving.set(true);
    try {
      await this.activity.approveCandidate(fingerprint, profileId);
      this.reviewSelection.update((current) => {
        const next = { ...current };
        delete next[fingerprint];
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
