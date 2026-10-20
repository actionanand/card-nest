import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { DashboardPage } from './dashboard';
import { CardNestStore } from '../../core/services/card-nest-store';
import { SqliteDatabase } from '../../core/data/sqlite-database';

describe('Dashboard budget with no configured amount', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      imports: [DashboardPage],
      providers: [
        provideRouter([]),
        {
          provide: SqliteDatabase,
          useValue: { ready: signal(false), unavailableReason: signal(null) },
        },
      ],
    }),
  );
  it('renders an empty installation without NaN or an invented budget', () => {
    const fixture = TestBed.createComponent(DashboardPage);
    fixture.detectChanges();
    expect(fixture.componentInstance.budgetPercent()).toBe(0);
    expect(fixture.nativeElement.textContent).not.toMatch(/NaN|Infinity/);
    expect(fixture.nativeElement.querySelector('.budget-ring').getAttribute('aria-label')).toBe(
      'Monthly budget not set',
    );
    expect(
      fixture.nativeElement.querySelector('.budget-ring').style.getPropertyValue('--progress'),
    ).toBe('0%');
    expect(fixture.nativeElement.querySelector('.budget-ring').textContent).toContain('Not set');
  });
  it('preserves configured-budget percentage and caps the ring when overspent', () => {
    const fixture = TestBed.createComponent(DashboardPage);
    const store = TestBed.inject(CardNestStore);
    store.monthlyBudgetMinor.set(10000);
    store.transactions.set([
      {
        id: 'synthetic-purchase',
        cardId: 'fictional-card',
        type: 'PURCHASE',
        amountMinor: 2500,
        currencyCode: 'INR',
        transactionDate: new Date().toISOString().slice(0, 10),
        categoryId: 'other',
        attachmentIds: [],
        createdAt: 'synthetic',
        updatedAt: 'synthetic',
      },
    ]);
    expect(fixture.componentInstance.budgetPercent()).toBe(25);
    store.monthlyBudgetMinor.set(1000);
    expect(fixture.componentInstance.budgetPercent()).toBe(100);
    store.monthlyBudgetMinor.set(0);
    expect(fixture.componentInstance.budgetPercent()).toBe(0);
  });
});
