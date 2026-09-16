/**
 * Browser session helpers.
 *
 * Sessions back the `pagent_session` cookie. The raw token is a 128-bit
 * random hex string generated at login time and stored only in the user's
 * cookie jar. Server-side we only ever persist the SHA-256 hash — a
 * dropped database backup is therefore useless for resuming sessions.
 *
 * Sliding expiry: every successful `lookupSession` extends `expires_at` by
 * SESSION_MAX_AGE_DAYS so an actively-used session never times out.
 * Inactive sessions still age out after the configured window.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §6 (Middleware
 * design), §7.2 (Token storage), §7.4 (CSRF protection).
 */
import { createHash, randomBytes } from 'node:crypto';
import * as db from '../db.ts';
import { env } from '../schemas.ts';
import type { AuthUser } from './middleware.ts';

// 16 bytes (128 bits) of entropy is well past brute-force feasibility for a
// cookie that's also bound to user-agent/IP at issue time. Hex doubles the
// length to 32 chars — fits in any browser cookie size limit without breaking
// a sweat. Matches the page-id sizing for visual consistency in log lines.
const SESSION_TOKEN_BYTES = 16;

// Number of milliseconds in one day. Used to translate
// SESSION_MAX_AGE_DAYS into an absolute Date for the expiry column.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Hash a raw session token for DB storage. Pure SHA-256 hex — no salt, no
 * HMAC. The raw token already carries 128 bits of entropy so salting would
 * buy us nothing, and a leaked HMAC key would compromise every hash.
 * Mirrors `refresh_tokens` / `magic_links` token storage strategy.
 */
function hashSessionToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Compute the absolute expiry timestamp for a session based on the
 * configured `SESSION_MAX_AGE_DAYS`. Computed at call time so a config
 * reload (or a test stubbing the env) is observable.
 */
function computeExpiresAt(): Date {
  return new Date(Date.now() + env.SESSION_MAX_AGE_DAYS * MS_PER_DAY);
}

/**
 * Create a fresh browser session. Generates a 128-bit random hex token,
 * stores SHA-256(token) plus session metadata (ip, user-agent, expiry),
 * and returns the raw token so the caller can set it on a cookie.
 *
 * The raw token leaves this function once. After that it lives in the
 * user's cookie jar and (briefly, per request) in `lookupSession`'s local
 * variable — never in the database, never in logs.
 */
export async function createSession(
  userId: string,
  ip?: string,
  userAgent?: string,
): Promise<string> {
  const raw = randomBytes(SESSION_TOKEN_BYTES).toString('hex');
  const tokenHash = hashSessionToken(raw);
  await db.insertSession({
    userId,
    tokenHash,
    ipAddress: ip ?? null,
    userAgent: userAgent ?? null,
    expiresAt: computeExpiresAt(),
  });
  return raw;
}

/**
 * Resolve a raw session token to an `AuthUser`. Returns null when the
 * token is unknown, expired, or otherwise unusable — the caller (auth
 * middleware) treats every "not a valid live session" outcome the same
 * way (anonymous request).
 *
 * On a successful lookup, the session's `expires_at` is bumped forward by
 * `SESSION_MAX_AGE_DAYS` — the sliding-expiry behaviour from spec §6. We
 * do this *after* resolving the user so a DB blip on the extend doesn't
 * fail the request (the row stays valid until the original `expires_at`).
 *
 * `authMethod` is set to 'cookie' here. The middleware overwrites it
 * downstream so both code paths converge on the same shape, but populating
 * it here keeps this function's return type honest.
 */
export async function lookupSession(token: string): Promise<AuthUser | null> {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const row = await db.getSessionWithUserByTokenHash(tokenHash);
  if (!row) return null;
  // Slide the expiry forward. Errors here are logged via the global error
  // handler but shouldn't fail the request — the existing `expires_at` is
  // still valid, so the user shouldn't see a 500 because of a backend blip
  // on an expiry-bump UPDATE. Swallowing keeps the auth path resilient.
  try {
    await db.extendSessionExpiry(row.session_id, computeExpiresAt());
  } catch {
    // Intentional: see above.
  }
  return {
    id: row.user_id,
    email: row.email,
    handle: row.handle,
    authMethod: 'cookie',
  };
}

/**
 * Delete a session by its raw token. Idempotent — second call against the
 * same token is a no-op. Used by `POST /auth/logout` (the cookie is also
 * cleared on the client side via Set-Cookie with a past expiry).
 */
export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  await db.deleteSessionByTokenHash(tokenHash);
}
