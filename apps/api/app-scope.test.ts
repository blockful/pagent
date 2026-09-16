import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';

vi.mock('./db.ts', () => ({
  init: vi.fn(() => Promise.resolve()),
  shutdown: vi.fn(() => Promise.resolve()),
  insertPage: vi.fn(() => Promise.resolve()),
  getActivePage: vi.fn(() => Promise.resolve(null)),
  submitPage: vi.fn(() => Promise.resolve({ kind: 'not_found' })),
  fetchAndAdvanceResult: vi.fn(() => Promise.resolve(null)),
  deletePage: vi.fn(() => Promise.resolve()),
  deleteExpiredPages: vi.fn(() => Promise.resolve({ total: 0, abandoned: 0 })),
  ping: vi.fn(() => Promise.resolve()),
}));
vi.mock('./metrics.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./metrics.ts')>();
  return {
    ...actual,
    metrics: {
      httpRequests: { add: vi.fn() },
      httpRequestDuration: { record: vi.fn() },
      pagesCreated: { add: vi.fn() },
      pagesViewed: { add: vi.fn() },
      pagesSubmitted: { add: vi.fn() },
      pagesAbandoned: { add: vi.fn() },
      pageSubmitLatency: { record: vi.fn() },
    },
  };
});
vi.mock('./auth/session.ts', () => ({
  lookupSession: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('./auth/jwt.ts', () => ({
  verifyAccessToken: vi.fn(() => Promise.reject(new Error('invalid token'))),
}));

import * as db from './db.ts';
import { app } from './app.ts';
import { verifyAccessToken } from './auth/jwt.ts';
import { lookupSession } from './auth/session.ts';
import { resolveAuth, SESSION_COOKIE_NAME, type AuthVariables } from './auth/middleware.ts';
import { createNewPageLimiter, registerPageRoutes } from './app/page-routes.ts';
import type { RequestIdVariables } from './request-id.ts';
import { env } from './schemas.ts';

const BASE = 'http://test';
const PAGE_ID = 'a'.repeat(32);
const errorSchema = z.object({ error: z.string() });

function claims(scope: string) {
  return {
    sub: 'api-user',
    email: 'api@example.com',
    handle: 'api-user',
    client_id: 'mcp-cli',
    scope,
    iss: BASE,
    aud: BASE,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: `jti-${scope}`,
  };
}

function makeResultApp(requireAuthEnabled: boolean) {
  const originalRequireAuth = env.REQUIRE_AUTH;
  env.REQUIRE_AUTH = requireAuthEnabled;
  try {
    const routeApp = new Hono<{ Variables: RequestIdVariables & AuthVariables }>();
    routeApp.use('*', resolveAuth());
    registerPageRoutes(routeApp, createNewPageLimiter());
    return routeApp;
  } finally {
    env.REQUIRE_AUTH = originalRequireAuth;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyAccessToken).mockRejectedValue(new Error('invalid token'));
  vi.mocked(lookupSession).mockResolvedValue(null);
  vi.mocked(db.fetchAndAdvanceResult).mockResolvedValue(null);
});

describe('REST OAuth scope enforcement', () => {
  it('denies POST /new when a verified Bearer has only page:read', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(claims('page:read'));
    const res = await app.fetch(
      new Request(`${BASE}/new`, {
        method: 'POST',
        headers: { authorization: 'Bearer read-only', 'content-type': 'application/json' },
        body: JSON.stringify({ spec: {} }),
      }),
    );

    expect(res.status).toBe(403);
    expect(errorSchema.parse(await res.json()).error).toBe('insufficient_scope');
    expect(res.headers.get('WWW-Authenticate')).toContain('scope="page:create"');
    expect(db.insertPage).not.toHaveBeenCalled();
  });

  it('denies GET /:id/result when a verified Bearer has an empty scope', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(claims(''));
    const res = await app.fetch(
      new Request(`${BASE}/${PAGE_ID}/result`, {
        headers: { authorization: 'Bearer empty-scope' },
      }),
    );

    expect(res.status).toBe(403);
    expect(errorSchema.parse(await res.json()).error).toBe('insufficient_scope');
    expect(res.headers.get('WWW-Authenticate')).toContain('scope="page:read"');
    expect(db.fetchAndAdvanceResult).not.toHaveBeenCalled();
  });

  it('allows POST /new when the verified Bearer has page:create', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(claims('page:create'));
    const res = await app.fetch(
      new Request(`${BASE}/new`, {
        method: 'POST',
        headers: { authorization: 'Bearer creator', 'content-type': 'application/json' },
        body: JSON.stringify({ spec: {} }),
      }),
    );

    expect(res.status).toBe(201);
    expect(db.insertPage).toHaveBeenCalledOnce();
  });

  it('allows GET /:id/result when the verified Bearer has page:read', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(claims('page:read'));
    vi.mocked(db.fetchAndAdvanceResult).mockResolvedValueOnce({
      stateAtRead: 'open',
      result: null,
      format: 'a2ui',
    });
    const res = await app.fetch(
      new Request(`${BASE}/${PAGE_ID}/result`, {
        headers: { authorization: 'Bearer reader' },
      }),
    );

    expect(res.status).toBe(200);
  });

  it('allows cookie-authenticated POST /new without OAuth scopes', async () => {
    vi.mocked(lookupSession).mockResolvedValueOnce({
      id: 'browser-user',
      email: 'browser@example.com',
      handle: 'browser',
      authMethod: 'cookie',
    });
    const res = await app.fetch(
      new Request(`${BASE}/new`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=browser-session`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ spec: {} }),
      }),
    );

    expect(res.status).toBe(201);
  });

  it('preserves anonymous POST /new during grace mode', async () => {
    const res = await app.fetch(
      new Request(`${BASE}/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: {} }),
      }),
    );

    expect(res.status).toBe(201);
  });
});

