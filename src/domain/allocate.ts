import { casesForShare, summarizeOrder } from './orderMath.js';
import type { MixLine, OrderSummary } from './orderMath.js';
import { servableFor } from './rules.js';
import type { Summary } from './scoring.js';
import type { Cat, Flavor, FoodState, HouseholdRule, OrderLine, Product } from './types.js';

type Summaries = Record<string, Record<string, Summary>>;

export const WEIGHT_FLOOR = 0.05;
export const UNLISTED_PROTEIN_WEIGHT = 0.3;
export const ACCEPT_THRESHOLD = 0.5;
export const FATIGUE_SHARE = 0.5;

export type AllocateInput = {
  cats: Cat[];
  flavors: Flavor[];
  rules: HouseholdRule[];
  asOf: string;
  summaries: Summaries;
  states: Record<string, FoodState>;
  candidateFlavorIds: string[];
  ownerOverrides?: Record<string, number>;
  onHandOz?: Record<string, number>;
  intervalDays: number;
};

export type AllocateResult = {
  ozPerDayByFlavor: Record<string, number>;
  perCatOz: Record<string, Record<string, number>>;
  notes: string[];
};

export type SheetLine = {
  productId: string;
  action: 'KEEP' | 'CHANGE' | 'ADD' | 'REMOVE';
  fromQty: number;
  toQty: number;
  reason: string;
};

export type UpdateSheet = {
  lines: SheetLine[];
  intervalWeeks: { from: number | null; to: number };
  summary: OrderSummary;
  warnings: string[];
};

export type UpdateSheetInput = {
  current: OrderLine[];
  proposedOzPerDay: Record<string, number>;
  products: Product[];
  flavorsByProduct: Record<string, Flavor[]>;
  onHandOz: Record<string, number>;
  intervalDays: number;
  states: Record<string, FoodState>;
  reasons: Record<string, string>;
  overrideSwapLimit?: boolean;
  perCatOz?: Record<string, Record<string, number>>;
  cats?: Cat[];
  flavors?: Map<string, Flavor>;
  currentIntervalWeeks?: number;
  /** Products in any order from the last 2 intervals: never subject to the one-swap rule. */
  recentProductIds?: string[];
};

const fin = (n: number | undefined): number => (n !== undefined && Number.isFinite(n) ? n : 0);
const total = (r: Record<string, number>): number => Object.values(r).reduce((n, v) => n + fin(v), 0);
const portion = (c: Cat): number => c.fixedPortionOz ?? c.dailyOz;
const scoreOf = (s: Summary | undefined): number | null => (s ? s.recent ?? s.longRun : null);

/** 1 − 0.15 × rank of the protein in the cat's list; 0.3 when not listed. */
export function prefWeight(cat: Cat, protein: string): number {
  const rank = cat.proteinPrefs.indexOf(protein);
  return rank < 0 ? UNLISTED_PROTEIN_WEIGHT : 1 - 0.15 * rank;
}

function latestPrice(p: Product): number | null {
  if (p.prices.length === 0) return null;
  return [...p.prices].sort((a, b) => (a.seenOn < b.seenOn ? 1 : a.seenOn > b.seenOn ? -1 : 0))[0]?.casePrice ?? null;
}

