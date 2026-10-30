import { ProfileModal } from '../../shared/profile-modal';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { IndianPhoneInput } from '../../shared/indian-phone-input';
import { afterNextRender, Component, computed, inject, Injector, signal } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { lpgEventChoices, lpgLifecycle } from './lpg-lifecycle';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { AppIcon } from '../../shared/app-icon';
import { parseMoneyToMinor, formatMoney } from '../../core/services/money';
import { IndiaTodayClock } from '../../core/services/india-date';
import { SnackbarService } from '../../core/services/snackbar.service';
import { WhatsAppAppChooser } from '../../shared/whatsapp-app-chooser';
import { WhatsAppPackage, WhatsAppService } from './whatsapp.service';
import { CYLINDER_OPTIONS } from './data/cylinder-options';
import { GAS_SERVICE_TYPES, GasServiceType } from './data/lpg-providers';
import { MOBILE_PLAN_TYPES } from './data/mobile-plan-types';
import { normalizeIndianMobileNumber, UtilitiesService } from './utilities.service';
import {
  LpgEvent,
  LpgEventType,
  LpgProfile,
  MobileProfile,
  MobileRecharge,
} from './utilities-model';
import {
  addCalendarDays,
  calendarDaysBetween,
  utilityOverview,
  validCalendarDate,
} from './utilities-calculations';

type UtilitySection = 'MOBILE' | 'GAS' | 'ELECTRICITY' | 'BROADBAND';

