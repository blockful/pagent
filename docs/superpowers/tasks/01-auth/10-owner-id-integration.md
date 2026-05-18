# 10 — Page owner_id integration and MCP auth wiring

## Description

Wire authenticated user identity into page creation so pages get an `owner_id` when created by an authenticated user. Update the MCP tools to pass auth info through, and update the stdio MCP server to forward `PAGENT_TOKEN` as a Bearer token.

## Files to create/modify

- `apps/api/store.ts` — modify `createPage()` and `createHtmlPage()` to accept an optional `ownerId?: string` parameter. Pass it through to `db.insertPage()`.
- `apps/api/db.ts` — modify `insertPage()` to include `owner_id` in the INSERT when provided.
- `apps/api/app.ts` — in the `POST /new` handler, extract `c.var.user?.id` and pass it as `ownerId` to `createPage()` / `createHtmlPage()`.
- `apps/api/mcp/tools.ts` — modify the `show_ui` and `show_html` tool handlers to extract `auth.extra.sub` (user ID from the JWT) and pass it as `ownerId` to the store functions.
- `apps/api/mcp/http.ts` — ensure `(req as any).auth` from the Bearer middleware (task 08) is forwarded to the `StreamableHTTPServerTransport` so tool handlers receive it.
- `apps/mcp/src/index.ts` (or equivalent stdio MCP entry) — if `PAGENT_TOKEN` env var is set, include `Authorization: Bearer ${PAGENT_TOKEN}` in HTTP requests to `SERVICE_URL`.
- `apps/api/db.test.ts` — add test: page created with `ownerId` has the correct FK. Page created without `ownerId` has `owner_id = NULL`.
- `apps/api/app.test.ts` — add test: authenticated `POST /new` produces a page with `owner_id`.

## Acceptance criteria

- Pages created by authenticated users (cookie or Bearer) have `owner_id` set to the user's UUID.
- Pages created by unauthenticated users (grace period) have `owner_id = NULL`.
- MCP tool handlers receive auth info and pass `ownerId` through to page creation.
- The stdio MCP server (`apps/mcp`) includes `Authorization: Bearer` header when `PAGENT_TOKEN` is set.
- Existing unauthenticated page creation still works when `REQUIRE_AUTH=false`.
- No behavioral changes to read endpoints (`GET /:id`, `GET /:id/result`).

## Dependencies

- **01** — `owner_id` column on `pages` must exist.
- **08** — auth middleware must be working (both Hono and MCP).

## Relevant spec sections

- Section 2.7 (Changes to pages — owner_id FK)
- Section 6.5 (owner_id injection — store.ts and db changes)
- Section 8 (Migration plan — grace period behavior)
- Section 8.4 (Backward compatibility guarantees)
- Section 9 (Environment variables — PAGENT_TOKEN for stdio MCP)