export function allocate(input: AllocateInput): AllocateResult {
  const { cats, rules, asOf, summaries, states, intervalDays } = input;
  const notes: string[] = [];
  const byId = new Map(input.flavors.map((f) => [f.id, f]));
  const candidates = input.candidateFlavorIds
    .map((id) => byId.get(id))
    .filter((f): f is Flavor => f !== undefined && f.kind === 'wet' && states[f.id] !== 'retired');
  const servable = (c: Cat) => candidates.filter((f) => servableFor(f, c, rules, asOf));

  // Steps 1–2: split each cat's portion by weight.
  const perCatOz: Record<string, Record<string, number>> = {};
  for (const c of cats) {
    const fs = servable(c);
    const mine: Record<string, number> = {};
    perCatOz[c.id] = mine;
    if (fs.length === 0) {
      notes.push(`${c.name} has no servable candidate flavors; their ${portion(c)} oz/day is unallocated.`);
      continue;
    }
    const weights = fs.map((f) =>
      Math.max(scoreOf(summaries[c.id]?.[f.id]) ?? prefWeight(c, f.primaryProtein), WEIGHT_FLOOR));
    const sumW = weights.reduce((n, w) => n + w, 0);
    fs.forEach((f, i) => { mine[f.id] = sumW > 0 ? (portion(c) * (weights[i] ?? 0)) / sumW : 0; });
  }

  // Step 4: leftover stock rejected by most but accepted by one cat is drawn down by that cat first.
  for (const f of candidates) {
    const stockOz = fin(input.onHandOz?.[f.id]);
    if (stockOz <= 0 || !(intervalDays > 0)) continue;
    const rejecters = cats.filter((c) => {
      const sc = scoreOf(summaries[c.id]?.[f.id]);
      return sc !== null && sc < ACCEPT_THRESHOLD;
    });
    const accepters = cats.filter((c) => {
      if (!servableFor(f, c, rules, asOf)) return false;
      const sc = scoreOf(summaries[c.id]?.[f.id]);
      return sc === null ? c.proteinPrefs.includes(f.primaryProtein) : sc >= ACCEPT_THRESHOLD;
    });
    const c = accepters[0];
    const shares = c ? perCatOz[c.id] : undefined;
    if (rejecters.length < 2 || accepters.length !== 1 || !c || !shares) continue;
    const daily = portion(c);
    const before = shares[f.id] ?? 0;
    const after = Math.min(before + stockOz / intervalDays, daily);
    const othersBefore = daily - before;
    const scale = othersBefore > 0 ? (daily - after) / othersBefore : 0;
    for (const id of Object.keys(shares)) if (id !== f.id) shares[id] = (shares[id] ?? 0) * scale;
    shares[f.id] = after;
    notes.push(`${c.name} draws down the ${f.name} on the shelf first (${(after - before).toFixed(2)} oz/day).`);
  }

  // Step 3: sum per flavor, then owner overrides win.
  const ozPerDayByFlavor: Record<string, number> = {};
  for (const shares of Object.values(perCatOz)) {
    for (const [id, oz] of Object.entries(shares)) ozPerDayByFlavor[id] = (ozPerDayByFlavor[id] ?? 0) + fin(oz);
  }
  // Overrides never get past a hard rule: only servable wet candidates can be overridden.
  for (const [id, oz] of Object.entries(input.ownerOverrides ?? {})) {
    const f = candidates.find((x) => x.id === id);
    const name = byId.get(id)?.name ?? id;
    const why = !byId.has(id) ? 'unknown flavor'
      : states[id] === 'retired' ? 'it is retired'
      : !f ? 'it is not a wet candidate this order'
      : !cats.some((c) => servableFor(f, c, rules, asOf)) ? 'no cat can be served it under the active rules'
      : null;
    if (why) {
      ozPerDayByFlavor[id] = 0;
      notes.push(`Owner override for ${name} ignored: ${why}.`);
      continue;
    }
    ozPerDayByFlavor[id] = Math.max(0, fin(oz));
    notes.push(`Owner override: ${name} set to ${fin(oz)} oz/day.`);
  }
  return { ozPerDayByFlavor, perCatOz, notes };
}

/**
 * Case price ÷ (case oz × share of cans whose flavor the household accepts).
 * null when no case price is on file; Infinity when no flavor is accepted.
 */
export function costPerAcceptedOz(product: Product, flavors: Flavor[], summaries: Summaries): number | null {
  const price = latestPrice(product);
  if (price === null) return null;
  let allCans = 0;
  let acceptedCans = 0;
  for (const f of flavors) {
    allCans += f.cansPerCase;
    let wSum = 0;
    let sSum = 0;
    for (const perCat of Object.values(summaries)) {
      const s = perCat[f.id];
      if (!s) continue;
      // Recent scores are weighted by how many recent meals back them; long-run falls back to weight 1.
      const [score, w] = s.recent !== null ? [s.recent, Math.max(s.recentCount, 1)] : [s.longRun, 1];
      if (score === null) continue;
      wSum += w;
      sSum += score * w;
    }
    if (wSum > 0 && sSum / wSum >= ACCEPT_THRESHOLD) acceptedCans += f.cansPerCase;
  }
  const caseOz = product.canOz * product.cansPerCase;
  if (allCans <= 0 || acceptedCans <= 0 || caseOz <= 0) return Infinity;
  return price / (caseOz * (acceptedCans / allCans));
}

