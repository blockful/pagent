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
      apiPublicUrl: 'https://api.test.local',
      pageTtlMs: 60_000,
      rateLimiter,
    }),
  );
  mcpUrl = started.url;
  closeServer = started.close;
});

afterAll(async () => {
  await closeServer?.();
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

function accessTokenClaims(scope: string, sub = 'user-uuid'): jwt.JwtPayload {
  return {
    sub,
    email: 'user@example.com',
    handle: 'user',
    client_id: 'mcp-cli',
    scope,
    iss: 'http://test.local',
    aud: 'http://test.local',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: 'test-jti',
  };
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
      apiPublicUrl: 'https://api.test.local',
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
        expect(wwwAuth).toContain(
          'Bearer resource_metadata="https://api.test.local/.well-known/oauth-protected-resource"',
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
      const claims = accessTokenClaims('page:create page:read');
      const spy = vi.spyOn(jwt, 'verifyAccessToken').mockResolvedValue(claims);
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
      const claims = accessTokenClaims('page:create', 'auth-flow-user-uuid');
      const spy = vi.spyOn(jwt, 'verifyAccessToken').mockResolvedValue(claims);
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

  it('show_ui returns an MCP tool error when the token lacks page:create', async () => {
    await withRequireAuth(async () => {
      const claims = accessTokenClaims('page:read', 'read-only-user');
      const spy = vi.spyOn(jwt, 'verifyAccessToken').mockResolvedValue(claims);
      const started = await startProtectedServer();
      const client = new Client({ name: 'test', version: '0.0.1' });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(started.url, {
            requestInit: { headers: { authorization: 'Bearer valid.jwt' } },
          }),
        );
        const result = await client.callTool({
          name: 'show_ui',
          arguments: { spec: [{ createSurface: { surfaceId: 'm' } }] },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('page:create');
        expect(db.insertPage).not.toHaveBeenCalled();
      } finally {
        await client.close();
        spy.mockRestore();
        await started.close();
      }
    });
  });

  it.each(['GET', 'DELETE'] as const)(
    'returns 401 for unauthenticated %s when REQUIRE_AUTH=true',
    async (method) => {
      await withRequireAuth(async () => {
        const started = await startProtectedServer();
        try {
          const res = await fetch(started.url, { method, headers: { Accept: MCP_ACCEPT } });
          expect(res.status).toBe(401);
          expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
        } finally {
          await started.close();
        }
      });
    },
  );

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
