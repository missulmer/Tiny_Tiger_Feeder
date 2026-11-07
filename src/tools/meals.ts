import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo } from '../store/repo.js';
import type { Flavor, Meal, Plate, Verdict, VomitCause } from '../domain/types.js';
import { checkPlate, type Violation } from '../domain/rules.js';
import { eventsForMeal } from '../domain/pantry.js';
import { CONFIRM_HINT, jsonTool } from './preview.js';
import { DATE_RE } from './time.js';

export type MealInput = Omit<Meal, 'id' | 'loggedAt' | 'choice' | 'vomitCause' | 'sideOutcome' | 'isTaster' | 'source' | 'note'> &
  Partial<Pick<Meal, 'choice' | 'vomitCause' | 'sideOutcome' | 'isTaster' | 'source' | 'note'>>;

const VERDICTS: Verdict[] = ['clean', 'bites_left', 'half', 'rejected', 'ate_then_vomited'];

function plateFlavorIds(p: Plate): string[] {
  const ids = [...p.items, ...p.toppers].map(i => i.flavorId);
  if (p.side) ids.push(p.side.flavorId);
  return ids;
}

export async function logMeal(
  repo: Repo,
  input: { meals: MealInput[]; confirm: boolean; acknowledgeViolations?: boolean; acknowledgeDuplicates?: boolean },
  now: Date = new Date(),
) {
  const { meals: inputs, confirm } = input;
  if (!inputs.length) throw new Error('No meals given.');
  const flavors = new Map<string, Flavor>((await repo.flavors.list()).map(f => [f.id, f]));
  const cats = new Map((await repo.cats.list()).map(c => [c.id, c]));
  const unknown = new Set<string>();
  for (const m of inputs) {
    if (!cats.has(m.catId)) throw new Error(`Unknown cat "${m.catId}". Nothing was logged.`);
    if (!DATE_RE.test(m.date)) throw new Error(`Date "${m.date}" must be YYYY-MM-DD.`);
    if (m.slot !== 'AM' && m.slot !== 'PM') throw new Error(`Slot must be AM or PM (got ${String(m.slot)}).`);
    if (!VERDICTS.includes(m.verdict)) throw new Error(`Unknown verdict "${String(m.verdict)}".`);
    if (!m.plates.length) throw new Error(`Meal for ${m.catId} has no plates.`);
    if (m.choice && !(m.choice.pickedIdx >= 0 && m.choice.pickedIdx < m.plates.length)) {
      throw new Error(`choice.pickedIdx ${m.choice.pickedIdx} is outside the plates for ${m.catId}.`);
    }
    for (const p of m.plates) for (const id of plateFlavorIds(p)) if (!flavors.has(id)) unknown.add(id);
  }
  if (unknown.size) {
    throw new Error(`Unknown flavor id(s): ${[...unknown].join(', ')}. Use find_food to resolve them. Nothing was logged.`);
  }

  const existing = await repo.meals.list();
  const usedIds = new Set(existing.map(m => m.id));
  const rules = await repo.rules.list();
  const loggedAt = now.toISOString();
  const meals: Meal[] = [];
  const duplicates: { catId: string; date: string; slot: string; existingMealId: string }[] = [];
  const violations: (Violation & { mealId: string })[] = [];
  for (const m of inputs) {
    let n = 1;
    while (usedIds.has(`${m.catId}:${m.date}:${m.slot}:${n}`)) n++;
    const id = `${m.catId}:${m.date}:${m.slot}:${n}`;
    usedIds.add(id);
    const meal: Meal = {
      id, catId: m.catId, date: m.date, slot: m.slot, plates: m.plates, choice: m.choice ?? null,
      verdict: m.verdict, vomitCause: (m.vomitCause ?? null) as VomitCause | null, sideOutcome: m.sideOutcome ?? null,
      isTaster: m.isTaster ?? false, source: m.source ?? 'observed', note: m.note ?? null, loggedAt,
    };
    if (!meal.choice) {
      for (const other of [...existing, ...meals]) {
        if (other.catId === meal.catId && other.date === meal.date && other.slot === meal.slot && !other.choice) {
          duplicates.push({ catId: meal.catId, date: meal.date, slot: meal.slot, existingMealId: other.id });
        }
      }
    }
    for (const p of meal.plates) {
      for (const v of checkPlate(p, cats.get(meal.catId)!, flavors, rules, meal.date)) violations.push({ ...v, mealId: id });
    }
    meals.push(meal);
  }

  const lines = meals.map(m => {
    const cat = cats.get(m.catId)!;
    const plates = m.plates.map(p =>
      plateFlavorIds(p).map(id => flavors.get(id)!.name).join(' + ')).join(' | ');
    return `${cat.name}, ${m.date} ${m.slot}: ${plates}${m.choice ? ` (picked plate ${m.choice.pickedIdx + 1})` : ''} - ${m.verdict}${m.source === 'recalled' ? ' (recalled)' : ''}`;
  });
  const preview = { lines, violations, duplicates };
  if (!confirm) return { saved: false, preview };
  if (violations.length && !input.acknowledgeViolations) {
    return { saved: false, preview, reason: 'Violations found; nothing saved. Tell the owner and re-call with acknowledgeViolations:true only if she agrees.' };
  }
  if (duplicates.length && !input.acknowledgeDuplicates) {
    return { saved: false, preview, reason: 'Duplicate meal(s) for the same cat/date/slot; nothing saved. Re-call with acknowledgeDuplicates:true only if she confirms it is a separate meal.' };
  }
  for (const m of meals) {
    await repo.meals.put(m);
    for (const e of eventsForMeal(m, flavors)) await repo.pantryEvents.put(e);
  }
  return { saved: true, preview };
}

export function register(server: McpServer, repo: Repo): void {
  const item = z.object({ flavorId: z.string(), amountOz: z.number() });
  const plate = z.object({
    items: z.array(item), toppers: z.array(item),
    side: z.object({ flavorId: z.string(), amount: z.number() }).nullable(),
  });
  server.registerTool('log_meal', {
    description: `Log meals eaten. Every flavor id must exist (find_food first). Preview lists violations and duplicates; saving needs acknowledgeViolations / acknowledgeDuplicates when present. ${CONFIRM_HINT}`,
    inputSchema: {
      meals: z.array(z.object({
        catId: z.string(), date: z.string(), slot: z.enum(['AM', 'PM']), plates: z.array(plate),
        choice: z.object({ pickedIdx: z.number() }).nullable().optional(),
        verdict: z.enum(['clean', 'bites_left', 'half', 'rejected', 'ate_then_vomited']),
        vomitCause: z.enum(['food', 'hairball', 'unsure']).nullable().optional(),
        sideOutcome: z.enum(['all', 'some', 'none']).nullable().optional(),
        isTaster: z.boolean().optional(), source: z.enum(['observed', 'recalled']).optional(),
        note: z.string().nullable().optional(),
      })),
      confirm: z.boolean(),
      acknowledgeViolations: z.boolean().optional(),
      acknowledgeDuplicates: z.boolean().optional(),
    },
  }, jsonTool((i: Parameters<typeof logMeal>[1]) => logMeal(repo, i)));
}
