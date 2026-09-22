import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.ALLOWED_ORIGINS = 'https://renderer.pagent.test';
});

import { app } from '../app.ts';
import { signAccessToken } from '../auth/jwt.ts';
import { SESSION_COOKIE_NAME } from '../auth/middleware.ts';
import { createSession } from '../auth/session.ts';
import * as db from '../db.ts';
import {
  createDocumentFixture,
  databaseUrl,
  documentDatabaseLifecycle,
  documentHtml,
  rendererOrigin,
  requestDocument,
  setup,
} from './document-test-support.ts';
import { publishDeckBodySchema } from './domain.ts';
import { publishDeck } from './repository-decks.ts';
import { addWorkspaceMember, setDeckCollaborators } from './repository-permissions.ts';
import { hashOpaqueToken } from './tokens.ts';

describe.runIf(databaseUrl !== undefined)('protected HTML document delivery', () => {
  documentDatabaseLifecycle();

  it('serves the exact stored prefix with an isolated frame policy when a viewer is authorized', async () => {
    // Given
    const fixture = await createDocumentFixture();
    // When
    const response = await requestDocument({
      audience: 'viewer',
      fields: { session_token: fixture.sessionToken, revision_id: fixture.revisionId },
    });
    // Then
    expect(response.status).toBe(200);
    const served = await response.text();
    expect(served.startsWith(documentHtml)).toBe(true);
    expect(served).not.toContain(fixture.sessionToken);
    expect(response.headers.get('content-type')?.toLowerCase()).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://renderer.pagent.test",
    );
    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each([
    null,
    'null',
    'https://attacker.test',
    `${rendererOrigin}.attacker.test`,
    `${rendererOrigin}/`,
  ])('denies the request when Origin is %s', async (origin) => {
    // Given
    const fields = { session_token: 'x'.repeat(32), revision_id: randomUUID() };
    // When
    const response = await requestDocument({ audience: 'viewer', fields, origin });
    // Then
    expect(response.status).toBe(403);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(await response.json()).toEqual({ error: 'forbidden' });
  });

  it('rejects malformed fields without reflecting input when a form is invalid', async () => {
    // Given
    const fields = { session_token: '<script>secret</script>', revision_id: 'invalid' };
    // When
    const response = await requestDocument({ audience: 'viewer', fields });
    // Then
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request' });
  });

  it('does not authorize with URL credentials when the form omits its session', async () => {
    // Given
    const fixture = await createDocumentFixture();
    const body = new FormData();
    body.set('revision_id', fixture.revisionId);
    // When
    const response = await app.request(
      `/v1/viewer/document?session_token=${fixture.sessionToken}`,
      { method: 'POST', headers: { origin: rendererOrigin }, body },
    );
    // Then
    expect(response.status).toBe(400);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('returns not found without document content when a viewer session is unknown', async () => {
    // Given
    const fields = { session_token: 'unknown'.padEnd(32, 'x'), revision_id: randomUUID() };
    // When
    const response = await requestDocument({ audience: 'viewer', fields });
    // Then
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });

  it.each([
    'session_expired',
    'session_revoked',
    'link_expired',
    'link_revoked',
    'deleted',
  ] as const)('rechecks access when state changes to %s', async (state) => {
    // Given
    const fixture = await createDocumentFixture();
    switch (state) {
      case 'session_expired':
        await setup`update viewer_sessions set expires_at = now() - interval '1 second' where token_hash = ${hashOpaqueToken(fixture.sessionToken)}`;
        break;
      case 'session_revoked':
        await setup`update viewer_sessions set revoked_at = now() where token_hash = ${hashOpaqueToken(fixture.sessionToken)}`;
        break;
      case 'link_expired':
        await setup`update share_links set expires_at = now() - interval '1 second' where id = ${fixture.linkId}`;
        break;
      case 'link_revoked':
        await setup`update share_links set revoked_at = now() where id = ${fixture.linkId}`;
        break;
      case 'deleted':
        await setup`update decks set deleted_at = now() where id = ${fixture.deckId}`;
        break;
    }
    // When
    const response = await requestDocument({
      audience: 'viewer',
      fields: { session_token: fixture.sessionToken, revision_id: fixture.revisionId },
    });
    // Then
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });

  it('rejects a stale revision when the owner publishes an update', async () => {
    // Given
    const fixture = await createDocumentFixture();
    await publishDeck(
      fixture.owner,
      publishDeckBodySchema.parse({
        title: 'Updated',
        html: '<main>New</main>',
        update_deck_id: fixture.deckId,
      }),
    );
    // When
    const response = await requestDocument({
      audience: 'viewer',
      fields: { session_token: fixture.sessionToken, revision_id: fixture.revisionId },
    });
    // Then
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'revision_changed' });
  });

  it('returns unsupported format when the revision contains legacy slides', async () => {
    // Given
    const fixture = await createDocumentFixture();
    const legacy = await publishDeck(fixture.owner, {
      title: 'Legacy',
      slides: [{ id: 'one', html: '<main>Legacy</main>' }],
    });
    // When
    const response = await requestDocument({
      audience: 'owner',
      fields: { deck_id: legacy.deckId, revision_id: legacy.revisionId },
      headers: { cookie: fixture.cookie },
    });
    // Then
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: 'unsupported_format' });
  });

  it('serves an owner preview when its cookie is authenticated', async () => {
    // Given
    const fixture = await createDocumentFixture();
    // When
    const response = await requestDocument({
      audience: 'owner',
      fields: { deck_id: fixture.deckId, revision_id: fixture.revisionId },
      headers: { cookie: fixture.cookie },
    });
    // Then
    expect(response.status).toBe(200);
    expect((await response.text()).startsWith(documentHtml)).toBe(true);
  });

  it.each(['page:read', 'page:create'])(
    'uses read authorization for an owner POST when bearer scope is %s',
    async (scope) => {
      // Given
      const fixture = await createDocumentFixture();
      const token = await signAccessToken({
        sub: fixture.owner.id,
        email: fixture.owner.email,
        handle: 'frame-owner',
        clientId: 'frame-test',
        scope,
      });
      // When
      const response = await requestDocument({
        audience: 'owner',
        fields: { deck_id: fixture.deckId, revision_id: fixture.revisionId },
        headers: { authorization: `Bearer ${token}` },
      });
      // Then
      expect(response.status).toBe(scope === 'page:read' ? 200 : 403);
    },
  );

  it('requires authentication when an owner request has no credentials', async () => {
    // Given
    const fields = { deck_id: randomUUID(), revision_id: randomUUID() };
    // When
    const response = await requestDocument({ audience: 'owner', fields });
    // Then
    expect(response.status).toBe(401);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it.each([false, true])(
    'enforces content collaboration when a different user has permission %s',
    async (canView) => {
      // Given
      const fixture = await createDocumentFixture();
      const colleague = await db.upsertUser({
        email: 'frame-colleague@pagent.test',
        handle: 'frame-colleague',
        name: 'Colleague',
        avatarUrl: null,
      });
      if (canView) {
        await addWorkspaceMember(fixture.owner.id, fixture.deckId, {
          email: colleague.email,
          role: 'member',
        });
        await setDeckCollaborators(fixture.owner.id, fixture.deckId, [colleague.id]);
      }
      const cookie = `${SESSION_COOKIE_NAME}=${await createSession(colleague.id)}`;
      // When
      const response = await requestDocument({
        audience: 'owner',
        fields: { deck_id: fixture.deckId, revision_id: fixture.revisionId },
        headers: { cookie },
      });
      // Then
      expect(response.status).toBe(canView ? 200 : 403);
    },
  );

  it('keeps framing denied when requesting an unrelated API route', async () => {
    // Given / When
    const response = await app.request('/health');
    // Then
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('caps document requests when one ingress IP exceeds sixty requests', async () => {
    // Given
    const input = {
      audience: 'viewer' as const,
      fields: { session_token: 'unknown'.padEnd(32, 'x'), revision_id: randomUUID() },
      headers: { 'x-real-ip': '203.0.113.222' },
    };
    for (let index = 0; index < 60; index += 1) await requestDocument(input);
    // When
    const response = await requestDocument(input);
    // Then
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });
});
