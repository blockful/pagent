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
import { env } from '../schemas.ts';
import { postMagicSend, setupMagicLinkTest } from './magic-link-test-support.ts';
import { AUTH_TRANSACTION_COOKIE_NAME } from './route-transaction.ts';
import { magicSendGlobalLimiter } from './routes.ts';
import { signStateJwt } from './state-jwt.ts';
import { firstCallArgument } from './test-call-support.ts';

setupMagicLinkTest();

const OAUTH_TRANSACTION_TOKEN = 'magic-send-oauth-transaction';
const OAUTH_TRANSACTION_HASH = createHash('sha256')
  .update(OAUTH_TRANSACTION_TOKEN)
  .digest('base64url');

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

  it('rate-limits varying recipient addresses from the same client IP', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValue();
    const realIp = '203.0.113.10';

    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(
        postMagicSend({ email: `recipient-${i}@blockful.io` }, { contentType: 'json', realIp }),
      );
      expect(res.status, `request ${i + 1} should succeed`).toBe(200);
    }

    const limited = await app.fetch(
      postMagicSend({ email: 'recipient-over-limit@blockful.io' }, { contentType: 'json', realIp }),
    );
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body.error).toBe('rate_limited');
    expect(mockSendMail).toHaveBeenCalledTimes(10);
  });

  it("uses Railway's X-Real-IP when X-Forwarded-For changes", async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValue();
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(
        postMagicSend(
          { email: `varying-chain-${i}@blockful.io` },
          {
            contentType: 'json',
            realIp: '203.0.113.10',
            forwardedFor: `203.0.113.10, 192.0.2.${i + 1}`,
          },
        ),
      );
      expect(res.status, `request ${i + 1} should succeed`).toBe(200);
    }

    const limited = await app.fetch(
      postMagicSend(
        { email: 'varying-chain-over-limit@blockful.io' },
        {
          contentType: 'json',
          realIp: '203.0.113.10',
          forwardedFor: '203.0.113.10, 192.0.2.200, 198.51.100.7',
        },
      ),
    );
    expect(limited.status).toBe(429);
    expect(mockSendMail).toHaveBeenCalledTimes(10);
  });

  it('enforces the provider safeguard across varying recipients and client IPs', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValue();

    for (let i = 0; i < 50; i++) {
      const res = await app.fetch(
        postMagicSend(
          { email: `provider-${i}@blockful.io` },
          { contentType: 'json', realIp: `198.51.100.${i + 1}` },
        ),
      );
      expect(res.status, `request ${i + 1} should succeed`).toBe(200);
    }

    const limited = await app.fetch(
      postMagicSend(
        { email: 'provider-over-limit@blockful.io' },
        { contentType: 'json', realIp: '198.51.100.201' },
      ),
    );
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body.error).toBe('rate_limited');
    expect(mockSendMail).toHaveBeenCalledTimes(50);
  });

  it('does not charge a client-IP bucket when the provider safeguard is already full', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValue();

    for (let i = 0; i < 50; i++) {
      const res = await app.fetch(
        postMagicSend(
          { email: `provider-cap-${i}@blockful.io` },
          { contentType: 'json', realIp: `198.51.100.${i + 1}` },
        ),
      );
      expect(res.status, `provider request ${i + 1} should succeed`).toBe(200);
    }

    const blockedIp = '203.0.113.200';
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(
        postMagicSend(
          { email: `blocked-provider-${i}@blockful.io` },
          { contentType: 'json', realIp: blockedIp },
        ),
      );
      expect(res.status, `blocked request ${i + 1} should not consume the IP bucket`).toBe(429);
    }

    magicSendGlobalLimiter.reset();

    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(
        postMagicSend(
          { email: `allowed-after-reset-${i}@blockful.io` },
          { contentType: 'json', realIp: blockedIp },
        ),
      );
      expect(res.status, `IP request ${i + 1} should succeed after the global reset`).toBe(200);
    }
  });

  it('does not charge an email bucket when the provider safeguard is already full', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValue();

    for (let i = 0; i < 50; i++) {
      const res = await app.fetch(
        postMagicSend(
          { email: `provider-email-cap-${i}@blockful.io` },
          { contentType: 'json', realIp: `198.51.100.${i + 1}` },
        ),
      );
      expect(res.status, `provider request ${i + 1} should succeed`).toBe(200);
    }

    const blockedEmail = 'blocked-provider-email@blockful.io';
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(
        postMagicSend(
          { email: blockedEmail },
          { contentType: 'json', realIp: `203.0.113.${i + 1}` },
        ),
      );
      expect(res.status, `blocked request ${i + 1} should not consume the email bucket`).toBe(429);
    }

    magicSendGlobalLimiter.reset();

    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(
        postMagicSend({ email: blockedEmail }, { contentType: 'json', realIp: `192.0.2.${i + 1}` }),
      );
      expect(res.status, `email request ${i + 1} should succeed after the global reset`).toBe(200);
    }
  });

  it('extracts authorize context from a signed state JWT', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValueOnce();

    const state = await signStateJwt({
      clientId: 'mcp-cli',
      redirectUri: 'http://localhost:9876/cb',
      codeChallenge: 'challenge',
      scope: 'page:create',
      state: 'mcp-csrf',
      browserTransactionHash: OAUTH_TRANSACTION_HASH,
      consentGranted: true,
    });

    const res = await app.fetch(
      postMagicSend(
        { email: 'alex@blockful.io', state },
        {
          contentType: 'json',
          cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${OAUTH_TRANSACTION_TOKEN}`,
        },
      ),
    );
    expect(res.status).toBe(200);
    const arg = firstCallArgument(vi.mocked(db.insertMagicLink).mock.calls, 'insertMagicLink');
    expect(arg.authorizeContext.clientId).toBe('mcp-cli');
    expect(arg.authorizeContext.redirectUri).toBe('http://localhost:9876/cb');
    expect(arg.authorizeContext.codeChallenge).toBe('challenge');
    expect(arg.authorizeContext.codeChallengeMethod).toBe('S256');
    expect(arg.authorizeContext.scope).toBe('page:create');
    expect(arg.authorizeContext.state).toBe('mcp-csrf');
    expect(arg.authorizeContext.browserTransactionHash).toBe(OAUTH_TRANSACTION_HASH);
    expect(arg.authorizeContext.consentGranted).toBe(true);
  });

  it('rejects a pending OAuth state before sending a magic link', async () => {
    const state = await signStateJwt({
      clientId: 'mcp-cli',
      redirectUri: 'http://localhost:9876/cb',
      codeChallenge: 'challenge',
      browserTransactionHash: OAUTH_TRANSACTION_HASH,
    });

    const res = await app.fetch(
      postMagicSend(
        { email: 'victim@blockful.io', state },
        {
          contentType: 'json',
          cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${OAUTH_TRANSACTION_TOKEN}`,
        },
      ),
    );

    expect(res.status).toBe(400);
    expect(db.insertMagicLink).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('forwards the browser transaction binding into the magic-link context', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValueOnce();
    const state = await signStateJwt({
      browserSession: true,
      browserTransactionHash: 'signed-browser-transaction-hash',
    });

    const res = await app.fetch(
      postMagicSend({ email: 'alex@blockful.io', state }, { contentType: 'json' }),
    );

    expect(res.status).toBe(200);
    const arg = firstCallArgument(vi.mocked(db.insertMagicLink).mock.calls, 'insertMagicLink');
    expect(arg.authorizeContext).toEqual({
      browserSession: true,
      browserTransactionHash: 'signed-browser-transaction-hash',
      clientId: undefined,
      codeChallenge: undefined,
      codeChallengeMethod: undefined,
      redirectUri: undefined,
      scope: undefined,
      state: undefined,
    });
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
    const arg = firstCallArgument(vi.mocked(db.insertMagicLink).mock.calls, 'insertMagicLink');
    expect(arg.authorizeContext).toEqual({});
  });

  it('lowercases the email before sending and storing', async () => {
    vi.mocked(db.insertMagicLink).mockResolvedValueOnce();

    await app.fetch(postMagicSend({ email: 'Alex@Blockful.IO' }, { contentType: 'json' }));
    const arg = firstCallArgument(vi.mocked(db.insertMagicLink).mock.calls, 'insertMagicLink');
    expect(arg.email).toBe('alex@blockful.io');
    const mailArg = firstCallArgument(mockSendMail.mock.calls, 'sendMail');
    expect(mailArg.to).toBe('alex@blockful.io');
  });
});
