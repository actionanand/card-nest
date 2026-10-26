import { TestBed } from '@angular/core/testing';
import axe from 'axe-core';
import { SmsPurchaseComparison } from './sms-purchase-comparison';

describe('Purchase comparison accessibility', () => {
  it.each(['light', 'dark'])(
    'exposes labelled keyboard buttons and selected state in %s mode',
    async (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const fixture = TestBed.createComponent(SmsPurchaseComparison);
      fixture.componentRef.setInput('matches', [
        {
          id: 'one',
          label: '2026-10-26 · 17:30 IST · Milk · ₹50',
          source: 'Daily card •••• 4844',
          reason: 'Same local date; manual confirmation required.',
          timeDifference: '',
        },
        {
          id: 'two',
          label: '2026-10-26 · Time not recorded · Breakfast · ₹50',
          source: 'Daily card •••• 4844',
          reason: 'Same local date only.',
          timeDifference: '',
        },
      ]);
      fixture.componentRef.setInput('timing', 'SMS receipt is approximate.');
      fixture.componentRef.setInput('selected', 'one');
      fixture.detectChanges();
      const buttons = fixture.nativeElement.querySelectorAll(
        'button',
      ) as NodeListOf<HTMLButtonElement>;
      expect(buttons).toHaveLength(3);
      expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
      const selected = vi.fn();
      const separate = vi.fn();
      fixture.componentInstance.match.subscribe(selected);
      fixture.componentInstance.confirmSeparate.subscribe(separate);
      buttons[1].click();
      buttons[2].click();
      expect(selected).toHaveBeenCalledWith('two');
      expect(separate).toHaveBeenCalledOnce();
      const result = await axe.run(fixture.nativeElement as HTMLElement, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(result.violations).toEqual([]);
      document.documentElement.removeAttribute('data-theme');
    },
    30000,
  );
});
