import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Persistence for the OAuth authorization server. Keys passed in are already
 * opaque: the provider hashes codes and tokens (sha256) before they reach the store,
 * so raw secrets never persist. Expiry is enforced by the provider, not here.
 */

/** An /authorize request waiting for the Google sign-in to come back. */
export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** The MCP client's own `state`, echoed back on the final redirect. */
  state?: string;
  scopes: string[];
  resource?: string;
  /** OpenID Connect nonce we sent to Google; must come back in the ID token. */
  nonce: string;
  /** ms since epoch */
  expiresAt: number;
}

/** Our authorization code, issued after a successful allowlisted Google sign-in. */
export interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  email: string;
  /** ms since epoch */
  expiresAt: number;
}

export interface StoredToken {
  kind: 'access' | 'refresh';
  clientId: string;
  email: string;
  scopes: string[];
  resource?: string;
  /** ms since epoch */
  expiresAt: number;
}

export interface AuthStore {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  saveClient(client: OAuthClientInformationFull): Promise<void>;

  savePending(id: string, p: PendingAuthorization): Promise<void>;
  /** Atomically read and delete. */
  takePending(id: string): Promise<PendingAuthorization | null>;

  saveCode(hash: string, c: AuthorizationCode): Promise<void>;
  getCode(hash: string): Promise<AuthorizationCode | null>;
  /** Atomically read and delete, so a code can be exchanged at most once. */
  takeCode(hash: string): Promise<AuthorizationCode | null>;

  saveToken(hash: string, t: StoredToken): Promise<void>;
  getToken(hash: string): Promise<StoredToken | null>;
  /** Atomically read and delete (refresh-token rotation). */
  takeToken(hash: string): Promise<StoredToken | null>;
  deleteToken(hash: string): Promise<void>;
}
