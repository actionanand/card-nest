import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
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
      if (transaction) transactions.update((items) => [transaction, ...items]);
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
    for (const id of ['other', 'payment', 'contra-expenses'])
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
        SmsReviewService,
        { provide: CardNestStore, useValue: store },
        { provide: AppLockService, useValue: lock },
        {
          provide: SqliteDatabase,
          useValue: {
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
  it('ambiguous suffixes remain multiple candidates and no suffix never guesses a card', () => {
    const cards = [card, { ...card, id: 'second' }] as Parameters<typeof eligibleSources>[1];
    expect(
      eligibleSources(evidence({ cardDigits: '4321', issuer: 'AMEX' }), cards, []),
    ).toHaveLength(2);
    expect(eligibleSources(evidence({ issuer: 'AMEX' }), cards, [])).toEqual([]);
    expect(existingSuggestions(evidence(), card.id, [])).toEqual([]);
  });
});
