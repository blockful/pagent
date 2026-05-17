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
}));

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
