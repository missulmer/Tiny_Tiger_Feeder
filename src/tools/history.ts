import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo, MealQuery } from '../store/repo.js';
import type { Meal, Verdict } from '../domain/types.js';
import { entriesFromMeal } from '../domain/scoring.js';
import { jsonTool } from './preview.js';

export type HistoryRow = {
  date: string; slot: 'AM' | 'PM'; catId: string; flavorId: string;
  verdict: Verdict; score: number; withTopper: boolean;
};

async function rows(repo: Repo, q: MealQuery, keep: (flavorId: string) => boolean): Promise<HistoryRow[]> {
  const cats = new Map((await repo.cats.list()).map(c => [c.id, c]));
  const out: { meal: Meal; row: HistoryRow }[] = [];
  for (const meal of await repo.mealsFor(q)) {
    const cat = cats.get(meal.catId);
    if (!cat) continue;
    for (const e of entriesFromMeal(meal, cat)) {
      if (!keep(e.flavorId)) continue;
      out.push({ meal, row: {
        date: meal.date, slot: meal.slot, catId: meal.catId, flavorId: e.flavorId,
        verdict: meal.verdict, score: e.score, withTopper: e.withTopper,
      } });
    }
  }
  const slotRank = (s: string) => (s === 'AM' ? 0 : 1);
  return out
    .sort((a, b) => a.row.date < b.row.date ? -1 : a.row.date > b.row.date ? 1 : slotRank(a.row.slot) - slotRank(b.row.slot))
    .map(x => x.row);
}

export async function catHistory(repo: Repo, input: { catId: string; from?: string; to?: string }): Promise<HistoryRow[]> {
  if (!(await repo.cats.get(input.catId))) throw new Error(`Unknown cat: ${input.catId}`);
  const q: MealQuery = { catId: input.catId };
  if (input.from !== undefined) q.from = input.from;
  if (input.to !== undefined) q.to = input.to;
  return rows(repo, q, () => true);
}

export async function foodHistory(repo: Repo, input: { flavorId: string }): Promise<HistoryRow[]> {
  if (!(await repo.flavors.get(input.flavorId))) throw new Error(`Unknown flavor: ${input.flavorId}`);
  return rows(repo, { flavorId: input.flavorId }, id => id === input.flavorId);
}

export async function exportAll(repo: Repo): Promise<Record<string, unknown[]>> {
  return repo.exportAll();
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function register(server: McpServer, repo: Repo): void {
  server.registerTool('cat_history', {
    description: 'Meal rows for one cat (date, slot, flavor, verdict, score, topper), oldest first, for charts. Optional from/to dates.',
    inputSchema: { catId: z.string(), from: DATE.optional(), to: DATE.optional() },
  }, jsonTool((i: { catId: string; from?: string; to?: string }) => catHistory(repo, i)));
  server.registerTool('food_history', {
    description: 'Meal rows for one flavor across all cats (date, slot, cat, verdict, score, topper), oldest first, for charts.',
    inputSchema: { flavorId: z.string() },
  }, jsonTool((i: { flavorId: string }) => foodHistory(repo, i)));
  server.registerTool('export_all', {
    description: 'Full JSON backup of every collection.',
    inputSchema: {},
  }, jsonTool(() => exportAll(repo)));
}
