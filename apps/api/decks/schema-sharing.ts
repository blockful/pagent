import type { Database } from './schema.ts';

export async function initSharingSchema(database: Database): Promise<void> {
  await database`
    create table if not exists share_links (
      id uuid primary key default gen_random_uuid(),
      deck_id uuid not null references decks(id) on delete cascade,
      creator_id uuid not null references users(id) on delete restrict,
      name text not null,
      token_hash text not null unique,
      access_mode text not null check (access_mode in ('anyone', 'allowed_email', 'authenticated')),
      expires_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await database`
    create table if not exists share_link_audience (
      id uuid primary key default gen_random_uuid(),
      share_link_id uuid not null references share_links(id) on delete cascade,
      audience_type text not null check (audience_type in ('email', 'domain')),
      audience_value text not null,
      created_at timestamptz not null default now(),
      unique (share_link_id, audience_type, audience_value)
    )
  `;
  await database`
    create table if not exists access_requests (
      id uuid primary key default gen_random_uuid(),
      share_link_id uuid not null references share_links(id) on delete cascade,
      requested_email text not null,
      status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
      decided_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      decided_at timestamptz,
      unique (share_link_id, requested_email)
    )
  `;
  await database`
    create table if not exists viewer_sessions (
      id uuid primary key default gen_random_uuid(),
      share_link_id uuid not null references share_links(id) on delete cascade,
      token_hash text not null unique,
      viewer_user_id uuid references users(id) on delete set null,
      viewer_email text,
      identity_confidence text not null
        check (identity_confidence in ('anonymous', 'unverified', 'authenticated')),
      preview boolean not null default false,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz
    )
  `;
  await database`
    create table if not exists audit_log (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid references workspaces(id) on delete set null,
      deck_id uuid references decks(id) on delete set null,
      share_link_id uuid references share_links(id) on delete set null,
      actor_user_id uuid references users(id) on delete set null,
      actor_viewer_session_id uuid references viewer_sessions(id) on delete set null,
      action text not null,
      details jsonb not null default '{}',
      created_at timestamptz not null default now()
    )
  `;
  await database`create index if not exists share_links_deck_id_idx on share_links (deck_id)`;
  await database`create index if not exists share_links_creator_id_idx on share_links (creator_id)`;
  await database`
    create index if not exists viewer_sessions_share_link_id_idx
      on viewer_sessions (share_link_id)
  `;
  await database`
    create index if not exists access_requests_share_link_id_idx
      on access_requests (share_link_id, status)
  `;
  await database`create index if not exists audit_log_deck_id_idx on audit_log (deck_id, created_at)`;
}
