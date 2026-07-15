import { Routes } from '@angular/router';

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
    path: 'settings',
    loadComponent: () => import('./features/settings/settings').then((item) => item.SettingsPage),
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
