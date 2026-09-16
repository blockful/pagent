import { client } from './connection.ts';
import type { RefreshTokenInsert } from './refresh-tokens.ts';

// ---------------------------------------------------------------------------
// Auth codes (PKCE authorization codes)
// ---------------------------------------------------------------------------
// 10-minute TTL per spec §3.4. The `code` itself is the PK so a second-use
// race against `consumed_at` can be detected as a unique-violation. The
// callback issues these after a successful Google handshake; the token
// endpoint (Task 06) consumes them.

export type AuthCodeInsert = {
  code: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  expiresAt: Date;
};

/**
 * Insert a fresh authorization code. `consumed_at` is left NULL — the token
 * endpoint flips it on first use. Not wrapped in withRetry: the code is a
 * unique random value, a retry after success would attempt to insert a
 * duplicate PK and falsely surface a unique-violation to the caller.
 */
export async function insertAuthCode(input: AuthCodeInsert): Promise<void> {
  const c = client();
  await c`
    insert into auth_codes (
      code, user_id, client_id, redirect_uri,
      code_challenge, code_challenge_method, scope, expires_at
    ) values (
      ${input.code}, ${input.userId}, ${input.clientId}, ${input.redirectUri},
      ${input.codeChallenge}, ${input.codeChallengeMethod},
      ${input.scope}, ${input.expiresAt}
    )
  `;
}

/**
 * Row returned by `getAuthCodeForReplay`. Mirrors the `auth_codes` column
 * layout and carries every binding the token endpoint validates before either
 * issuing tokens or treating a second exchange as a replay.
 */
export type AuthCodeRow = {
  code: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  resource: string | null;
  refresh_token_family_id: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
};

export type ConsumedAuthCode = {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  resource: string | null;
  refreshTokenFamilyId: string;
};

/**
 * Atomically consume an authorization code and insert its initial refresh
 * token while holding the same family lock used by replay revocation. The
 * transaction closes the gap where a losing exchange could revoke an empty
 * family before the winner inserted its token.
 *
 * Returns null when the code is unknown / expired / already consumed. The
 * token endpoint then disambiguates via `getAuthCodeForReplay` to decide
 * whether to treat the failure as a replay (which triggers family revocation
 * per RFC 6749 §4.1.2).
 */
export async function consumeAuthCodeAndInsertRefreshToken(
  code: string,
  refreshToken: RefreshTokenInsert,
): Promise<ConsumedAuthCode | null> {
  const c = client();
  return c.begin(async (tx): Promise<ConsumedAuthCode | null> => {
    await tx`
      select pg_advisory_xact_lock(
        hashtextextended(${refreshToken.familyId}, 0)
      )
    `;
    const rows = await tx<
      {
        user_id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        code_challenge_method: string;
        scope: string | null;
        resource: string | null;
        refresh_token_family_id: string;
      }[]
    >`
      update auth_codes
      set consumed_at = now()
      where code = ${code}
        and user_id = ${refreshToken.userId}
        and client_id = ${refreshToken.clientId}
        and refresh_token_family_id = ${refreshToken.familyId}
        and consumed_at is null
        and expires_at > now()
      returning user_id, client_id, redirect_uri, code_challenge,
               code_challenge_method, scope, resource, refresh_token_family_id
    `;
    const row = rows[0];
    if (row === undefined) return null;
    await tx`
      insert into refresh_tokens (user_id, client_id, family_id, token_hash, scope, expires_at)
      values (
        ${refreshToken.userId}, ${refreshToken.clientId}, ${refreshToken.familyId}, ${refreshToken.tokenHash},
        ${refreshToken.scope}, ${refreshToken.expiresAt}
      )
    `;
    return {
      userId: row.user_id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method,
      scope: row.scope,
      resource: row.resource,
      refreshTokenFamilyId: row.refresh_token_family_id,
    };
  });
}

/**
 * Look up an auth code without consuming it. The token endpoint validates the
 * stored bindings before mutation, and re-reads after a lost consume race to
 * distinguish a valid replay from an unknown or expired code.
 *
 * Returns null when the row doesn't exist. Expiry and prior consumption are
 * NOT filtered here — the caller decides what to do with each state.
 */
export async function getAuthCodeForReplay(code: string): Promise<AuthCodeRow | null> {
  const c = client();
  const rows = await c<AuthCodeRow[]>`
    select code, user_id, client_id, redirect_uri, refresh_token_family_id,
           code_challenge, code_challenge_method, scope, resource,
           created_at, expires_at, consumed_at
    from auth_codes
    where code = ${code}
  `;
  return rows[0] ?? null;
}
