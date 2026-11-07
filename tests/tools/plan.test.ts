import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryRepo } from '../../src/store/memoryRepo.js';
import type { Repo } from '../../src/store/repo.js';
import { planOrder, explainLine } from '../../src/tools/plan.js';
import { catHistory, foodHistory, exportAll } from '../../src/tools/history.js';
import { cats, chickenPate, funkInTheTrunk, product, salmonPate, fishTrial } from '../fixtures/household.js';
import { localToday } from '../../src/tools/time.js';
import type { Meal } from '../../src/domain/types.js';

let repo: Repo;
const meal = (id: string, catId: string, date: string, flavorId: string, verdict: Meal['verdict'] = 'clean'): Meal => ({
  id, catId, date, slot: 'AM', plates: [{ items: [{ flavorId, amountOz: 3 }], toppers: [], side: null }],
  choice: null, verdict, vomitCause: null, sideOutcome: null, isTaster: false, source: 'observed',
  note: null, loggedAt: `${date}T08:00:00Z`,
});

beforeEach(async () => {
  repo = createMemoryRepo();
  for (const c of cats) await repo.cats.put(c);
  for (const f of [chickenPate, funkInTheTrunk, salmonPate]) {
    await repo.flavors.put({ ...f, provenAtOnboarding: true });
    await repo.products.put(product({ id: f.productId }));
  }
  await repo.rules.put({ ...fishTrial, startsOn: '2020-01-01', endsOn: null });
  await repo.orders.put({
    id: 'o1', chewyOrderNo: 'C1', date: '2026-10-10', total: null, intervalWeeks: 4, status: 'confirmed-in-chewy',
    lines: [{ productId: chickenPate.productId, qtyCases: 6, casePrice: 24 }],
  });
  await repo.meals.put(meal('m1', 'vanta', localToday(), 'chicken-pate'));
});

describe('plan_order', () => {
  it('returns lines and a summary within the order-math tolerance', async () => {
    const sheet = await planOrder(repo, { intervalWeeks: 4 });
    expect(sheet.lines.length).toBeGreaterThan(0);
    expect(sheet.intervalWeeks).toEqual({ from: 4, to: 4 });
    expect(sheet.lines.every(l => l.reason.length > 0)).toBe(true);
    const s = sheet.summary;
    expect(Math.abs(s.daysOfFood - s.intervalWeeks * 7 - s.slackDays)).toBeLessThan(1e-6);
    expect(s.daysOfFood).toBeGreaterThanOrEqual(0);
  });

  it('warns when cost exceeds targetCostPerMonth', async () => {
    const sheet = await planOrder(repo, { targetCostPerMonth: 1 });
    expect(sheet.warnings.some(w => w.includes('target'))).toBe(true);
  });

  it('save omitted writes nothing; save:true stores planned order', async () => {
    await planOrder(repo, {});
    expect(await repo.ordersByStatus('planned')).toHaveLength(0);
    const sheet = await planOrder(repo, { save: true });
    const planned = await repo.ordersByStatus('planned');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.intervalWeeks).toBe(4);
    expect(planned[0]!.lines.map(l => l.productId).sort())
      .toEqual(sheet.lines.filter(l => l.action !== 'REMOVE').map(l => l.productId).sort());
  });
});

describe('explain_line / history / export', () => {
  it('explain_line returns per-cat summaries, state, stock and violations', async () => {
    await repo.meals.put(meal('ms', 'vanta', '2026-10-01', 'salmon-pate'));
    const r = await explainLine(repo, { productId: salmonPate.productId });
    expect(r.productId).toBe(salmonPate.productId);
    expect(r.flavors[0]!.flavorId).toBe('salmon-pate');
    expect(r.flavors[0]!.perCat['Vanta']).toBeDefined();
    expect(r.flavors[0]!.violations['Vanta']!.length).toBeGreaterThan(0);
    expect(r.flavors[0]!.stockCans).toBe(0);
  });

  it('cat_history and food_history return sorted rows', async () => {
    await repo.meals.put(meal('m0', 'vanta', '2026-01-01', 'chicken-pate', 'half'));
    const rows = await catHistory(repo, { catId: 'vanta' });
    expect(rows.map(r => r.date)).toEqual(['2026-01-01', localToday()]);
    expect(rows[0]).toMatchObject({ slot: 'AM', catId: 'vanta', flavorId: 'chicken-pate', verdict: 'half', score: 0.5, withTopper: false });
    expect(await catHistory(repo, { catId: 'vanta', from: '2026-06-01' })).toHaveLength(1);
    expect(await foodHistory(repo, { flavorId: 'chicken-pate' })).toHaveLength(2);
  });

  it('export_all returns repo export', async () => {
    const all = await exportAll(repo);
    expect(all.cats).toHaveLength(5);
  });
});
