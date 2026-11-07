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

async function requireProducts(repo: Repo, lines: { productId: string; qtyCases: number }[]) {
  for (const l of lines) {
    if (!(l.qtyCases > 0)) throw new Error(`qtyCases for ${l.productId} must be greater than 0.`);
    if (!(await repo.products.get(l.productId))) throw new Error(`Unknown product "${l.productId}". Add it with add_food first.`);
  }
}

export async function recordShipment(
  repo: Repo, input: { source: 'email' | 'screenshot' | 'plan'; order: OrderInput; confirm: boolean },
) {
  const o = input.order;
  if (!DATE_RE.test(o.date)) throw new Error('Order date must be YYYY-MM-DD.');
  if (!o.lines.length) throw new Error('Order has no lines.');
  await requireProducts(repo, o.lines);
  if (o.id && await repo.orders.get(o.id)) throw new Error(`Order id "${o.id}" already exists.`);
  const order: Order = {
    id: o.id ?? await uniqueId(repo.orders, `order-${o.date}`), chewyOrderNo: o.chewyOrderNo ?? null, date: o.date,
    lines: o.lines.map(l => ({ productId: l.productId, qtyCases: l.qtyCases, casePrice: l.casePrice ?? null })),
    total: o.total ?? null, intervalWeeks: o.intervalWeeks ?? null,
    status: input.source === 'plan' ? 'planned' : 'confirmed-in-chewy',
  };
  const preview = { order };
  return withConfirm(input.confirm, preview, async () => { await repo.orders.put(order); return preview; });
}

export async function confirmArrival(
  repo: Repo, input: { orderId: string; adjustments?: { productId: string; qtyCases: number }[]; confirm: boolean },
  now: Date = new Date(),
) {
  const order = await repo.orders.get(input.orderId);
  if (!order) throw new Error(`Order "${input.orderId}" not found.`);
  if (order.status === 'arrived') throw new Error(`Order "${order.id}" already arrived; refusing to add its stock twice.`);
  const adj = new Map((input.adjustments ?? []).map(a => [a.productId, a.qtyCases]));
  for (const [pid, q] of adj) {
    if (!order.lines.some(l => l.productId === pid)) throw new Error(`Adjustment for product "${pid}" which is not on the order.`);
    if (!(q >= 0)) throw new Error(`Adjustment qtyCases for ${pid} must be 0 or more.`);
  }
  const lines: OrderLine[] = order.lines.map(l => ({ ...l, qtyCases: adj.get(l.productId) ?? l.qtyCases }));
  const products = new Map((await repo.products.list()).map(p => [p.id, p]));
  const flavorsByProduct = new Map<string, Flavor[]>();
  for (const f of await repo.flavors.list()) flavorsByProduct.set(f.productId, [...(flavorsByProduct.get(f.productId) ?? []), f]);
  const events = eventsForArrival(lines, products, flavorsByProduct, now.toISOString(), order.id);
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
  await requireProducts(repo, input.lines);
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
  const qty = z.object({ productId: z.string(), qtyCases: z.number() });
  server.registerTool('record_shipment', {
    description: `Record an order from an email, screenshot, or the plan. Source "plan" stores it as planned; others as confirmed-in-chewy. ${CONFIRM_HINT}`,
    inputSchema: {
      source: z.enum(['email', 'screenshot', 'plan']),
      order: z.object({
        id: z.string().optional(), chewyOrderNo: z.string().nullable().optional(), date: z.string(),
        lines: z.array(z.object({ productId: z.string(), qtyCases: z.number(), casePrice: z.number().nullable().optional() })),
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
