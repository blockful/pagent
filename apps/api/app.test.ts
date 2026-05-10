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
  loadActivePages: vi.fn(() => Promise.resolve()),
  insertPage: vi.fn(() => Promise.resolve()),
  markSubmitted: vi.fn(() => Promise.resolve()),
  markReceived: vi.fn(() => Promise.resolve()),
  deletePage: vi.fn(() => Promise.resolve()),
}));

import * as db from './db.ts';
import { app, pages, MAX_BODY_BYTES } from './app.ts';

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

/** Create a page via POST /new and return its id. */
async function createPage(spec: unknown = { anything: 1 }): Promise<string> {
  const res = await app.fetch(req('POST', '/new', { spec }));
  const body = await json(res);
  return body.id as string;
}

// Reset in-memory state and mock call records before each test.
beforeEach(() => {
  pages.clear();
  vi.clearAllMocks();
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

  it('rejects bodies over 256 KB with 413', async () => {
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
    expect(resBody.max_bytes).toBe(MAX_BODY_BYTES);
    expect(db.insertPage).not.toHaveBeenCalled();
  });

  it('accepts a body just under 256 KB', async () => {
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
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------

describe('GET /:id', () => {
  it('returns 404 for unknown valid-format id', async () => {
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}`));
    expect(res.status).toBe(404);
  });

  it('returns 404 for a malformed id', async () => {
    const res = await app.fetch(req('GET', `/${BAD_ID}`));
    expect(res.status).toBe(404);
  });

  it('returns 200 with spec and state open after POST /new', async () => {
    const id = await createPage({ foo: 'bar' });
    const res = await app.fetch(req('GET', `/${id}`));
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
    const res = await app.fetch(req('POST', `/${UNKNOWN_ID}/result`, validAction));
    expect(res.status).toBe(404);
  });

  it('returns 200 and transitions page to submitted', async () => {
    const id = await createPage();
    vi.clearAllMocks();
    const res = await app.fetch(req('POST', `/${id}/result`, validAction));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(db.markSubmitted).toHaveBeenCalledOnce();
    expect(pages.get(id)?.state).toBe('submitted');
  });

  it('returns 409 on second submit to same page', async () => {
    const id = await createPage();
    await app.fetch(req('POST', `/${id}/result`, validAction));
    const res = await app.fetch(req('POST', `/${id}/result`, validAction));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toBe('conflict');
  });

  it('returns 400 for result body with name: "" (empty name)', async () => {
    const id = await createPage();
    const res = await app.fetch(req('POST', `/${id}/result`, { name: '', surfaceId: 'x' }));
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
    const id = await createPage();
    const res = await app.fetch(req('GET', `/${id}/result`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.state).toBe('open');
    expect(body.result).toBeNull();
  });

  it('returns submitted result immediately after POST /:id/result', async () => {
    const id = await createPage();
    await app.fetch(req('POST', `/${id}/result`, validAction));
    const res = await app.fetch(req('GET', `/${id}/result`));
    expect(res.status).toBe(200);
    const body = await json(res);
    // stateAtRead captured 'submitted' before flipping to 'received'
    expect(body.state).toBe('submitted');
    expect((body.result as Record<string, unknown>).name).toBe('clicked');
  });

  it('returns received state on subsequent reads after first GET /result', async () => {
    const id = await createPage();
    await app.fetch(req('POST', `/${id}/result`, validAction));
    // First read — flips submitted → received in memory; returns 'submitted'
    await app.fetch(req('GET', `/${id}/result`));
    // Second read — page is now 'received'
    const res = await app.fetch(req('GET', `/${id}/result`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.state).toBe('received');
    expect(db.markReceived).toHaveBeenCalledOnce();
  });

  it('returns 404 for unknown id on GET /:id/result', async () => {
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}/result`));
    expect(res.status).toBe(404);
  });
});
