import { describe, it, expect } from 'vitest';
import { repoContract } from './repo.contract.js';
import { createMemoryRepo } from '../../src/store/memoryRepo.js';

repoContract('memory', async () => createMemoryRepo());

describe('memory repo isolation', () => {
  it('deep-copies on put and get', async () => {
    const repo = createMemoryRepo();
    const flavor = {
      id: 'f1', productId: 'p1', name: 'T', primaryProtein: 'turkey', texture: 'pate' as const,
      contains: [], ingredientsText: null, cansPerCase: 24, kind: 'wet' as const, unit: 'can' as const, canOz: 3,
    };
    await repo.flavors.put(flavor);
    flavor.name = 'mutated';
    const a = await repo.flavors.get('f1');
    expect(a?.name).toBe('T');
    a!.name = 'mutated2';
    expect((await repo.flavors.get('f1'))?.name).toBe('T');
    (await repo.flavors.list())[0]!.name = 'x';
    expect((await repo.flavors.get('f1'))?.name).toBe('T');
  });
});
