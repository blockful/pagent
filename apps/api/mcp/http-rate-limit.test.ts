import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.ts', () => ({
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

import { makeMcpHttpHandler } from './http.ts';
import { RateLimiter } from './rate-limit.ts';
import {
  INITIALIZE_BODY,
  MCP_ACCEPT,
  parseJson,
  rateLimitResponseSchema,
  startServer,
} from './http-test-support.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

async function startTightServer(limit: number) {
  return startServer(
    makeMcpHttpHandler({
      publicUrl: 'http://test.local',
      apiPublicUrl: 'https://api.test.local',
      pageTtlMs: 60_000,
      rateLimiter: new RateLimiter(limit, 60_000),
    }),
  );
}

function postFromIp(url: URL, ip: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Accept: MCP_ACCEPT,
      'Content-Type': 'application/json',
      'X-Real-IP': ip,
    },
    body: INITIALIZE_BODY,
  });
}

describe('rate limiting', () => {
  it('returns 429 with retry_after_seconds once the per-IP cap is exhausted', async () => {
    const started = await startTightServer(2);
    try {
      const r1 = await postFromIp(started.url, '1.2.3.4');
      const r2 = await postFromIp(started.url, '1.2.3.4');
      expect(r1.status).toBeLessThan(400);
      expect(r2.status).toBeLessThan(400);
      await r1.body?.cancel();
      await r2.body?.cancel();

      const r3 = await postFromIp(started.url, '1.2.3.4');
      expect(r3.status).toBe(429);
      const body = await parseJson(r3, rateLimitResponseSchema);
      expect(body.error).toBe('rate_limited');
      expect(typeof body.retry_after_seconds).toBe('number');
      expect(body.retry_after_seconds).toBeGreaterThan(0);
      expect(typeof body.request_id).toBe('string');
      expect(r3.headers.get('Retry-After')).toBe(String(body.retry_after_seconds));
      expect(r3.headers.get('RateLimit')).toMatch(/limit=2, remaining=0, reset=\d+/);
    } finally {
      await started.close();
    }
  });

  it('keys per IP — exhausting one bucket does not affect another', async () => {
    const started = await startTightServer(1);
    try {
      const r1 = await postFromIp(started.url, '1.1.1.1');
      expect(r1.status).toBeLessThan(400);
      await r1.body?.cancel();

      const r2 = await postFromIp(started.url, '1.1.1.1');
      expect(r2.status).toBe(429);

      const r3 = await postFromIp(started.url, '2.2.2.2');
      expect(r3.status).toBeLessThan(400);
      await r3.body?.cancel();
    } finally {
      await started.close();
    }
  });
});
