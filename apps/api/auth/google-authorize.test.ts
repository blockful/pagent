import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.ts', () => ({
  init: vi.fn(() => Promise.resolve()),
  shutdown: vi.fn(() => Promise.resolve()),
  insertPage: vi.fn(() => Promise.resolve()),
  getActivePage: vi.fn(() => Promise.resolve(null)),
  submitPage: vi.fn(() => Promise.resolve({ kind: 'not_found' })),
  fetchAndAdvanceResult: vi.fn(() => Promise.resolve(null)),
  deletePage: vi.fn(() => Promise.resolve()),
  deleteExpiredPages: vi.fn(() => Promise.resolve({ total: 0, abandoned: 0 })),
  ping: vi.fn().mockResolvedValue(undefined),
  insertOAuthClient: vi.fn(),
  getOAuthClientById: vi.fn(),
  upsertUser: vi.fn(),
  getUserByHandle: vi.fn(),
  insertAuthCode: vi.fn(),
}));

import * as db from '../db.ts';
import { app } from '../app.ts';
import { PUBLIC_URL } from '../app/config.ts';
import { env } from '../schemas.ts';
import {
  authorizeUrl,
  BASE,
  clientRow,
  setupGoogleAuthTest,
  VALID_AUTHORIZE,
} from './google-test-support.ts';
import { AUTH_TRANSACTION_COOKIE_NAME } from './route-transaction.ts';
import { verifyStateJwt } from './state-jwt.ts';

function signedStateFromHtml(html: string): string {
  const match = html.match(/name="state" value="([^"]+)"/);
  if (!match?.[1]) throw new Error('signed state was not rendered');
  return match[1];
}

beforeAll(setupGoogleAuthTest);
beforeEach(() => vi.clearAllMocks());

