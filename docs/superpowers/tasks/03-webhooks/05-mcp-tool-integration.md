# 05 -- MCP tool integration (show_ui and show_html)

## Description

Add `webhook_url` and `webhook_secret` parameters to the `show_ui` and
`show_html` MCP tools, and update both transport adapters (in-process
HTTP and stdio REST) to pass them through. After this task, agents can
set webhooks via MCP tool calls.

## Files to create/modify

- `apps/api/mcp/tools.ts` -- modify
- `apps/api/mcp/http.ts` -- modify
- `apps/mcp/server.ts` -- modify
- `apps/api/mcp/tools.test.ts` -- modify
- `apps/api/mcp/http.test.ts` -- modify (if it tests tool params)
- `apps/mcp/server.test.ts` -- modify (if it tests tool params)

## Changes

### `apps/api/mcp/tools.ts`

1. **`PageOps` interface** -- update `showUi` and `showHtml` signatures
   to accept an optional opts object:
   ```ts
   showUi(spec: unknown, opts?: {
     webhook_url?: string;
     webhook_secret?: string;
   }): Promise<ShowUiResult>;
   showHtml(html: string, opts?: {
     webhook_url?: string;
     webhook_secret?: string;
   }): Promise<ShowUiResult>;
   ```

2. **`registerPagentTools`** -- add `webhook_url` and `webhook_secret`
   to the `inputSchema` for both `show_ui` and `show_html`:
   ```ts
   webhook_url: z.string().url().optional().describe(
     'Optional HTTPS callback URL. When set, Pagent POSTs the submission '
     + 'payload to this URL as soon as the user submits. The agent can '
     + 'still poll check_result -- webhooks are additive, not a replacement.'
   ),
   webhook_secret: z.string().min(16).max(256).optional().describe(
     'Optional shared secret for HMAC-SHA256 webhook signing. When set, '
     + 'every delivery carries an X-Pagent-Signature header: '
     + '"sha256=<hex-hmac>". The receiver MUST verify this signature to '
     + 'authenticate the payload. Minimum 16 characters.'
   ),
   ```

3. **Tool handlers** -- extract `webhook_url` and `webhook_secret` from
   the parsed input and pass to `ops.showUi(spec, { webhook_url, webhook_secret })`
   and `ops.showHtml(html, { webhook_url, webhook_secret })`.

### `apps/api/mcp/http.ts`

Update the in-process `PageOps` implementation to pass webhook opts
through to `store.createPage()` / `store.createHtmlPage()`.

### `apps/mcp/server.ts`

Update the stdio `restOps` `PageOps` implementation to include
`webhook_url` and `webhook_secret` in the `POST /new` request body.

### `apps/api/mcp/tools.test.ts`

Add MCP tool tests (2 tests per spec section 9):

1. `show_ui` passes `webhook_url` and `webhook_secret` to `ops.showUi` --
   assert the ops mock receives both fields.
2. `show_ui` without webhook fields still works -- assert opts are
   undefined or empty.

### `apps/mcp/server.test.ts`

If test coverage exists for the stdio adapter, add a test that the
`POST /new` fetch body includes webhook fields when provided.

## Acceptance criteria

- [ ] `show_ui` MCP tool accepts optional `webhook_url` (URL) and
      `webhook_secret` (16-256 chars).
- [ ] `show_html` MCP tool accepts the same two optional parameters.
- [ ] `PageOps.showUi` and `PageOps.showHtml` signatures accept an
      opts object with `webhook_url` and `webhook_secret`.
- [ ] In-process HTTP adapter passes webhook opts to `store.createPage`.
- [ ] Stdio REST adapter includes webhook fields in `POST /new` body.
- [ ] `check_result` tool is unchanged.
- [ ] Existing MCP tool calls without webhook fields remain green.
- [ ] New MCP tool tests pass.

## Dependencies

- **04** (API handler integration) -- `store.createPage` must accept
  webhook opts before this task can pass them through.

## Relevant spec sections

- Section 3: MCP tool parameter changes (show_ui, show_html, PageOps)
- Section 9: Testing strategy (MCP tool tests)
- Section 13: Rollout (commit 2 -- MCP tool integration)
