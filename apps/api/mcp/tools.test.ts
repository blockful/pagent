import { describe, expect, it } from 'vitest';
import { registerPagentTools, type PageOps, type PagentToolRegistrar } from './tools.ts';

type RegisteredTool = {
  readonly handler: (...args: unknown[]) => unknown;
};

function makeServer() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(
      name: string,
      _definition: { readonly title?: string; readonly description?: string },
      handler: (...args: never[]) => unknown,
    ) {
      tools.set(name, {
        handler: (...args: unknown[]): unknown => Reflect.apply(handler, undefined, args),
      });
    },
  } satisfies PagentToolRegistrar;
  return { server, tools };
}

const defaultOps: PageOps = {
  writeInteractive: async () => ({ id: 'a'.repeat(32), url: 'https://pagent.link/a', expires_at: 1 }),
  writeDocument: async () => ({ id: 'b'.repeat(32), url: 'https://pagent.link/b', expires_at: 2 }),
  writePresentation: async () => ({
    page_id: '00000000-0000-4000-8000-000000000001',
    revision_id: '00000000-0000-4000-8000-000000000002',
    revision_number: 1,
    manage_url: 'https://pagent.link/pages/00000000-0000-4000-8000-000000000001',
    preview_url: 'https://pagent.link/pages/00000000-0000-4000-8000-000000000001#preview',
  }),
  readResponse: async () => ({ kind: 'state', state: 'open', result: null, format: 'a2ui' }),
  readAnalytics: async () => ({ overview: { totalVisits: 3, uniqueViewers: 2 }, slides: [] }),
};

function makeTools(overrides: Partial<PageOps> = {}) {
  const { server, tools } = makeServer();
  registerPagentTools(server, { ...defaultOps, ...overrides });
  return tools;
}

function tool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const found = tools.get(name);
  if (found === undefined) throw new Error(`expected ${name} to be registered`);
  return found;
}

function structuredContent(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('structuredContent' in result)) {
    throw new Error('expected structuredContent');
  }
  return result.structuredContent;
}

const auth = {
  authInfo: {
    scopes: ['page:create', 'page:read'],
    extra: { sub: '00000000-0000-4000-8000-000000000010', email: 'owner@example.com' },
  },
};

describe('registerPagentTools', () => {
  it('registers exactly read and write', () => {
    expect([...makeTools().keys()].sort()).toEqual(['read', 'write']);
  });

  it('writes interactive and document pages through one tool', async () => {
    const seen: string[] = [];
    const tools = makeTools({
      writeInteractive: async (_spec, ownerId) => {
        seen.push(`interactive:${ownerId}`);
        return defaultOps.writeInteractive([], ownerId);
      },
      writeDocument: async (_html, ownerId) => {
        seen.push(`document:${ownerId}`);
        return defaultOps.writeDocument('', ownerId);
      },
    });

    const interactive = await tool(tools, 'write').handler(
      { type: 'interactive', spec: [] },
      auth,
    );
    const document = await tool(tools, 'write').handler(
      { type: 'document', html: '<h1>Report</h1>' },
      auth,
    );

    expect(seen).toEqual([
      'interactive:00000000-0000-4000-8000-000000000010',
      'document:00000000-0000-4000-8000-000000000010',
    ]);
    expect(structuredContent(interactive)).toMatchObject({ type: 'interactive', durable: false });
    expect(structuredContent(document)).toMatchObject({ type: 'document', durable: false });
  });

  it('writes a durable presentation page and maps page_id to the existing revision model', async () => {
    let updateDeckId: string | undefined;
    const tools = makeTools({
      writePresentation: async (input, publisher) => {
        updateDeckId = input.update_deck_id;
        expect(publisher).toEqual({
          id: '00000000-0000-4000-8000-000000000010',
          email: 'owner@example.com',
        });
        return defaultOps.writePresentation(input, publisher);
      },
    });

    const result = await tool(tools, 'write').handler(
      {
        type: 'presentation',
        page_id: '00000000-0000-4000-8000-000000000001',
        title: 'Northstar',
        slides: [{ id: 'cover', html: '<h1>Northstar</h1>' }],
      },
      auth,
    );

    expect(updateDeckId).toBe('00000000-0000-4000-8000-000000000001');
    expect(structuredContent(result)).toMatchObject({ type: 'presentation', durable: true });
  });

  it('reads an ephemeral response and a presentation analytics summary', async () => {
    const tools = makeTools();
    const response = await tool(tools, 'read').handler({ page_id: 'a'.repeat(32) }, auth);
    const analytics = await tool(tools, 'read').handler(
      { page_id: '00000000-0000-4000-8000-000000000001' },
      auth,
    );

    expect(structuredContent(response)).toEqual({
      page_id: 'a'.repeat(32),
      type: 'interactive',
      state: 'open',
      response: null,
    });
    expect(structuredContent(analytics)).toMatchObject({
      page_id: '00000000-0000-4000-8000-000000000001',
      type: 'presentation',
      analytics: { overview: { totalVisits: 3, uniqueViewers: 2 } },
    });
  });

  it.each([
    ['write', { type: 'interactive', spec: [] }, 'page:create'],
    ['read', { page_id: 'a'.repeat(32) }, 'page:read'],
  ] as const)('enforces %s OAuth scope', async (name, input, expectedScope) => {
    const tools = makeTools();
    await expect(
      tool(tools, name).handler(input, { authInfo: { scopes: [], extra: {} } }),
    ).rejects.toThrow(expectedScope);
  });
});
