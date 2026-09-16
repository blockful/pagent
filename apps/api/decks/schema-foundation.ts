import type { Database } from './schema.ts';

export async function initDeckFoundationSchema(database: Database): Promise<void> {
  await database`
    create table if not exists workspaces (
      id uuid primary key default gen_random_uuid(),
      personal_owner_id uuid unique references users(id) on delete cascade,
      name text not null,
      verified_domains text[] not null default '{}',
      analytics_consent_required boolean not null default false,
      analytics_retention_days integer not null default 365
        check (analytics_retention_days between 1 and 3650),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await database`
    create table if not exists workspace_members (
      workspace_id uuid not null references workspaces(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      role text not null default 'member' check (role in ('owner', 'admin', 'member')),
      status text not null default 'active' check (status in ('active', 'suspended', 'left')),
      created_at timestamptz not null default now(),
      primary key (workspace_id, user_id)
    )
  `;
  await database`
    create table if not exists teams (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid not null references workspaces(id) on delete cascade,
      name text not null,
      created_at timestamptz not null default now(),
      unique (workspace_id, name)
    )
  `;
  await database`
    create table if not exists team_members (
      team_id uuid not null references teams(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (team_id, user_id)
    )
  `;
  await database`
    create table if not exists decks (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid not null references workspaces(id) on delete cascade,
      owner_id uuid not null references users(id) on delete restrict,
      title text not null,
      description text,
      client_label text,
      status text not null default 'active' check (status in ('active', 'archived')),
      analytics_visibility text not null default 'private'
        check (analytics_visibility in ('private', 'selected', 'team', 'workspace')),
      latest_revision_number integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )
  `;
  await database`
    create table if not exists deck_revisions (
      id uuid primary key default gen_random_uuid(),
      deck_id uuid not null references decks(id) on delete cascade,
      revision_number integer not null check (revision_number > 0),
      created_by uuid not null references users(id) on delete restrict,
      created_at timestamptz not null default now(),
      unique (deck_id, revision_number)
    )
  `;
  await database`
    create table if not exists deck_slides (
      id uuid primary key default gen_random_uuid(),
      revision_id uuid not null references deck_revisions(id) on delete cascade,
      stable_slide_id text not null,
      ordinal integer not null check (ordinal > 0),
      title text,
      html text not null,
      unique (revision_id, stable_slide_id),
      unique (revision_id, ordinal)
    )
  `;
  await database`
    create table if not exists deck_analytics_subjects (
      deck_id uuid not null references decks(id) on delete cascade,
      subject_type text not null check (subject_type in ('user', 'team')),
      subject_id uuid not null,
      created_at timestamptz not null default now(),
      primary key (deck_id, subject_type, subject_id)
    )
  `;
  await database`
    create table if not exists deck_collaborators (
      deck_id uuid not null references decks(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      can_view_content boolean not null default true,
      created_at timestamptz not null default now(),
      primary key (deck_id, user_id)
    )
  `;
  await database`create index if not exists decks_owner_id_idx on decks (owner_id)`;
  await database`create index if not exists decks_workspace_id_idx on decks (workspace_id)`;
  await database`create index if not exists deck_revisions_deck_id_idx on deck_revisions (deck_id)`;
  await database`create index if not exists deck_slides_revision_id_idx on deck_slides (revision_id)`;
}
