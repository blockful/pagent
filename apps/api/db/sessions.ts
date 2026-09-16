import { client } from './connection.ts';

// ---------------------------------------------------------------------------
// Sessions (browser cookies)
// ---------------------------------------------------------------------------
// Browser sessions back the `pagent_session` cookie. `token_hash` is SHA-256
// of the raw cookie value; the raw token is only ever seen by the browser
// (in the cookie jar) and by `lookupSession` (during a request). Sliding
// expiry: every authenticated request extends `expires_at` by
// SESSION_MAX_AGE_DAYS so an actively-used session never bounces the user
// to re-login. See spec §6 and §7.2 (Token storage).

export type SessionInsert = {
  userId: string;
  tokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
};

/**
 * Insert a fresh session row. Not wrapped in withRetry: a retry after a
 * successful insert would surface a unique-violation on token_hash and
 * falsely report a duplicate. The raw token has 128 bits of entropy so
 * collisions are vanishingly unlikely; a retry-on-collision strategy isn't
 * worth the complexity here.
 */
export async function insertSession(input: SessionInsert): Promise<void> {
  const c = client();
  await c`
    insert into sessions (user_id, token_hash, ip_address, user_agent, expires_at)
    values (
      ${input.userId},
      ${input.tokenHash},
      ${input.ipAddress},
      ${input.userAgent},
      ${input.expiresAt}
    )
  `;
}

/**
 * Row shape returned by `getSessionWithUserByTokenHash` — joins sessions to
 * users so a single round-trip resolves both the session validity and the
 * user identity that the middleware needs for `c.var.user`.
 */
export type SessionWithUserRow = {
  session_id: string;
  user_id: string;
  email: string;
  handle: string | null;
  expires_at: Date;
};

/**
 * Look up a non-expired session by its `token_hash`, joined to the owning
 * user row. Returns null when the token is unknown or expired — the
 * middleware treats both as "anonymous request" so we collapse them here.
 *
 * The `expires_at > now()` filter is part of the WHERE clause so an
 * expired-but-not-yet-swept row reads as gone. The `sessions_token_hash_idx`
 * unique index keeps this O(1).
 */
export async function getSessionWithUserByTokenHash(
  tokenHash: string,
): Promise<SessionWithUserRow | null> {
  const c = client();
  const rows = await c<SessionWithUserRow[]>`
    select s.id as session_id,
           u.id as user_id,
           u.email as email,
           u.handle as handle,
           s.expires_at as expires_at
    from sessions s
    join users u on u.id = s.user_id
    where s.token_hash = ${tokenHash}
      and s.expires_at > now()
  `;
  return rows[0] ?? null;
}

/**
 * Extend a session's `expires_at` to a new absolute timestamp. Used by the
 * sliding-expiry path in `lookupSession` — every authenticated request bumps
 * the row out by SESSION_MAX_AGE_DAYS. Idempotent: a duplicate call simply
 * overwrites with the same value.
 */
export async function extendSessionExpiry(sessionId: string, newExpiresAt: Date): Promise<void> {
  const c = client();
  await c`
    update sessions
    set expires_at = ${newExpiresAt}
    where id = ${sessionId}
  `;
}

/**
 * Delete a session row by its `token_hash`. Used by logout — once the row is
 * gone, the cookie still in the browser is just an opaque string with no
 * server-side state to resolve. Returns silently when the row doesn't exist
 * (callers don't need to distinguish "logged out twice" from "first logout").
 */
export async function deleteSessionByTokenHash(tokenHash: string): Promise<void> {
  const c = client();
  await c`
    delete from sessions where token_hash = ${tokenHash}
  `;
}
