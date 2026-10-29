import { ProfileModal } from '../../shared/profile-modal';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
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
import { formatMoney } from '../../core/services/money';
import {
  displayBankAccountIdentifier,
  displayBankAccountSuffix,
} from '../../core/services/bank-account-identifier';
import { bankCashTracked } from '../../core/services/source-balance';
import { BankActivityEvent, BankActivityProfile } from './bank-activity-model';
import { BankActivityService } from './bank-activity.service';
import { BankAccountSyncService } from './bank-account-sync.service';
import { SourceMovementDialog } from '../../shared/source-movement-dialog';
import { PaymentSource } from '../../core/models/domain';
import { ActivatedRoute, Router } from '@angular/router';

interface BankAccountCard {
  readonly key: string;
  readonly source?: PaymentSource;
  readonly profile?: BankActivityProfile;
  readonly bankName: string;
  readonly nickname: string;
  readonly suffix?: string;
  readonly owner: BankActivityProfile['owner'];
  readonly sourceArchived?: boolean;
}

@Component({
  selector: 'app-bank-activity-page',
  imports: [
    ProfileModal,
    ConfirmationDialog,
    ReactiveFormsModule,
    AppIcon,
    AppSelectPicker,
    SourceMovementDialog,
  ],
  templateUrl: './bank-activity.html',
  styleUrl: './bank-activity.scss',
})
export class BankActivityPage {
  readonly activity = inject(BankActivityService);
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly requestedSourceId = this.route.snapshot.queryParamMap.get('source') ?? '';
  private readonly requestedDiscoveryFingerprint =
    this.route.snapshot.queryParamMap.get('discoverCandidate') ?? '';
  readonly returnSmsCandidate = this.route.snapshot.queryParamMap.get('discoverCandidate') ?? '';
  private readonly focusedRequestedSource = signal(false);
  private readonly dateClock = inject(IndiaTodayClock);
  readonly profileFormOpen = signal(false);
  readonly editingMoneySourceId = signal<string | null>(null);
  readonly eventProfileId = signal<string | null>(null);
  readonly editingProfileId = signal<string | null>(null);
  readonly editingEventId = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly android = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  readonly tabs = ['Discovered Accounts', 'Find Banks', 'Bank Activities'] as const;
  readonly activeTab = signal(0);
  readonly deletion = signal<BankActivityEvent | null>(null);
  readonly accountSync = inject(BankAccountSyncService);
  readonly balanceMovement = signal<{ sourceId: string } | null>(null);
  readonly discoveryNotice = signal('');
  readonly mismatchAcknowledged = signal<Readonly<Record<string, boolean>>>({});
  readonly confirmation = signal<{
    fingerprint: string;
    profileId: string;
    acknowledged: boolean;
    message: string;
  } | null>(null);
  readonly identityConfirmation = signal<{
    fingerprint: string;
    profileId: string;
    message: string;
  } | null>(null);
  readonly discoveries = computed(() => {
    const groups = new Map<
      string,
      { id: string; bankName: string; accountSuffix?: string; events: BankActivityCandidate[] }
    >();
    for (const candidate of this.activity.candidates()) {
      const match = this.activity.match(candidate);
      if (['UNIQUE', 'ARCHIVED'].includes(match.state)) continue;
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
      needsIdentification: group.events.some((row) => this.activity.match(row).state !== 'NEW'),
    }));
  });
  readonly reviewCandidates = computed(() => this.activity.candidates());
  readonly evidenceQuery = signal('');
  readonly evidenceFilter = signal('ALL');
  readonly evidenceFilterOptions: readonly AppSelectOption[] = [
    { value: 'ALL', label: 'All evidence' },
    { value: 'UNIDENTIFIED', label: 'Unidentified' },
    { value: 'SUGGESTED', label: 'Suggested match' },
    { value: 'NEEDS_REVIEW', label: 'Needs review' },
    { value: 'ASSOCIATED', label: 'Already associated' },
  ];
  readonly filteredEvidence = computed(() => {
    const query = this.evidenceQuery().trim().toLowerCase();
    const status = this.evidenceFilter();
    return this.reviewCandidates()
      .filter((candidate) => status === 'ALL' || this.evidenceStatus(candidate) === status)
      .filter(
        (candidate) =>
          !query ||
          [
            candidate.bankName,
            candidate.accountSuffix,
            candidate.activityDate,
            candidate.direction,
            candidate.purposeHint,
            candidate.reference,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(query),
      );
  });
  readonly reviewLimit = signal(20);
  readonly visibleReviewCandidates = computed(() =>
    this.filteredEvidence().slice(0, this.reviewLimit()),
  );
  private readonly explicitReviewSelections = signal<Readonly<Record<string, boolean>>>({});
  readonly reviewSelection = signal<Readonly<Record<string, string>>>({});
  readonly bankSources = computed(() =>
    this.store.paymentSources().filter((source) => source.kind === 'DEBIT' && !source.archived),
  );
  readonly activeProfiles = computed(() =>
    this.activity.profiles().filter((profile) => !profile.archived),
  );
  readonly activeMoneySources = computed(() =>
    this.store.paymentSources().filter((source) => source.kind === 'DEBIT' && !source.archived),
  );
  readonly archivedMoneySources = computed(() =>
    this.store.paymentSources().filter((source) => source.kind === 'DEBIT' && source.archived),
  );
  readonly accountCards = computed<readonly BankAccountCard[]>(() => {
    const allSources = this.store.paymentSources().filter((source) => source.kind === 'DEBIT');
    const sources = allSources.filter((source) => !source.archived);
    const profiles = this.activity.profiles();
    const linkedIds = new Set(allSources.map((source) => source.id));
    const sourceCards = sources.map((source) => ({
      key: source.id,
      source,
      profile: profiles.find((profile) => profile.paymentSourceId === source.id),
      bankName: source.institution || 'Bank/UPI',
      nickname: source.nickname,
      suffix: finalThree(source.lastDigits),
      owner: 'OWN' as const,
    }));
    const standaloneProfiles = profiles
      .filter(
        (profile) =>
          !profile.archived &&
          (!profile.paymentSourceId ||
            !linkedIds.has(profile.paymentSourceId) ||
            allSources.find((source) => source.id === profile.paymentSourceId)?.archived),
      )
      .map((profile) => ({
        key: `profile:${profile.id}`,
        source: undefined,
        profile,
        bankName: profile.bankName,
        nickname: profile.nickname || profile.holderName || 'Monitored account',
        suffix: finalThree(profile.accountSuffix),
        owner: profile.owner,
        sourceArchived:
          !!profile.paymentSourceId &&
          !!allSources.find((source) => source.id === profile.paymentSourceId)?.archived,
      }));
    return [...sourceCards, ...standaloneProfiles];
  });
  readonly archivedProfiles = computed(() =>
    this.activity.profiles().filter((profile) => profile.archived),
  );
  readonly sourceOptions = computed<readonly AppSelectOption[]>(() => [
    { value: '', label: 'Standalone monitored account' },
    ...this.bankSources().map((source) => ({
      value: source.id,
      label: `${source.institution || 'Bank'} · ${source.nickname}${finalThree(source.lastDigits) ? ` · ${displayBankAccountSuffix(source.lastDigits)}` : ' · no saved suffix'}`,
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
    accountIdentifier: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.maxLength(60),
        Validators.minLength(3),
        Validators.pattern(/^(?:|[0-9xX*•●×\s-]+)$/),
      ],
    }),
    owner: new FormControl<'OWN' | 'OTHERS' | ''>('OWN', { nonNullable: true }),
    holderName: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    manualOnly: new FormControl(false, { nonNullable: true }),
    allowIdentityConflict: new FormControl(false, { nonNullable: true }),
    confirmOwnershipSync: new FormControl(false, { nonNullable: true }),
    remarks: new FormControl('', { nonNullable: true, validators: Validators.maxLength(300) }),
  });
  readonly moneySourceForm = new FormGroup({
    nickname: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    institution: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    accountIdentifier: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.maxLength(60),
        Validators.pattern(/^[0-9xX*•●×\s-]+$/),
      ],
    }),
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
    if (this.requestedDiscoveryFingerprint) {
      this.activeTab.set(1);
      queueMicrotask(() => void this.findAccounts(this.requestedDiscoveryFingerprint));
    }
    effect(() => {
      const sourceId = this.requestedSourceId;
      if (!sourceId || this.focusedRequestedSource()) return;
      if (!this.accountCards().some((card) => card.source?.id === sourceId)) return;
      this.focusedRequestedSource.set(true);
      queueMicrotask(() => {
        const card = document.getElementById('bank-account-' + sourceId);
        card?.focus();
        card?.scrollIntoView?.({ block: 'center' });
      });
    });
    effect(() => {
      const candidates = this.activity.candidates();
      const explicit = this.explicitReviewSelections();
      const activeIds = new Set(
        this.activity
          .profiles()
          .filter((row) => !row.archived)
          .map((row) => row.id),
      );
      const automaticIds = new Set(
        this.activity
          .profiles()
          .filter((row) => !row.archived && !row.manualOnly)
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
            const resolvedProfile =
              candidate.resolvedAt && candidate.resolvedProfileId
                ? this.activity.profiles().find((row) => row.id === candidate.resolvedProfileId)
                : undefined;
            const resolvedId =
              resolvedProfile && !resolvedProfile.manualOnly
                ? resolvedProfile.id
                : match.suggestedId;
            if (resolvedId && automaticIds.has(resolvedId))
              next[candidate.fingerprint] = resolvedId;
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
          this.profileForm.controls.accountIdentifier.setValue(
            source.accountMask ?? displayBankAccountIdentifier(undefined, source.lastDigits),
          );
        }
      });
    for (const control of [
      this.profileForm.controls.bankName,
      this.profileForm.controls.accountIdentifier,
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
      ? `${displayBankAccountSuffix(source?.lastDigits)} (activity matching: •••${suffix})`
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
  async findAccounts(candidateFingerprint?: string): Promise<void> {
    if (this.activity.discovering()) return;
    this.error.set(null);
    try {
      const count = await this.activity.discoverSavedEvidence();
      const requestedCandidate = candidateFingerprint
        ? this.activity.candidates().find((row) => row.fingerprint === candidateFingerprint)
        : undefined;
      if (requestedCandidate) this.reviewDiscovery(requestedCandidate);
      this.discoveryNotice.set(
        `${count} saved alerts checked. ${this.discoveries().filter((row) => !row.needsIdentification).length} new account suggestions; ${this.reviewCandidates().filter((row) => this.activity.match(row).state === 'UNIQUE').length} existing-account activity suggestions; ${this.activity.candidates().filter((row) => !['NEW', 'UNIQUE'].includes(this.activity.match(row).state)).length} unresolved identity alerts. ` +
          (this.discoveries().some((row) => !row.needsIdentification)
            ? 'Review the suggestions below.'
            : 'No new bank accounts found'),
      );
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error
          ? error.message
          : 'Account discovery could not complete. Retry to resume.',
      );
    }
  }
  returnToSmsReview(): void {
    if (this.returnSmsCandidate)
      void this.router.navigate(['/sms-sync'], {
        queryParams: { review: this.returnSmsCandidate },
      });
  }
  reviewDiscovery(candidate: BankActivityCandidate): void {
    this.startProfile();
    this.profileForm.patchValue({
      bankName: candidate.bankName ?? '',
      accountIdentifier:
        candidate.accountMask ?? displayBankAccountIdentifier(undefined, candidate.accountSuffix),
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
    if (candidate.resolvedAt && candidate.resolvedProfileId) {
      const profile = this.activity
        .profiles()
        .find((row) => row.id === candidate.resolvedProfileId);
      if (profile?.manualOnly)
        return 'A legacy association points to a manual-only profile. It is not an automatic SMS identity; select an account and confirm activity explicitly.';
      return `Account identified as ${profile ? this.profileLabel(profile) : 'an unavailable account'}. Activity still requires separate confirmation.`;
    }
    return this.activity.match(candidate).reason;
  }
  evidenceStatus(candidate: BankActivityCandidate): string {
    if (candidate.resolvedAt && candidate.resolvedProfileId) {
      const profile = this.activity
        .profiles()
        .find((row) => row.id === candidate.resolvedProfileId);
      if (profile && !profile.manualOnly) return 'ASSOCIATED';
      return 'NEEDS_REVIEW';
    }
    const state = this.activity.match(candidate).state;
    if (state === 'UNIQUE') return 'SUGGESTED';
    if (state === 'NEW') return 'UNIDENTIFIED';
    return 'NEEDS_REVIEW';
  }
  evidenceStatusLabel(candidate: BankActivityCandidate): string {
    const labels: Readonly<Record<string, string>> = {
      ASSOCIATED: 'Account identified · activity pending',
      SUGGESTED: 'Suggested match · confirm identity',
      NEEDS_REVIEW: 'Needs review',
      UNIDENTIFIED: 'Unidentified account',
    };
    return labels[this.evidenceStatus(candidate)] ?? 'Needs review';
  }
  maskedReference(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.length > 4 ? `••••${value.slice(-4)}` : '••••';
  }
  canConfirmIdentity(candidate: BankActivityCandidate): boolean {
    const state = this.activity.match(candidate).state;
    const profileId = this.reviewSelection()[candidate.fingerprint];
    const profile = this.activity.profiles().find((row) => row.id === profileId && !row.archived);
    const suffix = finalThree(candidate.accountSuffix);
    return (
      !!profile &&
      !profile.manualOnly &&
      !!suffix &&
      profileSuffix(profile, this.store.paymentSources()) === suffix &&
      state !== 'BANK_MISMATCH' &&
      state !== 'SUFFIX_MISMATCH' &&
      state !== 'ARCHIVED'
    );
  }
  requestIdentityConfirmation(fingerprint: string): void {
    const profileId = this.reviewSelection()[fingerprint];
    const candidate = this.activity.candidates().find((row) => row.fingerprint === fingerprint);
    const profile = this.activity.profiles().find((row) => row.id === profileId && !row.archived);
    if (!candidate || !profile || !this.canConfirmIdentity(candidate)) {
      this.error.set(
        'Choose one active account with a matching saved suffix before identifying this evidence.',
      );
      return;
    }
    this.identityConfirmation.set({
      fingerprint,
      profileId,
      message:
        `Associate this saved SMS evidence with ${this.profileLabel(profile)}? ` +
        'This saves account identity only. It does not record Bank Activity, approve an SMS, create a transaction, or change a balance.',
    });
  }
  async confirmIdentity(): Promise<void> {
    const choice = this.identityConfirmation();
    if (!choice || this.saving()) return;
    this.identityConfirmation.set(null);
    this.error.set(null);
    this.saving.set(true);
    try {
      await this.activity.confirmCandidateIdentity(choice.fingerprint, choice.profileId);
      this.discoveryNotice.set(
        'Account identity saved. Related activity still requires separate review and confirmation; no transaction or balance changed.',
      );
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'Account identity could not be saved.',
      );
    } finally {
      this.saving.set(false);
    }
  }
  selectionConflict(candidate: BankActivityCandidate): boolean {
    const id = this.reviewSelection()[candidate.fingerprint];
    const profile = id ? this.activity.profiles().find((row) => row.id === id) : undefined;
    if (candidate.resolvedAt && candidate.resolvedProfileId === id && !profile?.manualOnly)
      return false;
    return !!id && !this.activity.selectionMatches(candidate, id);
  }
  hasTrustedIdentityAssociation(candidate: BankActivityCandidate): boolean {
    if (!candidate.resolvedAt || !candidate.resolvedProfileId) return false;
    const profile = this.activity.profiles().find((row) => row.id === candidate.resolvedProfileId);
    return !!profile && !profile.archived && !profile.manualOnly;
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

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
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

  accountBalanceLabel(source?: PaymentSource): string {
    if (!source || !this.store.bankCashTracking().enabled) return 'Not tracked';
    if (!bankCashTracked(source, this.store.bankCashTracking())) return 'Balance not set';
    return formatMoney(source.balanceMinor, 'INR');
  }

  canSetBalance(card: BankAccountCard): boolean {
    return (
      card.owner === 'OWN' &&
      !!card.source &&
      !card.source.archived &&
      this.store.bankCashTracking().enabled
    );
  }

  openBalance(card: BankAccountCard): void {
    if (this.canSetBalance(card) && card.source)
      this.balanceMovement.set({ sourceId: card.source.id });
  }

  startProfileForSource(source: PaymentSource): void {
    this.startProfile();
    this.profileForm.patchValue({
      paymentSourceId: source.id,
      bankName: source.institution ?? '',
      nickname: source.nickname,
      accountIdentifier:
        source.accountMask ?? displayBankAccountIdentifier(undefined, source.lastDigits),
      owner: 'OWN',
      manualOnly: false,
    });
  }

  editMoneySource(source: PaymentSource): void {
    if (this.saving() || source.kind !== 'DEBIT' || source.archived) return;
    this.error.set(null);
    this.editingMoneySourceId.set(source.id);
    this.moneySourceForm.reset({
      nickname: source.nickname,
      institution: source.institution ?? '',
      accountIdentifier:
        source.accountMask ?? displayBankAccountIdentifier(undefined, source.lastDigits),
    });
  }

  closeMoneySourceEditor(): void {
    if (!this.saving()) this.editingMoneySourceId.set(null);
  }

  async saveMoneySourceIdentity(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.moneySourceForm.markAllAsTouched();
    if (this.moneySourceForm.invalid) return;
    const sourceId = this.editingMoneySourceId();
    if (!sourceId) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const source = await this.activity.updateOwnMoneySourceIdentity({
        sourceId,
        ...this.moneySourceForm.getRawValue(),
      });
      this.editingMoneySourceId.set(null);
      this.discoveryNotice.set(
        `${source.nickname} identity saved. Its balance, baseline and audit history are unchanged.`,
      );
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Bank identity could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }

  async archiveMoneySource(source: PaymentSource): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      await this.store.updatePaymentSource({ ...source, archived: true });
      this.discoveryNotice.set(
        `${source.nickname} Money Source archived. Its monitoring profile and financial history were not changed.`,
      );
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'Money Source could not be archived.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async restoreMoneySource(source: PaymentSource): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      await this.store.updatePaymentSource({ ...source, archived: false });
      this.discoveryNotice.set(
        `${source.nickname} Money Source restored. Its saved balance and history are unchanged.`,
      );
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'Money Source could not be restored.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async restoreMonitoring(profile: BankActivityProfile): Promise<void> {
    try {
      await this.activity.setArchived(profile.id, false);
      this.discoveryNotice.set(`${this.profileLabel(profile)} monitoring restored.`);
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'Monitoring profile could not be restored.',
      );
    }
  }

  profileLabel(profile: BankActivityProfile): string {
    const suffix = profileSuffix(profile, this.store.paymentSources());
    return `${profile.bankName}${suffix ? ` · •••${suffix}` : ' · manual only'}${profile.nickname ? ` · ${profile.nickname}` : ''}`;
  }

  accountIdentifierLabel(mask?: string, suffix?: string): string {
    return displayBankAccountSuffix(suffix);
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
      accountIdentifier: '',
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
      accountIdentifier:
        profile.accountMask ?? displayBankAccountIdentifier(undefined, profile.accountSuffix),
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
    const returnToEvidence = this.activeTab() === 1;
    if (this.profileForm.invalid) {
      this.error.set(
        'Enter a masked identifier with at least three numeric digits, or choose manual-only monitoring.',
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
      this.activeTab.set(returnToEvidence ? 1 : 0);
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

  closeEvent(): void {
    if (!this.saving()) this.eventProfileId.set(null);
  }

  eventProfileLabel(): string {
    const profile = this.activity.profiles().find((item) => item.id === this.eventProfileId());
    return profile ? this.profileLabel(profile) : '';
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
    this.error.set(null);
    this.deletion.set(event);
  }
  async confirmDeletion(): Promise<void> {
    const event = this.deletion();
    if (!event || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.activity.deleteEvent(event.id);
      this.deletion.set(null);
      this.discoveryNotice.set('Activity deleted. Balances and transactions are unchanged.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Activity could not be deleted.');
    } finally {
      this.saving.set(false);
    }
  }
  tabKey(event: KeyboardEvent, index: number): void {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % this.tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + this.tabs.length - 1) % this.tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = this.tabs.length - 1;
    else return;
    event.preventDefault();
    this.activeTab.set(next);
    document.getElementById('bank-tab-' + next)?.focus();
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
    const conflict = this.selectionConflict(candidate);
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
          : this.activity.reviewNotice() ||
              'This suggestion has already been resolved. No new activity was recorded.',
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
  latestDate(profile: BankActivityProfile, direction: 'DEBIT' | 'CREDIT'): string {
    return (
      this.events(profile).find((row) => row.direction === direction)?.activityDate ?? 'Unknown'
    );
  }
}
