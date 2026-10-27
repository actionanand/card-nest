import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ProfileModal } from './profile-modal';
import { AppSelectPicker } from './app-select-picker';
import axe from 'axe-core';
@Component({
  imports: [ProfileModal, AppSelectPicker],
  template: `<app-profile-modal
    title="Add mobile profile"
    [busy]="busy()"
    (closed)="closes = closes + 1"
    ><label>Name<input /></label
    ><app-select-picker label="Operator" [options]="[{ value: 'JIO', label: 'Jio' }]" /><button
      type="button"
    >
      Save profile
    </button></app-profile-modal
  >`,
})
class Host {
  busy = signal(false);
  closes = 0;
}
describe('Shared profile dialog', () => {
  it.each(['light', 'dark'])(
    'locks scrolling, labels fields, traps focus and composes with custom pickers in %s theme',
    async (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const trigger = document.createElement('button');
      trigger.textContent = 'Add profile';
      document.body.append(trigger);
      trigger.focus();
      const fixture = TestBed.createComponent(Host);
      fixture.detectChanges();
      await fixture.whenStable();
      const element = fixture.nativeElement as HTMLElement;
      const dialog = element.querySelector('dialog')!;
      const input = dialog.querySelector('input')!;
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(document.body.style.overflow).toBe('hidden');
      const buttons = dialog.querySelectorAll('button');
      buttons.item(buttons.length - 1).focus();
      buttons
        .item(buttons.length - 1)
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
        );
      expect(document.activeElement).toBe(buttons[0]);
      (element.querySelector('app-select-picker button') as HTMLButtonElement).click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(element.querySelectorAll('dialog[open]')).toHaveLength(2);
      const back = new Event('cardnest:back', { cancelable: true });
      window.dispatchEvent(back);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.componentInstance.closes).toBe(0);
      expect(element.querySelectorAll('dialog[open]')).toHaveLength(1);
      expect(
        (
          await axe.run(element, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
            rules: { 'color-contrast': { enabled: false } },
          })
        ).violations,
      ).toEqual([]);
      fixture.componentInstance.busy.set(true);
      fixture.detectChanges();
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      expect(fixture.componentInstance.closes).toBe(0);
      fixture.componentInstance.busy.set(false);
      fixture.detectChanges();
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      expect(fixture.componentInstance.closes).toBe(1);
      fixture.destroy();
      expect(document.activeElement).toBe(trigger);
      expect(document.body.style.overflow).not.toBe('hidden');
      trigger.remove();
      document.documentElement.removeAttribute('data-theme');
    },
    30000,
  );
});
