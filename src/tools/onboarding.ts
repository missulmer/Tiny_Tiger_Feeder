import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo } from '../store/repo.js';
import type { Flavor, Meal, Verdict } from '../domain/types.js';
import { CONFIRM_HINT, jsonTool, withConfirm } from './preview.js';
import { localToday } from './time.js';

export async function markProven(repo: Repo, input: { flavorIds: string[]; confirm: boolean }) {
  const flavors: Flavor[] = [];
  const missing: string[] = [];
  for (const id of input.flavorIds) {
    const f = await repo.flavors.get(id);
    if (f) flavors.push(f); else missing.push(id);
  }
  if (missing.length) throw new Error(`Unknown flavor id(s): ${missing.join(', ')}. Nothing was changed.`);
  const preview = { markedProven: flavors.map(f => ({ id: f.id, name: f.name })) };
  return withConfirm(input.confirm, preview, async () => {
    for (const f of flavors) await repo.flavors.put({ ...f, provenAtOnboarding: true });
    return preview;
  });
}

const VERDICTS: Verdict[] = ['clean', 'bites_left', 'half', 'rejected', 'ate_then_vomited'];

export async function logRecalledVerdicts(
  repo: Repo, input: { catId: string; verdicts: { flavorId: string; verdict: Verdict }[]; confirm: boolean },
  now: Date = new Date(),
) {
  const cat = await repo.cats.get(input.catId);
  if (!cat) throw new Error(`Unknown cat "${input.catId}".`);
  const date = localToday(now);
  const meals: Meal[] = [];
  const missing: string[] = [];
  for (const v of input.verdicts) {
    if (!VERDICTS.includes(v.verdict)) throw new Error(`Unknown verdict "${String(v.verdict)}".`);
    const f = await repo.flavors.get(v.flavorId);
    if (!f) { missing.push(v.flavorId); continue; }
    meals.push({
      id: `${cat.id}:${date}:AM:recalled:${f.id}`, catId: cat.id, date, slot: 'AM',
      plates: [{ items: [{ flavorId: f.id, amountOz: 0 }], toppers: [], side: null }],
      choice: null, verdict: v.verdict, vomitCause: null, sideOutcome: null, isTaster: false,
      source: 'recalled', note: null, loggedAt: now.toISOString(),
    });
  }
  if (missing.length) throw new Error(`Unknown flavor id(s): ${missing.join(', ')}. Nothing was written.`);
  const preview = { cat: cat.name, verdicts: meals.map(m => ({ flavorId: m.plates[0]!.items[0]!.flavorId, verdict: m.verdict })) };
  return withConfirm(input.confirm, preview, async () => {
    for (const m of meals) await repo.meals.put(m);
    return preview;
  });
}

export function register(server: McpServer, repo: Repo): void {
  server.registerTool('mark_proven', {
    description: `Mark flavors as proven (cats already known to eat them) during onboarding. ${CONFIRM_HINT}`,
    inputSchema: { flavorIds: z.array(z.string()), confirm: z.boolean() },
  }, jsonTool((i: { flavorIds: string[]; confirm: boolean }) => markProven(repo, i)));
  server.registerTool('log_recalled_verdicts', {
    description: `Record remembered verdicts for a cat per flavor (no pantry change). ${CONFIRM_HINT}`,
    inputSchema: {
      catId: z.string(),
      verdicts: z.array(z.object({ flavorId: z.string(), verdict: z.enum(['clean', 'bites_left', 'half', 'rejected', 'ate_then_vomited']) })),
      confirm: z.boolean(),
    },
  }, jsonTool((i: Parameters<typeof logRecalledVerdicts>[1]) => logRecalledVerdicts(repo, i)));
}
