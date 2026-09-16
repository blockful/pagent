import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCodeRow } from '../db/auth-codes.ts';
import {
  CLIENT_ID,
  CLIENT_INFO,
  initializeTestKeys,
  pkceChallenge,
  REDIRECT_URI,
  SCOPE,
  sha256Hex,
  USER_ROW,
} from './provider-test-support.ts';

vi.mock('../db.ts', () => ({
  consumeAuthCodeAndInsertRefreshToken: vi.fn(),
  getAuthCodeForReplay: vi.fn(),
  getUserById: vi.fn(),
  revokeAllRefreshTokensForFamily: vi.fn(),
}));

vi.mock('./clients-store.ts', () => ({
  getClient: vi.fn(),
}));

import * as db from '../db.ts';
import { getClient } from './clients-store.ts';
import { initKeys, verifyAccessToken } from './jwt.ts';
import { exchangeAuthCode } from './provider.ts';

beforeAll(async () => {
  await initializeTestKeys(initKeys);
});

beforeEach(() => {
  vi.clearAllMocks();
});

function storedAuthCode(codeChallenge: string, overrides: Partial<AuthCodeRow> = {}): AuthCodeRow {
  return {
    code: 'auth-code-abc',
    user_id: USER_ROW.id,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: SCOPE,
    resource: null,
    refresh_token_family_id: 'grant-family-1',
    created_at: new Date(Date.now() - 60_000),
    expires_at: new Date(Date.now() + 60_000),
    consumed_at: null,
    ...overrides,
  };
}

