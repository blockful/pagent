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
import { BASE, json, req } from './app-test-fixtures.ts';

beforeEach(() => {
  vi.clearAllMocks();
  (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'not_found' });
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

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

describe('request-id middleware', () => {
  it('sets X-Request-ID on response when client does not send one', async () => {
    const res = await app.fetch(new Request('http://test/health'));
    expect(res.status).toBe(200);
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('echoes a valid client-supplied X-Request-ID', async () => {
    const res = await app.fetch(
      new Request('http://test/health', { headers: { 'X-Request-ID': 'abc123-test' } }),
    );
    expect(res.headers.get('x-request-id')).toBe('abc123-test');
  });

  it('regenerates ID when client supplies a malformed X-Request-ID (spaces/semicolons)', async () => {
    const bad = 'has spaces and ;';
    const res = await app.fetch(
      new Request('http://test/health', { headers: { 'X-Request-ID': bad } }),
    );
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe(bad);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('regenerates ID when client-supplied X-Request-ID exceeds 128 chars', async () => {
    const oversized = 'a'.repeat(129);
    const res = await app.fetch(
      new Request('http://test/health', { headers: { 'X-Request-ID': oversized } }),
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
