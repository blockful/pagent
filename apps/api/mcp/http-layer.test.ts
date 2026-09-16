import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  errorResponseSchema,
  INITIALIZE_BODY,
  MCP_ACCEPT,
  parseJson,
  startServer,
} from './http-test-support.ts';

let mcpUrl: URL;
let closeServer: (() => Promise<void>) | undefined;
const rateLimiter = new RateLimiter(1000, 60_000);

beforeAll(async () => {
  const started = await startServer(
    makeMcpHttpHandler({
      publicUrl: 'http://test.local',
      pageTtlMs: 60_000,
      rateLimiter,
    }),
  );
  mcpUrl = started.url;
  closeServer = started.close;
});

afterAll(async () => {
  if (closeServer !== undefined) {
    await closeServer();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiter.reset();
});

function postMcp(
  headers: Record<string, string> = {},
  body: string = INITIALIZE_BODY,
): Promise<Response> {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: { Accept: MCP_ACCEPT, 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('HTTP layer', () => {
  it('echoes a caller-supplied X-Request-Id', async () => {
    const res = await postMcp({ 'X-Request-Id': 'my-trace-abc' });
    expect(res.headers.get('X-Request-Id')).toBe('my-trace-abc');
    await res.body?.cancel();
  });

  it('generates a fresh X-Request-Id when the caller did not supply one', async () => {
    const res = await postMcp();
    const id = res.headers.get('X-Request-Id');
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    await res.body?.cancel();
  });

  it('sets X-Content-Type-Options: nosniff on every response', async () => {
    const res = await postMcp();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await res.body?.cancel();
  });

  it('handles CORS preflight: OPTIONS returns 204 with allow-methods + allow-headers', async () => {
    const res = await fetch(mcpUrl, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('echoes Access-Control-Allow-Origin when an Origin header is present', async () => {
    const res = await postMcp({ Origin: 'https://example.com' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await res.body?.cancel();
  });

  it('rejects POST without application/json with a clear 400', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(res.status).toBe(400);
    const body = await parseJson(res, errorResponseSchema);
    expect(body.error).toBe('bad_request');
    expect(body.message).toContain('application/json');
    expect(typeof body.request_id).toBe('string');
  });

  it('regenerates X-Request-Id when the inbound value violates the regex', async () => {
    const res = await postMcp({ 'X-Request-Id': 'has spaces and !!! chars' });
    const echoed = res.headers.get('X-Request-Id');
    expect(echoed).not.toBe('has spaces and !!! chars');
    expect(echoed).toMatch(/^[a-f0-9]{32}$/);
    await res.body?.cancel();
  });

  it('rejects POSTs that exceed the configured body cap with a 400', async () => {
    const started = await startServer(
      makeMcpHttpHandler({
        publicUrl: 'http://test.local',
        pageTtlMs: 60_000,
        maxBodyBytes: 200,
        rateLimiter: new RateLimiter(1000, 60_000),
      }),
    );
    try {
      const oversize = 'x'.repeat(500);
      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
        body: `{"jsonrpc":"2.0","id":1,"method":"junk","params":"${oversize}"}`,
      });
      expect(res.status).toBe(400);
      const body = await parseJson(res, errorResponseSchema);
      expect(body.error).toBe('bad_request');
      expect(body.message).toContain('200-byte limit');
      expect(typeof body.request_id).toBe('string');
    } finally {
      await started.close();
    }
  });

  it('emits draft-7 RateLimit + RateLimit-Policy on every POST (not just 429)', async () => {
    const res = await postMcp();
    const rateLimitHeader = res.headers.get('RateLimit');
    expect(rateLimitHeader).toMatch(/^limit=\d+, remaining=\d+, reset=\d+$/);
    expect(res.headers.get('RateLimit-Policy')).toMatch(/^\d+;w=\d+$/);
    await res.body?.cancel();
  });
});
