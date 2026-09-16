import { client } from './connection.ts';

// ---------------------------------------------------------------------------
// Refresh tokens (opaque, rotated on each use)
// ---------------------------------------------------------------------------
// `token_hash` is SHA-256(raw refresh token). Raw values are only ever held
// by the caller (memory + their HTTPS request). On rotation we insert a new
// row while revoking the old one atomically; on detected replay (presenting a row already
// `revoked_at IS NOT NULL`) we revoke every row in the same (user_id,
// client_id) family per OAuth 2.1 §6.1.

export type RefreshTokenRow = {
  id: string;
  user_id: string;
  client_id: string;
  token_hash: string;
  scope: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};

export type RefreshTokenInsert = {
  userId: string;
  clientId: string;
  tokenHash: string;
  scope: string | null;
  expiresAt: Date;
};

export type RefreshTokenSuccessor = {
  tokenHash: string;
  scope: string | null;
  expiresAt: Date;
};

/**
 * Insert a fresh refresh token row for authorization-code exchange.
 * `revoked_at` is left NULL. Not wrapped in withRetry: a retry after a
 * successful insert would race against the unique(token_hash) constraint and
 * surface a spurious failure even though the original write succeeded.
 */
export async function insertRefreshToken(input: RefreshTokenInsert): Promise<RefreshTokenRow> {
  const c = client();
  const rows = await c<RefreshTokenRow[]>`
    insert into refresh_tokens (user_id, client_id, token_hash, scope, expires_at)
    values (
      ${input.userId}, ${input.clientId}, ${input.tokenHash},
      ${input.scope}, ${input.expiresAt}
    )
    returning id, user_id, client_id, token_hash, scope,
             created_at, expires_at, revoked_at
  `;
  return rows[0]!;
}

/**
 * Atomically revoke an active refresh token and insert its successor. A null
 * result means another request already rotated the token, so no successor was
 * inserted by this request.
 */
export async function rotateRefreshToken(
  oldTokenId: string,
  successor: RefreshTokenSuccessor,
): Promise<RefreshTokenRow | null> {
  const c = client();
  const rows = await c.begin(async (tx): Promise<RefreshTokenRow[]> => {
    const families = await tx<Pick<RefreshTokenRow, 'user_id' | 'client_id'>[]>`
      select user_id, client_id
      from refresh_tokens
      where id = ${oldTokenId}
    `;
    const family = families[0];
    if (!family) return [];

    await tx`
      select pg_advisory_xact_lock(
        hashtextextended(${family.user_id} || chr(31) || ${family.client_id}, 0)
      )
    `;
    const inserted = await tx<RefreshTokenRow[]>`
      with revoked as (
        update refresh_tokens
        set revoked_at = now()
        where id = ${oldTokenId} and revoked_at is null
        returning user_id, client_id
      )
      insert into refresh_tokens (user_id, client_id, token_hash, scope, expires_at)
      select revoked.user_id, revoked.client_id, ${successor.tokenHash},
             ${successor.scope}, ${successor.expiresAt}
      from revoked
      returning id, user_id, client_id, token_hash, scope,
               created_at, expires_at, revoked_at
    `;
    return [...inserted];
  });
  return rows[0] ?? null;
}

/**
 * Look up a refresh token row by its SHA-256 hash. Returns null when the hash
 * is unknown. Expiry and revoked state are NOT filtered here — the caller
 * decides what to do with each state. In particular, the rotation path
 * inspects `revoked_at` to detect replays and trigger family revocation.
 */
export async function getRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
  const c = client();
  const rows = await c<RefreshTokenRow[]>`
    select id, user_id, client_id, token_hash, scope,
           created_at, expires_at, revoked_at
    from refresh_tokens
    where token_hash = ${tokenHash}
  `;
  return rows[0] ?? null;
}

/**
 * Mark a single refresh token revoked. Idempotent: a second call against the
 * same id is a no-op. Used by the explicit /oauth/revoke endpoint.
 */
export async function revokeRefreshToken(id: string): Promise<void> {
  const c = client();
  await c`
    update refresh_tokens
    set revoked_at = now()
    where id = ${id} and revoked_at is null
  `;
}

/**
 * Revoke every still-active refresh token for a (user_id, client_id) pair.
 * This is the "token family revocation" path triggered when a revoked token
 * is replayed — per OAuth 2.1 §6.1, the safe response is to assume the whole
 * family has been compromised and invalidate every outstanding refresh
 * token for that client session.
 */
export async function revokeAllRefreshTokensForFamily(
  userId: string,
  clientId: string,
): Promise<void> {
  const c = client();
  await c.begin(async (tx) => {
    // The lock must be acquired in a statement before the UPDATE. Under READ
    // COMMITTED, that gives the UPDATE a fresh snapshot after any in-flight
    // rotation holding the same family lock has committed its successor.
    await tx`
      select pg_advisory_xact_lock(
        hashtextextended(${userId} || chr(31) || ${clientId}, 0)
      )
    `;
    await tx`
      update refresh_tokens
      set revoked_at = now()
      where user_id = ${userId}
        and client_id = ${clientId}
        and revoked_at is null
    `;
  });
}
