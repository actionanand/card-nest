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

export interface CardImportantLink {
  id: string;
  label: string;
  url: string;
}

export interface CardBenefit {
  id: string;
  name: string;
  note?: string;
}

export interface CreditCard {
  id: string;
  nickname: string;
  issuerName: string;
  /** Last 5 digits for American Express; last 4 digits for every other network. */
  lastDigits: string;
  encryptedFullNumber?: string;
  encryptedCvv?: string;
  cardholderName?: string;
  network: CardNetwork;
  /** Optional international acceptance network printed on the card, when different. */
  globalNetwork?: CardNetwork;
  /** True when the issuer provides this as a non-physical/e-credit card. */
  isVirtual?: boolean;
  customNetwork?: string;
  subtype?: string;
  benefits?: readonly CardBenefit[];
  importantLinks?: readonly CardImportantLink[];
  relationshipGroupId?: string;
  theme: string;
  expiryMonth?: number;
  expiryYear?: number;
  statementDay: number;
  /** Undefined is treated as true for cards restored from older backups. */
  excludeStatementDayTransactions?: boolean;
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
  archivedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CardTransaction {
  id: string;
  cardId: string;
  type: TransactionType;
  adjustmentDirection?: 'INCREASE' | 'DECREASE';
  adjustmentPurpose?: 'SPLIT_PAYMENT' | 'LEGACY_MANUAL' | 'BALANCE_RECONCILIATION';
  amountMinor: Money;
  currencyCode: string;
  originalAmountMinor?: Money;
  originalCurrencyCode?: string;
  foreignFeeMinor?: Money;
  transactionDate: string;
  transactionTime?: string;
  /** Optional verified network reference, used only as supporting reconciliation evidence. */
  reference?: string;
  merchant?: string;
  categoryId: string;
  notes?: string;
  relatedTransactionId?: string;
  taxIncluded?: boolean;
  taxMinor?: Money;
  splitGroupId?: string;
  splitOriginalAmountMinor?: Money;
  recurringRuleId?: string;
  generatedOccurrenceDate?: string;
  attachmentIds: readonly string[];
  emiPlanId?: string;
  emiInstallmentNumber?: number;
  emiTenureMonths?: number;
  emiOriginalAmountMinor?: Money;
  emiCancelled?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Historical SMS rows can be recorded without replaying a balance already in the cutover snapshot. */
  sourceBalanceApplied?: boolean;
  /** Originating bank identity for Bank/UPI entries; never a full account number. */
  bankName?: string;
  accountSuffix?: string;
  origin?: 'SMS' | 'MANUAL';
  /** Exact Bank/Cash balance change applied by this entry, so edits and deletes reverse it once. */
  balanceEffect?: AppliedBalanceEffect;
  /** User's answer for an untimed entry on the balance-confirmation day. */
  balanceTiming?: BalanceTiming;
  /** When `balanceTiming` was answered; an answer older than the current balance is stale. */
  balanceTimingAt?: string;
  paymentMethod?: SmsPaymentMethod;
  paymentMethodDetail?: SmsPaymentMethodDetail;
  paymentMethodCustom?: string;
  smsAdditionalComment?: string;
}

/** A relationship only: its total is never posted to the financial ledger. */
export interface PaymentGroup {
  id: string;
  kind: 'DIVISION' | 'PAYMENTS';
  anchorId: string | null;
  title: string;
  currency: string;
  billTotalMinor: number | null;
  createdAt: string;
  updatedAt: string;
  memberIds: readonly string[];
}

export type BalanceTiming = 'AFTER_BASELINE' | 'INCLUDED_IN_BASELINE';

export type SmsPaymentMethod =
  'NONE' | 'UPI' | 'UPI_GLOBAL' | 'CARD' | 'CARD_TAP' | 'NEFT' | 'CHEQUE' | 'SWIFT_WIRE';

export type SmsPaymentMethodDetail =
  | 'BHIM_APP'
  | 'GPAY'
  | 'PHONEPE'
  | 'KIWI'
  | 'SLICE'
  | 'CRED'
  | 'AMAZON'
  | 'PAYTM'
  | 'PAYZAPP'
  | 'BHUTAN'
  | 'CAMBODIA'
  | 'FRANCE'
  | 'GREECE'
  | 'MALDIVES'
  | 'MAURITIUS'
  | 'NEPAL'
  | 'QATAR'
  | 'SINGAPORE'
  | 'SRI_LANKA'
  | 'UAE'
  | 'MAGNETIC_STRIPE'
  | 'EMV_CHIP'
  | 'KEYED_IN'
  | 'ONLINE'
  | 'ATM_WITHDRAWAL'
  | 'INTERNATIONAL'
  | 'INTERNATIONAL_ATM'
  | 'INTERNATIONAL_ONLINE'
  | 'TAP_CARD'
  | 'TAP_WATCH'
  | 'TAP_GPAY'
  | 'TAP_APPLE'
  | 'TAP_SAMSUNG'
  | 'TAP_PAYTM'
  | 'TAP_CRED'
  | 'TAP_IMOBILE'
  | 'TAP_PAYZAPP'
  | 'TAP_RING';

export interface AppliedBalanceEffect {
  sourceId: string;
  deltaMinor: Money;
  appliedAt: string;
}

export type SourceTransferKind =
  'TRANSFER' | 'CASH_WITHDRAWAL' | 'CASH_DEPOSIT' | 'CARD_SETTLEMENT' | 'LOAN_REPAYMENT';

/** One logical movement between owned sources, or bank funding for a card/loan repayment. */
export interface SourceTransfer {
  id: string;
  kind: SourceTransferKind;
  fromSourceId: string;
  toSourceId?: string;
  cardId?: string;
  paymentTransactionId?: string;
  amountMinor: Money;
  currencyCode: string;
  transferDate: string;
  transferTime?: string;
  description?: string;
  notes?: string;
  reference?: string;
  origin: 'SMS' | 'MANUAL';
  effects?: readonly AppliedBalanceEffect[];
  balanceTiming?: BalanceTiming;
  balanceTimingAt?: string;
  paymentMethod?: SmsPaymentMethod;
  paymentMethodDetail?: SmsPaymentMethodDetail;
  paymentMethodCustom?: string;
  smsAdditionalComment?: string;
  createdAt: string;
  updatedAt: string;
}

/** Audit record for an explicit balance setting; never income or spending. */
export interface SourceBalanceAdjustment {
  id: string;
  sourceId: string;
  reason: 'OPENING' | 'CORRECTION' | 'REBASE' | 'MIGRATION' | 'SMS_RECONCILIATION';
  previousMinor?: Money;
  newMinor: Money;
  correctionMinor: Money;
  note?: string;
  createdAt: string;
}

export interface BankCashTrackingSettings {
  enabled: boolean;
  askCardSettlementFunding: boolean;
  activatedAt?: string;
  disabledAt?: string;
}

export type PaymentSourceKind = 'CASH' | 'DEBIT' | 'MEAL' | 'FASTAG';

export interface PaymentSource {
  id: string;
  nickname: string;
  kind: PaymentSourceKind;
  institution?: string;
  lastDigits?: string;
  /** Masked display identifier only; complete account numbers are never persisted here. */
  accountMask?: string;
  /** One-way fingerprint used only to distinguish same-bank accounts with matching suffixes. */
  accountFingerprint?: string;
  ifscCode?: string;
  isPrimaryBank?: boolean;
  noLimit: boolean;
  balanceMinor?: Money;
  loadAmountMinor?: Money;
  loadDay?: number;
  autoLoad: boolean;
  lastLoadedPeriod?: string;
  vehicleNumber?: string;
  balanceCutoverAt?: string;
  balanceSnapshotMinor?: Money;
  balanceCutoverReason?: 'MANUAL' | 'SMS_RECONCILIATION';
  /** First verified SMS repair. Never overwritten; it is the one-time idempotency marker. */
  balanceReconciliation?: WalletBalanceReconciliation;
  /** Most recent verified SMS reconciliation; identifies the current balance anchor. */
  latestBalanceReconciliation?: WalletBalanceReconciliation;
  archived: boolean;
}

export interface WalletBalanceReconciliation {
  candidateId: string;
  transactionId: string;
  eventAt: string;
  eventAmountMinor: Money;
  eventType: 'TOPUP' | 'PURCHASE';
  savedBalanceMinor: Money;
  predictedBalanceMinor: Money;
  reportedBalanceMinor: Money;
  correctionMinor: Money;
  recordedAt: string;
}

export interface MonthlyIncomeRecord {
  periodKey: string;
  cycleStartDate: string;
  cycleEndDate: string;
  amountMinor: Money;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  colour?: string;
  appliesTo: 'EXPENSE' | 'CREDIT' | 'BOTH';
  archived: boolean;
  monthlyLimitMinor?: Money;
  showLimit?: boolean;
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
  reconciledPaymentId?: string;
  reconciledPaymentAmountMinor?: Money;
}

export interface RecurringRule {
  id: string;
  cardId: string;
  title: string;
  amountMinor: Money;
  categoryId: string;
  transactionType?: TransactionType;
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
  /** Undefined is treated as false for commitments created before ownership tracking. */
  forFriendsOrRelatives?: boolean;
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
  originalTransactionDate?: string;
  originalMerchant?: string;
  closedAt?: string;
  notes?: string;
  /** Undefined is treated as false for plans created before ownership tracking. */
  forFriendsOrRelatives?: boolean;
}

export interface EmiInstallment {
  id?: string;
  emiPlanId?: string;
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
  dateFormat:
    'DD-MM-YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'MMM-DD-YYYY' | 'DD-MMM-YYYY';
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
