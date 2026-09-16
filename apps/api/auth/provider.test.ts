/**
 * Token endpoint provider tests — pure unit, no live DB.
 *
 * Strategy mirrors clients-store.test.ts and google.test.ts:
 *   - db.ts is fully mocked; per-test stubs configure the rows the provider
 *     would see in production.
 *   - clients-store.ts is mocked so getClient() can be primed independently
 *     of the DB stubs.
 *   - jwt.ts is initialized with a fresh Ed25519 pair in beforeAll so
 *     signAccessToken() actually mints a token we can decode and assert
 *     against. We don't mock signAccessToken itself — that would let a bad
 *     contract slip through.
 *
 * Covers every case from the Task 07 acceptance criteria:
 *   1. authorization_code happy path
 *   2. PKCE failure
 *   3. Expired auth code
 *   4. Already-consumed auth code (replay triggers family revocation)
 *   5. refresh_token happy path
 *   6. Old refresh token revoked after rotation
 *   7. Revoked refresh token replay triggers family revocation
 *   8. Unknown client_id → invalid_client
 *   9. Token revocation always succeeds (idempotent)
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock db.ts — every helper the provider touches gets a stub. Type narrows
// happen per-test via vi.mocked().
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
  getUserById: vi.fn(),
  insertAuthCode: vi.fn(),
  consumeAuthCode: vi.fn(),
  getAuthCodeForReplay: vi.fn(),
  insertRefreshToken: vi.fn(),
  getRefreshTokenByHash: vi.fn(),
  revokeRefreshToken: vi.fn(),
  revokeAllRefreshTokensForFamily: vi.fn(),
}));

// Mock clients-store.ts — getClient is the only function the provider uses.
// The route layer uses registerClient + getClient; provider only needs the
// latter so a single mock suffices.
vi.mock('./clients-store.ts', () => ({
  getClient: vi.fn(),
}));

import * as db from '../db.ts';
import { getClient } from './clients-store.ts';
import { initKeys, verifyAccessToken } from './jwt.ts';
import { TokenError, exchangeAuthCode, refreshToken, revokeToken } from './provider.ts';

// --- Test setup -------------------------------------------------------------

beforeAll(async () => {
  // Ed25519 key pair for the JWT signer. signAccessToken throws without
  // initKeys; mocking the signer would let a bad claim shape slip through
  // so we run the real one against a per-test key.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await initKeys(
    privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Helpers ---------------------------------------------------------------

/** Compute the S256 PKCE challenge from a verifier. Mirrors the
 *  client-side computation. */
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** SHA-256(hex) — matches the storage hash used by provider.ts. */
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const CLIENT_ID = 'a1b2c3d4-e5f6-4321-9876-abcdef012345';
const REDIRECT_URI = 'http://localhost:9876/callback';
const SCOPE = 'page:create page:read';

