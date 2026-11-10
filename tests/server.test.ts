import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { createApp, loadEnv, type Env } from '../src/server.js';
import { createMemoryAuthStore } from '../src/auth/memoryAuthStore.js';
import type { GoogleClaims } from '../src/auth/googleAllowlist.js';
import { createMemoryRepo } from '../src/store/memoryRepo.js';

const BASE = 'https://feeder.example.com';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const ALL_TOOLS = [
  // catalog
  'find_food', 'add_food', 'update_food', 'set_alias',
  // cats, rules
  'update_cat', 'set_household_rule',
  // meals, pantry
  'log_meal', 'pantry_count',
  // shipments
  'record_shipment', 'confirm_arrival', 'confirm_in_chewy',
  // onboarding
  'mark_proven', 'log_recalled_verdicts',
  // plan, history, ui
  'plan_order', 'explain_line', 'cat_history', 'food_history', 'export_all', 'get_ui_kit',
].sort();

const env: Env = loadEnv({
  GOOGLE_CLIENT_ID: 'google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  PUBLIC_BASE_URL: BASE,
  STORE: 'memory',
});

/** Stub Google: the "Google code" names the email the stub ID token will carry. */
function stubGoogle() {
  return {
    // The real exchange posts the code to Google; the stub turns it into a fake ID token string.
    exchangeGoogleCode: async (code: string) => code,
    verifyGoogleIdToken: async (idToken: string): Promise<GoogleClaims> => {
      const [email, verified, nonce] = idToken.split('|');
      return { email: email!, email_verified: verified === 'true', nonce };
    },
  };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

let app: Express;
let authStore: ReturnType<typeof createMemoryAuthStore>;
let clock: number;

beforeEach(() => {
  clock = Date.now(); // the SDK bearer middleware also checks expiry against the real clock
  authStore = createMemoryAuthStore();
  app = createApp({ repo: createMemoryRepo(), authStore, ...stubGoogle(), env, now: () => clock });
});

async function registerClient() {
  const res = await request(app).post('/register').send({
    client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

/** Runs /authorize → Google redirect → callback. Returns the callback response. */
async function signIn(clientId: string, challenge: string, googleEmail: string, verified = true) {
  const auth = await request(app).get('/authorize').query({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state',
    resource: `${BASE}/mcp`,
  });
  expect(auth.status).toBe(302);
  const google = new URL(auth.headers.location!);
  expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(google.searchParams.get('client_id')).toBe(env.googleClientId);
  expect(google.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/google/callback`);
  expect(google.searchParams.get('scope')).toBe('openid email');
  expect(google.searchParams.get('response_type')).toBe('code');
  const state = google.searchParams.get('state')!;
  const nonce = google.searchParams.get('nonce')!;
  expect(state).toBeTruthy();
  expect(nonce).toBeTruthy();
  return request(app).get('/oauth/google/callback')
    .query({ state, code: `${googleEmail}|${verified}|${nonce}` });
}

async function tokenFor(clientId: string) {
  const { verifier, challenge } = pkce();
  const cb = await signIn(clientId, challenge, 'Laura@UlmerAndCo.io');
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.location!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('client-state');
  const code = back.searchParams.get('code')!;
  const tok = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId,
    redirect_uri: REDIRECT, resource: `${BASE}/mcp`,
  });
  expect(tok.status).toBe(200);
  return tok.body as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
}

function listTools(token?: string) {
  const r = request(app).post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
}

describe('loadEnv', () => {
  it('requires Google credentials and the public URL', () => {
    expect(() => loadEnv({ STORE: 'memory' })).toThrow(/GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET.*PUBLIC_BASE_URL/s);
  });
  it('requires GOOGLE_CLOUD_PROJECT for Firestore', () => {
    expect(() => loadEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', PUBLIC_BASE_URL: BASE }))
      .toThrow(/GOOGLE_CLOUD_PROJECT/);
  });
  it('defaults ALLOWED_EMAIL and PORT', () => {
    expect(env.allowedEmail).toBe('laura@ulmerandco.io');
    expect(env.port).toBe(8080);
    expect(env.store).toBe('memory');
  });
});

describe('metadata', () => {
  it('protected-resource metadata points at PUBLIC_BASE_URL', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.resource).toBe(`${BASE}/mcp`);
      expect(res.body.authorization_servers).toEqual([`${BASE}/`]);
    }
  });
  it('authorization-server metadata points at PUBLIC_BASE_URL', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe(`${BASE}/`);
    expect(res.body.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(res.body.token_endpoint).toBe(`${BASE}/token`);
    expect(res.body.registration_endpoint).toBe(`${BASE}/register`);
    expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
  });
});

describe('/mcp auth', () => {
  it('POST /mcp without token → 401 with resource metadata pointer', async () => {
    const res = await listTools();
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('unknown token → 401', async () => {
    expect((await listTools('nope')).status).toBe(401);
  });

  it('token for allowed email lists all tools (full happy path)', async () => {
    const clientId = await registerClient();
    const tok = await tokenFor(clientId);
    expect(tok.token_type.toLowerCase()).toBe('bearer');
    expect(tok.expires_in).toBe(3600);
    expect(tok.refresh_token).toBeTruthy();
    const res = await listTools(tok.access_token);
    expect(res.status).toBe(200);
    const names = (res.body.result.tools as { name: string }[]).map(t => t.name).sort();
    expect(names).toEqual(ALL_TOOLS);
  });

  it('sign-in with another email → 403 and no code issued', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const cb = await signIn(clientId, challenge, 'someone@else.com');
    expect(cb.status).toBe(403);
    expect(cb.headers.location).toBeUndefined();
    expect(authStore.countCodes()).toBe(0);
  });

  it('sign-in with unverified allowed email → 403', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const cb = await signIn(clientId, challenge, 'laura@ulmerandco.io', false);
    expect(cb.status).toBe(403);
    expect(authStore.countCodes()).toBe(0);
  });

  it('callback state is single-use', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const auth = await request(app).get('/authorize').query({
      client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const g = new URL(auth.headers.location!);
    const q = { state: g.searchParams.get('state')!, code: `laura@ulmerandco.io|true|${g.searchParams.get('nonce')}` };
    expect((await request(app).get('/oauth/google/callback').query(q)).status).toBe(302);
    expect((await request(app).get('/oauth/google/callback').query(q)).status).toBe(400);
  });

  it('ID token with the wrong nonce → 403', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const auth = await request(app).get('/authorize').query({
      client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const state = new URL(auth.headers.location!).searchParams.get('state')!;
    const cb = await request(app).get('/oauth/google/callback').query({ state, code: 'laura@ulmerandco.io|true|wrong' });
    expect(cb.status).toBe(403);
  });

  it('expired access token → 401', async () => {
    const tok = await tokenFor(await registerClient());
    clock += 3600_000 + 1000;
    expect((await listTools(tok.access_token)).status).toBe(401);
  });

  it('refresh token issues a new working access token and rotates', async () => {
    const clientId = await registerClient();
    const tok = await tokenFor(clientId);
    clock += 2 * 3600_000;
    const r = await request(app).post('/token').type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
    expect(r.status).toBe(200);
    expect((await listTools(r.body.access_token)).status).toBe(200);
    const again = await request(app).post('/token').type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
    expect(again.status).toBe(400);
  });

  it('changing ALLOWED_EMAIL revokes existing tokens', async () => {
    const tok = await tokenFor(await registerClient());
    const other = createApp({
      repo: createMemoryRepo(), authStore, ...stubGoogle(),
      env: { ...env, allowedEmail: 'someone@else.com' }, now: () => clock,
    });
    const res = await request(other).post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${tok.access_token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
  });

  it('tampered PKCE verifier → token request fails', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const cb = await signIn(clientId, challenge, 'laura@ulmerandco.io');
    const code = new URL(cb.headers.location!).searchParams.get('code')!;
    const tok = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(tok.status).toBe(400);
    expect(tok.body.error).toBe('invalid_grant');
    expect(tok.body.access_token).toBeUndefined();
  });

  it('authorization code is single-use', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const cb = await signIn(clientId, challenge, 'laura@ulmerandco.io');
    const code = new URL(cb.headers.location!).searchParams.get('code')!;
    const body = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId };
    expect((await request(app).post('/token').type('form').send(body)).status).toBe(200);
    expect((await request(app).post('/token').type('form').send(body)).status).toBe(400);
  });

  it('registration rejects redirect URIs outside the allowlist', async () => {
    const res = await request(app).post('/register').send({
      client_name: 'evil', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none',
    });
    expect(res.status).toBe(400);
  });

  it('tokens are stored hashed, never raw', async () => {
    const tok = await tokenFor(await registerClient());
    const hash = createHash('sha256').update(tok.access_token).digest('hex');
    expect(await authStore.getToken(tok.access_token)).toBeNull();
    expect((await authStore.getToken(hash))?.email).toBe('laura@ulmerandco.io');
  });
});
