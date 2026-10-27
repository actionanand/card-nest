import { TestBed } from '@angular/core/testing';
import { ConfirmationDialog } from './confirmation-dialog';
import axe from 'axe-core';

describe('Reusable confirmation focus and cancellation', () => {
  it('disables both actions and ignores Back/Escape while persistence is running', () => {
    const fixture = TestBed.createComponent(ConfirmationDialog);
    fixture.componentRef.setInput('title', 'Delete account activity?');
    fixture.componentRef.setInput('message', 'Selected debit');
    fixture.componentRef.setInput('busy', true);
    fixture.componentRef.setInput('error', 'Retry persistence');
    const cancel = vi.fn(),
      confirm = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancel);
    fixture.componentInstance.confirmed.subscribe(confirm);
    fixture.detectChanges();
    const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    window.dispatchEvent(new Event('cardnest:back', { cancelable: true }));
    fixture.componentInstance.cancel();
    fixture.componentInstance.confirm();
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toBe(
      'Retry persistence',
    );
    fixture.destroy();
  });
  it.each(['light', 'dark'])(
    'supports keyboard, Back and screen-reader confirmation in %s theme',
    async (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const trigger = document.createElement('button');
      trigger.textContent = 'Restore default filters';
      document.body.append(trigger);
      trigger.focus();
      const fixture = TestBed.createComponent(ConfirmationDialog);
      fixture.componentRef.setInput('title', 'Restore default filters?');
      fixture.componentRef.setInput('message', 'Your messages and transactions will not change.');
      fixture.componentRef.setInput('confirmLabel', 'Restore defaults');
      const cancel = vi.fn();
      fixture.componentInstance.cancelled.subscribe(cancel);
      fixture.detectChanges();
      await fixture.whenStable();
      const buttons = fixture.nativeElement.querySelectorAll(
        'button',
      ) as NodeListOf<HTMLButtonElement>;
      expect(document.activeElement).toBe(buttons[0]);
      buttons[0].dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement).toBe(buttons[1]);
      buttons[1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(buttons[0]);
      expect(
        (
          await axe.run(fixture.nativeElement, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
            rules: { 'color-contrast': { enabled: false } },
          })
        ).violations,
      ).toEqual([]);
      const back = new Event('cardnest:back', { cancelable: true });
      window.dispatchEvent(back);
      expect(back.defaultPrevented).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(cancel).toHaveBeenCalledTimes(2);
      fixture.destroy();
      expect(document.activeElement).toBe(trigger);
      trigger.remove();
      document.documentElement.removeAttribute('data-theme');
    },
    30000,
  );
});
