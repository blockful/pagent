import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../db.ts';
import { getDeckAnalytics } from './repository-analytics.ts';
import { DeckForbiddenError, getDeckPreview, publishDeck } from './repository-decks.ts';
import {
  addWorkspaceMember,
  createTeam,
  previewAnalyticsVisibility,
  setAnalyticsVisibility,
  setDeckCollaborators,
} from './repository-permissions.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_deck_permissions_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('internal content and analytics permissions', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let ownerId = '';
  let selectedId = '';
  let teammateId = '';
  let workspaceId = '';
  let outsiderId = '';
  let deckId = '';
  let teamId = '';

  beforeAll(async () => {
    // Given
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    const users = await Promise.all(
      [
        ['owner@pagent.test', 'owner'],
        ['selected@pagent.test', 'selected'],
        ['teammate@pagent.test', 'teammate'],
        ['workspace@pagent.test', 'workspace'],
        ['outsider@pagent.test', 'outsider'],
      ].map(([email, handle]) => db.upsertUser({ email, handle, name: handle, avatarUrl: null })),
    );
    const [owner, selected, teammate, workspaceMember, outsider] = users;
    if (
      owner === undefined ||
      selected === undefined ||
      teammate === undefined ||
      workspaceMember === undefined ||
      outsider === undefined
    ) {
      throw new TypeError('permission test users were not created');
    }
    ownerId = owner.id;
    selectedId = selected.id;
    teammateId = teammate.id;
    workspaceId = workspaceMember.id;
    outsiderId = outsider.id;
    const deck = await publishDeck(
      { id: owner.id, email: owner.email },
      { title: 'Permission model', slides: [{ id: 'one', html: '<h1>One</h1>' }] },
    );
    deckId = deck.deckId;
    await addWorkspaceMember(ownerId, deckId, { email: selected.email, role: 'member' });
    await addWorkspaceMember(ownerId, deckId, { email: teammate.email, role: 'member' });
    await addWorkspaceMember(ownerId, deckId, { email: workspaceMember.email, role: 'admin' });
    const team = await createTeam(ownerId, deckId, {
      name: 'Revenue',
      memberIds: [teammateId],
    });
    teamId = team.id;
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('keeps content collaboration separate from analytics access', async () => {
    // When
    await setDeckCollaborators(ownerId, deckId, [selectedId]);

    // Then
    await expect(getDeckPreview(selectedId, deckId)).resolves.toMatchObject({ deckId });
    await expect(getDeckAnalytics(selectedId, deckId, {})).rejects.toBeInstanceOf(
      DeckForbiddenError,
    );
  });

  it('previews and grants Selected people only to active workspace members', async () => {
    // Given
    const preview = await previewAnalyticsVisibility(ownerId, deckId, {
      scope: 'selected',
      subjectIds: [selectedId],
    });

    // When
    await setAnalyticsVisibility(ownerId, deckId, {
      scope: 'selected',
      subjectIds: [selectedId],
    });

    // Then
    expect(preview.audience.map((member) => member.id)).toEqual(
      expect.arrayContaining([ownerId, selectedId]),
    );
    await expect(getDeckAnalytics(selectedId, deckId, {})).resolves.toBeDefined();
    await expect(getDeckAnalytics(workspaceId, deckId, {})).rejects.toBeInstanceOf(
      DeckForbiddenError,
    );
  });

  it('grants Team analytics only to active members of selected workspace teams', async () => {
    // When
    await setAnalyticsVisibility(ownerId, deckId, { scope: 'team', subjectIds: [teamId] });

    // Then
    await expect(getDeckAnalytics(teammateId, deckId, {})).resolves.toBeDefined();
    await expect(getDeckAnalytics(workspaceId, deckId, {})).rejects.toBeInstanceOf(
      DeckForbiddenError,
    );
  });

  it('grants Workspace analytics to explicit active membership, never an email suffix', async () => {
    // When
    await setAnalyticsVisibility(ownerId, deckId, { scope: 'workspace', subjectIds: [] });

    // Then
    await expect(getDeckAnalytics(workspaceId, deckId, {})).resolves.toBeDefined();
    await expect(getDeckAnalytics(outsiderId, deckId, {})).rejects.toBeInstanceOf(
      DeckForbiddenError,
    );
  });

  it('removes analytics access immediately when visibility returns to Private', async () => {
    // When
    await setAnalyticsVisibility(ownerId, deckId, { scope: 'private', subjectIds: [] });

    // Then
    await expect(getDeckAnalytics(selectedId, deckId, {})).rejects.toBeInstanceOf(
      DeckForbiddenError,
    );
  });
});
