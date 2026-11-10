import type { Firestore, CollectionReference } from '@google-cloud/firestore';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthStore, AuthorizationCode, PendingAuthorization, StoredToken } from './authStore.js';

/**
 * oauthClients: registered clients, doc id = client_id.
 * oauthCodes:   pending authorizations (kind 'pending', doc id = sha256 of the Google state)
 *               and our authorization codes (kind 'code', doc id = sha256 of the code).
 * oauthTokens:  access and refresh tokens, doc id = sha256 of the token.
 */
export const AUTH_COLLECTIONS = ['oauthClients', 'oauthCodes', 'oauthTokens'] as const;

/** Firestore rejects undefined values; these are JSON-safe records. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function take<T>(db: Firestore, col: CollectionReference, id: string, kind?: string): Promise<T | null> {
  return db.runTransaction(async tx => {
    const ref = col.doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as T & { kind?: string };
    if (kind !== undefined && data.kind !== kind) return null;
    tx.delete(ref);
    return strip(data, kind);
  });
}

function strip<T>(data: T & { kind?: string }, kind?: string): T {
  if (kind === undefined) return data;
  const { kind: _k, ...rest } = data;
  return rest as T;
}

export function createFirestoreAuthStore(db: Firestore): AuthStore {
  const clients = db.collection('oauthClients');
  const codes = db.collection('oauthCodes');
  const tokens = db.collection('oauthTokens');
  return {
    async getClient(id) {
      const s = await clients.doc(id).get();
      return s.exists ? (s.data() as OAuthClientInformationFull) : undefined;
    },
    async saveClient(c) { await clients.doc(c.client_id).set(plain(c)); },
    async savePending(id, p) { await codes.doc(id).set(plain({ ...p, kind: 'pending' })); },
    takePending: id => take<PendingAuthorization>(db, codes, id, 'pending'),
    async saveCode(h, c) { await codes.doc(h).set(plain({ ...c, kind: 'code' })); },
    async getCode(h) {
      const s = await codes.doc(h).get();
      const d = s.data() as (AuthorizationCode & { kind?: string }) | undefined;
      return d && d.kind === 'code' ? strip(d, 'code') : null;
    },
    takeCode: h => take<AuthorizationCode>(db, codes, h, 'code'),
    async saveToken(h, t) { await tokens.doc(h).set(plain(t)); },
    async getToken(h) {
      const s = await tokens.doc(h).get();
      return s.exists ? (s.data() as StoredToken) : null;
    },
    takeToken: h => take<StoredToken>(db, tokens, h),
    async deleteToken(h) { await tokens.doc(h).delete(); },
  };
}
