import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryRepo } from '../../src/store/memoryRepo.js';
import type { Repo } from '../../src/store/repo.js';
import { addFood, updateFood, findFood, setAlias } from '../../src/tools/catalog.js';
import { setHouseholdRule } from '../../src/tools/rules.js';

const product = { name: 'Weruva Funky Fish', brand: 'Weruva', line: 'Cats in the Kitchen', canOz: 5.5, cansPerCase: 8 };
const flavors = [
  { name: 'Funky Chicken', primaryProtein: 'chicken', texture: 'pate' as const, contains: [' Chicken '], kind: 'wet' as const },
  { name: 'Mystery', primaryProtein: 'beef', texture: 'minced' as const, contains: null, kind: 'wet' as const },
];

let repo: Repo;
beforeEach(() => { repo = createMemoryRepo(); });

describe('add_food', () => {
  it('confirm:false writes nothing', async () => {
    const r = await addFood(repo, { product, flavors, confirm: false });
    expect(r.saved).toBe(false);
    expect(JSON.stringify(r.preview)).toContain('ingredients not checked');
    expect(await repo.products.list()).toHaveLength(0);
    expect(await repo.flavors.list()).toHaveLength(0);
  });

  it('confirm:true writes product and flavors, normalizing contains', async () => {
    const r = await addFood(repo, { product, flavors, confirm: true });
    expect(r.saved).toBe(true);
    const ps = await repo.products.list();
    expect(ps.map(p => p.id)).toEqual(['weruva-funky-fish']);
    const fs = await repo.flavors.list();
    expect(fs).toHaveLength(2);
    const chicken = fs.find(f => f.name === 'Funky Chicken')!;
    expect(chicken.contains).toEqual(['chicken']);
    expect(chicken.productId).toBe('weruva-funky-fish');
    expect(chicken.canOz).toBe(5.5);
  });

  it('suffixes ids on collision', async () => {
    await addFood(repo, { product, flavors, confirm: true });
    await addFood(repo, { product, flavors, confirm: true });
    expect((await repo.products.list()).map(p => p.id).sort()).toEqual(['weruva-funky-fish', 'weruva-funky-fish-2']);
    expect((await repo.flavors.list())).toHaveLength(4);
  });

  it('rejects bad sizes, kinds and productId, writing nothing', async () => {
    const bad = [
      { product: { ...product, canOz: 0 }, flavors },
      { product: { ...product, cansPerCase: -1 }, flavors },
      { product, flavors: [{ ...flavors[0]!, kind: 'treat' as never }] },
      { product, flavors: [{ ...flavors[0]!, productId: '' }] },
      { product, flavors: [{ ...flavors[0]!, canOz: 0 }] },
    ];
    for (const b of bad) await expect(addFood(repo, { ...b, confirm: true })).rejects.toThrow();
    expect(await repo.products.list()).toHaveLength(0);
    expect(await repo.flavors.list()).toHaveLength(0);
  });
});

describe('update_food', () => {
  it('patches a flavor, validating', async () => {
    await addFood(repo, { product, flavors, confirm: true });
    const id = (await repo.flavors.list())[0]!.id;
    const pre = await updateFood(repo, { id, patch: { texture: 'shredded' }, confirm: false });
    expect(pre.saved).toBe(false);
    expect((await repo.flavors.get(id))!.texture).not.toBe('shredded');
    await updateFood(repo, { id, patch: { texture: 'shredded', contains: ['Fish'] }, confirm: true });
    const f = (await repo.flavors.get(id))!;
    expect(f.texture).toBe('shredded');
    expect(f.contains).toEqual(['fish']);
    await expect(updateFood(repo, { id, patch: { canOz: 0 }, confirm: true })).rejects.toThrow();
    await expect(updateFood(repo, { id: 'nope', patch: {}, confirm: true })).rejects.toThrow(/not found/i);
  });

  it('patches a product', async () => {
    await addFood(repo, { product, flavors, confirm: true });
    await updateFood(repo, { id: 'weruva-funky-fish', patch: { status: 'retired' }, confirm: true });
    expect((await repo.products.get('weruva-funky-fish'))!.status).toBe('retired');
  });
});

describe('find_food and set_alias', () => {
  it('matches alias "funk"', async () => {
    await addFood(repo, { product, flavors, confirm: true });
    const fid = (await repo.flavors.list()).find(f => f.name === 'Funky Chicken')!.id;
    const r = await setAlias(repo, { text: 'Funk', targetId: fid, confirm: true });
    expect(r.saved).toBe(true);
    const hits = await findFood(repo, { query: 'funk' });
    expect(hits[0]).toMatchObject({ flavorId: fid, score: 1 });
  });

  it('set_alias confirm:false writes nothing; unknown target rejected', async () => {
    await addFood(repo, { product, flavors, confirm: true });
    const r = await setAlias(repo, { text: 'x', targetId: 'weruva-funky-fish', confirm: false });
    expect(r.saved).toBe(false);
    expect(await repo.aliases.list()).toHaveLength(0);
    await expect(setAlias(repo, { text: 'x', targetId: 'zzz', confirm: true })).rejects.toThrow(/not found/i);
  });

  it('scores names and UPC, top 10, sorted', async () => {
    await addFood(repo, { product: { ...product, upc: '123456' }, flavors, confirm: true });
    const byName = await findFood(repo, { query: 'funky chicken' });
    expect(byName[0]).toMatchObject({ name: 'Funky Chicken' });
    expect(byName[0]!.score).toBe(0.7);
    const any = await findFood(repo, { query: 'chicken zzz' });
    expect(any[0]!.score).toBe(0.4);
    const upc = await findFood(repo, { query: '123456' });
    expect(upc.every(h => h.score === 1)).toBe(true);
    expect(await findFood(repo, { query: 'qqq' })).toEqual([]);
  });
});

