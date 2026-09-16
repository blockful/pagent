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
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { registerPagentTools, type PageOps } from '../api/mcp/tools.ts';
import { formatRetryHint } from './lib.ts';

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
    // Bearer token for authenticated REST calls. The stdio transport has no
    // auth context of its own — the agent that spawns this process exports
    // PAGENT_TOKEN, we attach it to every outbound HTTP request, and the API
    // populates owner_id from the JWT's `sub` claim. Optional so the grace
    // period (REQUIRE_AUTH=false) keeps working without any env changes.
    PAGENT_TOKEN: z.string().optional(),
  }),
);

let env: z.infer<typeof envSchema>;
try {
  env = envSchema.parse(process.env);
} catch (e) {
  console.error('Invalid environment for pagent MCP:', e);
  process.exit(1);
}

// Read once at startup; fine for a short-lived stdio process.
const SERVICE_URL = (env.PAGENT_URL ?? 'https://api.pagent.link').replace(/\/$/, '');
const PAGENT_TOKEN = env.PAGENT_TOKEN;

/**
 * Returns the auth headers for every outbound REST call. Empty object when
 * PAGENT_TOKEN is unset (grace period); a Bearer header otherwise. Computed
 * once at startup and reused — the token doesn't rotate within a single
 * stdio process lifetime.
 */
function authHeaders(): Record<string, string> {
  return PAGENT_TOKEN ? { Authorization: `Bearer ${PAGENT_TOKEN}` } : {};
}

const apiErrorBodySchema = z.object({
  message: z.string().optional(),
  retry_after_seconds: z.number().optional(),
  max_bytes: z.number().optional(),
});

const presentationResultSchema = z.object({
  deckId: z.string().uuid(),
  revisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
});

const ephemeralResultSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  expires_at: z.number(),
});

const responseResultSchema = z.object({
  state: z.enum(['open', 'submitted', 'received']),
  result: z.unknown(),
  format: z.enum(['a2ui', 'html']),
});

const analyticsResultSchema = z.record(z.unknown());

async function readError(res: Response, fallbackVerb: string): Promise<Error> {
  const body = apiErrorBodySchema.catch({}).parse(await res.json().catch(() => ({})));
  const hint = formatRetryHint(body);
  const message = body.message ?? `HTTP ${res.status}`;
  return new Error(`${fallbackVerb} failed (${res.status}): ${message}${hint ? `. ${hint}` : ''}`);
}

// The PageOps `ownerId` parameter is intentionally ignored on the stdio path.
// Stdio has no authInfo to extract from — the agent's identity flows via
// PAGENT_TOKEN (Bearer) on every REST call, and the API's middleware turns
// the JWT `sub` claim into the page's owner_id server-side. Forwarding the
// header is therefore enough; we don't need to plumb a second copy through
// the request body.
const restOps: PageOps = {
  async writePresentation(input) {
    if (PAGENT_TOKEN === undefined) throw new Error('Authentication required for durable pages');
    const res = await fetch(`${SERVICE_URL}/v1/decks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw await readError(res, 'write');
    const published = presentationResultSchema.parse(await res.json());
    const rendererBase = SERVICE_URL.replace(/^https:\/\/api\./, 'https://').replace(
      /^http:\/\/api\./,
      'http://',
    );
    return {
      page_id: published.deckId,
      revision_id: published.revisionId,
      revision_number: published.revisionNumber,
      manage_url: `${rendererBase}/pages/${published.deckId}`,
      preview_url: `${rendererBase}/pages/${published.deckId}#preview`,
    };
  },
  async writeInteractive(spec, _ownerId) {
    const res = await fetch(`${SERVICE_URL}/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ spec }),
    });
    if (!res.ok) throw await readError(res, 'write');
    return ephemeralResultSchema.parse(await res.json());
  },
  async writeDocument(html, _ownerId) {
    const res = await fetch(`${SERVICE_URL}/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ format: 'html', spec: html }),
    });
    if (!res.ok) throw await readError(res, 'write');
    return ephemeralResultSchema.parse(await res.json());
  },
  async readResponse(pageId) {
    const res = await fetch(`${SERVICE_URL}/${pageId}/result`, {
      headers: { accept: 'application/json', ...authHeaders() },
    });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) throw await readError(res, 'read');
    const body = responseResultSchema.parse(await res.json());
    return { kind: 'state', state: body.state, result: body.result, format: body.format };
  },
  async readAnalytics(pageId) {
    if (PAGENT_TOKEN === undefined) throw new Error('Authentication required for analytics');
    const res = await fetch(`${SERVICE_URL}/v1/decks/${pageId}/analytics`, {
      headers: { accept: 'application/json', ...authHeaders() },
    });
    if (!res.ok) throw await readError(res, 'read');
    return analyticsResultSchema.parse(await res.json());
  },
};

const server = new McpServer({ name: 'pagent', version: '0.1.0' });
registerPagentTools(server, restOps);

// Boot guard — only start the stdio transport when run directly, so tests
// (and any future tooling that imports this module) don't spawn a transport.
// pathToFileURL handles both POSIX and Windows path separators correctly.
if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  await server.connect(new StdioServerTransport());
}