export const COVERED_REASON = 'Covered by stock on hand this shipment';
// Only adding one of these counts as the shipment's swap (spec section 7: "adding a new or rested food").
const SWAP_STATES: ReadonlySet<FoodState> = new Set<FoodState>(['unproven', 'resting', 'due_for_retry']);

const DEFAULT_REASON: Record<SheetLine['action'], string> = {
  KEEP: 'Same as the current order.',
  CHANGE: 'Quantity adjusted to the proposed mix.',
  ADD: 'New to the order.',
  REMOVE: 'No longer needed in the mix.',
};

export function buildUpdateSheet(input: UpdateSheetInput): UpdateSheet {
  const { current, proposedOzPerDay, flavorsByProduct, onHandOz, intervalDays, states, reasons } = input;
  const warnings: string[] = [];
  const productById = new Map(input.products.map((p) => [p.id, p]));
  const currentQty = new Map(current.map((l) => [l.productId, l.qtyCases]));
  const flavorsOf = (pid: string) => flavorsByProduct[pid] ?? [];
  const ozPerDay = (pid: string) => flavorsOf(pid).reduce((n, f) => n + fin(proposedOzPerDay[f.id]), 0);
  const stockOz = (pid: string) => flavorsOf(pid).reduce((n, f) => n + fin(onHandOz[f.id]), 0);
  const caseOzOf = (p: Product | undefined) => (p ? p.canOz * p.cansPerCase : 0);

  const toQtyFor = (pid: string): number => {
    const p = productById.get(pid);
    if (!p) return 0;
    if (p.isVarietyPack && !currentQty.has(pid)) {
      if (ozPerDay(pid) > 0) warnings.push(`${pid} is a variety pack not in the current order; its share was dropped.`);
      return 0;
    }
    const qty = casesForShare(ozPerDay(pid), intervalDays, caseOzOf(p), stockOz(pid));
    const unproven = states[pid] === 'unproven' || flavorsOf(pid).some((f) => states[f.id] === 'unproven');
    return unproven ? Math.min(qty, 1) : qty;
  };
  // Zero only because the pantry covers it: it would need cases with an empty shelf.
  const coveredByStock = (pid: string): boolean => {
    const p = productById.get(pid);
    return !!p && stockOz(pid) > 0 && casesForShare(ozPerDay(pid), intervalDays, caseOzOf(p), 0) > 0;
  };
  const line = (productId: string, action: SheetLine['action'], fromQty: number, toQty: number): SheetLine =>
    ({ productId, action, fromQty, toQty, reason: reasons[productId] ?? DEFAULT_REASON[action] });

  const lines: SheetLine[] = [];
  for (const cur of current) {
    const toQty = toQtyFor(cur.productId);
    if (toQty === 0 && coveredByStock(cur.productId)) {
      lines.push({ productId: cur.productId, action: 'KEEP', fromQty: cur.qtyCases, toQty: 0, reason: COVERED_REASON });
      continue;
    }
    const action = toQty === 0 ? 'REMOVE' : toQty === cur.qtyCases ? 'KEEP' : 'CHANGE';
    lines.push(line(cur.productId, action, cur.qtyCases, toQty));
  }

  // R21: an allocated product outside the current order that the shelf covers stays on the sheet as KEEP 0,
  // so it does not drop off once it leaves the order. (A variety pack outside the order is dropped instead.)
  const pids = new Set(Object.keys(flavorsByProduct));
  for (const pid of pids) {
    if (currentQty.has(pid) || productById.get(pid)?.isVarietyPack) continue;
    if (toQtyFor(pid) === 0 && coveredByStock(pid)) {
      lines.push({ productId: pid, action: 'KEEP', fromQty: 0, toQty: 0, reason: COVERED_REASON });
    }
  }

  // ADDs, largest oz/day first. Only adding a new or rested food counts as the one swap: a product whose
  // flavors are all unproven / resting / due_for_retry (or have no known state), that was in no order
  // from the last 2 intervals, and that has no stock on hand (R21). The first such ADD passes; the rest
  // are held back unless overridden.
  const recent = new Set(input.recentProductIds ?? []);
  const isSwap = (pid: string): boolean => !recent.has(pid) && !(stockOz(pid) > 0) &&
    flavorsOf(pid).every((f) => { const st = states[f.id]; return st === undefined || SWAP_STATES.has(st); });
  const adds = [...pids]
    .filter((pid) => !currentQty.has(pid))
    .map((pid) => ({ pid, oz: ozPerDay(pid), qty: toQtyFor(pid) }))
    .filter((a) => a.qty > 0)
    .sort((a, b) => b.oz - a.oz);
  let swapUsed = false;
  for (const a of adds) {
    if (!isSwap(a.pid) || input.overrideSwapLimit) { lines.push(line(a.pid, 'ADD', 0, a.qty)); continue; }
    if (!swapUsed) { swapUsed = true; lines.push(line(a.pid, 'ADD', 0, a.qty)); continue; }
    warnings.push(`Also worth adding: ${a.pid} (held back by the one-swap rule)`);
  }

  // Protein fatigue, from the proposed per-cat oz.
  if (input.perCatOz && input.cats && input.flavors) {
    for (const c of input.cats) {
      const shares: Record<string, number> = input.perCatOz[c.id] ?? {};
      const catTotal = total(shares);
      if (!(catTotal > 0)) continue;
      const byProtein: Record<string, number> = {};
      for (const [fid, oz] of Object.entries(shares)) {
        const protein = input.flavors.get(fid)?.primaryProtein;
        if (protein) byProtein[protein] = (byProtein[protein] ?? 0) + fin(oz);
      }
      for (const [protein, oz] of Object.entries(byProtein)) {
        const share = oz / catTotal;
        if (protein !== c.proteinPrefs[0] && share > FATIGUE_SHARE) {
          warnings.push(`${c.name}: ${protein} is ${Math.round(share * 100)}% of the proposed mix (protein fatigue risk).`);
        }
      }
    }
  }

  const kept = lines.filter((l) => l.action !== 'REMOVE');
  const mix: MixLine[] = kept.map((l) => {
    const p = productById.get(l.productId);
    const price = p ? latestPrice(p) : null;
    if (price === null && l.toQty > 0) {
      warnings.push(`No price on file for ${l.productId}, so the cost totals leave it out and are understated.`);
    }
    return { productId: l.productId, cases: l.toQty, caseOz: caseOzOf(p), casePrice: price ?? 0 };
  });
  const dailyOz = input.cats ? input.cats.reduce((n, c) => n + portion(c), 0) : total(proposedOzPerDay);
  // R21: stock of every product the mix allocates oz/day to counts, on the sheet or not; stock nobody is
  // allocated does not.
  const pantryOz = [...pids].filter((pid) => ozPerDay(pid) > 0).reduce((n, pid) => n + stockOz(pid), 0);

  // R20: summarizeOrder keeps its fitted-interval slack; the sheet measures slack against the chosen
  // interval, so it is negative when the food runs out before the next shipment.
  const summary = summarizeOrder(mix, dailyOz, pantryOz);
  summary.slackDays = summary.daysOfFood - intervalDays;
  if (summary.daysOfFood < intervalDays) {
    const n = Math.ceil(intervalDays - summary.daysOfFood);
    warnings.push(`Food runs out about ${n} day${n === 1 ? '' : 's'} before the next shipment`);
  }

  return {
    lines,
    intervalWeeks: { from: input.currentIntervalWeeks ?? null, to: intervalDays / 7 },
    summary,
    warnings,
  };
}
