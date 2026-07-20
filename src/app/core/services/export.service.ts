import { Service, inject } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { CardTransaction, TransactionType } from '../models/domain';
import {
  ExportDocument,
  ExportFormat,
  ExportPeriod,
  ExportRow,
  ExportSection,
} from '../models/export';
import { CardNestStore } from './card-nest-store';
import { formatMoney } from './money';
import { SnackbarService } from './snackbar.service';

interface CardNestExportPlugin {
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
}

const NativeExport = registerPlugin<CardNestExportPlugin>('CardNestExport');
const EXPENSE_TYPES: readonly TransactionType[] = ['PURCHASE', 'FEE', 'INTEREST'];
const CREDIT_TYPES: readonly TransactionType[] = ['PAYMENT', 'REFUND', 'CASHBACK', 'CREDIT'];

@Service()
export class ExportService {
  private readonly store = inject(CardNestStore);
  private readonly snackbar = inject(SnackbarService);

  exportTransactions(
    format: ExportFormat,
    period: ExportPeriod,
    candidates: readonly CardTransaction[],
  ): void {
    const transactions = this.inPeriod(candidates, period).sort((left, right) =>
      right.transactionDate.localeCompare(left.transactionDate),
    );
    const label = this.periodLabel(period);
    const filename = `cardnest-transactions-${this.filePeriod(period)}`;

    if (format === 'CSV') {
      const csv = this.transactionsCsv(transactions);
      void this.deliverCsv(csv, `${filename}.csv`, `CardNest transactions - ${label}`);
      return;
    }

    const debits = transactions
      .filter((item) => !this.isCredit(item.type))
      .reduce((sum, item) => sum + item.amountMinor, 0);
    const credits = transactions
      .filter((item) => this.isCredit(item.type))
      .reduce((sum, item) => sum + item.amountMinor, 0);
    const sections = this.transactionSections(transactions);
    const document: ExportDocument = {
      title: 'CardNest transaction statement',
      subtitle: label,
      generatedOn: this.generatedOn(),
      summary: [
        { label: 'Transactions', value: String(transactions.length) },
        { label: 'Spent / charged', value: this.money(debits) },
        { label: 'Payments / credits', value: this.money(credits) },
        { label: 'Net outflow', value: this.money(debits - credits) },
      ],
      sections,
    };
    void this.deliverPdf(document, `${filename}.pdf`);
  }

  exportTransactionSelection(
    format: ExportFormat,
    candidates: readonly CardTransaction[],
    label: string,
    filePeriod: string,
  ): void {
    const transactions = [...candidates].sort((left, right) =>
      right.transactionDate.localeCompare(left.transactionDate),
    );
    const filename = `cardnest-transactions-${filePeriod}`;
    if (format === 'CSV') {
      void this.deliverCsv(
        this.transactionsCsv(transactions),
        `${filename}.csv`,
        `CardNest transactions - ${label}`,
      );
      return;
    }
    const debits = transactions
      .filter((item) => !this.isCredit(item.type))
      .reduce((sum, item) => sum + item.amountMinor, 0);
    const credits = transactions
      .filter((item) => this.isCredit(item.type))
      .reduce((sum, item) => sum + item.amountMinor, 0);
    const document: ExportDocument = {
      title: 'CardNest transaction statement',
      subtitle: label,
      generatedOn: this.generatedOn(),
      summary: [
        { label: 'Transactions', value: String(transactions.length) },
        { label: 'Spent / charged', value: this.money(debits) },
        { label: 'Payments / credits', value: this.money(credits) },
        { label: 'Net outflow', value: this.money(debits - credits) },
      ],
      sections: this.transactionSections(transactions),
    };
    void this.deliverPdf(document, `${filename}.pdf`);
  }

