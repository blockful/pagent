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

vi.mock('../decks/repository-decks.ts', () => ({ publishDeck: vi.fn() }));
vi.mock('../decks/repository-analytics.ts', () => ({ getDeckAnalytics: vi.fn() }));

import * as db from '../db.ts';
import * as jwt from '../auth/jwt.ts';
import { getDeckAnalytics } from '../decks/repository-analytics.ts';
import { publishDeck } from '../decks/repository-decks.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeMcpHttpHandler } from './http.ts';
import { RateLimiter } from './rate-limit.ts';
import { startServer } from './http-test-support.ts';

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
  if (closeServer !== undefined) {
    await closeServer();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiter.reset();
  (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  vi.mocked(publishDeck).mockResolvedValue({
    deckId: '00000000-0000-4000-8000-000000000001',
    revisionId: '00000000-0000-4000-8000-000000000002',
    revisionNumber: 1,
  });
  vi.mocked(getDeckAnalytics).mockResolvedValue({
    owner: { id: '00000000-0000-4000-8000-000000000010', email: 'owner@example.com' },
    overview: {
      totalVisits: 3,
      uniqueViewers: 2,
      lastViewed: null,
      averageActiveTimeMs: 4_000,
      averageCompletion: 0.5,
      topSlide: null,
    },
    visitors: [],
    slides: [],
    visits: [],
  });
});

async function newSdkClient(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl));
  return client;
}

describe('SDK client', () => {
  it('lists exactly read and write', async () => {
    const client = await newSdkClient();
    try {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual(['read', 'write']);
    } finally {
      await client.close();
    }
  });

  it('write creates an interactive page and returns id/url/expires_at', async () => {
    const client = await newSdkClient();
    try {
      const result = await client.callTool({
        name: 'write',
        arguments: {
          type: 'interactive',
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
      const structuredContent = result.structuredContent as Record<string, unknown>;
      expect(typeof structuredContent.page_id).toBe('string');
      expect((structuredContent.page_id as string).length).toBe(32);
      expect(structuredContent.url).toMatch(/^http:\/\/test\.local\//);
      expect(typeof structuredContent.expires_at).toBe('number');
      expect(db.insertPage).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it('write sanitizes a document page before storage', async () => {
    const client = await newSdkClient();
    try {
      const result = await client.callTool({
        name: 'write',
        arguments: { type: 'document', html: '<p>safe</p><script>alert(1)</script>' },
      });
      const structuredContent = result.structuredContent as Record<string, unknown>;
      expect(typeof structuredContent.page_id).toBe('string');
      expect((structuredContent.page_id as string).length).toBe(32);
      expect(structuredContent.url).toMatch(/^http:\/\/test\.local\//);
      expect(typeof structuredContent.expires_at).toBe('number');
      expect(db.insertPage).toHaveBeenCalledTimes(1);
      const [insertedPage] = (db.insertPage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(insertedPage.format).toBe('html');
      expect(typeof insertedPage.spec).toBe('string');
      expect(insertedPage.spec as string).toContain('<p>safe</p>');
      expect(insertedPage.spec as string).not.toContain('<script');
      expect(insertedPage.spec as string).not.toContain('alert(1)');
    } finally {
      await client.close();
    }
  });

  it('write surfaces an error when document sanitization yields empty output', async () => {
    const client = await newSdkClient();
    try {
      const result = await client.callTool({
        name: 'write',
        arguments: { type: 'document', html: '<script>x</script>' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).toMatch(/stripped/i);
      expect(db.insertPage).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('read returns the open state for an existing interactive page', async () => {
    (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stateAtRead: 'open',
      result: null,
      format: 'a2ui',
    });
    const client = await newSdkClient();
    try {
      const result = await client.callTool({
        name: 'read',
        arguments: { page_id: 'aabbccddeeff00112233445566778899' },
      });
      const structuredContent = result.structuredContent as Record<string, unknown>;
      expect(structuredContent.state).toBe('open');
      expect(structuredContent.response).toBe(null);
      expect(structuredContent.type).toBe('interactive');
    } finally {
      await client.close();
    }
  });

  it('read on a not-found page returns an error with a recovery message', async () => {
    const client = await newSdkClient();
    try {
      const result = await client.callTool({
        name: 'read',
        arguments: { page_id: 'deadbeefdeadbeefdeadbeefdeadbeef' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).toContain('not found');
      expect(text).toContain('Write a new page');
    } finally {
      await client.close();
    }
  });

  it('writes a durable presentation page and reads its analytics over HTTP MCP', async () => {
    const claims: jwt.JwtPayload = {
      sub: '00000000-0000-4000-8000-000000000010',
      email: 'owner@example.com',
      handle: 'owner',
      client_id: 'mcp-cli',
      scope: 'page:create page:read',
      iss: 'https://api.test.local',
      aud: 'https://api.test.local',
      exp: Math.floor(Date.now() / 1000) + 3_600,
      iat: Math.floor(Date.now() / 1000),
      jti: 'durable-page-test',
    };
    const spy = vi.spyOn(jwt, 'verifyAccessToken').mockResolvedValue(claims);
    const client = new Client({ name: 'test', version: '0.0.1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(mcpUrl, {
          requestInit: { headers: { authorization: 'Bearer valid.jwt' } },
        }),
      );
      const written = await client.callTool({
        name: 'write',
        arguments: {
          type: 'presentation',
          title: 'Northstar',
          slides: [{ id: 'cover', html: '<h1>Northstar</h1>' }],
        },
      });
      expect(written.structuredContent).toMatchObject({
        page_id: '00000000-0000-4000-8000-000000000001',
        type: 'presentation',
        durable: true,
      });

      const read = await client.callTool({
        name: 'read',
        arguments: { page_id: '00000000-0000-4000-8000-000000000001' },
      });
      expect(read.structuredContent).toMatchObject({
        page_id: '00000000-0000-4000-8000-000000000001',
        type: 'presentation',
        analytics: { overview: { totalVisits: 3, uniqueViewers: 2 } },
      });
      expect(getDeckAnalytics).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000010',
        '00000000-0000-4000-8000-000000000001',
        {},
      );
    } finally {
      await client.close();
      spy.mockRestore();
    }
  });
});
