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
import { z } from 'zod';

// Mocks must come before importing the middleware module.
vi.mock('./session.ts', () => ({
  lookupSession: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('./jwt.ts', () => ({
  verifyAccessToken: vi.fn(() => Promise.reject(new Error('not configured'))),
}));

import { lookupSession } from './session.ts';
import { verifyAccessToken } from './jwt.ts';
import { resolveAuth, requireAuth, type AuthVariables, SESSION_COOKIE_NAME } from './middleware.ts';

const BASE = 'http://localhost';

const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  handle: z.string().nullable(),
  authMethod: z.enum(['cookie', 'bearer']),
});
const authErrorSchema = z.object({ error: z.string(), message: z.string() });
const protectedResponseSchema = z.object({ ok: z.literal(true), user: authUserSchema });

async function parseJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await res.json());
}

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

describe('requireAuth', () => {
  it('returns 401 with structured JSON when c.var.user is null', async () => {
    const app = makeTestApp();
    const res = await app.fetch(new Request(`${BASE}/private`));
    expect(res.status).toBe(401);
    const body = await parseJson(res, authErrorSchema);
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
    const body = await parseJson(res, protectedResponseSchema);
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
    const body = await parseJson(res, authErrorSchema);
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
    const body = await parseJson(res, authErrorSchema);
    expect(body.error).toBe('unauthorized');
  });
});
