import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo } from '../store/repo.js';
import type { Flavor, Order, OrderLine } from '../domain/types.js';
import { eventsForArrival } from '../domain/pantry.js';
import { CONFIRM_HINT, jsonTool, uniqueId, withConfirm } from './preview.js';
import { DATE_RE } from './time.js';

export type OrderInput = {
  id?: string; chewyOrderNo?: string | null; date: string;
  lines: { productId: string; qtyCases: number; casePrice?: number | null }[];
  total?: number | null; intervalWeeks?: number | null;
};

/** Each product may appear once; qtyCases must be a whole number (and at least `min`). */
function checkLines(lines: { productId: string; qtyCases: number }[], min: 0 | 1, what: string): void {
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.productId)) throw new Error(`Product "${l.productId}" appears more than once in the ${what}. List each product once with its total cases.`);
    seen.add(l.productId);
    if (!Number.isInteger(l.qtyCases)) throw new Error(`qtyCases for ${l.productId} must be a whole number of cases (got ${String(l.qtyCases)}).`);
    if (l.qtyCases < min) throw new Error(`qtyCases for ${l.productId} must be ${min === 1 ? 'greater than 0' : '0 or more'}.`);
  }
}

async function requireProducts(repo: Repo, lines: { productId: string; qtyCases: number }[], what: string) {
  checkLines(lines, 1, what);
  for (const l of lines) {
    if (!(await repo.products.get(l.productId))) throw new Error(`Unknown product "${l.productId}". Add it with add_food first.`);
  }
}

export async function recordShipment(
  repo: Repo, input: { source: 'email' | 'screenshot' | 'plan'; order: OrderInput; confirm: boolean },
) {
  const o = input.order;
  if (!DATE_RE.test(o.date)) throw new Error('Order date must be YYYY-MM-DD.');
  if (!o.lines.length) throw new Error('Order has no lines.');
  await requireProducts(repo, o.lines, 'order');
  for (const l of o.lines) {
    if (l.casePrice != null && !(Number.isFinite(l.casePrice) && l.casePrice > 0)) {
      throw new Error(`casePrice for ${l.productId} must be greater than 0 (got ${String(l.casePrice)}).`);
    }
  }
  if (o.id && await repo.orders.get(o.id)) throw new Error(`Order id "${o.id}" already exists.`);
  const order: Order = {
    id: o.id ?? await uniqueId(repo.orders, `order-${o.date}`), chewyOrderNo: o.chewyOrderNo ?? null, date: o.date,
    lines: o.lines.map(l => ({ productId: l.productId, qtyCases: l.qtyCases, casePrice: l.casePrice ?? null })),
    total: o.total ?? null, intervalWeeks: o.intervalWeeks ?? null,
    status: input.source === 'plan' ? 'planned' : 'confirmed-in-chewy',
  };
  // Case prices seen on this order are added to each product's price history (C1).
  const pricesToRecord = order.lines
    .filter((l): l is OrderLine & { casePrice: number } => l.casePrice !== null)
    .map(l => ({ productId: l.productId, casePrice: l.casePrice, seenOn: order.date }));
  const preview = { order, pricesToRecord };
  return withConfirm(input.confirm, preview, async () => {
    await repo.orders.put(order);
    for (const p of pricesToRecord) {
      const product = await repo.products.get(p.productId);
      if (!product) continue;
      const entry = { casePrice: p.casePrice, seenOn: p.seenOn, source: input.source };
      const dup = product.prices.some(x => x.casePrice === entry.casePrice && x.seenOn === entry.seenOn && x.source === entry.source);
      if (!dup) await repo.products.put({ ...product, prices: [...product.prices, entry] });
    }
    return preview;
  });
}

