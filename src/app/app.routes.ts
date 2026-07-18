import { CanDeactivateFn, Routes } from '@angular/router';

interface DirtyTransactionEditor {
  canDeactivate(): boolean | Promise<boolean>;
}

const confirmTransactionDraft: CanDeactivateFn<DirtyTransactionEditor> = (component) =>
  component.canDeactivate();

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./features/dashboard/dashboard').then((item) => item.DashboardPage),
  },
  {
    path: 'cards',
    loadComponent: () => import('./features/cards/cards').then((item) => item.CardsPage),
  },
  {
    path: 'transactions',
    canDeactivate: [confirmTransactionDraft],
    loadComponent: () =>
      import('./features/transactions/transactions').then((item) => item.TransactionsPage),
  },
  {
    path: 'categories',
    loadComponent: () =>
      import('./features/categories/categories').then((item) => item.CategoriesPage),
  },
  {
    path: 'reminders',
    loadComponent: () =>
      import('./features/reminders/reminders').then((item) => item.RemindersPage),
  },
  {
    path: 'reports',
    loadComponent: () => import('./features/reports/reports').then((item) => item.ReportsPage),
  },
  {
    path: 'category-spending',
    loadComponent: () =>
      import('./features/category-spending/category-spending').then(
        (item) => item.CategorySpendingPage,
      ),
  },
  {
    path: 'card-benefits',
    loadComponent: () =>
      import('./features/card-benefits/card-benefits').then((item) => item.CardBenefitsPage),
  },
  {
    path: 'card-usage',
    loadComponent: () =>
      import('./features/card-usage/card-usage').then((item) => item.CardUsagePage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings').then((item) => item.SettingsPage),
  },
  {
    path: 'help',
    loadComponent: () => import('./features/help/help').then((item) => item.HelpPage),
  },
  {
    path: 'sources',
    loadComponent: () => import('./features/sources/sources').then((item) => item.SourcesPage),
  },
  {
    path: 'loans',
    loadComponent: () => import('./features/loans/loans').then((item) => item.LoansPage),
  },
  { path: '**', redirectTo: '' },
];
