import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../db.ts';
import { publishDeckBodySchema } from './domain.ts';
import {
  DeckForbiddenError,
  deleteDeck,
  getDeckPreview,
  listDecks,
  publishDeck,
  setDeckStatus,
  updateDeckTitle,
} from './repository-decks.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_deck_repository_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('deck repository', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let ownerId = '';
  let colleagueId = '';
  let deckId = '';

  beforeAll(async () => {
    // Given
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    const owner = await db.upsertUser({
      email: 'owner@pagent.test',
      handle: 'owner',
      name: 'Owner',
      avatarUrl: null,
    });
    const colleague = await db.upsertUser({
      email: 'colleague@pagent.test',
      handle: 'colleague',
      name: 'Colleague',
      avatarUrl: null,
    });
    ownerId = owner.id;
    colleagueId = colleague.id;

    // When
    const published = await publishDeck(
      { id: ownerId, email: owner.email },
      {
        title: 'Northstar renewal',
        description: 'Infrastructure renewal',
        client_label: 'Northstar',
        slides: [
          { id: 'cover', title: 'Northstar', html: '<h1>Northstar</h1><script>bad()</script>' },
          { id: 'plan', title: 'Plan', html: '<h2>Plan</h2>' },
        ],
      },
    );
    deckId = published.deckId;
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('publishes a durable revision with sanitized ordered slides', async () => {
    // When
    const preview = await getDeckPreview(ownerId, deckId);

    // Then
    expect(preview.revisionNumber).toBe(1);
    expect(preview.slides.map((slide) => slide.stableSlideId)).toEqual(['cover', 'plan']);
    expect(preview.slides[0]?.html).not.toContain('<script>');
  });

  it('creates an immutable next revision without rewriting the first revision', async () => {
    // Given
    const before = await getDeckPreview(ownerId, deckId);

    // When
    const published = await publishDeck(
      { id: ownerId, email: 'owner@pagent.test' },
      publishDeckBodySchema.parse({
        title: 'Northstar renewal',
        update_deck_id: deckId,
        slides: [
          { id: 'cover', html: '<h1>Updated Northstar</h1>' },
          { id: 'plan', html: '<h2>Updated plan</h2>' },
          { id: 'terms', html: '<h2>Terms</h2>' },
        ],
      }),
    );
    const after = await getDeckPreview(ownerId, deckId);

    // Then
    expect(published.revisionNumber).toBe(2);
    expect(after.revisionNumber).toBe(2);
    expect(before.revisionId).not.toBe(after.revisionId);
    expect(after.slides).toHaveLength(3);
  });

  it('lists and searches owned decks by title or client label', async () => {
    // When
    const byTitle = await listDecks(ownerId, { q: 'renewal', scope: 'mine' });
    const byClient = await listDecks(ownerId, { q: 'northstar', scope: 'mine' });

    // Then
    expect(byTitle).toHaveLength(1);
    expect(byClient).toHaveLength(1);
    expect(byTitle[0]?.ownerId).toBe(ownerId);
  });

  it('renames, archives, and restores a deck without changing its revision', async () => {
    // Given
    const revision = (await getDeckPreview(ownerId, deckId)).revisionId;

    // When
    await updateDeckTitle(ownerId, deckId, 'Northstar 2027 renewal');
    await setDeckStatus(ownerId, deckId, 'archived');
    const archived = await listDecks(ownerId, { scope: 'mine', status: 'archived' });
    await setDeckStatus(ownerId, deckId, 'active');

    // Then
    expect(archived[0]?.title).toBe('Northstar 2027 renewal');
    expect((await getDeckPreview(ownerId, deckId)).revisionId).toBe(revision);
  });

  it('denies an ungranted workspace user at the repository boundary', async () => {
    // When
    const preview = getDeckPreview(colleagueId, deckId);

    // Then
    await expect(preview).rejects.toBeInstanceOf(DeckForbiddenError);
  });

  it('soft-deletes the deck so future owner preview access is removed', async () => {
    // When
    await deleteDeck(ownerId, deckId);

    // Then
    await expect(getDeckPreview(ownerId, deckId)).rejects.toBeInstanceOf(DeckForbiddenError);
  });
});
