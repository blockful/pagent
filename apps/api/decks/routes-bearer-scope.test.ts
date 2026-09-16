import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session.ts', () => ({ lookupSession: vi.fn(async () => null) }));
vi.mock('../auth/jwt.ts', () => ({ verifyAccessToken: vi.fn() }));

import { verifyAccessToken } from '../auth/jwt.ts';
import { resolveAuth, type AuthVariables } from '../auth/middleware.ts';
import { ownerDeckRoutes } from './routes-owner.ts';
import { permissionRoutes } from './routes-permissions.ts';
import { ownerSharingRoutes } from './routes-sharing-owner.ts';
import { workspaceAdminRoutes } from './routes-workspace-admin.ts';

const deckId = '11111111-1111-4111-8111-111111111111';

function claims(scope: string) {
  return {
    sub: 'scoped-user',
    email: 'scoped@example.com',
    handle: 'scoped',
    client_id: 'security-test',
    scope,
    iss: 'http://test.local',
    aud: 'http://test.local',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: `jti-${scope}`,
  };
}

function makeApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', resolveAuth());
  app.route('/v1', ownerDeckRoutes);
  app.route('/v1', ownerSharingRoutes);
  app.route('/v1', permissionRoutes);
  app.route('/v1', workspaceAdminRoutes);
  return app;
}

async function request(path: string, method: string, scope: string) {
  vi.mocked(verifyAccessToken).mockResolvedValueOnce(claims(scope));
  return makeApp().request(path, {
    method,
    headers: { authorization: 'Bearer valid.jwt' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('protected Page REST Bearer scopes', () => {
  it.each([
    ['/v1/decks', 'GET'],
    [`/v1/decks/${deckId}/share-links`, 'GET'],
    [`/v1/decks/${deckId}/access`, 'GET'],
    ['/v1/workspace', 'GET'],
  ])('requires page:read for %s %s', async (path, method) => {
    const response = await request(path, method, 'page:create');
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain('scope="page:read"');
    expect(await response.json()).toMatchObject({ error: 'insufficient_scope' });
  });

  it.each([
    ['/v1/decks', 'POST'],
    [`/v1/decks/${deckId}/share-links`, 'POST'],
    [`/v1/decks/${deckId}/access/policy`, 'PUT'],
    ['/v1/workspace/members', 'POST'],
  ])('requires page:create for %s %s', async (path, method) => {
    const response = await request(path, method, 'page:read');
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain('scope="page:create"');
    expect(await response.json()).toMatchObject({ error: 'insufficient_scope' });
  });
});
