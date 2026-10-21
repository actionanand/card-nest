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
import { matchExisting, walletComparison } from './sms-matching';
import {
  defaultReviewFilters,
  reviewFilters,
  SMS_REVIEW_FILTERS_KEY,
  SmsReviewFilters,
} from './sms-review-filters';
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
  recurringRelationship,
  suspectEvidence,
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
  recheckSaved(options: {
    items: { id: string; providerId: string; receivedAt: number }[];
  }): Promise<{ items: unknown[] }>;
}
const native = registerPlugin<NativeSms>('CardNestSms');

export interface SmsDismissal {
  readonly id: string;
  readonly token: string | null;
  readonly at: string;
  readonly expires: number;
  readonly previous: {
    state: ReviewState;
    read_at: string | null;
    decision: string | null;
    updated_at: string;
    transaction_id: string | null;
  };
}

@Service()
export class SmsReviewService {
  private readonly database = inject(SqliteDatabase);
  private readonly store = inject(CardNestStore);
  readonly lock = inject(AppLockService);
  readonly status = signal<ScanStatus | null>(null);
  readonly candidates = signal<readonly SmsCandidate[]>([]);
  readonly busy = signal(false);
  readonly reconciling = signal(false);
  readonly verificationFailed = signal(false);
  private refreshQueue: Promise<void> = Promise.resolve();
  private pendingRefreshes = 0;
  readonly requestingPermission = signal(false);
  readonly changingSync = signal(false);
  readonly syncEnabled = computed(
    () => this.status()?.permission === 'granted' && this.status()?.enabled === true,
  );
  readonly canScan = computed(() => {
    const status = this.status();
    return (
      status?.permission === 'granted' &&
      status.enabled &&
      !this.requestingPermission() &&
      !this.changingSync()
    );
  });
  readonly error = signal('');
  readonly duplicates = signal(0);
  readonly reviewPage = signal(0);
  readonly total = signal(0);
  readonly pendingTotal = signal(0);
  readonly matchedTotal = signal(0);
  readonly importedTotal = signal(0);
  readonly unreadTotal = signal(0);
  readonly markingRead = signal(false);
  readonly savedTotal = signal(0);
  readonly notice = signal('');
  private accessRevision = 0;
  private refreshRevision = 0;
  private reviewEntryAttempted = false;
  /** Called only by deliberate SMS Review navigation, never application startup. */
  async enterFromReview(days: number): Promise<void> {
    this.assertUnlocked();
    await this.refreshAccess();
    if (
      this.reviewEntryAttempted ||
      this.status()?.permission !== 'not requested' ||
      this.status()?.canRequest === false
    )
      return;
    this.reviewEntryAttempted = true;
    await this.enable(days);
  }
  private filters = defaultReviewFilters();
  async loadReviewFilters(): Promise<SmsReviewFilters> {
    this.assertUnlocked();
    const [row] = await this.database.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key=?',
      [SMS_REVIEW_FILTERS_KEY],
    );
    let saved: unknown;
    try {
      saved = row ? JSON.parse(row.encrypted_value) : undefined;
    } catch {
      saved = undefined;
    }
    this.filters = reviewFilters(saved);
    this.reviewPage.set(0);
    return { ...this.filters };
  }
  async filterReview(
    filters: Pick<SmsReviewFilters, 'state' | 'kind' | 'search' | 'source'> &
      Partial<SmsReviewFilters> & {
        from?: string;
        to?: string;
        read?: string;
      },
  ): Promise<void> {
    this.assertUnlocked();
    const applied = reviewFilters(filters);
    await this.database.run(
      'INSERT INTO app_preferences(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value',
      [SMS_REVIEW_FILTERS_KEY, JSON.stringify(applied)],
    );
    this.filters = applied;
    this.reviewPage.set(0);
    await this.refresh();
  }
  async turnPage(direction: number): Promise<void> {
    this.reviewPage.update((page) => Math.max(0, page + direction));
    await this.refresh();
  }
  private cancelled = false;
  private reconciliationCursor = '';
  private automaticCursor = '';
  private reparseCursor = '';
  private recheckOriginals(
    items: { id: string; providerId: string; receivedAt: number }[],
  ): Promise<{ items: unknown[] }> {
    return native.recheckSaved({ items });
  }
  /** Explicit provider recheck, not a historical scan or a financial repair. */
  async recheckSaved(): Promise<void> {
    this.assertUnlocked();
    const rows = await this.database.query<{ id: string; payload: string }>(
      "SELECT id,payload FROM sms_candidates WHERE payload IS NOT NULL AND state='PENDING' AND id>? ORDER BY id LIMIT 50",
      [this.reparseCursor],
    );
    const requests = rows.flatMap((row) => {
      const item: unknown = JSON.parse(row.payload);
      return validEvidence(item)
        ? [{ id: row.id, providerId: item.providerId, receivedAt: item.receivedAt }]
        : [];
    });
    const result = requests.length ? await this.recheckOriginals(requests) : { items: [] };
    const allowed = new Set(requests.map((item) => item.id));
    if (!result.items.every((item) => validEvidence(item) && allowed.has(item.id)))
      throw new Error('Invalid recheck evidence. Saved decisions are retained.');
    await this.stage(result.items as SmsEvidence[]);
    this.reparseCursor = rows.length === 50 ? rows.at(-1)!.id : '';
    this.notice.set(
      `${result.items.length} saved messages reparsed. ${requests.length - result.items.length} originals unavailable; verify their evidence manually. No financial records changed.`,
    );
    await this.refresh();
  }
  /** User-requested cleanup: old dismissed evidence only, with permanent dedup tombstones. */
  async cleanCompletedEvidence(): Promise<number> {
    this.assertUnlocked();
    const count = await this.database.atomic(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        "SELECT id FROM sms_candidates WHERE state IN ('REJECTED','IGNORED') AND payload IS NOT NULL AND updated_at < ? ORDER BY updated_at LIMIT 200",
        [new Date(Date.now() - 90 * 86400000).toISOString()],
      );
      for (const row of rows)
        await tx.run(
          "UPDATE sms_candidates SET payload=NULL,decision=COALESCE(decision,'') || ' · Optional evidence cleared after 90 days' WHERE id=? AND state IN ('REJECTED','IGNORED')",
          [row.id],
        );
      return rows.length;
    });
    await this.refresh();
    return count;
  }

  /** Bounded batches, serialized with manual writes. This path never writes financial tables. */
  async reevaluatePending(
    options: { pending?: boolean; automatic?: boolean } = {},
  ): Promise<number> {
    this.assertUnlocked();
    return this.database.atomic(async (tx) => {
      const [wallets] = await tx.query<{ encrypted_value: string }>(
        "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
      );
      const sources = wallets ? (JSON.parse(wallets.encrypted_value) as PaymentSource[]) : [];
      const cards = (await tx.query<{ payload: string }>('SELECT payload FROM credit_cards')).map(
        (row) => JSON.parse(row.payload) as import('../../core/models/domain').CreditCard,
      );
      const pending =
        options.pending === false
          ? []
          : await tx.query<{ id: string; payload: string }>(
              "SELECT id,payload FROM sms_candidates WHERE state='PENDING' AND payload IS NOT NULL AND id>? ORDER BY id LIMIT 200",
              [this.reconciliationCursor],
            );
      if (options.pending !== false)
        this.reconciliationCursor = pending.length === 200 ? pending[pending.length - 1].id : '';
      const evidence = pending.flatMap((row) => {
        try {
          const value: unknown = JSON.parse(row.payload);
          return validEvidence(value) ? [value] : [];
        } catch {
          return [];
        }
      });
      const dates = evidence.map((item) => item.eventDate).sort();
      const ledgerRows = dates.length
        ? await tx.query<{ payload: string }>(
            "SELECT payload FROM card_transactions WHERE transaction_date BETWEEN date(?,'-3 days') AND date(?,'+3 days') LIMIT 5001",
            [dates[0], dates[dates.length - 1]],
          )
        : [];
      const ledger = ledgerRows.map((entry) => JSON.parse(entry.payload) as CardTransaction);
      const bindings: { transaction_id: string }[] = [];
      if (ledger.length <= 5000)
        for (let start = 0; start < ledger.length; start += 400) {
          const batch = ledger.slice(start, start + 400);
          bindings.push(
            ...(await tx.query<{ transaction_id: string }>(
              `SELECT transaction_id FROM sms_candidates WHERE transaction_id IN (${batch.map(() => '?').join(',')}) AND state IN ('IMPORTED','MATCHED_EXISTING')`,
              batch.map((entry) => entry.id),
            )),
          );
        }
      const claimed = new Set(bindings.map((binding) => binding.transaction_id));
      const proposals = evidence.map((item) => ({
        item,
        match: matchExisting(item, cards, sources, ledger, claimed),
      }));
      const competingRows = dates.length
        ? await tx.query<{ payload: string }>(
            "SELECT payload FROM sms_candidates WHERE state='PENDING' AND payload IS NOT NULL AND json_extract(payload,'$.eventDate') BETWEEN ? AND ? LIMIT 5001",
            [dates[0], dates[dates.length - 1]],
          )
        : [];
      const competing = new Map<string, number>();
      for (const row of competingRows) {
        const item: unknown = JSON.parse(row.payload);
        if (!validEvidence(item)) continue;
        const proposal = matchExisting(item, cards, sources, ledger, claimed);
        // Weak nearby suggestions do not claim an exact existing occurrence.
        if (proposal.confidence !== 'HIGH_CONFIDENCE_EXISTING') continue;
        for (const target of proposal.transactionIds)
          competing.set(target, (competing.get(target) ?? 0) + 1);
      }
      let linked = 0;
      for (const { item, match } of proposals) {
        this.assertUnlocked();
        if (!ledgerType(item) || ledgerRows.length > 5000 || competingRows.length > 5000) continue;
        if (
          match.confidence !== 'HIGH_CONFIDENCE_EXISTING' ||
          competing.get(match.transactionIds[0]) !== 1 ||
          claimed.has(match.transactionIds[0])
        )
          continue;
        const now = new Date().toISOString();
        const decision = `AUTO_EXISTING: ${match.reason}`;
        await tx.run(
          'INSERT INTO sms_reconciliation(id,candidate_id,target_id,decision,amount_minor,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET target_id=excluded.target_id,decision=excluded.decision,amount_minor=excluded.amount_minor,created_at=excluded.created_at',
          [`auto-${item.id}`, item.id, match.transactionIds[0], decision, item.amountMinor, now],
        );
        await tx.run(
          "UPDATE sms_candidates SET state='MATCHED_EXISTING',transaction_id=?,decision=?,updated_at=? WHERE id=? AND state='PENDING'",
          [match.transactionIds[0], decision, now, item.id],
        );
        linked++;
        claimed.add(match.transactionIds[0]);
      }
      // Automatically created links are checked against current ledger/source metadata on revisit.
      // Explicit user decisions are never undone. Restored tombstones keep their dedup identity.
      const automatic =
        options.automatic === false
          ? []
          : await tx.query<{
              id: string;
              payload: string | null;
              transaction_id: string | null;
            }>(
              "SELECT id,payload,transaction_id FROM sms_candidates WHERE state='MATCHED_EXISTING' AND decision LIKE 'AUTO_EXISTING:%' AND id>? ORDER BY id LIMIT 200",
              [this.automaticCursor],
            );
      if (options.automatic !== false)
        this.automaticCursor = automatic.length === 200 ? automatic[automatic.length - 1].id : '';
      for (const row of automatic) {
        if (!row.payload) continue;
        const item = JSON.parse(row.payload) as SmsEvidence;
        // A parser upgrade is not permission to undo a previously resolved relationship.
        // Legacy evidence is surfaced for explicit inspection, while its ledger remains intact.
        if (suspectEvidence(item)) continue;
        const [target] = await tx.query<{ payload: string }>(
          'SELECT payload FROM card_transactions WHERE id=?',
          [row.transaction_id],
        );
        const match = matchExisting(
          item,
          cards,
          sources,
          target ? [JSON.parse(target.payload) as CardTransaction] : [],
        );
        if (match.confidence === 'HIGH_CONFIDENCE_EXISTING') continue;
        await tx.run(
          "UPDATE sms_candidates SET state='PENDING',transaction_id=NULL,decision='Previous automatic link needs review after ledger/source changes' WHERE id=?",
          [row.id],
        );
        await tx.run(
          "UPDATE sms_reconciliation SET target_id=NULL,decision='INVALIDATED_AUTOMATIC_LINK' WHERE candidate_id=?",
          [row.id],
        );
      }
      return linked;
    });
  }
  async relatedFor(candidate: SmsCandidate): Promise<readonly SmsCandidate[]> {
    this.assertUnlocked();
    const item = candidate.item;
    if (
      !item ||
      (!item.reference &&
        !item.standingInstructionReference &&
        !['PURCHASE', 'SCHEDULED_CHARGE'].includes(item.kind))
    )
      return [];
    const rows = await this.database.query<{
      id: string;
      state: ReviewState;
      kind: SmsEvidence['kind'];
      event_at: string;
      payload: string;
      transaction_id: string;
    }>(
      `SELECT * FROM sms_candidates WHERE id != ? AND payload IS NOT NULL AND payload LIKE ? LIMIT 50`,
      [candidate.id, `%${item.reference ?? item.standingInstructionReference ?? item.eventDate}%`],
    );
    return rows.flatMap((row) => {
      const other: unknown = JSON.parse(row.payload);
      if (
        !validEvidence(other) ||
        (!recurringRelationship(item, other) &&
          (!item.reference || other.reference !== item.reference)) ||
        other.amountMinor !== item.amountMinor
      )
        return [];
      if (
        !recurringRelationship(item, other) &&
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
  refresh(): Promise<void> {
    const revision = ++this.refreshRevision;
    this.pendingRefreshes++;
    this.reconciling.set(true);
    // Keep batch cursors private to one refresh and publish only verified results.
    const work = this.refreshQueue.then(async () => {
      if (revision !== this.refreshRevision) return;
      this.verificationFailed.set(false);
      try {
        await this.refreshSnapshot(revision);
      } catch (error) {
        if (revision === this.refreshRevision) {
          this.candidates.set([]);
          this.verificationFailed.set(true);
        }
        throw error;
      }
    });
    this.refreshQueue = work.catch(() => undefined);
    return work.finally(() => {
      this.pendingRefreshes--;
      this.reconciling.set(this.pendingRefreshes > 0);
    });
  }
  private async refreshSnapshot(revision: number): Promise<void> {
    this.assertUnlocked();
    await this.refreshAccess();
    await this.handoff();
    // Finish revalidating saved automatic links first. Any invalidated evidence is
    // then included in the complete pending pass, even if its ID sorts earlier.
    this.automaticCursor = '';
    do {
      await this.reevaluatePending({ pending: false });
      if (revision !== this.refreshRevision) return;
    } while (this.automaticCursor);
    this.reconciliationCursor = '';
    do {
      await this.reevaluatePending({ automatic: false });
      if (revision !== this.refreshRevision) return;
    } while (this.reconciliationCursor);
    const [totals] = await this.database.query<{
      saved: number;
      pending: number;
      unread: number;
      matched: number;
      imported: number;
    }>(
      `SELECT COUNT(*) AS saved, COALESCE(SUM(CASE WHEN state='PENDING' THEN 1 ELSE 0 END),0) AS pending, COALESCE(SUM(CASE WHEN state='MATCHED_EXISTING' THEN 1 ELSE 0 END),0) AS matched, COALESCE(SUM(CASE WHEN state='IMPORTED' THEN 1 ELSE 0 END),0) AS imported, COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END),0) AS unread FROM sms_candidates`,
    );
    if (revision !== this.refreshRevision || this.lock.locked() || !this.lock.foreground()) return;
    this.savedTotal.set(totals.saved);
    this.pendingTotal.set(totals.pending);
    this.matchedTotal.set(totals.matched ?? 0);
    this.importedTotal.set(totals.imported ?? 0);
    this.unreadTotal.set(totals.unread);
    const filters = this.filters;
    const kinds =
      filters.mode === 'MULTIPLE' ? filters.kinds : filters.kind === 'ALL' ? null : [filters.kind];
    const kindClause =
      kinds === null ? '1=1' : kinds.length ? `kind IN (${kinds.map(() => '?').join(',')})` : '0=1';
    const hideAdded =
      filters.hideAlreadyAdded &&
      filters.state !== 'MATCHED_EXISTING' &&
      filters.state !== 'IMPORTED';
    const where = `WHERE (? = 'ALL' OR state = ?) AND (${kindClause}) ${hideAdded ? "AND state NOT IN ('IMPORTED','MATCHED_EXISTING')" : ''}
      AND (? = '' OR (COALESCE(json_extract(payload,'$.merchant'),'') || ' ' || COALESCE(json_extract(payload,'$.reference'),'')) LIKE ?)
      AND (? = '' OR (COALESCE(json_extract(payload,'$.cardDigits'),'') || ' ' || COALESCE(json_extract(payload,'$.vehicleNumber'),'') || ' ' || COALESCE(json_extract(payload,'$.issuer'),'')) LIKE ?)
      AND (? = '' OR COALESCE(json_extract(payload,'$.eventDate'),substr(event_at,1,10)) >= ?)
      AND (? = '' OR COALESCE(json_extract(payload,'$.eventDate'),substr(event_at,1,10)) <= ?)
      AND (? = 'ALL' OR (? = 'UNREAD' AND read_at IS NULL) OR (? = 'READ' AND read_at IS NOT NULL))`;
    const values = [
      filters.state,
      filters.state,
      ...(kinds ?? []),
      filters.search,
      `%${filters.search}%`,
      filters.source,
      `%${filters.source}%`,
      filters.from,
      filters.from,
      filters.to,
      filters.to,
      filters.read,
      filters.read,
      filters.read,
    ];
    const [count] = await this.database.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM sms_candidates ${where}`,
      values,
    );
    if (revision !== this.refreshRevision || this.lock.locked() || !this.lock.foreground()) return;
    this.total.set(count.total);
    this.reviewPage.update((page) => Math.min(page, Math.max(0, Math.ceil(count.total / 200) - 1)));
    const rows = await this.database.query<{
      id: string;
      state: ReviewState;
      kind: SmsEvidence['kind'];
      event_at: string;
      payload: string | null;
      transaction_id: string;
      read_at: string | null;
      decision: string | null;
    }>(`SELECT * FROM sms_candidates ${where} ORDER BY event_at DESC, id LIMIT 200 OFFSET ?`, [
      ...values,
      this.reviewPage() * 200,
    ]);
    if (revision !== this.refreshRevision || this.lock.locked() || !this.lock.foreground()) return;
    this.candidates.set(
      rows.map((r) => ({
        id: r.id,
        state: r.state,
        kind: r.kind,
        eventAt: r.event_at,
        item: r.payload ? (JSON.parse(r.payload) as SmsEvidence) : null,
        transactionId: r.transaction_id,
        readAt: r.read_at,
        decision: r.decision,
      })),
    );
  }
  async markRead(id: string, read: boolean): Promise<void> {
    this.assertUnlocked();
    const readAt = read ? new Date().toISOString() : null;
    await this.database.run('UPDATE sms_candidates SET read_at=?,updated_at=? WHERE id=?', [
      readAt,
      this.nextDecisionAt(),
      id,
    ]);
    ++this.refreshRevision;
    this.candidates.update((items) =>
      items
        .map((item) => (item.id === id ? { ...item, readAt } : item))
        .filter(
          (item) =>
            this.filters.read === 'ALL' ||
            (this.filters.read === 'READ' ? !!item.readAt : !item.readAt),
        ),
    );
    try {
      await this.refresh();
    } catch {
      this.notice.set('Read state saved. Refresh the inbox to reload counts.');
    }
  }
  /** Keep the original candidate as a dedup tombstone. Never touch financial tables. */
  private lastDismissalTime = 0;
  private nextDecisionAt(): string {
    this.lastDismissalTime = Math.max(Date.now(), this.lastDismissalTime + 1);
    return new Date(this.lastDismissalTime).toISOString();
  }
  async dismiss(id: string): Promise<SmsDismissal | null> {
    this.assertUnlocked();
    const dismissal = await this.database.atomic(async (tx) => {
      const [previous] = await tx.query<SmsDismissal['previous']>(
        'SELECT state,read_at,decision,updated_at,transaction_id FROM sms_candidates WHERE id=?',
        [id],
      );
      if (!previous) return null;
      const at = this.nextDecisionAt();
      const token = ['IMPORTED', 'MATCHED_EXISTING'].includes(previous.state)
        ? previous.decision
        : `DISMISS:${crypto.randomUUID()}`;
      await tx.run(
        "UPDATE sms_candidates SET state=CASE WHEN state IN ('PENDING','DEFERRED','ERROR') THEN 'IGNORED' ELSE state END,read_at=?,decision=?,updated_at=? WHERE id=?",
        [at, token, at, id],
      );
      return { id, token, at, expires: Date.now() + 7000, previous };
    });
    if (!dismissal) return null;
    ++this.refreshRevision;
    this.candidates.update((items) => items.filter((item) => item.id !== id));
    await this.refreshAfterDismissal();
    return { ...dismissal, expires: Date.now() + 7000 };
  }
  async undoDismissal(dismissal: SmsDismissal): Promise<void> {
    this.assertUnlocked();
    if (Date.now() > dismissal.expires) return;
    const previous = dismissal.previous;
    const restored = await this.database.atomic((tx) =>
      tx.run(
        'UPDATE sms_candidates SET state=?,read_at=?,decision=?,updated_at=? WHERE id=? AND decision IS ? AND updated_at=? AND read_at=? AND transaction_id IS ? AND state=?',
        [
          previous.state,
          previous.read_at,
          previous.decision,
          previous.updated_at,
          dismissal.id,
          dismissal.token,
          dismissal.at,
          dismissal.at,
          previous.transaction_id,
          ['PENDING', 'DEFERRED', 'ERROR'].includes(previous.state) ? 'IGNORED' : previous.state,
        ],
      ),
    );
    ++this.refreshRevision;
    if (!restored) this.notice.set('This suggestion changed. Its newer decision was retained.');
    await this.refreshAfterDismissal();
  }
  private async refreshAfterDismissal(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      this.notice.set('Suggestion decision saved. Refresh the inbox to reload counts.');
    }
  }
  /** Explicit adjustment of a matched meal snapshot; never called by discovery or auto-linking. */
  async adjustMatchedBalance(candidate: SmsCandidate): Promise<void> {
    this.assertUnlocked();
    const sources = await this.database.atomic(async (tx) => {
      const [row] = await tx.query<{ payload: string; transaction_id: string }>(
        "SELECT payload,transaction_id FROM sms_candidates WHERE id=? AND state='MATCHED_EXISTING'",
        [candidate.id],
      );
      if (!row?.payload || !row.transaction_id)
        throw new Error('Choose a recorded wallet transaction first.');
      const item = JSON.parse(row.payload) as SmsEvidence;
      if (!validEvidence(item)) throw new Error('Valid retained SMS evidence is required.');
      const [pref] = await tx.query<{ encrypted_value: string }>(
        "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
      );
      if (!pref) throw new Error('Saved wallet unavailable.');
      const sources = JSON.parse(pref.encrypted_value) as PaymentSource[];
      const ledger = (
        await tx.query<{ payload: string }>('SELECT payload FROM card_transactions')
      ).map((entry) => JSON.parse(entry.payload) as CardTransaction);
      const existing = ledger.find((entry) => entry.id === row.transaction_id);
      const source = sources.find((source) => source.id === existing?.cardId);
      if (!source || !existing) throw new Error('Recorded wallet entry unavailable.');
      if (
        existing.type !== ledgerType(item) ||
        existing.amountMinor !== item.amountMinor ||
        existing.transactionDate !== item.eventDate
      )
        throw new Error(
          'The recorded entry changed. Review the transaction before adjusting its balance.',
        );
      const comparison = walletComparison(item, source, ledger, existing.id);
      if (!comparison?.canAdjust)
        throw new Error(comparison?.explanation ?? 'The balance cannot be safely adjusted.');
      const delta = comparison.difference;
      if (!delta) return sources;
      const now = new Date().toISOString();
      const adjustment: CardTransaction = {
        id: `sms-adjustment-${item.id}`,
        cardId: source.id,
        type: 'ADJUSTMENT',
        adjustmentDirection: delta > 0 ? 'DECREASE' : 'INCREASE',
        amountMinor: Math.abs(delta),
        currencyCode: 'INR',
        transactionDate: item.eventDate,
        categoryId: 'other',
        merchant: 'Approved wallet balance reconciliation',
        notes: `Explicit SMS snapshot adjustment at ${item.eventAt}`,
        relatedTransactionId: existing.id,
        sourceBalanceApplied: true,
        attachmentIds: [],
        createdAt: now,
        updatedAt: now,
      };
      await tx.run(
        'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,NULL,?,?,?,?,?,?,?,?)',
        [
          adjustment.id,
          'other',
          adjustment.type,
          adjustment.amountMinor,
          'INR',
          item.eventDate,
          JSON.stringify(adjustment),
          now,
          now,
        ],
      );
      await tx.run(
        "INSERT INTO transaction_links(transaction_id,related_transaction_id,relationship_type,created_at) VALUES(?,?,'ADJUSTMENT',?)",
        [adjustment.id, existing.id, now],
      );
      source.balanceMinor = comparison.reported;
      source.balanceSnapshotMinor = comparison.reported;
      source.balanceCutoverAt = item.eventAt;
      await tx.run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
        JSON.stringify(sources),
      ]);
      await tx.run(
        "UPDATE sms_reconciliation SET decision=decision || '; EXPLICIT_BALANCE_ADJUSTMENT' WHERE candidate_id=?",
        [item.id],
      );
      return sources;
    });
    // Refresh from committed rows, never optimistically alter a balance before the transaction.
    const adjustments = (
      await this.database.query<{ payload: string }>(
        'SELECT payload FROM card_transactions WHERE id=?',
        [`sms-adjustment-${candidate.id}`],
      )
    ).map((row) => JSON.parse(row.payload) as CardTransaction);
    this.store.acceptCommittedImport(adjustments[0] ?? null, sources);
    await this.refresh();
  }
  async markAllRead(): Promise<number> {
    this.assertUnlocked();
    if (this.markingRead()) return 0;
    this.markingRead.set(true);
    try {
      const count = await this.database.atomic((tx) =>
        tx.run('UPDATE sms_candidates SET read_at=? WHERE read_at IS NULL', [
          new Date().toISOString(),
        ]),
      );
      ++this.refreshRevision;
      this.unreadTotal.set(0);
      this.candidates.update((items) =>
        this.filters.read === 'UNREAD'
          ? []
          : items.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })),
      );
      try {
        await this.refresh();
      } catch {
        this.notice.set('Read state saved. Refresh the inbox to reload counts.');
      }
      return count;
    } finally {
      this.markingRead.set(false);
    }
  }
  async enable(days: number): Promise<void> {
    this.assertUnlocked();
    if (this.requestingPermission() || this.changingSync() || this.busy()) return;
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
    this.assertUnlocked();
    if (this.changingSync() || this.requestingPermission()) return;
    this.changingSync.set(true);
    this.cancelled = true;
    const revision = ++this.accessRevision;
    try {
      const status = await native.disable();
      if (revision === this.accessRevision) {
        this.accessRevision++;
        this.status.set(status);
      }
    } finally {
      this.changingSync.set(false);
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
      for (const incoming of items) {
        // Parser fixes may change a receipt-fallback fingerprint. Retain the old identity/decision.
        const [old] =
          incoming.legacyId && incoming.legacyId !== incoming.id
            ? await tx.query<{ id: string }>('SELECT id FROM sms_candidates WHERE id=?', [
                incoming.legacyId,
              ])
            : [];
        const item = old ? { ...incoming, id: old.id } : incoming;
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
        if (!changes && !(retention && item.eventDate < retention.value)) {
          // Reparsed evidence may improve a pending row, but cannot reset a decision/read flag.
          await tx.run(
            "UPDATE sms_candidates SET payload=?,kind=?,event_at=?,updated_at=? WHERE id=? AND state='PENDING'",
            [JSON.stringify(item), item.kind, item.eventAt, new Date().toISOString(), item.id],
          );
        }
      }
    });
  }
  private async handoff(): Promise<void> {
    // A refresh cannot retain or drain an unbounded inbox; subsequent refreshes resume safely.
    for (let page = 0; page < 5; page++) {
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
      `UPDATE sms_candidates SET state = ?, decision = ?, updated_at = ? WHERE id = ? AND state NOT IN ('IMPORTED','MATCHED_EXISTING')`,
      [state, `Manual review: ${state}`, this.nextDecisionAt(), candidate.id],
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
      if (!row)
        throw new Error('Saved suggestion is unavailable. Refresh the inbox before reviewing.');
      if (['IMPORTED', 'MATCHED_EXISTING'].includes(row.state)) return null;
      if (!row.payload || !['PENDING', 'DEFERRED'].includes(row.state))
        throw new Error('Reopen this item for review first.');
      const item: unknown = JSON.parse(row.payload);
      if (!validEvidence(item)) throw new Error('Evidence unavailable.');
      if (suspectEvidence(item))
        throw new Error(
          'Possible statement or scheduled-charge misclassification. Recheck the original SMS before adding.',
        );
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
      if (reconciliation === 'ADJUST_BALANCE' && item.kind.startsWith('PLUXEE')) {
        const comparison = source
          ? walletComparison(item, source, ledger, existingId || undefined)
          : null;
        if (!comparison?.canAdjust)
          throw new Error(
            comparison?.explanation ?? 'Verify the meal wallet and balance chronology first.',
          );
      }
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
          transactionTime: item.eventTimeExplicit === true ? item.eventTime : undefined,
          reference: item.reference,
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
        `UPDATE sms_candidates SET state = ?, transaction_id = ?, decision = ?, updated_at = ?, read_at=COALESCE(read_at,?) WHERE id = ?`,
        [
          existingId ? 'MATCHED_EXISTING' : 'IMPORTED',
          transactionId,
          reconciliation,
          now,
          now,
          item.id,
        ],
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
    ++this.refreshRevision;
    this.notice.set(
      !result
        ? 'This suggestion was already resolved. No additional transaction was added.'
        : existingId
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
        result
          ? 'Transaction approved and saved. Review inbox could not refresh; retry refresh safely.'
          : 'Review decision retained. No additional transaction was added. Retry inbox refresh safely.',
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
