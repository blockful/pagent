# 08 — Auth middleware (Hono + MCP)

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## As-built implementation

- `apps/api/auth/middleware.ts` exports `resolveAuth()`, `requireAuth()`, and
  `requireScope()`. `resolveAuth()` runs on every Hono request, preferring a
  `pagent_session` cookie and then a verified Bearer JWT. It sets
  `c.var.user` to an `AuthUser | null` and records Bearer scopes separately.
- `apps/api/auth/session.ts` creates random session tokens, stores only their
  SHA-256 hashes, resolves live sessions, slides their expiry, and deletes
  them by hash.
- `apps/api/app.ts` mounts `resolveAuth()` before the auth and page routes.
  `apps/api/app/page-routes.ts` conditionally requires authentication when
  `REQUIRE_AUTH=true` and enforces `page:create`/`page:read` for valid Bearer
  calls. Page reads remain public; result reads become protected when auth is
  required.
- `apps/api/mcp/http.ts` validates Bearer tokens before the Streamable HTTP
  transport when `REQUIRE_AUTH=true`, returns RFC 9728 discovery information
  on missing credentials, and assigns the verified SDK `AuthInfo` to
  `req.auth` for tool handlers.
- `middleware.resolve.test.ts`, `middleware.require.test.ts`, `session.test.ts`,
  `app-scope.test.ts`, and `mcp/http-auth.test.ts` cover the REST and MCP
  branches.

## Invariants

- Anonymous requests remain available during the rollout grace period where
  the route permits them; an under-scoped valid Bearer is still rejected.
- Cookie tokens are never stored in cleartext server-side.
- Invalid or expired Bearer tokens resolve as anonymous on REST routes; a
  protected route then returns the standard 401 response.

## Relevant spec sections

- Section 4.1 (MCP OAuth flow — 401 discovery with `WWW-Authenticate`)
- Section 6 (Middleware design)
- Section 7.2 (Token storage)
- Section 7.4 (CSRF protection)
