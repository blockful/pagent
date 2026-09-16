import type postgres from 'postgres';
import { initAnalyticsSchema } from './schema-analytics.ts';
import { initDeckFoundationSchema } from './schema-foundation.ts';
import { initSharingSchema } from './schema-sharing.ts';

export type Database = ReturnType<typeof postgres>;

export async function initDeckSchema(database: Database): Promise<void> {
  await initDeckFoundationSchema(database);
  await initSharingSchema(database);
  await initAnalyticsSchema(database);
}
