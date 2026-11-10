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

describe('shipments: final-review fixes', () => {
  it('C1: record_shipment previews the case prices it will record and appends them to the product on confirm', async () => {
    await repo.products.put(product({ id: chickenPate.productId, prices: [] }));
    const o = { id: 'a', date: '2026-10-01', lines: [{ productId: chickenPate.productId, qtyCases: 2, casePrice: 31.5 }] };
    const pre = await recordShipment(repo, { source: 'screenshot', order: o, confirm: false });
    expect(pre.preview.pricesToRecord).toEqual([{ productId: chickenPate.productId, casePrice: 31.5, seenOn: '2026-10-01' }]);
    expect((await repo.products.get(chickenPate.productId))!.prices).toEqual([]);
    await recordShipment(repo, { source: 'screenshot', order: o, confirm: true });
    expect((await repo.products.get(chickenPate.productId))!.prices)
      .toEqual([{ casePrice: 31.5, seenOn: '2026-10-01', source: 'screenshot' }]);
  });

  it('C1: lines without a casePrice record no price', async () => {
    await repo.products.put(product({ id: chickenPate.productId, prices: [] }));
    const r = await recordShipment(repo, { source: 'email', order: { ...order, id: 'a' }, confirm: true });
    expect(r.preview.pricesToRecord).toEqual([]);
    expect((await repo.products.get(chickenPate.productId))!.prices).toEqual([]);
  });

  it('M2: repeated productIds are rejected in record_shipment, confirm_in_chewy and confirm_arrival', async () => {
    const twice = [{ productId: chickenPate.productId, qtyCases: 1 }, { productId: chickenPate.productId, qtyCases: 2 }];
    await expect(recordShipment(repo, { source: 'email', order: { date: '2026-11-10', lines: twice }, confirm: true }))
      .rejects.toThrow(/more than once/);
    expect(await repo.orders.list()).toHaveLength(0);
    await recordShipment(repo, { source: 'plan', order: { ...order, id: 'a' }, confirm: true });
    await expect(confirmInChewy(repo, { orderId: 'a', lines: twice, confirm: true })).rejects.toThrow(/more than once/);
    await expect(confirmArrival(repo, { orderId: 'a', adjustments: twice, confirm: true })).rejects.toThrow(/more than once/);
    expect((await repo.orders.get('a'))!.status).toBe('planned');
    expect(await repo.pantryEvents.list()).toHaveLength(0);
  });

  it('M2: qtyCases must be a whole number', async () => {
    const half = [{ productId: chickenPate.productId, qtyCases: 1.5 }];
    await expect(recordShipment(repo, { source: 'email', order: { date: '2026-11-10', lines: half }, confirm: true }))
      .rejects.toThrow(/whole number/);
    await recordShipment(repo, { source: 'email', order: { ...order, id: 'a' }, confirm: true });
    await expect(confirmInChewy(repo, { orderId: 'a', lines: half, confirm: true })).rejects.toThrow(/whole number/);
    await expect(confirmArrival(repo, { orderId: 'a', adjustments: half, confirm: true })).rejects.toThrow(/whole number/);
    // 0 is a valid arrival adjustment (nothing came).
    const r = await confirmArrival(repo, { orderId: 'a', adjustments: [{ productId: chickenPate.productId, qtyCases: 0 }], confirm: false });
    expect(r.preview.stockAdded).toEqual([]);
  });
});
