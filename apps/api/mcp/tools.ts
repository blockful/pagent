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
import { HTML_MAX_BYTES } from '../limits.ts';

// --- Operations contract -----------------------------------------------------

export type PageState = 'open' | 'submitted' | 'received';

export type PageFormat = 'a2ui' | 'html';

export type ShowUiResult = {
  id: string;
  url: string;
  expires_at: number;
};

// `format` is required on responses from both the in-process API path (which
// knows the format from the DB row) and the stdio adapter (which reads it
// from the REST API's GET /:id/result response).
export type CheckResultOutcome =
  | { kind: 'not_found' }
  | { kind: 'state'; state: PageState; result: unknown; format: PageFormat };

export interface PageOps {
  /**
   * `ownerId` is the authenticated user's UUID, lifted from the MCP request's
   * authInfo (Bearer-authenticated HTTP MCP) or undefined for unauthenticated
   * paths (stdio adapter, REQUIRE_AUTH=false). Adapters pass it through to
   * page creation so the resulting row carries the right owner_id.
   */
  showUi(spec: unknown, ownerId?: string): Promise<ShowUiResult>;
  showHtml(html: string, ownerId?: string): Promise<ShowUiResult>;
  checkResult(page_id: string): Promise<CheckResultOutcome>;
}

/**
 * Extract the user id from the MCP tool handler's `extra.authInfo`. The HTTP
 * MCP path (apps/api/mcp/http.ts) sets `req.auth.extra.sub = claims.sub`
 * after Bearer verification; the SDK forwards that onto tool handlers as
 * `extra.authInfo.extra.sub`. Returns undefined for the stdio adapter (no
 * auth context) or for unauthenticated HTTP MCP calls in grace mode — the
 * adapter then inserts the page with owner_id = NULL.
 */
function ownerIdFromExtra(extra: unknown): string | undefined {
  if (!extra || typeof extra !== 'object') return undefined;
  const authInfo = (extra as { authInfo?: { extra?: Record<string, unknown> } }).authInfo;
  const sub = authInfo?.extra?.sub;
  return typeof sub === 'string' ? sub : undefined;
}

// --- Tool descriptions -------------------------------------------------------
// These are what the model sees when deciding whether to call the tools.
// The polling pattern is baked in here so MCP clients without a separate
// skill (Codex, OpenCode, Cursor, Cline, etc.) still get the guidance.

const SHOW_UI_DESCRIPTION = [
  'Ask the user a question that needs a structured answer back. Forms, pickers, confirmations, multi-step wizards, surveys, dashboards-as-input.',
  'Returns { page_id, url, expires_at }. PRINT the URL so the user can open it. The agent never sees the user typing — only the final submitted result.',
  'Each page is single-shot: one spec, one result. For a follow-up question, call show_ui again with a fresh spec — there is no surface-replace mechanism.',
  'After this call, poll check_result on your own cadence to read the user response (start at 2-3s, back off exponentially up to ~30s; do other useful work between polls rather than blocking).',
  'If you only want to SHOW something — a report, a chart, an infographic — use show_html instead. show_ui is for input.',
].join('\n\n');

const SHOW_UI_INPUT_DESCRIPTION = [
  'A2UI v0.9 spec — an array of A2UI messages.',
  'Start with one createSurface, then updateComponents with a tree whose root component MUST have id "root".',
  'The basic catalog (https://a2ui.org/specification/v0_9/basic_catalog.json) provides Column, Row, Card, Text, TextField, Button, Checkbox, Image, Divider, List, Tabs, Slider.',
  'Buttons fire actions via { action: { event: { name, context } } }; bind input fields with { value: { path: "/key" } } and reference those paths in the button context so user input flows back.',
  'Keep specs small — one screen, one purpose.',
].join(' ');

