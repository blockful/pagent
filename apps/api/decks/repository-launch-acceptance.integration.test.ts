import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../db.ts';
import { deckIdSchema } from './domain.ts';
import { deleteDeck } from './repository-deck-lifecycle.ts';
import { listDecks } from './repository-deck-list.ts';
import { publishDeck } from './repository-decks.ts';
import { ingestEngagement, startVisit } from './repository-engagement.ts';
import { getDeckAnalytics } from './repository-analytics.ts';
import { exportDeckAnalyticsCsv } from './repository-analytics-export.ts';
import { removeWorkspaceMember } from './repository-access-settings.ts';
import {
  createTeam,
  setAnalyticsVisibility,
  setDeckCollaborators,
} from './repository-permissions.ts';
import {
  createShareLink,
  decideAccessRequest,
  getViewerDeck,
  grantViewerAccess,
  requestAccess,
  revokeShareLink,
} from './repository-sharing.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_launch_acceptance_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);
const visitInput = {
  visible: true,
  interacted: true,
  analyticsConsent: true,
  deviceClass: 'desktop' as const,
  browserFamily: 'Chromium',
  countryCode: 'BR',
};

integration('launch acceptance repository matrix', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let owner: { readonly id: string; readonly email: string };
  let sender: { readonly id: string; readonly email: string };
  let collaborator: { readonly id: string; readonly email: string };
  let teamAdmin: { readonly id: string; readonly email: string };

  beforeAll(async () => {
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    owner = await user('owner@launch.test', 'owner');
    sender = await user('sender@launch.test', 'sender');
    collaborator = await user('collaborator@launch.test', 'collaborator');
    teamAdmin = await user('admin@launch.test', 'admin');
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('lists complete page rows across search, scope, and lifecycle filters', async () => {
    // Given
    const listed = await publish('Title Needle', 'Client Needle');
    const link = await createShareLink(owner.id, listed.deckId, {
      name: 'Link Needle',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    await activate(listed.deckId, sender.id, 'member');
    await activate(listed.deckId, collaborator.id, 'member');
    await activate(listed.deckId, teamAdmin.id, 'admin');
    await setDeckCollaborators(owner.id, listed.deckId, [collaborator.id]);
    await db.database()`update share_links set creator_id = ${sender.id} where id = ${link.id}`;
    const access = await grantViewerAccess({ token: link.token });
    const session = granted(access);
    await startVisit(session.sessionToken, visitInput);
    const archived = await publish('Archived page', null);
    const expired = await publish('Expired page', null);
    const revoked = await publish('Revoked page', null);
    await db.database()`update decks set status = 'archived' where id = ${archived.deckId}`;
    const expiredLink = await createShareLink(owner.id, expired.deckId, {
      name: 'Expired link',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.database()`update share_links set expires_at = now() - interval '1 minute' where id = ${expiredLink.id}`;
    const revokedLink = await createShareLink(owner.id, revoked.deckId, {
      name: 'Revoked link',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    await revokeShareLink(owner.id, revoked.deckId, revokedLink.id);

    // When
    const [
      mine,
      shared,
      team,
      title,
      client,
      ownerSearch,
      senderSearch,
      linkSearch,
      active,
      archivedRows,
      expiredRows,
      revokedRows,
    ] = await Promise.all([
      listDecks(owner.id, { scope: 'mine' }),
      listDecks(collaborator.id, { scope: 'shared' }),
      listDecks(teamAdmin.id, { scope: 'team' }),
      listDecks(owner.id, { scope: 'mine', q: 'title needle' }),
      listDecks(owner.id, { scope: 'mine', q: 'client needle' }),
      listDecks(owner.id, { scope: 'mine', q: owner.email }),
      listDecks(owner.id, { scope: 'mine', q: sender.email }),
      listDecks(owner.id, { scope: 'mine', q: 'link needle' }),
      listDecks(owner.id, { scope: 'mine', status: 'active' }),
      listDecks(owner.id, { scope: 'mine', status: 'archived' }),
      listDecks(owner.id, { scope: 'mine', status: 'expired' }),
      listDecks(owner.id, { scope: 'mine', status: 'revoked' }),
    ]);

    // Then
    expect(mine.find((row) => row.id === listed.deckId)).toMatchObject({
      id: listed.deckId,
      title: 'Title Needle',
      ownerId: owner.id,
      ownerEmail: owner.email,
      latestSenderId: sender.id,
      latestSenderEmail: sender.email,
      status: 'active',
      accessMode: 'anyone',
      linkCount: 1,
      uniqueViewers: 1,
    });
    const listRow = mine.find((row) => row.id === listed.deckId);
    expect(listRow?.lastViewed).toBeInstanceOf(Date);
    expect(shared.find((row) => row.id === listed.deckId)).toMatchObject({
      uniqueViewers: null,
      lastViewed: null,
    });
    expect(team.find((row) => row.id === listed.deckId)).toMatchObject({
      uniqueViewers: null,
      lastViewed: null,
    });
    expect(listRow?.updatedAt).toBeInstanceOf(Date);
    for (const rows of [shared, team, title, client, ownerSearch, senderSearch, linkSearch]) {
      expect(rows.map((row) => row.id)).toContain(listed.deckId);
    }
    expect(active.map((row) => row.id)).toContain(listed.deckId);
    expect(archivedRows.map((row) => row.id)).toContain(archived.deckId);
    expect(expiredRows.map((row) => row.id)).toContain(expired.deckId);
    expect(revokedRows.map((row) => row.id)).toContain(revoked.deckId);
  });

  it('redacts content-only list analytics and limits link creators to their own links', async () => {
    // Given
    const deck = await publish('Scoped list analytics', null);
    await activate(deck.deckId, sender.id, 'member');
    await activate(deck.deckId, collaborator.id, 'member');
    await setDeckCollaborators(owner.id, deck.deckId, [sender.id, collaborator.id]);
    const ownerLink = await createShareLink(owner.id, deck.deckId, {
      name: 'Owner audience',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    const senderLink = await createShareLink(owner.id, deck.deckId, {
      name: 'Sender audience',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    await db.database()`update share_links set creator_id = ${sender.id} where id = ${senderLink.id}`;
    const ownerSession = granted(await grantViewerAccess({ token: ownerLink.token }));
    const senderSession = granted(await grantViewerAccess({ token: senderLink.token }));
    const ownerVisit = started(await startVisit(ownerSession.sessionToken, visitInput));
    const senderVisit = started(await startVisit(senderSession.sessionToken, visitInput));
    const ownerViewedAt = new Date('2026-09-15T12:00:00.000Z');
    const senderViewedAt = new Date('2026-09-14T12:00:00.000Z');
    await db.database()`
      update visits set started_at = ${ownerViewedAt}, last_activity_at = ${ownerViewedAt}
      where id = ${ownerVisit}
    `;
    await db.database()`
      update visits set started_at = ${senderViewedAt}, last_activity_at = ${senderViewedAt}
      where id = ${senderVisit}
    `;

    // When
    const [owned, created, contentOnly] = await Promise.all([
      listDecks(owner.id, { scope: 'mine' }),
      listDecks(sender.id, { scope: 'shared' }),
      listDecks(collaborator.id, { scope: 'shared' }),
    ]);

    // Then
    expect(owned.find((row) => row.id === deck.deckId)).toMatchObject({
      uniqueViewers: 2,
      lastViewed: ownerViewedAt,
    });
    expect(created.find((row) => row.id === deck.deckId)).toMatchObject({
      uniqueViewers: 1,
      lastViewed: senderViewedAt,
    });
    expect(contentOnly.find((row) => row.id === deck.deckId)).toMatchObject({
      uniqueViewers: null,
      lastViewed: null,
    });
  });

  it('shows deck-wide list analytics only to the Selected people audience', async () => {
    // Given
    const fixture = await listAnalyticsFixture('Selected list analytics');
    await setAnalyticsVisibility(owner.id, fixture.deckId, {
      scope: 'selected',
      subjectIds: [collaborator.id],
    });

    // When
    const [selected, nonAudience] = await Promise.all([
      listDecks(collaborator.id, { scope: 'shared' }),
      listDecks(teamAdmin.id, { scope: 'team' }),
    ]);

    // Then
    expect(selected.find((row) => row.id === fixture.deckId)).toMatchObject({
      uniqueViewers: 2,
      lastViewed: fixture.lastViewed,
    });
    expect(nonAudience.find((row) => row.id === fixture.deckId)).toMatchObject({
      uniqueViewers: null,
      lastViewed: null,
    });
  });

  it('shows deck-wide list analytics only to the selected Team audience', async () => {
    // Given
    const fixture = await listAnalyticsFixture('Team list analytics');
    const team = await createTeam(owner.id, fixture.deckId, {
      name: 'List analytics team',
      memberIds: [sender.id],
    });
    await setAnalyticsVisibility(owner.id, fixture.deckId, {
      scope: 'team',
      subjectIds: [team.id],
    });

    // When
    const [teammate, nonAudience] = await Promise.all([
      listDecks(sender.id, { scope: 'shared' }),
      listDecks(teamAdmin.id, { scope: 'team' }),
    ]);

    // Then
    expect(teammate.find((row) => row.id === fixture.deckId)).toMatchObject({
      uniqueViewers: 2,
      lastViewed: fixture.lastViewed,
    });
    expect(nonAudience.find((row) => row.id === fixture.deckId)).toMatchObject({
      uniqueViewers: null,
      lastViewed: null,
    });
  });

  it('shows deck-wide list analytics to every active Workspace audience member', async () => {
    // Given
    const fixture = await listAnalyticsFixture('Workspace list analytics');
    await setAnalyticsVisibility(owner.id, fixture.deckId, {
      scope: 'workspace',
      subjectIds: [],
    });

    // When
    const [collaboratorRows, adminRows] = await Promise.all([
      listDecks(collaborator.id, { scope: 'shared' }),
      listDecks(teamAdmin.id, { scope: 'team' }),
    ]);

    // Then
    for (const rows of [collaboratorRows, adminRows]) {
      expect(rows.find((row) => row.id === fixture.deckId)).toMatchObject({
        uniqueViewers: 2,
        lastViewed: fixture.lastViewed,
      });
    }
  });

  it('retains viewer confidence and caps sessions at the chosen link expiry or seven days', async () => {
    // Given
    const deck = await publish('Expiring review', null);
    const shortExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const longExpiry = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const short = await createShareLink(owner.id, deck.deckId, {
      name: 'Two-day review',
      access_mode: 'allowed_email',
      allowed_emails: ['short@viewer.test'],
      allowed_domains: [],
      expires_at: shortExpiry.toISOString(),
    });
    const long = await createShareLink(owner.id, deck.deckId, {
      name: 'Ten-day review',
      access_mode: 'allowed_email',
      allowed_emails: ['long@viewer.test'],
      allowed_domains: [],
      expires_at: longExpiry.toISOString(),
    });

    // When
    const shortAccess = granted(
      await grantViewerAccess({ token: short.token, email: 'short@viewer.test' }),
    );
    const longAccess = granted(
      await grantViewerAccess({ token: long.token, email: 'long@viewer.test' }),
    );

    // Then
    expect(shortAccess.identityConfidence).toBe('unverified');
    expect(shortAccess.expiresAt.getTime()).toBe(short.expiresAt?.getTime());
    expect(longAccess.identityConfidence).toBe('unverified');
    expect(longAccess.expiresAt.getTime()).toBeLessThan(long.expiresAt?.getTime() ?? 0);
    expect(longAccess.expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(longAccess.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('persists visit fields and starts a new visit after thirty inactive minutes', async () => {
    // Given
    const deck = await publish('Visit continuity', null);
    const link = await createShareLink(owner.id, deck.deckId, {
      name: 'Visit link',
      access_mode: 'allowed_email',
      allowed_emails: ['visit@viewer.test'],
      allowed_domains: [],
    });
    const session = granted(
      await grantViewerAccess({ token: link.token, email: 'visit@viewer.test' }),
    );
    const first = started(await startVisit(session.sessionToken, visitInput));

    // When
    await db.database()`update visits set last_activity_at = now() - interval '31 minutes' where id = ${first}`;
    const second = started(await startVisit(session.sessionToken, visitInput));
    const visits = await db.database()<
      {
        id: string;
        viewer_email: string | null;
        identity_confidence: string;
        device_class: string;
        browser_family: string;
        country_code: string | null;
        analytics_consent: boolean;
        ended_at: Date | null;
      }[]
    >`select id, viewer_email, identity_confidence, device_class, browser_family, country_code,
        analytics_consent, ended_at from visits where share_link_id = ${link.id} order by started_at`;

    // Then
    expect(second).not.toBe(first);
    expect(visits).toEqual([
      expect.objectContaining({
        id: first,
        viewer_email: 'visit@viewer.test',
        identity_confidence: 'unverified',
        device_class: 'desktop',
        browser_family: 'Chromium',
        country_code: 'BR',
        analytics_consent: true,
        ended_at: expect.any(Date),
      }),
      expect.objectContaining({ id: second, ended_at: null }),
    ]);
  });

  it('returns complete analytics and applies link, viewer, sender, revision, and date filters', async () => {
    // Given
    const deck = await publish('Analytics matrix', null);
    await activate(deck.deckId, sender.id, 'member');
    const firstLink = await createShareLink(owner.id, deck.deckId, {
      name: 'First analytics link',
      access_mode: 'allowed_email',
      allowed_emails: ['first@viewer.test'],
      allowed_domains: [],
    });
    const firstSession = granted(
      await grantViewerAccess({ token: firstLink.token, email: 'first@viewer.test' }),
    );
    const firstVisit = started(await startVisit(firstSession.sessionToken, visitInput));
    await engage(firstSession.sessionToken, firstVisit, deck.revisionId, 1);
    const revised = await publish('Analytics matrix revision two', null, deck.deckId);
    const secondLink = await createShareLink(owner.id, deck.deckId, {
      name: 'Second analytics link',
      access_mode: 'allowed_email',
      allowed_emails: ['second@viewer.test'],
      allowed_domains: [],
    });
    await db.database()`update share_links set creator_id = ${sender.id} where id = ${secondLink.id}`;
    const secondSession = granted(
      await grantViewerAccess({ token: secondLink.token, email: 'second@viewer.test' }),
    );
    const secondVisit = started(await startVisit(secondSession.sessionToken, visitInput));
    await engage(secondSession.sessionToken, secondVisit, revised.revisionId, 2);
    await db.database()`update visits set started_at = now() - interval '2 days' where id = ${firstVisit}`;
    await db.database()`update visits set started_at = now() - interval '1 day' where id = ${secondVisit}`;

    // When
    const [analytics, byLink, byViewer, bySender, byRevision, byDate] = await Promise.all([
      getDeckAnalytics(owner.id, deck.deckId, {}),
      getDeckAnalytics(owner.id, deck.deckId, { linkId: firstLink.id }),
      getDeckAnalytics(owner.id, deck.deckId, { viewer: 'second@viewer.test' }),
      getDeckAnalytics(owner.id, deck.deckId, { sender: sender.id }),
      getDeckAnalytics(owner.id, deck.deckId, { revision: 2 }),
      getDeckAnalytics(owner.id, deck.deckId, {
        from: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        to: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    // Then
    expect(analytics.overview).toMatchObject({
      totalVisits: 2,
      uniqueViewers: 2,
      lastViewed: expect.any(Date),
      averageActiveTimeMs: expect.any(Number),
      averageCompletion: 1,
      topSlide: expect.objectContaining({
        stableSlideId: 'slide-1',
        revisionNumber: expect.any(Number),
        ordinal: 1,
        title: 'Slide 1',
        uniqueViewers: 1,
        viewRate: 1,
        averageActiveTimeMs: expect.any(Number),
        totalActiveTimeMs: expect.any(Number),
        exits: 0,
      }),
    });
    expect(analytics.visitors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewer: 'first@viewer.test',
          identityConfidence: 'unverified',
          firstVisit: expect.any(Date),
          lastVisit: expect.any(Date),
          visits: 1,
          totalActiveTimeMs: expect.any(Number),
          maximumCompletion: 1,
        }),
      ]),
    );
    expect(analytics.slides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableSlideId: 'slide-1',
          revisionNumber: 1,
          ordinal: 1,
          title: 'Slide 1',
          uniqueViewers: 1,
          viewRate: 1,
          averageActiveTimeMs: expect.any(Number),
          totalActiveTimeMs: expect.any(Number),
          exits: 0,
        }),
      ]),
    );
    expect(analytics.visits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstVisit,
          linkId: firstLink.id,
          revisionNumber: 1,
          totalActiveTimeMs: expect.any(Number),
          slideSequence: [expect.objectContaining({ ordinal: 1 })],
        }),
      ]),
    );
    for (const filtered of [byLink, byViewer, bySender, byRevision, byDate]) {
      expect(filtered.visits).toHaveLength(1);
    }
    expect(byLink.visits[0]?.id).toBe(firstVisit);
    expect(byViewer.visits[0]?.id).toBe(secondVisit);
    expect(bySender.visits[0]?.id).toBe(secondVisit);
    expect(byRevision.visits[0]?.id).toBe(secondVisit);
    expect(byDate.visits[0]?.id).toBe(firstVisit);
  });

  it('grants a live link creator analytics then denies it immediately after removal', async () => {
    // Given
    const deck = await publish('Creator analytics', null);
    await activate(deck.deckId, sender.id, 'member');
    await setDeckCollaborators(owner.id, deck.deckId, [sender.id]);
    const link = await createShareLink(owner.id, deck.deckId, {
      name: 'Creator link',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    await db.database()`update share_links set creator_id = ${sender.id} where id = ${link.id}`;
    const session = granted(await grantViewerAccess({ token: link.token }));
    started(await startVisit(session.sessionToken, visitInput));
    const whileActive = await getDeckAnalytics(sender.id, deck.deckId, {});
    const activeList = await listDecks(sender.id, { scope: 'shared' });

    // When
    await removeWorkspaceMember(owner.id, deck.deckId, sender.id);
    const removedList = await listDecks(sender.id, { scope: 'shared' });

    // Then
    expect(whileActive.owner.id).toBe(owner.id);
    expect(activeList.find((row) => row.id === deck.deckId)).toMatchObject({
      uniqueViewers: 1,
      lastViewed: expect.any(Date),
    });
    expect(removedList.find((row) => row.id === deck.deckId)).toBeUndefined();
    await expect(getDeckAnalytics(sender.id, deck.deckId, {})).rejects.toMatchObject({
      name: 'DeckForbiddenError',
    });
  });

  it('audits permission, decision, revocation, and export actions', async () => {
    // Given
    const deck = await publish('Audit matrix', null);
    await activate(deck.deckId, collaborator.id, 'member');
    const link = await createShareLink(owner.id, deck.deckId, {
      name: 'Audit link',
      access_mode: 'allowed_email',
      allowed_emails: [],
      allowed_domains: [],
    });
    await setDeckCollaborators(owner.id, deck.deckId, [collaborator.id]);
    const request = await requestAccess(link.token, 'audit@viewer.test');

    // When
    await decideAccessRequest({
      userId: owner.id,
      linkId: link.id,
      requestId: request.requestId,
      decision: 'approved',
    });
    await exportDeckAnalyticsCsv(owner.id, deck.deckId, { linkId: link.id });
    await revokeShareLink(owner.id, deck.deckId, link.id);
    const actions = await db.database()<{ action: string }[]>`
      select action from audit_log where deck_id = ${deck.deckId}
    `;

    // Then
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'deck.collaborators_changed',
        'viewer.access_decided',
        'analytics.exported',
        'share_link.revoked',
      ]),
    );
  });

  it('denies deleted-page viewer content and analytics while retaining its auditable deletion record', async () => {
    // Given
    const deck = await publish('Deletion matrix', null);
    const link = await createShareLink(owner.id, deck.deckId, {
      name: 'Deletion link',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    const session = granted(await grantViewerAccess({ token: link.token }));
    await startVisit(session.sessionToken, visitInput);

    // When
    await deleteDeck(owner.id, deck.deckId);
    const retained = await db.database()<{ action: string }[]>`
      select action from audit_log where deck_id = ${deck.deckId} and action = 'deck.deleted'
    `;

    // Then
    await expect(getViewerDeck(session.sessionToken)).rejects.toMatchObject({
      name: 'ViewerSessionUnavailableError',
      state: 'deleted',
    });
    await expect(getDeckAnalytics(owner.id, deck.deckId, {})).rejects.toMatchObject({
      name: 'DeckForbiddenError',
    });
    expect(retained).toHaveLength(1);
  });

  async function user(
    email: string,
    handle: string,
  ): Promise<{ readonly id: string; readonly email: string }> {
    return db.upsertUser({ email, handle, name: handle, avatarUrl: null });
  }

  async function publish(title: string, clientLabel: string | null, updateDeckId?: string) {
    return publishDeck(owner, {
      title,
      client_label: clientLabel ?? undefined,
      update_deck_id: updateDeckId === undefined ? undefined : deckIdSchema.parse(updateDeckId),
      slides: [{ id: 'slide-1', title: 'Slide 1', html: '<h1>Slide 1</h1>' }],
    });
  }

  async function activate(deckId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    await db.database()`
      insert into workspace_members (workspace_id, user_id, role, status)
      values ((select workspace_id from decks where id = ${deckId}), ${userId}, ${role}, 'active')
      on conflict (workspace_id, user_id) do update set role = excluded.role, status = 'active'
    `;
  }

  async function listAnalyticsFixture(
    title: string,
  ): Promise<{ readonly deckId: string; readonly lastViewed: Date }> {
    const deck = await publish(title, null);
    await activate(deck.deckId, sender.id, 'member');
    await activate(deck.deckId, collaborator.id, 'member');
    await activate(deck.deckId, teamAdmin.id, 'admin');
    await setDeckCollaborators(owner.id, deck.deckId, [sender.id, collaborator.id]);
    const firstLink = await createShareLink(owner.id, deck.deckId, {
      name: `${title} first audience`,
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    const secondLink = await createShareLink(owner.id, deck.deckId, {
      name: `${title} second audience`,
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    const firstSession = granted(await grantViewerAccess({ token: firstLink.token }));
    const secondSession = granted(await grantViewerAccess({ token: secondLink.token }));
    const firstVisit = started(await startVisit(firstSession.sessionToken, visitInput));
    const secondVisit = started(await startVisit(secondSession.sessionToken, visitInput));
    const firstViewed = new Date('2026-09-13T12:00:00.000Z');
    const lastViewed = new Date('2026-09-15T12:00:00.000Z');
    await db.database()`
      update visits set started_at = ${firstViewed}, last_activity_at = ${firstViewed}
      where id = ${firstVisit}
    `;
    await db.database()`
      update visits set started_at = ${lastViewed}, last_activity_at = ${lastViewed}
      where id = ${secondVisit}
    `;
    return { deckId: deck.deckId, lastViewed };
  }

  async function engage(
    sessionToken: string,
    visitId: string,
    revisionId: string,
    sequence: number,
  ): Promise<void> {
    const slide = await db.database()<{ id: string }[]>`
      select id from deck_slides where revision_id = ${revisionId} and ordinal = 1
    `;
    const slideId = slide[0]?.id;
    if (slideId === undefined) throw new TypeError('Missing analytics slide');
    await ingestEngagement(sessionToken, visitId, [
      {
        id: randomUUID(),
        eventType: 'slide_view',
        slideId,
        eventAt: new Date(Date.now() + 1_000),
        sequence,
        visibleRatio: 1,
        visibleDurationMs: 1_000,
        tabVisible: true,
        recentlyActive: true,
      },
    ]);
  }
});

function granted(result: Awaited<ReturnType<typeof grantViewerAccess>>) {
  if (result.kind !== 'granted') throw new TypeError(`Expected granted access, got ${result.kind}`);
  return result;
}

function started(result: Awaited<ReturnType<typeof startVisit>>): string {
  if (result.kind !== 'started') throw new TypeError(`Expected started visit, got ${result.kind}`);
  return result.visitId;
}
