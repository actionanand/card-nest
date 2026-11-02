import { Service, computed, inject, signal } from '@angular/core';
import { DatabaseSession, SqliteDatabase } from '../data/sqlite-database';
import {
  ConsumerWallet,
  ConsumerWalletEvent,
  ConsumerWalletEventAllocation,
  ConsumerWalletKind,
  PaymentSource,
} from '../models/domain';
import { APP_ENVIRONMENT } from './app-environment';
import { CardNestStore } from './card-nest-store';
import { indiaTodayIso } from './india-date';
import {
  CONSUMER_WALLET_PROVIDERS,
  ConsumerWalletProviderId,
} from '../../features/wallets/consumer-wallet-providers';

export type WalletsFeatureState = 'NEVER_CONFIGURED' | 'ENABLED' | 'DISABLED';
export type WalletSetupKind = 'FASTAG' | 'CONSUMER';

export interface WalletSetupIntent {
  readonly id: string;
  readonly kind: WalletSetupKind;
  readonly createdAt: string;
}

export interface WalletPurchaseInput {
  readonly id: string;
  readonly walletId: string;
  readonly amountMinor: number;
  readonly eventDate: string;
  readonly eventTime?: string;
  readonly categoryId: string;
  readonly merchant?: string;
  readonly notes?: string;
}

type WalletEventPosition = Pick<
  ConsumerWalletEvent,
  'id' | 'eventDate' | 'eventTime' | 'createdAt'
>;

export const WALLETS_FEATURE_STATE_KEY = 'consumer_wallets_feature_state';
export const WALLETS_SETUP_INTENT_KEY = 'consumer_wallets_setup_intent';

function parseSetupIntent(value: string | undefined): WalletSetupIntent | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('id' in parsed) ||
      typeof parsed.id !== 'string' ||
      !('kind' in parsed) ||
      (parsed.kind !== 'FASTAG' && parsed.kind !== 'CONSUMER') ||
      !('createdAt' in parsed) ||
      typeof parsed.createdAt !== 'string'
    )
      return null;
    return parsed as WalletSetupIntent;
  } catch {
    return null;
  }
}

@Service()
export class ConsumerWalletService {
  private readonly database = inject(SqliteDatabase);
  private readonly environment = inject(APP_ENVIRONMENT);
  private readonly store = inject(CardNestStore);
  readonly wallets = signal<readonly ConsumerWallet[]>([]);
  readonly events = signal<readonly ConsumerWalletEvent[]>([]);
  readonly allocations = signal<readonly ConsumerWalletEventAllocation[]>([]);
  readonly featureState = signal<WalletsFeatureState>('NEVER_CONFIGURED');
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly enabled = computed(() => this.featureState() === 'ENABLED');
  readonly setupIntent = signal<WalletSetupIntent | null>(null);
  readonly activeWallets = computed(() => this.wallets().filter((wallet) => !wallet.archived));
  readonly archivedWallets = computed(() => this.wallets().filter((wallet) => wallet.archived));
  readonly hasEligibleWallets = computed(
    () =>
      this.wallets().length > 0 ||
      this.store.paymentSources().some((source) => source.kind === 'FASTAG'),
  );
  readonly showWalletNavigation = computed(
    () =>
      this.enabled() ||
      this.wallets().length > 0 ||
      !!this.loadError() ||
      this.store.paymentSources().some((source) => source.kind === 'FASTAG'),
  );
  readonly activeWalletLimit = this.environment.maxWallets;
  readonly balances = computed(() => {
    const totals = new Map<string, number>();
    const today = indiaTodayIso();
    for (const event of this.events()) {
      if (event.eventDate > today) continue;
      totals.set(event.walletId, (totals.get(event.walletId) ?? 0) + event.balanceDeltaMinor);
    }
    return totals;
  });

