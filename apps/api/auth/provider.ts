/**
 * OAuthServerProvider — owns the application-side OAuth flow.
 *
 * Task 05 introduced the "post-Google-callback" half (turn a Google profile
 * into a Pagent user + mint the authorization code). Task 07 fills in the
 * token endpoint operations: exchange an authorization code for an
 * access+refresh token pair, rotate refresh tokens, and revoke either kind
 * on request.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §3.4–§3.6, §5.1–§5.2,
 * §7.1.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as db from '../db.ts';
import { logger } from '../logger.ts';
import { env } from '../schemas.ts';
import { getClient } from './clients-store.ts';
import { signAccessToken } from './jwt.ts';

// Handles are user-visible (URL slugs, display) so they share the
// constraints we'd apply to any short identifier: lowercase alphanumeric +
// dashes, 3-40 chars, must start/end with alphanumeric. The spec's regex is
// applied on read elsewhere; here we only need to produce a value that
// matches.
const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// 10-minute auth-code TTL per spec §3.4. Enough for the browser redirect +
// the MCP client's POST /oauth/token; longer windows just extend the
// abuse-replay surface for a stolen code.
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

// 32 bytes (256 bits) of entropy is overkill for a one-time code with a
// 10-minute window but matches the refresh-token sizing for consistency
// and gives operators a single number to reason about.
const AUTH_CODE_BYTES = 32;

/**
 * Reduce the email local part to handle-shaped characters.
 *
 * Steps:
 *   1. lowercase
 *   2. strip everything that isn't alphanumeric or dash
 *   3. trim leading/trailing dashes (HANDLE_REGEX requires alphanumeric anchors)
 *   4. enforce length: pad with "user" if too short, truncate if too long
 *
 * Returns a string that's guaranteed to satisfy HANDLE_REGEX. Callers then
 * resolve collisions via generateUniqueHandle.
 */
export function sanitizeHandle(local: string): string {
  let h = local.toLowerCase().replace(/[^a-z0-9-]/g, '');
  // Strip leading/trailing dashes — HANDLE_REGEX requires the first and
  // last char to be alphanumeric.
  h = h.replace(/^-+/, '').replace(/-+$/, '');
  // Pad short locals with "user" so we always end up >= 3 chars. A 0-length
  // input (e.g. all special chars stripped) yields "user".
  if (h.length < 3) h = (h + 'user').slice(0, 40);
  // Truncate long locals.
  if (h.length > 40) h = h.slice(0, 40);
  // Re-trim in case truncation re-exposed a trailing dash.
  h = h.replace(/^-+/, '').replace(/-+$/, '');
  // Final sanity check — if any of the above produced an invalid value
  // (e.g. all dashes input), fall back to a stable default. Vanishingly
  // rare in practice but keeps the contract iron-clad.
  if (!HANDLE_REGEX.test(h)) {
    h = 'user';
  }
  return h;
}

/**
 * Pick a handle that isn't already taken by another user.
 *
 * Tries the sanitized base, then `${base}2`, `${base}3`, etc., shortening
 * the base if needed to fit the suffix within the 40-char cap. Bails after
 * 999 attempts — at that point we'd rather fail loudly than spin.
 */
export async function generateUniqueHandle(local: string): Promise<string> {
  const base = sanitizeHandle(local);
  if (!(await db.getUserByHandle(base))) return base;
  for (let suffix = 2; suffix <= 999; suffix++) {
    const suffixStr = String(suffix);
    // Slice the base so base+suffix fits in 40 chars. For short bases this
    // is a no-op; for max-length bases we lose a few chars off the end.
    const trimmed = base.slice(0, 40 - suffixStr.length).replace(/-+$/, '');
    const candidate = `${trimmed}${suffixStr}`;
    if (HANDLE_REGEX.test(candidate) && !(await db.getUserByHandle(candidate))) {
      return candidate;
    }
  }
  throw new Error('handle generation exhausted');
}

/**
 * Profile fields extracted from Google's ID token (or a Magic Link).
 * `avatarUrl` may be null for Magic Link users (no profile picture).
 */
