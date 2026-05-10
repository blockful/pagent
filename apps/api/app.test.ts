/**
 * Handler tests — Hono app exercised in-process via app.fetch().
 * The DB module is fully mocked; no Postgres connection is needed.
 * DATABASE_URL and PORT are set via vitest.config.ts test.env.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock db.ts before any import that pulls it in.
vi.mock('./db.ts', () => ({
  init: vi.fn(() => Promise.resolve()),
  shutdown: vi.fn(() => Promise.resolve()),
  insertPage: vi.fn(() => Promise.resolve()),
  getActivePage: vi.fn(() => Promise.resolve(null)),
  submitPage: vi.fn(() => Promise.resolve('not_found')),
  fetchAndAdvanceResult: vi.fn(() => Promise.resolve(null)),
  deletePage: vi.fn(() => Promise.resolve()),
  deleteExpiredPages: vi.fn(() => Promise.resolve(0)),
  ping: vi.fn().mockResolvedValue(undefined),
}));

import * as db from './db.ts';
import { app, MAX_BODY_BYTES } from './app.ts';

// A valid 32-char hex id that has never been inserted.
const UNKNOWN_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';
// An invalid (non-hex) id.
const BAD_ID = 'not-hex';

const BASE = 'http://localhost';

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

/** Build a fake active page object (matches the Page type from db.ts). */
function fakePage(
  overrides: Partial<{
    id: string;
    spec: unknown;
    state: 'open' | 'submitted' | 'received';
    result: unknown;
  }> = {},
) {
  return {
    id: overrides.id ?? 'aabbccddeeff00112233445566778899',
    spec: overrides.spec ?? { anything: 1 },
    state: overrides.state ?? 'open',
    result: overrides.result ?? null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

// Reset mock call records before each test.
beforeEach(() => {
  vi.clearAllMocks();
  // Default: db reads return nothing (404 paths).
  (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValue('not_found');
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// POST /v1/new
// ---------------------------------------------------------------------------

describe('POST /v1/new', () => {
  it('returns 400 on non-JSON body', async () => {
    const res = await app.fetch(
      new Request(`${BASE}/v1/new`, { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('bad_request');
  });

  it('returns 400 on {} (no spec key)', async () => {
    const res = await app.fetch(req('POST', '/v1/new', {}));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('bad_request');
  });

  it('returns 201 with id, url, expires_at on valid body', async () => {
    const res = await app.fetch(req('POST', '/v1/new', { spec: { anything: 1 } }));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.id).toMatch(/^[a-f0-9]{32}$/);
    expect(typeof body.url).toBe('string');
    expect(typeof body.expires_at).toBe('number');
  });

  it('calls db.insertPage once with state open', async () => {
    await app.fetch(req('POST', '/v1/new', { spec: { anything: 1 } }));
    expect(db.insertPage).toHaveBeenCalledOnce();
    const [calledPage] = vi.mocked(db.insertPage).mock.calls[0];
    expect(calledPage.state).toBe('open');
  });

  it('rejects bodies over 256 KB with 413', async () => {
    const body = JSON.stringify({ spec: 'x'.repeat(300_000) });
    const res = await app.fetch(
      new Request(`${BASE}/v1/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(413);
    const resBody = await json(res);
    expect(resBody.error).toBe('payload_too_large');
    expect(resBody.max_bytes).toBe(MAX_BODY_BYTES);
    expect(db.insertPage).not.toHaveBeenCalled();
  });

  it('accepts a body just under 256 KB', async () => {
    const body = JSON.stringify({ spec: 'x'.repeat(250_000) });
    const res = await app.fetch(
      new Request(`${BASE}/v1/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/:id
// ---------------------------------------------------------------------------

describe('GET /v1/:id', () => {
  it('returns 404 for unknown valid-format id', async () => {
    // getActivePage already returns null by default
    const res = await app.fetch(req('GET', `/v1/${UNKNOWN_ID}`));
    expect(res.status).toBe(404);
  });

  it('returns 404 for a malformed id', async () => {
    const res = await app.fetch(req('GET', `/v1/${BAD_ID}`));
    expect(res.status).toBe(404);
  });

  it('returns 200 with spec and state open for an active page', async () => {
    const page = fakePage({ spec: { foo: 'bar' }, state: 'open' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    const res = await app.fetch(req('GET', `/v1/${page.id}`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.spec).toEqual({ foo: 'bar' });
    expect(body.state).toBe('open');
    expect(body.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/:id/result
// ---------------------------------------------------------------------------

const validAction = { name: 'clicked', surfaceId: 'main' };

describe('POST /v1/:id/result', () => {
  it('returns 404 for unknown id', async () => {
    // submitPage returns 'not_found' by default
    const res = await app.fetch(req('POST', `/v1/${UNKNOWN_ID}/result`, validAction));
    expect(res.status).toBe(404);
  });

  it('returns 200 and calls db.submitPage when page is open', async () => {
    const page = fakePage();
    (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('ok');
    const res = await app.fetch(req('POST', `/v1/${page.id}/result`, validAction));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(db.submitPage).toHaveBeenCalledOnce();
  });

  it('returns 409 on conflict (already submitted)', async () => {
    const page = fakePage({ state: 'submitted' });
    (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('conflict');
    const res = await app.fetch(req('POST', `/v1/${page.id}/result`, validAction));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toBe('conflict');
  });

  it('returns 400 for result body with name: "" (empty name)', async () => {
    // Validation happens before db call, so no need to stub submitPage
    const res = await app.fetch(
      req('POST', `/v1/${UNKNOWN_ID}/result`, { name: '', surfaceId: 'x' }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('bad_request');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/:id/result
// ---------------------------------------------------------------------------

describe('GET /v1/:id/result', () => {
  it('returns 200 with state open and null result before submit', async () => {
    (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stateAtRead: 'open',
      result: null,
    });
    const res = await app.fetch(req('GET', `/v1/${UNKNOWN_ID}/result`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.state).toBe('open');
    expect(body.result).toBeNull();
  });

  it('returns submitted result after POST /v1/:id/result', async () => {
    (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stateAtRead: 'submitted',
      result: validAction,
    });
    const res = await app.fetch(req('GET', `/v1/${UNKNOWN_ID}/result`));
    expect(res.status).toBe(200);
    const body = await json(res);
    // stateAtRead captures 'submitted' before flipping to 'received'
    expect(body.state).toBe('submitted');
    expect((body.result as Record<string, unknown>).name).toBe('clicked');
  });

  it('returns received state on subsequent reads (db already flipped)', async () => {
    // After the first GET, the DB has state='received'. Next GET sees 'received'.
    (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stateAtRead: 'received',
      result: validAction,
    });
    const res = await app.fetch(req('GET', `/v1/${UNKNOWN_ID}/result`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.state).toBe('received');
  });

  it('returns 404 for unknown id on GET /v1/:id/result', async () => {
    // fetchAndAdvanceResult returns null by default
    const res = await app.fetch(req('GET', `/v1/${UNKNOWN_ID}/result`));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 ok when db ping succeeds', async () => {
    const res = await app.fetch(new Request('http://test/health'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.db).toBe('ok');
  });

  it('returns 503 when db ping rejects', async () => {
    (db.ping as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const res = await app.fetch(new Request('http://test/health'));
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.db).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

describe('security headers', () => {
  it('sets X-Content-Type-Options nosniff on every response', async () => {
    const res = await app.fetch(new Request('http://test/health'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets X-Frame-Options DENY', async () => {
    const res = await app.fetch(new Request('http://test/health'));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('sets Strict-Transport-Security with includeSubDomains', async () => {
    const res = await app.fetch(new Request('http://test/health'));
    const hsts = res.headers.get('strict-transport-security');
    expect(hsts).not.toBeNull();
    expect(hsts).toContain('max-age=');
    expect(hsts).toContain('includeSubDomains');
  });

  it('sets Referrer-Policy', async () => {
    const res = await app.fetch(new Request('http://test/health'));
    const rp = res.headers.get('referrer-policy');
    expect(rp).not.toBeNull();
    expect(rp!.length).toBeGreaterThan(0);
  });

  it('does NOT set Content-Security-Policy on the JSON API', async () => {
    const res = await app.fetch(new Request('http://test/health'));
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('sets headers on error responses too', async () => {
    const res = await app.fetch(new Request('http://test/v1/new', { method: 'POST' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

// ---------------------------------------------------------------------------
// Request-ID middleware
// ---------------------------------------------------------------------------

describe('request-id middleware', () => {
  it('sets X-Request-ID on response when client does not send one', async () => {
    const res = await app.fetch(new Request('http://test/health'));
    expect(res.status).toBe(200);
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('echoes a valid client-supplied X-Request-ID', async () => {
    const res = await app.fetch(
      new Request('http://test/health', {
        headers: { 'X-Request-ID': 'abc123-test' },
      }),
    );
    expect(res.headers.get('x-request-id')).toBe('abc123-test');
  });

  it('regenerates ID when client supplies a malformed X-Request-ID (spaces/semicolons)', async () => {
    const bad = 'has spaces and ;';
    const res = await app.fetch(
      new Request('http://test/health', {
        headers: { 'X-Request-ID': bad },
      }),
    );
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe(bad);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('regenerates ID when client-supplied X-Request-ID exceeds 128 chars', async () => {
    const oversized = 'a'.repeat(129);
    const res = await app.fetch(
      new Request('http://test/health', {
        headers: { 'X-Request-ID': oversized },
      }),
    );
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe(oversized);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('sets X-Request-ID on every endpoint including 404 paths', async () => {
    const resHealth = await app.fetch(new Request('http://test/health'));
    const resNew = await app.fetch(req('POST', '/v1/new', { spec: {} }));
    const resNotFound = await app.fetch(new Request('http://test/no-such-path'));
    expect(resHealth.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
    expect(resNew.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
    expect(resNotFound.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
  });

  it('sets X-Request-ID even when bodyLimit fires (413)', async () => {
    const body = JSON.stringify({ spec: 'x'.repeat(300_000) });
    const res = await app.fetch(
      new Request(`${BASE}/v1/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// Deprecation shim
// ---------------------------------------------------------------------------

describe('deprecation shim', () => {
  it('unversioned POST /new still works and emits Deprecation header', async () => {
    const res = await app.fetch(req('POST', '/new', { spec: { anything: 1 } }));
    expect(res.status).toBe(201);
    expect(db.insertPage).toHaveBeenCalledOnce();
    expect(res.headers.get('Deprecation')).toBe('true');
    const link = res.headers.get('Link') ?? '';
    expect(link).toContain('rel="successor-version"');
  });

  it('unversioned GET /:id still works and emits Deprecation header', async () => {
    const page = fakePage({ spec: { foo: 'bar' }, state: 'open' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    const res = await app.fetch(req('GET', `/${page.id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    const link = res.headers.get('Link') ?? '';
    expect(link).toContain('rel="successor-version"');
  });

  it('/v1/... paths do NOT emit Deprecation header', async () => {
    const page = fakePage({ spec: { foo: 'bar' }, state: 'open' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    const res = await app.fetch(req('GET', `/v1/${page.id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBeNull();
  });
});