describe('GET /:id/result authentication mode', () => {
  it.each([
    ['anonymous request', undefined],
    ['invalid Bearer', 'Bearer invalid'],
  ])('returns 401 for an %s when authentication is required', async (_name, authorization) => {
    const routeApp = makeResultApp(true);
    const headers = authorization ? { authorization } : undefined;
    const res = await routeApp.fetch(new Request(`${BASE}/${PAGE_ID}/result`, { headers }));

    expect(res.status).toBe(401);
    expect(errorSchema.parse(await res.json()).error).toBe('unauthorized');
    expect(db.fetchAndAdvanceResult).not.toHaveBeenCalled();
  });

  it('returns 403 for a valid Bearer missing page:read when authentication is required', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(claims('page:create'));
    const routeApp = makeResultApp(true);
    const res = await routeApp.fetch(
      new Request(`${BASE}/${PAGE_ID}/result`, {
        headers: { authorization: 'Bearer create-only' },
      }),
    );

    expect(res.status).toBe(403);
    expect(errorSchema.parse(await res.json()).error).toBe('insufficient_scope');
    expect(db.fetchAndAdvanceResult).not.toHaveBeenCalled();
  });

  it('reaches the result handler with page:read when authentication is required', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(claims('page:read'));
    vi.mocked(db.fetchAndAdvanceResult).mockResolvedValueOnce({
      stateAtRead: 'open',
      result: null,
      format: 'a2ui',
    });
    const routeApp = makeResultApp(true);
    const res = await routeApp.fetch(
      new Request(`${BASE}/${PAGE_ID}/result`, {
        headers: { authorization: 'Bearer reader' },
      }),
    );

    expect(res.status).toBe(200);
    expect(db.fetchAndAdvanceResult).toHaveBeenCalledOnce();
  });

  it('preserves anonymous result polling during grace mode', async () => {
    const routeApp = makeResultApp(false);
    const res = await routeApp.fetch(new Request(`${BASE}/${PAGE_ID}/result`));

    expect(res.status).toBe(404);
    expect(db.fetchAndAdvanceResult).toHaveBeenCalledOnce();
  });
});
