import { InjectionToken } from '@angular/core';
import { registerPlugin } from '@capacitor/core';

export interface CardNestExportPlugin {
  exportPdf(options: {
    filename: string;
    content: string;
    title: string;
  }): Promise<{ path: string }>;
  exportCsv(options: {
    filename: string;
    content: string;
    title: string;
  }): Promise<{ path: string }>;
  shareBackup(options: { filename: string; content: string }): Promise<void>;
}

export const NativeExport = registerPlugin<CardNestExportPlugin>('CardNestExport');
export const NATIVE_EXPORT = new InjectionToken<CardNestExportPlugin>(
  'CardNest native file delivery',
  {
    providedIn: 'root',
    factory: () => NativeExport,
  },
);
