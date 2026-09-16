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
});

async function newSdkClient(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl));
  return client;
}

describe('SDK client', () => {
  it('lists all three tools', async () => {
    const client = await newSdkClient();
    try {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual([
        'check_result',
        'show_html',
        'show_ui',
      ]);
    } finally {
      await client.close();
    }
  });

  it('show_ui creates a page (db.insertPage called) and returns id/url/expires_at', async () => {
    const client = await newSdkClient();
    try {
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

  it('show_html sanitizes the input before storage and returns id/url/expires_at', async () => {
    const client = await newSdkClient();
    try {
      const result = await client.callTool({
        name: 'show_html',
        arguments: { html: '<p>safe</p><script>alert(1)</script>' },
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

  it('show_html surfaces an error when sanitization yields empty output', async () => {
    const client = await newSdkClient();
    try {
      const result = await client.callTool({
        name: 'show_html',
        arguments: { html: '<script>x</script>' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).toMatch(/stripped/i);
      expect(db.insertPage).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('check_result returns the open state for an existing page', async () => {
    (db.fetchAndAdvanceResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stateAtRead: 'open',
      result: null,
      format: 'a2ui',
    });
    const client = await newSdkClient();
    try {
      const result = await client.callTool({
        name: 'check_result',
        arguments: { page_id: 'aabbccddeeff00112233445566778899' },
      });
      const structuredContent = result.structuredContent as Record<string, unknown>;
      expect(structuredContent.state).toBe('open');
      expect(structuredContent.result).toBe(null);
      expect(structuredContent.format).toBe('a2ui');
    } finally {
      await client.close();
    }
  });

  it('check_result on a not-found page returns isError with a recovery message', async () => {
    const client = await newSdkClient();
    try {
      const result = await client.callTool({
        name: 'check_result',
        arguments: { page_id: 'deadbeefdeadbeefdeadbeefdeadbeef' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).toContain('not found');
      expect(text).toContain('show_ui');
    } finally {
      await client.close();
    }
  });
});
