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
import { defaultReviewFilters, SMS_REVIEW_FILTERS_KEY } from './sms-review-filters';
import { matchExisting } from './sms-matching';
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
  function manual(overrides: Partial<CardTransaction> = {}): CardTransaction {
    const entry: CardTransaction = {
      id: 'synthetic-manual',
      cardId: card.id,
      type: 'PURCHASE',
      amountMinor: 45000,
      currencyCode: 'INR',
      transactionDate: '2026-10-18',
      merchant: 'Synthetic Orchard via a payment app',
      categoryId: 'groceries',
      attachmentIds: [],
      createdAt: 'before',
      updatedAt: 'before',
      ...overrides,
    };
    run(
      'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        entry.id,
        entry.cardId === card.id ? card.id : null,
        entry.categoryId,
        entry.type,
        entry.amountMinor,
        entry.currencyCode,
        entry.transactionDate,
        JSON.stringify(entry),
        entry.createdAt,
        entry.updatedAt,
      ],
    );
    transactions.update((items) => [...items, entry]);
    return entry;
  }
  const confident = (overrides: Partial<SmsEvidence> = {}) =>
    evidence({ cardDigits: '54321', issuer: 'AMEX', merchant: 'ORCHARD MARKET', ...overrides });
  it('automatically links a unique existing purchase atomically with zero financial writes and unchanged read flag', async () => {
    manual();
    stage(confident());
    const before = rows('SELECT * FROM card_transactions');
    sql.exec(
      "CREATE TRIGGER forbid_financial_write BEFORE UPDATE ON card_transactions BEGIN SELECT RAISE(ABORT,'No financial writes allowed'); END",
    );
    expect(await service.reevaluatePending()).toBe(1);
    expect(rows('SELECT state,transaction_id,read_at FROM sms_candidates')).toEqual([
      { state: 'MATCHED_EXISTING', transaction_id: 'synthetic-manual', read_at: null },
    ]);
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(count('sms_reconciliation')).toBe(1);
    expect(await service.reevaluatePending()).toBe(0);
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    const restarted = runInInjectionContext(
      TestBed.inject(EnvironmentInjector),
      () => new SmsReviewService(),
    );
    expect(await restarted.reevaluatePending()).toBe(0);
    expect(rows('SELECT state FROM sms_candidates')[0]['state']).toBe('MATCHED_EXISTING');
    expect(count('sms_reconciliation')).toBe(1);
  });
  it.each([
    { merchant: undefined },
    { cardDigits: undefined },
    { dateFallback: true },
    { kind: 'REFUND' as const },
    { kind: 'CASHBACK' as const },
    { kind: 'PAYMENT_INITIATED' as const },
    { eventDate: '2026-10-19' },
    { accountDigits: '54321', cardDigits: undefined },
  ])('never automatically links insufficient or conflicting evidence %j', async (overrides) => {
    manual();
    stage(confident(overrides));
    expect(await service.reevaluatePending()).toBe(0);
    expect(rows('SELECT state FROM sms_candidates')[0]['state']).toBe('PENDING');
    expect(count('card_transactions')).toBe(1);
  });
  it('requires confirmation for duplicate purchases and refuses a second SMS claim on one existing entry', async () => {
    manual();
    manual({ id: 'synthetic-second' });
    stage(confident());
    expect(await service.reevaluatePending()).toBe(0);
    run('DELETE FROM card_transactions WHERE id=?', ['synthetic-second']);
    expect(await service.reevaluatePending()).toBe(1);
    stage(confident({ id: 'b'.repeat(64), reference: 'SYNTHOTHER123' }));
    expect(await service.reevaluatePending()).toBe(0);
    expect(count('sms_reconciliation')).toBe(1);
    expect(count('card_transactions')).toBe(1);
  });
  it('does not arbitrarily assign one manual purchase between two competing SMS events in the same batch', async () => {
    manual();
    stage(confident());
    stage(confident({ id: 'b'.repeat(64), reference: 'SYNTHSECOND1234' }));
    expect(await service.reevaluatePending()).toBe(0);
    expect(count('sms_reconciliation')).toBe(0);
    expect(count('card_transactions')).toBe(1);
  });
  it('invalidates automatic links after amount/source changes but never undoes explicit review decisions', async () => {
    const entry = manual();
    stage(confident());
    await service.reevaluatePending();
    run('UPDATE card_transactions SET payload=? WHERE id=?', [
      JSON.stringify({ ...entry, amountMinor: 1 }),
      entry.id,
    ]);
    await service.reevaluatePending();
    expect(rows('SELECT state,transaction_id FROM sms_candidates')).toEqual([
      { state: 'PENDING', transaction_id: null },
    ]);
    run("UPDATE sms_candidates SET state='REJECTED'");
    const restage = service as unknown as { stage(items: readonly SmsEvidence[]): Promise<void> };
    await restage.stage([confident({ merchant: 'Better evidence' })]);
    expect(rows('SELECT state FROM sms_candidates')[0]['state']).toBe('REJECTED');
  });
  it('recognizes a missing-suffix Pluxee purchase only with one meal wallet and independently matching merchant evidence', async () => {
    const wallet: PaymentSource = {
      id: 'synthetic-meal',
      kind: 'MEAL',
      nickname: 'Synthetic meal',
      institution: 'Sodexo',
      lastDigits: '8765',
      noLimit: false,
      balanceMinor: 90000,
      autoLoad: false,
      archived: false,
    };
    sources.set([wallet]);
    run('INSERT INTO app_preferences VALUES(?,?)', ['payment_sources', JSON.stringify([wallet])]);
    manual({ cardId: wallet.id });
    stage(confident({ kind: 'PLUXEE_PURCHASE', issuer: 'Pluxee', cardDigits: undefined }));
    const before = rows('SELECT * FROM card_transactions');
    expect(await service.reevaluatePending()).toBe(1);
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(
      JSON.parse(
        String(
          rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0][
            'encrypted_value'
          ],
        ),
      )[0].balanceMinor,
    ).toBe(90000);
  });
  it('rolls back an automatic match when reconciliation persistence fails', async () => {
    manual();
    stage(confident());
    sql.exec(
      "CREATE TRIGGER fail_auto BEFORE INSERT ON sms_reconciliation BEGIN SELECT RAISE(ABORT,'Synthetic reconciliation failure'); END",
    );
    await expect(service.reevaluatePending()).rejects.toThrow('Synthetic reconciliation failure');
    expect(rows('SELECT state FROM sms_candidates')[0]['state']).toBe('PENDING');
    expect(count('sms_reconciliation')).toBe(0);
    expect(count('card_transactions')).toBe(1);
  });
  it.each([
    ['REFUND', 'REFUND'],
    ['CASHBACK', 'CASHBACK'],
    ['CARD_PAYMENT_RECEIVED', 'PAYMENT'],
  ] as const)('links compatible %s without creating or modifying money', async (kind, type) => {
    manual({ type });
    stage(confident({ kind }));
    const before = rows('SELECT * FROM card_transactions');
    expect(await service.reevaluatePending()).toBe(1);
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
  });
  it('links a verified unique reference without a merchant but refuses conflicting transaction times', async () => {
    manual({ merchant: undefined, reference: 'SYNTHREF123456', transactionTime: '12:15' });
    stage(confident({ merchant: undefined, reference: 'SYNTHREF123456', eventTime: '12:15:00' }));
    expect(await service.reevaluatePending()).toBe(1);
  });
  it.each(['JIO Postpaid', 'MYJIO'])(
    'recognizes a provider alias %s as supporting merchant evidence without weakening source/date/amount checks',
    async (merchant) => {
      manual({ merchant: 'Jio fiber via a payment app', amountMinor: 47823 });
      stage(confident({ merchant, amountMinor: 47823 }));
      expect(await service.reevaluatePending()).toBe(1);
      expect(count('card_transactions')).toBe(1);
    },
  );
  it('does not let a matching merchant override conflicting verified network references', async () => {
    manual({ reference: 'SYNTHORIGINAL123' });
    stage(confident({ reference: 'SYNTHDIFFERENT123' }));
    expect(await service.reevaluatePending()).toBe(0);
    expect(count('sms_reconciliation')).toBe(0);
  });
  it.each([
    'BANK_DEBIT',
    'BANK_CREDIT',
    'BANK_TRANSFER',
    'LOAN_DEBIT',
    'STATEMENT',
    'PAYMENT_INITIATED',
  ] as const)(
    'keeps %s as evidence even when an amount/date/merchant resembles spending',
    async (kind) => {
      manual();
      stage(confident({ kind }));
      expect(await service.reevaluatePending()).toBe(0);
      expect(count('card_transactions')).toBe(1);
    },
  );
  it.each([
    ['PLUXEE_TOPUP', 'MEAL', 'CREDIT'],
    ['FASTAG_TOLL', 'FASTAG', 'PURCHASE'],
    ['FASTAG_TOPUP', 'FASTAG', 'CREDIT'],
  ] as const)(
    'links an already-recorded %s without applying wallet funds again',
    async (kind, walletKind, type) => {
      const wallet: PaymentSource = {
        id: 'synthetic-wallet',
        nickname: 'Synthetic wallet',
        kind: walletKind,
        lastDigits: '8765',
        vehicleNumber: 'KA01AB1234',
        noLimit: false,
        balanceMinor: 90000,
        autoLoad: false,
        archived: false,
      };
      sources.set([wallet]);
      run('INSERT INTO app_preferences VALUES(?,?)', ['payment_sources', JSON.stringify([wallet])]);
      manual({ cardId: wallet.id, type });
      stage(confident({ kind, cardDigits: '8765', vehicleNumber: 'KA01AB1234' }));
      const before = rows('SELECT * FROM card_transactions');
      expect(await service.reevaluatePending()).toBe(1);
      expect(rows('SELECT * FROM card_transactions')).toEqual(before);
      expect(sources()[0].balanceMinor).toBe(90000);
    },
  );
  it('retains read status and explicit decisions when improved evidence is restaged', async () => {
    stage(confident({ cardDigits: undefined }));
    run("UPDATE sms_candidates SET read_at='already-read'");
    await (service as unknown as { stage(items: readonly SmsEvidence[]): Promise<void> }).stage([
      confident(),
    ]);
    expect(
      JSON.parse(String(rows('SELECT payload FROM sms_candidates')[0]['payload'])).cardDigits,
    ).toBe('54321');
    expect(rows('SELECT read_at FROM sms_candidates')[0]['read_at']).toBe('already-read');
  });
  it('never chooses between meal wallets or substitutes a different suffix', async () => {
    const wallets: PaymentSource[] = ['one', 'two'].map((id) => ({
      id,
      nickname: id,
      kind: 'MEAL',
      lastDigits: id === 'one' ? '8765' : '8766',
      noLimit: false,
      balanceMinor: 90000,
      autoLoad: false,
      archived: false,
    }));
    sources.set(wallets);
    run('INSERT INTO app_preferences VALUES(?,?)', ['payment_sources', JSON.stringify(wallets)]);
    manual({ cardId: 'one' });
    stage(confident({ kind: 'PLUXEE_PURCHASE', issuer: 'Pluxee', cardDigits: undefined }));
    expect(await service.reevaluatePending()).toBe(0);
    stage(
      confident({
        id: 'b'.repeat(64),
        kind: 'PLUXEE_PURCHASE',
        issuer: 'Pluxee',
        cardDigits: '1111',
      }),
    );
    expect(await service.reevaluatePending()).toBe(0);
  });
  it('applies a separately confirmed matched-wallet correction once, with no second purchase', async () => {
    const wallet: PaymentSource = {
      id: 'meal',
      nickname: 'Synthetic meal',
      kind: 'MEAL',
      lastDigits: '8765',
      noLimit: false,
      balanceMinor: 50000,
      autoLoad: false,
      archived: false,
    };
    sources.set([wallet]);
    run('INSERT INTO app_preferences VALUES(?,?)', ['payment_sources', JSON.stringify([wallet])]);
    manual({ cardId: 'meal' });
    const candidate = stage(
      confident({
        kind: 'PLUXEE_PURCHASE',
        issuer: 'Pluxee',
        cardDigits: '8765',
        reportedBalanceMinor: 48000,
        balancePosition: 'AFTER',
      }),
    );
    await service.reevaluatePending();
    expect(sources()[0].balanceMinor).toBe(50000);
    await service.adjustMatchedBalance(candidate);
    expect(sources()[0].balanceMinor).toBe(48000);
    expect(rows("SELECT COUNT(*) AS n FROM card_transactions WHERE type='PURCHASE'")[0]['n']).toBe(
      1,
    );
    expect(
      rows("SELECT COUNT(*) AS n FROM card_transactions WHERE type='ADJUSTMENT'")[0]['n'],
    ).toBe(1);
    await expect(service.adjustMatchedBalance(candidate)).rejects.toThrow('cutover');
    expect(count('card_transactions')).toBe(2);
  });
  it('filters multiple types with OR and combines independent filters with AND; empty means no results', async () => {
    realRefresh();
    stage(confident());
    stage(confident({ id: 'b'.repeat(64), kind: 'CASHBACK' }));
    stage(confident({ id: 'c'.repeat(64), kind: 'REFUND' }));
    const filters = {
      ...defaultReviewFilters(),
      mode: 'MULTIPLE' as const,
      kinds: ['PURCHASE', 'CASHBACK', 'PURCHASE', 'invalid'],
      search: 'ORCHARD',
      multipleInitialized: true,
    };
    await service.filterReview(filters);
    expect(service.total()).toBe(2);
    expect((await service.loadReviewFilters()).kinds).toEqual(['PURCHASE', 'CASHBACK']);
    await service.filterReview({ ...filters, read: 'READ' });
    expect(service.total()).toBe(0);
    await service.filterReview({ ...filters, kinds: [] });
    expect(service.total()).toBe(0);
  });
  it('keeps old-installation defaults without creating preferences on load', async () => {
    expect(await service.loadReviewFilters()).toEqual(defaultReviewFilters());
    expect(count('app_preferences')).toBe(0);
  });
  it('persists all applied filters in SQLite and re-applies them through a recreated service', async () => {
    realRefresh();
    stage(evidence({ merchant: 'Synthetic shop', cardDigits: '54321' }));
    stage(evidence({ id: 'b'.repeat(64), providerId: '13', merchant: 'Synthetic other' }));
    const filters = {
      state: 'PENDING',
      kind: 'PURCHASE',
      search: 'Synthetic shop',
      source: '54321',
      from: '2026-10-01',
      to: '2026-10-31',
      read: 'UNREAD',
    };
    await service.filterReview(filters);
    expect(service.total()).toBe(1);
    expect(
      JSON.parse(
        rows<{ encrypted_value: string }>(
          'SELECT encrypted_value FROM app_preferences WHERE key=?',
          [SMS_REVIEW_FILTERS_KEY],
        )[0].encrypted_value,
      ),
    ).toEqual({ ...defaultReviewFilters(), ...filters });
    const recreated = runInInjectionContext(
      TestBed.inject(EnvironmentInjector),
      () => new SmsReviewService(),
    );
    vi.spyOn(recreated, 'refreshAccess').mockResolvedValue();
    vi.spyOn(recreated as unknown as { handoff(): Promise<void> }, 'handoff').mockResolvedValue();
    expect(await recreated.loadReviewFilters()).toEqual({ ...defaultReviewFilters(), ...filters });
    await recreated.refresh();
    expect(recreated.total()).toBe(1);
    expect(recreated.candidates()[0].id).toBe('a'.repeat(64));
    expect(count('card_transactions')).toBe(0);
    await recreated.filterReview({
      state: 'ALL',
      kind: 'ALL',
      search: '',
      source: '',
      read: 'ALL',
    });
    expect(await recreated.loadReviewFilters()).toEqual({
      ...defaultReviewFilters(),
      state: 'ALL',
      read: 'ALL',
    });
  });
  it('falls back safely for malformed or invalid restored filter values', async () => {
    run('INSERT INTO app_preferences VALUES(?,?)', [SMS_REVIEW_FILTERS_KEY, 'broken JSON']);
    expect(await service.loadReviewFilters()).toEqual(defaultReviewFilters());
    run('UPDATE app_preferences SET encrypted_value=? WHERE key=?', [
      JSON.stringify({
        state: 'unknown',
        kind: {},
        read: 'unknown',
        search: 9,
        source: ['bad'],
        from: '2026-02-30',
        to: 'injected',
      }),
      SMS_REVIEW_FILTERS_KEY,
    ]);
    expect(await service.loadReviewFilters()).toEqual(defaultReviewFilters());
  });
  it('preserves the last saved filters when a preference write fails', async () => {
    const original = { ...defaultReviewFilters(), search: 'Synthetic saved' };
    await service.filterReview(original);
    sql.exec(
      `CREATE TRIGGER fail_filter_save BEFORE UPDATE ON app_preferences BEGIN SELECT RAISE(ABORT,'Synthetic save failure'); END`,
    );
    await expect(service.filterReview({ ...original, search: 'Not saved' })).rejects.toThrow(
      'Synthetic save failure',
    );
    expect(await service.loadReviewFilters()).toEqual(original);
  });
  function realRefresh(): void {
    vi.mocked(service.refresh).mockRestore();
    vi.spyOn(service, 'refreshAccess').mockResolvedValue();
    vi.spyOn(service as unknown as { handoff(): Promise<void> }, 'handoff').mockResolvedValue();
  }
  const readCount = () =>
    rows<{ n: number }>('SELECT COUNT(*) AS n FROM sms_candidates WHERE read_at IS NOT NULL')[0].n;
  const readFilters = (read: string) => ({
    state: 'ALL',
    kind: 'ALL',
    search: '',
    source: '',
    read,
  });
  it('ranks bounded missing-suffix possibilities without automatically linking or guessing card identity', async () => {
    const entry = manual({ merchant: 'Product purchased at Synthetic clinic' });
    const item = evidence({ issuer: 'AMEX', merchant: 'SYNTHETIC CLINIC' });
    expect(matchExisting(item, [card], [], [entry])).toMatchObject({
      confidence: 'POSSIBLE_EXISTING',
      transactionIds: [entry.id],
    });
    const candidate = stage(item);
    expect(await service.reevaluatePending()).toBe(0);
    await service.approve(
      candidate,
      card.id,
      item.amountMinor,
      'Keep manual description',
      entry.id,
    );
    expect(count('card_transactions')).toBe(1);
    expect(rows('SELECT state FROM sms_candidates')).toEqual([{ state: 'MATCHED_EXISTING' }]);
    expect(
      matchExisting({ ...item, accountDigits: '1234' }, [card], [], [entry]).transactionIds,
    ).toEqual([]);
    expect(
      matchExisting({ ...item, dateFallback: true }, [card], [], [entry]).transactionIds,
    ).toEqual([]);
    expect(
      matchExisting(item, [card], [], [entry, { ...entry, id: 'another' }]).transactionIds,
    ).toHaveLength(2);
  });
  it('blocks legacy due-date purchases until original evidence is recovered and retains identity/read state', async () => {
    const old = evidence({ dueDate: '2026-10-18', merchant: undefined });
    const candidate = stage(old);
    run('UPDATE sms_candidates SET read_at=? WHERE id=?', ['synthetic-read', old.id]);
    await expect(
      service.approve(candidate, card.id, old.amountMinor, 'Unverified'),
    ).rejects.toThrow('statement');
    vi.spyOn(
      service as unknown as { recheckOriginals(items: unknown[]): Promise<{ items: unknown[] }> },
      'recheckOriginals',
    ).mockResolvedValue({
      items: [
        {
          ...old,
          kind: 'STATEMENT',
          parserVersion: 2,
          dateFallback: true,
          eventDate: '2026-10-17',
          statementTotalMinor: old.amountMinor,
        },
      ],
    });
    await service.recheckSaved();
    expect(rows('SELECT id,kind,state,read_at FROM sms_candidates')).toEqual([
      { id: old.id, kind: 'STATEMENT', state: 'PENDING', read_at: 'synthetic-read' },
    ]);
    expect(count('card_transactions')).toBe(0);
    await expect(service.approve(candidate, card.id, old.amountMinor, 'Statement')).rejects.toThrow(
      'evidence only',
    );
  });
  it('keeps unavailable originals suspect and explicit imported decisions intact during recheck', async () => {
    const pending = stage(evidence({ dueDate: '2026-10-18' }));
    const imported = stage(evidence({ id: 'b'.repeat(64) }));
    await service.approve(imported, card.id, 45000, 'Synthetic');
    const before = rows('SELECT * FROM card_transactions');
    const recovery = vi
      .spyOn(
        service as unknown as { recheckOriginals(items: unknown[]): Promise<{ items: unknown[] }> },
        'recheckOriginals',
      )
      .mockResolvedValue({ items: [] });
    await service.recheckSaved();
    expect(recovery.mock.calls[0][0]).toEqual([expect.objectContaining({ id: pending.id })]);
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(rows('SELECT state FROM sms_candidates WHERE id=?', [imported.id])).toEqual([
      { state: 'IMPORTED' },
    ]);
    expect(service.notice()).toContain('1 originals unavailable');
  });
  it('approves once, persists read/resolved state across a fresh service and retains imported history', async () => {
    const candidate = stage(evidence());
    await service.approve(candidate, card.id, 45000, 'Synthetic saved');
    service = TestBed.runInInjectionContext(() => new SmsReviewService());
    vi.spyOn(service, 'refreshAccess').mockResolvedValue();
    vi.spyOn(service as unknown as { handoff(): Promise<void> }, 'handoff').mockResolvedValue();
    await service.filterReview({ ...defaultReviewFilters(), read: 'ALL' });
    expect(service.candidates()).toEqual([]);
    expect(service.pendingTotal()).toBe(0);
    await service.filterReview({ ...readFilters('ALL'), hideAlreadyAdded: false });
    expect(service.candidates()[0]).toMatchObject({
      state: 'IMPORTED',
      transactionId: expect.any(String),
      readAt: expect.any(String),
    });
    await service.approve(candidate, card.id, 45000, 'Retry');
    expect(count('card_transactions')).toBe(1);
    await service.filterReview({ ...readFilters('ALL'), hideAlreadyAdded: true });
    expect(service.candidates()).toEqual([]);
    await service.filterReview({ ...readFilters('ALL'), state: 'MATCHED_EXISTING' });
    expect(service.candidates()).toEqual([]);
  });
  it('clears only old dismissed optional evidence and replay cannot resurrect its tombstone', async () => {
    const dismissed = stage(evidence());
    const readPending = stage(evidence({ id: 'b'.repeat(64) }));
    run(
      "UPDATE sms_candidates SET state='REJECTED',updated_at='2020-01-01',read_at='before' WHERE id=?",
      [dismissed.id],
    );
    await service.markRead(readPending.id, true);
    expect(await service.cleanCompletedEvidence()).toBe(1);
    const after = rows('SELECT id,state,read_at,payload FROM sms_candidates ORDER BY id');
    expect(after[0]).toMatchObject({ state: 'REJECTED', read_at: 'before', payload: null });
    expect(after[1]['payload']).toBeTruthy();
    await (service as unknown as { stage(items: SmsEvidence[]): Promise<void> }).stage([
      dismissed.item!,
    ]);
    expect(rows('SELECT id,state,read_at,payload FROM sms_candidates ORDER BY id')).toEqual(after);
    expect(count('card_transactions')).toBe(0);
  });
  it.each([false, true])(
    'only records genuine explicit transaction time (%s)',
    async (explicit) => {
      await service.approve(
        stage(evidence({ eventTime: '00:00', eventTimeExplicit: explicit })),
        card.id,
        45000,
        'Synthetic',
      );
      expect(transactions()[0].transactionTime).toBe(explicit ? '00:00' : undefined);
    },
  );
  it('marks one suggestion read and unread without changing its review decision or ledger', async () => {
    const candidate = stage(evidence());
    const before = rows('SELECT id,state,transaction_id,payload,updated_at FROM sms_candidates');
    await service.markRead(candidate.id, true);
    expect(readCount()).toBe(1);
    expect(rows('SELECT id,state,transaction_id,payload,updated_at FROM sms_candidates')).toEqual(
      before,
    );
    expect(count('card_transactions')).toBe(0);
    await service.markRead(candidate.id, false);
    expect(readCount()).toBe(0);
  });
  it('atomically marks all 451 saved candidates rather than just the page, then handles an empty inbox', async () => {
    for (let index = 0; index < 451; index++)
      stage(evidence({ id: index.toString(16).padStart(64, '0') }));
    expect(await service.markAllRead()).toBe(451);
    expect(readCount()).toBe(451);
    expect(await service.markAllRead()).toBe(0);
    expect(rows('SELECT DISTINCT state FROM sms_candidates')).toEqual([{ state: 'PENDING' }]);
    expect(count('card_transactions')).toBe(0);
  });
  it('retains only a 200-row active page across a large historical inbox without losing identities', async () => {
    for (let index = 0; index < 1001; index++)
      stage(evidence({ id: index.toString(16).padStart(64, '0') }));
    realRefresh();
    await service.filterReview({ ...readFilters('ALL'), state: 'PENDING' });
    const first = service.candidates();
    expect(first).toHaveLength(200);
    expect(service.total()).toBe(1001);
    await service.turnPage(1);
    expect(service.candidates()).toHaveLength(200);
    expect(service.candidates()).not.toBe(first);
    expect(
      service.candidates().some((item) => first.some((previous) => previous.id === item.id)),
    ).toBe(false);
    expect(count('sms_candidates')).toBe(1001);
    expect(count('card_transactions')).toBe(0);
  });
  it('defaults to unread independently of financial state and exposes Read/All history', async () => {
    const a = stage(evidence());
    stage(evidence({ id: 'b'.repeat(64) }));
    await service.markRead(a.id, true);
    realRefresh();
    await service.refresh();
    expect(service.candidates().map((item) => item.id)).toEqual(['b'.repeat(64)]);
    expect(service.unreadTotal()).toBe(1);
    await service.filterReview(readFilters('READ'));
    expect(service.candidates().map((item) => item.id)).toEqual([a.id]);
    expect(service.candidates()[0].readAt).toBeTruthy();
    await service.filterReview(readFilters('ALL'));
    expect(service.total()).toBe(2);
  });
  it('a read pending candidate remains eligible for explicit later approval', async () => {
    const candidate = stage(evidence());
    await service.markRead(candidate.id, true);
    await service.approve(candidate, card.id, 45000, 'Synthetic later approval');
    expect(count('card_transactions')).toBe(1);
    expect(rows('SELECT state FROM sms_candidates')).toEqual([{ state: 'IMPORTED' }]);
    expect(readCount()).toBe(1);
  });
  it('marking imported and matched items read preserves their ledger and reconciliation bindings', async () => {
    const candidate = stage(evidence());
    await service.approve(candidate, card.id, 45000, 'Synthetic');
    const other = stage(evidence({ id: 'b'.repeat(64) }));
    await service.approve(other, card.id, 45000, 'Synthetic', transactions()[0].id);
    const before = {
      ledger: rows('SELECT * FROM card_transactions'),
      bindings: rows('SELECT * FROM sms_reconciliation'),
      states: rows('SELECT id,state,transaction_id FROM sms_candidates'),
    };
    await service.markAllRead();
    expect({
      ledger: rows('SELECT * FROM card_transactions'),
      bindings: rows('SELECT * FROM sms_reconciliation'),
      states: rows('SELECT id,state,transaction_id FROM sms_candidates'),
    }).toEqual(before);
    expect(readCount()).toBe(2);
  });
  it('real historical staging and duplicate handoffs preserve read state, while new old-dated evidence is unread', async () => {
    const item = evidence();
    stage(item);
    await service.markAllRead();
    const stageNative = service as unknown as {
      stage(items: readonly SmsEvidence[]): Promise<void>;
    };
    await stageNative.stage([item, item]);
    expect(readCount()).toBe(1);
    await stageNative.stage([
      evidence({ id: 'c'.repeat(64), eventAt: '2010-01-01T00:00:00Z', eventDate: '2010-01-01' }),
    ]);
    expect(count('sms_candidates')).toBe(2);
    expect(rows('SELECT read_at FROM sms_candidates WHERE id=?', ['c'.repeat(64)])).toEqual([
      { read_at: null },
    ]);
  });
  it('a recreated service reads persisted flags instead of a session timestamp', async () => {
    const candidate = stage(evidence());
    await service.markRead(candidate.id, true);
    service = TestBed.runInInjectionContext(() => new SmsReviewService());
    vi.spyOn(service, 'refreshAccess').mockResolvedValue();
    vi.spyOn(service as unknown as { handoff(): Promise<void> }, 'handoff').mockResolvedValue();
    await service.filterReview(readFilters('READ'));
    expect(service.candidates()[0].id).toBe(candidate.id);
    expect(service.unreadTotal()).toBe(0);
  });
  it('a failed bulk write rolls back every flag and keeps the write queue and busy guard usable', async () => {
    stage(evidence());
    stage(evidence({ id: 'b'.repeat(64) }));
    sql.exec(
      `CREATE TRIGGER fail_read BEFORE UPDATE OF read_at ON sms_candidates WHEN OLD.id='${'b'.repeat(64)}' BEGIN SELECT RAISE(ABORT,'synthetic read failure'); END`,
    );
    await expect(service.markAllRead()).rejects.toThrow('synthetic read failure');
    expect(readCount()).toBe(0);
    expect(service.markingRead()).toBe(false);
    sql.exec('DROP TRIGGER fail_read');
    expect(await service.markAllRead()).toBe(2);
  });
  it('serializes scanning around the bulk boundary, keeps subsequent discovery unread, and blocks repeated taps', async () => {
    stage(evidence());
    const stageNative = service as unknown as {
      stage(items: readonly SmsEvidence[]): Promise<void>;
    };
    const earlier = stageNative.stage([evidence({ id: 'b'.repeat(64) })]);
    const bulk = service.markAllRead();
    expect(service.markingRead()).toBe(true);
    expect(await service.markAllRead()).toBe(0);
    const later = stageNative.stage([evidence({ id: 'c'.repeat(64) })]);
    await Promise.all([earlier, bulk, later]);
    expect(await bulk).toBe(2);
    expect(readCount()).toBe(2);
    expect(rows('SELECT read_at FROM sms_candidates WHERE id=?', ['c'.repeat(64)])).toEqual([
      { read_at: null },
    ]);
  });

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
  it('discards a stale pending-page refresh that finishes after a successful approval', async () => {
    const candidate = stage(evidence());
    realRefresh();
    const db = TestBed.inject(SqliteDatabase);
    const query = db.query.bind(db);
    let release!: () => void;
    let ready!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let delayed = false;
    vi.spyOn(db, 'query').mockImplementation(
      async <T extends Record<string, unknown>>(
        statement: string,
        values: readonly unknown[] = [],
      ) => {
        const result = await query<T>(statement, values);
        if (statement.startsWith('SELECT * FROM sms_candidates') && !delayed) {
          delayed = true;
          ready();
          await blocked;
        }
        return result;
      },
    );
    const stale = service.refresh();
    await started;
    await service.approve(candidate, card.id, 45000, 'Synthetic approved');
    release();
    await stale;
    expect(service.candidates()).toEqual([]);
    expect(rows('SELECT state FROM sms_candidates')).toEqual([{ state: 'IMPORTED' }]);
    expect(count('card_transactions')).toBe(1);
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
  it('does not announce success when a stale candidate no longer exists', async () => {
    const item = evidence();
    await expect(
      service.approve(
        { id: item.id, kind: item.kind, item, state: 'PENDING', eventAt: item.eventAt },
        card.id,
        item.amountMinor,
        'Synthetic',
      ),
    ).rejects.toThrow('unavailable');
    expect(service.notice()).toBe('');
    expect(count('card_transactions')).toBe(0);
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
      evidence({
        kind: 'PLUXEE_TOPUP',
        amountMinor: 2000,
        reportedBalanceMinor: 8000,
        balancePosition: 'AFTER',
      }),
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
    expect(service.notice()).toBe('Existing wallet top-up repaired and matched.');
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
