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
  private watchdogId: ReturnType<typeof setInterval> | null = null;
  private dismissAt = 0;

  show(text: string, tone: SnackbarTone = 'SUCCESS', durationMs = 3200): void {
    this.clearTimers();
    const id = Date.now();
    this.dismissAt = Date.now() + durationMs;
    this.message.set({ id, text, tone });
    this.timeoutId = setTimeout(() => this.dismissIfCurrent(id), durationMs);
    this.watchdogId = setInterval(() => {
      if (Date.now() >= this.dismissAt) this.dismissIfCurrent(id);
    }, 500);
  }

  dismiss(): void {
    this.clearTimers();
    this.message.set(null);
  }

  private dismissIfCurrent(id: number): void {
    if (this.message()?.id !== id) return;
    this.dismiss();
  }

  private clearTimers(): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    if (this.watchdogId) clearInterval(this.watchdogId);
    this.timeoutId = null;
    this.watchdogId = null;
    this.dismissAt = 0;
  }
}
