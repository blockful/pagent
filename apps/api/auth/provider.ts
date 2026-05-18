/**
 * OAuthServerProvider — partial implementation for Task 05.
 *
 * Owns the "post-Google-callback" half of the authorize flow: turn the
 * Google profile into a Pagent user (creating one on first sight) and
 * mint the authorization code the MCP client will redeem at the token
 * endpoint.
 *
 * The remaining provider methods (token exchange, refresh, revocation) are
 * implemented in Task 06 alongside the token endpoint.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §3.4, §3.7, §5.
 */
import { randomBytes } from 'node:crypto';
import * as db from '../db.ts';

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
