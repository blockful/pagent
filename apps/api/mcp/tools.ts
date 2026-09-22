import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { deckIdSchema, htmlPublishDeckBodySchema, type PublishDeckBody } from '../decks/domain.ts';
import { HTML_MAX_BYTES } from '../limits.ts';

export type PageState = 'open' | 'submitted' | 'received';
export type PageFormat = 'a2ui' | 'html';

export type EphemeralPageResult = {
  readonly id: string;
  readonly url: string;
  readonly expires_at: number;
};

export type ResponseReadOutcome =
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'state';
      readonly state: PageState;
      readonly result: unknown;
      readonly format: PageFormat;
    };

export type PublisherIdentity = {
  readonly id: string;
  readonly email: string;
};

export type PresentationWriteResult = {
  readonly page_id: string;
  readonly revision_id: string;
  readonly revision_number: number;
  readonly manage_url: string;
  readonly preview_url: string;
};

export interface PageOps {
  writeInteractive(spec: unknown, ownerId?: string): Promise<EphemeralPageResult>;
  writeDocument(html: string, ownerId?: string): Promise<EphemeralPageResult>;
  writePresentation(
    input: PublishDeckBody,
    publisher?: PublisherIdentity,
  ): Promise<PresentationWriteResult>;
  readResponse(pageId: string): Promise<ResponseReadOutcome>;
  readAnalytics(pageId: string, readerId?: string): Promise<object>;
}

type ToolExtra = {
  readonly authInfo?: {
    readonly scopes: readonly string[];
    readonly extra?: Readonly<Record<string, unknown>>;
  };
};

class InsufficientScopeError extends Error {
  readonly requiredScope: string;

  constructor(requiredScope: string) {
    super(`Insufficient OAuth scope: ${requiredScope} is required`);
    this.name = 'InsufficientScopeError';
    this.requiredScope = requiredScope;
  }
}

function ownerIdFromExtra(extra: ToolExtra | undefined): string | undefined {
  const sub = extra?.authInfo?.extra?.sub;
  return typeof sub === 'string' ? sub : undefined;
}

function publisherFromExtra(extra: ToolExtra | undefined): PublisherIdentity | undefined {
  const id = ownerIdFromExtra(extra);
  const email = extra?.authInfo?.extra?.email;
  return id !== undefined && typeof email === 'string' ? { id, email } : undefined;
}

function requireScope(extra: ToolExtra | undefined, scope: string): void {
  if (extra?.authInfo !== undefined && !extra.authInfo.scopes.includes(scope)) {
    throw new InsufficientScopeError(scope);
  }
}

const interactiveWriteSchema = z
  .object({
    type: z.literal('interactive'),
    spec: z.array(z.record(z.unknown())),
  })
  .strict();

const documentWriteSchema = z
  .object({
    type: z.literal('document'),
    html: z.string().min(1).max(HTML_MAX_BYTES),
  })
  .strict();

const presentationWriteSchema = htmlPublishDeckBodySchema
  .omit({ update_deck_id: true })
  .extend({
    type: z.literal('presentation'),
    page_id: deckIdSchema.optional(),
  })
  .strict();

const writeInputSchema = z.discriminatedUnion('type', [
  interactiveWriteSchema,
  documentWriteSchema,
  presentationWriteSchema,
]);

const ephemeralPageIdSchema = z.string().regex(/^[a-f0-9]{32}$/, 'invalid page_id');
const readInputSchema = z
  .object({
    page_id: z.union([ephemeralPageIdSchema, deckIdSchema]),
    include: z.enum(['response', 'analytics']).optional(),
  })
  .strict();

const WRITE_DESCRIPTION =
  'Write one Pagent page. Interactive and document pages are temporary. A durable presentation is one complete HTML document, with its own layout and inline JavaScript in an isolated sandbox. No slide schema is required. Presentation pages are revisioned, shareable, and analyzable. Use self-contained assets; network APIs and external assets are blocked. Browser sandbox restrictions are not a general network-isolation guarantee. Return the page URL to the user.';

