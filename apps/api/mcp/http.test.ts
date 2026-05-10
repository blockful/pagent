/**
 * Integration tests for the HTTP MCP handler.
 *
 * Boots an actual Node HTTP server on a random port and drives it with
 * either the official SDK client (for tool-level behavior) or plain fetch
 * (for HTTP-layer behavior — CORS, headers, rate limiting). The DB module
 * is mocked, mirroring app.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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

import * as db from '../db.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeMcpHttpHandler } from './http.ts';
import { RateLimiter } from './rate-limit.ts';

// --- Test fixture -----------------------------------------------------------

let server: Server;
let mcpUrl: URL;
const rateLimiter = new RateLimiter(1000, 60_000); // generous; rate-limit cases override per-test

/**
 * Boot a Node http server bound to a random local port. Returns once the
 * server is listening. `closeAllConnections()` is called in teardown to
 * tear down keep-alive sockets so close() returns promptly under CI.
 */
async function startServer(handler: ReturnType<typeof makeMcpHttpHandler>): Promise<{
  server: Server;
  url: URL;
  close: () => Promise<void>;
}> {
  const s = createServer(handler);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const port = (s.address() as AddressInfo).port;
  return {
    server: s,
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: () =>
      new Promise<void>((resolve, reject) => {
        s.closeAllConnections();
        s.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

beforeAll(async () => {
  const handler = makeMcpHttpHandler({
    publicUrl: 'http://test.local',
    pageTtlMs: 60_000,
    rateLimiter,
  });
  const started = await startServer(handler);
  server = started.server;
  mcpUrl = started.url;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiter.reset();
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

// --- Helpers ----------------------------------------------------------------

async function newSdkClient(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl));
  return client;
}

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fetch', version: '0' },
  },
});

const MCP_ACCEPT = 'application/json, text/event-stream';

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

// ---------------------------------------------------------------------------
// Tool-level behavior via the SDK client
// ---------------------------------------------------------------------------

describe('SDK client', () => {
  it('lists both tools', async () => {
    const client = await newSdkClient();
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name).sort()).toEqual(['check_result', 'show_ui']);
    await client.close();
  });

  it('show_ui creates a page (db.insertPage called) and returns id/url/expires_at', async () => {
    const client = await newSdkClient();
    const result = await client.callTool({
      name: 'show_ui',
      arguments: {
        spec: [
          {
            createSurface: {
              surfaceId: 'm',
              catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
            },
          },
          {
            updateComponents: {
              surfaceId: 'm',
              components: [{ id: 'root', component: 'Text', text: 'hi' }],
            },
          },
        ],
      },
    });
    const sc = result.structuredContent as Record<string, unknown>;
    expect(typeof sc.page_id).toBe('string');
    expect((sc.page_id as string).length).toBe(32);
    expect(sc.url).toMatch(/^http:\/\/test\.local\//);
    expect(typeof sc.expires_at).toBe('number');
    expect(db.insertPage).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it('check_result returns the open state for an existing page', async () => {
    (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stateAtRead: 'open',
      result: null,
    });
    const client = await newSdkClient();
    const result = await client.callTool({
      name: 'check_result',
      arguments: { page_id: 'aabbccddeeff00112233445566778899' },
    });
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.state).toBe('open');
    expect(sc.result).toBe(null);
    await client.close();
  });

  it('check_result on a not-found page returns isError with a recovery message', async () => {
    const client = await newSdkClient();
    const result = await client.callTool({
      name: 'check_result',
      arguments: { page_id: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('not found');
    expect(text).toContain('show_ui');
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP-layer behavior via plain fetch
// ---------------------------------------------------------------------------

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
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('echoes Access-Control-Allow-Origin when an Origin header is present', async () => {
    const res = await postMcp({ Origin: 'https://example.com' });
    // ALLOWED_ORIGINS is unset in test env → wildcard.
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
    const body = await res.json();
    expect(body.error).toBe('bad_request');
    expect(body.message).toContain('application/json');
    expect(typeof body.request_id).toBe('string');
  });

  it('regenerates X-Request-Id when the inbound value violates the regex', async () => {
    // Spaces aren't in [A-Za-z0-9_-]{1,128}, so the value should be rejected
    // and a fresh 32-char hex id generated in its place.
    const res = await postMcp({ 'X-Request-Id': 'has spaces and !!! chars' });
    const echoed = res.headers.get('X-Request-Id');
    expect(echoed).not.toBe('has spaces and !!! chars');
    expect(echoed).toMatch(/^[a-f0-9]{32}$/);
    await res.body?.cancel();
  });

  it('rejects POSTs that exceed the configured body cap with a 400', async () => {
    // Inject a tiny cap so we don't have to send 256 KB to trigger it.
    const tightHandler = makeMcpHttpHandler({
      publicUrl: 'http://test.local',
      pageTtlMs: 60_000,
      maxBodyBytes: 200,
      rateLimiter: new RateLimiter(1000, 60_000),
    });
    const { url, close } = await startServer(tightHandler);
    try {
      const oversize = 'x'.repeat(500);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
        body: `{"jsonrpc":"2.0","id":1,"method":"junk","params":"${oversize}"}`,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('bad_request');
      expect(body.message).toContain('200-byte limit');
      expect(typeof body.request_id).toBe('string');
    } finally {
      await close();
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

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  async function startTightServer(limit: number) {
    const handler = makeMcpHttpHandler({
      publicUrl: 'http://test.local',
      pageTtlMs: 60_000,
      rateLimiter: new RateLimiter(limit, 60_000),
    });
    return startServer(handler);
  }

  function postFromIp(url: URL, ip: string): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        Accept: MCP_ACCEPT,
        'Content-Type': 'application/json',
        'X-Forwarded-For': ip,
      },
      body: INITIALIZE_BODY,
    });
  }

  it('returns 429 with retry_after_seconds once the per-IP cap is exhausted', async () => {
    const { url, close } = await startTightServer(2);
    try {
      const r1 = await postFromIp(url, '1.2.3.4');
      const r2 = await postFromIp(url, '1.2.3.4');
      expect(r1.status).toBeLessThan(400);
      expect(r2.status).toBeLessThan(400);
      await r1.body?.cancel();
      await r2.body?.cancel();

      const r3 = await postFromIp(url, '1.2.3.4');
      expect(r3.status).toBe(429);
      const body = await r3.json();
      expect(body.error).toBe('rate_limited');
      expect(typeof body.retry_after_seconds).toBe('number');
      expect(body.retry_after_seconds).toBeGreaterThan(0);
      expect(typeof body.request_id).toBe('string');
      expect(r3.headers.get('Retry-After')).toBe(String(body.retry_after_seconds));
      // Combined draft-7 header — same shape hono-rate-limiter emits on REST.
      expect(r3.headers.get('RateLimit')).toMatch(/limit=2, remaining=0, reset=\d+/);
    } finally {
      await close();
    }
  });

  it('keys per IP — exhausting one bucket does not affect another', async () => {
    const { url, close } = await startTightServer(1);
    try {
      const r1 = await postFromIp(url, '1.1.1.1');
      expect(r1.status).toBeLessThan(400);
      await r1.body?.cancel();

      const r2 = await postFromIp(url, '1.1.1.1');
      expect(r2.status).toBe(429);

      const r3 = await postFromIp(url, '2.2.2.2');
      expect(r3.status).toBeLessThan(400);
      await r3.body?.cancel();
    } finally {
      await close();
    }
  });
});
