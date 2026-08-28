import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { AppIcon } from './app-icon';

export interface AppSelectOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly disabled?: boolean;
  readonly swatch?: string;
  readonly icon?: string;
  readonly iconColour?: string;
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
      @if (selectedOption()?.icon; as icon) {
        <span
          class="option-icon"
          [style.color]="selectedOption()?.iconColour || 'var(--accent)'"
          aria-hidden="true"
        >
          <app-icon [name]="icon" />
        </span>
      }
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
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <div class="picker-top">
            <header>
              <strong>{{ sheetTitle() || label() }}</strong>
              <button type="button" aria-label="Close options" (click)="open.set(false)">
                <app-icon name="close" />
              </button>
            </header>
            @if (searchable()) {
              <label class="picker-search">
                <span class="visually-hidden">Search {{ label().toLowerCase() }}</span>
                <app-icon name="search" aria-hidden="true" />
                <input
                  #searchInput
                  type="search"
                  autocomplete="off"
                  [placeholder]="searchPlaceholder()"
                  [value]="searchQuery()"
                  (input)="updateSearch($event)"
                />
              </label>
            }
          </div>
          <div class="picker-options" role="listbox" [attr.aria-label]="label()">
            @for (option of filteredOptions(); track option.value) {
              <button
                type="button"
                class="picker-option"
                [class.selected]="option.value === value()"
                [disabled]="option.disabled"
                role="option"
                [attr.aria-selected]="option.value === value()"
                (click)="select(option.value)"
              >
                @if (option.icon) {
                  <span
                    class="option-icon"
                    [style.color]="option.iconColour || 'var(--accent)'"
                    aria-hidden="true"
                  >
                    <app-icon [name]="option.icon" />
                  </span>
                }
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
            } @empty {
              <p class="picker-empty" role="status">No matching options</p>
            }
          </div>
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
  readonly searchable = input(false);
  readonly searchPlaceholder = input('Search options');
  readonly options = input.required<readonly AppSelectOption[]>();
  readonly valueChange = output<string>();
  readonly opened = output<void>();
  readonly open = signal(false);
  readonly searchQuery = signal('');
  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly selectedOption = computed(() =>
    this.options().find((option) => option.value === this.value()),
  );
  readonly selectedLabel = computed(() => this.selectedOption()?.label ?? this.placeholder());
  readonly filteredOptions = computed(() => {
    const query = normalizeSearch(this.searchQuery());
    if (!query) return this.options();
    return this.options().filter((option) =>
      normalizeSearch([option.label, option.detail ?? '', option.value].join(' ')).includes(query),
    );
  });

  show(): void {
    if (this.disabled()) return;
    this.searchQuery.set('');
    this.open.set(true);
    this.opened.emit();
    if (this.searchable()) queueMicrotask(() => this.searchInput()?.nativeElement.focus());
  }

  updateSearch(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  select(value: string): void {
    this.valueChange.emit(value);
    this.open.set(false);
  }
}

function normalizeSearch(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
