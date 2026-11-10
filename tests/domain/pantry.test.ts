import { describe, it, expect } from 'vitest';
import { eventsForArrival, eventsForMeal, stock, onHandOz, countCheckList } from '../../src/domain/pantry.js';
import type { Flavor, Meal, PantryEvent, Product } from '../../src/domain/types.js';
import { chickenPate, flavors } from '../fixtures/household.js';

function product(over: Partial<Product> & Pick<Product, 'id'>): Product {
  return {
    brand: 'b', line: 'l', name: 'n', canOz: 3, cansPerCase: 12, isVarietyPack: false,
    upc: null, store: null, prices: [], status: 'active', ...over,
  };
}
function fl(id: string, productId: string, cansPerCase: number): Flavor {
  return { ...chickenPate, id, productId, cansPerCase };
}
function meal(over: Partial<Meal>): Meal {
  return {
    id: 'm1', catId: 'vanta', date: '2026-11-06', slot: 'AM', plates: [], choice: null,
    verdict: 'clean', vomitCause: null, sideOutcome: null, isTaster: false,
    source: 'observed', note: null, loggedAt: '2026-11-06T08:00:00Z', ...over,
  };
}
const ev = (flavorId: string, deltaCans: number): PantryEvent => ({
  id: `${flavorId}:${deltaCans}`, flavorId, deltaCans, reason: 'meal', at: 't', refId: null,
});

describe('pantry', () => {
  it('single-flavor case adds cansPerCase × qty', () => {
    const p = product({ id: 'p1' });
    const out = eventsForArrival(
      [{ productId: 'p1', qtyCases: 2, casePrice: null }],
      new Map([['p1', p]]),
      new Map([['p1', [fl('f1', 'p1', 12)]]]),
      '2026-11-06T00:00:00Z',
      'o1',
    );
    expect(out).toEqual([
      { id: 'o1:f1', flavorId: 'f1', deltaCans: 24, reason: 'shipment', at: '2026-11-06T00:00:00Z', refId: 'o1' },
    ]);
  });

  it('variety pack adds per flavor', () => {
    const p = product({ id: 'vp', isVarietyPack: true });
    const fs = ['a', 'b', 'c', 'd'].map((id) => fl(id, 'vp', 3));
    const out = eventsForArrival(
      [{ productId: 'vp', qtyCases: 2, casePrice: null }],
      new Map([['vp', p]]),
      new Map([['vp', fs]]),
      't',
      'o2',
    );
    expect(out.map((e) => [e.flavorId, e.deltaCans])).toEqual([['a', 6], ['b', 6], ['c', 6], ['d', 6]]);
  });

  it('skips lines whose product is missing', () => {
    expect(eventsForArrival([{ productId: 'x', qtyCases: 1, casePrice: null }], new Map(), new Map(), 't', 'o')).toEqual([]);
  });

  it('meal subtracts fractional cans', () => {
    const f = { ...chickenPate, canOz: 5.5 };
    const m = meal({ plates: [{ items: [{ flavorId: f.id, amountOz: 2.75 }], toppers: [], side: null }] });
    const out = eventsForMeal(m, new Map([[f.id, f]]));
    expect(out).toEqual([
      { id: 'm1:chicken-pate', flavorId: 'chicken-pate', deltaCans: -0.5, reason: 'meal', at: m.loggedAt, refId: 'm1' },
    ]);
  });

  it('meal skips non-can units, unpicked plates and recalled meals', () => {
    const plate = (id: string) => ({
      items: [{ flavorId: id, amountOz: 3 }],
      toppers: [{ flavorId: 'purrly-salmon-chicken', amountOz: 0.5 }],
      side: null,
    });
    const choice = meal({ plates: [plate('chicken-pate'), plate('salmon-pate')], choice: { pickedIdx: 1 } });
    expect(eventsForMeal(choice, flavors).map((e) => e.flavorId)).toEqual(['salmon-pate']);
    expect(eventsForMeal(meal({ source: 'recalled', plates: [plate('chicken-pate')] }), flavors)).toEqual([]);
  });

  it('negative stock displays 0 and needs count', () => {
    const s = stock([ev('chicken-pate', -1.5)]);
    expect(s['chicken-pate']).toEqual({ cans: -1.5, display: 0, needsCount: true });
    expect(onHandOz(s, flavors)['chicken-pate']).toBe(0);
  });

  it('onHandOz uses display × canOz', () => {
    const s = stock([ev('chicken-pate', 4)]);
    expect(onHandOz(s, flavors)['chicken-pate']).toBe(12);
  });

  it('count-correction event sets stock', () => {
    const events = [ev('chicken-pate', 10), ev('chicken-pate', -12.5)];
    const counted = 4;
    const current = stock(events)['chicken-pate']!.cans;
    const fix: PantryEvent = { ...ev('chicken-pate', counted - current), reason: 'count-correction' };
    expect(stock([...events, fix])['chicken-pate']!.cans).toBe(counted);
  });

  it('countCheckList returns needs-count and next-order flavors, deduped, stable', () => {
    const s = stock([ev('salmon-pate', -1), ev('chicken-pate', 3), ev('chunks-in-gravy', -2)]);
    expect(countCheckList(s, flavors, ['chicken-pate', 'salmon-pate'])).toEqual([
      'chicken-pate', 'salmon-pate', 'chunks-in-gravy',
    ]);
  });
});
