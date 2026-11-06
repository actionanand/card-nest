import { TestBed } from '@angular/core/testing';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { SqliteDatabase } from './sqlite-database';
import { DATABASE_MIGRATIONS } from './migrations';
import { CardNestStore } from '../services/card-nest-store';
import { CommittedSaveRefreshError } from '../services/committed-save-refresh-error';
import {
  ConsumerWalletService,
  WALLETS_FEATURE_STATE_KEY,
} from '../services/consumer-wallet.service';
import { CardTransaction, PaymentSource } from '../models/domain';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { APP_ENVIRONMENT } from '../services/app-environment';
import {
  defaultReviewFilters,
  reviewFilters,
  SMS_REVIEW_FILTERS_KEY,
} from '../../features/sms-sync/sms-review-filters';
import { BackupService } from '../services/backup.service';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { NATIVE_EXPORT } from '../services/native-export';
import { AppLockService } from '../services/app-lock.service';
import { SmsReviewService } from '../../features/sms-sync/sms-review.service';
import { SmsCandidate, SmsEvidence } from '../../features/sms-sync/sms-model';
import { indiaTodayIso } from '../services/india-date';
import {
  UtilitiesService,
  SHOW_INDIAN_UTILITIES_KEY,
  UTILITY_REMINDERS_KEY,
} from '../../features/utilities/utilities.service';
import { BankActivityService } from '../../features/bank-activity/bank-activity.service';
import { addCalendarDays } from '../../features/utilities/utilities-calculations';
import { CATEGORY_REGISTRY } from './category-definitions';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

vi.hoisted(() => vi.resetModules());
const config = { smsPageSize: 200, maxWallets: 15, seedDemoData: false };
vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    createConnection: vi.fn(),
    open: vi.fn(),
    query: vi.fn(),
    run: vi.fn(),
    execute: vi.fn(),
    executeSet: vi.fn(),
    beginTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    rollbackTransaction: vi.fn(),
    isJsonValid: vi.fn(),
    close: vi.fn(),
    closeConnection: vi.fn(),
    importFromJson: vi.fn(),
  },
}));

