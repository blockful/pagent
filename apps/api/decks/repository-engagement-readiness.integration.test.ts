import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../db.ts';
import { getDeckAnalytics } from './repository-analytics.ts';
import { publishDeck } from './repository-decks.ts';
import {
  EngagementForbiddenError,
  ingestEngagement,
  startVisit,
  type EngagementEvent,
} from './repository-engagement.ts';
import { createShareLink, grantViewerAccess } from './repository-sharing.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_engagement_readiness_20260922_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('engagement readiness regressions', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let ownerId = '';
  let deckId = '';
  let token = '';
  let visitId = '';
  let slides: string[] = [];
  let base = new Date();

  beforeAll(async () => {
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    const owner = await db.upsertUser({
      email: 'readiness@pagent.test',
      handle: 'readiness',
      name: 'Readiness',
      avatarUrl: null,
    });
    ownerId = owner.id;
  });

  beforeEach(async () => {
    const deck = await publishDeck(
      { id: ownerId, email: 'readiness@pagent.test' },
      {
        title: 'Readiness',
        slides: [1, 2, 3].map((ordinal) => ({
          id: `slide-${ordinal}`,
          html: `<h1>${ordinal}</h1>`,
        })),
      },
    );
    deckId = deck.deckId;
    const rows = await db.database()<
      { id: string }[]
    >`select id from deck_slides where revision_id = ${deck.revisionId} order by ordinal`;
    slides = rows.map((row) => row.id);
    const link = await createShareLink(ownerId, deckId, {
      name: 'Review',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    const access = await grantViewerAccess({ token: link.token });
    if (access.kind !== 'granted') throw new TypeError('fixture access was not granted');
    token = access.sessionToken;
    const visit = await startVisit(token, {
      visible: true,
      interacted: true,
      analyticsConsent: true,
      deviceClass: 'desktop',
      browserFamily: 'Chromium',
      countryCode: null,
    });
    if (visit.kind !== 'started') throw new TypeError('fixture visit was not started');
    visitId = visit.visitId;
    base = new Date(Date.now() - 20_000);
    await db.database()`update visits set started_at = ${base}, last_activity_at = ${base} where id = ${visitId}`;
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  function event(
    slide: number,
    elapsed: number,
    overrides: Partial<EngagementEvent> = {},
  ): EngagementEvent {
    return {
      id: randomUUID(),
      eventType: 'slide_view',
      slideId: slides[slide - 1],
      eventAt: new Date(base.getTime() + elapsed),
      sequence: elapsed,
      visibleRatio: 1,
      visibleDurationMs: 1_000,
      tabVisible: true,
      recentlyActive: true,
      ...overrides,
    };
  }

  it('preserves qualifying repeated appearances from persisted events', async () => {
    // Given
    const events = [event(1, 3_000), event(2, 7_000), event(1, 10_000)];
    // When
    await ingestEngagement(token, visitId, events);
    const analytics = await getDeckAnalytics(ownerId, deckId, {});
    // Then
    expect(analytics.visits[0]).toMatchObject({ lastSlide: 1, viewedSlides: 2, completion: 2 / 3 });
    expect(analytics.visits[0]?.slideSequence.map((slide) => slide.ordinal)).toEqual([1, 2, 1]);
    expect(analytics.visits[0]?.slideSequence.map((slide) => slide.activeDurationMs)).toEqual([
      3_000, 4_000, 3_000,
    ]);
    expect(analytics.slides.map((slide) => slide.exits)).toEqual([1, 0, 0]);
  });

  it('preserves the earliest first-seen timestamp when an older event arrives later', async () => {
    // Given
    await ingestEngagement(token, visitId, [event(1, 10_000)]);
    const older = event(1, 3_000);
    // When
    await ingestEngagement(token, visitId, [older, older]);
    const rows = await db.database()<
      { first_seen_at: Date; last_seen_at: Date; active_duration_ms: string }[]
    >`
      select first_seen_at, last_seen_at, active_duration_ms::text from slide_engagement where visit_id = ${visitId}
    `;
    // Then
    expect(rows[0]).toEqual({
      first_seen_at: older.eventAt,
      last_seen_at: new Date(base.getTime() + 10_000),
      active_duration_ms: '10000',
    });
  });

  it.each(['stale', 'ended'] as const)(
    'rejects a %s visit without refreshing activity or persisting an event',
    async (state) => {
      // Given
      const previousActivity = new Date(Date.now() - (state === 'stale' ? 31 * 60_000 : 20_000));
      await db.database()`update visits set last_activity_at = ${previousActivity}, ended_at = ${state === 'ended' ? previousActivity : null} where id = ${visitId}`;
      // When
      const result = ingestEngagement(token, visitId, [event(1, 15_000)]);
      // Then
      await expect(result).rejects.toBeInstanceOf(EngagementForbiddenError);
      const rows = await db.database()<{ last_activity_at: Date; event_count: number }[]>`
      select last_activity_at, (select count(*)::integer from engagement_events where visit_id = ${visitId}) as event_count from visits where id = ${visitId}
    `;
      expect(rows[0]).toEqual({ last_activity_at: previousActivity, event_count: 0 });
    },
  );

  it('creates a different visit after an idle visit expires', async () => {
    // Given
    await db.database()`update visits set last_activity_at = now() - interval '31 minutes' where id = ${visitId}`;
    // When
    const next = await startVisit(token, {
      visible: true,
      interacted: true,
      analyticsConsent: true,
      deviceClass: 'desktop',
      browserFamily: 'Chromium',
      countryCode: null,
    });
    // Then
    expect(next.kind).toBe('started');
    if (next.kind === 'started') expect(next.visitId).not.toBe(visitId);
  });

  it('keeps a short final appearance unqualified even when that slide qualified earlier', async () => {
    // Given
    await ingestEngagement(token, visitId, [event(1, 3_000), event(2, 7_000)]);
    // When
    await ingestEngagement(token, visitId, [event(1, 7_500, { visibleDurationMs: 500 })]);
    const analytics = await getDeckAnalytics(ownerId, deckId, {});
    // Then
    expect(analytics.visits[0]?.lastSlide).toBe(2);
    expect(analytics.visits[0]?.slideSequence.map((slide) => slide.ordinal)).toEqual([1, 2]);
  });

  it('caps trusted time and leaves a repeated event idempotent', async () => {
    // Given
    const inflated = event(1, 20_000, { visibleDurationMs: 9_999_999 });
    // When
    await ingestEngagement(token, visitId, [inflated, inflated]);
    const analytics = await getDeckAnalytics(ownerId, deckId, {});
    // Then
    expect(analytics.visits[0]?.totalActiveTimeMs).toBe(10_000);
  });

  it('rejects impossible future events without qualifying a slide or advancing visit activity', async () => {
    // Given
    const future = event(1, 80_000);
    // When
    await ingestEngagement(token, visitId, [future]);
    const analytics = await getDeckAnalytics(ownerId, deckId, {});
    // Then
    expect(analytics.visits[0]).toMatchObject({
      lastActivityAt: base,
      totalActiveTimeMs: 0,
      viewedSlides: 0,
      lastSlide: null,
    });
  });

  it('credits only the interval after a zero-visibility resume boundary', async () => {
    // Given
    await db.database()`update visits set last_activity_at = now() - interval '5 minutes' where id = ${visitId}`;
    const baseline = event(1, 19_000, {
      eventType: 'heartbeat',
      visibleRatio: 0,
      visibleDurationMs: 0,
    });
    // When
    await ingestEngagement(token, visitId, [baseline, event(1, 20_000)]);
    const analytics = await getDeckAnalytics(ownerId, deckId, {});
    // Then
    expect(analytics.visits[0]?.totalActiveTimeMs).toBe(1_000);
  });

  it.each([false, true])(
    'preserves historical totals across migration without inventing old qualification (mixed: %s)',
    async (mixed) => {
      // Given
      await ingestEngagement(token, visitId, [event(1, 3_000)]);
      await db.database()`alter table engagement_events drop column qualified`;
      await db.database()`delete from deck_schema_migrations where version = 3`;
      // When
      await initDeckSchema(db.database());
      if (mixed) await ingestEngagement(token, visitId, [event(2, 7_000)]);
      const analytics = await getDeckAnalytics(ownerId, deckId, {});
      const events = await db.database()<{ qualified: boolean | null }[]>`
      select qualified from engagement_events where visit_id = ${visitId} order by event_at
    `;
      // Then
      expect(events.map((entry) => entry.qualified)).toEqual(mixed ? [null, true] : [null]);
      expect(analytics.visits[0]).toMatchObject({
        sequenceComplete: false,
        slideSequence: [],
        lastSlide: null,
        totalActiveTimeMs: mixed ? 7_000 : 3_000,
        viewedSlides: mixed ? 2 : 1,
        completion: (mixed ? 2 : 1) / 3,
      });
      expect(analytics.slides.map((slide) => slide.totalActiveTimeMs)).toEqual([
        3_000,
        mixed ? 4_000 : 0,
        0,
      ]);
      expect(analytics.slides.map((slide) => slide.exits)).toEqual([0, 0, 0]);
    },
  );
});