  exportStatistics(period: ExportPeriod): void {
    const transactions = this.inPeriod(this.store.transactions(), period);
    const expenses = transactions.filter((item) => EXPENSE_TYPES.includes(item.type));
    const totalSpent = expenses.reduce((sum, item) => sum + item.amountMinor, 0);
    const cycles = this.cycles(period);
    const cycleRows: ExportRow[] = cycles.map((cycle) => {
      const income =
        this.store.incomeHistory().find((item) => item.periodKey === cycle.key)?.amountMinor ??
        (cycle.offset === 0 ? this.store.monthlyIncomeMinor() : 0);
      const expense = expenses
        .filter(
          (item) =>
            item.transactionDate >= cycle.startDate && item.transactionDate <= cycle.endDate,
        )
        .reduce((sum, item) => sum + item.amountMinor, 0);
      const remaining = income - expense;
      return {
        state: remaining < 0 ? 'warning' : 'normal',
        cells: [
          cycle.label,
          this.money(income),
          this.money(expense),
          this.money(remaining),
          `${income ? Math.round((remaining / income) * 100) : 0}%`,
        ],
      };
    });
    const totalIncome = cycleRows.reduce(
      (sum, _, index) => sum + this.cycleIncome(cycles[index]),
      0,
    );
    const remaining = totalIncome - totalSpent;
    const categories = this.breakdown(
      expenses,
      (item) => this.categoryName(item.categoryId),
      totalSpent,
    );
    const sources = this.breakdown(
      expenses,
      (item) => this.store.sourceName(item.cardId),
      totalSpent,
    );
    const sections: ExportSection[] = [
      {
        title: 'Income and expense by budget cycle',
        headers: ['Cycle', 'Income', 'Expense', 'Remaining', 'Savings rate'],
        rows: cycleRows,
      },
      {
        title: 'Category-wise spending',
        headers: ['Category', 'Spent', 'Share'],
        rows: categories,
      },
      {
        title: 'Spending by card and source',
        headers: ['Payment source', 'Spent', 'Share'],
        rows: sources,
      },
      {
        title: 'Largest expenses',
        headers: ['Date', 'Merchant', 'Category', 'Source', 'Amount'],
        rows: [...expenses]
          .sort((left, right) => right.amountMinor - left.amountMinor)
          .slice(0, 15)
          .map((item) => ({
            cells: [
              this.displayDate(item.transactionDate),
              item.merchant || this.typeName(item.type),
              this.categoryName(item.categoryId),
              this.store.sourceName(item.cardId),
              this.money(item.amountMinor),
            ],
          })),
      },
    ];
    const document: ExportDocument = {
      title: 'CardNest spending and budget report',
      subtitle: this.periodLabel(period),
      generatedOn: this.generatedOn(),
      summary: [
        { label: 'Tracked income', value: this.money(totalIncome) },
        { label: 'Expense', value: this.money(totalSpent) },
        { label: 'Remaining', value: this.money(remaining) },
        {
          label: 'Expense / income',
          value: `${totalIncome ? Math.round((totalSpent / totalIncome) * 100) : 0}%`,
        },
      ],
      sections,
    };
    void this.deliverPdf(document, `cardnest-stats-${this.filePeriod(period)}.pdf`);
  }

  private transactionSections(transactions: readonly CardTransaction[]): ExportSection[] {
    const groups = new Map<string, CardTransaction[]>();
    for (const transaction of transactions) {
      const key = transaction.transactionDate.slice(0, 7);
      groups.set(key, [...(groups.get(key) ?? []), transaction]);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([key, items]) => ({
        title: new Date(`${key}-01T12:00:00`).toLocaleDateString('en-IN', {
          month: 'long',
          year: 'numeric',
        }),
        stats: [
          { label: 'Entries', value: String(items.length) },
          {
            label: 'Net',
            value: this.money(
              items.reduce(
                (sum, item) =>
                  sum + (this.isCredit(item.type) ? -item.amountMinor : item.amountMinor),
                0,
              ),
            ),
          },
        ],
        headers: ['Date', 'Transaction', 'Category', 'Payment source', 'Type', 'Amount'],
        rows: items.map((item) => ({
          state: this.isCredit(item.type) ? 'credit' : 'normal',
          cells: [
            this.displayDate(item.transactionDate),
            item.merchant || this.typeName(item.type),
            this.categoryName(item.categoryId),
            this.store.sourceName(item.cardId),
            this.typeName(item.type),
            `${this.isCredit(item.type) ? '+' : '-'}${this.money(item.amountMinor)}`,
          ],
        })),
      }));
  }

