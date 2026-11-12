import { Service, computed, inject, signal } from '@angular/core';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { indiaTodayIso } from '../../core/services/india-date';
import { AppSelectOption } from '../../shared/app-select-picker';
import { LPG_PROVIDERS } from './data/lpg-providers';
import { CYLINDER_OPTIONS } from './data/cylinder-options';
import { assertLpgTimelineChange } from './lpg-lifecycle';
import { MOBILE_OPERATORS } from './data/mobile-operators';
import {
  MOBILE_PLAN_TYPES,
  MOBILE_SUBSCRIPTION_TYPES,
  MobileSubscriptionType,
} from './data/mobile-plan-types';
import {
  addCalendarDays,
  calendarDaysBetween,
  lpgUsageSummary,
  mobileVoiceCoveragePeriods,
  mobileActivitySummary,
  suggestedVoicePlanStart,
  validCalendarDate,
} from './utilities-calculations';
import {
  LpgEvent,
  LpgEventType,
  LpgProfile,
  MobileProfile,
  MobileRecharge,
  TvProfile,
  TvProvider,
  TvRecharge,
  UtilitySettings,
} from './utilities-model';

export const SHOW_INDIAN_UTILITIES_KEY = 'show_indian_utilities';
export const UTILITY_REMINDERS_KEY = 'utility_reminders_enabled';

export interface UtilityReminderTarget {
  readonly id: string;
  readonly profileId: string;
  readonly kind: 'MOBILE_VOICE' | 'MOBILE_PLAN' | 'LPG_ESTIMATE';
  readonly eventDate: string;
  readonly title: string;
  readonly body: string;
  readonly scheduleDate: string;
}

export function normalizeIndianMobileNumber(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const national = /^([6-9]\d{9})$/.exec(trimmed);
  const international =
    /^\+91(?:[\s.-]*([6-9]\d{4})[\s.-]?(\d{5})|[\s.-]*\(([6-9]\d{4})\)[\s.-]*(\d{5}))$/.exec(
      trimmed,
    );
  const tenDigits = national
    ? national[1]
    : international
      ? `${international[1] ?? international[3]}${international[2] ?? international[4]}`
      : undefined;
  if (!tenDigits)
    throw new Error('Enter a ten-digit Indian mobile number, optionally prefixed by +91.');
  return `+91-${tenDigits}`;
}

export function normalizeInternationalPhoneNumber(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || !/^\+?[0-9][0-9\s()-]*$/.test(trimmed)) return undefined;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return undefined;
  if (!trimmed.startsWith('+') && /^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  return digits;
}

function preserveInternationalPhoneDisplay(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 80 || !/^\+?[0-9\s()-]+$/.test(trimmed) || !/\d/.test(trimmed))
    throw new Error('Enter a valid contact number of up to 80 characters.');
  return trimmed;
}

export const UTILITY_REMINDER_OFFSETS = [7, 3, 1, 0] as const;

function reminderTargetsFor(
  profileId: string,
  kind: UtilityReminderTarget['kind'],
  eventDate: string,
  today: string,
  title: string,
  body: string,
  notBefore = today,
): UtilityReminderTarget[] {
  return UTILITY_REMINDER_OFFSETS.flatMap((daysBefore) => {
    const scheduleDate = addCalendarDays(eventDate, -daysBefore);
    return scheduleDate < today || scheduleDate < notBefore
      ? []
      : [
          {
            id: `${profileId}:${kind}:${eventDate}:${daysBefore}`,
            profileId,
            kind,
            scheduleDate,
            eventDate,
            title,
            body,
          },
        ];
  });
}

