import { Service, computed, inject, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { CardNestStore } from '../../core/services/card-nest-store';
import { AppLockService } from '../../core/services/app-lock.service';
import {
  CardTransaction,
  CardStatement,
  EmiInstallment,
  PaymentSource,
} from '../../core/models/domain';
import { environment } from '../../../environments/environment';
import {
  SmsCandidate,
  SmsEvidence,
  ScanStatus,
  ReviewState,
  ReconciliationChoice,
  ApprovalEdits,
  ledgerType,
  validEvidence,
  existingSuggestions,
  transferRelationship,
} from './sms-model';

interface NativeSms {
  status(): Promise<ScanStatus>;
  enable(options: { since: number; batch: number }): Promise<ScanStatus>;
  openSettings(): Promise<void>;
  disable(): Promise<ScanStatus>;
  cancel(): Promise<ScanStatus>;
  scanPage(): Promise<ScanStatus>;
  beginScan(): Promise<void>;
  catchUp(): Promise<void>;
  pending(): Promise<{ items: unknown[] }>;
  acknowledge(options: { ids: string[] }): Promise<void>;
  parseText(options: { text: string }): Promise<{ item: unknown }>;
  clear(): Promise<void>;
}
const native = registerPlugin<NativeSms>('CardNestSms');

@Service()
export class SmsReviewService {
  private readonly database = inject(SqliteDatabase);
  private readonly store = inject(CardNestStore);
  readonly lock = inject(AppLockService);
  readonly status = signal<ScanStatus | null>(null);
  readonly candidates = signal<readonly SmsCandidate[]>([]);
  readonly busy = signal(false);
  readonly requestingPermission = signal(false);
  readonly canScan = computed(() => {
    const status = this.status();
    return status?.permission === 'granted' && status.enabled && !this.requestingPermission();
  });
  readonly error = signal('');
  readonly duplicates = signal(0);
  readonly reviewPage = signal(0);
  readonly total = signal(0);
  readonly pendingTotal = signal(0);
  readonly savedTotal = signal(0);
  readonly notice = signal('');
  private accessRevision = 0;
  private filters = { state: 'PENDING', kind: 'ALL', search: '', source: '', from: '', to: '' };
  async filterReview(
    filters: Omit<typeof this.filters, 'from' | 'to'> & { from?: string; to?: string },
  ): Promise<void> {
    this.filters = { from: '', to: '', ...filters };
    this.reviewPage.set(0);
    await this.refresh();
  }
  async turnPage(direction: number): Promise<void> {
    this.reviewPage.update((page) => Math.max(0, page + direction));
    await this.refresh();
  }
  private cancelled = false;
  async relatedFor(candidate: SmsCandidate): Promise<readonly SmsCandidate[]> {
    this.assertUnlocked();
    const item = candidate.item;
    if (!item?.reference) return [];
    const rows = await this.database.query<{
      id: string;
      state: ReviewState;
      kind: SmsEvidence['kind'];
      event_at: string;
      payload: string;
      transaction_id: string;
    }>(
      `SELECT * FROM sms_candidates WHERE id != ? AND payload IS NOT NULL AND payload LIKE ? LIMIT 50`,
      [candidate.id, `%${item.reference}%`],
    );
    return rows.flatMap((row) => {
      const other: unknown = JSON.parse(row.payload);
      if (
        !validEvidence(other) ||
        other.reference !== item.reference ||
        other.amountMinor !== item.amountMinor
      )
        return [];
      if (
        !transferRelationship(item, other) &&
        !(
          ledgerType(item) === ledgerType(other) ||
          item.kind === 'PAYMENT_INITIATED' ||
          other.kind === 'PAYMENT_INITIATED'
        )
      )
        return [];
      return [
        {
          id: row.id,
          state: row.state,
          kind: row.kind,
          eventAt: row.event_at,
          item: other,
          transactionId: row.transaction_id,
        },
      ];
    });
  }
  private assertUnlocked(): void {
    if (Capacitor.getPlatform() !== 'android' || this.lock.locked() || !this.lock.foreground())
      throw new Error('Unlock CardNest on Android to review SMS.');
  }
  async refresh(): Promise<void> {
    this.assertUnlocked();
    await this.refreshAccess();
    await this.handoff();
    const [totals] = await this.database.query<{ saved: number; pending: number }>(
      `SELECT COUNT(*) AS saved, COALESCE(SUM(CASE WHEN state='PENDING' THEN 1 ELSE 0 END),0) AS pending FROM sms_candidates`,
    );
    this.savedTotal.set(totals.saved);
    this.pendingTotal.set(totals.pending);
    const filters = this.filters;
    const where = `WHERE (? = 'ALL' OR state = ?) AND (? = 'ALL' OR kind = ?)
      AND (? = '' OR (COALESCE(json_extract(payload,'$.merchant'),'') || ' ' || COALESCE(json_extract(payload,'$.reference'),'')) LIKE ?)
      AND (? = '' OR (COALESCE(json_extract(payload,'$.cardDigits'),'') || ' ' || COALESCE(json_extract(payload,'$.vehicleNumber'),'') || ' ' || COALESCE(json_extract(payload,'$.issuer'),'')) LIKE ?)
      AND (? = '' OR COALESCE(json_extract(payload,'$.eventDate'),substr(event_at,1,10)) >= ?)
      AND (? = '' OR COALESCE(json_extract(payload,'$.eventDate'),substr(event_at,1,10)) <= ?)`;
    const values = [
      filters.state,
      filters.state,
      filters.kind,
      filters.kind,
      filters.search,
      `%${filters.search}%`,
      filters.source,
      `%${filters.source}%`,
      filters.from,
      filters.from,
      filters.to,
      filters.to,
    ];
    const [count] = await this.database.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM sms_candidates ${where}`,
      values,
    );
    this.total.set(count.total);
    this.reviewPage.update((page) => Math.min(page, Math.max(0, Math.ceil(count.total / 200) - 1)));
    const rows = await this.database.query<{
      id: string;
      state: ReviewState;
      kind: SmsEvidence['kind'];
      event_at: string;
      payload: string | null;
      transaction_id: string;
    }>(`SELECT * FROM sms_candidates ${where} ORDER BY event_at DESC, id LIMIT 200 OFFSET ?`, [
      ...values,
      this.reviewPage() * 200,
    ]);
    this.candidates.set(
      rows.map((r) => ({
        id: r.id,
        state: r.state,
        kind: r.kind,
        eventAt: r.event_at,
        item: r.payload ? (JSON.parse(r.payload) as SmsEvidence) : null,
        transactionId: r.transaction_id,
      })),
    );
  }
  async enable(days: number): Promise<void> {
    this.assertUnlocked();
    if (this.requestingPermission() || this.busy()) return;
    this.requestingPermission.set(true);
    this.error.set('');
    const revision = ++this.accessRevision;
    try {
      const status = await native.enable({
        since: days === 0 ? 0 : Date.now() - days * 86400000,
        batch: environment.smsPageSize,
      });
      if (revision !== this.accessRevision) return;
      this.accessRevision++;
      this.status.set(status);
      if (status.permission !== 'granted' || !status.enabled)
        this.error.set(
          status.permissionMessage ??
            'Android did not grant both SMS permissions. Check app settings or paste a message.',
        );
    } catch (error: unknown) {
      if (revision !== this.accessRevision) return;
      this.accessRevision++;
      this.error.set(
        error instanceof Error
          ? error.message
          : 'Android could not request SMS access. Check app settings or paste a message.',
      );
      try {
        await this.refreshAccess();
      } catch {
        /* Preserve the request error if the bridge is unavailable. */
      }
    } finally {
      this.requestingPermission.set(false);
    }
  }
  async refreshAccess(): Promise<void> {
    this.assertUnlocked();
    const revision = this.accessRevision;
    const status = await native.status();
    if (revision === this.accessRevision) {
      if (
        !this.requestingPermission() &&
        status.permission === 'granted' &&
        this.status()?.permission !== 'granted'
      )
        this.error.set('');
      this.status.set(status);
    }
  }
  async openSettings(): Promise<void> {
    this.assertUnlocked();
    await native.openSettings();
  }
  async disable(): Promise<void> {
    this.cancelled = true;
    const revision = ++this.accessRevision;
    const status = await native.disable();
    if (revision === this.accessRevision) {
      this.accessRevision++;
      this.status.set(status);
    }
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
    const revision = ++this.accessRevision;
    const status = await native.cancel();
    if (revision === this.accessRevision) {
      this.accessRevision++;
      this.status.set(status);
    }
  }
  async scan(): Promise<void> {
    if (this.busy()) return;
    this.assertUnlocked();
    this.busy.set(true);
    this.cancelled = false;
    this.error.set('');
    try {
      await this.refreshAccess();
      if (!this.canScan()) {
        this.error.set(
          this.status()?.permissionMessage ?? 'Enable both SMS permissions before scanning.',
        );
        return;
      }
      await native.beginScan();
      let more = true;
      while (more && !this.cancelled && !this.lock.locked() && this.lock.foreground()) {
        await this.handoff();
        const status = await native.scanPage();
        this.status.set(status);
        more = status.more;
      }
      await this.refresh();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Scan failed. Retry is safe.');
      if (!this.lock.locked() && this.lock.foreground()) {
        try {
          await this.refreshAccess();
        } catch {
          /* Keep the original scan failure. */
        }
      }
    } finally {
      this.busy.set(false);
      if (
        !this.cancelled &&
        this.canScan() &&
        this.status()?.backgroundPending &&
        (!this.lock.foreground() || this.lock.locked())
      )
        await native.catchUp();
    }
  }
  async paste(text: string): Promise<void> {
    this.assertUnlocked();
    const result = await native.parseText({ text });
    if (!validEvidence(result.item))
      throw new Error('No supported financial event found. OTP and marketing are discarded.');
    await this.stage([result.item]);
    await this.refresh();
  }
  private async stage(items: readonly SmsEvidence[]): Promise<void> {
    await this.database.atomic(async (tx) => {
      const [retention] = await tx.query<{ value: string }>(
        `SELECT value FROM sms_sync_state WHERE key='retention_cutoff'`,
      );
      for (const item of items) {
        const changes = await tx.run(
          `INSERT OR IGNORE INTO sms_candidates(id, provider_id, event_at, kind, state, payload, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id,
            item.providerId,
            item.eventAt,
            item.kind,
            retention && item.eventDate < retention.value ? 'IGNORED' : 'PENDING',
            retention && item.eventDate < retention.value ? null : JSON.stringify(item),
            new Date().toISOString(),
          ],
        );
        if (!changes) this.duplicates.update((n) => n + 1);
      }
    });
  }
  private async handoff(): Promise<void> {
    for (;;) {
      this.assertUnlocked();
      const { items } = await native.pending();
      if (!items.length) return;
      if (!items.every(validEvidence))
        throw new Error('Invalid native evidence; queue preserved for recovery.');
      await this.stage(items);
      // Crash here replays INSERT OR IGNORE without losing review decisions.
      await native.acknowledge({ ids: items.map((item) => item.id) });
    }
  }
  async decide(
    candidate: SmsCandidate,
    state: 'REJECTED' | 'DEFERRED' | 'IGNORED' | 'PENDING',
  ): Promise<void> {
    this.assertUnlocked();
    await this.database.run(
      `UPDATE sms_candidates SET state = ?, updated_at = ? WHERE id = ? AND state NOT IN ('IMPORTED','MATCHED_EXISTING')`,
      [state, new Date().toISOString(), candidate.id],
    );
    await this.refresh();
  }
  async rejectBatch(candidates: readonly SmsCandidate[]): Promise<void> {
    this.assertUnlocked();
    await this.database.atomic(async (tx) => {
      for (const candidate of candidates.slice(0, 200))
        await tx.run(
          `UPDATE sms_candidates SET state='REJECTED',updated_at=? WHERE id=? AND state IN ('PENDING','DEFERRED')`,
          [new Date().toISOString(), candidate.id],
        );
    });
    await this.refresh();
  }
  async approve(
    candidate: SmsCandidate,
    sourceId: string,
    amountMinor: number,
    merchant: string,
    existingId = '',
    reconciliation: ReconciliationChoice = 'PENDING',
    allowSeparate = false,
    settlementDate = '',
    statementDueMinor = 0,
    edits: ApprovalEdits = {},
  ): Promise<void> {
    this.assertUnlocked();
    const result = await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ state: string; payload: string | null }>(
        'SELECT state, payload FROM sms_candidates WHERE id = ?',
        [candidate.id],
      );
      if (!row || ['IMPORTED', 'MATCHED_EXISTING'].includes(row.state)) return null;
      if (!row.payload || !['PENDING', 'DEFERRED'].includes(row.state))
        throw new Error('Reopen this item for review first.');
      const item: unknown = JSON.parse(row.payload);
      if (!validEvidence(item)) throw new Error('Evidence unavailable.');
      const type = ledgerType(item);
      if (!type)
        throw new Error(
          'This notification is evidence only. Link or reconcile it explicitly; do not create spending.',
        );
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !sourceId)
        throw new Error('Choose source and a valid amount.');
      const card = this.store.cards().find((c) => c.id === sourceId && !c.deletedAt);
      const [pref] = await tx.query<{ encrypted_value: string }>(
        `SELECT encrypted_value FROM app_preferences WHERE key = 'payment_sources'`,
      );
      const sources = pref
        ? (JSON.parse(pref.encrypted_value) as PaymentSource[])
        : this.store.paymentSources().map((source) => ({ ...source }));
      const source = sources.find((s) => s.id === sourceId);
      const wallet = item.kind.startsWith('PLUXEE') || item.kind.startsWith('FASTAG');
      if (
        wallet
          ? !source || source.kind !== (item.kind.startsWith('FASTAG') ? 'FASTAG' : 'MEAL')
          : !card
      )
        throw new Error('Source type does not match this event.');
      if (card && card.currencyCode !== item.currency)
        throw new Error(
          'Currency differs from this card. Use manual entry with an explicit currency conversion.',
        );
      if (
        source?.kind === 'FASTAG' &&
        item.vehicleNumber &&
        source.vehicleNumber !== item.vehicleNumber
      )
        throw new Error('Choose the wallet for this vehicle.');
      const ledger = (
        await tx.query<{ payload: string }>('SELECT payload FROM card_transactions')
      ).map((r) => JSON.parse(r.payload) as CardTransaction);
      const now = new Date().toISOString();
      const transactionDate = edits.transactionDate ?? item.eventDate;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) ||
        !Number.isFinite(Date.parse(transactionDate)) ||
        new Date(transactionDate).toISOString().slice(0, 10) !== transactionDate
      )
        throw new Error('Enter a valid event date.');
      if (
        edits.categoryId &&
        !(await tx.query('SELECT id FROM categories WHERE id=?', [edits.categoryId])).length
      )
        throw new Error('Choose an existing category.');
      let statement: CardStatement | null = null;
      let balanceAdjustment: CardTransaction | null = null;
      let transaction: CardTransaction | null = null;
      let transactionId = existingId;
      if (existingId) {
        const existing = ledger.find((t) => t.id === existingId);
        if (!existing || existing.cardId !== sourceId || existing.type !== type)
          throw new Error('Existing entry must have the same source and event type.');
        if (existing.amountMinor !== amountMinor && reconciliation !== 'REPAIR_EXISTING')
          throw new Error('Amounts differ. Repair the existing transaction before linking.');
        if (reconciliation === 'REPAIR_EXISTING') {
          if (!source || existing.type !== 'CREDIT')
            throw new Error('Only a confirmed existing wallet top-up can be repaired here.');
          transaction = {
            ...existing,
            amountMinor,
            merchant: merchant.trim().slice(0, 100),
            transactionDate,
            categoryId: edits.categoryId ?? existing.categoryId,
            updatedAt: now,
          };
          await tx.run(
            'UPDATE card_transactions SET amount_minor=?,transaction_date=?,category_id=?,payload=?,updated_at=? WHERE id=?',
            [
              amountMinor,
              transactionDate,
              transaction.categoryId,
              JSON.stringify(transaction),
              now,
              existingId,
            ],
          );
          if (existing.sourceBalanceApplied !== false && !source.noLimit) {
            source.balanceMinor = (source.balanceMinor ?? 0) + amountMinor - existing.amountMinor;
            if (!Number.isSafeInteger(source.balanceMinor))
              throw new Error('Wallet balance would overflow.');
            await tx.run(
              `INSERT INTO app_preferences(key,encrypted_value) VALUES ('payment_sources',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value`,
              [JSON.stringify(sources)],
            );
          }
        }
      } else {
        if (reconciliation === 'REPAIR_EXISTING')
          throw new Error('Select the existing top-up to repair.');
        if (
          !allowSeparate &&
          (existingSuggestions(item, sourceId, ledger).length ||
            existingSuggestions(
              { ...item, amountMinor, eventDate: transactionDate },
              sourceId,
              ledger,
            ).length)
        )
          throw new Error(
            'Possible existing transaction. Match it or explicitly confirm a separate event.',
          );
        // Cross-message issuer confirmations with a shared reference cannot post twice.
        if (item.reference && type === 'PAYMENT') {
          const bindings = await tx.query<{ payload: string; transaction_id: string }>(
            `SELECT payload,transaction_id FROM sms_candidates WHERE state IN ('IMPORTED','MATCHED_EXISTING') AND payload IS NOT NULL`,
          );
          if (
            bindings.some((r) => {
              const other = JSON.parse(r.payload) as SmsEvidence;
              return (
                other.reference === item.reference &&
                other.amountMinor === item.amountMinor &&
                ledgerType(other) === type &&
                ledger.some((t) => t.id === r.transaction_id && t.cardId === sourceId)
              );
            })
          )
            throw new Error('This referenced event is already linked. Match its existing entry.');
        }
        const beforeCutover =
          !!source?.balanceCutoverAt &&
          (Date.parse(item.eventAt) < Date.parse(source.balanceCutoverAt) ||
            transactionDate < source.balanceCutoverAt.slice(0, 10));
        if (beforeCutover && reconciliation !== 'RETAIN_BALANCE')
          throw new Error(
            'Historical wallet event precedes the balance snapshot. Choose retain balance to avoid double-counting.',
          );
        transactionId = `sms-${item.id}`;
        transaction = {
          id: transactionId,
          cardId: sourceId,
          type,
          amountMinor,
          currencyCode: 'INR',
          transactionDate,
          transactionTime: item.eventTime,
          merchant: merchant.trim().slice(0, 100),
          categoryId:
            type === 'PAYMENT'
              ? 'payment'
              : ['CASHBACK', 'REFUND', 'CREDIT'].includes(type)
                ? 'contra-expenses'
                : 'other',
          notes: `Approved SMS discovery${item.dateFallback ? '; received date used' : ''}`,
          attachmentIds: [],
          createdAt: now,
          updatedAt: now,
        };
        transaction.sourceBalanceApplied = !beforeCutover;
        if (edits.categoryId) transaction.categoryId = edits.categoryId;
        if (edits.relatedTransactionId) {
          const original = ledger.find((t) => t.id === edits.relatedTransactionId);
          if (
            type !== 'REFUND' ||
            !original ||
            original.type !== 'PURCHASE' ||
            original.cardId !== sourceId
          )
            throw new Error('Choose an original purchase on the same source.');
          transaction.relatedTransactionId = original.id;
        }
        await tx.run(
          `INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            transaction.id,
            card?.id ?? null,
            transaction.categoryId,
            type,
            amountMinor,
            'INR',
            transactionDate,
            JSON.stringify(transaction),
            now,
            now,
          ],
        );
        if (transaction.relatedTransactionId)
          await tx.run(
            `INSERT INTO transaction_links(transaction_id,related_transaction_id,relationship_type,created_at) VALUES (?,?,'REFUND',?)`,
            [transaction.id, transaction.relatedTransactionId, now],
          );
        if (source && !source.noLimit && !beforeCutover) {
          source.balanceMinor =
            (source.balanceMinor ?? 0) + (type === 'PURCHASE' ? -amountMinor : amountMinor);
          if (!Number.isSafeInteger(source.balanceMinor))
            throw new Error('Wallet balance would overflow.');
          await tx.run(
            `INSERT INTO app_preferences(key,encrypted_value) VALUES ('payment_sources',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value`,
            [JSON.stringify(sources)],
          );
        }
      }
      if (reconciliation === 'ADJUST_BALANCE') {
        if (
          !source ||
          !wallet ||
          source.noLimit ||
          !Number.isSafeInteger(item.reportedBalanceMinor) ||
          (item.reportedBalanceMinor ?? -1) < 0
        )
          throw new Error('A reported wallet balance is required.');
        if (
          (source.balanceCutoverAt &&
            Date.parse(item.eventAt) < Date.parse(source.balanceCutoverAt)) ||
          ledger.some(
            (t) =>
              t.cardId === sourceId && t.id !== existingId && t.transactionDate >= item.eventDate,
          )
        )
          throw new Error(
            'This balance snapshot may be older than tracked activity. Retain the calculated balance.',
          );
        const delta = (item.reportedBalanceMinor ?? 0) - (source.balanceMinor ?? 0);
        if (delta) {
          balanceAdjustment = {
            id: `sms-adjustment-${item.id}`,
            cardId: sourceId,
            type: 'ADJUSTMENT',
            adjustmentDirection: delta > 0 ? 'DECREASE' : 'INCREASE',
            amountMinor: Math.abs(delta),
            currencyCode: 'INR',
            transactionDate: item.eventDate,
            categoryId: 'other',
            merchant: 'Approved wallet balance reconciliation',
            notes: `Explicit user adjustment to reported balance at ${item.eventAt}`,
            relatedTransactionId: transactionId,
            attachmentIds: [],
            createdAt: now,
            updatedAt: now,
          };
          await tx.run(
            `INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES (?,NULL,?,?,?,?,?,?,?,?)`,
            [
              balanceAdjustment.id,
              'other',
              'ADJUSTMENT',
              Math.abs(delta),
              'INR',
              item.eventDate,
              JSON.stringify(balanceAdjustment),
              now,
              now,
            ],
          );
          await tx.run(
            `INSERT INTO transaction_links(transaction_id,related_transaction_id,relationship_type,created_at) VALUES (?,?,'ADJUSTMENT',?)`,
            [balanceAdjustment.id, transactionId, now],
          );
        }
        source.balanceMinor = item.reportedBalanceMinor;
        source.balanceCutoverAt = item.eventAt;
        source.balanceSnapshotMinor = item.reportedBalanceMinor;
        await tx.run(
          `INSERT INTO app_preferences(key,encrypted_value) VALUES ('payment_sources',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value`,
          [JSON.stringify(sources)],
        );
      }
      await tx.run(
        `UPDATE sms_candidates SET state = ?, transaction_id = ?, decision = ?, updated_at = ? WHERE id = ?`,
        [existingId ? 'MATCHED_EXISTING' : 'IMPORTED', transactionId, reconciliation, now, item.id],
      );
      await tx.run(
        `INSERT INTO sms_reconciliation(id,candidate_id,target_id,decision,amount_minor,created_at) VALUES (?,?,?,?,?,?)`,
        [crypto.randomUUID(), item.id, transactionId, reconciliation, amountMinor, now],
      );
      if (reconciliation === 'FULLY_PAID') {
        if (
          type !== 'PAYMENT' ||
          !card ||
          !/^\d{4}-\d{2}-\d{2}$/.test(settlementDate) ||
          !Number.isFinite(Date.parse(settlementDate)) ||
          !Number.isSafeInteger(statementDueMinor) ||
          statementDueMinor < 0
        )
          throw new Error('Choose a statement date and valid original due amount.');
        const [stored] = await tx.query<{ payload: string }>(
          'SELECT payload FROM statements WHERE card_id = ? AND statement_date = ?',
          [sourceId, settlementDate],
        );
        const previous = stored ? (JSON.parse(stored.payload) as CardStatement) : null;
        statement = {
          id: previous?.id ?? crypto.randomUUID(),
          cardId: sourceId,
          cycleStartDate: previous?.cycleStartDate ?? settlementDate,
          cycleEndDate: previous?.cycleEndDate ?? settlementDate,
          statementDate: settlementDate,
          dueDate: previous?.dueDate ?? item.eventDate,
          calculatedAmountMinor: previous?.calculatedAmountMinor ?? statementDueMinor,
          bankStatementAmountMinor: previous?.bankStatementAmountMinor ?? statementDueMinor,
          totalPaidMinor:
            (previous?.totalPaidMinor ?? 0) +
            (previous?.reconciledPaymentId === transactionId ? 0 : amountMinor),
          status: 'FULLY_PAID',
          reconciledPaymentId: transactionId,
          reconciledPaymentAmountMinor: amountMinor,
          notes:
            'User explicitly settled this statement; actual payment amount retained. Overall outstanding remains ledger-derived.',
        };
        await tx.run(
          `INSERT INTO statements(id,card_id,cycle_start_date,cycle_end_date,statement_date,due_date,payload) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
          [
            statement.id,
            sourceId,
            statement.cycleStartDate,
            statement.cycleEndDate,
            settlementDate,
            statement.dueDate,
            JSON.stringify(statement),
          ],
        );
      }
      return { transaction, sources, statement, balanceAdjustment };
    });
    if (result) {
      this.store.acceptCommittedImport(result.transaction, result.sources);
      if (result.balanceAdjustment)
        this.store.acceptCommittedImport(result.balanceAdjustment, result.sources);
      if (result.statement) this.store.acceptCommittedStatement(result.statement);
    }
    this.notice.set(
      existingId
        ? reconciliation === 'REPAIR_EXISTING'
          ? 'Existing wallet top-up repaired and matched.'
          : 'Matched existing transaction. Its recorded details are retained.'
        : 'Transaction approved and saved.',
    );
    // The ledger is already durable. A bridge/permission/inbox refresh error must not
    // tell the user the financial write failed or encourage a second manual entry.
    if (this.candidates().some((item) => item.id === candidate.id))
      this.total.update((total) => Math.max(0, total - 1));
    if (result && candidate.state === 'PENDING')
      this.pendingTotal.update((total) => Math.max(0, total - 1));
    this.candidates.update((items) => items.filter((item) => item.id !== candidate.id));
    try {
      await this.refresh();
    } catch {
      this.notice.set(
        'Transaction approved and saved. Review inbox could not refresh; retry refresh safely.',
      );
    }
  }

  /** Bank/aggregator/loan notices can bind to existing records, never create money or schedules. */
  async reconcileEvidence(
    candidate: SmsCandidate,
    targetId: string,
    targetKind: 'TRANSACTION' | 'INSTALLMENT' | 'LOAN',
  ): Promise<void> {
    this.assertUnlocked();
    const installment = await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ state: string; payload: string | null }>(
        'SELECT state,payload FROM sms_candidates WHERE id = ?',
        [candidate.id],
      );
      if (!row || !row.payload || !['PENDING', 'DEFERRED'].includes(row.state))
        throw new Error('Item is no longer pending.');
      const item: unknown = JSON.parse(row.payload);
      if (
        !validEvidence(item) ||
        !['BANK_DEBIT', 'BANK_CREDIT', 'BANK_TRANSFER', 'PAYMENT_INITIATED', 'LOAN_DEBIT'].includes(
          item.kind,
        )
      )
        throw new Error('This message cannot confirm a financial event.');
      let updated: EmiInstallment | null = null;
      if (targetKind === 'TRANSACTION') {
        const [target] = await tx.query<{ payload: string }>(
          'SELECT payload FROM card_transactions WHERE id = ?',
          [targetId],
        );
        if (!target) throw new Error('Choose an existing transaction.');
        const payment = JSON.parse(target.payload) as CardTransaction;
        if (payment.amountMinor !== item.amountMinor || payment.type !== 'PAYMENT')
          throw new Error(
            'Choose a matching existing card payment. This evidence does not confirm issuer receipt.',
          );
      } else if (targetKind === 'INSTALLMENT') {
        if (item.kind !== 'LOAN_DEBIT') throw new Error('Loan debit evidence required.');
        const [target] = await tx.query<{ payload: string }>(
          'SELECT payload FROM emi_installments WHERE id = ?',
          [targetId],
        );
        if (!target) throw new Error('Choose an existing installment.');
        updated = JSON.parse(target.payload) as EmiInstallment;
        if (updated.totalMinor !== item.amountMinor || updated.paid)
          throw new Error('Verify the installment amount and payment status.');
        updated = { ...updated, paid: true };
        await tx.run('UPDATE emi_installments SET paid = 1,payload = ? WHERE id = ?', [
          JSON.stringify(updated),
          targetId,
        ]);
      } else {
        if (item.kind !== 'LOAN_DEBIT') throw new Error('Loan debit evidence required.');
        const [target] = await tx.query<{ payload: string }>(
          'SELECT payload FROM loan_commitments WHERE id = ?',
          [targetId],
        );
        if (!target) throw new Error('Choose an existing loan commitment.');
        const loan = JSON.parse(target.payload) as { installmentMinor: number };
        if (loan.installmentMinor !== item.amountMinor)
          throw new Error('Loan installment amount differs. Keep this unmatched until verified.');
        // Loan commitments have no paid-installment ledger; retain an explicit dated reconciliation.
      }
      const now = new Date().toISOString();
      await tx.run(
        `INSERT INTO sms_reconciliation(id,candidate_id,target_id,decision,amount_minor,created_at) VALUES (?,?,?,?,?,?)`,
        [
          crypto.randomUUID(),
          candidate.id,
          targetId,
          `CONFIRMED_${targetKind}`,
          item.amountMinor,
          now,
        ],
      );
      await tx.run(
        `UPDATE sms_candidates SET state='MATCHED_EXISTING',transaction_id=?,decision=?,updated_at=? WHERE id=?`,
        [
          targetKind === 'TRANSACTION' ? targetId : null,
          `CONFIRMED_${targetKind}`,
          now,
          candidate.id,
        ],
      );
      return updated;
    });
    if (installment)
      this.store.emiInstallments.update((items) =>
        items.map((i) => (i.id === installment.id ? installment : i)),
      );
    await this.refresh();
  }
}
