#!/usr/bin/env -S node --experimental-strip-types
/**
 * MCP server for pagent.
 * Exposes two tools: show_ui (creates a page in one shot) and
 * check_result (fetches the page's current state + result, fire-and-return).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE_URL = (process.env.PAGENT_URL ?? 'https://pagent.up.railway.app').replace(/\/$/, '');

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

const server = new McpServer({
  name: 'pagent',
  version: '0.0.1',
});

server.registerTool(
  'show_ui',
  {
    title: 'Show UI to the user',
    description:
      'Create a new UI page from a spec. ' +
      'Returns { page_id, url, expires_at } — print the URL so the user can open it. ' +
      'After this, poll check_result on your own cadence to read the user submission.',
    inputSchema: {
      spec: z
        .any()
        .describe(
          'The UI surface spec (A2UI v0.9). An array of A2UI v0.9 messages (createSurface / updateComponents / updateDataModel / deleteSurface). The root component MUST have id "root".',
        ),
    },
  },
  async ({ spec }) => {
    const res = await fetch(`${SERVICE_URL}/v1/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        retry_after_seconds?: number;
        max_bytes?: number;
      };
      const hint = formatRetryHint(body);
      const message = body?.message ?? `HTTP ${res.status}`;
      throw new Error(`show_ui failed (${res.status}): ${message}${hint ? `. ${hint}` : ''}`);
    }
    const created = (await res.json()) as { id: string; url: string; expires_at: number };

    return {
      content: [
        {
          type: 'text',
          text: `UI ready. Share this URL with the user:\n${created.url}\n\npage_id: ${created.id}`,
        },
      ],
      structuredContent: {
        page_id: created.id,
        url: created.url,
        expires_at: created.expires_at,
      },
    };
  },
);

server.registerTool(
  'check_result',
  {
    title: 'Check whether the user has submitted yet',
    description:
      'Fetch the current state of a page. Fire-and-return — does NOT block or wait. ' +
      'Returns { state, result, page_id } where state is "open" | "submitted" | "received" ' +
      'and result is null until the user submits. The agent decides its own polling cadence.',
    inputSchema: {
      page_id: z.string().describe('The page_id returned by show_ui.'),
    },
  },
  async ({ page_id }) => {
    const res = await fetch(`${SERVICE_URL}/v1/${page_id}/result`, {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      const message = body?.message ?? 'Page not found (expired or deleted)';
      throw new Error(`check_result failed (404): ${message}`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        retry_after_seconds?: number;
        max_bytes?: number;
      };
      const hint = formatRetryHint(body);
      const message = body?.message ?? `HTTP ${res.status}`;
      throw new Error(`check_result failed (${res.status}): ${message}${hint ? `. ${hint}` : ''}`);
    }
    const body = (await res.json()) as {
      state: 'open' | 'submitted' | 'received';
      result: unknown | null;
    };

    const text =
      body.result == null
        ? `User has not responded yet (state: ${body.state}). Call check_result again in a few seconds.`
        : `User submitted: ${JSON.stringify(body.result)}`;

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        state: body.state,
        result: body.result,
        page_id,
      },
    };
  },
);

// Boot guard — only start the stdio transport when run directly (not imported
// by tests or other modules). Mirrors the pattern in apps/api/server.ts.
if (import.meta.url === new URL(process.argv[1], import.meta.url).href) {
  await server.connect(new StdioServerTransport());
}