describe('GET /oauth/authorize', () => {
  it('renders the login page for valid parameters (200, text/html)', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(clientRow);
    const res = await app.fetch(new Request(authorizeUrl(VALID_AUTHORIZE)));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Unverified OAuth client');
    expect(html).toContain(clientRow.client_name);
    expect(html).toContain(VALID_AUTHORIZE.redirect_uri);
    expect(html).toContain('page:create');
    expect(html).toContain('page:read');
    expect(html).toContain('action="/oauth/authorize/consent"');
    expect(html).toContain('name="decision" value="allow"');
    expect(html).toContain('name="decision" value="cancel"');
    expect(html).not.toContain('accounts.google.com');
    expect(html).not.toContain('action="/oauth/magic/send"');

    const cookie = res.headers.get('set-cookie')?.match(/pagent_auth_transaction=([^;]+)/)?.[1];
    if (!cookie) throw new Error('authorization transaction cookie was not set');
    const claims = await verifyStateJwt(signedStateFromHtml(html));
    expect(claims.browserTransactionHash).toBe(
      createHash('sha256').update(cookie).digest('base64url'),
    );
  });

  it('rejects a pre-existing client with an insecure remote HTTP redirect', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce({
      ...clientRow,
      redirect_uris: ['http://attacker.example/callback'],
    });

    const res = await app.fetch(
      new Request(
        authorizeUrl({ ...VALID_AUTHORIZE, redirect_uri: 'http://attacker.example/callback' }),
      ),
    );

    expect(res.status).toBe(400);
    expect(db.getOAuthClientById).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('keeps cancellation local and clears the browser transaction', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    const authorize = await app.fetch(new Request(authorizeUrl(VALID_AUTHORIZE)));
    const html = await authorize.text();
    const cookie = authorize.headers
      .get('set-cookie')
      ?.match(/pagent_auth_transaction=([^;]+)/)?.[1];
    if (!cookie) throw new Error('authorization transaction cookie was not set');

    const denied = await app.fetch(
      new Request(`${BASE}/oauth/authorize/consent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `pagent_auth_transaction=${cookie}`,
        },
        body: new URLSearchParams({
          state: signedStateFromHtml(html),
          decision: 'cancel',
        }),
      }),
    );

    expect(denied.status).toBe(200);
    expect(denied.headers.get('location')).toBeNull();
    expect(await denied.text()).toContain('Authorization cancelled');
    expect(denied.headers.get('set-cookie')).toContain('pagent_auth_transaction=; Max-Age=0');
  });

  it('rejects consent without the browser transaction cookie', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    const authorize = await app.fetch(new Request(authorizeUrl(VALID_AUTHORIZE)));
    const pendingHtml = await authorize.text();

    const allowed = await app.fetch(
      new Request(`${BASE}/oauth/authorize/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          state: signedStateFromHtml(pendingHtml),
          decision: 'allow',
        }),
      }),
    );

    expect(allowed.status).toBe(400);
    expect(await allowed.text()).toContain('Authorization session expired or invalid');
    expect(allowed.headers.get('set-cookie')).toContain('pagent_auth_transaction=; Max-Age=0');
  });

  it('renders sign-in choices only after an explicit cookie-bound allow decision', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    const authorize = await app.fetch(new Request(authorizeUrl(VALID_AUTHORIZE)));
    const pendingHtml = await authorize.text();
    const cookie = authorize.headers
      .get('set-cookie')
      ?.match(/pagent_auth_transaction=([^;]+)/)?.[1];
    if (!cookie) throw new Error('authorization transaction cookie was not set');

    const allowed = await app.fetch(
      new Request(`${BASE}/oauth/authorize/consent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `pagent_auth_transaction=${cookie}`,
        },
        body: new URLSearchParams({
          state: signedStateFromHtml(pendingHtml),
          decision: 'allow',
        }),
      }),
    );

    expect(allowed.status).toBe(200);
    const loginHtml = await allowed.text();
    expect(loginHtml).toContain('accounts.google.com');
    expect(loginHtml).toContain('action="/oauth/magic/send"');
    const allowedState = await verifyStateJwt(signedStateFromHtml(loginHtml));
    expect(allowedState.consentGranted).toBe(true);
    expect(allowedState.browserTransactionHash).toBe(
      createHash('sha256').update(cookie).digest('base64url'),
    );
  });

  it('renders an error (not redirect) for invalid client_id', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(null);
    const res = await app.fetch(
      new Request(authorizeUrl({ ...VALID_AUTHORIZE, client_id: 'nonexistent' })),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Unknown client_id');
    expect(html).not.toContain('Continue with Google');
  });

  it('renders an error for mismatched redirect_uri', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(clientRow);
    const res = await app.fetch(
      new Request(
        authorizeUrl({ ...VALID_AUTHORIZE, redirect_uri: 'http://attacker.example.com/cb' }),
      ),
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('redirect_uri does not match');
  });

  it('renders an error when code_challenge is missing', async () => {
    const params: Record<string, string> = { ...VALID_AUTHORIZE };
    delete (params as { code_challenge?: string }).code_challenge;
    const res = await app.fetch(new Request(authorizeUrl(params)));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('code_challenge');
  });

  it('rejects a missing response_type for an OAuth client request', async () => {
    const params = Object.fromEntries(
      Object.entries(VALID_AUTHORIZE).filter(([key]) => key !== 'response_type'),
    );

    const res = await app.fetch(new Request(authorizeUrl(params)));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('response_type must be code');
  });

  it('rejects an unsupported response_type for an OAuth client request', async () => {
    const res = await app.fetch(
      new Request(authorizeUrl({ ...VALID_AUTHORIZE, response_type: 'token' })),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('response_type must be code');
  });

  it('renders an error for code_challenge_method=plain', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(clientRow);
    const res = await app.fetch(
      new Request(authorizeUrl({ ...VALID_AUTHORIZE, code_challenge_method: 'plain' })),
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('S256');
  });

  it('renders the login page for browser_session=1 without other params', async () => {
    const res = await app.fetch(new Request(`${BASE}/oauth/authorize?browser_session=1`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Continue with Google');
  });

  it('binds a trusted browser return target into the signed state', async () => {
    const returnTo = 'http://localhost:8788/share/opaque-token';

    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/authorize?${new URLSearchParams({ browser_session: '1', return_to: returnTo })}`,
      ),
    );

    expect(res.status).toBe(200);
    const claims = await verifyStateJwt(signedStateFromHtml(await res.text()));
    expect(claims.returnTo).toBe(returnTo);
    expect(claims.browserTransactionHash).toBeTruthy();
  });

  it('replaces an untrusted browser return target with the renderer origin', async () => {
    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/authorize?${new URLSearchParams({
          browser_session: '1',
          return_to: 'https://attacker.example/steal',
        })}`,
      ),
    );

    expect(res.status).toBe(200);
    const claims = await verifyStateJwt(signedStateFromHtml(await res.text()));
    expect(claims.returnTo).toBe(PUBLIC_URL);
  });

  it('uses the documented default scope when scope is omitted', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(clientRow);
    const params = Object.fromEntries(
      Object.entries(VALID_AUTHORIZE).filter(([key]) => key !== 'scope'),
    );
    const res = await app.fetch(new Request(authorizeUrl(params)));
    const claims = await verifyStateJwt(signedStateFromHtml(await res.text()));
    expect(claims.scope).toBe('page:create page:read');
  });

  it('rejects an unsupported requested scope', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(clientRow);
    const res = await app.fetch(
      new Request(authorizeUrl({ ...VALID_AUTHORIZE, scope: 'page:create page:admin' })),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Unsupported scope: page:admin');
  });

  it('deduplicates scopes into canonical order', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(clientRow);
    const res = await app.fetch(
      new Request(authorizeUrl({ ...VALID_AUTHORIZE, scope: 'page:read page:create page:read' })),
    );
    const claims = await verifyStateJwt(signedStateFromHtml(await res.text()));
    expect(claims.scope).toBe('page:create page:read');
  });

  it('starts a secure browser transaction for browser-session login', async () => {
    const originalNodeEnv = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const res = await app.fetch(new Request(`${BASE}/oauth/authorize?browser_session=1`));
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain(`${AUTH_TRANSACTION_COOKIE_NAME}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/oauth');
      expect(setCookie).toContain('Max-Age=900');
      const claims = await verifyStateJwt(signedStateFromHtml(await res.text()));
      expect(claims.browserSession).toBe(true);
      expect(claims.browserTransactionHash).toBeTruthy();
    } finally {
      env.NODE_ENV = originalNodeEnv;
    }
  });
});

describe('GET /oauth/authorize rate limit', () => {
  it('rate-limits at 30 per IP per minute (31st request → 429)', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    const ip = '198.51.100.42';
    const req = () => new Request(authorizeUrl(VALID_AUTHORIZE), { headers: { 'x-real-ip': ip } });
    for (let i = 0; i < 30; i++) {
      const res = await app.fetch(req());
      expect(res.status, `request ${i + 1} of 30 should be 200`).toBe(200);
    }
    const limited = await app.fetch(req());
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body.error).toBe('rate_limited');
  });
});
