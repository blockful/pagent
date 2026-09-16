import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initialDeckSchemaMigration } from './migrations/0001-initial-deck-schema.ts';
import {
  DeckMigrationHistoryError,
  runDeckMigrations,
  type DeckMigration,
} from './schema-migrations.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_deck_schema_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('deck database schema', () => {
  const sql = postgres(databaseUrl ?? '', { ssl: false, prepare: false });

  beforeAll(async () => {
    // Given
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await sql`
      create table users (
        id uuid primary key default gen_random_uuid(),
        email text unique not null,
        handle text
      )
    `;

    // When
    await initDeckSchema(sql);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('creates every durable deck, sharing, analytics, permission, and audit table', async () => {
    // Given
    const expected = [
      'access_requests',
      'audit_log',
      'deck_analytics_subjects',
      'deck_revisions',
      'deck_slides',
      'decks',
      'engagement_events',
      'deck_schema_migrations',
      'share_link_audience',
      'share_links',
      'slide_engagement',
      'team_members',
      'teams',
      'viewer_sessions',
      'visits',
      'workspace_members',
      'workspaces',
    ];

    // When
    const rows = await sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;

    // Then
    expect(rows.map((row) => row.table_name)).toEqual(expect.arrayContaining(expected));
  });

  it('records the applied deck schema version', async () => {
    const expectedMigration = { version: 1, name: 'initial_deck_schema' };

    const rows = await sql<{ version: number; name: string }[]>`
      select version, name from deck_schema_migrations order by version
    `;

    expect(rows).toEqual([expectedMigration]);
  });

  it('preserves existing deck data when baselining a pre-ledger deployment', async () => {
    const owner = await sql<{ id: string }[]>`
      insert into users (email) values ('legacy-owner@pagent.test') returning id
    `;
    const ownerId = owner[0]?.id;
    expect(ownerId).toBeDefined();
    if (ownerId === undefined) return;
    const workspace = await sql<{ id: string }[]>`
      insert into workspaces (name) values ('Legacy workspace') returning id
    `;
    const workspaceId = workspace[0]?.id;
    expect(workspaceId).toBeDefined();
    if (workspaceId === undefined) return;
    await sql`
      insert into decks (workspace_id, owner_id, title)
      values (${workspaceId}, ${ownerId}, 'Legacy deck')
    `;
    await sql`drop table deck_schema_migrations`;

    await initDeckSchema(sql);

    const rows = await sql<{ title: string }[]>`
      select title from decks where title = 'Legacy deck'
    `;
    expect(rows).toEqual([{ title: 'Legacy deck' }]);
  });

  it('serializes concurrent startup into one applied migration', async () => {
    await sql`drop table deck_schema_migrations`;

    await Promise.all([initDeckSchema(sql), initDeckSchema(sql)]);

    const rows = await sql<{ count: number }[]>`
      select count(*)::integer as count from deck_schema_migrations
    `;
    expect(rows).toEqual([{ count: 1 }]);
  });

  it('rolls back schema and ledger changes when a migration fails', async () => {
    class PlannedMigrationError extends Error {}
    const failingMigration = {
      version: 2,
      name: 'planned_failure',
      async up(database) {
        await database`create table migration_should_roll_back (id integer primary key)`;
        throw new PlannedMigrationError('planned migration failure');
      },
    } satisfies DeckMigration;

    const migration = runDeckMigrations(sql, [initialDeckSchemaMigration, failingMigration]);

    await expect(migration).rejects.toBeInstanceOf(PlannedMigrationError);
    const rows = await sql<{ table_name: string | null }[]>`
      select to_regclass('public.migration_should_roll_back')::text as table_name
    `;
    expect(rows).toEqual([{ table_name: null }]);
    const ledger = await sql<{ version: number }[]>`
      select version from deck_schema_migrations order by version
    `;
    expect(ledger).toEqual([{ version: 1 }]);
  });

  it('rejects divergent applied migration history', async () => {
    await sql`update deck_schema_migrations set name = 'tampered_history' where version = 1`;

    const migration = initDeckSchema(sql);

    await expect(migration).rejects.toBeInstanceOf(DeckMigrationHistoryError);
    await sql`update deck_schema_migrations set name = 'initial_deck_schema' where version = 1`;
  });

  it('rejects raw bearer tokens from the share-link persistence shape', async () => {
    // Given
    const rows = await sql<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name in ('share_links', 'viewer_sessions')
    `;

    // When
    const columns = rows.map((row) => row.column_name);

    // Then
    expect(columns).toContain('token_hash');
    expect(columns).not.toContain('token');
    expect(columns).not.toContain('raw_token');
  });

  it('enforces the three clarified access modes at the database boundary', async () => {
    // Given
    const owner = await sql<{ id: string }[]>`
      insert into users (email) values ('owner@pagent.test') returning id
    `;
    const ownerId = owner[0]?.id;
    expect(ownerId).toBeDefined();
    if (ownerId === undefined) return;
    const workspace = await sql<{ id: string }[]>`
      insert into workspaces (name) values ('Pagent test') returning id
    `;
    const workspaceId = workspace[0]?.id;
    expect(workspaceId).toBeDefined();
    if (workspaceId === undefined) return;
    const deck = await sql<{ id: string }[]>`
      insert into decks (workspace_id, owner_id, title)
      values (${workspaceId}, ${ownerId}, 'Mode test')
      returning id
    `;
    const deckId = deck[0]?.id;
    expect(deckId).toBeDefined();
    if (deckId === undefined) return;

    // When
    const insertInvalid = sql`
      insert into share_links (deck_id, creator_id, name, token_hash, access_mode)
      values (${deckId}, ${ownerId}, 'invalid', 'invalid-hash', 'password')
    `;

    // Then
    await expect(insertInvalid).rejects.toMatchObject({ code: '23514' });
  });
});
