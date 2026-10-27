import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import { lockDocumentScroll } from './document-scroll-lock';

/** Native top-layer dialog composes with the existing picker dialogs and shared scroll locks. */
@Component({
  selector: 'app-profile-modal',
  template: `<dialog
    #dialog
    tabindex="-1"
    class="profile-modal"
    [attr.aria-labelledby]="titleId"
    (cancel)="cancel($event)"
    (click)="backdrop($event)"
    (keydown)="key($event)"
  >
    <header>
      <h2 [id]="titleId">{{ title() }}</h2>
      <button
        class="btn"
        type="button"
        [disabled]="busy()"
        (click)="closed.emit()"
        aria-label="Close profile dialog"
      >
        Close
      </button>
    </header>
    <div class="modal-content"><ng-content /></div>
  </dialog>`,
  host: { '(window:cardnest:back)': 'back($event)' },
  styles: `
    :host {
      display: contents;
    }
    dialog {
      position: fixed;
      inset: 0;
      box-sizing: border-box;
      width: min(40rem, calc(100% - 1.5rem));
      max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 1.5rem);
      margin: auto;
      padding: 0;
      border: 1px solid var(--line);
      border-radius: 1rem;
      color: var(--ink);
      background: var(--surface);
      overflow: auto;
      overscroll-behavior: contain;
      box-shadow: 0 1rem 4rem #0005;
    }
    dialog::backdrop {
      background: rgb(8 22 16 / 65%);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      gap: 0.75rem;
      align-items: center;
      justify-content: space-between;
      padding: 1rem;
      background: var(--surface);
      border-bottom: 1px solid var(--line);
    }
    h2 {
      margin: 0;
      font-size: 1.15rem;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    button {
      min-height: 44px;
    }
    .modal-content {
      padding: 1rem;
      min-width: 0;
    }
    @media (max-width: 480px) {
      dialog {
        width: 100%;
        max-height: calc(100dvh - env(safe-area-inset-top) - 0.75rem);
        margin: auto 0 0;
        border-radius: 1rem 1rem 0 0;
        padding-bottom: env(safe-area-inset-bottom);
      }
      header {
        padding-inline: max(1rem, env(safe-area-inset-left)) max(1rem, env(safe-area-inset-right));
      }
      .modal-content {
        padding-inline: max(1rem, env(safe-area-inset-left)) max(1rem, env(safe-area-inset-right));
      }
    }
  `,
})
export class ProfileModal {
  readonly title = input.required<string>();
  readonly busy = input(false);
  readonly closed = output<void>();
  readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  readonly titleId = 'profile-title-' + crypto.randomUUID();
  constructor() {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    effect((cleanup) => {
      const dialog = this.dialog()?.nativeElement;
      if (!dialog) return;
      const unlock = lockDocumentScroll();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      queueMicrotask(() => {
        if (dialog.isConnected)
          dialog
            .querySelector<HTMLElement>(
              'input:not([type="checkbox"]),textarea,app-select-picker button',
            )
            ?.focus();
      });
      cleanup(() => {
        unlock();
        if (typeof dialog.close === 'function') dialog.close();
        if (previous?.isConnected) previous.focus();
      });
    });
  }
  private nested(): boolean {
    return !!document.querySelector('app-select-picker dialog[open]');
  }
  cancel(event: Event): void {
    event.preventDefault();
    if (!this.busy() && !this.nested()) this.closed.emit();
  }
  backdrop(event: MouseEvent): void {
    if (event.target === this.dialog()?.nativeElement) {
      const rect = this.dialog()!.nativeElement.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        this.cancel(event);
    }
  }
  back(event: Event): void {
    if (event.defaultPrevented || this.nested()) return;
    event.preventDefault();
    if (!this.busy()) this.closed.emit();
  }
  key(event: KeyboardEvent): void {
    if (this.nested()) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.cancel(event);
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [
      ...this.dialog()!.nativeElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
      ),
    ].filter((node) => !node.closest('[hidden]'));
    const first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}