const READ_DESCRIPTION =
  'Read a page response or durable presentation analytics. The page id selects the sensible default; use include only to be explicit. This call returns immediately and never waits.';

export interface PagentToolRegistrar {
  registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      readonly title?: string;
      readonly description?: string;
      readonly inputSchema?: InputArgs;
      readonly outputSchema?: OutputArgs;
      readonly annotations?: ToolAnnotations;
      readonly _meta?: Record<string, unknown>;
    },
    callback: ToolCallback<InputArgs>,
  ): unknown;
}

export function registerPagentTools(server: PagentToolRegistrar, ops: PageOps): void {
  server.registerTool(
    'write',
    { title: 'Write a page', description: WRITE_DESCRIPTION, inputSchema: writeInputSchema },
    async (input, extra) => {
      requireScope(extra, 'page:create');
      if (input.type === 'interactive') {
        const created = await ops.writeInteractive(input.spec, ownerIdFromExtra(extra));
        return ephemeralWriteResponse('interactive', created);
      }
      if (input.type === 'document') {
        const created = await ops.writeDocument(input.html, ownerIdFromExtra(extra));
        return ephemeralWriteResponse('document', created);
      }
      const publisher = publisherFromExtra(extra);
      const base = {
        title: input.title,
        description: input.description,
        client_label: input.client_label,
        html: input.html,
      };
      const publishInput: PublishDeckBody =
        input.page_id === undefined ? base : { ...base, update_deck_id: input.page_id };
      const written = await ops.writePresentation(publishInput, publisher);
      return {
        content: [
          { type: 'text' as const, text: `Presentation page ready: ${written.preview_url}` },
        ],
        structuredContent: { type: 'presentation', durable: true, ...written },
      };
    },
  );

  server.registerTool(
    'read',
    { title: 'Read a page', description: READ_DESCRIPTION, inputSchema: readInputSchema },
    async ({ page_id, include }, extra) => {
      requireScope(extra, 'page:read');
      const presentation = deckIdSchema.safeParse(page_id).success;
      const selected = include ?? (presentation ? 'analytics' : 'response');
      if (selected === 'analytics') {
        if (!presentation) throw new TypeError('Analytics are available for presentation pages');
        const readerId = ownerIdFromExtra(extra);
        const analytics = await ops.readAnalytics(page_id, readerId);
        return {
          content: [{ type: 'text' as const, text: `Analytics read for page ${page_id}.` }],
          structuredContent: { page_id, type: 'presentation', analytics },
        };
      }
      if (presentation) throw new TypeError('Presentation pages expose analytics, not responses');
      const outcome = await ops.readResponse(page_id);
      if (outcome.kind === 'not_found') {
        throw new Error(`Page ${page_id} was not found or has expired. Write a new page.`);
      }
      const type = outcome.format === 'html' ? 'document' : 'interactive';
      return {
        content: [{ type: 'text' as const, text: responseText(outcome) }],
        structuredContent: { page_id, type, state: outcome.state, response: outcome.result },
      };
    },
  );
}

function ephemeralWriteResponse(type: 'interactive' | 'document', page: EphemeralPageResult) {
  return {
    content: [{ type: 'text' as const, text: `Page ready: ${page.url}` }],
    structuredContent: {
      page_id: page.id,
      type,
      durable: false,
      url: page.url,
      expires_at: page.expires_at,
    },
  };
}

function responseText(
  outcome: Exclude<ResponseReadOutcome, { readonly kind: 'not_found' }>,
): string {
  if (outcome.format === 'html') return 'This document page is view-only and has no response.';
  if (outcome.result === null) return `No response yet (state: ${outcome.state}).`;
  return `Response: ${JSON.stringify(outcome.result)}`;
}