@Component({
  selector: 'app-utilities-page',
  imports: [
    ProfileModal,
    ConfirmationDialog,
    IndianPhoneInput,
    ReactiveFormsModule,
    NgOptimizedImage,
    AppIcon,
    AppSelectPicker,
    WhatsAppAppChooser,
  ],
  templateUrl: './utilities.html',
  styleUrl: './utilities.scss',
})
export class UtilitiesPage {
  readonly utilities = inject(UtilitiesService);
  private readonly whatsApp = inject(WhatsAppService);
  private readonly snackbar = inject(SnackbarService);
  private readonly dateClock = inject(IndiaTodayClock);
  private readonly injector = inject(Injector);
  private historyTrigger: HTMLElement | null = null;
  private historyRecordId: string | null = null;
  private lpgHistoryTrigger: HTMLElement | null = null;
  private lpgHistoryRecordId: string | null = null;
  readonly section = signal<UtilitySection>('MOBILE');
  readonly gasType = signal<GasServiceType>('LPG');
  readonly mobileFormOpen = signal(false);
  readonly lpgFormOpen = signal(false);
  readonly editingMobileId = signal<string | null>(null);
  readonly editingLpgId = signal<string | null>(null);
  readonly rechargeProfileId = signal<string | null>(null);
  readonly editingRechargeId = signal<string | null>(null);
  readonly rechargeHistoryProfileId = signal<string | null>(null);
  readonly rechargeHistoryProfile = computed(() =>
    this.utilities
      .mobileProfiles()
      .find((profile) => profile.id === this.rechargeHistoryProfileId()),
  );
  readonly lpgEventProfileId = signal<string | null>(null);
  readonly editingLpgEventId = signal<string | null>(null);
  readonly lpgHistoryProfileId = signal<string | null>(null);
  readonly lpgHistoryProfile = computed(() =>
    this.utilities.lpgProfiles().find((profile) => profile.id === this.lpgHistoryProfileId()),
  );
  readonly lpgEventProfile = computed(() =>
    this.utilities.lpgProfiles().find((profile) => profile.id === this.lpgEventProfileId()),
  );
  readonly validityMode = signal<'DAYS' | 'END_DATE'>('DAYS');
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly deletion = signal<{
    id: string;
    kind: 'RECHARGE' | 'LPG' | 'MOBILE_PROFILE' | 'LPG_PROFILE';
    title: string;
    message: string;
  } | null>(null);
  readonly whatsappPackages = signal<readonly WhatsAppPackage[]>([]);
  readonly whatsappNumber = signal('');
  readonly whatsappMessage = signal('');
  readonly whatsappFallbackNumber = signal('');
  readonly overview = computed(() =>
    utilityOverview(
      this.utilities.mobileProfiles().map((profile) => ({
        profile,
        plans: this.utilities.rechargesFor(profile.id),
      })),
      this.utilities.lpgProfiles().map((profile) => ({
        profile,
        events: this.utilities.eventsFor(profile.id),
        estimatedUsageDays: profile.estimatedUsageDays,
      })),
      this.today,
    ),
  );
  readonly mobileProfiles = computed(() =>
    this.utilities.mobileProfiles().filter((item) => !item.archived),
  );
  readonly lpgProfiles = computed(() =>
    this.utilities.lpgProfiles().filter((item) => !item.archived),
  );
  readonly archivedMobileProfiles = computed(() =>
    this.utilities.mobileProfiles().filter((item) => item.archived),
  );
  readonly archivedLpgProfiles = computed(() =>
    this.utilities.lpgProfiles().filter((item) => item.archived),
  );
  readonly mobileOptions = this.utilities.operatorOptions;
  readonly subscriptionOptions = this.utilities.subscriptionOptions;
  readonly planOptions = this.utilities.mobilePlanOptions;
  readonly providerOptions = this.utilities.lpgProviderOptions;
  readonly gasServiceOptions: readonly AppSelectOption[] = GAS_SERVICE_TYPES.map(
    ({ value, label }) => ({ value, label }),
  );
  readonly cylinderOptions = this.utilities.cylinderOptions;
  readonly lpgEventOptions = computed<readonly AppSelectOption[]>(() => {
    this.lpgEventChanges();
    const allowed = lpgEventChoices(
      this.utilities.eventsFor(this.lpgEventProfileId() ?? ''),
      this.lpgEventForm.controls.eventDate.value,
      this.editingLpgEventId() ?? undefined,
    );
    return this.utilities.lpgEventOptions.map((option) => ({
      ...option,
      disabled: !allowed.includes(option.value as LpgEventType),
    }));
  });
  readonly validityModeOptions: readonly AppSelectOption[] = [
    { value: 'DAYS', label: 'Validity in days' },
    { value: 'END_DATE', label: 'Last active date' },
  ];
  readonly mobileForm = new FormGroup({
    personName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    subscriptionType: new FormControl<'PREPAID' | 'POSTPAID'>('PREPAID', { nonNullable: true }),
    operator: new FormControl<MobileProfile['operator']>('JIO', { nonNullable: true }),
    mobileNumber: new FormControl('', {
      nonNullable: true,
      validators: [Validators.pattern(/^(?:|[6-9]\d{9}|\+91[ -]?[6-9]\d{9})$/)],
    }),
  });
  readonly rechargeForm = new FormGroup({
    planType: new FormControl<MobileRecharge['planType']>('VOICE_DATA', { nonNullable: true }),
    amount: new FormControl('', { nonNullable: true }),
    startDate: new FormControl(this.today, { nonNullable: true, validators: Validators.required }),
    validityDays: new FormControl('30', { nonNullable: true }),
    endDate: new FormControl('', { nonNullable: true }),
    comment: new FormControl('', { nonNullable: true, validators: Validators.maxLength(300) }),
  });
  readonly lpgForm = new FormGroup({
    connectionName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    provider: new FormControl<LpgProfile['provider']>('INDANE', { nonNullable: true }),
    commercial: new FormControl(false, { nonNullable: true }),
    mobileNumber: new FormControl('', { nonNullable: true, validators: Validators.maxLength(20) }),
    connectionId: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    distributorId: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    distributorName: new FormControl('', {
      nonNullable: true,
      validators: Validators.maxLength(80),
    }),
    distributorContact: new FormControl('', {
      nonNullable: true,
      validators: Validators.maxLength(20),
    }),
    distributorWhatsApp: new FormControl('', {
      nonNullable: true,
      validators: Validators.maxLength(20),
    }),
    cylinderSize: new FormControl<LpgProfile['cylinderSize']>('NORMAL', { nonNullable: true }),
    estimatedUsageDays: new FormControl('25', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^\d+$/)],
    }),
    notes: new FormControl('', { nonNullable: true, validators: Validators.maxLength(300) }),
  });
  readonly lpgEventForm = new FormGroup({
    eventType: new FormControl<LpgEventType>('STARTED', { nonNullable: true }),
    eventDate: new FormControl(this.today, { nonNullable: true, validators: Validators.required }),
    amount: new FormControl('', { nonNullable: true }),
    cylinderSize: new FormControl<LpgEvent['cylinderSize']>('NORMAL', { nonNullable: true }),
    comment: new FormControl('', { nonNullable: true, validators: Validators.maxLength(300) }),
  });
  private readonly lpgEventChanges = toSignal(this.lpgEventForm.valueChanges);

  get today(): string {
    return this.dateClock.today();
  }

  money(amountMinor: number): string {
    return formatMoney(amountMinor, 'INR');
  }
  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  hasWhatsAppNumber(value?: string): boolean {
    if (!value) return false;
    try {
      return !!normalizeIndianMobileNumber(value);
    } catch {
      return false;
    }
  }

  startAddMobile(): void {
    this.error.set(null);
    this.editingMobileId.set(null);
    this.mobileForm.reset({
      personName: '',
      subscriptionType: 'PREPAID',
      operator: 'JIO',
      mobileNumber: '',
    });
    this.mobileFormOpen.set(true);
  }

  editMobile(profile: MobileProfile): void {
    this.error.set(null);
    this.editingMobileId.set(profile.id);
    let mobileNumber = profile.mobileNumber ?? '';
    try {
      mobileNumber = normalizeIndianMobileNumber(mobileNumber)?.slice(4) ?? '';
    } catch {
      /* Preserve malformed legacy data for explicit correction. */
    }
    this.mobileForm.reset({
      personName: profile.personName,
      subscriptionType: profile.subscriptionType,
      operator: profile.operator,
      mobileNumber,
    });
    this.mobileFormOpen.set(true);
  }

  async saveMobile(event: Event): Promise<void> {
    event.preventDefault();
    this.mobileForm.markAllAsTouched();
    if (this.mobileForm.invalid || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.utilities.saveMobileProfile({
        ...this.mobileForm.getRawValue(),
        id: this.editingMobileId() ?? undefined,
      });
      this.mobileFormOpen.set(false);
      this.snackbar.show('Mobile profile saved.', 'SUCCESS');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Mobile profile could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }

  async archiveMobile(profile: MobileProfile): Promise<void> {
    await this.utilities.setMobileArchived(profile.id, true);
    this.snackbar.show('Mobile profile archived. Recharge history is kept.', 'INFO');
  }

  openRechargeHistory(profile: MobileProfile): void {
    if (this.saving()) return;
    this.historyRecordId = null;
    this.historyTrigger =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.error.set(null);
    this.rechargeHistoryProfileId.set(profile.id);
  }

  closeRechargeHistory(): void {
    if (this.saving()) return;
    this.rechargeHistoryProfileId.set(null);
    afterNextRender(
      () => {
        if (this.historyTrigger?.isConnected) this.historyTrigger.focus();
      },
      { injector: this.injector },
    );
  }

  requestMobileDeletion(profile: MobileProfile): void {
    if (this.saving()) return;
    this.error.set(null);
    const count = this.utilities.rechargesFor(profile.id).length;
    this.deletion.set({
      id: profile.id,
      kind: 'MOBILE_PROFILE',
      title: 'Permanently delete mobile profile?',
      message: `Delete ${profile.personName} (${profile.operator}) and all ${count} saved recharge records? The complete recharge history will be permanently deleted. This cannot be undone. Other profiles and financial records are not affected.`,
    });
  }

  startRecharge(profile: MobileProfile): void {
    if (this.saving()) return;
    this.error.set(null);
    this.editingRechargeId.set(null);
    this.rechargeProfileId.set(profile.id);
    this.validityMode.set('DAYS');
    this.rechargeForm.reset({
      planType: 'VOICE_DATA',
      amount: '',
      startDate: this.utilities.suggestedRechargeStart(profile.id),
      validityDays: '30',
      endDate: '',
      comment: '',
    });
  }

  closeRecharge(): void {
    if (this.saving()) return;
    this.rechargeProfileId.set(null);
    this.error.set(null);
    this.restoreHistoryFocus();
  }

  editRecharge(recharge: MobileRecharge): void {
    if (this.saving()) return;
    this.historyRecordId = recharge.id;
    this.error.set(null);
    this.editingRechargeId.set(recharge.id);
    this.rechargeProfileId.set(recharge.profileId);
    this.validityMode.set('END_DATE');
    this.rechargeForm.reset({
      planType: recharge.planType,
      amount: recharge.amountMinor === undefined ? '' : String(recharge.amountMinor / 100),
      startDate: recharge.startDate,
      validityDays: String(calendarDaysBetween(recharge.startDate, recharge.endDate) + 1),
      endDate: recharge.endDate,
      comment: recharge.comment ?? '',
    });
  }

  async saveRecharge(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.rechargeForm.markAllAsTouched();
    if (this.rechargeForm.invalid) {
      this.error.set('Check the recharge dates and comment.');
      return;
    }
    const value = this.rechargeForm.getRawValue();
    const amountMinor = value.amount.trim() ? parseMoneyToMinor(value.amount) : undefined;
    if (
      value.amount.trim() &&
      (amountMinor === null || amountMinor === undefined || amountMinor < 0)
    ) {
      this.error.set('Enter a valid INR recharge amount.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.utilities.saveRecharge({
        id: this.editingRechargeId() ?? undefined,
        profileId: this.rechargeProfileId()!,
        planType: value.planType,
        amountMinor: amountMinor ?? undefined,
        startDate: value.startDate,
        validityDays: this.validityMode() === 'DAYS' ? Number(value.validityDays) : undefined,
        endDate: this.validityMode() === 'END_DATE' ? value.endDate : undefined,
        comment: value.comment,
      });
      this.rechargeProfileId.set(null);
      this.restoreHistoryFocus();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Recharge could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRecharge(recharge: MobileRecharge): Promise<void> {
    if (this.saving()) return;
    this.historyRecordId = recharge.id;
    this.error.set(null);
    this.deletion.set({
      id: recharge.id,
      kind: 'RECHARGE',
      title: 'Delete recharge record?',
      message: `Remove the recharge starting ${recharge.startDate} from saved history?`,
    });
  }

  rechargeEndDatePreview(): string {
    const value = this.rechargeForm.getRawValue();
    if (this.validityMode() !== 'DAYS') return value.endDate;
    const days = Number(value.validityDays);
    return validCalendarDate(value.startDate) && Number.isSafeInteger(days) && days > 0
      ? addCalendarDays(value.startDate, days - 1)
      : 'Enter a positive number of days';
  }

  startAddLpg(): void {
    this.error.set(null);
    this.editingLpgId.set(null);
    this.lpgForm.reset({
      connectionName: '',
      provider: 'INDANE',
      commercial: false,
      mobileNumber: '',
      connectionId: '',
      distributorId: '',
      distributorName: '',
      distributorContact: '',
      distributorWhatsApp: '',
      cylinderSize: 'NORMAL',
      estimatedUsageDays: '25',
      notes: '',
    });
    this.lpgFormOpen.set(true);
  }

  editLpg(profile: LpgProfile): void {
    this.error.set(null);
    this.editingLpgId.set(profile.id);
    this.lpgForm.reset({
      connectionName: profile.connectionName,
      provider: profile.provider,
      commercial: profile.commercial,
      mobileNumber: profile.mobileNumber ?? '',
      connectionId: profile.connectionId ?? '',
      distributorId: profile.distributorId ?? '',
      distributorName: profile.distributorName ?? '',
      distributorContact: profile.distributorContact ?? '',
      distributorWhatsApp: profile.distributorWhatsApp ?? '',
      cylinderSize: profile.cylinderSize,
      estimatedUsageDays: String(profile.estimatedUsageDays),
      notes: profile.notes ?? '',
    });
    this.lpgFormOpen.set(true);
  }

  async saveLpg(event: Event): Promise<void> {
    event.preventDefault();
    this.lpgForm.markAllAsTouched();
    if (this.lpgForm.invalid || this.saving()) return;
    const value = this.lpgForm.getRawValue();
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.utilities.saveLpgProfile({
        ...value,
        id: this.editingLpgId() ?? undefined,
        estimatedUsageDays: Number(value.estimatedUsageDays),
      });
      this.lpgFormOpen.set(false);
      this.snackbar.show('LPG connection saved.', 'SUCCESS');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'LPG connection could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }

  async archiveLpg(profile: LpgProfile): Promise<void> {
    await this.utilities.setLpgArchived(profile.id, true);
    this.snackbar.show('LPG connection archived. Refill history is kept.', 'INFO');
  }

  startLpgEvent(profile: LpgProfile, eventType: LpgEventType = 'STARTED'): void {
    if (this.saving() || !this.canRecordLpgEvent(profile, eventType)) return;
    this.error.set(null);
    this.editingLpgEventId.set(null);
    this.lpgEventProfileId.set(profile.id);
    this.lpgEventForm.reset({
      eventType,
      eventDate: this.today,
      amount: '',
      cylinderSize: profile.cylinderSize,
      comment: '',
    });
  }

  editLpgEvent(event: LpgEvent): void {
    if (this.saving()) return;
    this.lpgHistoryRecordId = event.id;
    this.error.set(null);
    this.editingLpgEventId.set(event.id);
    this.lpgEventProfileId.set(event.profileId);
    this.lpgEventForm.reset({
      eventType: event.eventType,
      eventDate: event.eventDate,
      amount: event.amountMinor === undefined ? '' : String(event.amountMinor / 100),
      cylinderSize: event.cylinderSize ?? 'NORMAL',
      comment: event.comment ?? '',
    });
  }

  async saveLpgEvent(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.lpgEventForm.markAllAsTouched();
    if (this.lpgEventForm.invalid) {
      this.error.set('Check the event date and comment.');
      return;
    }
    const value = this.lpgEventForm.getRawValue();
    if (
      !lpgEventChoices(
        this.utilities.eventsFor(this.lpgEventProfileId() ?? ''),
        value.eventDate,
        this.editingLpgEventId() ?? undefined,
      ).includes(value.eventType)
    ) {
      this.error.set(
        'This event conflicts with the cylinder history. Choose a valid event/date or correct the affected history first.',
      );
      return;
    }
    const amountMinor = value.amount.trim() ? parseMoneyToMinor(value.amount) : undefined;
    if (
      value.amount.trim() &&
      (amountMinor === null || amountMinor === undefined || amountMinor < 0)
    ) {
      this.error.set('Enter a valid INR amount.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.utilities.saveLpgEvent({
        id: this.editingLpgEventId() ?? undefined,
        profileId: this.lpgEventProfileId()!,
        eventType: value.eventType,
        eventDate: value.eventDate,
        amountMinor: amountMinor ?? undefined,
        cylinderSize: value.cylinderSize || undefined,
        comment: value.comment,
      });
      this.lpgEventProfileId.set(null);
      this.restoreLpgHistoryFocus();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Cylinder event could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }

  async deleteLpgEvent(event: LpgEvent): Promise<void> {
    if (this.saving()) return;
    this.lpgHistoryRecordId = event.id;
    this.error.set(null);
    this.deletion.set({
      id: event.id,
      kind: 'LPG',
      title: 'Delete cylinder event?',
      message: `Remove the cylinder event on ${event.eventDate} from Utilities history?`,
    });
  }

  canRecordLpgEvent(profile: LpgProfile, type: LpgEventType): boolean {
    return (
      !profile.archived &&
      lpgEventChoices(this.utilities.eventsFor(profile.id), this.today).includes(type)
    );
  }

  closeLpgEvent(): void {
    if (this.saving()) return;
    this.lpgEventProfileId.set(null);
    this.error.set(null);
    this.restoreLpgHistoryFocus();
  }

  openLpgHistory(profile: LpgProfile): void {
    if (this.saving()) return;
    this.error.set(null);
    this.lpgHistoryRecordId = null;
    this.lpgHistoryTrigger =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.lpgHistoryProfileId.set(profile.id);
  }

  closeLpgHistory(): void {
    if (this.saving()) return;
    this.lpgHistoryProfileId.set(null);
    afterNextRender(
      () => {
        if (this.lpgHistoryTrigger?.isConnected) this.lpgHistoryTrigger.focus();
      },
      { injector: this.injector },
    );
  }

  private restoreLpgHistoryFocus(): void {
    if (!this.lpgHistoryProfileId()) return;
    afterNextRender(
      () => {
        const preferred = document.getElementById('lpg-history-edit-' + this.lpgHistoryRecordId);
        const target =
          preferred && !preferred.matches(':disabled')
            ? preferred
            : document.querySelector<HTMLElement>('.lpg-history button:not(:disabled)');
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  requestLpgDeletion(profile: LpgProfile): void {
    if (this.saving()) return;
    this.error.set(null);
    this.deletion.set({
      id: profile.id,
      kind: 'LPG_PROFILE',
      title: 'Permanently delete LPG connection?',
      message: `Delete ${profile.connectionName} (${profile.provider}) and all ${this.utilities.eventsFor(profile.id).length} saved cylinder events? The complete connection history will be permanently deleted. This cannot be undone. Other utility profiles, SMS and financial records are not affected.`,
    });
  }

  lpgStatus(profile: LpgProfile): string {
    const state = lpgLifecycle(
      this.utilities.eventsFor(profile.id).filter((event) => event.eventDate <= this.today),
    ).state;
    return {
      UNSTARTED: 'No cylinder started',
      IN_USE: 'Cylinder in use',
      EMPTY: 'Empty confirmed',
      RECEIVED: 'Refill received · not started',
    }[state];
  }

  lpgHistoryWarning(profile: LpgProfile): string {
    return lpgLifecycle(this.utilities.eventsFor(profile.id)).conflicts.length
      ? 'Legacy history has sequence conflicts. Records are preserved; correct the affected events before adding conflicting changes.'
      : '';
  }

  async confirmDeletion(): Promise<void> {
    const choice = this.deletion();
    if (!choice || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      if (choice.kind === 'RECHARGE') await this.utilities.deleteRecharge(choice.id);
      else if (choice.kind === 'MOBILE_PROFILE') {
        await this.utilities.deleteMobileProfile(choice.id);
        if (this.rechargeHistoryProfileId() === choice.id) this.rechargeHistoryProfileId.set(null);
        afterNextRender(() => document.getElementById('add-mobile-profile')?.focus(), {
          injector: this.injector,
        });
      } else if (choice.kind === 'LPG_PROFILE') {
        await this.utilities.deleteLpgProfile(choice.id);
        if (this.lpgHistoryProfileId() === choice.id) this.lpgHistoryProfileId.set(null);
        afterNextRender(() => document.getElementById('add-lpg-profile')?.focus(), {
          injector: this.injector,
        });
      } else await this.utilities.deleteLpgEvent(choice.id);
      this.deletion.set(null);
      this.restoreHistoryFocus();
      this.restoreLpgHistoryFocus();
      this.snackbar.show(
        choice.kind === 'RECHARGE'
          ? 'Recharge removed from history.'
          : choice.kind === 'MOBILE_PROFILE'
            ? 'Mobile profile and recharge history permanently deleted.'
            : choice.kind === 'LPG_PROFILE'
              ? 'LPG connection and cylinder history permanently deleted.'
              : 'Cylinder event deleted.',
        'INFO',
      );
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'The record could not be deleted.');
    } finally {
      this.saving.set(false);
    }
  }

  cancelDeletion(): void {
    if (this.saving()) return;
    this.deletion.set(null);
    this.restoreHistoryFocus();
    this.restoreLpgHistoryFocus();
  }

  private restoreHistoryFocus(): void {
    if (!this.rechargeHistoryProfileId()) return;
    afterNextRender(
      () => {
        const preferred = document.getElementById('recharge-history-edit-' + this.historyRecordId);
        const target =
          preferred && !preferred.matches(':disabled')
            ? preferred
            : document.querySelector<HTMLElement>('.recharge-history button:not(:disabled)');
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  openWhatsApp(number?: string): void {
    if (!number) return;
    const result = this.whatsApp.open(number);
    if (result.result === 'CHOOSER') {
      this.whatsappNumber.set(number);
      this.whatsappPackages.set(result.packages);
    } else if (result.result === 'BROWSER_FALLBACK') {
      this.whatsappNumber.set(number);
      this.whatsappFallbackNumber.set(number);
    } else if (result.result === 'INVALID') {
      this.snackbar.show('Save a valid +91 mobile number to open WhatsApp.', 'WARNING');
    } else if (result.result === 'BLOCKED') {
      this.snackbar.show('WhatsApp could not be opened on this device.', 'WARNING');
    }
  }

  chooseWhatsApp(packageName: WhatsAppPackage): void {
    if (!this.whatsApp.choose(this.whatsappNumber(), this.whatsappMessage(), packageName))
      this.snackbar.show('WhatsApp could not be opened. Try the browser link.', 'WARNING');
    this.whatsappPackages.set([]);
  }

  mobilePlans(profile: MobileProfile): readonly MobileRecharge[] {
    return this.utilities
      .rechargesFor(profile.id)
      .slice()
      .sort((left, right) => right.startDate.localeCompare(left.startDate));
  }

  activeMobilePlans(profile: MobileProfile): readonly MobileRecharge[] {
    return this.mobilePlans(profile).filter(
      (plan) => plan.startDate <= this.today && plan.endDate >= this.today,
    );
  }

  scheduledMobilePlans(profile: MobileProfile): readonly MobileRecharge[] {
    return this.mobilePlans(profile)
      .filter((plan) => plan.startDate > this.today)
      .sort((left, right) => left.startDate.localeCompare(right.startDate));
  }

  planStatus(recharge: MobileRecharge): string {
    return recharge.startDate > this.today
      ? 'Scheduled'
      : recharge.endDate < this.today
        ? 'Expired'
        : 'Active';
  }

  planPeriodText(recharge: MobileRecharge): string {
    if (recharge.startDate > this.today)
      return `Scheduled · starts in ${calendarDaysBetween(this.today, recharge.startDate)} days`;
    if (recharge.endDate < this.today)
      return `Expired ${calendarDaysBetween(recharge.endDate, this.today)} days ago`;
    const remaining = calendarDaysBetween(this.today, recharge.endDate);
    return remaining === 0 ? 'Last active day today' : `${remaining} days remaining`;
  }

  planTypeLabel(value: MobileRecharge['planType']): string {
    return MOBILE_PLAN_TYPES.find((item) => item.value === value)?.label ?? 'Recharge plan';
  }

  cylinderSizeLabel(
    value: NonNullable<LpgEvent['cylinderSize']> | LpgProfile['cylinderSize'],
  ): string {
    return CYLINDER_OPTIONS.find((item) => item.value === value)?.label ?? 'Cylinder';
  }

  lpgEventLabel(value: LpgEventType): string {
    return (
      this.utilities.lpgEventOptions.find((item) => item.value === value)?.label ?? 'Cylinder event'
    );
  }

  lpgDaysToCheck(profile: LpgProfile): number | null {
    return this.utilities.lpgSummary(profile, this.today).estimatedDaysToCheck;
  }

  lpgCheckLabel(profile: LpgProfile): string {
    const days = this.lpgDaysToCheck(profile);
    return days === null
      ? 'Start a cylinder'
      : days <= 0
        ? 'Check now · estimate'
        : `In ${days} days`;
  }

  lpgCheckDue(profile: LpgProfile): boolean {
    const days = this.lpgDaysToCheck(profile);
    return (
      days !== null &&
      days <= 0 &&
      !this.utilities.lpgSummary(profile, this.today).currentCylinderEmpty
    );
  }

  lpgAverageDuration(profile: LpgProfile): number | null {
    return this.utilities.lpgSummary(profile, this.today).averageCompletedDuration;
  }

  lpgLastCompletedDuration(profile: LpgProfile): number | null {
    return this.utilities.lpgSummary(profile, this.today).completedCylinderDurations.at(-1) ?? null;
  }

  lpgEmptyWait(profile: LpgProfile): number | null {
    return this.utilities.lpgSummary(profile, this.today).emptyToReplacementDays.at(-1) ?? null;
  }

  lpgHistory(profile: LpgProfile): readonly LpgEvent[] {
    return this.utilities
      .eventsFor(profile.id)
      .slice()
      .sort((left, right) => right.eventDate.localeCompare(left.eventDate));
  }

  statusLabel(profile: MobileProfile): string {
    const summary = this.utilities.mobileSummary(profile, this.today);
    if (summary.status === 'ACTIVE' && !summary.callingCoverageActive && summary.dataActive)
      return 'Data active · No recorded calling plan';
    return {
      ACTIVE: 'Active',
      NO_ACTIVE: 'No active subscription',
      SCHEDULED: 'Scheduled',
      UNKNOWN: 'Unknown',
    }[summary.status];
  }

  statusClass(profile: MobileProfile): string {
    const summary = this.utilities.mobileSummary(profile, this.today);
    if (summary.status === 'ACTIVE' && summary.dataActive && !summary.callingCoverageActive)
      return 'attention';
    return summary.status === 'ACTIVE'
      ? 'active'
      : summary.status === 'SCHEDULED'
        ? 'scheduled'
        : summary.status === 'UNKNOWN'
          ? 'unknown'
          : 'attention';
  }

  callingWarning(profile: MobileProfile): string | null {
    if (profile.subscriptionType === 'POSTPAID') return null;
    const summary = this.utilities.mobileSummary(profile, this.today);
    if (
      summary.callingCoverageActive &&
      summary.daysUntilCallingEnd !== null &&
      summary.daysUntilCallingEnd <= 10
    )
      return `Outgoing calling plan expires in ${summary.daysUntilCallingEnd} days`;
    if (!summary.callingCoverageActive && summary.daysWithoutCalling !== null)
      return `No recorded calling plan for ${summary.daysWithoutCalling} days`;
    return null;
  }

  setSection(section: UtilitySection): void {
    this.section.set(section);
    if (section === 'GAS') this.gasType.set('LPG');
  }

  setGasType(value: string): void {
    if (value === 'LPG' || value === 'PNG') this.gasType.set(value);
  }

  closeWhatsAppChooser(): void {
    this.whatsappPackages.set([]);
  }
  openWhatsAppFallback(): void {
    if (!this.whatsApp.openFallback(this.whatsappFallbackNumber(), this.whatsappMessage()))
      this.snackbar.show('The browser link could not be opened.', 'WARNING');
    this.whatsappFallbackNumber.set('');
  }
}