describe('exchangeAuthCode', () => {
  it('exchanges a valid code + verifier for a JWT access token + refresh token', async () => {
    const verifier = 'test-verifier-string-with-enough-entropy-12345';
    const challenge = pkceChallenge(verifier);

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(storedAuthCode(challenge));
    vi.mocked(db.consumeAuthCodeAndInsertRefreshToken).mockResolvedValueOnce({
      userId: USER_ROW.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: SCOPE,
      resource: null,
      refreshTokenFamilyId: 'grant-family-1',
    });
    vi.mocked(db.getUserById).mockResolvedValueOnce(USER_ROW);
    const response = await exchangeAuthCode('auth-code-abc', CLIENT_ID, REDIRECT_URI, verifier);

    expect(response.token_type).toBe('Bearer');
    expect(response.expires_in).toBe(3600);
    expect(response.scope).toBe(SCOPE);

    const payload = await verifyAccessToken(response.access_token);
    expect(payload.sub).toBe(USER_ROW.id);
    expect(payload.email).toBe(USER_ROW.email);
    expect(payload.handle).toBe(USER_ROW.handle);
    expect(payload.client_id).toBe(CLIENT_ID);
    expect(payload.scope).toBe(SCOPE);

    expect(response.refresh_token).toMatch(/^rt_[0-9a-f]{64}$/);

    const insertArg = vi.mocked(db.consumeAuthCodeAndInsertRefreshToken).mock.calls.at(0)?.[1];
    expect(insertArg?.tokenHash).toBe(sha256Hex(response.refresh_token));
    expect(insertArg?.tokenHash).not.toBe(response.refresh_token);
    expect(insertArg?.userId).toBe(USER_ROW.id);
    expect(insertArg?.clientId).toBe(CLIENT_ID);
    expect(insertArg?.familyId).toBe('grant-family-1');
    expect(insertArg?.scope).toBe(SCOPE);
    const ttlMs = (insertArg?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttlMs).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(91 * 24 * 60 * 60 * 1000);
  });

  it('rejects invalid PKCE verifier with invalid_grant', async () => {
    const verifier = 'correct-verifier-string-with-enough-entropy';
    const challenge = pkceChallenge(verifier);

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(storedAuthCode(challenge));

    await expect(
      exchangeAuthCode('auth-code-abc', CLIENT_ID, REDIRECT_URI, verifier.slice(0, -1) + 'X'),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });

    expect(db.consumeAuthCodeAndInsertRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects unknown / expired authorization code with invalid_grant', async () => {
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(null);

    await expect(
      exchangeAuthCode('expired-code', CLIENT_ID, REDIRECT_URI, 'verifier'),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(db.consumeAuthCodeAndInsertRefreshToken).not.toHaveBeenCalled();
  });

  it('detects auth code replay and revokes the issued refresh-token family', async () => {
    const verifier = 'replay-verifier-string-with-enough-entropy';
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(
      storedAuthCode(pkceChallenge(verifier), {
        code: 'replay-code',
        consumed_at: new Date(Date.now() - 30_000),
      }),
    );

    await expect(
      exchangeAuthCode('replay-code', CLIENT_ID, REDIRECT_URI, verifier),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    expect(db.revokeAllRefreshTokensForFamily).toHaveBeenCalledWith('grant-family-1');
    expect(db.consumeAuthCodeAndInsertRefreshToken).not.toHaveBeenCalled();
  });

  it('revokes the refresh-token family when a concurrent exchange wins consumption', async () => {
    const verifier = 'test-verifier-string-with-enough-entropy-12345';
    const challenge = pkceChallenge(verifier);
    const stored = storedAuthCode(challenge, { code: 'raced-code' });
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay)
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({ ...stored, consumed_at: new Date() });
    vi.mocked(db.getUserById).mockResolvedValueOnce(USER_ROW);
    vi.mocked(db.consumeAuthCodeAndInsertRefreshToken).mockResolvedValueOnce(null);

    await expect(
      exchangeAuthCode('raced-code', CLIENT_ID, REDIRECT_URI, verifier),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    expect(db.consumeAuthCodeAndInsertRefreshToken).toHaveBeenCalledOnce();
    expect(db.revokeAllRefreshTokensForFamily).toHaveBeenCalledWith('grant-family-1');
  });

  it('does not revoke for a consumed code with an invalid PKCE verifier', async () => {
    const verifier = 'correct-consumed-verifier-with-enough-entropy';
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(
      storedAuthCode(pkceChallenge(verifier), { consumed_at: new Date() }),
    );

    await expect(
      exchangeAuthCode('consumed-code', CLIENT_ID, REDIRECT_URI, `${verifier}-wrong`),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('does not revoke for a consumed code with a mismatched client or redirect', async () => {
    const verifier = 'bound-consumed-verifier-with-enough-entropy';
    const consumed = storedAuthCode(pkceChallenge(verifier), { consumed_at: new Date() });
    vi.mocked(getClient).mockResolvedValue(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValue(consumed);

    await expect(
      exchangeAuthCode(
        'consumed-code',
        '22222222-3333-4444-5555-666666666666',
        REDIRECT_URI,
        verifier,
      ),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(
      exchangeAuthCode('consumed-code', CLIENT_ID, 'https://attacker.example/callback', verifier),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('does not revoke for an expired consumed code', async () => {
    const verifier = 'expired-consumed-verifier-with-enough-entropy';
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(
      storedAuthCode(pkceChallenge(verifier), {
        expires_at: new Date(Date.now() - 1_000),
        consumed_at: new Date(Date.now() - 2_000),
      }),
    );

    await expect(
      exchangeAuthCode('expired-consumed-code', CLIENT_ID, REDIRECT_URI, verifier),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('rejects unknown client_id with invalid_client (401)', async () => {
    vi.mocked(getClient).mockResolvedValueOnce(undefined);

    await expect(
      exchangeAuthCode('code', 'no-such-client', REDIRECT_URI, 'verifier'),
    ).rejects.toMatchObject({
      code: 'invalid_client',
      status: 401,
    });
    expect(db.consumeAuthCodeAndInsertRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects redirect_uri mismatch with invalid_grant', async () => {
    const verifier = 'test-verifier-string-with-enough-entropy-12345';
    const challenge = pkceChallenge(verifier);
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(storedAuthCode(challenge));

    await expect(
      exchangeAuthCode('code', CLIENT_ID, 'http://attacker.example.com/cb', verifier),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(db.consumeAuthCodeAndInsertRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects a registered client_id mismatch without consuming the code', async () => {
    const verifier = 'test-verifier-string-with-enough-entropy-12345';
    const challenge = pkceChallenge(verifier);
    const otherClientId = '22222222-3333-4444-5555-666666666666';
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(storedAuthCode(challenge));

    await expect(
      exchangeAuthCode('auth-code-abc', otherClientId, REDIRECT_URI, verifier),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    expect(db.consumeAuthCodeAndInsertRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects missing required parameters with invalid_request', async () => {
    await expect(exchangeAuthCode('', CLIENT_ID, REDIRECT_URI, 'verifier')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(exchangeAuthCode('code', '', REDIRECT_URI, 'verifier')).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
