import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID,
  CLIENT_INFO,
  initializeTestKeys,
  SCOPE,
  sha256Hex,
  USER_ROW,
} from './provider-test-support.ts';

vi.mock('../db.ts', () => ({
  getRefreshTokenByHash: vi.fn(),
  getUserById: vi.fn(),
  insertRefreshToken: vi.fn(),
  revokeAllRefreshTokensForFamily: vi.fn(),
  revokeRefreshToken: vi.fn(),
  rotateRefreshToken: vi.fn(),
}));

vi.mock('./clients-store.ts', () => ({
  getClient: vi.fn(),
}));

import * as db from '../db.ts';
import { getClient } from './clients-store.ts';
import { initKeys, verifyAccessToken } from './jwt.ts';
import { refreshToken, TokenError } from './provider.ts';

const FAMILY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeAll(async () => {
  await initializeTestKeys(initKeys);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refreshToken', () => {
  it('exchanges a valid refresh token for a new access+refresh pair, revoking the old one', async () => {
    const oldRaw = 'rt_' + randomBytes(32).toString('hex');
    const oldRowId = 'rt-row-old';

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: oldRowId,
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      family_id: FAMILY_ID,
      token_hash: sha256Hex(oldRaw),
      scope: SCOPE,
      created_at: new Date(Date.now() - 60_000),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: null,
    });
    vi.mocked(db.getUserById).mockResolvedValueOnce(USER_ROW);
    vi.mocked(db.rotateRefreshToken).mockImplementation(async (_oldTokenId, input) => ({
      id: 'rt-row-new',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      family_id: FAMILY_ID,
      token_hash: input.tokenHash,
      scope: input.scope,
      created_at: new Date(),
      expires_at: input.expiresAt,
      revoked_at: null,
    }));

    const response = await refreshToken(oldRaw, CLIENT_ID);

    expect(response.token_type).toBe('Bearer');
    const payload = await verifyAccessToken(response.access_token);
    expect(payload.sub).toBe(USER_ROW.id);

    expect(response.refresh_token).toMatch(/^rt_[0-9a-f]{64}$/);
    expect(response.refresh_token).not.toBe(oldRaw);

    expect(db.rotateRefreshToken).toHaveBeenCalledWith(
      oldRowId,
      expect.objectContaining({
        tokenHash: sha256Hex(response.refresh_token),
        scope: SCOPE,
      }),
    );
    expect(db.insertRefreshToken).not.toHaveBeenCalled();
    expect(db.revokeRefreshToken).not.toHaveBeenCalled();

    expect(db.getRefreshTokenByHash).toHaveBeenCalledWith(sha256Hex(oldRaw));
    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('allows only one successor when concurrent refreshes race, then revokes the family', async () => {
    const oldRaw = 'rt_' + randomBytes(32).toString('hex');
    const oldRow: db.RefreshTokenRow = {
      id: 'rt-row-raced',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      family_id: FAMILY_ID,
      token_hash: sha256Hex(oldRaw),
      scope: SCOPE,
      created_at: new Date(Date.now() - 60_000),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: null,
    };

    vi.mocked(getClient).mockResolvedValue(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValue(oldRow);
    vi.mocked(db.getUserById).mockResolvedValue(USER_ROW);
    vi.mocked(db.rotateRefreshToken)
      .mockImplementationOnce(async (_oldTokenId, input) => ({
        ...oldRow,
        id: 'rt-row-winner',
        token_hash: input.tokenHash,
        expires_at: input.expiresAt,
      }))
      .mockResolvedValueOnce(null);

    const results = await Promise.allSettled([
      refreshToken(oldRaw, CLIENT_ID),
      refreshToken(oldRaw, CLIENT_ID),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(TokenError);
    expect(rejected[0]?.reason).toMatchObject({ code: 'invalid_grant' });
    expect(db.rotateRefreshToken).toHaveBeenCalledTimes(2);
    expect(db.revokeAllRefreshTokensForFamily).toHaveBeenCalledWith(FAMILY_ID);
  });

  it('revokes the entire token family when a revoked refresh token is replayed', async () => {
    const replayedRaw = 'rt_' + randomBytes(32).toString('hex');

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-row-revoked',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      family_id: FAMILY_ID,
      token_hash: sha256Hex(replayedRaw),
      scope: SCOPE,
      created_at: new Date(Date.now() - 120_000),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: new Date(Date.now() - 60_000),
    });

    await expect(refreshToken(replayedRaw, CLIENT_ID)).rejects.toMatchObject({
      code: 'invalid_grant',
    });

    expect(db.revokeAllRefreshTokensForFamily).toHaveBeenCalledWith(FAMILY_ID);
    expect(db.insertRefreshToken).not.toHaveBeenCalled();
  });

  it('does not revoke a family when an expired revoked refresh token is replayed', async () => {
    const replayedRaw = 'rt_' + randomBytes(32).toString('hex');

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-row-expired-revoked',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      family_id: FAMILY_ID,
      token_hash: sha256Hex(replayedRaw),
      scope: SCOPE,
      created_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
      revoked_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    });

    await expect(refreshToken(replayedRaw, CLIENT_ID)).rejects.toMatchObject({
      code: 'invalid_grant',
    });

    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('does not revoke a family when a revoked refresh token is replayed by another client', async () => {
    const replayedRaw = 'rt_' + randomBytes(32).toString('hex');

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-row-other-client-revoked',
      user_id: USER_ROW.id,
      client_id: 'different-client',
      family_id: FAMILY_ID,
      token_hash: sha256Hex(replayedRaw),
      scope: SCOPE,
      created_at: new Date(Date.now() - 120_000),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: new Date(Date.now() - 60_000),
    });

    await expect(refreshToken(replayedRaw, CLIENT_ID)).rejects.toMatchObject({
      code: 'invalid_grant',
    });

    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('rejects an unknown refresh token with invalid_grant', async () => {
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce(null);

    await expect(refreshToken('rt_unknown', CLIENT_ID)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('rejects an expired refresh token with invalid_grant', async () => {
    const raw = 'rt_' + randomBytes(32).toString('hex');
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-row-expired',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      family_id: FAMILY_ID,
      token_hash: sha256Hex(raw),
      scope: SCOPE,
      created_at: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
      expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
      revoked_at: null,
    });

    await expect(refreshToken(raw, CLIENT_ID)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('rejects a refresh token bound to a different client_id with invalid_grant', async () => {
    const raw = 'rt_' + randomBytes(32).toString('hex');
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-row-other',
      user_id: USER_ROW.id,
      client_id: 'different-client',
      family_id: FAMILY_ID,
      token_hash: sha256Hex(raw),
      scope: SCOPE,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: null,
    });

    await expect(refreshToken(raw, CLIENT_ID)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('rejects unknown client_id with invalid_client (401)', async () => {
    vi.mocked(getClient).mockResolvedValueOnce(undefined);
    await expect(refreshToken('rt_anything', 'unknown')).rejects.toMatchObject({
      code: 'invalid_client',
      status: 401,
    });
  });
});
