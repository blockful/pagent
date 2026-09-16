import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, NOW, SESSION_COOKIE_NAME, app, db } from './routes-test-support.ts';

const SESSION_USER_ROW = {
  id: '33333333-4444-5555-6666-777777777777',
  handle: 'alex',
  email: 'alex@blockful.io',
  name: 'Alex Netto',
  avatar_url: 'https://example.com/avatar.png',
  created_at: NOW,
  updated_at: NOW,
};
const SESSION_LOOKUP_ROW = {
  session_id: 'session-uuid-aabb',
  user_id: SESSION_USER_ROW.id,
  email: SESSION_USER_ROW.email,
  handle: SESSION_USER_ROW.handle,
  expires_at: new Date(Date.now() + 86400_000),
};

describe('GET /auth/me', () => {
  beforeEach(() => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockReset();
    vi.mocked(db.extendSessionExpiry).mockReset();
    vi.mocked(db.getUserById).mockReset();
  });

  it('returns the user profile when a valid session cookie is present', async () => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockResolvedValueOnce(SESSION_LOOKUP_ROW);
    vi.mocked(db.extendSessionExpiry).mockResolvedValueOnce(undefined);
    vi.mocked(db.getUserById).mockResolvedValueOnce(SESSION_USER_ROW);
    const res = await app.fetch(
      new Request(`${BASE}/auth/me`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=valid-session-token` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: SESSION_USER_ROW.id,
      handle: SESSION_USER_ROW.handle,
      email: SESSION_USER_ROW.email,
      name: SESSION_USER_ROW.name,
      avatar_url: SESSION_USER_ROW.avatar_url,
    });
  });

  it('returns 401 when no session cookie is provided', async () => {
    const res = await app.fetch(new Request(`${BASE}/auth/me`));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unauthorized');
    expect(db.getUserById).not.toHaveBeenCalled();
  });

  it('returns 401 when the session cookie is unknown', async () => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockResolvedValueOnce(null);
    const res = await app.fetch(
      new Request(`${BASE}/auth/me`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=stale-or-expired` },
      }),
    );
    expect(res.status).toBe(401);
    expect(db.getUserById).not.toHaveBeenCalled();
  });

  it('returns 401 when the user row vanished after the cookie was issued', async () => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockResolvedValueOnce(SESSION_LOOKUP_ROW);
    vi.mocked(db.extendSessionExpiry).mockResolvedValueOnce(undefined);
    vi.mocked(db.getUserById).mockResolvedValueOnce(null);
    const res = await app.fetch(
      new Request(`${BASE}/auth/me`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=valid-but-orphaned` },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  beforeEach(() => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockReset();
    vi.mocked(db.deleteSessionByTokenHash).mockReset();
    vi.mocked(db.extendSessionExpiry).mockReset();
  });

  it('deletes the DB session and clears the cookie when a session is present', async () => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockResolvedValueOnce(SESSION_LOOKUP_ROW);
    vi.mocked(db.extendSessionExpiry).mockResolvedValueOnce(undefined);
    vi.mocked(db.deleteSessionByTokenHash).mockResolvedValueOnce(undefined);
    const res = await app.fetch(
      new Request(`${BASE}/auth/logout`, {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=raw-cookie-token-abc` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(db.deleteSessionByTokenHash).toHaveBeenCalledTimes(1);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie?.toLowerCase()).toContain('max-age=0');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie?.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
  });

  it('clears the cookie even when no session cookie was sent (idempotent)', async () => {
    const res = await app.fetch(new Request(`${BASE}/auth/logout`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(db.deleteSessionByTokenHash).not.toHaveBeenCalled();
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie?.toLowerCase()).toContain('max-age=0');
  });
});
