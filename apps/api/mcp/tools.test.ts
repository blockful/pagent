/**
 * Unit tests for shared MCP tool registration.
 *
 * Exercises registerPagentTools against a stub server so we can assert
 * the tools' shapes and descriptions without booting a transport. The
 * HTTP MCP integration (apps/api/mcp/http.test.ts) covers end-to-end
 * client flows; this file pins the contract the model sees.
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

const noopOps: PageOps = {
  showUi: async () => ({ id: 'a'.repeat(32), url: 'http://x/a', expires_at: 0 }),
  showHtml: async () => ({ id: 'b'.repeat(32), url: 'http://x/b', expires_at: 0 }),
  checkResult: async () => ({ kind: 'state', state: 'open', result: null, format: 'a2ui' }),
};

describe('registerPagentTools', () => {
  it('registers three tools: show_ui, show_html, check_result', () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, noopOps);
    expect(tools.has('show_ui')).toBe(true);
    expect(tools.has('show_html')).toBe(true);
    expect(tools.has('check_result')).toBe(true);
  });

  it('show_html description mentions view-only and no scripts', () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, noopOps);
    const desc = tools.get('show_html')!.description;
    expect(desc).toMatch(/view-only/i);
    expect(desc).toMatch(/script/i);
    expect(desc).toMatch(/JavaScript/i);
  });

  it('show_ui description distinguishes itself from show_html', () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, noopOps);
    const desc = tools.get('show_ui')!.description;
    expect(desc).toMatch(/show_html/);
  });

  it('check_result structuredContent includes format', async () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, noopOps);
    const handler = tools.get('check_result')!.handler;
    const out = (await handler({ page_id: 'a'.repeat(32) })) as {
      structuredContent: { state: string; result: unknown; page_id: string; format: string };
    };
    expect(out.structuredContent.format).toBe('a2ui');
  });
});
