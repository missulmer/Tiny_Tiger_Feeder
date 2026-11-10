import { pathToFileURL } from 'node:url';
import express, { type Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Repo } from './store/repo.js';
import type { AuthStore } from './auth/authStore.js';
import {
  GoogleAllowlistProvider, GOOGLE_CALLBACK_PATH, CONSENT_PATH, type ExchangeGoogleCode, type VerifyGoogleIdToken,
} from './auth/googleAllowlist.js';
import { register as catalog } from './tools/catalog.js';
import { register as cats } from './tools/cats.js';
import { register as rules } from './tools/rules.js';
import { register as meals } from './tools/meals.js';
import { register as pantry } from './tools/pantry.js';
import { register as shipments } from './tools/shipments.js';
import { register as onboarding } from './tools/onboarding.js';
import { register as plan } from './tools/plan.js';
import { register as history } from './tools/history.js';
import { register as ui } from './tools/ui.js';

const REGISTRARS = [catalog, cats, rules, meals, pantry, shipments, onboarding, plan, history, ui];

export interface Env {
  allowedEmail: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Origin only, no trailing slash, e.g. https://tiny-tiger-feeder-xyz.a.run.app */
  publicBaseUrl: string;
  googleCloudProject?: string;
  store: 'memory' | 'firestore';
  port: number;
  allowedRedirectUris: string[];
  /** Optional Google account id (ID token `sub`) that must also match. */
  allowedGoogleSub?: string;
}

export const DEFAULT_ALLOWED_EMAIL = 'laura@ulmerandco.io';
export const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

