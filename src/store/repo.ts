import type {
  Cat, Product, Flavor, Alias, Meal, HouseholdRule, PantryEvent, Order,
} from '../domain/types.js';

export interface Collection<T extends { id: string }> {
  /** Shallow equality on top-level fields. */
  list(filter?: Partial<T>): Promise<T[]>;
  get(id: string): Promise<T | null>;
  put(entity: T): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Domain Alias has no id; stored aliases carry a caller-supplied id. */
export type StoredAlias = Alias & { id: string };

export interface MealQuery {
  catId?: string;
  /** Matches any plate item or topper flavorId. */
  flavorId?: string;
  /** Inclusive, YYYY-MM-DD. */
  from?: string;
  to?: string;
}

export interface Repo {
  cats: Collection<Cat>;
  products: Collection<Product>;
  flavors: Collection<Flavor>;
  aliases: Collection<StoredAlias>;
  meals: Collection<Meal>;
  rules: Collection<HouseholdRule>;
  pantryEvents: Collection<PantryEvent>;
  orders: Collection<Order>;
  mealsFor(q: MealQuery): Promise<Meal[]>;
  ordersByStatus(status: Order['status']): Promise<Order[]>;
  exportAll(): Promise<Record<string, unknown[]>>;
}

export const COLLECTIONS = [
  'cats', 'products', 'flavors', 'aliases', 'meals', 'rules', 'pantryEvents', 'orders',
] as const;

export function matchesFilter<T extends object>(e: T, filter?: Partial<T>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => v === undefined || (e as Record<string, unknown>)[k] === v);
}

export function mealMatches(m: Meal, q: MealQuery): boolean {
  if (q.catId !== undefined && m.catId !== q.catId) return false;
  if (q.from !== undefined && m.date < q.from) return false;
  if (q.to !== undefined && m.date > q.to) return false;
  if (q.flavorId !== undefined) {
    const hit = m.plates.some(p =>
      p.items.some(i => i.flavorId === q.flavorId) || p.toppers.some(i => i.flavorId === q.flavorId));
    if (!hit) return false;
  }
  return true;
}
