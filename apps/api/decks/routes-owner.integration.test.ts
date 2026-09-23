import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { app } from '../app.ts';
import { SESSION_COOKIE_NAME } from '../auth/middleware.ts';
import { createSession } from '../auth/session.ts';
import * as db from '../db.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_deck_routes_owner_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('authenticated deck routes', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let cookie = '';
  let deckId = '';

  beforeAll(async () => {
    // Given
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    const owner = await db.upsertUser({
      email: 'route-owner@pagent.test',
      handle: 'route-owner',
      name: 'Route Owner',
      avatarUrl: null,
    });
    const session = await createSession(owner.id);
    cookie = `${SESSION_COOKIE_NAME}=${session}`;
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('rejects NUL-containing HTML before attempting text persistence', async () => {
    const response = await request('/v1/decks', 'POST', {
      title: 'Invalid text',
      html: '<main>Before\u0000after</main>',
    });
    expect(response.status).toBe(400);
  });

  it('publishes, lists, previews, revises, and manages a deck lifecycle', async () => {
    // When
    const published = await request('/v1/decks', 'POST', {
      title: 'Northstar renewal',
      description: 'A secure proposal',
      client_label: 'Northstar',
      slides: [
        { id: 'cover', title: 'Northstar', html: '<h1>Northstar</h1>' },
        { id: 'plan', title: 'Plan', html: '<h2>Plan</h2>' },
      ],
    });

    // Then
    expect(published.status).toBe(201);
    const created = z
      .object({ deckId: z.string().uuid(), revisionNumber: z.number().int() })
      .parse(await published.json());
    deckId = created.deckId;
    expect(created.revisionNumber).toBe(1);

    // When
    const list = await request('/v1/decks', 'GET');
    const preview = await request(`/v1/decks/${deckId}/preview`, 'GET');
    const revised = await request('/v1/decks', 'POST', {
      title: 'Northstar renewal v2',
      update_deck_id: deckId,
      slides: [{ id: 'cover', html: '<h1>Northstar v2</h1>' }],
    });
    const renamed = await request(`/v1/decks/${deckId}`, 'PATCH', { title: 'Northstar final' });
    const archived = await request(`/v1/decks/${deckId}/archive`, 'POST');
    const restored = await request(`/v1/decks/${deckId}/restore`, 'POST');
    const detail = await request(`/v1/decks/${deckId}`, 'GET');

    // Then
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      decks: [{ id: deckId, title: 'Northstar renewal' }],
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      deckId,
      revisionNumber: 1,
      slides: [{ stableSlideId: 'cover' }, { stableSlideId: 'plan' }],
    });
    expect(revised.status).toBe(200);
    expect(await revised.json()).toMatchObject({ deckId, revisionNumber: 2 });
    expect(renamed.status).toBe(204);
    expect(archived.status).toBe(204);
    expect(restored.status).toBe(204);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: deckId,
      title: 'Northstar final',
      latestRevisionNumber: 2,
      revisions: [{ revisionNumber: 2 }, { revisionNumber: 1 }],
    });

    // When
    const removed = await request(`/v1/decks/${deckId}`, 'DELETE');
    const unavailable = await request(`/v1/decks/${deckId}/preview`, 'GET');

    // Then
    expect(removed.status).toBe(204);
    expect(unavailable.status).toBe(403);
  });

  async function request(path: string, method: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
});
