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
  Legend,
  LinearScale,
  Tooltip,
  type ChartConfiguration,
  type TooltipItem,
} from 'chart.js';
import { ThemeService } from '../core/services/theme.service';

export type ReportChartKind = 'doughnut' | 'bar';

Chart.register(
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  DoughnutController,
  Legend,
  LinearScale,
  Tooltip,
);

@Component({
  selector: 'app-report-chart',
  template: `
    <div class="chart-frame" [class.chart-frame--bar]="kind() === 'bar'">
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
  readonly accessibleLabel = input.required<string>();

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('chartCanvas');
  private readonly theme = inject(ThemeService);
  private readonly ready = signal(false);
  private chart: Chart<'doughnut', number[], string> | Chart<'bar', number[], string> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.chart?.destroy());

    afterNextRender(() => this.ready.set(true));

    effect(() => {
      const snapshot = {
        kind: this.kind(),
        labels: [...this.labels()],
        values: [...this.values()],
        colours: [...this.colours()],
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

    const configuration: ChartConfiguration<'bar', number[], string> = {
      type: 'bar',
      data: {
        labels: snapshot.labels,
        datasets: [
          {
            data: snapshot.values,
            backgroundColor: colours,
            borderRadius: 7,
            borderSkipped: false,
            barThickness: 18,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
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
