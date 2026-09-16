import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.ts', () => ({
  init: vi.fn(() => Promise.resolve()),
  shutdown: vi.fn(() => Promise.resolve()),
  insertPage: vi.fn(() => Promise.resolve()),
  getActivePage: vi.fn(() => Promise.resolve(null)),
  submitPage: vi.fn(() => Promise.resolve({ kind: 'not_found' })),
  fetchAndAdvanceResult: vi.fn(() => Promise.resolve(null)),
  deletePage: vi.fn(() => Promise.resolve()),
  deleteExpiredPages: vi.fn(() => Promise.resolve({ total: 0, abandoned: 0 })),
  ping: vi.fn().mockResolvedValue(undefined),
  getSessionWithUserByTokenHash: vi.fn(() => Promise.resolve(null)),
  extendSessionExpiry: vi.fn(() => Promise.resolve()),
  deleteSessionByTokenHash: vi.fn(() => Promise.resolve()),
}));
vi.mock('./metrics.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./metrics.ts')>();
  return {
    ...actual,
    metrics: {
      httpRequests: { add: vi.fn() },
      httpRequestDuration: { record: vi.fn() },
      pagesCreated: { add: vi.fn() },
      pagesViewed: { add: vi.fn() },
      pagesSubmitted: { add: vi.fn() },
      pagesAbandoned: { add: vi.fn() },
      pageSubmitLatency: { record: vi.fn() },
    },
  };
});

import * as db from './db.ts';
import { app } from './app.ts';
import { BASE, openApiDocumentSchema, req } from './app-test-fixtures.ts';

beforeEach(() => {
  vi.clearAllMocks();
  (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'not_found' });
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe('OpenAPI surface', () => {
  it('GET /openapi.json returns parsed spec with application/json content-type', async () => {
    const res = await app.fetch(new Request('http://test/openapi.json'));
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
    const body = openApiDocumentSchema.parse(await res.json());
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('Pagent API');
  });

  it('GET /openapi.yaml returns the raw YAML', async () => {
    const res = await app.fetch(new Request('http://test/openapi.yaml'));
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/yaml');
    const body = await res.text();
    expect(body.trimStart()).toMatch(/^openapi:/);
    expect(body.trimStart()).not.toMatch(/^\{/);
  });

  it('GET /openapi.json includes all expected paths', async () => {
    const res = await app.fetch(new Request('http://test/openapi.json'));
    const body = openApiDocumentSchema.parse(await res.json());
    const expectedPaths = [
      '/health',
      '/new',
      '/{id}',
      '/{id}/result',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/.well-known/jwks.json',
      '/oauth/register',
      '/oauth/authorize',
      '/oauth/callback/google',
      '/oauth/magic/send',
      '/oauth/magic',
      '/oauth/token',
      '/oauth/revoke',
      '/auth/me',
      '/auth/logout',
    ];
    for (const path of expectedPaths) expect(body.paths).toHaveProperty(path);
  });

  it('GET /docs returns HTML with Scalar marker', async () => {
    const res = await app.fetch(new Request('http://test/docs'));
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct.toLowerCase()).toMatch(/text\/html/);
    const body = await res.text();
    const lower = body.toLowerCase();
    expect(lower.includes('pagent api reference') || lower.includes('scalar')).toBe(true);
  });

  it('GET /docs and /openapi.json both carry X-Request-ID', async () => {
    const resDocs = await app.fetch(new Request('http://test/docs'));
    const resJson = await app.fetch(new Request('http://test/openapi.json'));
    expect(resDocs.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
    expect(resJson.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('POST /new owner_id propagation', () => {
  // Matches what the auth session uses internally: SHA-256(raw token) hex.
  // We don't bother computing it here — the mock matches any token by always
  // returning the same row.
  const FAKE_USER_ID = '11111111-2222-3333-4444-555555555555';

  function authedRequest(method: string, path: string, body?: unknown): Request {
    return new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        // Raw cookie token — the auth session module hashes it before lookup;
        // the mocked getSessionWithUserByTokenHash returns a hit regardless.
        Cookie: 'pagent_session=raw-cookie-token-value',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it('passes ownerId = user.id to db.insertPage when authenticated via cookie', async () => {
    (db.getSessionWithUserByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      session_id: 'session-uuid',
      user_id: FAKE_USER_ID,
      email: 'alice@example.com',
      handle: 'alice',
      expires_at: new Date(Date.now() + 86_400_000),
    });
    const res = await app.fetch(authedRequest('POST', '/new', { spec: { anything: 1 } }));
    expect(res.status).toBe(201);
    expect(db.insertPage).toHaveBeenCalledOnce();
    const [calledPage] = vi.mocked(db.insertPage).mock.calls[0];
    expect(calledPage.ownerId).toBe(FAKE_USER_ID);
  });

  it('passes ownerId = null to db.insertPage on anonymous POST /new (grace period)', async () => {
    // Default mock returns null — no session → c.var.user is null → ownerId null.
    const res = await app.fetch(req('POST', '/new', { spec: { anything: 1 } }));
    expect(res.status).toBe(201);
    expect(db.insertPage).toHaveBeenCalledOnce();
    const [calledPage] = vi.mocked(db.insertPage).mock.calls[0];
    expect(calledPage.ownerId).toBeNull();
  });

  it('passes ownerId on format=html pages too', async () => {
    (db.getSessionWithUserByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      session_id: 'session-uuid',
      user_id: FAKE_USER_ID,
      email: 'alice@example.com',
      handle: 'alice',
      expires_at: new Date(Date.now() + 86_400_000),
    });
    const res = await app.fetch(
      authedRequest('POST', '/new', { format: 'html', spec: '<p>hi</p>' }),
    );
    expect(res.status).toBe(201);
    expect(db.insertPage).toHaveBeenCalledOnce();
    const [calledPage] = vi.mocked(db.insertPage).mock.calls[0];
    expect(calledPage.format).toBe('html');
    expect(calledPage.ownerId).toBe(FAKE_USER_ID);
  });

  it('anonymous format=html POST /new also lands with ownerId = null', async () => {
    const res = await app.fetch(req('POST', '/new', { format: 'html', spec: '<p>hi</p>' }));
    expect(res.status).toBe(201);
    expect(db.insertPage).toHaveBeenCalledOnce();
    const [calledPage] = vi.mocked(db.insertPage).mock.calls[0];
    expect(calledPage.format).toBe('html');
    expect(calledPage.ownerId).toBeNull();
  });
});
