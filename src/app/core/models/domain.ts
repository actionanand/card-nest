export type Money = number;

export type CardNetwork =
  | 'VISA'
  | 'MASTERCARD'
  | 'RUPAY'
  | 'AMERICAN_EXPRESS'
  | 'DISCOVER'
  | 'DINERS_CLUB'
  | 'JCB'
  | 'UNIONPAY'
  | 'OTHER';

export type TransactionType =
  'PURCHASE' | 'CREDIT' | 'CASHBACK' | 'REFUND' | 'PAYMENT' | 'FEE' | 'INTEREST' | 'ADJUSTMENT';

export interface AnnualFeeDetails {
  amountMinor: Money;
  taxMinor?: Money;
  renewalMonth: number;
  renewalDay: number;
  frequencyMonths: number;
  waiverThresholdMinor?: Money;
  waiverPeriod?: 'ANNIVERSARY' | 'CALENDAR' | 'FINANCIAL' | 'CUSTOM';
  notes?: string;
}

export interface CreditCard {
  id: string;
  nickname: string;
  issuerName: string;
  /** Last 5 digits for American Express; last 4 digits for every other network. */
  lastDigits: string;
  encryptedFullNumber?: string;
  cardholderName?: string;
  network: CardNetwork;
  customNetwork?: string;
  subtype?: string;
  theme: string;
  expiryMonth?: number;
  expiryYear?: number;
  statementDay: number;
  dueDateMode: 'FIXED_DAY' | 'DAYS_AFTER_STATEMENT';
  paymentDueDay?: number;
  daysAfterStatement?: number;
  adjustDueDateOnWeekend: boolean;
  creditLimitMinor?: Money;
  currencyCode: string;
  openingBalanceMinor: Money;
  remindToSettle: boolean;
  annualFeeEnabled: boolean;
  annualFee?: AnnualFeeDetails;
  emergencyPhones: readonly string[];
  supportEmails: readonly string[];
  notes?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CardTransaction {
  id: string;
  cardId: string;
  type: TransactionType;
  adjustmentDirection?: 'INCREASE' | 'DECREASE';
  amountMinor: Money;
  currencyCode: string;
  originalAmountMinor?: Money;
  originalCurrencyCode?: string;
  foreignFeeMinor?: Money;
  transactionDate: string;
  transactionTime?: string;
  merchant?: string;
  categoryId: string;
  notes?: string;
  recurringRuleId?: string;
  generatedOccurrenceDate?: string;
  attachmentIds: readonly string[];
  emiPlanId?: string;
  createdAt: string;
  updatedAt: string;
}

export type PaymentSourceKind = 'CASH' | 'DEBIT' | 'MEAL';

export interface PaymentSource {
  id: string;
  nickname: string;
  kind: PaymentSourceKind;
  institution?: string;
  lastDigits?: string;
  noLimit: boolean;
  balanceMinor?: Money;
  loadAmountMinor?: Money;
  loadDay?: number;
  autoLoad: boolean;
  lastLoadedPeriod?: string;
  archived: boolean;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  colour?: string;
  appliesTo: 'EXPENSE' | 'CREDIT' | 'BOTH';
  archived: boolean;
}

export interface CardStatement {
  id: string;
  cardId: string;
  cycleStartDate: string;
  cycleEndDate: string;
  statementDate: string;
  dueDate: string;
  calculatedAmountMinor: Money;
  bankStatementAmountMinor?: Money;
  minimumAmountDueMinor?: Money;
  totalPaidMinor: Money;
  status: 'UPCOMING' | 'PENDING' | 'PARTIALLY_PAID' | 'MINIMUM_PAID' | 'FULLY_PAID' | 'OVERDUE';
  notes?: string;
}

export interface RecurringRule {
  id: string;
  cardId: string;
  title: string;
  amountMinor: Money;
  categoryId: string;
  frequency:
    | 'DAILY'
    | 'WEEKLY'
    | 'BIWEEKLY'
    | 'MONTHLY'
    | 'BIMONTHLY'
    | 'QUARTERLY'
    | 'HALF_YEARLY'
    | 'YEARLY'
    | 'CUSTOM';
  interval?: number;
  startDate: string;
  endDate?: string;
  occurrenceLimit?: number;
  nextOccurrenceDate?: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
}

export interface LoanCommitment {
  id: string;
  name: string;
  lender?: string;
  principalMinor: Money;
  installmentMinor: Money;
  debitDay: number;
  startDate: string;
  endDate: string;
  status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED';
  notes?: string;
}

export interface EmiPlan {
  id: string;
  transactionId: string;
  cardId: string;
  convertedAmountMinor: Money;
  remainingPurchaseMinor: Money;
  tenureMonths: number;
  annualRateBasisPoints: number;
  interestType: 'NO_COST' | 'STANDARD' | 'LOW_INTEREST' | 'CUSTOM';
  processingFeeMinor: Money;
  taxMinor: Money;
  startDate: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  notes?: string;
}

export interface EmiInstallment {
  installmentNumber: number;
  statementDate: string;
  dueDate: string;
  principalMinor: Money;
  interestMinor: Money;
  totalMinor: Money;
  remainingPrincipalMinor: Money;
  paid: boolean;
}

export interface AppPreferences {
  setupComplete: boolean;
  currencyCode: string;
  dateFormat: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
  theme: 'LIGHT' | 'DARK' | 'SYSTEM';
  reminderDaysBefore: number;
  monthlyBudgetMinor?: Money;
  budgetCycleStartDay: number;
  autoLockMinutes: number;
}

export interface DashboardSnapshot {
  outstandingMinor: Money;
  statementDueMinor: Money;
  unbilledMinor: Money;
  availableCreditMinor: Money;
  monthlySpendMinor: Money;
  remainingBudgetMinor?: Money;
  utilisationPercent: number;
}
