import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../db.ts';
import { deckIdSchema } from './domain.ts';
import { publishDeck } from './repository-decks.ts';
import { EngagementForbiddenError, startVisit } from './repository-engagement.ts';
import { createShareLink, grantViewerAccess } from './repository-sharing.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_visit_revision_20260922_test');
const integration = describe.runIf(databaseUrl !== undefined);
const readiness = {
  visible: true,
  interacted: true,
  analyticsConsent: true,
  deviceClass: 'desktop' as const,
  browserFamily: 'Chromium',
  countryCode: null,
};

integration('visit revision binding', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let owner = { id: '', email: 'revision-owner@pagent.test' };
  let original = { deckId: '', revisionId: '', revisionNumber: 0 };
  let sessionToken = '';

  beforeAll(async () => {
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    owner = await db.upsertUser({
      email: owner.email,
      handle: 'revision-owner',
      name: 'Revision Owner',
      avatarUrl: null,
    });
  });

  beforeEach(async () => {
    original = await publishDeck(owner, {
      title: 'Original',
      slides: [{ id: 'cover', html: '<h1>Legacy</h1>' }],
    });
    const link = await createShareLink(owner.id, original.deckId, {
      name: 'Review update',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    const access = await grantViewerAccess({ token: link.token });
    if (access.kind !== 'granted') throw new TypeError('Fixture viewer access must be granted');
    sessionToken = access.sessionToken;
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('starts a visit for the latest HTML revision when a legacy client reloads after publication', async () => {
    // Given
    const originalVisit = await startVisit(sessionToken, readiness);
    const updated = await publishDeck(owner, {
      title: 'HTML update',
      update_deck_id: deckIdSchema.parse(original.deckId),
      html: '<body>New</body>',
    });

    // When
    const htmlVisit = await startVisit(sessionToken, readiness);

    // Then
    expect(htmlVisit.kind).toBe('started');
    expect(htmlVisit).not.toEqual(originalVisit);
    if (htmlVisit.kind !== 'started') return;
    const rows = await setup<
      { revision_id: string }[]
    >`select revision_id from visits where id = ${htmlVisit.visitId}`;
    expect(rows).toEqual([{ revision_id: updated.revisionId }]);
  });

  it('binds the visit to loaded content when another revision publishes before interaction', async () => {
    // Given
    await publishDeck(owner, {
      title: 'HTML update',
      update_deck_id: deckIdSchema.parse(original.deckId),
      html: '<body>New</body>',
    });
    const input = { ...readiness, revisionId: original.revisionId };

    // When
    const visit = await startVisit(sessionToken, input);

    // Then
    expect(visit.kind).toBe('started');
    if (visit.kind !== 'started') return;
    const rows = await setup<
      { revision_id: string }[]
    >`select revision_id from visits where id = ${visit.visitId}`;
    expect(rows).toEqual([{ revision_id: original.revisionId }]);
  });

  it('rejects a requested revision when it belongs to a different deck', async () => {
    // Given
    const unrelated = await publishDeck(owner, { title: 'Unrelated', html: '<body>Other</body>' });
    const input = { ...readiness, revisionId: unrelated.revisionId };

    // When
    const result = startVisit(sessionToken, input);

    // Then
    await expect(result).rejects.toBeInstanceOf(EngagementForbiddenError);
  });
});
