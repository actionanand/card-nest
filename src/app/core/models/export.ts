export type ExportPeriod = 'MONTH' | 'THREE' | 'SIX' | 'YEAR' | 'ALL';

export type ExportFormat = 'PDF' | 'CSV';

export interface ExportSummaryItem {
  readonly label: string;
  readonly value: string;
}

export interface ExportRow {
  readonly state?: 'normal' | 'credit' | 'warning';
  readonly cells: readonly string[];
}

export interface ExportSection {
  readonly title: string;
  readonly stats?: readonly ExportSummaryItem[];
  readonly headers: readonly string[];
  readonly rows: readonly ExportRow[];
}

export interface ExportDocument {
  readonly title: string;
  readonly subtitle: string;
  readonly generatedOn: string;
  readonly summary: readonly ExportSummaryItem[];
  readonly sections: readonly ExportSection[];
}
