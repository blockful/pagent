import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, NOW, app, db } from './routes-test-support.ts';
import { firstCallArgument } from './test-call-support.ts';

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
    const arg = firstCallArgument(vi.mocked(db.insertOAuthClient).mock.calls, 'insertOAuthClient');
    expect(arg.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(arg.response_types).toEqual(['code']);
    expect(arg.token_endpoint_auth_method).toBe('none');
  });

  it('rate-limits at 10 registrations per IP per hour (11th request → 429)', async () => {
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
    const other = await app.fetch(
      postRegister({ redirect_uris: ['http://localhost:9876/callback'] }, '203.0.113.2'),
    );
    expect(other.status).toBe(201);
  });
});
