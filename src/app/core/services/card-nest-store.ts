import { Service, computed, inject, signal } from '@angular/core';
import {
  BalanceTiming,
  BankCashTrackingSettings,
  CardTransaction,
  CardStatement,
  Category,
  CreditCard,
  DashboardSnapshot,
  EmiInstallment,
  EmiPlan,
  LoanCommitment,
  MonthlyIncomeRecord,
  PaymentSource,
  PaymentGroup,
  RecurringRule,
  SourceBalanceAdjustment,
  SourceTransfer,
} from '../models/domain';
import { DatabaseSession, SqliteDatabase } from '../data/sqlite-database';
import { walletEffectApplies } from './wallet-anchor';
import {
  BANK_CASH_TRACKING_KEY,
  DEFAULT_BANK_CASH_TRACKING,
  applyBankCashTransaction,
  applyTransferEffects,
  applyWalletTransaction,
  bankAccountLabel,
  bankCashTracked,
  isBankOrCash,
  liquidTotals,
  parseBankCashTracking,
  reverseBalanceEffect,
  reverseTransferEffects,
  TIMING_QUESTION,
  needsBaselineConfirmation,
  transferKindFor,
  validTransferDate,
} from './source-balance';
import {
  excludesStatementDayTransactions,
  isTransactionIncludedInStatement,
  normalizeCardDueDateRule,
  previousStatementDate,
  statementDateFor,
  toIsoDate,
} from './billing-cycle';
import { calculateNetSpending, calculateOutstanding, transactionEffect } from './money';
import {
  attachPaymentGroup,
  detachPaymentGroup,
  eligiblePaymentMember,
  PaymentGroupEdits,
  readPaymentGroups,
} from './payment-groups';
import { indiaTimeOfDay, indiaTodayIso } from './india-date';
import { APP_ENVIRONMENT } from './app-environment';
import { initialiseAppData } from '../data/app-initialization';
import {
  configureMoneyDisplay,
  countryOption,
  countryOptionForCurrency,
  isSupportedDisplayCurrency,
} from './currency-display';

const now = new Date();
const today = now.toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;
const FLASH_SOURCE_STORAGE_KEY = 'cardnest_flash_transaction_source_id';
const PAYMENT_SOURCES_PREFERENCE_KEY = 'payment_sources';