  private transactionsCsv(transactions: readonly CardTransaction[]): string {
    const rows: readonly (readonly string[])[] = [
      [
        'Date',
        'Time',
        'Transaction',
        'Type',
        'Category',
        'Payment source',
        'Institution / card',
        'Amount',
        'Direction',
        'Currency',
        'Notes',
      ],
      ...transactions.map((item) => [
        item.transactionDate,
        item.transactionTime ?? '',
        item.merchant ?? '',
        this.typeName(item.type),
        this.categoryName(item.categoryId),
        this.store.sourceName(item.cardId),
        this.store.sourceDetail(item.cardId),
        (item.amountMinor / 100).toFixed(2),
        this.isCredit(item.type) ? 'Credit' : 'Debit',
        item.currencyCode,
        item.notes ?? '',
      ]),
    ];
    return `\uFEFF${rows.map((row) => row.map((cell) => this.csvCell(cell)).join(',')).join('\r\n')}`;
  }

  private breakdown(
    transactions: readonly CardTransaction[],
    nameFor: (transaction: CardTransaction) => string,
    total: number,
  ): ExportRow[] {
    const amounts = new Map<string, number>();
    for (const transaction of transactions) {
      const name = nameFor(transaction);
      amounts.set(name, (amounts.get(name) ?? 0) + transaction.amountMinor);
    }
    return [...amounts.entries()]
      .sort(([, left], [, right]) => right - left)
      .map(([name, amount]) => ({
        cells: [name, this.money(amount), `${total ? Math.round((amount / total) * 100) : 0}%`],
      }));
  }

