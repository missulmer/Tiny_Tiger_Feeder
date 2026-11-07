import { COLLECTIONS, matchesFilter, mealMatches, type Collection, type Repo } from './repo.js';

function memoryCollection<T extends { id: string }>(): Collection<T> {
  const store = new Map<string, T>();
  return {
    async list(filter) {
      return [...store.values()].filter(e => matchesFilter(e, filter)).map(e => structuredClone(e));
    },
    async get(id) {
      const e = store.get(id);
      return e ? structuredClone(e) : null;
    },
    async put(entity) { store.set(entity.id, structuredClone(entity)); },
    async delete(id) { store.delete(id); },
  };
}

export function createMemoryRepo(): Repo {
  const repo: Repo = {
    cats: memoryCollection(),
    products: memoryCollection(),
    flavors: memoryCollection(),
    aliases: memoryCollection(),
    meals: memoryCollection(),
    rules: memoryCollection(),
    pantryEvents: memoryCollection(),
    orders: memoryCollection(),
    async mealsFor(q) { return (await repo.meals.list()).filter(m => mealMatches(m, q)); },
    async ordersByStatus(status) { return repo.orders.list({ status }); },
    async exportAll() {
      const out: Record<string, unknown[]> = {};
      for (const c of COLLECTIONS) out[c] = await repo[c].list();
      return out;
    },
  };
  return repo;
}
