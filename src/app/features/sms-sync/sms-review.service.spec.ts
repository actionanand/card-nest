import { TestBed } from '@angular/core/testing';
import { EnvironmentInjector, Injector, runInInjectionContext, signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { TransactionsPage } from '../transactions/transactions';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Capacitor } from '@capacitor/core';
import { DATABASE_MIGRATIONS } from '../../core/data/migrations';
import { DatabaseSession, SqliteDatabase } from '../../core/data/sqlite-database';
import { CardNestStore } from '../../core/services/card-nest-store';
import { AppLockService } from '../../core/services/app-lock.service';
import { CardTransaction, CreditCard, PaymentSource } from '../../core/models/domain';
import { SmsReviewService } from './sms-review.service';
import {
  SmsCandidate,
  SmsEvidence,
  existingSuggestions,
  eligibleSources,
  ledgerType,
  transferRelationship,
} from './sms-model';

/** Actual SQLite constraints/rollback, not an array pretending that ledger writes succeeded. */
describe('SMS approved import integrity', () => {
  let sql: DatabaseSync;
  let service: SmsReviewService;
  let queue: Promise<unknown>;
  const card: CreditCard = {
    id: 'fiction-card',
    nickname: 'Fiction',
    issuerName: 'AMEX',
    lastDigits: '54321',
    network: 'AMERICAN_EXPRESS',
    theme: 'green',
    statementDay: 1,
    dueDateMode: 'DAYS_AFTER_STATEMENT',
    daysAfterStatement: 20,
    adjustDueDateOnWeekend: false,
    currencyCode: 'INR',
    openingBalanceMinor: 0,
    remindToSettle: false,
    annualFeeEnabled: false,
    emergencyPhones: [],
    supportEmails: [],
    archived: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const sources = signal<readonly PaymentSource[]>([]);
  const transactions = signal<readonly CardTransaction[]>([]);
  const lock = { locked: signal(false), foreground: signal(true) };
  const store = {
    cards: signal([card]),
    paymentSources: sources,
    transactions,
    emiInstallments: signal([]),
    acceptCommittedImport: (
      transaction: CardTransaction | null,
      wallets: readonly PaymentSource[],
    ) => {
      if (transaction)
        transactions.update((items) => [
          transaction,
          ...items.filter((item) => item.id !== transaction.id),
        ]);
      sources.set(wallets);
    },
    acceptCommittedStatement: vi.fn(),
  };
  function rows<T extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ): readonly T[] {
    return sql.prepare(statement).all(...(values as SQLInputValue[])) as T[];
  }
  function run(statement: string, values: readonly unknown[] = []): number {
    return Number(sql.prepare(statement).run(...(values as SQLInputValue[])).changes);
  }
  const evidence = (overrides: Partial<SmsEvidence> = {}): SmsEvidence => ({
    id: 'a'.repeat(64),
    providerId: '12',
    kind: 'PURCHASE',
    amountMinor: 45000,
    currency: 'INR',
    eventDate: '2026-10-18',
    eventAt: '2026-10-18T12:00:00Z',
    receivedAt: 1792324800000,
    dateFallback: false,
    evidence: 'Synthetic',
    ...overrides,
  });
  function stage(item: SmsEvidence): SmsCandidate {
    run(
      `INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES(?,?,?,?,'PENDING',?,'now')`,
      [item.id, item.providerId, item.eventAt, item.kind, JSON.stringify(item)],
    );
    return { id: item.id, kind: item.kind, eventAt: item.eventAt, state: 'PENDING', item };
  }
  beforeEach(() => {
    sql = new DatabaseSync(':memory:');
    queue = Promise.resolve();
    sql.exec('PRAGMA foreign_keys=ON');
    for (const migration of DATABASE_MIGRATIONS)
      for (const statement of migration.statements) sql.exec(statement);
    for (const id of ['other', 'payment', 'contra-expenses', 'groceries'])
      run(`INSERT INTO categories(id,name,icon,applies_to) VALUES (?,?,'test','BOTH')`, [id, id]);
    run(
      `INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,'now','now')`,
      [
        card.id,
        card.nickname,
        card.issuerName,
        card.lastDigits,
        card.network,
        JSON.stringify(card),
      ],
    );
    transactions.set([]);
    sources.set([]);
    lock.locked.set(false);
    lock.foreground.set(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        SmsReviewService,
        { provide: CardNestStore, useValue: store },
        { provide: AppLockService, useValue: lock },
        {
          provide: SqliteDatabase,
          useValue: {
            ready: signal(true),
            query: async (statement: string, values: readonly unknown[] = []) =>
              rows(statement, values),
            run: async (statement: string, values: readonly unknown[] = []) =>
              run(statement, values),
            atomic: <T>(work: (session: DatabaseSession) => Promise<T>) => {
              const operation = queue.then(async () => {
                sql.exec('BEGIN');
                try {
                  const value = await work({
                    query: async <R extends Record<string, unknown>>(
                      s: string,
                      v: readonly unknown[] = [],
                    ) => rows<R>(s, v),
                    run: async (s, v = []) => run(s, v),
                  });
                  sql.exec('COMMIT');
                  return value;
                } catch (error: unknown) {
                  sql.exec('ROLLBACK');
                  throw error;
                }
              });
              queue = operation.catch(() => undefined);
              return operation;
            },
          },
        },
      ],
    });
    service = TestBed.inject(SmsReviewService);
    vi.spyOn(service, 'refresh').mockResolvedValue();
  });
  afterEach(() => {
    sql.close();
    vi.restoreAllMocks();
  });
  const count = (table: string) => rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

  it('persists edited purchase fields in SQL, JSON, real store and Activity without a reload', async () => {
    const actual = TestBed.runInInjectionContext(() => new CardNestStore());
    actual.cards.set([card]);
    actual.paymentSources.set([]);
    actual.transactions.set([]);
    vi.spyOn(store, 'acceptCommittedImport').mockImplementation((t, s) =>
      actual.acceptCommittedImport(t, s),
    );
    const route = {
      snapshot: { queryParamMap: convertToParamMap({}) },
      queryParamMap: of(convertToParamMap({})),
    };
    const injector = Injector.create({
      providers: [
        { provide: CardNestStore, useValue: actual },
        { provide: ActivatedRoute, useValue: route },
      ],
      parent: TestBed.inject(EnvironmentInjector),
    });
    const activity = runInInjectionContext(injector, () => new TransactionsPage());
    expect(activity.visibleTransactions()).toEqual([]);
    const candidate = stage(evidence());
    await service.approve(
      candidate,
      card.id,
      67890,
      'Edited synthetic shop',
      '',
      'PENDING',
      false,
      '',
      0,
      { transactionDate: '2026-09-03', categoryId: 'groceries' },
    );
    const [row] = rows<{
      payload: string;
      card_id: string;
      amount_minor: number;
      category_id: string;
      transaction_date: string;
    }>('SELECT * FROM card_transactions');
    const saved = JSON.parse(row.payload) as CardTransaction;
    expect([row.card_id, row.amount_minor, row.category_id, row.transaction_date]).toEqual([
      card.id,
      67890,
      'groceries',
      '2026-09-03',
    ]);
    expect(saved).toMatchObject({
      cardId: card.id,
      amountMinor: 67890,
      categoryId: 'groceries',
      transactionDate: '2026-09-03',
      merchant: 'Edited synthetic shop',
    });
    expect(actual.transactions()).toEqual([saved]);
    expect(activity.visibleTransactions()).toEqual([saved]);
    expect(actual.cardOutstanding(card.id)).toBe(67890);
    expect(rows<{ state: string }>('SELECT state FROM sms_candidates')[0].state).toBe('IMPORTED');
    injector.destroy();
  });
  it('reports durable success when inbox refresh fails after commit and retry cannot post twice', async () => {
    vi.mocked(service.refresh).mockRejectedValue(new Error('Synthetic bridge unavailable'));
    const candidate = stage(evidence());
    await expect(service.approve(candidate, card.id, 45000, 'Demo')).resolves.toBeUndefined();
    expect(service.notice()).toContain('approved and saved');
    expect(service.notice()).toContain('could not refresh');
    expect(count('card_transactions')).toBe(1);
    await service.approve(candidate, card.id, 45000, 'Demo');
    expect(count('card_transactions')).toBe(1);
  });
  it('reconciles an actual historical manual purchase without inserting a second purchase', async () => {
    const manual: CardTransaction = {
      id: 'manual-history',
      cardId: card.id,
      type: 'PURCHASE',
      amountMinor: 45000,
      currencyCode: 'INR',
      transactionDate: '2026-10-18',
      merchant: 'Manual demo',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    run(
      'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        manual.id,
        card.id,
        'other',
        'PURCHASE',
        manual.amountMinor,
        'INR',
        manual.transactionDate,
        JSON.stringify(manual),
        'now',
        'now',
      ],
    );
    transactions.set([manual]);
    const candidate = stage(evidence());
    await expect(service.approve(candidate, card.id, 45000, 'Demo')).rejects.toThrow('Match it');
    // Editing away the original date cannot hide an existing manual duplicate.
    await expect(
      service.approve(candidate, card.id, 45000, 'Demo', '', 'PENDING', false, '', 0, {
        transactionDate: '2026-08-01',
      }),
    ).rejects.toThrow('Match it');
    await service.approve(candidate, card.id, 45000, 'Demo', manual.id);
    expect(count('card_transactions')).toBe(1);
    expect(transactions()).toEqual([manual]);
    expect(
      rows<{ state: string; transaction_id: string }>(
        'SELECT state,transaction_id FROM sms_candidates',
      )[0],
    ).toMatchObject({ state: 'MATCHED_EXISTING', transaction_id: manual.id });
  });
  it('detects duplicates using the final edited amount and date too', async () => {
    await service.approve(stage(evidence()), card.id, 45000, 'Demo');
    const other = stage(
      evidence({
        id: 'b'.repeat(64),
        amountMinor: 1,
        eventDate: '2026-08-01',
        eventAt: '2026-08-01T12:00:00Z',
      }),
    );
    await expect(
      service.approve(other, card.id, 45000, 'Demo', '', 'PENDING', false, '', 0, {
        transactionDate: '2026-10-18',
      }),
    ).rejects.toThrow('Possible existing');
    expect(count('card_transactions')).toBe(1);
  });
  it('edited wallet dates cannot replay a balance included in a cutover snapshot', async () => {
    const wallet: PaymentSource = {
      id: 'meal-date',
      nickname: 'Synthetic wallet',
      kind: 'MEAL',
      archived: false,
      noLimit: false,
      autoLoad: false,
      balanceMinor: 50000,
      balanceCutoverAt: '2026-10-17T00:00:00Z',
    };
    sources.set([wallet]);
    const candidate = stage(evidence({ kind: 'PLUXEE_PURCHASE' }));
    const edits = { transactionDate: '2026-10-16', categoryId: 'other' };
    await expect(
      service.approve(candidate, wallet.id, 45000, 'Demo', '', 'PENDING', false, '', 0, edits),
    ).rejects.toThrow('snapshot');
    await service.approve(
      candidate,
      wallet.id,
      45000,
      'Demo',
      '',
      'RETAIN_BALANCE',
      false,
      '',
      0,
      edits,
    );
    expect(sources()[0].balanceMinor).toBe(50000);
    const row = rows<{ transaction_date: string; payload: string }>(
      'SELECT * FROM card_transactions',
    )[0];
    expect(row.transaction_date).toBe('2026-10-16');
    expect(JSON.parse(row.payload)).toMatchObject({
      transactionDate: '2026-10-16',
      sourceBalanceApplied: false,
    });
  });
  it('invalid category or calendar date leaves candidate pending and ledger untouched', async () => {
    const candidate = stage(evidence());
    await expect(
      service.approve(candidate, card.id, 45000, 'Demo', '', 'PENDING', false, '', 0, {
        categoryId: 'missing',
      }),
    ).rejects.toThrow('category');
    await expect(
      service.approve(candidate, card.id, 45000, 'Demo', '', 'PENDING', false, '', 0, {
        transactionDate: '2026-02-31',
      }),
    ).rejects.toThrow('date');
    expect(count('card_transactions')).toBe(0);
    expect(count('sms_reconciliation')).toBe(0);
  });
  it('counts saved and pending independently and filters original local date, merchant/reference and source evidence', async () => {
    const a = stage(
      evidence({
        eventDate: '2026-10-18',
        eventAt: '2026-10-17T20:00:00Z',
        merchant: 'DEMO STORE',
        cardDigits: '4321',
      }),
    );
    stage(evidence({ id: 'b'.repeat(64), merchant: 'OTHER', reference: 'SYNTHREF4321' }));
    run("UPDATE sms_candidates SET state='REJECTED' WHERE id=?", [a.id]);
    vi.mocked(service.refresh).mockRestore();
    vi.spyOn(service, 'refreshAccess').mockResolvedValue();
    // This case exercises the real SQL filtering after an empty native handoff.
    vi.spyOn(service as unknown as { handoff(): Promise<void> }, 'handoff').mockResolvedValue();
    await service.filterReview({
      state: 'ALL',
      kind: 'ALL',
      search: 'DEMO',
      source: '4321',
      from: '2026-10-18',
      to: '2026-10-18',
    });
    expect(service.savedTotal()).toBe(2);
    expect(service.pendingTotal()).toBe(1);
    expect(service.total()).toBe(1);
    expect(service.candidates()[0].state).toBe('REJECTED');
    await service.filterReview({ state: 'ALL', kind: 'ALL', search: '', source: '4321' });
    expect(service.total()).toBe(1); // a reference suffix is not a source identifier
    await service.filterReview({ state: 'PENDING', kind: 'ALL', search: '', source: '' });
    expect(service.total()).toBe(1);
    expect(service.candidates()[0].id).toBe('b'.repeat(64));
  });

  it('double approval and commit-before-ack retries create one entry and one binding', async () => {
    const candidate = stage(evidence());
    await Promise.all([
      service.approve(candidate, card.id, 45000, 'DEMO'),
      service.approve(candidate, card.id, 45000, 'DEMO'),
    ]);
    await service.approve(candidate, card.id, 45000, 'DEMO');
    expect(count('card_transactions')).toBe(1);
    expect(count('sms_reconciliation')).toBe(1);
    expect(transactions()).toHaveLength(1);
  });
  it('constraint failure rolls back ledger, binding and UI state together', async () => {
    sql.exec(
      `CREATE TRIGGER fail_binding BEFORE INSERT ON sms_reconciliation BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END`,
    );
    const candidate = stage(evidence());
    await expect(service.approve(candidate, card.id, 45000, 'DEMO')).rejects.toThrow(
      'synthetic disk failure',
    );
    expect(count('card_transactions')).toBe(0);
    expect(transactions()).toHaveLength(0);
    expect(rows<{ state: string }>('SELECT state FROM sms_candidates')[0].state).toBe('PENDING');
  });
  it('reject survives restaging and cannot be imported until deliberately reopened', async () => {
    const candidate = stage(evidence());
    await service.decide(candidate, 'REJECTED');
    run(
      `INSERT OR IGNORE INTO sms_candidates(id,provider_id,event_at,kind,state,updated_at) VALUES(?,?,?,?,'PENDING','now')`,
      [candidate.id, '13', candidate.eventAt, candidate.kind],
    );
    await expect(service.approve(candidate, card.id, 45000, 'DEMO')).rejects.toThrow('Reopen');
    expect(count('card_transactions')).toBe(0);
  });
  it('informational, initiation and unknown loan events never create ledger entries', async () => {
    for (const [index, kind] of (
      [
        'BANK_DEBIT',
        'BANK_CREDIT',
        'BANK_TRANSFER',
        'PAYMENT_INITIATED',
        'STATEMENT',
        'PAYMENT_REMINDER',
        'LOAN_DEBIT',
        'LOAN_REMINDER',
      ] as const
    ).entries()) {
      const candidate = stage(evidence({ id: String(index).repeat(64), kind }));
      await expect(service.approve(candidate, card.id, 45000, 'DEMO')).rejects.toThrow(
        'evidence only',
      );
    }
    expect(count('card_transactions')).toBe(0);
  });
  it('records actual overpayment and explicitly settles only the selected statement', async () => {
    const candidate = stage(evidence({ kind: 'CARD_PAYMENT_RECEIVED', amountMinor: 431700 }));
    await service.approve(
      candidate,
      card.id,
      431700,
      'Issuer receipt',
      '',
      'FULLY_PAID',
      false,
      '2026-10-01',
      430700,
    );
    expect(transactions()[0].amountMinor).toBe(431700);
    const statement = JSON.parse(
      rows<{ payload: string }>('SELECT payload FROM statements')[0].payload,
    ) as { totalPaidMinor: number; bankStatementAmountMinor: number };
    expect(statement.totalPaidMinor).toBe(431700);
    expect(statement.bankStatementAmountMinor).toBe(430700);
    expect(count('card_transactions')).toBe(1);
  });
  it('matching a manual payment adds evidence without another monetary effect', async () => {
    const first = stage(evidence({ kind: 'CARD_PAYMENT_RECEIVED' }));
    await service.approve(first, card.id, 45000, 'Manual equivalent');
    const second = stage(evidence({ id: 'b'.repeat(64), kind: 'CARD_PAYMENT_RECEIVED' }));
    await expect(service.approve(second, card.id, 45000, 'Same')).rejects.toThrow(
      'Possible existing',
    );
    await service.approve(second, card.id, 45000, 'Same', transactions()[0].id);
    expect(count('card_transactions')).toBe(1);
    expect(count('sms_reconciliation')).toBe(2);
  });
  it('locks and web platform block all approvals', async () => {
    const candidate = stage(evidence());
    lock.locked.set(true);
    await expect(service.approve(candidate, card.id, 45000, 'DEMO')).rejects.toThrow('Unlock');
    lock.locked.set(false);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    await expect(service.approve(candidate, card.id, 45000, 'DEMO')).rejects.toThrow('Android');
    expect(count('card_transactions')).toBe(0);
  });
  it('preserves historical meal snapshot, and keeps different vehicle balances independent', async () => {
    const wallets: PaymentSource[] = [
      {
        id: 'meal',
        nickname: 'DEMO meal',
        kind: 'MEAL',
        autoLoad: false,
        archived: false,
        noLimit: false,
        balanceMinor: 50000,
        balanceCutoverAt: '2026-10-19T00:00:00Z',
      },
      {
        id: 'tag-a',
        nickname: 'DEMO A',
        kind: 'FASTAG',
        vehicleNumber: 'KA01AB1234',
        autoLoad: false,
        archived: false,
        noLimit: false,
        balanceMinor: 10000,
      },
      {
        id: 'tag-b',
        nickname: 'DEMO B',
        kind: 'FASTAG',
        vehicleNumber: 'KA02CD5678',
        autoLoad: false,
        archived: false,
        noLimit: false,
        balanceMinor: 20000,
      },
    ];
    sources.set(wallets);
    run(`INSERT INTO app_preferences VALUES ('payment_sources',?)`, [JSON.stringify(wallets)]);
    const historical = stage(evidence({ kind: 'PLUXEE_TOPUP' }));
    await expect(service.approve(historical, 'meal', 45000, 'Load')).rejects.toThrow('snapshot');
    await service.approve(historical, 'meal', 45000, 'Load', '', 'RETAIN_BALANCE');
    expect(sources()[0].balanceMinor).toBe(50000);
    expect(transactions()[0].sourceBalanceApplied).toBe(false);
    const toll = stage(
      evidence({
        id: 'b'.repeat(64),
        kind: 'FASTAG_TOLL',
        vehicleNumber: 'KA02CD5678',
        amountMinor: 9200,
      }),
    );
    await expect(service.approve(toll, 'tag-a', 9200, 'Toll')).rejects.toThrow('vehicle');
    await service.approve(toll, 'tag-b', 9200, 'Toll');
    expect(sources()[1].balanceMinor).toBe(10000);
    expect(sources()[2].balanceMinor).toBe(10800);
  });
  it('equal merchant and amount in different months remain distinct purchases', async () => {
    await service.approve(stage(evidence()), card.id, 45000, 'DEMO recurring');
    await service.approve(
      stage(
        evidence({ id: 'b'.repeat(64), eventDate: '2026-09-18', eventAt: '2026-09-18T12:00:00Z' }),
      ),
      card.id,
      45000,
      'DEMO recurring',
    );
    expect(count('card_transactions')).toBe(2);
  });
  it('bank send/receive reference links evidence, never spending and income', () => {
    const a = evidence({ kind: 'BANK_CREDIT', reference: 'SYNTHREF1234' });
    const b = evidence({ kind: 'BANK_TRANSFER', reference: 'SYNTHREF1234' });
    expect(transferRelationship(a, b)).toBe(true);
    expect(ledgerType(a)).toBeUndefined();
    expect(ledgerType(b)).toBeUndefined();
  });
  it('serializes real manual wallet writes, source edits and creation with SMS approval', async () => {
    const wallet: PaymentSource = {
      id: 'meal',
      nickname: 'DEMO wallet',
      kind: 'MEAL',
      balanceMinor: 10000,
      noLimit: false,
      autoLoad: false,
      archived: false,
    };
    run(`INSERT INTO app_preferences VALUES ('payment_sources',?)`, [JSON.stringify([wallet])]);
    sources.set([{ ...wallet }]);
    const manual = TestBed.runInInjectionContext(() => new CardNestStore());
    manual.cards.set([card]);
    manual.transactions.set([]);
    manual.paymentSources.set([{ ...wallet }]);
    const entry: CardTransaction = {
      id: 'manual-wallet',
      cardId: 'meal',
      type: 'PURCHASE',
      amountMinor: 1000,
      currencyCode: 'INR',
      transactionDate: '2026-10-17',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    manual.addTransaction(entry);
    const approval = service.approve(
      stage(evidence({ kind: 'PLUXEE_TOPUP', amountMinor: 2000 })),
      'meal',
      2000,
      'Load',
    );
    manual.updatePaymentSource({ ...manual.paymentSources()[0], nickname: 'Renamed wallet' });
    const creation = manual.addWallet({
      id: 'tag-extra',
      nickname: 'Fictional vehicle',
      kind: 'FASTAG',
      balanceMinor: 0,
      noLimit: false,
      autoLoad: false,
      archived: false,
      vehicleNumber: 'KA01AB1234',
    });
    await Promise.all([approval, creation]);
    const readWallets = () =>
      JSON.parse(
        rows<{ encrypted_value: string }>(
          `SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'`,
        )[0].encrypted_value,
      ) as PaymentSource[];
    expect(readWallets()[0].balanceMinor).toBe(11000);
    expect(readWallets()[0].nickname).toBe('Renamed wallet');
    expect(readWallets()).toHaveLength(2);
    expect(count('card_transactions')).toBe(2);
    manual.updateTransaction({ ...entry, amountMinor: 2000 });
    await TestBed.inject(SqliteDatabase).atomic(async () => undefined);
    expect(readWallets()[0].balanceMinor).toBe(10000);
    manual.deleteTransaction(entry.id);
    await TestBed.inject(SqliteDatabase).atomic(async () => undefined);
    expect(readWallets()[0].balanceMinor).toBe(12000);
  });
  it('explicit wallet reconciliation creates a documented adjustment and rejects an older snapshot', async () => {
    const wallet: PaymentSource = {
      id: 'meal',
      nickname: 'DEMO',
      kind: 'MEAL',
      balanceMinor: 5000,
      noLimit: false,
      autoLoad: false,
      archived: false,
    };
    sources.set([wallet]); // Missing preference must be created durably without mutating the signal early.
    const candidate = stage(
      evidence({ kind: 'PLUXEE_TOPUP', amountMinor: 2000, reportedBalanceMinor: 8000 }),
    );
    await service.approve(candidate, 'meal', 2000, 'Load', '', 'ADJUST_BALANCE');
    expect(sources()[0].balanceMinor).toBe(8000);
    expect(count('card_transactions')).toBe(2);
    expect(transactions().find((t) => t.type === 'ADJUSTMENT')?.amountMinor).toBe(1000);
    const older = stage(
      evidence({
        id: 'b'.repeat(64),
        kind: 'PLUXEE_TOPUP',
        eventDate: '2026-10-17',
        eventAt: '2026-10-17T12:00:00Z',
        reportedBalanceMinor: 1000,
      }),
    );
    await expect(
      service.approve(older, 'meal', 45000, 'Older', '', 'ADJUST_BALANCE'),
    ).rejects.toThrow('snapshot');
    expect(sources()[0].balanceMinor).toBe(8000);
    expect(count('card_transactions')).toBe(2);
  });
  it('repairs the selected existing top-up without posting a second load', async () => {
    const wallet: PaymentSource = {
      id: 'meal',
      nickname: 'DEMO',
      kind: 'MEAL',
      balanceMinor: 5000,
      noLimit: false,
      autoLoad: false,
      archived: false,
    };
    sources.set([wallet]);
    run(`INSERT INTO app_preferences VALUES ('payment_sources',?)`, [JSON.stringify([wallet])]);
    await service.approve(
      stage(evidence({ kind: 'PLUXEE_TOPUP', amountMinor: 2000 })),
      'meal',
      2000,
      'Load',
    );
    const existing = transactions()[0];
    await service.approve(
      stage(evidence({ id: 'b'.repeat(64), kind: 'PLUXEE_TOPUP', amountMinor: 3000 })),
      'meal',
      3000,
      'Corrected',
      existing.id,
      'REPAIR_EXISTING',
      false,
      '',
      0,
      { transactionDate: '2026-10-16', categoryId: 'other' },
    );
    expect(count('card_transactions')).toBe(1);
    expect(transactions()).toHaveLength(1);
    expect(transactions()[0].amountMinor).toBe(3000);
    expect(transactions()[0].transactionDate).toBe('2026-10-16');
    expect(
      rows<{ transaction_date: string; category_id: string }>(
        'SELECT transaction_date,category_id FROM card_transactions',
      )[0],
    ).toMatchObject({ transaction_date: '2026-10-16', category_id: 'other' });
    expect(sources()[0].balanceMinor).toBe(8000);
  });
  it('failed wallet import never mutates fallback source signals', async () => {
    const wallet: PaymentSource = {
      id: 'meal',
      nickname: 'DEMO',
      kind: 'MEAL',
      balanceMinor: 5000,
      noLimit: false,
      autoLoad: false,
      archived: false,
    };
    sources.set([wallet]);
    sql.exec(
      `CREATE TRIGGER fail_binding BEFORE INSERT ON sms_reconciliation BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`,
    );
    await expect(
      service.approve(stage(evidence({ kind: 'PLUXEE_TOPUP' })), 'meal', 45000, 'Load'),
    ).rejects.toThrow();
    expect(wallet.balanceMinor).toBe(5000);
    expect(sources()[0].balanceMinor).toBe(5000);
    expect(count('card_transactions')).toBe(0);
  });
  it('ambiguous suffixes remain multiple candidates and no suffix never guesses a card', () => {
    const cards = [card, { ...card, id: 'second' }] as Parameters<typeof eligibleSources>[1];
    expect(
      eligibleSources(evidence({ cardDigits: '4321', issuer: 'AMEX' }), cards, []),
    ).toHaveLength(2);
    expect(eligibleSources(evidence({ issuer: 'AMEX' }), cards, [])).toEqual([]);
    expect(existingSuggestions(evidence(), card.id, [])).toEqual([]);
  });
});
