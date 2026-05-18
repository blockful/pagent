/**
 * Pure page operations shared between the REST handlers and the MCP tools.
 *
 * Both protocol layers go through the same business ops so URL-building,
 * id generation, and TTL config live in one place. Result types are
 * re-exported from `mcp/tools.ts` so the in-process MCP adapter can
 * forward them through `PageOps` without a structural-equivalence dance.
 */
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import * as db from './db.ts';
import type { Page, PageFormat } from './db.ts';
import { metrics } from './metrics.ts';
import { sanitize } from './sanitize.ts';
import type { ShowUiResult, CheckResultOutcome } from './mcp/tools.ts';

export type CreatePageConfig = {
  publicUrl: string;
  pageTtlMs: number;
  /**
   * UUID of the authenticated user creating the page. When set, the page row
   * is inserted with `owner_id` so the user can list / manage their pages
   * later. Null/undefined during the grace period (REQUIRE_AUTH=false) or
   * for the in-process MCP stdio adapter, which has no auth context.
   */
  ownerId?: string | null;
};

/**
 * Thrown by createHtmlPage when sanitization strips the input to empty.
 * REST and MCP both map this to a clear 400 so the agent knows their payload
 * was malformed (all-forbidden tags, all-event-handlers, etc.) rather than
 * silently storing an empty page.
 */
export class SanitizedEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SanitizedEmptyError';
  }
}

export const newId = (): string => randomBytes(16).toString('hex');

export async function createPage(
  spec: unknown,
  format: PageFormat,
  cfg: CreatePageConfig,
): Promise<ShowUiResult> {
  const now = Date.now();
  const page: Page = {
    id: newId(),
    spec,
    format,
    state: 'open',
    result: null,
    createdAt: now,
    expiresAt: now + cfg.pageTtlMs,
    ownerId: cfg.ownerId ?? null,
  };
  await db.insertPage(page);
  metrics.pagesCreated.add(1, { format });
  return {
    id: page.id,
    url: `${cfg.publicUrl}/${page.id}`,
    expires_at: page.expiresAt,
  };
}

/**
 * Sanitize + log + store an HTML submission. Shared between the REST
 * POST /new path and the in-process MCP `show_html` tool so the sanitize
 * ritual evolves in one place. Throws SanitizedEmptyError if the input was
 * stripped to empty — the caller is responsible for surfacing the 400.
 *
 * The logger is narrowed to `Pick<Logger, 'info'>` so callers can pass a
 * child logger with request-scoped fields baked in (REST) or the module
 * logger (MCP path, which has no request context to attach).
 */
export async function createHtmlPage(
  rawHtml: string,
  cfg: CreatePageConfig,
  log: Pick<Logger, 'info'>,
): Promise<ShowUiResult> {
  const { output, removedTags, removedAttrs } = sanitize(rawHtml);
  log.info(
    { format: 'html', sanitizer_removed_tags: removedTags, sanitizer_removed_attrs: removedAttrs },
    'sanitized html submission',
  );
  if (output.trim() === '') {
    throw new SanitizedEmptyError(
      'All HTML content was stripped by the sanitizer. The submission contained only forbidden tags (e.g., <script>, <iframe>) or all event handlers. Re-author the HTML using inline-only styles and safe markup.',
    );
  }
  return createPage(output, 'html', cfg);
}

export async function advanceResult(id: string): Promise<CheckResultOutcome> {
  const r = await db.fetchAndAdvanceResult(id);
  if (!r) return { kind: 'not_found' };
  return { kind: 'state', state: r.stateAtRead, result: r.result, format: r.format };
}
