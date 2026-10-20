import {
  Component,
  ElementRef,
  computed,
  effect,
  forwardRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { AppIcon } from './app-icon';
import { lockDocumentScroll } from './document-scroll-lock';

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
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => AppSelectPicker), multi: true },
  ],
  host: { '(window:cardnest:back)': 'androidBack($event)' },
  template: `
    @if (!hideLabel()) {
      <span class="field-label">{{ label() }}</span>
    }
    <button
      type="button"
      #trigger
      class="picker-trigger"
      [disabled]="isDisabled()"
      [attr.aria-label]="label() + ': ' + selectedLabel()"
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
      <dialog
        #pickerDialog
        class="picker-backdrop"
        aria-modal="true"
        [attr.aria-label]="sheetTitle() || label()"
        tabindex="-1"
        (click)="close()"
        (cancel)="$event.preventDefault(); close()"
        (keydown.escape)="$event.stopPropagation()"
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
              <button type="button" aria-label="Close options" (click)="close()">
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
          <div
            class="picker-options"
            role="listbox"
            tabindex="0"
            [attr.aria-label]="label()"
            (keydown)="navigateOptions($event)"
          >
            @for (option of filteredOptions(); track option.value) {
              <button
                type="button"
                class="picker-option"
                [class.selected]="option.value === currentValue()"
                [disabled]="option.disabled"
                role="option"
                [attr.aria-selected]="option.value === currentValue()"
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
                @if (option.value === currentValue()) {
                  <app-icon class="option-check" name="success" />
                }
              </button>
            } @empty {
              <p class="picker-empty" role="status">No matching options</p>
            }
          </div>
        </div>
      </dialog>
    }
  `,
  styleUrl: './app-select-picker.scss',
})
export class AppSelectPicker implements ControlValueAccessor {
  readonly label = input.required<string>();
  readonly sheetTitle = input('');
  readonly value = input('');
  readonly placeholder = input('Choose an option');
  readonly hint = input('');
  readonly disabled = input(false);
  readonly hideLabel = input(false);
  private readonly formValue = signal<string | null>(null);
  private readonly formDisabled = signal(false);
  readonly currentValue = computed(() => this.formValue() ?? this.value());
  readonly isDisabled = computed(() => this.disabled() || this.formDisabled());
  private changed: (value: string) => void = () => undefined;
  private touched: () => void = () => undefined;
  readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  readonly pickerDialog = viewChild<ElementRef<HTMLDialogElement>>('pickerDialog');
  constructor() {
    effect((cleanup) => {
      const dialog = this.pickerDialog()?.nativeElement;
      if (!dialog) return;
      const releaseScroll = lockDocumentScroll();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      if (this.searchable()) queueMicrotask(() => this.searchInput()?.nativeElement.focus());
      cleanup(() => {
        releaseScroll();
        if (typeof dialog.close === 'function') dialog.close();
        this.trigger()?.nativeElement.focus();
      });
    });
  }
  writeValue(value: unknown): void {
    this.formValue.set(typeof value === 'string' ? value : '');
  }
  registerOnChange(fn: (value: string) => void): void {
    this.changed = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.touched = fn;
  }
  setDisabledState(value: boolean): void {
    this.formDisabled.set(value);
  }
  close(): void {
    this.open.set(false);
    this.touched();
  }
  androidBack(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.close();
  }
  navigateOptions(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [
      ...(this.pickerDialog()?.nativeElement.querySelectorAll<HTMLButtonElement>(
        '.picker-option:not(:disabled)',
      ) ?? []),
    ];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : index < 0
            ? event.key === 'ArrowDown'
              ? 0
              : buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
  readonly searchable = input(false);
  readonly searchPlaceholder = input('Search options');
  readonly options = input.required<readonly AppSelectOption[]>();
  readonly valueChange = output<string>();
  readonly opened = output<void>();
  readonly open = signal(false);
  readonly searchQuery = signal('');
  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly selectedOption = computed(() =>
    this.options().find((option) => option.value === this.currentValue()),
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
    if (this.isDisabled()) return;
    this.searchQuery.set('');
    this.open.set(true);
    this.opened.emit();
  }

  updateSearch(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  select(value: string): void {
    if (
      this.isDisabled() ||
      !this.options().some((option) => option.value === value && !option.disabled)
    )
      return;
    if (this.formValue() !== null) this.formValue.set(value);
    this.changed(value);
    this.valueChange.emit(value);
    this.close();
  }
}

function normalizeSearch(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
