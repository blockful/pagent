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
import { metrics } from './metrics.ts';
import { BAD_ID, fakePage, json, req, UNKNOWN_ID } from './app-test-fixtures.ts';

beforeEach(() => {
  vi.clearAllMocks();
  (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (db.submitPage as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'not_found' });
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

const validAction = { name: 'clicked', surfaceId: 'main' };

describe('GET /:id render metric', () => {
  it('counts a render once for an open a2ui page, tagged with format', async () => {
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(
      fakePage({ format: 'a2ui', state: 'open' }),
    );
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}`));
    expect(res.status).toBe(200);
    expect(metrics.pagesViewed.add).toHaveBeenCalledTimes(1);
    expect(metrics.pagesViewed.add).toHaveBeenCalledWith(1, { format: 'a2ui' });
  });

  it('counts html page views (view-only pages stay open)', async () => {
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(
      fakePage({ format: 'html', spec: '<p>hi</p>', state: 'open' }),
    );
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}`));
    expect(res.status).toBe(200);
    expect(metrics.pagesViewed.add).toHaveBeenCalledWith(1, { format: 'html' });
  });

  it('does not count post-submit polling reads as renders', async () => {
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(
      fakePage({ state: 'submitted', result: { name: 'submitted' } }),
    );
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}`));
    expect(res.status).toBe(200);
    expect(metrics.pagesViewed.add).not.toHaveBeenCalled();
  });

  it('does not count a missing/expired page as a render', async () => {
    (db.getActivePage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await app.fetch(req('GET', `/${UNKNOWN_ID}`));
    expect(res.status).toBe(404);
    expect(metrics.pagesViewed.add).not.toHaveBeenCalled();
  });
});

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
