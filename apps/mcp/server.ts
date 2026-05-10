#!/usr/bin/env -S node --experimental-strip-types
/**
 * Stdio MCP server for pagent.
 *
 * Tool definitions live in apps/api/mcp/tools.ts so the stdio transport and
 * the in-process HTTP MCP share descriptions, schemas, and handler logic.
 * The only stdio-specific concern is talking to the REST API over HTTP.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerPagentTools, type PageOps } from '../api/mcp/tools.ts';

// Empty strings (set by some shells / launchers when a var is "unset") need
// to be normalised to undefined before .url().optional() runs.
const envSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v === '' ? undefined : v;
    }
    return out;
  },
  z.object({
    PAGENT_URL: z.string().url('PAGENT_URL must be a valid URL').optional(),
  }),
);

let env: z.infer<typeof envSchema>;
try {
  env = envSchema.parse(process.env);
} catch (e) {
  console.error('Invalid environment for pagent MCP:', e);
  process.exit(1);
}

const SERVICE_URL = (env.PAGENT_URL ?? 'https://pagent.up.railway.app').replace(/\/$/, '');

/**
 * Build a short, actionable hint from a structured API error body.
 * Rate-limit hint takes precedence over size hint (more urgent signal).
 */
export function formatRetryHint(body: {
  retry_after_seconds?: number;
  max_bytes?: number;
}): string {
  if (typeof body.retry_after_seconds === 'number') {
    return `Retry after ${body.retry_after_seconds}s`;
  }
  if (typeof body.max_bytes === 'number') {
    return `Reduce body to ≤${body.max_bytes} bytes`;
  }
  return '';
}

type ApiErrorBody = {
  message?: string;
  retry_after_seconds?: number;
  max_bytes?: number;
};

async function readError(res: Response, fallbackVerb: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
  const hint = formatRetryHint(body);
  const message = body?.message ?? `HTTP ${res.status}`;
  return new Error(`${fallbackVerb} failed (${res.status}): ${message}${hint ? `. ${hint}` : ''}`);
}

const restOps: PageOps = {
  async showUi(spec) {
    const res = await fetch(`${SERVICE_URL}/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
    if (!res.ok) throw await readError(res, 'show_ui');
    return (await res.json()) as { id: string; url: string; expires_at: number };
  },
  async checkResult(page_id) {
    const res = await fetch(`${SERVICE_URL}/${page_id}/result`, {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) throw await readError(res, 'check_result');
    const body = (await res.json()) as {
      state: 'open' | 'submitted' | 'received';
      result: unknown | null;
    };
    return { kind: 'state', state: body.state, result: body.result };
  },
};

const server = new McpServer({ name: 'pagent', version: '0.0.1' });
registerPagentTools(server, restOps);

// Boot guard — only start the stdio transport when run directly, so tests
// (and any future tooling that imports this module) don't spawn a transport.
if (import.meta.url === new URL(process.argv[1], import.meta.url).href) {
  await server.connect(new StdioServerTransport());
}
