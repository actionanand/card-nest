import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import { AppIcon } from './app-icon';
import { lockDocumentScroll } from './document-scroll-lock';

@Component({
  selector: 'app-backup-delivery-dialog',
  imports: [AppIcon],
  host: { '(window:cardnest:back)': 'back($event)' },
  template: `
    <dialog #sheet aria-labelledby="backup-ready-title" (cancel)="$event.preventDefault(); close()">
      <header>
        <app-icon name="privacy" />
        <h2 id="backup-ready-title" tabindex="-1" autofocus>Backup ready</h2>
      </header>
      <p>Your encrypted backup is ready. Choose where to keep it.</p>
      <p class="filename">{{ filename() }}</p>
      <div class="choices">
        <button class="choice" type="button" [disabled]="busy()" (click)="save.emit()">
          <app-icon name="download" /><span
            ><strong>Save locally</strong><small>Choose a folder or document provider</small></span
          ><app-icon name="chevron_right" />
        </button>
        <button
          class="choice"
          type="button"
          [disabled]="busy() || !canShare()"
          (click)="share.emit()"
        >
          <app-icon name="cloud_backup" /><span
            ><strong>Share Backup</strong
            ><small>Choose an installed app or cloud storage</small></span
          ><app-icon name="chevron_right" />
        </button>
      </div>
      @if (!canShare()) {
        <p class="hint">File sharing is unavailable in this browser. You can still save locally.</p>
      }
      <p class="hint">Only the encrypted file is shared. Keep its passphrase separately.</p>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (busy()) {
        <p role="status">Opening…</p>
      }
      <button class="btn cancel" type="button" [disabled]="busy()" (click)="close()">Cancel</button>
    </dialog>
  `,
  styles: `
    dialog {
      position: fixed;
      inset: auto 0 0;
      margin: 0 auto;
      box-sizing: border-box;
      width: min(30rem, 100%);
      max-width: none;
      max-height: calc(100dvh - env(safe-area-inset-top) - 1rem);
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 1rem max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom))
        max(1rem, env(safe-area-inset-left));
      border: 1px solid var(--line);
      border-radius: 1rem 1rem 0 0;
      color: var(--ink);
      background: var(--surface);
    }
    dialog::backdrop {
      background: rgb(10 25 18 / 68%);
    }
    header {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    header app-icon {
      color: var(--accent);
    }
    h2 {
      margin: 0;
      font-size: 1.15rem;
    }
    p {
      font-size: 0.85rem;
      line-height: 1.5;
    }
    .filename {
      color: var(--muted);
      font-size: 0.75rem;
      overflow-wrap: anywhere;
    }
    .choices {
      display: grid;
      gap: 0.6rem;
    }
    .choice {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.7rem;
      min-height: 44px;
      padding: 0.8rem;
      border: 1px solid var(--line);
      border-radius: 0.7rem;
      color: var(--ink);
      background: var(--surface-2);
      text-align: start;
      font: inherit;
    }
    .choice > app-icon {
      color: var(--accent);
    }
    .choice span {
      display: grid;
      gap: 0.25rem;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    strong {
      font-size: 0.85rem;
    }
    small,
    .hint {
      color: var(--muted);
      font-size: 0.75rem;
      line-height: 1.4;
    }
    .choice:enabled:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button:focus-visible {
      outline: 3px solid var(--accent);
      outline-offset: 3px;
    }
    .cancel {
      width: 100%;
      margin-top: 0.5rem;
    }
    .error {
      color: var(--danger);
    }
  `,
})
export class BackupDeliveryDialog {
  readonly filename = input.required<string>();
  readonly busy = input(false);
  readonly canShare = input(false);
  readonly error = input<string | null>(null);
  readonly save = output<void>();
  readonly share = output<void>();
  readonly dismissed = output<void>();
  readonly sheet = viewChild<ElementRef<HTMLDialogElement>>('sheet');
  constructor() {
    effect((cleanup) => {
      const dialog = this.sheet()?.nativeElement;
      if (!dialog) return;
      const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const release = lockDocumentScroll();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      cleanup(() => {
        release();
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
        if (trigger?.isConnected) trigger.focus();
      });
    });
  }
  close(): void {
    if (!this.busy()) this.dismissed.emit();
  }
  back(event: Event): void {
    event.preventDefault();
    this.close();
  }
}
