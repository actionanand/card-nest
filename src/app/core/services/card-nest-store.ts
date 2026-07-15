import { Service, computed, inject, signal } from '@angular/core';
import {
  CardTransaction,
  Category,
  CreditCard,
  DashboardSnapshot,
  LoanCommitment,
  MonthlyIncomeRecord,
  PaymentSource,
  RecurringRule,
} from '../models/domain';
import { SqliteDatabase } from '../data/sqlite-database';
import { calculateNetSpending, calculateOutstanding } from './money';

const now = new Date();
const today = now.toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;

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
    dueDateMode: 'FIXED_DAY',
    paymentDueDay: 24,
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
  ['other', 'Other', 'category', '#7a8797'],
].map(
  ([id, name, icon, colour]) =>
    ({
      id,
      name,
      icon,
      colour,
      appliesTo: id === 'payment' ? 'CREDIT' : 'BOTH',
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
    balanceMinor: 880000,
    loadAmountMinor: 880000,
    loadDay: 1,
    autoLoad: true,
    lastLoadedPeriod: today.slice(0, 7),
    archived: false,
  },
];

@Service()
export class CardNestStore {
  private readonly database = inject(SqliteDatabase);
  readonly cards = signal<readonly CreditCard[]>(SAMPLE_CARDS);
  readonly transactions = signal<readonly CardTransaction[]>(SAMPLE_TRANSACTIONS);
  readonly categories = signal<readonly Category[]>(CATEGORIES);
  readonly paymentSources = signal<readonly PaymentSource[]>(PAYMENT_SOURCES);
  readonly recurringRules = signal<readonly RecurringRule[]>([]);
  readonly loans = signal<readonly LoanCommitment[]>([]);
  readonly monthlyBudgetMinor = signal(6000000);
  readonly monthlyIncomeMinor = signal(8000000);
  readonly budgetCycleStartDay = signal(1);
  readonly incomeHistory = signal<readonly MonthlyIncomeRecord[]>([]);
  readonly profileTitle = signal('');
  readonly profileName = signal('');
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
  readonly activeCards = computed(() => this.cards().filter((card) => !card.archived));
  readonly activePaymentSources = computed(() =>
    this.paymentSources().filter((source) => !source.archived),
  );

  readonly dashboard = computed<DashboardSnapshot>(() => {
    const cards = this.activeCards();
    const transactions = this.transactions();
    const outstandingMinor = cards.reduce(
      (sum, card) =>
        sum +
        Math.max(
          0,
          calculateOutstanding(
            card.openingBalanceMinor,
            transactions.filter((item) => item.cardId === card.id),
          ),
        ),
      0,
    );
    const totalCredit = cards.reduce((sum, card) => sum + (card.creditLimitMinor ?? 0), 0);
    const month = today.slice(0, 7);
    const monthlySpendMinor = calculateNetSpending(
      transactions.filter((item) => item.transactionDate.startsWith(month)),
    );
    return {
      outstandingMinor,
      statementDueMinor: Math.round(outstandingMinor * 0.62),
      unbilledMinor: Math.round(outstandingMinor * 0.38),
      availableCreditMinor: Math.max(0, totalCredit - outstandingMinor),
      monthlySpendMinor,
      remainingBudgetMinor: Math.max(0, this.monthlyBudgetMinor() - monthlySpendMinor),
      utilisationPercent:
        totalCredit === 0 ? 0 : Math.round((outstandingMinor / totalCredit) * 1000) / 10,
    };
  });

  constructor() {
    this.materializeSourceLoads();
  }

  async initialisePreferences(): Promise<void> {
    if (!this.database.ready()) return;
    const preferences = await this.database.query<{ key: string; encrypted_value: string }>(
      `SELECT key, encrypted_value FROM app_preferences
       WHERE key IN ('budget_cycle_start_day', 'monthly_budget_minor', 'profile_title', 'profile_name')`,
    );
    const values = new Map(preferences.map((item) => [item.key, item.encrypted_value]));
    const cycleDay = Number(values.get('budget_cycle_start_day'));
    const budget = Number(values.get('monthly_budget_minor'));
    if (Number.isInteger(cycleDay) && cycleDay >= 1 && cycleDay <= 28) {
      this.budgetCycleStartDay.set(cycleDay);
    }
    if (Number.isFinite(budget) && budget >= 0) this.monthlyBudgetMinor.set(budget);
    this.profileTitle.set(values.get('profile_title') ?? '');
    this.profileName.set(values.get('profile_name') ?? '');
    await this.loadCurrentIncome();
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

  cardOutstanding(cardId: string): number {
    const card = this.cards().find((item) => item.id === cardId);
    return card
      ? calculateOutstanding(
          card.openingBalanceMinor,
          this.transactions().filter((item) => item.cardId === cardId),
        )
      : 0;
  }

  addCard(card: CreditCard): void {
    this.cards.update((cards) => [...cards, card]);
  }
  updateCard(updated: CreditCard): void {
    this.cards.update((cards) => cards.map((card) => (card.id === updated.id ? updated : card)));
  }
  addTransaction(transaction: CardTransaction): void {
    this.transactions.update((items) => [transaction, ...items]);
    this.adjustPaymentSourceBalance(transaction, 1);
  }
  updateTransaction(updated: CardTransaction): boolean {
    const existing = this.transactions().find((transaction) => transaction.id === updated.id);
    if (!existing) return false;
    this.adjustPaymentSourceBalance(existing, -1);
    this.transactions.update((items) =>
      items.map((transaction) => (transaction.id === updated.id ? updated : transaction)),
    );
    this.adjustPaymentSourceBalance(updated, 1);
    return true;
  }
  deleteTransaction(transactionId: string): boolean {
    const existing = this.transactions().find((transaction) => transaction.id === transactionId);
    if (!existing) return false;
    this.adjustPaymentSourceBalance(existing, -1);
    this.transactions.update((items) =>
      items.filter((transaction) => transaction.id !== transactionId),
    );
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.addTransaction(duplicate);
    return duplicate;
  }
  addRecurringRule(rule: RecurringRule): void {
    this.recurringRules.update((rules) => [...rules, rule]);
    this.materializeRecurringTransactions();
  }
  updatePaymentSource(updated: PaymentSource): void {
    this.paymentSources.update((sources) =>
      sources.map((source) => (source.id === updated.id ? updated : source)),
    );
    this.materializeSourceLoads();
  }
  addLoan(loan: LoanCommitment): void {
    this.loans.update((loans) => [loan, ...loans]);
  }
  cancelLoan(loanId: string): void {
    this.loans.update((loans) =>
      loans.map((loan) => (loan.id === loanId ? { ...loan, status: 'CANCELLED' } : loan)),
    );
  }
  deleteCard(cardId: string): void {
    this.cards.update((cards) => cards.filter((card) => card.id !== cardId));
    this.transactions.update((items) => items.filter((item) => item.cardId !== cardId));
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
  archiveCard(cardId: string): void {
    this.cards.update((cards) =>
      cards.map((card) =>
        card.id === cardId
          ? { ...card, archived: true, updatedAt: new Date().toISOString() }
          : card,
      ),
    );
  }

  restoreCard(cardId: string): void {
    this.cards.update((cards) =>
      cards.map((card) =>
        card.id === cardId
          ? { ...card, archived: false, updatedAt: new Date().toISOString() }
          : card,
      ),
    );
  }

  addCategory(category: Category): void {
    this.categories.update((categories) => [...categories, category]);
  }

  updateCategory(updated: Category): void {
    this.categories.update((categories) =>
      categories.map((category) => (category.id === updated.id ? updated : category)),
    );
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
    return true;
  }

  sourceName(sourceId: string): string {
    return (
      this.cards().find((card) => card.id === sourceId)?.nickname ??
      this.paymentSources().find((source) => source.id === sourceId)?.nickname ??
      'Unknown source'
    );
  }

  sourceDetail(sourceId: string): string {
    const card = this.cards().find((item) => item.id === sourceId);
    if (card) return `${card.nickname} •••• ${card.lastDigits} · ${card.issuerName}`;
    const source = this.paymentSources().find((item) => item.id === sourceId);
    return source
      ? `${source.nickname}${source.institution ? ` · ${source.institution}` : ''}`
      : 'Unknown source';
  }

  materializeRecurringTransactions(asOf = today): void {
    const generated: CardTransaction[] = [];
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
        return { ...rule, nextOccurrenceDate: next, status };
      }),
    );
    if (generated.length) {
      this.transactions.update((items) => [...generated, ...items]);
      for (const transaction of generated) this.adjustPaymentSourceBalance(transaction, 1);
    }
  }

  materializeSourceLoads(asOf = today): void {
    const period = asOf.slice(0, 7);
    const currentDay = Number(asOf.slice(8, 10));
    this.paymentSources.update((sources) =>
      sources.map((source) =>
        source.kind === 'MEAL' &&
        source.autoLoad &&
        source.loadAmountMinor &&
        source.loadDay &&
        currentDay >= source.loadDay &&
        source.lastLoadedPeriod !== period
          ? {
              ...source,
              balanceMinor: (source.balanceMinor ?? 0) + source.loadAmountMinor,
              lastLoadedPeriod: period,
            }
          : source,
      ),
    );
  }

  private adjustPaymentSourceBalance(transaction: CardTransaction, direction: 1 | -1): void {
    const source = this.paymentSources().find((item) => item.id === transaction.cardId);
    if (!source || source.noLimit || source.balanceMinor === undefined) return;
    const isCredit = ['PAYMENT', 'REFUND', 'CASHBACK', 'CREDIT'].includes(transaction.type);
    const transactionEffect =
      (isCredit ? transaction.amountMinor : -transaction.amountMinor) * direction;
    this.paymentSources.update((sources) =>
      sources.map((item) =>
        item.id === source.id
          ? { ...item, balanceMinor: Math.max(0, (item.balanceMinor ?? 0) + transactionEffect) }
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
      await this.setMonthlyIncome(this.monthlyIncomeMinor());
      return;
    }
    this.monthlyIncomeMinor.set(income.amountMinor);
    await this.refreshIncomeHistory();
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
