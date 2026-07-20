import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import { CardTransaction } from '../core/models/domain';
import { ExportFormat, ExportPeriod } from '../core/models/export';
import { ExportService } from '../core/services/export.service';
import { AppIcon } from './app-icon';
import { AppSelectOption, AppSelectPicker } from './app-select-picker';

export interface TransactionExportChoice {
  readonly value: string;
  readonly label: string;
  readonly transactions: readonly CardTransaction[];
}

@Component({
  selector: 'app-export-dialog',
  imports: [AppIcon, AppSelectPicker],
  template: `
    <div class="backdrop">
      <section
        class="dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
      >
        <header>
          <div>
            <p class="eyebrow">Private export</p>
            <h2 id="export-dialog-title">Export transactions</h2>
          </div>
          <button
            type="button"
            class="icon-button"
            (click)="closed.emit()"
            aria-label="Close export"
          >
            <app-icon name="close" />
          </button>
        </header>
        <fieldset>
          <legend>File type</legend>
          <div class="choices two">
            <label>
              <input
                type="radio"
                name="export-format"
                value="PDF"
                [checked]="format() === 'PDF'"
                (change)="format.set('PDF')"
              />
              <span
                ><app-icon name="file_pdf" /><strong>PDF</strong
                ><small>Formatted statement for printing or sharing</small></span
              >
            </label>
            <label>
              <input
                type="radio"
                name="export-format"
                value="CSV"
                [checked]="format() === 'CSV'"
                (change)="format.set('CSV')"
              />
              <span
                ><app-icon name="file_csv" /><strong>CSV</strong
                ><small>Spreadsheet-ready transaction rows</small></span
              >
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Arrange export by</legend>
          <div class="choices two scope-choices">
            <label>
              <input
                type="radio"
                name="export-scope"
                value="STATEMENT"
                [checked]="scope() === 'STATEMENT'"
                [disabled]="!statementChoices().length"
                (change)="setScope('STATEMENT')"
              />
              <span
                ><strong>Statement-wise</strong
                ><small>Transactions in a selected card statement</small></span
              >
            </label>
            <label>
              <input
                type="radio"
                name="export-scope"
                value="MONTH"
                [checked]="scope() === 'MONTH'"
                (change)="setScope('MONTH')"
              />
              <span
                ><strong>Month-wise</strong><small>Transactions in a calendar month</small></span
              >
            </label>
          </div>
        </fieldset>
        <app-select-picker
          label="Export range"
          [options]="rangeOptions"
          [value]="range()"
          (valueChange)="setRange($event)"
        />
        @if (range() === 'SELECTED') {
          <app-select-picker
            [label]="scope() === 'STATEMENT' ? 'Choose statement' : 'Choose month and year'"
            [options]="periodOptions()"
            [value]="period()"
            (valueChange)="period.set($event)"
          />
        }
        <p class="privacy-note">
          The export contains the currently filtered transactions. Full card numbers and CVVs are
          never included.
        </p>
        <footer>
          <button class="btn" type="button" (click)="closed.emit()">Cancel</button>
          <button class="btn btn-primary" type="button" (click)="export()">
            <app-icon name="download" /> Export {{ format() }}
          </button>
        </footer>
      </section>
    </div>
  `,
  styleUrl: './export-dialog.scss',
  host: { '(document:keydown.escape)': 'closed.emit()' },
})
export class ExportDialog {
  private readonly exporter = inject(ExportService);
  readonly transactions = input.required<readonly CardTransaction[]>();
  readonly statementChoices = input<readonly TransactionExportChoice[]>([]);
  readonly monthChoices = input<readonly TransactionExportChoice[]>([]);
  readonly initialFormat = input<ExportFormat>('PDF');
  readonly closed = output<void>();
  readonly format = linkedSignal(() => this.initialFormat());
  readonly scope = linkedSignal<'STATEMENT' | 'MONTH'>(() =>
    this.statementChoices().length ? 'STATEMENT' : 'MONTH',
  );
  readonly activeChoices = computed(() =>
    this.scope() === 'STATEMENT' ? this.statementChoices() : this.monthChoices(),
  );
  readonly periodOptions = computed<readonly AppSelectOption[]>(() =>
    this.activeChoices().map(({ value, label }) => ({ value, label })),
  );
  readonly period = linkedSignal(() => this.activeChoices()[0]?.value ?? '');
  readonly range = linkedSignal<'SELECTED' | ExportPeriod>(() => 'THREE');
  readonly rangeOptions: readonly AppSelectOption[] = [
    { value: 'SELECTED', label: 'Choose one statement or month' },
    { value: 'THREE', label: 'Last 3 months' },
    { value: 'SIX', label: 'Last 6 months' },
    { value: 'YEAR', label: 'Last 1 year' },
    { value: 'ALL', label: 'All transactions' },
  ];

  setRange(value: string): void {
    this.range.set(value as 'SELECTED' | ExportPeriod);
  }

  setScope(scope: 'STATEMENT' | 'MONTH'): void {
    if (scope === 'STATEMENT' && !this.statementChoices().length) return;
    this.scope.set(scope);
    const choices = scope === 'STATEMENT' ? this.statementChoices() : this.monthChoices();
    this.period.set(choices[0]?.value ?? '');
  }

  export(): void {
    if (this.range() !== 'SELECTED') {
      this.exporter.exportTransactions(
        this.format(),
        this.range() as ExportPeriod,
        this.transactions(),
      );
      this.closed.emit();
      return;
    }
    const choice = this.activeChoices().find((item) => item.value === this.period());
    if (!choice) return;
    this.exporter.exportTransactionSelection(
      this.format(),
      choice.transactions,
      choice.label,
      choice.value,
    );
    this.closed.emit();
  }
}
