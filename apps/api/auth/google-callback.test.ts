import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  upsertGoogleUser: vi.fn(),
  getUserByHandle: vi.fn(),
  insertAuthCode: vi.fn(),
  insertSession: vi.fn(),
}));

import * as db from '../db.ts';
import { app } from '../app.ts';
import { signStateJwt } from './state-jwt.ts';
import {
  BASE,
  clientRow,
  mockGoogleTokenResponse,
  setupGoogleAuthTest,
  VALID_AUTHORIZE,
} from './google-test-support.ts';
import { AUTH_TRANSACTION_COOKIE_NAME } from './route-transaction.ts';

const BROWSER_TRANSACTION_TOKEN = 'browser-transaction-token';
const OAUTH_TRANSACTION_TOKEN = 'oauth-transaction-token';

function browserTransactionHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

async function browserState(): Promise<string> {
  return signStateJwt({
    browserSession: true,
    browserTransactionHash: browserTransactionHash(BROWSER_TRANSACTION_TOKEN),
  });
}

beforeAll(setupGoogleAuthTest);
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('GET /oauth/callback/google', () => {
  it('exchanges the code, upserts the user, and redirects with code+state', async () => {
    const fetchSpy = await mockGoogleTokenResponse({
      sub: 'google-sub-123',
      email: 'alex@blockful.io',
      name: 'Alex Netto',
      picture: 'https://lh3.googleusercontent.com/abc',
    });
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertGoogleUser).mockResolvedValue({
      kind: 'success',
      user: {
        id: '11111111-2222-3333-4444-555555555555',
        handle: 'alex',
        email: 'alex@blockful.io',
        name: 'Alex Netto',
        avatar_url: 'https://lh3.googleusercontent.com/abc',
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    vi.mocked(db.insertAuthCode).mockResolvedValue();
    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
      scope: VALID_AUTHORIZE.scope,
      state: VALID_AUTHORIZE.state,
      browserTransactionHash: browserTransactionHash(OAUTH_TRANSACTION_TOKEN),
      consentGranted: true,
    });
    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${OAUTH_TRANSACTION_TOKEN}`,
          },
        },
      ),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    if (!location) throw new Error('callback redirect location was not recorded');
    const parsed = new URL(location);
    expect(parsed.origin + parsed.pathname).toBe(VALID_AUTHORIZE.redirect_uri);
    expect(parsed.searchParams.get('code')).toBeTruthy();
    expect(parsed.searchParams.get('state')).toBe(VALID_AUTHORIZE.state);
    const tokenCall = fetchSpy.mock.calls.find((call) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('oauth2.googleapis.com/token');
    });
    expect(tokenCall).toBeDefined();
    if (!tokenCall) throw new Error('Google token endpoint was not called');
    expect(tokenCall[1]?.method).toBe('POST');
    expect(db.upsertGoogleUser).toHaveBeenCalledWith(
      expect.objectContaining({
        googleSubject: 'google-sub-123',
        email: 'alex@blockful.io',
        name: 'Alex Netto',
        avatarUrl: 'https://lh3.googleusercontent.com/abc',
      }),
    );
    expect(db.insertAuthCode).toHaveBeenCalledTimes(1);
    const [authCodeArg] = vi.mocked(db.insertAuthCode).mock.calls[0] ?? [];
    if (!authCodeArg) throw new Error('insertAuthCode call was not recorded');
    expect(authCodeArg.userId).toBe('11111111-2222-3333-4444-555555555555');
    expect(authCodeArg.clientId).toBe(VALID_AUTHORIZE.client_id);
    expect(authCodeArg.redirectUri).toBe(VALID_AUTHORIZE.redirect_uri);
    expect(authCodeArg.codeChallenge).toBe(VALID_AUTHORIZE.code_challenge);
    expect(authCodeArg.codeChallengeMethod).toBe('S256');
    fetchSpy.mockRestore();
  });

  it('refuses to auto-link an existing email account to the Google subject', async () => {
    await mockGoogleTokenResponse({
      sub: 'google-sub-unlinked',
      email: 'legacy@blockful.io',
    });
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertGoogleUser).mockResolvedValue({ kind: 'link_required' });
    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
      browserTransactionHash: browserTransactionHash(OAUTH_TRANSACTION_TOKEN),
      consentGranted: true,
    });

    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${OAUTH_TRANSACTION_TOKEN}` } },
      ),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Sign in with an email magic link');
    expect(db.insertAuthCode).not.toHaveBeenCalled();
    expect(db.insertSession).not.toHaveBeenCalled();
  });

  it('rejects an unverified Google email before user mutation', async () => {
    await mockGoogleTokenResponse({
      sub: 'google-sub-unverified',
      email: 'unverified@blockful.io',
      email_verified: false,
    });
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
      browserTransactionHash: browserTransactionHash(OAUTH_TRANSACTION_TOKEN),
      consentGranted: true,
    });

    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${OAUTH_TRANSACTION_TOKEN}` } },
      ),
    );

    expect(res.status).toBe(400);
    expect(db.upsertGoogleUser).not.toHaveBeenCalled();
    expect(db.insertAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a scraped normal OAuth state without the bound browser transaction', async () => {
    const fetchSpy = await mockGoogleTokenResponse({
      sub: 'google-sub-123',
      email: 'victim@blockful.io',
    });
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
      browserTransactionHash: browserTransactionHash(OAUTH_TRANSACTION_TOKEN),
      consentGranted: true,
    });

    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.upsertGoogleUser).not.toHaveBeenCalled();
    expect(db.insertAuthCode).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toContain(`${AUTH_TRANSACTION_COOKIE_NAME}=; Max-Age=0`);
  });

  it('rejects a pending OAuth state even with the matching browser transaction', async () => {
    const fetchSpy = await mockGoogleTokenResponse({
      sub: 'google-sub-123',
      email: 'victim@blockful.io',
    });
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
      browserTransactionHash: browserTransactionHash(OAUTH_TRANSACTION_TOKEN),
    });

    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${OAUTH_TRANSACTION_TOKEN}`,
          },
        },
      ),
    );

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.upsertGoogleUser).not.toHaveBeenCalled();
    expect(db.insertAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a legacy insecure redirect before contacting Google', async () => {
    const fetchSpy = await mockGoogleTokenResponse({
      sub: 'google-sub-123',
      email: 'victim@blockful.io',
    });
    const redirectUri = 'http://attacker.example/callback';
    vi.mocked(db.getOAuthClientById).mockResolvedValue({
      ...clientRow,
      redirect_uris: [redirectUri],
    });
    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
      browserTransactionHash: browserTransactionHash(OAUTH_TRANSACTION_TOKEN),
      consentGranted: true,
    });

    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${OAUTH_TRANSACTION_TOKEN}`,
          },
        },
      ),
    );

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.upsertGoogleUser).not.toHaveBeenCalled();
    expect(db.insertAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a tampered state JWT', async () => {
    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
    });
    const tampered = state.slice(0, -3) + (state.endsWith('AAA') ? 'BBB' : 'AAA');
    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(tampered)}`,
      ),
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('expired or invalid');
  });

  it('rejects callback with missing code', async () => {
    const state = await signStateJwt({ clientId: 'x', redirectUri: 'http://x' });
    const res = await app.fetch(
      new Request(`${BASE}/oauth/callback/google?state=${encodeURIComponent(state)}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects callback with missing state', async () => {
    const res = await app.fetch(new Request(`${BASE}/oauth/callback/google?code=google-code`));
    expect(res.status).toBe(400);
  });

  it('handle collision: appends numeric suffix when base handle is taken', async () => {
    await mockGoogleTokenResponse({
      sub: 'google-sub-456',
      email: 'alex@another.example',
      name: 'Alex Second',
    });
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    vi.mocked(db.getUserByHandle)
      .mockResolvedValueOnce({
        id: 'existing-alex',
        handle: 'alex',
        email: 'alex@first.example',
        name: null,
        avatar_url: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .mockResolvedValueOnce(null);
    vi.mocked(db.upsertGoogleUser).mockResolvedValue({
      kind: 'success',
      user: {
        id: 'new-user',
        handle: 'alex2',
        email: 'alex@another.example',
        name: null,
        avatar_url: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    vi.mocked(db.insertAuthCode).mockResolvedValue();
    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
      browserTransactionHash: browserTransactionHash(OAUTH_TRANSACTION_TOKEN),
      consentGranted: true,
    });
    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${OAUTH_TRANSACTION_TOKEN}`,
          },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(db.upsertGoogleUser).toHaveBeenCalledWith(
      expect.objectContaining({ googleSubject: 'google-sub-456', handle: 'alex2' }),
    );
  });

  it('rejects a browser callback without its transaction cookie before mutation', async () => {
    const state = await browserState();
    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(res.status).toBe(400);
    expect(db.upsertGoogleUser).not.toHaveBeenCalled();
    expect(db.insertSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toContain(`${AUTH_TRANSACTION_COOKIE_NAME}=; Max-Age=0`);
  });

  it('rejects a browser callback with a mismatched transaction cookie before mutation', async () => {
    const state = await browserState();
    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=different-token` } },
      ),
    );
    expect(res.status).toBe(400);
    expect(db.upsertGoogleUser).not.toHaveBeenCalled();
    expect(db.insertSession).not.toHaveBeenCalled();
  });

  it('accepts a matching browser transaction and clears it after creating the session', async () => {
    await mockGoogleTokenResponse({
      sub: 'google-browser-user',
      email: 'browser@blockful.io',
      name: 'Browser User',
    });
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertGoogleUser).mockResolvedValue({
      kind: 'success',
      user: {
        id: 'browser-user-id',
        handle: 'browser-user',
        email: 'browser@blockful.io',
        name: 'Browser User',
        avatar_url: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    vi.mocked(db.insertSession).mockResolvedValue();
    const state = await browserState();
    const res = await app.fetch(
      new Request(
        `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${BROWSER_TRANSACTION_TOKEN}` } },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(db.upsertGoogleUser).toHaveBeenCalledTimes(1);
    expect(db.insertSession).toHaveBeenCalledTimes(1);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${AUTH_TRANSACTION_COOKIE_NAME}=; Max-Age=0`);
    expect(setCookie).toContain('pagent_session=');
  });
});
