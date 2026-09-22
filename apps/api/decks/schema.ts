import type postgres from 'postgres';
import { initialDeckSchemaMigration } from './migrations/0001-initial-deck-schema.ts';
import { viewerSessionAnalyticsExclusionMigration } from './migrations/0002-add-viewer-session-analytics-exclusion.ts';
import { engagementEventQualificationMigration } from './migrations/0003-add-engagement-event-qualification.ts';
import { htmlDeckRevisionsMigration } from './migrations/0004-add-html-deck-revisions.ts';
import { runDeckMigrations, type DeckMigration } from './schema-migrations.ts';

export type Database = ReturnType<typeof postgres> | postgres.TransactionSql;
export type DatabasePool = ReturnType<typeof postgres>;

const deckMigrations: readonly DeckMigration[] = [
  initialDeckSchemaMigration,
  viewerSessionAnalyticsExclusionMigration,
  engagementEventQualificationMigration,
  htmlDeckRevisionsMigration,
];

export async function initDeckSchema(database: DatabasePool): Promise<void> {
  await runDeckMigrations(database, deckMigrations);
}
