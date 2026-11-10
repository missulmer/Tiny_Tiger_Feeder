import { describe, expect, it } from 'vitest';
import { allocate, buildUpdateSheet, costPerAcceptedOz } from '../../src/domain/allocate.js';
import type { AllocateInput } from '../../src/domain/allocate.js';
import { summarizeOrder } from '../../src/domain/orderMath.js';
import type { Summary } from '../../src/domain/scoring.js';
import {
  cats, chickenPate, chunksInGravy, fishTrial, flavor, flavors, flavorsByProduct, funkInTheTrunk,
  lordBuggins, product, products, salmonPate, sinbad, vanta,
} from '../fixtures/household.js';

const asOf = '2026-11-06';
const s = (score: number): Summary => ({ recent: score, longRun: score, recentCount: 4, toppedShare: 0 });
const wet = [chickenPate, salmonPate, chunksInGravy, funkInTheTrunk];

function input(over: Partial<AllocateInput> = {}): AllocateInput {
  return {
    cats,
    flavors: [...flavors.values()],
    rules: [fishTrial],
    asOf,
    summaries: {},
    states: {},
    candidateFlavorIds: wet.map((f) => f.id),
    intervalDays: 28,
    ...over,
  };
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((n, v) => n + v, 0);

function sheet(over: Partial<Parameters<typeof buildUpdateSheet>[0]> = {}) {
  return buildUpdateSheet({
    current: [],
    proposedOzPerDay: {},
    products,
    flavorsByProduct,
    onHandOz: {},
    intervalDays: 28,
    states: {},
    reasons: {},
    ...over,
  });
}

describe('costPerAcceptedOz', () => {
  it('variety pack with 1 of 4 flavors rejected has cost per accepted oz = price / (oz × 0.75)', () => {
    const vp = product({ id: 'vp', isVarietyPack: true, prices: [{ casePrice: 30, seenOn: '2026-11-01', source: 'chewy' }] });
    const fs = ['a', 'b', 'c', 'd'].map((id) =>
      flavor({ id, name: id, primaryProtein: 'chicken', productId: 'vp', cansPerCase: 3 }));
    const summaries = { vanta: { a: s(0.9), b: s(0.8), c: s(0.7), d: s(0.1) }, sinbad: { a: s(0.6), d: s(0.2) } };
    expect(costPerAcceptedOz(vp, fs, summaries)).toBeCloseTo(30 / (36 * 0.75), 10);
  });
  it('is Infinity when no flavor is accepted', () => {
    const fs = [flavor({ id: 'a', name: 'a', primaryProtein: 'chicken', productId: 'vp' })];
    expect(costPerAcceptedOz(product({ id: 'vp' }), fs, { vanta: { a: s(0.1) } })).toBe(Infinity);
  });
});

describe('allocate', () => {
  it('no verdicts anywhere still yields finite mix summing to 32.5', () => {
    const out = allocate(input());
    for (const v of Object.values(out.ozPerDayByFlavor)) expect(Number.isFinite(v)).toBe(true);
    expect(sum(out.ozPerDayByFlavor)).toBeCloseTo(32.5, 9);
  });

  it('fish flavor gets 0 oz during trial', () => {
    const out = allocate(input({ summaries: { 'lord-buggins': { 'salmon-pate': s(1) } } }));
    expect(out.ozPerDayByFlavor['salmon-pate'] ?? 0).toBe(0);
  });

  it("Pixel's share excludes chunks", () => {
    const out = allocate(input({ summaries: { pixel: { 'chunks-in-gravy': s(1) } } }));
    expect(out.perCatOz.pixel!['chunks-in-gravy'] ?? 0).toBe(0);
    expect(sum(out.perCatOz.pixel!)).toBeCloseTo(6.5, 9);
  });

  it('weights by score with the 0.05 floor, and by protein rank when unscored', () => {
    const out = allocate(input({
      cats: [vanta, sinbad],
      rules: [],
      candidateFlavorIds: ['chicken-pate', 'salmon-pate'],
      summaries: { vanta: { 'chicken-pate': s(1), 'salmon-pate': s(0) } },
    }));
    expect(out.perCatOz.vanta!['chicken-pate']).toBeCloseTo(6.5 / 1.05, 9);
    // Sinbad unscored: salmon is not a listed protein (0.3); chicken is rank 1 (0.85).
    expect(out.perCatOz.sinbad!['chicken-pate']).toBeCloseTo((6.5 * 0.85) / 1.15, 9);
  });

  it('owner overrides replace the computed oz/day', () => {
    const out = allocate(input({ ownerOverrides: { 'chicken-pate': 4 } }));
    expect(out.ozPerDayByFlavor['chicken-pate']).toBe(4);
  });

  it('an override on salmon-pate under the fish trial still yields 0 oz and a note', () => {
    const out = allocate(input({ ownerOverrides: { 'salmon-pate': 5 } }));
    expect(out.ozPerDayByFlavor['salmon-pate'] ?? 0).toBe(0);
    expect(out.notes.some((n) => n.includes('Salmon Pate') && n.includes('override'))).toBe(true);
  });

  it('overrides on retired or non-candidate flavors are ignored with a note', () => {
    const out = allocate(input({
      states: { 'chicken-pate': 'retired' },
      ownerOverrides: { 'chicken-pate': 3, 'purrly-salmon-chicken': 1 },
    }));
    expect(out.ozPerDayByFlavor['chicken-pate'] ?? 0).toBe(0);
    expect(out.ozPerDayByFlavor['purrly-salmon-chicken'] ?? 0).toBe(0);
    expect(out.notes.filter((n) => n.includes('override') && n.includes('ignored'))).toHaveLength(2);
  });

  it('a kibble flavor in candidateFlavorIds gets 0 oz and the total still sums to 32.5', () => {
    const out = allocate(input({ candidateFlavorIds: [...wet.map((f) => f.id), 'kibble', 'purrly-salmon-chicken'] }));
    expect(out.ozPerDayByFlavor['kibble'] ?? 0).toBe(0);
    expect(out.ozPerDayByFlavor['purrly-salmon-chicken'] ?? 0).toBe(0);
    expect(sum(out.ozPerDayByFlavor)).toBeCloseTo(32.5, 9);
  });

  it('Funk in the Trunk stock reduces Sinbad\'s other shares', () => {
    const base = input({
      cats: [vanta, sinbad, lordBuggins],
      candidateFlavorIds: ['chicken-pate', 'funk-in-the-trunk'],
      summaries: {
        vanta: { 'funk-in-the-trunk': s(0.1) },
        'lord-buggins': { 'funk-in-the-trunk': s(0.2) },
        sinbad: { 'funk-in-the-trunk': s(0.9), 'chicken-pate': s(0.9) },
      },
    });
    const without = allocate(base);
    const withStock = allocate({ ...base, onHandOz: { 'funk-in-the-trunk': 56 } });
    expect(without.perCatOz.sinbad!['chicken-pate']).toBeCloseTo(3.25, 9);
    expect(withStock.perCatOz.sinbad!['chicken-pate']).toBeCloseTo(1.25, 9);
    expect(withStock.perCatOz.sinbad!['funk-in-the-trunk']).toBeCloseTo(5.25, 9);
    expect(sum(withStock.perCatOz.sinbad!)).toBeCloseTo(6.5, 9);
    expect(withStock.perCatOz.vanta).toEqual(without.perCatOz.vanta);
    expect(withStock.notes.some((n) => n.includes('Funk in the Trunk') && n.includes('Sinbad'))).toBe(true);

    const capped = allocate({ ...base, onHandOz: { 'funk-in-the-trunk': 1000 } });
    expect(capped.perCatOz.sinbad!['funk-in-the-trunk']).toBeCloseTo(6.5, 9);
    expect(capped.perCatOz.sinbad!['chicken-pate'] ?? 0).toBeCloseTo(0, 9);
  });
});

describe('buildUpdateSheet', () => {
  it('Buggins with salmon over half his proposed share gets a fatigue warning', () => {
    const out = allocate(input({
      cats: [lordBuggins],
      rules: [],
      candidateFlavorIds: ['salmon-pate', 'chicken-pate'],
      summaries: { 'lord-buggins': { 'salmon-pate': s(1), 'chicken-pate': s(0.2) } },
    }));
    const sh = sheet({
      proposedOzPerDay: out.ozPerDayByFlavor, perCatOz: out.perCatOz, cats: [lordBuggins], flavors,
      overrideSwapLimit: true,
    });
    expect(sh.warnings.some((w) => w.includes('Lord Buggins') && w.includes('salmon'))).toBe(true);
  });

  it('no fatigue warning when the favorite dominates', () => {
    const sh = sheet({
      proposedOzPerDay: { 'chicken-pate': 6.5 }, perCatOz: { 'lord-buggins': { 'chicken-pate': 6.5 } },
      cats: [lordBuggins], flavors,
    });
    expect(sh.warnings.filter((w) => w.includes('Lord Buggins'))).toEqual([]);
  });

  it('unproven capped at 1 case', () => {
    expect(sheet({ proposedOzPerDay: { 'chicken-pate': 10 } }).lines[0]!.toQty).toBe(8);
    const byFlavor = sheet({ proposedOzPerDay: { 'chicken-pate': 10 }, states: { 'chicken-pate': 'unproven' } });
    expect(byFlavor.lines[0]).toMatchObject({ productId: 'p-chicken-pate', action: 'ADD', toQty: 1 });
    const byProduct = sheet({ proposedOzPerDay: { 'chicken-pate': 10 }, states: { 'p-chicken-pate': 'unproven' } });
    expect(byProduct.lines[0]!.toQty).toBe(1);
  });

  it('second ADD becomes a warning, not a line', () => {
    const sh = sheet({ proposedOzPerDay: { 'chicken-pate': 2, 'funk-in-the-trunk': 3 } });
    expect(sh.lines).toEqual([expect.objectContaining({ productId: 'p-funk-in-the-trunk', action: 'ADD' })]);
    expect(sh.warnings).toContain('Also worth adding: p-chicken-pate (held back by the one-swap rule)');
  });

  it('override allows two ADDs', () => {
    const sh = sheet({ proposedOzPerDay: { 'chicken-pate': 2, 'funk-in-the-trunk': 3 }, overrideSwapLimit: true });
    expect(sh.lines.map((l) => l.action)).toEqual(['ADD', 'ADD']);
    expect(sh.warnings.some((w) => w.includes('one-swap'))).toBe(false);
  });

  it('REMOVE and CHANGE are not limited', () => {
    const sh = sheet({
      current: [
        { productId: 'p-chicken-pate', qtyCases: 2, casePrice: 24 },
        { productId: 'p-funk-in-the-trunk', qtyCases: 2, casePrice: 24 },
        { productId: 'p-chunks-in-gravy', qtyCases: 3, casePrice: 24 },
        { productId: 'p-salmon-pate', qtyCases: 1, casePrice: 24 },
      ],
      proposedOzPerDay: { 'chicken-pate': 2.5, 'funk-in-the-trunk': 5, 'chunks-in-gravy': 1, 'purrly-salmon-chicken': 0.2 },
      reasons: { 'p-salmon-pate': 'Fish trial is on' },
      currentIntervalWeeks: 4,
    });
    const byId = Object.fromEntries(sh.lines.map((l) => [l.productId, l]));
    expect(byId['p-chicken-pate']).toMatchObject({ action: 'KEEP', fromQty: 2, toQty: 2 });
    expect(byId['p-funk-in-the-trunk']).toMatchObject({ action: 'CHANGE', fromQty: 2, toQty: 4 });
    expect(byId['p-chunks-in-gravy']).toMatchObject({ action: 'CHANGE', fromQty: 3, toQty: 1 });
    expect(byId['p-salmon-pate']).toMatchObject({ action: 'REMOVE', fromQty: 1, toQty: 0, reason: 'Fish trial is on' });
    expect(byId['p-purrly-salmon-chicken']).toMatchObject({ action: 'ADD', fromQty: 0, toQty: 1 });
    expect(sh.warnings.some((w) => w.includes('one-swap'))).toBe(false);
    expect(sh.intervalWeeks).toEqual({ from: 4, to: 4 });
  });

  it('sheet summary matches summarizeOrder for its lines', () => {
    const sh = sheet({
      current: [{ productId: 'p-salmon-pate', qtyCases: 2, casePrice: 24 }],
      proposedOzPerDay: { 'chicken-pate': 6.5 },
      onHandOz: { 'chicken-pate': 12, 'salmon-pate': 9 },
      cats,
    });
    expect(sh.lines.map((l) => [l.productId, l.action, l.toQty])).toEqual([
      ['p-salmon-pate', 'REMOVE', 0],
      ['p-chicken-pate', 'ADD', 5],
    ]);
    // R20: same as summarizeOrder except slack, which the sheet measures against the chosen 28-day interval.
    const base = summarizeOrder([{ productId: 'p-chicken-pate', cases: 5, caseOz: 36, casePrice: 24 }], 32.5, 12);
    expect(sh.summary).toEqual({ ...base, slackDays: base.daysOfFood - 28 });
    expect(sh.intervalWeeks).toEqual({ from: null, to: 4 });
  });

  it('variety pack is only proposed when already in the order', () => {
    const vp = product({ id: 'vp', isVarietyPack: true });
    const vf = [flavor({ id: 'v1', name: 'v1', primaryProtein: 'chicken', productId: 'vp' })];
    const base = { products: [vp], flavorsByProduct: { vp: vf }, proposedOzPerDay: { v1: 2 } };
    const fresh = sheet(base);
    expect(fresh.lines).toEqual([]);
    expect(fresh.warnings.some((w) => w.includes('vp'))).toBe(true);
    const kept = sheet({ ...base, current: [{ productId: 'vp', qtyCases: 2, casePrice: 24 }] });
    expect(kept.lines[0]).toMatchObject({ productId: 'vp', action: 'KEEP', toQty: 2 });
  });

  it('missing price counts as 0 with a warning, and numbers stay finite', () => {
    const sh = sheet({
      products: [product({ id: 'p-chicken-pate', prices: [] })],
      proposedOzPerDay: { 'chicken-pate': 6.5 },
    });
    expect(sh.summary.costPerShipment).toBe(0);
    expect(sh.warnings.some((w) => w.includes('p-chicken-pate') && w.includes('price'))).toBe(true);
    for (const v of Object.values(sh.summary)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });
});

describe('final-review fixes (domain)', () => {
  it('C1: costPerAcceptedOz is null when the product has no price', () => {
    const fs = [flavor({ id: 'a', name: 'a', primaryProtein: 'chicken', productId: 'np' })];
    expect(costPerAcceptedOz(product({ id: 'np', prices: [] }), fs, { vanta: { a: s(0.9) } })).toBeNull();
  });

  it('I1: slack is measured against the chosen interval (3 weeks, ~31 days of food -> ~10 days)', () => {
    // 14 oz x 24 = 336 oz per case; 32.5 oz/day x 21 days = 682.5 oz -> 3 cases = 1008 oz = 31.0 days.
    const big = product({ id: 'p-chicken-pate', canOz: 14, cansPerCase: 24 });
    const sh = sheet({ products: [big], proposedOzPerDay: { 'chicken-pate': 32.5 }, intervalDays: 21 });
    expect(sh.lines[0]).toMatchObject({ action: 'ADD', toQty: 3 });
    expect(sh.summary.daysOfFood).toBeCloseTo(1008 / 32.5, 9);
    expect(sh.summary.slackDays).toBeCloseTo(1008 / 32.5 - 21, 9);
    expect(sh.summary.slackDays).toBeGreaterThan(9.9);
    expect(sh.intervalWeeks.to).toBe(3);
    expect(sh.warnings.some((w) => w.includes('Food runs out'))).toBe(false);
  });

  it('I1: a shortfall gives negative slack and a run-out warning with the server-computed days', () => {
    // Unproven cap: 1 case of 36 oz for 32.5 oz/day = 1.1 days against a 28-day interval.
    const sh = sheet({ proposedOzPerDay: { 'chicken-pate': 32.5 }, states: { 'chicken-pate': 'unproven' } });
    expect(sh.summary.slackDays).toBeCloseTo(36 / 32.5 - 28, 9);
    expect(sh.summary.slackDays).toBeLessThan(0);
    expect(sh.warnings).toContain('Food runs out about 27 days before the next shipment');
  });

  it('I2: a current-order line covered by the pantry is KEEP 0 with the stock reason, not REMOVE', () => {
    const sh = sheet({
      current: [{ productId: 'p-chicken-pate', qtyCases: 2, casePrice: 24 }],
      proposedOzPerDay: { 'chicken-pate': 2 },
      onHandOz: { 'chicken-pate': 100 },
      states: { 'chicken-pate': 'in_rotation' },
      reasons: { 'p-chicken-pate': 'In rotation; liked by 5 of 5' },
    });
    expect(sh.lines).toEqual([{
      productId: 'p-chicken-pate', action: 'KEEP', fromQty: 2, toQty: 0,
      reason: 'Covered by stock on hand this shipment',
    }]);
    // Its shelf stock still counts toward days of food.
    expect(sh.summary.daysOfFood).toBeCloseTo(100 / 2, 9);
  });

  it('I2: a genuinely unneeded current line is still REMOVE with its own reason', () => {
    const sh = sheet({
      current: [{ productId: 'p-salmon-pate', qtyCases: 1, casePrice: 24 }],
      proposedOzPerDay: {},
      onHandOz: { 'salmon-pate': 9 },
      reasons: { 'p-salmon-pate': 'Fish trial is on' },
    });
    expect(sh.lines[0]).toMatchObject({ action: 'REMOVE', toQty: 0, reason: 'Fish trial is on' });
  });

  it('I2: only ADDs whose flavors are all unproven/resting/due_for_retry count against the one-swap rule', () => {
    const sh = sheet({
      proposedOzPerDay: { 'chicken-pate': 2, 'funk-in-the-trunk': 3, 'chunks-in-gravy': 1 },
      states: { 'chicken-pate': 'slipping', 'funk-in-the-trunk': 'resting', 'chunks-in-gravy': 'due_for_retry' },
    });
    expect(sh.lines.map((l) => [l.productId, l.action])).toEqual([
      ['p-funk-in-the-trunk', 'ADD'],
      ['p-chicken-pate', 'ADD'],
    ]);
    expect(sh.warnings).toContain('Also worth adding: p-chunks-in-gravy (held back by the one-swap rule)');
  });

  it('I2: a product from a recent order is never subject to the one-swap rule', () => {
    const sh = sheet({
      proposedOzPerDay: { 'chicken-pate': 2, 'funk-in-the-trunk': 3 },
      states: { 'chicken-pate': 'resting', 'funk-in-the-trunk': 'unproven' },
      recentProductIds: ['p-chicken-pate'],
    });
    expect(sh.lines.map((l) => [l.productId, l.action])).toEqual([
      ['p-funk-in-the-trunk', 'ADD'],
      ['p-chicken-pate', 'ADD'],
    ]);
    expect(sh.warnings.some((w) => w.includes('one-swap'))).toBe(false);
  });
});
