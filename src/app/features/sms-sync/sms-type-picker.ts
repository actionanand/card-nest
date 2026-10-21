import {
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { AppIcon } from '../../shared/app-icon';
import { lockDocumentScroll } from '../../shared/document-scroll-lock';
import { SMS_KINDS } from './sms-review-filters';

@Component({
  selector: 'app-sms-type-picker',
  imports: [AppIcon],
  host: { '(window:cardnest:back)': 'back($event)' },
  template: `
    <button
      #trigger
      class="btn"
      type="button"
      aria-haspopup="dialog"
      [attr.aria-expanded]="open()"
      (click)="open.set(true)"
    >
      {{ value().length }} types selected <app-icon name="chevron_down" />
    </button>
    @if (open()) {
      <dialog
        #sheet
        tabindex="-1"
        aria-labelledby="type-picker-title"
        (cancel)="back($event)"
        (click)="outside($event)"
        (keydown)="keyboard($event)"
      >
        <header>
          <div>
            <h2 id="type-picker-title">Select transaction types</h2>
            <p>{{ value().length }} selected · Matches any selected type (OR)</p>
          </div>
          <button
            class="btn"
            type="button"
            aria-label="Close transaction types"
            (click)="open.set(false)"
          >
            <app-icon name="close" />
          </button>
        </header>
        <label
          >Search types<input type="search" [value]="query()" (input)="search($event)"
        /></label>
        <div class="actions">
          <button class="btn" type="button" (click)="changed.emit(all)">Select all</button
          ><button class="btn" type="button" (click)="changed.emit([])">Clear</button>
        </div>
        <div class="options" role="group" aria-label="Available transaction types">
          @for (kind of filtered(); track kind) {
            <label
              ><input
                type="checkbox"
                [checked]="value().includes(kind)"
                (change)="toggle(kind)"
              />{{ label(kind) }}</label
            >
          } @empty {
            <p>No types match this search.</p>
          }
        </div>
        <footer>
          <button class="btn btn-primary" type="button" (click)="open.set(false)">
            Done · {{ value().length }} selected
          </button>
        </footer>
      </dialog>
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
    dialog {
      position: fixed;
      inset: auto 0 0;
      box-sizing: border-box;
      width: min(32rem, 100%);
      max-width: none;
      max-height: calc(100dvh - env(safe-area-inset-top) - 1rem);
      height: min(38rem, 85dvh);
      margin: 0 auto;
      padding: 1rem max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom))
        max(1rem, env(safe-area-inset-left));
      border: 1px solid var(--line);
      border-radius: 1rem 1rem 0 0;
      background: var(--surface);
      color: var(--ink);
      overflow: hidden;
    }
    dialog[open] {
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      gap: 0.75rem;
    }
    dialog::backdrop {
      background: rgb(10 25 18 / 68%);
    }
    header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 0.5rem;
    }
    h2 {
      font-size: 1.1rem;
      margin: 0;
    }
    p {
      font-size: 0.78rem;
      color: var(--muted);
      margin: 0.3rem 0 0;
    }
    label {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      min-height: 44px;
      color: var(--ink);
      font-size: 0.85rem;
    }
    dialog > label {
      display: grid;
      gap: 0.35rem;
    }
    input[type='search'] {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      min-height: 44px;
      background: var(--canvas);
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 0.6rem;
      padding: 0.6rem;
      font: inherit;
    }
    .options {
      overflow: auto;
      overscroll-behavior: contain;
      border-block: 1px solid var(--line);
      padding-block: 0.25rem;
    }
    .options label {
      margin: 0;
      padding: 0.15rem 0.3rem;
    }
    .options input {
      width: 20px;
      height: 20px;
      flex-shrink: 0;
      accent-color: var(--accent);
    }
    .actions {
      display: flex;
      gap: 0.5rem;
    }
    .btn {
      min-height: 44px;
    }
    footer .btn {
      width: 100%;
    }
    :focus-visible {
      outline: 3px solid var(--accent);
      outline-offset: 2px;
    }
  `,
})
export class SmsTypePicker {
  readonly value = input<readonly string[]>([]);
  readonly changed = output<string[]>();
  readonly open = signal(false);
  readonly query = signal('');
  readonly all = [...SMS_KINDS];
  readonly sheet = viewChild<ElementRef<HTMLDialogElement>>('sheet');
  readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  readonly filtered = computed(() =>
    this.all.filter((kind) => this.label(kind).toLowerCase().includes(this.query().toLowerCase())),
  );
  constructor() {
    effect((cleanup) => {
      const sheet = this.sheet()?.nativeElement;
      if (!sheet) return;
      const unlock = lockDocumentScroll();
      if (typeof sheet.showModal === 'function') sheet.showModal();
      else sheet.setAttribute('open', '');
      queueMicrotask(() => {
        if (sheet.isConnected) sheet.querySelector('input')?.focus();
      });
      cleanup(() => {
        unlock();
        if (typeof sheet.close === 'function') sheet.close();
        this.trigger()?.nativeElement.focus();
      });
    });
  }
  label(kind: string): string {
    return kind
      .toLowerCase()
      .replaceAll('_', ' ')
      .replace(/^./, (letter) => letter.toUpperCase());
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
  outside(event: MouseEvent): void {
    const sheet = this.sheet()?.nativeElement;
    if (sheet && event.target === sheet) {
      const rect = sheet.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        this.open.set(false);
    }
  }
  keyboard(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.back(event);
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = this.sheet()?.nativeElement.querySelectorAll<HTMLElement>('button,input');
    if (!nodes?.length) return;
    if (event.shiftKey && document.activeElement === nodes[0]) {
      event.preventDefault();
      nodes[nodes.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) {
      event.preventDefault();
      nodes[0].focus();
    }
  }
}