const SHOW_HTML_DESCRIPTION = [
  'Show the user a rich visualization: a styled report, dashboard, chart, infographic, comparison table, slide, or other view-only artifact.',
  'Returns { page_id, url, expires_at }. PRINT the URL so the user can open it. The page is one-way — the user looks at it; nothing comes back.',
  'Do NOT poll check_result for HTML pages; they never produce a result. If you need a follow-up decision, call show_ui after with a fresh spec.',
  'Constraints (enforced — violations are stripped or rejected):',
  'No JavaScript: no <script> tags, no on*= event handlers, no javascript: URLs. JavaScript does not run.',
  'No external assets: inline all CSS as <style>, embed images as data:image/...;base64,... URIs. No Google Fonts, no CDN libraries, no remote <img src=https:>.',
  'No forms, iframes, or meta refresh: <form> submissions (use show_ui for input), <iframe>, and <meta http-equiv=refresh> are stripped.',
  '1 MB payload cap.',
].join('\n\n');

const SHOW_HTML_INPUT_DESCRIPTION = [
  'A single UTF-8 HTML string. May be a fragment or a full document; the renderer wraps it in a sandboxed scaffold either way.',
  'Inline all CSS as <style>; embed all images as data: URIs. No external assets — they will not load.',
  'Up to 1,000,000 bytes (1 MB).',
].join(' ');

const CHECK_RESULT_DESCRIPTION = [
  'Fetch the current state of a page created by show_ui. Fire-and-return — does NOT block or wait.',
  'Returns { state, result, format, page_id } where state is "open" | "submitted" | "received" and format is "a2ui" | "html".',
  'When state is "open", the user has not responded yet — wait a few seconds and call again. When "submitted", result is the user input as an A2UI client-action: { name, surfaceId, sourceComponentId, context, timestamp }. When "received", you already read the result on a prior poll (treat as duplicate).',
  'If format is "html", the page is view-only — stop polling; HTML pages never produce a result.',
  'If the page expired (Page not found), do NOT retry the same page_id — ask the user in chat whether to start over, then call show_ui (or show_html) with a fresh spec.',
].join('\n\n');

// --- Registration ------------------------------------------------------------

export function registerPagentTools(server: McpServer, ops: PageOps): void {
  server.registerTool(
    'show_ui',
    {
      title: 'Show UI to the user',
      description: SHOW_UI_DESCRIPTION,
      inputSchema: {
        spec: z.array(z.record(z.unknown())).describe(SHOW_UI_INPUT_DESCRIPTION),
      },
    },
    async ({ spec }, extra) => {
      const created = await ops.showUi(spec, ownerIdFromExtra(extra));
      return {
        content: [
          {
            type: 'text',
            text: `UI ready. Share this URL with the user:\n${created.url}\n\npage_id: ${created.id}\nexpires_at: ${created.expires_at}`,
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
    'show_html',
    {
      title: 'Show HTML visualization to the user',
      description: SHOW_HTML_DESCRIPTION,
      inputSchema: {
        html: z.string().min(1).max(HTML_MAX_BYTES).describe(SHOW_HTML_INPUT_DESCRIPTION),
      },
    },
    async ({ html }, extra) => {
      const created = await ops.showHtml(html, ownerIdFromExtra(extra));
      return {
        content: [
          {
            type: 'text',
            text: `View ready. Share this URL with the user:\n${created.url}\n\npage_id: ${created.id}\nexpires_at: ${created.expires_at}\n\nView-only — do not poll check_result for this page.`,
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
          `Page ${page_id} not found (expired or deleted). Don't retry the same page_id — ask the user whether to start over, then call show_ui (or show_html) with a fresh spec.`,
        );
      }
      let text: string;
      if (outcome.format === 'html') {
        text = `Page ${page_id} is an HTML view (format: html). It does not produce a result — stop polling. If you need a follow-up decision, call show_ui with a fresh spec.`;
      } else if (outcome.result == null) {
        text = `User has not responded yet (state: ${outcome.state}). Call check_result again in a few seconds.`;
      } else {
        text = `User submitted: ${JSON.stringify(outcome.result)}`;
      }
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          state: outcome.state,
          result: outcome.result,
          format: outcome.format,
          page_id,
        },
      };
    },
  );
}
