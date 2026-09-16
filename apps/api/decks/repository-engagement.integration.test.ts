import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../db.ts';
import { getDeckAnalytics } from './repository-analytics.ts';
import { publishDeck } from './repository-decks.ts';
import { ingestEngagement, startVisit } from './repository-engagement.ts';
import { createShareLink, grantViewerAccess } from './repository-sharing.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_deck_engagement_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('viewer engagement repository', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let ownerId = '';
  let deckId = '';
  let viewerSessionToken = '';
  let slideIds: readonly string[] = [];

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
    ownerId = owner.id;
    const published = await publishDeck(
      { id: owner.id, email: owner.email },
      {
        title: 'Ten-slide proposal',
        slides: Array.from({ length: 10 }, (_, index) => ({
          id: `slide-${index + 1}`,
          title: `Slide ${index + 1}`,
          html: `<h1>Slide ${index + 1}</h1>`,
        })),
      },
    );
    deckId = published.deckId;
    const slides = await db.database()<{ id: string }[]>`
      select id from deck_slides where revision_id = ${published.revisionId} order by ordinal
    `;
    slideIds = slides.map((slide) => slide.id);
    const link = await createShareLink(owner.id, deckId, {
      name: 'Buyer review',
      access_mode: 'allowed_email',
      allowed_emails: ['buyer@northstar.example'],
      allowed_domains: [],
    });
    const access = await grantViewerAccess({
      token: link.token,
      email: 'buyer@northstar.example',
    });
    expect(access.kind).toBe('granted');
    if (access.kind === 'granted') viewerSessionToken = access.sessionToken;
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('does not create a visit until the client confirms a visible interactive session', async () => {
    // When
    const outcome = await startVisit(viewerSessionToken, {
      visible: false,
      interacted: false,
      analyticsConsent: true,
      deviceClass: 'desktop',
      browserFamily: 'Chromium',
      countryCode: null,
    });

    // Then
    expect(outcome).toEqual({ kind: 'excluded' });
  });

  it('deduplicates retries, ignores background and out-of-order time, and preserves completion semantics', async () => {
    // Given
    const started = await startVisit(viewerSessionToken, {
      visible: true,
      interacted: true,
      analyticsConsent: true,
      deviceClass: 'desktop',
      browserFamily: 'Chromium',
      countryCode: 'US',
    });
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    const base = new Date();
    const slideOneEvent = randomUUID();
    const events = [
      {
        id: slideOneEvent,
        eventType: 'slide_view' as const,
        slideId: slideIds[0],
        eventAt: new Date(base.getTime() + 1_000),
        sequence: 1,
        visibleRatio: 1,
        visibleDurationMs: 1_000,
        tabVisible: true,
        recentlyActive: true,
      },
      {
        id: randomUUID(),
        eventType: 'heartbeat' as const,
        slideId: slideIds[0],
        eventAt: new Date(base.getTime() + 6_000),
        sequence: 2,
        visibleRatio: 1,
        visibleDurationMs: 6_000,
        tabVisible: true,
        recentlyActive: true,
      },
      {
        id: randomUUID(),
        eventType: 'heartbeat' as const,
        slideId: slideIds[0],
        eventAt: new Date(base.getTime() + 11_000),
        sequence: 3,
        visibleRatio: 1,
        visibleDurationMs: 11_000,
        tabVisible: false,
        recentlyActive: false,
      },
      {
        id: randomUUID(),
        eventType: 'slide_view' as const,
        slideId: slideIds[9],
        eventAt: new Date(base.getTime() + 12_000),
        sequence: 4,
        visibleRatio: 1,
        visibleDurationMs: 1_000,
        tabVisible: true,
        recentlyActive: true,
      },
    ];

    // When
    await ingestEngagement(viewerSessionToken, started.visitId, events);
    await ingestEngagement(viewerSessionToken, started.visitId, [events[0]]);
    await ingestEngagement(viewerSessionToken, started.visitId, [
      {
        id: randomUUID(),
        eventType: 'heartbeat',
        slideId: slideIds[0],
        eventAt: new Date(base.getTime() + 3_000),
        sequence: 5,
        visibleRatio: 1,
        visibleDurationMs: 3_000,
        tabVisible: true,
        recentlyActive: true,
      },
    ]);
    const analytics = await getDeckAnalytics(ownerId, deckId, {});

    // Then
    expect(analytics.overview.totalVisits).toBe(1);
    expect(analytics.overview.uniqueViewers).toBe(1);
    expect(analytics.visitors[0]?.identityConfidence).toBe('unverified');
    expect(analytics.visits[0]).toMatchObject({
      completion: 0.2,
      furthestSlide: 10,
      lastSlide: 10,
    });
    expect(analytics.overview.averageActiveTimeMs).toBeGreaterThan(0);
    expect(analytics.overview.averageActiveTimeMs).toBeLessThanOrEqual(20_000);
  });
});
