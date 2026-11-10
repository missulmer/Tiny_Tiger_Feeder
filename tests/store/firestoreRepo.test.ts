import { describe } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { repoContract } from './repo.contract.js';
import { createFirestoreRepo, COLLECTIONS } from '../../src/store/firestoreRepo.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('firestore emulator', () => {
  const db = new Firestore({ projectId: 'demo-ttf' });
  repoContract('firestore', async () => {
    for (const c of COLLECTIONS) await db.recursiveDelete(db.collection(c));
    return createFirestoreRepo(db);
  });
});
