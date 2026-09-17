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

let sql: ReturnType<typeof postgres> | null = null;

export class DatabaseTlsPolicyError extends Error {
  readonly code = 'DATABASE_TLS_POLICY' as const;

  constructor() {
    super('DATABASE_URL with sslmode=disable is not allowed in production');
    this.name = 'DatabaseTlsPolicyError';
  }
}

export function databaseSsl(
  connectionString: string,
  runtime = process.env.NODE_ENV,
): false | 'verify-full' {
  const sslmodes = new URL(connectionString).searchParams
    .getAll('sslmode')
    .map((mode) => mode.toLowerCase());
  const isDisabled = sslmodes.includes('disable');
  if (isDisabled && runtime === 'production') {
    throw new DatabaseTlsPolicyError();
  }
  return isDisabled ? false : 'verify-full';
}

export async function init(connectionString: string): Promise<void> {
  if (sql) return;
  const ssl = databaseSsl(connectionString);
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
      google_sub text,
      name       text,
      avatar_url text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await sql`alter table users add column if not exists google_sub text`;
  await sql`create unique index if not exists users_email_idx on users (lower(email))`;
  await sql`create unique index if not exists users_handle_idx on users (lower(handle))`;
  await sql`
    create unique index if not exists users_google_sub_idx
    on users (google_sub)
    where google_sub is not null
  `;

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
      refresh_token_family_id uuid       not null default gen_random_uuid(),
      created_at            timestamptz not null default now(),
      expires_at            timestamptz not null,
      consumed_at           timestamptz
    )
  `;
  await sql`
    alter table auth_codes
      add column if not exists refresh_token_family_id uuid
  `;
  await sql`
    alter table auth_codes
      alter column refresh_token_family_id set default gen_random_uuid()
  `;

  // Refresh tokens — opaque, rotated on each use. `token_hash` is
  // SHA-256(raw). On rotation the old row gets revoked_at = now() and a
  // new row is inserted; presenting a revoked token revokes only that grant's
  // family, not every grant previously issued to the same client.
  await sql`
    create table if not exists refresh_tokens (
      id         uuid        primary key default gen_random_uuid(),
      user_id    uuid        not null references users(id) on delete cascade,
      client_id  text        not null references oauth_clients(client_id) on delete cascade,
      family_id  uuid        not null default gen_random_uuid(),
      token_hash text        not null unique,
      scope      text,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz
    )
  `;
  await sql`
    alter table refresh_tokens
      add column if not exists family_id uuid
  `;
  await sql`
    alter table refresh_tokens
      alter column family_id set default gen_random_uuid()
  `;
  await sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(
        hashtextextended('pagent:refresh-family-migration', 0)
      )
    `;
    await tx`
      update auth_codes
      set refresh_token_family_id = gen_random_uuid(),
          consumed_at = coalesce(consumed_at, now())
      where refresh_token_family_id is null
    `;
    await tx`
      update refresh_tokens
      set family_id = id,
          revoked_at = coalesce(revoked_at, now())
      where family_id is null
    `;
    await tx`
      alter table auth_codes
        alter column refresh_token_family_id set not null
    `;
    await tx`
      alter table refresh_tokens
        alter column family_id set not null
    `;
  });
  await sql`create index if not exists auth_codes_expires_at_idx on auth_codes (expires_at)`;
  await sql`create index if not exists refresh_tokens_user_id_idx on refresh_tokens (user_id)`;
  await sql`create index if not exists refresh_tokens_family_id_idx on refresh_tokens (family_id)`;
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
  // Carry the OAuth authorize context (client_id, redirect_uri, code_challenge,
  // scope, state) keyed on the magic link token so the email link itself can
  // stay short (just the raw token). Without this, we'd have to encode every
  // PKCE parameter in the URL — leaks them into email logs and inflates the
  // link length. Stored as JSONB so we can extend the shape (e.g. for browser
  // session flag, future fields) without a migration. Idempotent — safe on
  // pre-existing deployments that already have the base table.
  await sql`
    alter table magic_links
      add column if not exists authorize_context jsonb
  `;

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

export function client(): ReturnType<typeof postgres> {
  if (!sql) throw new Error('db not initialized');
  return sql;
}
