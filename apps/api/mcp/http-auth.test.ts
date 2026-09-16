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

import * as db from '../db.ts';
import * as jwt from '../auth/jwt.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { env } from '../schemas.ts';
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
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

function withRequireAuth<T>(fn: () => Promise<T>): Promise<T> {
  const original = env.REQUIRE_AUTH;
  (env as { REQUIRE_AUTH: boolean }).REQUIRE_AUTH = true;
  return fn().finally(() => {
    (env as { REQUIRE_AUTH: boolean }).REQUIRE_AUTH = original;
  });
}

async function newSdkClient(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl));
  return client;
}

async function startProtectedServer() {
  return startServer(
    makeMcpHttpHandler({
      publicUrl: 'http://test.local',
      pageTtlMs: 60_000,
      rateLimiter: new RateLimiter(1000, 60_000),
    }),
  );
}

describe('Bearer auth gating', () => {
  it('returns 401 with WWW-Authenticate when REQUIRE_AUTH=true and no Bearer', async () => {
    await withRequireAuth(async () => {
      const started = await startProtectedServer();
      try {
        const res = await fetch(started.url, {
          method: 'POST',
          headers: { Accept: MCP_ACCEPT, 'Content-Type': 'application/json' },
          body: INITIALIZE_BODY,
        });
        expect(res.status).toBe(401);
        const wwwAuth = res.headers.get('WWW-Authenticate');
        expect(wwwAuth).toContain('Bearer');
        expect(wwwAuth).toContain(
          'resource_metadata="http://test.local/.well-known/oauth-protected-resource"',
        );
        const body = await parseJson(res, errorResponseSchema);
        expect(body.error).toBe('unauthorized');
        expect(body.message).toMatch(/bearer/i);
        expect(typeof body.request_id).toBe('string');
      } finally {
        await started.close();
      }
    });
  });

  it('returns 401 with invalid_token when REQUIRE_AUTH=true and Bearer fails verification', async () => {
    await withRequireAuth(async () => {
      const spy = vi.spyOn(jwt, 'verifyAccessToken').mockRejectedValue(new Error('expired'));
      const started = await startProtectedServer();
      try {
        const res = await fetch(started.url, {
          method: 'POST',
          headers: {
            Accept: MCP_ACCEPT,
            'Content-Type': 'application/json',
            authorization: 'Bearer expired.jwt.token',
          },
          body: INITIALIZE_BODY,
        });
        expect(res.status).toBe(401);
        const wwwAuth = res.headers.get('WWW-Authenticate');
        expect(wwwAuth).toContain('error="invalid_token"');
        const body = await parseJson(res, errorResponseSchema);
        expect(body.error).toBe('invalid_token');
      } finally {
        spy.mockRestore();
        await started.close();
      }
    });
  });

  it('passes through when REQUIRE_AUTH=true and a valid Bearer is presented', async () => {
    await withRequireAuth(async () => {
      const spy = vi.spyOn(jwt, 'verifyAccessToken').mockResolvedValue({
        sub: 'user-uuid',
        email: 'a@b.co',
        handle: 'a',
        client_id: 'mcp-cli',
        scope: 'page:create page:read',
        iss: 'http://test.local',
        aud: 'http://test.local',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        jti: 'jti-1',
      });
      const started = await startProtectedServer();
      try {
        const res = await fetch(started.url, {
          method: 'POST',
          headers: {
            Accept: MCP_ACCEPT,
            'Content-Type': 'application/json',
            authorization: 'Bearer valid.jwt',
          },
          body: INITIALIZE_BODY,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('WWW-Authenticate')).toBeNull();
        await res.body?.cancel();
      } finally {
        spy.mockRestore();
        await started.close();
      }
    });
  });

  it('does not require Bearer when REQUIRE_AUTH=false (existing behavior preserved)', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { Accept: MCP_ACCEPT, 'Content-Type': 'application/json' },
      body: INITIALIZE_BODY,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
    await res.body?.cancel();
  });

  it('show_ui via authed MCP forwards JWT sub as owner_id to db.insertPage', async () => {
    await withRequireAuth(async () => {
      const spy = vi.spyOn(jwt, 'verifyAccessToken').mockResolvedValue({
        sub: 'auth-flow-user-uuid',
        email: 'flow@example.com',
        handle: 'flow',
        client_id: 'mcp-cli',
        scope: 'page:create',
        iss: 'http://test.local',
        aud: 'http://test.local',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        jti: 'jti-flow',
      });
      const started = await startProtectedServer();
      const client = new Client({ name: 'test', version: '0.0.1' });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(started.url, {
            requestInit: { headers: { authorization: 'Bearer valid.jwt' } },
          }),
        );
        await client.callTool({
          name: 'show_ui',
          arguments: { spec: [{ createSurface: { surfaceId: 'm' } }] },
        });
        expect(db.insertPage).toHaveBeenCalledTimes(1);
        const [page] = (db.insertPage as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(page.ownerId).toBe('auth-flow-user-uuid');
      } finally {
        await client.close();
        spy.mockRestore();
        await started.close();
      }
    });
  });

  it('show_ui via unauthenticated MCP (REQUIRE_AUTH=false) leaves ownerId null', async () => {
    const client = await newSdkClient();
    try {
      await client.callTool({
        name: 'show_ui',
        arguments: { spec: [{ createSurface: { surfaceId: 'm' } }] },
      });
      expect(db.insertPage).toHaveBeenCalledTimes(1);
      const [page] = (db.insertPage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(page.ownerId).toBeNull();
    } finally {
      await client.close();
    }
  });
});
