import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID,
  initializeTestKeys,
  SCOPE,
  sha256Hex,
  USER_ROW,
} from './provider-test-support.ts';

vi.mock('../db.ts', () => ({
  getRefreshTokenByHash: vi.fn(),
  revokeAllRefreshTokensForFamily: vi.fn(),
}));

vi.mock('./clients-store.ts', () => ({
  getClient: vi.fn(),
}));

import * as db from '../db.ts';
import { initKeys } from './jwt.ts';
import { revokeToken, TokenError } from './provider.ts';

beforeAll(async () => {
  await initializeTestKeys(initKeys);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('revokeToken', () => {
  it('revokes the refresh-token family when the token exists', async () => {
    const raw = 'rt_' + randomBytes(32).toString('hex');
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-id',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      family_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      token_hash: sha256Hex(raw),
      scope: SCOPE,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: null,
    });

    await revokeToken(raw, undefined, undefined);

    expect(db.revokeAllRefreshTokensForFamily).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
  });

  it('silently succeeds for an unknown refresh token (no error, no revoke)', async () => {
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce(null);
    await expect(revokeToken('rt_unknown', undefined, undefined)).resolves.toBeUndefined();
    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('revokes the family even when the presented token was already revoked', async () => {
    const raw = 'rt_' + randomBytes(32).toString('hex');
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-already',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      family_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      token_hash: sha256Hex(raw),
      scope: SCOPE,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: new Date(),
    });

    await revokeToken(raw, undefined, undefined);
    expect(db.revokeAllRefreshTokensForFamily).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
  });

  it('does not revoke a token bound to a different supplied client', async () => {
    const raw = 'rt_' + randomBytes(32).toString('hex');
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-other-client',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      family_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      token_hash: sha256Hex(raw),
      scope: SCOPE,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: null,
    });

    await revokeToken(raw, undefined, 'different-client');
    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('is a no-op for non-rt_-prefixed tokens (V1 access tokens have no denylist)', async () => {
    await revokeToken('eyJhbGciOiJFZERTQSJ9.fake-jwt-payload.fake-signature', undefined, undefined);
    expect(db.getRefreshTokenByHash).not.toHaveBeenCalled();
    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('silently succeeds for an empty token string', async () => {
    await expect(revokeToken('', undefined, undefined)).resolves.toBeUndefined();
    expect(db.getRefreshTokenByHash).not.toHaveBeenCalled();
  });
});

describe('TokenError', () => {
  it('exposes OAuth 2.1 error_response shape: { error, error_description, status }', () => {
    const err = new TokenError('invalid_grant', 'PKCE verification failed');
    expect(err.code).toBe('invalid_grant');
    expect(err.description).toBe('PKCE verification failed');
    expect(err.status).toBe(400);
  });

  it('uses 401 for invalid_client per RFC 6749 §5.2', () => {
    const err = new TokenError('invalid_client', 'Unknown client_id', 401);
    expect(err.status).toBe(401);
  });
});
