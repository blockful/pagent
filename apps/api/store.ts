/**
 * Pure page operations shared between the REST handlers and the MCP tools.
 *
 * Both protocol layers go through the same business ops so URL-building,
 * id generation, and TTL config live in one place. Result types are
 * re-exported from `mcp/tools.ts` so the in-process MCP adapter can
 * forward them through `PageOps` without a structural-equivalence dance.
 */
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import type { Page } from './db.ts';
import { metrics } from './metrics.ts';
import type { ShowUiResult, CheckResultOutcome } from './mcp/tools.ts';

export type CreatePageConfig = {
  publicUrl: string;
  pageTtlMs: number;
};

export const newId = (): string => randomBytes(16).toString('hex');

export async function createPage(spec: unknown, cfg: CreatePageConfig): Promise<ShowUiResult> {
  const now = Date.now();
  const page: Page = {
    id: newId(),
    spec,
    state: 'open',
    result: null,
    createdAt: now,
    expiresAt: now + cfg.pageTtlMs,
  };
  await db.insertPage(page);
  metrics.pagesCreated.add(1);
  return {
    id: page.id,
    url: `${cfg.publicUrl}/${page.id}`,
    expires_at: page.expiresAt,
  };
}

export async function advanceResult(id: string): Promise<CheckResultOutcome> {
  const r = await db.fetchAndAdvanceResult(id);
  if (!r) return { kind: 'not_found' };
  return { kind: 'state', state: r.stateAtRead, result: r.result };
}
