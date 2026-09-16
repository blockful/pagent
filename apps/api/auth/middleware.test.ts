/**
 * Hono auth middleware unit tests.
 *
 * Boots a tiny Hono app in-process, mounts `resolveAuth()` on every route,
 * and `requireAuth()` on a designated protected route. The session.ts and
 * jwt.ts modules are mocked so we can drive the resolution behaviour
 * directly: a stub returns a user, the middleware should set c.var.user;
 * a stub returns null, the middleware should set c.var.user to null.
 *
 * The test app deliberately avoids importing app.ts — we want this test
 * isolated from the rest of the API surface (otherwise we'd be retesting
 * cors, secureHeaders, rate limiting, etc.).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mocks must come before importing the middleware module.
vi.mock('./session.ts', () => ({
  lookupSession: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('./jwt.ts', () => ({
  verifyAccessToken: vi.fn(() => Promise.reject(new Error('not configured'))),
}));

import { lookupSession } from './session.ts';
import { verifyAccessToken } from './jwt.ts';
import {
  resolveAuth,
  requireAuth,
  type AuthUser,
  type AuthVariables,
  SESSION_COOKIE_NAME,
} from './middleware.ts';

const BASE = 'http://localhost';

/**
 * Build a fresh test app for each case so c.var doesn't leak between tests.
 * `/me` echoes c.var.user; `/private` is gated by requireAuth() so a 401 is
 * the expected outcome for an anonymous request.
 */
function makeTestApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', resolveAuth());
  app.get('/me', (c) => c.json(c.var.user));
  app.get('/private', requireAuth(), (c) => c.json({ ok: true, user: c.var.user }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: every fake returns "not authenticated".
  (lookupSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (verifyAccessToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not configured'));
});

describe('resolveAuth — cookie path', () => {
  it('sets c.var.user from a valid session cookie', async () => {
    const fakeUser: AuthUser = {
      id: 'user-uuid-1',
      email: 'alex@blockful.io',
      handle: 'alex',
      authMethod: 'cookie',
    };
    (lookupSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakeUser);
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=session-token-1` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('user-uuid-1');
    expect(body.authMethod).toBe('cookie');
    expect(lookupSession).toHaveBeenCalledWith('session-token-1');
    // Bearer path should not have been consulted once a cookie resolved.
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('falls through to anonymous when the session cookie is unknown', async () => {
    (lookupSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=stale-or-expired` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });
});

describe('resolveAuth — Bearer path', () => {
  it('sets c.var.user from a valid Bearer JWT', async () => {
    (verifyAccessToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sub: 'user-uuid-2',
      email: 'bob@example.com',
      handle: 'bob',
      client_id: 'mcp-cli',
      scope: 'page:create page:read',
      iss: 'http://test.local',
      aud: 'http://test.local',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: 'jti-1',
    });
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: { authorization: 'Bearer valid.jwt.token' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('user-uuid-2');
    expect(body.email).toBe('bob@example.com');
    expect(body.handle).toBe('bob');
    expect(body.authMethod).toBe('bearer');
    expect(verifyAccessToken).toHaveBeenCalledWith('valid.jwt.token');
  });

  it('falls through to anonymous when Bearer JWT verification fails', async () => {
    (verifyAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('expired'));
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: { authorization: 'Bearer bad.jwt.token' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });

  it('ignores a non-Bearer Authorization header', async () => {
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('ignores an empty Bearer token (just the prefix)', async () => {
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: { authorization: 'Bearer ' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('handles null handle in JWT claims (handle is nullable per schema)', async () => {
    (verifyAccessToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sub: 'user-uuid-3',
      email: 'newbie@example.com',
      handle: '', // Empty string from a fresh signup that hasn't picked a handle yet
      client_id: 'mcp-cli',
      scope: 'page:create',
      iss: 'http://test.local',
      aud: 'http://test.local',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: 'jti-2',
    });
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: { authorization: 'Bearer valid.jwt' },
      }),
    );
    const body = await res.json();
    expect(body.handle).toBeNull();
  });
});

describe('resolveAuth — anonymous', () => {
  it('sets c.var.user to null when no cookie and no Authorization header', async () => {
    const app = makeTestApp();
    const res = await app.fetch(new Request(`${BASE}/me`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
    expect(lookupSession).not.toHaveBeenCalled();
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});

describe('resolveAuth — priority', () => {
  it('cookie takes precedence over Bearer when both are present', async () => {
    const fakeUser: AuthUser = {
      id: 'user-from-cookie',
      email: 'cookie@example.com',
      handle: 'cookie-user',
      authMethod: 'cookie',
    };
    (lookupSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakeUser);
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=valid-session`,
          authorization: 'Bearer also.valid.token',
        },
      }),
    );
    const body = await res.json();
    expect(body.id).toBe('user-from-cookie');
    expect(body.authMethod).toBe('cookie');
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});

describe('requireAuth', () => {
  it('returns 401 with structured JSON when c.var.user is null', async () => {
    const app = makeTestApp();
    const res = await app.fetch(new Request(`${BASE}/private`));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.message).toMatch(/auth/i);
    // request_id is populated by the global request-id middleware in app.ts;
    // here we mounted middleware in isolation so the field may be undefined.
    // Whichever it is, it should not crash the response.
  });

  it('passes through when c.var.user is populated', async () => {
    (lookupSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'user-uuid-1',
      email: 'alex@blockful.io',
      handle: 'alex',
      authMethod: 'cookie',
    });
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/private`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=valid-token` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe('user-uuid-1');
  });

  it('returns 401 when Bearer JWT is invalid', async () => {
    (verifyAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bad sig'));
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/private`, {
        headers: { authorization: 'Bearer broken.jwt' },
      }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 when session cookie is expired (lookup returns null)', async () => {
    (lookupSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const app = makeTestApp();
    const res = await app.fetch(
      new Request(`${BASE}/private`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=expired-token` },
      }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });
});
