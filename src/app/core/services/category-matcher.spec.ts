import {
  DEFAULT_CATEGORIES,
  CATEGORY_REGISTRY,
  validateCategoryRegistry,
} from '../data/category-definitions';
import { CATEGORY_RULES, suggestCategory, validateMatchingRules } from './category-matcher';
import type { Category } from '../models/domain';

describe('Offline category matching with strict winner fallback', () => {
  const suggest = (merchant: string, categories: readonly Category[] = DEFAULT_CATEGORIES) =>
    suggestCategory({ purpose: 'PURCHASE', merchant }, categories);
  it.each([
    ['Swiggy', 'dining'],
    ['SWIGGY--- INSTAMART', 'groceries'],
    ['Zomato', 'dining'],
    ['Blinkit', 'groceries'],
    ['Fresh Vegetable Market', 'fresh-produce'],
    ['Milk Dairy', 'meat-dairy'],
    ['HILL FARM MEATS', 'meat-dairy'],
    ['Blue Bakery', 'snacks-pastry'],
    ['Indian Oil', 'fuel'],
    ['Netflix', 'subscription'],
    ['City Pharmacy', 'healthcare'],
    ['Electronics Store', 'tech-gadgets'],
    ['Toy Store', 'kids'],
    ['Digital software download', 'digital-goods'],
    ['Tuition Centre', 'education'],
    ['Water bill', 'utilities'],
    ['Amazon', 'other'],
    ['Visa', 'other'],
    ['UPI GPAY', 'other'],
    ['SWIGGYSOMETHING', 'other'],
    ['Unspecified merchant', 'other'],
    ['Indulgences', 'other'],
  ])('maps safe merchant evidence %s to %s', (merchant, id) => expect(suggest(merchant)).toBe(id));
  it.each(['missing', 'archived', 'incompatible'])(
    'uses Other for a %s winning target without falling through to Swiggy Dining',
    (mode) => {
      const categories = DEFAULT_CATEGORIES.flatMap((row) =>
        row.id !== 'groceries'
          ? [row]
          : mode === 'missing'
            ? []
            : [
                {
                  ...row,
                  archived: mode === 'archived',
                  appliesTo: mode === 'incompatible' ? ('CREDIT' as const) : row.appliesTo,
                },
              ],
      );
      expect(suggest('Swiggy Instamart', categories)).toBe('other');
    },
  );
  it('resolves reused custom IDs and rejects ambiguous resolution', () => {
    const categories = [
      ...DEFAULT_CATEGORIES.filter((row) => row.id !== 'kids'),
      {
        ...DEFAULT_CATEGORIES.find((row) => row.id === 'kids')!,
        id: 'user-uuid',
        name: '  KIDS  ',
      },
    ];
    expect(suggest('Toy Store', categories)).toBe('user-uuid');
    expect(
      suggestCategory({ purpose: 'PURCHASE', merchant: 'Toy Store' }, categories, [
        { canonical_id: 'kids', category_id: 'user-uuid', deleted: 0 },
      ]),
    ).toBe('user-uuid');
    expect(
      suggestCategory({ purpose: 'PURCHASE', merchant: 'Toy Store' }, categories, [
        { canonical_id: 'kids', category_id: null, deleted: 1 },
      ]),
    ).toBe('other');
    expect(suggest('Toy Store', [...categories, { ...categories.at(-1)!, id: 'another' }])).toBe(
      'other',
    );
  });
  it('uses explicit choice, purpose, inherited category, merchant and Other in that order', () => {
    expect(
      suggestCategory(
        { purpose: 'CASHBACK', merchant: 'Swiggy', explicitId: 'shopping' },
        DEFAULT_CATEGORIES,
      ),
    ).toBe('shopping');
    expect(
      suggestCategory(
        { purpose: 'CASHBACK', merchant: 'Swiggy', inheritedId: 'dining' },
        DEFAULT_CATEGORIES,
      ),
    ).toBe('contra-expenses');
    expect(suggestCategory({ purpose: 'PAYMENT', merchant: 'Swiggy' }, DEFAULT_CATEGORIES)).toBe(
      'payment',
    );
    expect(suggestCategory({ purpose: 'INCOME', merchant: 'Swiggy' }, DEFAULT_CATEGORIES)).toBe(
      'income',
    );
    expect(
      suggestCategory(
        { purpose: 'ADJUSTMENT', merchant: 'Netflix', inheritedId: 'dining' },
        DEFAULT_CATEGORIES,
      ),
    ).toBe('dining');
    expect(
      suggestCategory(
        { purpose: 'ADJUSTMENT', merchant: 'Netflix', inheritedId: 'deleted' },
        DEFAULT_CATEGORIES,
      ),
    ).toBe('other');
    for (const [purpose, id] of [
      ['CASHBACK', 'contra-expenses'],
      ['INCOME', 'income'],
      ['PAYMENT', 'payment'],
    ] as const)
      expect(
        suggestCategory(
          { purpose, merchant: 'Swiggy' },
          DEFAULT_CATEGORIES.filter((row) => row.id !== id),
        ),
      ).toBe('other');
  });
  it('honours specificity, priority, deterministic IDs and disabled winner fallback', () => {
    const rules = [
      { id: 'z', categoryId: 'shopping', priority: 50, merchantWords: ['shop'], enabled: true },
      { id: 'a', categoryId: 'dining', priority: 50, merchantWords: ['shop'], enabled: true },
    ];
    expect(
      suggestCategory({ purpose: 'PURCHASE', merchant: 'Shop' }, DEFAULT_CATEGORIES, [], rules),
    ).toBe('dining');
    expect(
      suggestCategory(
        { purpose: 'PURCHASE', merchant: 'Shop' },
        DEFAULT_CATEGORIES,
        [],
        [...rules].reverse(),
      ),
    ).toBe('dining');
    expect(
      suggestCategory(
        { purpose: 'PURCHASE', merchant: 'Shop' },
        DEFAULT_CATEGORIES,
        [],
        [{ ...rules[0], priority: 60 }, rules[1]],
      ),
    ).toBe('shopping');
    expect(
      suggestCategory(
        { purpose: 'PURCHASE', merchant: 'Swiggy Instamart' },
        DEFAULT_CATEGORIES,
        [],
        CATEGORY_RULES.map((rule) =>
          rule.id === 'swiggy-instamart' ? { ...rule, enabled: false } : rule,
        ),
      ),
    ).toBe('other');
  });
  it('validates both registries, duplicate IDs, target IDs and refuses executable regex fields', () => {
    expect(CATEGORY_REGISTRY.categories).toHaveLength(21);
    expect(validateMatchingRules({ version: 1, rules: CATEGORY_RULES })).toEqual(CATEGORY_RULES);
    for (const value of [
      { version: 1, rules: [CATEGORY_RULES[0], CATEGORY_RULES[0]] },
      { version: 1, rules: [{ ...CATEGORY_RULES[0], regex: '.*' }] },
      { version: 1, rules: [{ ...CATEGORY_RULES[0], categoryId: 'missing' }] },
      { version: 1, rules: [{ ...CATEGORY_RULES[0], merchantWords: ['two words'] }] },
      { version: 1, rules: [{ ...CATEGORY_RULES[0], priority: NaN }] },
    ])
      expect(() => validateMatchingRules(value)).toThrow();
    expect(() => validateCategoryRegistry({ version: 1, categories: [] })).toThrow();
  });
  it('raises a clear integrity error if active Other is unavailable', () => {
    expect(() => suggest('Swiggy', [])).toThrow('Category integrity error');
    expect(() =>
      suggest(
        'Swiggy',
        DEFAULT_CATEGORIES.map((row) => (row.id === 'other' ? { ...row, archived: true } : row)),
      ),
    ).toThrow('Category integrity error');
  });
});
