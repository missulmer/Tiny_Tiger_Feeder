import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthStore, AuthorizationCode, PendingAuthorization, StoredToken } from './authStore.js';

const clone = <T>(v: T): T => structuredClone(v);

function take<T>(m: Map<string, T>, k: string): T | null {
  const v = m.get(k);
  if (v === undefined) return null;
  m.delete(k);
  return v;
}

export function createMemoryAuthStore(): AuthStore & { countCodes(): number } {
  const clients = new Map<string, OAuthClientInformationFull>();
  const pending = new Map<string, PendingAuthorization>();
  const codes = new Map<string, AuthorizationCode>();
  const tokens = new Map<string, StoredToken>();
  return {
    async getClient(id) { const c = clients.get(id); return c && clone(c); },
    async saveClient(c) { clients.set(c.client_id, clone(c)); },
    async savePending(id, p) { pending.set(id, clone(p)); },
    async takePending(id) { return take(pending, id); },
    async saveCode(h, c) { codes.set(h, clone(c)); },
    async getCode(h) { const c = codes.get(h); return c ? clone(c) : null; },
    async takeCode(h) { return take(codes, h); },
    async saveToken(h, t) { tokens.set(h, clone(t)); },
    async getToken(h) { const t = tokens.get(h); return t ? clone(t) : null; },
    async takeToken(h) { return take(tokens, h); },
    async deleteToken(h) { tokens.delete(h); },
    countCodes() { return codes.size; },
  };
}
