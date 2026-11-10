import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, RequestHandler } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthStore } from './authStore.js';

/** The ID-token claims we rely on, after signature/audience/issuer/expiry checks. */
export interface GoogleClaims {
  email?: string;
  email_verified?: boolean;
  nonce?: string;
  /** Google's stable account id. */
  sub?: string;
}
/** Verifies a Google ID token (signature, aud = GOOGLE_CLIENT_ID, iss, exp) and returns its claims. */
export type VerifyGoogleIdToken = (idToken: string) => Promise<GoogleClaims>;
/** Exchanges the Google authorization code (server-side, with the client secret) for an ID token. */
export type ExchangeGoogleCode = (code: string) => Promise<string>;

export interface AllowlistConfig {
  allowedEmail: string;
  googleClientId: string;
  /** e.g. https://feeder.example.com (no trailing slash) */
  publicBaseUrl: string;
  /** Exact redirect URIs dynamic clients may register (Claude's OAuth callbacks). */
  allowedRedirectUris: string[];
  /** Optional: pin the Google account id (`sub`) as well as the email. */
  allowedGoogleSub?: string;
  now?: () => number;
  /** Informational log sink (default console.log). */
  log?: (msg: string) => void;
}

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';
export const CONSENT_PATH = '/oauth/consent';
/** __Host- prefix: Secure, Path=/, no Domain, so only this exact origin can set or read it. */
export const BROWSER_COOKIE = '__Host-ttf_auth';

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const normEmail = (e: string) => e.trim().toLowerCase();
const comparable = (u: string) => u.split('#')[0]!.replace(/\/$/, '');

