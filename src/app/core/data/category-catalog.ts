import type { DatabaseSession } from './sqlite-database';
import { CATEGORY_REGISTRY, normalizedCategoryName } from './category-definitions';

export interface CategoryCatalogEntry extends Record<string, unknown> {
  canonical_id: string;
  category_id: string | null;
  deleted: number;
}
export interface CategoryMigrationRecord extends Record<string, unknown> {
  id: string;
  category_id: string;
  details: string;
  created_at: string;
}
interface CategoryRow extends Record<string, unknown> {
  id: string;
  name: string;
  icon: string;
  colour: string | null;
  applies_to: string;
  archived: number;
}

/** Change only category references, never invoke financial transaction persistence or balance effects. */
export async function remapCategoryReferences(
  tx: DatabaseSession,
  from: string,
  to: string,
): Promise<void> {
  await tx.run(
    "UPDATE card_transactions SET category_id=?,payload=json_set(payload,'$.categoryId',?) WHERE category_id=?",
    [to, to, from],
  );
  await tx.run(
    "UPDATE recurring_rules SET payload=json_set(payload,'$.categoryId',?) WHERE json_valid(payload) AND json_extract(payload,'$.categoryId')=?",
    [to, from],
  );
  const drafts = await tx.query<{ key: string; encrypted_value: string }>(
    "SELECT key,encrypted_value FROM app_preferences WHERE key LIKE 'sms_purchase_review:%'",
  );
  for (const draft of drafts) {
    let value: unknown;
    try {
      value = JSON.parse(draft.encrypted_value);
    } catch {
      /* Malformed drafts are ignored by the review validator as before. */
      continue;
    }
    if (value && typeof value === 'object' && 'category' in value && value.category === from) {
      await tx.run('UPDATE app_preferences SET encrypted_value=? WHERE key=?', [
        JSON.stringify({ ...value, category: to, categoryUnavailable: true }),
        draft.key,
      ]);
    }
  }
}

/** Idempotent, versioned catalog upgrade. Caller owns the SQLite transaction. */
export async function reconcileCategoryCatalog(tx: DatabaseSession): Promise<void> {
  const [marker] = await tx.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM app_preferences WHERE key='category_catalog_version'",
  );
  const version = Number(marker?.encrypted_value ?? 1);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error('Invalid category catalog version. Restore a valid backup.');
  if (version > CATEGORY_REGISTRY.version) return;
  const initial = await tx.query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM app_preferences WHERE key='initial_data_state'",
  );
  const fresh = initial[0]?.encrypted_value === 'PENDING';
  const rows = [...(await tx.query<CategoryRow>('SELECT * FROM categories ORDER BY id'))];
  const states = await tx.query<CategoryCatalogEntry>('SELECT * FROM category_catalog_state');
  for (const def of CATEGORY_REGISTRY.categories) {
    const state = states.find((row) => row.canonical_id === def.id);
    if (state?.deleted) continue;
    // Once initialized, absence is intentional. Only a newer registry version adds new defaults.
    if (marker && version >= CATEGORY_REGISTRY.version) continue;
    const names = new Set([def.name, ...def.aliases].map(normalizedCategoryName));
    const equivalents = rows.filter((row) => names.has(normalizedCategoryName(row.name)));
    const stable = rows.find((row) => row.id === def.id);
    let chosen = stable ?? equivalents[0];
    if (chosen) {
      for (const duplicate of equivalents.filter((row) => row.id !== chosen!.id)) {
        const limits = await tx.query<{
          category_id: string;
          limit_minor: number;
          show_limit: number;
          updated_at: string;
        }>('SELECT * FROM category_limits WHERE category_id IN (?,?)', [chosen.id, duplicate.id]);
        // Retain both configurations in a durable, visible migration record. Never sum limits.
        const details = JSON.stringify({
          retained: chosen,
          merged: duplicate,
          budgets: limits,
          strategy:
            'Retained category budget wins; otherwise the merged budget is retained. Original settings preserved here.',
        });
        await tx.run(
          'INSERT OR IGNORE INTO category_catalog_conflicts(id,category_id,details,created_at) VALUES(?,?,?,?)',
          [`${def.id}:${duplicate.id}`, chosen.id, details, new Date().toISOString()],
        );
        if (!limits.some((row) => row.category_id === chosen!.id))
          await tx.run('UPDATE category_limits SET category_id=? WHERE category_id=?', [
            chosen.id,
            duplicate.id,
          ]);
        await remapCategoryReferences(tx, duplicate.id, chosen.id);
        await tx.run('UPDATE category_catalog_state SET category_id=? WHERE category_id=?', [
          chosen.id,
          duplicate.id,
        ]);
        await tx.run('DELETE FROM categories WHERE id=?', [duplicate.id]);
        rows.splice(rows.indexOf(duplicate), 1);
      }
      if (names.has(normalizedCategoryName(chosen.name))) {
        await tx.run('UPDATE categories SET name=? WHERE id=?', [def.name, chosen.id]);
        chosen.name = def.name;
      }
    } else if (fresh || def.introduced > version) {
      chosen = {
        id: def.id,
        name: def.name,
        icon: def.icon,
        colour: def.colour,
        applies_to: def.appliesTo,
        archived: 0,
      };
      await tx.run(
        'INSERT INTO categories(id,name,icon,colour,applies_to,archived) VALUES(?,?,?,?,?,0)',
        [chosen.id, chosen.name, chosen.icon, chosen.colour, chosen.applies_to],
      );
      rows.push(chosen);
    }
    await tx.run(
      'INSERT INTO category_catalog_state(canonical_id,category_id,deleted) VALUES(?,?,?) ON CONFLICT(canonical_id) DO UPDATE SET category_id=excluded.category_id,deleted=excluded.deleted',
      [def.id, chosen?.id ?? null, chosen ? 0 : 1],
    );
  }
  await tx.run(
    "INSERT INTO app_preferences(key,encrypted_value) VALUES('category_catalog_version',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value",
    [String(CATEGORY_REGISTRY.version)],
  );
}

export async function deletePersistedCategory(tx: DatabaseSession, id: string): Promise<void> {
  const states = await tx.query<CategoryCatalogEntry>('SELECT * FROM category_catalog_state');
  if (
    CATEGORY_REGISTRY.categories.some(
      (def) =>
        def.protected &&
        (def.id === id ||
          states.some((row) => row.canonical_id === def.id && row.category_id === id)),
    )
  )
    throw new Error('This essential category cannot be deleted.');
  const [row] = await tx.query<{ id: string; name: string }>(
    'SELECT id,name FROM categories WHERE id=?',
    [id],
  );
  if (!row) throw new Error('This category no longer exists.');
  const [other] = await tx.query<{ id: string }>(
    "SELECT id FROM categories WHERE id='other' AND archived=0 AND applies_to='BOTH'",
  );
  if (!other)
    throw new Error('Category integrity error: active Other is missing. Restore a valid backup.');
  await remapCategoryReferences(tx, id, other.id);
  const matches = CATEGORY_REGISTRY.categories.filter(
    (def) =>
      def.id === id ||
      [def.name, ...def.aliases].some(
        (name) => normalizedCategoryName(name) === normalizedCategoryName(row.name),
      ) ||
      states.some((state) => state.canonical_id === def.id && state.category_id === id),
  );
  for (const def of matches)
    await tx.run(
      'INSERT INTO category_catalog_state(canonical_id,category_id,deleted) VALUES(?,NULL,1) ON CONFLICT(canonical_id) DO UPDATE SET category_id=NULL,deleted=1',
      [def.id],
    );
  await tx.run('DELETE FROM categories WHERE id=?', [id]);
}
