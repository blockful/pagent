import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { app } from '../app.ts';
import { SESSION_COOKIE_NAME } from '../auth/middleware.ts';
import { createSession } from '../auth/session.ts';
import * as db from '../db.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

const databaseUrl = integrationDatabaseUrl('pagent_deck_routes_sharing_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);
const publishedSchema = z.object({ deckId: z.string().uuid() });
const createdLinkSchema = z.object({ id: z.string().uuid(), token: z.string().min(20) });
const sessionSchema = z.object({ kind: z.literal('granted'), sessionToken: z.string().min(20) });
const anonymousSessionSchema = sessionSchema.extend({ identityConfidence: z.literal('anonymous') });

integration('deck sharing routes', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let ownerCookie = '';
  let editorCookie = '';
  let editorId = '';
  let viewerCookie = '';
  let deckId = '';

  beforeAll(async () => {
    // Given
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    const owner = await db.upsertUser({
      email: 'sharing-owner@pagent.test',
      handle: 'sharing-owner',
      name: 'Sharing Owner',
      avatarUrl: null,
    });
    const viewer = await db.upsertUser({
      email: 'viewer@pagent.test',
      handle: 'viewer',
      name: 'Viewer',
      avatarUrl: null,
    });
    const editor = await db.upsertUser({
      email: 'editor@pagent.test',
      handle: 'editor',
      name: 'Editor',
      avatarUrl: null,
    });
    editorId = editor.id;
    ownerCookie = `${SESSION_COOKIE_NAME}=${await createSession(owner.id)}`;
    editorCookie = `${SESSION_COOKIE_NAME}=${await createSession(editor.id)}`;
    viewerCookie = `${SESSION_COOKIE_NAME}=${await createSession(viewer.id)}`;
    const response = await ownerRequest('/v1/decks', 'POST', {
      title: 'Sharing launch',
      slides: [{ id: 'cover', html: '<h1>Sharing launch</h1>' }],
    });
    deckId = publishedSchema.parse(await response.json()).deckId;
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('supports anyone, unverified email, and authenticated viewer modes', async () => {
    // Given
    const anyone = await createLink({ name: 'Public', access_mode: 'anyone' });
    const allowed = await createLink({
      name: 'Northstar buyer',
      access_mode: 'allowed_email',
      allowed_emails: ['allowed@pagent.test'],
    });
    const authenticated = await createLink({
      name: 'Confidential',
      access_mode: 'authenticated',
      allowed_domains: ['pagent.test'],
    });

    // When
    const metadata = await shareRequest({ path: '/v1/share', method: 'GET', token: anyone.token });
    const anonymousAccess = await shareRequest({
      path: '/v1/share/access',
      method: 'POST',
      token: anyone.token,
      body: {},
    });
    const allowedAccess = await shareRequest({
      path: '/v1/share/access',
      method: 'POST',
      token: allowed.token,
      body: { email: 'ALLOWED@PAGENT.TEST' },
    });
    const authenticationGate = await shareRequest({
      path: '/v1/share/access',
      method: 'POST',
      token: authenticated.token,
      body: { email: 'viewer@pagent.test' },
    });
    const authenticatedAccess = await shareRequest({
      path: '/v1/share/access',
      method: 'POST',
      token: authenticated.token,
      body: { email: 'viewer@pagent.test' },
      cookie: viewerCookie,
    });

    // Then
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      deckTitle: 'Sharing launch',
      senderEmail: 'sharing-owner@pagent.test',
      accessMode: 'anyone',
      state: 'active',
    });
    expect(await anonymousAccess.json()).toMatchObject({
      kind: 'granted',
      identityConfidence: 'anonymous',
    });
    expect(await allowedAccess.json()).toMatchObject({
      kind: 'granted',
      identityConfidence: 'unverified',
    });
    expect(await authenticationGate.json()).toEqual({ kind: 'authentication_required' });
    expect(await authenticatedAccess.json()).toMatchObject({
      kind: 'granted',
      identityConfidence: 'authenticated',
    });
  });

  it('keeps request responses generic and approvals under the original link mode', async () => {
    // Given
    const link = await createLink({
      name: 'Requestable',
      access_mode: 'allowed_email',
      allowed_emails: ['first@pagent.test'],
    });

    // When
    const requested = await shareRequest({
      path: '/v1/share/request',
      method: 'POST',
      token: link.token,
      body: { email: 'outsider@pagent.test' },
    });
    const requestId = z
      .object({ requestId: z.string().uuid() })
      .parse(await requested.json()).requestId;
    const decided = await ownerRequest(
      `/v1/decks/${deckId}/share-links/${link.id}/requests/${requestId}`,
      'POST',
      { decision: 'approved' },
    );
    const granted = await shareRequest({
      path: '/v1/share/access',
      method: 'POST',
      token: link.token,
      body: { email: 'outsider@pagent.test' },
    });

    // Then
    expect(requested.status).toBe(202);
    expect(decided.status).toBe(204);
    expect(await granted.json()).toMatchObject({
      kind: 'granted',
      identityConfidence: 'unverified',
    });
  });

  it('excludes owner previews and blocks an already-open session after revocation', async () => {
    // Given
    const link = await createLink({ name: 'Revocable', access_mode: 'anyone' });
    const access = await shareRequest({
      path: '/v1/share/access',
      method: 'POST',
      token: link.token,
      body: {},
    });
    const session = sessionSchema.parse(await access.json()).sessionToken;

    // When
    const deckBefore = await viewerRequest({
      path: '/v1/viewer/deck',
      method: 'GET',
      token: session,
    });
    const preview = await ownerRequest(
      `/v1/decks/${deckId}/share-links/${link.id}/preview`,
      'POST',
    );
    const previewSession = sessionSchema.parse(await preview.json()).sessionToken;
    const previewVisit = await viewerRequest({
      path: '/v1/viewer/visits',
      method: 'POST',
      token: previewSession,
      body: {
        visible: true,
        interacted: true,
        analyticsConsent: true,
        deviceClass: 'desktop',
        browserFamily: 'Chromium',
        countryCode: null,
      },
    });
    const revoked = await ownerRequest(`/v1/decks/${deckId}/share-links/${link.id}/revoke`, 'POST');
    const deckAfter = await viewerRequest({
      path: '/v1/viewer/deck',
      method: 'GET',
      token: session,
    });

    // Then
    expect(deckBefore.status).toBe(200);
    expect(await deckBefore.json()).toMatchObject({ deckId, preview: false });
    expect(await previewVisit.json()).toEqual({ kind: 'excluded' });
    expect(revoked.status).toBe(204);
    expect(deckAfter.status).toBe(410);
    expect(await deckAfter.json()).toEqual({ error: 'revoked' });
  });

  it('excludes authenticated owners and content editors on normal public links', async () => {
    // Given
    const link = await createLink({ name: 'Normal public link', access_mode: 'anyone' });
    const added = await ownerRequest(`/v1/decks/${deckId}/access/members`, 'POST', {
      email: 'editor@pagent.test',
      role: 'member',
    });
    const collaborated = await ownerRequest(`/v1/decks/${deckId}/access/collaborators`, 'PUT', {
      memberIds: [editorId],
    });
    expect(added.status).toBe(201);
    expect(collaborated.status).toBe(204);

    // When
    const ownerAccess = anonymousSessionSchema.parse(
      await (
        await shareRequest({
          path: '/v1/share/access',
          method: 'POST',
          token: link.token,
          body: {},
          cookie: ownerCookie,
        })
      ).json(),
    );
    const editorAccess = anonymousSessionSchema.parse(
      await (
        await shareRequest({
          path: '/v1/share/access',
          method: 'POST',
          token: link.token,
          body: {},
          cookie: editorCookie,
        })
      ).json(),
    );
    const viewerAccess = anonymousSessionSchema.parse(
      await (
        await shareRequest({
          path: '/v1/share/access',
          method: 'POST',
          token: link.token,
          body: {},
          cookie: viewerCookie,
        })
      ).json(),
    );
    const ownerVisit = await viewerRequest({
      path: '/v1/viewer/visits',
      method: 'POST',
      token: ownerAccess.sessionToken,
      body: visitBody(),
    });
    const editorVisit = await viewerRequest({
      path: '/v1/viewer/visits',
      method: 'POST',
      token: editorAccess.sessionToken,
      body: visitBody(),
    });
    const viewerVisit = await viewerRequest({
      path: '/v1/viewer/visits',
      method: 'POST',
      token: viewerAccess.sessionToken,
      body: visitBody(),
    });

    // Then
    expect(await ownerVisit.json()).toEqual({ kind: 'excluded' });
    expect(await editorVisit.json()).toEqual({ kind: 'excluded' });
    expect(await viewerVisit.json()).toMatchObject({ kind: 'started' });
  });

  it('denies another workspace user access to a link request queue', async () => {
    // Given
    const link = await createLink({ name: 'Private queue', access_mode: 'anyone' });

    // When
    const response = await app.request(
      `/v1/decks/${deckId}/share-links/${link.id}/requests`,
      requestInit('GET', undefined, { cookie: viewerCookie }),
    );

    // Then
    expect(response.status).toBe(403);
  });

  async function createLink(body: unknown): Promise<{ id: string; token: string }> {
    const response = await ownerRequest(`/v1/decks/${deckId}/share-links`, 'POST', body);
    expect(response.status).toBe(201);
    return createdLinkSchema.parse(await response.json());
  }

  async function ownerRequest(path: string, method: string, body?: unknown): Promise<Response> {
    return app.request(path, requestInit(method, body, { cookie: ownerCookie }));
  }

  type TokenRequest = {
    readonly path: string;
    readonly method: string;
    readonly token: string;
    readonly body?: unknown;
    readonly cookie?: string;
  };

  async function shareRequest(input: TokenRequest): Promise<Response> {
    return app.request(
      input.path,
      requestInit(input.method, input.body, {
        'x-share-token': input.token,
        cookie: input.cookie,
      }),
    );
  }

  async function viewerRequest(input: TokenRequest): Promise<Response> {
    return app.request(
      input.path,
      requestInit(input.method, input.body, {
        'x-viewer-session': input.token,
      }),
    );
  }
});

function requestInit(
  method: string,
  body: unknown,
  headers: Readonly<Record<string, string | undefined>>,
): RequestInit {
  const cleanHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) cleanHeaders.set(name, value);
  }
  if (body !== undefined) cleanHeaders.set('content-type', 'application/json');
  return {
    method,
    headers: cleanHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function visitBody() {
  return {
    visible: true,
    interacted: true,
    analyticsConsent: true,
    deviceClass: 'desktop',
    browserFamily: 'Chromium',
    countryCode: null,
  };
}
