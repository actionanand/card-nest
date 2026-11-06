import { Service, computed, inject, signal } from '@angular/core';
import { DatabaseSession, SqliteDatabase } from '../data/sqlite-database';
import {
  allocateConsumerWalletDebit,
  assertChronologicalConsumerWalletLedger,
  compareConsumerWalletEvents,
  ConsumerWalletEventPosition,
  planConsumerWalletDebit,
  persistConsumerWalletDebitPlan,
} from '../data/consumer-wallet-ledger';
import {
  ConsumerWallet,
  ConsumerWalletEvent,
  ConsumerWalletEventAllocation,
  ConsumerWalletCreditProvenanceSegment,
  ConsumerWalletExpenseReversal,
  ConsumerWalletKind,
  ConsumerWalletReturnLink,
  PaymentSource,
  BalanceTiming,
  CardTransaction,
} from '../models/domain';
import { APP_ENVIRONMENT } from './app-environment';
import { CardNestStore } from './card-nest-store';
import {
  attachPaymentGroup,
  linkWalletRefundToPaymentGroup,
  readPaymentGroups,
} from './payment-groups';
import { indiaTodayIso } from './india-date';
import {
  applyBankCashTransaction,
  isEnrolledBankAccount,
  needsBaselineConfirmation,
  parseBankCashTracking,
  TIMING_QUESTION,
  validTransferDate,
} from './source-balance';
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
  readonly attachmentIds?: readonly string[];
  readonly confirmationKey: string;
  readonly splitTargetId?: string;
}

export interface WalletPurchasePreview {
  readonly walletId: string;
  readonly amountMinor: number;
  readonly balanceBeforeMinor: number;
  readonly balanceAfterMinor: number;
  readonly allocations: readonly {
    readonly creditEventId: string;
    readonly allocatedMinor: number;
  }[];
  readonly confirmationKey: string;
}

export interface WalletPurchaseRefundInput {
  readonly id: string;
  readonly purchaseEventId: string;
  readonly amountMinor: number;
  readonly eventDate: string;
  readonly eventTime?: string;
  readonly reason?: string;
  readonly reference?: string;
  readonly notes?: string;
  readonly eventType?: 'REFUND' | 'REVERSAL';
  readonly confirmationKey?: string;
}

export interface WalletPurchaseRefundPreview {
  readonly walletId: string;
  readonly purchaseEventId: string;
  readonly amountMinor: number;
  readonly alreadyRefundedMinor: number;
  readonly refundableRemainingMinor: number;
  readonly provenanceSegments: readonly Omit<
    ConsumerWalletCreditProvenanceSegment,
    'id' | 'creditEventId' | 'createdAt'
  >[];
  readonly confirmationKey: string;
}

type WalletCreditProvenanceSegment = Pick<
  ConsumerWalletCreditProvenanceSegment,
  'segmentOrder' | 'rootCreditEventId' | 'sourcePurchaseEventId' | 'amountMinor'
>;

export interface UpiLiteReturnInput {
  readonly id: string;
  readonly walletId: string;
  readonly bankSourceId: string;
  readonly amountMinor: number;
  readonly eventDate: string;
  readonly eventTime?: string;
  readonly reference?: string;
  readonly note?: string;
  readonly existingBankTransactionId?: string;
  readonly balanceTiming?: BalanceTiming;
  readonly confirmationKey: string;
}

export interface UpiLiteReturnAttribution {
  readonly creditEventId: string;
  readonly creditEventType: ConsumerWalletEvent['eventType'];
  readonly allocatedMinor: number;
  readonly expenseReversalMinor: number;
}

export interface UpiLiteReturnPreview {
  readonly walletId: string;
  readonly bankSourceId: string;
  readonly bankName: string;
  readonly amountMinor: number;
  readonly eventDate: string;
  readonly eventTime?: string;
  readonly existingBankTransactionId?: string;
  readonly fundedPrincipalReversalMinor: number;
  readonly nonFundedReturnMinor: number;
  readonly remainingWalletBalanceMinor: number;
  readonly attributions: readonly UpiLiteReturnAttribution[];
  readonly confirmationKey: string;
}

function upiLiteReturnConfirmationKey(
  input: Omit<UpiLiteReturnInput, 'confirmationKey'>,
  existingBankTransactionId: string | undefined,
  attributions: readonly UpiLiteReturnAttribution[],
  remainingWalletBalanceMinor: number,
): string {
  return JSON.stringify([
    input.walletId,
    input.bankSourceId,
    input.amountMinor,
    input.eventDate,
    input.eventTime ?? '',
    input.balanceTiming ?? '',
    input.reference?.trim() ?? '',
    existingBankTransactionId ?? '',
    remainingWalletBalanceMinor,
    attributions.map((item) => [
      item.creditEventId,
      item.creditEventType,
      item.allocatedMinor,
      item.expenseReversalMinor,
    ]),
  ]);
}

function walletPurchaseConfirmationKey(
  input: Omit<WalletPurchaseInput, 'confirmationKey'>,
  balanceAfterMinor: number,
  allocations: readonly { readonly creditEventId: string; readonly allocatedMinor: number }[],
): string {
  return JSON.stringify([
    input.id,
    input.walletId,
    input.amountMinor,
    input.eventDate,
    input.eventTime ?? '',
    input.categoryId,
    input.merchant?.trim() ?? '',
    input.notes?.trim() ?? '',
    input.attachmentIds ?? [],
    input.splitTargetId ?? '',
    balanceAfterMinor,
    allocations.map((allocation) => [allocation.creditEventId, allocation.allocatedMinor]),
  ]);
}

