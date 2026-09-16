import { client } from './connection.ts';

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
 * Row returned by `consumeAuthCode` and `getAuthCodeForReplay`. Mirrors the
 * `auth_codes` column layout but the caller usually only needs the fields the
 * token endpoint compares against (user_id, client_id, redirect_uri, PKCE
 * bits, scope/resource).
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
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
};

/**
 * Atomically consume an authorization code: set `consumed_at = now()` and
 * return the row's binding fields, but only if the row exists, hasn't expired,
 * and hasn't already been consumed. The single-statement UPDATE ... WHERE
 * consumed_at IS NULL is what gives us the single-use guarantee — concurrent
 * token requests race on this filter and at most one wins.
 *
 * Returns null when the code is unknown / expired / already consumed. The
 * token endpoint then disambiguates via `getAuthCodeForReplay` to decide
 * whether to treat the failure as a replay (which triggers family revocation
 * per RFC 6749 §4.1.2).
 */
export async function consumeAuthCode(code: string): Promise<{
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  resource: string | null;
} | null> {
  const c = client();
  const rows = await c<
    {
      user_id: string;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      code_challenge_method: string;
      scope: string | null;
      resource: string | null;
    }[]
  >`
    update auth_codes
    set consumed_at = now()
    where code = ${code}
      and consumed_at is null
      and expires_at > now()
    returning user_id, client_id, redirect_uri, code_challenge,
             code_challenge_method, scope, resource
  `;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    userId: r.user_id,
    clientId: r.client_id,
    redirectUri: r.redirect_uri,
    codeChallenge: r.code_challenge,
    codeChallengeMethod: r.code_challenge_method,
    scope: r.scope,
    resource: r.resource,
  };
}

/**
 * Look up an auth code without consuming it. Used by the token endpoint after
 * `consumeAuthCode` returns null to disambiguate "unknown / expired" from
 * "already consumed" — RFC 6749 §4.1.2 suggests revoking any tokens issued
 * from a replayed code, which we can only do if we know the row exists.
 *
 * Returns null when the row doesn't exist. Expiry and prior consumption are
 * NOT filtered here — the caller decides what to do with each state.
 */
export async function getAuthCodeForReplay(code: string): Promise<AuthCodeRow | null> {
  const c = client();
  const rows = await c<AuthCodeRow[]>`
    select code, user_id, client_id, redirect_uri,
           code_challenge, code_challenge_method, scope, resource,
           created_at, expires_at, consumed_at
    from auth_codes
    where code = ${code}
  `;
  return rows[0] ?? null;
}
