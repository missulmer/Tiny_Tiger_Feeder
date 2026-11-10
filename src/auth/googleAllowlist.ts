import { createHash, randomBytes } from 'node:crypto';
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
  now?: () => number;
}

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const normEmail = (e: string) => e.trim().toLowerCase();
const comparable = (u: string) => u.split('#')[0]!.replace(/\/$/, '');

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

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const googleState = randomToken();
    const nonce = randomToken();
    await this.store.savePending(sha256(googleState), {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: this.resourceUrl,
      nonce,
      expiresAt: this.now() + PENDING_TTL_MS,
    });
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', this.cfg.googleClientId);
    url.searchParams.set('redirect_uri', new URL(GOOGLE_CALLBACK_PATH, this.cfg.publicBaseUrl).href);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', googleState);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('prompt', 'select_account');
    res.redirect(302, url.href);
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
      if (!pending || pending.expiresAt <= this.now()) {
        res.status(400).type('text').send('This sign-in link expired or was already used. Start again from Claude.');
        return;
      }
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
      if (claims.nonce !== pending.nonce || claims.email_verified !== true || !this.isAllowed(claims.email)) {
        res.status(403).type('text').send('This Google account is not allowed to use Tiny Tiger Feeder.');
        return;
      }

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
      resource: new URL(this.resourceUrl),
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
