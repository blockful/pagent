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
import { registerPagentTools, type PageOps, type PagentToolRegistrar } from './tools.ts';

type RegisteredTool = {
  handler: (...args: unknown[]) => unknown;
};

function makeServer() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(
      name: string,
      _def: { title?: string; description?: string },
      handler: (...args: never[]) => unknown,
    ) {
      const invoke = (...args: unknown[]): unknown => Reflect.apply(handler, undefined, args);
      tools.set(name, { handler: invoke });
    },
  } satisfies PagentToolRegistrar;
  return { server, tools };
}

function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`expected registered tool: ${name}`);
  return tool;
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

function makeTools(ops = makeOps()): Map<string, RegisteredTool> {
  const { server, tools } = makeServer();
  registerPagentTools(server, ops);
  return tools;
}

const toolCalls = [
  [
    'show_ui',
    { spec: [] },
    'page:create',
    { page_id: 'a'.repeat(32), url: 'http://x/a', expires_at: 0 },
  ],
  [
    'show_html',
    { html: '<p>x</p>' },
    'page:create',
    { page_id: 'b'.repeat(32), url: 'http://x/b', expires_at: 0 },
  ],
  [
    'check_result',
    { page_id: 'a'.repeat(32) },
    'page:read',
    { page_id: 'a'.repeat(32), state: 'open', result: null, format: 'a2ui' },
  ],
] as const;

