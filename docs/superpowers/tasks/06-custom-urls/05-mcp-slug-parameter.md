# 05 — MCP tool slug parameter (show_ui, show_html, stdio adapter)

## Description

Add the optional `slug` parameter to the `show_ui` and `show_html` MCP tool input schemas, update the `PageOps` interface, forward slug through both the in-process HTTP MCP adapter and the stdio REST adapter, and clarify the `check_result` description.

## Files to create/modify

- `apps/api/mcp/tools.ts` — add `slug: slugSchema.optional()` to both `show_ui` and `show_html` `inputSchema`; update `PageOps` interface signatures to `showUi(spec: unknown, slug?: string)` and `showHtml(html: string, slug?: string)`; update `SHOW_UI_DESCRIPTION` with slug guidance; update `check_result` description to clarify page_id must be hex
- `apps/api/mcp/http.ts` — update `buildInProcessOps()` to forward the `slug` argument from tool handlers through to `store.createPage()` / `store.createHtmlPage()`
- `apps/mcp/server.ts` — update `restOps.showUi()` and `restOps.showHtml()` to accept `slug` parameter and include `...(slug && { slug })` in the `POST /new` request body
- `apps/api/mcp/tools.test.ts` — add tests: show_ui with slug forwards it; show_ui without slug omits it; show_html with slug forwards it
- `apps/mcp/server.test.ts` — add tests: restOps.showUi sends slug in body; restOps.showHtml sends slug in body

## Acceptance criteria

- `show_ui({ spec: [...], slug: "my-form" })` creates a page with the slug and returns custom URL
- `show_ui({ spec: [...] })` (no slug) works exactly as before
- `show_html` has the same optional slug behavior
- `PageOps` interface updated with `slug?: string` on both methods
- Stdio adapter forwards slug to `POST /new` when present
- In-process HTTP adapter forwards slug to store when present
- `check_result` tool description notes that `page_id` must be the hex ID, not a slug
- `SHOW_UI_DESCRIPTION` mentions slugs and custom URLs
- All new behavior has unit tests

## Dependencies

- 01 (schemas -- `slugSchema`)
- 03 (store -- `createPage` accepts slug)

## Relevant spec sections

- 4.2 MCP tool changes (show_ui)
- 7.1 `show_ui` -- slug parameter
- 7.2 `show_html` -- same slug parameter
- 7.3 Updated tool description
- 7.4 `check_result` -- page_id format update
- 7.5 Response URL format
- 7.6 PageOps interface update
- 7.7 Stdio MCP adapter
