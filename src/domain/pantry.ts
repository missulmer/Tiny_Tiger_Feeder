import type { Flavor, Meal, OrderLine, PantryEvent, PlateItem, Product } from './types.js';

export interface StockEntry {
  cans: number;
  display: number;
  needsCount: boolean;
}
export type StockMap = Record<string, StockEntry>;

export function eventsForArrival(
  lines: OrderLine[],
  products: Map<string, Product>,
  flavorsByProduct: Map<string, Flavor[]>,
  at: string,
  orderId: string,
): PantryEvent[] {
  const out: PantryEvent[] = [];
  for (const line of lines) {
    const product = products.get(line.productId);
    if (!product) continue;
    const flavors = flavorsByProduct.get(product.id) ?? [];
    // Variety pack: each flavor's own cansPerCase; single flavor: its (only) flavor's cans per case.
    const targets = product.isVarietyPack ? flavors : flavors.slice(0, 1);
    for (const f of targets) {
      out.push({
        id: `${orderId}:${f.id}`,
        flavorId: f.id,
        deltaCans: f.cansPerCase * line.qtyCases,
        reason: 'shipment',
        at,
        refId: orderId,
      });
    }
  }
  return out;
}

export function eventsForMeal(meal: Meal, flavors: Map<string, Flavor>): PantryEvent[] {
  if (meal.source === 'recalled') return [];
  // Choice meals: only the picked plate is consumed; the other plate is logged as another cat's meal.
  const plates = meal.choice ? meal.plates.filter((_, i) => i === meal.choice!.pickedIdx) : meal.plates;
  const amounts = new Map<string, number>();
  // v1: only can-unit flavors are tracked. Toppers/sides in tubes or cups are skipped.
  const add = (item: PlateItem) => {
    const f = flavors.get(item.flavorId);
    if (!f || f.unit !== 'can' || !(f.canOz > 0)) return;
    amounts.set(f.id, (amounts.get(f.id) ?? 0) + item.amountOz / f.canOz);
  };
  for (const p of plates) {
    p.items.forEach(add);
    p.toppers.forEach(add);
  }
  return [...amounts].map(([flavorId, cans]) => ({
    id: `${meal.id}:${flavorId}`,
    flavorId,
    deltaCans: -cans,
    reason: 'meal' as const,
    at: meal.loggedAt,
    refId: meal.id,
  }));
}

export function stock(events: PantryEvent[]): StockMap {
  const totals: Record<string, number> = {};
  for (const e of events) totals[e.flavorId] = (totals[e.flavorId] ?? 0) + e.deltaCans;
  const out: StockMap = {};
  for (const [id, cans] of Object.entries(totals)) {
    out[id] = { cans, display: Math.max(0, cans), needsCount: cans < 0 };
  }
  return out;
}

export function onHandOz(stockMap: StockMap, flavors: Map<string, Flavor>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, s] of Object.entries(stockMap)) {
    const f = flavors.get(id);
    if (f) out[id] = s.display * f.canOz;
  }
  return out;
}

export function countCheckList(
  stockMap: StockMap,
  flavors: Map<string, Flavor>,
  inNextOrder: string[],
): string[] {
  const known = (id: string) => flavors.has(id);
  const needs = Object.keys(stockMap).filter((id) => stockMap[id]?.needsCount && known(id)).sort();
  return [...new Set([...inNextOrder.filter(known), ...needs])];
}
