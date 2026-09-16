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
    expect(html).toContain('Continue with Google');
    expect(html).toContain('accounts.google.com');
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
    const req = () =>
      new Request(authorizeUrl(VALID_AUTHORIZE), { headers: { 'x-forwarded-for': ip } });
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
