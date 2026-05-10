/**
 * Shared MCP tool definitions for pagent.
 *
 * Both the in-process HTTP MCP (apps/api/mcp/http.ts) and the stdio MCP
 * (apps/mcp/server.ts) call registerPagentTools. Tool descriptions —
 * which the model uses to decide whether to invoke the tools — live here
 * so they stay in sync across transports. Adapters differ only in how
 * they fulfill the page operations: the API speaks Postgres directly,
 * the stdio server speaks to the REST API.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// --- Operations contract -----------------------------------------------------

export type PageState = 'open' | 'submitted' | 'received';

export type ShowUiResult = {
  id: string;
  url: string;
  expires_at: number;
};

export type CheckResultOutcome =
  | { kind: 'not_found' }
  | { kind: 'state'; state: PageState; result: unknown };

export interface PageOps {
  showUi(spec: unknown): Promise<ShowUiResult>;
  checkResult(page_id: string): Promise<CheckResultOutcome>;
}

// --- Tool descriptions -------------------------------------------------------
// These are what the model sees when deciding whether to call the tools.
// The polling pattern is baked in here so MCP clients without a separate
// skill (Codex, OpenCode, Cursor, Cline, etc.) still get the guidance.

const SHOW_UI_DESCRIPTION = [
  "Render an interactive UI in the user's browser — forms, pickers, dashboards, confirmations, multi-step wizards, surveys.",
  'Returns { page_id, url, expires_at }. PRINT the URL so the user can open it. The agent never sees the user typing — only the final submitted result.',
  'Each page is single-shot: one spec, one result. For a follow-up question, call show_ui again with a fresh spec — there is no surface-replace mechanism.',
  'After this call, poll check_result on your own cadence to read the user response (start at 2-3s, back off exponentially up to ~30s; do other useful work between polls rather than blocking).',
].join('\n\n');

const SHOW_UI_INPUT_DESCRIPTION = [
  'A2UI v0.9 spec — an array of A2UI messages.',
  'Start with one createSurface, then updateComponents with a tree whose root component MUST have id "root".',
  'The basic catalog (https://a2ui.org/specification/v0_9/basic_catalog.json) provides Column, Row, Card, Text, TextField, Button, Checkbox, Image, Divider, List, Tabs, Slider.',
  'Buttons fire actions via { action: { event: { name, context } } }; bind input fields with { value: { path: "/key" } } and reference those paths in the button context so user input flows back.',
  'Keep specs small — one screen, one purpose.',
].join(' ');

const CHECK_RESULT_DESCRIPTION = [
  'Fetch the current state of a page created by show_ui. Fire-and-return — does NOT block or wait.',
  'Returns { state, result, page_id } where state is "open" | "submitted" | "received".',
  'When state is "open", the user has not responded yet — wait a few seconds and call again. When "submitted", result is the user input as an A2UI client-action: { name, surfaceId, sourceComponentId, context, timestamp }. When "received", you already read the result on a prior poll (treat as duplicate).',
  'If the page expired (Page not found), do NOT retry the same page_id — ask the user in chat whether to start over, then call show_ui with a fresh spec.',
].join('\n\n');

// --- Registration ------------------------------------------------------------

export function registerPagentTools(server: McpServer, ops: PageOps): void {
  server.registerTool(
    'show_ui',
    {
      title: 'Show UI to the user',
      description: SHOW_UI_DESCRIPTION,
      inputSchema: {
        spec: z.any().describe(SHOW_UI_INPUT_DESCRIPTION),
      },
    },
    async ({ spec }) => {
      const created = await ops.showUi(spec);
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
      description: CHECK_RESULT_DESCRIPTION,
      inputSchema: {
        page_id: z
          .string()
          .regex(/^[a-f0-9]{32}$/, 'invalid page_id')
          .describe('The page_id returned by show_ui.'),
      },
    },
    async ({ page_id }) => {
      const outcome = await ops.checkResult(page_id);
      if (outcome.kind === 'not_found') {
        throw new Error(
          `Page ${page_id} not found (expired or deleted). Don't retry the same page_id — ask the user whether to start over, then call show_ui with a fresh spec.`,
        );
      }
      const text =
        outcome.result == null
          ? `User has not responded yet (state: ${outcome.state}). Call check_result again in a few seconds.`
          : `User submitted: ${JSON.stringify(outcome.result)}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          state: outcome.state,
          result: outcome.result,
          page_id,
        },
      };
    },
  );
}
