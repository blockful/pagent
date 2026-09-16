/**
 * Magic Link flow tests — unit (sendMagicLink / verifyMagicLink round-trip,
 * expired/consumed token rejection) and integration via the Hono app
 * (POST /oauth/magic/send rate limit, 503 when SMTP unset, GET /oauth/magic
 * redirect happy path, anti-enumeration response shape).
 *
 * Strategy:
 *   - db.ts is fully mocked (same shape as google.test.ts) so we don't open
 *     a Postgres connection. Per-test mocks of `insertMagicLink` and
 *     `verifyAndConsumeMagicLink` let us simulate every state of the row.
 *   - nodemailer.createTransport is spied on so we can assert sendMail
 *     arguments without making a real SMTP connection.
 *   - env vars (SMTP_HOST, AUTH_STATE_SECRET, PUBLIC_URL) are mutated on the
 *     parsed env object — same trick google.test.ts uses.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock db.ts BEFORE app.ts is imported so the auth routes wire up against
// the stubs. Every method the routes touch (including the inherited Google
// callback path) gets a vi.fn() — tests configure per-case.
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
}));

// Mock nodemailer's default export so sendMagicLink doesn't dial a real
// SMTP server. The mock transport tracks sendMail calls so we can assert
// the message contents (to, from, subject, link URL).
//
// Type the parameter as `Record<string, string>` (mirrors the subset of
// nodemailer's `SendMailOptions` we actually populate) so call assertions
// don't need an explicit cast on every access.
const mockSendMail = vi.fn(async (_message: Record<string, string>) => ({
  messageId: 'test-message-id',
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  },
}));

import * as db from '../db.ts';
import { env } from '../schemas.ts';
import { app } from '../app.ts';
import { initKeys } from './jwt.ts';
import {
  InvalidMagicLinkError,
  SmtpUnavailableError,
  createTransport,
  sendMagicLink,
  verifyMagicLink,
} from './magic-link.ts';
import { magicSendLimiter } from './routes.ts';
import { signStateJwt } from './state-jwt.ts';

const BASE = 'http://localhost';

// SHA-256(token) — matches the hash function in magic-link.ts. Helpers below
// use this so tests can compute the expected DB key without re-implementing
// the algorithm inline.
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

beforeAll(async () => {
  // Ed25519 keys for the JWT signer — required by app.ts boot path even
  // though we don't exercise the token endpoint here.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await initKeys(
    privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  );
  // Populate the auth secrets in-memory. envSchema's optional fields default
  // to undefined; tests need them set to exercise the signing + email path.
  (env as { SMTP_HOST: string | undefined }).SMTP_HOST = 'smtp.test.example';
  (env as { SMTP_USER: string | undefined }).SMTP_USER = 'test-user';
  (env as { SMTP_PASS: string | undefined }).SMTP_PASS = 'test-pass';
  (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET =
    'test-auth-state-secret-very-long-random-value-32-bytes';
  (env as { PUBLIC_URL: string | undefined }).PUBLIC_URL = 'http://localhost:8787';
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module-level rate limiter so each test starts with a fresh
  // bucket. The limiter lives across test files; without this, tests that
  // share an email would interfere.
  magicSendLimiter.reset();
});

// ---------------------------------------------------------------------------
// createTransport
// ---------------------------------------------------------------------------

describe('createTransport', () => {
  it('returns null when SMTP_HOST is not configured', () => {
    const original = env.SMTP_HOST;
    (env as { SMTP_HOST: string | undefined }).SMTP_HOST = undefined;
    try {
      expect(createTransport()).toBeNull();
    } finally {
      (env as { SMTP_HOST: string | undefined }).SMTP_HOST = original;
    }
  });

  it('returns a transport when SMTP_HOST is set', () => {
    expect(createTransport()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sendMagicLink / verifyMagicLink (round-trip + failure modes)
// ---------------------------------------------------------------------------

describe('sendMagicLink', () => {
  it('throws SmtpUnavailableError when SMTP_HOST is unset', async () => {
    const original = env.SMTP_HOST;
    (env as { SMTP_HOST: string | undefined }).SMTP_HOST = undefined;
    try {
      await expect(sendMagicLink('alex@blockful.io', {})).rejects.toBeInstanceOf(
        SmtpUnavailableError,
      );
      // No DB write attempted when transport is unavailable.
      expect(db.insertMagicLink).not.toHaveBeenCalled();
    } finally {
      (env as { SMTP_HOST: string | undefined }).SMTP_HOST = original;
    }
  });

  it('inserts a 32-byte token hash with 15-minute expiry and sends an email', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValueOnce();

    const before = Date.now();
    const { token } = await sendMagicLink('alex@blockful.io', {
      clientId: 'mcp-cli',
      redirectUri: 'http://localhost:9876/cb',
    });

    // base64url of 32 bytes = 43 chars, charset [A-Za-z0-9_-].
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBe(43);

    expect(db.insertMagicLink).toHaveBeenCalledTimes(1);
    const insertArg = vi.mocked(db.insertMagicLink).mock.calls[0]![0];
    expect(insertArg.email).toBe('alex@blockful.io');
    // The DB sees the hash, never the raw token.
    expect(insertArg.tokenHash).toBe(sha256Hex(token));
    expect(insertArg.tokenHash).not.toBe(token);
    expect(insertArg.authorizeContext.clientId).toBe('mcp-cli');
    expect(insertArg.authorizeContext.redirectUri).toBe('http://localhost:9876/cb');
    // expiresAt ≈ now + 15 min. Allow generous tolerance to avoid clock-tick flake.
    const ttlMs = insertArg.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(15 * 60 * 1000 - 100);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 100);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mailArg = mockSendMail.mock.calls[0]![0];
    expect(mailArg.to).toBe('alex@blockful.io');
    expect(mailArg.from).toBe(env.SMTP_FROM);
    expect(mailArg.subject).toBe('Sign in to Pagent');
    // Both text and HTML carry the link.
    expect(mailArg.text).toContain(`/oauth/magic?token=${token}`);
    expect(mailArg.html).toContain(`/oauth/magic?token=${token}`);
    // The token itself appears in the email body — but it must not appear in
    // any DB-bound payload (sanity check against accidental logging).
    expect(insertArg.tokenHash).not.toContain(token);
  });

  it('writes the row before sending the email (DB failure aborts send)', async () => {
    vi.mocked(db.insertMagicLink).mockRejectedValueOnce(new Error('db down'));
    await expect(sendMagicLink('alex@blockful.io', {})).rejects.toThrow('db down');
    // Email is never attempted if the DB write fails — otherwise the user
    // would receive a link with no row to verify against.
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe('verifyMagicLink', () => {
  it('round-trips: sendMagicLink token verifies and returns the stored context', async () => {
    let captured: Parameters<typeof db.insertMagicLink>[0] | null = null;
    vi.mocked(db.insertMagicLink).mockImplementation(async (input) => {
      captured = input;
    });

    const ctx = {
      clientId: 'mcp-cli',
      redirectUri: 'http://localhost:9876/cb',
      codeChallenge: 'challenge-abc',
      codeChallengeMethod: 'S256',
      scope: 'page:create',
      state: 'mcp-csrf',
    };
    const { token } = await sendMagicLink('alex@blockful.io', ctx);
    expect(captured).not.toBeNull();

    // Simulate the DB returning the same row on verify (atomic UPDATE).
    vi.mocked(db.verifyAndConsumeMagicLink).mockResolvedValueOnce({
      email: 'alex@blockful.io',
      authorizeContext: ctx,
    });
    const result = await verifyMagicLink(token);
    expect(result.email).toBe('alex@blockful.io');
    expect(result.authorizeContext).toEqual(ctx);

    // The verify call used the hash, not the raw token.
    expect(db.verifyAndConsumeMagicLink).toHaveBeenCalledWith(sha256Hex(token));
  });

  it('rejects an unknown / expired / consumed token (DB returns null)', async () => {
    // Single failure path: the DB's atomic UPDATE returns no rows for every
    // case — unknown hash, expired row, already-consumed row. We don't
    // distinguish (would leak verification state) but assert all three.
    for (const _ of ['unknown', 'expired', 'consumed']) {
      vi.mocked(db.verifyAndConsumeMagicLink).mockResolvedValueOnce(null);
      await expect(verifyMagicLink('bogus-token')).rejects.toBeInstanceOf(InvalidMagicLinkError);
    }
  });

  it('rejects empty / non-string input without a DB round-trip', async () => {
    await expect(verifyMagicLink('')).rejects.toBeInstanceOf(InvalidMagicLinkError);
    // The empty-string guard short-circuits the DB call.
    expect(db.verifyAndConsumeMagicLink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /oauth/magic/send
// ---------------------------------------------------------------------------

function postMagicSend(
  body: Record<string, string>,
  opts: { contentType?: 'json' | 'form' } = {},
): Request {
  const headers: Record<string, string> = {};
  let serialized: string;
  if (opts.contentType === 'form' || opts.contentType === undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    serialized = new URLSearchParams(body).toString();
  } else {
    headers['Content-Type'] = 'application/json';
    serialized = JSON.stringify(body);
  }
  return new Request(`${BASE}/oauth/magic/send`, {
    method: 'POST',
    headers,
    body: serialized,
  });
}

describe('POST /oauth/magic/send', () => {
  it('returns 200 with a "check your email" message on valid request', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValueOnce();

    const res = await app.fetch(
      postMagicSend({ email: 'alex@blockful.io' }, { contentType: 'json' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.message).toBe('string');
    expect((body.message as string).toLowerCase()).toContain('check your email');
    expect(db.insertMagicLink).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('accepts form-encoded body (the login page default)', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValueOnce();

    const res = await app.fetch(postMagicSend({ email: 'alex@blockful.io' }));
    expect(res.status).toBe(200);
    expect(db.insertMagicLink).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when SMTP_HOST is not configured', async () => {
    const original = env.SMTP_HOST;
    (env as { SMTP_HOST: string | undefined }).SMTP_HOST = undefined;
    try {
      const res = await app.fetch(postMagicSend({ email: 'alex@blockful.io' }));
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('service_unavailable');
      // No DB write or email attempted.
      expect(db.insertMagicLink).not.toHaveBeenCalled();
      expect(mockSendMail).not.toHaveBeenCalled();
    } finally {
      (env as { SMTP_HOST: string | undefined }).SMTP_HOST = original;
    }
  });

  it('returns 400 invalid_request for malformed email', async () => {
    const res = await app.fetch(postMagicSend({ email: 'not-an-email' }, { contentType: 'json' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
    expect(db.insertMagicLink).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_request for missing email', async () => {
    const res = await app.fetch(postMagicSend({}, { contentType: 'json' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  it('anti-enumeration: identical response for existing and non-existing emails', async () => {
    // Magic link doubles as sign-up, so the same code path runs for any
    // email. Both responses should be byte-for-byte equal except for any
    // entropy-bearing fields (none here). We assert the shape, not just the
    // status code, to lock the invariant in.
    vi.mocked(db.insertMagicLink).mockResolvedValue();

    const res1 = await app.fetch(
      postMagicSend({ email: 'existing@blockful.io' }, { contentType: 'json' }),
    );
    const res2 = await app.fetch(
      postMagicSend({ email: 'brand-new@example.org' }, { contentType: 'json' }),
    );
    expect(res1.status).toBe(res2.status);
    expect(await res1.json()).toEqual(await res2.json());
    // Same number of DB writes — sendMagicLink is called for every valid
    // email regardless of registration.
    expect(db.insertMagicLink).toHaveBeenCalledTimes(2);
  });

  it('rate-limits at 5 / email / 15 min — 6th request → 429', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValue();
    const email = 'limited@blockful.io';

    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(postMagicSend({ email }, { contentType: 'json' }));
      expect(res.status, `request ${i + 1} of 5 should succeed`).toBe(200);
    }
    const limited = await app.fetch(postMagicSend({ email }, { contentType: 'json' }));
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retry_after_seconds).toBe('number');
    expect(limited.headers.get('Retry-After')).toBe(String(body.retry_after_seconds));

    // Different email still works (per-email bucket).
    const other = await app.fetch(
      postMagicSend({ email: 'other@blockful.io' }, { contentType: 'json' }),
    );
    expect(other.status).toBe(200);
  });

  it('rate-limit key is case-insensitive on email', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValue();
    for (let i = 0; i < 5; i++) {
      await app.fetch(postMagicSend({ email: 'CaseTest@Blockful.io' }, { contentType: 'json' }));
    }
    const limited = await app.fetch(
      postMagicSend({ email: 'casetest@blockful.io' }, { contentType: 'json' }),
    );
    expect(limited.status).toBe(429);
  });

  it('extracts authorize context from a signed state JWT', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValueOnce();

    const state = await signStateJwt({
      clientId: 'mcp-cli',
      redirectUri: 'http://localhost:9876/cb',
      codeChallenge: 'challenge',
      scope: 'page:create',
      state: 'mcp-csrf',
    });

    const res = await app.fetch(
      postMagicSend({ email: 'alex@blockful.io', state }, { contentType: 'json' }),
    );
    expect(res.status).toBe(200);
    const arg = vi.mocked(db.insertMagicLink).mock.calls[0]![0];
    expect(arg.authorizeContext.clientId).toBe('mcp-cli');
    expect(arg.authorizeContext.redirectUri).toBe('http://localhost:9876/cb');
    expect(arg.authorizeContext.codeChallenge).toBe('challenge');
    expect(arg.authorizeContext.codeChallengeMethod).toBe('S256');
    expect(arg.authorizeContext.scope).toBe('page:create');
    expect(arg.authorizeContext.state).toBe('mcp-csrf');
  });

  it('tolerates an invalid state JWT (proceeds with empty context)', async () => {
    // An expired or tampered state shouldn't 400 — that would distinguish
    // "valid state, unregistered email" from "invalid state" and leak
    // enumeration info. We just drop the context and email anyway.
    vi.mocked(db.insertMagicLink).mockResolvedValueOnce();

    const res = await app.fetch(
      postMagicSend(
        { email: 'alex@blockful.io', state: 'not-a-valid-jwt' },
        { contentType: 'json' },
      ),
    );
    expect(res.status).toBe(200);
    const arg = vi.mocked(db.insertMagicLink).mock.calls[0]![0];
    expect(arg.authorizeContext).toEqual({});
  });

  it('lowercases the email before sending and storing', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValueOnce();

    await app.fetch(postMagicSend({ email: 'Alex@Blockful.IO' }, { contentType: 'json' }));
    const arg = vi.mocked(db.insertMagicLink).mock.calls[0]![0];
    expect(arg.email).toBe('alex@blockful.io');
    const mailArg = mockSendMail.mock.calls[0]![0];
    expect(mailArg.to).toBe('alex@blockful.io');
  });
});

// ---------------------------------------------------------------------------
// GET /oauth/magic
// ---------------------------------------------------------------------------

const clientRow = {
  client_id: 'a1b2c3d4-e5f6-4321-9876-abcdef012345',
  client_secret: null,
  client_secret_expires_at: null,
  client_id_issued_at: new Date('2026-05-17T12:00:00Z'),
  client_name: 'Claude Code',
  client_uri: null,
  logo_uri: null,
  redirect_uris: ['http://localhost:9876/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: null,
  token_endpoint_auth_method: 'none',
};

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
    const location = res.headers.get('location')!;
    const parsed = new URL(location);
    expect(parsed.origin + parsed.pathname).toBe('http://localhost:9876/callback');
    expect(parsed.searchParams.get('code')).toBeTruthy();
    expect(parsed.searchParams.get('state')).toBe('mcp-csrf');

    // The auth code was inserted with the same PKCE challenge from the
    // stored context.
    expect(db.insertAuthCode).toHaveBeenCalledTimes(1);
    const codeArg = vi.mocked(db.insertAuthCode).mock.calls[0]![0];
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
});