  async initialise(): Promise<void> {
    if (!this.database.ready()) {
      this.loadError.set('Wallet storage is unavailable. Wallet data has not been changed.');
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const state = await this.database.atomic(async (tx) => {
        const preferences = await tx.query<{ key: string; encrypted_value: string }>(
          'SELECT key,encrypted_value FROM app_preferences WHERE key IN (?,?,?)',
          [WALLETS_FEATURE_STATE_KEY, WALLETS_SETUP_INTENT_KEY, 'payment_sources'],
        );
        const values = new Map(preferences.map((row) => [row.key, row.encrypted_value]));
        const wallets = await tx.query<{ payload: string }>(
          'SELECT payload FROM consumer_wallets ORDER BY created_at,id',
        );
        const savedState = values.get(WALLETS_FEATURE_STATE_KEY);
        let featureState: WalletsFeatureState =
          savedState === 'ENABLED' || savedState === 'DISABLED' || savedState === 'NEVER_CONFIGURED'
            ? savedState
            : 'NEVER_CONFIGURED';
        if (
          savedState !== 'ENABLED' &&
          savedState !== 'DISABLED' &&
          savedState !== 'NEVER_CONFIGURED'
        ) {
          const hasFastag = (() => {
            try {
              const sources = JSON.parse(values.get('payment_sources') ?? '[]') as PaymentSource[];
              return sources.some((source) => source.kind === 'FASTAG');
            } catch {
              return false;
            }
          })();
          featureState = wallets.length || hasFastag ? 'ENABLED' : 'NEVER_CONFIGURED';
          await this.writePreference(tx, WALLETS_FEATURE_STATE_KEY, featureState);
        }
        // A setup form interrupted by process death is never allowed to enable the feature later.
        await tx.run('DELETE FROM app_preferences WHERE key=?', [WALLETS_SETUP_INTENT_KEY]);
        const events = await tx.query<{ payload: string }>(
          'SELECT payload FROM consumer_wallet_events ORDER BY event_date DESC,created_at DESC',
        );
        const allocations = await tx.query<{
          id: string;
          debit_event_id: string;
          credit_event_id: string;
          allocated_minor: number;
          expense_reversal_minor: number;
          created_at: string;
        }>('SELECT * FROM consumer_wallet_event_allocations ORDER BY created_at,id');
        return {
          featureState,
          wallets: wallets.map((row) => JSON.parse(row.payload) as ConsumerWallet),
          events: events.map((row) => JSON.parse(row.payload) as ConsumerWalletEvent),
          allocations: allocations.map((row) => ({
            id: row.id,
            debitEventId: row.debit_event_id,
            creditEventId: row.credit_event_id,
            allocatedMinor: row.allocated_minor,
            expenseReversalMinor: row.expense_reversal_minor,
            createdAt: row.created_at,
          })),
        };
      });
      this.featureState.set(state.featureState);
      this.wallets.set(state.wallets);
      this.events.set(state.events);
      this.allocations.set(state.allocations);
      this.setupIntent.set(null);
    } catch (error: unknown) {
      this.loadError.set(
        error instanceof Error
          ? `Wallet data could not be loaded. Existing data was preserved. (${error.message})`
          : 'Wallet data could not be loaded. Existing data was preserved.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const state = await this.database.atomic(async (tx) => {
      if (enabled) {
        const [walletCount] = await tx.query<{ count: number }>(
          'SELECT COUNT(*) AS count FROM consumer_wallets',
        );
        const [sourcesRow] = await tx.query<{ encrypted_value: string }>(
          "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
        );
        const sources: PaymentSource[] = (() => {
          try {
            return JSON.parse(sourcesRow?.encrypted_value ?? '[]') as PaymentSource[];
          } catch {
            return [];
          }
        })();
        if (!walletCount.count && !sources.some((source) => source.kind === 'FASTAG'))
          throw new Error('Register a FASTag wallet or consumer wallet before enabling Wallets.');
      }
      const next: WalletsFeatureState = enabled ? 'ENABLED' : 'DISABLED';
      await this.writePreference(tx, WALLETS_FEATURE_STATE_KEY, next);
      if (!enabled)
        await tx.run('DELETE FROM app_preferences WHERE key=?', [WALLETS_SETUP_INTENT_KEY]);
      return next;
    });
    this.featureState.set(state);
    if (!enabled) this.setupIntent.set(null);
  }

  async beginSetup(kind: WalletSetupKind): Promise<WalletSetupIntent> {
    const intent: WalletSetupIntent = {
      id: crypto.randomUUID(),
      kind,
      createdAt: new Date().toISOString(),
    };
    await this.database.atomic(async (tx) => {
      if (this.featureState() === 'ENABLED') throw new Error('Wallets are already enabled.');
      await this.writePreference(tx, WALLETS_SETUP_INTENT_KEY, JSON.stringify(intent));
    });
    this.setupIntent.set(intent);
    return intent;
  }

