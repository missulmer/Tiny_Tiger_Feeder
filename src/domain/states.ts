import { isSlipping } from './scoring.js';
import type { ScoreEntry, Summary } from './scoring.js';
import type { Flavor, FoodState, Meal } from './types.js';

const RETRY_AFTER_DAYS = 42;
const VOMIT_WINDOW_DAYS = 28;
const VOMIT_MIN_COUNT = 2;
const MIN_ARRIVED_ORDERS = 2;
const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function foodState(
  input: {
    flavorId: string;
    retired: boolean;
    provenAtOnboarding: boolean;
    arrivedOrdersContaining: number;
    inCurrentOrder: boolean;
    lastServed: string | null;
    perCat: Record<string, Summary>;
  },
  asOf: string,
): FoodState {
  if (input.retired) return 'retired';
  if (input.arrivedOrdersContaining < MIN_ARRIVED_ORDERS && !input.provenAtOnboarding) return 'unproven';
  if (Object.values(input.perCat).some(isSlipping)) return 'slipping';
  if (input.inCurrentOrder) return 'in_rotation';
  if (input.lastServed !== null && daysBetween(input.lastServed, asOf) >= RETRY_AFTER_DAYS) return 'due_for_retry';
  return 'resting';
}

export function vomitPattern(entries: ScoreEntry[], catId: string, flavorId: string, asOf: string): boolean {
  const count = entries.filter((e) => {
    if (e.catId !== catId || e.flavorId !== flavorId) return false;
    if (!e.vomitFlag && e.vomitCause === undefined) return false;
    const age = daysBetween(e.date, asOf);
    return age >= 0 && age < VOMIT_WINDOW_DAYS;
  }).length;
  return count >= VOMIT_MIN_COUNT;
}

export function proteinShare(
  meals: Meal[],
  flavors: Map<string, Flavor>,
  catId: string,
  asOf: string,
  windowMeals = 6,
): Record<string, number> {
  const considered = meals
    .filter((m) => m.catId === catId && m.date <= asOf)
    .sort((a, b) => (a.date === b.date ? (a.slot === b.slot ? 0 : a.slot === 'AM' ? -1 : 1) : a.date < b.date ? -1 : 1))
    .slice(-windowMeals);
  const counts: Record<string, number> = {};
  for (const m of considered) {
    const proteins = new Set<string>();
    for (const plate of m.plates) {
      for (const item of plate.items) {
        const p = flavors.get(item.flavorId)?.primaryProtein;
        if (p) proteins.add(p);
      }
    }
    for (const p of proteins) counts[p] = (counts[p] ?? 0) + 1;
  }
  const shares: Record<string, number> = {};
  for (const [p, n] of Object.entries(counts)) shares[p] = n / considered.length;
  return shares;
}
