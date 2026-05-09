#!/usr/bin/env -S node --experimental-strip-types
/**
 * MCP server for agent-ui-session.
 * Exposes two tools: show_ui (creates a session + sets surface) and
 * wait_for_event (long-polls for the next user_action).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE_URL = (process.env.AGENT_UI_SESSION_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const DEFAULT_FORMAT = 'a2ui-v0.9';

// Track last cursor per session so successive wait_for_event calls advance.
const cursors = new Map<string, number>();

const server = new McpServer({
  name: 'agent-ui-session',
  version: '0.0.1',
});

server.registerTool(
  'show_ui',
  {
    title: 'Show UI to the user',
    description:
      'Create a new UI session and publish a surface to it. ' +
      'Returns { session_id, url } — print the URL so the user can open it. ' +
      'After this, call wait_for_event to receive user input.',
    inputSchema: {
      spec: z
        .any()
        .describe(
          'The UI surface spec. For format "a2ui-v0.9" this is an array of A2UI v0.9 messages (createSurface / updateComponents / updateDataModel / deleteSurface). The root component MUST have id "root".',
        ),
      format: z
        .string()
        .optional()
        .describe(`Surface format tag. Defaults to "${DEFAULT_FORMAT}".`),
    },
  },
  async ({ spec, format }) => {
    const fmt = format ?? DEFAULT_FORMAT;
    const createRes = await fetch(`${SERVICE_URL}/sessions`, { method: 'POST' });
    if (!createRes.ok) {
      throw new Error(`Failed to create session: ${createRes.status} ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as { id: string; url: string; ttl_ms: number };

    const putRes = await fetch(`${SERVICE_URL}/sessions/${created.id}/surface`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: fmt, spec }),
    });
    if (!putRes.ok) {
      throw new Error(`Failed to set surface: ${putRes.status} ${await putRes.text()}`);
    }

    cursors.set(created.id, 0);

    return {
      content: [
        {
          type: 'text',
          text: `UI ready. Share this URL with the user:\n${created.url}\n\nsession_id: ${created.id}`,
        },
      ],
      structuredContent: {
        session_id: created.id,
        url: created.url,
        ttl_ms: created.ttl_ms,
      },
    };
  },
);

server.registerTool(
  'wait_for_event',
  {
    title: 'Wait for the next user event',
    description:
      'Long-poll for the next user interaction (form submit, button click) on a session. ' +
      'Returns the event when it arrives, or null on timeout (then call again). ' +
      'Default timeout is 25 seconds — well under most MCP host limits.',
    inputSchema: {
      session_id: z.string().describe('The session_id returned by show_ui.'),
      timeout_s: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe('How long to wait, in seconds (default 25, max 60).'),
    },
  },
  async ({ session_id, timeout_s }) => {
    const since = cursors.get(session_id) ?? 0;
    const timeoutMs = (timeout_s ?? 25) * 1000;

    const url = new URL(`${SERVICE_URL}/sessions/${session_id}/events`);
    url.searchParams.set('since', String(since));
    url.searchParams.set('type', 'user_action');
    url.searchParams.set('timeout_ms', String(timeoutMs));

    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) {
      cursors.delete(session_id);
      throw new Error(`Session ${session_id} not found (expired or deleted).`);
    }
    if (!res.ok) {
      throw new Error(`wait_for_event failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      events: Array<{ id: number; type: string; action?: unknown; ts: number }>;
      cursor: number;
    };

    cursors.set(session_id, body.cursor);

    if (body.events.length === 0) {
      return {
        content: [{ type: 'text', text: 'No event yet (timeout). Call wait_for_event again to keep waiting.' }],
        structuredContent: { event: null, cursor: body.cursor },
      };
    }

    const ev = body.events[0];
    return {
      content: [
        { type: 'text', text: `Event received: ${JSON.stringify(ev.action)}` },
      ],
      structuredContent: { event: ev, cursor: body.cursor },
    };
  },
);

await server.connect(new StdioServerTransport());
