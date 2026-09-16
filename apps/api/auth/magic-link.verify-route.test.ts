import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

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
  insertMagicLink: vi.fn(),
  verifyAndConsumeMagicLink: vi.fn(),
  insertSession: vi.fn(),
}));

const mockSendMail = vi.fn(async (_message: Record<string, string>) => ({
  messageId: 'test-message-id',
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  },
}));

import * as db from '../db.ts';
import { app } from '../app.ts';
import { BASE, clientRow, setupMagicLinkTest, sha256Hex } from './magic-link-test-support.ts';
import { AUTH_TRANSACTION_COOKIE_NAME } from './route-transaction.ts';
import { firstCallArgument } from './test-call-support.ts';

const BROWSER_TRANSACTION_TOKEN = 'magic-browser-transaction-token';
const BROWSER_TRANSACTION_HASH = createHash('sha256')
  .update(BROWSER_TRANSACTION_TOKEN)
  .digest('base64url');

const browserUser = {
  id: 'browser-user-id',
  handle: 'browser-user',
  email: 'browser@blockful.io',
  name: null,
  avatar_url: null,
  created_at: new Date(),
  updated_at: new Date(),
};

function mockBrowserMagicLink(): void {
  vi.mocked(db.verifyAndConsumeMagicLink).mockResolvedValueOnce({
    email: browserUser.email,
    authorizeContext: {
      browserSession: true,
      browserTransactionHash: BROWSER_TRANSACTION_HASH,
    },
  });
}

setupMagicLinkTest();

describe('GET /oauth/magic', () => {
  it('verifies the token, upserts the user, and redirects with code + state', async () => {
    vi.mocked(db.verifyAndConsumeMagicLink).mockResolvedValueOnce({
      email: 'alex@blockful.io',
      authorizeContext: {
        clientId: clientRow.client_id,
        redirectUri: 'http://localhost:9876/callback',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        scope: 'page:create',
        state: 'mcp-csrf',
      },
    });
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      handle: 'alex',
      email: 'alex@blockful.io',
      name: null,
      avatar_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    vi.mocked(db.insertAuthCode).mockResolvedValue();

    const res = await app.fetch(new Request(`${BASE}/oauth/magic?token=fake-token`));

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    if (location === null) throw new Error('expected callback redirect location');
    const parsed = new URL(location);
    expect(parsed.origin + parsed.pathname).toBe('http://localhost:9876/callback');
    expect(parsed.searchParams.get('code')).toBeTruthy();
    expect(parsed.searchParams.get('state')).toBe('mcp-csrf');

    // The auth code was inserted with the same PKCE challenge from the
    // stored context.
    expect(db.insertAuthCode).toHaveBeenCalledTimes(1);
    const codeArg = firstCallArgument(vi.mocked(db.insertAuthCode).mock.calls, 'insertAuthCode');
    expect(codeArg.userId).toBe('11111111-2222-3333-4444-555555555555');
    expect(codeArg.clientId).toBe(clientRow.client_id);
    expect(codeArg.redirectUri).toBe('http://localhost:9876/callback');
    expect(codeArg.codeChallenge).toBe('challenge');
    expect(codeArg.codeChallengeMethod).toBe('S256');
    expect(codeArg.scope).toBe('page:create');

    // The token was hashed before lookup.
    expect(db.verifyAndConsumeMagicLink).toHaveBeenCalledWith(sha256Hex('fake-token'));
  });

  it('renders an error page when the token is missing', async () => {
    const res = await app.fetch(new Request(`${BASE}/oauth/magic`));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('token');
    expect(db.verifyAndConsumeMagicLink).not.toHaveBeenCalled();
  });

  it('renders an error page for an unknown / expired / consumed token', async () => {
    vi.mocked(db.verifyAndConsumeMagicLink).mockResolvedValueOnce(null);
    const res = await app.fetch(new Request(`${BASE}/oauth/magic?token=bogus`));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('expired');
    // No user upsert when verification fails.
    expect(db.upsertUser).not.toHaveBeenCalled();
  });

  it('renders an error when the client registration changed after the email was sent', async () => {
    vi.mocked(db.verifyAndConsumeMagicLink).mockResolvedValueOnce({
      email: 'alex@blockful.io',
      authorizeContext: {
        clientId: 'no-longer-registered',
        redirectUri: 'http://localhost:9876/callback',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      },
    });
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(null);
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValue({
      id: 'uid',
      handle: 'alex',
      email: 'alex@blockful.io',
      name: null,
      avatar_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await app.fetch(new Request(`${BASE}/oauth/magic?token=t`));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('client');
    // The auth code is NOT issued in this case.
    expect(db.insertAuthCode).not.toHaveBeenCalled();
  });

  it('renders an error when the authorize context has no redirect_uri', async () => {
    vi.mocked(db.verifyAndConsumeMagicLink).mockResolvedValueOnce({
      email: 'alex@blockful.io',
      authorizeContext: {},
    });
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValue({
      id: 'uid',
      handle: 'alex',
      email: 'alex@blockful.io',
      name: null,
      avatar_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await app.fetch(new Request(`${BASE}/oauth/magic?token=t`));
    expect(res.status).toBe(400);
  });

  it('rejects a browser-session link without its transaction cookie before mutation', async () => {
    mockBrowserMagicLink();
    const res = await app.fetch(new Request(`${BASE}/oauth/magic?token=browser-token`));

    expect(res.status).toBe(400);
    expect(db.upsertUser).not.toHaveBeenCalled();
    expect(db.insertSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toContain(`${AUTH_TRANSACTION_COOKIE_NAME}=; Max-Age=0`);
  });

  it('rejects a browser-session link with a mismatched transaction cookie before mutation', async () => {
    mockBrowserMagicLink();
    const res = await app.fetch(
      new Request(`${BASE}/oauth/magic?token=browser-token`, {
        headers: { cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=different-token` },
      }),
    );

    expect(res.status).toBe(400);
    expect(db.upsertUser).not.toHaveBeenCalled();
    expect(db.insertSession).not.toHaveBeenCalled();
  });

  it('accepts a matching browser transaction and clears it after creating the session', async () => {
    mockBrowserMagicLink();
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValue(browserUser);
    vi.mocked(db.insertSession).mockResolvedValue();
    const res = await app.fetch(
      new Request(`${BASE}/oauth/magic?token=browser-token`, {
        headers: {
          cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${BROWSER_TRANSACTION_TOKEN}`,
        },
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(db.upsertUser).toHaveBeenCalledTimes(1);
    expect(db.insertSession).toHaveBeenCalledTimes(1);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${AUTH_TRANSACTION_COOKIE_NAME}=; Max-Age=0`);
    expect(setCookie).toContain('pagent_session=');
  });
});
