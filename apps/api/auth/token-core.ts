import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as db from '../db.ts';
import { env } from '../schemas.ts';
import { signAccessToken } from './jwt.ts';

// 32-byte (256-bit) refresh tokens. Hex doubles the length to 64 chars so the
// raw value is ~67 chars including the `rt_` prefix — small enough to fit in
// a JSON response without bloat, large enough that brute force is infeasible.
const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_TOKEN_PREFIX = 'rt_';

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

type TokenErrorCode =
  | 'invalid_grant'
  | 'invalid_client'
  | 'invalid_request'
  | 'unsupported_grant_type'
  | 'invalid_scope';

/**
 * Error class for the token endpoint. Each instance maps to an OAuth 2.1
 * error response: `{ error, error_description }` plus an HTTP status (400 for
 * client errors, 401 for invalid_client). The route layer catches these and
 * serializes them.
 */
export class TokenError extends Error {
  readonly code: TokenErrorCode;
  readonly description: string;
  readonly status: 400 | 401;

  constructor(code: TokenErrorCode, description: string, status: 400 | 401 = 400) {
    super(description);
    this.code = code;
    this.description = description;
    this.status = status;
    this.name = 'TokenError';
  }
}

/**
 * Hash a raw refresh token for DB storage. Pure SHA-256 (hex) — no salt, no
 * HMAC: the raw token already carries 256 bits of entropy so salting buys
 * nothing, and a leaked HMAC key would compromise every hash. Matches the
 * `magic_links.token_hash` / `sessions.token_hash` storage strategy.
 */
export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Generate a fresh refresh token. Returns both the raw value (to give back
 * to the caller) and the SHA-256 hash (to persist).
 */
export function generateRefreshToken(): { raw: string; hash: string } {
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
export function pkceVerify(codeVerifier: string, codeChallenge: string, method: string): boolean {
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
export async function mintTokens(
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
