import definitions from '../data/category-matching-rules.json';
import {
  CATEGORY_REGISTRY,
  categoryDefinition,
  normalizedCategoryName,
} from '../data/category-definitions';
import type { Category, TransactionType } from '../models/domain';
import type { CategoryCatalogEntry } from '../data/category-catalog';

export interface CategoryRule {
  id: string;
  categoryId: string;
  priority: number;
  merchantWords?: readonly string[];
  merchantPhrases?: readonly string[];
  enabled: boolean;
}
function merchantTokens(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-IN')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}
export function validateMatchingRules(value: unknown): readonly CategoryRule[] {
  if (!value || typeof value !== 'object') throw new Error('Invalid category matching rules.');
  const data = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(data['version']) ||
    Number(data['version']) < 1 ||
    !Array.isArray(data['rules'])
  )
    throw new Error('Invalid matching rules version.');
  const ids = new Set<string>();
  for (const raw of data['rules']) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid matching rule.');
    const row = raw as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) =>
          !['id', 'categoryId', 'priority', 'merchantWords', 'merchantPhrases', 'enabled'].includes(
            key,
          ),
      ) ||
      typeof row['id'] !== 'string' ||
      !row['id'] ||
      ids.has(row['id']) ||
      typeof row['categoryId'] !== 'string' ||
      !CATEGORY_REGISTRY.categories.some((def) => def.id === row['categoryId']) ||
      !Number.isSafeInteger(row['priority']) ||
      typeof row['enabled'] !== 'boolean'
    )
      throw new Error('Invalid or duplicate matching rule.');
    ids.add(row['id']);
    const terms = [row['merchantWords'], row['merchantPhrases']];
    if (
      !terms.some((list) => Array.isArray(list) && list.length) ||
      terms.some(
        (list) =>
          list !== undefined &&
          (!Array.isArray(list) ||
            !list.every(
              (word: unknown) =>
                typeof word === 'string' && merchantTokens(word) && word.length <= 100,
            )),
      ) ||
      (Array.isArray(row['merchantWords']) &&
        !row['merchantWords'].every((word: string) => !merchantTokens(word).includes(' ')))
    )
      throw new Error('Invalid merchant words or phrases.');
  }
  return data['rules'] as CategoryRule[];
}
export const CATEGORY_RULES = validateMatchingRules(definitions);
export type CategoryPurpose = TransactionType | 'INCOME' | 'TOPUP';
export function categoryCompatible(
  category: Pick<Category, 'archived' | 'appliesTo'>,
  purpose: CategoryPurpose,
): boolean {
  const credit = ['REFUND', 'CASHBACK', 'PAYMENT', 'CREDIT', 'INCOME', 'TOPUP'].includes(purpose);
  return !category.archived && category.appliesTo !== (credit ? 'EXPENSE' : 'CREDIT');
}
export function requireOther(categories: readonly Category[]): string {
  const other = categories.find(
    (row) => row.id === 'other' && !row.archived && row.appliesTo === 'BOTH',
  );
  if (!other)
    throw new Error('Category integrity error: active Other is missing. Restore a valid backup.');
  return other.id;
}
export function resolveCategory(
  id: string,
  categories: readonly Category[],
  purpose: CategoryPurpose,
  states: readonly CategoryCatalogEntry[] = [],
): string {
  const fallback = requireOther(categories);
  const state = states.find((row) => row.canonical_id === id);
  if (state?.deleted) return fallback;
  let matches: readonly Category[];
  if (state) matches = categories.filter((row) => row.id === state.category_id);
  else {
    const def = CATEGORY_REGISTRY.categories.find((row) => row.id === id);
    matches = categories.filter(
      (row) => row.id === id || (!!def && categoryDefinition(row.name)?.id === def.id),
    );
  }
  return matches.length === 1 && categoryCompatible(matches[0], purpose) ? matches[0].id : fallback;
}
/** Called only by interactive Add/Review workflows. Winner is selected before resolving its target. */
export function suggestCategory(
  input: { purpose: CategoryPurpose; merchant?: string; inheritedId?: string; explicitId?: string },
  categories: readonly Category[],
  states: readonly CategoryCatalogEntry[] = [],
  rules: readonly CategoryRule[] = CATEGORY_RULES,
): string {
  const fallback = requireOther(categories);
  if (input.explicitId) {
    const explicit = categories.find((row) => row.id === input.explicitId);
    return explicit && categoryCompatible(explicit, input.purpose) ? explicit.id : fallback;
  }
  const preferred = ['REFUND', 'CASHBACK', 'TOPUP'].includes(input.purpose)
    ? 'contra-expenses'
    : input.purpose === 'PAYMENT'
      ? 'payment'
      : ['CREDIT', 'INCOME'].includes(input.purpose)
        ? 'income'
        : undefined;
  if (preferred) return resolveCategory(preferred, categories, input.purpose, states);
  if (input.inheritedId !== undefined) {
    const category = categories.find((row) => row.id === input.inheritedId);
    return category && categoryCompatible(category, input.purpose) ? category.id : fallback;
  }
  const merchant = ` ${merchantTokens(input.merchant ?? '')} `;
  const matches = rules
    .flatMap((rule) => {
      const terms = [...(rule.merchantPhrases ?? []), ...(rule.merchantWords ?? [])].filter(
        (term) => merchant.includes(` ${merchantTokens(term)} `),
      );
      return terms.length
        ? [
            {
              rule,
              specificity: Math.max(...terms.map((term) => merchantTokens(term).split(' ').length)),
              length: Math.max(...terms.map((term) => merchantTokens(term).length)),
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        b.rule.priority - a.rule.priority ||
        b.length - a.length ||
        normalizedCategoryName(a.rule.id).localeCompare(normalizedCategoryName(b.rule.id), 'en'),
    );
  const winner = matches[0]?.rule;
  return winner?.enabled
    ? resolveCategory(winner.categoryId, categories, input.purpose, states)
    : fallback;
}
