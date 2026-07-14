import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Category } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';

@Component({
  selector: 'app-categories-page',
  imports: [ReactiveFormsModule],
  templateUrl: './categories.html',
  styleUrl: './categories.scss',
})
export class CategoriesPage {
  readonly store = inject(CardNestStore);
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly deletingId = signal<string | null>(null);
  readonly replacementId = signal('');
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
    return this.store.transactions().filter((item) => item.categoryId === categoryId).length;
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
    this.deletingId.set(categoryId);
    this.replacementId.set('');
  }
  cancelDelete(): void {
    this.deletingId.set(null);
    this.replacementId.set('');
  }
  confirmDelete(categoryId: string): void {
    if (this.store.deleteCategory(categoryId, this.replacementId() || undefined))
      this.cancelDelete();
  }
  updateReplacement(event: Event): void {
    this.replacementId.set((event.target as HTMLSelectElement).value);
  }
}
