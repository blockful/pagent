/**
 * OAuth discovery / metadata endpoint tests.
 *
 * Exercises the three .well-known routes mounted in app.ts:
 *   - /.well-known/oauth-authorization-server (RFC 8414)
 *   - /.well-known/oauth-protected-resource    (RFC 9728)
 *   - /.well-known/jwks.json                   (RFC 7517)
 *
 * The JWKS endpoint reaches into the jwt module's cached public key, so we
 * call initKeys() once in beforeAll with a fresh Ed25519 pair generated
 * in-process. The DB mock matches app.test.ts so importing app.ts doesn't
 * try to open a real Postgres connection.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { SignJWT, exportJWK } from 'jose';

// Mock db.ts before importing app.ts (which imports it transitively).
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
  // Token endpoint helpers (Task 07) — used by /oauth/token and /oauth/revoke.
  // Stubbed here so the existing well-known / register tests don't break when
  // the routes file imports provider's new functions.
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
  // Session helpers (Task 08) — used by resolveAuth middleware + /auth/me +
  // /auth/logout + browser_session callback paths. Stubbed so tests can drive
  // the cookie-session state directly without a live Postgres.
  insertSession: vi.fn(() => Promise.resolve()),
  getSessionWithUserByTokenHash: vi.fn(() => Promise.resolve(null)),
  extendSessionExpiry: vi.fn(() => Promise.resolve()),
  deleteSessionByTokenHash: vi.fn(() => Promise.resolve()),
  // Magic link + Google callback helpers — referenced by the browser_session
  // tests below so the verify path can succeed without a real magic link row.
  insertMagicLink: vi.fn(() => Promise.resolve()),
  verifyAndConsumeMagicLink: vi.fn(() => Promise.resolve(null)),
}));

import * as db from '../db.ts';
import { app } from '../app.ts';
import { initKeys, KID, getIssuer } from './jwt.ts';

const BASE = 'http://localhost';

/** Generate a fresh Ed25519 key pair and feed it to initKeys(). */
async function setupKeys(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signingKeyB64u = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
  const publicKeyB64u = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  await initKeys(signingKeyB64u, publicKeyB64u);
}

beforeAll(async () => {
  await setupKeys();
});

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// AS metadata (RFC 8414)
// ---------------------------------------------------------------------------

describe('GET /.well-known/oauth-authorization-server', () => {
  it('returns 200 with application/json content-type', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('issuer matches getIssuer() (derived from PUBLIC_URL)', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const body = await json(res);
    expect(body.issuer).toBe(getIssuer());
  });

  it('endpoint URLs use PUBLIC_URL as the base (no hardcoded api.pagent.link)', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const body = await json(res);
    const issuer = getIssuer();
    expect(body.authorization_endpoint).toBe(`${issuer}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${issuer}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${issuer}/oauth/register`);
    expect(body.revocation_endpoint).toBe(`${issuer}/oauth/revoke`);
    // Guard against accidental reintroduction of the spec's example URL.
    for (const v of Object.values(body)) {
      if (typeof v === 'string') {
        expect(v).not.toContain('api.pagent.link');
      }
    }
  });

  it('has every field RFC 8414 requires for our profile', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const body = await json(res);
    const required = [
      'issuer',
      'authorization_endpoint',
      'token_endpoint',
      'registration_endpoint',
      'revocation_endpoint',
      'response_types_supported',
      'grant_types_supported',
      'token_endpoint_auth_methods_supported',
      'code_challenge_methods_supported',
      'scopes_supported',
      'service_documentation',
    ];
    for (const k of required) {
      expect(body).toHaveProperty(k);
    }
  });

  it('response_types_supported = ["code"]', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const body = await json(res);
    expect(body.response_types_supported).toEqual(['code']);
  });

  it('grant_types_supported includes authorization_code and refresh_token', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const body = await json(res);
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  });

  it('token_endpoint_auth_methods_supported = ["none"] (public clients only)', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const body = await json(res);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('code_challenge_methods_supported = ["S256"] only — no plain', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const body = await json(res);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.code_challenge_methods_supported).not.toContain('plain');
  });

  it('scopes_supported = ["page:create", "page:read", "page:write"]', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const body = await json(res);
    expect(body.scopes_supported).toEqual(['page:create', 'page:read', 'page:write']);
  });
});

// ---------------------------------------------------------------------------
// Protected Resource metadata (RFC 9728)
// ---------------------------------------------------------------------------

