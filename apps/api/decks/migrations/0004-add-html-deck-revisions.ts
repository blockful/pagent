import type { DeckMigration } from '../schema-migrations.ts';

export const htmlDeckRevisionsMigration = {
  version: 4,
  name: 'add_html_deck_revisions',
  async up(database) {
    await database`alter table deck_revisions add column if not exists html text`;
  },
} satisfies DeckMigration;
