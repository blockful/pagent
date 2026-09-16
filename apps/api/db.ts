import { client, withRetry } from './db/connection.ts';

export { databaseSsl, init, ping, shutdown, withRetry } from './db/connection.ts';
export type { RetryOptions } from './db/connection.ts';

export type PageState = 'open' | 'submitted' | 'received';

export type PageFormat = 'a2ui' | 'html';

export type Page = {
  id: string;
  spec: unknown;
  format: PageFormat;
  state: PageState;
  result: unknown;
  createdAt: number;
  expiresAt: number;
  /**
   * Authenticated user that created this page. Optional / nullable to keep
   * unauthenticated grace-period creation working — when REQUIRE_AUTH=true
   * the POST /new middleware enforces a non-null user. `ON DELETE SET NULL`
   * keeps pages live when the owning user is deleted.
   */
  ownerId?: string | null;
};

type PageRow = {
  id: string;
  spec: unknown;
  format: PageFormat;
  state: PageState;
  result: unknown;
  created_at: Date;
  expires_at: Date;
};

export async function getActivePage(id: string): Promise<Page | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<PageRow[]>`
      select id, spec, format, state, result, created_at, expires_at
      from pages
      where id = ${id} and expires_at > now()
    `;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      spec: r.spec,
      format: r.format,
      state: r.state,
      result: r.result,
      createdAt: r.created_at.getTime(),
      expiresAt: r.expires_at.getTime(),
    };
  });
}

export type SubmitOutcome =
  | { kind: 'ok'; createdAt: Date }
  | { kind: 'conflict' }
  | { kind: 'not_found' };

/**
 * Atomic open→submitted transition. Returns the row's `created_at` on success
 * so the caller can record submit-latency without a follow-up query.
 *
 * 'not_found' covers both "no such page id" and "page expired" — the caller
 * doesn't need to distinguish, and the disambiguation SELECT explicitly
 * excludes expired rows so a stale-but-not-yet-swept row reads correctly.
 *
 * NOT wrapped in withRetry: if attempt 1 commits but its response is lost on
 * the network, attempt 2 finds state='submitted' and (incorrectly) reports
 * 'conflict' — caller would conclude someone else submitted. Better to
 * surface the network error to the caller, who can decide.
 */
export async function submitPage(id: string, action: unknown): Promise<SubmitOutcome> {
  const c = client();
  const rows = await c<{ created_at: Date }[]>`
    update pages
    set state = 'submitted',
        result = ${c.json(action as Parameters<typeof c.json>[0])},
        submitted_at = now()
    where id = ${id} and state = 'open' and expires_at > now()
    returning created_at
  `;
  if (rows.length > 0) return { kind: 'ok', createdAt: rows[0]!.created_at };
  // Disambiguate: does the page exist and is it still valid (conflict) or not (not_found)?
  // Filter on expires_at > now() so an expired-but-not-yet-swept row is
  // correctly classified as 'not_found' rather than 'conflict'.
  const exists = await c<{ id: string }[]>`
    select id from pages where id = ${id} and expires_at > now()
  `;
  return exists.length > 0 ? { kind: 'conflict' } : { kind: 'not_found' };
}

/**
 * Read the result and atomically flip submitted→received on the first read.
 *
 * NOT wrapped in withRetry: if attempt 1's UPDATE commits but the response
 * drops, attempt 2 sees state='received' and the caller (the agent) treats
 * the result as "already handled" — they'd discard it. Better to surface
 * the error to the agent's polling loop, which retries at the HTTP level.
 */
export async function fetchAndAdvanceResult(
  id: string,
): Promise<{ stateAtRead: PageState; result: unknown; format: PageFormat } | null> {
  const c = client();
  const rows = await c<{ state: PageState; result: unknown; format: PageFormat }[]>`
    select state, result, format from pages where id = ${id} and expires_at > now()
  `;
  if (rows.length === 0) return null;
  const { state, result, format } = rows[0];
  const stateAtRead = state;
  if (state === 'submitted') {
    await c`
      update pages
      set state = 'received', received_at = now()
      where id = ${id} and state = 'submitted'
    `;
  }
  return { stateAtRead, result, format };
}

export async function insertPage(p: Page): Promise<void> {
  await withRetry(async () => {
    const c = client();
    // owner_id is nullable — postgres-js binds `null` as SQL NULL, which is
    // what the grace-period path (unauthenticated POST /new) requires. When
    // REQUIRE_AUTH=true the route middleware guarantees ownerId is set.
    await c`insert into pages (id, spec, format, state, expires_at, owner_id)
            values (
              ${p.id},
              ${c.json(p.spec as Parameters<typeof c.json>[0])},
              ${p.format},
              'open',
              to_timestamp(${p.expiresAt} / 1000.0),
              ${p.ownerId ?? null}
            )`;
  });
}

