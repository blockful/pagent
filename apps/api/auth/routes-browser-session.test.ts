import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../schemas.ts';
import { BASE, NOW, SESSION_COOKIE_NAME, app, db } from './routes-test-support.ts';
import { signStateJwt } from './state-jwt.ts';
import { AUTH_TRANSACTION_COOKIE_NAME } from './route-transaction.ts';
import { firstCallArgument } from './test-call-support.ts';

const BROWSER_TRANSACTION_TOKEN = 'routes-browser-transaction-token';
const BROWSER_TRANSACTION_HASH = createHash('sha256')
  .update(BROWSER_TRANSACTION_TOKEN)
  .digest('base64url');

const SESSION_USER_ROW = {
  id: '33333333-4444-5555-6666-777777777777',
  handle: 'alex',
  email: 'alex@blockful.io',
  name: 'Alex Netto',
  avatar_url: 'https://example.com/avatar.png',
  created_at: NOW,
  updated_at: NOW,
};

describe('Browser session login flow', () => {
  beforeAll(() => {
    (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET =
      'test-auth-state-secret-very-long-random-value-32-bytes';
    (env as { GOOGLE_CLIENT_ID: string | undefined }).GOOGLE_CLIENT_ID = 'test-google-client-id';
    (env as { GOOGLE_CLIENT_SECRET: string | undefined }).GOOGLE_CLIENT_SECRET =
      'test-google-client-secret';
    (env as { GOOGLE_REDIRECT_URI: string | undefined }).GOOGLE_REDIRECT_URI =
      'http://localhost/oauth/callback/google';
  });

  beforeEach(() => {
    vi.mocked(db.insertSession).mockReset();
    vi.mocked(db.upsertUser).mockReset();
    vi.mocked(db.upsertGoogleUser).mockReset();
    vi.mocked(db.getUserByHandle).mockReset();
    vi.mocked(db.getActiveMagicLink).mockReset();
    vi.mocked(db.verifyAndConsumeMagicLink).mockReset();
  });

  it('GET /oauth/authorize?browser_session=1 renders login page without other params', async () => {
    const res = await app.fetch(
      new Request(`${BASE}/oauth/authorize?browser_session=1`, {
        headers: { 'x-forwarded-for': '198.51.100.99' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Continue with Google');
    expect(html).toContain('<form method="POST" action="/oauth/magic/send"');
    expect(res.headers.get('set-cookie')).toContain(`${AUTH_TRANSACTION_COOKIE_NAME}=`);
  });

  it('Magic link verify with browser_session=true sets cookie and redirects to /', async () => {
    const magicLink = {
      email: 'alex@blockful.io',
      authorizeContext: {
        browserSession: true,
        browserTransactionHash: BROWSER_TRANSACTION_HASH,
      },
    };
    vi.mocked(db.getActiveMagicLink).mockResolvedValueOnce(magicLink);
    vi.mocked(db.verifyAndConsumeMagicLink).mockResolvedValueOnce(magicLink);
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValueOnce(SESSION_USER_ROW);
    vi.mocked(db.insertSession).mockResolvedValueOnce(undefined);
    const res = await app.fetch(
      new Request(`${BASE}/oauth/magic?token=browser-flow-token`, {
        headers: {
          'user-agent': 'MockBrowser/1.0',
          'x-forwarded-for': '10.5.0.1, 100.64.0.2',
          cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${BROWSER_TRANSACTION_TOKEN}`,
        },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie?.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie?.toLowerCase()).toContain('max-age=2592000');
    expect(db.insertSession).toHaveBeenCalledTimes(1);
    const insertArg = firstCallArgument(vi.mocked(db.insertSession).mock.calls, 'insertSession');
    expect(insertArg.userId).toBe(SESSION_USER_ROW.id);
    expect(insertArg.ipAddress).toBe('10.5.0.1');
    expect(insertArg.userAgent).toBe('MockBrowser/1.0');
    expect(db.insertAuthCode).not.toHaveBeenCalled();
  });

  it('Google callback with browser_session=true sets cookie and redirects to /', async () => {
    const browserState = await signStateJwt({
      browserSession: true,
      browserTransactionHash: BROWSER_TRANSACTION_HASH,
    });
    const rsaPair = generateKeyPairSync('rsa', { modulusLength: 2048 }) as {
      publicKey: KeyObject;
      privateKey: KeyObject;
    };
    const publicJwk = await exportJWK(rsaPair.publicKey);
    const jwksDoc = {
      keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid: 'browser-test-kid' }],
    };
    const signedIdToken = await new SignJWT({
      sub: 'google-sub-browser',
      email: 'alex@blockful.io',
      email_verified: true,
      name: 'Alex Netto',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'browser-test-kid', typ: 'JWT' })
      .setIssuer('https://accounts.google.com')
      .setAudience('test-google-client-id')
      .setIssuedAt()
      .setExpirationTime('600s')
      .sign(rsaPair.privateKey);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ id_token: signedIdToken, access_token: 'g-at' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('googleapis.com/oauth2/v3/certs')) {
        return new Response(JSON.stringify(jwksDoc), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertGoogleUser).mockResolvedValueOnce({
      kind: 'success',
      user: SESSION_USER_ROW,
    });
    vi.mocked(db.insertSession).mockResolvedValueOnce(undefined);
    try {
      const res = await app.fetch(
        new Request(
          `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(browserState)}`,
          {
            headers: {
              'user-agent': 'MockBrowser/2.0',
              'x-forwarded-for': '203.0.113.77, 100.64.0.3',
              cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${BROWSER_TRANSACTION_TOKEN}`,
            },
          },
        ),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie?.toLowerCase()).toContain('samesite=lax');
      expect(db.insertSession).toHaveBeenCalledTimes(1);
      expect(db.upsertGoogleUser).toHaveBeenCalledWith(
        expect.objectContaining({ googleSubject: 'google-sub-browser' }),
      );
      const insertArg = firstCallArgument(vi.mocked(db.insertSession).mock.calls, 'insertSession');
      expect(insertArg.userId).toBe(SESSION_USER_ROW.id);
      expect(insertArg.ipAddress).toBe('203.0.113.77');
      expect(insertArg.userAgent).toBe('MockBrowser/2.0');
      expect(db.insertAuthCode).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
