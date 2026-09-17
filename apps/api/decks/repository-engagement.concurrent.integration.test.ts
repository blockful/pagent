import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../db.ts';
import { publishDeck } from './repository-decks.ts';
import { startVisit } from './repository-engagement.ts';
import { createShareLink, grantViewerAccess } from './repository-sharing.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';
import { hashOpaqueToken } from './tokens.ts';

const databaseUrl = integrationDatabaseUrl('pagent_deck_engagement_concurrent_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('concurrent viewer engagement repository', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let viewerSessionToken = '';

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
    const published = await publishDeck(
      { id: owner.id, email: owner.email },
      {
        title: 'Concurrent viewer proposal',
        slides: [{ id: 'slide-1', title: 'Slide 1', html: '<h1>Slide 1</h1>' }],
      },
    );
    const link = await createShareLink(owner.id, published.deckId, {
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

  it('returns one active visit when the same viewer starts concurrently', async () => {
    // Given
    const input = {
      visible: true,
      interacted: true,
      analyticsConsent: true,
      deviceClass: 'desktop' as const,
      browserFamily: 'Chromium',
      countryCode: 'US',
    };
    await db.database()`
      create function delay_concurrent_visit_insert() returns trigger
      language plpgsql as $$
      begin
        perform pg_sleep(0.1);
        return new;
      end;
      $$
    `;
    await db.database()`
      create trigger delay_concurrent_visit_insert
      before insert on visits for each row
      execute function delay_concurrent_visit_insert()
    `;

    // When
    try {
      const [first, second] = await Promise.all([
        startVisit(viewerSessionToken, input),
        startVisit(viewerSessionToken, input),
      ]);

      // Then
      expect(first.kind).toBe('started');
      expect(second.kind).toBe('started');
      if (first.kind !== 'started' || second.kind !== 'started') return;
      expect(first.visitId).toBe(second.visitId);
      const [openVisits, startedAudits] = await Promise.all([
        db.database()<{ count: number }[]>`
          select count(*)::integer as count from visits
          where viewer_session_id = (
            select id from viewer_sessions where token_hash = ${hashOpaqueToken(viewerSessionToken)}
          ) and ended_at is null
        `,
        db.database()<{ count: number }[]>`
          select count(*)::integer as count from audit_log
          where actor_viewer_session_id = (
            select id from viewer_sessions where token_hash = ${hashOpaqueToken(viewerSessionToken)}
          ) and action = 'visit.started'
        `,
      ]);
      expect(openVisits[0]?.count).toBe(1);
      expect(startedAudits[0]?.count).toBe(1);
    } finally {
      await db.database()`drop trigger if exists delay_concurrent_visit_insert on visits`;
      await db.database()`drop function if exists delay_concurrent_visit_insert()`;
    }
  });
});
