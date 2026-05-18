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
import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

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
    vi.mocked(db.insertOAuthClient).mockImplementation(async (input) =>
      registerRow({ ...input }),
    );

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
    const res = await app.fetch(
      postRegister({ redirect_uris: ['not a uri'] }, '10.0.0.4'),
    );

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
    vi.mocked(db.insertOAuthClient).mockImplementation(async (input) =>
      registerRow({ ...input }),
    );

    const res = await app.fetch(
      postRegister(
        { redirect_uris: ['http://localhost:9876/callback'] },
        '10.0.0.6',
      ),
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
    vi.mocked(db.insertOAuthClient).mockImplementation(async (input) =>
      registerRow({ ...input }),
    );

    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(
        postRegister(
          { redirect_uris: ['http://localhost:9876/callback'] },
          ip,
        ),
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
    expect(limited.headers.get('Retry-After')).toBe(
      String(body.retry_after_seconds),
    );

    // Different IP still works.
    const other = await app.fetch(
      postRegister(
        { redirect_uris: ['http://localhost:9876/callback'] },
        '203.0.113.2',
      ),
    );
    expect(other.status).toBe(201);
  });
});
