import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryRepo } from '../../src/store/memoryRepo.js';
import type { Repo } from '../../src/store/repo.js';
import { recordShipment, confirmArrival, confirmInChewy } from '../../src/tools/shipments.js';
import { chickenPate, product } from '../fixtures/household.js';

let repo: Repo;
beforeEach(async () => {
  repo = createMemoryRepo();
  await repo.products.put(product({ id: chickenPate.productId }));
  await repo.flavors.put(chickenPate);
});
const order = { date: '2026-11-10', lines: [{ productId: chickenPate.productId, qtyCases: 2 }] };

describe('shipments', () => {
  it('record_shipment status depends on source', async () => {
    await recordShipment(repo, { source: 'plan', order: { ...order, id: 'a' }, confirm: true });
    await recordShipment(repo, { source: 'email', order: { ...order, id: 'b' }, confirm: true });
    expect((await repo.orders.get('a'))!.status).toBe('planned');
    expect((await repo.orders.get('b'))!.status).toBe('confirmed-in-chewy');
  });

  it('confirm_in_chewy reports qty mismatch', async () => {
    await recordShipment(repo, { source: 'plan', order: { ...order, id: 'a' }, confirm: true });
    const lines = [{ productId: chickenPate.productId, qtyCases: 3 }];
    const r = await confirmInChewy(repo, { orderId: 'a', lines, confirm: false });
    expect(r.preview.differences).toEqual([{ productId: chickenPate.productId, planned: 2, inChewy: 3 }]);
    expect((await repo.orders.get('a'))!.status).toBe('planned');
    await confirmInChewy(repo, { orderId: 'a', lines, confirm: true });
    const o = (await repo.orders.get('a'))!;
    expect(o.status).toBe('confirmed-in-chewy');
    expect(o.lines[0]!.qtyCases).toBe(3);
  });

  it('confirm_arrival adds stock with adjustments and cannot repeat', async () => {
    await recordShipment(repo, { source: 'email', order: { ...order, id: 'a' }, confirm: true });
    await confirmArrival(repo, { orderId: 'a', adjustments: [{ productId: chickenPate.productId, qtyCases: 1 }], confirm: true });
    const ev = await repo.pantryEvents.list();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.deltaCans).toBe(12);
    expect((await repo.orders.get('a'))!.status).toBe('arrived');
    await expect(confirmArrival(repo, { orderId: 'a', confirm: true })).rejects.toThrow(/already arrived/);
    expect(await repo.pantryEvents.list()).toHaveLength(1);
  });
});