  private async deliverPdf(document: ExportDocument, filename: string): Promise<void> {
    if (this.isAndroid()) {
      await this.nativeExport(
        () =>
          NativeExport.exportPdf({
            filename,
            content: JSON.stringify(document),
            title: document.title,
          }),
        'PDF',
      );
      return;
    }
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      this.snackbar.show('Allow pop-ups to create the PDF.', 'WARNING');
      return;
    }
    printWindow.document.write(this.documentHtml(document));
    printWindow.document.close();
    window.setTimeout(() => printWindow.print(), 350);
    this.snackbar.show('PDF opened. Choose Save as PDF in the print dialog.');
  }

  private async deliverCsv(content: string, filename: string, title: string): Promise<void> {
    if (this.isAndroid()) {
      await this.nativeExport(() => NativeExport.exportCsv({ filename, content, title }), 'CSV');
      return;
    }
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    this.snackbar.show('CSV downloaded.');
  }

  private async nativeExport(
    operation: () => Promise<{ path: string }>,
    kind: 'PDF' | 'CSV',
  ): Promise<void> {
    this.snackbar.show(`Preparing ${kind} export.`, 'INFO');
    try {
      await Promise.race([
        operation(),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error('Export timed out')), 30000),
        ),
      ]);
      this.snackbar.show(`${kind} saved to Downloads. You can also share it now.`);
    } catch {
      this.snackbar.show(`Unable to export ${kind}.`, 'WARNING');
    }
  }

  private documentHtml(report: ExportDocument): string {
    const sections = report.sections
      .map(
        (section) =>
          `<section><div class="section-title"><h2>${this.html(section.title)}</h2>${
            section.stats?.length
              ? `<p>${section.stats.map((item) => `${this.html(item.label)}: <strong>${this.html(item.value)}</strong>`).join(' &nbsp; ')}</p>`
              : ''
          }</div><table><thead><tr>${section.headers.map((header) => `<th>${this.html(header)}</th>`).join('')}</tr></thead><tbody>${
            section.rows.length
              ? section.rows
                  .map(
                    (row) =>
                      `<tr class="${row.state ?? 'normal'}">${row.cells.map((cell) => `<td>${this.html(cell)}</td>`).join('')}</tr>`,
                  )
                  .join('')
              : `<tr><td colspan="${section.headers.length}">No data in this period.</td></tr>`
          }</tbody></table></section>`,
      )
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${this.html(report.title)}</title><style>
@page{size:A4 portrait;margin:12mm}*{box-sizing:border-box}body{margin:0;color:#14271e;font:8.5px/1.35 Arial,sans-serif}.brand{padding-bottom:12px;border-bottom:3px solid #28684e}.brand h1{margin:0;font:700 21px Georgia,serif}.brand p{margin:4px 0 0;color:#587066}.summary{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;margin:12px 0}.summary div{padding:9px;border:1px solid #d8e2dc;border-radius:8px;background:#f5f8f5}.summary strong{display:block;color:#28684e;font-size:13px}.summary span{color:#587066}section{margin:13px 0;break-inside:auto}.section-title{display:flex;align-items:end;justify-content:space-between;gap:10px;margin-bottom:5px}.section-title h2{margin:0;font:700 14px Georgia,serif}.section-title p{margin:0;color:#587066}table{width:100%;border-collapse:collapse;table-layout:fixed}th{padding:6px 4px;background:#28684e;color:#fff;text-align:left}td{padding:5px 4px;border-bottom:1px solid #dfe7e2;overflow-wrap:anywhere}tr:nth-child(even) td{background:#f5f8f5}tr.credit td:last-child{color:#197447;font-weight:700}tr.warning td{color:#a1342e}.footer{margin-top:16px;padding-top:7px;border-top:1px solid #d8e2dc;color:#587066;text-align:center}thead{display:table-header-group}@media print{section{break-inside:auto}}
</style></head><body><header class="brand"><h1>${this.html(report.title)}</h1><p>${this.html(report.subtitle)} &middot; Generated ${this.html(report.generatedOn)}</p></header><div class="summary">${report.summary.map((item) => `<div><strong>${this.html(item.value)}</strong><span>${this.html(item.label)}</span></div>`).join('')}</div>${sections}<footer class="footer">CardNest &middot; Private, local-first money tracking</footer></body></html>`;
  }

  private inPeriod(
    transactions: readonly CardTransaction[],
    period: ExportPeriod,
  ): CardTransaction[] {
    const range = this.periodRange(period);
    return transactions.filter(
      (item) =>
        !range ||
        (item.transactionDate >= range.startDate && item.transactionDate <= range.endDate),
    );
  }

  private periodRange(period: ExportPeriod): { startDate: string; endDate: string } | null {
    if (period === 'ALL') return null;
    const count = this.periodCount(period);
    const first = this.cycle(count - 1);
    const last = this.cycle(0);
    return { startDate: first.startDate, endDate: last.endDate };
  }

  private cycles(period: ExportPeriod) {
    const count =
      period === 'ALL'
        ? Math.max(1, Math.min(120, this.store.incomeHistory().length || 12))
        : this.periodCount(period);
    return Array.from({ length: count }, (_, index) => this.cycle(count - index - 1));
  }

  private cycle(offset: number) {
    const startDay = this.store.budgetCycleStartDay();
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), startDay, 12);
    if (now.getDate() < startDay) start.setMonth(start.getMonth() - 1);
    start.setMonth(start.getMonth() - offset);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, startDay - 1, 12);
    return {
      offset,
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      label: `${this.shortDate(start)} - ${this.shortDate(end)}`,
      startDate: this.localDate(start),
      endDate: this.localDate(end),
    };
  }

  private cycleIncome(cycle: ReturnType<ExportService['cycle']>): number {
    return (
      this.store.incomeHistory().find((item) => item.periodKey === cycle.key)?.amountMinor ??
      (cycle.offset === 0 ? this.store.monthlyIncomeMinor() : 0)
    );
  }

  private periodCount(period: Exclude<ExportPeriod, 'ALL'>): number {
    return { MONTH: 1, THREE: 3, SIX: 6, YEAR: 12 }[period];
  }

  private periodLabel(period: ExportPeriod): string {
    if (period === 'ALL') return 'All recorded transactions';
    const range = this.periodRange(period);
    return range
      ? `${this.displayDate(range.startDate)} - ${this.displayDate(range.endDate)}`
      : 'All recorded transactions';
  }

  private filePeriod(period: ExportPeriod): string {
    return period.toLocaleLowerCase();
  }

  private money(value: number): string {
    return formatMoney(value, 'INR');
  }

  private categoryName(categoryId: string): string {
    return this.store.categories().find((item) => item.id === categoryId)?.name ?? 'Other';
  }

  private typeName(type: TransactionType): string {
    return type.charAt(0) + type.slice(1).toLocaleLowerCase().replaceAll('_', ' ');
  }

  private isCredit(type: TransactionType): boolean {
    return CREDIT_TYPES.includes(type);
  }

  private displayDate(value: string): string {
    return new Date(`${value}T12:00:00`).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  private shortDate(value: Date): string {
    return value.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  private localDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  private generatedOn(): string {
    return new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' });
  }

  private csvCell(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
  }

  private html(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  private isAndroid(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  }
}
