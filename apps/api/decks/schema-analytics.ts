import type { Database } from './schema.ts';

export async function initAnalyticsSchema(database: Database): Promise<void> {
  await database`
    create table if not exists visits (
      id uuid primary key default gen_random_uuid(),
      share_link_id uuid not null references share_links(id) on delete cascade,
      revision_id uuid not null references deck_revisions(id) on delete restrict,
      viewer_session_id uuid not null references viewer_sessions(id) on delete restrict,
      identity_confidence text not null
        check (identity_confidence in ('anonymous', 'unverified', 'authenticated')),
      viewer_email text,
      device_class text not null check (device_class in ('mobile', 'tablet', 'desktop', 'unknown')),
      browser_family text not null,
      country_code text,
      analytics_consent boolean not null default true,
      excluded boolean not null default false,
      started_at timestamptz not null default now(),
      last_activity_at timestamptz not null default now(),
      ended_at timestamptz
    )
  `;
  await database`
    create table if not exists engagement_events (
      idempotency_key uuid primary key,
      visit_id uuid not null references visits(id) on delete cascade,
      event_type text not null check (event_type in ('start', 'heartbeat', 'slide_view', 'close')),
      slide_id uuid references deck_slides(id) on delete restrict,
      event_at timestamptz not null,
      server_received_at timestamptz not null default now(),
      sequence integer not null check (sequence >= 0),
      visible_ratio double precision not null default 0 check (visible_ratio between 0 and 1),
      tab_visible boolean not null default false,
      recently_active boolean not null default false,
      accepted_duration_ms integer not null default 0
        check (accepted_duration_ms between 0 and 10000)
    )
  `;
  await database`
    create table if not exists slide_engagement (
      visit_id uuid not null references visits(id) on delete cascade,
      slide_id uuid not null references deck_slides(id) on delete restrict,
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null,
      active_duration_ms bigint not null default 0 check (active_duration_ms >= 0),
      view_count integer not null default 0 check (view_count >= 0),
      first_sequence integer not null,
      last_sequence integer not null,
      qualified boolean not null default false,
      primary key (visit_id, slide_id)
    )
  `;
  await database`create index if not exists visits_share_link_id_idx on visits (share_link_id)`;
  await database`create index if not exists visits_revision_id_idx on visits (revision_id)`;
  await database`
    create index if not exists visits_viewer_session_id_idx on visits (viewer_session_id)
  `;
  await database`
    create index if not exists engagement_events_visit_id_idx on engagement_events (visit_id, sequence)
  `;
  await database`
    create index if not exists slide_engagement_slide_id_idx on slide_engagement (slide_id)
  `;
}
