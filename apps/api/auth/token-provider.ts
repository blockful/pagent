import * as db from '../db.ts';
import { logger } from '../logger.ts';
import { getClient } from './clients-store.ts';
import {
  hashRefreshToken,
  prepareTokenPair,
  REFRESH_TOKEN_PREFIX,
  TokenError,
  type TokenResponse,
} from './token-core.ts';

/**
 * Refresh an access token using a refresh token (RFC 6749 §6 + RFC 6749 §6
 * + OAuth 2.1 §6.1 rotation).
 *
 * Sequence:
 *   1. Look up the refresh token by SHA-256(raw).
 *   2. If unknown → invalid_grant.
 *   3. If revoked → token family revocation: revoke every active refresh
 *      token for (user_id, client_id) and return invalid_grant.
 *   4. If expired → invalid_grant.
 *   5. If client_id doesn't match the bound client → invalid_grant.
 *   6. Atomically revoke the old refresh token and insert its successor.
 */
export async function refreshToken(
  rawRefreshToken: string,
  clientId: string,
): Promise<TokenResponse> {
  if (!rawRefreshToken || !clientId) {
    throw new TokenError('invalid_request', 'Missing required parameter');
  }

  const client = await getClient(clientId);
  if (!client) {
    throw new TokenError('invalid_client', 'Unknown client_id', 401);
  }

  const tokenHash = hashRefreshToken(rawRefreshToken);
  const row = await db.getRefreshTokenByHash(tokenHash);
  if (!row) {
    throw new TokenError('invalid_grant', 'Refresh token is invalid');
  }

  // Replay of a revoked token → revoke entire family. Per OAuth 2.1 §6.1:
  // the safe assumption is that the token leaked, so every still-active
  // refresh for that user+client gets revoked.
  if (row.revoked_at !== null) {
    logger.warn(
      {
        refresh_token_id: row.id,
        user_id: row.user_id,
        client_id: row.client_id,
      },
      'revoked refresh token replay — revoking entire token family',
    );
    await db.revokeAllRefreshTokensForFamily(row.user_id, row.client_id);
    throw new TokenError('invalid_grant', 'Refresh token has been revoked');
  }

  if (row.expires_at.getTime() <= Date.now()) {
    throw new TokenError('invalid_grant', 'Refresh token has expired');
  }

  if (row.client_id !== clientId) {
    throw new TokenError('invalid_grant', 'client_id does not match refresh token');
  }

  const user = await db.getUserById(row.user_id);
  if (!user) {
    throw new TokenError('invalid_grant', 'User no longer exists');
  }

  const prepared = await prepareTokenPair(user, clientId, row.scope);
  const successor = await db.rotateRefreshToken(row.id, {
    tokenHash: prepared.refreshToken.tokenHash,
    scope: prepared.refreshToken.scope,
    expiresAt: prepared.refreshToken.expiresAt,
  });
  if (!successor) {
    logger.warn(
      {
        refresh_token_id: row.id,
        user_id: row.user_id,
        client_id: row.client_id,
      },
      'refresh token rotation race — revoking entire token family',
    );
    await db.revokeAllRefreshTokensForFamily(row.user_id, row.client_id);
    throw new TokenError('invalid_grant', 'Refresh token has been revoked');
  }
  return prepared.response;
}

/**
 * Revoke a refresh token (RFC 7009). The endpoint always returns success
 * regardless of whether the token existed — distinguishing would leak token
 * validity to an attacker probing.
 *
 * `tokenTypeHint` is informational (per RFC 7009 §2.1) — we ignore it because
 * we only issue refresh tokens by opaque format and access tokens by JWT;
 * the `rt_` prefix on refresh tokens disambiguates without needing the hint.
 */
export async function revokeToken(
  token: string,
  _tokenTypeHint: string | undefined,
  _clientId: string | undefined,
): Promise<void> {
  if (!token) return;
  // Refresh token: opaque, identified by the `rt_` prefix. Hash and look up.
  if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
    const row = await db.getRefreshTokenByHash(hashRefreshToken(token));
    if (row && row.revoked_at === null) {
      await db.revokeRefreshToken(row.id);
    }
    return;
  }
  // Access tokens (JWTs) aren't revocable in V1 — they're short-lived (1h)
  // and verification is purely cryptographic. RFC 7009 §2.2 says the server
  // SHOULD revoke the access token if revoking a refresh token; we have no
  // index from access-token jti to refresh-token row, so this is a no-op
  // until V2 introduces an explicit denylist.
}
