import { describe, expect, it } from 'vitest';
import { BASE, app, json } from './routes-test-support.ts';
import { KID, getIssuer } from './jwt.ts';

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

  it('scopes_supported = ["page:create", "page:read"]', async () => {
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const body = await json(res);
    expect(body.scopes_supported).toEqual(['page:create', 'page:read']);
  });
});

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
    expect(body.scopes_supported).toEqual(['page:create', 'page:read']);
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

describe('discovery endpoints are public', () => {
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