/** Constant-time comparison of sha256(value) against a stored hex hash. */
function hashMatches(value: string | undefined, storedHash: string | undefined): boolean {
  if (!value || !storedHash) return false;
  const a = Buffer.from(sha256(value), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

export const escapeHtml = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * form-action must also allow Google: browsers apply form-action to the redirect that follows
 * the consent POST, so 'self' alone would block the hop to Google sign-in.
 */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com";
export const CONSENT_WARNING =
  'Approve only if you just clicked Connect in your own Claude app. If someone sent you this link, close this page.';

function sendPage(res: Response, status: number, title: string, body: string): void {
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 16px;color:#222;background:#fff}
dt{font-weight:600;margin-top:.5rem}dd{margin:0;word-break:break-all}.warn{background:#fff4e5;border:1px solid #f0a040;padding:.75rem;border-radius:6px}
button{font:inherit;padding:.6rem 1.2rem;margin:1rem .5rem 0 0;border-radius:6px;border:1px solid #888;background:#f4f4f4}
button.ok{background:#1a5fd0;color:#fff;border-color:#1a5fd0}</style></head>
<body>${body}</body></html>`);
}

const failPage = (res: Response, status: number, msg: string) =>
  sendPage(res, status, 'Tiny Tiger Feeder', `<h1>Tiny Tiger Feeder</h1><p>${escapeHtml(msg)}</p>`);

/**
 * OAuth 2.1 authorization server for exactly one person. Sign-in is delegated to Google
 * (OpenID Connect); only a verified Google account whose email equals `allowedEmail`
 * gets an authorization code. Codes and tokens are opaque, random, and stored hashed.
 */
export class GoogleAllowlistProvider implements OAuthServerProvider {
  readonly resourceUrl: string;
  private readonly now: () => number;

  constructor(private readonly store: AuthStore, private readonly cfg: AllowlistConfig) {
    this.resourceUrl = new URL('/mcp', cfg.publicBaseUrl).href;
    this.now = cfg.now ?? Date.now;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: id => this.store.getClient(id),
      registerClient: async client => {
        const allowed = new Set(this.cfg.allowedRedirectUris);
        const bad = client.redirect_uris.filter(u => !allowed.has(u));
        if (bad.length > 0 || client.redirect_uris.length === 0) {
          throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad.join(', ') || '(none)'}`);
        }
        // The SDK generates client_id before calling us (clientIdGeneration defaults on).
        const full = client as OAuthClientInformationFull;
        await this.store.saveClient(full);
        return full;
      },
    };
  }

  private isAllowed(email: string | undefined): boolean {
    return !!email && normEmail(email) === normEmail(this.cfg.allowedEmail);
  }

  private checkResource(resource: URL | string | undefined): void {
    if (resource !== undefined && comparable(String(resource)) !== comparable(this.resourceUrl)) {
      throw new InvalidTargetError(`Unknown resource; this server only serves ${this.resourceUrl}`);
    }
  }

  /**
   * /authorize (after the SDK validated client, redirect_uri and PKCE params): bind the request to
   * this browser with a __Host- cookie and show a consent page. Nothing goes to Google until the
   * page's form is POSTed back with a valid CSRF token from the same browser.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const browser = randomToken();
    const pendingId = randomToken();
    const csrf = randomToken();
    await this.store.savePending(sha256(pendingId), {
      stage: 'consent',
      browserHash: sha256(browser),
      csrfHash: sha256(csrf),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: this.resourceUrl,
      expiresAt: this.now() + PENDING_TTL_MS,
    });
    res.cookie(BROWSER_COOKIE, browser, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: PENDING_TTL_MS,
    });
    const registered = client.client_id_issued_at
      ? new Date(client.client_id_issued_at * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
      : 'unknown';
    const name = client.client_name?.trim() || '(unnamed client)';
    sendPage(res, 200, 'Connect Tiny Tiger Feeder?', `<h1>Connect Tiny Tiger Feeder?</h1>
<p class="warn"><strong>${escapeHtml(CONSENT_WARNING)}</strong></p>
<p>An app is asking to read and change your cats' feeding data.</p>
<dl><dt>App name (self-reported)</dt><dd>${escapeHtml(name)}</dd>
<dt>Sends you back to</dt><dd>${escapeHtml(params.redirectUri)}</dd>
<dt>Registered</dt><dd>${escapeHtml(registered)}</dd></dl>
<form method="post" action="${CONSENT_PATH}">
<input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button class="ok" type="submit" name="decision" value="approve">Approve and sign in with Google</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`);
  }

  /** POST /oauth/consent: the consent form. Only a valid approve from the same browser reaches Google. */
  consentHandler(): RequestHandler {
    return async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const pendingId = typeof body.pending === 'string' ? body.pending : undefined;
      const csrf = typeof body.csrf === 'string' ? body.csrf : undefined;
      const bad = () => failPage(res, 400, 'This sign-in request is invalid or expired. Start again from Claude.');
      if (!pendingId) { bad(); return; }
      // Taken (single use) before any check: a forged or replayed POST burns the request.
      const rec = await this.store.takePending(sha256(pendingId));
      if (!rec || rec.stage !== 'consent' || rec.expiresAt <= this.now()) { bad(); return; }
      if (!hashMatches(readCookie(req, BROWSER_COOKIE), rec.browserHash)) { bad(); return; }
      if (!hashMatches(csrf, rec.csrfHash)) { bad(); return; }
      if (body.decision !== 'approve') {
        failPage(res, 200, 'Denied. Nothing was connected. You can close this page.');
        return;
      }

      const googleState = randomToken();
      const nonce = randomToken();
      const { csrfHash: _csrf, ...rest } = rec;
      await this.store.savePending(sha256(googleState), {
        ...rest, stage: 'google', nonce, expiresAt: this.now() + PENDING_TTL_MS,
      });
      const url = new URL(GOOGLE_AUTH_URL);
      url.searchParams.set('client_id', this.cfg.googleClientId);
      url.searchParams.set('redirect_uri', new URL(GOOGLE_CALLBACK_PATH, this.cfg.publicBaseUrl).href);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email');
      url.searchParams.set('state', googleState);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('prompt', 'select_account');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, url.href);
    };
  }

  /** GET /oauth/google/callback — Google returns here; on an allowlisted sign-in, we issue our code. */
  googleCallback(exchange: ExchangeGoogleCode, verify: VerifyGoogleIdToken): RequestHandler {
    return async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const q = req.query as Record<string, unknown>;
      const state = typeof q.state === 'string' ? q.state : undefined;
      const code = typeof q.code === 'string' ? q.code : undefined;
      if (!state) { res.status(400).type('text').send('Missing state.'); return; }
      const pending = await this.store.takePending(sha256(state));
      if (!pending || pending.stage !== 'google' || pending.expiresAt <= this.now()) {
        res.status(400).type('text').send('This sign-in link expired or was already used. Start again from Claude.');
        return;
      }
      // Browser binding, checked before anything else: the browser finishing sign-in must be the
      // one that started it at /authorize and approved the consent page.
      if (!hashMatches(readCookie(req, BROWSER_COOKIE), pending.browserHash)) {
        res.status(400).type('text').send('This sign-in was started in a different browser. Start again from Claude.');
        return;
      }
      res.clearCookie(BROWSER_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
      if (typeof q.error === 'string' || !code) {
        // The person cancelled at Google (or Google refused): tell the MCP client, issue nothing.
        const back = new URL(pending.redirectUri);
        back.searchParams.set('error', 'access_denied');
        if (pending.state) back.searchParams.set('state', pending.state);
        res.redirect(302, back.href);
        return;
      }

      let idToken: string;
      try {
        idToken = await exchange(code);
      } catch (e) {
        console.error('google code exchange failed', e);
        res.status(502).type('text').send('Could not complete Google sign-in. Try again.');
        return;
      }
      let claims: GoogleClaims;
      try {
        claims = await verify(idToken);
      } catch (e) {
        console.error('google id token rejected', e);
        res.status(403).type('text').send('Google sign-in could not be verified.');
        return;
      }
      const subOk = this.cfg.allowedGoogleSub === undefined || claims.sub === this.cfg.allowedGoogleSub;
      if (!pending.nonce || claims.nonce !== pending.nonce || claims.email_verified !== true
        || !this.isAllowed(claims.email) || !subOk) {
        res.status(403).type('text').send('This Google account is not allowed to use Tiny Tiger Feeder.');
        return;
      }

      // Not secret; logged so the owner can pin it via ALLOWED_GOOGLE_SUB (docs/deploy.md §7).
      (this.cfg.log ?? console.log)(`google sign-in sub=${claims.sub ?? '(none)'} accepted`);
      const ourCode = randomToken();
      await this.store.saveCode(sha256(ourCode), {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes: pending.scopes,
        resource: pending.resource,
        email: normEmail(claims.email!),
        expiresAt: this.now() + CODE_TTL_MS,
      });
      const back = new URL(pending.redirectUri);
      back.searchParams.set('code', ourCode);
      if (pending.state) back.searchParams.set('state', pending.state);
      res.redirect(302, back.href);
    };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const rec = await this.store.getCode(sha256(authorizationCode));
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= this.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string,
    redirectUri?: string, resource?: URL,
  ): Promise<OAuthTokens> {
    // PKCE was verified by the SDK's token handler (skipLocalPkceValidation is not set).
    const rec = await this.store.takeCode(sha256(authorizationCode));
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= this.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    this.checkResource(resource);
    if (!this.isAllowed(rec.email)) throw new InvalidGrantError('Account no longer allowed');
    return this.issueTokens(client.client_id, rec.email, rec.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const rec = await this.store.getToken(hash);
    if (!rec || rec.kind !== 'refresh' || rec.clientId !== client.client_id || rec.expiresAt <= this.now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    if (!this.isAllowed(rec.email)) throw new InvalidGrantError('Account no longer allowed');
    this.checkResource(resource);
    if (scopes && !scopes.every(s => rec.scopes.includes(s))) {
      throw new InvalidScopeError('Requested scope exceeds the original grant');
    }
    // Rotate: the presented refresh token is consumed exactly once.
    if (!(await this.store.takeToken(hash))) throw new InvalidGrantError('Refresh token already used');
    return this.issueTokens(client.client_id, rec.email, scopes ?? rec.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = await this.store.getToken(sha256(token));
    if (!rec || rec.kind !== 'access') throw new InvalidTokenError('Invalid access token');
    if (rec.expiresAt <= this.now()) throw new InvalidTokenError('Access token expired');
    if (!this.isAllowed(rec.email)) throw new InvalidTokenError('Account no longer allowed');
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      // From the stored record, so the SDK's expectedResource check is meaningful.
      resource: rec.resource ? new URL(rec.resource) : undefined,
      extra: { email: rec.email },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = sha256(request.token);
    const rec = await this.store.getToken(hash);
    if (rec && rec.clientId === client.client_id) await this.store.deleteToken(hash);
  }

  private async issueTokens(clientId: string, email: string, scopes: string[]): Promise<OAuthTokens> {
    const access = randomToken();
    const refresh = randomToken();
    const now = this.now();
    const base = { clientId, email, scopes, resource: this.resourceUrl };
    await this.store.saveToken(sha256(access), { ...base, kind: 'access', expiresAt: now + ACCESS_TTL_MS });
    await this.store.saveToken(sha256(refresh), { ...base, kind: 'refresh', expiresAt: now + REFRESH_TTL_MS });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
    };
  }
}
