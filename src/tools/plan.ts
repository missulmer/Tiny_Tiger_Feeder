import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo } from '../store/repo.js';
import type { Cat, Flavor, FoodState, HouseholdRule, Meal, Order, Product } from '../domain/types.js';
import { ACCEPT_THRESHOLD, allocate, buildUpdateSheet, costPerAcceptedOz } from '../domain/allocate.js';
import type { UpdateSheet } from '../domain/allocate.js';
import { entriesFromMeal, isSlipping, summarize } from '../domain/scoring.js';
import type { Summary } from '../domain/scoring.js';
import { foodState } from '../domain/states.js';
import { onHandOz, stock } from '../domain/pantry.js';
import type { StockMap } from '../domain/pantry.js';
import { checkFlavorForCat } from '../domain/rules.js';
import type { Violation } from '../domain/rules.js';
import { CONFIRM_HINT, jsonTool, withConfirm } from './preview.js';
import { localToday } from './time.js';

type Summaries = Record<string, Record<string, Summary>>;

export type Context = {
  asOf: string;
  cats: Cat[];
  products: Product[];
  flavors: Flavor[];
  rules: HouseholdRule[];
  meals: Meal[];
  stockMap: StockMap;
  summaries: Summaries;
  states: Record<string, FoodState>;
  lastServed: Record<string, string>;
  currentOrder: Order | null;
};

const latestPrice = (p: Product): number | null =>
  [...p.prices].sort((a, b) => (a.seenOn < b.seenOn ? 1 : a.seenOn > b.seenOn ? -1 : 0))[0]?.casePrice ?? null;

const mealHasFlavor = (m: Meal, id: string) =>
  m.plates.some(p => p.items.some(i => i.flavorId === id) || p.toppers.some(i => i.flavorId === id));

export async function loadContext(repo: Repo, asOf: string): Promise<Context> {
  const [cats, products, flavors, rules, meals, orders, events] = await Promise.all([
    repo.cats.list(), repo.products.list(), repo.flavors.list(), repo.rules.list(),
    repo.meals.list(), repo.orders.list(), repo.pantryEvents.list(),
  ]);
  const productById = new Map(products.map(p => [p.id, p]));
  const confirmed = orders.filter(o => o.status === 'confirmed-in-chewy')
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const currentOrder = confirmed[0] ?? null;
  const arrived = orders.filter(o => o.status === 'arrived');

  const summaries: Summaries = {};
  for (const c of cats) {
    const entries = meals.filter(m => m.catId === c.id).flatMap(m => entriesFromMeal(m, c));
    const mine: Record<string, Summary> = {};
    for (const f of flavors.filter(x => x.kind === 'wet')) {
      const es = entries.filter(e => e.flavorId === f.id);
      if (es.length > 0) mine[f.id] = summarize(es, asOf);
    }
    summaries[c.id] = mine;
  }

  const states: Record<string, FoodState> = {};
  const lastServed: Record<string, string> = {};
  for (const f of flavors.filter(x => x.kind === 'wet')) {
    const served = meals.filter(m => m.source === 'observed' && m.date <= asOf && mealHasFlavor(m, f.id))
      .map(m => m.date).sort();
    const last = served[served.length - 1] ?? null;
    if (last) lastServed[f.id] = last;
    const perCat: Record<string, Summary> = {};
    for (const [catId, s] of Object.entries(summaries)) { const x = s[f.id]; if (x) perCat[catId] = x; }
    states[f.id] = foodState({
      flavorId: f.id,
      retired: productById.get(f.productId)?.status === 'retired',
      provenAtOnboarding: f.provenAtOnboarding ?? false,
      arrivedOrdersContaining: arrived.filter(o => o.lines.some(l => l.productId === f.productId)).length,
      inCurrentOrder: currentOrder?.lines.some(l => l.productId === f.productId) ?? false,
      lastServed: last,
      perCat,
    }, asOf);
  }
  return { asOf, cats, products, flavors, rules, meals, stockMap: stock(events), summaries, states, lastServed, currentOrder };
}

