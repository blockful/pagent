/**
 * Rate-limit tests for POST /new.
 *
 * These run in a separate file so we can set RATE_LIMIT_MAX=3 via a
 * beforeAll hook BEFORE dynamically importing app.ts. The module-level
 * rateLimiter() call in app.ts reads env.RATE_LIMIT_MAX at import time,
 * so we must mutate process.env before the import resolves.
 *
 * Keeping these isolated also prevents the low cap (3) from interfering
 * with the existing app.test.ts suite, which sends several POST /new calls.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock db.ts before anything imports it.
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

// Set a low rate limit cap BEFORE importing app (which constructs the limiter).
beforeAll(() => {
  process.env.RATE_LIMIT_MAX = '3';
});

// Dynamic import so the module is loaded AFTER the env is set.
let app: Awaited<typeof import('./app.ts')>['app'];

beforeAll(async () => {
  const mod = await import('./app.ts');
  app = mod.app;
});

const BASE = 'http://localhost';

function postNew(xForwardedFor?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (xForwardedFor !== undefined) headers['x-forwarded-for'] = xForwardedFor;
  return new Request(`${BASE}/new`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ spec: { test: true } }),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// Reset mock call counts before each test.
beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Per-IP rate limiting
// ---------------------------------------------------------------------------

describe('rate-limits at the configured cap and returns 429', () => {
  it('allows up to RATE_LIMIT_MAX requests, then 429 for the same IP, 201 for a new IP', async () => {
    const ip1 = '1.2.3.4';
    const ip2 = '5.6.7.8';

    // First 3 requests from ip1 should succeed (201).
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(postNew(ip1));
      expect(res.status, `request ${i + 1} from ip1 should be 201`).toBe(201);
    }

    // 4th request from ip1 should be rate-limited (429).
    const limited = await app.fetch(postNew(ip1));
    expect(limited.status).toBe(429);
    const body = await json(limited);
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after_seconds).toBe(60);
    expect(limited.headers.get('Retry-After')).toBe('60');

    // A different IP should still succeed (201).
    const other = await app.fetch(postNew(ip2));
    expect(other.status).toBe(201);

    // db.insertPage must have been called exactly 4 times:
    // 3 successful from ip1 + 1 successful from ip2. The blocked 4th from
    // ip1 must NOT have called insertPage.
    expect(db.insertPage).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// Anonymous fallback (no x-forwarded-for)
// ---------------------------------------------------------------------------

describe('falls back to "anonymous" bucket when x-forwarded-for is absent', () => {
  it('rate-limits requests with no XFF header as a single bucket', async () => {
    // First 3 with no XFF should succeed.
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(postNew(undefined));
      expect(res.status, `anon request ${i + 1} should be 201`).toBe(201);
    }

    // 4th with no XFF should be 429.
    const limited = await app.fetch(postNew(undefined));
    expect(limited.status).toBe(429);
    const body = await json(limited);
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after_seconds).toBe(60);
  });
});
