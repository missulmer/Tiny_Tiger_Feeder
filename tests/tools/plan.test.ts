import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryRepo } from '../../src/store/memoryRepo.js';
import type { Repo } from '../../src/store/repo.js';
import { planOrder, explainLine, register as registerPlan } from '../../src/tools/plan.js';
import { recordShipment, confirmArrival, confirmInChewy } from '../../src/tools/shipments.js';
import { pantryCount } from '../../src/tools/pantry.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { catHistory, foodHistory, exportAll } from '../../src/tools/history.js';
import { cats, chickenPate, flavor, funkInTheTrunk, product, salmonPate, fishTrial } from '../fixtures/household.js';
import { localToday } from '../../src/tools/time.js';
import type { Flavor, Meal } from '../../src/domain/types.js';

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
    const sheet = await planOrder(repo, { intervalWeeks: 4, confirm: false });
    expect(sheet.lines.length).toBeGreaterThan(0);
    expect(sheet.intervalWeeks).toEqual({ from: 4, to: 4 });
    expect(sheet.lines.every(l => l.reason.length > 0)).toBe(true);
    const s = sheet.summary;
    // Slack is measured against the chosen interval (R20), not the fitted one.
    expect(Math.abs(s.daysOfFood - sheet.intervalWeeks.to * 7 - s.slackDays)).toBeLessThan(1e-6);
    expect(s.daysOfFood).toBeGreaterThanOrEqual(0);
  });

  it('warns when cost exceeds targetCostPerMonth', async () => {
    const sheet = await planOrder(repo, { targetCostPerMonth: 1, confirm: false });
    expect(sheet.warnings.some(w => w.includes('target'))).toBe(true);
  });

  it('confirm:false writes nothing; confirm:true stores planned order', async () => {
    const pre = await planOrder(repo, { confirm: false });
    expect(pre.saved).toBe(false);
    expect(await repo.ordersByStatus('planned')).toHaveLength(0);
    const sheet = await planOrder(repo, { confirm: true });
    expect(sheet.saved).toBe(true);
    const planned = await repo.ordersByStatus('planned');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.intervalWeeks).toBe(4);
    expect(planned[0]!.lines.map(l => l.productId).sort())
      .toEqual(sheet.lines.filter(l => l.action !== 'REMOVE').map(l => l.productId).sort());
  });
});