const CLIENT_INFO = {
  client_id: CLIENT_ID,
  client_id_issued_at: Math.floor(Date.now() / 1000),
  redirect_uris: [REDIRECT_URI],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

const USER_ROW: db.UserRow = {
  id: '11111111-2222-3333-4444-555555555555',
  handle: 'alex',
  email: 'alex@blockful.io',
  name: 'Alex',
  avatar_url: null,
  created_at: new Date('2026-05-01T00:00:00Z'),
  updated_at: new Date('2026-05-01T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// authorization_code grant
// ---------------------------------------------------------------------------

describe('exchangeAuthCode', () => {
  it('exchanges a valid code + verifier for a JWT access token + refresh token', async () => {
    const verifier = 'test-verifier-string-with-enough-entropy-12345';
    const challenge = pkceChallenge(verifier);

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.consumeAuthCode).mockResolvedValueOnce({
      userId: USER_ROW.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: SCOPE,
      resource: null,
    });
    vi.mocked(db.getUserById).mockResolvedValueOnce(USER_ROW);
    vi.mocked(db.insertRefreshToken).mockImplementation(async (input) => ({
      id: 'rt-row-id',
      user_id: input.userId,
      client_id: input.clientId,
      token_hash: input.tokenHash,
      scope: input.scope,
      created_at: new Date(),
      expires_at: input.expiresAt,
      revoked_at: null,
    }));

    const response = await exchangeAuthCode('auth-code-abc', CLIENT_ID, REDIRECT_URI, verifier);

    // TokenResponse shape.
    expect(response.token_type).toBe('Bearer');
    expect(response.expires_in).toBe(3600);
    expect(response.scope).toBe(SCOPE);

    // Access token is a JWT signed by the Ed25519 key — round-trip via
    // verifyAccessToken proves the signature is valid and the claims are
    // populated.
    const payload = await verifyAccessToken(response.access_token);
    expect(payload.sub).toBe(USER_ROW.id);
    expect(payload.email).toBe(USER_ROW.email);
    expect(payload.handle).toBe(USER_ROW.handle);
    expect(payload.client_id).toBe(CLIENT_ID);
    expect(payload.scope).toBe(SCOPE);

    // Refresh token format: rt_ + 64 hex chars (32 bytes hex-encoded).
    expect(response.refresh_token).toMatch(/^rt_[0-9a-f]{64}$/);

    // The DB row stores the SHA-256 hash, not the raw token.
    const insertArg = vi.mocked(db.insertRefreshToken).mock.calls[0]![0];
    expect(insertArg.tokenHash).toBe(sha256Hex(response.refresh_token));
    expect(insertArg.tokenHash).not.toBe(response.refresh_token);
    expect(insertArg.userId).toBe(USER_ROW.id);
    expect(insertArg.clientId).toBe(CLIENT_ID);
    expect(insertArg.scope).toBe(SCOPE);
    // 90-day expiry by default (REFRESH_TOKEN_MAX_DAYS).
    const ttlMs = insertArg.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(91 * 24 * 60 * 60 * 1000);
  });

  it('rejects invalid PKCE verifier with invalid_grant', async () => {
    const verifier = 'correct-verifier-string-with-enough-entropy';
    const challenge = pkceChallenge(verifier);

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.consumeAuthCode).mockResolvedValueOnce({
      userId: USER_ROW.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: SCOPE,
      resource: null,
    });

    await expect(
      exchangeAuthCode(
        'auth-code-abc',
        CLIENT_ID,
        REDIRECT_URI,
        // Off-by-one: change a single char so the SHA-256 mismatches.
        verifier.slice(0, -1) + 'X',
      ),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });

    // No refresh token issued on PKCE failure.
    expect(db.insertRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects unknown / expired authorization code with invalid_grant', async () => {
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    // consumeAuthCode returns null for unknown / expired / consumed.
    vi.mocked(db.consumeAuthCode).mockResolvedValueOnce(null);
    // No row exists for the replay disambiguation.
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(null);

    await expect(
      exchangeAuthCode('expired-code', CLIENT_ID, REDIRECT_URI, 'verifier'),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('detects auth code replay and revokes the issued refresh-token family', async () => {
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.consumeAuthCode).mockResolvedValueOnce(null);
    // The code exists but has been consumed — classic replay.
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce({
      code: 'replay-code',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: 'irrelevant',
      code_challenge_method: 'S256',
      scope: SCOPE,
      resource: null,
      created_at: new Date(Date.now() - 60_000),
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: new Date(Date.now() - 30_000),
    });

    await expect(
      exchangeAuthCode('replay-code', CLIENT_ID, REDIRECT_URI, 'verifier'),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    // RFC 6749 §4.1.2 SHOULD: revoke any tokens issued from the replayed code.
    expect(db.revokeAllRefreshTokensForFamily).toHaveBeenCalledWith(USER_ROW.id, CLIENT_ID);
  });

  it('rejects unknown client_id with invalid_client (401)', async () => {
    vi.mocked(getClient).mockResolvedValueOnce(undefined);

    await expect(
      exchangeAuthCode('code', 'no-such-client', REDIRECT_URI, 'verifier'),
    ).rejects.toMatchObject({
      code: 'invalid_client',
      status: 401,
    });
    // We don't even reach the DB if the client is unknown.
    expect(db.consumeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects redirect_uri mismatch with invalid_grant', async () => {
    const verifier = 'test-verifier-string-with-enough-entropy-12345';
    const challenge = pkceChallenge(verifier);
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.consumeAuthCode).mockResolvedValueOnce({
      userId: USER_ROW.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: SCOPE,
      resource: null,
    });

    await expect(
      exchangeAuthCode('code', CLIENT_ID, 'http://attacker.example.com/cb', verifier),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
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

// ---------------------------------------------------------------------------
// refresh_token grant — rotation + family revocation
// ---------------------------------------------------------------------------

describe('refreshToken', () => {
  it('exchanges a valid refresh token for a new access+refresh pair, revoking the old one', async () => {
    const oldRaw = 'rt_' + randomBytes(32).toString('hex');
    const oldRowId = 'rt-row-old';

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: oldRowId,
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      token_hash: sha256Hex(oldRaw),
      scope: SCOPE,
      created_at: new Date(Date.now() - 60_000),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: null,
    });
    vi.mocked(db.getUserById).mockResolvedValueOnce(USER_ROW);
    vi.mocked(db.insertRefreshToken).mockImplementation(async (input) => ({
      id: 'rt-row-new',
      user_id: input.userId,
      client_id: input.clientId,
      token_hash: input.tokenHash,
      scope: input.scope,
      created_at: new Date(),
      expires_at: input.expiresAt,
      revoked_at: null,
    }));

    const response = await refreshToken(oldRaw, CLIENT_ID);

    // New access token is a JWT.
    expect(response.token_type).toBe('Bearer');
    const payload = await verifyAccessToken(response.access_token);
    expect(payload.sub).toBe(USER_ROW.id);

    // New refresh token is different and matches the format.
    expect(response.refresh_token).toMatch(/^rt_[0-9a-f]{64}$/);
    expect(response.refresh_token).not.toBe(oldRaw);

    // The new refresh token was inserted, AND the old one was revoked.
    expect(db.insertRefreshToken).toHaveBeenCalledTimes(1);
    expect(db.revokeRefreshToken).toHaveBeenCalledWith(oldRowId);

    // The hashed lookup used the SHA-256 of the raw token (defense-in-depth).
    expect(db.getRefreshTokenByHash).toHaveBeenCalledWith(sha256Hex(oldRaw));

    // Family revocation NOT triggered on the happy path.
    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('revokes the entire token family when a revoked refresh token is replayed', async () => {
    const replayedRaw = 'rt_' + randomBytes(32).toString('hex');

    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-row-revoked',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      token_hash: sha256Hex(replayedRaw),
      scope: SCOPE,
      created_at: new Date(Date.now() - 120_000),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      // Already revoked — this is the replay signal.
      revoked_at: new Date(Date.now() - 60_000),
    });

    await expect(refreshToken(replayedRaw, CLIENT_ID)).rejects.toMatchObject({
      code: 'invalid_grant',
    });

    // The defining behaviour of token family revocation: every active refresh
    // for (user_id, client_id) gets killed.
    expect(db.revokeAllRefreshTokensForFamily).toHaveBeenCalledWith(USER_ROW.id, CLIENT_ID);
    // No new tokens issued on replay.
    expect(db.insertRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects an unknown refresh token with invalid_grant', async () => {
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce(null);

    await expect(refreshToken('rt_unknown', CLIENT_ID)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    // No family revocation when we don't know who the token belongs to.
    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('rejects an expired refresh token with invalid_grant', async () => {
    const raw = 'rt_' + randomBytes(32).toString('hex');
    vi.mocked(getClient).mockResolvedValueOnce(CLIENT_INFO);
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-row-expired',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      token_hash: sha256Hex(raw),
      scope: SCOPE,
      created_at: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
      // Expired one day ago.
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
      // Bound to a DIFFERENT client than the one in the request.
      client_id: 'different-client',
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

// ---------------------------------------------------------------------------
// Token revocation (RFC 7009)
// ---------------------------------------------------------------------------

describe('revokeToken', () => {
  it('marks a refresh token as revoked when it exists and is active', async () => {
    const raw = 'rt_' + randomBytes(32).toString('hex');
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-id',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      token_hash: sha256Hex(raw),
      scope: SCOPE,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: null,
    });

    await revokeToken(raw, undefined, undefined);

    expect(db.revokeRefreshToken).toHaveBeenCalledWith('rt-id');
  });

  it('silently succeeds for an unknown refresh token (no error, no revoke)', async () => {
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce(null);
    // Per RFC 7009 the response is the same regardless — the function returns
    // void and doesn't throw.
    await expect(revokeToken('rt_unknown', undefined, undefined)).resolves.toBeUndefined();
    expect(db.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it('does not re-revoke an already-revoked token', async () => {
    const raw = 'rt_' + randomBytes(32).toString('hex');
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-already',
      user_id: USER_ROW.id,
      client_id: CLIENT_ID,
      token_hash: sha256Hex(raw),
      scope: SCOPE,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      revoked_at: new Date(),
    });

    await revokeToken(raw, undefined, undefined);
    expect(db.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it('is a no-op for non-rt_-prefixed tokens (V1 access tokens have no denylist)', async () => {
    // Per RFC 7009 §2.2, this is allowed — the server SHOULD revoke an access
    // token if it can, but pagent V1 doesn't index JWTs server-side, so the
    // call silently returns.
    await revokeToken('eyJhbGciOiJFZERTQSJ9.fake-jwt-payload.fake-signature', undefined, undefined);
    expect(db.getRefreshTokenByHash).not.toHaveBeenCalled();
    expect(db.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it('silently succeeds for an empty token string', async () => {
    await expect(revokeToken('', undefined, undefined)).resolves.toBeUndefined();
    expect(db.getRefreshTokenByHash).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TokenError shape
// ---------------------------------------------------------------------------

describe('TokenError', () => {
  it('exposes OAuth 2.1 error_response shape: { error, error_description, status }', () => {
    const err = new TokenError('invalid_grant', 'PKCE verification failed');
    expect(err.code).toBe('invalid_grant');
    expect(err.description).toBe('PKCE verification failed');
    // Default status for client errors is 400 (RFC 6749 §5.2).
    expect(err.status).toBe(400);
  });

  it('uses 401 for invalid_client per RFC 6749 §5.2', () => {
    const err = new TokenError('invalid_client', 'Unknown client_id', 401);
    expect(err.status).toBe(401);
  });
});
