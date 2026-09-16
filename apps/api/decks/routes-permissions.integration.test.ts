import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { app } from '../app.ts';
import { SESSION_COOKIE_NAME } from '../auth/middleware.ts';
import { createSession } from '../auth/session.ts';
import * as db from '../db.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_deck_routes_permissions_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('deck permission routes', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let ownerCookie = '';
  let memberCookie = '';
  let memberId = '';
  let deckId = '';

  beforeAll(async () => {
    // Given
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    const owner = await db.upsertUser({
      email: 'permission-owner@pagent.test',
      handle: 'permission-owner',
      name: 'Permission Owner',
      avatarUrl: null,
    });
    const member = await db.upsertUser({
      email: 'member@pagent.test',
      handle: 'member',
      name: 'Member',
      avatarUrl: null,
    });
    memberId = member.id;
    ownerCookie = `${SESSION_COOKIE_NAME}=${await createSession(owner.id)}`;
    memberCookie = `${SESSION_COOKIE_NAME}=${await createSession(member.id)}`;
    const published = await api({
      path: '/v1/decks',
      method: 'POST',
      cookie: ownerCookie,
      body: {
        title: 'Private analytics',
        slides: [{ id: 'cover', html: '<h1>Private analytics</h1>' }],
      },
    });
    deckId = z.object({ deckId: z.string().uuid() }).parse(await published.json()).deckId;
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('separates content access from analytics and removes analytics grants immediately', async () => {
    // When
    const added = await api({
      path: `/v1/decks/${deckId}/access/members`,
      method: 'POST',
      cookie: ownerCookie,
      body: { email: 'member@pagent.test', role: 'member' },
    });
    const collaborated = await api({
      path: `/v1/decks/${deckId}/access/collaborators`,
      method: 'PUT',
      cookie: ownerCookie,
      body: { memberIds: [memberId] },
    });
    const content = await api({
      path: `/v1/decks/${deckId}/preview`,
      method: 'GET',
      cookie: memberCookie,
    });
    const privateAnalytics = await api({
      path: `/v1/decks/${deckId}/analytics`,
      method: 'GET',
      cookie: memberCookie,
    });

    // Then
    expect(added.status).toBe(201);
    expect(collaborated.status).toBe(204);
    expect(content.status).toBe(200);
    expect(privateAnalytics.status).toBe(403);

    // When
    const audience = await api({
      path: `/v1/decks/${deckId}/access/analytics/preview`,
      method: 'POST',
      cookie: ownerCookie,
      body: { scope: 'selected', subjectIds: [memberId] },
    });
    const granted = await api({
      path: `/v1/decks/${deckId}/access/analytics`,
      method: 'PUT',
      cookie: ownerCookie,
      body: { scope: 'selected', subjectIds: [memberId] },
    });
    const visible = await api({
      path: `/v1/decks/${deckId}/analytics`,
      method: 'GET',
      cookie: memberCookie,
    });
    const removed = await api({
      path: `/v1/decks/${deckId}/access/analytics`,
      method: 'PUT',
      cookie: ownerCookie,
      body: { scope: 'private', subjectIds: [] },
    });
    const denied = await api({
      path: `/v1/decks/${deckId}/analytics`,
      method: 'GET',
      cookie: memberCookie,
    });

    // Then
    expect(await audience.json()).toMatchObject({
      scope: 'selected',
      audience: expect.arrayContaining([
        expect.objectContaining({ id: memberId, email: 'member@pagent.test' }),
      ]),
    });
    expect(granted.status).toBe(200);
    expect(visible.status).toBe(200);
    expect(removed.status).toBe(200);
    expect(denied.status).toBe(403);

    // When
    const policy = await api({
      path: `/v1/decks/${deckId}/access/policy`,
      method: 'PUT',
      cookie: ownerCookie,
      body: { consentRequired: true, retentionDays: 90 },
    });
    const settings = await api({
      path: `/v1/decks/${deckId}/access`,
      method: 'GET',
      cookie: ownerCookie,
    });
    const membershipRemoved = await api({
      path: `/v1/decks/${deckId}/access/members/${memberId}`,
      method: 'DELETE',
      cookie: ownerCookie,
    });
    const contentDenied = await api({
      path: `/v1/decks/${deckId}/preview`,
      method: 'GET',
      cookie: memberCookie,
    });
    const exported = await api({
      path: `/v1/decks/${deckId}/analytics.csv`,
      method: 'GET',
      cookie: ownerCookie,
    });
    const audit = await api({
      path: `/v1/decks/${deckId}/audit`,
      method: 'GET',
      cookie: ownerCookie,
    });

    // Then
    expect(policy.status).toBe(204);
    expect(await settings.json()).toMatchObject({
      analyticsVisibility: 'private',
      analyticsConsentRequired: true,
      analyticsRetentionDays: 90,
    });
    expect(membershipRemoved.status).toBe(204);
    expect(contentDenied.status).toBe(403);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('text/csv');
    expect(await audit.json()).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ action: 'analytics.visibility_changed' }),
        expect.objectContaining({ action: 'analytics.policy_changed' }),
        expect.objectContaining({ action: 'workspace.member_removed' }),
        expect.objectContaining({ action: 'analytics.exported' }),
      ]),
    });
  });
});

type ApiInput = {
  readonly path: string;
  readonly method: string;
  readonly cookie: string;
  readonly body?: unknown;
};

async function api(input: ApiInput): Promise<Response> {
  return app.request(input.path, {
    method: input.method,
    headers: {
      cookie: input.cookie,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}
