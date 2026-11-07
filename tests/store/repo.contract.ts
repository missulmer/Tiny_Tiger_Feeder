import { describe, it, expect, beforeEach } from 'vitest';
import type { Repo } from '../../src/store/repo.js';
import type {
  Cat, Product, Flavor, Alias, Meal, HouseholdRule, PantryEvent, Order, Plate,
} from '../../src/domain/types.js';

const plate = (flavorId: string, topper?: string): Plate => ({
  items: [{ flavorId, amountOz: 1.5 }],
  toppers: topper ? [{ flavorId: topper, amountOz: 0.25 }] : [],
  side: null,
});

const meal = (id: string, date: string, over: Partial<Meal> = {}): Meal => ({
  id, catId: 'c1', date, slot: 'AM', plates: [plate('f1')], choice: null,
  verdict: 'clean', vomitCause: null, sideOutcome: null, isTaster: false,
  source: 'observed', note: null, loggedAt: `${date}T08:00:00Z`, ...over,
});

const cat: Cat = {
  id: 'c1', name: 'Tiger', age: 3, breed: null, weight: 9.5,
  allergies: [{ substance: 'chicken', status: 'suspected', until: null }],
  textureRules: { allowed: ['pate'], blocked: ['shredded'] },
  noMixDryIntoWet: false, sideSwingsWet: true, fixedPortionOz: null,
  eatsAnythingWeight: 0.5, dailyOz: 6, proteinPrefs: ['turkey'], usualPlate: plate('f1'),
};
const product: Product = {
  id: 'p1', brand: 'B', line: 'L', name: 'N', canOz: 3, cansPerCase: 24,
  isVarietyPack: false, upc: null, store: 'chewy',
  prices: [{ casePrice: 30, seenOn: '2026-01-01', source: 'chewy' }], status: 'active',
};
const flavor: Flavor = {
  id: 'f1', productId: 'p1', name: 'Turkey', primaryProtein: 'turkey', texture: 'pate',
  contains: [], ingredientsText: null, cansPerCase: 24, kind: 'wet', unit: 'can', canOz: 3,
};
const alias: Alias & { id: string } = { id: 'a1', text: 'turkey pate', flavorId: 'f1', productId: null };
const rule: HouseholdRule = {
  id: 'r1', kind: 'exclude-ingredient', value: 'chicken', startsOn: '2026-01-01', endsOn: null, outcome: null,
};
const pev: PantryEvent = { id: 'e1', flavorId: 'f1', deltaCans: 24, reason: 'shipment', at: '2026-01-02T00:00:00Z', refId: null };
const order: Order = {
  id: 'o1', chewyOrderNo: null, date: '2026-01-03', lines: [{ productId: 'p1', qtyCases: 2, casePrice: 30 }],
  total: 60, intervalWeeks: 4, status: 'planned',
};