export async function deletePage(id: string): Promise<void> {
  await withRetry(async () => {
    const c = client();
    await c`delete from pages where id = ${id}`;
  });
}

/**
 * Deletes expired rows and reports how many were "abandoned" — i.e. still in
 * state='open' when TTL killed them. Pages that already reached
 * 'submitted' or 'received' before expiry don't count as abandoned; they're
 * just garbage collection.
 */
export async function deleteExpiredPages(): Promise<{ total: number; abandoned: number }> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<{ state: PageState }[]>`
      delete from pages where expires_at <= now() returning state
    `;
    const abandoned = rows.filter((r) => r.state === 'open').length;
    return { total: rows.length, abandoned };
  });
}

// ---------------------------------------------------------------------------
// OAuth clients (RFC 7591 dynamic registration)
// ---------------------------------------------------------------------------
// Backs apps/api/auth/clients-store.ts. The store module owns validation and
// mapping to/from the MCP SDK's OAuthClientInformationFull shape; this layer
// owns SQL — same split as insertPage / store.createPage. See spec §2.3 for
// the column layout.

export type OAuthClientRow = {
  client_id: string;
  client_secret: string | null;
  client_secret_expires_at: Date | null;
  client_id_issued_at: Date;
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string | null;
  token_endpoint_auth_method: string;
};

/**
 * Columns provided to INSERT. `created_at` and `client_id_issued_at` have DB
 * defaults so we omit them; the row returned by `returning *` carries the
 * server-assigned timestamps back. Nullable optional metadata uses `null`
 * (not undefined) so postgres-js binds it as SQL NULL rather than the
 * literal 'undefined' string.
 */
export type OAuthClientInsert = {
  client_id: string;
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string | null;
  token_endpoint_auth_method: string;
};

/**
 * Insert a new OAuth client. Returns the inserted row with server-defaulted
 * timestamps so the caller can derive `client_id_issued_at` in Unix seconds.
 * Wrapped in withRetry — registration is idempotent at the application layer
 * (UUID PK collisions are vanishingly unlikely) so retrying a transient DB
 * error is safe.
 */
export async function insertOAuthClient(input: OAuthClientInsert): Promise<OAuthClientRow> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<OAuthClientRow[]>`
      insert into oauth_clients (
        client_id,
        client_name,
        client_uri,
        logo_uri,
        redirect_uris,
        grant_types,
        response_types,
        scope,
        token_endpoint_auth_method
      ) values (
        ${input.client_id},
        ${input.client_name},
        ${input.client_uri},
        ${input.logo_uri},
        ${input.redirect_uris},
        ${input.grant_types},
        ${input.response_types},
        ${input.scope},
        ${input.token_endpoint_auth_method}
      )
      returning
        client_id, client_secret, client_secret_expires_at, client_id_issued_at,
        client_name, client_uri, logo_uri, redirect_uris, grant_types,
        response_types, scope, token_endpoint_auth_method
    `;
    return rows[0]!;
  });
}

/**
 * Look up a registered OAuth client by `client_id`. Returns null if no row
 * exists. The clients-store wraps this to surface `undefined` per the MCP
 * SDK's `OAuthRegisteredClientsStore` contract.
 */
export async function getOAuthClientById(clientId: string): Promise<OAuthClientRow | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<OAuthClientRow[]>`
      select
        client_id, client_secret, client_secret_expires_at, client_id_issued_at,
        client_name, client_uri, logo_uri, redirect_uris, grant_types,
        response_types, scope, token_endpoint_auth_method
      from oauth_clients
      where client_id = ${clientId}
    `;
    return rows[0] ?? null;
  });
}

// ---------------------------------------------------------------------------
// Users (Google + Magic Link upsert)
// ---------------------------------------------------------------------------
// Backs the Google OAuth callback's user upsert. `handle` is assigned by the
// callback after collision-checking via getUserByHandle. Email is the natural
// key — Google guarantees uniqueness within their tenant, and the
// `users_email_idx` unique index defends against case-variant duplicates.
// See spec §2 (Schema) and §3.7 (Google callback flow).

export type UserRow = {
  id: string;
  handle: string | null;
  email: string;
  name: string | null;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
};

export type UserUpsertInput = {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  handle: string;
};

/**
 * Insert-or-update a user by email. On first sight, the row is created with
 * the supplied handle. On subsequent logins, name/avatar_url/updated_at are
 * refreshed but `handle` is preserved (it's the user-visible identifier and
 * shouldn't churn just because Google reissued a different display name).
 *
 * Returns the canonical row — caller can rely on `id` being the durable user
 * UUID regardless of whether the row is brand new.
 */