describe('GET /.well-known/oauth-protected-resource', () => {
  it('returns 200 with application/json content-type', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('resource and authorization_servers[0] both equal PUBLIC_URL', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    const body = await json(res);
    const issuer = getIssuer();
    expect(body.resource).toBe(issuer);
    expect(body.authorization_servers).toEqual([issuer]);
  });

  it('has every field RFC 9728 requires for our profile', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    const body = await json(res);
    const required = [
      'resource',
      'authorization_servers',
      'scopes_supported',
      'bearer_methods_supported',
      'resource_name',
      'resource_documentation',
    ];
    for (const k of required) {
      expect(body).toHaveProperty(k);
    }
  });

  it('scopes_supported matches the AS metadata', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    const body = await json(res);
    expect(body.scopes_supported).toEqual(['page:create', 'page:read', 'page:write']);
  });

  it('bearer_methods_supported = ["header"] (header-only, no query/body)', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    const body = await json(res);
    expect(body.bearer_methods_supported).toEqual(['header']);
  });

  it('resource_name = "Pagent API"', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    const body = await json(res);
    expect(body.resource_name).toBe('Pagent API');
  });
});

// ---------------------------------------------------------------------------
// JWKS (RFC 7517)
// ---------------------------------------------------------------------------

describe('GET /.well-known/jwks.json', () => {
  it('returns 200 with application/json content-type', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/jwks.json`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('returns a single Ed25519 OKP key', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/jwks.json`));
    const body = await json(res);
    expect(Array.isArray(body.keys)).toBe(true);
    const keys = body.keys as Array<Record<string, unknown>>;
    expect(keys).toHaveLength(1);
    const key = keys[0];
    expect(key.kty).toBe('OKP');
    expect(key.crv).toBe('Ed25519');
    expect(key.use).toBe('sig');
    expect(key.kid).toBe(KID);
  });

  it('does not leak the private-key material (no `d` field)', async () => {
    // Defense in depth — the jwt module's getJwks already enforces this, but
    // a regression at this layer (e.g. accidentally spreading a private JWK)
    // would expose the signing key. Worth catching at the route boundary.
    const res = await app.fetch(new Request(`${BASE}/.well-known/jwks.json`));
    const body = await json(res);
    const key = (body.keys as Array<Record<string, unknown>>)[0];
    expect(key.d).toBeUndefined();
  });

  it('public key x is a 43-char base64url string (Ed25519 raw 32 bytes)', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/jwks.json`));
    const body = await json(res);
    const key = (body.keys as Array<Record<string, unknown>>)[0];
    expect(typeof key.x).toBe('string');
    expect((key.x as string).length).toBe(43);
  });
});

// ---------------------------------------------------------------------------
// Public access (no auth middleware applied)
// ---------------------------------------------------------------------------

describe('discovery endpoints are public', () => {
  // The three .well-known routes must be reachable without any Authorization
  // header. This isn't a "no auth middleware" assertion (there isn't one yet
  // in app.ts) but it locks in the contract so a future addition of auth
  // middleware can't accidentally cover these paths.
  const paths = [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/jwks.json',
  ];

  for (const path of paths) {
    it(`GET ${path} returns 200 with no Authorization header`, async () => {
      const res = await app.fetch(new Request(`${BASE}${path}`));
      expect(res.status).toBe(200);
    });
  }
});

// ---------------------------------------------------------------------------
// POST /oauth/register (RFC 7591 dynamic client registration)
// ---------------------------------------------------------------------------
// Integration test through the Hono app: validates the route layer's
// argument forwarding, response shape, error mapping, and rate limiter.

import { beforeEach } from 'vitest';

const NOW = new Date('2026-05-17T12:00:00Z');

function registerRow(overrides: Partial<Parameters<typeof db.insertOAuthClient>[0]> = {}) {
  return {
    client_id: overrides.client_id ?? 'a1b2c3d4-e5f6-4321-9876-abcdef012345',
    client_secret: null,
    client_secret_expires_at: null,
    client_id_issued_at: NOW,
    client_name: overrides.client_name ?? null,
    client_uri: overrides.client_uri ?? null,
    logo_uri: overrides.logo_uri ?? null,
    redirect_uris: overrides.redirect_uris ?? ['http://localhost:9876/callback'],
    grant_types: overrides.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: overrides.response_types ?? ['code'],
    scope: overrides.scope ?? null,
    token_endpoint_auth_method: overrides.token_endpoint_auth_method ?? 'none',
  };
}

function postRegister(body: unknown, xForwardedFor?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (xForwardedFor !== undefined) headers['x-forwarded-for'] = xForwardedFor;
  return new Request(`${BASE}/oauth/register`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /oauth/register', () => {
  beforeEach(() => {
    vi.mocked(db.insertOAuthClient).mockReset();
  });

  it('returns 201 with OAuthClientInformationFull on valid registration', async () => {
    vi.mocked(db.insertOAuthClient).mockImplementation(async (input) => registerRow({ ...input }));

    const res = await app.fetch(
      postRegister(
        {
          redirect_uris: ['http://localhost:9876/callback'],
          client_name: 'Claude Code',
        },
        '10.0.0.1',
      ),
    );

    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe('string');
    expect(body.client_name).toBe('Claude Code');
    expect(body.redirect_uris).toEqual(['http://localhost:9876/callback']);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.response_types).toEqual(['code']);
    expect(typeof body.client_id_issued_at).toBe('number');
    expect(body.client_secret).toBeUndefined();
  });

  it('returns 400 invalid_client_metadata when body is not JSON object', async () => {
    vi.mocked(db.insertOAuthClient).mockResolvedValueOnce(registerRow());

    const res = await app.fetch(postRegister('not-json', '10.0.0.2'));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client_metadata');
    expect(typeof body.error_description).toBe('string');
    expect(db.insertOAuthClient).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_client_metadata when redirect_uris is missing', async () => {
    const res = await app.fetch(postRegister({ client_name: 'No URI' }, '10.0.0.3'));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client_metadata');
    expect((body.error_description as string).toLowerCase()).toContain('redirect_uris');
    expect(db.insertOAuthClient).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_client_metadata when redirect_uris has invalid URI', async () => {
    const res = await app.fetch(postRegister({ redirect_uris: ['not a uri'] }, '10.0.0.4'));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client_metadata');
    expect(db.insertOAuthClient).not.toHaveBeenCalled();
  });

  it('returns 400 when redirect_uris is empty array', async () => {
    const res = await app.fetch(postRegister({ redirect_uris: [] }, '10.0.0.5'));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('applies defaults when grant_types/response_types are omitted', async () => {
    vi.mocked(db.insertOAuthClient).mockImplementation(async (input) => registerRow({ ...input }));

    const res = await app.fetch(
      postRegister({ redirect_uris: ['http://localhost:9876/callback'] }, '10.0.0.6'),
    );

    expect(res.status).toBe(201);
    const arg = vi.mocked(db.insertOAuthClient).mock.calls[0]![0];
    expect(arg.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(arg.response_types).toEqual(['code']);
    expect(arg.token_endpoint_auth_method).toBe('none');
  });

  it('rate-limits at 10 registrations per IP per hour (11th request → 429)', async () => {
    // Rate limit bucket is keyed on the last X-Forwarded-For hop. Use a unique
    // IP so the bucket is empty when this test runs (other tests above used
    // different IPs).
    const ip = '203.0.113.1';
    vi.mocked(db.insertOAuthClient).mockImplementation(async (input) => registerRow({ ...input }));

    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(
        postRegister({ redirect_uris: ['http://localhost:9876/callback'] }, ip),
      );
      expect(res.status, `request ${i + 1} of 10 should be 201`).toBe(201);
    }

    const limited = await app.fetch(
      postRegister({ redirect_uris: ['http://localhost:9876/callback'] }, ip),
    );
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retry_after_seconds).toBe('number');
    expect(limited.headers.get('Retry-After')).toBe(String(body.retry_after_seconds));

    // Different IP still works.
    const other = await app.fetch(
      postRegister({ redirect_uris: ['http://localhost:9876/callback'] }, '203.0.113.2'),
    );
    expect(other.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// POST /oauth/token + POST /oauth/revoke (Task 07)
// ---------------------------------------------------------------------------
// Integration tests through the Hono app. Validates body-parsing strictness
// (must be form-encoded), error-response shape (OAuth 2.1 `{ error,
// error_description }`), and the 20/IP/min rate limit. Per-grant happy paths
// are covered exhaustively in provider.test.ts — these focus on the route
// layer (body parsing, content-type enforcement, error mapping, rate limit).

import { createHash } from 'node:crypto';

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

/** Build a POST /oauth/token request with form-encoded body. */
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
  return new Request(`${BASE}/oauth/token`, {
    method: 'POST',
    headers,
    body: serialized,
  });
}

/** Same shape as postToken but for /oauth/revoke. */
function postRevoke(
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
  return new Request(`${BASE}/oauth/revoke`, {
    method: 'POST',
    headers,
    body: serialized,
  });
}

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('POST /oauth/token', () => {
  beforeEach(() => {
    vi.mocked(db.getOAuthClientById).mockReset();
    vi.mocked(db.consumeAuthCode).mockReset();
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
    vi.mocked(db.consumeAuthCode).mockResolvedValueOnce({
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
    // RFC 6749 §5.1 mandates no-store on token responses.
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
    vi.mocked(db.consumeAuthCode).mockResolvedValueOnce(null);
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
      // 401 invalid_client is the expected response — what matters is that we
      // didn't get 429 yet.
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

describe('POST /oauth/revoke', () => {
  beforeEach(() => {
    vi.mocked(db.getRefreshTokenByHash).mockReset();
    vi.mocked(db.revokeRefreshToken).mockReset();
  });

  it('returns 200 with no body for a successful revocation', async () => {
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-row',
      user_id: TOKEN_USER_ROW.id,
      client_id: TOKEN_CLIENT_ID,
      token_hash: 'irrelevant',
      scope: null,
      created_at: NOW,
      expires_at: new Date(Date.now() + 86400_000),
      revoked_at: null,
    });

    const res = await app.fetch(
      postRevoke({ token: 'rt_abc', client_id: TOKEN_CLIENT_ID }, { xForwardedFor: '10.2.0.1' }),
    );

    expect(res.status).toBe(200);
    expect(db.revokeRefreshToken).toHaveBeenCalledWith('rt-row');
  });

  it('returns 200 even when the token is unknown (RFC 7009 §2.2)', async () => {
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce(null);

    const res = await app.fetch(postRevoke({ token: 'rt_unknown' }, { xForwardedFor: '10.2.0.2' }));

    expect(res.status).toBe(200);
    expect(db.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it('returns 200 when the body is empty (no token field)', async () => {
    const res = await app.fetch(postRevoke({}, { xForwardedFor: '10.2.0.3' }));
    expect(res.status).toBe(200);
    expect(db.getRefreshTokenByHash).not.toHaveBeenCalled();
  });

  it('returns 200 even for a malformed JSON body (degrades to no-op)', async () => {
    const res = await app.fetch(
      postRevoke({ token: 'rt_anything' }, { contentType: 'json', xForwardedFor: '10.2.0.4' }),
    );
    expect(res.status).toBe(200);
    // JSON content-type isn't form-encoded; provider sees no body, no work
    // gets done — but the response status is still 200 per RFC 7009.
    expect(db.revokeRefreshToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /auth/me + POST /auth/logout (Task 09 — browser session)
// ---------------------------------------------------------------------------
// /auth/me returns the cookie-authenticated user's profile. /auth/logout
// deletes the DB row and clears the cookie. Both depend on the resolveAuth
// middleware populating c.var.user from the pagent_session cookie — we drive
// that here by stubbing getSessionWithUserByTokenHash to return a session row.

import { SESSION_COOKIE_NAME } from './middleware.ts';

const SESSION_USER_ROW = {
  id: '33333333-4444-5555-6666-777777777777',
  handle: 'alex',
  email: 'alex@blockful.io',
  name: 'Alex Netto',
  avatar_url: 'https://example.com/avatar.png',
  created_at: NOW,
  updated_at: NOW,
};

const SESSION_LOOKUP_ROW = {
  session_id: 'session-uuid-aabb',
  user_id: SESSION_USER_ROW.id,
  email: SESSION_USER_ROW.email,
  handle: SESSION_USER_ROW.handle,
  expires_at: new Date(Date.now() + 86400_000),
};

describe('GET /auth/me', () => {
  beforeEach(() => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockReset();
    vi.mocked(db.extendSessionExpiry).mockReset();
    vi.mocked(db.getUserById).mockReset();
  });

  it('returns the user profile when a valid session cookie is present', async () => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockResolvedValueOnce(SESSION_LOOKUP_ROW);
    vi.mocked(db.extendSessionExpiry).mockResolvedValueOnce(undefined);
    vi.mocked(db.getUserById).mockResolvedValueOnce(SESSION_USER_ROW);

    const res = await app.fetch(
      new Request(`${BASE}/auth/me`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=valid-session-token` },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: SESSION_USER_ROW.id,
      handle: SESSION_USER_ROW.handle,
      email: SESSION_USER_ROW.email,
      name: SESSION_USER_ROW.name,
      avatar_url: SESSION_USER_ROW.avatar_url,
    });
  });

  it('returns 401 when no session cookie is provided', async () => {
    const res = await app.fetch(new Request(`${BASE}/auth/me`));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unauthorized');
    // No DB user lookup attempted when the request is anonymous.
    expect(db.getUserById).not.toHaveBeenCalled();
  });

  it('returns 401 when the session cookie is unknown', async () => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockResolvedValueOnce(null);
    const res = await app.fetch(
      new Request(`${BASE}/auth/me`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=stale-or-expired` },
      }),
    );
    expect(res.status).toBe(401);
    expect(db.getUserById).not.toHaveBeenCalled();
  });

  it('returns 401 when the user row vanished after the cookie was issued', async () => {
    // Cascade-delete edge case: session row exists (lookup returns it) but the
    // user was deleted between issuing and now. We treat that as unauthorized.
    vi.mocked(db.getSessionWithUserByTokenHash).mockResolvedValueOnce(SESSION_LOOKUP_ROW);
    vi.mocked(db.extendSessionExpiry).mockResolvedValueOnce(undefined);
    vi.mocked(db.getUserById).mockResolvedValueOnce(null);

    const res = await app.fetch(
      new Request(`${BASE}/auth/me`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=valid-but-orphaned` },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  beforeEach(() => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockReset();
    vi.mocked(db.deleteSessionByTokenHash).mockReset();
    vi.mocked(db.extendSessionExpiry).mockReset();
  });

  it('deletes the DB session and clears the cookie when a session is present', async () => {
    vi.mocked(db.getSessionWithUserByTokenHash).mockResolvedValueOnce(SESSION_LOOKUP_ROW);
    vi.mocked(db.extendSessionExpiry).mockResolvedValueOnce(undefined);
    vi.mocked(db.deleteSessionByTokenHash).mockResolvedValueOnce(undefined);

    const res = await app.fetch(
      new Request(`${BASE}/auth/logout`, {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=raw-cookie-token-abc` },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(db.deleteSessionByTokenHash).toHaveBeenCalledTimes(1);

    // Set-Cookie clears the value with Max-Age=0.
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie?.toLowerCase()).toContain('max-age=0');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie?.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
  });

  it('clears the cookie even when no session cookie was sent (idempotent)', async () => {
    const res = await app.fetch(new Request(`${BASE}/auth/logout`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(db.deleteSessionByTokenHash).not.toHaveBeenCalled();
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie?.toLowerCase()).toContain('max-age=0');
  });
});

// ---------------------------------------------------------------------------
// Browser session login flow (browser_session=1)
// ---------------------------------------------------------------------------
// Verifies that:
//   1. GET /oauth/authorize?browser_session=1 renders the login page without
//      requiring client_id / redirect_uri / code_challenge.
//   2. Google callback with browser_session state sets a session cookie and
//      redirects to /.
//   3. Magic link verify with browser_session ctx sets a session cookie and
//      redirects to /.

import { signStateJwt } from './state-jwt.ts';
import { env } from '../schemas.ts';

describe('Browser session login flow', () => {
  beforeAll(() => {
    // The state JWT signer needs AUTH_STATE_SECRET set. Other auth tests do
    // this in their own beforeAll; here we set it defensively (idempotent —
    // the routes test file may run in isolation).
    (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET =
      'test-auth-state-secret-very-long-random-value-32-bytes';
    (env as { GOOGLE_CLIENT_ID: string | undefined }).GOOGLE_CLIENT_ID = 'test-google-client-id';
    (env as { GOOGLE_CLIENT_SECRET: string | undefined }).GOOGLE_CLIENT_SECRET =
      'test-google-client-secret';
    (env as { GOOGLE_REDIRECT_URI: string | undefined }).GOOGLE_REDIRECT_URI =
      'http://localhost/oauth/callback/google';
  });

  beforeEach(() => {
    vi.mocked(db.insertSession).mockReset();
    vi.mocked(db.upsertUser).mockReset();
    vi.mocked(db.getUserByHandle).mockReset();
    vi.mocked(db.verifyAndConsumeMagicLink).mockReset();
  });

  it('GET /oauth/authorize?browser_session=1 renders login page without other params', async () => {
    // Use a unique IP so the per-IP rate limit doesn't interfere with tests
    // run in the same file (the authorize bucket caps at 30/min/IP).
    const res = await app.fetch(
      new Request(`${BASE}/oauth/authorize?browser_session=1`, {
        headers: { 'x-forwarded-for': '198.51.100.99' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Continue with Google');
    expect(html).toContain('<form method="POST" action="/oauth/magic/send"');
  });

  it('Magic link verify with browser_session=true sets cookie and redirects to /', async () => {
    // Mock the magic link DB row's authorize_context to flag browser_session.
    vi.mocked(db.verifyAndConsumeMagicLink).mockResolvedValueOnce({
      email: 'alex@blockful.io',
      authorizeContext: { browserSession: true },
    });
    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValueOnce(SESSION_USER_ROW);
    vi.mocked(db.insertSession).mockResolvedValueOnce(undefined);

    const res = await app.fetch(
      new Request(`${BASE}/oauth/magic?token=browser-flow-token`, {
        headers: {
          'user-agent': 'MockBrowser/1.0',
          'x-forwarded-for': '10.5.0.1',
        },
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie?.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie?.toLowerCase()).toContain('max-age=2592000');

    // Session insert captured the IP and user-agent from the request.
    expect(db.insertSession).toHaveBeenCalledTimes(1);
    const insertArg = vi.mocked(db.insertSession).mock.calls[0]![0];
    expect(insertArg.userId).toBe(SESSION_USER_ROW.id);
    expect(insertArg.ipAddress).toBe('10.5.0.1');
    expect(insertArg.userAgent).toBe('MockBrowser/1.0');

    // No auth code minted — this is the cookie path, not the MCP-client path.
    expect(db.insertAuthCode).not.toHaveBeenCalled();
  });

  it('Google callback with browser_session=true sets cookie and redirects to /', async () => {
    // Build a state JWT that carries browser_session=true.
    const browserState = await signStateJwt({ browserSession: true });

    // Sign an ID token with a fresh RSA key, and serve the matching JWKS
    // from the same fetch spy. provider's exchangeGoogleCode now does real
    // signature verification (createRemoteJWKSet + jwtVerify), so an
    // unsigned `header.payload.fake-sig` triple no longer passes.
    const rsaPair = generateKeyPairSync('rsa', { modulusLength: 2048 }) as {
      publicKey: KeyObject;
      privateKey: KeyObject;
    };
    const publicJwk = await exportJWK(rsaPair.publicKey);
    const jwksDoc = {
      keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid: 'browser-test-kid' }],
    };
    const signedIdToken = await new SignJWT({
      sub: 'google-sub-browser',
      email: 'alex@blockful.io',
      name: 'Alex Netto',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'browser-test-kid', typ: 'JWT' })
      .setIssuer('https://accounts.google.com')
      .setAudience('test-google-client-id')
      .setIssuedAt()
      .setExpirationTime('600s')
      .sign(rsaPair.privateKey);

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ id_token: signedIdToken, access_token: 'g-at' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('googleapis.com/oauth2/v3/certs')) {
        return new Response(JSON.stringify(jwksDoc), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.mocked(db.getUserByHandle).mockResolvedValue(null);
    vi.mocked(db.upsertUser).mockResolvedValueOnce(SESSION_USER_ROW);
    vi.mocked(db.insertSession).mockResolvedValueOnce(undefined);

    try {
      const res = await app.fetch(
        new Request(
          `${BASE}/oauth/callback/google?code=google-code&state=${encodeURIComponent(browserState)}`,
          {
            headers: {
              'user-agent': 'MockBrowser/2.0',
              'x-forwarded-for': '203.0.113.77',
            },
          },
        ),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');

      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie?.toLowerCase()).toContain('samesite=lax');

      // Session insert captured the IP and user-agent.
      expect(db.insertSession).toHaveBeenCalledTimes(1);
      const insertArg = vi.mocked(db.insertSession).mock.calls[0]![0];
      expect(insertArg.userId).toBe(SESSION_USER_ROW.id);
      expect(insertArg.ipAddress).toBe('203.0.113.77');
      expect(insertArg.userAgent).toBe('MockBrowser/2.0');

      // No auth code minted — this is the cookie path.
      expect(db.insertAuthCode).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
