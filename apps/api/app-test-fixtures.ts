import { z } from 'zod';

export const UNKNOWN_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';
export const BAD_ID = 'not-hex';
export const BASE = 'http://localhost';

export function req(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function json(res: Response) {
  return z.record(z.string(), z.unknown()).parse(await res.json());
}

export const openApiDocumentSchema = z.object({
  openapi: z.string(),
  info: z.object({ title: z.string() }),
  paths: z.record(z.string(), z.unknown()),
});

/** Build a fake active page object (matches the Page type from db.ts). */
export function fakePage(
  overrides: Partial<{
    id: string;
    spec: unknown;
    format: 'a2ui' | 'html';
    state: 'open' | 'submitted' | 'received';
    result: unknown;
  }> = {},
) {
  return {
    id: overrides.id ?? 'aabbccddeeff00112233445566778899',
    spec: overrides.spec ?? { anything: 1 },
    format: overrides.format ?? ('a2ui' as const),
    state: overrides.state ?? 'open',
    result: overrides.result ?? null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}
