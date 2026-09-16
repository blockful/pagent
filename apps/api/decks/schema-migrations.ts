import { z } from 'zod';
import type { Database, DatabasePool } from './schema.ts';

export type DeckMigration = {
  readonly version: number;
  readonly name: string;
  readonly up: (database: Database) => Promise<void>;
};

const appliedMigrationSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().min(1),
  })
  .strict();

const appliedMigrationsSchema = z.array(appliedMigrationSchema);

type MigrationHistoryMismatch = {
  readonly position: number;
  readonly expected: DeckMigration | undefined;
  readonly applied: z.infer<typeof appliedMigrationSchema>;
};

export class DeckMigrationHistoryError extends Error {
  readonly mismatch: MigrationHistoryMismatch;

  constructor(mismatch: MigrationHistoryMismatch) {
    super(`Deck schema migration history diverged at position ${mismatch.position}`);
    this.name = 'DeckMigrationHistoryError';
    this.mismatch = mismatch;
  }
}

export async function runDeckMigrations(
  database: DatabasePool,
  migrations: readonly DeckMigration[],
): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction`
      select pg_advisory_xact_lock(hashtextextended('pagent:deck-schema-migrations', 0))
    `;
    await transaction`
      create table if not exists deck_schema_migrations (
        version integer primary key check (version > 0),
        name text not null unique,
        applied_at timestamptz not null default now()
      )
    `;

    const applied = appliedMigrationsSchema.parse(
      await transaction`select version, name from deck_schema_migrations order by version`,
    );

    for (const [position, appliedMigration] of applied.entries()) {
      const expectedMigration = migrations.at(position);
      if (
        expectedMigration === undefined ||
        expectedMigration.version !== appliedMigration.version ||
        expectedMigration.name !== appliedMigration.name
      ) {
        throw new DeckMigrationHistoryError({
          position,
          expected: expectedMigration,
          applied: appliedMigration,
        });
      }
    }

    for (const migration of migrations.slice(applied.length)) {
      await migration.up(transaction);
      await transaction`
        insert into deck_schema_migrations (version, name)
        values (${migration.version}, ${migration.name})
      `;
    }
  });
}