export interface UserProfile {
  email: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * Insert-or-update a user by email. On a brand-new email the row is created
 * with a freshly generated handle; on a returning email name/avatar_url are
 * refreshed but the handle is left alone (it's the user-visible identifier
 * and shouldn't churn).
 *
 * Returns the resulting user row so the callback can reference its `id` /
 * `handle` when issuing the authorization code.
 */
export async function upsertUser(profile: UserProfile): Promise<db.UserRow> {
  // Local part of the email is the seed for the handle. RFC 5321 caps local
  // parts at 64 chars, sanitizeHandle further truncates to 40 — so even
  // pathologically long inputs are bounded.
  const localPart = profile.email.split('@')[0] ?? '';
  const handle = await generateUniqueHandle(localPart);
  return db.upsertUser({
    email: profile.email,
    name: profile.name ?? null,
    avatarUrl: profile.avatarUrl ?? null,
    handle,
  });
}

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

// ---------------------------------------------------------------------------
// Token endpoint operations
// ---------------------------------------------------------------------------

// 32-byte (256-bit) refresh tokens. Hex doubles the length to 64 chars so the
// raw value is ~67 chars including the `rt_` prefix — small enough to fit in
// a JSON response without bloat, large enough that brute force is infeasible.
const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_PREFIX = 'rt_';

/**
 * Token endpoint success response. Matches RFC 6749 §4.1.4 — every successful
 * exchange returns the same shape regardless of grant type.
 *
 * `expires_in` is the access-token lifetime in seconds (the refresh token's
 * own lifetime is not exposed — clients learn it implicitly by trying to
 * refresh and observing the failure).
 */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

/**
 * Error class for the token endpoint. Each instance maps to an OAuth 2.1
 * error response: `{ error, error_description }` plus an HTTP status (400 for
 * client errors, 401 for invalid_client). The route layer catches these and
 * serializes them.
 */
export class TokenError extends Error {
  constructor(
    public readonly code:
      | 'invalid_grant'
      | 'invalid_client'
      | 'invalid_request'
      | 'unsupported_grant_type'
      | 'invalid_scope',
    public readonly description: string,
    public readonly status: 400 | 401 = 400,
  ) {
    super(description);
    this.name = 'TokenError';
  }
}

/**
 * Hash a raw refresh token for DB storage. Pure SHA-256 (hex) — no salt, no
 * HMAC: the raw token already carries 256 bits of entropy so salting buys
 * nothing, and a leaked HMAC key would compromise every hash. Matches the
 * `magic_links.token_hash` / `sessions.token_hash` storage strategy.
 */
function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Generate a fresh refresh token. Returns both the raw value (to give back
 * to the caller) and the SHA-256 hash (to persist).
 */
function generateRefreshToken(): { raw: string; hash: string } {
  const random = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const raw = `${REFRESH_TOKEN_PREFIX}${random}`;
  const hash = hashRefreshToken(raw);
  return { raw, hash };
}

/**
 * Verify a PKCE challenge against the supplied verifier (RFC 7636).
 *
 * S256 only: pagent advertises S256 as the sole supported method (see AS
 * metadata), so a non-S256 method here is an internal contract violation.
 * Uses `crypto.timingSafeEqual` for defense-in-depth — timing leakage on
 * base64url SHA-256 comparison is largely academic, but the cost is zero
 * and it keeps every hash comparison on the auth surface constant-time.
 */
function pkceVerify(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  const expected = createHash('sha256').update(codeVerifier).digest('base64url');
  // timingSafeEqual throws when buffer lengths differ — pre-check so we
  // return false instead of crashing on a malformed challenge.
  if (expected.length !== codeChallenge.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(codeChallenge));
}

/**
 * Mint the access+refresh pair given a verified context (user, client,
 * scope). Shared between the authorization_code and refresh_token grants so
 * the JWT claim shape and refresh-token persistence stay in lockstep.
 *
 * `user` is the pagent user row — we need `id`, `email`, and `handle` for
 * the JWT claims. The handle must be non-null at this point (we generate one
 * at upsertUser time), but we defensively fall back to the email local part
 * if it's somehow missing.
 */
async function mintTokens(
  user: db.UserRow,
  clientId: string,
  scope: string | null,
): Promise<TokenResponse> {
  const handle = user.handle ?? user.email.split('@')[0] ?? 'user';
  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    handle,
    clientId,
    // Scope on the JWT is the empty string when none was negotiated — the
    // claim shape from spec §5.1 requires a string, not null/undefined.
    scope: scope ?? '',
  });