function walletRefundConfirmationKey(
  input: WalletPurchaseRefundInput,
  walletId: string,
  alreadyRefundedMinor: number,
  remainingMinor: number,
  segments: readonly WalletCreditProvenanceSegment[],
): string {
  return JSON.stringify([
    input.id,
    input.purchaseEventId,
    walletId,
    input.amountMinor,
    input.eventDate,
    input.eventTime ?? '',
    input.reason?.trim() ?? '',
    input.reference?.trim() ?? '',
    input.notes?.trim() ?? '',
    input.eventType ?? 'REFUND',
    alreadyRefundedMinor,
    remainingMinor,
    segments.map((segment) => [
      segment.segmentOrder,
      segment.rootCreditEventId,
      segment.sourcePurchaseEventId,
      segment.amountMinor,
    ]),
  ]);
}

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
  readonly expenseReversals = signal<readonly ConsumerWalletExpenseReversal[]>([]);
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
        const expenseReversals = await tx.query<{
          return_event_id: string;
          credit_event_id: string;
          funded_load_event_id: string;
          reversed_minor: number;
          created_at: string;
        }>('SELECT * FROM consumer_wallet_expense_reversals ORDER BY created_at');
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
          expenseReversals: expenseReversals.map((row) => ({
            returnEventId: row.return_event_id,
            creditEventId: row.credit_event_id,
            fundedLoadEventId: row.funded_load_event_id,
            reversedMinor: row.reversed_minor,
            createdAt: row.created_at,
          })),
        };
      });
      this.featureState.set(state.featureState);
      this.wallets.set(state.wallets);
      this.events.set(state.events);
      this.allocations.set(state.allocations);
      this.expenseReversals.set(state.expenseReversals);
      this.store.acceptWalletFinancialHistory(state.events, state.expenseReversals);
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
      await assertChronologicalConsumerWalletLedger(tx, input.walletId);
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
      const position: ConsumerWalletEventPosition = {
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
        deltaMinor < 0 ? await allocateConsumerWalletDebit(tx, record, Math.abs(deltaMinor)) : [];
      await assertChronologicalConsumerWalletLedger(tx, input.walletId);
      return { event: record, allocations };
    });
    if (result.event) this.publishEventWrite(result.event, result.allocations);
    return result.event;
  }

  async recordWalletPurchase(input: WalletPurchaseInput): Promise<ConsumerWalletEvent> {
    if (!input.id.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('Enter a positive wallet purchase amount.');
    if (!input.confirmationKey)
      throw new Error('Review and approve the wallet purchase before saving.');
    if (!validTransferDate(input.eventDate, input.eventTime))
      throw new Error('Enter a valid wallet purchase date and time.');
    if (!input.categoryId.trim()) throw new Error('Choose a transaction category.');
    this.assertWalletAttachments(input.attachmentIds);
    const result = await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      await this.assertActiveWallet(tx, input.walletId);
      await this.assertWalletCategory(tx, input.categoryId);
      const duplicate = await this.readIdempotentEvent(
        tx,
        input.id,
        input.walletId,
        'PURCHASE',
        input.amountMinor,
        input.eventDate,
      );
      if (duplicate) {
        if (
          (duplicate.eventTime ?? '') !== (input.eventTime ?? '') ||
          duplicate.categoryId !== input.categoryId ||
          (duplicate.merchant ?? '') !== (input.merchant?.trim().slice(0, 100) ?? '') ||
          (duplicate.notes ?? '') !== (input.notes?.trim().slice(0, 500) ?? '') ||
          JSON.stringify(duplicate.attachmentIds ?? []) !==
            JSON.stringify(input.attachmentIds ?? [])
        )
          throw new Error('This wallet purchase ID was already used for a different purchase.');
        const existingAllocations = await this.readEventAllocations(tx, duplicate.id);
        const balanceBeforeMinor = await this.balanceIn(tx, input.walletId, duplicate);
        const replayPlan = await planConsumerWalletDebit(tx, duplicate, input.amountMinor);
        const expectedKey = walletPurchaseConfirmationKey(
          input,
          balanceBeforeMinor - input.amountMinor,
          replayPlan.map((allocation) => ({
            creditEventId: allocation.creditEvent.id,
            allocatedMinor: allocation.allocatedMinor,
          })),
        );
        if (input.confirmationKey !== expectedKey)
          throw new Error('Wallet balance or FIFO attribution changed. Review the purchase again.');
        return {
          event: duplicate,
          allocations: existingAllocations,
          groups: await readPaymentGroups(tx),
        };
      }
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
        attachmentIds: input.attachmentIds ? [...input.attachmentIds] : undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const historicalBalance = await this.balanceIn(tx, input.walletId, event);
      if (historicalBalance < input.amountMinor)
        throw new Error('Purchase exceeds the available historical wallet balance.');
      const plan = await planConsumerWalletDebit(tx, event, input.amountMinor);
      const allocations = plan.map((item) => ({
        creditEventId: item.creditEvent.id,
        allocatedMinor: item.allocatedMinor,
      }));
      const confirmationKey = walletPurchaseConfirmationKey(
        input,
        historicalBalance - input.amountMinor,
        allocations,
      );
      if (input.confirmationKey !== confirmationKey)
        throw new Error('Wallet balance or FIFO attribution changed. Review the purchase again.');
      await this.insertEvent(tx, event);
      const persistedAllocations = await persistConsumerWalletDebitPlan(tx, event, plan);
      await assertChronologicalConsumerWalletLedger(tx, input.walletId);
      if (input.splitTargetId)
        await attachPaymentGroup(tx, [], input.splitTargetId, {}, [event.id]);
      return { event, allocations: persistedAllocations, groups: await readPaymentGroups(tx) };
    });
    this.publishEventWrite(result.event, result.allocations);
    this.store.paymentGroups.set(result.groups);
    return result.event;
  }

  async previewWalletPurchase(
    input: Omit<WalletPurchaseInput, 'confirmationKey'>,
  ): Promise<WalletPurchasePreview> {
    if (!input.id.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('Enter a positive wallet purchase amount.');
    if (!validTransferDate(input.eventDate, input.eventTime))
      throw new Error('Enter a valid wallet purchase date and time.');
    if (!input.categoryId.trim()) throw new Error('Choose a transaction category.');
    this.assertWalletAttachments(input.attachmentIds);
    return this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      await this.assertActiveWallet(tx, input.walletId);
      await this.assertWalletCategory(tx, input.categoryId);
      const duplicate = await this.readIdempotentEvent(
        tx,
        input.id,
        input.walletId,
        'PURCHASE',
        input.amountMinor,
        input.eventDate,
      );
      if (duplicate) throw new Error('This wallet purchase ID has already been used.');
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
        attachmentIds: input.attachmentIds ? [...input.attachmentIds] : undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const balanceBeforeMinor = await this.balanceIn(tx, input.walletId, event);
      if (balanceBeforeMinor < input.amountMinor)
        throw new Error('Purchase exceeds the available historical wallet balance.');
      const plan = await planConsumerWalletDebit(tx, event, input.amountMinor);
      const allocations = plan.map((item) => ({
        creditEventId: item.creditEvent.id,
        allocatedMinor: item.allocatedMinor,
      }));
      const previewAllocations: ConsumerWalletEventAllocation[] = plan.map((item, index) => ({
        id: `wallet-purchase-preview:${index}:${item.creditEvent.id}`,
        debitEventId: event.id,
        creditEventId: item.creditEvent.id,
        allocatedMinor: item.allocatedMinor,
        expenseReversalMinor: 0,
        createdAt: timestamp,
      }));
      await assertChronologicalConsumerWalletLedger(tx, input.walletId, {
        additionalEvents: [event],
        additionalAllocations: previewAllocations,
      });
      const balanceAfterMinor = balanceBeforeMinor - input.amountMinor;
      return {
        walletId: input.walletId,
        amountMinor: input.amountMinor,
        balanceBeforeMinor,
        balanceAfterMinor,
        allocations,
        confirmationKey: walletPurchaseConfirmationKey(input, balanceAfterMinor, allocations),
      };
    });
  }

  async previewWalletPurchaseEdit(
    input: Omit<WalletPurchaseInput, 'confirmationKey'>,
  ): Promise<WalletPurchasePreview> {
    this.validateWalletPurchaseInput(input);
    return this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      await this.assertActiveWallet(tx, input.walletId);
      await this.assertWalletCategory(tx, input.categoryId);
      const previous = await this.readWalletPurchaseEvent(tx, input.id, input.walletId);
      const financialChange = this.walletPurchaseFinancialChange(previous, input);
      if (financialChange) await this.assertPurchaseHasNoRefunds(tx, previous.id);
      const event = this.updatedWalletPurchaseEvent(previous, input);
      const excludedEvents = new Set([previous.id]);
      const balanceBeforeMinor = await this.balanceIn(tx, input.walletId, event, excludedEvents);
      if (balanceBeforeMinor < input.amountMinor)
        throw new Error('Purchase exceeds the available historical wallet balance.');
      const plan = await planConsumerWalletDebit(
        tx,
        event,
        input.amountMinor,
        undefined,
        excludedEvents,
      );
      const allocations = plan.map((item) => ({
        creditEventId: item.creditEvent.id,
        allocatedMinor: item.allocatedMinor,
      }));
      await assertChronologicalConsumerWalletLedger(tx, input.walletId, {
        replacedEventIds: [previous.id],
        replacedDebitEventIds: [previous.id],
        additionalEvents: [event],
        additionalAllocations: this.previewDebitAllocations(event, plan),
      });
      const balanceAfterMinor = balanceBeforeMinor - input.amountMinor;
      return {
        walletId: input.walletId,
        amountMinor: input.amountMinor,
        balanceBeforeMinor,
        balanceAfterMinor,
        allocations,
        confirmationKey: walletPurchaseConfirmationKey(input, balanceAfterMinor, allocations),
      };
    });
  }

  async updateWalletPurchase(input: WalletPurchaseInput): Promise<ConsumerWalletEvent> {
    this.validateWalletPurchaseInput(input);
    if (!input.confirmationKey)
      throw new Error('Review and approve the wallet purchase edit before saving.');
    const result = await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      await this.assertActiveWallet(tx, input.walletId);
      await this.assertWalletCategory(tx, input.categoryId);
      const previous = await this.readWalletPurchaseEvent(tx, input.id, input.walletId);
      const financialChange = this.walletPurchaseFinancialChange(previous, input);
      if (financialChange) await this.assertPurchaseHasNoRefunds(tx, previous.id);
      const event = this.updatedWalletPurchaseEvent(previous, input);
      const excludedEvents = new Set([previous.id]);
      const balanceBeforeMinor = await this.balanceIn(tx, input.walletId, event, excludedEvents);
      if (balanceBeforeMinor < input.amountMinor)
        throw new Error('Purchase exceeds the available historical wallet balance.');
      const plan = await planConsumerWalletDebit(
        tx,
        event,
        input.amountMinor,
        undefined,
        excludedEvents,
      );
      const allocations = plan.map((item) => ({
        creditEventId: item.creditEvent.id,
        allocatedMinor: item.allocatedMinor,
      }));
      const confirmationKey = walletPurchaseConfirmationKey(
        input,
        balanceBeforeMinor - input.amountMinor,
        allocations,
      );
      if (input.confirmationKey !== confirmationKey)
        throw new Error(
          'Wallet balance or FIFO attribution changed. Review the purchase edit again.',
        );

      if (financialChange)
        await tx.run('DELETE FROM consumer_wallet_event_allocations WHERE debit_event_id=?', [
          event.id,
        ]);
      await tx.run(
        'UPDATE consumer_wallet_events SET event_date=?,event_time=?,amount_minor=?,balance_delta_minor=?,category_id=?,merchant=?,notes=?,payload=?,updated_at=? WHERE id=?',
        [
          event.eventDate,
          event.eventTime ?? null,
          event.amountMinor,
          event.balanceDeltaMinor,
          event.categoryId ?? null,
          event.merchant ?? null,
          event.notes ?? null,
          JSON.stringify(event),
          event.updatedAt,
          event.id,
        ],
      );
      const persistedAllocations = financialChange
        ? await persistConsumerWalletDebitPlan(tx, event, plan)
        : await this.readEventAllocations(tx, event.id);
      await assertChronologicalConsumerWalletLedger(tx, input.walletId);
      return { event, allocations: persistedAllocations };
    });
    this.events.update((items) => [
      result.event,
      ...items.filter((item) => item.id !== result.event.id),
    ]);
    this.allocations.update((items) => [
      ...result.allocations,
      ...items.filter((item) => item.debitEventId !== result.event.id),
    ]);
    return result.event;
  }

  private validateWalletPurchaseInput(input: Omit<WalletPurchaseInput, 'confirmationKey'>): void {
    if (!input.id.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('Enter a positive wallet purchase amount.');
    if (!validTransferDate(input.eventDate, input.eventTime))
      throw new Error('Enter a valid wallet purchase date and time.');
    if (!input.categoryId.trim()) throw new Error('Choose a transaction category.');
    this.assertWalletAttachments(input.attachmentIds);
  }

  private async readWalletPurchaseEvent(
    tx: DatabaseSession,
    eventId: string,
    walletId: string,
  ): Promise<ConsumerWalletEvent> {
    const [row] = await tx.query<{ payload: string }>(
      "SELECT payload FROM consumer_wallet_events WHERE id=? AND wallet_id=? AND event_type='PURCHASE'",
      [eventId, walletId],
    );
    if (!row) throw new Error('Choose an existing purchase from this wallet.');
    return JSON.parse(row.payload) as ConsumerWalletEvent;
  }

  private walletPurchaseFinancialChange(
    previous: ConsumerWalletEvent,
    input: Omit<WalletPurchaseInput, 'confirmationKey'>,
  ): boolean {
    return (
      previous.amountMinor !== input.amountMinor ||
      previous.eventDate !== input.eventDate ||
      (previous.eventTime ?? '') !== (input.eventTime ?? '')
    );
  }

  private updatedWalletPurchaseEvent(
    previous: ConsumerWalletEvent,
    input: Omit<WalletPurchaseInput, 'confirmationKey'>,
  ): ConsumerWalletEvent {
    return {
      ...previous,
      eventDate: input.eventDate,
      eventTime: input.eventTime,
      amountMinor: input.amountMinor,
      balanceDeltaMinor: -input.amountMinor,
      categoryId: input.categoryId,
      merchant: input.merchant?.trim().slice(0, 100) || undefined,
      notes: input.notes?.trim().slice(0, 500) || undefined,
      attachmentIds: input.attachmentIds ? [...input.attachmentIds] : undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  private async assertPurchaseHasNoRefunds(
    tx: DatabaseSession,
    purchaseEventId: string,
  ): Promise<void> {
    const [row] = await tx.query<{ id: string }>(
      "SELECT id FROM consumer_wallet_events WHERE event_type IN ('REFUND','REVERSAL') AND reversal_of_event_id=? LIMIT 1",
      [purchaseEventId],
    );
    if (row)
      throw new Error('A purchase with refunds or cancellation cannot be financially edited.');
  }

  private previewDebitAllocations(
    event: ConsumerWalletEvent,
    plan: readonly { readonly creditEvent: ConsumerWalletEvent; readonly allocatedMinor: number }[],
  ): ConsumerWalletEventAllocation[] {
    return plan.map((item, index) => ({
      id: `wallet-edit-preview:${index}:${item.creditEvent.id}`,
      debitEventId: event.id,
      creditEventId: item.creditEvent.id,
      allocatedMinor: item.allocatedMinor,
      expenseReversalMinor: 0,
      createdAt: event.createdAt,
    }));
  }

  private async resolveCreditProvenanceSegments(
    tx: DatabaseSession,
    credit: ConsumerWalletEvent,
    seen = new Set<string>(),
  ): Promise<WalletCreditProvenanceSegment[]> {
    if (seen.has(credit.id)) throw new Error('Wallet refund provenance contains a cycle.');
    seen.add(credit.id);
    const stored = await tx.query<{
      segment_order: number;
      root_credit_event_id: string;
      source_purchase_event_id: string;
      amount_minor: number;
    }>(
      'SELECT segment_order,root_credit_event_id,source_purchase_event_id,amount_minor FROM consumer_wallet_credit_provenance_segments WHERE credit_event_id=? ORDER BY segment_order',
      [credit.id],
    );
    if (stored.length) {
      let total = 0;
      const segments: WalletCreditProvenanceSegment[] = [];
      for (const [index, row] of stored.entries()) {
        if (
          row.segment_order !== index ||
          !Number.isSafeInteger(row.amount_minor) ||
          row.amount_minor <= 0
        )
          throw new Error('Ordered wallet refund provenance is invalid.');
        const [rootRow] = await tx.query<{ payload: string }>(
          'SELECT payload FROM consumer_wallet_events WHERE id=?',
          [row.root_credit_event_id],
        );
        const [purchaseRow] = await tx.query<{ payload: string }>(
          'SELECT payload FROM consumer_wallet_events WHERE id=?',
          [row.source_purchase_event_id],
        );
        const root = rootRow ? (JSON.parse(rootRow.payload) as ConsumerWalletEvent) : null;
        const sourcePurchase = purchaseRow
          ? (JSON.parse(purchaseRow.payload) as ConsumerWalletEvent)
          : null;
        if (
          !root ||
          root.walletId !== credit.walletId ||
          root.balanceDeltaMinor <= 0 ||
          root.eventType === 'REFUND' ||
          root.eventType === 'REVERSAL' ||
          !sourcePurchase ||
          sourcePurchase.walletId !== credit.walletId ||
          sourcePurchase.eventType !== 'PURCHASE'
        )
          throw new Error('Wallet refund provenance crosses an invalid event or wallet.');
        total += row.amount_minor;
        if (!Number.isSafeInteger(total))
          throw new Error('Wallet provenance exceeds supported amounts.');
        segments.push({
          segmentOrder: index,
          rootCreditEventId: row.root_credit_event_id,
          sourcePurchaseEventId: row.source_purchase_event_id,
          amountMinor: row.amount_minor,
        });
      }
      if (total !== credit.amountMinor)
        throw new Error('Ordered wallet refund provenance does not equal its credit amount.');
      return segments;
    }

    const legacy = await tx.query<{
      source_credit_event_id: string;
      allocated_minor: number;
      payload: string;
    }>(
      `SELECT p.source_credit_event_id,p.allocated_minor,e.payload
       FROM consumer_wallet_credit_provenance p
       JOIN consumer_wallet_events e ON e.id=p.source_credit_event_id
       WHERE p.credit_event_id=?`,
      [credit.id],
    );
    if (!legacy.length) {
      if (credit.eventType === 'REFUND' || credit.eventType === 'REVERSAL')
        throw new Error(
          'This legacy wallet refund has no provable ordered provenance; do not return it to Bank automatically.',
        );
      return [
        {
          segmentOrder: 0,
          rootCreditEventId: credit.id,
          sourcePurchaseEventId: '',
          amountMinor: credit.amountMinor,
        },
      ];
    }
    if (legacy.length !== 1 || legacy[0].allocated_minor !== credit.amountMinor)
      throw new Error(
        'This legacy wallet refund has ambiguous provenance ordering; correct it manually before returning it to Bank.',
      );
    const root = JSON.parse(legacy[0].payload) as ConsumerWalletEvent;
    if (root.walletId !== credit.walletId || root.balanceDeltaMinor <= 0)
      throw new Error('Wallet refund provenance crosses wallet boundaries.');
    if (root.eventType === 'REFUND' || root.eventType === 'REVERSAL')
      return this.resolveCreditProvenanceSegments(tx, root, seen);
    return [
      {
        segmentOrder: 0,
        rootCreditEventId: root.id,
        sourcePurchaseEventId: '',
        amountMinor: credit.amountMinor,
      },
    ];
  }

  private sliceWalletProvenance(
    segments: readonly WalletCreditProvenanceSegment[],
    offsetMinor: number,
    amountMinor: number,
    purchaseEventId: string,
  ): WalletCreditProvenanceSegment[] {
    if (
      !Number.isSafeInteger(offsetMinor) ||
      offsetMinor < 0 ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor <= 0
    )
      throw new Error('Wallet refund provenance range is invalid.');
    let remainingOffset = offsetMinor;
    let remaining = amountMinor;
    const result: WalletCreditProvenanceSegment[] = [];
    for (const segment of segments) {
      const skipped = Math.min(remainingOffset, segment.amountMinor);
      remainingOffset -= skipped;
      const available = segment.amountMinor - skipped;
      const take = Math.min(available, remaining);
      if (!take) continue;
      remaining -= take;
      result.push({
        segmentOrder: result.length,
        rootCreditEventId: segment.rootCreditEventId,
        sourcePurchaseEventId: purchaseEventId,
        amountMinor: take,
      });
    }
    if (remainingOffset || remaining)
      throw new Error('Wallet refund exceeds the original purchase provenance.');
    return result;
  }

  private async purchaseProvenanceSegments(
    tx: DatabaseSession,
    purchase: ConsumerWalletEvent,
    offsetMinor: number,
    amountMinor: number,
  ): Promise<WalletCreditProvenanceSegment[]> {
    const allocations = await tx.query<{
      credit_event_id: string;
      allocated_minor: number;
      payload: string;
      credit_payload: string;
    }>(
      `SELECT a.credit_event_id,a.allocated_minor,d.payload,e.payload AS credit_payload
       FROM consumer_wallet_event_allocations a
       JOIN consumer_wallet_events d ON d.id=a.debit_event_id
       JOIN consumer_wallet_events e ON e.id=a.credit_event_id
       WHERE a.debit_event_id=?`,
      [purchase.id],
    );
    const ordered = allocations
      .map((row) => ({
        ...row,
        debit: JSON.parse(row.payload) as ConsumerWalletEvent,
        credit: JSON.parse(row.credit_payload) as ConsumerWalletEvent,
      }))
      .sort((left, right) => compareConsumerWalletEvents(left.credit, right.credit));
    if (ordered.reduce((total, row) => total + row.allocated_minor, 0) !== purchase.amountMinor)
      throw new Error('Original purchase allocations are incomplete; refund was not saved.');

    const purchaseSegments: WalletCreditProvenanceSegment[] = [];
    for (const row of ordered) {
      const priorRows = await tx.query<{ payload: string; allocated_minor: number }>(
        `SELECT d.payload,a.allocated_minor FROM consumer_wallet_event_allocations a
         JOIN consumer_wallet_events d ON d.id=a.debit_event_id
         WHERE a.credit_event_id=?`,
        [row.credit_event_id],
      );
      const consumedBeforePurchase = priorRows.reduce(
        (total, allocation) =>
          compareConsumerWalletEvents(
            JSON.parse(allocation.payload) as ConsumerWalletEvent,
            purchase,
          ) < 0
            ? total + allocation.allocated_minor
            : total,
        0,
      );
      const originSegments = await this.resolveCreditProvenanceSegments(tx, row.credit);
      const allocatedSegments = this.sliceWalletProvenance(
        originSegments,
        consumedBeforePurchase,
        row.allocated_minor,
        purchase.id,
      );
      purchaseSegments.push(
        ...allocatedSegments.map((segment) => ({
          ...segment,
          segmentOrder: purchaseSegments.length + segment.segmentOrder,
        })),
      );
    }
    if (
      purchaseSegments.reduce((total, segment) => total + segment.amountMinor, 0) !==
      purchase.amountMinor
    )
      throw new Error('Original purchase provenance is incomplete; refund was not saved.');
    return this.sliceWalletProvenance(purchaseSegments, offsetMinor, amountMinor, purchase.id);
  }

  async previewWalletPurchaseRefund(
    input: Omit<WalletPurchaseRefundInput, 'confirmationKey'>,
  ): Promise<WalletPurchaseRefundPreview> {
    this.assertRefundInput(input);
    return this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      const { purchase, alreadyRefundedMinor, segments, remainingMinor } =
        await this.readWalletRefundState(tx, input);
      const event = this.walletRefundEvent(input, purchase, new Date().toISOString());
      if (compareConsumerWalletEvents(event, purchase) <= 0)
        throw new Error('A wallet refund cannot be dated before its original purchase.');
      await this.assertNoBackdatedWalletRefund(tx, purchase, event);
      const balanceBeforeMinor = await this.balanceIn(tx, purchase.walletId, event);
      const eventWithBalance = { ...event, balanceDeltaMinor: input.amountMinor };
      if (!Number.isSafeInteger(balanceBeforeMinor + input.amountMinor))
        throw new Error('Wallet balance would exceed the supported amount.');
      await assertChronologicalConsumerWalletLedger(tx, purchase.walletId, {
        additionalEvents: [eventWithBalance],
      });
      return {
        walletId: purchase.walletId,
        purchaseEventId: purchase.id,
        amountMinor: input.amountMinor,
        alreadyRefundedMinor,
        refundableRemainingMinor: remainingMinor - input.amountMinor,
        provenanceSegments: segments,
        confirmationKey: walletRefundConfirmationKey(
          input,
          purchase.walletId,
          alreadyRefundedMinor,
          remainingMinor,
          segments,
        ),
      };
    });
  }

  async recordWalletPurchaseRefund(input: WalletPurchaseRefundInput): Promise<ConsumerWalletEvent> {
    this.assertRefundInput(input);
    if (!input.confirmationKey)
      throw new Error('Review and approve the wallet refund before saving.');
    const result = await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      const [duplicateRow] = await tx.query<{ payload: string }>(
        'SELECT payload FROM consumer_wallet_events WHERE id=?',
        [input.id],
      );
      if (duplicateRow) {
        const duplicate = JSON.parse(duplicateRow.payload) as ConsumerWalletEvent;
        if (
          duplicate.eventType !== (input.eventType ?? 'REFUND') ||
          duplicate.walletId !== (await this.readWalletIdForPurchase(tx, input.purchaseEventId)) ||
          duplicate.reversalOfEventId !== input.purchaseEventId ||
          duplicate.amountMinor !== input.amountMinor ||
          duplicate.eventDate !== input.eventDate ||
          (duplicate.eventTime ?? '') !== (input.eventTime ?? '') ||
          (duplicate.reference ?? '') !== (input.reference?.trim().slice(0, 100) ?? '') ||
          (duplicate.refundReason ?? '') !== (input.reason?.trim().slice(0, 160) ?? '') ||
          (duplicate.notes ?? '') !== (input.notes?.trim().slice(0, 500) ?? '')
        )
          throw new Error('This refund ID was already used for a different financial event.');
        await linkWalletRefundToPaymentGroup(
          tx,
          input.purchaseEventId,
          duplicate.id,
          duplicate.createdAt,
        );
        return { event: duplicate, groups: await readPaymentGroups(tx) };
      }
      const { purchase, alreadyRefundedMinor, segments, remainingMinor } =
        await this.readWalletRefundState(tx, {
          ...input,
          amountMinor: input.amountMinor,
        });
      const event = this.walletRefundEvent(input, purchase, new Date().toISOString());
      if (compareConsumerWalletEvents(event, purchase) <= 0)
        throw new Error('A wallet refund cannot be dated before its original purchase.');
      await this.assertNoBackdatedWalletRefund(tx, purchase, event);
      if (input.amountMinor > remainingMinor)
        throw new Error('Refund exceeds the remaining refundable purchase amount.');
      if (input.eventType === 'REVERSAL' && input.amountMinor !== remainingMinor)
        throw new Error('Purchase cancellation must reverse the full remaining purchase amount.');
      const expectedKey = walletRefundConfirmationKey(
        input,
        purchase.walletId,
        alreadyRefundedMinor,
        remainingMinor,
        segments,
      );
      if (input.confirmationKey !== expectedKey)
        throw new Error('Purchase refunds or provenance changed. Review the refund again.');
      const balanceBeforeMinor = await this.balanceIn(tx, purchase.walletId, event);
      if (!Number.isSafeInteger(balanceBeforeMinor + input.amountMinor))
        throw new Error('Wallet balance would exceed the supported amount.');
      await this.insertEvent(tx, event);
      await linkWalletRefundToPaymentGroup(tx, purchase.id, event.id, event.createdAt);
      const aggregate = new Map<string, number>();
      for (const segment of segments) {
        aggregate.set(
          segment.rootCreditEventId,
          (aggregate.get(segment.rootCreditEventId) ?? 0) + segment.amountMinor,
        );
        await tx.run(
          'INSERT INTO consumer_wallet_credit_provenance_segments(id,credit_event_id,segment_order,root_credit_event_id,source_purchase_event_id,amount_minor,created_at) VALUES(?,?,?,?,?,?,?)',
          [
            `${event.id}:segment:${segment.segmentOrder}`,
            event.id,
            segment.segmentOrder,
            segment.rootCreditEventId,
            segment.sourcePurchaseEventId,
            segment.amountMinor,
            event.createdAt,
          ],
        );
      }
      for (const [rootCreditEventId, allocatedMinor] of aggregate) {
        await tx.run(
          'INSERT INTO consumer_wallet_credit_provenance(credit_event_id,source_credit_event_id,allocated_minor,created_at) VALUES(?,?,?,?)',
          [event.id, rootCreditEventId, allocatedMinor, event.createdAt],
        );
      }
      await assertChronologicalConsumerWalletLedger(tx, purchase.walletId);
      return { event, groups: await readPaymentGroups(tx) };
    });
    if (result.event.id === input.id) this.publishEventWrite(result.event, []);
    this.store.paymentGroups.set(result.groups);
    return result.event;
  }

  async previewWalletPurchaseCancellation(
    input: Omit<WalletPurchaseRefundInput, 'confirmationKey' | 'eventType'>,
  ): Promise<WalletPurchaseRefundPreview> {
    const preview = await this.previewWalletPurchaseRefund({ ...input, eventType: 'REVERSAL' });
    if (preview.refundableRemainingMinor !== 0)
      throw new Error('Cancel the purchase by reversing its full remaining amount.');
    return preview;
  }

  async cancelWalletPurchase(
    input: Omit<WalletPurchaseRefundInput, 'eventType'>,
  ): Promise<ConsumerWalletEvent> {
    return this.recordWalletPurchaseRefund({ ...input, eventType: 'REVERSAL' });
  }

  private assertRefundInput(input: Omit<WalletPurchaseRefundInput, 'confirmationKey'>): void {
    if (
      !input.id.trim() ||
      !input.purchaseEventId.trim() ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0
    )
      throw new Error('Enter a positive wallet refund amount.');
    if (!validTransferDate(input.eventDate, input.eventTime))
      throw new Error('Enter a valid wallet refund date and time.');
  }

  private walletRefundEvent(
    input: WalletPurchaseRefundInput,
    purchase: ConsumerWalletEvent,
    timestamp: string,
  ): ConsumerWalletEvent {
    return {
      id: input.id,
      walletId: purchase.walletId,
      eventType: input.eventType ?? 'REFUND',
      eventDate: input.eventDate,
      eventTime: input.eventTime,
      amountMinor: input.amountMinor,
      balanceDeltaMinor: input.amountMinor,
      reversalOfEventId: purchase.id,
      reference: input.reference?.trim().slice(0, 100) || undefined,
      refundReason: input.reason?.trim().slice(0, 160) || undefined,
      notes: input.notes?.trim().slice(0, 500) || undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private async readWalletRefundState(
    tx: DatabaseSession,
    input: Pick<WalletPurchaseRefundInput, 'purchaseEventId' | 'amountMinor' | 'eventDate' | 'id'>,
  ): Promise<{
    purchase: ConsumerWalletEvent;
    alreadyRefundedMinor: number;
    remainingMinor: number;
    segments: WalletCreditProvenanceSegment[];
  }> {
    const [purchaseRow] = await tx.query<{ payload: string }>(
      "SELECT payload FROM consumer_wallet_events WHERE id=? AND event_type='PURCHASE'",
      [input.purchaseEventId],
    );
    if (!purchaseRow) throw new Error('Choose an existing wallet purchase to refund.');
    const purchase = JSON.parse(purchaseRow.payload) as ConsumerWalletEvent;
    if (input.id === purchase.id) throw new Error('A refund must use a new event ID.');
    const [walletRow] = await tx.query<{ id: string }>(
      'SELECT id FROM consumer_wallets WHERE id=?',
      [purchase.walletId],
    );
    if (!walletRow) throw new Error('The original consumer wallet no longer exists.');
    const refundRows = await tx.query<{ payload: string }>(
      "SELECT payload FROM consumer_wallet_events WHERE event_type IN ('REFUND','REVERSAL') AND reversal_of_event_id=?",
      [purchase.id],
    );
    const alreadyRefundedMinor = refundRows.reduce((total, row) => {
      const refund = JSON.parse(row.payload) as ConsumerWalletEvent;
      return total + refund.amountMinor;
    }, 0);
    if (!Number.isSafeInteger(alreadyRefundedMinor) || alreadyRefundedMinor > purchase.amountMinor)
      throw new Error('Existing refunds exceed this purchase amount.');
    const remainingMinor = purchase.amountMinor - alreadyRefundedMinor;
    if (input.amountMinor > remainingMinor)
      throw new Error('Refund exceeds the remaining refundable purchase amount.');
    const segments = await this.purchaseProvenanceSegments(
      tx,
      purchase,
      alreadyRefundedMinor,
      input.amountMinor,
    );
    if (segments.reduce((total, segment) => total + segment.amountMinor, 0) !== input.amountMinor)
      throw new Error('Refund provenance does not equal the refund amount.');
    return { purchase, alreadyRefundedMinor, remainingMinor, segments };
  }

  private async readWalletIdForPurchase(
    tx: DatabaseSession,
    purchaseEventId: string,
  ): Promise<string> {
    const [row] = await tx.query<{ wallet_id: string }>(
      "SELECT wallet_id FROM consumer_wallet_events WHERE id=? AND event_type='PURCHASE'",
      [purchaseEventId],
    );
    if (!row) throw new Error('Choose an existing wallet purchase to refund.');
    return row.wallet_id;
  }

  private async assertNoBackdatedWalletRefund(
    tx: DatabaseSession,
    purchase: ConsumerWalletEvent,
    event: ConsumerWalletEvent,
  ): Promise<void> {
    const priorRows = await tx.query<{ payload: string }>(
      "SELECT payload FROM consumer_wallet_events WHERE event_type IN ('REFUND','REVERSAL') AND reversal_of_event_id=?",
      [purchase.id],
    );
    if (
      priorRows.some((row) => {
        const prior = JSON.parse(row.payload) as ConsumerWalletEvent;
        return compareConsumerWalletEvents(event, prior) < 0;
      })
    )
      throw new Error('A backdated refund would change audited purchase provenance.');
  }

  private async classifyReturnAllocation(
    tx: DatabaseSession,
    returnEventId: string,
    credit: ConsumerWalletEvent,
    allocatedMinor: number,
    alreadyConsumedMinor: number,
    reversedByFundedLoad: Map<string, number>,
    createdAt: string,
  ): Promise<{ expenseReversalMinor: number; reversals: ConsumerWalletExpenseReversal[] }> {
    const segments = await this.resolveCreditProvenanceSegments(tx, credit);
    const allocationStart = alreadyConsumedMinor;
    const allocationEnd = alreadyConsumedMinor + allocatedMinor;
    let segmentStart = 0;
    let expenseReversalMinor = 0;
    const reversals: ConsumerWalletExpenseReversal[] = [];
    for (const segment of segments) {
      const segmentEnd = segmentStart + segment.amountMinor;
      const overlap = Math.max(
        0,
        Math.min(allocationEnd, segmentEnd) - Math.max(allocationStart, segmentStart),
      );
      segmentStart = segmentEnd;
      if (!overlap) continue;
      const [originRow] = await tx.query<{ payload: string }>(
        'SELECT payload FROM consumer_wallet_events WHERE id=?',
        [segment.rootCreditEventId],
      );
      const origin = originRow ? (JSON.parse(originRow.payload) as ConsumerWalletEvent) : null;
      if (!origin || origin.walletId !== credit.walletId)
        throw new Error('Refund credit provenance crosses a wallet boundary.');
      if (origin.eventType !== 'FUNDED_LOAD') continue;
      const [reversedRow] = await tx.query<{ reversed: number | null }>(
        'SELECT COALESCE(SUM(reversed_minor),0) AS reversed FROM consumer_wallet_expense_reversals WHERE funded_load_event_id=?',
        [origin.id],
      );
      const alreadyReversed =
        Number(reversedRow?.reversed ?? 0) + (reversedByFundedLoad.get(origin.id) ?? 0);
      const fundedPrincipal = origin.loadedAmountMinor ?? origin.amountMinor;
      const reversedMinor = Math.min(overlap, Math.max(0, fundedPrincipal - alreadyReversed));
      if (!reversedMinor) continue;
      reversals.push({
        returnEventId,
        creditEventId: credit.id,
        fundedLoadEventId: origin.id,
        reversedMinor,
        createdAt,
      });
      reversedByFundedLoad.set(
        origin.id,
        (reversedByFundedLoad.get(origin.id) ?? 0) + reversedMinor,
      );
      expenseReversalMinor += reversedMinor;
    }
    return { expenseReversalMinor, reversals };
  }

  async previewUpiLiteReturn(
    input: Omit<UpiLiteReturnInput, 'confirmationKey'>,
  ): Promise<UpiLiteReturnPreview> {
    if (!input.id.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('Enter a positive wallet return amount.');
    if (!validTransferDate(input.eventDate, input.eventTime))
      throw new Error('Enter a valid return date and time.');
    const reference = input.reference?.trim().slice(0, 100) || undefined;
    const timestamp = new Date().toISOString();
    return this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      await this.assertActiveWallet(tx, input.walletId);
      const [walletRow] = await tx.query<{ wallet_kind: string }>(
        'SELECT wallet_kind FROM consumer_wallets WHERE id=?',
        [input.walletId],
      );
      if (walletRow?.wallet_kind !== 'UPI_LITE')
        throw new Error('Return to Bank is available only for an active UPI Lite wallet.');
      const [sourcePreference] = await tx.query<{ encrypted_value: string }>(
        "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
      );
      let sources: PaymentSource[];
      try {
        sources = sourcePreference
          ? (JSON.parse(sourcePreference.encrypted_value) as PaymentSource[])
          : this.store.paymentSources().map((source) => ({ ...source }));
      } catch {
        throw new Error('Bank accounts could not be read; the return was not recorded.');
      }
      const bank = sources.find((source) => source.id === input.bankSourceId);
      if (
        !bank ||
        bank.archived ||
        !isEnrolledBankAccount(bank) ||
        bank.id === 'source-debit' ||
        bank.institution === 'Primary bank'
      )
        throw new Error('Choose an active registered Bank/UPI account.');
      const existingBankTransaction = await this.resolveExistingBankCredit(tx, bank, input);
      const [trackingPreference] = await tx.query<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM app_preferences WHERE key=?',
        ['bank_cash_tracking'],
      );
      const settings = parseBankCashTracking(trackingPreference?.encrypted_value);
      if (
        !existingBankTransaction &&
        !input.balanceTiming &&
        needsBaselineConfirmation(bank, settings, input.eventDate, input.eventTime)
      )
        throw new Error(TIMING_QUESTION);

      const event: ConsumerWalletEvent = {
        id: input.id,
        walletId: input.walletId,
        eventType: 'UPI_LITE_RETURN',
        eventDate: input.eventDate,
        eventTime: input.eventTime,
        amountMinor: input.amountMinor,
        balanceDeltaMinor: -input.amountMinor,
        returnSourceId: bank.id,
        memo: input.note?.trim().slice(0, 200) || undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const historicalBalance = await this.balanceIn(tx, input.walletId, event);
      if (historicalBalance < input.amountMinor)
        throw new Error('Return exceeds the available historical UPI Lite balance.');
      if (!existingBankTransaction) {
        applyBankCashTransaction(
          sources,
          null,
          {
            id: `wallet-return-bank-credit-${input.id}`,
            cardId: bank.id,
            type: 'CREDIT',
            amountMinor: input.amountMinor,
            currencyCode: 'INR',
            transactionDate: input.eventDate,
            transactionTime: input.eventTime,
            merchant: `UPI Lite return${reference ? ` · Ref ${reference}` : ''}`,
            categoryId: 'contra-expenses',
            origin: 'MANUAL',
            balanceTiming: input.balanceTiming,
            balanceTimingAt: input.balanceTiming ? timestamp : undefined,
            attachmentIds: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          settings,
          timestamp,
        );
      }
      const reversedByFundedLoad = new Map<string, number>();
      const reversalRows: ConsumerWalletExpenseReversal[] = [];
      const plan = await planConsumerWalletDebit(
        tx,
        event,
        input.amountMinor,
        async (credit, allocatedMinor, alreadyConsumedMinor) => {
          const classified = await this.classifyReturnAllocation(
            tx,
            event.id,
            credit,
            allocatedMinor,
            alreadyConsumedMinor,
            reversedByFundedLoad,
            timestamp,
          );
          reversalRows.push(...classified.reversals);
          return classified.expenseReversalMinor;
        },
      );
      const attributions: UpiLiteReturnAttribution[] = plan.map((item) => ({
        creditEventId: item.creditEvent.id,
        creditEventType: item.creditEvent.eventType,
        allocatedMinor: item.allocatedMinor,
        expenseReversalMinor: item.expenseReversalMinor,
      }));
      const previewAllocations: ConsumerWalletEventAllocation[] = plan.map((item, index) => ({
        id: `preview:${index}:${item.creditEvent.id}`,
        debitEventId: event.id,
        creditEventId: item.creditEvent.id,
        allocatedMinor: item.allocatedMinor,
        expenseReversalMinor: item.expenseReversalMinor,
        createdAt: timestamp,
      }));
      await assertChronologicalConsumerWalletLedger(tx, input.walletId, {
        additionalEvents: [event],
        additionalAllocations: previewAllocations,
      });
      const fundedPrincipalReversalMinor = attributions.reduce(
        (total, item) => total + item.expenseReversalMinor,
        0,
      );
      const remainingWalletBalanceMinor = historicalBalance - input.amountMinor;
      return {
        walletId: input.walletId,
        bankSourceId: bank.id,
        bankName: bank.institution || bank.nickname,
        amountMinor: input.amountMinor,
        eventDate: input.eventDate,
        eventTime: input.eventTime,
        existingBankTransactionId: existingBankTransaction?.id,
        fundedPrincipalReversalMinor,
        nonFundedReturnMinor: input.amountMinor - fundedPrincipalReversalMinor,
        remainingWalletBalanceMinor,
        attributions,
        confirmationKey: upiLiteReturnConfirmationKey(
          input,
          existingBankTransaction?.id,
          attributions,
          remainingWalletBalanceMinor,
        ),
      };
    });
  }

  async recordUpiLiteReturn(input: UpiLiteReturnInput): Promise<ConsumerWalletEvent> {
    if (!input.id.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('Enter a positive wallet return amount.');
    if (!validTransferDate(input.eventDate, input.eventTime))
      throw new Error('Enter a valid return date and time.');
    const reference = input.reference?.trim().slice(0, 100) || undefined;
    const note = input.note?.trim().slice(0, 200) || undefined;
    const timestamp = new Date().toISOString();
    const result = await this.database.atomic(async (tx) => {
      await this.assertWalletsEnabled(tx);
      await this.assertActiveWallet(tx, input.walletId);
      const [walletRow] = await tx.query<{ wallet_kind: string }>(
        'SELECT wallet_kind FROM consumer_wallets WHERE id=?',
        [input.walletId],
      );
      if (walletRow?.wallet_kind !== 'UPI_LITE')
        throw new Error('Return to Bank is available only for an active UPI Lite wallet.');

      const [sourcePreference] = await tx.query<{ encrypted_value: string }>(
        "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
      );
      let sources: PaymentSource[];
      try {
        sources = sourcePreference
          ? (JSON.parse(sourcePreference.encrypted_value) as PaymentSource[])
          : this.store.paymentSources().map((source) => ({ ...source }));
      } catch {
        throw new Error('Bank accounts could not be read; the return was not recorded.');
      }
      const bank = sources.find((source) => source.id === input.bankSourceId);
      if (
        !bank ||
        bank.archived ||
        !isEnrolledBankAccount(bank) ||
        bank.id === 'source-debit' ||
        bank.institution === 'Primary bank'
      )
        throw new Error('Choose an active registered Bank/UPI account.');
      const [trackingPreference] = await tx.query<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM app_preferences WHERE key=?',
        ['bank_cash_tracking'],
      );
      const settings = parseBankCashTracking(trackingPreference?.encrypted_value);

      const [sameIdRow] = await tx.query<{ payload: string }>(
        'SELECT payload FROM consumer_wallet_events WHERE id=?',
        [input.id],
      );
      if (sameIdRow) {
        const existing = JSON.parse(sameIdRow.payload) as ConsumerWalletEvent;
        const [link] = await tx.query<{
          wallet_id: string;
          bank_source_id: string;
          existing_bank_transaction_id: string | null;
          reference: string | null;
          note: string | null;
        }>(
          'SELECT wallet_id,bank_source_id,existing_bank_transaction_id,reference,note FROM consumer_wallet_return_links WHERE return_event_id=?',
          [input.id],
        );
        if (
          existing.eventType !== 'UPI_LITE_RETURN' ||
          existing.walletId !== input.walletId ||
          existing.amountMinor !== input.amountMinor ||
          existing.eventDate !== input.eventDate ||
          (existing.eventTime ?? '') !== (input.eventTime ?? '') ||
          link?.wallet_id !== input.walletId ||
          link?.bank_source_id !== bank.id ||
          (link?.existing_bank_transaction_id ?? undefined) !==
            (input.existingBankTransactionId ?? undefined) ||
          (link?.reference ?? undefined) !== reference ||
          (link?.note ?? undefined) !== note
        )
          throw new Error('This return ID was already used for a different financial event.');
        const allocations = await this.readEventAllocations(tx, existing.id);
        const reversalRows = await tx.query<{
          return_event_id: string;
          credit_event_id: string;
          funded_load_event_id: string;
          reversed_minor: number;
          created_at: string;
        }>('SELECT * FROM consumer_wallet_expense_reversals WHERE return_event_id=?', [
          existing.id,
        ]);
        return {
          event: existing,
          allocations,
          sources,
          postedBankTransaction: null,
          expenseReversals: reversalRows.map((row) => ({
            returnEventId: row.return_event_id,
            creditEventId: row.credit_event_id,
            fundedLoadEventId: row.funded_load_event_id,
            reversedMinor: row.reversed_minor,
            createdAt: row.created_at,
          })),
        };
      }

      const existingBankTransaction = await this.resolveExistingBankCredit(tx, bank, {
        ...input,
        reference,
      });
      const bankTransactionId =
        existingBankTransaction?.id ?? `wallet-return-bank-credit-${input.id}`;

      const event: ConsumerWalletEvent = {
        id: input.id,
        walletId: input.walletId,
        eventType: 'UPI_LITE_RETURN',
        eventDate: input.eventDate,
        eventTime: input.eventTime,
        amountMinor: input.amountMinor,
        balanceDeltaMinor: -input.amountMinor,
        sourceTransactionId: bankTransactionId,
        returnSourceId: bank.id,
        memo: note,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const historicalBalance = await this.balanceIn(tx, input.walletId, event);
      if (historicalBalance < input.amountMinor)
        throw new Error('Return exceeds the available historical UPI Lite balance.');

      let balanceEffect = existingBankTransaction?.balanceEffect;
      let postedBankTransaction: CardTransaction | null = null;
      if (!existingBankTransaction) {
        if (
          !input.balanceTiming &&
          needsBaselineConfirmation(bank, settings, input.eventDate, input.eventTime)
        )
          throw new Error(TIMING_QUESTION);
        const bankCredit = await this.store.writeWalletReturnCredit(tx, {
          id: bankTransactionId,
          cardId: bank.id,
          type: 'CREDIT',
          amountMinor: input.amountMinor,
          currencyCode: 'INR',
          transactionDate: input.eventDate,
          transactionTime: input.eventTime,
          merchant: `UPI Lite return${reference ? ` · Ref ${reference}` : ''}`,
          categoryId: 'contra-expenses',
          origin: 'MANUAL',
          balanceTiming: input.balanceTiming,
          balanceTimingAt: input.balanceTiming ? timestamp : undefined,
          attachmentIds: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        postedBankTransaction = bankCredit.transaction;
        sources = bankCredit.sources;
        balanceEffect = bankCredit.transaction.balanceEffect;
      }

      await this.insertEvent(tx, event);
      const reversalsByFundedLoad = new Map<string, number>();
      const reversalRows: ConsumerWalletExpenseReversal[] = [];
      const attributions: UpiLiteReturnAttribution[] = [];
      const allocations = await allocateConsumerWalletDebit(
        tx,
        event,
        input.amountMinor,
        async (credit, allocatedMinor, alreadyConsumedMinor) => {
          const classified = await this.classifyReturnAllocation(
            tx,
            event.id,
            credit,
            allocatedMinor,
            alreadyConsumedMinor,
            reversalsByFundedLoad,
            timestamp,
          );
          reversalRows.push(...classified.reversals);
          attributions.push({
            creditEventId: credit.id,
            creditEventType: credit.eventType,
            allocatedMinor,
            expenseReversalMinor: classified.expenseReversalMinor,
          });
          return classified.expenseReversalMinor;
        },
      );
      const remainingWalletBalanceMinor = historicalBalance - input.amountMinor;
      const confirmationKey = upiLiteReturnConfirmationKey(
        input,
        existingBankTransaction?.id,
        attributions,
        remainingWalletBalanceMinor,
      );
      if (!input.confirmationKey || input.confirmationKey !== confirmationKey)
        throw new Error(
          'Wallet or FIFO attribution changed. Review and approve the return summary again.',
        );
      for (const reversal of reversalRows)
        await tx.run(
          'INSERT INTO consumer_wallet_expense_reversals(return_event_id,credit_event_id,funded_load_event_id,reversed_minor,created_at) VALUES(?,?,?,?,?)',
          [
            reversal.returnEventId,
            reversal.creditEventId,
            reversal.fundedLoadEventId,
            reversal.reversedMinor,
            reversal.createdAt,
          ],
        );
      await assertChronologicalConsumerWalletLedger(tx, input.walletId);
      const returnLink: ConsumerWalletReturnLink = {
        returnEventId: event.id,
        walletId: event.walletId,
        bankSourceId: bank.id,
        existingBankTransactionId: existingBankTransaction?.id,
        balanceEffect,
        reference,
        note,
        createdAt: timestamp,
      };
      await tx.run(
        'INSERT INTO consumer_wallet_return_links(return_event_id,wallet_id,bank_source_id,existing_bank_transaction_id,balance_effect,reference,note,created_at) VALUES(?,?,?,?,?,?,?,?)',
        [
          returnLink.returnEventId,
          returnLink.walletId,
          returnLink.bankSourceId,
          returnLink.existingBankTransactionId ?? null,
          returnLink.balanceEffect ? JSON.stringify(returnLink.balanceEffect) : null,
          returnLink.reference ?? null,
          returnLink.note ?? null,
          returnLink.createdAt,
        ],
      );
      return { event, allocations, sources, postedBankTransaction, expenseReversals: reversalRows };
    });
    this.store.acceptCommittedImport(
      result.postedBankTransaction,
      result.sources,
      result.event.sourceTransactionId,
    );
    this.publishEventWrite(result.event, result.allocations);
    this.expenseReversals.update((rows) => [
      ...rows.filter((row) => row.returnEventId !== result.event.id),
      ...result.expenseReversals,
    ]);
    this.store.acceptWalletFinancialHistory(this.events(), this.expenseReversals());
    return result.event;
  }

  async reloadFinancialHistory(): Promise<void> {
    const [events, allocations, expenseReversals] = await Promise.all([
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
      this.database.query<{
        return_event_id: string;
        credit_event_id: string;
        funded_load_event_id: string;
        reversed_minor: number;
        created_at: string;
      }>('SELECT * FROM consumer_wallet_expense_reversals ORDER BY created_at'),
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
    const mappedReversals = expenseReversals.map((row) => ({
      returnEventId: row.return_event_id,
      creditEventId: row.credit_event_id,
      fundedLoadEventId: row.funded_load_event_id,
      reversedMinor: row.reversed_minor,
      createdAt: row.created_at,
    }));
    this.expenseReversals.set(mappedReversals);
    this.store.acceptWalletFinancialHistory(
      events.map((row) => JSON.parse(row.payload) as ConsumerWalletEvent),
      mappedReversals,
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
    this.store.acceptWalletFinancialHistory(this.events(), this.expenseReversals());
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

  private async assertWalletCategory(tx: DatabaseSession, categoryId: string): Promise<void> {
    const [category] = await tx.query<{ id: string; archived: number }>(
      'SELECT id,archived FROM categories WHERE id=?',
      [categoryId],
    );
    if (!category || category.archived !== 0)
      throw new Error('Choose an active transaction category.');
  }

  private assertWalletAttachments(attachmentIds: readonly string[] | undefined): void {
    if (!attachmentIds) return;
    if (attachmentIds.length > 10)
      throw new Error('A wallet purchase can include up to 10 receipt images.');
    for (const attachment of attachmentIds) {
      const match = /^data:image\/(?:jpeg|png|webp|gif);base64,([a-z0-9+/=]+)$/i.exec(attachment);
      if (!match || Math.floor((match[1].length * 3) / 4) > 1_000_000)
        throw new Error('Wallet receipt images must be valid images no larger than 1 MB.');
    }
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

  private async resolveExistingBankCredit(
    tx: DatabaseSession,
    bank: PaymentSource,
    input: Pick<
      UpiLiteReturnInput,
      'amountMinor' | 'eventDate' | 'reference' | 'existingBankTransactionId'
    >,
  ): Promise<CardTransaction | undefined> {
    if (!input.existingBankTransactionId) {
      const rows = await tx.query<{ payload: string }>(
        `SELECT payload FROM card_transactions
         WHERE type='CREDIT' AND json_extract(payload,'$.cardId')=?
           AND amount_minor=? AND transaction_date=?`,
        [bank.id, input.amountMinor, input.eventDate],
      );
      const candidates = rows
        .map((row) => JSON.parse(row.payload) as CardTransaction)
        .filter((transaction) => !input.reference || transaction.reference === input.reference);
      if (candidates.length)
        throw new Error(
          'A Bank/UPI credit may already represent this return. Select it explicitly or enter a distinct reference.',
        );
      return undefined;
    }
    const [row] = await tx.query<{ payload: string }>(
      "SELECT payload FROM card_transactions WHERE id=? AND type='CREDIT'",
      [input.existingBankTransactionId],
    );
    const existing = row ? (JSON.parse(row.payload) as CardTransaction) : undefined;
    if (
      !existing ||
      existing.cardId !== bank.id ||
      existing.amountMinor !== input.amountMinor ||
      existing.transactionDate !== input.eventDate ||
      (input.reference && existing.reference !== input.reference)
    )
      throw new Error('The selected Bank/UPI credit does not match this return.');
    if (existing) {
      const [linked] = await tx.query<{ return_event_id: string }>(
        'SELECT return_event_id FROM consumer_wallet_return_links WHERE existing_bank_transaction_id=?',
        [existing.id],
      );
      if (linked) throw new Error('That Bank/UPI credit is already linked to a wallet return.');
    }
    return existing;
  }

  private async readEventAllocations(
    tx: DatabaseSession,
    debitEventId: string,
  ): Promise<ConsumerWalletEventAllocation[]> {
    const rows = await tx.query<{
      id: string;
      debit_event_id: string;
      credit_event_id: string;
      allocated_minor: number;
      expense_reversal_minor: number;
      created_at: string;
    }>(
      'SELECT id,debit_event_id,credit_event_id,allocated_minor,expense_reversal_minor,created_at FROM consumer_wallet_event_allocations WHERE debit_event_id=? ORDER BY created_at,id',
      [debitEventId],
    );
    return rows.map((row) => ({
      id: row.id,
      debitEventId: row.debit_event_id,
      creditEventId: row.credit_event_id,
      allocatedMinor: row.allocated_minor,
      expenseReversalMinor: row.expense_reversal_minor,
      createdAt: row.created_at,
    }));
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
      .sort(compareConsumerWalletEvents);
  }

  private async balanceIn(
    tx: DatabaseSession,
    walletId: string,
    before?: ConsumerWalletEventPosition,
    excludedEventIds: ReadonlySet<string> = new Set<string>(),
  ): Promise<number> {
    const events = await this.readChronologicalEvents(tx, walletId);
    let balance = 0;
    for (const event of events) {
      if (excludedEventIds.has(event.id)) continue;
      if (before && compareConsumerWalletEvents(event, before) >= 0) break;
      const next = balance + event.balanceDeltaMinor;
      if (!Number.isSafeInteger(event.balanceDeltaMinor) || !Number.isSafeInteger(next))
        throw new Error('Wallet history exceeds the supported balance range.');
      if (next < 0) throw new Error('Wallet history contains a negative historical balance.');
      balance = next;
    }
    return balance;
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
    this.store.acceptWalletFinancialHistory(this.events(), this.expenseReversals());
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