function readFlashSourcePreference(): string | null {
  try {
    return globalThis.localStorage?.getItem(FLASH_SOURCE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeFlashSourcePreference(id: string): void {
  try {
    globalThis.localStorage?.setItem(FLASH_SOURCE_STORAGE_KEY, id);
  } catch {
    // SQLite remains the secondary preference store when browser storage is unavailable.
  }
}

function clearFlashSourcePreference(): void {
  try {
    globalThis.localStorage?.removeItem(FLASH_SOURCE_STORAGE_KEY);
  } catch {
    // The in-memory signal is still reset below.
  }
}

const SAMPLE_CARDS: readonly CreditCard[] = [
  {
    id: 'card-demo-one',
    nickname: 'Everyday',
    issuerName: 'Northstar Bank',
    lastDigits: '4821',
    network: 'VISA',
    subtype: 'Visa Signature',
    theme: 'indigo',
    statementDay: 18,
    dueDateMode: 'DAYS_AFTER_STATEMENT',
    daysAfterStatement: 20,
    adjustDueDateOnWeekend: true,
    creditLimitMinor: 25000000,
    currencyCode: 'INR',
    openingBalanceMinor: 0,
    remindToSettle: true,
    annualFeeEnabled: true,
    annualFee: {
      amountMinor: 99900,
      renewalMonth: 10,
      renewalDay: 12,
      frequencyMonths: 12,
      waiverThresholdMinor: 10000000,
      waiverPeriod: 'ANNIVERSARY',
    },
    emergencyPhones: [],
    supportEmails: [],
    archived: false,
    createdAt: today,
    updatedAt: today,
  },
  {
    id: 'card-demo-two',
    nickname: 'Travel',
    issuerName: 'Atlas Credit',
    lastDigits: '1907',
    network: 'MASTERCARD',
    subtype: 'World',
    theme: 'teal',
    statementDay: 4,
    dueDateMode: 'DAYS_AFTER_STATEMENT',
    daysAfterStatement: 20,
    adjustDueDateOnWeekend: true,
    creditLimitMinor: 40000000,
    currencyCode: 'INR',
    openingBalanceMinor: 0,
    remindToSettle: true,
    annualFeeEnabled: false,
    emergencyPhones: [],
    supportEmails: [],
    archived: false,
    createdAt: today,
    updatedAt: today,
  },
];

const CATEGORIES: readonly Category[] = [
  ['groceries', 'Groceries', 'shopping_basket', '#e0a860'],
  ['dining', 'Dining', 'restaurant', '#de7d68'],
  ['fuel', 'Fuel', 'local_gas_station', '#5a9d90'],
  ['shopping', 'Shopping', 'shopping_bag', '#9075b5'],
  ['travel', 'Travel', 'flight', '#4e87c7'],
  ['utilities', 'Utilities', 'bolt', '#c8a43b'],
  ['healthcare', 'Healthcare', 'health_and_safety', '#d56a7b'],
  ['subscription', 'Subscription', 'subscriptions', '#65758b'],
  ['payment', 'Card Payment', 'payments', '#4e9d73'],
  ['contra-expenses', 'Contra-expenses', 'banknote_arrow_down', '#4e9d73'],
  ['income', 'Income', 'banknote_arrow_up', '#3f8f63'],
  ['other', 'Other', 'category', '#7a8797'],
].map(
  ([id, name, icon, colour]) =>
    ({
      id,
      name,
      icon,
      colour,
      appliesTo:
        id === 'payment' || id === 'contra-expenses' || id === 'income' ? 'CREDIT' : 'BOTH',
      archived: false,
    }) as Category,
);

const SAMPLE_TRANSACTIONS: readonly CardTransaction[] = [
  {
    id: 'tx-1',
    cardId: 'card-demo-one',
    type: 'PURCHASE',
    amountMinor: 284900,
    currencyCode: 'INR',
    transactionDate: today,
    merchant: 'Fresh Basket',
    categoryId: 'groceries',
    attachmentIds: [],
    createdAt: today,
    updatedAt: today,
  },
  {
    id: 'tx-2',
    cardId: 'card-demo-two',
    type: 'PURCHASE',
    amountMinor: 1249900,
    currencyCode: 'INR',
    transactionDate: monthStart,
    merchant: 'Skyline Hotels',
    categoryId: 'travel',
    attachmentIds: [],
    createdAt: today,
    updatedAt: today,
  },
  {
    id: 'tx-3',
    cardId: 'card-demo-one',
    type: 'PURCHASE',
    amountMinor: 89900,
    currencyCode: 'INR',
    transactionDate: monthStart,
    merchant: 'Streambox',
    categoryId: 'subscription',
    attachmentIds: [],
    createdAt: today,
    updatedAt: today,
  },
  {
    id: 'tx-4',
    cardId: 'card-demo-one',
    type: 'PAYMENT',
    amountMinor: 500000,
    currencyCode: 'INR',
    transactionDate: monthStart,
    merchant: 'Payment received',
    categoryId: 'payment',
    attachmentIds: [],
    createdAt: today,
    updatedAt: today,
  },
];

const TRANSACTION_CACHE_KEY = 'cardnest.transactions.cache.v1';

const PAYMENT_SOURCES: readonly PaymentSource[] = [
  {
    id: 'source-cash',
    nickname: 'Cash',
    kind: 'CASH',
    noLimit: true,
    autoLoad: false,
    archived: false,
  },
  {
    id: 'source-debit',
    nickname: 'Bank / UPI',
    kind: 'DEBIT',
    institution: 'Primary bank',
    noLimit: true,
    autoLoad: false,
    archived: false,
  },
  {
    id: 'source-meal',
    nickname: 'Pluxee meal card',
    kind: 'MEAL',
    institution: 'Pluxee',
    noLimit: false,
    balanceMinor: 0,
    autoLoad: false,
    lastLoadedPeriod: today.slice(0, 7),
    archived: false,
  },
];

@Service()
export class CardNestStore {
  private readonly database = inject(SqliteDatabase);
  private readonly environment = inject(APP_ENVIRONMENT);
  private dataWasCleared = false;
  readonly cards = signal<readonly CreditCard[]>([]);
  readonly transactions = signal<readonly CardTransaction[]>([]);
  readonly paymentGroups = signal<readonly PaymentGroup[]>([]);
  readonly transactionWriteError = signal('');
  readonly categories = signal<readonly Category[]>(CATEGORIES);
  readonly paymentSources = signal<readonly PaymentSource[]>(PAYMENT_SOURCES);
  readonly recurringRules = signal<readonly RecurringRule[]>([]);
  readonly loans = signal<readonly LoanCommitment[]>([]);
  readonly emiPlans = signal<readonly EmiPlan[]>([]);
  readonly emiInstallments = signal<readonly EmiInstallment[]>([]);
  readonly reconciledStatements = signal<readonly CardStatement[]>([]);
  readonly monthlyBudgetMinor = signal(0);
  readonly monthlyIncomeMinor = signal(0);
  readonly budgetCycleStartDay = signal(1);
  readonly incomeHistory = signal<readonly MonthlyIncomeRecord[]>([]);
  readonly profileTitle = signal('');
  readonly profileName = signal('');
  readonly displayCountryCode = signal('IN');
  readonly displayCurrencyCode = signal('INR');
  readonly emiMinimumMinor = signal(250_000);
  readonly spendHighlightThresholdMinor = signal(400_000);
  readonly highlightDashboardSpending = signal(true);
  readonly flashTransactionSourceId = signal(readFlashSourcePreference() ?? '');
  readonly snoozedReminderCardIds = signal<readonly string[]>([]);
  readonly bankCashTracking = signal<BankCashTrackingSettings>({ ...DEFAULT_BANK_CASH_TRACKING });
  readonly transfers = signal<readonly SourceTransfer[]>([]);
  readonly balanceAdjustments = signal<readonly SourceBalanceAdjustment[]>([]);
  readonly liquidFunds = computed(() =>
    liquidTotals(this.paymentSources(), this.bankCashTracking()),
  );
  readonly bankAccounts = computed(() =>
    this.paymentSources().filter((source) => source.kind === 'DEBIT' && !source.archived),
  );
  /** Bank accounts that may fund a card settlement: both toggles on and a confirmed balance. */
  readonly cardSettlementFundingAccounts = computed(() => {
    const settings = this.bankCashTracking();
    return settings.enabled && settings.askCardSettlementFunding
      ? this.bankAccounts().filter((source) => bankCashTracked(source, settings))
      : [];
  });
  readonly profileDisplayName = computed(() => {
    const name = this.profileName().trim();
    return name ? [this.profileTitle(), name].filter(Boolean).join(' ') : '';
  });
  readonly currentIncomePeriod = computed(() =>
    this.incomePeriodFor(new Date(), this.budgetCycleStartDay()),
  );
  readonly currentIncomePeriodLabel = computed(() => {
    const period = this.currentIncomePeriod();
    const start = new Date(`${period.cycleStartDate}T12:00:00`);
    const end = new Date(`${period.cycleEndDate}T12:00:00`);
    return `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  });
  readonly activeCards = computed(() =>
    this.cards().filter((card) => !card.archived && !card.deletedAt),
  );
  readonly alphabeticalActiveCards = computed(() =>
    [...this.activeCards()].sort((left, right) =>
      left.nickname.localeCompare(right.nickname, undefined, { sensitivity: 'base' }),
    ),
  );
  readonly activePaymentSources = computed(() =>
    this.paymentSources().filter((source) => !source.archived),
  );

  readonly dashboard = computed<DashboardSnapshot>(() => {
    const cards = this.activeCards();
    const transactions = this.transactions();
    const outstandingMinor = cards.reduce(
      (sum, card) => sum + Math.max(0, this.cardOutstanding(card.id)),
      0,
    );
    const statementDueMinor = cards.reduce((sum, card) => sum + this.cardDueAmount(card.id), 0);
    const totalCredit = cards.reduce((sum, card) => sum + (card.creditLimitMinor ?? 0), 0);
    const month = today.slice(0, 7);
    const monthlySpendMinor = calculateNetSpending(
      transactions.filter((item) => item.transactionDate.startsWith(month)),
    );
    return {
      outstandingMinor,
      statementDueMinor,
      unbilledMinor: Math.max(0, outstandingMinor - statementDueMinor),
      availableCreditMinor: Math.max(0, totalCredit - outstandingMinor),
      monthlySpendMinor,
      remainingBudgetMinor: Math.max(0, this.monthlyBudgetMinor() - monthlySpendMinor),
      utilisationPercent:
        totalCredit === 0 ? 0 : Math.round((outstandingMinor / totalCredit) * 1000) / 10,
    };
  });

  async initialisePreferences(): Promise<void> {
    if (!this.database.ready()) return;
    await initialiseAppData(this.database, this.environment.seedDemoData, {
      categories: CATEGORIES,
      cards: SAMPLE_CARDS,
      transactions: SAMPLE_TRANSACTIONS,
      income: {
        ...this.currentIncomePeriod(),
        amountMinor: 8000000,
        updatedAt: new Date().toISOString(),
      },
    });
    const durableUi = await this.database.query<{ key: string; encrypted_value: string }>(
      "SELECT key,encrypted_value FROM app_preferences WHERE key IN ('sms_swipe_actions_enabled','show_transaction_time')",
    );
    const swipePreference = durableUi.find((row) => row.key === 'sms_swipe_actions_enabled');
    this.smsSwipeActionsEnabled.set(swipePreference?.encrypted_value === '1');
    this.showTransactionTime.set(
      durableUi.some((row) => row.key === 'show_transaction_time' && row.encrypted_value === '1'),
    );
    const preferences = await this.database.query<{ key: string; encrypted_value: string }>(
      `SELECT key, encrypted_value FROM app_preferences
       WHERE key IN ('budget_cycle_start_day', 'monthly_budget_minor', 'profile_title', 'profile_name', 'default_country_code', 'default_currency_code', 'emi_minimum_minor', 'spend_highlight_threshold_minor', 'highlight_dashboard_spending', 'flash_transaction_source_id', 'snoozed_reminder_card_ids', 'payment_sources', 'data_cleared', '${BANK_CASH_TRACKING_KEY}')`,
    );
    const values = new Map(preferences.map((item) => [item.key, item.encrypted_value]));
    this.dataWasCleared = values.get('data_cleared') === '1';
    const cycleDay = Number(values.get('budget_cycle_start_day'));
    const budget = Number(values.get('monthly_budget_minor'));
    this.budgetCycleStartDay.set(
      Number.isInteger(cycleDay) && cycleDay >= 1 && cycleDay <= 28 ? cycleDay : 1,
    );
    if (Number.isFinite(budget) && budget >= 0) this.monthlyBudgetMinor.set(budget);
    else this.monthlyBudgetMinor.set(0);
    this.profileTitle.set(values.get('profile_title') ?? '');
    this.profileName.set(values.get('profile_name') ?? '');
    const savedCountry = countryOption(values.get('default_country_code') ?? 'IN');
    let countryCode = savedCountry?.countryCode ?? 'IN';
    const savedCurrency = values.get('default_currency_code') ?? '';
    const currencyCode = isSupportedDisplayCurrency(savedCurrency)
      ? savedCurrency
      : (savedCountry?.currencyCode ?? 'INR');
    const matchingCountry = countryOptionForCurrency(currencyCode, countryCode);
    countryCode = matchingCountry?.countryCode ?? countryCode;
    this.displayCountryCode.set(countryCode);
    this.displayCurrencyCode.set(currencyCode);
    configureMoneyDisplay(countryCode, currencyCode);
    if (values.get('default_country_code') !== countryCode) {
      await this.upsertPreference('default_country_code', countryCode);
    }
    if (values.get('default_currency_code') !== currencyCode) {
      await this.upsertPreference('default_currency_code', currencyCode);
    }
    const emiMinimum = Number(values.get('emi_minimum_minor'));
    if (Number.isFinite(emiMinimum) && emiMinimum >= 0) this.emiMinimumMinor.set(emiMinimum);
    const spendThreshold = Number(values.get('spend_highlight_threshold_minor'));
    if (Number.isFinite(spendThreshold) && spendThreshold >= 0)
      this.spendHighlightThresholdMinor.set(spendThreshold);
    const highlightSpending = values.get('highlight_dashboard_spending');
    if (highlightSpending !== undefined)
      this.highlightDashboardSpending.set(highlightSpending !== '0');
    const locallyStoredFlashSource = readFlashSourcePreference();
    const preferredFlashSource =
      locallyStoredFlashSource ?? values.get('flash_transaction_source_id') ?? '';
    this.flashTransactionSourceId.set(preferredFlashSource);
    writeFlashSourcePreference(preferredFlashSource);
    try {
      const snoozed = JSON.parse(values.get('snoozed_reminder_card_ids') ?? '[]') as unknown;
      this.snoozedReminderCardIds.set(
        Array.isArray(snoozed) ? snoozed.filter((id): id is string => typeof id === 'string') : [],
      );
    } catch {
      this.snoozedReminderCardIds.set([]);
    }
    try {
      const sources = JSON.parse(values.get(PAYMENT_SOURCES_PREFERENCE_KEY) ?? '[]') as unknown;
      if (Array.isArray(sources) && values.has(PAYMENT_SOURCES_PREFERENCE_KEY)) {
        this.paymentSources.set(sources as PaymentSource[]);
      } else this.paymentSources.set(PAYMENT_SOURCES);
    } catch {
      this.paymentSources.set(PAYMENT_SOURCES);
    }
    if (!values.has(PAYMENT_SOURCES_PREFERENCE_KEY)) {
      const sources = await this.database.atomic(async (tx) => {
        await tx.run('INSERT OR IGNORE INTO app_preferences(key,encrypted_value) VALUES(?,?)', [
          PAYMENT_SOURCES_PREFERENCE_KEY,
          JSON.stringify(PAYMENT_SOURCES),
        ]);
        return this.readStoredSources(tx);
      });
      this.paymentSources.set(sources);
    }
    if (this.paymentSources().some((source) => source.kind === 'MEAL' && source.autoLoad)) {
      const sources = await this.database.atomic(async (tx) => {
        const stored = await this.readStoredSources(tx);
        const updated = stored.map((source) =>
          source.kind === 'MEAL' ? { ...source, autoLoad: false } : source,
        );
        await this.writeStoredSources(tx, updated);
        return updated;
      });
      this.paymentSources.set(sources);
    }
    await this.loadBankCashTracking(values.get(BANK_CASH_TRACKING_KEY));
    await Promise.all([this.loadCurrentIncome(), this.loadCards()]);
    await this.loadCategories();
    await this.loadCategoryLimits();
    await this.loadTransactions();
    await this.loadTransfers();
    const statementRows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM statements',
    );
    this.reconciledStatements.set(
      statementRows.map((row) => JSON.parse(row.payload) as CardStatement),
    );
    await this.loadRecurringRules();
    this.materializeRecurringTransactions();
    await this.loadEmiPlans();
    await this.loadLoans();
  }

  readonly smsSwipeActionsEnabled = signal(false);
  readonly showTransactionTime = signal(false);
  async setDurableUiPreference(
    key: 'sms_swipe_actions_enabled' | 'show_transaction_time',
    enabled: boolean,
  ): Promise<void> {
    if (!this.database.ready()) throw new Error('SQLite storage is unavailable.');
    await this.upsertPreference(key, enabled ? '1' : '0');
    (key === 'sms_swipe_actions_enabled'
      ? this.smsSwipeActionsEnabled
      : this.showTransactionTime
    ).set(enabled);
  }

  async setMonthlyIncome(amountMinor: number): Promise<void> {
    if (!this.database.ready()) throw new Error('SQLite storage is unavailable.');
    const period = this.currentIncomePeriod();
    const updatedAt = new Date().toISOString();
    await this.database.run(
      `INSERT INTO monthly_income
       (period_key, cycle_start_date, cycle_end_date, amount_minor, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(period_key) DO UPDATE SET
         cycle_start_date = excluded.cycle_start_date,
         cycle_end_date = excluded.cycle_end_date,
         amount_minor = excluded.amount_minor,
         updated_at = excluded.updated_at`,
      [period.periodKey, period.cycleStartDate, period.cycleEndDate, amountMinor, updatedAt],
    );
    this.monthlyIncomeMinor.set(amountMinor);
    await this.refreshIncomeHistory();
  }

  async setDisplayCountry(countryCode: string): Promise<void> {
    const option = countryOption(countryCode);
    if (!option) return;
    this.displayCountryCode.set(option.countryCode);
    this.displayCurrencyCode.set(option.currencyCode);
    configureMoneyDisplay(option.countryCode, option.currencyCode);
    await Promise.all([
      this.upsertPreference('default_country_code', option.countryCode),
      this.upsertPreference('default_currency_code', option.currencyCode),
    ]);
  }

  async setDisplayCurrency(currencyCode: string): Promise<void> {
    if (!isSupportedDisplayCurrency(currencyCode)) return;
    const country = countryOptionForCurrency(currencyCode, this.displayCountryCode());
    if (!country) return;
    this.displayCountryCode.set(country.countryCode);
    this.displayCurrencyCode.set(currencyCode);
    configureMoneyDisplay(country.countryCode, currencyCode);
    await Promise.all([
      this.upsertPreference('default_country_code', country.countryCode),
      this.upsertPreference('default_currency_code', currencyCode),
    ]);
  }

  async setMonthlyBudget(amountMinor: number): Promise<void> {
    this.monthlyBudgetMinor.set(amountMinor);
    await this.upsertPreference('monthly_budget_minor', String(amountMinor));
  }

  async setBudgetCycleStartDay(day: number): Promise<void> {
    const safeDay = Math.min(28, Math.max(1, Math.round(day)));
    const currentIncome = this.monthlyIncomeMinor();
    this.budgetCycleStartDay.set(safeDay);
    await this.upsertPreference('budget_cycle_start_day', String(safeDay));
    const existing = await this.findIncome(this.currentIncomePeriod().periodKey);
    if (existing) {
      this.monthlyIncomeMinor.set(existing.amountMinor);
      await this.refreshIncomeHistory();
      return;
    }
    await this.setMonthlyIncome(currentIncome);
  }

  async setProfileTitle(title: string): Promise<void> {
    this.profileTitle.set(title);
    await this.upsertPreference('profile_title', title);
  }

  async setProfileName(name: string): Promise<void> {
    const cleanName = name.trim().slice(0, 60);
    this.profileName.set(cleanName);
    await this.upsertPreference('profile_name', cleanName);
  }

  async setEmiMinimum(amountMinor: number): Promise<void> {
    this.emiMinimumMinor.set(amountMinor);
    await this.upsertPreference('emi_minimum_minor', String(amountMinor));
  }

  async setSpendHighlightThreshold(amountMinor: number): Promise<void> {
    this.spendHighlightThresholdMinor.set(amountMinor);
    await this.upsertPreference('spend_highlight_threshold_minor', String(amountMinor));
  }

  async setHighlightDashboardSpending(enabled: boolean): Promise<void> {
    this.highlightDashboardSpending.set(enabled);
    await this.upsertPreference('highlight_dashboard_spending', enabled ? '1' : '0');
  }

  async setFlashTransactionSource(id: string): Promise<void> {
    writeFlashSourcePreference(id);
    this.flashTransactionSourceId.set(id);
    if (!this.database.ready()) return;
    try {
      await this.upsertPreference('flash_transaction_source_id', id);
    } catch {
      // This small device preference remains durable in local storage even if SQLite is busy.
    }
  }

  async setReminderSnoozed(cardId: string, snoozed: boolean): Promise<void> {
    const current = this.snoozedReminderCardIds();
    const updated = snoozed
      ? [...new Set([...current, cardId])]
      : current.filter((id) => id !== cardId);
    this.snoozedReminderCardIds.set(updated);
    await this.upsertPreference('snoozed_reminder_card_ids', JSON.stringify(updated));
  }

  cardOutstanding(cardId: string): number {
    const card = this.cards().find((item) => item.id === cardId);
    const currentMonth = new Date().toISOString().slice(0, 7);
    return card
      ? calculateOutstanding(
          card.openingBalanceMinor,
          this.transactions().filter(
            (item) =>
              item.cardId === cardId &&
              !item.emiCancelled &&
              item.transactionDate.slice(0, 7) <= currentMonth,
          ),
        )
      : 0;
  }

  cardDueAmount(cardId: string, reference = new Date()): number {
    const card = this.cards().find((item) => item.id === cardId);
    if (!card) return 0;
    const nextStatement = statementDateFor(reference, card.statementDay);
    const latestStatement =
      nextStatement.getTime() > reference.getTime()
        ? previousStatementDate(nextStatement, card.statementDay)
        : nextStatement;
    const statementIso = toIsoDate(latestStatement);
    if (
      this.reconciledStatements().some(
        (statement) =>
          statement.cardId === cardId &&
          statement.statementDate === statementIso &&
          statement.status === 'FULLY_PAID' &&
          this.transactions().some(
            (t) =>
              t.id === statement.reconciledPaymentId &&
              t.type === 'PAYMENT' &&
              t.cardId === cardId &&
              t.amountMinor === statement.reconciledPaymentAmountMinor,
          ),
      )
    )
      return 0;
    const excludesStatementDay = excludesStatementDayTransactions(card);
    const dueAtStatement = this.transactions()
      .filter(
        (item) =>
          item.cardId === cardId &&
          !item.emiCancelled &&
          isTransactionIncludedInStatement(item.transactionDate, latestStatement, card),
      )
      .reduce((total, item) => total + transactionEffect(item), card.openingBalanceMinor);
    const creditsAfterStatement = this.transactions()
      .filter(
        (item) =>
          item.cardId === cardId &&
          !item.emiCancelled &&
          (excludesStatementDay
            ? item.transactionDate >= statementIso
            : item.transactionDate > statementIso) &&
          transactionEffect(item) < 0,
      )
      .reduce((total, item) => total + transactionEffect(item), 0);
    return Math.max(0, dueAtStatement + creditsAfterStatement);
  }

  private latestStatementFor(card: CreditCard, reference: Date): Date {
    const nextStatement = statementDateFor(reference, card.statementDay);
    return nextStatement.getTime() > reference.getTime()
      ? previousStatementDate(nextStatement, card.statementDay)
      : nextStatement;
  }

  /** The balance carried into the latest statement, i.e. everything billed before this cycle. */
  cardCarriedForwardMinor(cardId: string, reference = new Date()): number {
    const card = this.cards().find((item) => item.id === cardId);
    if (!card) return 0;
    const previousStatement = previousStatementDate(
      this.latestStatementFor(card, reference),
      card.statementDay,
    );
    return this.transactions()
      .filter(
        (item) =>
          item.cardId === cardId &&
          !item.emiCancelled &&
          isTransactionIncludedInStatement(item.transactionDate, previousStatement, card),
      )
      .reduce((total, item) => total + transactionEffect(item), card.openingBalanceMinor);
  }

  cardOutstandingTransactions(cardId: string, reference = new Date()): readonly CardTransaction[] {
    const card = this.cards().find((item) => item.id === cardId);
    if (!card) return [];
    const previousStatement = previousStatementDate(
      this.latestStatementFor(card, reference),
      card.statementDay,
    );
    const currentMonth = new Date().toISOString().slice(0, 7);
    return this.transactions().filter(
      (item) =>
        item.cardId === cardId &&
        !item.emiCancelled &&
        item.transactionDate.slice(0, 7) <= currentMonth &&
        !isTransactionIncludedInStatement(item.transactionDate, previousStatement, card),
    );
  }

  cardStatementTransactions(cardId: string, reference = new Date()): readonly CardTransaction[] {
    const card = this.cards().find((item) => item.id === cardId);
    if (!card) return [];
    const latestStatement = this.latestStatementFor(card, reference);
    const previousStatement = previousStatementDate(latestStatement, card.statementDay);
    const statementIso = toIsoDate(latestStatement);
    const excludesStatementDay = excludesStatementDayTransactions(card);
    return this.transactions().filter(
      (item) =>
        item.cardId === cardId &&
        !item.emiCancelled &&
        // Transactions billed in the latest statement cycle only.
        ((isTransactionIncludedInStatement(item.transactionDate, latestStatement, card) &&
          !isTransactionIncludedInStatement(item.transactionDate, previousStatement, card)) ||
          // Payments and refunds made after the statement that reduce this due.
          ((excludesStatementDay
            ? item.transactionDate >= statementIso
            : item.transactionDate > statementIso) &&
            transactionEffect(item) < 0)),
    );
  }

  cardUnbilledTransactions(cardId: string, reference = new Date()): readonly CardTransaction[] {
    const card = this.cards().find((item) => item.id === cardId);
    if (!card) return [];
    const latestStatement = this.latestStatementFor(card, reference);
    const statementIso = toIsoDate(latestStatement);
    const excludesStatementDay = excludesStatementDayTransactions(card);
    const currentMonth = new Date().toISOString().slice(0, 7);
    return this.transactions().filter(
      (item) =>
        item.cardId === cardId &&
        !item.emiCancelled &&
        item.transactionDate.slice(0, 7) <= currentMonth &&
        !isTransactionIncludedInStatement(item.transactionDate, latestStatement, card) &&
        !(
          (excludesStatementDay
            ? item.transactionDate >= statementIso
            : item.transactionDate > statementIso) && transactionEffect(item) < 0
        ),
    );
  }

  addCard(card: CreditCard): void {
    this.cards.update((cards) => [...cards, card]);
    void this.persistCard(card);
  }
  updateCard(updated: CreditCard): void {
    this.cards.update((cards) => cards.map((card) => (card.id === updated.id ? updated : card)));
    void this.persistCard(updated);
  }
  async refreshPaymentGroups(): Promise<void> {
    if (this.database.ready()) this.paymentGroups.set(await readPaymentGroups(this.database));
  }
  async refreshPaymentLedger(): Promise<void> {
    await this.loadTransactions();
  }

  async combinePayments(
    ids: readonly string[],
    targetId = ids[0],
    edits: PaymentGroupEdits = {},
  ): Promise<string> {
    if (!this.database.ready()) throw new Error('Database is not ready.');
    const id = await this.database.atomic((tx) => attachPaymentGroup(tx, ids, targetId, edits));
    await this.loadTransactions();
    return id;
  }

  async removePaymentMember(id: string, dissolve = false): Promise<void> {
    await this.database.atomic((tx) => detachPaymentGroup(tx, id, dissolve));
    await this.loadTransactions();
  }

  async updatePaymentGroup(id: string, edits: PaymentGroupEdits): Promise<void> {
    await this.database.atomic(async (tx) => {
      const group = (await readPaymentGroups(tx)).find((row) => row.id === id);
      if (!group) throw new Error('Payment group no longer exists.');
      const bill = edits.billTotalMinor === undefined ? group.billTotalMinor : edits.billTotalMinor;
      if (bill !== null && (!Number.isSafeInteger(bill) || bill < 0))
        throw new Error('Enter a valid bill total.');
      await tx.run(
        'UPDATE transaction_split_groups SET title=?,bill_total_minor=?,updated_at=? WHERE id=?',
        [(edits.title ?? group.title).trim().slice(0, 150), bill, new Date().toISOString(), id],
      );
    });
    await this.loadTransactions();
  }

  /** Manual saves publish only after all ledger, grouping and balance writes commit. */
  async saveManualTransaction(
    transaction: CardTransaction,
    targetId = '',
    unlinkConfirmed = false,
  ): Promise<void> {
    if (!this.database.ready()) throw new Error('Database is not ready.');
    const result = await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ payload: string }>(
        'SELECT payload FROM card_transactions WHERE id=?',
        [transaction.id],
      );
      const previous = row ? (JSON.parse(row.payload) as CardTransaction) : null;
      if (
        !Number.isSafeInteger(transaction.amountMinor) ||
        transaction.amountMinor <= 0 ||
        !validTransferDate(transaction.transactionDate)
      )
        throw new Error('Enter a valid amount and transaction date.');
      const sources = await this.readStoredSources(tx);
      const card = this.cards().find((item) => item.id === transaction.cardId && !item.deletedAt);
      if (!card && !sources.some((item) => item.id === transaction.cardId))
        throw new Error('Choose an existing payment source.');
      if (transaction.currencyCode !== (card?.currencyCode ?? 'INR'))
        throw new Error('The payment currency differs from the source.');
      if (targetId === transaction.id) throw new Error('A payment cannot link to itself.');
      const next = { ...transaction };
      if (previous?.sourceBalanceApplied === false && previous.cardId !== next.cardId)
        next.sourceBalanceApplied = true;
      const previousGroup = (await readPaymentGroups(tx)).find((group) =>
        group.memberIds.includes(next.id),
      );
      if (previousGroup) next.splitGroupId = previousGroup.id;
      if (
        previousGroup &&
        eligiblePaymentMember(next) &&
        previousGroup.currency !== next.currencyCode
      )
        throw new Error('Unlink this payment before changing its currency.');
      if (next.type === 'ADJUSTMENT') {
        if (targetId) {
          if (previous?.adjustmentPurpose === 'BALANCE_RECONCILIATION')
            throw new Error(
              'A verified balance correction is not a merchant payment. Record the real payment separately.',
            );
          if (next.adjustmentDirection === 'DECREASE')
            throw new Error(
              'A decreasing legacy adjustment cannot be a new positive Split payment.',
            );
          next.adjustmentPurpose = 'SPLIT_PAYMENT';
          next.adjustmentDirection = 'INCREASE';
          const group = (await readPaymentGroups(tx)).find(
            (item) => item.id === targetId || item.memberIds.includes(targetId),
          );
          const anchorId = group?.anchorId ?? targetId;
          if (anchorId === next.id && !previousGroup)
            throw new Error('A payment cannot link to itself.');
          next.relatedTransactionId = anchorId === next.id ? undefined : (anchorId ?? undefined);
        } else if (
          !previous ||
          previous.type !== 'ADJUSTMENT' ||
          (previous.adjustmentPurpose === 'SPLIT_PAYMENT' && !!previous.splitGroupId)
        )
          throw new Error('Choose the related purchase or payment group for this Split payment.');
        else {
          next.adjustmentPurpose = previous.adjustmentPurpose ?? 'LEGACY_MANUAL';
          if (
            next.relatedTransactionId &&
            !(
              await tx.query('SELECT id FROM card_transactions WHERE id=?', [
                next.relatedTransactionId,
              ])
            ).length
          )
            next.relatedTransactionId = undefined;
        }
      } else {
        next.adjustmentPurpose = undefined;
        next.adjustmentDirection = undefined;
        if (next.type !== 'REFUND') next.relatedTransactionId = undefined;
      }
      if (
        previous &&
        previousGroup &&
        (!eligiblePaymentMember(next) || (previous.type !== next.type && !targetId))
      ) {
        if (!unlinkConfirmed)
          throw new Error('Confirm removing this payment from its group before changing its type.');
        await detachPaymentGroup(tx, next.id);
        next.splitGroupId = undefined;
      }
      const saved = await this.writeTransaction(tx, next);
      if (previous && previous.type !== next.type) {
        const note = `MANUAL_TYPE_CHANGE:${previous.type}->${next.type}`;
        await tx.run(
          "UPDATE sms_candidates SET decision='EXPLICIT_TYPE_CHANGE: '||COALESCE(decision,'')||'; '||? WHERE transaction_id=? AND state IN ('IMPORTED','MATCHED_EXISTING')",
          [note, next.id],
        );
        await tx.run("UPDATE sms_reconciliation SET decision=decision||'; '||? WHERE target_id=?", [
          note,
          next.id,
        ]);
      }
      if (targetId && next.type === 'ADJUSTMENT') await attachPaymentGroup(tx, [next.id], targetId);
      return saved;
    });
    this.publishStoredBalances(result.wallets);
    await this.loadTransactions();
    if (result.fundingChanged) await this.loadTransfers();
  }

  async deleteRecordedTransaction(id: string): Promise<void> {
    await this.removePersistedTransaction(id);
    await this.loadTransactions();
  }

  addTransaction(transaction: CardTransaction): void {
    this.transactions.update((items) => {
      const updated = [transaction, ...items];
      this.cacheTransactions(updated);
      return updated;
    });
    this.adjustPaymentSourceBalance(transaction, 1);
    void this.persistTransaction(transaction);
  }

  /** SMS import calls this only after the ledger, binding and balances commit together. */
  acceptCommittedImport(
    transaction: CardTransaction | null,
    sources: readonly PaymentSource[],
  ): void {
    if (transaction)
      this.transactions.update((items) => {
        const next = [transaction, ...items.filter((item) => item.id !== transaction.id)];
        this.cacheTransactions(next);
        return next;
      });
    this.paymentSources.set(sources);
  }

  acceptCommittedStatement(statement: CardStatement): void {
    this.reconciledStatements.update((items) => [
      statement,
      ...items.filter((item) => item.id !== statement.id),
    ]);
  }

  async addWallet(source: PaymentSource): Promise<void> {
    if (source.kind !== 'FASTAG' && source.kind !== 'MEAL')
      throw new Error('Choose a wallet kind.');
    if (!source.nickname.trim() || this.paymentSources().some((item) => item.id === source.id))
      throw new Error('Invalid wallet.');
    const sources = await this.database.atomic(async (tx) => {
      const stored = await this.readStoredSources(tx);
      if (stored.some((item) => item.id === source.id)) throw new Error('Wallet already exists.');
      const next = [...(stored.length ? stored : this.paymentSources()), source];
      await this.writeStoredSources(tx, next);
      return next;
    });
    this.paymentSources.set(sources);
  }
  updateTransaction(updated: CardTransaction): boolean {
    const existing = this.transactions().find((transaction) => transaction.id === updated.id);
    if (!existing) return false;
    if (existing.sourceBalanceApplied === false && updated.cardId !== existing.cardId)
      updated = { ...updated, sourceBalanceApplied: true };
    if (existing.splitGroupId) {
      void this.saveManualTransaction(
        updated,
        updated.type === 'ADJUSTMENT' && updated.adjustmentPurpose === 'SPLIT_PAYMENT'
          ? (updated.relatedTransactionId ?? '')
          : '',
      ).catch((error: unknown) =>
        this.transactionWriteError.set(
          error instanceof Error ? error.message : 'Unable to save grouped payment.',
        ),
      );
      return true;
    }
    this.adjustPaymentSourceBalance(existing, -1);
    this.transactions.update((items) => {
      const next = items.map((transaction) =>
        transaction.id === updated.id ? updated : transaction,
      );
      this.cacheTransactions(next);
      return next;
    });
    this.adjustPaymentSourceBalance(updated, 1);
    void this.persistTransaction(updated);
    return true;
  }
  deleteTransaction(transactionId: string): boolean {
    const existing = this.transactions().find((transaction) => transaction.id === transactionId);
    if (!existing) return false;
    if (existing.splitGroupId) {
      void this.deleteRecordedTransaction(transactionId).catch((error: unknown) =>
        this.transactionWriteError.set(
          error instanceof Error ? error.message : 'Unable to delete grouped payment.',
        ),
      );
      return true;
    }
    this.adjustPaymentSourceBalance(existing, -1);
    this.transactions.update((items) => {
      const next = items.filter((transaction) => transaction.id !== transactionId);
      this.cacheTransactions(next);
      return next;
    });
    if (this.database.ready()) {
      void this.removePersistedTransaction(transactionId);
    }
    return true;
  }
  duplicateTransaction(transactionId: string): CardTransaction | null {
    const existing = this.transactions().find((transaction) => transaction.id === transactionId);
    if (!existing) return null;
    const timestamp = new Date().toISOString();
    const duplicate: CardTransaction = {
      ...existing,
      id: crypto.randomUUID(),
      recurringRuleId: undefined,
      generatedOccurrenceDate: undefined,
      emiPlanId: undefined,
      emiInstallmentNumber: undefined,
      emiTenureMonths: undefined,
      emiOriginalAmountMinor: undefined,
      emiCancelled: undefined,
      relatedTransactionId: undefined,
      splitGroupId: undefined,
      splitOriginalAmountMinor: undefined,
      transactionDate: indiaTodayIso(),
      sourceBalanceApplied: this.paymentSources().some(
        (source) => source.id === existing.cardId && source.kind === 'MEAL',
      )
        ? true
        : existing.sourceBalanceApplied,
      balanceTiming: undefined,
      balanceTimingAt: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.addTransaction(duplicate);
    return duplicate;
  }
  saveEmiPlan(plan: EmiPlan, installments: readonly EmiInstallment[]): void {
    // A rescheduled plan replaces, rather than duplicates, its future generated transactions.
    for (const existing of this.transactions().filter(
      (item) => item.emiPlanId === plan.id && item.id !== plan.transactionId,
    )) {
      this.deleteTransaction(existing.id);
    }
    this.emiPlans.update((plans) => [plan, ...plans.filter((item) => item.id !== plan.id)]);
    const storedInstallments = installments.map((installment) => ({
      ...installment,
      id: installment.id ?? crypto.randomUUID(),
      emiPlanId: plan.id,
    }));
    this.emiInstallments.update((items) => [
      ...items.filter((item) => item.emiPlanId !== plan.id),
      ...storedInstallments,
    ]);
    const transaction = this.transactions().find((item) => item.id === plan.transactionId);
    if (transaction && storedInstallments.length) {
      const merchant = transaction.merchant?.replace(/ · EMI \d+\/\d+$/, '') || 'Purchase';
      const [firstInstallment, ...futureInstallments] = storedInstallments;
      this.updateTransaction({
        ...transaction,
        amountMinor: firstInstallment.totalMinor,
        transactionDate: firstInstallment.statementDate,
        merchant: `${merchant} · EMI 1/${plan.tenureMonths}`,
        emiPlanId: plan.id,
        emiInstallmentNumber: 1,
        emiTenureMonths: plan.tenureMonths,
        emiOriginalAmountMinor: plan.convertedAmountMinor,
        updatedAt: new Date().toISOString(),
      });
      for (const installment of futureInstallments) {
        const timestamp = new Date().toISOString();
        this.addTransaction({
          ...transaction,
          id: crypto.randomUUID(),
          amountMinor: installment.totalMinor,
          transactionDate: installment.statementDate,
          merchant: `${merchant} · EMI ${installment.installmentNumber}/${plan.tenureMonths}`,
          taxIncluded: false,
          taxMinor: undefined,
          relatedTransactionId: undefined,
          attachmentIds: [],
          recurringRuleId: undefined,
          generatedOccurrenceDate: undefined,
          emiPlanId: plan.id,
          emiInstallmentNumber: installment.installmentNumber,
          emiTenureMonths: plan.tenureMonths,
          emiOriginalAmountMinor: undefined,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }
    if (this.database.ready()) void this.persistEmiPlan(plan, storedInstallments);
  }

  closeEmiPlan(planId: string): void {
    const plan = this.emiPlans().find((item) => item.id === planId);
    if (!plan || plan.status !== 'ACTIVE') return;
    const closedAt = new Date().toISOString();
    const currentMonth = closedAt.slice(0, 7);
    const updatedPlan: EmiPlan = { ...plan, status: 'CANCELLED', closedAt };
    this.emiPlans.update((plans) => plans.map((item) => (item.id === planId ? updatedPlan : item)));
    for (const transaction of this.transactions().filter(
      (item) => item.emiPlanId === planId && item.transactionDate.slice(0, 7) > currentMonth,
    )) {
      this.updateTransaction({ ...transaction, emiCancelled: true, updatedAt: closedAt });
    }
    if (this.database.ready()) {
      void this.persistEmiPlan(
        updatedPlan,
        this.emiInstallments().filter((item) => item.emiPlanId === planId),
      );
    }
  }

  async splitTransaction(
    transactionId: string,
    parts: readonly { sourceId: string; amountMinor: number; balanceTiming?: BalanceTiming }[],
  ): Promise<readonly CardTransaction[]> {
    const result = await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ payload: string }>(
        'SELECT payload FROM card_transactions WHERE id=?',
        [transactionId],
      );
      const original = row ? (JSON.parse(row.payload) as CardTransaction) : null;
      if (
        !original ||
        !eligiblePaymentMember(original) ||
        original.emiPlanId ||
        original.recurringRuleId ||
        (await readPaymentGroups(tx)).some((group) => group.memberIds.includes(transactionId))
      )
        throw new Error(
          'Only an ungrouped positive purchase payment without EMI or recurrence can be divided.',
        );
      if (
        parts.length < 2 ||
        parts.some((part) => !Number.isSafeInteger(part.amountMinor) || part.amountMinor <= 0) ||
        parts.reduce((sum, part) => sum + part.amountMinor, 0) !== original.amountMinor
      )
        throw new Error('Payment parts must be positive and total the original amount.');
      const sources = await this.readStoredSources(tx);
      const timestamp = new Date().toISOString();
      const entries: CardTransaction[] = [];
      for (const [index, part] of parts.entries()) {
        const card = this.cards().find((item) => item.id === part.sourceId && !item.deletedAt);
        if (!card && !sources.some((item) => item.id === part.sourceId))
          throw new Error('Choose an existing payment source.');
        if ((card?.currencyCode ?? 'INR') !== original.currencyCode)
          throw new Error('Payment currencies must match.');
        const entry: CardTransaction = {
          ...original,
          id: index === 0 ? original.id : crypto.randomUUID(),
          cardId: part.sourceId,
          amountMinor: part.amountMinor,
          splitOriginalAmountMinor: original.amountMinor,
          balanceTiming: part.balanceTiming ?? (index === 0 ? original.balanceTiming : undefined),
          balanceTimingAt: part.balanceTiming
            ? timestamp
            : index === 0
              ? original.balanceTimingAt
              : undefined,
          ...(index === 0
            ? {}
            : {
                origin: 'MANUAL' as const,
                reference: undefined,
                attachmentIds: [],
                notes: undefined,
                transactionTime: undefined,
                relatedTransactionId: undefined,
                balanceEffect: undefined,
                sourceBalanceApplied: undefined,
                bankName: undefined,
                accountSuffix: undefined,
                paymentMethod: undefined,
                paymentMethodDetail: undefined,
                paymentMethodCustom: undefined,
                smsAdditionalComment: undefined,
              }),
          createdAt: index === 0 ? original.createdAt : timestamp,
          updatedAt: timestamp,
        };
        if (
          index === 0 &&
          original.sourceBalanceApplied === false &&
          original.cardId !== entry.cardId
        )
          entry.sourceBalanceApplied = true;
        const saved = await this.writeTransaction(tx, entry);
        entries.push(saved.persisted);
      }
      const groupId = crypto.randomUUID();
      await tx.run(
        `INSERT INTO transaction_split_groups(id,original_amount_minor,created_at,kind,anchor_transaction_id,title,currency_code,bill_total_minor,updated_at) VALUES(?,?,?,'DIVISION',?,?,?,?,?)`,
        [
          groupId,
          original.amountMinor,
          timestamp,
          original.id,
          original.merchant ?? '',
          original.currencyCode,
          original.amountMinor,
          timestamp,
        ],
      );
      for (const entry of entries) {
        await tx.run('INSERT INTO transaction_split_members(group_id,transaction_id) VALUES(?,?)', [
          groupId,
          entry.id,
        ]);
        await tx.run('UPDATE card_transactions SET payload=? WHERE id=?', [
          JSON.stringify({ ...entry, splitGroupId: groupId }),
          entry.id,
        ]);
      }
      const note = `EXPLICIT_DIVISION:${groupId}`;
      await tx.run(
        "UPDATE sms_candidates SET decision=?||'; '||COALESCE(decision,'') WHERE transaction_id=? AND state IN ('IMPORTED','MATCHED_EXISTING')",
        [note, original.id],
      );
      await tx.run("UPDATE sms_reconciliation SET decision=decision||'; '||? WHERE target_id=?", [
        note,
        original.id,
      ]);
      return entries.map((entry) => ({ ...entry, splitGroupId: groupId }));
    });
    await this.loadTransactions();
    this.publishStoredBalances(await this.readStoredSources(this.database));
    return result;
  }
  addRecurringRule(rule: RecurringRule): void {
    this.recurringRules.update((rules) => [...rules, rule]);
    void this.persistRecurringRule(rule);
    this.materializeRecurringTransactions();
  }
  updateRecurringRule(ruleId: string, amountMinor: number): void {
    if (amountMinor <= 0) return;
    this.recurringRules.update((rules) =>
      rules.map((rule) => (rule.id === ruleId ? { ...rule, amountMinor } : rule)),
    );
    const updated = this.recurringRules().find((rule) => rule.id === ruleId);
    if (updated) void this.persistRecurringRule(updated);
  }
  terminateRecurringRule(ruleId: string): void {
    this.recurringRules.update((rules) =>
      rules.map((rule) =>
        rule.id === ruleId ? { ...rule, status: 'COMPLETED', nextOccurrenceDate: undefined } : rule,
      ),
    );
    const updated = this.recurringRules().find((rule) => rule.id === ruleId);
    if (updated) void this.persistRecurringRule(updated);
  }
  updatePaymentSource(updated: PaymentSource): void {
    const previous = this.paymentSources().find((source) => source.id === updated.id);
    if (previous?.balanceMinor !== updated.balanceMinor)
      updated = {
        ...updated,
        balanceCutoverAt: new Date().toISOString(),
        balanceSnapshotMinor: updated.balanceMinor,
        ...(updated.kind === 'MEAL' ? { balanceCutoverReason: 'MANUAL' as const } : {}),
      };
    this.paymentSources.update((sources) =>
      sources.map((source) => (source.id === updated.id ? updated : source)),
    );
    if (!this.database.ready()) return;
    const changed = Object.keys(updated).filter(
      (key) => updated[key as keyof PaymentSource] !== previous?.[key as keyof PaymentSource],
    );
    void this.database
      .atomic(async (tx) => {
        const sources = await this.readStoredSources(tx);
        const next = sources.map((source) =>
          source.id === updated.id
            ? (Object.fromEntries([
                ...Object.entries(source),
                ...changed.map((key) => [key, updated[key as keyof PaymentSource]]),
              ]) as unknown as PaymentSource)
            : source,
        );
        await this.writeStoredSources(tx, next);
        return next;
      })
      .then((sources) => this.paymentSources.set(sources));
  }
  addLoan(loan: LoanCommitment): void {
    this.loans.update((loans) => [loan, ...loans]);
    void this.persistLoan(loan);
  }
  updateLoan(updated: LoanCommitment): void {
    this.loans.update((loans) => loans.map((loan) => (loan.id === updated.id ? updated : loan)));
    void this.persistLoan(updated);
  }
  cancelLoan(loanId: string): void {
    this.loans.update((loans) =>
      loans.map((loan) => (loan.id === loanId ? { ...loan, status: 'CANCELLED' } : loan)),
    );
    const loan = this.loans().find((item) => item.id === loanId);
    if (loan) void this.persistLoan(loan);
  }
  deleteCard(cardId: string): void {
    const card = this.cards().find((item) => item.id === cardId);
    if (!card) return;
    this.updateCard({
      ...card,
      archived: true,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  recordPayment(cardId: string, amountMinor: number, label = 'Card payment'): void {
    if (amountMinor <= 0) return;
    const timestamp = new Date().toISOString();
    this.addTransaction({
      id: crypto.randomUUID(),
      cardId,
      type: 'PAYMENT',
      amountMinor,
      currencyCode: 'INR',
      transactionDate: timestamp.slice(0, 10),
      merchant: label,
      categoryId: 'payment',
      attachmentIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  /** One atomic card payment plus its explicit bank deduction; never a second purchase. */
  async recordFundedPayment(
    cardId: string,
    amountMinor: number,
    label: string,
    fundingSourceId: string,
  ): Promise<void> {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
      throw new Error('Enter a valid payment amount.');
    if (!this.cards().some((card) => card.id === cardId && !card.deletedAt))
      throw new Error('Choose an existing credit card.');
    const timestamp = new Date().toISOString();
    // Recorded now, so the payment is after any balance confirmed earlier.
    const recordedAt = new Date(timestamp);
    const payment: CardTransaction = {
      id: crypto.randomUUID(),
      cardId,
      type: 'PAYMENT',
      amountMinor,
      currencyCode: 'INR',
      transactionDate: indiaTodayIso(recordedAt),
      transactionTime: indiaTimeOfDay(recordedAt),
      merchant: label,
      categoryId: 'payment',
      attachmentIds: [],
      origin: 'MANUAL',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const result = await this.database.atomic(async (tx) => {
      const settings = await this.readTrackingSettings(tx);
      if (!settings.enabled || !settings.askCardSettlementFunding)
        throw new Error('Turn on bank deduction for card payments in Settings first.');
      const sources = await this.readStoredSources(tx);
      const funding = sources.find((source) => source.id === fundingSourceId);
      if (!funding || funding.kind !== 'DEBIT' || !bankCashTracked(funding, settings))
        throw new Error('Choose a tracked bank account with a confirmed balance.');
      await this.upsertTransactionRow(tx, payment);
      const transfer = applyTransferEffects(
        sources,
        null,
        {
          id: crypto.randomUUID(),
          kind: 'CARD_SETTLEMENT',
          fromSourceId: funding.id,
          cardId,
          paymentTransactionId: payment.id,
          amountMinor,
          currencyCode: 'INR',
          transferDate: payment.transactionDate,
          transferTime: payment.transactionTime,
          balanceTiming: 'AFTER_BASELINE',
          description: label,
          origin: 'MANUAL',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        settings,
        timestamp,
      );
      await this.writeTransferRow(tx, transfer);
      await this.writeStoredSources(tx, sources);
      return { transfer, sources };
    });
    this.transactions.update((items) => {
      const next = [payment, ...items];
      this.cacheTransactions(next);
      return next;
    });
    this.acceptCommittedTransfer(result.transfer, result.sources);
  }

  fundingFor(paymentTransactionId: string): SourceTransfer | undefined {
    return this.transfers().find((item) => item.paymentTransactionId === paymentTransactionId);
  }

  /**
   * Durable Add Cash / Record incoming money: the ledger row and balance commit together and
   * the UI is updated only afterwards. Saving the same id twice is rejected.
   */
  async recordSourceReceipt(input: {
    id: string;
    sourceId: string;
    amountMinor: number;
    transactionDate: string;
    transactionTime?: string;
    merchant: string;
    categoryId: string;
    balanceTiming?: BalanceTiming;
  }): Promise<CardTransaction> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('Enter a valid amount.');
    if (!validTransferDate(input.transactionDate, input.transactionTime))
      throw new Error('Enter a valid date and time.');
    const timestamp = new Date().toISOString();
    const result = await this.database.atomic(async (tx) => {
      const [existing] = await tx.query<{ id: string }>(
        'SELECT id FROM card_transactions WHERE id=?',
        [input.id],
      );
      if (existing) throw new Error('This entry was already saved.');
      const sources = await this.readStoredSources(tx);
      const settings = await this.readTrackingSettings(tx);
      const source = sources.find((item) => item.id === input.sourceId && !item.archived);
      if (!source || !isBankOrCash(source)) throw new Error('Choose a bank account or cash.');
      const [category] = await tx.query<{ applies_to: string }>(
        'SELECT applies_to FROM categories WHERE id=? AND archived=0',
        [input.categoryId],
      );
      if (!category || category.applies_to === 'EXPENSE')
        throw new Error('Choose a category that allows incoming money.');
      if (
        !input.balanceTiming &&
        needsBaselineConfirmation(source, settings, input.transactionDate, input.transactionTime)
      )
        throw new Error(TIMING_QUESTION);
      const transaction = applyBankCashTransaction(
        sources,
        null,
        {
          id: input.id,
          cardId: source.id,
          type: 'CREDIT',
          amountMinor: input.amountMinor,
          currencyCode: 'INR',
          transactionDate: input.transactionDate,
          transactionTime: input.transactionTime || undefined,
          merchant: input.merchant.trim().slice(0, 100) || undefined,
          categoryId: input.categoryId,
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
      await this.upsertTransactionRow(tx, transaction);
      await this.writeStoredSources(tx, sources);
      return { transaction, sources };
    });
    this.transactions.update((items) => {
      const next = [result.transaction, ...items.filter((item) => item.id !== input.id)];
      this.cacheTransactions(next);
      return next;
    });
    this.paymentSources.set(result.sources);
    return result.transaction;
  }

  /** SMS review and store writes publish only after the transfer and balances commit. */
  acceptCommittedTransfer(
    transfer: SourceTransfer | null,
    sources: readonly PaymentSource[],
  ): void {
    if (transfer)
      this.transfers.update((items) => [
        transfer,
        ...items.filter((item) => item.id !== transfer.id),
      ]);
    this.paymentSources.set(sources);
  }

  async enableBankCashTracking(balances: Readonly<Record<string, number | null>>): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.database.atomic(async (tx) => {
      const stored = await this.readStoredSources(tx);
      const sources = stored.length ? stored : this.paymentSources().map((item) => ({ ...item }));
      const previous = await this.readTrackingSettings(tx);
      const adjustments: SourceBalanceAdjustment[] = [];
      for (const source of sources.filter(isBankOrCash)) {
        const value = balances[source.id];
        // Unconfirmed balances stay unknown; the previous value is kept for reference only.
        if (value === null || value === undefined) {
          source.balanceCutoverAt = undefined;
          continue;
        }
        this.assertBalanceValue(source, value);
        const adjustment: SourceBalanceAdjustment = {
          id: crypto.randomUUID(),
          sourceId: source.id,
          reason: previous.activatedAt ? 'REBASE' : 'OPENING',
          previousMinor: source.balanceMinor,
          newMinor: value,
          correctionMinor: value - (source.balanceMinor ?? 0),
          createdAt: now,
        };
        await this.insertBalanceAdjustment(tx, adjustment);
        adjustments.push(adjustment);
        source.balanceMinor = value;
        source.balanceSnapshotMinor = value;
        source.balanceCutoverAt = now;
      }
      const settings: BankCashTrackingSettings = {
        enabled: true,
        askCardSettlementFunding: previous.askCardSettlementFunding,
        activatedAt: now,
      };
      await this.writeTrackingSettings(tx, settings);
      await this.writeStoredSources(tx, sources);
      return { sources, settings, adjustments };
    });
    this.paymentSources.set(result.sources);
    this.bankCashTracking.set(result.settings);
    this.balanceAdjustments.update((items) => [...result.adjustments, ...items]);
  }

  /** Keeps balances, baselines and history; re-enabling requires a fresh balance confirmation. */
  async disableBankCashTracking(): Promise<void> {
    const settings = await this.database.atomic(async (tx) => {
      const previous = await this.readTrackingSettings(tx);
      const next: BankCashTrackingSettings = {
        ...previous,
        enabled: false,
        disabledAt: new Date().toISOString(),
      };
      await this.writeTrackingSettings(tx, next);
      return next;
    });
    this.bankCashTracking.set(settings);
  }

  async setCardSettlementFunding(enabled: boolean): Promise<void> {
    const settings = await this.database.atomic(async (tx) => {
      const previous = await this.readTrackingSettings(tx);
      if (enabled && !previous.enabled)
        throw new Error('Turn on Bank & Cash tracking before enabling bank deductions.');
      const next = { ...previous, askCardSettlementFunding: enabled };
      await this.writeTrackingSettings(tx, next);
      return next;
    });
    this.bankCashTracking.set(settings);
  }

  /** Explicit, audited balance setting. It is never recorded as income or spending. */
  async setSourceBalance(sourceId: string, newMinor: number, note?: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.database.atomic(async (tx) => {
      const settings = await this.readTrackingSettings(tx);
      if (!settings.enabled) throw new Error('Turn on Bank & Cash tracking first.');
      const sources = await this.readStoredSources(tx);
      const source = sources.find((item) => item.id === sourceId);
      if (!source || !isBankOrCash(source)) throw new Error('Choose a bank account or cash.');
      this.assertBalanceValue(source, newMinor);
      const tracked = bankCashTracked(source, settings);
      const adjustment: SourceBalanceAdjustment = {
        id: crypto.randomUUID(),
        sourceId,
        reason: tracked ? 'CORRECTION' : 'OPENING',
        previousMinor: tracked ? source.balanceMinor : undefined,
        newMinor,
        correctionMinor: newMinor - (tracked ? (source.balanceMinor ?? 0) : 0),
        note: note?.trim().slice(0, 200) || undefined,
        createdAt: now,
      };
      await this.insertBalanceAdjustment(tx, adjustment);
      source.balanceMinor = newMinor;
      source.balanceSnapshotMinor = newMinor;
      source.balanceCutoverAt = now;
      await this.writeStoredSources(tx, sources);
      return { sources, adjustment };
    });
    this.paymentSources.set(result.sources);
    this.balanceAdjustments.update((items) => [result.adjustment, ...items]);
  }

  /** Explicit enrollment only; reading an SMS never creates a source. */
  async addBankAccount(input: {
    nickname: string;
    institution: string;
    lastDigits: string;
  }): Promise<PaymentSource> {
    const nickname = input.nickname.trim().slice(0, 80);
    const institution = input.institution.trim().slice(0, 80);
    const lastDigits = input.lastDigits.trim();
    if (!nickname || !institution) throw new Error('Enter the account name and bank.');
    if (!/^\d{3,5}$/.test(lastDigits))
      throw new Error('Enter the last 3 to 5 digits shown in your bank messages.');
    const account: PaymentSource = {
      id: `bank-${crypto.randomUUID()}`,
      nickname,
      kind: 'DEBIT',
      institution,
      lastDigits,
      noLimit: true,
      autoLoad: false,
      archived: false,
    };
    const sources = await this.database.atomic(async (tx) => {
      const stored = await this.readStoredSources(tx);
      const current = stored.length ? stored : this.paymentSources().map((item) => ({ ...item }));
      const sameBank = (value?: string) =>
        (value ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .replace(/bank$/, '') ===
        institution
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .replace(/bank$/, '');
      if (
        current.some(
          (item) =>
            item.kind === 'DEBIT' &&
            !item.archived &&
            item.lastDigits === lastDigits &&
            sameBank(item.institution),
        )
      )
        throw new Error('This bank account is already enrolled.');
      const next = [...current, account];
      await this.writeStoredSources(tx, next);
      return next;
    });
    this.paymentSources.set(sources);
    return account;
  }

  /** Records or edits an own-account movement; both balances change in one SQLite transaction. */
  async saveTransfer(
    input: {
      id: string;
      fromSourceId: string;
      toSourceId?: string;
      amountMinor: number;
      transferDate: string;
      transferTime?: string;
      description?: string;
      balanceTiming?: BalanceTiming;
    },
    mode: 'CREATE' | 'UPDATE',
  ): Promise<SourceTransfer> {
    if (!validTransferDate(input.transferDate, input.transferTime))
      throw new Error('Enter a valid date and time.');
    const now = new Date().toISOString();
    const result = await this.database.atomic(async (tx) => {
      const settings = await this.readTrackingSettings(tx);
      const sources = await this.readStoredSources(tx);
      const [row] = await tx.query<{ payload: string }>(
        'SELECT payload FROM source_transfers WHERE id=?',
        [input.id],
      );
      if (mode === 'CREATE' && row) throw new Error('This transfer was already saved.');
      if (mode === 'UPDATE' && !row) throw new Error('This transfer no longer exists.');
      const previous = row ? (JSON.parse(row.payload) as SourceTransfer) : null;
      if (previous && previous.kind === 'CARD_SETTLEMENT')
        throw new Error('Edit the card payment to change its bank deduction.');
      const loan = previous?.kind === 'LOAN_REPAYMENT';
      const from = sources.find((item) => item.id === input.fromSourceId);
      const to = loan ? undefined : sources.find((item) => item.id === input.toSourceId);
      if (!from || (!loan && !to)) throw new Error('Choose both accounts.');
      reverseTransferEffects(sources, previous, settings);
      const transfer = applyTransferEffects(
        sources,
        previous,
        {
          id: input.id,
          kind: loan ? 'LOAN_REPAYMENT' : transferKindFor(from, to),
          fromSourceId: from.id,
          toSourceId: to?.id,
          amountMinor: input.amountMinor,
          currencyCode: 'INR',
          transferDate: input.transferDate,
          transferTime: input.transferTime || undefined,
          description: input.description?.trim().slice(0, 100) || undefined,
          notes: previous?.notes,
          reference: previous?.reference,
          origin: previous?.origin ?? 'MANUAL',
          balanceTiming: input.balanceTiming ?? previous?.balanceTiming,
          balanceTimingAt: input.balanceTiming ? now : previous?.balanceTimingAt,
          paymentMethod: previous?.paymentMethod,
          paymentMethodDetail: previous?.paymentMethodDetail,
          paymentMethodCustom: previous?.paymentMethodCustom,
          smsAdditionalComment: previous?.smsAdditionalComment,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        },
        settings,
        now,
      );
      await this.writeTransferRow(tx, transfer);
      await this.writeStoredSources(tx, sources);
      return { transfer, sources };
    });
    this.acceptCommittedTransfer(result.transfer, result.sources);
    return result.transfer;
  }

  /** Reverses both recorded sides together. A card payment itself is kept. */
  async deleteTransfer(id: string): Promise<void> {
    const sources = await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ payload: string }>(
        'SELECT payload FROM source_transfers WHERE id=?',
        [id],
      );
      if (!row) throw new Error('This transfer no longer exists.');
      const settings = await this.readTrackingSettings(tx);
      const stored = await this.readStoredSources(tx);
      reverseTransferEffects(stored, JSON.parse(row.payload) as SourceTransfer, settings);
      await tx.run(
        "UPDATE sms_reconciliation SET target_id=NULL,decision=decision || '; TRANSFER_DELETED' WHERE target_id=?",
        [id],
      );
      await tx.run('DELETE FROM source_transfers WHERE id=?', [id]);
      await this.writeStoredSources(tx, stored);
      return stored;
    });
    this.transfers.update((items) => items.filter((item) => item.id !== id));
    this.paymentSources.set(sources);
  }

  private assertBalanceValue(source: PaymentSource, value: number): void {
    if (!Number.isSafeInteger(value) || (source.kind === 'CASH' && value < 0))
      throw new Error(
        source.kind === 'CASH' ? 'Cash balance cannot be negative.' : 'Enter a valid balance.',
      );
  }

  private async loadBankCashTracking(raw: string | undefined): Promise<void> {
    if (raw !== undefined) {
      this.bankCashTracking.set(parseBankCashTracking(raw));
      await this.loadBalanceAdjustments();
      return;
    }
    // Earlier versions tracked Bank/Cash per source. Keep those balances as a confirmed
    // baseline so older entries are never replayed, and keep their tracking on.
    const result = await this.database.atomic(async (tx) => {
      const [existing] = await tx.query<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM app_preferences WHERE key=?',
        [BANK_CASH_TRACKING_KEY],
      );
      if (existing)
        return { settings: parseBankCashTracking(existing.encrypted_value), sources: null };
      const sources = await this.readStoredSources(tx);
      const legacy = sources.filter(
        (source) =>
          isBankOrCash(source) && !source.noLimit && Number.isSafeInteger(source.balanceMinor),
      );
      const now = new Date().toISOString();
      const settings: BankCashTrackingSettings = legacy.length
        ? { enabled: true, askCardSettlementFunding: false, activatedAt: now }
        : { ...DEFAULT_BANK_CASH_TRACKING };
      for (const source of legacy) {
        await this.insertBalanceAdjustment(tx, {
          id: crypto.randomUUID(),
          sourceId: source.id,
          reason: 'MIGRATION',
          previousMinor: source.balanceMinor,
          newMinor: source.balanceMinor ?? 0,
          correctionMinor: 0,
          note: 'Existing tracked balance kept as the confirmed baseline.',
          createdAt: now,
        });
        source.balanceSnapshotMinor = source.balanceMinor;
        source.balanceCutoverAt = now;
      }
      await this.writeTrackingSettings(tx, settings);
      if (legacy.length) await this.writeStoredSources(tx, sources);
      return { settings, sources: legacy.length ? sources : null };
    });
    this.bankCashTracking.set(result.settings);
    if (result.sources) this.paymentSources.set(result.sources);
    await this.loadBalanceAdjustments();
  }

  private async loadTransfers(): Promise<void> {
    const rows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM source_transfers ORDER BY transfer_date DESC, created_at DESC',
    );
    this.transfers.set(
      rows.flatMap((row) => {
        try {
          return [JSON.parse(row.payload) as SourceTransfer];
        } catch {
          return [];
        }
      }),
    );
  }

  private async loadBalanceAdjustments(): Promise<void> {
    const rows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM source_balance_adjustments ORDER BY created_at DESC LIMIT 500',
    );
    this.balanceAdjustments.set(
      rows.flatMap((row) => {
        try {
          return [JSON.parse(row.payload) as SourceBalanceAdjustment];
        } catch {
          return [];
        }
      }),
    );
  }
  archiveCard(cardId: string): void {
    const card = this.cards().find((item) => item.id === cardId);
    if (card) {
      const timestamp = new Date().toISOString();
      this.updateCard({ ...card, archived: true, archivedAt: timestamp, updatedAt: timestamp });
    }
  }

  restoreCard(cardId: string): void {
    const card = this.cards().find((item) => item.id === cardId);
    if (card)
      this.updateCard({
        ...card,
        archived: false,
        archivedAt: undefined,
        updatedAt: new Date().toISOString(),
      });
  }

  async deleteAllData(): Promise<void> {
    await this.database.deleteAllData();
    this.cards.set([]);
    this.transactions.set([]);
    this.paymentGroups.set([]);
    this.categories.set(CATEGORIES);
    this.paymentSources.set(PAYMENT_SOURCES);
    this.recurringRules.set([]);
    this.loans.set([]);
    this.emiPlans.set([]);
    this.emiInstallments.set([]);
    this.reconciledStatements.set([]);
    this.incomeHistory.set([]);
    this.monthlyIncomeMinor.set(0);
    this.monthlyBudgetMinor.set(0);
    this.budgetCycleStartDay.set(1);
    this.profileTitle.set('');
    this.profileName.set('');
    this.displayCountryCode.set('IN');
    this.displayCurrencyCode.set('INR');
    configureMoneyDisplay('IN', 'INR');
    this.emiMinimumMinor.set(250_000);
    this.spendHighlightThresholdMinor.set(400_000);
    this.highlightDashboardSpending.set(true);
    this.flashTransactionSourceId.set('');
    clearFlashSourcePreference();
    this.snoozedReminderCardIds.set([]);
    this.bankCashTracking.set({ ...DEFAULT_BANK_CASH_TRACKING });
    this.transfers.set([]);
    this.balanceAdjustments.set([]);
    writeCachedTransactions([]);
    for (const category of CATEGORIES) await this.persistCategory(category);
    this.dataWasCleared = true;
    await this.upsertPreference('data_cleared', '1');
  }

  async retainRecentYears(years: number): Promise<number> {
    if (![3, 5, 7, 10].includes(years)) throw new Error('Choose a supported retention period.');
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const cutoffIso = toIsoDate(cutoff);
    const removedTransactions = this.transactions().filter(
      (transaction) => transaction.transactionDate < cutoffIso,
    );
    const removedIds = new Set(removedTransactions.map((transaction) => transaction.id));
    const balanceForwardByCard = new Map<string, number>();
    for (const transaction of removedTransactions) {
      if (!this.cards().some((card) => card.id === transaction.cardId)) continue;
      balanceForwardByCard.set(
        transaction.cardId,
        (balanceForwardByCard.get(transaction.cardId) ?? 0) + transactionEffect(transaction),
      );
    }
    const retainedTransactions = this.transactions().filter(
      (transaction) => !removedIds.has(transaction.id),
    );
    const removedPlanIds = new Set(
      this.emiPlans()
        .filter((plan) => removedIds.has(plan.transactionId))
        .map((plan) => plan.id),
    );

    await this.database.deleteDataOlderThan(cutoffIso);
    const timestamp = new Date().toISOString();
    const updatedCards = this.cards().map((card) => {
      const balanceForward = balanceForwardByCard.get(card.id);
      return balanceForward
        ? {
            ...card,
            openingBalanceMinor: card.openingBalanceMinor + balanceForward,
            updatedAt: timestamp,
          }
        : card;
    });
    this.cards.set(updatedCards);
    this.transactions.set(retainedTransactions);
    this.emiPlans.update((plans) => plans.filter((plan) => !removedPlanIds.has(plan.id)));
    this.emiInstallments.update((installments) =>
      installments.filter(
        (installment) => !installment.emiPlanId || !removedPlanIds.has(installment.emiPlanId),
      ),
    );
    this.incomeHistory.update((records) =>
      records.filter((record) => record.cycleEndDate >= cutoffIso),
    );
    this.cacheTransactions(retainedTransactions);
    for (const card of updatedCards.filter((card) => balanceForwardByCard.has(card.id))) {
      await this.persistCard(card);
    }
    return removedTransactions.length;
  }

  addCategory(category: Category): void {
    this.categories.update((categories) => [...categories, category]);
    void this.persistCategory(category);
  }

  updateCategory(updated: Category): void {
    this.categories.update((categories) =>
      categories.map((category) => (category.id === updated.id ? updated : category)),
    );
    void this.persistCategory(updated);
  }

  deleteCategory(categoryId: string, replacementCategoryId = 'other'): boolean {
    if (categoryId === 'other' || categoryId === 'payment') return false;
    if (replacementCategoryId) {
      this.transactions.update((transactions) =>
        transactions.map((transaction) =>
          transaction.categoryId === categoryId
            ? {
                ...transaction,
                categoryId: replacementCategoryId,
                updatedAt: new Date().toISOString(),
              }
            : transaction,
        ),
      );
    }
    this.categories.update((categories) =>
      categories.filter((category) => category.id !== categoryId),
    );
    if (this.database.ready()) {
      void this.database.run('DELETE FROM categories WHERE id = ?', [categoryId]);
    }
    return true;
  }

  async setCategoryLimit(
    categoryId: string,
    limitMinor: number | undefined,
    showLimit: boolean,
  ): Promise<void> {
    this.categories.update((categories) =>
      categories.map((category) =>
        category.id === categoryId
          ? { ...category, monthlyLimitMinor: limitMinor, showLimit }
          : category,
      ),
    );
    if (!this.database.ready()) return;
    if (limitMinor === undefined) {
      await this.database.run('DELETE FROM category_limits WHERE category_id = ?', [categoryId]);
      return;
    }
    await this.database.run(
      `INSERT INTO category_limits (category_id, limit_minor, show_limit, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(category_id) DO UPDATE SET
         limit_minor = excluded.limit_minor,
         show_limit = excluded.show_limit,
         updated_at = excluded.updated_at`,
      [categoryId, limitMinor, showLimit ? 1 : 0, new Date().toISOString()],
    );
  }

  sourceName(sourceId: string): string {
    const card = this.cards().find((item) => item.id === sourceId);
    const source = this.paymentSources().find((item) => item.id === sourceId);
    return (
      (card ? `${card.nickname}${card.deletedAt ? ' (deleted card)' : ''}` : undefined) ??
      (source
        ? `${source.nickname}${source.lastDigits ? ` ${source.lastDigits}` : ''}`
        : undefined) ??
      'Unknown source'
    );
  }

  sourceDetail(sourceId: string): string {
    const card = this.cards().find((item) => item.id === sourceId);
    if (card)
      return `${card.nickname} •••• ${card.lastDigits} · ${card.issuerName}${card.deletedAt ? ' · Deleted card' : ''}`;
    const source = this.paymentSources().find((item) => item.id === sourceId);
    if (source?.kind === 'DEBIT' && source.lastDigits) return bankAccountLabel(source);
    return source
      ? `${source.nickname}${source.lastDigits ? ` · ${source.lastDigits}` : ''}${source.institution ? ` · ${source.institution}` : ''}`
      : 'Unknown source';
  }

  materializeRecurringTransactions(asOf = today): void {
    const generated: CardTransaction[] = [];
    const changedRules: RecurringRule[] = [];
    const nowStamp = new Date().toISOString();
    this.recurringRules.update((rules) =>
      rules.map((rule) => {
        let next = rule.nextOccurrenceDate;
        let guard = 0;
        let occurrenceCount = this.transactions().filter(
          (item) => item.recurringRuleId === rule.id,
        ).length;
        let status = rule.status;
        while (rule.status === 'ACTIVE' && next && next <= asOf && guard < 120) {
          if (rule.occurrenceLimit !== undefined && occurrenceCount >= rule.occurrenceLimit) {
            status = 'COMPLETED';
            next = undefined;
            break;
          }
          const occurrence = next;
          const exists = this.transactions().some(
            (item) =>
              item.recurringRuleId === rule.id && item.generatedOccurrenceDate === occurrence,
          );
          if (!exists) {
            generated.push({
              id: crypto.randomUUID(),
              cardId: rule.cardId,
              type: rule.transactionType ?? 'PURCHASE',
              amountMinor: rule.amountMinor,
              currencyCode: 'INR',
              transactionDate: occurrence,
              merchant: rule.title,
              categoryId: rule.categoryId,
              recurringRuleId: rule.id,
              generatedOccurrenceDate: occurrence,
              attachmentIds: [],
              createdAt: nowStamp,
              updatedAt: nowStamp,
            });
            occurrenceCount += 1;
          }
          if (rule.occurrenceLimit !== undefined && occurrenceCount >= rule.occurrenceLimit) {
            status = 'COMPLETED';
            next = undefined;
          } else {
            next = this.nextRecurringDate(rule, occurrence);
          }
          guard += 1;
        }
        if (next === rule.nextOccurrenceDate && status === rule.status) return rule;
        const updated = { ...rule, nextOccurrenceDate: next, status };
        changedRules.push(updated);
        return updated;
      }),
    );
    for (const rule of changedRules) void this.persistRecurringRule(rule);
    if (generated.length) {
      this.transactions.update((items) => {
        const next = [...generated, ...items];
        this.cacheTransactions(next);
        return next;
      });
      for (const transaction of generated) {
        this.adjustPaymentSourceBalance(transaction, 1);
        void this.persistTransaction(transaction);
      }
    }
  }

  private adjustPaymentSourceBalance(transaction: CardTransaction, direction: 1 | -1): void {
    const source = this.paymentSources().find((item) => item.id === transaction.cardId);
    // Bank/Cash balances are published only after their SQLite effect commits.
    if (!source || isBankOrCash(source) || source.noLimit || source.balanceMinor === undefined)
      return;
    if (!walletEffectApplies(source, transaction)) return;
    const balanceEffect = -transactionEffect(transaction) * direction;
    this.paymentSources.update((sources) =>
      sources.map((item) =>
        item.id === source.id
          ? { ...item, balanceMinor: (item.balanceMinor ?? 0) + balanceEffect }
          : item,
      ),
    );
  }

  private nextRecurringDate(rule: RecurringRule, occurrence: string): string {
    const date = new Date(`${occurrence}T12:00:00`);
    if (rule.frequency === 'WEEKLY') date.setDate(date.getDate() + 7);
    else if (rule.frequency === 'BIWEEKLY') date.setDate(date.getDate() + 14);
    else if (rule.frequency === 'DAILY') date.setDate(date.getDate() + 1);
    else if (rule.frequency === 'YEARLY') date.setFullYear(date.getFullYear() + 1);
    else {
      const months =
        rule.frequency === 'BIMONTHLY'
          ? 2
          : rule.frequency === 'QUARTERLY'
            ? 3
            : rule.frequency === 'HALF_YEARLY'
              ? 6
              : Math.max(1, rule.interval ?? 1);
      const anchorDay = Number(rule.startDate.slice(8, 10));
      date.setDate(1);
      date.setMonth(date.getMonth() + months);
      date.setDate(
        Math.min(anchorDay, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()),
      );
    }
    return date.toISOString().slice(0, 10);
  }

  private async loadCurrentIncome(): Promise<void> {
    const income = await this.findIncome(this.currentIncomePeriod().periodKey);
    if (!income) {
      this.monthlyIncomeMinor.set(0);
      await this.refreshIncomeHistory();
      return;
    }
    this.monthlyIncomeMinor.set(income.amountMinor);
    await this.refreshIncomeHistory();
  }

  private async loadCards(): Promise<void> {
    const rows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM credit_cards ORDER BY created_at',
    );
    if (rows.length) {
      const legacyCards: CreditCard[] = [];
      const cards = rows.flatMap((row) => {
        try {
          const restored = JSON.parse(row.payload) as CreditCard;
          const normalized = normalizeCardDueDateRule(restored);
          if (normalized !== restored) legacyCards.push(normalized);
          return [normalized];
        } catch {
          return [];
        }
      });
      if (cards.length) this.cards.set(cards);
      // Old backups stored a fixed day-of-month. Persist the equivalent number of
      // days after statement once so future backups use the current billing model.
      for (const card of legacyCards) await this.persistCard(card);
      return;
    }
    this.cards.set([]);
  }

  private async loadCategoryLimits(): Promise<void> {
    const rows = await this.database.query<
      {
        categoryId: string;
        limitMinor: number;
        showLimit: number;
      } & Record<string, unknown>
    >(
      `SELECT category_id AS categoryId, limit_minor AS limitMinor, show_limit AS showLimit
       FROM category_limits`,
    );
    const limits = new Map(rows.map((row) => [row.categoryId, row]));
    this.categories.update((categories) =>
      categories.map((category) => {
        const limit = limits.get(category.id);
        return limit
          ? {
              ...category,
              monthlyLimitMinor: limit.limitMinor,
              showLimit: Boolean(limit.showLimit),
            }
          : category;
      }),
    );
  }

  private async loadCategories(): Promise<void> {
    const rows = await this.database.query<
      {
        id: string;
        name: string;
        icon: string;
        colour: string | null;
        appliesTo: Category['appliesTo'];
        archived: number;
      } & Record<string, unknown>
    >(
      `SELECT id, name, icon, colour, applies_to AS appliesTo, archived
       FROM categories ORDER BY name COLLATE NOCASE`,
    );
    if (rows.length) {
      const storedCategories = rows.map((row) => ({
        id: row.id,
        name: row.name,
        icon: row.icon,
        colour: row.colour ?? undefined,
        appliesTo: row.appliesTo,
        archived: Boolean(row.archived),
      }));
      const missingDefaults = CATEGORIES.filter(
        (category) =>
          !storedCategories.some(
            (stored) =>
              stored.id === category.id ||
              stored.name.localeCompare(category.name, undefined, { sensitivity: 'base' }) === 0,
          ),
      );
      this.categories.set([...storedCategories, ...missingDefaults]);
      for (const category of missingDefaults) await this.persistCategory(category);
      return;
    }
    for (const category of this.categories()) await this.persistCategory(category);
  }

  private async loadTransactions(): Promise<void> {
    await this.refreshPaymentGroups();
    const rows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM card_transactions ORDER BY transaction_date DESC, created_at DESC',
    );
    if (!rows.length) {
      const [initialization] = await this.database.query<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM app_preferences WHERE key=?',
        ['initial_data_state'],
      );
      // Preserve the old installed-cache fallback only for recognized legacy installations.
      // Never resurrect cache records after a restore/clear, or invent their missing sources.
      const sources = new Set([
        ...this.cards().map((card) => card.id),
        ...this.paymentSources().map((source) => source.id),
      ]);
      const cached = initialization?.encrypted_value === 'EXISTING' ? readCachedTransactions() : [];
      this.transactions.set((cached ?? []).filter((item) => sources.has(item.cardId)));
      return;
    }
    const transactions = rows.flatMap((row) => {
      try {
        return [JSON.parse(row.payload) as CardTransaction];
      } catch {
        return [];
      }
    });
    this.transactions.set(transactions);
    this.cacheTransactions(transactions);
  }

  private async loadRecurringRules(): Promise<void> {
    const rows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM recurring_rules ORDER BY rowid',
    );
    this.recurringRules.set(
      rows.flatMap((row) => {
        try {
          return [JSON.parse(row.payload) as RecurringRule];
        } catch {
          return [];
        }
      }),
    );
  }

  private async loadLoans(): Promise<void> {
    const rows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM loan_commitments ORDER BY rowid DESC',
    );
    this.loans.set(
      rows.flatMap((row) => {
        try {
          return [JSON.parse(row.payload) as LoanCommitment];
        } catch {
          return [];
        }
      }),
    );
  }

  private async loadEmiPlans(): Promise<void> {
    const planRows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM emi_plans ORDER BY rowid DESC',
    );
    this.emiPlans.set(
      planRows.flatMap((row) => {
        try {
          return [JSON.parse(row.payload) as EmiPlan];
        } catch {
          return [];
        }
      }),
    );
    const installmentRows = await this.database.query<
      { id: string; emiPlanId: string; payload: string } & Record<string, unknown>
    >('SELECT id, emi_plan_id AS emiPlanId, payload FROM emi_installments ORDER BY statement_date');
    this.emiInstallments.set(
      installmentRows.flatMap((row) => {
        try {
          return [
            { ...JSON.parse(row.payload), id: row.id, emiPlanId: row.emiPlanId } as EmiInstallment,
          ];
        } catch {
          return [];
        }
      }),
    );
    for (const plan of this.emiPlans()) {
      const transaction = this.transactions().find((item) => item.id === plan.transactionId);
      if (!transaction || transaction.emiInstallmentNumber) continue;
      const installments = this.emiInstallments().filter((item) => item.emiPlanId === plan.id);
      if (!installments.length) continue;
      this.saveEmiPlan(
        {
          ...plan,
          remainingPurchaseMinor: 0,
          originalTransactionDate: plan.originalTransactionDate ?? transaction.transactionDate,
          originalMerchant: plan.originalMerchant ?? transaction.merchant,
        },
        installments,
      );
    }
  }

  private cacheTransactions(transactions: readonly CardTransaction[]): void {
    writeCachedTransactions(transactions);
  }

  private async persistTransaction(transaction: CardTransaction): Promise<void> {
    if (!this.database.ready()) return;
    const result = await this.database.atomic((tx) => this.writeTransaction(tx, transaction));
    this.publishStoredBalances(result.wallets);
    if (result.fundingChanged) await this.loadTransfers();
  }

  private async writeTransaction(tx: DatabaseSession, transaction: CardTransaction) {
    const [stored] = await tx.query<{ payload: string }>(
      'SELECT payload FROM card_transactions WHERE id = ?',
      [transaction.id],
    );
    const previous = stored ? (JSON.parse(stored.payload) as CardTransaction) : null;
    const wallets = await this.readStoredSources(tx);
    const settings = await this.readTrackingSettings(tx);
    const now = new Date().toISOString();
    const metadataOnly =
      previous &&
      previous.cardId === transaction.cardId &&
      previous.amountMinor === transaction.amountMinor &&
      previous.transactionDate === transaction.transactionDate &&
      previous.transactionTime === transaction.transactionTime &&
      transactionEffect(previous) === transactionEffect(transaction) &&
      previous.sourceBalanceApplied === transaction.sourceBalanceApplied &&
      previous.balanceTiming === transaction.balanceTiming &&
      previous.balanceTimingAt === transaction.balanceTimingAt;
    let persisted: CardTransaction;
    if (metadataOnly)
      persisted = {
        ...transaction,
        balanceEffect: previous.balanceEffect,
        sourceBalanceApplied: previous.sourceBalanceApplied,
        balanceTiming: previous.balanceTiming,
        balanceTimingAt: previous.balanceTimingAt,
      };
    else {
      applyWalletTransaction(wallets, previous, -1);
      applyWalletTransaction(wallets, transaction, 1);
      reverseBalanceEffect(wallets, previous?.balanceEffect, settings);
      persisted = applyBankCashTransaction(wallets, previous, transaction, settings, now);
    }
    await this.upsertTransactionRow(tx, persisted);
    await tx.run('DELETE FROM transaction_links WHERE transaction_id = ?', [transaction.id]);
    if (
      transaction.relatedTransactionId &&
      (transaction.type === 'REFUND' || transaction.type === 'ADJUSTMENT')
    ) {
      await tx.run(
        `INSERT INTO transaction_links
         (transaction_id, related_transaction_id, relationship_type, created_at)
         VALUES (?, ?, ?, ?)`,
        [transaction.id, transaction.relatedTransactionId, transaction.type, transaction.createdAt],
      );
    }
    const fundingChanged = await this.syncCardFunding(tx, wallets, settings, persisted, now);
    if (wallets.length) await this.writeStoredSources(tx, wallets);
    return { wallets, fundingChanged, persisted };
  }

  private async upsertTransactionRow(
    tx: DatabaseSession,
    transaction: CardTransaction,
  ): Promise<void> {
    const creditCardId = this.cards().some((card) => card.id === transaction.cardId)
      ? transaction.cardId
      : null;
    await tx.run(
      `INSERT INTO card_transactions
       (id, card_id, category_id, type, amount_minor, currency_code, transaction_date, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         card_id = excluded.card_id,
         category_id = excluded.category_id,
         type = excluded.type,
         amount_minor = excluded.amount_minor,
         currency_code = excluded.currency_code,
         transaction_date = excluded.transaction_date,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        transaction.id,
        creditCardId,
        transaction.categoryId,
        transaction.type,
        transaction.amountMinor,
        transaction.currencyCode,
        transaction.transactionDate,
        JSON.stringify(transaction),
        transaction.createdAt,
        transaction.updatedAt,
      ],
    );
  }

  /** Keeps a card payment's bank funding equal to the payment, or removes it if no longer a payment. */
  private async syncCardFunding(
    tx: DatabaseSession,
    sources: PaymentSource[],
    settings: BankCashTrackingSettings,
    payment: CardTransaction,
    now: string,
  ): Promise<boolean> {
    const [row] = await tx.query<{ payload: string }>(
      'SELECT payload FROM source_transfers WHERE payment_transaction_id = ?',
      [payment.id],
    );
    if (!row) return false;
    const funding = JSON.parse(row.payload) as SourceTransfer;
    reverseTransferEffects(sources, funding, settings);
    if (payment.type !== 'PAYMENT' || !this.cards().some((card) => card.id === payment.cardId)) {
      await tx.run('DELETE FROM source_transfers WHERE id = ?', [funding.id]);
      return true;
    }
    const next = applyTransferEffects(
      sources,
      funding,
      {
        ...funding,
        cardId: payment.cardId,
        amountMinor: payment.amountMinor,
        transferDate: payment.transactionDate,
        transferTime: payment.transactionTime,
        updatedAt: now,
      },
      settings,
      now,
      false,
    );
    await this.writeTransferRow(tx, next);
    return true;
  }

  private async readStoredSources(tx: DatabaseSession): Promise<PaymentSource[]> {
    const [row] = await tx.query<{ encrypted_value: string }>(
      `SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'`,
    );
    return row ? (JSON.parse(row.encrypted_value) as PaymentSource[]) : [];
  }

  private async writeStoredSources(
    tx: DatabaseSession,
    sources: readonly PaymentSource[],
  ): Promise<void> {
    await tx.run(
      `INSERT INTO app_preferences(key,encrypted_value) VALUES ('payment_sources',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value`,
      [JSON.stringify(sources)],
    );
  }

  private async readTrackingSettings(tx: DatabaseSession): Promise<BankCashTrackingSettings> {
    const [row] = await tx.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key=?',
      [BANK_CASH_TRACKING_KEY],
    );
    return parseBankCashTracking(row?.encrypted_value);
  }

  private async writeTrackingSettings(
    tx: DatabaseSession,
    settings: BankCashTrackingSettings,
  ): Promise<void> {
    await tx.run(
      `INSERT INTO app_preferences(key,encrypted_value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value`,
      [BANK_CASH_TRACKING_KEY, JSON.stringify(settings)],
    );
  }

  private async writeTransferRow(tx: DatabaseSession, transfer: SourceTransfer): Promise<void> {
    await tx.run(
      `INSERT INTO source_transfers
       (id, kind, from_source_id, to_source_id, payment_transaction_id, amount_minor, transfer_date, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         from_source_id = excluded.from_source_id,
         to_source_id = excluded.to_source_id,
         amount_minor = excluded.amount_minor,
         transfer_date = excluded.transfer_date,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        transfer.id,
        transfer.kind,
        transfer.fromSourceId,
        transfer.toSourceId ?? null,
        transfer.paymentTransactionId ?? null,
        transfer.amountMinor,
        transfer.transferDate,
        JSON.stringify(transfer),
        transfer.createdAt,
        transfer.updatedAt,
      ],
    );
  }

  private async insertBalanceAdjustment(
    tx: DatabaseSession,
    adjustment: SourceBalanceAdjustment,
  ): Promise<void> {
    await tx.run(
      `INSERT INTO source_balance_adjustments
       (id, source_id, reason, previous_minor, new_minor, correction_minor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        adjustment.id,
        adjustment.sourceId,
        adjustment.reason,
        adjustment.previousMinor ?? null,
        adjustment.newMinor,
        adjustment.correctionMinor,
        JSON.stringify(adjustment),
        adjustment.createdAt,
      ],
    );
  }

  private publishStoredBalances(sources: readonly PaymentSource[]): void {
    this.paymentSources.update((items) =>
      items.map((item) => {
        const stored = sources.find((source) => source.id === item.id);
        return stored ? { ...item, balanceMinor: stored.balanceMinor } : item;
      }),
    );
  }

  private async removePersistedTransaction(id: string): Promise<void> {
    const result = await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ payload: string }>(
        'SELECT payload FROM card_transactions WHERE id=?',
        [id],
      );
      const wallets = await this.readStoredSources(tx);
      const settings = await this.readTrackingSettings(tx);
      const previous = row ? (JSON.parse(row.payload) as CardTransaction) : null;
      applyWalletTransaction(wallets, previous, -1);
      reverseBalanceEffect(wallets, previous?.balanceEffect, settings);
      const [funding] = await tx.query<{ payload: string }>(
        'SELECT payload FROM source_transfers WHERE payment_transaction_id=?',
        [id],
      );
      if (funding) {
        reverseTransferEffects(wallets, JSON.parse(funding.payload) as SourceTransfer, settings);
        await tx.run('DELETE FROM source_transfers WHERE payment_transaction_id=?', [id]);
      }
      await detachPaymentGroup(tx, id);
      await tx.run('DELETE FROM card_transactions WHERE id=?', [id]);
      if (wallets.length) await this.writeStoredSources(tx, wallets);
      return { wallets, funding: !!funding };
    });
    this.publishStoredBalances(result.wallets);
    if (result.funding) await this.loadTransfers();
  }

  private async persistRecurringRule(rule: RecurringRule): Promise<void> {
    if (!this.database.ready()) return;
    const creditCardId = this.cards().some((card) => card.id === rule.cardId) ? rule.cardId : null;
    if (!creditCardId) return;
    await this.database.run(
      `INSERT INTO recurring_rules (id, card_id, next_occurrence_date, status, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         next_occurrence_date = excluded.next_occurrence_date,
         status = excluded.status,
         payload = excluded.payload`,
      [rule.id, creditCardId, rule.nextOccurrenceDate ?? null, rule.status, JSON.stringify(rule)],
    );
  }

  private async persistLoan(loan: LoanCommitment): Promise<void> {
    if (!this.database.ready()) return;
    await this.database.run(
      `INSERT INTO loan_commitments (id, status, payload, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [loan.id, loan.status, JSON.stringify(loan), new Date().toISOString()],
    );
  }

  private async persistEmiPlan(
    plan: EmiPlan,
    installments: readonly EmiInstallment[],
  ): Promise<void> {
    await this.database.run(
      `INSERT INTO emi_plans (id, transaction_id, card_id, status, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload`,
      [plan.id, plan.transactionId, plan.cardId, plan.status, JSON.stringify(plan)],
    );
    await this.database.run('DELETE FROM emi_installments WHERE emi_plan_id = ?', [plan.id]);
    for (const installment of installments) {
      await this.database.run(
        `INSERT INTO emi_installments
         (id, emi_plan_id, installment_number, statement_date, due_date,
          principal_minor, interest_minor, paid, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          installment.id,
          plan.id,
          installment.installmentNumber,
          installment.statementDate,
          installment.dueDate,
          installment.principalMinor,
          installment.interestMinor,
          installment.paid ? 1 : 0,
          JSON.stringify(installment),
        ],
      );
    }
  }

  private async persistCategory(category: Category): Promise<void> {
    if (!this.database.ready()) return;
    await this.database.run(
      `INSERT INTO categories (id, name, icon, colour, applies_to, archived)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         icon = excluded.icon,
         colour = excluded.colour,
         applies_to = excluded.applies_to,
         archived = excluded.archived`,
      [
        category.id,
        category.name,
        category.icon,
        category.colour ?? null,
        category.appliesTo,
        category.archived ? 1 : 0,
      ],
    );
  }

  private async persistCard(card: CreditCard): Promise<void> {
    if (!this.database.ready()) return;
    await this.database.run(
      `INSERT INTO credit_cards
       (id, nickname, issuer_name, last_digits, encrypted_full_number, network, payload, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         nickname = excluded.nickname,
         issuer_name = excluded.issuer_name,
         last_digits = excluded.last_digits,
         encrypted_full_number = excluded.encrypted_full_number,
         network = excluded.network,
         payload = excluded.payload,
         archived = excluded.archived,
         updated_at = excluded.updated_at`,
      [
        card.id,
        card.nickname,
        card.issuerName,
        card.lastDigits,
        card.encryptedFullNumber ?? null,
        card.network,
        JSON.stringify(card),
        card.archived ? 1 : 0,
        card.createdAt,
        card.updatedAt,
      ],
    );
    await this.database.run('DELETE FROM card_benefits WHERE card_id = ?', [card.id]);
    for (const benefit of card.benefits ?? []) {
      await this.database.run(
        `INSERT INTO card_benefits (id, card_id, name, note, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [benefit.id, card.id, benefit.name, benefit.note ?? null, card.updatedAt],
      );
    }
    await this.database.run('DELETE FROM card_important_links WHERE card_id = ?', [card.id]);
    for (const link of card.importantLinks ?? []) {
      await this.database.run(
        `INSERT INTO card_important_links (id, card_id, label, url, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [link.id, card.id, link.label, link.url, card.updatedAt],
      );
    }
    await this.database.run('DELETE FROM card_relationship_members WHERE card_id = ?', [card.id]);
    if (card.relationshipGroupId) {
      await this.database.run(
        `INSERT INTO card_relationship_groups (id, name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
        [card.relationshipGroupId, card.relationshipGroupId, card.updatedAt],
      );
      await this.database.run(
        'INSERT INTO card_relationship_members (group_id, card_id) VALUES (?, ?)',
        [card.relationshipGroupId, card.id],
      );
    }
    await this.database.run(
      `INSERT INTO card_secrets (card_id, encrypted_number, encrypted_cvv, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET
         encrypted_number = excluded.encrypted_number,
         encrypted_cvv = excluded.encrypted_cvv,
         updated_at = excluded.updated_at`,
      [card.id, card.encryptedFullNumber ?? null, card.encryptedCvv ?? null, card.updatedAt],
    );
  }

  private async findIncome(periodKey: string): Promise<MonthlyIncomeRecord | null> {
    const rows = await this.database.query<MonthlyIncomeRecord & Record<string, unknown>>(
      `SELECT period_key AS periodKey,
              cycle_start_date AS cycleStartDate,
              cycle_end_date AS cycleEndDate,
              amount_minor AS amountMinor,
              updated_at AS updatedAt
       FROM monthly_income WHERE period_key = ?`,
      [periodKey],
    );
    return rows[0] ?? null;
  }

  private async refreshIncomeHistory(): Promise<void> {
    const rows = await this.database.query<MonthlyIncomeRecord & Record<string, unknown>>(
      `SELECT period_key AS periodKey,
              cycle_start_date AS cycleStartDate,
              cycle_end_date AS cycleEndDate,
              amount_minor AS amountMinor,
              updated_at AS updatedAt
       FROM monthly_income ORDER BY cycle_start_date DESC`,
    );
    this.incomeHistory.set(rows);
  }

  private async upsertPreference(key: string, value: string): Promise<void> {
    if (!this.database.ready()) throw new Error('SQLite storage is unavailable.');
    await this.database.run(
      `INSERT INTO app_preferences (key, encrypted_value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
      [key, value],
    );
  }

  private incomePeriodFor(date: Date, startDay: number) {
    const start = new Date(date.getFullYear(), date.getMonth(), startDay);
    if (date.getDate() < startDay) start.setMonth(start.getMonth() - 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, startDay - 1);
    return {
      periodKey: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      cycleStartDate: this.localDate(start),
      cycleEndDate: this.localDate(end),
    };
  }

  private localDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}

function readCachedTransactions(): readonly CardTransaction[] | null {
  try {
    const value = globalThis.localStorage?.getItem(TRANSACTION_CACHE_KEY);
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item: unknown): item is CardTransaction =>
            typeof item === 'object' &&
            item !== null &&
            'id' in item &&
            typeof item.id === 'string' &&
            'cardId' in item &&
            typeof item.cardId === 'string' &&
            'amountMinor' in item &&
            Number.isSafeInteger(item.amountMinor) &&
            'transactionDate' in item &&
            typeof item.transactionDate === 'string' &&
            'categoryId' in item &&
            typeof item.categoryId === 'string',
        )
      : null;
  } catch {
    return null;
  }
}
function writeCachedTransactions(transactions: readonly CardTransaction[]): void {
  try {
    globalThis.localStorage?.setItem(TRANSACTION_CACHE_KEY, JSON.stringify(transactions));
  } catch {
    // The SQLite database remains the source of truth when browser storage is unavailable.
  }
}
