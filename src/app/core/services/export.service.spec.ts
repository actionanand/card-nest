import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import {
  CardTransaction,
  ConsumerWallet,
  ConsumerWalletEvent,
  ConsumerWalletExpenseReversal,
  SourceTransfer,
} from '../models/domain';
import { ExportDocument } from '../models/export';
import { CardNestStore } from './card-nest-store';
import { ExportService } from './export.service';
import { ConsumerWalletService } from './consumer-wallet.service';
import { SnackbarService } from './snackbar.service';
import { formatMoney } from './money';
import { projectConsolidatedSpending } from './financial-spending';

/** Fictional accounts and amounts only. */
describe('ExportService own-account movements', () => {
  const transfer = (changes: Partial<SourceTransfer>): SourceTransfer => ({
    id: 'transfer',
    kind: 'CASH_WITHDRAWAL',
    fromSourceId: 'bank',
    toSourceId: 'cash',
    amountMinor: 200_000,
    currencyCode: 'INR',
    transferDate: '2026-05-04',
    origin: 'MANUAL',
    createdAt: '2026-05-04T10:00:00Z',
    updatedAt: '2026-05-04T10:00:00Z',
    ...changes,
  });
  const transfers = [
    transfer({ id: 'withdrawal', transferTime: '10:15', reference: 'FICTREF0001' }),
    transfer({
      id: 'loan',
      kind: 'LOAN_REPAYMENT',
      toSourceId: undefined,
      amountMinor: 980_000,
      transferDate: '2026-05-09',
    }),
    transfer({
      id: 'funding',
      kind: 'CARD_SETTLEMENT',
      toSourceId: undefined,
      cardId: 'card',
      paymentTransactionId: 'payment',
      amountMinor: 50_000,
      transferDate: '2026-04-28',
    }),
    transfer({ id: 'other-month', transferDate: '2026-06-02' }),
    transfer({
      id: 'unrelated',
      kind: 'TRANSFER',
      fromSourceId: 'bank-2',
      toSourceId: 'bank-3',
      transferDate: '2026-05-05',
    }),
  ];
  const names: Record<string, string> = {
    bank: 'Fiction bank',
    'bank-2': 'Second fiction bank',
    'bank-3': 'Third fiction bank',
    cash: 'Cash',
    card: 'Fiction card',
  };
  const wallets: ConsumerWallet[] = [
    {
      id: 'amazon-wallet',
      providerId: 'amazon-pay',
      kind: 'STANDARD',
      nickname: 'Synthetic Amazon wallet',
      archived: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  const payment: CardTransaction = {
    id: 'payment',
    cardId: 'card',
    type: 'PAYMENT',
    amountMinor: 50_000,
    currencyCode: 'INR',
    transactionDate: '2026-04-28',
    categoryId: 'payment',
    attachmentIds: [],
    createdAt: '2026-04-28T10:00:00Z',
    updatedAt: '2026-04-28T10:00:00Z',
  };
  let service: ExportService;
  let csv: ReturnType<typeof vi.fn>;
  let pdf: ReturnType<typeof vi.fn>;
  const transactionEntries = signal<readonly CardTransaction[]>([]);
  const walletEventEntries = signal<readonly ConsumerWalletEvent[]>([]);
  const reversalEntries = signal<readonly ConsumerWalletExpenseReversal[]>([]);
  const consolidatedSpending = computed(() =>
    projectConsolidatedSpending(transactionEntries(), walletEventEntries(), reversalEntries()),
  );

  beforeEach(() => {
    transactionEntries.set([]);
    walletEventEntries.set([]);
    reversalEntries.set([]);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: CardNestStore,
          useValue: {
            transfers: signal(transfers),
            transactions: transactionEntries,
            walletFinancialEvents: walletEventEntries,
            walletExpenseReversals: reversalEntries,
            consolidatedSpending,
            incomeHistory: signal([]),
            categories: signal([]),
            budgetCycleStartDay: () => 1,
            monthlyIncomeMinor: () => 0,
            sourceName: (id: string) => names[id] ?? 'Unknown',
            sourceDetail: (id: string) => `${names[id] ?? 'Unknown'} detail`,
          },
        },
        {
          provide: ConsumerWalletService,
          useValue: { wallets: signal(wallets) },
        },
        { provide: SnackbarService, useValue: { show: vi.fn() } },
      ],
    });
    service = TestBed.inject(ExportService);
    const internals = service as unknown as {
      deliverCsv: (content: string, filename: string, title: string) => Promise<void>;
      deliverPdf: (document: ExportDocument, filename: string) => Promise<void>;
    };
    csv = vi.spyOn(internals, 'deliverCsv').mockResolvedValue() as unknown as ReturnType<
      typeof vi.fn
    >;
    pdf = vi.spyOn(internals, 'deliverPdf').mockResolvedValue() as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  const may = { range: { startDate: '2026-05-01', endDate: '2026-05-31' } };
  it('exports signed legacy adjustments and grouping IDs while counting only actual merchant spending in statistics', () => {
    const entry = (
      id: string,
      type: CardTransaction['type'],
      amountMinor: number,
      extra: Partial<CardTransaction> = {},
    ): CardTransaction => ({
      ...payment,
      id,
      type,
      amountMinor,
      transactionDate: '2026-05-10',
      merchant: id,
      categoryId: 'other',
      ...extra,
    });
    const entries = [
      entry('purchase', 'PURCHASE', 20000),
      entry('split', 'ADJUSTMENT', 2000, {
        adjustmentPurpose: 'SPLIT_PAYMENT',
        splitGroupId: 'logical-group',
      }),
      entry('legacy-decreasing', 'ADJUSTMENT', 1000, {
        adjustmentDirection: 'DECREASE',
        adjustmentPurpose: 'LEGACY_MANUAL',
      }),
      entry('fee', 'FEE', 100),
      entry('interest', 'INTEREST', 200),
      entry('refund', 'REFUND', 500),
      entry('cashback', 'CASHBACK', 100),
      entry('ordinary-credit', 'CREDIT', 9000),
      entry('repayment', 'PAYMENT', 9000),
      entry('verified-correction', 'ADJUSTMENT', 88888, {
        adjustmentPurpose: 'BALANCE_RECONCILIATION',
      }),
    ];
    TestBed.inject(CardNestStore).transactions.set(entries);
    service.exportStatistics('ALL', {
      key: '2026-05',
      label: 'May 2026',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      offset: 0,
    });
    const report = pdf.mock.calls[0][0] as ExportDocument;
    expect(report.summary.find((item) => item.label === 'Expense')?.value).toBe(
      formatMoney(20700, 'INR'),
    );
    service.exportTransactionSelection('CSV', entries, 'May 2026', '2026-05', may);
    const content = String(csv.mock.calls[0][0]);
    expect(content).toContain('"Payment group ID"');
    expect(content).toContain('logical-group');
    const legacyRow = content.split('\r\n').find((line) => line.includes('legacy-decreasing'))!;
    expect(legacyRow).toContain('"Credit"');
    expect(legacyRow).toContain('Legacy adjustment');
    service.exportTransactionSelection('PDF', entries, 'May 2026', '2026-05', may);
    const statement = pdf.mock.calls[1][0] as ExportDocument;
    expect(statement.summary.find((item) => item.label === 'Net merchant spending')?.value).toBe(
      formatMoney(20700, 'INR'),
    );
  });

  it('exports a transfers-only month by its range and source filter, each movement once', () => {
    service.exportTransactionSelection('CSV', [], 'May 2026', '2026-05', {
      ...may,
      sourceId: 'bank',
    });
    const content = String(csv.mock.calls[0][0]);
    const lines = content.split('\r\n').slice(1);
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes('Cash withdrawal'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('Loan repayment'))).toHaveLength(1);
    expect(content).toContain('"2026-05-04","10:15"');
    expect(content).toContain('"Fiction bank (Fiction bank detail)","Cash (Cash detail)"');
    expect(content).toContain('Ref FICTREF0001');
    expect(content).toContain('Transfer / settlement (not spending)');
    expect(content).not.toContain('other-month');
    expect(content).not.toContain('Second fiction bank');
  });

  it('PDF lists movements in their own section and keeps them out of spending totals', () => {
    service.exportTransactionSelection('PDF', [], 'May 2026', '2026-05', may);
    const document = pdf.mock.calls[0][0] as ExportDocument;
    expect(document.summary.find((item) => item.label === 'Spent / charged')?.value).toBe(
      document.summary.find((item) => item.label === 'Payments / credits')?.value,
    );
    expect(document.summary.find((item) => item.label === 'Transactions')?.value).toBe('0');
    const section = document.sections.find(
      (item) => item.title === 'Transfers & settlements (not spending)',
    )!;
    expect(section.headers).toEqual([
      'Date / time',
      'Movement',
      'From',
      'To / purpose',
      'Reference',
      'Amount',
    ]);
    // 'ALL' sources in May: withdrawal, loan repayment and the unrelated bank transfer.
    expect(section.rows).toHaveLength(3);
    expect(section.rows.map((row) => row.cells[3])).toContain('Loan repayment');
  });

  it('includes funding linked to an exported card payment once, even outside the range', () => {
    service.exportTransactionSelection('CSV', [payment], 'Statement', 'statement');
    const lines = String(csv.mock.calls[0][0]).split('\r\n').slice(1);
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes('Credit-card settlement'))).toHaveLength(1);
    expect(lines.some((line) => line.includes('Credit-card settlement: Fiction card'))).toBe(true);
    service.exportTransactionSelection('CSV', [payment], 'May', '2026-05', {
      range: { startDate: '2026-04-01', endDate: '2026-04-30' },
      sourceId: 'bank',
    });
    expect(
      String(csv.mock.calls[1][0])
        .split('\r\n')
        .filter((line) => line.includes('Credit-card settlement')),
    ).toHaveLength(1);
  });

  it('all-time export filtered by source includes every movement of that source', () => {
    service.exportTransactions('CSV', 'ALL', [], 'bank');
    const lines = String(csv.mock.calls[0][0]).split('\r\n').slice(1);
    expect(lines).toHaveLength(4);
    expect(lines.some((line) => line.includes('Second fiction bank'))).toBe(false);
  });

  it('exports wallet purchases and refunds separately from consolidated spending', () => {
    const walletEvents: ConsumerWalletEvent[] = [
      {
        id: 'wallet-purchase',
        walletId: 'amazon-wallet',
        eventType: 'PURCHASE',
        eventDate: '2026-05-12',
        amountMinor: 10000,
        balanceDeltaMinor: -10000,
        categoryId: 'other',
        merchant: 'Synthetic wallet shop',
        createdAt: '2026-05-12T10:00:00Z',
        updatedAt: '2026-05-12T10:00:00Z',
      },
      {
        id: 'wallet-refund',
        walletId: 'amazon-wallet',
        eventType: 'REFUND',
        eventDate: '2026-05-14',
        amountMinor: 4000,
        balanceDeltaMinor: 4000,
        reversalOfEventId: 'wallet-purchase',
        createdAt: '2026-05-14T10:00:00Z',
        updatedAt: '2026-05-14T10:00:00Z',
      },
    ];
    service.exportTransactionSelection('CSV', [payment], 'May 2026', '2026-05', may, walletEvents);
    const content = String(csv.mock.calls[0][0]);
    expect(content).toContain('Synthetic wallet shop');
    expect(content).toContain('Wallet purchase');
    expect(content).toContain('Wallet refund');
    expect(content).toContain('0.00');
    expect(content).toContain('wallet-purchase');
    expect(content).toContain('wallet-refund');

    service.exportTransactionSelection('PDF', [payment], 'May 2026', '2026-05', may, walletEvents);
    const document = pdf.mock.calls[0][0] as ExportDocument;
    expect(document.summary.find((item) => item.label === 'Transactions')?.value).toBe('1');
    expect(
      document.summary.find((item) => item.label === 'Wallet activities (informational)')?.value,
    ).toBe('2');
    expect(document.summary.find((item) => item.label === 'Net merchant spending')?.value).toBe(
      formatMoney(0, 'INR'),
    );
    const walletSection = document.sections.find((item) =>
      item.title.includes('Consumer wallet activity'),
    )!;
    expect(walletSection.rows.map((row) => row.cells[6])).toEqual([
      formatMoney(0, 'INR'),
      formatMoney(0, 'INR'),
    ]);
    expect(
      walletSection.stats?.find((item) => item.label === 'Net wallet spending (informational)')
        ?.value,
    ).toBe(formatMoney(6000, 'INR'));
  });
  it('exports durable UPI Lite funded-principal reversals as dated expense contributions', () => {
    const loadDebit: CardTransaction = {
      ...payment,
      id: 'wallet-load-debit',
      cardId: 'bank',
      type: 'PURCHASE',
      amountMinor: 32000,
      transactionDate: '2026-10-12',
      categoryId: 'other',
    };
    const bankReturn: CardTransaction = {
      ...payment,
      id: 'bank-return-credit',
      cardId: 'bank',
      type: 'CREDIT',
      amountMinor: 10000,
      transactionDate: '2026-11-03',
      categoryId: 'contra-expenses',
    };
    const fundedLoad: ConsumerWalletEvent = {
      id: 'funded-load',
      walletId: 'amazon-wallet',
      eventType: 'FUNDED_LOAD',
      eventDate: '2026-10-12',
      amountMinor: 30000,
      balanceDeltaMinor: 30000,
      debitAmountMinor: 32000,
      fundingSourceId: 'bank',
      fundingCategoryId: 'other',
      sourceTransactionId: loadDebit.id,
      createdAt: '2026-10-12T10:00:00Z',
      updatedAt: '2026-10-12T10:00:00Z',
    };
    const returnEvent: ConsumerWalletEvent = {
      id: 'upi-return',
      walletId: 'amazon-wallet',
      eventType: 'UPI_LITE_RETURN',
      eventDate: '2026-11-03',
      amountMinor: 10000,
      balanceDeltaMinor: -10000,
      sourceTransactionId: bankReturn.id,
      returnSourceId: 'bank',
      createdAt: '2026-11-03T10:00:00Z',
      updatedAt: '2026-11-03T10:00:00Z',
    };
    transactionEntries.set([loadDebit, bankReturn]);
    walletEventEntries.set([fundedLoad, returnEvent]);
    reversalEntries.set([
      {
        returnEventId: returnEvent.id,
        creditEventId: fundedLoad.id,
        fundedLoadEventId: fundedLoad.id,
        reversedMinor: 6000,
        createdAt: '2026-11-03T10:00:00Z',
      },
    ]);
    const range = { range: { startDate: '2026-10-01', endDate: '2026-11-30' }, sourceId: 'ALL' };

    service.exportTransactionSelection(
      'CSV',
      [loadDebit, bankReturn],
      'Oct-Nov',
      '2026-10-11',
      range,
      [fundedLoad, returnEvent],
    );
    const csvContent = String(csv.mock.calls[0][0]);
    expect(csvContent).toContain('UPI Lite funded-principal return');
    expect(csvContent).toContain('Expense reversal');
    expect(csvContent).toContain('-60.00');

    service.exportTransactionSelection(
      'PDF',
      [loadDebit, bankReturn],
      'Oct-Nov',
      '2026-10-11',
      range,
      [fundedLoad, returnEvent],
    );
    const document = pdf.mock.calls[0][0] as ExportDocument;
    expect(document.summary.find((item) => item.label === 'Net merchant spending')?.value).toBe(
      formatMoney(26000, 'INR'),
    );
    const reversalSection = document.sections.find((section) =>
      section.title.includes('Wallet-derived consolidated expense contributions'),
    );
    expect(reversalSection?.rows[0].cells).toContain(formatMoney(-6000, 'INR'));
  });
});
