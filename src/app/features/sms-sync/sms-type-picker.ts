import { Component, computed, input, output, signal } from '@angular/core';
import { AppIcon } from '../../shared/app-icon';
import { SMS_KINDS } from './sms-review-filters';

@Component({
  selector: 'app-sms-type-picker',
  imports: [AppIcon],
  host: { '(window:cardnest:back)': 'back($event)', '(keydown.escape)': 'back($event)' },
  template: `
    <button class="btn" type="button" [attr.aria-expanded]="open()" (click)="open.set(!open())">
      {{ value().length }} types · OR <app-icon name="chevron_down" />
    </button>
    @if (open()) {
      <div class="picker" role="group" aria-label="Multiple transaction types">
        <label
          >Search types<input type="search" [value]="query()" (input)="search($event)"
        /></label>
        <div class="actions">
          <button class="btn" type="button" (click)="changed.emit(all)">Select all</button
          ><button class="btn" type="button" (click)="changed.emit([])">Clear</button
          ><button class="btn" type="button" (click)="open.set(false)">Done</button>
        </div>
        <div class="options">
          @for (kind of filtered(); track kind) {
            <label
              ><input
                type="checkbox"
                [checked]="value().includes(kind)"
                (change)="toggle(kind)"
              />{{ label(kind) }}</label
            >
          }
        </div>
      </div>
    }
    @if (!value().length) {
      <p role="status">No types selected. Choose at least one type to see results.</p>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: 0.5rem;
      min-width: 0;
    }
    .picker {
      border: 1px solid var(--line);
      border-radius: 0.7rem;
      padding: 0.7rem;
      background: var(--surface);
    }
    label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-height: 44px;
      color: var(--ink);
      font-size: 0.8rem;
    }
    label:has(input[type='search']) {
      display: grid;
    }
    input[type='search'] {
      width: 100%;
      min-width: 0;
    }
    .options {
      max-height: 15rem;
      overflow: auto;
      overscroll-behavior: contain;
    }
    .options input {
      width: 20px;
      height: 20px;
      accent-color: var(--accent);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }
    .btn {
      min-height: 44px;
    }
    p {
      font-size: 0.8rem;
      color: var(--muted);
      margin: 0;
    }
  `,
})
export class SmsTypePicker {
  readonly value = input<readonly string[]>([]);
  readonly changed = output<string[]>();
  readonly open = signal(false);
  readonly query = signal('');
  readonly all = [...SMS_KINDS];
  readonly filtered = computed(() =>
    this.all.filter((kind) => this.label(kind).toLowerCase().includes(this.query().toLowerCase())),
  );
  label(kind: string): string {
    return kind.toLowerCase().replaceAll('_', ' ');
  }
  search(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
  toggle(kind: string): void {
    this.changed.emit(
      this.value().includes(kind)
        ? this.value().filter((value) => value !== kind)
        : [...this.value(), kind],
    );
  }
  back(event: Event): void {
    if (this.open()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.open.set(false);
    }
  }
}
