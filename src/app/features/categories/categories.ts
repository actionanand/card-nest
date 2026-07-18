import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Category } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';

@Component({
  selector: 'app-categories-page',
  imports: [ReactiveFormsModule, AppIcon, ConfirmationDialog, AppSelectPicker],
  templateUrl: './categories.html',
  styleUrl: './categories.scss',
})
export class CategoriesPage {
  readonly store = inject(CardNestStore);
  private readonly snackbar = inject(SnackbarService);
  readonly embedded = input(false);
  readonly closed = output<void>();
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly deleteCandidate = signal<Category | null>(null);
  readonly iconOptions = [
    'category',
    'shopping_basket',
    'restaurant',
    'local_gas_station',
    'shopping_bag',
    'flight',
    'bolt',
    'health_and_safety',
    'subscriptions',
    'payments',
    'home',
    'entertainment',
    'vegetables_fruits',
    'kids',
    'fashion',
    'groceries',
    'meat_fish',
    'milk',
    'pastry_snacks',
    'utility_bills',
    'mobile',
    'electronics',
    'electricity',
    'jewels',
    'religion',
    'insurance',
    'education',
    'boy',
    'girl',
    'other',
    'family',
    'hamburger',
    'apple',
    'shopping_cart',
    'tag',
    'film',
    'popcorn',
    'landmark',
    'banknote_arrow_up',
    'banknote_arrow_down',
    'globe_check',
    'globe_off',
    'briefcase_business',
  ] as const;
  readonly appliesToOptions: readonly AppSelectOption[] = [
    { value: 'BOTH', label: 'Expenses and credits' },
    { value: 'EXPENSE', label: 'Expenses only' },
    { value: 'CREDIT', label: 'Credits only' },
  ];
  readonly colourPalette: readonly AppSelectOption[] = [
    { value: '#28684e', label: 'Forest green', swatch: '#28684e' },
    { value: '#4e9d73', label: 'Emerald green', swatch: '#4e9d73' },
    { value: '#5a9d90', label: 'Teal', swatch: '#5a9d90' },
    { value: '#4e87c7', label: 'Blue', swatch: '#4e87c7' },
    { value: '#65758b', label: 'Slate blue', swatch: '#65758b' },
    { value: '#9075b5', label: 'Purple', swatch: '#9075b5' },
    { value: '#d56a7b', label: 'Rose', swatch: '#d56a7b' },
    { value: '#de7d68', label: 'Coral', swatch: '#de7d68' },
    { value: '#e0a860', label: 'Amber', swatch: '#e0a860' },
    { value: '#c8a43b', label: 'Gold', swatch: '#c8a43b' },
    { value: '#7a8797', label: 'Slate', swatch: '#7a8797' },
    { value: '#3f7659', label: 'Deep green', swatch: '#3f7659' },
  ] as const;
  readonly sortedCategories = computed(() =>
    [...this.store.categories()].sort((a, b) => a.name.localeCompare(b.name)),
  );
  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(40)],
    }),
    icon: new FormControl('category', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(40)],
    }),
    colour: new FormControl('#28684e', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^#[0-9a-fA-F]{6}$/)],
    }),
    appliesTo: new FormControl<Category['appliesTo']>('BOTH', { nonNullable: true }),
  });
  setAppliesTo(value: string): void {
    this.form.controls.appliesTo.setValue(value as Category['appliesTo']);
    this.form.controls.appliesTo.markAsDirty();
  }

  availableColours(): readonly AppSelectOption[] {
    const selected = this.form.controls.colour.value.toLowerCase();
    if (this.colourPalette.some((colour) => colour.value === selected)) {
      return this.colourPalette;
    }
    return [
      { value: selected, label: 'Current custom colour', swatch: selected },
      ...this.colourPalette,
    ];
  }

  chooseColour(colour: string): void {
    this.form.controls.colour.setValue(colour);
    this.form.controls.colour.markAsDirty();
    this.form.controls.colour.markAsTouched();
  }

  usageCount(categoryId: string): number {
    const month = new Date().toISOString().slice(0, 7);
    return this.store
      .transactions()
      .filter((item) => item.categoryId === categoryId && item.transactionDate.startsWith(month))
      .length;
  }
  openAdd(): void {
    this.editingId.set(null);
    this.form.reset({ name: '', icon: 'category', colour: '#28684e', appliesTo: 'BOTH' });
    this.showForm.set(true);
  }
  edit(category: Category): void {
    this.editingId.set(category.id);
    this.form.reset({
      name: category.name,
      icon: category.icon,
      colour: category.colour ?? '#28684e',
      appliesTo: category.appliesTo,
    });
    this.showForm.set(true);
  }
  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
  }
  save(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const value = this.form.getRawValue();
    const duplicate = this.store
      .categories()
      .some(
        (item) =>
          item.id !== this.editingId() &&
          item.name.toLocaleLowerCase() === value.name.trim().toLocaleLowerCase(),
      );
    if (duplicate) {
      this.form.controls.name.setErrors({ duplicate: true });
      return;
    }
    const category: Category = {
      id: this.editingId() ?? crypto.randomUUID(),
      name: value.name.trim(),
      icon: value.icon.trim(),
      colour: value.colour,
      appliesTo: value.appliesTo,
      archived: false,
    };
    if (this.editingId()) this.store.updateCategory(category);
    else this.store.addCategory(category);
    this.snackbar.show(this.editingId() ? `${category.name} updated.` : `${category.name} added.`);
    this.closeForm();
  }
  requestDelete(categoryId: string): void {
    const category = this.store.categories().find((item) => item.id === categoryId);
    if (category) this.deleteCandidate.set(category);
  }
  confirmDelete(): void {
    const category = this.deleteCandidate();
    if (!category) return;
    this.store.deleteCategory(category.id);
    this.deleteCandidate.set(null);
    this.snackbar.show(`${category.name} deleted. Existing entries moved to Other.`, 'WARNING');
  }
}
