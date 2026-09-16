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
import { app, MAX_BODY_BYTES } from './app.ts';
import { BASE, json, req } from './app-test-fixtures.ts';

beforeEach(() => {
  vi.clearAllMocks();
  (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'not_found' });
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

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