/** Validates configuration; throws one error naming every problem. */
export function loadEnv(e: Record<string, string | undefined> = process.env): Env {
  const problems: string[] = [];
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PUBLIC_BASE_URL'].filter(k => !e[k]?.trim());
  if (missing.length) problems.push(`missing ${missing.join(', ')}`);

  const store = e.STORE === 'memory' ? 'memory' : 'firestore';
  // Against the emulator any project id works; demo-* ids never reach real GCP.
  const googleCloudProject = e.GOOGLE_CLOUD_PROJECT?.trim() || (e.FIRESTORE_EMULATOR_HOST ? 'demo-ttf' : undefined);
  if (store === 'firestore' && !googleCloudProject) {
    problems.push('missing GOOGLE_CLOUD_PROJECT (or set STORE=memory for local dev)');
  }

  let publicBaseUrl = '';
  if (e.PUBLIC_BASE_URL?.trim()) {
    try {
      const u = new URL(e.PUBLIC_BASE_URL.trim());
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !local) problems.push('PUBLIC_BASE_URL must be https');
      if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
        problems.push('PUBLIC_BASE_URL must be an origin only (no path, query or fragment)');
      }
      publicBaseUrl = u.origin;
    } catch {
      problems.push('PUBLIC_BASE_URL is not a valid URL');
    }
  }

  const port = e.PORT ? Number(e.PORT) : 8080;
  if (!Number.isInteger(port) || port <= 0) problems.push('PORT must be a positive integer');

  const allowedEmail = (e.ALLOWED_EMAIL?.trim() || DEFAULT_ALLOWED_EMAIL).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(allowedEmail)) problems.push('ALLOWED_EMAIL is not an email address');

  const allowedRedirectUris = e.ALLOWED_REDIRECT_URIS?.trim()
    ? e.ALLOWED_REDIRECT_URIS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_REDIRECT_URIS;

  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}. See .env.example.`);
  return {
    allowedEmail,
    googleClientId: e.GOOGLE_CLIENT_ID!.trim(),
    googleClientSecret: e.GOOGLE_CLIENT_SECRET!.trim(),
    publicBaseUrl,
    googleCloudProject,
    store,
    port,
    allowedRedirectUris,
    ...(e.ALLOWED_GOOGLE_SUB?.trim() ? { allowedGoogleSub: e.ALLOWED_GOOGLE_SUB.trim() } : {}),
  };
}

export function buildMcpServer(repo: Repo): McpServer {
  const server = new McpServer({ name: 'tiny-tiger-feeder', version: '0.1.0' });
  for (const r of REGISTRARS) r(server, repo);
  return server;
}

export interface AppDeps {
  repo: Repo;
  authStore: AuthStore;
  verifyGoogleIdToken: VerifyGoogleIdToken;
  exchangeGoogleCode: ExchangeGoogleCode;
  env: Env;
  /** Clock for token/code expiry (ms since epoch). Tests inject this. */
  now?: () => number;
  /** Informational log sink (default console.log). */
  log?: (msg: string) => void;
}

export function createApp({ repo, authStore, verifyGoogleIdToken, exchangeGoogleCode, env, now, log }: AppDeps): Express {
  const provider = new GoogleAllowlistProvider(authStore, {
    allowedEmail: env.allowedEmail,
    googleClientId: env.googleClientId,
    publicBaseUrl: env.publicBaseUrl,
    allowedRedirectUris: env.allowedRedirectUris,
    allowedGoogleSub: env.allowedGoogleSub,
    now,
    log,
  });
  const issuerUrl = new URL(env.publicBaseUrl);
  const mcpUrl = new URL(provider.resourceUrl);

  const app = express();
  app.disable('x-powered-by');
  // Cloud Run puts exactly one proxy in front; rate limiting keys on the real client IP.
  app.set('trust proxy', 1);

  app.use(mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: mcpUrl,
    resourceName: 'Tiny Tiger Feeder',
    // Claude does not re-register when a client secret expires; the allowlist, PKCE and
    // short-lived codes/tokens are what protect this server, so secrets don't expire.
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));
  // Some clients probe the root PRM path rather than the path-specific one (RFC 9728 §3.1).
  app.use('/.well-known/oauth-protected-resource', metadataHandler({
    resource: mcpUrl.href,
    authorization_servers: [issuerUrl.href],
    resource_name: 'Tiny Tiger Feeder',
  }));

  app.post(CONSENT_PATH, express.urlencoded({ extended: false, limit: '10kb' }), provider.consentHandler());
  app.get(GOOGLE_CALLBACK_PATH, provider.googleCallback(exchangeGoogleCode, verifyGoogleIdToken));
  app.get('/healthz', (_req, res) => { res.type('text').send('ok'); });

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  // Stateless Streamable HTTP: a fresh server + transport per request (SDK's recommended stateless pattern).
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const server = buildMcpServer(repo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('mcp request failed', e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
  const noSessions: express.RequestHandler = (_req, res) => {
    res.status(405).set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless.' }, id: null });
  };
  app.get('/mcp', bearer, noSessions);
  app.delete('/mcp', bearer, noSessions);

  return app;
}

export async function main(): Promise<void> {
  const env = loadEnv();
  const { OAuth2Client } = await import('google-auth-library');
  const google = new OAuth2Client({
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: new URL(GOOGLE_CALLBACK_PATH, env.publicBaseUrl).href,
  });
  const exchangeGoogleCode: ExchangeGoogleCode = async code => {
    const { tokens } = await google.getToken({ code });
    if (!tokens.id_token) throw new Error('Google returned no id_token');
    return tokens.id_token;
  };
  const verifyGoogleIdToken: VerifyGoogleIdToken = async idToken => {
    const ticket = await google.verifyIdToken({ idToken, audience: env.googleClientId });
    const p = ticket.getPayload();
    if (!p) throw new Error('ID token has no payload');
    return { email: p.email, email_verified: p.email_verified, nonce: p.nonce, sub: p.sub };
  };

  let repo: Repo;
  let authStore: AuthStore;
  if (env.store === 'memory') {
    const { createMemoryRepo } = await import('./store/memoryRepo.js');
    const { createMemoryAuthStore } = await import('./auth/memoryAuthStore.js');
    repo = createMemoryRepo();
    authStore = createMemoryAuthStore();
    console.warn('STORE=memory: data and sign-ins are lost on restart.');
  } else {
    const { Firestore } = await import('@google-cloud/firestore');
    const { createFirestoreRepo } = await import('./store/firestoreRepo.js');
    const { createFirestoreAuthStore } = await import('./auth/firestoreAuthStore.js');
    const db = new Firestore({ projectId: env.googleCloudProject });
    repo = createFirestoreRepo(db);
    authStore = createFirestoreAuthStore(db);
  }

  const app = createApp({ repo, authStore, verifyGoogleIdToken, exchangeGoogleCode, env });
  app.listen(env.port, () => {
    console.log(`tiny-tiger-feeder listening on :${env.port}; connector URL ${env.publicBaseUrl}/mcp`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