export function repoContract(name: string, make: () => Promise<Repo>) {
  describe(`Repo contract: ${name}`, () => {
    let repo: Repo;
    beforeEach(async () => { repo = await make(); });

    it('round-trips each entity', async () => {
      await repo.cats.put(cat); expect(await repo.cats.get('c1')).toEqual(cat);
      await repo.products.put(product); expect(await repo.products.get('p1')).toEqual(product);
      await repo.flavors.put(flavor); expect(await repo.flavors.get('f1')).toEqual(flavor);
      await repo.aliases.put(alias); expect(await repo.aliases.get('a1')).toEqual(alias);
      await repo.meals.put(meal('m1', '2026-01-05')); expect(await repo.meals.get('m1')).toEqual(meal('m1', '2026-01-05'));
      await repo.rules.put(rule); expect(await repo.rules.get('r1')).toEqual(rule);
      await repo.pantryEvents.put(pev); expect(await repo.pantryEvents.get('e1')).toEqual(pev);
      await repo.orders.put(order); expect(await repo.orders.get('o1')).toEqual(order);
    });

    it('get returns null when missing; put overwrites; delete removes', async () => {
      expect(await repo.cats.get('nope')).toBeNull();
      await repo.cats.put(cat);
      await repo.cats.put({ ...cat, name: 'Tigger' });
      expect((await repo.cats.get('c1'))?.name).toBe('Tigger');
      expect(await repo.cats.list()).toHaveLength(1);
      await repo.cats.delete('c1');
      expect(await repo.cats.get('c1')).toBeNull();
      await repo.cats.delete('c1');
    });

    it('list filters by shallow equality on top-level fields', async () => {
      await repo.products.put(product);
      await repo.products.put({ ...product, id: 'p2', status: 'retired' });
      expect((await repo.products.list()).map(p => p.id).sort()).toEqual(['p1', 'p2']);
      expect((await repo.products.list({ status: 'retired' })).map(p => p.id)).toEqual(['p2']);
      expect(await repo.products.list({ status: 'active', brand: 'X' })).toEqual([]);
    });

    it('list filter can match null values', async () => {
      await repo.products.put(product);
      await repo.products.put({ ...product, id: 'p2', store: null });
      expect((await repo.products.list({ store: null })).map(p => p.id)).toEqual(['p2']);
    });

    it('mealsFor filters by cat, flavor (plates and toppers) and inclusive date range', async () => {
      await repo.meals.put(meal('m1', '2026-01-01'));
      await repo.meals.put(meal('m2', '2026-01-02', { catId: 'c2' }));
      await repo.meals.put(meal('m3', '2026-01-03', { plates: [plate('f2', 'f9')] }));
      await repo.meals.put(meal('m4', '2026-01-04'));
      const ids = async (q: Parameters<Repo['mealsFor']>[0]) => (await repo.mealsFor(q)).map(m => m.id).sort();
      expect(await ids({})).toEqual(['m1', 'm2', 'm3', 'm4']);
      expect(await ids({ catId: 'c1' })).toEqual(['m1', 'm3', 'm4']);
      expect(await ids({ from: '2026-01-02', to: '2026-01-03' })).toEqual(['m2', 'm3']);
      expect(await ids({ from: '2026-01-04' })).toEqual(['m4']);
      expect(await ids({ to: '2026-01-01' })).toEqual(['m1']);
      expect(await ids({ flavorId: 'f2' })).toEqual(['m3']);
      expect(await ids({ flavorId: 'f9' })).toEqual(['m3']);
      expect(await ids({ catId: 'c1', flavorId: 'f1', from: '2026-01-02' })).toEqual(['m4']);
    });

    it('ordersByStatus', async () => {
      await repo.orders.put(order);
      await repo.orders.put({ ...order, id: 'o2', status: 'arrived' });
      expect((await repo.ordersByStatus('arrived')).map(o => o.id)).toEqual(['o2']);
      expect(await repo.ordersByStatus('confirmed-in-chewy')).toEqual([]);
    });

    it('exportAll contains everything put, keyed by collection', async () => {
      await repo.cats.put(cat); await repo.products.put(product); await repo.flavors.put(flavor);
      await repo.aliases.put(alias); await repo.meals.put(meal('m1', '2026-01-05'));
      await repo.rules.put(rule); await repo.pantryEvents.put(pev); await repo.orders.put(order);
      const all = await repo.exportAll();
      expect(Object.keys(all).sort()).toEqual(
        ['aliases', 'cats', 'flavors', 'meals', 'orders', 'pantryEvents', 'products', 'rules']);
      expect(all.cats).toEqual([cat]);
      expect(all.meals).toEqual([meal('m1', '2026-01-05')]);
      expect(all.orders).toEqual([order]);
      expect(all.aliases).toEqual([alias]);
    });

    it('preserves undefined-free round trip when optional fields are undefined', async () => {
      const m = { ...meal('mu', '2026-02-01'), note: undefined } as unknown as Meal;
      await repo.meals.put(m);
      const got = await repo.meals.get('mu');
      expect(got?.id).toBe('mu');
      expect(got?.note ?? null).toBeNull();
    });
  });
}
