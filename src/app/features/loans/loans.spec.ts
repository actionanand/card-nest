import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { CardNestStore } from '../../core/services/card-nest-store';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { SnackbarService } from '../../core/services/snackbar.service';
import { LoansPage } from './loans';

describe('Loans page add commitment dialog', () => {
  let fixtureToCleanUp: { destroy(): void } | undefined;

  afterEach(() => {
    fixtureToCleanUp?.destroy();
    fixtureToCleanUp = undefined;
  });

  it('shows validation and persistence errors, preserves the draft, and closes after success', async () => {
    const loanRows = signal<readonly unknown[]>([]);
    const store = {
      recurringRules: signal<readonly unknown[]>([]),
      emiPlans: signal<readonly unknown[]>([]),
      emiInstallments: signal<readonly unknown[]>([]),
      loans: loanRows,
      cards: signal<readonly unknown[]>([]),
      addLoan: vi.fn(async (loan: unknown) => loanRows.update((items) => [loan, ...items])),
    };
    const snackbar = { show: vi.fn() };
    TestBed.configureTestingModule({
      imports: [LoansPage],
      providers: [
        provideRouter([]),
        { provide: CardNestStore, useValue: store },
        { provide: SqliteDatabase, useValue: { ready: () => false } },
        { provide: SnackbarService, useValue: snackbar },
      ],
    });
    const fixture = TestBed.createComponent(LoansPage);
    fixtureToCleanUp = fixture;
    const page = fixture.componentInstance;
    page.showForm.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    await page.save();
    fixture.detectChanges();
    expect(store.addLoan).not.toHaveBeenCalled();
    const validationMessages = Array.from(
      fixture.nativeElement.querySelectorAll('[role="alert"]'),
      (element: Element) => element.textContent?.trim() ?? '',
    );
    expect(validationMessages).toContain('Enter a positive principal amount.');

    page.form.patchValue({
      name: 'Synthetic loan',
      lender: 'Synthetic lender',
      principal: '10000',
      installment: '500',
      startDate: '2026-11-12',
      endDate: '2027-11-11',
    });
    store.addLoan.mockRejectedValueOnce(new Error('Synthetic persistence failure'));
    await page.save();
    fixture.detectChanges();
    expect(page.showForm()).toBe(true);
    expect(page.form.controls.name.value).toBe('Synthetic loan');
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Synthetic persistence failure',
    );

    await page.save();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.showForm()).toBe(false);
    expect(page.form.controls.name.value).toBe('');
    expect(store.addLoan).toHaveBeenCalledTimes(2);
    expect(snackbar.show).toHaveBeenCalledWith('Loan commitment saved.');
    fixture.destroy();
    fixtureToCleanUp = undefined;
  });
});
