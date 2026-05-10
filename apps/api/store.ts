/**
 * Pure page operations shared between the REST handlers and the MCP tools.
 *
 * Both protocol layers go through the same business ops so URL-building,
 * id generation, and TTL config live in one place.
 */
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import type { Page, PageState } from './db.ts';

export type CreatePageConfig = {
  publicUrl: string;
  pageTtlMs: number;
};

export type ShowUiResult = {
  id: string;
  url: string;
  expires_at: number;
};

export type AdvanceResultOutcome =
  | { kind: 'not_found' }
  | { kind: 'state'; state: PageState; result: unknown };

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
  return {
    id: page.id,
    url: `${cfg.publicUrl}/${page.id}`,
    expires_at: page.expiresAt,
  };
}

export async function advanceResult(id: string): Promise<AdvanceResultOutcome> {
  const r = await db.fetchAndAdvanceResult(id);
  if (!r) return { kind: 'not_found' };
  return { kind: 'state', state: r.stateAtRead, result: r.result };
}
