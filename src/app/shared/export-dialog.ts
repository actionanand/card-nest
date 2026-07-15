import { Component, inject, input, linkedSignal, output, signal } from '@angular/core';
import { CardTransaction } from '../core/models/domain';
import { ExportFormat, ExportPeriod } from '../core/models/export';
import { ExportService } from '../core/services/export.service';
import { AppIcon } from './app-icon';

@Component({
  selector: 'app-export-dialog',
  imports: [AppIcon],
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
          <legend>Budget-cycle period</legend>
          <div class="choices periods">
            @for (choice of periods; track choice.value) {
              <label>
                <input
                  type="radio"
                  name="export-period"
                  [value]="choice.value"
                  [checked]="period() === choice.value"
                  (change)="period.set(choice.value)"
                />
                <span
                  ><strong>{{ choice.label }}</strong></span
                >
              </label>
            }
          </div>
        </fieldset>
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
  readonly initialFormat = input<ExportFormat>('PDF');
  readonly closed = output<void>();
  readonly format = linkedSignal(() => this.initialFormat());
  readonly period = signal<ExportPeriod>('MONTH');
  readonly periods: readonly { value: ExportPeriod; label: string }[] = [
    { value: 'MONTH', label: 'This cycle' },
    { value: 'THREE', label: '3 months' },
    { value: 'SIX', label: '6 months' },
    { value: 'YEAR', label: '1 year' },
    { value: 'ALL', label: 'All time' },
  ];

  export(): void {
    this.exporter.exportTransactions(this.format(), this.period(), this.transactions());
    this.closed.emit();
  }
}