@Service()
export class UtilitiesService {
  private readonly database = inject(SqliteDatabase);
  readonly settings = signal<UtilitySettings>({
    showIndianUtilities: true,
    utilityReminders: false,
  });
  readonly showIndianUtilities = computed(() => this.settings().showIndianUtilities);
  readonly utilityReminders = computed(() => this.settings().utilityReminders);
  readonly mobileProfiles = signal<readonly MobileProfile[]>([]);
  readonly mobileRecharges = signal<readonly MobileRecharge[]>([]);
  readonly lpgProfiles = signal<readonly LpgProfile[]>([]);
  readonly lpgEvents = signal<readonly LpgEvent[]>([]);
  readonly tvProfiles = signal<readonly TvProfile[]>([]);
  readonly tvRecharges = signal<readonly TvRecharge[]>([]);
  readonly operatorOptions: readonly AppSelectOption[] = MOBILE_OPERATORS.map(
    ({ value, label }) => ({ value, label }),
  );
  readonly subscriptionOptions: readonly AppSelectOption[] = MOBILE_SUBSCRIPTION_TYPES.map(
    ({ value, label }) => ({ value, label }),
  );
  readonly mobilePlanOptions: readonly AppSelectOption[] = MOBILE_PLAN_TYPES.map(
    ({ value, label }) => ({ value, label }),
  );
  readonly lpgProviderOptions: readonly AppSelectOption[] = LPG_PROVIDERS.map(
    ({ value, label }) => ({ value, label }),
  );
  readonly tvProviderOptions: readonly AppSelectOption[] = [
    { value: 'SUN', label: 'Sun' },
    { value: 'TATA_PLAY', label: 'Tata Play' },
    { value: 'AIRTEL', label: 'Airtel' },
    { value: 'VIDEOCON_D2H', label: 'Videocon d2h' },
    { value: 'DISH_TV', label: 'Dish TV' },
    { value: 'JIO_DTH', label: 'Jio DTH' },
    { value: 'OTHER', label: 'Other' },
  ];
  readonly cylinderOptions: readonly AppSelectOption[] = [
    { value: 'SMALL', label: 'Small' },
    { value: 'NORMAL', label: 'Normal' },
  ];
  readonly lpgEventOptions: readonly AppSelectOption[] = [
    { value: 'STARTED', label: 'Cylinder installed / started using' },
    { value: 'EMPTY', label: 'Cylinder became empty' },
    { value: 'REFILL_RECEIVED', label: 'Refill / replacement received' },
  ];

  async initialise(): Promise<void> {
    if (!this.database.ready()) return;
    const rows = await this.database.query<{ key: string; encrypted_value: string }>(
      'SELECT key,encrypted_value FROM app_preferences WHERE key IN (?,?)',
      [SHOW_INDIAN_UTILITIES_KEY, UTILITY_REMINDERS_KEY],
    );
    const values = new Map(rows.map((row) => [row.key, row.encrypted_value]));
    this.settings.set({
      showIndianUtilities: values.get(SHOW_INDIAN_UTILITIES_KEY) !== '0',
      utilityReminders: values.get(UTILITY_REMINDERS_KEY) === '1',
    });
    await this.reload();
  }

  async setShowIndianUtilities(enabled: boolean): Promise<void> {
    await this.writeSetting(SHOW_INDIAN_UTILITIES_KEY, enabled);
    this.settings.update((current) => ({ ...current, showIndianUtilities: enabled }));
  }

  async setUtilityReminders(enabled: boolean): Promise<void> {
    await this.writeSetting(UTILITY_REMINDERS_KEY, enabled);
    this.settings.update((current) => ({ ...current, utilityReminders: enabled }));
  }