const PRIORITY: FoodState[] = ['retired', 'slipping', 'unproven', 'due_for_retry', 'resting', 'in_rotation'];
const DAY_MS = 86_400_000;

function reasonFor(ctx: Context, product: Product, flavors: Flavor[]): string {
  const state = PRIORITY.find(s => flavors.some(f => ctx.states[f.id] === s)) ?? 'in_rotation';
  const flavorIds = flavors.map(f => f.id);
  const scoreOf = (catId: string): number | null => {
    const vals = flavorIds.map(id => ctx.summaries[catId]?.[id]).filter((s): s is Summary => !!s)
      .map(s => s.recent ?? s.longRun).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((n, v) => n + v, 0) / vals.length : null;
  };
  const rated = ctx.cats.filter(c => scoreOf(c.id) !== null);
  const liked = rated.filter(c => (scoreOf(c.id) as number) >= ACCEPT_THRESHOLD).length;
  const likedText = rated.length ? `liked by ${liked} of ${ctx.cats.length}` : 'no meals logged yet';
  const last = flavorIds.map(id => ctx.lastServed[id]).filter((d): d is string => !!d).sort().pop();
  const weeks = last ? Math.round((Date.parse(ctx.asOf) - Date.parse(last)) / DAY_MS / 7) : null;

  let text: string;
  if (state === 'retired') text = 'Retired';
  else if (state === 'slipping') {
    const names = ctx.cats.filter(c => flavorIds.some(id => { const s = ctx.summaries[c.id]?.[id]; return s ? isSlipping(s) : false; })).map(c => c.name);
    text = `Slipping for ${names.join(', ')}`;
  } else if (state === 'unproven') text = 'Unproven — capped at 1 case';
  else if (state === 'due_for_retry') text = `Due for a retry${weeks !== null ? ` after ${weeks} weeks` : ''}; ${likedText}`;
  else if (state === 'resting') text = `Rested${weeks !== null ? ` ${weeks} weeks` : ''}; ${likedText}`;
  else text = `In rotation; ${likedText}`;

  if (product.isVarietyPack) {
    const cost = costPerAcceptedOz(product, flavors, ctx.summaries);
    text += Number.isFinite(cost) ? `; $${cost.toFixed(2)} per accepted oz` : '; no accepted flavors yet';
  }
  return text;
}

export type PlanInput = {
  intervalWeeks?: number;
  targetCostPerMonth?: number;
  overrides?: Record<string, number>;
  overrideSwapLimit?: boolean;
  save?: boolean;
};

