import { Service, computed, signal } from '@angular/core';
import {
  CardTransaction,
  Category,
  CreditCard,
  DashboardSnapshot,
  LoanCommitment,
  PaymentSource,
  RecurringRule,
} from '../models/domain';
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
  readonly cards = signal<readonly CreditCard[]>(SAMPLE_CARDS);
  readonly transactions = signal<readonly CardTransaction[]>(SAMPLE_TRANSACTIONS);
  readonly categories = signal<readonly Category[]>(CATEGORIES);
  readonly paymentSources = signal<readonly PaymentSource[]>(PAYMENT_SOURCES);
  readonly recurringRules = signal<readonly RecurringRule[]>([]);
  readonly loans = signal<readonly LoanCommitment[]>([]);
  readonly monthlyBudgetMinor = signal(6000000);
  readonly monthlyIncomeMinor = signal(8000000);
  readonly budgetCycleStartDay = signal(1);
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
    const source = this.paymentSources().find((item) => item.id === transaction.cardId);
    if (source && !source.noLimit && source.balanceMinor !== undefined) {
      const isCredit = ['PAYMENT', 'REFUND', 'CASHBACK', 'CREDIT'].includes(transaction.type);
      this.updatePaymentSource({
        ...source,
        balanceMinor: Math.max(
          0,
          source.balanceMinor + (isCredit ? transaction.amountMinor : -transaction.amountMinor),
        ),
      });
    }
  }
  addRecurringRule(rule: RecurringRule): void {
    this.recurringRules.update((rules) => [...rules, rule]);
    this.materializeRecurringTransactions();
  }
  updatePaymentSource(updated: PaymentSource): void {
    this.paymentSources.update((sources) =>
      sources.map((source) => (source.id === updated.id ? updated : source)),
    );
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
        while (rule.status === 'ACTIVE' && next && next <= asOf && guard < 120) {
          const occurrence = next;
          const exists = this.transactions().some(
            (item) =>
              item.recurringRuleId === rule.id && item.generatedOccurrenceDate === occurrence,
          );
          if (!exists) {
            generated.push({
              id: crypto.randomUUID(),
              cardId: rule.cardId,
              type: 'PURCHASE',
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
          }
          const date = new Date(`${occurrence}T12:00:00`);
          if (rule.frequency === 'WEEKLY') date.setDate(date.getDate() + 7);
          else if (rule.frequency === 'YEARLY') date.setFullYear(date.getFullYear() + 1);
          else date.setMonth(date.getMonth() + (rule.frequency === 'QUARTERLY' ? 3 : 1));
          next = date.toISOString().slice(0, 10);
          guard += 1;
        }
        return { ...rule, nextOccurrenceDate: next };
      }),
    );
    if (generated.length) this.transactions.update((items) => [...generated, ...items]);
  }

  private materializeSourceLoads(): void {
    const period = today.slice(0, 7);
    const currentDay = Number(today.slice(8, 10));
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
}
