import { describe, it, expect } from 'vitest';
import { createMemoryRepo } from '../../src/store/memoryRepo.js';
import { updateCat } from '../../src/tools/cats.js';

describe('update_cat', () => {
  it('creates a new cat with defaults only on confirm', async () => {
    const repo = createMemoryRepo();
    const pre = await updateCat(repo, { id: 'tiger', patch: { name: 'Tiger', dailyOz: 7 }, confirm: false });
    expect(pre.saved).toBe(false);
    expect(await repo.cats.list()).toHaveLength(0);
    await updateCat(repo, { id: 'tiger', patch: { name: 'Tiger', dailyOz: 7 }, confirm: true });
    expect(await repo.cats.get('tiger')).toEqual({
      id: 'tiger', name: 'Tiger', age: null, breed: null, weight: null, allergies: [],
      textureRules: { allowed: [], blocked: [] }, noMixDryIntoWet: false, sideSwingsWet: false,
      fixedPortionOz: null, eatsAnythingWeight: 1, dailyOz: 7, proteinPrefs: [], usualPlate: null,
    });
  });

  it('shallow-merges into an existing cat', async () => {
    const repo = createMemoryRepo();
    await updateCat(repo, { id: 'tiger', patch: { name: 'Tiger' }, confirm: true });
    await updateCat(repo, { id: 'tiger', patch: { textureRules: { allowed: [], blocked: ['pate'] }, sideSwingsWet: true }, confirm: true });
    const c = (await repo.cats.get('tiger'))!;
    expect(c.name).toBe('Tiger');
    expect(c.dailyOz).toBe(6.5);
    expect(c.textureRules.blocked).toEqual(['pate']);
    expect(c.sideSwingsWet).toBe(true);
  });

  it('rejects unknown patch fields and id changes', async () => {
    const repo = createMemoryRepo();
    await expect(updateCat(repo, { id: 't', patch: { bogus: 1 }, confirm: true })).rejects.toThrow(/bogus/);
    await expect(updateCat(repo, { id: 't', patch: { id: 'x' }, confirm: true })).rejects.toThrow();
    expect(await repo.cats.list()).toHaveLength(0);
  });
});

describe('update_cat validation (I4)', () => {
  it('rejects a string dailyOz, a non-Texture, and out-of-range numbers, writing nothing', async () => {
    const repo = createMemoryRepo();
    await expect(updateCat(repo, { id: 't', patch: { dailyOz: '6.5' }, confirm: true })).rejects.toThrow(/dailyOz/);
    await expect(updateCat(repo, { id: 't', patch: { textureRules: { allowed: [], blocked: ['chunks'] } }, confirm: true }))
      .rejects.toThrow(/textureRules/);
    await expect(updateCat(repo, { id: 't', patch: { dailyOz: 0 }, confirm: true })).rejects.toThrow(/dailyOz/);
    await expect(updateCat(repo, { id: 't', patch: { weight: -1 }, confirm: true })).rejects.toThrow(/weight/);
    await expect(updateCat(repo, { id: 't', patch: { fixedPortionOz: Number.NaN }, confirm: true })).rejects.toThrow(/fixedPortionOz/);
    await expect(updateCat(repo, { id: 't', patch: { eatsAnythingWeight: 1.5 }, confirm: true })).rejects.toThrow(/eatsAnythingWeight/);
    expect(await repo.cats.list()).toHaveLength(0);
  });

  it('lowercases proteinPrefs and accepts valid values', async () => {
    const repo = createMemoryRepo();
    await updateCat(repo, { id: 't', patch: { proteinPrefs: [' Chicken', 'DUCK'], eatsAnythingWeight: 0.5, fixedPortionOz: null }, confirm: true });
    const c = (await repo.cats.get('t'))!;
    expect(c.proteinPrefs).toEqual(['chicken', 'duck']);
    expect(c.eatsAnythingWeight).toBe(0.5);
  });
});