describe('registerPagentTools', () => {
  it('registers three tools: show_ui, show_html, check_result', () => {
    const tools = makeTools();
    expect([...tools.keys()].sort()).toEqual(['check_result', 'show_html', 'show_ui']);
  });

  it.each(toolCalls)(
    '%s allows an authenticated call with its required scope',
    async (name, args, requiredScope, expectedContent) => {
      const tools = makeTools();
      const handler = getTool(tools, name).handler;
      const result = (await handler(args, {
        authInfo: { scopes: [requiredScope], extra: { sub: 'user-uuid' } },
      })) as { structuredContent: unknown };
      expect(result.structuredContent).toEqual(expectedContent);
    },
  );

  it.each(toolCalls)(
    '%s rejects an authenticated call without its required scope',
    async (name, args, requiredScope) => {
      const tools = makeTools();
      const handler = getTool(tools, name).handler;
      await expect(
        handler(args, {
          authInfo: { scopes: name === 'check_result' ? [] : ['arbitrary'], extra: {} },
        }),
      ).rejects.toThrow(requiredScope);
    },
  );

  it('check_result structuredContent includes format', async () => {
    const tools = makeTools();
    const handler = getTool(tools, 'check_result').handler;
    const out = (await handler({ page_id: 'a'.repeat(32) })) as {
      structuredContent: { state: string; result: unknown; page_id: string; format: string };
    };
    expect(out.structuredContent.format).toBe('a2ui');
  });

  it('show_html handler returns structuredContent matching showHtml', async () => {
    const expectedId = 'c'.repeat(32);
    const expectedUrl = 'http://test.local/' + expectedId;
    const expectedExpires = 1700000000000;
    const tools = makeTools(
      makeOps({
        showHtml: async (html) => {
          // Sanity check: handler must forward the html argument.
          expect(html).toBe('<p>x</p>');
          return { id: expectedId, url: expectedUrl, expires_at: expectedExpires };
        },
      }),
    );
    const handler = getTool(tools, 'show_html').handler;
    const out = (await handler({ html: '<p>x</p>' })) as {
      structuredContent: { page_id: string; url: string; expires_at: number };
    };
    expect(out.structuredContent.page_id).toBe(expectedId);
    expect(out.structuredContent.url).toBe(expectedUrl);
    expect(out.structuredContent.expires_at).toBe(expectedExpires);
  });

  it('check_result handler preserves HTML page state', async () => {
    const tools = makeTools(
      makeOps({
        checkResult: async () => ({
          kind: 'state',
          state: 'open',
          result: null,
          format: 'html',
        }),
      }),
    );
    const handler = getTool(tools, 'check_result').handler;
    const out = (await handler({ page_id: 'd'.repeat(32) })) as {
      structuredContent: { state: string; result: unknown; format: string; page_id: string };
    };
    expect(out.structuredContent.format).toBe('html');
    expect(out.structuredContent.state).toBe('open');
    expect(out.structuredContent.result).toBe(null);
  });

  // ---------------------------------------------------------------------------
  // Auth context propagation
  // ---------------------------------------------------------------------------
  // The HTTP MCP transport stamps `req.auth.extra.sub` after Bearer verify
  // and the SDK forwards that as `extra.authInfo.extra.sub` to tool handlers.
  // These tests pin the contract that the handler lifts that out and passes
  // it to ops.showUi / ops.showHtml as `ownerId`.

  it('show_ui handler forwards extra.authInfo.extra.sub to ops.showUi as ownerId', async () => {
    const captured: { spec?: unknown; ownerId?: string } = {};
    const tools = makeTools(
      makeOps({
        showUi: async (spec, ownerId) => {
          captured.spec = spec;
          captured.ownerId = ownerId;
          return { id: 'a'.repeat(32), url: 'http://x/a', expires_at: 0 };
        },
      }),
    );
    const handler = getTool(tools, 'show_ui').handler;
    await handler(
      { spec: [{ createSurface: { surfaceId: 'm' } }] },
      {
        authInfo: {
          token: 'tok',
          clientId: 'mcp-cli',
          scopes: ['page:create'],
          extra: { sub: 'user-uuid-abc', email: 'a@b.co' },
        },
      },
    );
    expect(captured.ownerId).toBe('user-uuid-abc');
  });

  it('show_ui handler passes ownerId = undefined when no authInfo is present', async () => {
    let captured: string | undefined = 'sentinel';
    const tools = makeTools(
      makeOps({
        showUi: async (_spec, ownerId) => {
          captured = ownerId;
          return { id: 'a'.repeat(32), url: 'http://x/a', expires_at: 0 };
        },
      }),
    );
    const handler = getTool(tools, 'show_ui').handler;
    // Stdio adapter / anon HTTP MCP: extra has no authInfo.
    await handler({ spec: [{ createSurface: { surfaceId: 'm' } }] }, {});
    expect(captured).toBeUndefined();
  });

  it('show_html handler forwards extra.authInfo.extra.sub to ops.showHtml as ownerId', async () => {
    let captured: string | undefined;
    const tools = makeTools(
      makeOps({
        showHtml: async (_html, ownerId) => {
          captured = ownerId;
          return { id: 'b'.repeat(32), url: 'http://x/b', expires_at: 0 };
        },
      }),
    );
    const handler = getTool(tools, 'show_html').handler;
    await handler(
      { html: '<p>x</p>' },
      {
        authInfo: {
          token: 'tok',
          clientId: 'mcp-cli',
          scopes: ['page:create'],
          extra: { sub: 'user-uuid-def' },
        },
      },
    );
    expect(captured).toBe('user-uuid-def');
  });

  it('show_html handler passes ownerId = undefined when no authInfo is present', async () => {
    let captured: string | undefined = 'sentinel';
    const tools = makeTools(
      makeOps({
        showHtml: async (_html, ownerId) => {
          captured = ownerId;
          return { id: 'b'.repeat(32), url: 'http://x/b', expires_at: 0 };
        },
      }),
    );
    const handler = getTool(tools, 'show_html').handler;
    await handler({ html: '<p>x</p>' }, {});
    expect(captured).toBeUndefined();
  });

  it('handler tolerates non-string extra.authInfo.extra.sub (defensive)', async () => {
    // If an upstream auth pipeline ever set `sub` to a number / object, the
    // helper must not pass through garbage. ownerId should be undefined and
    // the store will write owner_id = NULL.
    let captured: string | undefined = 'sentinel';
    const tools = makeTools(
      makeOps({
        showUi: async (_spec, ownerId) => {
          captured = ownerId;
          return { id: 'a'.repeat(32), url: 'http://x/a', expires_at: 0 };
        },
      }),
    );
    const handler = getTool(tools, 'show_ui').handler;
    await handler(
      { spec: [{ createSurface: { surfaceId: 'm' } }] },
      {
        authInfo: {
          token: 'tok',
          clientId: 'mcp-cli',
          scopes: ['page:create'],
          extra: { sub: 42 },
        },
      },
    );
    expect(captured).toBeUndefined();
  });
});
