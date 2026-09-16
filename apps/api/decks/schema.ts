import type postgres from 'postgres';
import { initialDeckSchemaMigration } from './migrations/0001-initial-deck-schema.ts';
import { runDeckMigrations, type DeckMigration } from './schema-migrations.ts';

export type Database = ReturnType<typeof postgres> | postgres.TransactionSql;
export type DatabasePool = ReturnType<typeof postgres>;

const deckMigrations: readonly DeckMigration[] = [initialDeckSchemaMigration];

export async function initDeckSchema(database: DatabasePool): Promise<void> {
  await runDeckMigrations(database, deckMigrations);
}
