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
