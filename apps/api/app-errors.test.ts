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
import { fakePage, json, req, UNKNOWN_ID } from './app-test-fixtures.ts';

beforeEach(() => {
  vi.clearAllMocks();
  (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'not_found' });
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

const validAction = { name: 'clicked', surfaceId: 'main' };

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
