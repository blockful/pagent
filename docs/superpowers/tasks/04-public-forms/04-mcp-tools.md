# 04 — MCP tools: show_ui mode/access_emails params and check_result public response

## Description

Extend the MCP `show_ui` tool with `mode` and `access_emails` parameters. Update `check_result` to return paginated submissions for public pages and accept `cursor`/`limit` params. Update the `PageOps` interface and `CheckResultOutcome` type. Update both the in-process HTTP MCP adapter and the stdio MCP server.

## Files to create/modify

- `apps/api/mcp/tools.ts` — add `mode` and `access_emails` to the `show_ui` input schema with `.describe()` strings from the spec. Add `cursor` and `limit` to the `check_result` input schema. Update `SHOW_UI_DESCRIPTION` and `CHECK_RESULT_DESCRIPTION` with public-mode guidance. Extend `CheckResultOutcome` to include the public-mode variant with `submissions`, `total`, `cursor`. Extend `PageOps.showUi()` signature to accept `{ mode?, accessEmails? }`. Extend `PageOps.checkResult()` to accept `{ limit?, cursor? }`. Update the `check_result` handler to format public-mode responses (submissions array as text + structuredContent).
- `apps/api/mcp/http.ts` — update the in-process `PageOps` implementation to pass `mode`, `accessEmails`, `ownerId` through to `store.createPage()` and to pass `limit`, `cursor` through `store.advanceResult()`.
- `apps/mcp/server.ts` — update the stdio `restOps` implementation: pass `mode` and `access_emails` in the `POST /new` body, pass `cursor` and `limit` as query params on `GET /:id/result`.
- `apps/api/mcp/tools.test.ts` — add tests for: `show_ui` with `mode: "public"`, `check_result` returning submissions array, `check_result` with cursor pagination.
- `apps/mcp/server.test.ts` — add tests for the stdio adapter passing mode and pagination params.

## Acceptance criteria

- `show_ui({ spec, mode: "public" })` creates a public page.
- `show_ui({ spec, mode: "public", access_emails: ["a@b.com"] })` creates a restricted public page.
- `show_ui({ spec })` (no mode) defaults to `"single"` — backward compatible.
- `check_result(page_id)` for a public page returns `{ state, mode: "public", format, page_id, submissions: [...], total, cursor }` as structuredContent, with a human-readable text summary.
- `check_result(page_id, { cursor, limit })` paginates submissions.
- `check_result(page_id)` for a single page returns the existing shape (backward compatible).
- `SHOW_UI_DESCRIPTION` mentions public mode, closing, and polling behavior.
- `CHECK_RESULT_DESCRIPTION` documents both single and public response shapes.
- `PageOps` interface signature updated: `showUi(spec, opts?)`, `checkResult(page_id, opts?)`.
- Stdio adapter sends `mode`/`access_emails` in POST body and `cursor`/`limit` as query params.

## Dependencies

- 01-schema-migration
- 02-db-functions
- 03-api-endpoints

## Relevant spec sections

- MCP tool changes > `show_ui` — new parameters
- MCP tool changes > `check_result` — response shape change
- MCP tool changes > `PageOps` interface — extended
- MCP tool changes > `CheckResultOutcome` — extended
- Pagination > Agent polling pattern
