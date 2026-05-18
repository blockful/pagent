/**
 * Google OAuth helpers + state JWT + login flow tests.
 *
 * Covers:
 *   - buildGoogleAuthUrl: URL shape, scopes, encoded state
 *   - signStateJwt / verifyStateJwt: round-trip, tampering, expiry
 *   - renderLoginPage: HTML validity, XSS escaping
 *   - GET /oauth/authorize: validates client_id / redirect_uri / PKCE
 *   - GET /oauth/callback/google: exchange + upsert + auth code + redirect
 *
 * The Google token endpoint is mocked via `vi.spyOn(global, 'fetch')`, and the
 * db layer is mocked the same way clients-store.test.ts does so we can run
 * without a live Postgres.
 */
import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocking db.ts has to happen BEFORE we import anything that transitively
// pulls it in (app.ts, routes.ts). Every function the routes touch is
// stubbed; the auth-code happy path checks the calls per-test.
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
import { env } from '../schemas.ts';
import { app } from '../app.ts';
import { initKeys } from './jwt.ts';
import { buildGoogleAuthUrl } from './google.ts';
import { renderLoginPage } from './login-page.ts';
import { signStateJwt, verifyStateJwt } from './state-jwt.ts';
import {
  sanitizeHandle,
  generateUniqueHandle,
  upsertUser,
  createAuthCode,
} from './provider.ts';

const BASE = 'http://localhost';

// --- Setup -------------------------------------------------------------------
// Env vars need to be set on the parsed env object — the schema parse already
// ran at module import. Mutating the in-memory copy is what jwt.test.ts does
// to flip PUBLIC_URL; same pattern here for the auth secrets.

