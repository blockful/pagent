import type { DeckMigration } from '../schema-migrations.ts';

export const viewerSessionAnalyticsExclusionMigration = {
  version: 2,
  name: 'add_viewer_session_analytics_exclusion',
  async up(database) {
    await database`
      alter table viewer_sessions
        add column if not exists analytics_excluded boolean not null default false
    `;
  },
} satisfies DeckMigration;
