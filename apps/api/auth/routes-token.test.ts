import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, NOW, app, db } from './routes-test-support.ts';

const TOKEN_CLIENT_ID = 'b1c2d3e4-f5a6-7890-1234-bcdef0123456';
const TOKEN_REDIRECT_URI = 'http://localhost:9876/cb';
const TOKEN_CLIENT_ROW = {
  client_id: TOKEN_CLIENT_ID,
  client_secret: null,
  client_secret_expires_at: null,
  client_id_issued_at: NOW,
  client_name: null,
  client_uri: null,
  logo_uri: null,
  redirect_uris: [TOKEN_REDIRECT_URI],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: null,
  token_endpoint_auth_method: 'none',
};
const TOKEN_USER_ROW = {
  id: '22222222-3333-4444-5555-666666666666',
  handle: 'tester',
  email: 'tester@example.com',
  name: null,
  avatar_url: null,
  created_at: NOW,
  updated_at: NOW,
};

function postToken(
  body: Record<string, string>,
  opts: { contentType?: 'form' | 'json'; xForwardedFor?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  let serialized: string;
  if (opts.contentType === 'json') {
    headers['Content-Type'] = 'application/json';
    serialized = JSON.stringify(body);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    serialized = new URLSearchParams(body).toString();
  }
  if (opts.xForwardedFor !== undefined) headers['x-forwarded-for'] = opts.xForwardedFor;
  return new Request(`${BASE}/oauth/token`, { method: 'POST', headers, body: serialized });
}

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('POST /oauth/token', () => {
  beforeEach(() => {
    vi.mocked(db.getOAuthClientById).mockReset();
    vi.mocked(db.consumeAuthCodeAndInsertRefreshToken).mockReset();
    vi.mocked(db.getAuthCodeForReplay).mockReset();
    vi.mocked(db.getUserById).mockReset();
    vi.mocked(db.insertRefreshToken).mockReset();
    vi.mocked(db.getRefreshTokenByHash).mockReset();
    vi.mocked(db.revokeRefreshToken).mockReset();
    vi.mocked(db.revokeAllRefreshTokensForFamily).mockReset();
  });

  it('exchanges authorization_code grant for tokens (form-encoded body)', async () => {
    const verifier = 'integration-test-verifier-with-enough-entropy';
    const challenge = pkceS256(verifier);
    vi.mocked(db.getOAuthClientById).mockResolvedValue(TOKEN_CLIENT_ROW);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce({
      code: 'test-auth-code',
      user_id: TOKEN_USER_ROW.id,
      client_id: TOKEN_CLIENT_ID,
      redirect_uri: TOKEN_REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'page:create',
      resource: null,
      created_at: new Date(Date.now() - 60_000),
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
    });
    vi.mocked(db.consumeAuthCodeAndInsertRefreshToken).mockResolvedValueOnce({
      userId: TOKEN_USER_ROW.id,
      clientId: TOKEN_CLIENT_ID,
      redirectUri: TOKEN_REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'page:create',
      resource: null,
    });
    vi.mocked(db.getUserById).mockResolvedValueOnce(TOKEN_USER_ROW);
    vi.mocked(db.insertRefreshToken).mockImplementation(async (input) => ({
      id: 'rt-id',
      user_id: input.userId,
      client_id: input.clientId,
      token_hash: input.tokenHash,
      scope: input.scope,
      created_at: new Date(),
      expires_at: input.expiresAt,
      revoked_at: null,
    }));
    const res = await app.fetch(
      postToken(
        {
          grant_type: 'authorization_code',
          code: 'test-auth-code',
          client_id: TOKEN_CLIENT_ID,
          redirect_uri: TOKEN_REDIRECT_URI,
          code_verifier: verifier,
        },
        { xForwardedFor: '10.1.0.1' },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(typeof body.access_token).toBe('string');
    expect((body.access_token as string).split('.')).toHaveLength(3);
    expect((body.refresh_token as string).startsWith('rt_')).toBe(true);
    expect(body.scope).toBe('page:create');
  });

  it('rejects application/json body with invalid_request (400)', async () => {
    const res = await app.fetch(
      postToken(
        {
          grant_type: 'authorization_code',
          code: 'x',
          client_id: TOKEN_CLIENT_ID,
          redirect_uri: TOKEN_REDIRECT_URI,
          code_verifier: 'v',
        },
        { contentType: 'json', xForwardedFor: '10.1.0.2' },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
    expect(typeof body.error_description).toBe('string');
    expect((body.error_description as string).toLowerCase()).toContain('x-www-form-urlencoded');
  });

  it('returns unsupported_grant_type for unknown grants (400)', async () => {
    const res = await app.fetch(
      postToken(
        { grant_type: 'password', username: 'x', password: 'y' },
        { xForwardedFor: '10.1.0.3' },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unsupported_grant_type');
    expect(typeof body.error_description).toBe('string');
  });

  it('returns invalid_request when grant_type is missing', async () => {
    const res = await app.fetch(postToken({ code: 'x' }, { xForwardedFor: '10.1.0.4' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  it('returns invalid_grant for an invalid auth code (no consume row)', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValue(TOKEN_CLIENT_ROW);
    vi.mocked(db.getAuthCodeForReplay).mockResolvedValueOnce(null);
    const res = await app.fetch(
      postToken(
        {
          grant_type: 'authorization_code',
          code: 'unknown',
          client_id: TOKEN_CLIENT_ID,
          redirect_uri: TOKEN_REDIRECT_URI,
          code_verifier: 'v',
        },
        { xForwardedFor: '10.1.0.5' },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });

  it('returns invalid_client (401) for unknown client_id', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValue(null);
    const res = await app.fetch(
      postToken(
        {
          grant_type: 'authorization_code',
          code: 'x',
          client_id: 'no-such-client',
          redirect_uri: TOKEN_REDIRECT_URI,
          code_verifier: 'v',
        },
        { xForwardedFor: '10.1.0.6' },
      ),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client');
  });

  it('rate-limits at 20 per IP per minute (21st request → 429)', async () => {
    const ip = '203.0.113.50';
    vi.mocked(db.getOAuthClientById).mockResolvedValue(null);
    for (let i = 0; i < 20; i++) {
      const res = await app.fetch(
        postToken(
          {
            grant_type: 'authorization_code',
            code: 'x',
            client_id: 'no-such-client',
            redirect_uri: TOKEN_REDIRECT_URI,
            code_verifier: 'v',
          },
          { xForwardedFor: ip },
        ),
      );
      expect(res.status, `request ${i + 1} of 20 should not be rate-limited`).not.toBe(429);
    }
    const limited = await app.fetch(
      postToken(
        {
          grant_type: 'authorization_code',
          code: 'x',
          client_id: 'no-such-client',
          redirect_uri: TOKEN_REDIRECT_URI,
          code_verifier: 'v',
        },
        { xForwardedFor: ip },
      ),
    );
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retry_after_seconds).toBe('number');
    expect(limited.headers.get('Retry-After')).toBe(String(body.retry_after_seconds));
  });
});
