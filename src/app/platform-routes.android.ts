import { Routes } from '@angular/router';
import { Capacitor } from '@capacitor/core';
export const platformRoutes: Routes = [
  {
    path: 'sms-sync',
    data: { floatingShortcut: 'SMS_SYNC' },
    canMatch: [() => Capacitor.getPlatform() === 'android'],
    loadComponent: () => import('./features/sms-sync/sms-sync').then((m) => m.SmsSyncPage),
  },
];
