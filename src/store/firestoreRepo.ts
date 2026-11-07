import type { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS, matchesFilter, mealMatches, type Collection, type Repo,
} from './repo.js';

export { COLLECTIONS };

/** Firestore rejects undefined; drop them (deeply, JSON-safe plain data only). */
function strip<T>(v: T): T {
  if (Array.isArray(v)) return v.map(strip) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = strip(x);
    return out as T;
  }
  return v;
}

function firestoreCollection<T extends { id: string }>(db: Firestore, name: string): Collection<T> {
  const col = db.collection(name);
  return {
    async list(filter) {
      let q: FirebaseFirestore.Query = col;
      for (const [k, v] of Object.entries(filter ?? {})) if (v !== undefined) q = q.where(k, '==', v);
      const snap = await q.get();
      // re-check client-side so semantics match the memory repo exactly
      return snap.docs.map(d => d.data() as T).filter(e => matchesFilter(e, filter));
    },
    async get(id) {
      const s = await col.doc(id).get();
      return s.exists ? (s.data() as T) : null;
    },
    async put(entity) { await col.doc(entity.id).set(strip(entity)); },
    async delete(id) { await col.doc(id).delete(); },
  };
}

export function createFirestoreRepo(db: Firestore): Repo {
  const repo: Repo = {
    cats: firestoreCollection(db, 'cats'),
    products: firestoreCollection(db, 'products'),
    flavors: firestoreCollection(db, 'flavors'),
    aliases: firestoreCollection(db, 'aliases'),
    meals: firestoreCollection(db, 'meals'),
    rules: firestoreCollection(db, 'rules'),
    pantryEvents: firestoreCollection(db, 'pantryEvents'),
    orders: firestoreCollection(db, 'orders'),
    async mealsFor(q) {
      // date range + catId pushed to Firestore; flavorId (nested arrays) filtered in memory
      let query: FirebaseFirestore.Query = db.collection('meals');
      if (q.catId !== undefined) query = query.where('catId', '==', q.catId);
      if (q.from !== undefined) query = query.where('date', '>=', q.from);
      if (q.to !== undefined) query = query.where('date', '<=', q.to);
      const snap = await query.get();
      return snap.docs.map(d => d.data() as import('../domain/types.js').Meal).filter(m => mealMatches(m, q));
    },
    async ordersByStatus(status) { return repo.orders.list({ status }); },
    async exportAll() {
      const out: Record<string, unknown[]> = {};
      for (const c of COLLECTIONS) out[c] = (await db.collection(c).get()).docs.map(d => d.data());
      return out;
    },
  };
  return repo;
}
