/**
 * Session helpers unit tests — db is fully mocked so the createSession ↔
 * lookupSession ↔ deleteSession lifecycle can be verified without a real
 * Postgres instance. We assert the contract every higher layer relies on:
 *
 *   - createSession returns a 32-char hex token (16 bytes hex-encoded).
 *   - The DB only ever sees SHA-256(raw) — the raw token never lands in
 *     `insertSession`'s arguments as `tokenHash`.
 *   - lookupSession returns null for unknown / expired tokens.
 *   - lookupSession bumps `expires_at` by SESSION_MAX_AGE_DAYS on success
 *     (sliding expiry).
 *   - deleteSession passes the hash, not the raw token.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../db.ts', () => ({
  insertSession: vi.fn(() => Promise.resolve()),
  getSessionWithUserByTokenHash: vi.fn(() => Promise.resolve(null)),
  extendSessionExpiry: vi.fn(() => Promise.resolve()),
  deleteSessionByTokenHash: vi.fn(() => Promise.resolve()),
}));

import * as db from '../db.ts';
import { createSession, lookupSession, deleteSession } from './session.ts';
import { env } from '../schemas.ts';

const HEX_32 = /^[a-f0-9]{32}$/;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
  (db.getSessionWithUserByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe('createSession', () => {
  it('returns a 32-char hex token (16 bytes of entropy)', async () => {
    const token = await createSession('user-uuid-1');
    expect(token).toMatch(HEX_32);
  });

  it('stores SHA-256(token) in the DB, never the raw token', async () => {
    const token = await createSession('user-uuid-1');
    expect(db.insertSession).toHaveBeenCalledTimes(1);
    const call = (db.insertSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.tokenHash).toBe(sha256Hex(token));
    // Belt and suspenders — the raw token must not equal the hash.
    expect(call.tokenHash).not.toBe(token);
    // No raw-token field exposed on the insert.
    expect(JSON.stringify(call)).not.toContain(token);
  });

  it('uses SESSION_MAX_AGE_DAYS for expires_at', async () => {
    const before = Date.now();
    await createSession('user-uuid-1');
    const after = Date.now();
    const call = (db.insertSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const expiresMs = (call.expiresAt as Date).getTime();
    const expectedMin = before + env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const expectedMax = after + env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresMs).toBeLessThanOrEqual(expectedMax);
  });

  it('passes through ip/userAgent when provided', async () => {
    await createSession('user-uuid-1', '203.0.113.5', 'TestAgent/1.0');
    const call = (db.insertSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.ipAddress).toBe('203.0.113.5');
    expect(call.userAgent).toBe('TestAgent/1.0');
  });

  it('stores null for ip/userAgent when omitted', async () => {
    await createSession('user-uuid-1');
    const call = (db.insertSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.ipAddress).toBeNull();
    expect(call.userAgent).toBeNull();
  });

  it('generates a different token on every call', async () => {
    const a = await createSession('user-uuid-1');
    const b = await createSession('user-uuid-1');
    expect(a).not.toBe(b);
  });
});

describe('lookupSession', () => {
  it('round-trip: creates a session, then resolves it by raw token', async () => {
    // Simulate insertSession storing the hash; lookupSession then "sees" the
    // same row coming back from getSessionWithUserByTokenHash.
    let stored: { tokenHash: string } | null = null;
    (db.insertSession as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { tokenHash: string }) => {
        stored = input;
      },
    );
    (db.getSessionWithUserByTokenHash as ReturnType<typeof vi.fn>).mockImplementation(
      async (hash: string) =>
        stored && stored.tokenHash === hash
          ? {
              session_id: 'session-uuid-1',
              user_id: 'user-uuid-1',
              email: 'alex@blockful.io',
              handle: 'alex',
              expires_at: new Date(Date.now() + 1000),
            }
          : null,
    );

    const token = await createSession('user-uuid-1');
    const user = await lookupSession(token);

    expect(user).not.toBeNull();
    expect(user?.id).toBe('user-uuid-1');
    expect(user?.email).toBe('alex@blockful.io');
    expect(user?.handle).toBe('alex');
    expect(user?.authMethod).toBe('cookie');
  });

  it('returns null when the token hash is unknown to the DB', async () => {
    (db.getSessionWithUserByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const user = await lookupSession('some-random-token');
    expect(user).toBeNull();
  });

  it('returns null on empty token', async () => {
    const user = await lookupSession('');
    expect(user).toBeNull();
    // Defensive: should NOT hit the DB at all for an empty input.
    expect(db.getSessionWithUserByTokenHash).not.toHaveBeenCalled();
  });

  it('extends expires_at on successful lookup (sliding expiry)', async () => {
    (db.getSessionWithUserByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: 'session-uuid-2',
      user_id: 'user-uuid-1',
      email: 'alex@blockful.io',
      handle: 'alex',
      expires_at: new Date(Date.now() + 60_000),
    });
    const before = Date.now();
    await lookupSession('any-token');
    expect(db.extendSessionExpiry).toHaveBeenCalledTimes(1);
    const [sessionId, newExpires] = (db.extendSessionExpiry as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(sessionId).toBe('session-uuid-2');
    // newExpires should be ~ now + SESSION_MAX_AGE_DAYS.
    const expectedMin = before + env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    expect((newExpires as Date).getTime()).toBeGreaterThanOrEqual(expectedMin);
  });

  it('does not fail the request if extendSessionExpiry throws', async () => {
    (db.getSessionWithUserByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: 'session-uuid-3',
      user_id: 'user-uuid-2',
      email: 'bob@example.com',
      handle: null,
      expires_at: new Date(Date.now() + 60_000),
    });
    (db.extendSessionExpiry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db blip'),
    );
    const user = await lookupSession('any-token');
    expect(user).not.toBeNull();
    expect(user?.id).toBe('user-uuid-2');
    expect(user?.handle).toBeNull();
  });

  it('hashes the raw token before passing it to the DB', async () => {
    await lookupSession('plain-token-value');
    expect(db.getSessionWithUserByTokenHash).toHaveBeenCalledWith(sha256Hex('plain-token-value'));
  });
});

describe('deleteSession', () => {
  it('hashes the raw token before deletion', async () => {
    await deleteSession('raw-cookie-token');
    expect(db.deleteSessionByTokenHash).toHaveBeenCalledWith(sha256Hex('raw-cookie-token'));
  });

  it('no-ops on empty token', async () => {
    await deleteSession('');
    expect(db.deleteSessionByTokenHash).not.toHaveBeenCalled();
  });

  it('after delete + DB now returning null, lookupSession yields null', async () => {
    // Simulate: insert, then delete clears the stored row, then lookup.
    let stored: { tokenHash: string } | null = null;
    (db.insertSession as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { tokenHash: string }) => {
        stored = input;
      },
    );
    (db.deleteSessionByTokenHash as ReturnType<typeof vi.fn>).mockImplementation(
      async (hash: string) => {
        if (stored && stored.tokenHash === hash) stored = null;
      },
    );
    (db.getSessionWithUserByTokenHash as ReturnType<typeof vi.fn>).mockImplementation(
      async (hash: string) =>
        stored && stored.tokenHash === hash
          ? {
              session_id: 'session-uuid-4',
              user_id: 'user-uuid-3',
              email: 'gone@example.com',
              handle: null,
              expires_at: new Date(Date.now() + 1000),
            }
          : null,
    );

    const token = await createSession('user-uuid-3');
    expect(await lookupSession(token)).not.toBeNull();
    await deleteSession(token);
    expect(await lookupSession(token)).toBeNull();
  });
});
