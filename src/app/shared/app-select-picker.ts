import { Component, computed, input, output, signal } from '@angular/core';
import { AppIcon } from './app-icon';

export interface AppSelectOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly disabled?: boolean;
  readonly swatch?: string;
}

@Component({
  selector: 'app-select-picker',
  imports: [AppIcon],
  template: `
    <span class="field-label">{{ label() }}</span>
    <button
      type="button"
      class="picker-trigger"
      [disabled]="disabled()"
      [attr.aria-expanded]="open()"
      aria-haspopup="dialog"
      (click)="show()"
    >
      @if (selectedOption()?.swatch; as swatch) {
        <span class="option-swatch" [style.background-color]="swatch"></span>
      }
      <span>{{ selectedLabel() }}</span>
      <app-icon name="chevron_down" />
    </button>
    @if (hint()) {
      <small>{{ hint() }}</small>
    }

    @if (open()) {
      <div
        class="picker-backdrop"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="sheetTitle() || label()"
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
          <header>
            <strong>{{ sheetTitle() || label() }}</strong>
            <button type="button" aria-label="Close options" (click)="open.set(false)">
              <app-icon name="close" />
            </button>
          </header>
          @for (option of options(); track option.value) {
            <button
              type="button"
              class="picker-option"
              [class.selected]="option.value === value()"
              [disabled]="option.disabled"
              role="option"
              [attr.aria-selected]="option.value === value()"
              (click)="select(option.value)"
            >
              @if (option.swatch) {
                <span class="option-swatch" [style.background-color]="option.swatch"></span>
              }
              <span class="option-copy">
                <strong>{{ option.label }}</strong>
                @if (option.detail) {
                  <small>{{ option.detail }}</small>
                }
              </span>
              @if (option.value === value()) {
                <app-icon class="option-check" name="success" />
              }
            </button>
          }
        </div>
      </div>
    }
  `,
  styleUrl: './app-select-picker.scss',
})
export class AppSelectPicker {
  readonly label = input.required<string>();
  readonly sheetTitle = input('');
  readonly value = input('');
  readonly placeholder = input('Choose an option');
  readonly hint = input('');
  readonly disabled = input(false);
  readonly options = input.required<readonly AppSelectOption[]>();
  readonly valueChange = output<string>();
  readonly opened = output<void>();
  readonly open = signal(false);

  readonly selectedOption = computed(() =>
    this.options().find((option) => option.value === this.value()),
  );
  readonly selectedLabel = computed(() => this.selectedOption()?.label ?? this.placeholder());

  show(): void {
    if (this.disabled()) return;
    this.open.set(true);
    this.opened.emit();
  }

  select(value: string): void {
    this.valueChange.emit(value);
    this.open.set(false);
  }
}
