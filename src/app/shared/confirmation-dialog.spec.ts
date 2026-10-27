import { TestBed } from '@angular/core/testing';
import { ConfirmationDialog } from './confirmation-dialog';
import axe from 'axe-core';

describe('Reusable confirmation focus and cancellation', () => {
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
