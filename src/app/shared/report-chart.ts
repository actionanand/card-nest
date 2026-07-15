import {
  afterNextRender,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartConfiguration,
  type TooltipItem,
} from 'chart.js';
import { ThemeService } from '../core/services/theme.service';

export type ReportChartKind = 'doughnut' | 'bar' | 'column' | 'line' | 'comparison';

Chart.register(
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  DoughnutController,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
);

@Component({
  selector: 'app-report-chart',
  template: `
    <div
      class="chart-frame"
      [class.chart-frame--bar]="kind() === 'bar'"
      [class.chart-frame--trend]="kind() === 'line' || kind() === 'comparison'"
    >
      <canvas #chartCanvas role="img" [attr.aria-label]="accessibleLabel()"></canvas>
    </div>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      min-width: 0;
    }

    .chart-frame {
      position: relative;
      width: 100%;
      height: 14rem;
    }

    .chart-frame--bar {
      height: clamp(14rem, 32vw, 20rem);
    }

    .chart-frame--trend {
      height: clamp(16rem, 36vw, 23rem);
    }

    canvas {
      max-width: 100%;
    }

    @media (max-width: 600px) {
      .chart-frame {
        height: 12rem;
      }

      .chart-frame--bar {
        height: 15rem;
      }
    }
  `,
})
export class ReportChart {
  readonly kind = input.required<ReportChartKind>();
  readonly labels = input.required<readonly string[]>();
  readonly values = input.required<readonly number[]>();
  readonly colours = input.required<readonly string[]>();
  readonly secondaryValues = input<readonly number[]>([]);
  readonly datasetLabels = input<readonly string[]>([]);
  readonly accessibleLabel = input.required<string>();

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('chartCanvas');
  private readonly theme = inject(ThemeService);
  private readonly ready = signal(false);
  private chart: Chart | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.chart?.destroy());

    afterNextRender(() => this.ready.set(true));

    effect(() => {
      const snapshot = {
        kind: this.kind(),
        labels: [...this.labels()],
        values: [...this.values()],
        colours: [...this.colours()],
        secondaryValues: [...this.secondaryValues()],
        datasetLabels: [...this.datasetLabels()],
        appTheme: this.theme.theme(),
      };
      if (!this.ready()) return;
      this.render(snapshot);
    });
  }

  private render(snapshot: {
    kind: ReportChartKind;
    labels: string[];
    values: number[];
    colours: string[];
    secondaryValues: number[];
    datasetLabels: string[];
  }): void {
    this.chart?.destroy();
    const canvas = this.canvas().nativeElement;
    const styles = getComputedStyle(canvas);
    const ink = styles.getPropertyValue('--ink').trim() || '#173c2d';
    const muted = styles.getPropertyValue('--muted').trim() || '#66776f';
    const line = styles.getPropertyValue('--line').trim() || '#d9e2dc';
    const fallbackColour = styles.getPropertyValue('--accent').trim() || '#28684e';
    const colours = snapshot.colours.length
      ? snapshot.colours
      : snapshot.values.map(() => fallbackColour);

    if (snapshot.kind === 'doughnut') {
      const configuration: ChartConfiguration<'doughnut', number[], string> = {
        type: 'doughnut',
        data: {
          labels: snapshot.labels,
          datasets: [
            {
              data: snapshot.values,
              backgroundColor: colours,
              borderColor: styles.getPropertyValue('--surface').trim() || '#ffffff',
              borderWidth: 3,
              hoverOffset: 5,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '68%',
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: this.doughnutTooltipLabel } },
          },
        },
      };
      this.chart = new Chart(canvas, configuration);
      return;
    }

    if (snapshot.kind === 'line') {
      const configuration: ChartConfiguration<'line', number[], string> = {
        type: 'line',
        data: {
          labels: snapshot.labels,
          datasets: [
            {
              label: snapshot.datasetLabels[0] ?? 'Expense',
              data: snapshot.values,
              borderColor: colours[0] ?? '#d84a42',
              backgroundColor: `${colours[0] ?? '#d84a42'}22`,
              pointBackgroundColor: colours[0] ?? '#d84a42',
              fill: true,
              tension: 0.32,
            },
            {
              label: snapshot.datasetLabels[1] ?? 'Remaining',
              data: snapshot.secondaryValues,
              borderColor: colours[1] ?? '#3b9b53',
              backgroundColor: `${colours[1] ?? '#3b9b53'}18`,
              pointBackgroundColor: colours[1] ?? '#3b9b53',
              fill: true,
              tension: 0.32,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: { legend: { labels: { color: ink } } },
          scales: {
            x: { border: { display: false }, grid: { display: false }, ticks: { color: muted } },
            y: {
              beginAtZero: true,
              border: { display: false },
              grid: { color: line },
              ticks: { color: muted, callback: (value) => this.compactCurrency(Number(value)) },
            },
          },
        },
      };
      this.chart = new Chart(canvas, configuration);
      return;
    }

    if (snapshot.kind === 'comparison') {
      const configuration: ChartConfiguration<'bar', number[], string> = {
        type: 'bar',
        data: {
          labels: snapshot.labels,
          datasets: [
            {
              label: snapshot.datasetLabels[0] ?? 'Income',
              data: snapshot.values,
              backgroundColor: colours[0] ?? '#397bd1',
              borderRadius: 6,
            },
            {
              label: snapshot.datasetLabels[1] ?? 'Expense',
              data: snapshot.secondaryValues,
              backgroundColor: colours[1] ?? '#d84a42',
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: ink } } },
          scales: {
            x: { border: { display: false }, grid: { display: false }, ticks: { color: muted } },
            y: {
              beginAtZero: true,
              border: { display: false },
              grid: { color: line },
              ticks: { color: muted, callback: (value) => this.compactCurrency(Number(value)) },
            },
          },
        },
      };
      this.chart = new Chart(canvas, configuration);
      return;
    }

    const configuration: ChartConfiguration<'bar', number[], string> = {
      type: 'bar',
      data: {
        labels: snapshot.labels,
        datasets: [
          {
            data: snapshot.values,
            backgroundColor:
              snapshot.kind === 'column' ? snapshot.values.map(() => colours[0]) : colours,
            borderRadius: 7,
            borderSkipped: false,
            barThickness: 18,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: snapshot.kind === 'bar' ? 'y' : 'x',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: this.barTooltipLabel } },
        },
        scales: {
          x: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: line },
            ticks: {
              color: muted,
              callback: (value) => this.compactCurrency(Number(value)),
            },
          },
          y: {
            border: { display: false },
            grid: { display: false },
            ticks: { color: ink },
          },
        },
      },
    };
    this.chart = new Chart(canvas, configuration);
  }

  private readonly doughnutTooltipLabel = (context: TooltipItem<'doughnut'>): string =>
    ` ${this.currency(Number(context.raw))}`;

  private readonly barTooltipLabel = (context: TooltipItem<'bar'>): string =>
    ` ${this.currency(Number(context.raw))}`;

  private currency(value: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(value);
  }

  private compactCurrency(value: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }
}
