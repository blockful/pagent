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
let baseUrl: string;
let mcpUrl: URL;
const rateLimiter = new RateLimiter(1000, 60_000); // generous; rate-limit cases override per-test

beforeAll(async () => {
  const handler = makeMcpHttpHandler({
    publicUrl: 'http://test.local',
    pageTtlMs: 60_000,
    rateLimiter,
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  mcpUrl = new URL(`${baseUrl}/mcp`);
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
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
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('returns 429 with retry_after once the per-IP cap is exhausted', async () => {
    // Tight limiter, isolated to this describe block.
    const tight = new RateLimiter(2, 60_000);
    const tightHandler = makeMcpHttpHandler({
      publicUrl: 'http://test.local',
      pageTtlMs: 60_000,
      rateLimiter: tight,
    });
    const tightServer = createServer(tightHandler);
    await new Promise<void>((resolve) => tightServer.listen(0, '127.0.0.1', () => resolve()));
    const tightPort = (tightServer.address() as AddressInfo).port;
    const tightUrl = new URL(`http://127.0.0.1:${tightPort}/mcp`);

    try {
      const ip = '1.2.3.4';
      const post = () =>
        fetch(tightUrl, {
          method: 'POST',
          headers: {
            Accept: MCP_ACCEPT,
            'Content-Type': 'application/json',
            'X-Forwarded-For': ip,
          },
          body: INITIALIZE_BODY,
        });

      const r1 = await post();
      const r2 = await post();
      expect(r1.status).toBeLessThan(400);
      expect(r2.status).toBeLessThan(400);
      await r1.body?.cancel();
      await r2.body?.cancel();

      const r3 = await post();
      expect(r3.status).toBe(429);
      const body = await r3.json();
      expect(body.error).toBe('rate_limited');
      expect(typeof body.retry_after_seconds).toBe('number');
      expect(body.retry_after_seconds).toBeGreaterThan(0);
      expect(r3.headers.get('Retry-After')).toBe(String(body.retry_after_seconds));
      expect(r3.headers.get('RateLimit-Limit')).toBe('2');
    } finally {
      await new Promise<void>((resolve, reject) =>
        tightServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('keys per IP — exhausting one bucket does not affect another', async () => {
    const tight = new RateLimiter(1, 60_000);
    const tightHandler = makeMcpHttpHandler({
      publicUrl: 'http://test.local',
      pageTtlMs: 60_000,
      rateLimiter: tight,
    });
    const tightServer = createServer(tightHandler);
    await new Promise<void>((resolve) => tightServer.listen(0, '127.0.0.1', () => resolve()));
    const tightPort = (tightServer.address() as AddressInfo).port;
    const tightUrl = new URL(`http://127.0.0.1:${tightPort}/mcp`);

    try {
      const post = (ip: string) =>
        fetch(tightUrl, {
          method: 'POST',
          headers: {
            Accept: MCP_ACCEPT,
            'Content-Type': 'application/json',
            'X-Forwarded-For': ip,
          },
          body: INITIALIZE_BODY,
        });

      const r1 = await post('1.1.1.1');
      expect(r1.status).toBeLessThan(400);
      await r1.body?.cancel();

      const r2 = await post('1.1.1.1');
      expect(r2.status).toBe(429);

      const r3 = await post('2.2.2.2');
      expect(r3.status).toBeLessThan(400);
      await r3.body?.cancel();
    } finally {
      await new Promise<void>((resolve, reject) =>
        tightServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
