import { Component, computed, input, output, signal } from '@angular/core';
import { AppIcon } from './app-icon';

interface CalendarCell {
  readonly value: string;
  readonly day: number;
  readonly selected: boolean;
  readonly today: boolean;
}

@Component({
  selector: 'app-date-picker',
  imports: [AppIcon],
  template: `
    <span class="field-label">{{ label() }}</span>
    <button type="button" class="date-trigger" aria-haspopup="dialog" (click)="show()">
      <span>{{ selectedLabel() }}</span>
      <app-icon name="schedule" />
    </button>

    @if (open()) {
      <div
        class="date-backdrop"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="label()"
        tabindex="-1"
        (click)="open.set(false)"
        (keydown.escape)="open.set(false)"
      >
        <section
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <header>
            <button type="button" aria-label="Previous month" (click)="moveMonth(-1)">
              <app-icon name="back" />
            </button>
            <strong>{{ monthLabel() }}</strong>
            <button type="button" aria-label="Next month" (click)="moveMonth(1)">
              <app-icon name="chevron_right" />
            </button>
          </header>
          <div class="weekdays" aria-hidden="true">
            @for (day of weekdays; track day) {
              <span>{{ day }}</span>
            }
          </div>
          <div class="calendar" role="grid">
            @for (blank of leadingBlanks(); track $index) {
              <span></span>
            }
            @for (cell of calendarCells(); track cell.value) {
              <button
                type="button"
                [class.selected]="cell.selected"
                [class.today]="cell.today"
                [attr.aria-label]="dateLabel(cell.value)"
                [attr.aria-selected]="cell.selected"
                (click)="choose(cell.value)"
              >
                {{ cell.day }}
              </button>
            }
          </div>
          <footer>
            <button type="button" class="today-button" (click)="choose(today)">Today</button>
            <button type="button" class="close-button" (click)="open.set(false)">Cancel</button>
          </footer>
        </section>
      </div>
    }
  `,
  styleUrl: './app-date-picker.scss',
})
export class AppDatePicker {
  readonly label = input('Date');
  readonly value = input.required<string>();
  readonly valueChange = output<string>();
  readonly open = signal(false);
  readonly viewMonth = signal(new Date().toISOString().slice(0, 7));
  readonly weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  readonly today = new Date().toISOString().slice(0, 10);

  readonly selectedLabel = computed(() => this.dateLabel(this.value()));
  readonly monthLabel = computed(() => {
    const [year, month] = this.viewMonth().split('-').map(Number);
    return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(
      new Date(year, month - 1, 1),
    );
  });
  readonly leadingBlanks = computed(() => {
    const [year, month] = this.viewMonth().split('-').map(Number);
    return Array.from({ length: new Date(year, month - 1, 1).getDay() });
  });
  readonly calendarCells = computed<readonly CalendarCell[]>(() => {
    const [year, month] = this.viewMonth().split('-').map(Number);
    const count = new Date(year, month, 0).getDate();
    return Array.from({ length: count }, (_, index) => {
      const day = index + 1;
      const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { value, day, selected: value === this.value(), today: value === this.today };
    });
  });

  show(): void {
    this.viewMonth.set((this.value() || this.today).slice(0, 7));
    this.open.set(true);
  }

  moveMonth(offset: number): void {
    const [year, month] = this.viewMonth().split('-').map(Number);
    const next = new Date(year, month - 1 + offset, 1);
    this.viewMonth.set(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  }

  choose(value: string): void {
    this.valueChange.emit(value);
    this.open.set(false);
  }

  dateLabel(value: string): string {
    const [year, month, day] = value.split('-').map(Number);
    if (!year || !month || !day) return 'Choose a date';
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(year, month - 1, day));
  }
}
