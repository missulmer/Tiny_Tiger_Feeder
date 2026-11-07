import { expect, test } from 'vitest';
import { casesForShare, summarizeOrder } from '../../src/domain/orderMath.js';

const W_CHK = { productId: 'weruva-chicken', caseOz: 144, casePrice: 56.7175 };
const W_LAMB = { productId: 'weruva-lamb', caseOz: 144, casePrice: 56.7175 };
const BB = { productId: 'blue-buffalo', caseOz: 132, casePrice: 39.97 };

test('9-week order reproduces handoff numbers', () => {
  const s = summarizeOrder([{ ...W_CHK, cases: 5 }, { ...W_LAMB, cases: 5 }, { ...BB, cases: 6 }], 32.5);
  expect(s.totalOz).toBe(2232);
  expect(s.daysOfFood).toBeCloseTo(68.7, 1);
  expect(s.intervalWeeks).toBe(9);
  expect(Math.abs(s.costPerShipment - 807)).toBeLessThan(0.05);
});
test('4-week order reproduces handoff numbers', () => {
  const s = summarizeOrder([{ ...W_CHK, cases: 2 }, { ...W_LAMB, cases: 2 }, { ...BB, cases: 3 }], 32.5);
  expect(s.totalOz).toBe(972);
  expect(s.daysOfFood).toBeCloseTo(29.9, 1);
  expect(s.intervalWeeks).toBe(4);
  expect(s.slackDays).toBeCloseTo(1.9, 1);
  expect(Math.abs(s.costPerShipment - 346.78)).toBeLessThan(0.05);
});
test('daily cost range', () => {
  expect(Math.abs(summarizeOrder([{ ...W_CHK, cases: 1 }], 32.5).costPerDay - 12.81)).toBeLessThan(0.05);
  expect(Math.abs(summarizeOrder([{ ...BB, cases: 1 }], 32.5).costPerDay - 9.82)).toBeLessThan(0.05);
});
test('pantry oz extends days of food', () => {
  expect(summarizeOrder([{ ...BB, cases: 1 }], 32.5, 32.5).daysOfFood).toBeCloseTo(132 / 32.5 + 1, 5);
});
test('casesForShare subtracts stock and never goes negative', () => {
  expect(casesForShare(13, 28, 144, 0)).toBe(3);
  expect(casesForShare(13, 28, 144, 1000)).toBe(0);
});
