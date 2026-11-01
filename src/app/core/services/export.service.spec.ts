import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { CardTransaction, SourceTransfer } from '../models/domain';
import { ExportDocument } from '../models/export';
import { CardNestStore } from './card-nest-store';
import { ExportService } from './export.service';
import { SnackbarService } from './snackbar.service';
import { formatMoney } from './money';

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

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: CardNestStore,
          useValue: {
            transfers: signal(transfers),
            transactions: signal([]),
            incomeHistory: signal([]),
            categories: signal([]),
            budgetCycleStartDay: () => 1,
            monthlyIncomeMinor: () => 0,
            sourceName: (id: string) => names[id] ?? 'Unknown',
            sourceDetail: (id: string) => `${names[id] ?? 'Unknown'} detail`,
          },
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
});
