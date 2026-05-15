/**
 * Unit tests for shared MCP tool registration.
 *
 * Exercises registerPagentTools against a stub server so we can assert
 * the tools' shapes, descriptions, and handler behavior without booting
 * a transport. The HTTP MCP integration (apps/api/mcp/http.test.ts)
 * covers end-to-end client flows; this file pins the contract the model
 * sees and the per-tool handler logic.
 */
import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPagentTools, type PageOps } from './tools.ts';

type RegisteredTool = {
  description: string;
  inputSchema: unknown;
  handler: (...args: unknown[]) => unknown;
};

function makeServer(): {
  server: McpServer;
  tools: Map<string, RegisteredTool>;
} {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(
      name: string,
      def: { description: string; inputSchema: unknown },
      handler: (...args: unknown[]) => unknown,
    ) {
      tools.set(name, { ...def, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

// Default no-op PageOps. Tests that exercise a specific handler call
// makeOps({ ... }) to override one or more methods.
const defaultOps: PageOps = {
  showUi: async () => ({ id: 'a'.repeat(32), url: 'http://x/a', expires_at: 0 }),
  showHtml: async () => ({ id: 'b'.repeat(32), url: 'http://x/b', expires_at: 0 }),
  checkResult: async () => ({ kind: 'state', state: 'open', result: null, format: 'a2ui' }),
};

function makeOps(overrides: Partial<PageOps> = {}): PageOps {
  return { ...defaultOps, ...overrides };
}

describe('registerPagentTools', () => {
  it('registers three tools: show_ui, show_html, check_result', () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, makeOps());
    expect(tools.has('show_ui')).toBe(true);
    expect(tools.has('show_html')).toBe(true);
    expect(tools.has('check_result')).toBe(true);
  });

  it('show_html description mentions view-only and no scripts', () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, makeOps());
    const desc = tools.get('show_html')!.description;
    expect(desc).toMatch(/view-only/i);
    expect(desc).toMatch(/script/i);
    expect(desc).toMatch(/JavaScript/i);
  });

  it('show_ui description distinguishes itself from show_html', () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, makeOps());
    const desc = tools.get('show_ui')!.description;
    expect(desc).toMatch(/show_html/);
  });

  it('check_result structuredContent includes format', async () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, makeOps());
    const handler = tools.get('check_result')!.handler;
    const out = (await handler({ page_id: 'a'.repeat(32) })) as {
      structuredContent: { state: string; result: unknown; page_id: string; format: string };
    };
    expect(out.structuredContent.format).toBe('a2ui');
  });

  it('show_html handler returns structuredContent matching showHtml + "do not poll" text', async () => {
    const { server, tools } = makeServer();
    const expectedId = 'c'.repeat(32);
    const expectedUrl = 'http://test.local/' + expectedId;
    const expectedExpires = 1700000000000;
    registerPagentTools(
      server,
      makeOps({
        showHtml: async (html) => {
          // Sanity check: handler must forward the html argument.
          expect(html).toBe('<p>x</p>');
          return { id: expectedId, url: expectedUrl, expires_at: expectedExpires };
        },
      }),
    );
    const handler = tools.get('show_html')!.handler;
    const out = (await handler({ html: '<p>x</p>' })) as {
      structuredContent: { page_id: string; url: string; expires_at: number };
      content: Array<{ type: string; text: string }>;
    };
    expect(out.structuredContent.page_id).toBe(expectedId);
    expect(out.structuredContent.url).toBe(expectedUrl);
    expect(out.structuredContent.expires_at).toBe(expectedExpires);
    // Per show_html handler text (tools.ts), the LLM-facing string tells the
    // model the page is view-only and not to poll. Match on "do not poll".
    expect(out.content[0]?.text).toMatch(/do not poll/i);
  });

  it('check_result handler on an HTML page surfaces "stop polling" guidance', async () => {
    const { server, tools } = makeServer();
    registerPagentTools(
      server,
      makeOps({
        checkResult: async () => ({
          kind: 'state',
          state: 'open',
          result: null,
          format: 'html',
        }),
      }),
    );
    const handler = tools.get('check_result')!.handler;
    const out = (await handler({ page_id: 'd'.repeat(32) })) as {
      structuredContent: { state: string; result: unknown; format: string; page_id: string };
      content: Array<{ type: string; text: string }>;
    };
    expect(out.structuredContent.format).toBe('html');
    expect(out.structuredContent.state).toBe('open');
    expect(out.structuredContent.result).toBe(null);
    expect(out.content[0]?.text).toMatch(/stop polling/i);
  });
});
