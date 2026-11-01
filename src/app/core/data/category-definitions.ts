import registry from './default-categories.json';
import type { Category } from '../models/domain';

export interface DefaultCategory {
  id: string;
  name: string;
  aliases: readonly string[];
  icon: string;
  colour: string;
  appliesTo: Category['appliesTo'];
  protected: boolean;
  introduced: number;
  description?: string;
}
export function normalizedCategoryName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-IN');
}
export function validateCategoryRegistry(value: unknown): {
  version: number;
  categories: readonly DefaultCategory[];
} {
  if (!value || typeof value !== 'object') throw new Error('Invalid category registry.');
  const data = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(data['version']) ||
    Number(data['version']) < 1 ||
    !Array.isArray(data['categories'])
  )
    throw new Error('Invalid category registry version.');
  const ids = new Set<string>(),
    names = new Set<string>();
  for (const raw of data['categories']) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid category definition.');
    const row = raw as Record<string, unknown>;
    if (
      typeof row['id'] !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(row['id']) ||
      ids.has(row['id']) ||
      typeof row['name'] !== 'string' ||
      !row['name'].trim() ||
      typeof row['icon'] !== 'string' ||
      !row['icon'] ||
      typeof row['colour'] !== 'string' ||
      !/^#[a-f0-9]{6}$/i.test(row['colour']) ||
      !['BOTH', 'EXPENSE', 'CREDIT'].includes(String(row['appliesTo'])) ||
      typeof row['protected'] !== 'boolean' ||
      !Number.isSafeInteger(row['introduced']) ||
      Number(row['introduced']) < 1 ||
      Number(row['introduced']) > Number(data['version']) ||
      !Array.isArray(row['aliases']) ||
      !row['aliases'].every((alias: unknown) => typeof alias === 'string' && alias.trim())
    )
      throw new Error('Invalid or duplicate category definition.');
    ids.add(row['id']);
    for (const name of [row['name'], ...(row['aliases'] as string[])]) {
      const key = normalizedCategoryName(name);
      if (names.has(key)) throw new Error('Ambiguous category alias.');
      names.add(key);
    }
  }
  if (!ids.has('other') || !ids.has('payment'))
    throw new Error('Essential category definitions are missing.');
  return value as { version: number; categories: readonly DefaultCategory[] };
}
export const CATEGORY_REGISTRY = validateCategoryRegistry(registry);
export const DEFAULT_CATEGORIES: readonly Category[] = CATEGORY_REGISTRY.categories.map(
  ({ id, name, icon, colour, appliesTo }) => ({
    id,
    name,
    icon,
    colour,
    appliesTo,
    archived: false,
  }),
);
export function categoryDefinition(name: string): DefaultCategory | undefined {
  const key = normalizedCategoryName(name);
  return CATEGORY_REGISTRY.categories.find((row) =>
    [row.name, ...row.aliases].some((alias) => normalizedCategoryName(alias) === key),
  );
}
export function formatNewCategoryName(name: string): string {
  const clean = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return (
    categoryDefinition(clean)?.name ??
    clean.replace(/\S+/gu, (word) =>
      word === word.toLocaleLowerCase('en-IN')
        ? word.replace(/^\p{Ll}/u, (char) => char.toLocaleUpperCase('en-IN'))
        : word,
    )
  );
}