export async function planOrder(repo: Repo, input: PlanInput, now: Date = new Date()) {
  const asOf = localToday(now);
  const ctx = await loadContext(repo, asOf);
  const intervalWeeks = input.intervalWeeks ?? 4;
  const intervalDays = intervalWeeks * 7;
  const productById = new Map(ctx.products.map(p => [p.id, p]));
  const wet = ctx.flavors.filter(f => f.kind === 'wet');
  const candidateFlavorIds = wet.filter(f => productById.get(f.productId)?.status !== 'retired').map(f => f.id);
  const flavorsByProduct: Record<string, Flavor[]> = {};
  for (const f of wet) (flavorsByProduct[f.productId] ??= []).push(f);

  const flavorMap = new Map(ctx.flavors.map(f => [f.id, f]));
  const onHand = onHandOz(ctx.stockMap, flavorMap);
  const result = allocate({
    cats: ctx.cats, flavors: ctx.flavors, rules: ctx.rules, asOf, summaries: ctx.summaries, states: ctx.states,
    candidateFlavorIds, onHandOz: onHand, intervalDays,
    ...(input.overrides ? { ownerOverrides: input.overrides } : {}),
  });

  const reasons: Record<string, string> = {};
  for (const p of ctx.products) {
    const fs = flavorsByProduct[p.id];
    if (fs?.length) reasons[p.id] = reasonFor(ctx, p, fs);
  }

  const current = ctx.currentOrder?.lines ?? [];
  const sheet: UpdateSheet = buildUpdateSheet({
    current, proposedOzPerDay: result.ozPerDayByFlavor, products: ctx.products, flavorsByProduct,
    onHandOz: onHand, intervalDays, states: ctx.states, reasons,
    ...(input.overrideSwapLimit !== undefined ? { overrideSwapLimit: input.overrideSwapLimit } : {}),
    perCatOz: result.perCatOz, cats: ctx.cats, flavors: flavorMap,
    ...(ctx.currentOrder?.intervalWeeks != null ? { currentIntervalWeeks: ctx.currentOrder.intervalWeeks } : {}),
  });
  sheet.warnings.push(...result.notes);
  if (input.targetCostPerMonth !== undefined) {
    const cost = sheet.summary.costPerMonth;
    const t = input.targetCostPerMonth;
    sheet.warnings.push(
      `Cost per month $${cost.toFixed(2)} is ${cost > t ? 'over' : 'within'} the $${t.toFixed(2)} target` +
      ' (the target does not change the mix in v1).');
  }

  const kept = sheet.lines.filter(l => l.action !== 'REMOVE');
  let orderId: string | null = null;
  const commit = async () => {
    const existing = new Set((await repo.orders.list()).map(o => o.id));
    let id = `plan-${asOf}`;
    for (let n = 2; existing.has(id); n++) id = `plan-${asOf}-${n}`;
    await repo.orders.put({
      id, chewyOrderNo: null, date: asOf, status: 'planned', intervalWeeks,
      total: sheet.summary.costPerShipment,
      lines: kept.map(l => ({ productId: l.productId, qtyCases: l.toQty, casePrice: (() => { const p = productById.get(l.productId); return p ? latestPrice(p) : null; })() })),
    });
    orderId = id;
    return sheet;
  };
  const r = await withConfirm(input.save === true, sheet, commit);
  return { ...r.preview, saved: r.saved, orderId };
}

export async function explainLine(repo: Repo, input: { productId: string }, now: Date = new Date()) {
  const asOf = localToday(now);
  const ctx = await loadContext(repo, asOf);
  const product = ctx.products.find(p => p.id === input.productId);
  if (!product) throw new Error(`Unknown product: ${input.productId}`);
  const flavors = ctx.flavors.filter(f => f.productId === product.id);
  return {
    productId: product.id,
    flavors: flavors.map(f => {
      const perCat: Record<string, Summary> = {};
      const violations: Record<string, Violation[]> = {};
      for (const c of ctx.cats) {
        const s = ctx.summaries[c.id]?.[f.id];
        if (s) perCat[c.name] = s;
        violations[c.name] = checkFlavorForCat(f, c, ctx.rules, asOf);
      }
      return {
        flavorId: f.id, name: f.name, state: ctx.states[f.id] ?? null, perCat,
        stockCans: ctx.stockMap[f.id]?.cans ?? 0, violations,
      };
    }),
  };
}

export function register(server: McpServer, repo: Repo): void {
  server.registerTool('plan_order', {
    description: `Plan the next Chewy order; returns the update sheet data. Writes nothing unless save:true. ${CONFIRM_HINT.split('.')[0]}.`,
    inputSchema: {
      intervalWeeks: z.number().positive().optional(),
      targetCostPerMonth: z.number().positive().optional(),
      overrides: z.record(z.string(), z.number()).optional(),
      overrideSwapLimit: z.boolean().optional(),
      save: z.boolean().optional(),
    },
  }, jsonTool((i: PlanInput) => planOrder(repo, i)));
  server.registerTool('explain_line', {
    description: 'Why a product is on the sheet: state, per-cat scores, stock on hand and rule hits for its flavors.',
    inputSchema: { productId: z.string() },
  }, jsonTool((i: { productId: string }) => explainLine(repo, i)));
}
