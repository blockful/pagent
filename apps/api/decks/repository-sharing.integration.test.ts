import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../db.ts';
import { publishDeck } from './repository-decks.ts';
import {
  createShareLink,
  decideAccessRequest,
  getShareMetadata,
  getViewerDeck,
  grantViewerAccess,
  requestAccess,
  revokeShareLink,
} from './repository-sharing.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_deck_sharing_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('share-link access repository', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let ownerId = '';
  let viewerId = '';
  let deckId = '';
  let publicToken = '';
  let allowedToken = '';
  let authenticatedToken = '';
  let authenticatedLinkId = '';

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
    const viewer = await db.upsertUser({
      email: 'verified@northstar.example',
      handle: 'viewer',
      name: 'Viewer',
      avatarUrl: null,
    });
    ownerId = owner.id;
    viewerId = viewer.id;
    const deck = await publishDeck(
      { id: owner.id, email: owner.email },
      { title: 'Northstar renewal', slides: [{ id: 'cover', html: '<h1>Private</h1>' }] },
    );
    deckId = deck.deckId;

    // When
    const publicLink = await createShareLink(ownerId, deckId, {
      name: 'Public review',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    const allowedLink = await createShareLink(ownerId, deckId, {
      name: 'Northstar low friction',
      access_mode: 'allowed_email',
      allowed_emails: ['buyer@northstar.example'],
      allowed_domains: ['trusted.example'],
    });
    const authenticatedLink = await createShareLink(ownerId, deckId, {
      name: 'Northstar confidential',
      access_mode: 'authenticated',
      allowed_emails: ['verified@northstar.example'],
      allowed_domains: [],
    });
    publicToken = publicLink.token;
    allowedToken = allowedLink.token;
    authenticatedToken = authenticatedLink.token;
    authenticatedLinkId = authenticatedLink.id;
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('issues an anonymous session for Anyone links without exposing content in metadata', async () => {
    // When
    const metadata = await getShareMetadata(publicToken);
    const access = await grantViewerAccess({ token: publicToken });

    // Then
    expect(metadata).toMatchObject({ deckTitle: 'Northstar renewal', accessMode: 'anyone' });
    expect(metadata).not.toHaveProperty('slides');
    expect(access.kind).toBe('granted');
    if (access.kind === 'granted') expect(access.identityConfidence).toBe('anonymous');
  });

  it('grants Allowed email access without authentication and labels it Unverified', async () => {
    // When
    const access = await grantViewerAccess({
      token: allowedToken,
      email: ' BUYER@NORTHSTAR.EXAMPLE ',
    });

    // Then
    expect(access.kind).toBe('granted');
    if (access.kind === 'granted') {
      expect(access.identityConfidence).toBe('unverified');
      expect((await getViewerDeck(access.sessionToken)).slides).toHaveLength(1);
    }
  });

  it('returns the same unavailable outcome for non-allowed addresses', async () => {
    // When
    const first = await grantViewerAccess({ token: allowedToken, email: 'unknown@example.test' });
    const second = await grantViewerAccess({ token: allowedToken, email: 'other@example.test' });

    // Then
    expect(first).toEqual({ kind: 'unavailable', canRequest: true });
    expect(second).toEqual(first);
  });

  it('requires authenticated identity before serving an Authenticated viewer link', async () => {
    // When
    const anonymous = await grantViewerAccess({
      token: authenticatedToken,
      email: 'verified@northstar.example',
    });
    const authenticated = await grantViewerAccess({
      token: authenticatedToken,
      email: 'verified@northstar.example',
      authenticatedUser: { id: viewerId, email: 'verified@northstar.example' },
    });

    // Then
    expect(anonymous).toEqual({ kind: 'authentication_required' });
    expect(authenticated.kind).toBe('granted');
    if (authenticated.kind === 'granted') {
      expect(authenticated.identityConfidence).toBe('authenticated');
    }
  });

  it('applies an approved request only to its link and preserves its authentication mode', async () => {
    // Given
    const requested = await requestAccess(authenticatedToken, 'new@northstar.example');

    // When
    await decideAccessRequest({
      userId: ownerId,
      linkId: authenticatedLinkId,
      requestId: requested.requestId,
      decision: 'approved',
    });
    const withoutAuthentication = await grantViewerAccess({
      token: authenticatedToken,
      email: 'new@northstar.example',
    });

    // Then
    expect(withoutAuthentication).toEqual({ kind: 'authentication_required' });
  });

  it('revocation invalidates an already-issued viewer session on its next content request', async () => {
    // Given
    const access = await grantViewerAccess({
      token: authenticatedToken,
      authenticatedUser: {
        id: viewerId,
        email: 'verified@northstar.example',
      },
    });
    expect(access.kind).toBe('granted');
    if (access.kind !== 'granted') return;

    // When
    await revokeShareLink(ownerId, deckId, authenticatedLinkId);

    // Then
    await expect(getViewerDeck(access.sessionToken)).rejects.toMatchObject({
      name: 'ViewerSessionUnavailableError',
      state: 'revoked',
    });
  });
});
