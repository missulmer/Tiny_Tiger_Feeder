import { expect, test } from 'vitest';
import { activeRules, checkFlavorForCat, checkPlate, servableFor } from '../../src/domain/rules.js';
import {
  chickenPate, flavor, chunksInGravy, fishTrial as trial, flavors, kibble, pixel,
  purrlySalmonChicken, salmonPate, vanta,
} from '../fixtures/household.js';

test('fish flavor violates active trial for every cat', () =>
  expect(checkFlavorForCat(salmonPate, vanta, [trial], '2026-11-10')[0]).toMatchObject({ rule: 'excluded_ingredient', ingredient: 'fish', certainty: 'known' }));
test('trial not active after endsOn', () =>
  expect(checkFlavorForCat(salmonPate, vanta, [trial], '2026-12-14')).toEqual([]));
test('trial boundaries are inclusive; open-ended rules stay active', () => {
  expect(activeRules([trial], '2026-11-01')).toHaveLength(1);
  expect(activeRules([trial], '2026-12-13')).toHaveLength(1);
  expect(activeRules([trial], '2026-10-31')).toHaveLength(0);
  expect(activeRules([{ ...trial, endsOn: null }], '2030-01-01')).toHaveLength(1);
});
test('unknown contains is flagged and not servable during trial', () => {
  const f = { ...chickenPate, contains: null };
  expect(checkFlavorForCat(f, vanta, [trial], '2026-11-10')[0]).toMatchObject({ rule: 'excluded_ingredient', ingredient: 'fish', certainty: 'unknown' });
  expect(servableFor(f, vanta, [trial], '2026-11-10')).toBe(false);
});
test('fish-free flavor is servable during trial', () =>
  expect(servableFor(chickenPate, vanta, [trial], '2026-11-10')).toBe(true));
test('chunks blocked for Pixel', () =>
  expect(checkFlavorForCat(chunksInGravy, pixel, [], '2026-11-10')[0]?.rule).toBe('texture'));
test('kibble side on Pixel plate is dry_mix', () =>
  expect(
    checkPlate({ items: [{ flavorId: chickenPate.id, amountOz: 3 }], toppers: [], side: { flavorId: kibble.id, amount: 0.125 } },
      pixel, flavors, [], '2026-11-10').map((v) => v.rule),
  ).toContain('dry_mix'));
test('kibble side is fine for Vanta', () =>
  expect(
    checkPlate({ items: [{ flavorId: chickenPate.id, amountOz: 3 }], toppers: [], side: { flavorId: kibble.id, amount: 0.125 } },
      vanta, flavors, [], '2026-11-10'),
  ).toEqual([]));
test('topper with fish violates trial (Purrly salmon & chicken)', () => {
  const v = checkPlate(
    { items: [{ flavorId: chickenPate.id, amountOz: 3 }], toppers: [{ flavorId: purrlySalmonChicken.id, amountOz: 0.5 }], side: null },
    vanta, flavors, [trial], '2026-11-10');
  expect(v).toContainEqual(expect.objectContaining({ rule: 'excluded_ingredient', ingredient: 'fish', flavorId: purrlySalmonChicken.id }));
});
test('a no-chicken rule flags chicken foods and not fish-free beef', () => {
  const rule = { ...trial, value: 'chicken' };
  const chicken = { ...chickenPate, contains: ['chicken'] };
  const beef = flavor({ id: 'beef-pate', name: 'Beef Pate', primaryProtein: 'beef', contains: ['beef'] });
  expect(checkFlavorForCat(chicken, vanta, [rule], '2026-11-10')).toEqual([
    expect.objectContaining({ rule: 'excluded_ingredient', ingredient: 'chicken', certainty: 'known',
      message: 'Contains chicken; the no-chicken rule is active until 2026-12-13.' }),
  ]);
  expect(checkFlavorForCat(beef, vanta, [rule], '2026-11-10')).toEqual([]);
});
test('unknown ingredients are flagged once per active rule', () => {
  const f = { ...chickenPate, contains: null };
  const rules = [trial, { ...trial, id: 'r2', value: 'chicken', endsOn: null }];
  const v = checkFlavorForCat(f, vanta, rules, '2026-11-10');
  expect(v).toHaveLength(2);
  expect(v.map((x) => x.ingredient)).toEqual(['fish', 'chicken']);
  expect(v[0]?.message).toBe('Ingredients not checked; the no-fish rule is active until 2026-12-13.');
  expect(v[1]?.message).toBe('Ingredients not checked; the no-chicken rule is active.');
  expect(servableFor(f, vanta, rules, '2026-11-10')).toBe(false);
});
test('rule value matching is case-insensitive', () =>
  expect(checkFlavorForCat(salmonPate, vanta, [{ ...trial, value: 'Fish' }], '2026-11-10')[0])
    .toMatchObject({ rule: 'excluded_ingredient', ingredient: 'fish', certainty: 'known' }));