  async cancelSetup(intentId?: string): Promise<void> {
    const active = this.setupIntent();
    if (!active || (intentId && active.id !== intentId)) return;
    await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM app_preferences WHERE key=?',
        [WALLETS_SETUP_INTENT_KEY],
      );
      if (parseSetupIntent(row?.encrypted_value)?.id === active.id)
        await tx.run('DELETE FROM app_preferences WHERE key=?', [WALLETS_SETUP_INTENT_KEY]);
    });
    this.setupIntent.set(null);
  }

  async registerWallet(input: {
    providerId: ConsumerWalletProviderId;
    customName?: string;
    nickname?: string;
    setupIntentId?: string;
  }): Promise<ConsumerWallet> {
    if (!CONSUMER_WALLET_PROVIDERS.some((provider) => provider.id === input.providerId))
      throw new Error('Choose a supported wallet provider.');
    const customName = input.customName?.trim();
    const nickname = input.nickname?.trim();
    if (input.providerId === 'other' && !customName) throw new Error('Enter a custom wallet name.');
    if (input.providerId !== 'other' && customName)
      throw new Error('A custom wallet name is only valid for Other.');
    if ((customName?.length ?? 0) > 80 || /[\r\n\0]/.test(customName ?? ''))
      throw new Error('Custom wallet names must be a single line of at most 80 characters.');
    if ((nickname?.length ?? 0) > 80 || /[\r\n\0]/.test(nickname ?? ''))
      throw new Error('Wallet nicknames must be a single line of at most 80 characters.');
    const timestamp = new Date().toISOString();
    const wallet: ConsumerWallet = {
      id: crypto.randomUUID(),
      providerId: input.providerId,
      kind: input.providerId === 'upi-lite' ? 'UPI_LITE' : 'STANDARD',
      customName: input.providerId === 'other' ? customName : undefined,
      nickname: nickname || undefined,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const next = await this.database.atomic(async (tx) => {
      await this.assertSetupIntent(tx, input.setupIntentId, 'CONSUMER');
      const current = await this.readWallets(tx);
      if (current.filter((item) => !item.archived).length >= this.activeWalletLimit)
        throw new Error(
          `You can register up to ${this.activeWalletLimit} active wallets. Archive or delete an eligible wallet first.`,
        );
      const identity = this.walletIdentity(wallet);
      if (current.some((item) => this.walletIdentity(item) === identity))
        throw new Error(
          'This wallet identity already exists. Restore its archived record instead.',
        );
      await this.insertWallet(tx, wallet);
      await this.completeSetup(tx, input.setupIntentId);
      return [...current, wallet];
    });
    this.wallets.set(next);
    this.featureState.set('ENABLED');
    this.setupIntent.set(null);
    return wallet;
  }

  async saveFastagWallet(source: PaymentSource, setupIntentId?: string): Promise<void> {
    if (
      source.kind !== 'FASTAG' ||
      !source.id.trim() ||
      !source.nickname.trim() ||
      source.nickname.trim().length > 80 ||
      (source.institution?.trim().length ?? 0) > 80 ||
      source.archived ||
      !/^[A-Z0-9]{5,16}$/.test(source.vehicleNumber ?? '')
    )
      throw new Error('Enter a wallet name and vehicle registration.');
    const result = await this.database.atomic(async (tx) => {
      await this.assertSetupIntent(tx, setupIntentId, 'FASTAG');
      const featureState = await this.readFeatureState(tx);
      const [row] = await tx.query<{ encrypted_value: string }>(
        "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
      );
      const stored = row
        ? (JSON.parse(row.encrypted_value) as PaymentSource[])
        : this.store.paymentSources().map((item) => ({ ...item }));
      if (stored.some((item) => item.id === source.id)) throw new Error('Wallet already exists.');
      const next = [...stored, source];
      await this.writePreference(tx, 'payment_sources', JSON.stringify(next));
      if (setupIntentId || featureState !== 'DISABLED') await this.completeSetup(tx, setupIntentId);
      return {
        sources: next,
        featureState: setupIntentId || featureState !== 'DISABLED' ? 'ENABLED' : 'DISABLED',
      } as const;
    });
    this.store.paymentSources.set(result.sources);
    this.featureState.set(result.featureState);
    if (setupIntentId) this.setupIntent.set(null);
  }

  async addWalletCredit(input: {
    id: string;
    walletId: string;
    amountMinor: number;
    eventType: 'MANUAL_CREDIT' | 'PROMOTIONAL_CREDIT';
    eventDate?: string;
    memo?: string;
  }): Promise<ConsumerWalletEvent> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('Enter a positive wallet credit amount.');
    const eventDate = input.eventDate ?? indiaTodayIso();
    this.assertWalletDate(eventDate);
    const event = await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      await this.assertActiveWallet(tx, input.walletId);
      const duplicate = await this.readIdempotentEvent(
        tx,
        input.id,
        input.walletId,
        input.eventType,
        input.amountMinor,
        eventDate,
      );
      if (duplicate)
        return { event: duplicate, allocations: [] as ConsumerWalletEventAllocation[] };
      const timestamp = new Date().toISOString();
      const record: ConsumerWalletEvent = {
        id: input.id,
        walletId: input.walletId,
        eventType: input.eventType,
        eventDate,
        amountMinor: input.amountMinor,
        balanceDeltaMinor: input.amountMinor,
        memo: input.memo?.trim().slice(0, 200) || undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.insertEvent(tx, record);
      await this.assertChronologicalLedger(tx, input.walletId);
      return { event: record, allocations: [] as ConsumerWalletEventAllocation[] };
    });
    this.publishEventWrite(event.event, event.allocations);
    return event.event;
  }

  async updateWalletBalance(input: {
    id: string;
    walletId: string;
    newBalanceMinor: number;
    eventDate?: string;
    memo?: string;
  }): Promise<ConsumerWalletEvent | null> {
    if (!Number.isSafeInteger(input.newBalanceMinor) || input.newBalanceMinor < 0)
      throw new Error('Enter a valid non-negative wallet balance.');
    const eventDate = input.eventDate ?? indiaTodayIso();
    this.assertWalletDate(eventDate);
    const result = await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      await this.assertActiveWallet(tx, input.walletId);
      const [existingRow] = await tx.query<{ payload: string }>(
        'SELECT payload FROM consumer_wallet_events WHERE id=?',
        [input.id],
      );
      if (existingRow) {
        const existing = JSON.parse(existingRow.payload) as ConsumerWalletEvent;
        if (
          existing.walletId === input.walletId &&
          (existing.eventType === 'BALANCE_CORRECTION' ||
            existing.eventType === 'UNKNOWN_BALANCE') &&
          existing.eventDate === eventDate
        ) {
          const historicalBalance = await this.balanceIn(tx, input.walletId, existing);
          if (input.newBalanceMinor - historicalBalance === existing.balanceDeltaMinor)
            return { event: existing, allocations: [] as ConsumerWalletEventAllocation[] };
        }
        throw new Error('This wallet correction ID was already used for a different event.');
      }
      const timestamp = new Date().toISOString();
      const position: WalletEventPosition = {
        id: input.id,
        eventDate,
        eventTime: undefined,
        createdAt: timestamp,
      };
      const historicalBalance = await this.balanceIn(tx, input.walletId, position);
      const deltaMinor = input.newBalanceMinor - historicalBalance;
      if (deltaMinor === 0)
        return { event: null, allocations: [] as ConsumerWalletEventAllocation[] };
      const record: ConsumerWalletEvent = {
        id: input.id,
        walletId: input.walletId,
        eventType: deltaMinor > 0 ? 'UNKNOWN_BALANCE' : 'BALANCE_CORRECTION',
        eventDate,
        amountMinor: Math.abs(deltaMinor),
        balanceDeltaMinor: deltaMinor,
        memo: input.memo?.trim().slice(0, 200) || undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.insertEvent(tx, record);
      const allocations =
        deltaMinor < 0 ? await this.allocateDebit(tx, record, Math.abs(deltaMinor), 0) : [];
      await this.assertChronologicalLedger(tx, input.walletId);
      return { event: record, allocations };
    });
    if (result.event) this.publishEventWrite(result.event, result.allocations);
    return result.event;
  }

  async recordWalletPurchase(input: WalletPurchaseInput): Promise<ConsumerWalletEvent> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('Enter a positive wallet purchase amount.');
    this.assertWalletDate(input.eventDate);
    if (!input.categoryId.trim()) throw new Error('Choose a transaction category.');
    const result = await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      await this.assertActiveWallet(tx, input.walletId);
      const duplicate = await this.readIdempotentEvent(
        tx,
        input.id,
        input.walletId,
        'PURCHASE',
        input.amountMinor,
        input.eventDate,
      );
      if (duplicate)
        return { event: duplicate, allocations: [] as ConsumerWalletEventAllocation[] };
      const timestamp = new Date().toISOString();
      const event: ConsumerWalletEvent = {
        id: input.id,
        walletId: input.walletId,
        eventType: 'PURCHASE',
        eventDate: input.eventDate,
        eventTime: input.eventTime,
        amountMinor: input.amountMinor,
        balanceDeltaMinor: -input.amountMinor,
        categoryId: input.categoryId,
        merchant: input.merchant?.trim().slice(0, 100) || undefined,
        notes: input.notes?.trim().slice(0, 500) || undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const historicalBalance = await this.balanceIn(tx, input.walletId, event);
      if (historicalBalance < input.amountMinor)
        throw new Error('Purchase exceeds the available historical wallet balance.');
      await this.insertEvent(tx, event);
      const allocations = await this.allocateDebit(tx, event, input.amountMinor, 0);
      await this.assertChronologicalLedger(tx, input.walletId);
      return { event, allocations };
    });
    this.publishEventWrite(result.event, result.allocations);
    return result.event;
  }

  async reloadFinancialHistory(): Promise<void> {
    const [events, allocations] = await Promise.all([
      this.database.query<{ payload: string }>(
        'SELECT payload FROM consumer_wallet_events ORDER BY event_date DESC,created_at DESC',
      ),
      this.database.query<{
        id: string;
        debit_event_id: string;
        credit_event_id: string;
        allocated_minor: number;
        expense_reversal_minor: number;
        created_at: string;
      }>('SELECT * FROM consumer_wallet_event_allocations ORDER BY created_at,id'),
    ]);
    this.events.set(events.map((row) => JSON.parse(row.payload) as ConsumerWalletEvent));
    this.allocations.set(
      allocations.map((row) => ({
        id: row.id,
        debitEventId: row.debit_event_id,
        creditEventId: row.credit_event_id,
        allocatedMinor: row.allocated_minor,
        expenseReversalMinor: row.expense_reversal_minor,
        createdAt: row.created_at,
      })),
    );
  }

  forgetFundedLoadForTransaction(transactionId: string): void {
    const deletedIds = new Set(
      this.events()
        .filter(
          (event) =>
            event.eventType === 'FUNDED_LOAD' && event.sourceTransactionId === transactionId,
        )
        .map((event) => event.id),
    );
    if (!deletedIds.size) return;
    this.events.update((events) => events.filter((event) => !deletedIds.has(event.id)));
    this.allocations.update((allocations) =>
      allocations.filter(
        (allocation) =>
          !deletedIds.has(allocation.creditEventId) && !deletedIds.has(allocation.debitEventId),
      ),
    );
  }

  async archiveWallet(walletId: string): Promise<void> {
    const next = await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      const wallets = await this.readWallets(tx);
      const wallet = wallets.find((item) => item.id === walletId && !item.archived);
      if (!wallet) throw new Error('Active wallet not found.');
      return this.writeWalletStates(tx, wallets, [
        { ...wallet, archived: true, updatedAt: new Date().toISOString() },
      ]);
    });
    this.wallets.set(next);
  }

  async restoreWallet(walletId: string, replaceWalletId?: string): Promise<void> {
    const next = await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      const wallets = await this.readWallets(tx);
      const target = wallets.find((item) => item.id === walletId && item.archived);
      if (!target) throw new Error('Archived wallet not found.');
      const active = wallets.filter((item) => !item.archived);
      if (active.length > this.activeWalletLimit)
        throw new Error(
          `This database has more than ${this.activeWalletLimit} active wallets. Archive active wallets before restoring another.`,
        );
      const replacement = replaceWalletId
        ? active.find((item) => item.id === replaceWalletId)
        : undefined;
      if (replaceWalletId && !replacement) throw new Error('Choose an active wallet to archive.');
      if (active.length >= this.activeWalletLimit && !replacement)
        throw new Error(
          `You can have up to ${this.activeWalletLimit} active wallets. Choose one to archive before restoring this wallet.`,
        );
      if (active.length < this.activeWalletLimit && replacement)
        throw new Error(
          'A replacement wallet is only needed when the active-wallet limit is reached.',
        );
      const timestamp = new Date().toISOString();
      const changes: ConsumerWallet[] = [
        { ...target, archived: false, updatedAt: timestamp },
        ...(replacement ? [{ ...replacement, archived: true, updatedAt: timestamp }] : []),
      ];
      return this.writeWalletStates(tx, wallets, changes);
    });
    this.wallets.set(next);
  }

  async deleteWalletIfEmpty(walletId: string): Promise<void> {
    await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      const [events] = await tx.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM consumer_wallet_events WHERE wallet_id=?',
        [walletId],
      );
      if (events.count)
        throw new Error('This wallet has financial history. Archive it instead of deleting it.');
      const deleted = await tx.run('DELETE FROM consumer_wallets WHERE id=?', [walletId]);
      if (!deleted) throw new Error('Wallet not found.');
    });
    this.wallets.update((items) => items.filter((item) => item.id !== walletId));
  }

  private async assertSetupIntent(
    tx: DatabaseSession,
    intentId: string | undefined,
    kind: WalletSetupKind,
  ): Promise<void> {
    const [featureRow] = await tx.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key=?',
      [WALLETS_FEATURE_STATE_KEY],
    );
    const [intentRow] = await tx.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key=?',
      [WALLETS_SETUP_INTENT_KEY],
    );
    const featureState = featureRow?.encrypted_value;
    const intent = parseSetupIntent(intentRow?.encrypted_value);
    if (intentId && (!intent || intent.id !== intentId || intent.kind !== kind))
      throw new Error('This Wallets setup request has expired. Start setup again from Settings.');
    if (
      featureState === 'DISABLED' &&
      (kind === 'CONSUMER' || intentId !== undefined) &&
      (!intentId || !intent || intent.id !== intentId || intent.kind !== kind)
    )
      throw new Error(
        'Wallets is explicitly off. Start a valid setup from Settings before registering a consumer wallet.',
      );
  }

  private async readFeatureState(tx: DatabaseSession): Promise<WalletsFeatureState> {
    const [row] = await tx.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key=?',
      [WALLETS_FEATURE_STATE_KEY],
    );
    const value = row?.encrypted_value;
    return value === 'ENABLED' || value === 'DISABLED' || value === 'NEVER_CONFIGURED'
      ? value
      : 'NEVER_CONFIGURED';
  }

  private async assertWalletsEnabled(tx: DatabaseSession): Promise<void> {
    const [row] = await tx.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key=?',
      [WALLETS_FEATURE_STATE_KEY],
    );
    if (row?.encrypted_value !== 'ENABLED')
      throw new Error(
        'Wallets is off. Enable Wallets in Settings before changing consumer wallets.',
      );
  }

  private assertWalletDate(value: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)))
      throw new Error('Enter a valid wallet event date.');
  }

  private async assertActiveWallet(tx: DatabaseSession, walletId: string): Promise<void> {
    const [row] = await tx.query<{ wallet_kind: ConsumerWalletKind; archived: number }>(
      'SELECT wallet_kind,archived FROM consumer_wallets WHERE id=?',
      [walletId],
    );
    if (!row || row.archived !== 0) throw new Error('Choose an active registered consumer wallet.');
  }

  private async readIdempotentEvent(
    tx: DatabaseSession,
    id: string,
    walletId: string,
    eventType: ConsumerWalletEvent['eventType'],
    amountMinor: number,
    eventDate: string,
  ): Promise<ConsumerWalletEvent | null> {
    const [row] = await tx.query<{ payload: string }>(
      'SELECT payload FROM consumer_wallet_events WHERE id=?',
      [id],
    );
    if (!row) return null;
    const existing = JSON.parse(row.payload) as ConsumerWalletEvent;
    if (
      existing.walletId === walletId &&
      existing.eventType === eventType &&
      existing.amountMinor === amountMinor &&
      existing.eventDate === eventDate
    )
      return existing;
    throw new Error('This wallet event ID was already used for a different financial event.');
  }

  private compareWalletEvents(left: WalletEventPosition, right: WalletEventPosition): number {
    return (
      left.eventDate.localeCompare(right.eventDate) ||
      (left.eventTime ?? '').localeCompare(right.eventTime ?? '') ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    );
  }

  private async readChronologicalEvents(
    tx: DatabaseSession,
    walletId: string,
  ): Promise<ConsumerWalletEvent[]> {
    const rows = await tx.query<{ payload: string }>(
      'SELECT payload FROM consumer_wallet_events WHERE wallet_id=?',
      [walletId],
    );
    return rows
      .map((row) => JSON.parse(row.payload) as ConsumerWalletEvent)
      .sort((left, right) => this.compareWalletEvents(left, right));
  }

  private async balanceIn(
    tx: DatabaseSession,
    walletId: string,
    before?: WalletEventPosition,
  ): Promise<number> {
    const events = await this.readChronologicalEvents(tx, walletId);
    let balance = 0;
    for (const event of events) {
      if (before && this.compareWalletEvents(event, before) >= 0) break;
      const next = balance + event.balanceDeltaMinor;
      if (!Number.isSafeInteger(event.balanceDeltaMinor) || !Number.isSafeInteger(next))
        throw new Error('Wallet history exceeds the supported balance range.');
      if (next < 0) throw new Error('Wallet history contains a negative historical balance.');
      balance = next;
    }
    return balance;
  }

  private async assertChronologicalLedger(tx: DatabaseSession, walletId: string): Promise<void> {
    const events = await this.readChronologicalEvents(tx, walletId);
    const allocationRows = await tx.query<{
      debit_event_id: string;
      credit_event_id: string;
      allocated_minor: number;
    }>(
      `SELECT debit_event_id,credit_event_id,allocated_minor
       FROM consumer_wallet_event_allocations
       WHERE debit_event_id IN (SELECT id FROM consumer_wallet_events WHERE wallet_id=?)`,
      [walletId],
    );
    const actualByDebit = new Map<string, Map<string, number>>();
    for (const allocation of allocationRows) {
      const creditMap = actualByDebit.get(allocation.debit_event_id) ?? new Map<string, number>();
      creditMap.set(
        allocation.credit_event_id,
        (creditMap.get(allocation.credit_event_id) ?? 0) + allocation.allocated_minor,
      );
      actualByDebit.set(allocation.debit_event_id, creditMap);
    }

    let balance = 0;
    const lots: { id: string; available: number }[] = [];
    for (const event of events) {
      if (!Number.isSafeInteger(event.balanceDeltaMinor))
        throw new Error('Wallet history contains an invalid balance change.');
      const nextBalance = balance + event.balanceDeltaMinor;
      if (!Number.isSafeInteger(nextBalance))
        throw new Error('Wallet history exceeds the supported balance range.');
      if (nextBalance < 0)
        throw new Error('Wallet event would create a negative historical balance.');
      balance = nextBalance;

      if (event.balanceDeltaMinor > 0) {
        lots.push({ id: event.id, available: event.balanceDeltaMinor });
        continue;
      }
      if (event.amountMinor !== Math.abs(event.balanceDeltaMinor))
        throw new Error('Wallet debit amount does not match its balance change.');

      let remaining = Math.abs(event.balanceDeltaMinor);
      const expected = new Map<string, number>();
      for (const lot of lots) {
        if (!remaining) break;
        const allocatedMinor = Math.min(lot.available, remaining);
        if (!allocatedMinor) continue;
        expected.set(lot.id, allocatedMinor);
        lot.available -= allocatedMinor;
        remaining -= allocatedMinor;
      }
      if (remaining) throw new Error('Wallet event exceeds historical credit provenance.');

      const actual = actualByDebit.get(event.id) ?? new Map<string, number>();
      if (
        expected.size !== actual.size ||
        [...expected].some(([creditId, amount]) => actual.get(creditId) !== amount)
      )
        throw new Error(
          'Wallet event would change audited FIFO allocations. Correct the history without rewriting prior events.',
        );
    }
  }

  private async insertEvent(tx: DatabaseSession, event: ConsumerWalletEvent): Promise<void> {
    await tx.run(
      'INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,event_time,amount_minor,balance_delta_minor,debit_amount_minor,loaded_amount_minor,fee_minor,funding_source_kind,funding_source_id,source_transaction_id,return_source_id,reversal_of_event_id,funding_category_id,category_id,merchant,notes,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        event.id,
        event.walletId,
        event.eventType,
        event.eventDate,
        event.eventTime ?? null,
        event.amountMinor,
        event.balanceDeltaMinor,
        event.debitAmountMinor ?? null,
        event.loadedAmountMinor ?? null,
        event.feeMinor ?? null,
        event.fundingSourceKind ?? null,
        event.fundingSourceId ?? null,
        event.sourceTransactionId ?? null,
        event.returnSourceId ?? null,
        event.reversalOfEventId ?? null,
        event.fundingCategoryId ?? null,
        event.categoryId ?? null,
        event.merchant ?? null,
        event.notes ?? null,
        JSON.stringify(event),
        event.createdAt,
        event.updatedAt,
      ],
    );
  }

  private async allocateDebit(
    tx: DatabaseSession,
    debit: ConsumerWalletEvent,
    amountMinor: number,
    expenseReversalMinor: number,
  ): Promise<ConsumerWalletEventAllocation[]> {
    const creditRows = await tx.query<{
      id: string;
      balance_delta_minor: number;
      payload: string;
    }>(
      'SELECT id,balance_delta_minor,payload FROM consumer_wallet_events WHERE wallet_id=? AND balance_delta_minor>0 AND id<>?',
      [debit.walletId, debit.id],
    );
    const credits = creditRows
      .map((row) => ({
        id: row.id,
        amountMinor: row.balance_delta_minor,
        event: JSON.parse(row.payload) as ConsumerWalletEvent,
      }))
      .filter((credit) => this.compareWalletEvents(credit.event, debit) < 0)
      .sort((left, right) => this.compareWalletEvents(left.event, right.event));
    let remaining = amountMinor;
    let expenseRemaining = expenseReversalMinor;
    const allocations: ConsumerWalletEventAllocation[] = [];
    for (const credit of credits) {
      if (!remaining) break;
      const priorAllocations = await tx.query<{
        allocated_minor: number;
        payload: string;
      }>(
        `SELECT a.allocated_minor,e.payload
         FROM consumer_wallet_event_allocations a
         JOIN consumer_wallet_events e ON e.id=a.debit_event_id
         WHERE a.credit_event_id=?`,
        [credit.id],
      );
      const alreadyConsumed = priorAllocations.reduce((total, allocation) => {
        const priorDebit = JSON.parse(allocation.payload) as ConsumerWalletEvent;
        return this.compareWalletEvents(priorDebit, debit) < 0
          ? total + allocation.allocated_minor
          : total;
      }, 0);
      const available = credit.amountMinor - alreadyConsumed;
      if (available <= 0) continue;
      const allocatedMinor = Math.min(available, remaining);
      const allocatedExpense = Math.min(allocatedMinor, expenseRemaining);
      const allocation: ConsumerWalletEventAllocation = {
        id: crypto.randomUUID(),
        debitEventId: debit.id,
        creditEventId: credit.id,
        allocatedMinor,
        expenseReversalMinor: allocatedExpense,
        createdAt: new Date().toISOString(),
      };
      await tx.run(
        'INSERT INTO consumer_wallet_event_allocations(id,debit_event_id,credit_event_id,allocated_minor,expense_reversal_minor,created_at) VALUES(?,?,?,?,?,?)',
        [
          allocation.id,
          allocation.debitEventId,
          allocation.creditEventId,
          allocation.allocatedMinor,
          allocation.expenseReversalMinor,
          allocation.createdAt,
        ],
      );
      allocations.push(allocation);
      remaining -= allocatedMinor;
      expenseRemaining -= allocatedExpense;
    }
    if (remaining)
      throw new Error('Wallet balance provenance is incomplete; the debit was not saved.');
    return allocations;
  }

  private publishEventWrite(
    event: ConsumerWalletEvent,
    allocations: readonly ConsumerWalletEventAllocation[],
  ): void {
    this.events.update((items) => [event, ...items.filter((item) => item.id !== event.id)]);
    if (allocations.length)
      this.allocations.update((items) => [
        ...allocations,
        ...items.filter((item) => !allocations.some((next) => next.id === item.id)),
      ]);
  }

  private async completeSetup(tx: DatabaseSession, intentId: string | undefined): Promise<void> {
    await this.writePreference(tx, WALLETS_FEATURE_STATE_KEY, 'ENABLED');
    if (!intentId) return;
    const [row] = await tx.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key=?',
      [WALLETS_SETUP_INTENT_KEY],
    );
    if (parseSetupIntent(row?.encrypted_value)?.id !== intentId)
      throw new Error('This Wallets setup request has expired. The wallet was not saved.');
    await tx.run('DELETE FROM app_preferences WHERE key=?', [WALLETS_SETUP_INTENT_KEY]);
  }

  private async readWallets(tx: DatabaseSession): Promise<ConsumerWallet[]> {
    const rows = await tx.query<{ payload: string }>(
      'SELECT payload FROM consumer_wallets ORDER BY created_at,id',
    );
    return rows.map((row) => JSON.parse(row.payload) as ConsumerWallet);
  }

  private async insertWallet(tx: DatabaseSession, wallet: ConsumerWallet): Promise<void> {
    await tx.run(
      'INSERT INTO consumer_wallets(id,provider_id,wallet_kind,custom_name,nickname,archived,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [
        wallet.id,
        wallet.providerId,
        wallet.kind,
        wallet.customName ?? null,
        wallet.nickname ?? null,
        0,
        JSON.stringify(wallet),
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
  }

  private async writeWalletStates(
    tx: DatabaseSession,
    wallets: readonly ConsumerWallet[],
    changes: readonly ConsumerWallet[],
  ): Promise<ConsumerWallet[]> {
    const byId = new Map(changes.map((wallet) => [wallet.id, wallet]));
    const next = wallets.map((wallet) => byId.get(wallet.id) ?? wallet);
    for (const wallet of changes) {
      await tx.run('UPDATE consumer_wallets SET archived=?,payload=?,updated_at=? WHERE id=?', [
        wallet.archived ? 1 : 0,
        JSON.stringify(wallet),
        wallet.updatedAt,
        wallet.id,
      ]);
    }
    return next;
  }

  private walletIdentity(wallet: ConsumerWallet): string {
    const normalize = (value: string | undefined) => value?.trim().toLocaleLowerCase() ?? '';
    return [wallet.providerId, normalize(wallet.customName), normalize(wallet.nickname)].join('\0');
  }

  private async writePreference(tx: DatabaseSession, key: string, value: string): Promise<void> {
    await tx.run(
      'INSERT INTO app_preferences(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value',
      [key, value],
    );
  }
}