describe('set_household_rule', () => {
  it('stores dates', async () => {
    const rule = { kind: 'exclude-ingredient' as const, value: ' Fish ', startsOn: '2026-11-01', endsOn: '2026-12-01' };
    const pre = await setHouseholdRule(repo, { rule, confirm: false });
    expect(pre.saved).toBe(false);
    expect(await repo.rules.list()).toHaveLength(0);
    await setHouseholdRule(repo, { rule, confirm: true });
    const [r] = await repo.rules.list();
    expect(r).toMatchObject({ kind: 'exclude-ingredient', value: 'fish', startsOn: '2026-11-01', endsOn: '2026-12-01', outcome: null });
  });

  it('validates kind and dates', async () => {
    const ok = { kind: 'exclude-ingredient' as const, value: 'fish', startsOn: '2026-11-01' };
    await expect(setHouseholdRule(repo, { rule: { ...ok, kind: 'other' as never }, confirm: true })).rejects.toThrow();
    await expect(setHouseholdRule(repo, { rule: { ...ok, startsOn: '11/01/2026' }, confirm: true })).rejects.toThrow();
    await expect(setHouseholdRule(repo, { rule: { ...ok, endsOn: '2026-10-01' }, confirm: true })).rejects.toThrow();
    expect(await repo.rules.list()).toHaveLength(0);
  });
});

describe('final-review fixes: catalog', () => {
  it('C1: add_food records an optional casePrice; rejects a non-positive one', async () => {
    await addFood(repo, { product: { ...product, casePrice: 39.99 }, flavors, confirm: true });
    const p = (await repo.products.get('weruva-funky-fish'))!;
    expect(p.prices).toHaveLength(1);
    expect(p.prices[0]).toMatchObject({ casePrice: 39.99, source: 'add_food' });
    expect(p.prices[0]!.seenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(addFood(repo, { product: { ...product, casePrice: 0 }, flavors, confirm: true })).rejects.toThrow(/casePrice/);
    await expect(addFood(repo, { product: { ...product, casePrice: Number.POSITIVE_INFINITY }, flavors, confirm: true })).rejects.toThrow(/casePrice/);
    expect(await repo.products.list()).toHaveLength(1);
  });

  it('I4: update_food rejects a missing productId, unknown fields, bad enums and bad prices', async () => {
    await addFood(repo, { product, flavors, confirm: true });
    const fid = (await repo.flavors.list())[0]!.id;
    await expect(updateFood(repo, { id: fid, patch: { productId: 'nope' }, confirm: true })).rejects.toThrow(/nope/);
    await expect(updateFood(repo, { id: fid, patch: { bogus: 1 }, confirm: true })).rejects.toThrow(/bogus/);
    await expect(updateFood(repo, { id: fid, patch: { kind: 'treat' }, confirm: true })).rejects.toThrow(/kind/);
    await expect(updateFood(repo, { id: fid, patch: { texture: 'chunks' }, confirm: true })).rejects.toThrow(/texture/);
    await expect(updateFood(repo, { id: 'weruva-funky-fish', patch: { status: 'gone' }, confirm: true })).rejects.toThrow(/status/);
    await expect(updateFood(repo, { id: 'weruva-funky-fish', patch: { bogus: 1 }, confirm: true })).rejects.toThrow(/bogus/);
    await expect(updateFood(repo, { id: 'weruva-funky-fish', patch: { prices: [{ casePrice: -1, seenOn: '2026-11-01', source: 'x' }] }, confirm: true }))
      .rejects.toThrow(/prices/);
    await expect(updateFood(repo, { id: 'weruva-funky-fish', patch: { prices: [{ casePrice: 30, seenOn: 'yesterday', source: 'x' }] }, confirm: true }))
      .rejects.toThrow(/prices/);
    await updateFood(repo, { id: 'weruva-funky-fish', patch: { prices: [{ casePrice: 30, seenOn: '2026-11-01', source: 'owner' }] }, confirm: true });
    expect((await repo.products.get('weruva-funky-fish'))!.prices).toEqual([{ casePrice: 30, seenOn: '2026-11-01', source: 'owner' }]);
  });
});

describe('R21: primaryProtein is lowercased', () => {
  it('in add_food and update_food', async () => {
    await addFood(repo, { product, flavors: [{ ...flavors[0]!, primaryProtein: ' Chicken ' }], confirm: true });
    const f = (await repo.flavors.list())[0]!;
    expect(f.primaryProtein).toBe('chicken');
    await updateFood(repo, { id: f.id, patch: { primaryProtein: 'DUCK' }, confirm: true });
    expect((await repo.flavors.get(f.id))!.primaryProtein).toBe('duck');
  });
});
