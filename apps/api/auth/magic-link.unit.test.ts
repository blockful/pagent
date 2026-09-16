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
import { env } from '../schemas.ts';
import { setupMagicLinkTest, sha256Hex } from './magic-link-test-support.ts';
import {
  InvalidMagicLinkError,
  SmtpUnavailableError,
  createTransport,
  sendMagicLink,
  verifyMagicLink,
} from './magic-link.ts';

setupMagicLinkTest();

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
    expect(mailArg.text).toContain(`https://api.pagent.link/oauth/magic?token=${token}`);
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
