import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../db.ts';
import { publishDeckBodySchema } from './domain.ts';
import { getDeckAnalytics } from './repository-analytics.ts';
import { getDeckDetail, getDeckPreview, publishDeck } from './repository-decks.ts';
import { ingestEngagement, startVisit } from './repository-engagement.ts';
import { createShareLink, getViewerDeck, grantViewerAccess } from './repository-sharing.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_html_backend_20260922_test');
const integration = describe.runIf(databaseUrl !== undefined);
const html =
  '\n<!doctype html><html><head><style>:root { --accent: #08f }</style></head><body><main>Olá</main><script>window.ready = true</script></body></html>\n';

integration('HTML document repository', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let owner = { id: '', email: 'html-owner@pagent.test' };

  beforeAll(async () => {
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    owner = await db.upsertUser({
      email: owner.email,
      handle: 'html-owner',
      name: 'HTML Owner',
      avatarUrl: null,
    });
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('stores and returns the exact document when publishing an HTML revision', async () => {
    // Given
    const body = publishDeckBodySchema.parse({ title: 'Exact document', html });

    // When
    const published = await publishDeck(owner, body);
    const preview = await getDeckPreview(owner.id, published.deckId);
    const detail = await getDeckDetail(owner.id, published.deckId);

    // Then
    expect(preview).toMatchObject({ html, slides: [] });
    expect(detail.revisions[0]).toMatchObject({ contentFormat: 'html', slideCount: 0 });
    const rows = await setup<{ html: string; slide_count: number }[]>`
      select r.html, (select count(*)::integer from deck_slides s where s.revision_id = r.id) as slide_count
      from deck_revisions r where r.id = ${published.revisionId}
    `;
    expect(rows).toEqual([{ html, slide_count: 0 }]);
  });

  it('retains legacy slides and identifies an unvisited HTML update when revising a deck', async () => {
    // Given
    const original = await publishDeck(owner, {
      title: 'Legacy',
      slides: [{ id: 'cover', html: '<h1>Legacy</h1><script>bad()</script>' }],
    });

    // When
    await publishDeck(
      owner,
      publishDeckBodySchema.parse({ title: 'Updated', update_deck_id: original.deckId, html }),
    );
    const analytics = await getDeckAnalytics(owner.id, original.deckId, {});
    const filtered = await getDeckAnalytics(owner.id, original.deckId, { revision: 2 });
    const detail = await getDeckDetail(owner.id, original.deckId);

    // Then
    expect(analytics).toMatchObject({ contentFormat: 'mixed', revisionNumbers: [2, 1] });
    expect(filtered).toMatchObject({ contentFormat: 'html', revisionNumbers: [2], slides: [] });
    expect(filtered.overview.averageCompletion).toBeNull();
    expect(detail.revisions.map((revision) => revision.contentFormat)).toEqual(['html', 'slides']);
    const rows = await setup<
      { html: string }[]
    >`select html from deck_slides where revision_id = ${original.revisionId}`;
    expect(rows).toEqual([{ html: '<h1>Legacy</h1>' }]);
  });

  it('keeps earlier HTML bytes immutable when publishing another document revision', async () => {
    // Given
    const original = await publishDeck(
      owner,
      publishDeckBodySchema.parse({ title: 'Original', html }),
    );
    const updated = '<!doctype html><body><p>New document</p></body>';

    // When
    await publishDeck(
      owner,
      publishDeckBodySchema.parse({
        title: 'Updated',
        update_deck_id: original.deckId,
        html: updated,
      }),
    );
    const rows = await setup<{ revision_number: number; html: string }[]>`
      select revision_number, html from deck_revisions where deck_id = ${original.deckId} order by revision_number
    `;

    // Then
    expect(rows).toEqual([
      { revision_number: 1, html },
      { revision_number: 2, html: updated },
    ]);
  });

  it('tracks accepted visit-level time without invented slides when an HTML viewer is active', async () => {
    // Given
    const published = await publishDeck(
      owner,
      publishDeckBodySchema.parse({ title: 'Track document', html }),
    );
    const link = await createShareLink(owner.id, published.deckId, {
      name: 'Review',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
    const access = await grantViewerAccess({ token: link.token });
    expect(access.kind).toBe('granted');
    if (access.kind !== 'granted') return;
    const viewer = await getViewerDeck(access.sessionToken);
    const started = await startVisit(access.sessionToken, {
      visible: true,
      interacted: true,
      analyticsConsent: true,
      deviceClass: 'desktop',
      browserFamily: 'Chromium',
      countryCode: null,
    });
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    const base = new Date(Date.now() - 10_000);
    await setup`update visits set started_at = ${base}, last_activity_at = ${base} where id = ${started.visitId}`;
    const event = {
      id: randomUUID(),
      eventType: 'heartbeat' as const,
      eventAt: new Date(base.getTime() + 5000),
      sequence: 1,
      visibleRatio: 1,
      visibleDurationMs: 5000,
      tabVisible: true,
      recentlyActive: true,
    };

    // When
    await ingestEngagement(access.sessionToken, started.visitId, [event, event]);
    const analytics = await getDeckAnalytics(owner.id, published.deckId, {});

    // Then
    expect(viewer).toMatchObject({ html, slides: [] });
    expect(analytics.visits[0]).toMatchObject({
      contentFormat: 'html',
      totalActiveTimeMs: 5000,
      viewedSlides: null,
      completion: null,
      furthestSlide: null,
      lastSlide: null,
      slideSequence: [],
    });
    expect(analytics.overview).toMatchObject({
      totalVisits: 1,
      averageActiveTimeMs: 5000,
      averageCompletion: null,
      topSlide: null,
    });
    expect(analytics.slides).toEqual([]);
    const rows = await setup<
      { count: number }[]
    >`select count(*)::integer as count from slide_engagement where visit_id = ${started.visitId}`;
    expect(rows).toEqual([{ count: 0 }]);
  });
});