  reminderTargets(today = indiaTodayIso()): readonly UtilityReminderTarget[] {
    if (!this.showIndianUtilities() || !this.utilityReminders()) return [];
    const targets: UtilityReminderTarget[] = [];
    for (const profile of this.mobileProfiles().filter((item) => !item.archived)) {
      const plans = this.rechargesFor(profile.id);
      const dataPlanDates = new Map<string, string>();
      for (const plan of plans.filter(
        (item) => item.planType === 'DATA_ONLY' && item.endDate >= today,
      )) {
        const existingStart = dataPlanDates.get(plan.endDate);
        if (!existingStart || plan.startDate < existingStart)
          dataPlanDates.set(plan.endDate, plan.startDate);
      }
      for (const [date, startDate] of dataPlanDates)
        targets.push(
          ...reminderTargetsFor(
            profile.id,
            'MOBILE_PLAN',
            date,
            today,
            'Mobile plan reminder',
            'A recorded recharge plan is approaching its last active day. Check CardNest.',
            startDate,
          ),
        );
      for (const period of mobileVoiceCoveragePeriods(plans, today))
        targets.push(
          ...reminderTargetsFor(
            profile.id,
            'MOBILE_VOICE',
            period.endDate,
            today,
            'Outgoing calling plan reminder',
            'A recorded calling plan is nearing its last active day. Check CardNest.',
            period.startDate,
          ),
        );
    }
    for (const profile of this.lpgProfiles().filter((item) => !item.archived)) {
      const summary = lpgUsageSummary(
        this.eventsFor(profile.id),
        profile.estimatedUsageDays,
        today,
      );
      if (
        summary.estimatedCheckDate &&
        summary.estimatedCheckDate >= today &&
        !summary.currentCylinderEmpty
      )
        targets.push(
          ...reminderTargetsFor(
            profile.id,
            'LPG_ESTIMATE',
            summary.estimatedCheckDate,
            today,
            'Estimated LPG check',
            'Check whether a refill is needed in CardNest. This is an estimate only.',
          ),
        );
    }
    return targets;
  }

  rechargesFor(profileId: string): readonly MobileRecharge[] {
    return this.mobileRecharges().filter((item) => item.profileId === profileId);
  }

