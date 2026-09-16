import { randomBytes } from 'node:crypto';
import * as db from '../db.ts';
import { logger } from '../logger.ts';
import { getClient } from './clients-store.ts';
import { pkceVerify, prepareTokenPair, TokenError, type TokenResponse } from './token-core.ts';

// 10-minute auth-code TTL per spec §3.4. Enough for the browser redirect +
// the MCP client's POST /oauth/token; longer windows just extend the
// abuse-replay surface for a stolen code.
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

// 32 bytes (256 bits) of entropy is overkill for a one-time code with a
// 10-minute window but matches the refresh-token sizing for consistency
// and gives operators a single number to reason about.
const AUTH_CODE_BYTES = 32;

/**
 * Mint a fresh authorization code, persist it with PKCE + redirect_uri so
 * the token endpoint can verify the binding, and return the code string to
 * the caller (so they can build the redirect to the MCP client).
 *
 * The code is URL-safe base64 (`randomBytes().toString('base64url')`) — fits
 * in a query parameter without encoding and is opaque to clients.
 */
export async function createAuthCode(
  userId: string,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  codeChallengeMethod: string,
  scope: string | null,
): Promise<string> {
  const code = randomBytes(AUTH_CODE_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS);
  await db.insertAuthCode({
    code,
    userId,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
    expiresAt,
  });
  return code;
}

/**
 * Exchange an authorization code (+ PKCE verifier) for an access+refresh
 * pair. Implements the authorization_code grant from RFC 6749 §4.1.3 with
 * PKCE per RFC 7636.
 *
 * Sequence:
 *   1. Read the code and verify expiry, PKCE, client_id, and redirect_uri.
 *      Invalid exchange attempts must not consume an otherwise valid code.
 *   2. Atomically consume the validated code and insert its refresh token
 *      while holding the token-family replay lock.
 *   3. If the code was already consumed, revoke any refresh tokens issued
 *      from that code's user/client — RFC 6749 §4.1.2 SHOULD.
 *   4. Return the prepared access + refresh pair.
 */
export async function exchangeAuthCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    throw new TokenError('invalid_request', 'Missing required parameter');
  }

  // Verify the client exists. We don't authenticate it (public client, no
  // secret) but we do require the client_id to resolve — otherwise the
  // attacker could forge any client_id and we'd happily mint a token bound
  // to it.
  const client = await getClient(clientId);
  if (!client) {
    throw new TokenError('invalid_client', 'Unknown client_id', 401);
  }

  // Validate against a non-destructive read first. Consuming before these
  // checks would let an attacker invalidate a stolen code merely by sending
  // the wrong verifier, client_id, or redirect_uri.
  const stored = await db.getAuthCodeForReplay(code);
  if (!stored) {
    throw new TokenError('invalid_grant', 'Authorization code is invalid or expired');
  }
  if (stored.expires_at.getTime() <= Date.now()) {
    throw new TokenError('invalid_grant', 'Authorization code is invalid or expired');
  }

  // PKCE first (cheaper than DB calls, catches the most common attacker
  // case — forged code from another browser without the verifier).
  if (!pkceVerify(codeVerifier, stored.code_challenge, stored.code_challenge_method)) {
    throw new TokenError('invalid_grant', 'PKCE verification failed');
  }

  // Binding checks: the code is single-use and bound to a specific
  // client_id/redirect_uri at issue time. A request that doesn't match must
  // fail invalid_grant — a mismatched redirect_uri is the canonical
  // open-redirect / code-injection signal.
  if (stored.client_id !== clientId) {
    throw new TokenError('invalid_grant', 'client_id does not match authorization code');
  }
  if (stored.redirect_uri !== redirectUri) {
    throw new TokenError('invalid_grant', 'redirect_uri does not match authorization code');
  }

  if (stored.consumed_at !== null) {
    await revokeForAuthCodeReplay(code, stored.user_id, stored.client_id);
  }

  const user = await db.getUserById(stored.user_id);
  if (!user) {
    throw new TokenError('invalid_grant', 'User no longer exists');
  }
  const prepared = await prepareTokenPair(user, clientId, stored.scope);

  const consumed = await db.consumeAuthCodeAndInsertRefreshToken(code, prepared.refreshToken);
  if (!consumed) {
    const replay = await db.getAuthCodeForReplay(code);
    if (replay && replay.consumed_at !== null) {
      await revokeForAuthCodeReplay(code, replay.user_id, replay.client_id);
    }
    throw new TokenError('invalid_grant', 'Authorization code is invalid or expired');
  }

  return prepared.response;
}

async function revokeForAuthCodeReplay(
  code: string,
  userId: string,
  clientId: string,
): Promise<never> {
  logger.warn(
    {
      code: code.slice(0, 8) + '…',
      user_id: userId,
      client_id: clientId,
    },
    'auth code replay attempt — revoking refresh token family',
  );
  await db.revokeAllRefreshTokensForFamily(userId, clientId);
  throw new TokenError('invalid_grant', 'Authorization code is invalid or expired');
}
