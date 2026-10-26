import { TestBed } from '@angular/core/testing';
import { EnvironmentInjector, Injector, runInInjectionContext, signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { TransactionsPage } from '../transactions/transactions';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
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

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** Actual SQLite constraints/rollback, not an array pretending that ledger writes succeeded. */
describe('SMS approved import integrity', () => {
  let sql: DatabaseSyncType;
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
    parserVersion: 3,
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
    for (const id of ['other', 'payment', 'contra-expenses', 'groceries', 'dining'])
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
  it('dismisses durably with exact Undo and guards against concurrent resolution and repeated Undo', async () => {
    const candidate = stage(evidence());
    service.candidates.set([candidate]);
    const before = rows('SELECT * FROM sms_candidates');
    const dismissal = await service.dismiss(candidate.id);
    expect(dismissal).not.toBeNull();
    expect(service.candidates()).toEqual([]);
    expect(rows('SELECT state,read_at FROM sms_candidates')[0]).toMatchObject({
      state: 'IGNORED',
      read_at: expect.any(String),
    });
    expect(count('card_transactions')).toBe(0);
    await service.undoDismissal(dismissal!);
    expect(rows('SELECT * FROM sms_candidates')).toEqual(before);
    await service.undoDismissal(dismissal!);
    expect(count('sms_candidates')).toBe(1);
    const again = await service.dismiss(candidate.id);
    run("UPDATE sms_candidates SET state='REJECTED',decision='newer choice' WHERE id=?", [
      candidate.id,
    ]);
    await service.undoDismissal(again!);
    expect(rows('SELECT state,decision FROM sms_candidates')[0]).toEqual({
      state: 'REJECTED',
      decision: 'newer choice',
    });
  });
  it('isolates rapid Undo tokens, preserves newer read actions, and expires dismissal Undo after seven seconds', async () => {
    const first = stage(evidence());
    const second = stage(evidence({ id: 'b'.repeat(64) }));
    const a = await service.dismiss(first.id);
    const b = await service.dismiss(second.id);
    await service.undoDismissal(b!);
    await service.undoDismissal(a!);
    expect(rows('SELECT state,read_at FROM sms_candidates ORDER BY id')).toEqual([
      { state: 'PENDING', read_at: null },
      { state: 'PENDING', read_at: null },
    ]);
    const newer = await service.dismiss(first.id);
    await service.markRead(first.id, false);
    await service.undoDismissal(newer!);
    expect(rows('SELECT state,read_at FROM sms_candidates WHERE id=?', [first.id])[0]).toEqual({
      state: 'IGNORED',
      read_at: null,
    });
    const expired = await service.dismiss(second.id);
    await service.undoDismissal({ ...expired!, expires: Date.now() - 1 });
    expect(rows('SELECT state FROM sms_candidates WHERE id=?', [second.id])[0]['state']).toBe(
      'IGNORED',
    );
    expect(count('sms_candidates')).toBe(2);
    expect(count('card_transactions')).toBe(0);
  });
  it('preserves imported links and provenance through dismissal and exact read-state Undo', async () => {
    const candidate = stage(evidence());
    await service.approve(candidate, card.id, 45000, 'Synthetic');
    const ledger = rows('SELECT * FROM card_transactions');
    const before = rows('SELECT * FROM sms_candidates');
    const dismissal = await service.dismiss(candidate.id);
    expect(rows('SELECT state,transaction_id,decision FROM sms_candidates')[0]).toMatchObject({
      state: 'IMPORTED',
      transaction_id: 'sms-' + candidate.id,
      decision: before[0]['decision'],
    });
    await service.undoDismissal(dismissal!);
    expect(rows('SELECT * FROM sms_candidates')).toEqual(before);
    expect(rows('SELECT * FROM card_transactions')).toEqual(ledger);
  });
  it('never imports a scheduled notice and links confirmed materialized recurring occurrences once across monthly cycles', async () => {
    run(
      "INSERT INTO recurring_rules(id,card_id,next_occurrence_date,status,payload) VALUES('synthetic-rule',?,'2026-11-18','ACTIVE',?)",
      [card.id, JSON.stringify({ id: 'synthetic-rule', amountMinor: 45000, status: 'ACTIVE' })],
    );
    const ruleBefore = rows('SELECT * FROM recurring_rules');
    const entry = manual({
      recurringRuleId: 'synthetic-rule',
      generatedOccurrenceDate: '2026-10-18',
    });
    const scheduled = stage(
      evidence({
        kind: 'SCHEDULED_CHARGE',
        issuer: 'AMEX',
        cardDigits: '4321',
        merchant: entry.merchant,
      }),
    );
    await expect(service.approve(scheduled, card.id, 45000, entry.merchant!)).rejects.toThrow(
      'evidence only',
    );
    expect(await service.reevaluatePending()).toBe(0);
    const confirmed = stage(
      evidence({
        id: 'b'.repeat(64),
        issuer: 'AMEX',
        cardDigits: '4321',
        merchant: entry.merchant,
      }),
    );
    expect(await service.reevaluatePending()).toBe(0);
    await service.approve(confirmed, card.id, 45000, entry.merchant!, entry.id);
    expect(count('card_transactions')).toBe(1);
    expect(
      rows('SELECT transaction_id FROM sms_candidates WHERE id=?', [confirmed.id])[0][
        'transaction_id'
      ],
    ).toBe(entry.id);
    expect(await service.reevaluatePending()).toBe(0);
    const july = evidence({
      id: 'c'.repeat(64),
      issuer: 'AMEX',
      cardDigits: '4321',
      merchant: entry.merchant,
      eventDate: '2026-07-18',
      eventAt: '2026-07-18T00:00:00Z',
    });
    expect(matchExisting(july, [card], [], [entry]).transactionIds).toEqual([]);
    expect(rows('SELECT * FROM recurring_rules')).toEqual(ruleBefore);
    const second = manual({
      id: 'second-real-occurrence',
      recurringRuleId: 'another-rule',
      generatedOccurrenceDate: '2026-10-18',
    });
    expect(matchExisting(confirmed.item!, [card], [], [entry, second]).confidence).toBe(
      'AMBIGUOUS',
    );
    expect(matchExisting(confirmed.item!, [card], [], [entry, second]).reason).toContain(
      'Possible existing recurring transaction',
    );
  });
  it('does not unlink a resolved legacy automatic relationship merely because the parser was upgraded', async () => {
    const entry = manual();
    const candidate = stage(
      evidence({ parserVersion: 2, issuer: 'AMEX', cardDigits: '4321', merchant: entry.merchant }),
    );
    run(
      "UPDATE sms_candidates SET state='MATCHED_EXISTING',transaction_id=?,decision='AUTO_EXISTING: prior verified relationship',read_at='before' WHERE id=?",
      [entry.id, candidate.id],
    );
    const before = rows('SELECT * FROM sms_candidates');
    const ledger = rows('SELECT * FROM card_transactions');
    expect(await service.reevaluatePending()).toBe(0);
    expect(rows('SELECT * FROM sms_candidates')).toEqual(before);
    expect(rows('SELECT * FROM card_transactions')).toEqual(ledger);
  });
  it('requires bounded original recheck for pre-v3 AMEX purchases without changing read state or ledger', async () => {
    const old = stage(
      evidence({ parserVersion: 2, issuer: 'AMEX', cardDigits: '4321', merchant: 'T&Cs Apply' }),
    );
    await expect(service.approve(old, card.id, 45000, 'Unknown')).rejects.toThrow('Recheck');
    vi.spyOn(
      service as unknown as { recheckOriginals(items: unknown[]): Promise<{ items: unknown[] }> },
      'recheckOriginals',
    ).mockResolvedValue({
      items: [
        {
          ...old.item,
          kind: 'SCHEDULED_CHARGE',
          parserVersion: 3,
          merchant: 'Synthetic Insurance',
        },
      ],
    });
    await service.recheckSaved();
    expect(rows('SELECT id,kind,state,read_at FROM sms_candidates')[0]).toEqual({
      id: old.id,
      kind: 'SCHEDULED_CHARGE',
      state: 'PENDING',
      read_at: null,
    });
    expect(count('card_transactions')).toBe(0);
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
    evidence({
      cardDigits: '54321',
      issuer: 'AMEX',
      merchant: 'ORCHARD MARKET',
      eventTimeExplicit: true,
      eventTime: '17:30:00',
      reference: 'SYNTHREF123456',
      ...overrides,
    });
  const verifiedManual = () => manual({ reference: 'SYNTHREF123456', transactionTime: '17:30' });
  it('allows explicit reference-based linking after delayed delivery without treating fallback timing as high confidence', async () => {
    const entry = verifiedManual();
    const candidate = stage(
      confident({ eventTimeExplicit: false, receivedAt: Date.parse('2026-10-23T12:00:00Z') }),
    );
    expect(matchExisting(candidate.item!, [card], [], [entry]).confidence).toBe(
      'POSSIBLE_EXISTING',
    );
    expect(await service.reevaluatePending()).toBe(0);
    const before = rows('SELECT * FROM card_transactions');
    await service.approve(candidate, card.id, 45000, 'Delayed delivery', entry.id);
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(rows('SELECT decision FROM sms_reconciliation')[0]['decision']).toBe('EXPLICIT_MATCH');
  });
  it('never automatically links same-day identical merchants and amounts without unique reference and explicit timing', async () => {
    const entry = manual({ transactionTime: '17:30' });
    const item = confident({ reference: undefined });
    stage(item);
    expect(matchExisting(item, [card], [], [entry]).confidence).toBe('POSSIBLE_EXISTING');
    expect(await service.reevaluatePending()).toBe(0);
    expect(
      matchExisting(
        { ...item, reference: 'VERIFIED', eventTimeExplicit: false },
        [card],
        [],
        [{ ...entry, reference: 'VERIFIED' }],
      ).confidence,
    ).toBe('POSSIBLE_EXISTING');
    expect(
      matchExisting(
        { ...item, reference: 'VERIFIED' },
        [card],
        [],
        [{ ...entry, reference: 'VERIFIED', transactionTime: undefined }],
      ).confidence,
    ).toBe('POSSIBLE_EXISTING');
  });
  it('records an explicit match without another purchase and a confirmed separate purchase exactly once across double approval, restart and rescanning', async () => {
    const entry = manual();
    const linked = stage(evidence());
    const before = rows('SELECT * FROM card_transactions');
    await service.approve(linked, card.id, 45000, 'Edited description', entry.id);
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(
      rows('SELECT decision FROM sms_reconciliation WHERE candidate_id=?', [linked.id])[0][
        'decision'
      ],
    ).toBe('EXPLICIT_MATCH');
    const separate = stage(evidence({ id: 'b'.repeat(64) }));
    await expect(service.approve(separate, card.id, 45000, 'Breakfast')).rejects.toThrow(
      'Match it',
    );
    await Promise.all([
      service.approve(separate, card.id, 45000, 'Breakfast', '', 'PENDING', true, '', 0, {
        categoryId: 'dining',
        smsAdditionalComment: 'Different purchase',
      }),
      service.approve(separate, card.id, 45000, 'Breakfast', '', 'PENDING', true),
    ]);
    expect(count('card_transactions')).toBe(2);
    expect(transactions().find((entry) => entry.id === `sms-${separate.id}`)).toMatchObject({
      merchant: 'Breakfast',
      categoryId: 'dining',
      smsAdditionalComment: 'Different purchase',
    });
    expect(
      rows('SELECT decision FROM sms_reconciliation WHERE candidate_id=?', [separate.id])[0][
        'decision'
      ],
    ).toBe('CONFIRMED_SEPARATE_PURCHASE');
    const restarted = runInInjectionContext(
      TestBed.inject(EnvironmentInjector),
      () => new SmsReviewService(),
    );
    await (restarted as unknown as { stage(items: readonly SmsEvidence[]): Promise<void> }).stage([
      separate.item!,
    ]);
    await restarted.approve(separate, card.id, 45000, 'Again', '', 'PENDING', true);
    expect(count('card_transactions')).toBe(2);
    expect(count('sms_reconciliation')).toBe(2);
  });
  it('revalidates matching inside approval and never bypasses a proven reference using separate confirmation or edited amounts', async () => {
    const entry = verifiedManual();
    const candidate = stage(confident());
    await expect(
      service.approve(candidate, card.id, 45000, 'Same ref', '', 'PENDING', true),
    ).rejects.toThrow('referenced purchase');
    await expect(
      service.approve(candidate, card.id, 45001, 'Edited amount', '', 'PENDING', true),
    ).rejects.toThrow('referenced purchase');
    run('UPDATE card_transactions SET payload=? WHERE id=?', [
      JSON.stringify({
        ...entry,
        transactionDate: '2026-10-23',
        reference: 'CONFLICTING_REFERENCE',
      }),
      entry.id,
    ]);
    await expect(
      service.approve(candidate, card.id, 45000, 'Stale match', entry.id),
    ).rejects.toThrow('no longer matches');
    expect(count('card_transactions')).toBe(1);
    expect(count('sms_reconciliation')).toBe(0);
  });
  it('excludes conflicting references from manual suggestions and rejects a forged link', async () => {
    const entry = manual({ reference: 'OTHER_REFERENCE' });
    const candidate = stage(confident());
    expect(existingSuggestions(candidate.item!, card.id, [entry])).toEqual([]);
    await expect(service.approve(candidate, card.id, 45000, 'Mismatch', entry.id)).rejects.toThrow(
      'no longer matches',
    );
  });
  it('rejects a cached proximity choice when the recorded time moves outside 18 hours', async () => {
    const entry = manual({ transactionTime: '17:30' });
    const candidate = stage(confident({ reference: undefined }));
    expect(existingSuggestions(candidate.item!, card.id, [entry])).toHaveLength(1);
    run('UPDATE card_transactions SET payload=? WHERE id=?', [
      JSON.stringify({ ...entry, transactionDate: '2026-10-15' }),
      entry.id,
    ]);
    await expect(
      service.approve(candidate, card.id, 45000, 'Stale proximity', entry.id),
    ).rejects.toThrow('no longer matches');
    expect(count('card_transactions')).toBe(1);
  });
  it('stores review drafts across service restart without financial effects and removes the draft atomically after approval', async () => {
    const candidate = stage(evidence());
    const draft = {
      mode: 'CARD' as const,
      source: card.id,
      amount: '450',
      merchant: 'Milk',
      transactionDate: '2026-10-18',
      category: 'groceries',
      existing: '',
      separate: true,
      paymentMethod: 'NONE',
      paymentMethodDetail: '',
      paymentMethodCustom: '',
      smsAdditionalComment: 'Separate visit',
    };
    await service.savePurchaseReview(candidate.id, draft);
    expect(count('card_transactions')).toBe(0);
    const restarted = runInInjectionContext(
      TestBed.inject(EnvironmentInjector),
      () => new SmsReviewService(),
    );
    expect(await restarted.loadPurchaseReview(candidate.id)).toEqual(draft);
    await restarted.approve(candidate, card.id, 45000, draft.merchant, '', 'PENDING', true);
    expect(await restarted.loadPurchaseReview(candidate.id)).toBeNull();
    await restarted.savePurchaseReview(candidate.id, draft);
    expect(await restarted.loadPurchaseReview(candidate.id)).toBeNull();
  });
  it('keeps a saved matching choice pending until final approval even if background evidence would qualify for automatic linking', async () => {
    const entry = verifiedManual();
    const candidate = stage(confident());
    await service.savePurchaseReview(candidate.id, {
      mode: 'CARD',
      source: card.id,
      amount: '450',
      merchant: 'Milk',
      transactionDate: '2026-10-18',
      category: 'groceries',
      existing: entry.id,
      separate: false,
      paymentMethod: 'NONE',
      paymentMethodDetail: '',
      paymentMethodCustom: '',
      smsAdditionalComment: '',
    });
    expect(await service.reevaluatePending()).toBe(0);
    expect(rows('SELECT state FROM sms_candidates')[0]['state']).toBe('PENDING');
    expect(count('sms_reconciliation')).toBe(0);
    await service.approve(candidate, card.id, 45000, 'Milk', entry.id);
    expect(count('card_transactions')).toBe(1);
    expect(rows('SELECT state FROM sms_candidates')[0]['state']).toBe('MATCHED_EXISTING');
  });
  it('automatically links a unique existing purchase atomically with zero financial writes and unchanged read flag', async () => {
    verifiedManual();
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
    { reference: undefined },
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
    verifiedManual();
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
    verifiedManual();
    stage(confident());
    stage(confident({ id: 'b'.repeat(64), reference: 'SYNTHREF123456' }));
    expect(await service.reevaluatePending()).toBe(0);
    expect(count('sms_reconciliation')).toBe(0);
    expect(count('card_transactions')).toBe(1);
  });
  it('invalidates automatic links after amount/source changes but never undoes explicit review decisions', async () => {
    const entry = verifiedManual();
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
    verifiedManual();
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
    stage(
      confident({
        merchant: undefined,
        reference: 'SYNTHREF123456',
        eventTime: '12:15:00',
        eventAt: '2026-10-18T06:45:00Z',
      }),
    );
    expect(await service.reevaluatePending()).toBe(1);
  });
  it.each(['JIO Postpaid', 'MYJIO'])(
    'keeps provider alias %s as supporting evidence requiring manual confirmation without a unique reference',
    async (merchant) => {
      manual({ merchant: 'Jio fiber via a payment app', amountMinor: 47823 });
      stage(confident({ merchant, amountMinor: 47823 }));
      expect(await service.reevaluatePending()).toBe(0);
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
        institution: walletKind === 'MEAL' ? 'Pluxee' : undefined,
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
      stage(
        confident({
          kind,
          issuer: walletKind === 'MEAL' ? 'Pluxee' : 'AMEX',
          cardDigits: '8765',
          vehicleNumber: 'KA01AB1234',
        }),
      );
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
      institution: 'Pluxee',
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
      institution: 'Pluxee',
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
        eventTime: '17:30:00',
        eventTimeExplicit: true,
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
    ).toBe(0);
    await service.adjustMatchedBalance(candidate);
    expect(count('card_transactions')).toBe(1);
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
    expect((await service.loadReviewFilters()).sortOrder).toBe('RECEIVED_DESC');
    expect(count('app_preferences')).toBe(0);
  });
  it('orders late-arriving SMS by receipt time by default and preserves transaction-date order as the alternate', async () => {
    const lateOlderTransaction = stage(
      evidence({
        id: 'a'.repeat(64),
        eventDate: '2026-10-25',
        eventAt: '2026-10-25T16:00:00.000Z',
        receivedAt: Date.parse('2026-10-26T02:30:00.000Z'),
      }),
    );
    const newerTransaction = stage(
      evidence({
        id: 'b'.repeat(64),
        eventDate: '2026-10-26',
        eventAt: '2026-10-25T20:30:00.000Z',
        receivedAt: Date.parse('2026-10-25T20:31:00.000Z'),
      }),
    );
    const middleTransaction = stage(
      evidence({
        id: 'c'.repeat(64),
        eventDate: '2026-10-25',
        eventAt: '2026-10-25T16:25:00.000Z',
        receivedAt: Date.parse('2026-10-25T16:26:00.000Z'),
      }),
    );
    realRefresh();

    await service.filterReview({ ...readFilters('ALL'), state: 'ALL' });
    expect(service.candidates().map((candidate) => candidate.id)).toEqual([
      lateOlderTransaction.id,
      newerTransaction.id,
      middleTransaction.id,
    ]);
    expect((await service.loadReviewFilters()).sortOrder).toBe('RECEIVED_DESC');

    await service.filterReview({
      ...readFilters('ALL'),
      state: 'ALL',
      sortOrder: 'TRANSACTION_DESC',
    });
    expect(service.candidates().map((candidate) => candidate.id)).toEqual([
      newerTransaction.id,
      middleTransaction.id,
      lateOlderTransaction.id,
    ]);
    expect((await service.loadReviewFilters()).sortOrder).toBe('TRANSACTION_DESC');
    expect(count('card_transactions')).toBe(0);
  });
  it('keeps HSBC repayment and purchase evidence visible with tracking off without creating financial rows', async () => {
    const repayment = stage(
      evidence({
        id: 'a'.repeat(64),
        kind: 'PAYMENT_INITIATED',
        issuer: 'HSBC',
        accountDigits: '2006',
        direction: 'DEBIT',
        purposeHint: 'CARD_REPAYMENT',
        merchant: 'CRED Club',
        reference: '735182094701',
        amountMinor: 652066,
        eventDate: '2026-10-26',
        eventAt: '2026-10-25T18:30:00.000Z',
        eventTime: '00:00:00',
        eventTimeExplicit: false,
      }),
    );
    const purchase = stage(
      evidence({
        id: 'b'.repeat(64),
        kind: 'PURCHASE',
        issuer: 'HSBC',
        cardDigits: '0379',
        direction: undefined,
        purposeHint: undefined,
        merchant: 'FLIPKART',
        amountMinor: 101800,
        availableLimitMinor: 6334,
        amountDueMinor: 1048666,
        eventDate: '2026-10-26',
        eventAt: '2026-10-25T18:30:00.000Z',
        eventTime: '00:00:00',
        eventTimeExplicit: false,
        receivedAt: Date.parse('2026-10-26T18:31:00.000Z'),
      }),
    );
    realRefresh();

    await service.filterReview({ ...readFilters('ALL'), state: 'ALL', kind: 'ALL' });
    expect(service.candidates().map((candidate) => candidate.id)).toEqual([
      purchase.id,
      repayment.id,
    ]);
    expect(service.candidates().map((candidate) => candidate.item?.issuer)).toEqual([
      'HSBC',
      'HSBC',
    ]);
    expect(service.candidates()[0].item).toMatchObject({
      cardDigits: '0379',
      merchant: 'FLIPKART',
      amountMinor: 101800,
      availableLimitMinor: 6334,
      amountDueMinor: 1048666,
      eventTimeExplicit: false,
    });
    expect(service.candidates()[1].item).toMatchObject({
      kind: 'PAYMENT_INITIATED',
      accountDigits: '2006',
      direction: 'DEBIT',
      purposeHint: 'CARD_REPAYMENT',
      merchant: 'CRED Club',
      reference: '735182094701',
      amountMinor: 652066,
      eventTimeExplicit: false,
    });
    expect(count('card_transactions')).toBe(0);
    expect(count('source_transfers')).toBe(0);
  });
  it('keeps supported bank, card-payment, card-purchase and loan kinds visible in All types mode', async () => {
    const kinds: SmsEvidence['kind'][] = [
      'PURCHASE',
      'CARD_PAYMENT_RECEIVED',
      'BANK_DEBIT',
      'BANK_CREDIT',
      'PAYMENT_INITIATED',
      'LOAN_DEBIT',
      'LOAN_REMINDER',
    ];
    kinds.forEach((kind, index) =>
      stage(
        evidence({
          id: (index + 1).toString(16).padStart(64, '0'),
          kind,
          direction:
            kind === 'BANK_CREDIT' || kind === 'CARD_PAYMENT_RECEIVED' ? 'CREDIT' : 'DEBIT',
          purposeHint:
            kind === 'PAYMENT_INITIATED'
              ? 'CARD_REPAYMENT'
              : kind === 'BANK_CREDIT'
                ? 'INCOMING'
                : undefined,
        }),
      ),
    );
    realRefresh();

    await service.filterReview({ ...readFilters('ALL'), state: 'ALL', kind: 'ALL' });
    expect(
      service
        .candidates()
        .map((candidate) => candidate.kind)
        .sort(),
    ).toEqual(kinds.sort());
    expect(service.total()).toBe(kinds.length);
  });
  it('uses deterministic event-date fallback for missing or invalid receivedAt metadata', async () => {
    const validReceived = stage(
      evidence({
        id: 'a'.repeat(64),
        eventAt: '2010-01-01T00:00:00.000Z',
        receivedAt: Date.parse('2026-10-26T02:30:00.000Z'),
      }),
    );
    const missingReceived = stage(
      evidence({
        id: 'b'.repeat(64),
        eventAt: '2026-10-25T23:00:00.000Z',
        receivedAt: Date.parse('2020-01-01T00:00:00.000Z'),
      }),
    );
    const invalidReceived = stage(
      evidence({
        id: 'c'.repeat(64),
        eventAt: '2026-10-25T23:00:00.000Z',
        receivedAt: Date.parse('2020-01-01T00:00:00.000Z'),
      }),
    );
    run("UPDATE sms_candidates SET payload=json_remove(payload,'$.receivedAt') WHERE id=?", [
      missingReceived.id,
    ]);
    run(
      "UPDATE sms_candidates SET payload=json_set(payload,'$.receivedAt','legacy-invalid') WHERE id=?",
      [invalidReceived.id],
    );
    realRefresh();

    await service.filterReview({ ...readFilters('ALL'), state: 'ALL' });
    expect(service.candidates().map((candidate) => candidate.id)).toEqual([
      validReceived.id,
      missingReceived.id,
      invalidReceived.id,
    ]);
  });
  it('retains ascending candidate ID as the deterministic transaction-date tie-breaker', async () => {
    const second = stage(
      evidence({
        id: 'b'.repeat(64),
        eventAt: '2026-10-25T16:00:00.000Z',
        receivedAt: Date.parse('2026-10-25T18:00:00.000Z'),
      }),
    );
    const first = stage(
      evidence({
        id: 'a'.repeat(64),
        eventAt: '2026-10-25T16:00:00.000Z',
        receivedAt: Date.parse('2026-10-25T17:00:00.000Z'),
      }),
    );
    realRefresh();

    await service.filterReview({
      ...readFilters('ALL'),
      state: 'ALL',
      sortOrder: 'TRANSACTION_DESC',
    });
    expect(service.candidates().map((candidate) => candidate.id)).toEqual([first.id, second.id]);
  });
  it('sorts received timestamps across the full filtered dataset before the 200-row page limit', async () => {
    const baseReceivedAt = Date.parse('2026-10-01T00:00:00.000Z');
    const target = stage(
      evidence({
        id: 'f'.repeat(64),
        eventAt: '2010-01-01T00:00:00.000Z',
        receivedAt: baseReceivedAt + 10_000,
      }),
    );
    for (let index = 0; index < 204; index++)
      stage(
        evidence({
          id: (index + 1).toString(16).padStart(64, '0'),
          eventAt: `2026-10-26T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
          receivedAt: baseReceivedAt + index,
        }),
      );
    realRefresh();

    await service.filterReview({ ...readFilters('ALL'), state: 'ALL' });
    expect(service.total()).toBe(205);
    expect(service.candidates()).toHaveLength(200);
    expect(service.candidates()[0].id).toBe(target.id);
    const firstPageIds = service.candidates().map((candidate) => candidate.id);
    const oldestReceivedOnFirstPage = service.candidates().at(-1)!.item!.receivedAt;
    await service.turnPage(1);
    expect(service.candidates()).toHaveLength(5);
    expect(service.candidates()[0].item!.receivedAt).toBeLessThan(oldestReceivedOnFirstPage);
    expect(service.candidates().some((candidate) => firstPageIds.includes(candidate.id))).toBe(
      false,
    );
    expect(count('card_transactions')).toBe(0);
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
      sortOrder: 'TRANSACTION_DESC' as const,
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
      sortOrder: 'TRANSACTION_DESC',
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
        sortOrder: 'ORDER BY arbitrary SQL',
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
    expect(matchExisting({ ...item, dateFallback: true }, [card], [], [entry]).confidence).toBe(
      'POSSIBLE_EXISTING',
    );
    expect(
      matchExisting(item, [card], [], [entry, { ...entry, id: 'another' }]).transactionIds,
    ).toHaveLength(2);
  });
  it('blocks legacy due-date purchases until original evidence is recovered and retains identity/read state', async () => {
    const old = evidence({ parserVersion: 1, dueDate: '2026-10-18', merchant: undefined });
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
    const pending = stage(evidence({ parserVersion: 1, dueDate: '2026-10-18' }));
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
    const before = rows('SELECT id,state,transaction_id,payload,decision FROM sms_candidates');
    await service.markRead(candidate.id, true);
    expect(readCount()).toBe(1);
    expect(rows('SELECT id,state,transaction_id,payload,decision FROM sms_candidates')).toEqual(
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
      notes: 'Original manually entered note',
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
    expect(transactions()[0].notes).toBe('Original manually entered note');
  });
  it('adds validated annotations to a matched manual transaction without changing its financial data or provenance', async () => {
    const manual: CardTransaction = {
      id: 'synthetic-annotated-match',
      cardId: card.id,
      type: 'PURCHASE',
      amountMinor: 45000,
      currencyCode: 'INR',
      transactionDate: '2026-10-18',
      merchant: 'Synthetic merchant',
      categoryId: 'groceries',
      notes: 'Manual note stays intact',
      attachmentIds: [],
      createdAt: '2026-10-18T12:00:00Z',
      updatedAt: '2026-10-18T12:00:00Z',
    };
    run(
      'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        manual.id,
        manual.cardId,
        manual.categoryId,
        manual.type,
        manual.amountMinor,
        manual.currencyCode,
        manual.transactionDate,
        JSON.stringify(manual),
        manual.createdAt,
        manual.updatedAt,
      ],
    );
    transactions.set([manual]);
    const candidate = stage(evidence());
    await expect(
      service.approve(candidate, card.id, 45000, 'Synthetic', manual.id, 'PENDING', false, '', 0, {
        paymentMethod: 'UPI',
      }),
    ).rejects.toThrow('Choose a valid upi app');
    expect(count('card_transactions')).toBe(1);
    expect(
      JSON.parse(
        String(rows<{ payload: string }>('SELECT payload FROM card_transactions')[0].payload),
      ).notes,
    ).toBe('Manual note stays intact');

    await service.approve(
      candidate,
      card.id,
      45000,
      'Synthetic',
      manual.id,
      'PENDING',
      false,
      '',
      0,
      {
        paymentMethod: 'CARD_TAP',
        paymentMethodDetail: 'TAP_GPAY',
        smsAdditionalComment: 'Used at the synthetic market',
      },
    );
    const persisted = JSON.parse(
      String(rows<{ payload: string }>('SELECT payload FROM card_transactions')[0].payload),
    ) as CardTransaction;
    const transactionRow = rows<{ payload: string; updated_at: string }>(
      'SELECT payload,updated_at FROM card_transactions WHERE id=?',
      [manual.id],
    )[0];
    const transactionPayload = JSON.parse(transactionRow.payload) as CardTransaction;
    expect(transactionRow.updated_at).toBe(transactionPayload.updatedAt);
    expect(transactionPayload.updatedAt).not.toBe(manual.updatedAt);
    expect(persisted).toMatchObject({
      amountMinor: 45000,
      transactionDate: '2026-10-18',
      merchant: 'Synthetic merchant',
      paymentMethod: 'CARD_TAP',
      paymentMethodDetail: 'TAP_GPAY',
      smsAdditionalComment: 'Used at the synthetic market',
      notes: 'Card tap -> Tap (GPay)\nUsed at the synthetic market\nManual note stays intact',
    });
    expect(persisted.origin).toBeUndefined();
    expect(persisted.notes).not.toContain('(Approved SMS discovery)');
    expect(count('card_transactions')).toBe(1);
    expect(transactions()).toEqual([persisted]);
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
      institution: 'Pluxee',
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
    const approval = service.approve(candidate, card.id, 45000, 'Synthetic approved');
    // Release the intentionally blocked stale read before waiting for the
    // post-approval refresh, which is serialized behind it.
    release();
    await approval;
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
  it('retains uncertain historical snapshots until explicitly confirmed and preserves FASTag accounting', async () => {
    const wallets: PaymentSource[] = [
      {
        id: 'meal',
        nickname: 'DEMO meal',
        institution: 'Pluxee',
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
    // A distinct amount: an equal top-up one day apart is a legitimate possible duplicate.
    const retained = stage(
      evidence({
        id: 'c'.repeat(64),
        kind: 'PLUXEE_TOPUP',
        amountMinor: 30000,
        eventDate: '2026-10-17',
        eventAt: '2026-10-17T12:00:00Z',
      }),
    );
    await service.approve(retained, 'meal', 30000, 'Load', '', 'RETAIN_BALANCE');
    expect(sources()[0].balanceMinor).toBe(50000);
    expect(
      transactions().find((item) => item.id === `sms-${retained.id}`)?.sourceBalanceApplied,
    ).toBe(false);
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
      institution: 'Pluxee',
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
  it('reconciles an approved Pluxee top-up against its trusted post-event balance once in SQLite', async () => {
    const wallet: PaymentSource = {
      id: 'pluxee-6423',
      nickname: 'Pluxee meal card',
      institution: 'Pluxee',
      kind: 'MEAL',
      lastDigits: '6423',
      autoLoad: false,
      archived: false,
      noLimit: false,
      balanceMinor: 333124,
      balanceCutoverAt: '2026-10-23T12:15:00.000Z',
      balanceSnapshotMinor: 333124,
    };
    sources.set([wallet]);
    run('INSERT INTO app_preferences VALUES (?,?)', ['payment_sources', JSON.stringify([wallet])]);
    for (const [index, amountMinor] of [
      ...Array.from({ length: 14 }, () => 60000),
      163908,
    ].entries())
      manual({
        id: `historical-pluxee-${index}`,
        cardId: wallet.id,
        amountMinor,
        transactionDate: '2026-10-22',
        sourceBalanceApplied: false,
      });
    expect(
      transactions()
        .filter((entry) => entry.cardId === wallet.id)
        .reduce((sum, entry) => sum + entry.amountMinor, 0),
    ).toBe(1003908);
    const candidate = stage(
      evidence({
        id: 'f'.repeat(64),
        kind: 'PLUXEE_TOPUP',
        amountMinor: 880000,
        issuer: 'Pluxee',
        cardDigits: '6423',
        eventDate: '2026-10-23',
        eventAt: '2026-10-22T23:47:27.000Z',
        eventTime: '05:17:27',
        eventTimeExplicit: true,
        timeZone: 'Asia/Kolkata',
        reportedBalanceMinor: 973724,
        balancePosition: 'AFTER',
      }),
    );

    await service.approve(candidate, wallet.id, 880000, 'Meal wallet top-up');
    expect(sources()[0].balanceMinor).toBe(973724);
    expect(count('card_transactions')).toBe(16);
    const topup = JSON.parse(
      String(
        rows('SELECT payload FROM card_transactions WHERE id=?', [`sms-${candidate.id}`])[0][
          'payload'
        ],
      ),
    ) as CardTransaction;
    expect(topup).toMatchObject({
      type: 'CREDIT',
      amountMinor: 880000,
      transactionDate: '2026-10-23',
      transactionTime: '05:17:27',
      categoryId: 'contra-expenses',
      sourceBalanceApplied: true,
    });
    const storedSources = JSON.parse(
      String(
        rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0][
          'encrypted_value'
        ],
      ),
    ) as PaymentSource[];
    expect(storedSources[0].balanceMinor).toBe(973724);
    expect(storedSources[0]).toMatchObject({
      balanceCutoverAt: candidate.item!.eventAt,
      balanceCutoverReason: 'SMS_RECONCILIATION',
      balanceReconciliation: {
        savedBalanceMinor: 333124,
        predictedBalanceMinor: 1213124,
        correctionMinor: -239400,
      },
    });
    const decision = String(
      rows('SELECT decision FROM sms_reconciliation WHERE candidate_id=?', [candidate.id])[0][
        'decision'
      ],
    );
    expect(decision).toContain('saved 1213124; reported 973724');
    expect(decision).toContain('baseline decrease 239400 minor units');

    await service.approve(candidate, wallet.id, 880000, 'Meal wallet top-up');
    expect(count('card_transactions')).toBe(16);
    expect(sources()[0].balanceMinor).toBe(973724);
    sources.set(storedSources);
    expect(sources()[0].balanceMinor).toBe(973724);

    const historical = stage(
      evidence({
        id: 'b'.repeat(64),
        kind: 'PLUXEE_PURCHASE',
        amountMinor: 1200,
        eventDate: '2026-10-21',
        eventAt: '2026-10-21T12:00:00Z',
      }),
    );
    await service.approve(historical, wallet.id, 1200, 'Historical already included');
    expect(
      transactions().find((entry) => entry.id === `sms-${historical.id}`)?.sourceBalanceApplied,
    ).toBe(false);
    expect(sources()[0].balanceMinor).toBe(973724);
    const later = stage(
      evidence({
        id: 'c'.repeat(64),
        kind: 'PLUXEE_TOPUP',
        amountMinor: 10000,
        eventDate: '2026-10-24',
        eventAt: '2026-10-24T00:30:00Z',
        eventTime: '06:00:00',
        eventTimeExplicit: true,
        reportedBalanceMinor: 2000000,
        balancePosition: 'AFTER',
      }),
    );
    await service.approve(later, wallet.id, 10000, 'Later load');
    expect(sources()[0].balanceMinor).toBe(983724);
    expect(sources()[0].balanceReconciliation?.candidateId).toBe(candidate.id);
  });
  function repairFixture(
    sourceChanges: Partial<PaymentSource> = {},
    evidenceChanges: Partial<SmsEvidence> = {},
  ): { wallet: PaymentSource; candidate: SmsCandidate } {
    const wallet: PaymentSource = {
      id: 'meal-repair',
      nickname: 'Synthetic Pluxee',
      institution: 'Sodexo',
      kind: 'MEAL',
      balanceMinor: 333124,
      balanceCutoverAt: '2026-10-23T12:15:00Z',
      balanceSnapshotMinor: 333124,
      noLimit: false,
      autoLoad: false,
      archived: false,
      ...sourceChanges,
    };
    sources.set([wallet]);
    run('INSERT INTO app_preferences VALUES(?,?)', ['payment_sources', JSON.stringify([wallet])]);
    const candidate = stage(
      evidence({
        kind: 'PLUXEE_TOPUP',
        issuer: 'Pluxee',
        amountMinor: 880000,
        eventDate: '2026-10-23',
        eventAt: '2026-10-22T23:47:27Z',
        eventTime: '05:17:27',
        eventTimeExplicit: true,
        timeZone: 'Asia/Kolkata',
        reportedBalanceMinor: 973724,
        balancePosition: 'AFTER',
        ...evidenceChanges,
      }),
    );
    return { wallet, candidate };
  }
  it.each([
    { dateFallback: true },
    { eventTimeExplicit: false },
    { eventTime: '25:17:27' },
    { eventAt: '2026-10-23T01:00:00Z' },
    { balancePosition: 'UNKNOWN' as const },
    { balancePosition: 'BEFORE' as const },
  ])('does not replace an uncertain historical baseline from %j', async (evidenceChanges) => {
    const { wallet, candidate } = repairFixture({}, evidenceChanges);
    await expect(service.approve(candidate, wallet.id, 880000, 'Load')).rejects.toThrow('snapshot');
    expect(sources()[0].balanceMinor).toBe(333124);
    expect(count('card_transactions')).toBe(0);
    expect(count('sms_reconciliation')).toBe(0);
  });
  it.each(['MANUAL', 'SMS_RECONCILIATION'] as const)(
    'never replaces a newer confirmed %s snapshot',
    async (balanceCutoverReason) => {
      const { wallet, candidate } = repairFixture({ balanceCutoverReason });
      await expect(
        service.approve(candidate, wallet.id, 880000, 'Load', '', 'ADJUST_BALANCE'),
      ).rejects.toThrow('newer');
      expect(sources()[0].balanceMinor).toBe(333124);
    },
  );
  it.each([
    ['2026-10-23', '05:18:00'],
    ['2026-10-23', undefined],
    ['2026-10-24', '01:00:00'],
  ])(
    'blocks an older repair when recorded activity is at %s %s',
    async (transactionDate, transactionTime) => {
      const { wallet, candidate } = repairFixture();
      manual({ cardId: wallet.id, transactionDate, transactionTime });
      await expect(service.approve(candidate, wallet.id, 880000, 'Load')).rejects.toThrow(
        'snapshot',
      );
      expect(sources()[0].balanceMinor).toBe(333124);
      expect(count('card_transactions')).toBe(1);
    },
  );
  it('does not reconcile edited event amounts or dates and rolls back failed audit persistence', async () => {
    const { wallet, candidate } = repairFixture();
    await expect(service.approve(candidate, wallet.id, 880100, 'Load')).rejects.toThrow('snapshot');
    await expect(
      service.approve(candidate, wallet.id, 880000, 'Load', '', 'ADJUST_BALANCE', false, '', 0, {
        transactionDate: '2026-10-24',
      }),
    ).rejects.toThrow();
    sql.exec(
      "CREATE TRIGGER fail_repair_audit BEFORE INSERT ON sms_reconciliation BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
    );
    await expect(service.approve(candidate, wallet.id, 880000, 'Load')).rejects.toThrow(
      'synthetic audit failure',
    );
    expect(sources()[0].balanceMinor).toBe(333124);
    expect(
      JSON.parse(
        String(
          rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0][
            'encrypted_value'
          ],
        ),
      )[0].balanceMinor,
    ).toBe(333124);
    expect(count('card_transactions')).toBe(0);
    expect(rows('SELECT state FROM sms_candidates')[0]['state']).toBe('PENDING');
  });
  it.each([undefined, 'SMS_RECONCILIATION'] as const)(
    'deducts an explicitly verified omitted purchase once instead of permanently excluding it (%s snapshot)',
    async (balanceCutoverReason) => {
      const { wallet, candidate } = repairFixture(
        { balanceCutoverReason },
        {
          kind: 'PLUXEE_PURCHASE',
          amountMinor: 50000,
          reportedBalanceMinor: undefined,
          eventTimeExplicit: false,
        },
      );
      await expect(
        service.approve(candidate, wallet.id, 50000, 'Fictional purchase'),
      ).rejects.toThrow('snapshot');
      await service.approve(candidate, wallet.id, 50000, 'Fictional purchase', '', 'APPLY_EVENT');
      expect(sources()[0].balanceMinor).toBe(283124);
      expect(transactions()[0].sourceBalanceApplied).toBe(true);
      await service.approve(candidate, wallet.id, 50000, 'Fictional purchase', '', 'APPLY_EVENT');
      expect(sources()[0].balanceMinor).toBe(283124);
      expect(count('card_transactions')).toBe(1);
    },
  );
  it('will not automatically repair an ambiguous, archived, unrelated or conflicting wallet', async () => {
    const { wallet, candidate } = repairFixture();
    const alternate = { ...wallet, id: 'second' };
    run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
      JSON.stringify([wallet, alternate]),
    ]);
    await expect(service.approve(candidate, wallet.id, 880000, 'Load')).rejects.toThrow('snapshot');
    for (const changes of [
      { archived: true },
      { institution: 'Other provider', nickname: 'Unrelated meal wallet' },
    ]) {
      run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
        JSON.stringify([{ ...wallet, ...changes }]),
      ]);
      await expect(service.approve(candidate, wallet.id, 880000, 'Load')).rejects.toThrow('Pluxee');
    }
    run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
      JSON.stringify([{ ...wallet, lastDigits: '1111' }]),
    ]);
    run('UPDATE sms_candidates SET payload=? WHERE id=?', [
      JSON.stringify({ ...candidate.item, cardDigits: '2222' }),
      candidate.id,
    ]);
    await expect(service.approve(candidate, wallet.id, 880000, 'Load')).rejects.toThrow('suffix');
    expect(count('card_transactions')).toBe(0);
  });
  it('retains the repair tombstone when an alternate SMS fingerprint attempts to replay the same event', async () => {
    const { wallet, candidate } = repairFixture();
    await service.approve(candidate, wallet.id, 880000, 'Load');
    const duplicate = stage({
      ...candidate.item!,
      id: 'b'.repeat(64),
      eventAt: new Date(candidate.item!.eventAt).toISOString(),
    });
    await expect(
      service.approve(duplicate, wallet.id, 880000, 'Load', '', 'PENDING', true),
    ).rejects.toThrow('already reconciled');
    expect(sources()[0].balanceMinor).toBe(973724);
    expect(count('card_transactions')).toBe(1);
    const existing = transactions()[0];
    await service.approve(duplicate, wallet.id, 880000, 'Load', existing.id);
    expect(sources()[0].balanceMinor).toBe(973724);
    expect(count('card_transactions')).toBe(1);
    const actualStore = TestBed.runInInjectionContext(() => new CardNestStore());
    actualStore.paymentSources.set(sources());
    actualStore.transactions.set(transactions());
    actualStore.deleteTransaction(existing.id);
    await TestBed.inject(SqliteDatabase).atomic(async () => undefined);
    const afterDeletion = stage({ ...candidate.item!, id: 'c'.repeat(64) });
    await expect(
      service.approve(afterDeletion, wallet.id, 880000, 'Load', '', 'PENDING', true),
    ).rejects.toThrow('already reconciled');
    expect(count('card_transactions')).toBe(0);
  });
  it.each([
    ['PLUXEE_PURCHASE', 'dining'],
    ['PLUXEE_TOPUP', 'contra-expenses'],
  ] as const)(
    'uses a valid existing %s category and falls back to Other',
    async (kind, preferred) => {
      const { wallet, candidate } = repairFixture(
        { balanceCutoverAt: undefined },
        {
          kind,
          reportedBalanceMinor: undefined,
        },
      );
      run('DELETE FROM categories WHERE id=?', [preferred]);
      await service.approve(candidate, wallet.id, 880000, 'Synthetic event');
      expect(transactions()[0].categoryId).toBe('other');
      run(
        "INSERT INTO categories(id,name,icon,applies_to) VALUES('synthetic-custom','Synthetic custom','category','BOTH')",
      );
      const nearby = stage({
        ...candidate.item!,
        id: 'b'.repeat(64),
        eventDate: '2026-10-24',
        eventAt: '2026-10-24T12:00:00Z',
      });
      await expect(
        service.approve(nearby, wallet.id, 880000, 'Nearby event', '', 'PENDING', false, '', 0, {
          categoryId: 'synthetic-custom',
        }),
      ).rejects.toThrow('Possible existing transaction');
      expect(count('card_transactions')).toBe(1);
      const next = stage({
        ...candidate.item!,
        id: 'c'.repeat(64),
        amountMinor: 120000,
        eventDate: '2026-10-24',
        eventAt: '2026-10-24T12:00:00Z',
      });
      await service.approve(next, wallet.id, 120000, 'Custom event', '', 'PENDING', false, '', 0, {
        categoryId: 'synthetic-custom',
      });
      expect(transactions()[0].categoryId).toBe('synthetic-custom');
      expect(count('card_transactions')).toBe(2);
    },
  );
  it('allows a guarded one-time baseline repair for an already approved Pluxee top-up', async () => {
    const wallet: PaymentSource = {
      id: 'pluxee-6423',
      nickname: 'Pluxee meal card',
      institution: 'Sodexo',
      kind: 'MEAL',
      lastDigits: '6423',
      autoLoad: false,
      archived: false,
      noLimit: false,
      balanceMinor: 333124,
      balanceCutoverAt: '2026-10-23T12:15:00.000Z',
    };
    sources.set([wallet]);
    run('INSERT INTO app_preferences VALUES (?,?)', ['payment_sources', JSON.stringify([wallet])]);
    const existing = manual({
      id: 'already-approved-pluxee-topup',
      cardId: wallet.id,
      type: 'CREDIT',
      amountMinor: 880000,
      transactionDate: '2026-10-23',
      sourceBalanceApplied: false,
    });
    const candidate = stage(
      evidence({
        id: 'e'.repeat(64),
        kind: 'PLUXEE_TOPUP',
        amountMinor: 880000,
        issuer: 'Pluxee',
        cardDigits: '6423',
        eventDate: '2026-10-23',
        eventAt: '2026-10-22T23:47:27.000Z',
        eventTime: '05:17:27',
        eventTimeExplicit: true,
        reportedBalanceMinor: 973724,
        balancePosition: 'AFTER',
      }),
    );
    run("UPDATE sms_candidates SET state='IMPORTED',transaction_id=? WHERE id=?", [
      existing.id,
      candidate.id,
    ]);

    await service.adjustMatchedBalance(candidate);
    expect(sources()[0].balanceMinor).toBe(973724);
    expect(count('card_transactions')).toBe(1);
    expect(
      String(
        rows('SELECT decision FROM sms_reconciliation WHERE candidate_id=?', [candidate.id])[0][
          'decision'
        ],
      ),
    ).toContain('baseline correction -239400');
    await service.adjustMatchedBalance(candidate);
    expect(count('card_transactions')).toBe(1);
    expect(sources()[0].balanceMinor).toBe(973724);
    const actualStore = TestBed.runInInjectionContext(() => new CardNestStore());
    actualStore.paymentSources.set(sources());
    actualStore.transactions.set([existing]);
    actualStore.updateTransaction({ ...existing, amountMinor: 870000 });
    await TestBed.inject(SqliteDatabase).atomic(async () => undefined);
    expect(actualStore.paymentSources()[0].balanceMinor).toBe(963724);
    actualStore.deleteTransaction(existing.id);
    await TestBed.inject(SqliteDatabase).atomic(async () => undefined);
    expect(actualStore.paymentSources()[0].balanceMinor).toBe(93724);
    expect(count('card_transactions')).toBe(0);
  });
  it('explicit Pluxee reconciliation saves an audited baseline and rejects an older snapshot', async () => {
    const wallet: PaymentSource = {
      id: 'meal',
      nickname: 'DEMO',
      institution: 'Pluxee',
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
        eventTime: '17:30:00',
        eventTimeExplicit: true,
      }),
    );
    await service.approve(candidate, 'meal', 2000, 'Load', '', 'ADJUST_BALANCE');
    expect(sources()[0].balanceMinor).toBe(8000);
    expect(count('card_transactions')).toBe(1);
    expect(sources()[0].balanceReconciliation?.correctionMinor).toBe(1000);
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
    ).rejects.toThrow('balance');
    expect(sources()[0].balanceMinor).toBe(8000);
    expect(count('card_transactions')).toBe(1);
  });
  it('repairs the selected existing top-up without posting a second load', async () => {
    const wallet: PaymentSource = {
      id: 'meal',
      nickname: 'DEMO',
      institution: 'Pluxee',
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
      institution: 'Pluxee',
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