  const { raw: refreshToken, hash: refreshHash } = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_MAX_DAYS * 24 * 60 * 60 * 1000);
  await db.insertRefreshToken({
    userId: user.id,
    clientId,
    tokenHash: refreshHash,
    scope,
    expiresAt: refreshExpiresAt,
  });

  const response: TokenResponse = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
  };
  if (scope !== null) response.scope = scope;
  return response;
}

/**
 * Exchange an authorization code (+ PKCE verifier) for an access+refresh
 * pair. Implements the authorization_code grant from RFC 6749 §4.1.3 with
 * PKCE per RFC 7636.
 *
 * Sequence:
 *   1. Atomically consume the code (UPDATE ... WHERE consumed_at IS NULL).
 *   2. If the code was unknown / expired / already consumed → invalid_grant.
 *      For the "already consumed" case (detectable via a second SELECT) we
 *      also revoke any refresh tokens issued from that code's user/client —
 *      RFC 6749 §4.1.2 SHOULD.
 *   3. Verify the PKCE challenge → invalid_grant on mismatch.
 *   4. Verify client_id and redirect_uri match the bound values → invalid_grant.
 *   5. Mint access + refresh tokens.
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

  // Atomic single-use consume. Returns null for "unknown / expired / already
  // consumed" — we then SELECT to disambiguate the "already consumed" case
  // and react accordingly.
  const consumed = await db.consumeAuthCode(code);
  if (!consumed) {
    const replay = await db.getAuthCodeForReplay(code);
    if (replay && replay.consumed_at !== null) {
      // Replay attempt — revoke any refresh tokens already issued from this
      // code's user/client pair. RFC 6749 §4.1.2 SHOULD; aligns with the
      // refresh-token family revocation in `refreshToken` below.
      logger.warn(
        {
          code: code.slice(0, 8) + '…',
          user_id: replay.user_id,
          client_id: replay.client_id,
        },
        'auth code replay attempt — revoking refresh token family',
      );
      await db.revokeAllRefreshTokensForFamily(replay.user_id, replay.client_id);
    }
    throw new TokenError('invalid_grant', 'Authorization code is invalid or expired');
  }

  // PKCE first (cheaper than DB calls, catches the most common attacker
  // case — forged code from another browser without the verifier).
  if (!pkceVerify(codeVerifier, consumed.codeChallenge, consumed.codeChallengeMethod)) {
    throw new TokenError('invalid_grant', 'PKCE verification failed');
  }

  // Binding checks: the code is single-use and bound to a specific
  // client_id/redirect_uri at issue time. A request that doesn't match must
  // fail invalid_grant — a mismatched redirect_uri is the canonical
  // open-redirect / code-injection signal.
  if (consumed.clientId !== clientId) {
    throw new TokenError('invalid_grant', 'client_id does not match authorization code');
  }
  if (consumed.redirectUri !== redirectUri) {
    throw new TokenError('invalid_grant', 'redirect_uri does not match authorization code');
  }

  // Resolve the user so we can populate JWT claims. cascade delete would have
  // purged the auth_code if the user disappeared, so this should always
  // succeed — but a defensive null check keeps a missing row from crashing
  // the request.
  const user = await db.getUserById(consumed.userId);
  if (!user) {
    throw new TokenError('invalid_grant', 'User no longer exists');
  }

  return mintTokens(user, clientId, consumed.scope);
}

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
 *   6. Mint a new access+refresh pair, then revoke the old refresh token.
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

  // Mint the new pair first; only revoke the old token after the insert
  // succeeds. If minting fails halfway through, the original token stays
  // valid so the caller can retry rather than getting locked out.
  const response = await mintTokens(user, clientId, row.scope);
  await db.revokeRefreshToken(row.id);
  return response;
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
