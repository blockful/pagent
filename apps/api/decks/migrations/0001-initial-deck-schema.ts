import { initAnalyticsSchema } from '../schema-analytics.ts';
import { initDeckFoundationSchema } from '../schema-foundation.ts';
import { initSharingSchema } from '../schema-sharing.ts';
import type { DeckMigration } from '../schema-migrations.ts';

export const initialDeckSchemaMigration = {
  version: 1,
  name: 'initial_deck_schema',
  async up(database) {
    await initDeckFoundationSchema(database);
    await initSharingSchema(database);
    await initAnalyticsSchema(database);
  },
} satisfies DeckMigration;
