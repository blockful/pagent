# 10 — Page `owner_id` integration and MCP auth wiring

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## As-built implementation

- `apps/api/store.ts` accepts an optional `ownerId` in page-creation options.
  `apps/api/db/pages.ts` persists it as the nullable `pages.owner_id` field.
- `apps/api/app/page-routes.ts` reads the identity resolved by Hono middleware
  and passes that user ID to A2UI and HTML page creation. During the grace
  period, anonymous creation stores `owner_id = NULL`.
- `apps/api/mcp/tools.ts` reads the verified SDK `authInfo.extra.sub` and
  forwards it to the in-process page operations. `apps/api/mcp/http.ts`
  supplies that `AuthInfo` on the typed `req.auth` request property before the
  Streamable HTTP transport handles the request.
- `apps/mcp/server.ts` adds `Authorization: Bearer ${PAGENT_TOKEN}` to its
  REST calls when configured. The API derives ownership from that verified
  token; the stdio adapter does not trust an owner ID from tool input.
- `app-contracts.test.ts`, `mcp/tools.test.ts`, `mcp/http-auth.test.ts`, and
  `apps/mcp/server.test.ts` cover authenticated and anonymous ownership paths.

## Invariants

- Cookie- and Bearer-authenticated REST page creation stores the authenticated
  user's UUID as `owner_id`.
- Authenticated in-process MCP creation uses the Bearer JWT subject as
  `owner_id`.
- No read endpoint's authorization behavior changes merely because ownership
  is recorded.

## Relevant spec sections

- Section 2.7 (Changes to pages — `owner_id` FK)
- Section 6.5 (`owner_id` injection)
- Section 8 (Migration and rollout behavior)
- Section 9 (Environment variables — `PAGENT_TOKEN` for stdio MCP)