export async function upsertUser(input: UserUpsertInput): Promise<UserRow> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<UserRow[]>`
      insert into users (email, name, avatar_url, handle)
      values (${input.email}, ${input.name}, ${input.avatarUrl}, ${input.handle})
      on conflict (email) do update set
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        updated_at = now()
      returning id, handle, email, name, avatar_url, created_at, updated_at
    `;
    return rows[0]!;
  });
}

/**
 * Lookup a user by handle. Used during handle generation to detect collisions
 * before we attempt the upsert. Case-insensitive via the lower(handle) unique
 * index, so we match the same comparison the DB constraint enforces.
 */
export async function getUserByHandle(handle: string): Promise<UserRow | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<UserRow[]>`
      select id, handle, email, name, avatar_url, created_at, updated_at
      from users
      where lower(handle) = lower(${handle})
    `;
    return rows[0] ?? null;
  });
}

/**
 * Lookup a user by primary key. Used by the token endpoint to populate JWT
 * claims (email/handle) when exchanging an auth code or refresh token. Cascade
 * delete keeps auth_codes / refresh_tokens in sync with users, so a missing
 * row here means the user was deleted between issuing and exchanging — which
 * the caller surfaces as `invalid_grant`.
 */
export async function getUserById(id: string): Promise<UserRow | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<UserRow[]>`
      select id, handle, email, name, avatar_url, created_at, updated_at
      from users
      where id = ${id}
    `;
    return rows[0] ?? null;
  });
}

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
  const rows = await c<RefreshTokenRow[]>`
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
  await c`
    update refresh_tokens
    set revoked_at = now()
    where user_id = ${userId}
      and client_id = ${clientId}
      and revoked_at is null
  `;
}

// ---------------------------------------------------------------------------
// Magic Links (passwordless email tokens, 15-minute TTL)
// ---------------------------------------------------------------------------
// `token_hash` is SHA-256(raw token) — the raw token is only ever seen by the
// user (in the email) and by the verify handler (in the query string). The
// authorize_context column carries the OAuth round-trip parameters keyed on
// the link so we can resume the flow without inflating the email URL.

/**
 * Authorize-request context stored alongside a magic link so the verify
 * handler can resume the OAuth flow. Mirrors `StateClaims` from state-jwt.ts
 * but without the JWT envelope — we already have a per-token row, so signing
 * would just add overhead.
 *
 * Every field is optional because a future "log in without an OAuth client"
 * path (e.g. browser session) doesn't need the PKCE bits.
 */
export type MagicLinkAuthorizeContext = {
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
  state?: string;
  browserSession?: boolean;
};

export type MagicLinkInsert = {
  email: string;
  tokenHash: string;
  authorizeContext: MagicLinkAuthorizeContext;
  expiresAt: Date;
};

/**
 * Insert a fresh magic link row. The raw token is never stored — only the
 * SHA-256 hash from the caller. Not wrapped in withRetry: a retry after a
 * successful insert would surface a unique-violation on token_hash and
 * confuse the caller (the token is already valid).
 */
export async function insertMagicLink(input: MagicLinkInsert): Promise<void> {
  const c = client();
  await c`
    insert into magic_links (email, token_hash, authorize_context, expires_at)
    values (
      ${input.email},
      ${input.tokenHash},
      ${c.json(input.authorizeContext as Parameters<typeof c.json>[0])},
      ${input.expiresAt}
    )
  `;
}

/**
 * Atomically consume a magic link: marks `consumed_at = now()` and returns
 * the email + stored authorize context, but only if the row exists, hasn't
 * expired, and hasn't already been consumed. Concurrent verifies race on the
 * UPDATE WHERE clause — at most one succeeds.
 *
 * Returns null when the token is unknown / expired / already used. The
 * caller surfaces that as a generic "expired or invalid" error — we don't
 * distinguish to avoid leaking whether the token existed at all.
 */
export async function verifyAndConsumeMagicLink(
  tokenHash: string,
): Promise<{ email: string; authorizeContext: MagicLinkAuthorizeContext } | null> {
  const c = client();
  const rows = await c<{ email: string; authorize_context: MagicLinkAuthorizeContext | null }[]>`
    update magic_links
    set consumed_at = now()
    where token_hash = ${tokenHash}
      and expires_at > now()
      and consumed_at is null
    returning email, authorize_context
  `;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    email: r.email,
    // authorize_context is JSONB; postgres-js returns parsed objects already.
    // Treat NULL as an empty context — a legacy row missing the column would
    // still be consumable (e.g. browser-session flow with no PKCE bits).
    authorizeContext: r.authorize_context ?? {},
  };
}

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