/** Native-plugin contract backed by real SQLite, including transactions and foreign keys. */
describe('Durable first-run data, additive read migration and private portable backups', () => {
  let sql: DatabaseSyncType;
  let database: SqliteDatabase;
  it('preserves nested refund segment order through purchases and a later UPI Lite return', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const bank = await store.addBankAccount({ institution: 'ICICI Bank', lastDigits: '419' });
    const wallet = await wallets.registerWallet({ providerId: 'upi-lite' });
    const today = indiaTodayIso();
    const promoDate = addCalendarDays(today, -7);
    await wallets.addWalletCredit({
      id: 'lineage-promo',
      walletId: wallet.id,
      amountMinor: 6000,
      eventType: 'PROMOTIONAL_CREDIT',
      eventDate: promoDate,
    });
    const purchase = async (id: string, amountMinor: number, eventDate: string) => {
      const input = {
        id,
        walletId: wallet.id,
        amountMinor,
        eventDate,
        eventTime: '10:00',
        categoryId: 'other',
      };
      const preview = await wallets.previewWalletPurchase(input);
      return wallets.recordWalletPurchase({ ...input, confirmationKey: preview.confirmationKey });
    };
    await purchase('lineage-first-purchase', 6000, addCalendarDays(today, -6));

    const refund = async (
      id: string,
      purchaseEventId: string,
      amountMinor: number,
      eventDate: string,
    ) => {
      const input = { id, purchaseEventId, amountMinor, eventDate, eventTime: '10:00' };
      const preview = await wallets.previewWalletPurchaseRefund(input);
      return wallets.recordWalletPurchaseRefund({
        ...input,
        confirmationKey: preview.confirmationKey,
      });
    };
    await refund(
      'lineage-first-refund',
      'lineage-first-purchase',
      6000,
      addCalendarDays(today, -4),
    );

    const loadCreatedAt = new Date().toISOString();
    await store.saveManualTransaction(
      {
        id: 'lineage-load-debit',
        cardId: bank.id,
        type: 'PURCHASE',
        amountMinor: 6000,
        currencyCode: 'INR',
        transactionDate: addCalendarDays(today, -5),
        transactionTime: '10:00',
        categoryId: 'other',
        attachmentIds: [],
        paymentMethod: 'WALLET_LOADING',
        origin: 'MANUAL',
        createdAt: loadCreatedAt,
        updatedAt: loadCreatedAt,
      },
      '',
      false,
      undefined,
      '',
      { walletId: wallet.id, loadedAmountMinor: 6000 },
    );
    await wallets.reloadFinancialHistory();
    const fundedLoad = wallets
      .events()
      .find((event) => event.sourceTransactionId === 'lineage-load-debit');
    expect(fundedLoad).toBeDefined();
    await purchase('lineage-second-purchase', 10000, addCalendarDays(today, -3));
    await refund(
      'lineage-second-refund',
      'lineage-second-purchase',
      10000,
      addCalendarDays(today, -2),
    );

    expect(
      rows(
        'SELECT segment_order,root_credit_event_id,source_purchase_event_id,amount_minor FROM consumer_wallet_credit_provenance_segments WHERE credit_event_id=? ORDER BY segment_order',
        ['lineage-second-refund'],
      ),
    ).toEqual([
      {
        segment_order: 0,
        root_credit_event_id: fundedLoad!.id,
        source_purchase_event_id: 'lineage-second-purchase',
        amount_minor: 6000,
      },
      {
        segment_order: 1,
        root_credit_event_id: 'lineage-promo',
        source_purchase_event_id: 'lineage-second-purchase',
        amount_minor: 4000,
      },
    ]);
    const preview = await wallets.previewUpiLiteReturn({
      id: 'lineage-return',
      walletId: wallet.id,
      bankSourceId: bank.id,
      amountMinor: 8000,
      eventDate: today,
      eventTime: '10:00',
    });
    expect(preview.attributions).toMatchObject([
      { creditEventId: 'lineage-first-refund', allocatedMinor: 2000, expenseReversalMinor: 0 },
      { creditEventId: 'lineage-second-refund', allocatedMinor: 6000, expenseReversalMinor: 6000 },
    ]);
    expect(preview.fundedPrincipalReversalMinor).toBe(6000);
    const returned = await wallets.recordUpiLiteReturn({
      id: 'lineage-return',
      walletId: wallet.id,
      bankSourceId: bank.id,
      amountMinor: 8000,
      eventDate: today,
      eventTime: '10:00',
      confirmationKey: preview.confirmationKey,
    });
    expect(returned.eventType).toBe('UPI_LITE_RETURN');
  });
  it('previews and confirms wallet purchases without fabricating a card or bank debit', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const today = indiaTodayIso();
    await wallets.addWalletCredit({
      id: 'purchase-preview-credit',
      walletId: wallet.id,
      amountMinor: 30000,
      eventType: 'MANUAL_CREDIT',
      eventDate: addCalendarDays(today, -2),
    });
    const input = {
      id: 'confirmed-wallet-purchase',
      walletId: wallet.id,
      amountMinor: 10000,
      eventDate: today,
      eventTime: '10:00',
      categoryId: 'other',
      merchant: 'Synthetic wallet merchant',
      notes: 'Synthetic receipt purchase',
      attachmentIds: ['data:image/png;base64,aGVsbG8='],
    };
    const beforeTransactions = rows('SELECT * FROM card_transactions ORDER BY id');
    const preview = await wallets.previewWalletPurchase(input);
    expect(preview).toMatchObject({
      balanceBeforeMinor: 30000,
      balanceAfterMinor: 20000,
      allocations: [{ creditEventId: 'purchase-preview-credit', allocatedMinor: 10000 }],
    });
    expect(rows('SELECT id FROM consumer_wallet_events WHERE id=?', [input.id])).toEqual([]);
    await expect(
      wallets.recordWalletPurchase({
        ...input,
        amountMinor: 20000,
        confirmationKey: preview.confirmationKey,
      }),
    ).rejects.toThrow('Review the purchase again');
    expect(rows('SELECT id FROM consumer_wallet_events WHERE id=?', [input.id])).toEqual([]);
    const purchase = await wallets.recordWalletPurchase({
      ...input,
      confirmationKey: preview.confirmationKey,
    });
    expect(purchase.attachmentIds).toEqual(input.attachmentIds);
    expect(wallets.balances().get(wallet.id)).toBe(20000);
    expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(beforeTransactions);
    await expect(
      wallets.recordWalletPurchase({ ...input, confirmationKey: preview.confirmationKey }),
    ).resolves.toEqual(purchase);
    expect(rows('SELECT id FROM consumer_wallet_events WHERE id=?', [input.id])).toHaveLength(1);
    expect(
      rows('SELECT allocated_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?', [
        input.id,
      ]),
    ).toEqual([{ allocated_minor: 10000 }]);
    await expect(
      wallets.recordWalletPurchase({
        ...input,
        merchant: 'Different merchant',
        confirmationKey: preview.confirmationKey,
      }),
    ).rejects.toThrow('different purchase');
    await expect(
      wallets.previewWalletPurchase({
        ...input,
        id: 'invalid-wallet-category',
        categoryId: 'missing-category',
      }),
    ).rejects.toThrow('active transaction category');
    await expect(
      wallets.previewWalletPurchase({
        ...input,
        id: 'future-funded-purchase',
        eventDate: addCalendarDays(today, -3),
      }),
    ).rejects.toThrow('historical wallet balance');
    await expect(
      wallets.previewWalletPurchase({ ...input, id: 'excess-wallet-purchase', amountMinor: 40000 }),
    ).rejects.toThrow('historical wallet balance');
    await wallets.archiveWallet(wallet.id);
    await expect(
      wallets.previewWalletPurchase({ ...input, id: 'archived-wallet-purchase' }),
    ).rejects.toThrow('active registered consumer wallet');
    await wallets.setEnabled(false);
    await expect(
      wallets.recordWalletPurchase({
        ...input,
        id: 'disabled-wallet-purchase',
        confirmationKey: 'approved-before-wallets-disabled',
      }),
    ).rejects.toThrow('Wallets is off');
  });
  it('restores ordered mixed refund provenance through partial refunds and a later Bank return', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const bank = await store.addBankAccount({ institution: 'ICICI Bank', lastDigits: '419' });
    await store.enableBankTracking({ [bank.id]: 50000 });
    const wallet = await wallets.registerWallet({ providerId: 'upi-lite' });
    const today = indiaTodayIso();
    const loadDate = addCalendarDays(today, -8);
    const loadCreatedAt = new Date().toISOString();
    await store.saveManualTransaction(
      {
        id: 'mixed-refund-load-debit',
        cardId: bank.id,
        type: 'PURCHASE',
        amountMinor: 6000,
        currencyCode: 'INR',
        transactionDate: loadDate,
        transactionTime: '10:00',
        categoryId: 'other',
        merchant: 'Synthetic UPI Lite load',
        attachmentIds: [],
        paymentMethod: 'WALLET_LOADING',
        origin: 'MANUAL',
        createdAt: loadCreatedAt,
        updatedAt: loadCreatedAt,
      },
      '',
      false,
      undefined,
      '',
      { walletId: wallet.id, loadedAmountMinor: 6000 },
    );
    await wallets.reloadFinancialHistory();
    const fundedLoad = wallets
      .events()
      .find((event) => event.sourceTransactionId === 'mixed-refund-load-debit')!;
    await wallets.addWalletCredit({
      id: 'mixed-refund-promo',
      walletId: wallet.id,
      amountMinor: 4000,
      eventType: 'PROMOTIONAL_CREDIT',
      eventDate: addCalendarDays(today, -7),
    });
    const purchaseInput = {
      id: 'mixed-refund-purchase',
      walletId: wallet.id,
      amountMinor: 10000,
      eventDate: addCalendarDays(today, -6),
      categoryId: 'other',
      merchant: 'Synthetic mixed purchase',
    };
    await recordApprovedWalletPurchase(wallets, purchaseInput);

    const refundInput = (id: string, amountMinor: number, eventDate: string) => ({
      id,
      purchaseEventId: purchaseInput.id,
      amountMinor,
      eventDate,
      reason: 'Synthetic partial refund',
    });
    const firstInput = refundInput('mixed-refund-40', 4000, addCalendarDays(today, -4));
    const firstPreview = await wallets.previewWalletPurchaseRefund(firstInput);
    expect(firstPreview.provenanceSegments).toEqual([
      {
        segmentOrder: 0,
        rootCreditEventId: fundedLoad.id,
        sourcePurchaseEventId: purchaseInput.id,
        amountMinor: 4000,
      },
    ]);
    const firstRefund = await wallets.recordWalletPurchaseRefund({
      ...firstInput,
      confirmationKey: firstPreview.confirmationKey,
    });
    await expect(
      wallets.recordWalletPurchaseRefund({
        ...firstInput,
        confirmationKey: firstPreview.confirmationKey,
      }),
    ).resolves.toEqual(firstRefund);
    expect(wallets.balances().get(wallet.id)).toBe(4000);
    await expect(
      wallets.previewWalletPurchaseEdit({
        ...purchaseInput,
        amountMinor: 9000,
      }),
    ).rejects.toThrow('refunds or cancellation');
    const secondInput = refundInput('mixed-refund-30', 3000, addCalendarDays(today, -3));
    const secondPreview = await wallets.previewWalletPurchaseRefund(secondInput);
    expect(secondPreview.provenanceSegments).toEqual([
      {
        segmentOrder: 0,
        rootCreditEventId: fundedLoad.id,
        sourcePurchaseEventId: purchaseInput.id,
        amountMinor: 2000,
      },
      {
        segmentOrder: 1,
        rootCreditEventId: 'mixed-refund-promo',
        sourcePurchaseEventId: purchaseInput.id,
        amountMinor: 1000,
      },
    ]);
    const secondRefund = await wallets.recordWalletPurchaseRefund({
      ...secondInput,
      confirmationKey: secondPreview.confirmationKey,
    });
    await expect(
      wallets.recordWalletPurchaseRefund({
        ...secondInput,
        confirmationKey: secondPreview.confirmationKey,
      }),
    ).resolves.toEqual(secondRefund);
    expect(wallets.balances().get(wallet.id)).toBe(7000);
    await expect(
      wallets.previewWalletPurchaseRefund(
        refundInput('mixed-refund-over', 4000, addCalendarDays(today, -2)),
      ),
    ).rejects.toThrow('remaining refundable');
    const returnInput = {
      id: 'mixed-refund-return',
      walletId: wallet.id,
      bankSourceId: bank.id,
      amountMinor: 7000,
      eventDate: today,
      eventTime: '10:00',
    };
    const returnPreview = await wallets.previewUpiLiteReturn(returnInput);
    expect(returnPreview).toMatchObject({
      fundedPrincipalReversalMinor: 6000,
      nonFundedReturnMinor: 1000,
    });
    const returnEvent = await wallets.recordUpiLiteReturn({
      ...returnInput,
      confirmationKey: returnPreview.confirmationKey,
    });
    expect(returnEvent.eventType).toBe('UPI_LITE_RETURN');
    expect(
      rows(
        'SELECT segment_order,root_credit_event_id,amount_minor FROM consumer_wallet_credit_provenance_segments WHERE credit_event_id=? ORDER BY segment_order',
        [firstRefund.id],
      ),
    ).toEqual([{ segment_order: 0, root_credit_event_id: fundedLoad.id, amount_minor: 4000 }]);
    expect(
      rows(
        'SELECT segment_order,root_credit_event_id,amount_minor FROM consumer_wallet_credit_provenance_segments WHERE credit_event_id=? ORDER BY segment_order',
        [secondRefund.id],
      ),
    ).toEqual([
      { segment_order: 0, root_credit_event_id: fundedLoad.id, amount_minor: 2000 },
      { segment_order: 1, root_credit_event_id: 'mixed-refund-promo', amount_minor: 1000 },
    ]);
    expect(
      rows(
        'SELECT SUM(reversed_minor) AS reversed FROM consumer_wallet_expense_reversals WHERE funded_load_event_id=?',
        [fundedLoad.id],
      ),
    ).toEqual([{ reversed: 6000 }]);
    expect(
      rows('SELECT id FROM card_transactions WHERE id=?', [
        `wallet-return-bank-credit-${returnInput.id}`,
      ]),
    ).toHaveLength(1);
  });
  it('cancels a purchase by reversing only its remaining refundable value', async () => {
    await database.initialise();
    await TestBed.inject(CardNestStore).initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const today = indiaTodayIso();
    await wallets.addWalletCredit({
      id: 'cancel-wallet-credit',
      walletId: wallet.id,
      amountMinor: 15000,
      eventType: 'MANUAL_CREDIT',
      eventDate: addCalendarDays(today, -4),
    });
    const purchaseInput = {
      id: 'cancel-wallet-purchase',
      walletId: wallet.id,
      amountMinor: 10000,
      eventDate: addCalendarDays(today, -3),
      categoryId: 'other',
    };
    await recordApprovedWalletPurchase(wallets, purchaseInput);
    const refundInput = {
      id: 'cancel-wallet-partial-refund',
      purchaseEventId: purchaseInput.id,
      amountMinor: 4000,
      eventDate: addCalendarDays(today, -2),
    };
    const refundPreview = await wallets.previewWalletPurchaseRefund(refundInput);
    await wallets.recordWalletPurchaseRefund({
      ...refundInput,
      confirmationKey: refundPreview.confirmationKey,
    });
    const cancellationInput = {
      id: 'cancel-wallet-reversal',
      purchaseEventId: purchaseInput.id,
      amountMinor: 6000,
      eventDate: addCalendarDays(today, -1),
      reason: 'Synthetic cancellation',
    };
    const cancellationPreview = await wallets.previewWalletPurchaseCancellation(cancellationInput);
    const cancellation = await wallets.cancelWalletPurchase({
      ...cancellationInput,
      confirmationKey: cancellationPreview.confirmationKey,
    });
    expect(cancellation).toMatchObject({
      eventType: 'REVERSAL',
      reversalOfEventId: purchaseInput.id,
      amountMinor: 6000,
    });
    expect(wallets.balances().get(wallet.id)).toBe(15000);
    expect(
      rows('SELECT id FROM consumer_wallet_events WHERE id=?', [purchaseInput.id]),
    ).toHaveLength(1);
    await expect(
      wallets.cancelWalletPurchase({
        ...cancellationInput,
        confirmationKey: cancellationPreview.confirmationKey,
      }),
    ).resolves.toEqual(cancellation);
    expect(
      rows(
        "SELECT id FROM consumer_wallet_events WHERE reversal_of_event_id=? AND event_type IN ('REFUND','REVERSAL')",
        [purchaseInput.id],
      ),
    ).toHaveLength(2);
  });
  it('starts cumulative refund offsets after a completely refunded provenance segment', async () => {
    await database.initialise();
    await TestBed.inject(CardNestStore).initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const today = indiaTodayIso();
    await wallets.addWalletCredit({
      id: 'segment-offset-first-credit',
      walletId: wallet.id,
      amountMinor: 6000,
      eventType: 'MANUAL_CREDIT',
      eventDate: addCalendarDays(today, -5),
    });
    await wallets.addWalletCredit({
      id: 'segment-offset-second-credit',
      walletId: wallet.id,
      amountMinor: 4000,
      eventType: 'PROMOTIONAL_CREDIT',
      eventDate: addCalendarDays(today, -4),
    });
    const purchaseInput = {
      id: 'segment-offset-purchase',
      walletId: wallet.id,
      amountMinor: 10000,
      eventDate: addCalendarDays(today, -3),
      categoryId: 'other',
    };
    await recordApprovedWalletPurchase(wallets, purchaseInput);
    const refund = async (id: string, amountMinor: number, eventDate: string) => {
      const input = { id, purchaseEventId: purchaseInput.id, amountMinor, eventDate };
      const preview = await wallets.previewWalletPurchaseRefund(input);
      return wallets.recordWalletPurchaseRefund({
        ...input,
        confirmationKey: preview.confirmationKey,
      });
    };
    await refund('segment-offset-refund-first', 6000, addCalendarDays(today, -2));
    await refund('segment-offset-refund-second', 1000, addCalendarDays(today, -1));
    expect(
      rows(
        'SELECT segment_order,root_credit_event_id,amount_minor FROM consumer_wallet_credit_provenance_segments WHERE credit_event_id=? ORDER BY segment_order',
        ['segment-offset-refund-second'],
      ),
    ).toEqual([
      {
        segment_order: 0,
        root_credit_event_id: 'segment-offset-second-credit',
        amount_minor: 1000,
      },
    ]);
  });
  it('edits wallet purchase metadata and safe amounts without changing downstream FIFO history', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const today = indiaTodayIso();
    await wallets.addWalletCredit({
      id: 'edit-wallet-credit',
      walletId: wallet.id,
      amountMinor: 30000,
      eventType: 'MANUAL_CREDIT',
      eventDate: addCalendarDays(today, -4),
    });
    const originalInput = {
      id: 'edit-wallet-purchase',
      walletId: wallet.id,
      amountMinor: 10000,
      eventDate: addCalendarDays(today, -3),
      eventTime: '10:00',
      categoryId: 'other',
      merchant: 'Original merchant',
      notes: 'Original note',
    };
    const original = await recordApprovedWalletPurchase(wallets, originalInput);
    const later = await recordApprovedWalletPurchase(wallets, {
      id: 'edit-later-purchase',
      walletId: wallet.id,
      amountMinor: 5000,
      eventDate: addCalendarDays(today, -2),
      categoryId: 'other',
    });
    const originalAllocation = rows(
      'SELECT id,credit_event_id,allocated_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?',
      [original.id],
    );
    const metadataInput = {
      ...originalInput,
      merchant: 'Updated merchant',
      notes: 'Updated note',
    };
    const metadataPreview = await wallets.previewWalletPurchaseEdit(metadataInput);
    const metadataUpdate = await wallets.updateWalletPurchase({
      ...metadataInput,
      confirmationKey: metadataPreview.confirmationKey,
    });
    expect(metadataUpdate).toMatchObject({
      id: original.id,
      merchant: 'Updated merchant',
      notes: 'Updated note',
    });
    expect(
      rows(
        'SELECT id,credit_event_id,allocated_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?',
        [original.id],
      ),
    ).toEqual(originalAllocation);

    const amountInput = { ...metadataInput, amountMinor: 12000 };
    const amountPreview = await wallets.previewWalletPurchaseEdit(amountInput);
    await wallets.updateWalletPurchase({
      ...amountInput,
      confirmationKey: amountPreview.confirmationKey,
    });
    expect(wallets.balances().get(wallet.id)).toBe(13000);
    expect(
      rows(
        'SELECT credit_event_id,allocated_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?',
        [later.id],
      ),
    ).toEqual([{ credit_event_id: 'edit-wallet-credit', allocated_minor: 5000 }]);
    expect(
      rows('SELECT id,amount_minor FROM consumer_wallet_events WHERE id=?', [original.id]),
    ).toEqual([{ id: original.id, amount_minor: 12000 }]);

    await expect(
      wallets.previewWalletPurchaseEdit({
        ...amountInput,
        eventDate: addCalendarDays(today, -5),
      }),
    ).rejects.toThrow('historical wallet balance');
    expect(
      rows('SELECT id,amount_minor FROM consumer_wallet_events WHERE id=?', [original.id]),
    ).toEqual([{ id: original.id, amount_minor: 12000 }]);
  });
  it('initializes Wallets from legacy FASTag data but preserves explicit OFF', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    await store.addWallet({
      id: 'legacy-fastag-wallet',
      nickname: 'Synthetic FASTag',
      kind: 'FASTAG',
      vehicleNumber: 'KA01AB1234',
      noLimit: false,
      balanceMinor: 0,
      autoLoad: false,
      archived: false,
    });
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    expect(wallets.featureState()).toBe('ENABLED');

    await database.run('UPDATE app_preferences SET encrypted_value=? WHERE key=?', [
      'DISABLED',
      WALLETS_FEATURE_STATE_KEY,
    ]);
    await wallets.initialise();
    expect(wallets.featureState()).toBe('DISABLED');
    expect(
      store.paymentSources().find((source) => source.id === 'legacy-fastag-wallet'),
    ).toMatchObject({
      id: 'legacy-fastag-wallet',
      kind: 'FASTAG',
      vehicleNumber: 'KA01AB1234',
    });
  });

  it('surfaces wallet load failures without clearing records and recovers on retry', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({
      providerId: 'amazon-pay',
      nickname: 'Retained wallet',
    });
    const before = wallets.wallets();
    vi.spyOn(database, 'atomic').mockRejectedValueOnce(new Error('synthetic wallet load failure'));

    await wallets.initialise();
    expect(wallets.loadError()).toContain('Existing data was preserved');
    expect(wallets.wallets()).toEqual(before);
    expect(wallets.wallets().find((item) => item.id === wallet.id)).toBeDefined();

    await wallets.initialise();
    expect(wallets.loadError()).toBeNull();
    expect(wallets.wallets()).toEqual(before);
  });

  it('cancels setup without enabling and commits a consumer wallet with activation atomically', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    expect(wallets.featureState()).toBe('NEVER_CONFIGURED');

    const cancelled = await wallets.beginSetup('CONSUMER');
    await wallets.cancelSetup(cancelled.id);
    expect(wallets.featureState()).toBe('NEVER_CONFIGURED');
    expect(
      sql
        .prepare('SELECT key FROM app_preferences WHERE key=?')
        .get('consumer_wallets_setup_intent'),
    ).toBeUndefined();

    const intent = await wallets.beginSetup('CONSUMER');
    const wallet = await wallets.registerWallet({
      providerId: 'other',
      customName: 'Synthetic Gift Balance',
      nickname: 'Rewards',
      setupIntentId: intent.id,
    });
    expect(wallets.featureState()).toBe('ENABLED');
    expect(wallets.wallets()).toContainEqual(wallet);
    expect(
      sql
        .prepare('SELECT encrypted_value FROM app_preferences WHERE key=?')
        .get(WALLETS_FEATURE_STATE_KEY)?.['encrypted_value'],
    ).toBe('ENABLED');
    expect(
      sql
        .prepare('SELECT key FROM app_preferences WHERE key=?')
        .get('consumer_wallets_setup_intent'),
    ).toBeUndefined();
  });

  it('commits FASTag registration and Wallets activation together or rolls both back', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const intent = await wallets.beginSetup('FASTAG');
    const source: PaymentSource = {
      id: 'atomic-setup-fastag',
      kind: 'FASTAG',
      nickname: 'Synthetic atomic FASTag',
      vehicleNumber: 'FICT001',
      noLimit: false,
      balanceMinor: 0,
      autoLoad: false,
      archived: false,
    };
    sql.exec(
      `CREATE TRIGGER fail_wallet_activation BEFORE UPDATE ON app_preferences
       WHEN NEW.key='${WALLETS_FEATURE_STATE_KEY}' AND NEW.encrypted_value='ENABLED'
       BEGIN SELECT RAISE(ABORT,'synthetic Wallets activation failure'); END`,
    );
    await expect(wallets.saveFastagWallet(source, intent.id)).rejects.toThrow(
      'synthetic Wallets activation failure',
    );
    expect(store.paymentSources().some((item) => item.id === source.id)).toBe(false);
    expect(wallets.featureState()).toBe('NEVER_CONFIGURED');
    expect(
      rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0]?.[
        'encrypted_value'
      ],
    ).not.toContain(source.id);
    sql.exec('DROP TRIGGER fail_wallet_activation');

    await wallets.saveFastagWallet(source, intent.id);
    expect(wallets.featureState()).toBe('ENABLED');
    expect(store.paymentSources().find((item) => item.id === source.id)).toEqual(source);
    expect(
      rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0]?.[
        'encrypted_value'
      ],
    ).toContain(source.id);
  });

  it('enforces explicit Wallets OFF at persistence boundaries while preserving FASTag operations', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const active = await wallets.registerWallet({
      providerId: 'amazon-pay',
      nickname: 'Existing active',
    });
    const archived = await wallets.registerWallet({
      providerId: 'paytm-wallet',
      nickname: 'Existing archived',
    });
    await wallets.archiveWallet(archived.id);
    await wallets.setEnabled(false);

    await expect(
      wallets.registerWallet({ providerId: 'phonepe-wallet', nickname: 'Direct while off' }),
    ).rejects.toThrow('explicitly off');
    await expect(wallets.archiveWallet(active.id)).rejects.toThrow('Wallets is off');
    await expect(wallets.restoreWallet(archived.id)).rejects.toThrow('Wallets is off');
    await expect(wallets.deleteWalletIfEmpty(active.id)).rejects.toThrow('Wallets is off');

    const fastag: PaymentSource = {
      id: 'fastag-while-consumer-wallets-off',
      kind: 'FASTAG',
      nickname: 'FASTag remains separate',
      vehicleNumber: 'FICT007',
      noLimit: false,
      balanceMinor: 5000,
      autoLoad: false,
      archived: false,
    };
    await wallets.saveFastagWallet(fastag);
    expect(wallets.featureState()).toBe('DISABLED');
    expect(store.paymentSources().find((source) => source.id === fastag.id)).toEqual(fastag);

    const setup = await wallets.beginSetup('CONSUMER');
    const restoredActivation = await wallets.registerWallet({
      providerId: 'swiggy-money',
      nickname: 'Explicit setup reactivation',
      setupIntentId: setup.id,
    });
    expect(wallets.featureState()).toBe('ENABLED');
    expect(wallets.wallets()).toContainEqual(restoredActivation);
  });

  it('limits active consumer wallets and atomically replaces one when restoring at capacity', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    await wallets.saveFastagWallet({
      id: 'outside-consumer-wallet-cap',
      kind: 'FASTAG',
      nickname: 'Synthetic FASTag',
      vehicleNumber: 'FICT001',
      noLimit: false,
      balanceMinor: 0,
      autoLoad: false,
      archived: false,
    });
    const created: Awaited<ReturnType<typeof wallets.registerWallet>>[] = [];
    for (let index = 0; index < 15; index += 1)
      created.push(
        await wallets.registerWallet({ providerId: 'amazon-pay', nickname: `Synthetic ${index}` }),
      );
    await expect(
      wallets.registerWallet({ providerId: 'amazon-pay', nickname: 'Sixteenth' }),
    ).rejects.toThrow('up to 15 active wallets');
    await wallets.archiveWallet(created[14].id);
    await expect(
      wallets.registerWallet({ providerId: 'amazon-pay', nickname: 'Synthetic 0' }),
    ).rejects.toThrow('identity already exists');

    await wallets.registerWallet({
      providerId: 'paytm-wallet',
      nickname: 'Replacement slot',
    });
    const before = sql
      .prepare('SELECT id,archived,payload FROM consumer_wallets ORDER BY id')
      .all();
    sql.exec(
      `CREATE TRIGGER fail_wallet_replacement BEFORE UPDATE ON consumer_wallets
       WHEN NEW.id='${created[0].id}' BEGIN SELECT RAISE(ABORT,'synthetic replacement failure'); END`,
    );
    await expect(wallets.restoreWallet(created[14].id, created[0].id)).rejects.toThrow(
      'synthetic replacement failure',
    );
    expect(
      sql.prepare('SELECT id,archived,payload FROM consumer_wallets ORDER BY id').all(),
    ).toEqual(before);
    sql.exec('DROP TRIGGER fail_wallet_replacement');

    await wallets.restoreWallet(created[14].id, created[0].id);
    expect(wallets.wallets().find((wallet) => wallet.id === created[14].id)?.archived).toBe(false);
    expect(wallets.wallets().find((wallet) => wallet.id === created[0].id)?.archived).toBe(true);
    expect(wallets.activeWallets()).toHaveLength(15);
    expect(store.paymentSources().filter((source) => source.kind === 'FASTAG')).toHaveLength(1);
  });

  it('rejects portable backups above the active-wallet limit without replacing current data', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const existing = await wallets.registerWallet({
      providerId: 'amazon-pay',
      nickname: 'Existing',
    });
    const beforeWalletRows = rows('SELECT * FROM consumer_wallets ORDER BY id');
    const beforePreferences = rows('SELECT * FROM app_preferences ORDER BY key');
    const backup = JSON.parse(await database.exportBackupJson()) as {
      format: string;
      version: number;
      databaseVersion: number;
      tables: { name: string; rows: Record<string, unknown>[] }[];
    };
    const table = backup.tables.find((candidate) => candidate.name === 'consumer_wallets')!;
    const base = table.rows[0];
    for (let index = 1; index < 16; index += 1) {
      const id = `over-limit-${index}`;
      const payload = JSON.parse(String(base['payload'])) as Record<string, unknown>;
      table.rows.push({
        ...base,
        id,
        nickname: `Synthetic ${index}`,
        payload: JSON.stringify({ ...payload, id, nickname: `Synthetic ${index}` }),
      });
    }
    await expect(database.restoreBackupJson(JSON.stringify(backup))).rejects.toThrow(
      'exceeds the configured limit of 15 active consumer wallets',
    );
    expect(rows('SELECT * FROM consumer_wallets ORDER BY id')).toEqual(beforeWalletRows);
    expect(rows('SELECT * FROM app_preferences ORDER BY key')).toEqual(beforePreferences);
    expect(wallets.wallets().map((wallet) => wallet.id)).toEqual([existing.id]);
  });

  it('persists default-off UI preferences through serialized writes, reload and encrypted backup restoration', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(store.smsSwipeActionsEnabled()).toBe(false);
    expect(store.showTransactionTime()).toBe(false);
    await Promise.all([
      store.setDurableUiPreference('sms_swipe_actions_enabled', true),
      store.setDurableUiPreference('show_transaction_time', true),
    ]);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-preference-passphrase');
      expect(backup.contents).not.toContain('sms_swipe_actions_enabled');
      await store.setDurableUiPreference('show_transaction_time', false);
      await backups.restore(backup.contents, 'synthetic-preference-passphrase');
      await store.initialisePreferences();
      expect(store.smsSwipeActionsEnabled()).toBe(true);
      expect(store.showTransactionTime()).toBe(true);
      await database.run(
        "UPDATE app_preferences SET encrypted_value='invalid' WHERE key='show_transaction_time'",
      );
      await database.run("DELETE FROM app_preferences WHERE key='sms_swipe_actions_enabled'");
      await store.initialisePreferences();
      expect(store.showTransactionTime()).toBe(false);
      expect(store.smsSwipeActionsEnabled()).toBe(false);
      await database.run("DELETE FROM app_preferences WHERE key='show_transaction_time'");
      const oldBackup = await backups.create('synthetic-preference-passphrase');
      await store.setDurableUiPreference('sms_swipe_actions_enabled', true);
      await store.setDurableUiPreference('show_transaction_time', true);
      await backups.restore(oldBackup.contents, 'synthetic-preference-passphrase');
      await store.initialisePreferences();
      expect(store.showTransactionTime()).toBe(false);
      expect(store.smsSwipeActionsEnabled()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('restores audited additive and replacement balances without financial transaction effects', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const bank = await store.addBankAccount({ institution: 'ICICI Bank', lastDigits: '419' });
    await store.enableBankTracking({ [bank.id]: 50000 });
    await store.enableCashTracking(25000);
    const meal = store.paymentSources().find((source) => source.kind === 'MEAL')!;
    await store.setSourceBalance(meal.id, 30000, 'Initial wallet balance');
    await store.addSourceBalance(bank.id, 5000, 'Bank add');
    await store.addSourceBalance('source-cash', 2000, 'Cash add');
    await store.addSourceBalance(meal.id, 4000, 'Meal add');
    await store.setSourceBalance('source-cash', 31000, 'Cash correction');

    const transactions = rows('SELECT * FROM card_transactions ORDER BY id');
    const adjustments = rows('SELECT * FROM source_balance_adjustments ORDER BY id');
    const balances = store.paymentSources().map(({ id, balanceMinor }) => [id, balanceMinor]);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-balance-passphrase');
      await store.addSourceBalance(bank.id, 9000, 'Temporary post-backup add');
      await store.setSourceBalance('source-cash', 1, 'Temporary post-backup set');
      await backups.restore(backup.contents, 'synthetic-balance-passphrase');
      await store.initialisePreferences();
      expect(rows('SELECT * FROM source_balance_adjustments ORDER BY id')).toEqual(adjustments);
      expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(transactions);
      expect(store.paymentSources().map(({ id, balanceMinor }) => [id, balanceMinor])).toEqual(
        balances,
      );
      expect(store.balanceAdjustments().some((item) => item.note?.includes('Temporary'))).toBe(
        false,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('restores reset category definitions and preserves custom IDs, budgets and transaction references in backup', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const dining = store.categories().find((category) => category.id === 'dining')!;
    await store.updateCategory({
      ...dining,
      name: 'My Dining',
      icon: 'film',
      colour: '#123456',
      archived: true,
    });
    await store.setCategoryLimit('dining', 12500, true);
    await store.addCategory({
      id: 'backup-custom-category',
      name: 'Backup Custom',
      icon: 'tag',
      colour: '#456789',
      appliesTo: 'BOTH',
      archived: false,
    });
    const transaction: CardTransaction = {
      id: 'backup-category-reset-transaction',
      cardId: 'source-cash',
      type: 'PURCHASE',
      amountMinor: 2300,
      currencyCode: 'INR',
      transactionDate: indiaTodayIso(),
      categoryId: 'dining',
      attachmentIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.saveManualTransaction(transaction);
    await store.deleteCategory('education');
    await store.resetDefaultCategories();
    await store.resetDefaultCategories();
    const expectedTransactions = rows('SELECT * FROM card_transactions ORDER BY id');
    const expectedLimits = rows('SELECT * FROM category_limits ORDER BY category_id');

    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-category-reset-passphrase');
      await store.deleteCategory('wealth-assets');
      await store.setCategoryLimit('dining', 100, false);
      await backups.restore(backup.contents, 'synthetic-category-reset-passphrase');
      const restored = TestBed.runInInjectionContext(() => new CardNestStore());
      await restored.initialisePreferences();

      expect(
        restored
          .categories()
          .filter((category) =>
            CATEGORY_REGISTRY.categories.some((definition) => definition.id === category.id),
          ),
      ).toHaveLength(24);
      expect(restored.categories().find((category) => category.id === 'dining')).toMatchObject({
        name: 'Dining',
        archived: false,
        monthlyLimitMinor: 12500,
        showLimit: true,
      });
      expect(
        restored.categories().find((category) => category.id === 'backup-custom-category'),
      ).toMatchObject({ name: 'Backup Custom', colour: '#456789' });
      expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(expectedTransactions);
      expect(rows('SELECT * FROM category_limits ORDER BY category_id')).toEqual(expectedLimits);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps the SQLite budget and cycle through reload and encrypted restore, including older unset backups', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(store.monthlyBudgetMinor()).toBe(0);
    await store.setMonthlyBudget(654321);
    await store.setBudgetCycleStartDay(12);
    const restartedStore = TestBed.runInInjectionContext(() => new CardNestStore());
    await restartedStore.initialisePreferences();
    expect(restartedStore.monthlyBudgetMinor()).toBe(654321);
    expect(restartedStore.budgetCycleStartDay()).toBe(12);
    await store.initialisePreferences();
    expect(store.monthlyBudgetMinor()).toBe(654321);
    expect(store.budgetCycleStartDay()).toBe(12);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-budget-passphrase');
      expect(backup.contents).not.toContain('monthly_budget_minor');
      await store.setMonthlyBudget(100);
      await store.setBudgetCycleStartDay(5);
      await backups.restore(backup.contents, 'synthetic-budget-passphrase');
      await store.initialisePreferences();
      expect(store.monthlyBudgetMinor()).toBe(654321);
      expect(store.budgetCycleStartDay()).toBe(12);
      await database.run(
        "DELETE FROM app_preferences WHERE key IN ('monthly_budget_minor','budget_cycle_start_day')",
      );
      const oldBackup = await backups.create('synthetic-budget-passphrase');
      await store.setMonthlyBudget(100);
      await store.setBudgetCycleStartDay(5);
      await backups.restore(oldBackup.contents, 'synthetic-budget-passphrase');
      await store.initialisePreferences();
      expect(store.monthlyBudgetMinor()).toBe(0);
      expect(store.budgetCycleStartDay()).toBe(1);
      expect(store.displayCurrencyCode()).toBe('INR');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  const rows = (statement: string, values: readonly unknown[] = []) =>
    sql.prepare(statement).all(...(values as SQLInputValue[]));
  const recordApprovedWalletPurchase = async (
    wallets: ConsumerWalletService,
    input: Parameters<ConsumerWalletService['previewWalletPurchase']>[0],
  ) => {
    const preview = await wallets.previewWalletPurchase(input);
    return wallets.recordWalletPurchase({ ...input, confirmationKey: preview.confirmationKey });
  };
  const count = (table: string) => Number(rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]['n']);
  const marker = () =>
    rows("SELECT encrypted_value FROM app_preferences WHERE key='initial_data_state'")[0]?.[
      'encrypted_value'
    ];
  it('backs up and restores applied SMS filters, including search, with normal preferences', async () => {
    await database.initialise();
    const filters = JSON.stringify({
      state: 'DEFERRED',
      kind: 'REFUND',
      search: 'Synthetic shop',
      source: '54321',
      from: '2026-01-01',
      to: '2026-02-28',
      read: 'READ',
    });
    await database.run('INSERT INTO app_preferences VALUES(?,?)', ['sms_review_filters', filters]);
    const backup = await database.exportBackupJson();
    await database.run('UPDATE app_preferences SET encrypted_value=? WHERE key=?', [
      '{}',
      'sms_review_filters',
    ]);
    await database.restoreBackupJson(backup);
    expect(
      rows("SELECT encrypted_value FROM app_preferences WHERE key='sms_review_filters'"),
    ).toEqual([{ encrypted_value: filters }]);
    await database.deleteAllData();
    expect(
      rows("SELECT encrypted_value FROM app_preferences WHERE key='sms_review_filters'"),
    ).toEqual([]);
  });
  function schema(version: number): void {
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= version))
      for (const statement of migration.statements) sql.exec(statement);
    sql.exec(`PRAGMA user_version=${version}`);
  }
  function installFinancialData(): void {
    sql.exec(`INSERT INTO categories(id,name,icon,applies_to) VALUES('synthetic-category','Synthetic','category','BOTH');
      INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES('synthetic-card','Synthetic existing','Fictional Bank','54321','AMERICAN_EXPRESS','{}','before','before');
      INSERT INTO card_transactions VALUES('synthetic-transaction','synthetic-card','synthetic-category','PURCHASE',12345,'INR','2026-10-01','{"manual":true}','before','before');
      INSERT INTO app_preferences VALUES('payment_sources','[{"id":"synthetic-wallet","kind":"MEAL","balanceMinor":654321}]');
      INSERT INTO loan_commitments VALUES('synthetic-loan','ACTIVE','{"amount":54321}','before');
      INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,transaction_id,updated_at) VALUES('synthetic-read','1','2026-10-01','PURCHASE','IMPORTED','{"evidence":"Synthetic private evidence"}','synthetic-transaction','before');
      INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES('synthetic-pending','2','2026-10-02','PURCHASE','PENDING','{"evidence":"Synthetic pending evidence"}','before');
      INSERT INTO sms_reconciliation VALUES('synthetic-binding','synthetic-read','synthetic-transaction','IMPORT',12345,'before');`);
  }
  async function installWalletLoadTestCard(store: CardNestStore) {
    const card = {
      id: 'wallet-load-boundary-card',
      nickname: 'Synthetic boundary card',
      issuerName: 'Fictional Bank',
      lastDigits: '4321',
      network: 'VISA' as const,
      theme: 'green',
      statementDay: 1,
      dueDateMode: 'DAYS_AFTER_STATEMENT' as const,
      daysAfterStatement: 20,
      adjustDueDateOnWeekend: false,
      currencyCode: 'INR',
      openingBalanceMinor: 0,
      remindToSettle: false,
      annualFeeEnabled: false,
      emergencyPhones: [],
      supportEmails: [],
      archived: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    await database.run(
      'INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      [
        card.id,
        card.nickname,
        card.issuerName,
        card.lastDigits,
        card.network,
        JSON.stringify(card),
        card.createdAt,
        card.updatedAt,
      ],
    );
    store.cards.set([card]);
    return card;
  }
  it('saves funded wallet loads atomically with their real source debit and protects consumed provenance', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const openingBalance = await wallets.updateWalletBalance({
      id: 'wallet-load-opening-balance',
      walletId: wallet.id,
      newBalanceMinor: 1000,
      eventDate: '2026-10-01',
    });
    await expect(
      wallets.updateWalletBalance({
        id: 'wallet-load-opening-balance',
        walletId: wallet.id,
        newBalanceMinor: 1000,
        eventDate: '2026-10-01',
      }),
    ).resolves.toEqual(openingBalance);
    await expect(
      wallets.updateWalletBalance({
        id: 'wallet-load-opening-balance',
        walletId: wallet.id,
        newBalanceMinor: 1200,
        eventDate: '2026-10-01',
      }),
    ).rejects.toThrow('already used for a different event');
    await wallets.addWalletCredit({
      id: 'wallet-load-manual-credit',
      walletId: wallet.id,
      amountMinor: 100,
      eventType: 'MANUAL_CREDIT',
      eventDate: '2026-10-02',
    });
    await wallets.addWalletCredit({
      id: 'wallet-load-promo-credit',
      walletId: wallet.id,
      amountMinor: 50,
      eventType: 'PROMOTIONAL_CREDIT',
      eventDate: '2026-10-03',
    });
    await wallets.updateWalletBalance({
      id: 'wallet-load-correction',
      walletId: wallet.id,
      newBalanceMinor: 1100,
      eventDate: '2026-10-04',
    });
    const card = {
      id: 'wallet-load-card',
      nickname: 'Synthetic load card',
      issuerName: 'Fictional Bank',
      lastDigits: '4321',
      network: 'VISA' as const,
      theme: 'green',
      statementDay: 1,
      dueDateMode: 'DAYS_AFTER_STATEMENT' as const,
      daysAfterStatement: 20,
      adjustDueDateOnWeekend: false,
      currencyCode: 'INR',
      openingBalanceMinor: 0,
      remindToSettle: false,
      annualFeeEnabled: false,
      emergencyPhones: [],
      supportEmails: [],
      archived: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    await database.run(
      'INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      [
        card.id,
        card.nickname,
        card.issuerName,
        card.lastDigits,
        card.network,
        JSON.stringify(card),
        card.createdAt,
        card.updatedAt,
      ],
    );
    store.cards.set([card]);
    const transaction = {
      id: 'wallet-load-source-debit',
      cardId: card.id,
      type: 'PURCHASE' as const,
      amountMinor: 5200,
      currencyCode: 'INR',
      transactionDate: '2026-10-05',
      categoryId: 'other',
      merchant: 'Synthetic wallet top-up',
      attachmentIds: [],
      paymentMethod: 'WALLET_LOADING' as const,
      createdAt: '2026-10-05T10:00:00.000Z',
      updatedAt: '2026-10-05T10:00:00.000Z',
    };
    const save = (loadedAmountMinor: number, walletId = wallet.id) =>
      store.saveManualTransaction(transaction, '', false, undefined, '', {
        walletId,
        loadedAmountMinor,
      });

    await expect(save(5000, 'missing-wallet')).rejects.toThrow('active registered consumer wallet');
    expect(rows('SELECT id FROM card_transactions WHERE id=?', [transaction.id])).toEqual([]);
    expect(
      rows('SELECT id FROM consumer_wallet_events WHERE source_transaction_id=?', [transaction.id]),
    ).toEqual([]);

    await save(5000);
    await save(5000);
    await save(4800);
    expect(
      rows(
        'SELECT amount_minor,fee_minor FROM consumer_wallet_events WHERE source_transaction_id=?',
        [transaction.id],
      ),
    ).toEqual([{ amount_minor: 4800, fee_minor: 400 }]);
    const alternateWallet = await wallets.registerWallet({ providerId: 'paytm-wallet' });
    await save(4800, alternateWallet.id);
    expect(
      rows('SELECT wallet_id FROM consumer_wallet_events WHERE source_transaction_id=?', [
        transaction.id,
      ]),
    ).toEqual([{ wallet_id: alternateWallet.id }]);
    await save(5000);
    expect(rows('SELECT id FROM card_transactions WHERE id=?', [transaction.id])).toHaveLength(1);
    const storedLoadTransaction = rows('SELECT payload FROM card_transactions WHERE id=?', [
      transaction.id,
    ]);
    expect(store.updateTransaction({ ...transaction, merchant: 'Unsafe direct update' })).toBe(
      false,
    );
    expect(store.transactionWriteError()).toContain('through Wallet Loading');
    expect(rows('SELECT payload FROM card_transactions WHERE id=?', [transaction.id])).toEqual(
      storedLoadTransaction,
    );
    expect(store.deleteTransaction(transaction.id)).toBe(false);
    expect(store.transactionWriteError()).toContain('Delete this funding debit from Transactions');
    await expect(store.duplicateTransaction(transaction.id)).rejects.toThrow(
      'wallet-load funding debit',
    );
    store.addTransaction({ ...transaction, id: 'unsafe-wallet-load-copy' });
    await database.atomic(async () => undefined);
    expect(
      rows('SELECT id FROM card_transactions WHERE id=?', ['unsafe-wallet-load-copy']),
    ).toEqual([]);
    expect(
      rows(
        'SELECT amount_minor,debit_amount_minor,fee_minor FROM consumer_wallet_events WHERE source_transaction_id=?',
        [transaction.id],
      ),
    ).toEqual([{ amount_minor: 5000, debit_amount_minor: 5200, fee_minor: 200 }]);
    expect(
      rows(
        "SELECT COUNT(*) AS count FROM consumer_wallet_events WHERE event_type='FUNDED_LOAD' AND source_transaction_id=?",
        [transaction.id],
      ),
    ).toEqual([{ count: 1 }]);

    const walletPurchaseInput = {
      id: 'wallet-load-test-purchase',
      walletId: wallet.id,
      amountMinor: 2100,
      eventDate: '2026-10-06',
      categoryId: 'other',
    };
    const walletPurchasePreview = await wallets.previewWalletPurchase(walletPurchaseInput);
    const walletPurchase = await wallets.recordWalletPurchase({
      ...walletPurchaseInput,
      confirmationKey: walletPurchasePreview.confirmationKey,
    });
    await expect(
      wallets.recordWalletPurchase({
        ...walletPurchaseInput,
        confirmationKey: walletPurchasePreview.confirmationKey,
      }),
    ).resolves.toEqual(walletPurchase);
    const fundedLoad = rows(
      "SELECT id FROM consumer_wallet_events WHERE event_type='FUNDED_LOAD' AND source_transaction_id=?",
      [transaction.id],
    )[0];
    const purchaseAllocations = rows(
      'SELECT credit_event_id,allocated_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=? ORDER BY credit_event_id',
      ['wallet-load-test-purchase'],
    );
    expect(purchaseAllocations).toEqual(
      [
        { credit_event_id: openingBalance!.id, allocated_minor: 950 },
        { credit_event_id: 'wallet-load-manual-credit', allocated_minor: 100 },
        { credit_event_id: 'wallet-load-promo-credit', allocated_minor: 50 },
        { credit_event_id: fundedLoad['id'], allocated_minor: 1000 },
      ].sort((left, right) =>
        String(left.credit_event_id).localeCompare(String(right.credit_event_id)),
      ),
    );
    await expect(save(4000)).rejects.toThrow('already been spent or returned');
    await expect(store.deleteRecordedTransaction(transaction.id)).rejects.toThrow(
      'already been spent or returned',
    );
    expect(store.deleteTransaction(transaction.id)).toBe(false);
    await database.atomic(async () => undefined);
    await Promise.resolve();
    expect(store.transactionWriteError()).toContain('Delete this funding debit from Transactions');
    expect(rows('SELECT id FROM card_transactions WHERE id=?', [transaction.id])).toHaveLength(1);
    expect(
      rows('SELECT amount_minor FROM consumer_wallet_events WHERE source_transaction_id=?', [
        transaction.id,
      ]),
    ).toEqual([{ amount_minor: 5000 }]);

    const unconsumedTransaction = {
      ...transaction,
      id: 'wallet-load-unconsumed-source-debit',
      amountMinor: 1000,
      transactionDate: '2026-10-10',
      createdAt: '2026-10-10T10:00:00.000Z',
      updatedAt: '2026-10-10T10:00:00.000Z',
    };
    await store.saveManualTransaction(unconsumedTransaction, '', false, undefined, '', {
      walletId: wallet.id,
      loadedAmountMinor: 1000,
    });
    await wallets.reloadFinancialHistory();
    const unconsumedLoad = wallets
      .events()
      .find((event) => event.sourceTransactionId === unconsumedTransaction.id)!;
    vi.spyOn(database, 'query').mockRejectedValueOnce(new Error('synthetic refresh failure'));
    await expect(store.deleteRecordedTransaction(unconsumedTransaction.id)).rejects.toBeInstanceOf(
      CommittedSaveRefreshError,
    );
    expect(rows('SELECT id FROM card_transactions WHERE id=?', [unconsumedTransaction.id])).toEqual(
      [],
    );
    expect(rows('SELECT id FROM consumer_wallet_events WHERE id=?', [unconsumedLoad.id])).toEqual(
      [],
    );
    expect(wallets.events().some((event) => event.id === unconsumedLoad.id)).toBe(true);
    wallets.forgetFundedLoadForTransaction(unconsumedTransaction.id);
    expect(wallets.events().some((event) => event.id === unconsumedLoad.id)).toBe(false);
    expect(wallets.balances().get(wallet.id)).toBe(4000);

    await store.refreshPaymentLedger();
    await wallets.reloadFinancialHistory();
    expect(wallets.events().some((event) => event.id === unconsumedLoad.id)).toBe(false);
  });
  it('rejects a Nov 1 funded load that would displace a Nov 3 purchase from its Nov 2 credit', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const creditedWallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const otherWallet = await wallets.registerWallet({ providerId: 'paytm-wallet' });
    await wallets.addWalletCredit({
      id: 'nov-2-manual-credit',
      walletId: creditedWallet.id,
      amountMinor: 10000,
      eventType: 'MANUAL_CREDIT',
      eventDate: '2026-11-02',
    });
    await recordApprovedWalletPurchase(wallets, {
      id: 'nov-3-wallet-purchase',
      walletId: creditedWallet.id,
      amountMinor: 5000,
      eventDate: '2026-11-03',
      categoryId: 'other',
    });
    const card = await installWalletLoadTestCard(store);
    const loadTransaction: CardTransaction = {
      id: 'nov-1-funding-debit',
      cardId: card.id,
      type: 'PURCHASE',
      amountMinor: 10000,
      currencyCode: 'INR',
      transactionDate: '2026-11-01',
      categoryId: 'other',
      merchant: 'Synthetic wallet funding',
      attachmentIds: [],
      paymentMethod: 'WALLET_LOADING',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    };
    const saveLoad = (walletId: string) =>
      store.saveManualTransaction(loadTransaction, '', false, undefined, '', {
        walletId,
        loadedAmountMinor: 10000,
      });

    await expect(saveLoad(creditedWallet.id)).rejects.toThrow('audited FIFO allocations');
    expect(rows('SELECT id FROM card_transactions WHERE id=?', [loadTransaction.id])).toEqual([]);
    expect(
      rows('SELECT id FROM consumer_wallet_events WHERE source_transaction_id=?', [
        loadTransaction.id,
      ]),
    ).toEqual([]);
    expect(
      rows(
        'SELECT credit_event_id,allocated_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?',
        ['nov-3-wallet-purchase'],
      ),
    ).toEqual([{ credit_event_id: 'nov-2-manual-credit', allocated_minor: 5000 }]);

    await saveLoad(otherWallet.id);
    await expect(saveLoad(creditedWallet.id)).rejects.toThrow('audited FIFO allocations');
    expect(
      rows('SELECT wallet_id FROM consumer_wallet_events WHERE source_transaction_id=?', [
        loadTransaction.id,
      ]),
    ).toEqual([{ wallet_id: otherWallet.id }]);
    expect(
      rows('SELECT card_id,transaction_date FROM card_transactions WHERE id=?', [
        loadTransaction.id,
      ]),
    ).toEqual([{ card_id: card.id, transaction_date: '2026-11-01' }]);
  });
  it('permits a safe past-dated funded load after an existing purchase without changing its allocation', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const today = indiaTodayIso();
    const creditDate = addCalendarDays(today, -4);
    const purchaseDate = addCalendarDays(today, -3);
    const loadDate = addCalendarDays(today, -2);
    await wallets.addWalletCredit({
      id: 'safe-backdated-manual-credit',
      walletId: wallet.id,
      amountMinor: 10000,
      eventType: 'MANUAL_CREDIT',
      eventDate: creditDate,
    });
    await recordApprovedWalletPurchase(wallets, {
      id: 'safe-backdated-purchase',
      walletId: wallet.id,
      amountMinor: 5000,
      eventDate: purchaseDate,
      categoryId: 'other',
    });
    const card = await installWalletLoadTestCard(store);
    const transaction: CardTransaction = {
      id: 'safe-backdated-load-debit',
      cardId: card.id,
      type: 'PURCHASE',
      amountMinor: 10000,
      currencyCode: 'INR',
      transactionDate: loadDate,
      categoryId: 'other',
      attachmentIds: [],
      paymentMethod: 'WALLET_LOADING',
      createdAt: `${loadDate}T10:00:00.000Z`,
      updatedAt: `${loadDate}T10:00:00.000Z`,
    };
    await store.saveManualTransaction(transaction, '', false, undefined, '', {
      walletId: wallet.id,
      loadedAmountMinor: 10000,
    });
    expect(
      rows(
        'SELECT credit_event_id,allocated_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?',
        ['safe-backdated-purchase'],
      ),
    ).toEqual([{ credit_event_id: 'safe-backdated-manual-credit', allocated_minor: 5000 }]);
    expect(
      rows('SELECT id FROM consumer_wallet_events WHERE source_transaction_id=?', [transaction.id]),
    ).toHaveLength(1);
  });
  it('rejects a same-day load-time edit that would displace an existing wallet purchase allocation', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const untimedCredit = await wallets.addWalletCredit({
      id: 'same-day-manual-credit',
      walletId: wallet.id,
      amountMinor: 10000,
      eventType: 'MANUAL_CREDIT',
      eventDate: '2026-11-02',
      memo: 'early lot',
    });
    const timedCredit = { ...untimedCredit, eventTime: '11:00' };
    await database.run('UPDATE consumer_wallet_events SET event_time=?,payload=? WHERE id=?', [
      '11:00',
      JSON.stringify(timedCredit),
      timedCredit.id,
    ]);
    await recordApprovedWalletPurchase(wallets, {
      id: 'same-day-wallet-purchase-before-load',
      walletId: wallet.id,
      amountMinor: 5000,
      eventDate: '2026-11-02',
      eventTime: '12:00',
      categoryId: 'other',
    });
    const card = await installWalletLoadTestCard(store);
    const transaction: CardTransaction = {
      id: 'same-day-load-debit',
      cardId: card.id,
      type: 'PURCHASE',
      amountMinor: 10000,
      currencyCode: 'INR',
      transactionDate: '2026-11-02',
      transactionTime: '13:00',
      categoryId: 'other',
      attachmentIds: [],
      paymentMethod: 'WALLET_LOADING',
      createdAt: '2026-11-02T13:00:00.000Z',
      updatedAt: '2026-11-02T13:00:00.000Z',
    };
    const save = (next: CardTransaction) =>
      store.saveManualTransaction(next, '', false, undefined, '', {
        walletId: wallet.id,
        loadedAmountMinor: 10000,
      });
    await save(transaction);
    await recordApprovedWalletPurchase(wallets, {
      id: 'same-day-wallet-purchase-after-load',
      walletId: wallet.id,
      amountMinor: 10000,
      eventDate: '2026-11-02',
      eventTime: '14:00',
      categoryId: 'other',
    });
    await expect(
      store.saveManualTransaction(transaction, '', false, undefined, '', {
        walletId: wallet.id,
        loadedAmountMinor: 4000,
      }),
    ).rejects.toThrow('already been spent or returned');
    await expect(save({ ...transaction, transactionTime: '09:00' })).rejects.toThrow(
      'audited FIFO allocations',
    );
    expect(
      rows('SELECT event_time FROM consumer_wallet_events WHERE source_transaction_id=?', [
        transaction.id,
      ]),
    ).toEqual([{ event_time: '13:00' }]);
  });
  it('does not let a future wallet credit fund a backdated purchase', async () => {
    await database.initialise();
    await TestBed.inject(CardNestStore).initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const today = indiaTodayIso();
    const futureLoad = {
      id: 'future-wallet-load',
      walletId: wallet.id,
      eventType: 'FUNDED_LOAD',
      eventDate: addCalendarDays(today, 1),
      eventTime: '10:00',
      amountMinor: 5000,
      balanceDeltaMinor: 5000,
      loadedAmountMinor: 5000,
      feeMinor: 0,
      createdAt: '2026-11-02T10:00:00.000Z',
      updatedAt: '2026-11-02T10:00:00.000Z',
    };
    await database.run(
      'INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,event_time,amount_minor,balance_delta_minor,loaded_amount_minor,fee_minor,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        futureLoad.id,
        futureLoad.walletId,
        futureLoad.eventType,
        futureLoad.eventDate,
        futureLoad.eventTime,
        futureLoad.amountMinor,
        futureLoad.balanceDeltaMinor,
        futureLoad.loadedAmountMinor,
        futureLoad.feeMinor,
        JSON.stringify(futureLoad),
        futureLoad.createdAt,
        futureLoad.updatedAt,
      ],
    );
    expect(wallets.balances().get(wallet.id) ?? 0).toBe(0);
    await expect(
      recordApprovedWalletPurchase(wallets, {
        id: 'backdated-wallet-purchase',
        walletId: wallet.id,
        amountMinor: 1000,
        eventDate: today,
        categoryId: 'other',
      }),
    ).rejects.toThrow('historical');
    expect(
      rows('SELECT id FROM consumer_wallet_events WHERE id=?', ['backdated-wallet-purchase']),
    ).toEqual([]);
  });
  it('accepts a safe backdated balance correction without changing later FIFO provenance', async () => {
    await database.initialise();
    await TestBed.inject(CardNestStore).initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const today = indiaTodayIso();
    await wallets.addWalletCredit({
      id: 'correction-opening-credit',
      walletId: wallet.id,
      amountMinor: 1000,
      eventType: 'MANUAL_CREDIT',
      eventDate: addCalendarDays(today, -3),
    });
    await recordApprovedWalletPurchase(wallets, {
      id: 'correction-later-purchase',
      walletId: wallet.id,
      amountMinor: 200,
      eventDate: addCalendarDays(today, -1),
      categoryId: 'other',
    });

    await wallets.updateWalletBalance({
      id: 'safe-backdated-correction',
      walletId: wallet.id,
      newBalanceMinor: 900,
      eventDate: addCalendarDays(today, -2),
    });

    expect(wallets.balances().get(wallet.id)).toBe(700);
    expect(
      rows(
        'SELECT credit_event_id,allocated_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?',
        ['correction-later-purchase'],
      ),
    ).toEqual([{ credit_event_id: 'correction-opening-credit', allocated_minor: 200 }]);
  });
  it('rejects a backdated correction that would change an audited downstream FIFO allocation', async () => {
    await database.initialise();
    await TestBed.inject(CardNestStore).initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const today = indiaTodayIso();
    await wallets.addWalletCredit({
      id: 'fifo-first-credit',
      walletId: wallet.id,
      amountMinor: 500,
      eventType: 'MANUAL_CREDIT',
      eventDate: addCalendarDays(today, -4),
    });
    await wallets.addWalletCredit({
      id: 'fifo-second-credit',
      walletId: wallet.id,
      amountMinor: 500,
      eventType: 'PROMOTIONAL_CREDIT',
      eventDate: addCalendarDays(today, -2),
    });
    await recordApprovedWalletPurchase(wallets, {
      id: 'fifo-later-purchase',
      walletId: wallet.id,
      amountMinor: 500,
      eventDate: addCalendarDays(today, -1),
      categoryId: 'other',
    });

    await expect(
      wallets.updateWalletBalance({
        id: 'unsafe-backdated-correction',
        walletId: wallet.id,
        newBalanceMinor: 100,
        eventDate: addCalendarDays(today, -3),
      }),
    ).rejects.toThrow('change audited FIFO allocations');
    expect(
      rows('SELECT id FROM consumer_wallet_events WHERE id=?', ['unsafe-backdated-correction']),
    ).toEqual([]);
    expect(
      rows(
        'SELECT credit_event_id,allocated_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?',
        ['fifo-later-purchase'],
      ),
    ).toEqual([{ credit_event_id: 'fifo-first-credit', allocated_minor: 500 }]);
  });
  it('rejects a backdated correction that would make a later purchase historically negative', async () => {
    await database.initialise();
    await TestBed.inject(CardNestStore).initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    const today = indiaTodayIso();
    await wallets.addWalletCredit({
      id: 'negative-history-credit',
      walletId: wallet.id,
      amountMinor: 1000,
      eventType: 'MANUAL_CREDIT',
      eventDate: addCalendarDays(today, -3),
    });
    await recordApprovedWalletPurchase(wallets, {
      id: 'negative-history-purchase',
      walletId: wallet.id,
      amountMinor: 700,
      eventDate: addCalendarDays(today, -1),
      categoryId: 'other',
    });

    await expect(
      wallets.updateWalletBalance({
        id: 'negative-history-correction',
        walletId: wallet.id,
        newBalanceMinor: 0,
        eventDate: addCalendarDays(today, -2),
      }),
    ).rejects.toThrow('negative historical balance');
    expect(
      rows('SELECT id FROM consumer_wallet_events WHERE id=?', ['negative-history-correction']),
    ).toEqual([]);
    expect(wallets.balances().get(wallet.id)).toBe(300);
  });
  it('rejects a wallet-credit overflow without committing the overflowing event', async () => {
    await database.initialise();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'amazon-pay' });
    await wallets.addWalletCredit({
      id: 'maximum-wallet-credit',
      walletId: wallet.id,
      amountMinor: Number.MAX_SAFE_INTEGER,
      eventType: 'MANUAL_CREDIT',
      eventDate: '2026-11-01',
    });
    await expect(
      wallets.addWalletCredit({
        id: 'overflow-wallet-credit',
        walletId: wallet.id,
        amountMinor: 1,
        eventType: 'PROMOTIONAL_CREDIT',
        eventDate: '2026-11-02',
      }),
    ).rejects.toThrow('supported balance range');
    expect(
      rows('SELECT id FROM consumer_wallet_events WHERE id=?', ['overflow-wallet-credit']),
    ).toEqual([]);
  });
  it('previews and atomically posts UPI Lite returns with funded-principal FIFO attribution', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const bank = await store.addBankAccount({ institution: 'ICICI Bank', lastDigits: '419' });
    await store.enableBankTracking({ [bank.id]: 50000 });
    const wallet = await wallets.registerWallet({ providerId: 'upi-lite' });
    const today = indiaTodayIso();
    await wallets.addWalletCredit({
      id: 'return-test-manual-credit',
      walletId: wallet.id,
      amountMinor: 4000,
      eventType: 'MANUAL_CREDIT',
      eventDate: addCalendarDays(today, -4),
    });
    const loadCreatedAt = new Date().toISOString();
    const loadTransaction: CardTransaction = {
      id: 'return-test-load-transaction',
      cardId: bank.id,
      type: 'PURCHASE',
      amountMinor: 6500,
      currencyCode: 'INR',
      transactionDate: addCalendarDays(today, -3),
      transactionTime: '10:00',
      categoryId: 'other',
      merchant: 'Synthetic UPI Lite load',
      attachmentIds: [],
      paymentMethod: 'WALLET_LOADING',
      origin: 'MANUAL',
      createdAt: loadCreatedAt,
      updatedAt: loadCreatedAt,
    };
    await store.saveManualTransaction(loadTransaction, '', false, undefined, '', {
      walletId: wallet.id,
      loadedAmountMinor: 6000,
    });
    await wallets.reloadFinancialHistory();
    const fundedLoad = wallets
      .events()
      .find((event) => event.sourceTransactionId === loadTransaction.id)!;
    expect(fundedLoad).toMatchObject({
      eventType: 'FUNDED_LOAD',
      amountMinor: 6000,
      loadedAmountMinor: 6000,
      debitAmountMinor: 6500,
      feeMinor: 500,
      fundingSourceKind: 'BANK',
      fundingSourceId: bank.id,
    });
    const input = {
      id: 'return-test-event',
      walletId: wallet.id,
      bankSourceId: bank.id,
      amountMinor: 8000,
      eventDate: addCalendarDays(today, 2),
      eventTime: '10:00',
      reference: 'SYNTHETIC-RETURN-1',
      note: 'Synthetic return test',
    };
    const preview = await wallets.previewUpiLiteReturn(input);
    expect(preview).toMatchObject({
      fundedPrincipalReversalMinor: 4000,
      nonFundedReturnMinor: 4000,
      remainingWalletBalanceMinor: 2000,
      attributions: [
        {
          creditEventId: 'return-test-manual-credit',
          allocatedMinor: 4000,
          expenseReversalMinor: 0,
        },
        {
          creditEventId: fundedLoad.id,
          allocatedMinor: 4000,
          expenseReversalMinor: 4000,
        },
      ],
    });
    expect(rows('SELECT id FROM consumer_wallet_events WHERE id=?', [input.id])).toEqual([]);

    const confirmedInput = { ...input, confirmationKey: preview.confirmationKey };
    const bankSourcesBeforeFailure = rows(
      "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
    );
    sql.exec(
      `CREATE TRIGGER fail_return_link BEFORE INSERT ON consumer_wallet_return_links
       BEGIN SELECT RAISE(ABORT,'synthetic return link failure'); END`,
    );
    await expect(wallets.recordUpiLiteReturn(confirmedInput)).rejects.toThrow(
      'synthetic return link failure',
    );
    expect(rows('SELECT id FROM consumer_wallet_events WHERE id=?', [input.id])).toEqual([]);
    expect(
      rows('SELECT * FROM consumer_wallet_event_allocations WHERE debit_event_id=?', [input.id]),
    ).toEqual([]);
    expect(
      rows('SELECT * FROM consumer_wallet_expense_reversals WHERE return_event_id=?', [input.id]),
    ).toEqual([]);
    expect(
      rows('SELECT id FROM card_transactions WHERE id=?', [
        `wallet-return-bank-credit-${input.id}`,
      ]),
    ).toEqual([]);
    expect(rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")).toEqual(
      bankSourcesBeforeFailure,
    );
    expect(store.paymentSources().find((source) => source.id === bank.id)?.balanceMinor).toBe(
      50000,
    );
    sql.exec('DROP TRIGGER fail_return_link');

    const returned = await wallets.recordUpiLiteReturn(confirmedInput);
    expect(returned).toMatchObject({
      id: input.id,
      eventType: 'UPI_LITE_RETURN',
      amountMinor: 8000,
      balanceDeltaMinor: -8000,
      sourceTransactionId: `wallet-return-bank-credit-${input.id}`,
    });
    expect(
      rows(
        'SELECT credit_event_id,allocated_minor,expense_reversal_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?',
        [input.id],
      ),
    ).toHaveLength(2);
    expect(
      rows(
        'SELECT credit_event_id,allocated_minor,expense_reversal_minor FROM consumer_wallet_event_allocations WHERE debit_event_id=?',
        [input.id],
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          credit_event_id: 'return-test-manual-credit',
          allocated_minor: 4000,
          expense_reversal_minor: 0,
        },
        {
          credit_event_id: fundedLoad.id,
          allocated_minor: 4000,
          expense_reversal_minor: 4000,
        },
      ]),
    );
    expect(
      rows(
        'SELECT credit_event_id,funded_load_event_id,reversed_minor FROM consumer_wallet_expense_reversals WHERE return_event_id=?',
        [input.id],
      ),
    ).toEqual([
      {
        credit_event_id: fundedLoad.id,
        funded_load_event_id: fundedLoad.id,
        reversed_minor: 4000,
      },
    ]);
    expect(
      rows(
        'SELECT bank_source_id,existing_bank_transaction_id,reference,note FROM consumer_wallet_return_links WHERE return_event_id=?',
        [input.id],
      ),
    ).toEqual([
      {
        bank_source_id: bank.id,
        existing_bank_transaction_id: null,
        reference: input.reference,
        note: input.note,
      },
    ]);
    const bankReturnRows = rows('SELECT payload FROM card_transactions WHERE id=?', [
      `wallet-return-bank-credit-${input.id}`,
    ]);
    expect(bankReturnRows).toHaveLength(1);
    expect(JSON.parse(String(bankReturnRows[0]['payload']))).toMatchObject({
      cardId: bank.id,
      type: 'CREDIT',
      amountMinor: input.amountMinor,
      categoryId: 'contra-expenses',
      origin: 'MANUAL',
      balanceEffect: { sourceId: bank.id, deltaMinor: input.amountMinor },
    });
    expect(store.paymentSources().find((source) => source.id === bank.id)?.balanceMinor).toBe(
      58000,
    );
    await expect(wallets.recordUpiLiteReturn(confirmedInput)).resolves.toEqual(returned);
    expect(
      rows('SELECT id FROM consumer_wallet_event_allocations WHERE debit_event_id=?', [input.id]),
    ).toHaveLength(2);
    expect(store.paymentSources().find((source) => source.id === bank.id)?.balanceMinor).toBe(
      58000,
    );
  });
  it('links only an explicitly selected Bank credit without posting or applying a duplicate', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const bank = await store.addBankAccount({ institution: 'ICICI Bank', lastDigits: '419' });
    await store.enableBankTracking({ [bank.id]: 50000 });
    const wallet = await wallets.registerWallet({ providerId: 'upi-lite' });
    const today = indiaTodayIso();
    const eventDate = addCalendarDays(today, 1);
    await wallets.addWalletCredit({
      id: 'existing-return-wallet-credit',
      walletId: wallet.id,
      amountMinor: 5000,
      eventType: 'MANUAL_CREDIT',
      eventDate: today,
    });
    const existingCredit: CardTransaction = {
      id: 'existing-upi-return-bank-credit',
      cardId: bank.id,
      type: 'CREDIT',
      amountMinor: 5000,
      currencyCode: 'INR',
      transactionDate: eventDate,
      categoryId: 'contra-expenses',
      reference: 'EXISTING-RETURN-RECEIPT',
      origin: 'MANUAL',
      attachmentIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.saveManualTransaction(existingCredit);
    const balanceAfterExistingCredit = store
      .paymentSources()
      .find((source) => source.id === bank.id)?.balanceMinor;
    expect(balanceAfterExistingCredit).toBe(55000);
    const input = {
      id: 'explicit-existing-return-event',
      walletId: wallet.id,
      bankSourceId: bank.id,
      amountMinor: 5000,
      eventDate,
      eventTime: '10:00',
      reference: existingCredit.reference,
    };
    await expect(wallets.previewUpiLiteReturn(input)).rejects.toThrow(
      'Select it explicitly or enter a distinct reference',
    );
    const preview = await wallets.previewUpiLiteReturn({
      ...input,
      existingBankTransactionId: existingCredit.id,
    });
    expect(preview.existingBankTransactionId).toBe(existingCredit.id);
    const returned = await wallets.recordUpiLiteReturn({
      ...input,
      existingBankTransactionId: existingCredit.id,
      confirmationKey: preview.confirmationKey,
    });

    expect(returned.sourceTransactionId).toBe(existingCredit.id);
    expect(
      rows(
        'SELECT existing_bank_transaction_id FROM consumer_wallet_return_links WHERE return_event_id=?',
        [input.id],
      ),
    ).toEqual([{ existing_bank_transaction_id: existingCredit.id }]);
    expect(
      rows(
        "SELECT id FROM card_transactions WHERE type='CREDIT' AND json_extract(payload,'$.cardId')=?",
        [bank.id],
      ),
    ).toEqual([{ id: existingCredit.id }]);
    expect(store.updateTransaction({ ...existingCredit, merchant: 'Unsafe linked edit' })).toBe(
      false,
    );
    expect(store.transactionWriteError()).toContain('linked to a UPI Lite return');
    expect(store.deleteTransaction(existingCredit.id)).toBe(false);
    expect(rows('SELECT id FROM card_transactions WHERE id=?', [existingCredit.id])).toHaveLength(
      1,
    );
    expect(store.paymentSources().find((source) => source.id === bank.id)?.balanceMinor).toBe(
      balanceAfterExistingCredit,
    );
  });
  it('preserves promotional and funded-load FIFO order and rejects ineligible returns', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const bank = await store.addBankAccount({ institution: 'ICICI Bank', lastDigits: '419' });
    await store.enableBankTracking({ [bank.id]: 50000 });
    const wallet = await wallets.registerWallet({ providerId: 'upi-lite' });
    const today = indiaTodayIso();
    const saveFundedLoad = async (id: string, eventDate: string) => {
      const createdAt = new Date().toISOString();
      await store.saveManualTransaction(
        {
          id,
          cardId: bank.id,
          type: 'PURCHASE',
          amountMinor: 6500,
          currencyCode: 'INR',
          transactionDate: eventDate,
          transactionTime: '10:00',
          categoryId: 'other',
          attachmentIds: [],
          paymentMethod: 'WALLET_LOADING',
          origin: 'MANUAL',
          createdAt,
          updatedAt: createdAt,
        },
        '',
        false,
        undefined,
        '',
        { walletId: wallet.id, loadedAmountMinor: 6000 },
      );
    };
    const recordReturn = async (id: string, amountMinor: number, eventDate: string) => {
      const input = {
        id,
        walletId: wallet.id,
        bankSourceId: bank.id,
        amountMinor,
        eventDate,
        eventTime: '10:00',
      };
      const preview = await wallets.previewUpiLiteReturn(input);
      const returned = await wallets.recordUpiLiteReturn({
        ...input,
        confirmationKey: preview.confirmationKey,
      });
      return { preview, returned };
    };

    await wallets.addWalletCredit({
      id: 'promo-before-load',
      walletId: wallet.id,
      amountMinor: 4000,
      eventType: 'PROMOTIONAL_CREDIT',
      eventDate: addCalendarDays(today, -8),
    });
    await saveFundedLoad('load-after-promo', addCalendarDays(today, -7));
    const promoFirst = await recordReturn('return-promo-first', 10000, addCalendarDays(today, -6));
    expect(promoFirst.preview).toMatchObject({
      fundedPrincipalReversalMinor: 6000,
      nonFundedReturnMinor: 4000,
      remainingWalletBalanceMinor: 0,
      attributions: [
        { creditEventId: 'promo-before-load', allocatedMinor: 4000, expenseReversalMinor: 0 },
        { allocatedMinor: 6000, expenseReversalMinor: 6000 },
      ],
    });

    await saveFundedLoad('load-before-promo', addCalendarDays(today, -4));
    await wallets.addWalletCredit({
      id: 'promo-after-load',
      walletId: wallet.id,
      amountMinor: 4000,
      eventType: 'PROMOTIONAL_CREDIT',
      eventDate: addCalendarDays(today, -3),
    });
    const loadFirst = await recordReturn('return-load-first', 8000, addCalendarDays(today, -2));
    expect(loadFirst.preview).toMatchObject({
      fundedPrincipalReversalMinor: 6000,
      nonFundedReturnMinor: 2000,
      remainingWalletBalanceMinor: 2000,
      attributions: [
        { allocatedMinor: 6000, expenseReversalMinor: 6000 },
        { creditEventId: 'promo-after-load', allocatedMinor: 2000, expenseReversalMinor: 0 },
      ],
    });
    const fundedLoadRows = rows(
      "SELECT amount_minor,loaded_amount_minor,fee_minor FROM consumer_wallet_events WHERE event_type='FUNDED_LOAD' AND wallet_id=? ORDER BY event_date",
      [wallet.id],
    );
    expect(fundedLoadRows).toEqual([
      { amount_minor: 6000, loaded_amount_minor: 6000, fee_minor: 500 },
      { amount_minor: 6000, loaded_amount_minor: 6000, fee_minor: 500 },
    ]);
    expect(store.paymentSources().find((source) => source.id === bank.id)?.balanceMinor).toBe(
      50000,
    );

    const invalidBankInput = {
      id: 'invalid-return-bank',
      walletId: wallet.id,
      bankSourceId: 'source-cash',
      amountMinor: 1000,
      eventDate: addCalendarDays(today, 1),
      confirmationKey: '',
    };
    await expect(wallets.recordUpiLiteReturn(invalidBankInput)).rejects.toThrow(
      'Choose an active registered Bank/UPI account',
    );
    await wallets.archiveWallet(wallet.id);
    await expect(
      wallets.recordUpiLiteReturn({
        ...invalidBankInput,
        id: 'archived-return-wallet',
        bankSourceId: bank.id,
      }),
    ).rejects.toThrow('active registered consumer wallet');
    await wallets.setEnabled(false);
    await expect(
      wallets.recordUpiLiteReturn({
        ...invalidBankInput,
        id: 'disabled-return-wallet',
        bankSourceId: bank.id,
      }),
    ).rejects.toThrow('Wallets is off');
  });
  beforeEach(() => {
    vi.clearAllMocks();
    config.seedDemoData = false;
    sql = new DatabaseSync(':memory:');
    sql.exec('PRAGMA foreign_keys=ON');
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    vi.mocked(CapacitorSQLite.query).mockImplementation(async (options) => ({
      values: rows(options.statement!, options.values),
    }));
    vi.mocked(CapacitorSQLite.run).mockImplementation(async (options) => ({
      changes: {
        changes: Number(
          sql.prepare(options.statement!).run(...((options.values ?? []) as SQLInputValue[]))
            .changes,
        ),
      },
    }));
    vi.mocked(CapacitorSQLite.execute).mockImplementation(async (options) => {
      if (options.transaction) sql.exec('BEGIN');
      try {
        sql.exec(options.statements!);
        if (options.transaction) sql.exec('COMMIT');
      } catch (error) {
        if (options.transaction) sql.exec('ROLLBACK');
        throw error;
      }
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.executeSet).mockImplementation(async (options) => {
      for (const item of options.set ?? [])
        sql.prepare(item.statement!).run(...((item.values ?? []) as SQLInputValue[]));
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.beginTransaction).mockImplementation(async () => {
      sql.exec('BEGIN');
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.commitTransaction).mockImplementation(async () => {
      sql.exec('COMMIT');
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.rollbackTransaction).mockImplementation(async () => {
      sql.exec('ROLLBACK');
      return { changes: { changes: 0 } };
    });
    TestBed.configureTestingModule({
      providers: [
        SqliteDatabase,
        CardNestStore,
        ConsumerWalletService,
        SmsReviewService,
        { provide: AppLockService, useValue: { locked: () => false, foreground: () => true } },
        { provide: APP_ENVIRONMENT, useValue: config },
        { provide: NATIVE_EXPORT, useValue: {} },
      ],
    });
    database = TestBed.inject(SqliteDatabase);
  });
  afterEach(() => {
    sql.close();
    vi.restoreAllMocks();
  });
  it('round-trips consumer-wallet events, FIFO allocations, FASTag identity and cloned recharge history', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const funded = await wallets.registerWallet({
      providerId: 'amazon-pay',
      nickname: 'Synthetic funded wallet',
    });
    const upiLite = await wallets.registerWallet({ providerId: 'upi-lite' });
    await wallets.archiveWallet(upiLite.id);
    await wallets.setEnabled(false);
    const fastag: PaymentSource = {
      id: 'backup-fastag-source',
      kind: 'FASTAG',
      nickname: 'Synthetic backup FASTag',
      institution: 'Fictional provider',
      vehicleNumber: 'FICT001',
      noLimit: false,
      balanceMinor: 76500,
      autoLoad: false,
      archived: false,
    };
    await store.addWallet(fastag);

    const eventRows = [
      {
        id: 'backup-load-event',
        walletId: funded.id,
        eventType: 'FUNDED_LOAD',
        eventDate: '2026-10-20',
        amountMinor: 30000,
        balanceDeltaMinor: 30000,
        loadedAmountMinor: 30000,
        feeMinor: 2000,
        fundingSourceKind: 'CARD',
        fundingSourceId: 'backup-card',
        sourceTransactionId: 'backup-funding-transaction',
        createdAt: '2026-10-20T10:00:00Z',
        updatedAt: '2026-10-20T10:00:00Z',
      },
      {
        id: 'backup-wallet-purchase',
        walletId: funded.id,
        eventType: 'PURCHASE',
        eventDate: '2026-10-21',
        amountMinor: 5000,
        balanceDeltaMinor: -5000,
        categoryId: 'other',
        attachmentIds: ['data:image/jpeg;base64,c3ludGhldGljLXJlY2VpcHQ='],
        createdAt: '2026-10-21T10:00:00Z',
        updatedAt: '2026-10-21T10:00:00Z',
      },
      {
        id: 'backup-upi-load',
        walletId: upiLite.id,
        eventType: 'FUNDED_LOAD',
        eventDate: '2026-10-22',
        amountMinor: 50000,
        balanceDeltaMinor: 50000,
        loadedAmountMinor: 50000,
        feeMinor: 0,
        fundingSourceKind: 'BANK',
        fundingSourceId: 'backup-bank-source',
        sourceTransactionId: 'backup-bank-load-transaction',
        createdAt: '2026-10-22T10:00:00Z',
        updatedAt: '2026-10-22T10:00:00Z',
      },
      {
        id: 'backup-upi-purchase',
        walletId: upiLite.id,
        eventType: 'PURCHASE',
        eventDate: '2026-10-23',
        eventTime: '09:00',
        amountMinor: 5000,
        balanceDeltaMinor: -5000,
        categoryId: 'other',
        createdAt: '2026-10-23T09:00:00Z',
        updatedAt: '2026-10-23T09:00:00Z',
      },
      {
        id: 'backup-upi-return',
        walletId: upiLite.id,
        eventType: 'UPI_LITE_RETURN',
        eventDate: '2026-10-23',
        amountMinor: 10000,
        balanceDeltaMinor: -10000,
        fundingSourceKind: 'BANK',
        returnSourceId: 'backup-favourite-bank',
        sourceTransactionId: 'backup-return-bank-credit',
        createdAt: '2026-10-23T10:00:00Z',
        updatedAt: '2026-10-23T10:00:00Z',
      },
      {
        id: 'backup-refund-credit',
        walletId: upiLite.id,
        eventType: 'REFUND',
        eventDate: '2026-10-24',
        amountMinor: 5000,
        balanceDeltaMinor: 5000,
        reversalOfEventId: 'backup-upi-purchase',
        refundReason: 'Synthetic returned purchase',
        createdAt: '2026-10-24T11:00:00Z',
        updatedAt: '2026-10-24T11:00:00Z',
      },
      {
        id: 'backup-manual-credit',
        walletId: funded.id,
        eventType: 'PROMOTIONAL_CREDIT',
        eventDate: '2026-10-24',
        amountMinor: 1200,
        balanceDeltaMinor: 1200,
        createdAt: '2026-10-24T10:00:00Z',
        updatedAt: '2026-10-24T10:00:00Z',
      },
    ];
    await database.atomic(async (tx) => {
      await tx.run(
        'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [
          'backup-return-bank-credit',
          null,
          'contra-expenses',
          'CREDIT',
          10000,
          'INR',
          '2026-10-23',
          JSON.stringify({
            id: 'backup-return-bank-credit',
            cardId: 'backup-favourite-bank',
            type: 'CREDIT',
            amountMinor: 10000,
            currencyCode: 'INR',
            transactionDate: '2026-10-23',
            categoryId: 'contra-expenses',
            origin: 'MANUAL',
            attachmentIds: [],
            createdAt: '2026-10-23T10:00:00Z',
            updatedAt: '2026-10-23T10:00:00Z',
          }),
          '2026-10-23T10:00:00Z',
          '2026-10-23T10:00:00Z',
        ],
      );
      for (const event of eventRows)
        await tx.run(
          'INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,loaded_amount_minor,fee_minor,funding_source_kind,funding_source_id,source_transaction_id,return_source_id,reversal_of_event_id,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            event.id,
            event.walletId,
            event.eventType,
            event.eventDate,
            event.amountMinor,
            event.balanceDeltaMinor,
            'loadedAmountMinor' in event ? event.loadedAmountMinor : null,
            'feeMinor' in event ? event.feeMinor : null,
            'fundingSourceKind' in event ? event.fundingSourceKind : null,
            'fundingSourceId' in event ? event.fundingSourceId : null,
            'sourceTransactionId' in event ? event.sourceTransactionId : null,
            'returnSourceId' in event ? event.returnSourceId : null,
            'reversalOfEventId' in event ? event.reversalOfEventId : null,
            JSON.stringify(event),
            event.createdAt,
            event.updatedAt,
          ],
        );
      await tx.run(
        'INSERT INTO consumer_wallet_event_allocations(id,debit_event_id,credit_event_id,allocated_minor,expense_reversal_minor,created_at) VALUES(?,?,?,?,?,?)',
        [
          'backup-purchase-allocation',
          'backup-wallet-purchase',
          'backup-load-event',
          5000,
          0,
          'now',
        ],
      );
      await tx.run(
        'INSERT INTO consumer_wallet_event_allocations(id,debit_event_id,credit_event_id,allocated_minor,expense_reversal_minor,created_at) VALUES(?,?,?,?,?,?)',
        ['backup-return-allocation', 'backup-upi-return', 'backup-upi-load', 10000, 10000, 'now'],
      );
      await tx.run(
        'INSERT INTO consumer_wallet_event_allocations(id,debit_event_id,credit_event_id,allocated_minor,expense_reversal_minor,created_at) VALUES(?,?,?,?,?,?)',
        [
          'backup-upi-purchase-allocation',
          'backup-upi-purchase',
          'backup-upi-load',
          5000,
          0,
          'now',
        ],
      );
      await tx.run(
        'INSERT INTO consumer_wallet_return_links(return_event_id,wallet_id,bank_source_id,existing_bank_transaction_id,balance_effect,reference,note,created_at) VALUES(?,?,?,?,?,?,?,?)',
        [
          'backup-upi-return',
          upiLite.id,
          'backup-favourite-bank',
          null,
          JSON.stringify({
            sourceId: 'backup-favourite-bank',
            deltaMinor: 10000,
            appliedAt: '2026-10-23T10:00:00Z',
          }),
          'BACKUP-RETURN-REF',
          'Synthetic backup return',
          '2026-10-23T10:00:00Z',
        ],
      );
      await tx.run(
        'INSERT INTO consumer_wallet_expense_reversals(return_event_id,credit_event_id,funded_load_event_id,reversed_minor,created_at) VALUES(?,?,?,?,?)',
        ['backup-upi-return', 'backup-upi-load', 'backup-upi-load', 10000, 'now'],
      );
      await tx.run(
        'INSERT INTO consumer_wallet_credit_provenance(credit_event_id,source_credit_event_id,allocated_minor,created_at) VALUES(?,?,?,?)',
        ['backup-refund-credit', 'backup-upi-load', 5000, 'now'],
      );
      await tx.run(
        'INSERT INTO consumer_wallet_credit_provenance_segments(id,credit_event_id,segment_order,root_credit_event_id,source_purchase_event_id,amount_minor,created_at) VALUES(?,?,?,?,?,?,?)',
        [
          'backup-refund-credit:segment:0',
          'backup-refund-credit',
          0,
          'backup-upi-load',
          'backup-upi-purchase',
          5000,
          'now',
        ],
      );
      await tx.run(
        'INSERT INTO transaction_split_groups(id,original_amount_minor,created_at,kind,anchor_transaction_id,title,currency_code,bill_total_minor,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [
          'backup-wallet-split-group',
          5000,
          'now',
          'PAYMENTS',
          null,
          'Synthetic mixed split',
          'INR',
          5000,
          'now',
        ],
      );
      await tx.run(
        'INSERT INTO consumer_wallet_split_members(group_id,wallet_event_id,member_kind,member_order,created_at) VALUES(?,?,?,?,?)',
        ['backup-wallet-split-group', 'backup-wallet-purchase', 'WALLET_PURCHASE', 1, 'now'],
      );
    });

    const utilities = TestBed.inject(UtilitiesService);
    await utilities.initialise();
    const mobile = await utilities.saveMobileProfile({
      personName: 'Synthetic clone profile',
      operator: 'JIO',
      subscriptionType: 'PREPAID',
    });
    const originalRecharge = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'VOICE_DATA',
      amountMinor: 34900,
      startDate: '2026-10-01',
      validityDays: 28,
    });
    const clonedRecharge = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: originalRecharge.planType,
      amountMinor: originalRecharge.amountMinor,
      startDate: '2026-11-02',
      validityDays: 28,
      comment: 'Cloned draft saved as new history',
    });

    const expectedWallets = rows('SELECT * FROM consumer_wallets ORDER BY id');
    const expectedEvents = rows('SELECT * FROM consumer_wallet_events ORDER BY id');
    const expectedAllocations = rows('SELECT * FROM consumer_wallet_event_allocations ORDER BY id');
    const expectedReturnLinks = rows(
      'SELECT * FROM consumer_wallet_return_links ORDER BY return_event_id',
    );
    const expectedReversals = rows(
      'SELECT * FROM consumer_wallet_expense_reversals ORDER BY return_event_id,credit_event_id,funded_load_event_id',
    );
    const expectedCreditProvenance = rows(
      'SELECT * FROM consumer_wallet_credit_provenance ORDER BY credit_event_id,source_credit_event_id',
    );
    const expectedProvenanceSegments = rows(
      'SELECT * FROM consumer_wallet_credit_provenance_segments ORDER BY credit_event_id,segment_order',
    );
    const expectedWalletSplitMembers = rows(
      'SELECT * FROM consumer_wallet_split_members ORDER BY group_id,member_order',
    );
    const expectedSplitGroups = rows('SELECT * FROM transaction_split_groups ORDER BY id');
    const expectedCardTransactions = rows('SELECT * FROM card_transactions ORDER BY id');
    const expectedSources = store.paymentSources();
    const expectedRecharges = rows('SELECT * FROM mobile_recharges ORDER BY id');
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-wallet-roundtrip-passphrase');
      expect(backup.contents).not.toContain('Synthetic funded wallet');
      expect(rows('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
      expect(rows('PRAGMA foreign_key_check')).toEqual([]);
      await database.run(
        "UPDATE consumer_wallet_events SET notes='mutated after backup' WHERE id='backup-upi-return'",
      );
      const preRestoreEvents = rows('SELECT * FROM consumer_wallet_events ORDER BY id');
      const preRestoreSegments = rows(
        'SELECT * FROM consumer_wallet_credit_provenance_segments ORDER BY credit_event_id,segment_order',
      );
      const preRestoreLinks = rows(
        'SELECT * FROM consumer_wallet_return_links ORDER BY return_event_id',
      );
      sql.exec(
        `CREATE TRIGGER fail_wallet_relation_restore BEFORE INSERT ON consumer_wallet_return_links
         BEGIN SELECT RAISE(ABORT,'synthetic wallet relation restore failure'); END`,
      );
      await expect(
        backups.restore(backup.contents, 'synthetic-wallet-roundtrip-passphrase'),
      ).rejects.toThrow('synthetic wallet relation restore failure');
      expect(rows('SELECT * FROM consumer_wallet_events ORDER BY id')).toEqual(preRestoreEvents);
      expect(
        rows(
          'SELECT * FROM consumer_wallet_credit_provenance_segments ORDER BY credit_event_id,segment_order',
        ),
      ).toEqual(preRestoreSegments);
      expect(rows('SELECT * FROM consumer_wallet_return_links ORDER BY return_event_id')).toEqual(
        preRestoreLinks,
      );
      expect(rows('SELECT * FROM consumer_wallet_event_allocations ORDER BY id')).toEqual(
        expectedAllocations,
      );
      expect(
        rows(
          'SELECT * FROM consumer_wallet_expense_reversals ORDER BY return_event_id,credit_event_id,funded_load_event_id',
        ),
      ).toEqual(expectedReversals);
      expect(
        rows(
          'SELECT * FROM consumer_wallet_credit_provenance ORDER BY credit_event_id,source_credit_event_id',
        ),
      ).toEqual(expectedCreditProvenance);
      expect(
        rows(
          'SELECT * FROM consumer_wallet_credit_provenance_segments ORDER BY credit_event_id,segment_order',
        ),
      ).toEqual(expectedProvenanceSegments);
      expect(
        JSON.parse(
          String(
            rows('SELECT payload FROM consumer_wallet_events WHERE id=?', [
              'backup-wallet-purchase',
            ])[0]['payload'],
          ),
        ).attachmentIds,
      ).toEqual(['data:image/jpeg;base64,c3ludGhldGljLXJlY2VpcHQ=']);
      expect(
        rows('SELECT * FROM consumer_wallet_split_members ORDER BY group_id,member_order'),
      ).toEqual(expectedWalletSplitMembers);
      expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(expectedCardTransactions);
      expect(rows('PRAGMA foreign_key_check')).toEqual([]);
      sql.exec('DROP TRIGGER fail_wallet_relation_restore');

      await backups.restore(backup.contents, 'synthetic-wallet-roundtrip-passphrase');
      await store.initialisePreferences();
      await wallets.initialise();
      await utilities.initialise();

      expect(rows('SELECT * FROM consumer_wallets ORDER BY id')).toEqual(expectedWallets);
      expect(rows('SELECT * FROM consumer_wallet_events ORDER BY id')).toEqual(expectedEvents);
      expect(rows('SELECT * FROM consumer_wallet_event_allocations ORDER BY id')).toEqual(
        expectedAllocations,
      );
      expect(rows('SELECT * FROM consumer_wallet_return_links ORDER BY return_event_id')).toEqual(
        expectedReturnLinks,
      );
      expect(
        rows(
          'SELECT * FROM consumer_wallet_expense_reversals ORDER BY return_event_id,credit_event_id,funded_load_event_id',
        ),
      ).toEqual(expectedReversals);
      expect(
        rows(
          'SELECT * FROM consumer_wallet_credit_provenance ORDER BY credit_event_id,source_credit_event_id',
        ),
      ).toEqual(expectedCreditProvenance);
      expect(
        rows('SELECT * FROM consumer_wallet_split_members ORDER BY group_id,member_order'),
      ).toEqual(expectedWalletSplitMembers);
      expect(rows('SELECT * FROM transaction_split_groups ORDER BY id')).toEqual(
        expectedSplitGroups,
      );
      expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(expectedCardTransactions);
      expect(rows('PRAGMA foreign_key_check')).toEqual([]);
      expect(wallets.featureState()).toBe('DISABLED');
      expect(wallets.showWalletNavigation()).toBe(true);
      expect(wallets.wallets().find((wallet) => wallet.id === upiLite.id)?.archived).toBe(true);
      expect(store.paymentSources()).toEqual(expectedSources);
      expect(store.paymentSources().find((source) => source.id === fastag.id)).toEqual(fastag);
      expect(rows('SELECT * FROM mobile_recharges ORDER BY id')).toEqual(expectedRecharges);
      expect(utilities.rechargesFor(mobile.id).map((recharge) => recharge.id)).toEqual([
        clonedRecharge.id,
        originalRecharge.id,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retains wallet balance and FIFO attribution after old funding transactions are pruned', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallets = TestBed.inject(ConsumerWalletService);
    await wallets.initialise();
    const wallet = await wallets.registerWallet({ providerId: 'upi-lite' });
    const sourceTransaction = {
      id: 'old-retained-wallet-funding',
      cardId: '',
      type: 'PURCHASE',
      amountMinor: 50000,
      currencyCode: 'INR',
      transactionDate: '2018-01-01',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: '2018-01-01T10:00:00Z',
      updatedAt: '2018-01-01T10:00:00Z',
    };
    await database.run(
      'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        sourceTransaction.id,
        null,
        sourceTransaction.categoryId,
        sourceTransaction.type,
        sourceTransaction.amountMinor,
        sourceTransaction.currencyCode,
        sourceTransaction.transactionDate,
        JSON.stringify(sourceTransaction),
        sourceTransaction.createdAt,
        sourceTransaction.updatedAt,
      ],
    );
    const load = {
      id: 'retained-wallet-load',
      walletId: wallet.id,
      eventType: 'FUNDED_LOAD',
      eventDate: '2018-01-01',
      amountMinor: 50000,
      balanceDeltaMinor: 50000,
      loadedAmountMinor: 50000,
      feeMinor: 0,
      fundingSourceKind: 'BANK',
      fundingSourceId: 'retained-bank-id',
      sourceTransactionId: sourceTransaction.id,
      merchant: 'Private old merchant',
      memo: 'Private old note',
      createdAt: '2018-01-01T10:00:00Z',
      updatedAt: '2018-01-01T10:00:00Z',
    };
    const purchaseEvent = {
      id: 'retained-wallet-purchase',
      walletId: wallet.id,
      eventType: 'PURCHASE',
      eventDate: '2025-01-01',
      amountMinor: 10000,
      balanceDeltaMinor: -10000,
      createdAt: '2025-01-01T10:00:00Z',
      updatedAt: '2025-01-01T10:00:00Z',
    };
    const returnEvent = {
      id: 'retained-upi-return',
      walletId: wallet.id,
      eventType: 'UPI_LITE_RETURN',
      eventDate: '2025-02-01',
      amountMinor: 15000,
      balanceDeltaMinor: -15000,
      returnSourceId: 'any-active-bank-id',
      createdAt: '2025-02-01T10:00:00Z',
      updatedAt: '2025-02-01T10:00:00Z',
    };
    await database.atomic(async (tx) => {
      for (const event of [load, purchaseEvent, returnEvent])
        await tx.run(
          'INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,loaded_amount_minor,fee_minor,funding_source_kind,funding_source_id,source_transaction_id,return_source_id,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            event.id,
            event.walletId,
            event.eventType,
            event.eventDate,
            event.amountMinor,
            event.balanceDeltaMinor,
            'loadedAmountMinor' in event ? event.loadedAmountMinor : null,
            'feeMinor' in event ? event.feeMinor : null,
            'fundingSourceKind' in event ? event.fundingSourceKind : null,
            'fundingSourceId' in event ? event.fundingSourceId : null,
            'sourceTransactionId' in event ? event.sourceTransactionId : null,
            'returnSourceId' in event ? event.returnSourceId : null,
            JSON.stringify(event),
            event.createdAt,
            event.updatedAt,
          ],
        );
      await tx.run(
        'INSERT INTO consumer_wallet_event_allocations(id,debit_event_id,credit_event_id,allocated_minor,expense_reversal_minor,created_at) VALUES(?,?,?,?,?,?)',
        ['retained-purchase-allocation', purchaseEvent.id, load.id, 10000, 0, 'now'],
      );
      await tx.run(
        'INSERT INTO consumer_wallet_event_allocations(id,debit_event_id,credit_event_id,allocated_minor,expense_reversal_minor,created_at) VALUES(?,?,?,?,?,?)',
        ['retained-return-allocation', returnEvent.id, load.id, 15000, 15000, 'now'],
      );
    });
    const balanceBeforeRetention = Number(
      rows('SELECT SUM(balance_delta_minor) AS balance FROM consumer_wallet_events')[0]['balance'],
    );
    expect(balanceBeforeRetention).toBe(25000);

    await database.deleteDataOlderThan('2020-01-01');

    expect(count('card_transactions')).toBe(0);
    expect(
      rows('SELECT source_transaction_id FROM consumer_wallet_events WHERE id=?', [load.id])[0][
        'source_transaction_id'
      ],
    ).toBeNull();
    const retainedPayload = JSON.parse(
      String(
        rows('SELECT payload FROM consumer_wallet_events WHERE id=?', [load.id])[0]['payload'],
      ),
    ) as Record<string, unknown>;
    expect(retainedPayload['merchant']).toBeUndefined();
    expect(retainedPayload['memo']).toBeUndefined();
    expect(count('consumer_wallet_events')).toBe(3);
    expect(count('consumer_wallet_event_allocations')).toBe(2);
    expect(
      rows('SELECT SUM(balance_delta_minor) AS balance FROM consumer_wallet_events')[0]['balance'],
    ).toBe(balanceBeforeRetention);
  });

  it('embeds supported receipt URL schemes into encrypted backups and restores media bytes', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const dataUrl = 'data:image/jpeg;base64,Q2FyZE5lc3Q=';
    const receiptPaths = [
      'file:///synthetic/receipt-image.jpg',
      'content://synthetic.provider/receipt-image.jpg',
      'blob:http://localhost/synthetic-receipt-id',
      dataUrl,
    ];
    const receiptBytes = new Uint8Array([0x43, 0x61, 0x72, 0x64, 0x4e, 0x65, 0x73, 0x74]);
    const transaction = {
      id: 'legacy-file-receipt-transaction',
      cardId: null,
      type: 'PURCHASE',
      amountMinor: 1200,
      currencyCode: 'INR',
      transactionDate: '2026-10-25',
      categoryId: 'other',
      attachmentIds: receiptPaths,
      createdAt: '2026-10-25T10:00:00Z',
      updatedAt: '2026-10-25T10:00:00Z',
    };
    await database.run(
      'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        transaction.id,
        null,
        transaction.categoryId,
        transaction.type,
        transaction.amountMinor,
        transaction.currencyCode,
        transaction.transactionDate,
        JSON.stringify(transaction),
        transaction.createdAt,
        transaction.updatedAt,
      ],
    );
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        expect(receiptPaths.slice(0, 3)).toContain(String(input));
        return new Response(new Uint8Array(receiptBytes), {
          headers: { 'content-type': 'image/jpeg' },
        });
      }),
    );
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-receipt-backup-passphrase');
      await database.run('DELETE FROM card_transactions WHERE id=?', [transaction.id]);
      await backups.restore(backup.contents, 'synthetic-receipt-backup-passphrase');
      await store.initialisePreferences();
      const restored = JSON.parse(
        String(
          rows('SELECT payload FROM card_transactions WHERE id=?', [transaction.id])[0]['payload'],
        ),
      ) as { attachmentIds: string[] };
      expect(restored.attachmentIds).toHaveLength(4);
      expect(
        restored.attachmentIds
          .slice(0, 3)
          .every((item) => item.startsWith('data:image/jpeg;base64,')),
      ).toBe(true);
      expect(restored.attachmentIds[3]).toBe(dataUrl);
      for (const media of restored.attachmentIds.slice(0, 3)) {
        const encoded = media.split(',')[1];
        expect(Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0))).toEqual(receiptBytes);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores an encrypted backup created before optional SMS annotation fields existed', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const legacyCard = {
      id: 'legacy-annotation-card',
      nickname: 'Legacy synthetic card',
      issuerName: 'Fictional Bank',
      lastDigits: '4321',
      network: 'VISA',
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
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
    };
    const legacyTransaction = {
      id: 'legacy-annotation-transaction',
      cardId: legacyCard.id,
      type: 'PURCHASE',
      amountMinor: 12345,
      currencyCode: 'INR',
      transactionDate: '2026-10-02',
      merchant: 'Fictional legacy merchant',
      categoryId: 'other',
      notes: 'Existing legacy note\nApproved SMS discovery',
      attachmentIds: [],
      createdAt: '2026-10-02T10:00:00Z',
      updatedAt: '2026-10-02T10:00:00Z',
    };
    await database.run(
      'INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      [
        legacyCard.id,
        legacyCard.nickname,
        legacyCard.issuerName,
        legacyCard.lastDigits,
        legacyCard.network,
        JSON.stringify(legacyCard),
        legacyCard.createdAt,
        legacyCard.updatedAt,
      ],
    );
    await database.run(
      'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        legacyTransaction.id,
        legacyCard.id,
        'other',
        'PURCHASE',
        legacyTransaction.amountMinor,
        'INR',
        legacyTransaction.transactionDate,
        JSON.stringify(legacyTransaction),
        legacyTransaction.createdAt,
        legacyTransaction.updatedAt,
      ],
    );
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-legacy-passphrase');
      await database.run('DELETE FROM card_transactions');
      await database.run('DELETE FROM credit_cards');
      await backups.restore(backup.contents, 'synthetic-legacy-passphrase');
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      await restarted.initialisePreferences();
      const restored = restarted.transactions()[0];
      expect(restored).toMatchObject(legacyTransaction);
      expect(restored.paymentMethod).toBeUndefined();
      expect(restored.paymentMethodDetail).toBeUndefined();
      expect(restored.paymentMethodCustom).toBeUndefined();
      expect(restored.smsAdditionalComment).toBeUndefined();
      expect(count('card_transactions')).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])(
    'atomically deletes a mobile profile and its recharges (archived=%s) without touching other data',
    async (archived) => {
      await database.initialise();
      const store = TestBed.inject(CardNestStore);
      await store.initialisePreferences();
      const utilities = TestBed.inject(UtilitiesService);
      await utilities.initialise();
      const profile = await utilities.saveMobileProfile({
        personName: 'Deletion target',
        subscriptionType: 'PREPAID',
        operator: 'JIO',
      });
      const other = await utilities.saveMobileProfile({
        personName: 'Keep mobile',
        subscriptionType: 'POSTPAID',
        operator: 'AIRTEL',
      });
      for (const profileId of [profile.id, profile.id, other.id])
        await utilities.saveRecharge({
          profileId,
          planType: 'VOICE_DATA',
          startDate: '2026-10-01',
          validityDays: 30,
        });
      const lpg = await utilities.saveLpgProfile({
        connectionName: 'Keep LPG',
        provider: 'INDANE',
        commercial: false,
        cylinderSize: 'NORMAL',
        estimatedUsageDays: 25,
      });
      await utilities.saveLpgEvent({
        profileId: lpg.id,
        eventType: 'STARTED',
        eventDate: '2026-10-01',
      });
      await store.addBankAccount({
        nickname: 'Keep bank',
        institution: 'Synthetic Bank',
        lastDigits: '007',
      });
      await store.saveManualTransaction({
        id: 'keep-c1-purchase',
        cardId: 'source-cash',
        type: 'PURCHASE',
        amountMinor: 12345,
        currencyCode: 'INR',
        transactionDate: indiaTodayIso(),
        categoryId: 'other',
        attachmentIds: [],
        createdAt: '2026-10-01T12:00:00Z',
        updatedAt: '2026-10-01T12:00:00Z',
      });
      await database.run(
        "INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES('keep-c1-sms','synthetic','2026-10-01','BANK_DEBIT','PENDING','{}','before')",
      );
      const savedRecharges = utilities.rechargesFor(profile.id);
      const financialTables = [
        'credit_cards',
        'card_transactions',
        'sms_candidates',
        'sms_reconciliation',
        'source_transfers',
        'source_balance_adjustments',
        'transaction_split_groups',
        'transaction_split_members',
        'loan_commitments',
        'emi_plans',
        'emi_installments',
        'recurring_rules',
        'bank_activity_profiles',
        'bank_activity_events',
      ];
      const financialState = () =>
        financialTables.map((table) => rows(`SELECT * FROM ${table} ORDER BY rowid`));
      const unchanged = financialState();
      const restoredFinancialState = unchanged.map((records, index) =>
        financialTables[index] === 'sms_candidates'
          ? records.map((record) => ({ ...record, payload: null }))
          : records,
      );
      const sources = rows("SELECT * FROM app_preferences WHERE key='payment_sources'");
      await utilities.setMobileArchived(profile.id, true);
      await utilities.setMobileArchived(profile.id, false);
      expect(utilities.rechargesFor(profile.id)).toHaveLength(2);
      if (archived) await utilities.setMobileArchived(profile.id, true);
      const beforeProfiles = utilities.mobileProfiles();
      const beforeRecharges = utilities.mobileRecharges();
      sql.exec(
        "CREATE TRIGGER fail_mobile_delete BEFORE DELETE ON utility_profiles WHEN OLD.kind='MOBILE' BEGIN SELECT RAISE(ABORT,'mobile delete rollback'); END",
      );
      await expect(utilities.deleteMobileProfile(profile.id)).rejects.toThrow(
        'mobile delete rollback',
      );
      expect(utilities.mobileProfiles()).toBe(beforeProfiles);
      expect(utilities.mobileRecharges()).toBe(beforeRecharges);
      expect(count('mobile_recharges')).toBe(3);
      expect(count('utility_profiles')).toBe(3);
      sql.exec('DROP TRIGGER fail_mobile_delete');
      await expect(utilities.deleteMobileProfile(lpg.id)).rejects.toThrow(
        'Mobile profile not found',
      );

      vi.stubGlobal('crypto', webcrypto);
      vi.stubGlobal('Blob', NodeBlob);
      try {
        const backups = TestBed.inject(BackupService);
        const before = await backups.create('synthetic-mobile-deletion-passphrase');
        const refresh = vi
          .spyOn(utilities, 'reload')
          .mockRejectedValue(new Error('Post-commit refresh unavailable'));
        const atomic = database.atomic.bind(database);
        const publishedBeforeCommit: boolean[] = [];
        const transaction = vi.spyOn(database, 'atomic').mockImplementation((work) =>
          atomic(async (tx) => {
            const result = await work(tx);
            publishedBeforeCommit.push(
              utilities.mobileProfiles().some((row) => row.id === profile.id),
            );
            return result;
          }),
        );
        await utilities.deleteMobileProfile(profile.id);
        expect(publishedBeforeCommit).toEqual([true]);
        transaction.mockRestore();
        expect(refresh).not.toHaveBeenCalled();
        refresh.mockRestore();
        expect(utilities.mobileProfiles().map((row) => row.id)).toEqual([other.id]);
        expect(utilities.rechargesFor(profile.id)).toEqual([]);
        expect(utilities.rechargesFor(other.id)).toHaveLength(1);
        expect(count('lpg_events')).toBe(1);
        expect(financialState()).toEqual(unchanged);
        expect(rows("SELECT * FROM app_preferences WHERE key='payment_sources'")).toEqual(sources);
        const after = await backups.create('synthetic-mobile-deletion-passphrase');
        const restarted = TestBed.runInInjectionContext(() => new UtilitiesService());
        await restarted.initialise();
        expect(restarted.mobileProfiles().map((row) => row.id)).toEqual([other.id]);
        await backups.restore(before.contents, 'synthetic-mobile-deletion-passphrase');
        await restarted.initialise();
        expect(restarted.rechargesFor(profile.id)).toHaveLength(2);
        expect(restarted.rechargesFor(profile.id)).toEqual(
          expect.arrayContaining([...savedRecharges]),
        );
        expect(restarted.mobileProfiles().find((row) => row.id === profile.id)?.archived).toBe(
          archived,
        );
        expect(financialState()).toEqual(restoredFinancialState);
        await backups.restore(after.contents, 'synthetic-mobile-deletion-passphrase');
        await restarted.initialise();
        expect(restarted.mobileProfiles().map((row) => row.id)).toEqual([other.id]);
        expect(restarted.rechargesFor(other.id)).toHaveLength(1);
        expect(restarted.lpgEvents()).toHaveLength(1);
        expect(financialState()).toEqual(restoredFinancialState);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('deletes only an individually selected recharge and retains its sibling and profile after restart', async () => {
    await database.initialise();
    const utilities = TestBed.inject(UtilitiesService);
    await utilities.initialise();
    const profile = await utilities.saveMobileProfile({
      personName: 'Keep history',
      operator: 'JIO',
      subscriptionType: 'PREPAID',
    });
    const first = await utilities.saveRecharge({
      profileId: profile.id,
      planType: 'VOICE_ONLY',
      startDate: '2026-09-01',
      validityDays: 30,
    });
    const second = await utilities.saveRecharge({
      profileId: profile.id,
      planType: 'DATA_ONLY',
      startDate: '2026-10-01',
      validityDays: 30,
      comment: 'Retain sibling',
    });
    await utilities.deleteRecharge(first.id);
    const restarted = TestBed.runInInjectionContext(() => new UtilitiesService());
    await restarted.initialise();
    expect(restarted.rechargesFor(profile.id)).toEqual([second]);
    expect(restarted.mobileProfiles().map((row) => row.id)).toEqual([profile.id]);
    await utilities.deleteMobileProfile(profile.id);
    const empty = await utilities.saveMobileProfile({
      personName: 'No recharge history',
      operator: 'VI',
      subscriptionType: 'POSTPAID',
    });
    await utilities.deleteMobileProfile(empty.id);
    expect(count('utility_profiles')).toBe(0);
  });

  it('serializes LPG progression and rejects duplicate, backdated, edited and deleted-event conflicts', async () => {
    await database.initialise();
    const utilities = TestBed.inject(UtilitiesService);
    await utilities.initialise();
    const profile = await utilities.saveLpgProfile({
      connectionName: 'Lifecycle connection',
      provider: 'INDANE',
      commercial: false,
      cylinderSize: 'NORMAL',
      estimatedUsageDays: 25,
    });
    const save = (eventType: 'STARTED' | 'EMPTY' | 'REFILL_RECEIVED', eventDate = '2026-10-02') =>
      utilities.saveLpgEvent({ profileId: profile.id, eventType, eventDate });
    await expect(save('EMPTY')).rejects.toThrow('preceding cylinder STARTED');
    const concurrent = await Promise.allSettled([save('STARTED'), save('STARTED')]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const started = utilities.eventsFor(profile.id)[0];
    await expect(save('REFILL_RECEIVED')).rejects.toThrow('in use');
    const empty = await save('EMPTY');
    await expect(save('EMPTY')).rejects.toThrow('preceding cylinder STARTED');
    const received = await save('REFILL_RECEIVED');
    await expect(save('REFILL_RECEIVED')).rejects.toThrow('already recorded');
    expect(utilities.eventsFor(profile.id)).toHaveLength(3);
    await save('STARTED', '2026-10-03');
    const snapshot = rows('SELECT * FROM lpg_events ORDER BY rowid');
    await expect(save('STARTED', '2026-10-01')).rejects.toThrow('2026-10-02');
    await expect(utilities.saveLpgEvent({ ...started, eventDate: '2026-10-04' })).rejects.toThrow();
    await expect(utilities.deleteLpgEvent(started.id)).rejects.toThrow('EMPTY requires');
    await expect(utilities.deleteLpgEvent(empty.id)).rejects.toThrow();
    await expect(
      utilities.saveLpgEvent({
        profileId: profile.id,
        eventType: 'UNKNOWN' as 'STARTED',
        eventDate: '2026-10-04',
      }),
    ).rejects.toThrow('Choose a cylinder event');
    await expect(
      utilities.saveLpgEvent({
        profileId: profile.id,
        eventType: 'EMPTY',
        cylinderSize: 'UNKNOWN' as 'NORMAL',
        eventDate: '2026-10-04',
      }),
    ).rejects.toThrow('supported cylinder size');
    expect(rows('SELECT * FROM lpg_events ORDER BY rowid')).toEqual(snapshot);
    const edited = await utilities.saveLpgEvent({
      ...received,
      comment: 'Receipt correction',
      amountMinor: 95000,
    });
    expect(edited.id).toBe(received.id);
    expect(edited.createdAt).toBe(received.createdAt);
    sql.exec(
      "CREATE TRIGGER fail_lpg_event BEFORE INSERT ON lpg_events BEGIN SELECT RAISE(ABORT,'event write rollback'); END",
    );
    const signals = utilities.lpgEvents();
    await expect(save('EMPTY', '2026-10-04')).rejects.toThrow('event write rollback');
    expect(utilities.lpgEvents()).toBe(signals);
    expect(count('lpg_events')).toBe(4);
    sql.exec('DROP TRIGGER fail_lpg_event');
    await utilities.reload();
    expect(utilities.eventsFor(profile.id).map((event) => event.eventType)).toEqual([
      'STARTED',
      'EMPTY',
      'REFILL_RECEIVED',
      'STARTED',
    ]);
    await save('EMPTY', '2026-10-04');
    await save('STARTED', '2026-10-05');
    sql.exec(
      "CREATE TRIGGER fail_lpg_event_delete BEFORE DELETE ON lpg_events BEGIN SELECT RAISE(ABORT,'event delete rollback'); END",
    );
    const beforeDelete = utilities.lpgEvents();
    await expect(utilities.deleteLpgEvent(received.id)).rejects.toThrow('event delete rollback');
    expect(utilities.lpgEvents()).toBe(beforeDelete);
    expect(count('lpg_events')).toBe(6);
    sql.exec('DROP TRIGGER fail_lpg_event_delete');
    await utilities.deleteLpgEvent(received.id);
    expect(utilities.eventsFor(profile.id)).toHaveLength(5);
  });

  it('retains row order for same-day LPG events with identical creation timestamps after restart', async () => {
    await database.initialise();
    const utilities = TestBed.inject(UtilitiesService);
    await utilities.initialise();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    try {
      const profile = await utilities.saveLpgProfile({
        connectionName: 'Same-day connection',
        provider: 'INDANE',
        commercial: false,
        cylinderSize: 'NORMAL',
        estimatedUsageDays: 25,
      });
      for (const eventType of ['STARTED', 'EMPTY', 'REFILL_RECEIVED', 'STARTED'] as const)
        await utilities.saveLpgEvent({ profileId: profile.id, eventType, eventDate: '2026-10-10' });
      expect(new Set(utilities.eventsFor(profile.id).map((event) => event.createdAt)).size).toBe(1);
      await utilities.saveLpgEvent({
        ...utilities.eventsFor(profile.id)[1],
        comment: 'Same-day correction',
      });
      const restarted = TestBed.runInInjectionContext(() => new UtilitiesService());
      await restarted.initialise();
      expect(restarted.eventsFor(profile.id).map((event) => event.eventType)).toEqual([
        'STARTED',
        'EMPTY',
        'REFILL_RECEIVED',
        'STARTED',
      ]);
      await restarted.saveLpgEvent({
        profileId: profile.id,
        eventType: 'EMPTY',
        eventDate: '2026-10-10',
      });
      expect(restarted.eventsFor(profile.id)).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves legacy LPG conflicts and permits safe explicit corrections without rewriting later records', async () => {
    await database.initialise();
    const utilities = TestBed.inject(UtilitiesService);
    await utilities.initialise();
    const profile = await utilities.saveLpgProfile({
      connectionName: 'Legacy connection',
      provider: 'HPCL',
      commercial: true,
      cylinderSize: 'SMALL',
      estimatedUsageDays: 25,
    });
    const legacy = {
      id: 'legacy-empty',
      profileId: profile.id,
      eventType: 'EMPTY' as const,
      eventDate: '2026-10-01',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: 'before',
    };
    await database.run(
      'INSERT INTO lpg_events(id,profile_id,event_type,event_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      [
        legacy.id,
        profile.id,
        legacy.eventType,
        legacy.eventDate,
        JSON.stringify(legacy),
        legacy.createdAt,
        legacy.updatedAt,
      ],
    );
    await utilities.reload();
    expect(utilities.eventsFor(profile.id)).toEqual([legacy]);
    await utilities.saveLpgEvent({ ...legacy, comment: 'Explicit historical note' });
    const started = await utilities.saveLpgEvent({
      profileId: profile.id,
      eventType: 'STARTED',
      eventDate: '2026-10-02',
    });
    await expect(utilities.saveLpgEvent({ ...legacy, eventType: 'STARTED' })).rejects.toThrow(
      '2026-10-02',
    );
    await utilities.deleteLpgEvent(legacy.id);
    expect(utilities.eventsFor(profile.id)).toEqual([started]);
  });

  it.each([false, true])(
    'atomically deletes only the selected LPG connection and round trips backups (archived=%s)',
    async (archived) => {
      await database.initialise();
      const store = TestBed.inject(CardNestStore);
      await store.initialisePreferences();
      const utilities = TestBed.inject(UtilitiesService);
      await utilities.initialise();
      const connection = await utilities.saveLpgProfile({
        connectionName: 'Delete LPG',
        provider: 'INDANE',
        commercial: true,
        cylinderSize: 'NORMAL',
        estimatedUsageDays: 25,
      });
      const other = await utilities.saveLpgProfile({
        connectionName: 'Keep LPG',
        provider: 'HPCL',
        commercial: false,
        cylinderSize: 'SMALL',
        estimatedUsageDays: 25,
      });
      for (const profileId of [connection.id, other.id]) {
        await utilities.saveLpgEvent({ profileId, eventType: 'STARTED', eventDate: '2026-10-01' });
        await utilities.saveLpgEvent({ profileId, eventType: 'EMPTY', eventDate: '2026-10-20' });
      }
      const mobile = await utilities.saveMobileProfile({
        personName: 'Keep mobile',
        operator: 'JIO',
        subscriptionType: 'PREPAID',
      });
      await utilities.saveRecharge({
        profileId: mobile.id,
        planType: 'VOICE_DATA',
        startDate: '2026-10-01',
        validityDays: 30,
      });
      await store.addBankAccount({
        nickname: 'Keep bank',
        institution: 'Synthetic Bank',
        lastDigits: '007',
      });
      await store.saveManualTransaction({
        id: 'keep-c2-purchase',
        cardId: 'source-cash',
        type: 'PURCHASE',
        amountMinor: 12345,
        currencyCode: 'INR',
        transactionDate: indiaTodayIso(),
        categoryId: 'other',
        attachmentIds: [],
        createdAt: '2026-10-01T12:00:00Z',
        updatedAt: '2026-10-01T12:00:00Z',
      });
      await database.run(
        "INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES('keep-c2-sms','synthetic','2026-10-01','BANK_DEBIT','PENDING',NULL,'before')",
      );
      const tables = [
        'credit_cards',
        'card_transactions',
        'sms_candidates',
        'sms_reconciliation',
        'source_transfers',
        'source_balance_adjustments',
        'transaction_split_groups',
        'transaction_split_members',
        'loan_commitments',
        'emi_plans',
        'emi_installments',
        'recurring_rules',
        'bank_activity_profiles',
        'bank_activity_events',
        'mobile_recharges',
      ];
      const untouched = () => tables.map((table) => rows(`SELECT * FROM ${table} ORDER BY rowid`));
      const before = untouched();
      const sources = rows("SELECT * FROM app_preferences WHERE key='payment_sources'");
      await utilities.setLpgArchived(connection.id, true);
      await utilities.setLpgArchived(connection.id, false);
      if (archived) await utilities.setLpgArchived(connection.id, true);
      const profiles = utilities.lpgProfiles();
      const events = utilities.lpgEvents();
      sql.exec(
        "CREATE TRIGGER fail_lpg_delete BEFORE DELETE ON utility_profiles WHEN OLD.kind='LPG' BEGIN SELECT RAISE(ABORT,'connection delete rollback'); END",
      );
      await expect(utilities.deleteLpgProfile(connection.id)).rejects.toThrow(
        'connection delete rollback',
      );
      expect(utilities.lpgProfiles()).toBe(profiles);
      expect(utilities.lpgEvents()).toBe(events);
      expect(count('lpg_events')).toBe(4);
      sql.exec('DROP TRIGGER fail_lpg_delete');
      await expect(utilities.deleteLpgProfile(mobile.id)).rejects.toThrow(
        'LPG connection not found',
      );
      vi.stubGlobal('crypto', webcrypto);
      vi.stubGlobal('Blob', NodeBlob);
      try {
        const backups = TestBed.inject(BackupService);
        const prior = await backups.create('synthetic-lpg-deletion-passphrase');
        const atomic = database.atomic.bind(database);
        const published: boolean[] = [];
        const transaction = vi.spyOn(database, 'atomic').mockImplementation((work) =>
          atomic(async (tx) => {
            const result = await work(tx);
            published.push(utilities.lpgProfiles().some((row) => row.id === connection.id));
            return result;
          }),
        );
        await utilities.deleteLpgProfile(connection.id);
        transaction.mockRestore();
        expect(published).toEqual([true]);
        expect(utilities.lpgProfiles().map((row) => row.id)).toEqual([other.id]);
        expect(utilities.eventsFor(other.id)).toHaveLength(2);
        expect(untouched()).toEqual(before);
        expect(rows("SELECT * FROM app_preferences WHERE key='payment_sources'")).toEqual(sources);
        const after = await backups.create('synthetic-lpg-deletion-passphrase');
        const restarted = TestBed.runInInjectionContext(() => new UtilitiesService());
        await restarted.initialise();
        expect(restarted.eventsFor(connection.id)).toEqual([]);
        await backups.restore(prior.contents, 'synthetic-lpg-deletion-passphrase');
        await restarted.initialise();
        expect(restarted.eventsFor(connection.id)).toHaveLength(2);
        expect(restarted.lpgProfiles().find((row) => row.id === connection.id)?.archived).toBe(
          archived,
        );
        await backups.restore(after.contents, 'synthetic-lpg-deletion-passphrase');
        await restarted.initialise();
        expect(restarted.lpgProfiles().map((row) => row.id)).toEqual([other.id]);
        expect(restarted.eventsFor(other.id)).toHaveLength(2);
        expect(restarted.rechargesFor(mobile.id)).toHaveLength(1);
        expect(untouched()).toEqual(before);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('persists Utilities and Bank Activity through reload and encrypted backup while keeping finance isolated', async () => {
    const today = indiaTodayIso();
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const utilities = TestBed.inject(UtilitiesService);
    const bankActivity = TestBed.inject(BankActivityService);
    await Promise.all([utilities.initialise(), bankActivity.initialise()]);
    expect(utilities.settings()).toEqual({ showIndianUtilities: true, utilityReminders: false });
    expect(store.bankCashTracking().enabled).toBe(false);

    const mobile = await utilities.saveMobileProfile({
      personName: 'Fictional Sam',
      subscriptionType: 'PREPAID',
      operator: 'JIO',
      mobileNumber: '+91 98765 43210',
    });
    expect(mobile.mobileNumber).toBe('+91-9876543210');
    const queuedVoice = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'VOICE_ONLY',
      amountMinor: 19900,
      startDate: today,
      validityDays: 3,
      comment: 'Synthetic queued voice plan',
    });
    const queuedData = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'DATA_ONLY',
      startDate: today,
      validityDays: 2,
    });
    expect(queuedVoice.endDate).toBe(addCalendarDays(today, 2));
    expect(queuedData.planType).toBe('DATA_ONLY');

    const lpg = await utilities.saveLpgProfile({
      connectionName: 'Fictional kitchen',
      provider: 'INDANE',
      commercial: false,
      cylinderSize: 'NORMAL',
      estimatedUsageDays: 25,
    });
    await utilities.saveLpgEvent({
      profileId: lpg.id,
      eventType: 'STARTED',
      eventDate: '2026-08-01',
    });
    await utilities.saveLpgEvent({
      profileId: lpg.id,
      eventType: 'EMPTY',
      eventDate: '2026-08-25',
    });
    await utilities.saveLpgEvent({
      profileId: lpg.id,
      eventType: 'REFILL_RECEIVED',
      eventDate: '2026-08-27',
      amountMinor: 95000,
      cylinderSize: 'NORMAL',
    });
    const currentLpg = await utilities.saveLpgProfile({
      connectionName: 'Fictional active cylinder',
      provider: 'HPCL',
      commercial: false,
      cylinderSize: 'SMALL',
      estimatedUsageDays: 25,
    });
    await utilities.saveLpgEvent({
      profileId: currentLpg.id,
      eventType: 'STARTED',
      eventDate: addCalendarDays(today, -24),
    });

    const linkedBank = await store.addBankAccount({
      nickname: 'Fiction activity bank',
      institution: 'ICICI Bank',
      accountIdentifier: '000000000417',
      ifscCode: 'ICIC0000417',
    });
    expect(linkedBank.accountFingerprint).toMatch(/^hmac-sha256-v1:[0-9a-f]{64}$/);
    const bankProfile = await bankActivity.saveProfile({
      paymentSourceId: linkedBank.id,
      bankName: '',
      owner: 'OWN',
      nickname: 'Household account',
    });
    const manualEvent = await bankActivity.saveManualEvent({
      profileId: bankProfile.id,
      activityDate: '2026-04-24',
      direction: 'CREDIT',
      reference: 'SYNTHREF123',
    });
    expect(manualEvent.verification).toBe('USER_CONFIRMED');
    const temporaryEvent = await bankActivity.saveManualEvent({
      profileId: bankProfile.id,
      activityDate: '2026-04-20',
      direction: 'DEBIT',
    });
    const correctedEvent = await bankActivity.saveManualEvent({
      id: temporaryEvent.id,
      profileId: bankProfile.id,
      activityDate: '2026-04-21',
      direction: 'DEBIT',
    });
    expect(correctedEvent.origin).toBe('MANUAL');
    expect(correctedEvent.createdAt).toBe(temporaryEvent.createdAt);
    await bankActivity.deleteEvent(correctedEvent.id);
    const nativePlatform = vi.spyOn(Capacitor, 'isNativePlatform');
    nativePlatform.mockReturnValue(false);
    expect(
      await bankActivity.ingestAndroidSms({
        fingerprint: 'c'.repeat(64),
        activityDate: today,
        kind: 'BANK_DEBIT',
        direction: 'DEBIT',
        purposeHint: 'PURCHASE',
        accountDigits: '417',
        issuer: 'ICICI',
      }),
    ).toBe(false);
    nativePlatform.mockReturnValue(true);
    expect(store.bankCashTracking().enabled).toBe(false);
    expect(
      store.paymentSources().find((item) => item.id === linkedBank.id)?.balanceMinor,
    ).toBeUndefined();

    const smsEvidence = {
      fingerprint: 'a'.repeat(64),
      activityDate: today,
      kind: 'BANK_DEBIT',
      direction: 'DEBIT' as const,
      purposeHint: 'PURCHASE',
      accountDigits: '417',
      issuer: 'ICICI',
      reference: 'SYNTHRRN123',
      merchant: 'Fictional market',
    };
    expect(
      await bankActivity.ingestAndroidSms({
        ...smsEvidence,
        fingerprint: 'd'.repeat(64),
        purposeHint: 'INCOMING',
        direction: 'CREDIT',
        merchant: 'Monthly interest credit',
      }),
    ).toBe(false);
    expect(await bankActivity.ingestAndroidSms(smsEvidence)).toBe(false);
    expect(bankActivity.eventsFor(bankProfile.id)).toHaveLength(1);
    await bankActivity.approveCandidate(smsEvidence.fingerprint, bankProfile.id);
    expect(await bankActivity.ingestAndroidSms(smsEvidence)).toBe(false);
    expect(bankActivity.eventsFor(bankProfile.id)).toHaveLength(2);
    expect(count('card_transactions')).toBe(0);
    expect(count('source_transfers')).toBe(0);

    const ambiguousProfile = await bankActivity.saveProfile({
      bankName: 'ICICI Bank',
      accountSuffix: '417',
      owner: 'OTHERS',
      holderName: 'Fictional Alex',
      allowIdentityConflict: true,
    });
    expect(
      await bankActivity.ingestAndroidSms({ ...smsEvidence, fingerprint: 'b'.repeat(64) }),
    ).toBe(false);
    expect(bankActivity.candidates()).toMatchObject([
      {
        fingerprint: 'b'.repeat(64),
        activityDate: today,
        bankName: 'ICICI Bank',
        accountSuffix: '417',
      },
    ]);
    await bankActivity.approveCandidate('b'.repeat(64), ambiguousProfile.id);
    expect(bankActivity.eventsFor(ambiguousProfile.id)).toMatchObject([
      { origin: 'ANDROID_SMS', verification: 'USER_CONFIRMED', fingerprint: 'b'.repeat(64) },
    ]);
    expect(
      await bankActivity.ingestAndroidSms({
        ...smsEvidence,
        fingerprint: 'e'.repeat(64),
        issuer: undefined,
      }),
    ).toBe(false);
    expect(bankActivity.candidates()).toHaveLength(1);

    const dismissedFingerprint = 'f'.repeat(64);
    expect(
      await bankActivity.ingestAndroidSms({ ...smsEvidence, fingerprint: dismissedFingerprint }),
    ).toBe(false);
    await bankActivity.dismissCandidate(dismissedFingerprint);
    expect(
      bankActivity.candidates().some((item) => item.fingerprint === dismissedFingerprint),
    ).toBe(false);
    expect(
      await bankActivity.ingestAndroidSms({ ...smsEvidence, fingerprint: dismissedFingerprint }),
    ).toBe(false);

    await utilities.setUtilityReminders(true);
    expect(
      utilities
        .reminderTargets(today)
        .map((target) => target.kind)
        .sort(),
    ).toEqual(['LPG_ESTIMATE', 'MOBILE_PLAN', 'MOBILE_PLAN', 'MOBILE_VOICE', 'MOBILE_VOICE']);
    await utilities.setShowIndianUtilities(false);
    expect(utilities.reminderTargets(today)).toEqual([]);
    expect(utilities.mobileProfiles()).toHaveLength(1);
    await utilities.setShowIndianUtilities(true);
    expect(utilities.utilityReminders()).toBe(true);
    await database.run(
      'INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES(?,?,?,?,?,?,?)',
      [
        'synthetic-raw-exclusion',
        'synthetic-provider',
        today,
        'BANK_DEBIT',
        'PENDING',
        JSON.stringify({ body: 'SYNTHETIC_RAW_SMS_MUST_NOT_BE_BACKED_UP' }),
        new Date().toISOString(),
      ],
    );

    await database.run(
      'INSERT INTO app_preferences(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value',
      [
        SMS_REVIEW_FILTERS_KEY,
        JSON.stringify({ ...defaultReviewFilters(), sortOrder: 'TRANSACTION_DESC' }),
      ],
    );
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const fullBackup = await backups.create('synthetic-utilities-passphrase');
      const plaintext = await database.exportBackupJson();
      expect(plaintext).not.toContain('SYNTHETIC_RAW_SMS_MUST_NOT_BE_BACKED_UP');
      await database.run('DELETE FROM bank_activity_events');
      await database.run('DELETE FROM bank_activity_profiles');
      await database.run('DELETE FROM lpg_events');
      await database.run('DELETE FROM mobile_recharges');
      await database.run('DELETE FROM utility_profiles');
      await database.run('DELETE FROM app_preferences WHERE key IN (?,?)', [
        SHOW_INDIAN_UTILITIES_KEY,
        UTILITY_REMINDERS_KEY,
      ]);
      await backups.restore(fullBackup.contents, 'synthetic-utilities-passphrase');
      const restoredUtilities = TestBed.runInInjectionContext(() => new UtilitiesService());
      const restoredBankActivity = TestBed.runInInjectionContext(() => new BankActivityService());
      const restoredStore = TestBed.runInInjectionContext(() => new CardNestStore());
      await Promise.all([
        restoredStore.initialisePreferences(),
        restoredUtilities.initialise(),
        restoredBankActivity.initialise(),
      ]);
      const [restoredReviewPreference] = await database.query<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM app_preferences WHERE key=?',
        [SMS_REVIEW_FILTERS_KEY],
      );
      expect(reviewFilters(JSON.parse(restoredReviewPreference.encrypted_value)).sortOrder).toBe(
        'TRANSACTION_DESC',
      );
      expect(restoredUtilities.settings()).toEqual({
        showIndianUtilities: true,
        utilityReminders: true,
      });
      expect(restoredUtilities.mobileProfiles()).toEqual([mobile]);
      expect(
        restoredUtilities
          .mobileRecharges()
          .map((item) => item.id)
          .sort(),
      ).toEqual([queuedVoice.id, queuedData.id].sort());
      expect(
        restoredUtilities
          .lpgProfiles()
          .map((item) => item.id)
          .sort(),
      ).toEqual([lpg.id, currentLpg.id].sort());
      expect(restoredUtilities.lpgEvents()).toHaveLength(4);
      expect(
        restoredBankActivity
          .profiles()
          .map((item) => item.id)
          .sort(),
      ).toEqual([bankProfile.id, ambiguousProfile.id].sort());
      expect(restoredBankActivity.eventsFor(bankProfile.id)).toHaveLength(2);
      expect(restoredStore.paymentSources().find((row) => row.id === linkedBank.id)).toMatchObject({
        lastDigits: '417',
        accountFingerprint: linkedBank.accountFingerprint,
        ifscCode: 'ICIC0000417',
      });
      expect(await restoredStore.fingerprintBankAccount('000000000417')).toBe(
        linkedBank.accountFingerprint,
      );
      await expect(
        restoredStore.addBankAccount({
          institution: 'ICICI',
          accountIdentifier: '000000000417',
        }),
      ).rejects.toThrow('already enrolled');
      expect(
        restoredBankActivity.profiles().find((row) => row.id === bankProfile.id),
      ).toMatchObject({
        paymentSourceId: linkedBank.id,
        accountFingerprint: linkedBank.accountFingerprint,
        ifscCode: 'ICIC0000417',
      });
      expect(await database.exportBackupJson()).not.toContain('000000000417');
      expect(
        restoredBankActivity.eventsFor(bankProfile.id).some((item) => item.origin === 'MANUAL'),
      ).toBe(true);
      expect(
        restoredBankActivity
          .eventsFor(bankProfile.id)
          .some((item) => item.origin === 'ANDROID_SMS'),
      ).toBe(true);
      expect(restoredBankActivity.eventsFor(ambiguousProfile.id)).toMatchObject([
        { origin: 'ANDROID_SMS', verification: 'USER_CONFIRMED', fingerprint: 'b'.repeat(64) },
      ]);
      expect(restoredBankActivity.candidates()).toMatchObject([
        { fingerprint: 'e'.repeat(64), activityDate: today, accountSuffix: '417' },
      ]);
      const [dismissedCandidate] = await database.query<{ payload: string }>(
        'SELECT payload FROM bank_activity_candidates WHERE fingerprint=?',
        [dismissedFingerprint],
      );
      expect(JSON.parse(dismissedCandidate.payload)).toMatchObject({ dismissed: true });
      expect(restoredStore.bankCashTracking().enabled).toBe(false);
      expect(count('card_transactions')).toBe(0);
      expect(count('source_transfers')).toBe(0);

      const oldPortable = JSON.parse(await database.exportBackupJson()) as {
        databaseVersion: number;
        tables: { name: string; rows: Record<string, unknown>[] }[];
      };
      oldPortable.databaseVersion = 9;
      oldPortable.tables = oldPortable.tables
        .filter(
          (table) =>
            ![
              'utility_profiles',
              'mobile_recharges',
              'lpg_events',
              'bank_activity_profiles',
              'bank_activity_events',
              'bank_activity_candidates',
            ].includes(table.name),
        )
        .map((table) =>
          table.name === 'app_preferences'
            ? {
                ...table,
                rows: table.rows.filter(
                  (row) =>
                    ![SHOW_INDIAN_UTILITIES_KEY, UTILITY_REMINDERS_KEY].includes(
                      String(row['key']),
                    ) && String(row['key']) !== SMS_REVIEW_FILTERS_KEY,
                ),
              }
            : table,
        );
      const exportSpy = vi
        .spyOn(database, 'exportBackupJson')
        .mockResolvedValue(JSON.stringify(oldPortable));
      const oldBackup = await backups.create('synthetic-old-utilities-passphrase');
      exportSpy.mockRestore();
      await backups.restore(oldBackup.contents, 'synthetic-old-utilities-passphrase');
      const [oldReviewPreference] = await database.query<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM app_preferences WHERE key=?',
        [SMS_REVIEW_FILTERS_KEY],
      );
      expect(oldReviewPreference).toBeUndefined();
      expect(reviewFilters(undefined).sortOrder).toBe('RECEIVED_DESC');
      const oldUtilities = TestBed.runInInjectionContext(() => new UtilitiesService());
      await oldUtilities.initialise();
      expect(oldUtilities.settings()).toEqual({
        showIndianUtilities: true,
        utilityReminders: false,
      });
      expect(oldUtilities.mobileProfiles()).toEqual([]);
      expect(oldUtilities.lpgProfiles()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('deducts 15 actual meal purchases exactly once, preserves legacy snapshots and does not manufacture a fresh cutover', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const meal = store.paymentSources().find((source) => source.kind === 'MEAL')!;
    expect(meal.balanceCutoverAt).toBeUndefined();
    const initialPurchase = {
      id: 'synthetic-fresh-purchase',
      cardId: meal.id,
      type: 'PURCHASE' as const,
      amountMinor: 100,
      currencyCode: 'INR',
      transactionDate: '2026-10-22',
      categoryId: 'dining',
      attachmentIds: [],
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
    };
    store.addTransaction(initialPurchase);
    await database.atomic(async () => undefined);
    await store.initialisePreferences();
    expect(store.paymentSources().find((source) => source.id === meal.id)?.balanceMinor).toBe(-100);
    store.deleteTransaction(initialPurchase.id);
    await database.atomic(async () => undefined);
    const initialBalance = 1097632;
    const wallets = store
      .paymentSources()
      .map((source) =>
        source.id === meal.id
          ? { ...source, balanceMinor: initialBalance, autoLoad: true }
          : source,
      );
    await database.run('INSERT OR REPLACE INTO app_preferences VALUES(?,?)', [
      'payment_sources',
      JSON.stringify(wallets),
    ]);
    await store.initialisePreferences();
    expect(store.paymentSources().find((source) => source.id === meal.id)).toMatchObject({
      autoLoad: false,
      balanceMinor: initialBalance,
    });
    expect(
      store.paymentSources().find((source) => source.id === meal.id)?.balanceCutoverAt,
    ).toBeUndefined();
    const amounts = [...Array.from({ length: 14 }, () => 60000), 163908];
    for (const [index, amountMinor] of amounts.entries())
      store.addTransaction({
        id: `synthetic-meal-purchase-${index}`,
        cardId: meal.id,
        type: 'PURCHASE',
        amountMinor,
        currencyCode: 'INR',
        transactionDate: '2026-10-22',
        transactionTime: `${String(index + 1).padStart(2, '0')}:00:00`,
        categoryId: 'dining',
        merchant: 'Fictional dining',
        attachmentIds: [],
        createdAt: '2026-10-22T00:00:00Z',
        updatedAt: '2026-10-22T00:00:00Z',
      });
    await database.atomic(async () => undefined);
    expect(store.transactions().reduce((sum, entry) => sum + entry.amountMinor, 0)).toBe(1003908);
    expect(store.paymentSources().find((source) => source.id === meal.id)?.balanceMinor).toBe(
      93724,
    );
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(restarted.transactions()).toHaveLength(15);
    expect(restarted.paymentSources().find((source) => source.id === meal.id)?.balanceMinor).toBe(
      93724,
    );
    expect(
      restarted.paymentSources().find((source) => source.id === meal.id)?.balanceCutoverAt,
    ).toBeUndefined();
    const snapshot = '2026-10-23T00:00:00Z';
    await database.run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
      JSON.stringify(
        restarted.paymentSources().map((source) =>
          source.id === meal.id
            ? {
                ...source,
                autoLoad: true,
                balanceCutoverAt: snapshot,
                balanceSnapshotMinor: 93724,
              }
            : source,
        ),
      ),
    ]);
    await restarted.initialisePreferences();
    expect(restarted.paymentSources().find((source) => source.id === meal.id)).toMatchObject({
      autoLoad: false,
      balanceMinor: 93724,
      balanceCutoverAt: snapshot,
      balanceSnapshotMinor: 93724,
    });
    expect(count('card_transactions')).toBe(15);
  });
  it('persists the Pluxee baseline repair, later purchases, edits, concurrent preferences and encrypted restore without replay', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallet = store.paymentSources().find((source) => source.kind === 'MEAL')!;
    await database.run('INSERT INTO categories(id,name,icon,applies_to) VALUES(?,?,?,?)', [
      'synthetic-kids',
      'Synthetic Kids',
      'category',
      'BOTH',
    ]);
    await database.run('INSERT OR REPLACE INTO app_preferences VALUES(?,?)', [
      'payment_sources',
      JSON.stringify(
        store.paymentSources().map((source) =>
          source.id === wallet.id
            ? {
                ...source,
                balanceMinor: 333124,
                balanceCutoverAt: '2026-10-23T12:15:00Z',
                balanceSnapshotMinor: 333124,
              }
            : source,
        ),
      ),
    ]);
    await store.initialisePreferences();
    const otherSources = store.paymentSources().filter((source) => source.id !== wallet.id);
    for (const [index, amountMinor] of [
      ...Array.from({ length: 14 }, () => 60000),
      163908,
    ].entries())
      store.addTransaction({
        id: `synthetic-retained-${index}`,
        cardId: wallet.id,
        type: 'PURCHASE',
        amountMinor,
        currencyCode: 'INR',
        transactionDate: '2026-10-22',
        categoryId: index % 2 ? 'synthetic-kids' : 'groceries',
        sourceBalanceApplied: false,
        attachmentIds: [],
        createdAt: '2026-10-22T00:00:00Z',
        updatedAt: '2026-10-22T00:00:00Z',
      });
    await database.atomic(async () => undefined);
    const history = rows('SELECT payload FROM card_transactions ORDER BY id');
    const review = TestBed.inject(SmsReviewService);
    vi.spyOn(review, 'refresh').mockResolvedValue();
    const topup: SmsEvidence = {
      id: 'd'.repeat(64),
      providerId: 'synthetic-repair',
      kind: 'PLUXEE_TOPUP',
      issuer: 'Pluxee',
      amountMinor: 880000,
      currency: 'INR',
      eventDate: '2026-10-23',
      eventTime: '05:17:27',
      eventAt: '2026-10-22T23:47:27Z',
      eventTimeExplicit: true,
      timeZone: 'Asia/Kolkata',
      receivedAt: 1792712847000,
      dateFallback: false,
      balancePosition: 'AFTER',
      reportedBalanceMinor: 973724,
      evidence: 'Synthetic meal wallet credit',
    };
    const stage = async (item: SmsEvidence): Promise<SmsCandidate> => {
      await database.run(
        "INSERT OR IGNORE INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES(?,?,?,?,'PENDING',?,'now')",
        [item.id, item.providerId, item.eventAt, item.kind, JSON.stringify(item)],
      );
      return { id: item.id, kind: item.kind, eventAt: item.eventAt, state: 'PENDING', item };
    };
    const candidate = await stage(topup);
    expect(rows("SELECT COUNT(*) AS n FROM card_transactions WHERE type='CREDIT'")[0]['n']).toBe(0);
    expect(store.paymentSources().find((source) => source.id === wallet.id)?.balanceMinor).toBe(
      333124,
    );
    await Promise.all([
      review.approve(candidate, wallet.id, 880000, 'Meal wallet top-up'),
      review.approve(candidate, wallet.id, 880000, 'Meal wallet top-up'),
    ]);
    const repaired = () => store.paymentSources().find((source) => source.id === wallet.id)!;
    expect(repaired()).toMatchObject({
      balanceMinor: 973724,
      balanceCutoverAt: topup.eventAt,
      balanceCutoverReason: 'SMS_RECONCILIATION',
      balanceSnapshotMinor: 973724,
      balanceReconciliation: {
        candidateId: topup.id,
        transactionId: `sms-${topup.id}`,
        savedBalanceMinor: 333124,
        predictedBalanceMinor: 1213124,
        reportedBalanceMinor: 973724,
        correctionMinor: -239400,
      },
    });
    expect(rows("SELECT payload FROM card_transactions WHERE type='PURCHASE' ORDER BY id")).toEqual(
      history,
    );
    expect(count('card_transactions')).toBe(16);
    const purchase = await stage({
      ...topup,
      id: 'e'.repeat(64),
      kind: 'PLUXEE_PURCHASE',
      amountMinor: 50000,
      eventTime: '06:00:00',
      eventAt: '2026-10-23T00:30:00Z',
      reportedBalanceMinor: undefined,
    });
    await review.approve(
      purchase,
      wallet.id,
      50000,
      'Fictional breakfast',
      '',
      'PENDING',
      false,
      '',
      0,
      { categoryId: 'dining' },
    );
    expect(repaired().balanceMinor).toBe(923724);
    const second = await stage({
      ...purchase.item!,
      id: 'f'.repeat(64),
      amountMinor: 25000,
      eventTime: '07:00:00',
      eventAt: '2026-10-23T01:30:00Z',
    });
    const approval = review.approve(second, wallet.id, 25000, 'Fictional lunch');
    store.updatePaymentSource({ ...repaired(), nickname: 'Renamed Pluxee wallet' });
    await approval;
    await database.atomic(async () => undefined);
    expect(repaired().balanceMinor).toBe(898724);
    expect(repaired().nickname).toBe('Renamed Pluxee wallet');
    const firstPurchase = store.transactions().find((entry) => entry.id === `sms-${purchase.id}`)!;
    expect(firstPurchase.categoryId).toBe('dining');
    store.updateTransaction({ ...firstPurchase, amountMinor: 40000 });
    await database.atomic(async () => undefined);
    expect(repaired().balanceMinor).toBe(908724);
    store.deleteTransaction(firstPurchase.id);
    await database.atomic(async () => undefined);
    expect(repaired().balanceMinor).toBe(948724);
    expect(store.paymentSources().filter((source) => source.id !== wallet.id)).toEqual(
      otherSources,
    );
    const expectedSource = repaired();
    const audit = rows('SELECT * FROM sms_reconciliation ORDER BY id');
    const expectedLedger = rows('SELECT * FROM card_transactions ORDER BY id');
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-wallet-passphrase');
      expect(backup.contents).not.toContain('synthetic-retained');
      await database.deleteAllData();
      await backups.restore(backup.contents, 'synthetic-wallet-passphrase');
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      await restarted.initialisePreferences();
      expect(restarted.paymentSources().find((source) => source.id === wallet.id)).toEqual(
        expectedSource,
      );
      expect(restarted.categories().some((category) => category.id === 'synthetic-kids')).toBe(
        true,
      );
      expect(rows('SELECT * FROM sms_reconciliation ORDER BY id')).toEqual(audit);
      expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(expectedLedger);
      await stage(topup);
      await review.approve(candidate, wallet.id, 880000, 'Meal wallet top-up');
      expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(expectedLedger);
      expect(
        restarted.paymentSources().find((source) => source.id === wallet.id)?.balanceMinor,
      ).toBe(948724);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps a verified Pluxee anchor stable when earlier history is edited, deleted or moved, while later activity applies normally', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallet = store.paymentSources().find((source) => source.kind === 'MEAL')!;
    const balance = () => store.paymentSources().find((source) => source.id === wallet.id)!;
    const storedBalance = () =>
      (
        JSON.parse(
          String(
            rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0][
              'encrypted_value'
            ],
          ),
        ) as { id: string; balanceMinor?: number }[]
      ).find((source) => source.id === wallet.id)?.balanceMinor;
    const settle = () => database.atomic(async () => undefined);
    await database.run('INSERT OR REPLACE INTO app_preferences VALUES(?,?)', [
      'payment_sources',
      JSON.stringify(
        store
          .paymentSources()
          .map((source) =>
            source.id === wallet.id
              ? { ...source, balanceMinor: 438124, balanceCutoverAt: '2026-10-23T12:15:00Z' }
              : source,
          ),
      ),
    ]);
    await store.initialisePreferences();
    const otherSources = store.paymentSources().filter((source) => source.id !== wallet.id);
    const base = {
      cardId: wallet.id,
      type: 'PURCHASE' as const,
      currencyCode: 'INR',
      categoryId: 'groceries',
      attachmentIds: [],
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
    };
    // 1. Historical purchases whose effects were applied before the anchor exists.
    store.addTransaction({
      ...base,
      id: 'history-a',
      amountMinor: 100000,
      transactionDate: '2026-10-22',
    });
    store.addTransaction({
      ...base,
      id: 'history-b',
      amountMinor: 5000,
      transactionDate: '2026-10-23',
      transactionTime: '04:00:00',
    });
    await settle();
    expect(balance().balanceMinor).toBe(333124);
    const review = TestBed.inject(SmsReviewService);
    vi.spyOn(review, 'refresh').mockResolvedValue();
    const evidence = (changes: Partial<SmsEvidence>): SmsEvidence => ({
      id: 'a'.repeat(64),
      providerId: 'synthetic-anchor',
      kind: 'PLUXEE_TOPUP',
      issuer: 'Pluxee',
      amountMinor: 880000,
      currency: 'INR',
      eventDate: '2026-10-23',
      eventTime: '05:17:27',
      eventAt: '2026-10-22T23:47:27Z',
      eventTimeExplicit: true,
      timeZone: 'Asia/Kolkata',
      receivedAt: 1792712847000,
      dateFallback: false,
      balancePosition: 'AFTER',
      reportedBalanceMinor: 973724,
      evidence: 'Synthetic meal wallet event',
      ...changes,
    });
    const stage = async (item: SmsEvidence): Promise<SmsCandidate> => {
      await database.run(
        "INSERT OR IGNORE INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES(?,?,?,?,'PENDING',?,'now')",
        [item.id, item.providerId, item.eventAt, item.kind, JSON.stringify(item)],
      );
      return { id: item.id, kind: item.kind, eventAt: item.eventAt, state: 'PENDING', item };
    };
    // 2. One-time repair to the verified post-event balance.
    const topup = await stage(evidence({}));
    await review.approve(topup, wallet.id, 880000, 'Meal wallet top-up');
    expect(balance().balanceMinor).toBe(973724);
    // 3–5. Editing, moving or deleting earlier history keeps the trusted anchor.
    const historyA = store.transactions().find((entry) => entry.id === 'history-a')!;
    store.updateTransaction({ ...historyA, amountMinor: 120000 });
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    const historyB = store.transactions().find((entry) => entry.id === 'history-b')!;
    store.updateTransaction({ ...historyB, amountMinor: 6000, transactionTime: '04:30:00' });
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    store.deleteTransaction('history-a');
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    expect(storedBalance()).toBe(973724);
    expect(rows("SELECT id FROM card_transactions WHERE id='history-b'")).toHaveLength(1);
    // 6. Activity after the anchor applies and reverses normally.
    const purchase = await stage(
      evidence({
        id: 'b'.repeat(64),
        kind: 'PLUXEE_PURCHASE',
        amountMinor: 50000,
        eventTime: '06:00:00',
        eventAt: '2026-10-23T00:30:00Z',
        reportedBalanceMinor: undefined,
      }),
    );
    await review.approve(purchase, wallet.id, 50000, 'Fictional breakfast');
    expect(balance().balanceMinor).toBe(923724);
    store.addTransaction({
      ...base,
      id: 'after-anchor',
      amountMinor: 25000,
      transactionDate: '2026-10-23',
      transactionTime: '07:00:00',
    });
    await settle();
    expect(balance().balanceMinor).toBe(898724);
    store.updateTransaction({
      ...store.transactions().find((entry) => entry.id === 'after-anchor')!,
      amountMinor: 20000,
    });
    await settle();
    expect(balance().balanceMinor).toBe(903724);
    store.deleteTransaction('after-anchor');
    await settle();
    expect(balance().balanceMinor).toBe(923724);
    // 7. The reconciled top-up itself edits and reverses symmetrically.
    const topupEntry = () => store.transactions().find((entry) => entry.id === `sms-${topup.id}`)!;
    store.updateTransaction({ ...topupEntry(), amountMinor: 870000 });
    await settle();
    expect(balance().balanceMinor).toBe(913724);
    store.updateTransaction({ ...topupEntry(), amountMinor: 880000 });
    await settle();
    expect(balance().balanceMinor).toBe(923724);
    // 8. Source transfers: later activity leaves once; earlier history never shifts the anchor.
    const smsPurchase = store.transactions().find((entry) => entry.id === `sms-${purchase.id}`)!;
    store.updateTransaction({ ...smsPurchase, cardId: 'source-cash' });
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    const movedB = store.transactions().find((entry) => entry.id === 'history-b')!;
    store.updateTransaction({ ...movedB, cardId: 'source-cash' });
    await settle();
    store.updateTransaction({
      ...store.transactions().find((entry) => entry.id === 'history-b')!,
      cardId: wallet.id,
    });
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    store.updateTransaction({
      ...store.transactions().find((entry) => entry.id === smsPurchase.id)!,
      cardId: wallet.id,
    });
    await settle();
    expect(balance().balanceMinor).toBe(923724);
    // Explicit historical application cannot double-count an event the anchor already contains.
    const earlier = await stage(
      evidence({
        id: 'c'.repeat(64),
        kind: 'PLUXEE_PURCHASE',
        amountMinor: 1200,
        eventDate: '2026-10-22',
        eventTime: '12:00:00',
        eventAt: '2026-10-22T06:30:00Z',
        reportedBalanceMinor: undefined,
      }),
    );
    await expect(
      review.approve(earlier, wallet.id, 1200, 'Earlier purchase', '', 'APPLY_EVENT'),
    ).rejects.toThrow('already includes');
    expect(balance().balanceMinor).toBe(923724);
    await review.approve(earlier, wallet.id, 1200, 'Earlier purchase', '', 'RETAIN_BALANCE');
    expect(balance().balanceMinor).toBe(923724);
    // A later explicit correction is audited without overwriting the one-time repair marker.
    const later = await stage(
      evidence({
        id: 'd'.repeat(64),
        amountMinor: 10000,
        eventDate: '2026-10-24',
        eventTime: '06:00:00',
        eventAt: '2026-10-24T00:30:00Z',
        reportedBalanceMinor: 930000,
      }),
    );
    await review.approve(later, wallet.id, 10000, 'Later load', '', 'ADJUST_BALANCE');
    expect(balance()).toMatchObject({
      balanceMinor: 930000,
      balanceCutoverAt: '2026-10-24T00:30:00Z',
      balanceReconciliation: { candidateId: topup.id, correctionMinor: -239400 },
      latestBalanceReconciliation: {
        candidateId: later.id,
        transactionId: `sms-${later.id}`,
        savedBalanceMinor: 923724,
        predictedBalanceMinor: 933724,
        correctionMinor: -3724,
      },
    });
    expect(
      String(
        rows('SELECT decision FROM sms_reconciliation WHERE candidate_id=?', [later.id])[0][
          'decision'
        ],
      ),
    ).toContain('EXPLICIT_BALANCE_RECONCILIATION');
    // The new anchor now contains the earlier top-up; editing it no longer shifts funds.
    store.updateTransaction({ ...topupEntry(), amountMinor: 870000 });
    await settle();
    expect(balance().balanceMinor).toBe(930000);
    const stale = await stage(
      evidence({
        id: 'e'.repeat(64),
        amountMinor: 20000,
        eventTime: '08:00:00',
        eventAt: '2026-10-23T02:30:00Z',
        reportedBalanceMinor: 5000000,
      }),
    );
    await expect(
      review.approve(stale, wallet.id, 20000, 'Stale load', '', 'ADJUST_BALANCE'),
    ).rejects.toThrow();
    expect(balance().balanceMinor).toBe(930000);
    expect(storedBalance()).toBe(930000);
    expect(store.paymentSources().filter((source) => source.id !== wallet.id)).toEqual(
      otherSources,
    );
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(restarted.paymentSources().find((source) => source.id === wallet.id)).toEqual(balance());
  });
  it('starts signals empty and initializes a genuinely fresh production database without fictional financial values', async () => {
    const store = TestBed.inject(CardNestStore);
    expect(store.cards()).toEqual([]);
    expect(store.transactions()).toEqual([]);
    expect(store.monthlyIncomeMinor()).toBe(0);
    expect(store.monthlyBudgetMinor()).toBe(0);
    await database.initialise();
    expect(marker()).toBe('PENDING');
    await store.initialisePreferences();
    expect(marker()).toBe('EMPTY');
    expect(count('credit_cards')).toBe(0);
    expect(count('card_transactions')).toBe(0);
    expect(count('monthly_income')).toBe(0);
    expect(count('categories')).toBeGreaterThan(0);
    expect(store.paymentSources().every((source) => !source.balanceMinor)).toBe(true);
  });
  it('turning demo on in a later build cannot populate an already initialized empty installation', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    config.seedDemoData = true;
    await database.initialise();
    await store.initialisePreferences();
    expect(marker()).toBe('EMPTY');
    expect(store.cards()).toEqual([]);
    expect(count('card_transactions')).toBe(0);
    expect(count('monthly_income')).toBe(0);
  });
  it('does not seed a schema-only interrupted version-zero installation', async () => {
    schema(7);
    sql.exec('PRAGMA user_version=0');
    config.seedDemoData = true;
    await database.initialise();
    await TestBed.inject(CardNestStore).initialisePreferences();
    expect(marker()).toBe('EXISTING');
    expect(count('credit_cards')).toBe(0);
    expect(count('monthly_income')).toBe(0);
  });
  it('demo-enabled fresh initialization seeds a coherent labeled dataset once, and flag changes preserve it', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(marker()).toBe('DEMO');
    expect(count('credit_cards')).toBe(2);
    expect(count('card_transactions')).toBe(4);
    expect(count('monthly_income')).toBe(1);
    expect(store.cards().every((card) => card.nickname.includes('(demo)'))).toBe(true);
    expect(store.monthlyBudgetMinor()).toBe(6000000);
    expect(store.monthlyIncomeMinor()).toBe(8000000);
    const before = rows('SELECT * FROM card_transactions');
    config.seedDemoData = false;
    await store.initialisePreferences();
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(count('credit_cards')).toBe(2);
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('concurrent eligible initialization cannot duplicate demo records', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await Promise.all([store.initialisePreferences(), store.initialisePreferences()]);
    expect(count('credit_cards')).toBe(2);
    expect(count('card_transactions')).toBe(4);
    expect(count('monthly_income')).toBe(1);
  });
  it('preserves legacy cached records with existing sources but never lets stale cache override an empty restore', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const cached = { ...store.transactions()[0], id: 'synthetic-legacy-cache' };
    localStorage.setItem('cardnest.transactions.cache.v1', JSON.stringify([cached]));
    await database.run('DELETE FROM card_transactions');
    await database.run(
      "UPDATE app_preferences SET encrypted_value='EXISTING' WHERE key='initial_data_state'",
    );
    config.seedDemoData = false;
    await store.initialisePreferences();
    expect(store.transactions()).toEqual([cached]);
    const backup = await database.exportBackupJson();
    await database.restoreBackupJson(backup);
    await store.initialisePreferences();
    expect(store.transactions()).toEqual([]);
    expect(count('credit_cards')).toBe(2);
    localStorage.removeItem('cardnest.transactions.cache.v1');
  });
  it('does not remove existing demo transactions when a user adds their first manual transaction', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    store.addTransaction({
      ...store.transactions()[0],
      id: 'synthetic-manual',
      merchant: 'Synthetic manual',
    });
    await database.atomic(async () => undefined);
    expect(store.transactions()).toHaveLength(5);
    expect(count('card_transactions')).toBe(5);
  });
  it('never seeds an existing empty versioned database, nor after cards are manually removed', async () => {
    schema(7);
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(marker()).toBe('EXISTING');
    expect(count('credit_cards')).toBe(0);
    expect(count('monthly_income')).toBe(0);
    await store.initialisePreferences();
    expect(store.cards()).toEqual([]);
    expect(store.transactions()).toEqual([]);
  });
  it('does not seed a partially initialized version-zero database with existing preferences', async () => {
    schema(7);
    sql.exec(
      "PRAGMA user_version=0; INSERT INTO app_preferences VALUES('profile_name','Synthetic existing')",
    );
    // Replayable old schema statements coexist with the interrupted database.
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(marker()).toBe('EXISTING');
    expect(count('credit_cards')).toBe(0);
    expect(store.profileName()).toBe('Synthetic existing');
  });
  it('adds read flags without changing financial rows, decisions, bindings or wallet amounts', async () => {
    schema(7);
    installFinancialData();
    const before = {
      cards: rows('SELECT * FROM credit_cards'),
      ledger: rows('SELECT * FROM card_transactions'),
      loans: rows('SELECT * FROM loan_commitments'),
      binding: rows('SELECT * FROM sms_reconciliation'),
      wallet: rows("SELECT * FROM app_preferences WHERE key='payment_sources'"),
    };
    await database.initialise();
    expect({
      cards: rows('SELECT * FROM credit_cards'),
      ledger: rows('SELECT * FROM card_transactions'),
      loans: rows('SELECT * FROM loan_commitments'),
      binding: rows('SELECT * FROM sms_reconciliation'),
      wallet: rows("SELECT * FROM app_preferences WHERE key='payment_sources'"),
    }).toEqual(before);
    expect(rows('SELECT id,state,read_at FROM sms_candidates ORDER BY id')).toEqual([
      { id: 'synthetic-pending', state: 'PENDING', read_at: null },
      { id: 'synthetic-read', state: 'IMPORTED', read_at: 'before' },
    ]);
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('round trips read flags and bindings through real backup/restore while excluding evidence payloads and blocking reseeding', async () => {
    schema(7);
    installFinancialData();
    await database.initialise();
    const backup = await database.exportBackupJson();
    expect(backup).not.toContain('Synthetic private evidence');
    expect(backup).not.toContain('Synthetic pending evidence');
    await database.run("UPDATE sms_candidates SET read_at='changed'");
    await database.restoreBackupJson(backup);
    expect(marker()).toBe('RESTORED');
    expect(rows('SELECT id,read_at,payload FROM sms_candidates ORDER BY id')).toEqual([
      { id: 'synthetic-pending', read_at: null, payload: null },
      { id: 'synthetic-read', read_at: 'before', payload: null },
    ]);
    const before = rows('SELECT * FROM card_transactions');
    config.seedDemoData = true;
    // Initialization must return without touching restored financial rows.
    const { initialiseAppData } = await import('./app-initialization');
    await initialiseAppData(database, true, {
      categories: [],
      cards: [],
      transactions: [],
      income: {
        periodKey: 'synthetic',
        cycleStartDate: '2026-01-01',
        cycleEndDate: '2026-01-31',
        amountMinor: 1,
        updatedAt: 'now',
      },
    });
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(count('sms_reconciliation')).toBe(1);
  });
  it.each([
    { kind: 'REFUND', search: 'Synthetic legacy' },
    {
      kind: 'PURCHASE',
      mode: 'MULTIPLE',
      kinds: ['PURCHASE', 'CASHBACK', 'PURCHASE', 'invalid'],
      multipleInitialized: true,
      read: 'READ',
    },
    { mode: 'MULTIPLE', kinds: [], multipleInitialized: true },
  ])(
    'round trips old/new SMS filter preferences and matching audit without financial changes %j',
    async (preferences) => {
      schema(7);
      installFinancialData();
      await database.initialise();
      await database.run('INSERT INTO app_preferences VALUES(?,?)', [
        'sms_review_filters',
        JSON.stringify(preferences),
      ]);
      const before = rows('SELECT * FROM card_transactions');
      const backup = await database.exportBackupJson();
      await database.restoreBackupJson(backup);
      const restored = JSON.parse(
        String(
          rows("SELECT encrypted_value FROM app_preferences WHERE key='sms_review_filters'")[0][
            'encrypted_value'
          ],
        ),
      );
      expect(reviewFilters(restored)).toEqual(reviewFilters(preferences));
      expect(rows('SELECT * FROM card_transactions')).toEqual(before);
      expect(rows('SELECT target_id FROM sms_reconciliation')[0]['target_id']).toBe(
        'synthetic-transaction',
      );
    },
  );
  it('read state survives closing and reopening an on-disk SQLite database', async () => {
    schema(7);
    installFinancialData();
    await database.initialise();
    await database.run(
      "UPDATE sms_candidates SET read_at='synthetic-seen' WHERE id='synthetic-pending'",
    );
    const directory = mkdtempSync(join(tmpdir(), 'card-nest-read-restart-'));
    const file = join(directory, `synthetic-read-restart-${randomUUID()}.sqlite`);
    await database.run('INSERT INTO app_preferences VALUES(?,?)', [
      'sms_review_filters',
      JSON.stringify({ search: 'Synthetic saved query', read: 'ALL' }),
    ]);
    try {
      sql.prepare('VACUUM INTO ?').run(file);
      sql.close();
      sql = new DatabaseSync(file);
      await database.initialise();
      expect(rows("SELECT read_at,state FROM sms_candidates WHERE id='synthetic-pending'")).toEqual(
        [{ read_at: 'synthetic-seen', state: 'PENDING' }],
      );
      expect(count('card_transactions')).toBe(1);
      expect(
        JSON.parse(
          String(
            rows("SELECT encrypted_value FROM app_preferences WHERE key='sms_review_filters'")[0][
              'encrypted_value'
            ],
          ),
        ),
      ).toEqual({ search: 'Synthetic saved query', read: 'ALL' });
    } finally {
      sql.close();
      sql = new DatabaseSync(':memory:');
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    }
  });
  it('restores old backups without read fields using the migration policy and never seeds an empty restored backup', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const backup = JSON.parse(await database.exportBackupJson()) as {
      tables: { name: string; rows: Record<string, unknown>[] }[];
    };
    const candidates = backup.tables.find((table) => table.name === 'sms_candidates')!;
    candidates.rows = [
      {
        id: 'synthetic-old',
        provider_id: '1',
        event_at: '2026-01-01',
        kind: 'PURCHASE',
        state: 'REJECTED',
        payload: null,
        updated_at: 'before',
      },
    ];
    await database.restoreBackupJson(JSON.stringify(backup));
    expect(rows('SELECT read_at FROM sms_candidates')).toEqual([{ read_at: 'before' }]);
    candidates.rows = [];
    await database.restoreBackupJson(JSON.stringify(backup));
    config.seedDemoData = true;
    await store.initialisePreferences();
    expect(count('credit_cards')).toBe(0);
    expect(count('card_transactions')).toBe(0);
    expect(marker()).toBe('RESTORED');
  });
  it('explicit Delete all data leaves a durable no-reseed marker even in a demo-enabled build', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    await store.deleteAllData();
    expect(marker()).toBe('CLEARED');
    await database.initialise();
    await store.initialisePreferences();
    expect(count('credit_cards')).toBe(0);
    expect(count('card_transactions')).toBe(0);
    expect(count('monthly_income')).toBe(0);
    expect(store.cards()).toEqual([]);
  });
  it('seed failures roll back cards, transactions, categories and marker together, and retry does not duplicate data', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    sql.exec(
      "CREATE TRIGGER fail_seed BEFORE INSERT ON card_transactions BEGIN SELECT RAISE(ABORT,'synthetic seed failure'); END",
    );
    await expect(store.initialisePreferences()).rejects.toThrow('synthetic seed failure');
    expect(count('credit_cards')).toBe(0);
    expect(count('categories')).toBe(0);
    expect(marker()).toBe('PENDING');
    sql.exec('DROP TRIGGER fail_seed');
    await store.initialisePreferences();
    await store.initialisePreferences();
    expect(count('credit_cards')).toBe(2);
    expect(count('card_transactions')).toBe(4);
  });
  it('a pending first-run marker cannot seed demos after the user has created financial data', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const card = {
      id: 'synthetic-user-card',
      nickname: 'Synthetic user-created card',
      issuerName: 'Fictional Bank',
      lastDigits: '4321',
      network: 'VISA',
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
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
    };
    await database.run(
      'INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      [
        card.id,
        card.nickname,
        card.issuerName,
        card.lastDigits,
        card.network,
        JSON.stringify(card),
        card.createdAt,
        card.updatedAt,
      ],
    );
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(marker()).toBe('EXISTING');
    expect(store.cards().map((item) => item.id)).toEqual([card.id]);
    expect(count('card_transactions')).toBe(0);
    expect(count('monthly_income')).toBe(0);
    expect(store.monthlyBudgetMinor()).toBe(0);
  });
  it('failed restore rolls back read flags and financial data as one transaction', async () => {
    schema(7);
    installFinancialData();
    await database.initialise();
    const backup = await database.exportBackupJson();
    const before = rows('SELECT * FROM sms_candidates');
    const clearDiscovery = vi.spyOn(
      database as unknown as { clearPlatformDiscoveryAfterCommit: () => Promise<void> },
      'clearPlatformDiscoveryAfterCommit',
    );
    sql.exec(
      "CREATE TRIGGER fail_restore BEFORE INSERT ON sms_candidates BEGIN SELECT RAISE(ABORT,'synthetic restore failure'); END",
    );
    await expect(database.restoreBackupJson(backup)).rejects.toThrow('synthetic restore failure');
    expect(clearDiscovery).not.toHaveBeenCalled();
    expect(rows('SELECT * FROM sms_candidates')).toEqual(before);
    expect(count('card_transactions')).toBe(1);
    expect(count('sms_reconciliation')).toBe(1);
  });
  it('rolls back a failed legacy plugin import without losing pending SMS or financial data', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const transaction = {
      id: 'legacy-import-rollback-transaction',
      cardId: '',
      type: 'PURCHASE',
      amountMinor: 1200,
      currencyCode: 'INR',
      transactionDate: '2026-10-25',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: '2026-10-25T10:00:00Z',
      updatedAt: '2026-10-25T10:00:00Z',
    };
    await database.run(
      'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        transaction.id,
        null,
        transaction.categoryId,
        transaction.type,
        transaction.amountMinor,
        transaction.currencyCode,
        transaction.transactionDate,
        JSON.stringify(transaction),
        transaction.createdAt,
        transaction.updatedAt,
      ],
    );
    await database.run(
      "INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES('rollback-sms','synthetic','2026-10-25','BANK_DEBIT','PENDING','{\"message\":\"private pending evidence\"}','before')",
    );
    const originalTransactions = rows('SELECT * FROM card_transactions ORDER BY id');
    const originalCandidates = rows('SELECT * FROM sms_candidates ORDER BY id');
    const originalPreferences = rows('SELECT * FROM app_preferences ORDER BY key');
    vi.mocked(CapacitorSQLite.isJsonValid).mockResolvedValue({ result: true });
    vi.mocked(CapacitorSQLite.importFromJson).mockImplementation(async () => {
      sql.exec(
        'DELETE FROM card_transactions; DELETE FROM sms_candidates; DELETE FROM app_preferences;',
      );
      throw new Error('synthetic legacy import failure');
    });

    await expect(
      database.restoreBackupJson(
        JSON.stringify({ database: 'synthetic-legacy', version: 7, tables: [] }),
      ),
    ).rejects.toThrow('synthetic legacy import failure');
    expect(database.ready()).toBe(true);
    expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(originalTransactions);
    expect(rows('SELECT * FROM sms_candidates ORDER BY id')).toEqual(originalCandidates);
    expect(rows('SELECT * FROM app_preferences ORDER BY key')).toEqual(originalPreferences);
  });

  it('rolls back original data when a legacy import fails during a forward migration', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const transaction = {
      id: 'legacy-migration-rollback-transaction',
      cardId: '',
      type: 'PURCHASE',
      amountMinor: 2400,
      currencyCode: 'INR',
      transactionDate: '2026-10-26',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: '2026-10-26T10:00:00Z',
      updatedAt: '2026-10-26T10:00:00Z',
    };
    await database.run(
      'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        transaction.id,
        null,
        transaction.categoryId,
        transaction.type,
        transaction.amountMinor,
        transaction.currencyCode,
        transaction.transactionDate,
        JSON.stringify(transaction),
        transaction.createdAt,
        transaction.updatedAt,
      ],
    );
    await database.run(
      "INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES('migration-rollback-sms','synthetic','2026-10-26','BANK_DEBIT','PENDING','{\"message\":\"preserve this evidence\"}','before')",
    );
    const originalTransactions = rows('SELECT * FROM card_transactions ORDER BY id');
    const originalCandidates = rows('SELECT * FROM sms_candidates ORDER BY id');
    const originalPreferences = rows('SELECT * FROM app_preferences ORDER BY key');
    const execute = vi.mocked(CapacitorSQLite.execute).getMockImplementation()!;
    let failLatestMigration = true;
    vi.mocked(CapacitorSQLite.isJsonValid).mockResolvedValue({ result: true });
    vi.mocked(CapacitorSQLite.execute).mockImplementation(async (options) => {
      if (
        failLatestMigration &&
        options.transaction &&
        options.statements?.includes('PRAGMA user_version = 15')
      ) {
        failLatestMigration = false;
        throw new Error('synthetic forward migration failure');
      }
      return execute(options);
    });
    vi.mocked(CapacitorSQLite.importFromJson).mockImplementation(async () => {
      sql.close();
      sql = new DatabaseSync(':memory:');
      sql.exec('PRAGMA foreign_keys=ON');
      schema(14);
      installFinancialData();
      return { changes: { changes: 1 } };
    });

    await expect(
      database.restoreBackupJson(
        JSON.stringify({ database: 'synthetic-legacy', version: 14, tables: [] }),
      ),
    ).rejects.toThrow('The restored database could not be opened.');
    expect(database.ready()).toBe(true);
    expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(originalTransactions);
    expect(rows('SELECT * FROM sms_candidates ORDER BY id')).toEqual(originalCandidates);
    expect(rows('SELECT * FROM app_preferences ORDER BY key')).toEqual(originalPreferences);
  });

  it('reopens and migrates a legacy plugin import before recording RESTORED, without introducing demo data', async () => {
    await database.initialise();
    vi.mocked(CapacitorSQLite.isJsonValid).mockResolvedValue({ result: true });
    // The platform importer is the boundary stub; its resulting old-version database is real SQLite.
    vi.mocked(CapacitorSQLite.importFromJson).mockImplementation(async () => {
      sql.close();
      sql = new DatabaseSync(':memory:');
      sql.exec('PRAGMA foreign_keys=ON');
      schema(7);
      installFinancialData();
      return { changes: { changes: 1 } };
    });
    await database.restoreBackupJson(
      JSON.stringify({ database: 'synthetic-legacy', version: 7, tables: [] }),
    );
    expect(database.ready()).toBe(true);
    expect(marker()).toBe('RESTORED');
    expect(count('credit_cards')).toBe(1);
    expect(count('card_transactions')).toBe(1);
    expect(rows("SELECT read_at FROM sms_candidates WHERE id='synthetic-read'")).toEqual([
      { read_at: 'before' },
    ]);
    expect(vi.mocked(CapacitorSQLite.closeConnection)).toHaveBeenCalled();
    expect(CapacitorSQLite.createConnection).toHaveBeenCalledTimes(2);
    expect(sql.prepare('PRAGMA user_version').get()?.['user_version']).toBe(
      DATABASE_MIGRATIONS.at(-1)?.version,
    );
  });
});