export async function confirmArrival(
  repo: Repo, input: { orderId: string; adjustments?: { productId: string; qtyCases: number }[]; confirm: boolean },
  now: Date = new Date(),
) {
  const order = await repo.orders.get(input.orderId);
  if (!order) throw new Error(`Order "${input.orderId}" not found.`);
  if (order.status === 'arrived') throw new Error(`Order "${order.id}" already arrived; refusing to add its stock twice.`);
  checkLines(input.adjustments ?? [], 0, 'adjustments');
  const adj = new Map((input.adjustments ?? []).map(a => [a.productId, a.qtyCases]));
  for (const pid of adj.keys()) {
    if (!order.lines.some(l => l.productId === pid)) throw new Error(`Adjustment for product "${pid}" which is not on the order.`);
  }
  const lines: OrderLine[] = order.lines.map(l => ({ ...l, qtyCases: adj.get(l.productId) ?? l.qtyCases }));
  const products = new Map((await repo.products.list()).map(p => [p.id, p]));
  const flavorsByProduct = new Map<string, Flavor[]>();
  for (const f of await repo.flavors.list()) flavorsByProduct.set(f.productId, [...(flavorsByProduct.get(f.productId) ?? []), f]);
  // A line adjusted to 0 cases (nothing came) adds no stock event.
  const events = eventsForArrival(lines, products, flavorsByProduct, now.toISOString(), order.id).filter(e => e.deltaCans !== 0);
  const flavorNames = new Map([...flavorsByProduct.values()].flat().map(f => [f.id, f.name]));
  const preview = {
    orderId: order.id, lines,
    stockAdded: events.map(e => ({ flavorId: e.flavorId, name: flavorNames.get(e.flavorId), cans: e.deltaCans })),
  };
  return withConfirm(input.confirm, preview, async () => {
    for (const e of events) await repo.pantryEvents.put(e);
    await repo.orders.put({ ...order, lines, status: 'arrived' });
    return preview;
  });
}

export async function confirmInChewy(
  repo: Repo, input: { orderId: string; lines: { productId: string; qtyCases: number }[]; confirm: boolean },
) {
  const order = await repo.orders.get(input.orderId);
  if (!order) throw new Error(`Order "${input.orderId}" not found.`);
  if (order.status === 'arrived') throw new Error(`Order "${order.id}" already arrived.`);
  await requireProducts(repo, input.lines, 'Chewy lines');
  const planned = new Map(order.lines.map(l => [l.productId, l.qtyCases]));
  const seen = new Map(input.lines.map(l => [l.productId, l.qtyCases]));
  const differences = [...new Set([...planned.keys(), ...seen.keys()])]
    .map(productId => ({ productId, planned: planned.get(productId) ?? 0, inChewy: seen.get(productId) ?? 0 }))
    .filter(d => d.planned !== d.inChewy);
  const preview = { orderId: order.id, differences };
  return withConfirm(input.confirm, preview, async () => {
    const prices = new Map(order.lines.map(l => [l.productId, l.casePrice]));
    const lines: OrderLine[] = input.lines.map(l => ({ productId: l.productId, qtyCases: l.qtyCases, casePrice: prices.get(l.productId) ?? null }));
    await repo.orders.put({ ...order, lines, status: 'confirmed-in-chewy' });
    return preview;
  });
}

export function register(server: McpServer, repo: Repo): void {
  const qty = z.object({ productId: z.string(), qtyCases: z.number().int().min(0) });
  server.registerTool('record_shipment', {
    description: `Record an autoship order from an email, screenshot, or the plan. Source "plan" stores it as planned; others as confirmed-in-chewy. Line case prices are added to each product's prices. ${CONFIRM_HINT}`,
    inputSchema: {
      source: z.enum(['email', 'screenshot', 'plan']),
      order: z.object({
        id: z.string().optional(), chewyOrderNo: z.string().nullable().optional(), date: z.string(),
        lines: z.array(z.object({ productId: z.string(), qtyCases: z.number().int().min(1), casePrice: z.number().positive().nullable().optional() })),
        total: z.number().nullable().optional(), intervalWeeks: z.number().nullable().optional(),
      }),
      confirm: z.boolean(),
    },
  }, jsonTool((i: Parameters<typeof recordShipment>[1]) => recordShipment(repo, i)));
  server.registerTool('confirm_arrival', {
    description: `Mark an order arrived and add its cans to the pantry. adjustments override quantities actually received. Once only per order. ${CONFIRM_HINT}`,
    inputSchema: { orderId: z.string(), adjustments: z.array(qty).optional(), confirm: z.boolean() },
  }, jsonTool((i: Parameters<typeof confirmArrival>[1]) => confirmArrival(repo, i)));
  server.registerTool('confirm_in_chewy', {
    description: `Compare lines read from the Chewy autoship screen with the stored order; reports differences, and on confirm adopts Chewy's lines. ${CONFIRM_HINT}`,
    inputSchema: { orderId: z.string(), lines: z.array(qty), confirm: z.boolean() },
  }, jsonTool((i: Parameters<typeof confirmInChewy>[1]) => confirmInChewy(repo, i)));
}