  eventsFor(profileId: string): readonly LpgEvent[] {
    return this.lpgEvents().filter((item) => item.profileId === profileId);
  }
  tvRechargesFor(profileId: string): readonly TvRecharge[] {
    return this.tvRecharges().filter((item) => item.profileId === profileId);
  }
  async saveTvProfile(input: {
    id?: string;
    displayName: string;
    provider: TvProvider;
    otherProviderName?: string;
    customerId?: string;
    mobileNumber?: string;
  }): Promise<TvProfile> {
    const displayName = input.displayName.trim();
    const otherProviderName = input.otherProviderName?.trim();
    const customerId = input.customerId?.trim();
    if (!displayName || displayName.length > 80)
      throw new Error('Enter a profile name of up to 80 characters.');
    if (!this.tvProviderOptions.some((item) => item.value === input.provider))
      throw new Error('Choose a supported TV provider.');
    if (input.provider === 'OTHER' && !otherProviderName)
      throw new Error('Enter the TV provider name.');
    if ((otherProviderName?.length ?? 0) > 80 || (customerId?.length ?? 0) > 80)
      throw new Error('Provider and customer IDs must be 80 characters or fewer.');
    const mobileNumber = normalizeIndianMobileNumber(input.mobileNumber ?? '');
    const timestamp = new Date().toISOString();
    const existing = input.id ? this.tvProfiles().find((item) => item.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('TV profile not found.');
    const profile: TvProfile = {
      id: existing?.id ?? crypto.randomUUID(),
      kind: 'TV',
      displayName,
      provider: input.provider,
      otherProviderName: input.provider === 'OTHER' ? otherProviderName : undefined,
      customerId: customerId || undefined,
      mobileNumber,
      archived: existing?.archived ?? false,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.database.run(
      'INSERT INTO tv_profiles(id,provider,archived,payload,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,archived=excluded.archived,payload=excluded.payload,updated_at=excluded.updated_at',
      [
        profile.id,
        profile.provider,
        profile.archived ? 1 : 0,
        JSON.stringify(profile),
        profile.createdAt,
        timestamp,
      ],
    );
    this.tvProfiles.update((items) => [profile, ...items.filter((item) => item.id !== profile.id)]);
    return profile;
  }
  async setTvArchived(profileId: string, archived: boolean): Promise<void> {
    const profile = this.tvProfiles().find((item) => item.id === profileId);
    if (!profile) throw new Error('TV profile not found.');
    const updated = { ...profile, archived, updatedAt: new Date().toISOString() };
    await this.database.run('UPDATE tv_profiles SET archived=?,payload=?,updated_at=? WHERE id=?', [
      archived ? 1 : 0,
      JSON.stringify(updated),
      updated.updatedAt,
      profileId,
    ]);
    this.tvProfiles.update((items) =>
      items.map((item) => (item.id === profileId ? updated : item)),
    );
  }
  async saveTvRecharge(input: {
    id?: string;
    profileId: string;
    amountMinor?: number;
    startDate: string;
    endDate?: string;
    durationDays?: number;
    notes?: string;
  }): Promise<TvRecharge> {
    if (!validCalendarDate(input.startDate)) throw new Error('Enter a valid recharge start date.');
    if (
      input.amountMinor !== undefined &&
      (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    )
      throw new Error('Enter a positive recharge amount.');
    let endDate = input.endDate?.trim() ?? '';
    if (!endDate) {
      if (!Number.isSafeInteger(input.durationDays) || (input.durationDays ?? 0) <= 0)
        throw new Error('Enter a valid end date or positive duration.');
      endDate = addCalendarDays(input.startDate, (input.durationDays ?? 1) - 1);
    }
    if (!validCalendarDate(endDate) || endDate < input.startDate)
      throw new Error('Recharge end date must be on or after its start date.');
    const timestamp = new Date().toISOString();
    const today = indiaTodayIso();
    const recharge = await this.database.atomic(async (tx) => {
      const [profileRow] = await tx.query<{ payload: string }>(
        'SELECT payload FROM tv_profiles WHERE id=? AND archived=0',
        [input.profileId],
      );
      if (!profileRow) throw new Error('Choose an active TV profile.');
      const rows = await tx.query<{ payload: string }>(
        'SELECT payload FROM tv_recharges WHERE profile_id=? ORDER BY start_date DESC,id',
        [input.profileId],
      );
      const records = rows.map((row) => JSON.parse(row.payload) as TvRecharge);
      const previous = input.id ? records.find((item) => item.id === input.id) : undefined;
      if (input.id && !previous) throw new Error('TV recharge was not found on this profile.');
      if (previous && previous.endDate < today)
        throw new Error('Expired TV recharge history is read-only. Create a new recharge instead.');
      const others = records.filter((item) => item.id !== previous?.id);
      if (!previous && others.some((item) => item.endDate >= today))
        throw new Error('An active or scheduled recharge already exists. Edit or cancel it first.');
      if (others.some((item) => input.startDate <= item.endDate && endDate >= item.startDate))
        throw new Error('TV recharge dates overlap another saved recharge.');
      const saved: TvRecharge = {
        id: previous?.id ?? crypto.randomUUID(),
        profileId: input.profileId,
        amountMinor: input.amountMinor,
        startDate: input.startDate,
        endDate,
        durationDays: calendarDaysBetween(input.startDate, endDate) + 1,
        notes: input.notes?.trim().slice(0, 300) || undefined,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await tx.run(
        'INSERT INTO tv_recharges(id,profile_id,start_date,end_date,amount_minor,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET start_date=excluded.start_date,end_date=excluded.end_date,amount_minor=excluded.amount_minor,payload=excluded.payload,updated_at=excluded.updated_at',
        [
          saved.id,
          saved.profileId,
          saved.startDate,
          saved.endDate,
          saved.amountMinor ?? null,
          JSON.stringify(saved),
          saved.createdAt,
          timestamp,
        ],
      );
      return saved;
    });
    this.tvRecharges.update((items) => [
      recharge,
      ...items.filter((item) => item.id !== recharge.id),
    ]);
    return recharge;
  }

  async deleteTvRecharge(id: string): Promise<void> {
    await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ payload: string }>(
        'SELECT payload FROM tv_recharges WHERE id=?',
        [id],
      );
      if (!row) throw new Error('TV recharge was not found.');
      const recharge = JSON.parse(row.payload) as TvRecharge;
      if (recharge.endDate < indiaTodayIso())
        throw new Error('Expired TV recharge history is read-only.');
      await tx.run('DELETE FROM tv_recharges WHERE id=?', [id]);
    });
    this.tvRecharges.update((items) => items.filter((item) => item.id !== id));
  }

  async deleteTvProfile(profileId: string): Promise<void> {
    await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ id: string }>('SELECT id FROM tv_profiles WHERE id=?', [
        profileId,
      ]);
      if (!row) throw new Error('TV profile was not found.');
      await tx.run('DELETE FROM tv_recharges WHERE profile_id=?', [profileId]);
      await tx.run('DELETE FROM tv_profiles WHERE id=?', [profileId]);
    });
    this.tvRecharges.update((items) => items.filter((item) => item.profileId !== profileId));
    this.tvProfiles.update((items) => items.filter((item) => item.id !== profileId));
  }

  suggestedRechargeStart(profileId: string): string {
    return suggestedVoicePlanStart(this.rechargesFor(profileId), indiaTodayIso());
  }

  mobileSummary(profile: MobileProfile, today = indiaTodayIso()) {
    return mobileActivitySummary(this.rechargesFor(profile.id), profile.subscriptionType, today);
  }

  lpgSummary(profile: LpgProfile, today = indiaTodayIso()) {
    return lpgUsageSummary(this.eventsFor(profile.id), profile.estimatedUsageDays, today);
  }

  async saveMobileProfile(input: {
    id?: string;
    personName: string;
    subscriptionType: MobileSubscriptionType;
    operator: MobileProfile['operator'];
    mobileNumber?: string;
  }): Promise<MobileProfile> {
    const personName = input.personName.trim().slice(0, 80);
    if (!personName) throw new Error("Enter the person's name.");
    if (!MOBILE_OPERATORS.some((item) => item.value === input.operator))
      throw new Error('Choose a supported Indian operator.');
    if (!MOBILE_SUBSCRIPTION_TYPES.some((item) => item.value === input.subscriptionType))
      throw new Error('Choose Prepaid or Postpaid.');
    const timestamp = new Date().toISOString();
    const prior = input.id ? this.mobileProfiles().find((item) => item.id === input.id) : undefined;
    if (input.id && !prior) throw new Error('This mobile profile no longer exists.');
    const profile: MobileProfile = {
      id: prior?.id ?? crypto.randomUUID(),
      kind: 'MOBILE',
      personName,
      subscriptionType: input.subscriptionType,
      operator: input.operator,
      mobileNumber: normalizeIndianMobileNumber(input.mobileNumber ?? ''),
      archived: prior?.archived ?? false,
      createdAt: prior?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.database.atomic(async (tx) => {
      await tx.run(
        `INSERT INTO utility_profiles(id,kind,archived,payload,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET archived=excluded.archived,payload=excluded.payload,updated_at=excluded.updated_at`,
        [
          profile.id,
          profile.kind,
          profile.archived ? 1 : 0,
          JSON.stringify(profile),
          profile.createdAt,
          timestamp,
        ],
      );
    });
    this.mobileProfiles.update((items) => [
      profile,
      ...items.filter((item) => item.id !== profile.id),
    ]);
    return profile;
  }

  async setMobileArchived(profileId: string, archived: boolean): Promise<void> {
    const profile = this.mobileProfiles().find((item) => item.id === profileId);
    if (!profile) throw new Error('Mobile profile not found.');
    const updated = { ...profile, archived, updatedAt: new Date().toISOString() };
    await this.database.run(
      "UPDATE utility_profiles SET archived=?,payload=?,updated_at=? WHERE id=? AND kind='MOBILE'",
      [archived ? 1 : 0, JSON.stringify(updated), updated.updatedAt, profileId],
    );
    this.mobileProfiles.update((items) =>
      items.map((item) => (item.id === profileId ? updated : item)),
    );
  }

  async saveRecharge(input: {
    id?: string;
    profileId: string;
    planType: MobileRecharge['planType'];
    amountMinor?: number;
    startDate: string;
    validityDays?: number;
    endDate?: string;
    comment?: string;
  }): Promise<MobileRecharge> {
    const profile = this.mobileProfiles().find(
      (item) => item.id === input.profileId && !item.archived,
    );
    if (!profile) throw new Error('Choose an active mobile profile.');
    if (!MOBILE_PLAN_TYPES.some((item) => item.value === input.planType))
      throw new Error('Choose a plan type.');
    if (!validCalendarDate(input.startDate)) throw new Error('Enter a valid start date.');
    const endDate =
      input.validityDays !== undefined
        ? Number.isSafeInteger(input.validityDays) && input.validityDays > 0
          ? addCalendarDays(input.startDate, input.validityDays - 1)
          : (() => {
              throw new Error('Validity must be a positive whole number of days.');
            })()
        : input.endDate;
    if (!endDate || !validCalendarDate(endDate) || endDate < input.startDate)
      throw new Error('Choose a valid last-active date on or after the start date.');
    if (
      input.amountMinor !== undefined &&
      (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0)
    )
      throw new Error('Enter a valid recharge amount.');
    const timestamp = new Date().toISOString();
    const existing = input.id
      ? this.mobileRecharges().find((item) => item.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error('Recharge record not found.');
    const recharge: MobileRecharge = {
      id: existing?.id ?? crypto.randomUUID(),
      profileId: input.profileId,
      planType: input.planType,
      amountMinor: input.amountMinor,
      startDate: input.startDate,
      endDate,
      comment: input.comment?.trim().slice(0, 300) || undefined,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.database.run(
      `INSERT INTO mobile_recharges(id,profile_id,start_date,end_date,plan_type,amount_minor,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,start_date=excluded.start_date,end_date=excluded.end_date,plan_type=excluded.plan_type,amount_minor=excluded.amount_minor,payload=excluded.payload,updated_at=excluded.updated_at`,
      [
        recharge.id,
        recharge.profileId,
        recharge.startDate,
        recharge.endDate,
        recharge.planType,
        recharge.amountMinor ?? null,
        JSON.stringify(recharge),
        recharge.createdAt,
        timestamp,
      ],
    );
    this.mobileRecharges.update((items) => [
      recharge,
      ...items.filter((item) => item.id !== recharge.id),
    ]);
    return recharge;
  }

  async deleteRecharge(id: string): Promise<void> {
    await this.database.run('DELETE FROM mobile_recharges WHERE id=?', [id]);
    this.mobileRecharges.update((items) => items.filter((item) => item.id !== id));
  }

  async deleteMobileProfile(profileId: string): Promise<void> {
    await this.database.atomic(async (tx) => {
      const [profile] = await tx.query<{ id: string }>(
        "SELECT id FROM utility_profiles WHERE id=? AND kind='MOBILE'",
        [profileId],
      );
      if (!profile) throw new Error('Mobile profile not found.');
      await tx.run('DELETE FROM mobile_recharges WHERE profile_id=?', [profileId]);
      await tx.run("DELETE FROM utility_profiles WHERE id=? AND kind='MOBILE'", [profileId]);
    });
    this.mobileRecharges.update((items) => items.filter((item) => item.profileId !== profileId));
    this.mobileProfiles.update((items) => items.filter((item) => item.id !== profileId));
  }

  async saveLpgProfile(
    input: Omit<LpgProfile, 'id' | 'kind' | 'archived' | 'createdAt' | 'updatedAt'> & {
      id?: string;
    },
  ): Promise<LpgProfile> {
    const connectionName = input.connectionName.trim().slice(0, 80);
    if (!connectionName) throw new Error('Enter a connection name.');
    if (!LPG_PROVIDERS.some((item) => item.value === input.provider))
      throw new Error('Choose an LPG provider.');
    if (
      !Number.isSafeInteger(input.estimatedUsageDays) ||
      input.estimatedUsageDays < 1 ||
      input.estimatedUsageDays > 365
    )
      throw new Error('Estimated usage must be between 1 and 365 days.');
    const timestamp = new Date().toISOString();
    const previous = input.id ? this.lpgProfiles().find((item) => item.id === input.id) : undefined;
    if (input.id && !previous) throw new Error('LPG connection not found.');
    const profile: LpgProfile = {
      ...input,
      connectionName,
      mobileNumber: normalizeIndianMobileNumber(input.mobileNumber ?? ''),
      distributorContact: preserveInternationalPhoneDisplay(input.distributorContact ?? ''),
      distributorWhatsApp: preserveInternationalPhoneDisplay(input.distributorWhatsApp ?? ''),
      id: previous?.id ?? crypto.randomUUID(),
      kind: 'LPG',
      archived: previous?.archived ?? false,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.database.run(
      `INSERT INTO utility_profiles(id,kind,archived,payload,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET archived=excluded.archived,payload=excluded.payload,updated_at=excluded.updated_at`,
      [
        profile.id,
        profile.kind,
        profile.archived ? 1 : 0,
        JSON.stringify(profile),
        profile.createdAt,
        timestamp,
      ],
    );
    this.lpgProfiles.update((items) => [
      profile,
      ...items.filter((item) => item.id !== profile.id),
    ]);
    return profile;
  }

  async setLpgArchived(profileId: string, archived: boolean): Promise<void> {
    const profile = this.lpgProfiles().find((item) => item.id === profileId);
    if (!profile) throw new Error('LPG connection not found.');
    const updated = { ...profile, archived, updatedAt: new Date().toISOString() };
    await this.database.run(
      "UPDATE utility_profiles SET archived=?,payload=?,updated_at=? WHERE id=? AND kind='LPG'",
      [archived ? 1 : 0, JSON.stringify(updated), updated.updatedAt, profileId],
    );
    this.lpgProfiles.update((items) =>
      items.map((item) => (item.id === profileId ? updated : item)),
    );
  }

  async saveLpgEvent(input: {
    id?: string;
    profileId: string;
    eventType: LpgEventType;
    eventDate: string;
    amountMinor?: number;
    cylinderSize?: LpgEvent['cylinderSize'];
    comment?: string;
  }): Promise<LpgEvent> {
    if (!this.lpgProfiles().some((item) => item.id === input.profileId && !item.archived))
      throw new Error('Choose an active LPG connection.');
    if (!validCalendarDate(input.eventDate)) throw new Error('Enter a valid event date.');
    if (!['STARTED', 'EMPTY', 'REFILL_RECEIVED'].includes(input.eventType))
      throw new Error('Choose a cylinder event.');
    if (
      input.amountMinor !== undefined &&
      (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0)
    )
      throw new Error('Enter a valid amount.');
    if (
      input.cylinderSize !== undefined &&
      !CYLINDER_OPTIONS.some((size) => size.value === input.cylinderSize)
    )
      throw new Error('Choose a supported cylinder size.');
    const event = await this.database.atomic(async (tx) => {
      const [profile] = await tx.query<{ id: string; archived: number; payload: string }>(
        "SELECT id,archived,payload FROM utility_profiles WHERE id=? AND kind='LPG'",
        [input.profileId],
      );
      if (!profile || profile.archived) throw new Error('Choose an active LPG connection.');
      const rows = await tx.query<{ payload: string }>(
        'SELECT payload FROM lpg_events WHERE profile_id=? ORDER BY event_date,created_at,rowid',
        [input.profileId],
      );
      const before = rows.map((row) => JSON.parse(row.payload) as LpgEvent);
      const previous = input.id ? before.find((item) => item.id === input.id) : undefined;
      if (input.id && !previous) throw new Error('LPG event not found on this connection.');
      const timestamp = new Date().toISOString();
      const saved: LpgEvent = {
        ...input,
        cylinderSize: (JSON.parse(profile.payload) as LpgProfile).cylinderSize,
        id: previous?.id ?? crypto.randomUUID(),
        comment: input.comment?.trim().slice(0, 300) || undefined,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      assertLpgTimelineChange(
        before,
        previous ? before.map((item) => (item.id === saved.id ? saved : item)) : [...before, saved],
        saved.id,
      );
      await tx.run(
        `INSERT INTO lpg_events(id,profile_id,event_type,event_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,event_type=excluded.event_type,event_date=excluded.event_date,payload=excluded.payload,updated_at=excluded.updated_at`,
        [
          saved.id,
          saved.profileId,
          saved.eventType,
          saved.eventDate,
          JSON.stringify(saved),
          saved.createdAt,
          timestamp,
        ],
      );
      return saved;
    });
    this.lpgEvents.update((items) =>
      items.some((item) => item.id === event.id)
        ? items.map((item) => (item.id === event.id ? event : item))
        : [...items, event],
    );
    return event;
  }

  async deleteLpgEvent(id: string): Promise<void> {
    await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ payload: string }>(
        'SELECT payload FROM lpg_events WHERE id=?',
        [id],
      );
      if (!row) throw new Error('LPG event not found.');
      const event = JSON.parse(row.payload) as LpgEvent;
      const rows = await tx.query<{ payload: string }>(
        'SELECT payload FROM lpg_events WHERE profile_id=? ORDER BY event_date,created_at,rowid',
        [event.profileId],
      );
      const before = rows.map((item) => JSON.parse(item.payload) as LpgEvent);
      assertLpgTimelineChange(
        before,
        before.filter((item) => item.id !== id),
      );
      await tx.run('DELETE FROM lpg_events WHERE id=?', [id]);
    });
    this.lpgEvents.update((items) => items.filter((item) => item.id !== id));
  }

  async deleteLpgProfile(profileId: string): Promise<void> {
    await this.database.atomic(async (tx) => {
      const [profile] = await tx.query<{ id: string }>(
        "SELECT id FROM utility_profiles WHERE id=? AND kind='LPG'",
        [profileId],
      );
      if (!profile) throw new Error('LPG connection not found.');
      await tx.run('DELETE FROM lpg_events WHERE profile_id=?', [profileId]);
      await tx.run("DELETE FROM utility_profiles WHERE id=? AND kind='LPG'", [profileId]);
    });
    this.lpgEvents.update((items) => items.filter((item) => item.profileId !== profileId));
    this.lpgProfiles.update((items) => items.filter((item) => item.id !== profileId));
  }

  async reload(): Promise<void> {
    if (!this.database.ready()) return;
    const [profiles, recharges, events, tvProfiles, tvRecharges] = await Promise.all([
      this.database.query<{ payload: string }>(
        "SELECT payload FROM utility_profiles WHERE kind='MOBILE' ORDER BY created_at DESC",
      ),
      this.database.query<{ payload: string }>(
        'SELECT payload FROM mobile_recharges ORDER BY start_date DESC',
      ),
      this.database.query<{ payload: string }>(
        'SELECT payload FROM lpg_events ORDER BY event_date,created_at,rowid',
      ),
      this.database.query<{ payload: string }>(
        'SELECT payload FROM tv_profiles ORDER BY created_at DESC',
      ),
      this.database.query<{ payload: string }>(
        'SELECT payload FROM tv_recharges ORDER BY start_date DESC',
      ),
    ]);
    const lpgProfiles = await this.database.query<{ payload: string }>(
      "SELECT payload FROM utility_profiles WHERE kind='LPG' ORDER BY created_at DESC",
    );
    this.mobileProfiles.set(profiles.map((row) => JSON.parse(row.payload) as MobileProfile));
    this.mobileRecharges.set(recharges.map((row) => JSON.parse(row.payload) as MobileRecharge));
    this.lpgProfiles.set(lpgProfiles.map((row) => JSON.parse(row.payload) as LpgProfile));
    this.lpgEvents.set(events.map((row) => JSON.parse(row.payload) as LpgEvent));
    this.tvProfiles.set(tvProfiles.map((row) => JSON.parse(row.payload) as TvProfile));
    this.tvRecharges.set(tvRecharges.map((row) => JSON.parse(row.payload) as TvRecharge));
  }

  private async writeSetting(key: string, enabled: boolean): Promise<void> {
    if (!this.database.ready()) throw new Error('SQLite storage is unavailable.');
    await this.database.run(
      `INSERT INTO app_preferences(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value`,
      [key, enabled ? '1' : '0'],
    );
  }
}
