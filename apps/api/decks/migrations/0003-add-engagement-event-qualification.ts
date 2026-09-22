import type { DeckMigration } from '../schema-migrations.ts';

export const engagementEventQualificationMigration = {
  version: 3,
  name: 'add_engagement_event_qualification',
  async up(database) {
    // Historical events omit visible duration, so their qualification cannot be backfilled.
    await database`alter table engagement_events add column if not exists qualified boolean`;
  },
} satisfies DeckMigration;
