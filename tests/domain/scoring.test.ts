import { describe, expect, it } from 'vitest';
import { entriesFromMeal, isSlipping, summarize } from '../../src/domain/scoring.js';
import type { ScoreEntry } from '../../src/domain/scoring.js';
import type { Meal, Plate, Verdict } from '../../src/domain/types.js';
import { lordBuggins, sinbad, vanta } from '../fixtures/household.js';

const plate = (flavorId: string, side: Plate['side'] = null, topper = false): Plate => ({
  items: [{ flavorId, amountOz: 3 }],
  toppers: topper ? [{ flavorId: 'purrly-salmon-chicken', amountOz: 0.5 }] : [],
  side,
});

function meal(over: Partial<Meal> & { verdict: Verdict }): Meal {
  return {
    id: 'm1',
    catId: 'lord-buggins',
    date: '2026-11-01',
    slot: 'AM',
    plates: [plate('chicken-pate')],
    choice: null,
    vomitCause: null,
    sideOutcome: null,
    isTaster: false,
    source: 'observed',
    note: null,
    loggedAt: '2026-11-01T08:00:00Z',
    ...over,
  };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const entry = (date: string, score: number): ScoreEntry => ({
  catId: 'lord-buggins',
  flavorId: 'chicken-pate',
  date,
  score,
  weight: 1,
  withTopper: false,
  vomitFlag: false,
});

describe('entriesFromMeal', () => {
  it('scores plain verdicts', () => {
    const score = (v: Verdict) => entriesFromMeal(meal({ verdict: v }), lordBuggins)[0]!.score;
    expect([score('clean'), score('bites_left'), score('half'), score('rejected')]).toEqual([1, 0.75, 0.5, 0]);
  });

  it('food vomit flags with score 0', () => {
    const [e] = entriesFromMeal(meal({ verdict: 'ate_then_vomited', vomitCause: 'food' }), lordBuggins);
    expect(e!).toMatchObject({ score: 0, vomitFlag: true, weight: 1, vomitCause: 'food' });
  });

  it('unsure vomit scores 0 at weight 0.3', () => {
    const [e] = entriesFromMeal(meal({ verdict: 'ate_then_vomited', vomitCause: 'unsure' }), lordBuggins);
    expect(e!).toMatchObject({ score: 0, weight: 0.3, vomitFlag: false, vomitCause: 'unsure' });
  });

  it('hairball vomit produces no entry', () => {
    expect(entriesFromMeal(meal({ verdict: 'ate_then_vomited', vomitCause: 'hairball' }), lordBuggins)).toEqual([]);
  });

  it('Sinbad clean counts at half weight', () => {
    const [e] = entriesFromMeal(meal({ verdict: 'clean', catId: 'sinbad' }), sinbad);
    expect(e!).toMatchObject({ score: 1, weight: 0.5 });
  });

  it('Vanta half with all kibble scores 0.75', () => {
    const side = { flavorId: 'kibble', amount: 1 };
    const [e] = entriesFromMeal(
      meal({ verdict: 'half', catId: 'vanta', plates: [plate('chicken-pate', side)], sideOutcome: 'all' }),
      vanta,
    );
    expect(e!.score).toBe(0.75);
  });

  it('Vanta floor does not apply to vomit verdicts', () => {
    const [e] = entriesFromMeal(
      meal({ verdict: 'ate_then_vomited', vomitCause: 'food', catId: 'vanta', sideOutcome: 'all' }),
      vanta,
    );
    expect(e!.score).toBe(0);
  });

  it('choice loser gets 0.25 at weight 0.5', () => {
    const m = meal({
      verdict: 'clean',
      plates: [plate('chicken-pate'), plate('funk-in-the-trunk')],
      choice: { pickedIdx: 0 },
    });
    const es = entriesFromMeal(m, lordBuggins);
    expect(es.find((e) => e.flavorId === 'chicken-pate')).toMatchObject({ score: 1, weight: 1.5 });
    expect(es.find((e) => e.flavorId === 'funk-in-the-trunk')).toMatchObject({ score: 0.25, weight: 0.5 });
  });

  it('recalled meal halves weight', () => {
    const [e] = entriesFromMeal(meal({ verdict: 'clean', source: 'recalled' }), lordBuggins);
    expect(e!.weight).toBe(0.5);
  });

  it('flags topper plates', () => {
    const [e] = entriesFromMeal(meal({ verdict: 'clean', plates: [plate('chicken-pate', null, true)] }), lordBuggins);
    expect(e!.withTopper).toBe(true);
  });
});

describe('summarize and isSlipping', () => {
  const asOf = '2026-11-06';
  const clean10 = Array.from({ length: 10 }, (_, i) => entry(addDays(asOf, -30 - i * 3), 1));

  it('slipping: 4 recent rejects after 10 clean', () => {
    const rejects = [0, 1, 2, 3].map((i) => entry(addDays(asOf, -i * 4), 0));
    const s = summarize([...clean10, ...rejects], asOf);
    expect(s.recentCount).toBe(4);
    expect(isSlipping(s)).toBe(true);
  });

  it('3 recent rejects is not slipping', () => {
    const rejects = [0, 1, 2].map((i) => entry(addDays(asOf, -i * 4), 0));
    expect(isSlipping(summarize([...clean10, ...rejects], asOf))).toBe(false);
  });

  it('no entries → recent null, longRun null', () => {
    expect(summarize([], asOf)).toEqual({ recent: null, longRun: null, recentCount: 0, toppedShare: 0 });
  });

  it('window is inclusive of asOf-20 and excludes asOf-21 and the future', () => {
    const s = summarize([entry('2026-10-17', 1), entry('2026-10-16', 1), entry('2026-11-07', 0)], asOf);
    expect(s.recentCount).toBe(1);
    expect(s.longRun).toBe(1);
  });

  it('computes weighted means and topped share', () => {
    const a = { ...entry('2026-11-05', 1), weight: 3, withTopper: true };
    const b = { ...entry('2026-11-04', 0), weight: 1 };
    const s = summarize([a, b], asOf);
    expect(s.recent).toBe(0.75);
    expect(s.toppedShare).toBe(0.5);
  });
});
