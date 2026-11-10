import { it, expect, beforeEach } from 'vitest';
import type { AuthStore } from '../../src/auth/authStore.js';

export function authStoreContract(name: string, make: () => Promise<AuthStore>) {
  let s: AuthStore;
  beforeEach(async () => { s = await make(); });

  it(`${name}: clients round-trip`, async () => {
    expect(await s.getClient('c1')).toBeUndefined();
    await s.saveClient({ client_id: 'c1', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' });
    expect((await s.getClient('c1'))?.client_name).toBe('Claude');
  });

  it(`${name}: pending authorizations are taken once`, async () => {
    await s.savePending('p1', {
      clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', scopes: [], nonce: 'n', expiresAt: 1,
    });
    expect((await s.takePending('p1'))?.nonce).toBe('n');
    expect(await s.takePending('p1')).toBeNull();
  });

  it(`${name}: codes can be read, then taken once`, async () => {
    await s.saveCode('h1', {
      clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', scopes: ['a'], email: 'e', expiresAt: 2,
    });
    expect((await s.getCode('h1'))?.codeChallenge).toBe('ch');
    expect((await s.takeCode('h1'))?.email).toBe('e');
    expect(await s.takeCode('h1')).toBeNull();
    expect(await s.getCode('h1')).toBeNull();
  });

  it(`${name}: tokens round-trip and delete`, async () => {
    await s.saveToken('t1', { kind: 'access', clientId: 'c1', email: 'e', scopes: [], expiresAt: 3 });
    expect((await s.getToken('t1'))?.kind).toBe('access');
    await s.deleteToken('t1');
    expect(await s.getToken('t1')).toBeNull();
    await s.saveToken('t2', { kind: 'refresh', clientId: 'c1', email: 'e', scopes: [], expiresAt: 4 });
    expect((await s.takeToken('t2'))?.kind).toBe('refresh');
    expect(await s.takeToken('t2')).toBeNull();
  });
}