describe('plan_order rules', () => {
  it('removes a fish product from the current order under a no-fish rule', async () => {
    await repo.orders.put({
      id: 'o1', chewyOrderNo: 'C1', date: '2026-10-10', total: null, intervalWeeks: 4, status: 'confirmed-in-chewy',
      lines: [
        { productId: chickenPate.productId, qtyCases: 6, casePrice: 24 },
        { productId: salmonPate.productId, qtyCases: 4, casePrice: 24 },
      ],
    });
    const sheet = await planOrder(repo, { overrides: { 'salmon-pate': 3 }, overrideSwapLimit: true, confirm: false });
    const line = sheet.lines.find(l => l.productId === salmonPate.productId)!;
    expect(line.action).toBe('REMOVE');
    expect(sheet.lines.filter(l => l.action !== 'REMOVE' && l.productId === salmonPate.productId)).toHaveLength(0);
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

describe('plan_order: final-review fixes (tool level)', () => {
  const lamb = flavor({ id: 'lamb-pate', name: 'Lamb Pate', primaryProtein: 'lamb' });
  const turkey = flavor({ id: 'turkey-pate', name: 'Turkey Pate', primaryProtein: 'turkey' });
  const duck = flavor({ id: 'duck-pate', name: 'Duck Pate', primaryProtein: 'duck' });

  async function household(fs: { f: Flavor; proven: boolean }[], prices = true): Promise<Repo> {
    const r = createMemoryRepo();
    for (const c of cats) await r.cats.put(c);
    for (const { f, proven } of fs) {
      await r.flavors.put(proven ? { ...f, provenAtOnboarding: true } : f);
      await r.products.put(product({ id: f.productId, ...(prices ? {} : { prices: [] }) }));
    }
    return r;
  }
  const record = (r: Repo, id: string, date: string, lines: { productId: string; qtyCases: number; casePrice?: number }[]) =>
    recordShipment(r, { source: 'screenshot', order: { id, date, lines, intervalWeeks: 4 }, confirm: true });

  it('C1: case prices recorded by record_shipment reach the sheet', async () => {
    const r = await household([{ f: chickenPate, proven: true }, { f: funkInTheTrunk, proven: true }], false);
    await record(r, 'on1', '2026-09-01', [
      { productId: chickenPate.productId, qtyCases: 2, casePrice: 24 }, { productId: funkInTheTrunk.productId, qtyCases: 1, casePrice: 30 }]);
    await record(r, 'on2', '2026-10-01', [
      { productId: chickenPate.productId, qtyCases: 3, casePrice: 25 }, { productId: funkInTheTrunk.productId, qtyCases: 2, casePrice: 31 }]);
    const sheet = await planOrder(r, { confirm: true });
    expect(sheet.summary.costPerShipment).toBeGreaterThan(0);
    expect(sheet.warnings.filter(w => w.includes('No case price'))).toEqual([]);
    const planned = (await r.ordersByStatus('planned'))[0]!;
    expect(planned.lines.find(l => l.productId === chickenPate.productId)!.casePrice).toBe(25);
  });

  it('C1: a variety pack with no price says "no price", never "$0.00"', async () => {
    const r = await household([{ f: chickenPate, proven: true }]);
    const vf = flavor({ id: 'vp-chicken', name: 'VP Chicken', primaryProtein: 'chicken', productId: 'vp' });
    await r.flavors.put({ ...vf, provenAtOnboarding: true });
    await r.products.put(product({ id: 'vp', isVarietyPack: true, prices: [] }));
    await r.meals.put(meal('mv', 'vanta', localToday(), 'vp-chicken'));
    await r.orders.put({ id: 'o', chewyOrderNo: null, date: '2026-10-01', total: null, intervalWeeks: 4, status: 'arrived',
      lines: [{ productId: 'vp', qtyCases: 1, casePrice: null }] });
    const sheet = await planOrder(r, { confirm: false });
    const line = sheet.lines.find(l => l.productId === 'vp')!;
    expect(line.reason).toContain('no price');
    expect(JSON.stringify(sheet)).not.toContain('$0.00');
  });

  it('C2: after arrival the next plan compares against the arrived order', async () => {
    const r = await household([{ f: chickenPate, proven: true }, { f: lamb, proven: true }, { f: funkInTheTrunk, proven: true }]);
    await record(r, 'on1', '2026-08-01', [{ productId: chickenPate.productId, qtyCases: 4 }, { productId: lamb.productId, qtyCases: 2 }]);
    await record(r, 'on2', '2026-09-01', [{ productId: chickenPate.productId, qtyCases: 4 }, { productId: lamb.productId, qtyCases: 2 }]);
    const p1 = await planOrder(r, { intervalWeeks: 3, confirm: true });
    expect(p1.orderId).not.toBeNull();
    const stored = (await r.orders.get(p1.orderId!))!;
    const chewyLines = stored.lines.map(l => ({ productId: l.productId, qtyCases: l.productId === chickenPate.productId ? 7 : l.qtyCases }));
    await confirmInChewy(r, { orderId: stored.id, lines: chewyLines, confirm: true });
    await confirmArrival(r, { orderId: stored.id, confirm: true });

    const p2 = await planOrder(r, { confirm: false });
    expect(p2.intervalWeeks.from).toBe(3);
    const fromLines = p2.lines.filter(l => l.action !== 'ADD');
    expect(Object.fromEntries(fromLines.map(l => [l.productId, l.fromQty])))
      .toEqual(Object.fromEntries(chewyLines.map(l => [l.productId, l.qtyCases])));
    for (const l of fromLines) expect(['KEEP', 'CHANGE', 'REMOVE']).toContain(l.action);
    expect(p2.lines.filter(l => l.action === 'ADD').map(l => l.productId))
      .not.toContain(chickenPate.productId);
  });

  it('I1: slack uses the chosen interval; a shortfall warns how many days early food runs out', async () => {
    const ok = await planOrder(repo, { intervalWeeks: 3, confirm: false });
    expect(ok.summary.slackDays).toBeCloseTo(ok.summary.daysOfFood - 21, 9);

    const r = await household([{ f: chickenPate, proven: false }, { f: lamb, proven: false }]);
    const short = await planOrder(r, { confirm: false });
    const days = short.summary.daysOfFood;
    expect(days).toBeLessThan(28);
    expect(short.summary.slackDays).toBeCloseTo(days - 28, 9);
    expect(short.warnings).toContain(`Food runs out about ${Math.ceil(28 - days)} days before the next shipment`);
  });

  it('I2: a pantry-covered staple is not REMOVEd, and coming back does not burn the one swap', async () => {
    const r = await household([
      { f: chickenPate, proven: true }, { f: lamb, proven: true }, { f: turkey, proven: false }, { f: duck, proven: false }]);
    await record(r, 'on1', '2026-09-01', [{ productId: chickenPate.productId, qtyCases: 4 }, { productId: lamb.productId, qtyCases: 2 }]);
    await pantryCount(r, { counts: { 'lamb-pate': 500 }, confirm: true });

    const p1 = await planOrder(r, { confirm: true });
    const lambLine = p1.lines.find(l => l.productId === lamb.productId)!;
    expect(lambLine).toMatchObject({ action: 'KEEP', fromQty: 2, toQty: 0, reason: 'Covered by stock on hand this shipment' });
    const newAdds = p1.lines.filter(l => l.action === 'ADD').map(l => l.productId);
    expect(newAdds).toHaveLength(1);
    const heldBack = [turkey.productId, duck.productId].find(id => !newAdds.includes(id))!;
    expect(p1.warnings).toContain(`Also worth adding: ${heldBack} (held back by the one-swap rule)`);

    const stored = (await r.orders.get(p1.orderId!))!;
    expect(stored.lines.map(l => l.productId)).not.toContain(lamb.productId);
    await confirmInChewy(r, { orderId: stored.id, lines: stored.lines.map(l => ({ productId: l.productId, qtyCases: l.qtyCases })), confirm: true });
    await confirmArrival(r, { orderId: stored.id, confirm: true });
    await pantryCount(r, { counts: { 'lamb-pate': 0 }, confirm: true });

    const p2 = await planOrder(r, { confirm: false });
    const adds = p2.lines.filter(l => l.action === 'ADD').map(l => l.productId).sort();
    expect(adds).toEqual([heldBack, lamb.productId].sort());
    expect(p2.warnings.filter(w => w.includes('one-swap'))).toEqual([]);
  });

  it('M3 + confirm: intervalWeeks must be a whole number of weeks and confirm is required', async () => {
    await expect(planOrder(repo, { intervalWeeks: 2.5, confirm: false })).rejects.toThrow(/intervalWeeks/);
    await expect(planOrder(repo, { intervalWeeks: 0, confirm: false })).rejects.toThrow(/intervalWeeks/);
    const server = new McpServer({ name: 't', version: '0' });
    registerPlan(server, repo);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.callTool({ name: 'plan_order', arguments: { intervalWeeks: 2.5, confirm: false } })).isError).toBe(true);
    expect((await client.callTool({ name: 'plan_order', arguments: { save: true } })).isError).toBe(true);
    expect(await repo.ordersByStatus('planned')).toHaveLength(0);
    const ok = await client.callTool({ name: 'plan_order', arguments: { intervalWeeks: 3, confirm: false } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse((ok.content as { text: string }[])[0]!.text).saved).toBe(false);
  });
});

describe('R21: covered stock (tool level)', () => {
  const lamb = flavor({ id: 'lamb-pate', name: 'Lamb Pate', primaryProtein: 'lamb' });

  async function setup(): Promise<Repo> {
    const r = createMemoryRepo();
    for (const c of cats) await r.cats.put(c);
    for (const f of [chickenPate, lamb]) {
      await r.flavors.put({ ...f, provenAtOnboarding: true });
      await r.products.put(product({ id: f.productId }));
    }
    return r;
  }

  it('stock covering more than one interval keeps lamb on the sheet and in days of food', async () => {
    const r = await setup();
    await recordShipment(r, { source: 'screenshot', confirm: true, order: { id: 'on1', date: '2026-09-01', intervalWeeks: 4,
      lines: [{ productId: chickenPate.productId, qtyCases: 4 }, { productId: lamb.productId, qtyCases: 2 }] } });
    await pantryCount(r, { counts: { 'lamb-pate': 2000 }, confirm: true });

    const p1 = await planOrder(r, { confirm: true });
    expect(p1.lines.find(l => l.productId === lamb.productId))
      .toMatchObject({ action: 'KEEP', fromQty: 2, toQty: 0, reason: 'Covered by stock on hand this shipment' });
    const stored = (await r.orders.get(p1.orderId!))!;
    await confirmInChewy(r, { orderId: stored.id, lines: stored.lines.map(l => ({ productId: l.productId, qtyCases: l.qtyCases })), confirm: true });
    await confirmArrival(r, { orderId: stored.id, confirm: true });

    const p2 = await planOrder(r, { confirm: false });
    expect(p2.lines.find(l => l.productId === lamb.productId))
      .toEqual({ productId: lamb.productId, action: 'KEEP', fromQty: 0, toQty: 0, reason: 'Covered by stock on hand this shipment' });
    expect(p2.summary.daysOfFood).toBeGreaterThan((2000 * 3) / 32.5);
    expect(p2.summary.slackDays).toBeGreaterThanOrEqual(0);
    expect(p2.warnings.filter(w => w.includes('Food runs out'))).toEqual([]);
  });

  it('confirm:true with nothing left to order stores no empty planned order', async () => {
    const r = await setup();
    await pantryCount(r, { counts: { 'chicken-pate': 5000, 'lamb-pate': 5000 }, confirm: true });
    const p = await planOrder(r, { confirm: true });
    expect(p.lines.every(l => l.toQty === 0)).toBe(true);
    expect(p.saved).toBe(false);
    expect(p.orderId).toBeNull();
    expect((p as { reason?: string }).reason).toMatch(/nothing to order/i);
    expect(await r.ordersByStatus('planned')).toHaveLength(0);
  });
});
