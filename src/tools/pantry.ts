import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo } from '../store/repo.js';
import type { Flavor, PantryEvent } from '../domain/types.js';
import { countCheckList, stock } from '../domain/pantry.js';
import { CONFIRM_HINT, jsonTool, withConfirm } from './preview.js';

export async function pantryCount(
  repo: Repo, input: { counts?: Record<string, number>; confirm: boolean }, now: Date = new Date(),
) {
  const flavors = new Map<string, Flavor>((await repo.flavors.list()).map(f => [f.id, f]));
  const stockMap = stock(await repo.pantryEvents.list());
  const { counts } = input;
  if (!counts) {
    const nextOrder = (await repo.ordersByStatus('planned')).concat(await repo.ordersByStatus('confirmed-in-chewy'));
    const products = new Set(nextOrder.flatMap(o => o.lines.map(l => l.productId)));
    const inNext = [...flavors.values()].filter(f => products.has(f.productId)).map(f => f.id);
    const ids = countCheckList(stockMap, flavors, inNext);
    return { saved: false, preview: { checkList: ids.map(id => ({ flavorId: id, name: flavors.get(id)!.name, currentCans: stockMap[id]?.cans ?? 0 })) } };
  }
  const bad = Object.entries(counts).filter(([id, n]) => !flavors.has(id) || !Number.isFinite(n) || n < 0);
  if (bad.length) throw new Error(`Bad counts (unknown flavor or negative/invalid number): ${bad.map(([id]) => id).join(', ')}. Nothing was written.`);
  const at = now.toISOString();
  const events: PantryEvent[] = [];
  const changes = Object.entries(counts).map(([id, counted]) => {
    const current = stockMap[id]?.cans ?? 0;
    const delta = counted - current;
    if (delta !== 0) events.push({ id: `count:${at}:${id}`, flavorId: id, deltaCans: delta, reason: 'count-correction', at, refId: null });
    return { flavorId: id, name: flavors.get(id)!.name, was: current, counted, correction: delta };
  });
  const preview = { changes };
  return withConfirm(input.confirm, preview, async () => {
    for (const e of events) await repo.pantryEvents.put(e);
    return preview;
  });
}

export function register(server: McpServer, repo: Repo): void {
  server.registerTool('pantry_count', {
    description: `Without counts: the list of flavors worth counting. With counts {flavorId: cans on hand}: corrects stock. ${CONFIRM_HINT}`,
    inputSchema: { counts: z.record(z.string(), z.number()).optional(), confirm: z.boolean() },
  }, jsonTool((i: { counts?: Record<string, number>; confirm: boolean }) => pantryCount(repo, i)));
}
