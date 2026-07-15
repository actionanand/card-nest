import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Category } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { AppIcon } from '../../shared/app-icon';

@Component({
  selector: 'app-categories-page',
  imports: [ReactiveFormsModule, RouterLink, AppIcon],
  templateUrl: './categories.html',
  styleUrl: './categories.scss',
})
export class CategoriesPage {
  readonly store = inject(CardNestStore);
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
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
    this.closeForm();
  }
  requestDelete(categoryId: string): void {
    const category = this.store.categories().find((item) => item.id === categoryId);
    if (
      !category ||
      !globalThis.confirm?.(`Delete ${category.name}? Existing transactions will move to Other.`)
    )
      return;
    this.store.deleteCategory(categoryId);
  }
}
