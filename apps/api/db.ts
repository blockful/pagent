import postgres from 'postgres';

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
};

/** Retry a transient async operation with exponential backoff + ±25% jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 100;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delay = baseDelay * 2 ** i * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

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
};

let sql: ReturnType<typeof postgres> | null = null;

export async function init(connectionString: string): Promise<void> {
  if (sql) return;
  const sslMode = new URL(connectionString).searchParams.get('sslmode');
  const ssl = sslMode === 'disable' ? false : 'require';
  sql = postgres(connectionString, { ssl, prepare: false });
  await sql`
    create table if not exists pages (
      id           text primary key,
      spec         jsonb       not null,
      format       text        not null default 'a2ui' check (format in ('a2ui','html')),
      state        text        not null check (state in ('open','submitted','received')),
      result       jsonb,
      created_at   timestamptz not null default now(),
      expires_at   timestamptz not null,
      submitted_at timestamptz,
      received_at  timestamptz
    )
  `;
  // Pick up the column on pre-existing deployments. Idempotent — safe to run
  // on every boot. Backfill is implicit via the default.
  await sql`
    alter table pages
      add column if not exists format text
        not null default 'a2ui'
        check (format in ('a2ui','html'))
  `;
  await sql`create index if not exists pages_expires_at_idx on pages (expires_at)`;

  // --- Auth tables ---------------------------------------------------------
  // Bootstrap follows the same idempotent pattern as `pages`: every CREATE
  // / ALTER / INDEX is `IF NOT EXISTS` so a second boot is a no-op. See
  // docs/superpowers/specs/2026-05-17-auth-design.md §2.
  //
  // Users — `handle` is nullable (assigned during onboarding, not creation).
  // Unique indexes are on `lower(email)` / `lower(handle)` so case-variant
  // collisions are rejected at insert time, not at lookup time.
  await sql`
    create table if not exists users (
      id         uuid        primary key default gen_random_uuid(),
      handle     text        unique,
      email      text        unique not null,
      name       text,
      avatar_url text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await sql`create unique index if not exists users_email_idx on users (lower(email))`;
  await sql`create unique index if not exists users_handle_idx on users (lower(handle))`;

  // Sessions — browser cookies. `token_hash` is SHA-256(cookie); raw token
  // never stored. Sliding window — `expires_at` is extended on every
  // authenticated request.
  await sql`
    create table if not exists sessions (
      id         uuid        primary key default gen_random_uuid(),
      user_id    uuid        not null references users(id) on delete cascade,
      token_hash text        not null,
      ip_address text,
      user_agent text,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `;
  await sql`create index if not exists sessions_user_id_idx on sessions (user_id)`;
  await sql`create index if not exists sessions_expires_at_idx on sessions (expires_at)`;
  // Every authenticated request looks up by token_hash; without this index
  // each request does a sequential scan. UNIQUE also defends against
  // hash-collision inserts at the storage layer.
  await sql`create unique index if not exists sessions_token_hash_idx on sessions (token_hash)`;

  // OAuth clients — RFC 7591 dynamic registration. MCP clients are public
  // (`token_endpoint_auth_method = 'none'`), so `client_secret` is null.
  await sql`
    create table if not exists oauth_clients (
      client_id                  text        primary key,
      client_secret              text,
      client_secret_expires_at   timestamptz,
      client_id_issued_at        timestamptz not null default now(),
      client_name                text,
      client_uri                 text,
      logo_uri                   text,
      redirect_uris              text[]      not null,
      grant_types                text[]      not null default '{authorization_code,refresh_token}',
      response_types             text[]      not null default '{code}',
      scope                      text,
      token_endpoint_auth_method text        not null default 'none',
      created_at                 timestamptz not null default now()
    )
  `;

  // Auth codes — PKCE authorization codes (10-minute TTL). `consumed_at` is
  // set on first use; second use is rejected and revokes the token family.
  await sql`
    create table if not exists auth_codes (
      code                  text        primary key,
      user_id               uuid        not null references users(id) on delete cascade,
      client_id             text        not null references oauth_clients(client_id) on delete cascade,
      redirect_uri          text        not null,
      code_challenge        text        not null,
      code_challenge_method text        not null default 'S256',
      scope                 text,
      resource              text,
      created_at            timestamptz not null default now(),
      expires_at            timestamptz not null,
      consumed_at           timestamptz
    )
  `;
  await sql`create index if not exists auth_codes_expires_at_idx on auth_codes (expires_at)`;

  // Refresh tokens — opaque, rotated on each use. `token_hash` is
  // SHA-256(raw). On rotation the old row gets revoked_at = now() and a
  // new row is inserted; presenting a revoked token revokes the whole family.
  await sql`
    create table if not exists refresh_tokens (
      id         uuid        primary key default gen_random_uuid(),
      user_id    uuid        not null references users(id) on delete cascade,
      client_id  text        not null references oauth_clients(client_id) on delete cascade,
      token_hash text        not null unique,
      scope      text,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz
    )
  `;
  await sql`create index if not exists refresh_tokens_user_id_idx on refresh_tokens (user_id)`;
  await sql`create index if not exists refresh_tokens_expires_at_idx on refresh_tokens (expires_at)`;

  // Magic links — passwordless email tokens (15-minute TTL).
  await sql`
    create table if not exists magic_links (
      id          uuid        primary key default gen_random_uuid(),
      email       text        not null,
      token_hash  text        not null unique,
      created_at  timestamptz not null default now(),
      expires_at  timestamptz not null,
      consumed_at timestamptz
    )
  `;
  await sql`create index if not exists magic_links_expires_at_idx on magic_links (expires_at)`;

  // Pages owner — nullable FK so unauthenticated page creation during the
  // grace period still works. When REQUIRE_AUTH=true, the POST /new
  // middleware enforces a non-null owner. ON DELETE SET NULL preserves
  // pages when an owning user is deleted (avoids cascading loss of state).
  await sql`
    alter table pages
      add column if not exists owner_id uuid
        references users(id) on delete set null
  `;
  await sql`create index if not exists pages_owner_id_idx on pages (owner_id)`;
}

export async function ping(): Promise<void> {
  const c = client();
  await c`select 1`;
}

export async function shutdown(): Promise<void> {
  if (!sql) return;
  await sql.end({ timeout: 5 });
  sql = null;
}

function client(): ReturnType<typeof postgres> {
  if (!sql) throw new Error('db not initialized');
  return sql;
}

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
    await c`insert into pages (id, spec, format, state, expires_at)
            values (
              ${p.id},
              ${c.json(p.spec as Parameters<typeof c.json>[0])},
              ${p.format},
              'open',
              to_timestamp(${p.expiresAt} / 1000.0)
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
