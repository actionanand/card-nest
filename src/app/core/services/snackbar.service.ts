import { Service, signal } from '@angular/core';

export type SnackbarTone = 'SUCCESS' | 'INFO' | 'WARNING';

export interface SnackbarMessage {
  readonly id: number;
  readonly text: string;
  readonly tone: SnackbarTone;
}

@Service()
export class SnackbarService {
  readonly message = signal<SnackbarMessage | null>(null);
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  show(text: string, tone: SnackbarTone = 'SUCCESS'): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.message.set({ id: Date.now(), text, tone });
    this.timeoutId = setTimeout(() => this.dismiss(), 3200);
  }

  dismiss(): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = null;
    this.message.set(null);
  }
}
