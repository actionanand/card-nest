import { Service, computed, inject, signal } from '@angular/core';
import {
  CardTransaction,
  Category,
  CreditCard,
  DashboardSnapshot,
  EmiInstallment,
  EmiPlan,
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
  ['contra-expenses', 'Contra-expenses', 'banknote_arrow_down', '#4e9d73'],
  ['other', 'Other', 'category', '#7a8797'],
].map(
  ([id, name, icon, colour]) =>
    ({
      id,
      name,
      icon,
      colour,
      appliesTo: id === 'payment' || id === 'contra-expenses' ? 'CREDIT' : 'BOTH',
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
  readonly transactions = signal<readonly CardTransaction[]>(
    readCachedTransactions() ?? SAMPLE_TRANSACTIONS,
  );
  readonly categories = signal<readonly Category[]>(CATEGORIES);
  readonly paymentSources = signal<readonly PaymentSource[]>(PAYMENT_SOURCES);
  readonly recurringRules = signal<readonly RecurringRule[]>([]);
  readonly loans = signal<readonly LoanCommitment[]>([]);
  readonly emiPlans = signal<readonly EmiPlan[]>([]);
  readonly emiInstallments = signal<readonly EmiInstallment[]>([]);
  readonly monthlyBudgetMinor = signal(6000000);
  readonly monthlyIncomeMinor = signal(8000000);
  readonly budgetCycleStartDay = signal(1);
  readonly incomeHistory = signal<readonly MonthlyIncomeRecord[]>([]);
  readonly profileTitle = signal('');
  readonly profileName = signal('');
  readonly emiMinimumMinor = signal(250_000);
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
       WHERE key IN ('budget_cycle_start_day', 'monthly_budget_minor', 'profile_title', 'profile_name', 'emi_minimum_minor')`,
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
    const emiMinimum = Number(values.get('emi_minimum_minor'));
    if (Number.isFinite(emiMinimum) && emiMinimum >= 0) this.emiMinimumMinor.set(emiMinimum);
    await Promise.all([this.loadCurrentIncome(), this.loadCards()]);
    await this.loadCategories();
    await this.loadCategoryLimits();
    await this.loadTransactions();
    await this.loadEmiPlans();
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

  async setEmiMinimum(amountMinor: number): Promise<void> {
    this.emiMinimumMinor.set(amountMinor);
    await this.upsertPreference('emi_minimum_minor', String(amountMinor));
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
    void this.persistCard(card);
  }
  updateCard(updated: CreditCard): void {
    this.cards.update((cards) => cards.map((card) => (card.id === updated.id ? updated : card)));
    void this.persistCard(updated);
  }
  addTransaction(transaction: CardTransaction): void {
    this.transactions.update((items) => {
      const existingItems = hasOnlySampleTransactions(items) ? [] : items;
      const updated = [transaction, ...existingItems];
      this.cacheTransactions(updated);
      return updated;
    });
    this.adjustPaymentSourceBalance(transaction, 1);
    void this.persistTransaction(transaction);
  }
  updateTransaction(updated: CardTransaction): boolean {
    const existing = this.transactions().find((transaction) => transaction.id === updated.id);
    if (!existing) return false;
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
    this.adjustPaymentSourceBalance(existing, -1);
    this.transactions.update((items) => {
      const next = items.filter((transaction) => transaction.id !== transactionId);
      this.cacheTransactions(next);
      return next;
    });
    if (this.database.ready()) {
      void this.database.run('DELETE FROM card_transactions WHERE id = ?', [transactionId]);
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
      relatedTransactionId: undefined,
      splitGroupId: undefined,
      splitOriginalAmountMinor: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.addTransaction(duplicate);
    return duplicate;
  }
  saveEmiPlan(plan: EmiPlan, installments: readonly EmiInstallment[]): void {
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
    if (transaction) {
      this.updateTransaction({
        ...transaction,
        emiPlanId: plan.id,
        updatedAt: new Date().toISOString(),
      });
    }
    if (this.database.ready()) void this.persistEmiPlan(plan, storedInstallments);
  }

  splitTransaction(
    transactionId: string,
    parts: readonly { sourceId: string; amountMinor: number }[],
  ): readonly CardTransaction[] {
    const original = this.transactions().find((item) => item.id === transactionId);
    if (!original || parts.length < 2 || parts.length > 4) return [];
    const total = parts.reduce((sum, part) => sum + part.amountMinor, 0);
    if (total !== original.amountMinor) return [];
    const groupId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const splitTransactions = parts.map((part, index): CardTransaction => ({
      ...original,
      id: index === 0 ? original.id : crypto.randomUUID(),
      cardId: part.sourceId,
      amountMinor: part.amountMinor,
      splitGroupId: groupId,
      splitOriginalAmountMinor: original.amountMinor,
      emiPlanId: undefined,
      createdAt: index === 0 ? original.createdAt : timestamp,
      updatedAt: timestamp,
    }));
    this.updateTransaction(splitTransactions[0]);
    for (const transaction of splitTransactions.slice(1)) this.addTransaction(transaction);
    if (this.database.ready())
      void this.persistSplitGroup(groupId, original.amountMinor, splitTransactions);
    return splitTransactions;
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
    if (this.database.ready()) {
      void this.database.run('DELETE FROM credit_cards WHERE id = ?', [cardId]);
    }
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
    const card = this.cards().find((item) => item.id === cardId);
    if (card) this.updateCard({ ...card, archived: true, updatedAt: new Date().toISOString() });
  }

  restoreCard(cardId: string): void {
    const card = this.cards().find((item) => item.id === cardId);
    if (card) this.updateCard({ ...card, archived: false, updatedAt: new Date().toISOString() });
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

  private async loadCards(): Promise<void> {
    const rows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM credit_cards ORDER BY created_at',
    );
    if (rows.length) {
      const cards = rows.flatMap((row) => {
        try {
          return [JSON.parse(row.payload) as CreditCard];
        } catch {
          return [];
        }
      });
      if (cards.length) this.cards.set(cards);
      return;
    }
    for (const card of this.cards()) await this.persistCard(card);
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
        (category) => !storedCategories.some((stored) => stored.id === category.id),
      );
      this.categories.set([...storedCategories, ...missingDefaults]);
      for (const category of missingDefaults) await this.persistCategory(category);
      return;
    }
    for (const category of this.categories()) await this.persistCategory(category);
  }

  private async loadTransactions(): Promise<void> {
    const rows = await this.database.query<{ payload: string }>(
      'SELECT payload FROM card_transactions ORDER BY transaction_date DESC, created_at DESC',
    );
    if (!rows.length) {
      const cached = readCachedTransactions();
      this.transactions.set(cached ?? []);
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
  }

  private cacheTransactions(transactions: readonly CardTransaction[]): void {
    writeCachedTransactions(transactions);
  }

  private async persistTransaction(transaction: CardTransaction): Promise<void> {
    if (!this.database.ready()) return;
    const creditCardId = this.cards().some((card) => card.id === transaction.cardId)
      ? transaction.cardId
      : null;
    await this.database.run(
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
    await this.database.run('DELETE FROM transaction_links WHERE transaction_id = ?', [
      transaction.id,
    ]);
    if (
      transaction.relatedTransactionId &&
      (transaction.type === 'REFUND' || transaction.type === 'ADJUSTMENT')
    ) {
      await this.database.run(
        `INSERT INTO transaction_links
         (transaction_id, related_transaction_id, relationship_type, created_at)
         VALUES (?, ?, ?, ?)`,
        [transaction.id, transaction.relatedTransactionId, transaction.type, transaction.createdAt],
      );
    }
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

  private async persistSplitGroup(
    groupId: string,
    originalAmountMinor: number,
    transactions: readonly CardTransaction[],
  ): Promise<void> {
    for (const transaction of transactions) await this.persistTransaction(transaction);
    await this.database.run(
      `INSERT INTO transaction_split_groups (id, original_amount_minor, created_at)
       VALUES (?, ?, ?)`,
      [groupId, originalAmountMinor, new Date().toISOString()],
    );
    for (const transaction of transactions) {
      await this.database.run(
        `INSERT INTO transaction_split_members (group_id, transaction_id) VALUES (?, ?)`,
        [groupId, transaction.id],
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

function hasOnlySampleTransactions(transactions: readonly CardTransaction[]): boolean {
  return (
    transactions.length === SAMPLE_TRANSACTIONS.length &&
    transactions.every((transaction) =>
      SAMPLE_TRANSACTIONS.some((sample) => sample.id === transaction.id),
    )
  );
}

function readCachedTransactions(): readonly CardTransaction[] | null {
  try {
    const value = globalThis.localStorage?.getItem(TRANSACTION_CACHE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as CardTransaction[]) : null;
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
