import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SourcesPage } from './sources';
import { CardNestStore } from '../../core/services/card-nest-store';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { SnackbarService } from '../../core/services/snackbar.service';
import { CardTransaction } from '../../core/models/domain';
import { TransactionsPage } from '../transactions/transactions';

describe('Explicit FASTag wallet creation and feedback', () => {
  const setup = () => {
    TestBed.configureTestingModule({
      imports: [SourcesPage],
      providers: [provideRouter([]), { provide: SqliteDatabase, useValue: { ready: () => false } }],
    });
    const fixture = TestBed.createComponent(SourcesPage);
    fixture.detectChanges();
    fixture.componentInstance.walletOpen.set(true);
    fixture.componentInstance.walletForm.setValue({
      name: 'Synthetic vehicle',
      provider: 'Fictional toll provider',
      plate: 'FICT001',
    });
    return fixture;
  };
  it('shows success after saving, resets/collapses the form and preserves existing wallets and balances', async () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    const before = store.paymentSources();
    const add = vi.spyOn(store, 'addWallet').mockResolvedValue();
    const snackbar = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    await fixture.componentInstance.addFastag(new Event('submit'));
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Synthetic vehicle',
        kind: 'FASTAG',
        vehicleNumber: 'FICT001',
        balanceMinor: 0,
      }),
    );
    expect(snackbar).toHaveBeenCalledWith('FASTag wallet created.');
    expect(fixture.componentInstance.walletOpen()).toBe(false);
    expect(fixture.componentInstance.walletForm.pristine).toBe(true);
    expect(fixture.componentInstance.walletForm.controls.name.value).toBe('');
    expect(store.paymentSources()).toEqual(before);
  });
  it('keeps invalid registration or failed creation editable and reports the failure without success', async () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    const add = vi
      .spyOn(store, 'addWallet')
      .mockRejectedValue(new Error('Synthetic wallet write failure'));
    const snackbar = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    fixture.componentInstance.walletForm.controls.plate.setValue('!');
    await fixture.componentInstance.addFastag(new Event('submit'));
    expect(add).not.toHaveBeenCalled();
    fixture.componentInstance.walletForm.controls.plate.setValue('FICT001');
    await fixture.componentInstance.addFastag(new Event('submit'));
    expect(fixture.componentInstance.walletOpen()).toBe(true);
    expect(fixture.componentInstance.walletForm.controls.name.value).toBe('Synthetic vehicle');
    expect(snackbar).toHaveBeenCalledExactlyOnceWith('Synthetic wallet write failure', 'WARNING');
  });
  it('prevents repeated submit while creation is pending', async () => {
    const fixture = setup();
    let finish!: () => void;
    const add = vi
      .spyOn(TestBed.inject(CardNestStore), 'addWallet')
      .mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const first = fixture.componentInstance.addFastag(new Event('submit'));
    await fixture.componentInstance.addFastag(new Event('submit'));
    expect(add).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.walletSaving()).toBe(true);
    finish();
    await first;
    expect(fixture.componentInstance.walletSaving()).toBe(false);
  });
  it('waits for identity persistence, reports a failure and restores the field without false success', async () => {
    const fixture = setup();
    const page = fixture.componentInstance;
    const store = TestBed.inject(CardNestStore);
    const source = store.paymentSources().find((row) => row.kind === 'DEBIT')!;
    const input = document.createElement('input');
    input.value = 'Unsaved nickname';
    let reject!: (reason: Error) => void;
    const update = vi.spyOn(store, 'updatePaymentSource').mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const snackbar = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    const pending = page.updateBankField(source, 'nickname', { target: input } as unknown as Event);
    expect(snackbar).not.toHaveBeenCalled();
    reject(new Error('Identity not saved'));
    await pending;
    expect(snackbar).toHaveBeenCalledExactlyOnceWith('Identity not saved', 'WARNING');
    expect(input.value).toBe(source.nickname);
    update.mockResolvedValueOnce();
    input.value = 'Saved nickname';
    await page.updateBankField(source, 'nickname', { target: input } as unknown as Event);
    expect(snackbar).toHaveBeenLastCalledWith(`${source.nickname} updated.`);
    fixture.destroy();
  });
  it('exposes an explicit restore action for an archived bank account without replacing its identity or history', async () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    const source = {
      ...store.paymentSources().find((row) => row.kind === 'DEBIT')!,
      archived: true,
      lastDigits: '00007',
    };
    store.paymentSources.set([source]);
    fixture.detectChanges();
    const update = vi.spyOn(store, 'updatePaymentSource').mockResolvedValue();
    const restore = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'details[aria-label="Archived bank accounts"] button',
    );
    expect(restore).not.toBeNull();
    restore!.click();
    await fixture.whenStable();
    expect(update).toHaveBeenCalledWith({ ...source, archived: false });
    expect(source.archived).toBe(true);
    fixture.destroy();
  });
  it('orders wallet activity by event time and shows recorded time without using scan time', () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    store.paymentSources.set([
      {
        id: 'synthetic-meal',
        kind: 'MEAL',
        nickname: 'Synthetic Pluxee',
        noLimit: false,
        autoLoad: false,
        archived: false,
        balanceMinor: 93724,
      },
    ]);
    const entry: CardTransaction = {
      id: 'meal-early',
      cardId: 'synthetic-meal',
      type: 'PURCHASE',
      amountMinor: 10000,
      currencyCode: 'INR',
      transactionDate: '2026-10-23',
      transactionTime: '05:17:27',
      categoryId: 'dining',
      merchant: 'Fictional meal',
      attachmentIds: [],
      createdAt: '2026-10-24T23:59:00Z',
      updatedAt: '2026-10-24T23:59:00Z',
    };
    store.transactions.set([
      entry,
      {
        ...entry,
        id: 'meal-later',
        transactionTime: '06:00:00',
        createdAt: '2026-10-23T01:00:00Z',
      },
    ]);
    fixture.componentInstance.showSourceActivity('synthetic-meal');
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleTransactions().map((item) => item.id)).toEqual([
      'meal-later',
      'meal-early',
    ]);
    expect(fixture.nativeElement.querySelectorAll('.transaction-time')).toHaveLength(2);
    expect(fixture.componentInstance.recordedTime({ ...entry, transactionTime: undefined })).toBe(
      '',
    );
    const activity = TestBed.createComponent(TransactionsPage);
    store.showTransactionTime.set(false);
    expect(activity.componentInstance.recordedTime(entry)).toBe('');
    expect(activity.componentInstance.recordedEventTime(entry)).not.toBe('');
    activity.componentInstance.openDetails(entry);
    activity.detectChanges();
    expect(activity.nativeElement.querySelector('.transaction-detail')?.textContent).toContain(
      activity.componentInstance.recordedEventTime(entry),
    );
  });
});