beforeAll(async () => {
  // Ed25519 keys for the access-token signer (consumed by the well-known JWKS
  // route — not exercised here but required so app.ts boots cleanly).
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await initKeys(
    privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  );
  // Set the auth secrets in-memory. The schema's optional() means they default
  // to undefined; tests need them populated to exercise the signing path.
  (env as { GOOGLE_CLIENT_ID: string | undefined }).GOOGLE_CLIENT_ID = 'test-google-client-id';
  (env as { GOOGLE_CLIENT_SECRET: string | undefined }).GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  (env as { GOOGLE_REDIRECT_URI: string | undefined }).GOOGLE_REDIRECT_URI =
    'http://localhost/oauth/callback/google';
  (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET =
    'test-auth-state-secret-very-long-random-value-32-bytes';
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// buildGoogleAuthUrl
// ---------------------------------------------------------------------------

describe('buildGoogleAuthUrl', () => {
  it('returns a Google auth URL with all required parameters', () => {
    const url = buildGoogleAuthUrl('signed-state-jwt');
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('test-google-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://localhost/oauth/callback/google',
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('openid email profile');
    expect(parsed.searchParams.get('state')).toBe('signed-state-jwt');
  });

  it('throws when GOOGLE_CLIENT_ID is not configured', () => {
    const original = env.GOOGLE_CLIENT_ID;
    (env as { GOOGLE_CLIENT_ID: string | undefined }).GOOGLE_CLIENT_ID = undefined;
    try {
      expect(() => buildGoogleAuthUrl('x')).toThrow(/GOOGLE_CLIENT_ID/);
    } finally {
      (env as { GOOGLE_CLIENT_ID: string | undefined }).GOOGLE_CLIENT_ID = original;
    }
  });
});

// ---------------------------------------------------------------------------
// signStateJwt / verifyStateJwt
// ---------------------------------------------------------------------------

describe('state JWT', () => {
  it('round-trip preserves every claim', async () => {
    const claims = {
      clientId: 'mcp-cli',
      redirectUri: 'http://localhost:9876/cb',
      codeChallenge: 'abc',
      scope: 'page:create page:read',
      state: 'csrf-state-from-client',
    };
    const token = await signStateJwt(claims);
    const decoded = await verifyStateJwt(token);
    expect(decoded).toEqual(claims);
  });

  it('round-trip preserves browser_session flag', async () => {
    const token = await signStateJwt({ browserSession: true });
    const decoded = await verifyStateJwt(token);
    expect(decoded.browserSession).toBe(true);
    expect(decoded.clientId).toBeUndefined();
  });

  it('rejects a tampered token (modified payload, original signature)', async () => {
    const token = await signStateJwt({ clientId: 'mcp-cli', redirectUri: 'http://x' });
    // Surgically replace the middle segment with a payload that claims a
    // different redirect_uri but keep the original signature — the HMAC
    // verify must reject.
    const [h, _p, s] = token.split('.');
    const evil = Buffer.from(
      JSON.stringify({ client_id: 'mcp-cli', redirect_uri: 'http://attacker', iss: 'pagent:oauth:state' }),
    ).toString('base64url');
    const tampered = `${h}.${evil}.${s}`;
    await expect(verifyStateJwt(tampered)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = await signStateJwt({ clientId: 'mcp-cli' });
      // State JWT TTL is 15 minutes; jump 30 minutes ahead.
      vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
      await expect(verifyStateJwt(token)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a token signed under a different secret', async () => {
    const token = await signStateJwt({ clientId: 'mcp-cli' });
    const original = env.AUTH_STATE_SECRET;
    (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET = 'different-secret';
    try {
      await expect(verifyStateJwt(token)).rejects.toThrow();
    } finally {
      (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET = original;
    }
  });
});

// ---------------------------------------------------------------------------
// renderLoginPage
// ---------------------------------------------------------------------------

describe('renderLoginPage', () => {
  it('renders a complete HTML document with the Google link and email form', async () => {
    const state = await signStateJwt({ clientId: 'mcp-cli', redirectUri: 'http://x' });
    const html = renderLoginPage({ signedState: state });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Sign in to Pagent</title>');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(html).toContain('<form method="POST" action="/oauth/magic/send"');
    expect(html).toContain(`value="${state}"`);
    expect(html).toContain('<input type="email"');
  });

  it('escapes the error message to prevent XSS', () => {
    const html = renderLoginPage({ error: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('omits the buttons when no signedState is supplied (hard error)', () => {
    const html = renderLoginPage({ error: 'Unknown client_id' });
    expect(html).not.toContain('Continue with Google');
    expect(html).not.toContain('<form method="POST"');
    expect(html).toContain('Unknown client_id');
  });
});

// ---------------------------------------------------------------------------
// Handle generation
// ---------------------------------------------------------------------------

describe('sanitizeHandle', () => {
  it('lowercases and strips non-alphanumeric chars', () => {
    expect(sanitizeHandle('Alex.Netto')).toBe('alexnetto');
    expect(sanitizeHandle('Alex_NETTO+work')).toBe('alexnettowork');
  });

  it('pads short locals with "user"', () => {
    expect(sanitizeHandle('a')).toBe('auser');
    expect(sanitizeHandle('')).toBe('user');
  });

  it('truncates locals over 40 chars', () => {
    const long = 'a'.repeat(60);
    const out = sanitizeHandle(long);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toBe('a'.repeat(40));
  });

  it('strips leading and trailing dashes', () => {
    expect(sanitizeHandle('-alex-')).toBe('alex');
    expect(sanitizeHandle('---')).toBe('user');
  });
});

describe('generateUniqueHandle', () => {
  it('returns the base when not taken', async () => {
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    const h = await generateUniqueHandle('alex');
    expect(h).toBe('alex');
  });

  it('appends a numeric suffix on collision', async () => {
    // First two lookups return existing users; the third (alex3) is free.
    vi.mocked(db.getUserByHandle)
      .mockResolvedValueOnce({ id: '1' } as never)
      .mockResolvedValueOnce({ id: '2' } as never)
      .mockResolvedValueOnce(null);
    const h = await generateUniqueHandle('alex');
    expect(h).toBe('alex3');
  });
});

// ---------------------------------------------------------------------------
// upsertUser
// ---------------------------------------------------------------------------

describe('upsertUser', () => {
  it('generates a handle from the email local part and forwards to db.upsertUser', async () => {
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValue({
      id: 'user-uuid',
      handle: 'alex',
      email: 'alex@blockful.io',
      name: 'Alex',
      avatar_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const u = await upsertUser({
      email: 'alex@blockful.io',
      name: 'Alex',
    });

    expect(u.id).toBe('user-uuid');
    expect(db.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'alex@blockful.io',
        name: 'Alex',
        avatarUrl: null,
        handle: 'alex',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// createAuthCode
// ---------------------------------------------------------------------------

describe('createAuthCode', () => {
  it('inserts a code with 10-minute expiry and forwards every field to db', async () => {
    vi.mocked(db.insertAuthCode).mockResolvedValue();
    const before = Date.now();
    const code = await createAuthCode(
      'user-uuid',
      'client-id',
      'http://localhost:9876/cb',
      'challenge',
      'S256',
      'page:create',
    );
    expect(code).toBeTruthy();
    // base64url is /^[A-Za-z0-9_-]+$/ — 32 bytes yields 43 chars.
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(db.insertAuthCode).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(db.insertAuthCode).mock.calls[0]![0];
    expect(arg.code).toBe(code);
    expect(arg.userId).toBe('user-uuid');
    expect(arg.clientId).toBe('client-id');
    expect(arg.redirectUri).toBe('http://localhost:9876/cb');
    expect(arg.codeChallenge).toBe('challenge');
    expect(arg.codeChallengeMethod).toBe('S256');
    expect(arg.scope).toBe('page:create');
    // expiresAt should be ~10 minutes from now. Allow generous tolerance to
    // avoid clock-tick flake.
    const ttlMs = arg.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(10 * 60 * 1000 - 100);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 100);
  });
});

// ---------------------------------------------------------------------------
// GET /oauth/authorize
// ---------------------------------------------------------------------------

function authorizeUrl(params: Record<string, string>): string {
  return `${BASE}/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

// Standard valid params used as a baseline; individual tests override fields.
const VALID_AUTHORIZE = {
  client_id: 'a1b2c3d4-e5f6-4321-9876-abcdef012345',
  redirect_uri: 'http://localhost:9876/callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  scope: 'page:create page:read',
  state: 'mcp-client-csrf-state',
} as const;

const clientRow = {
  client_id: VALID_AUTHORIZE.client_id,
  client_secret: null,
  client_secret_expires_at: null,
  client_id_issued_at: new Date('2026-05-17T12:00:00Z'),
  client_name: 'Claude Code',
  client_uri: null,
  logo_uri: null,
  redirect_uris: [VALID_AUTHORIZE.redirect_uri],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: null,
  token_endpoint_auth_method: 'none',
};

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
    // Hard error → no Google button (user can't proceed).
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
    const res = await app.fetch(
      new Request(`${BASE}/oauth/authorize?browser_session=1`),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Continue with Google');
  });
});

// ---------------------------------------------------------------------------
// GET /oauth/callback/google
// ---------------------------------------------------------------------------
// Mocks the Google token endpoint via vi.spyOn(global, 'fetch'). The ID
// token is unsigned (decoded with jose.decodeJwt) so we just need a valid
// JWT structure — header.payload.signature, all base64url, with the email
// claim populated.

function makeFakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  // Signature segment can be anything — decodeJwt doesn't verify.
  return `${header}.${payload}.fake-signature`;
}

function mockGoogleTokenResponse(idTokenClaims: Record<string, unknown>) {
  const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return new Response(
      JSON.stringify({ id_token: makeFakeIdToken(idTokenClaims), access_token: 'g-at' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  return fetchSpy;
}

describe('GET /oauth/callback/google', () => {
  it('exchanges the code, upserts the user, and redirects with code+state', async () => {
    const fetchSpy = mockGoogleTokenResponse({
      sub: 'google-sub-123',
      email: 'alex@blockful.io',
      name: 'Alex Netto',
      picture: 'https://lh3.googleusercontent.com/abc',
    });

    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      handle: 'alex',
      email: 'alex@blockful.io',
      name: 'Alex Netto',
      avatar_url: 'https://lh3.googleusercontent.com/abc',
      created_at: new Date(),
      updated_at: new Date(),
    });
    vi.mocked(db.insertAuthCode).mockResolvedValue();

    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
      scope: VALID_AUTHORIZE.scope,
      state: VALID_AUTHORIZE.state,
    });
    const res = await app.fetch(
      new Request(`${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const parsed = new URL(location);
    expect(parsed.origin + parsed.pathname).toBe(VALID_AUTHORIZE.redirect_uri);
    expect(parsed.searchParams.get('code')).toBeTruthy();
    expect(parsed.searchParams.get('state')).toBe(VALID_AUTHORIZE.state);

    // Verify the call shape into Google's token endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchSpy.mock.calls[0]!;
    expect(fetchArgs[0]).toBe('https://oauth2.googleapis.com/token');
    expect(fetchArgs[1]?.method).toBe('POST');

    // Verify the user upsert was called with Google's profile data.
    expect(db.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'alex@blockful.io',
        name: 'Alex Netto',
        avatarUrl: 'https://lh3.googleusercontent.com/abc',
      }),
    );

    // Verify the auth code was inserted with the PKCE challenge.
    expect(db.insertAuthCode).toHaveBeenCalledTimes(1);
    const authCodeArg = vi.mocked(db.insertAuthCode).mock.calls[0]![0];
    expect(authCodeArg.userId).toBe('11111111-2222-3333-4444-555555555555');
    expect(authCodeArg.clientId).toBe(VALID_AUTHORIZE.client_id);
    expect(authCodeArg.redirectUri).toBe(VALID_AUTHORIZE.redirect_uri);
    expect(authCodeArg.codeChallenge).toBe(VALID_AUTHORIZE.code_challenge);
    expect(authCodeArg.codeChallengeMethod).toBe('S256');

    fetchSpy.mockRestore();
  });

  it('rejects a tampered state JWT', async () => {
    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
    });
    // Flip a character in the signature segment so HMAC verification fails.
    const tampered = state.slice(0, -3) + (state.endsWith('AAA') ? 'BBB' : 'AAA');
    const res = await app.fetch(
      new Request(`${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(tampered)}`),
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
    const res = await app.fetch(
      new Request(`${BASE}/oauth/callback/google?code=google-code`),
    );
    expect(res.status).toBe(400);
  });

  it('handle collision: appends numeric suffix when base handle is taken', async () => {
    mockGoogleTokenResponse({
      sub: 'google-sub-456',
      email: 'alex@another.example',
      name: 'Alex Second',
    });
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    // alex is taken, alex2 is free.
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
    vi.mocked(db.upsertUser).mockResolvedValue({
      id: 'new-user',
      handle: 'alex2',
      email: 'alex@another.example',
      name: null,
      avatar_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    vi.mocked(db.insertAuthCode).mockResolvedValue();

    const state = await signStateJwt({
      clientId: VALID_AUTHORIZE.client_id,
      redirectUri: VALID_AUTHORIZE.redirect_uri,
      codeChallenge: VALID_AUTHORIZE.code_challenge,
    });
    const res = await app.fetch(
      new Request(`${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(state)}`),
    );
    expect(res.status).toBe(302);
    // The upsert call should have received handle="alex2"
    expect(db.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'alex2' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Rate limit on /oauth/authorize
// ---------------------------------------------------------------------------

describe('GET /oauth/authorize rate limit', () => {
  it('rate-limits at 30 per IP per minute (31st request → 429)', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValue(clientRow);
    const ip = '198.51.100.42';
    const req = () =>
      new Request(authorizeUrl(VALID_AUTHORIZE), {
        headers: { 'x-forwarded-for': ip },
      });

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
