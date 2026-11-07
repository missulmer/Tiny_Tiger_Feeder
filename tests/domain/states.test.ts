import { describe, expect, it } from 'vitest';
import { foodState, proteinShare, vomitPattern } from '../../src/domain/states.js';
import type { ScoreEntry, Summary } from '../../src/domain/scoring.js';
import type { Meal } from '../../src/domain/types.js';
import { flavors } from '../fixtures/household.js';

const ok: Summary = { recent: 0.9, longRun: 0.9, recentCount: 5, toppedShare: 0 };
const slip: Summary = { recent: 0.3, longRun: 0.9, recentCount: 5, toppedShare: 0 };
const base = {
  flavorId: 'f',
  retired: false,
  provenAtOnboarding: false,
  arrivedOrdersContaining: 2,
  inCurrentOrder: false,
  lastServed: '2026-11-01' as string | null,
  perCat: { a: ok } as Record<string, Summary>,
};
const asOf = '2026-11-06';

describe('foodState', () => {
  it('retired wins over everything', () => {
    expect(foodState({ ...base, retired: true, arrivedOrdersContaining: 0, perCat: { a: slip } }, asOf)).toBe('retired');
  });
  it('unproven with <2 arrived orders and not proven', () => {
    expect(foodState({ ...base, arrivedOrdersContaining: 1, perCat: { a: slip } }, asOf)).toBe('unproven');
  });
  it('proven at onboarding skips unproven', () => {
    expect(foodState({ ...base, arrivedOrdersContaining: 0, provenAtOnboarding: true, inCurrentOrder: true }, asOf)).toBe('in_rotation');
  });
  it('slipping when any cat slipping, even in current order', () => {
    expect(foodState({ ...base, inCurrentOrder: true, perCat: { a: ok, b: slip } }, asOf)).toBe('slipping');
  });
  it('in_rotation when in current order', () => {
    expect(foodState({ ...base, inCurrentOrder: true, lastServed: '2026-01-01' }, asOf)).toBe('in_rotation');
  });
  it('due_for_retry at exactly 42 days', () => {
    expect(foodState({ ...base, lastServed: '2026-09-25' }, asOf)).toBe('due_for_retry');
  });
  it('resting at 41 days', () => {
    expect(foodState({ ...base, lastServed: '2026-09-26' }, asOf)).toBe('resting');
  });
  it('resting when never served and not in order', () => {
    expect(foodState({ ...base, lastServed: null }, asOf)).toBe('resting');
  });
});

const entry = (date: string, over: Partial<ScoreEntry> = {}): ScoreEntry => ({
  catId: 'c', flavorId: 'f', date, score: 0, weight: 1, withTopper: false, vomitFlag: true, vomitCause: 'food', ...over,
});

describe('vomitPattern', () => {
  it('two food vomits in 28 days flags', () => {
    expect(vomitPattern([entry('2026-10-20'), entry('2026-11-05')], 'c', 'f', asOf)).toBe(true);
  });
  it('food + unsure vomit counts', () => {
    expect(vomitPattern([entry('2026-10-20'), entry('2026-11-05', { vomitFlag: false, vomitCause: 'unsure', weight: 0.3 })], 'c', 'f', asOf)).toBe(true);
  });
  it('two vomits 40 days apart does not', () => {
    expect(vomitPattern([entry('2026-09-20'), entry('2026-10-30')], 'c', 'f', asOf)).toBe(false);
  });
  it('ignores other cats, flavors, non-vomit entries', () => {
    const es = [entry('2026-11-01', { catId: 'x' }), entry('2026-11-02', { flavorId: 'g' }), entry('2026-11-03', { vomitFlag: false, vomitCause: undefined })];
    expect(vomitPattern(es, 'c', 'f', asOf)).toBe(false);
  });
});

const meal = (i: number, flavorId: string, catId = 'lord-buggins'): Meal => ({
  id: `m${i}`, catId, date: `2026-11-0${1 + Math.floor(i / 2)}`, slot: i % 2 === 0 ? 'AM' : 'PM',
  plates: [{ items: [{ flavorId, amountOz: 3 }], toppers: [], side: null }],
  choice: null, verdict: 'clean', vomitCause: null, sideOutcome: null, isTaster: false,
  source: 'observed', note: null, loggedAt: '2026-11-06T00:00:00Z',
});

describe('proteinShare', () => {
  it('Buggins salmon 4 of last 6 meals → share 0.67', () => {
    const ms = [
      meal(0, 'chicken-pate'), meal(1, 'chicken-pate'), // outside last 6 below? 8 meals total
      meal(2, 'salmon-pate'), meal(3, 'chicken-pate'), meal(4, 'salmon-pate'),
      meal(5, 'salmon-pate'), meal(6, 'chicken-pate'), meal(7, 'salmon-pate'),
      meal(0, 'salmon-pate', 'pixel'),
    ];
    const share = proteinShare(ms, flavors, 'lord-buggins', asOf);
    expect(share.salmon).toBeCloseTo(4 / 6);
    expect(share.chicken).toBeCloseTo(2 / 6);
  });
  it('counts a meal once per protein and respects asOf', () => {
    const m = meal(0, 'chicken-pate');
    m.plates[0]!.items.push({ flavorId: 'chunks-in-gravy', amountOz: 1 });
    expect(proteinShare([m], flavors, 'lord-buggins', asOf)).toEqual({ chicken: 1 });
    expect(proteinShare([m], flavors, 'lord-buggins', '2026-10-01')).toEqual({});
  });
});
