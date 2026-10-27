import { TestBed } from '@angular/core/testing';
import { CategorySpendingPage } from './category-spending';
import { CardNestStore } from '../../core/services/card-nest-store';
import { SqliteDatabase } from '../../core/data/sqlite-database';

describe('Category limit action layout and editor', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      imports: [CategorySpendingPage],
      providers: [{ provide: SqliteDatabase, useValue: { ready: () => false } }],
    }),
  );
  it('keeps Set/Edit limit in dedicated action rows without expanding or changing amounts', async () => {
    const fixture = TestBed.createComponent(CategorySpendingPage);
    const store = TestBed.inject(CardNestStore);
    const category = store.categories().find((row) => row.id === 'groceries')!;
    store.categories.set([
      category,
      {
        ...category,
        id: 'synthetic-limited',
        name: 'Synthetic limited',
        monthlyLimitMinor: 10000,
        showLimit: true,
      },
    ]);
    fixture.detectChanges();
    const buttons = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.category-actions .limit-button',
      ),
    ];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('Set limit');
    expect(buttons[1].textContent).toContain('Edit limit');
    buttons[0].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedCategoryId()).toBeNull();
    expect(fixture.componentInstance.limitCategoryId()).toBe(category.id);
    const save = vi.spyOn(store, 'setCategoryLimit').mockResolvedValue();
    fixture.componentInstance.limitForm.setValue({ amount: '123.45', showLimit: true });
    await fixture.componentInstance.saveLimit();
    expect(save).toHaveBeenCalledWith(category.id, 12345, true);
    buttons[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.limitForm.controls.amount.value).toBe('100');
    expect(fixture.componentInstance.limitForm.controls.showLimit.value).toBe(true);
    fixture.componentInstance.closeLimit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role=dialog]')).toBeNull();
  });
  it('opens a native modal and restores focus on cancel or Android Back without saving', async () => {
    const fixture = TestBed.createComponent(CategorySpendingPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    document.body.append(element);
    const trigger = element.querySelector<HTMLButtonElement>('.limit-button')!;
    const save = vi.spyOn(TestBed.inject(CardNestStore), 'setCategoryLimit');
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    const dialog = element.querySelector<HTMLDialogElement>('dialog')!;
    expect(dialog.open).toBe(true);
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(cancel.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(element.querySelector('dialog')).toBeNull();
    trigger.click();
    fixture.detectChanges();
    const back = new Event('cardnest:back', { cancelable: true });
    window.dispatchEvent(back);
    fixture.detectChanges();
    expect(back.defaultPrevented).toBe(true);
    expect(element.querySelector('dialog')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    element.remove();
  });
});
