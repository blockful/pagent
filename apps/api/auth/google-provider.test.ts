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
  upsertGoogleUser: vi.fn(),
  getUserByHandle: vi.fn(),
  insertAuthCode: vi.fn(),
}));

import * as db from '../db.ts';
import {
  createAuthCode,
  generateUniqueHandle,
  sanitizeHandle,
  upsertGoogleUser,
  upsertUser,
} from './provider.ts';
import { setupGoogleAuthTest } from './google-test-support.ts';

beforeAll(setupGoogleAuthTest);
beforeEach(() => vi.clearAllMocks());

function userRow(id: string, handle: string): db.UserRow {
  return {
    id,
    handle,
    email: `${handle}@example.test`,
    name: null,
    avatar_url: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

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
    vi.mocked(db.getUserByHandle)
      .mockResolvedValueOnce(userRow('1', 'alex'))
      .mockResolvedValueOnce(userRow('2', 'alex2'))
      .mockResolvedValueOnce(null);
    const h = await generateUniqueHandle('alex');
    expect(h).toBe('alex3');
  });
});

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
    const u = await upsertUser({ email: 'alex@blockful.io', name: 'Alex' });
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

  it('canonicalizes email casing before persistence', async () => {
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValue({
      id: 'user-uuid',
      handle: 'alex',
      email: 'alex@example.com',
      name: null,
      avatar_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    await upsertUser({ email: ' Alex@Example.COM ' });

    expect(db.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alex@example.com', handle: 'alex' }),
    );
  });

  it('retries handle allocation after a concurrent unique conflict', async () => {
    vi.mocked(db.getUserByHandle)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(userRow('winner', 'alex'))
      .mockResolvedValueOnce(null);
    const conflict = Object.assign(new Error('duplicate handle'), {
      code: '23505',
      constraint_name: 'users_handle_key',
    });
    vi.mocked(db.upsertUser).mockRejectedValueOnce(conflict).mockResolvedValueOnce({
      id: 'user-uuid',
      handle: 'alex2',
      email: 'alex@example.com',
      name: null,
      avatar_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const user = await upsertUser({ email: 'alex@example.com' });

    expect(user.handle).toBe('alex2');
    expect(db.upsertUser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ email: 'alex@example.com', handle: 'alex2' }),
    );
  });

  it('retries handle allocation when the case-insensitive handle index conflicts', async () => {
    vi.mocked(db.getUserByHandle)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(userRow('winner', 'alex'))
      .mockResolvedValueOnce(null);
    const conflict = Object.assign(new Error('duplicate handle'), {
      code: '23505',
      constraint_name: 'users_handle_idx',
    });
    vi.mocked(db.upsertUser).mockRejectedValueOnce(conflict).mockResolvedValueOnce({
      id: 'user-uuid',
      handle: 'alex2',
      email: 'alex@example.com',
      name: null,
      avatar_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const user = await upsertUser({ email: 'alex@example.com' });

    expect(user.handle).toBe('alex2');
    expect(db.upsertUser).toHaveBeenCalledTimes(2);
  });

  it('does not retry a unique conflict from another constraint', async () => {
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    const conflict = Object.assign(new Error('duplicate email'), {
      code: '23505',
      constraint_name: 'users_email_idx',
    });
    vi.mocked(db.upsertUser).mockRejectedValue(conflict);

    await expect(upsertUser({ email: 'alex@example.com' })).rejects.toBe(conflict);
    expect(db.upsertUser).toHaveBeenCalledOnce();
  });
});

describe('upsertGoogleUser', () => {
  it('forwards the immutable Google subject separately from mutable profile fields', async () => {
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertGoogleUser).mockResolvedValue({
      kind: 'success',
      user: userRow('google-user-uuid', 'alex'),
    });

    await upsertGoogleUser({
      googleSubject: 'google-sub-123',
      email: ' Alex@Example.COM ',
      name: 'Alex',
    });

    expect(db.upsertGoogleUser).toHaveBeenCalledWith({
      googleSubject: 'google-sub-123',
      email: 'alex@example.com',
      name: 'Alex',
      avatarUrl: null,
      handle: 'alex',
    });
  });

  it('returns link-required without retrying or replacing the legacy account', async () => {
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertGoogleUser).mockResolvedValue({ kind: 'link_required' });

    await expect(
      upsertGoogleUser({ googleSubject: 'google-sub-new', email: 'legacy@example.test' }),
    ).resolves.toEqual({ kind: 'link_required' });
    expect(db.upsertGoogleUser).toHaveBeenCalledOnce();
  });
});

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
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(db.insertAuthCode).toHaveBeenCalledTimes(1);
    const [arg] = vi.mocked(db.insertAuthCode).mock.calls[0] ?? [];
    if (!arg) throw new Error('insertAuthCode call was not recorded');
    expect(arg.code).toBe(code);
    expect(arg.userId).toBe('user-uuid');
    expect(arg.clientId).toBe('client-id');
    expect(arg.redirectUri).toBe('http://localhost:9876/cb');
    expect(arg.codeChallenge).toBe('challenge');
    expect(arg.codeChallengeMethod).toBe('S256');
    expect(arg.scope).toBe('page:create');
    const ttlMs = arg.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(10 * 60 * 1000 - 100);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 100);
  });
});
