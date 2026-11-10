import { describe } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { authStoreContract } from './authStore.contract.js';
import { createMemoryAuthStore } from '../../src/auth/memoryAuthStore.js';
import { createFirestoreAuthStore, AUTH_COLLECTIONS } from '../../src/auth/firestoreAuthStore.js';

describe('memory auth store', () => {
  authStoreContract('memory', async () => createMemoryAuthStore());
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('firestore auth store (emulator)', () => {
  const db = new Firestore({ projectId: 'demo-ttf' });
  authStoreContract('firestore', async () => {
    for (const c of AUTH_COLLECTIONS) await db.recursiveDelete(db.collection(c));
    return createFirestoreAuthStore(db);
  });
});
