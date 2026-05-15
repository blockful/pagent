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
  submitPage: vi.fn(() => Promise.resolve({ kind: 'not_found' })),
  fetchAndAdvanceResult: vi.fn(() => Promise.resolve(null)),
  deletePage: vi.fn(() => Promise.resolve()),
  deleteExpiredPages: vi.fn(() => Promise.resolve({ total: 0, abandoned: 0 })),
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
    format: 'a2ui' | 'html';
    state: 'open' | 'submitted' | 'received';
    result: unknown;
  }> = {},
) {
  return {
    id: overrides.id ?? 'aabbccddeeff00112233445566778899',
    spec: overrides.spec ?? { anything: 1 },
    format: overrides.format ?? ('a2ui' as const),
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
  (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'not_found' });
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// POST /new
// ---------------------------------------------------------------------------

describe('POST /new', () => {
  it('returns 400 on non-JSON body', async () => {
    const res = await app.fetch(new Request(`${BASE}/new`, { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('bad_request');
  });

  it('returns 400 on {} (no spec key)', async () => {
    const res = await app.fetch(req('POST', '/new', {}));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('bad_request');
  });

  it('returns 201 with id, url, expires_at on valid body', async () => {
    const res = await app.fetch(req('POST', '/new', { spec: { anything: 1 } }));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.id).toMatch(/^[a-f0-9]{32}$/);
    expect(typeof body.url).toBe('string');
    expect(typeof body.expires_at).toBe('number');
  });

  it('calls db.insertPage once with state open', async () => {
    await app.fetch(req('POST', '/new', { spec: { anything: 1 } }));
    expect(db.insertPage).toHaveBeenCalledOnce();
    const [calledPage] = vi.mocked(db.insertPage).mock.calls[0];
    expect(calledPage.state).toBe('open');
  });

  it('rejects A2UI bodies over 256 KB with 413 (post-parse cap)', async () => {
    const body = JSON.stringify({ spec: 'x'.repeat(300_000) });
    const res = await app.fetch(
      new Request(`${BASE}/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(413);
    const resBody = await json(res);
    expect(resBody.error).toBe('payload_too_large');
    expect(resBody.max_bytes).toBe(256_000);
    expect(resBody.format).toBe('a2ui');
    expect(typeof resBody.message).toBe('string');
    expect(db.insertPage).not.toHaveBeenCalled();
  });

  it('accepts an A2UI body just under 256 KB', async () => {
    const body = JSON.stringify({ spec: 'x'.repeat(250_000) });
    const res = await app.fetch(
      new Request(`${BASE}/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(201);
  });

  it('413 body.message references the A2UI byte limit', async () => {
    const body = JSON.stringify({ spec: 'x'.repeat(300_000) });
    const res = await app.fetch(
      new Request(`${BASE}/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(413);
    const resBody = await json(res);
    expect(typeof resBody.message).toBe('string');
    expect(resBody.message as string).toContain('256');
  });

  it('bodyLimit middleware rejects any body > 1 MB with 413', async () => {
    // 1 MB is the absolute bodyLimit cap (per spec, HTML's true ceiling).
    // Stuff in a JSON string that pushes the wire body past 1 MB.
    const body = JSON.stringify({ spec: 'x'.repeat(1_050_000) });
    const res = await app.fetch(
      new Request(`${BASE}/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(413);
    const resBody = await json(res);
    expect(resBody.error).toBe('payload_too_large');
    expect(resBody.max_bytes).toBe(MAX_BODY_BYTES);
    expect(MAX_BODY_BYTES).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// POST /new with format=html
// ---------------------------------------------------------------------------

describe('POST /new with format=html', () => {
  it('accepts an HTML payload and returns 201 with { id, url, expires_at }', async () => {
    const res = await app.fetch(
      req('POST', '/new', {
        format: 'html',
        spec: '<div><h1>Hello</h1><p>World</p></div>',
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect((body.id as string) ?? '').toMatch(/^[a-f0-9]{32}$/);
    expect(typeof body.url).toBe('string');
    expect(typeof body.expires_at).toBe('number');
  });

  it('passes format=html and a sanitized spec to db.insertPage', async () => {
    await app.fetch(
      req('POST', '/new', {
        format: 'html',
        spec: '<div>safe</div><script>alert(1)</script>',
      }),
    );
    expect(db.insertPage).toHaveBeenCalledOnce();
    const [page] = vi.mocked(db.insertPage).mock.calls[0];
    expect(page.format).toBe('html');
    expect(typeof page.spec).toBe('string');
    expect(page.spec as string).not.toContain('<script');
    expect(page.spec as string).toContain('<div>safe</div>');
  });

  it('rejects HTML payloads > 1 MB with 413 payload_too_large', async () => {
    const big = 'a'.repeat(1_000_001);
    const res = await app.fetch(req('POST', '/new', { format: 'html', spec: big }));
    // The wire body (with JSON wrapping) exceeds the 1 MB bodyLimit, so the
    // bodyLimit middleware fires before Zod parsing and returns 413.
    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.error).toBe('payload_too_large');
  });

  it('accepts A2UI payloads with implicit default format (backwards compat)', async () => {
    const res = await app.fetch(
      req('POST', '/new', { spec: [{ createSurface: { surfaceId: 'm' } }] }),
    );
    expect(res.status).toBe(201);
  });

  it('rejects A2UI payloads > 256 KB even when body limit allows up to 1 MB', async () => {
    // Use a value below the 1 MB bodyLimit but above the 256 KB A2UI cap.
    const big = 'x'.repeat(300_000);
    const res = await app.fetch(req('POST', '/new', { spec: big }));
    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.error).toBe('payload_too_large');
    expect(body.format).toBe('a2ui');
  });

  it('returns 400 sanitized_empty when sanitization yields empty output', async () => {
    // Pure forbidden tags — DOMPurify strips everything, leaving an empty
    // string. The handler must reject with a clear error rather than store
    // an empty HTML page.
    const res = await app.fetch(
      req('POST', '/new', { format: 'html', spec: '<script>alert(1)</script>' }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('sanitized_empty');
    expect(body.format).toBe('html');
    expect(typeof body.message).toBe('string');
    expect(db.insertPage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------

describe('GET /:id', () => {
  it('returns 404 for unknown valid-format id', async () => {
    // getActivePage already returns null by default
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}`));
    expect(res.status).toBe(404);
  });

  it('returns 404 for a malformed id', async () => {
    const res = await app.fetch(req('GET', `/${BAD_ID}`));
    expect(res.status).toBe(404);
  });

  it('returns 200 with spec and state open for an active page', async () => {
    const page = fakePage({ spec: { foo: 'bar' }, state: 'open' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    const res = await app.fetch(req('GET', `/${page.id}`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.spec).toEqual({ foo: 'bar' });
    expect(body.state).toBe('open');
    expect(body.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /:id/result
// ---------------------------------------------------------------------------

const validAction = { name: 'clicked', surfaceId: 'main' };

describe('POST /:id/result', () => {
  it('returns 404 for unknown id', async () => {
    // submitPage returns 'not_found' by default
    const res = await app.fetch(req('POST', `/${UNKNOWN_ID}/result`, validAction));
    expect(res.status).toBe(404);
  });

  it('returns 404 (not 409) when submitPage reports not_found for an expired page', async () => {
    // Regression: before the fix, the disambiguation SELECT in submitPage
    // matched expired rows, so submitPage returned 'conflict' and the handler
    // returned 409 "already submitted" for a page that was merely expired.
    // The fixed SELECT adds `expires_at > now()`, making expired rows return
    // 'not_found' → 404, which is the correct user-facing response.
    // The handler reads the page first via getActivePage for the format guard;
    // mock it to return an active a2ui page so submitPage's 'not_found' outcome
    // is what we exercise here (e.g. row expired between the two reads).
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePage());
    (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'not_found' });
    const res = await app.fetch(req('POST', `/${UNKNOWN_ID}/result`, validAction));
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error).not.toBe('conflict');
  });

  it('returns 200 and calls db.submitPage when page is open', async () => {
    const page = fakePage();
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: 'ok',
      createdAt: new Date(),
    });
    const res = await app.fetch(req('POST', `/${page.id}/result`, validAction));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(db.submitPage).toHaveBeenCalledOnce();
  });

  it('returns 409 on conflict (already submitted)', async () => {
    const page = fakePage({ state: 'submitted' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'conflict' });
    const res = await app.fetch(req('POST', `/${page.id}/result`, validAction));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toBe('conflict');
    expect(typeof body.message).toBe('string');
    expect(body.message as string).toContain('already submitted');
  });

  it('409 conflict body.message mentions creating a new page', async () => {
    const page = fakePage({ state: 'submitted' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'conflict' });
    const res = await app.fetch(req('POST', `/${page.id}/result`, validAction));
    const body = await json(res);
    expect(body.message as string).toContain('new page');
  });

  it('returns 400 for result body with name: "" (empty name)', async () => {
    // Page must exist (a2ui) so we reach the body-parse stage.
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePage());
    const res = await app.fetch(req('POST', `/${UNKNOWN_ID}/result`, { name: '', surfaceId: 'x' }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('bad_request');
  });
});

// ---------------------------------------------------------------------------
// GET /:id/result
// ---------------------------------------------------------------------------

describe('GET /:id/result', () => {
  it('returns 200 with state open and null result before submit', async () => {
    (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stateAtRead: 'open',
      result: null,
      format: 'a2ui',
    });
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}/result`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.state).toBe('open');
    expect(body.result).toBeNull();
    expect(body.format).toBe('a2ui');
  });

  it('returns submitted result after POST /:id/result', async () => {
    (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stateAtRead: 'submitted',
      result: validAction,
      format: 'a2ui',
    });
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}/result`));
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
      format: 'a2ui',
    });
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}/result`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.state).toBe('received');
  });

  it('returns 404 for unknown id on GET /:id/result', async () => {
    // fetchAndAdvanceResult returns null by default
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}/result`));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// format echo + HTML result handling
// ---------------------------------------------------------------------------

describe('format echo and HTML result handling', () => {
  it('GET /:id echoes format=html for an HTML page', async () => {
    const page = fakePage({ format: 'html', spec: '<p>x</p>' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    const res = await app.fetch(req('GET', `/${page.id}`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.format).toBe('html');
  });

  it('GET /:id echoes format=a2ui for an A2UI page', async () => {
    const page = fakePage({ format: 'a2ui' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    const res = await app.fetch(req('GET', `/${page.id}`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.format).toBe('a2ui');
  });

  it('GET /:id/result includes format on every response', async () => {
    (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stateAtRead: 'open',
      result: null,
      format: 'html',
    });
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}/result`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.format).toBe('html');
    expect(body.state).toBe('open');
    expect(body.result).toBeNull();
  });

  it('POST /:id/result rejects HTML pages with 400 invalid_for_format', async () => {
    const page = fakePage({ format: 'html', spec: '<p>x</p>' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    const res = await app.fetch(
      req('POST', `/${page.id}/result`, { name: 'submitted', surfaceId: 'main' }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('invalid_for_format');
    expect(body.format).toBe('html');
    expect(db.submitPage).not.toHaveBeenCalled();
  });

  it('POST /:id/result still works for A2UI pages (regression)', async () => {
    const page = fakePage({ format: 'a2ui' });
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page);
    (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: 'ok',
      createdAt: new Date(),
    });
    const res = await app.fetch(
      req('POST', `/${page.id}/result`, { name: 'submitted', surfaceId: 'main' }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
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
    const res = await app.fetch(new Request('http://test/new', { method: 'POST' }));
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
    const resNew = await app.fetch(req('POST', '/new', { spec: {} }));
    const resNotFound = await app.fetch(new Request('http://test/no-such-path'));
    expect(resHealth.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
    expect(resNew.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
    expect(resNotFound.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
  });

  it('sets X-Request-ID even when bodyLimit fires (413)', async () => {
    const body = JSON.stringify({ spec: 'x'.repeat(300_000) });
    const res = await app.fetch(
      new Request(`${BASE}/new`, {
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
// Global error handler
// ---------------------------------------------------------------------------

describe('error handler', () => {
  it('returns JSON 500 when getActivePage throws', async () => {
    (db.getActivePage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connection terminated'),
    );
    const res = await app.fetch(new Request(`http://test/${UNKNOWN_ID}`));
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error).toBe('internal_error');
    expect(typeof body.request_id).toBe('string');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('500 body includes the request_id from X-Request-ID header', async () => {
    (db.getActivePage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const res = await app.fetch(
      new Request(`http://test/${UNKNOWN_ID}`, {
        headers: { 'X-Request-ID': 'smoketest-abc' },
      }),
    );
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.request_id).toBe('smoketest-abc');
    expect(res.headers.get('x-request-id')).toBe('smoketest-abc');
  });

  it('500 body never leaks the error message', async () => {
    (db.getActivePage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('SECRET sql: SELECT * FROM users WHERE password = ...'),
    );
    const res = await app.fetch(new Request(`http://test/${UNKNOWN_ID}`));
    expect(res.status).toBe(500);
    const body = await json(res);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('SECRET');
    expect(serialised).not.toContain('SELECT');
    expect(serialised).not.toContain('sql');
  });

  it('insertPage throw on POST /new returns 500', async () => {
    (db.insertPage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db write failed'));
    const res = await app.fetch(req('POST', '/new', { spec: { anything: 1 } }));
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error).toBe('internal_error');
    expect(typeof body.request_id).toBe('string');
  });

  it('submitPage throw on POST /:id/result returns 500', async () => {
    // Page-existence gate runs first; mock it to return an a2ui page so
    // the throw on submitPage is what we actually exercise.
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePage());
    (db.submitPage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db write failed'));
    const res = await app.fetch(req('POST', `/${UNKNOWN_ID}/result`, validAction));
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error).toBe('internal_error');
    expect(typeof body.request_id).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// OpenAPI surface
// ---------------------------------------------------------------------------

describe('OpenAPI surface', () => {
  it('GET /openapi.json returns parsed spec with application/json content-type', async () => {
    const res = await app.fetch(new Request('http://test/openapi.json'));
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
    const body = await res.json();
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
    const body = await res.json();
    expect(body.paths).toHaveProperty('/new');
    expect(body.paths).toHaveProperty('/{id}');
    expect(body.paths).toHaveProperty('/{id}/result');
    expect(body.paths).toHaveProperty('/health');
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

// ---------------------------------------------------------------------------
// Error message field
// ---------------------------------------------------------------------------

describe('error message field', () => {
  it('500 body includes non-empty message field', async () => {
    (db.getActivePage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const res = await app.fetch(new Request(`http://test/${UNKNOWN_ID}`));
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(typeof body.message).toBe('string');
    expect((body.message as string).length).toBeGreaterThan(0);
  });

  it('400 bad_request body includes non-empty message field', async () => {
    const res = await app.fetch(req('POST', '/new', {}));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(typeof body.message).toBe('string');
    expect((body.message as string).length).toBeGreaterThan(0);
  });

  it('404 body includes non-empty message field', async () => {
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}`));
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(typeof body.message).toBe('string');
    expect((body.message as string).length).toBeGreaterThan(0);
  });
});
