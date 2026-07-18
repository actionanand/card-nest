import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CardNestStore } from '../core/services/card-nest-store';
import { AppIcon } from './app-icon';

@Component({
  selector: 'app-payment-source-picker',
  imports: [AppIcon],
  template: `
    <div class="picker-field">
      <span class="field-label">{{ label() }}</span>
      <button
        type="button"
        class="picker-trigger"
        [attr.aria-expanded]="open()"
        aria-haspopup="dialog"
        (click)="open.set(true)"
      >
        <span>{{ selectedLabel() }}</span>
        <app-icon name="chevron_down" />
      </button>
    </div>

    @if (open()) {
      <div
        class="picker-backdrop"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="label()"
        tabindex="-1"
        (click)="open.set(false)"
        (keydown.escape)="open.set(false)"
      >
        <div
          class="picker-sheet"
          role="listbox"
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <div class="picker-header">
            <strong>{{ sheetTitle() }}</strong>
            <button type="button" aria-label="Close payment source list" (click)="open.set(false)">
              <app-icon name="close" />
            </button>
          </div>

          @if (allowAutomatic()) {
            <button
              type="button"
              class="picker-option"
              [class.selected]="!value()"
              role="option"
              [attr.aria-selected]="!value()"
              (click)="select('')"
            >
              <span class="option-name">First available source</span>
              <span class="option-detail">Automatic</span>
              @if (!value()) {
                <app-icon class="option-check" name="success" />
              }
            </button>
          }

          @if (store.alphabeticalActiveCards().length) {
            <p class="picker-group">Credit cards</p>
            @for (card of store.alphabeticalActiveCards(); track card.id) {
              <button
                type="button"
                class="picker-option"
                [class.selected]="value() === card.id"
                role="option"
                [attr.aria-selected]="value() === card.id"
                (click)="select(card.id)"
              >
                <span class="option-name">{{ card.nickname }}</span>
                <span class="option-detail">{{ card.lastDigits }} · {{ card.issuerName }}</span>
                @if (value() === card.id) {
                  <app-icon class="option-check" name="success" />
                }
              </button>
            }
          }

          @if (store.activePaymentSources().length) {
            <p class="picker-group">Cash, bank &amp; meal card</p>
            @for (source of store.activePaymentSources(); track source.id) {
              <button
                type="button"
                class="picker-option"
                [class.selected]="value() === source.id"
                role="option"
                [attr.aria-selected]="value() === source.id"
                (click)="select(source.id)"
              >
                <span class="option-name">{{ source.nickname }}</span>
                <span class="option-detail">{{ source.institution || source.kind }}</span>
                @if (value() === source.id) {
                  <app-icon class="option-check" name="success" />
                }
              </button>
            }
          }
        </div>
      </div>
    }
  `,
  styles: `
    :host,
    .picker-field {
      display: grid;
      min-width: 0;
      gap: 0.35rem;
    }
    .field-label {
      color: var(--muted);
      font-size: 0.75rem;
      font-weight: 700;
    }
    .picker-trigger {
      display: flex;
      width: 100%;
      min-height: 2.8rem;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0.65rem 0.75rem;
      border: 1px solid var(--line);
      border-radius: 0.6rem;
      color: var(--ink);
      background: var(--canvas);
      text-align: left;
    }
    .picker-trigger span {
      min-width: 0;
      overflow: hidden;
      flex: 1;
      font-size: 1rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .picker-trigger app-icon {
      width: 1.1rem;
      height: 1.1rem;
      flex: 0 0 auto;
      color: var(--muted);
    }
    .picker-backdrop {
      position: fixed;
      z-index: 1100;
      inset: 0;
      display: flex;
      align-items: flex-end;
      background: rgb(10 25 18 / 55%);
      backdrop-filter: blur(3px);
    }
    .picker-sheet {
      width: 100%;
      max-height: 75dvh;
      padding-bottom: max(1.25rem, env(safe-area-inset-bottom));
      overflow-y: auto;
      border-radius: 1.25rem 1.25rem 0 0;
      background: var(--surface);
      box-shadow: 0 -0.5rem 2rem rgb(8 26 18 / 22%);
    }
    .picker-header {
      position: sticky;
      z-index: 1;
      top: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem 0.75rem;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }
    .picker-header button {
      display: grid;
      width: 2.4rem;
      height: 2.4rem;
      place-items: center;
      border: 0;
      border-radius: 50%;
      color: var(--muted);
      background: var(--canvas);
    }
    .picker-header app-icon,
    .option-check {
      width: 1.05rem;
      height: 1.05rem;
    }
    .picker-group {
      margin: 0.65rem 1.25rem 0.15rem;
      color: var(--muted);
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .picker-option {
      display: flex;
      width: 100%;
      min-height: 3.65rem;
      align-items: center;
      gap: 0.55rem;
      padding: 0.8rem 1.25rem;
      border: 0;
      border-bottom: 1px solid var(--line);
      color: var(--ink);
      background: transparent;
      text-align: left;
    }
    .picker-option.selected {
      background: var(--accent-soft);
    }
    .option-name {
      min-width: 0;
      overflow: hidden;
      flex: 1;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .option-detail {
      flex: 0 1 auto;
      color: var(--muted);
      font-size: 0.78rem;
      text-align: right;
    }
    .option-check {
      flex: 0 0 auto;
      color: var(--accent);
    }
    @media (min-width: 761px) {
      .picker-backdrop {
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
      }
      .picker-sheet {
        width: min(34rem, 100%);
        max-height: min(42rem, calc(100dvh - 3rem));
        border-radius: 1.25rem;
      }
    }
  `,
})
export class PaymentSourcePicker {
  readonly store = inject(CardNestStore);
  readonly value = input('');
  readonly label = input('Pay from');
  readonly sheetTitle = input('Pay from');
  readonly allowAutomatic = input(false);
  readonly valueChange = output<string>();
  readonly open = signal(false);

  readonly selectedLabel = computed(() => {
    if (!this.value()) return this.allowAutomatic() ? 'First available source' : 'Choose a source';
    const card = this.store.activeCards().find((item) => item.id === this.value());
    if (card) return `${card.nickname} · ${card.lastDigits} · ${card.issuerName}`;
    const source = this.store.activePaymentSources().find((item) => item.id === this.value());
    return source
      ? `${source.nickname}${source.institution ? ` · ${source.institution}` : ''}`
      : 'Choose a source';
  });

  select(id: string): void {
    this.valueChange.emit(id);
    this.open.set(false);
  }
}
