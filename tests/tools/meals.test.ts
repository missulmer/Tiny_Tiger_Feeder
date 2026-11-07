import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryRepo } from '../../src/store/memoryRepo.js';
import type { Repo } from '../../src/store/repo.js';
import type { Plate } from '../../src/domain/types.js';
import { logMeal, type MealInput } from '../../src/tools/meals.js';
import { pantryCount } from '../../src/tools/pantry.js';
import { logRecalledVerdicts, markProven } from '../../src/tools/onboarding.js';
import { vanta, sinbad, chickenPate, salmonPate, purrlySalmonChicken, fishTrial } from '../fixtures/household.js';

const plate = (...ids: string[]): Plate => ({ items: ids.map(flavorId => ({ flavorId, amountOz: 3 })), toppers: [], side: null });
const meal = (over: Partial<MealInput> = {}): MealInput => ({
  catId: 'vanta', date: '2026-11-06', slot: 'AM', plates: [plate('chicken-pate')], verdict: 'clean', ...over,
});

let repo: Repo;
beforeEach(async () => {
  repo = createMemoryRepo();
  for (const c of [vanta, sinbad]) await repo.cats.put(c);
  for (const f of [chickenPate, salmonPate, purrlySalmonChicken]) await repo.flavors.put(f);
  await repo.rules.put(fishTrial);
});

describe('log_meal', () => {
  it('log_meal preview lists excluded_ingredient violation for Purrly salmon', async () => {
    const r = await logMeal(repo, {
      meals: [meal({ plates: [{ items: [{ flavorId: 'chicken-pate', amountOz: 3 }], toppers: [{ flavorId: 'purrly-salmon-chicken', amountOz: 0.5 }], side: null }] })],
      confirm: false,
    });
    expect(r.saved).toBe(false);
    expect(r.preview.violations.map(v => v.rule)).toEqual(['excluded_ingredient']);
    expect(r.preview.lines).toHaveLength(1);
  });

  it('log_meal refuses save with violation unless acknowledged', async () => {
    const m = meal({ plates: [plate('salmon-pate')] });
    const no = await logMeal(repo, { meals: [m], confirm: true });
    expect(no.saved).toBe(false);
    expect(await repo.meals.list()).toHaveLength(0);
    expect(await repo.pantryEvents.list()).toHaveLength(0);
    const yes = await logMeal(repo, { meals: [m], confirm: true, acknowledgeViolations: true });
    expect(yes.saved).toBe(true);
    expect(await repo.meals.list()).toHaveLength(1);
  });

  it('rejects unknown flavor ids and writes nothing', async () => {
    await expect(logMeal(repo, { meals: [meal(), meal({ plates: [plate('nope')] })], confirm: true }))
      .rejects.toThrow(/nope/);
    expect(await repo.meals.list()).toHaveLength(0);
  });

  it('second non-choice meal for same cat/date/slot reports duplicate and is not saved without confirm', async () => {
    await logMeal(repo, { meals: [meal()], confirm: true });
    const prev = await logMeal(repo, { meals: [meal()], confirm: false });
    expect(prev.preview.duplicates).toHaveLength(1);
    const blocked = await logMeal(repo, { meals: [meal()], confirm: true });
    expect(blocked.saved).toBe(false);
    expect(await repo.meals.list()).toHaveLength(1);
    expect(await repo.pantryEvents.list()).toHaveLength(1);
    const ok = await logMeal(repo, { meals: [meal()], confirm: true, acknowledgeDuplicates: true });
    expect(ok.saved).toBe(true);
    expect((await repo.meals.list()).map(m => m.id).sort()).toEqual(['vanta:2026-11-06:AM:1', 'vanta:2026-11-06:AM:2']);
  });

  it('choice meal with two plates is not a duplicate', async () => {
    const c = meal({ plates: [plate('chicken-pate'), plate('chicken-pate')], choice: { pickedIdx: 0 } });
    await logMeal(repo, { meals: [c], confirm: true });
    const r = await logMeal(repo, { meals: [c], confirm: false });
    expect(r.preview.duplicates).toHaveLength(0);
  });

  it('saved meal writes pantry events', async () => {
    await logMeal(repo, { meals: [meal()], confirm: true });
    const ev = await repo.pantryEvents.list();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ flavorId: 'chicken-pate', deltaCans: -1, reason: 'meal', refId: 'vanta:2026-11-06:AM:1' });
  });
});

describe('onboarding', () => {
  it('recalled verdicts write no pantry events', async () => {
    const r = await logRecalledVerdicts(repo, { catId: 'vanta', verdicts: [{ flavorId: 'chicken-pate', verdict: 'clean' }], confirm: true });
    expect(r.saved).toBe(true);
    const ms = await repo.meals.list();
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ source: 'recalled', slot: 'AM' });
    expect(await repo.pantryEvents.list()).toHaveLength(0);
  });

  it('mark_proven sets provenAtOnboarding and rejects unknown ids', async () => {
    await expect(markProven(repo, { flavorIds: ['chicken-pate', 'zzz'], confirm: true })).rejects.toThrow(/zzz/);
    await markProven(repo, { flavorIds: ['chicken-pate'], confirm: true });
    expect((await repo.flavors.get('chicken-pate'))!.provenAtOnboarding).toBe(true);
  });
});

describe('pantry_count', () => {
  it('writes count-correction as counted minus current stock', async () => {
    await repo.pantryEvents.put({ id: 'e1', flavorId: 'chicken-pate', deltaCans: 10, reason: 'shipment', at: 'x', refId: null });
    const r = await pantryCount(repo, { counts: { 'chicken-pate': 7 }, confirm: true });
    expect(r.saved).toBe(true);
    const fix = (await repo.pantryEvents.list()).find(e => e.reason === 'count-correction')!;
    expect(fix.deltaCans).toBe(-3);
  });

  it('without counts returns the check list', async () => {
    await repo.pantryEvents.put({ id: 'e1', flavorId: 'chicken-pate', deltaCans: -2, reason: 'meal', at: 'x', refId: null });
    const r = await pantryCount(repo, { confirm: false });
    expect(JSON.stringify(r.preview)).toContain('chicken-pate');
  });
});
