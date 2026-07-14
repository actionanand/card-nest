import { Service, computed, signal } from '@angular/core';
import { CardTransaction, Category, CreditCard, DashboardSnapshot } from '../models/domain';
import { calculateNetSpending, calculateOutstanding } from './money';

const now = new Date();
const today = now.toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;

const SAMPLE_CARDS: readonly CreditCard[] = [
  {
    id: 'card-demo-one',
    nickname: 'Everyday',
    issuerName: 'Northstar Bank',
    lastFourDigits: '4821',
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
    lastFourDigits: '1907',
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

@Service()
export class CardNestStore {
  readonly cards = signal<readonly CreditCard[]>(SAMPLE_CARDS);
  readonly transactions = signal<readonly CardTransaction[]>(SAMPLE_TRANSACTIONS);
  readonly categories = signal<readonly Category[]>(CATEGORIES);
  readonly monthlyBudgetMinor = signal(6000000);
  readonly activeCards = computed(() => this.cards().filter((card) => !card.archived));

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
  addTransaction(transaction: CardTransaction): void {
    this.transactions.update((items) => [transaction, ...items]);
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
}
