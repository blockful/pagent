# 08 — Auth middleware (Hono + MCP)

## Description

Implement the two auth middleware layers: the Hono middleware for REST routes (`resolveAuth` + `requireAuth`) and the MCP handler middleware for Bearer token validation on `/mcp`. Wire them into `app.ts` and `server.ts`.

## Files to create/modify

- `apps/api/auth/middleware.ts` (new) — Hono middleware:
  - `resolveAuth(): MiddlewareHandler` — checks for `pagent_session` cookie (resolves via session lookup) or `Authorization: Bearer` header (resolves via `verifyAccessToken()`). Sets `c.var.user` to `AuthUser | null`. Does NOT reject unauthenticated requests.
  - `requireAuth(): MiddlewareHandler` — rejects with 401 JSON if `c.var.user` is null.
  - Type exports: `AuthUser = { id, email, handle, authMethod: 'cookie' | 'bearer' }`, `AuthVariables = { user: AuthUser | null }`.
- `apps/api/auth/session.ts` (new) — session helpers:
  - `lookupSession(token: string): Promise<AuthUser | null>` — computes `SHA-256(token)`, queries `sessions JOIN users WHERE token_hash = hash AND expires_at > now()`. Extends `expires_at` by `SESSION_MAX_AGE_DAYS` (sliding expiry).
  - `createSession(userId: string, ip?: string, userAgent?: string): Promise<string>` — generates 128-bit random hex, stores `SHA-256(token)` in `sessions` with expiry. Returns the raw token for the cookie.
  - `deleteSession(token: string): Promise<void>` — deletes by `token_hash`.
- `apps/api/mcp/http.ts` — add Bearer token check before `StreamableHTTPServerTransport.handleRequest()`. On missing/invalid Bearer when `REQUIRE_AUTH=true`: return 401 with `WWW-Authenticate: Bearer resource_metadata="/.well-known/oauth-protected-resource"`.
- `apps/api/app.ts` — mount `resolveAuth()` on `*`. Conditionally mount `requireAuth()` on `POST /new` when `REQUIRE_AUTH=true`.
- `apps/api/auth/middleware.test.ts` (new) — tests:
  - Request with valid session cookie sets `c.var.user`.
  - Request with valid Bearer JWT sets `c.var.user`.
  - Request with no auth sets `c.var.user = null`.
  - `requireAuth()` returns 401 when user is null.
  - Expired session cookie is rejected.
  - Invalid JWT is rejected.
- `apps/api/auth/session.test.ts` (new) — tests:
  - `createSession` + `lookupSession` round-trip.
  - Expired session returns null.
  - `deleteSession` prevents future lookup.
  - Sliding expiry extends `expires_at` on lookup.

## Acceptance criteria

- `resolveAuth()` is applied to ALL routes via `app.use('*', ...)`.
- Cookie-based auth uses `pagent_session` cookie name.
- Session tokens are stored as SHA-256 hashes in the DB (raw token only in cookie).
- Session lifetime: 30 days, sliding (each request extends by `SESSION_MAX_AGE_DAYS`).
- Bearer auth uses `verifyAccessToken()` from `jwt.ts` (no DB lookup).
- MCP handler returns 401 with `WWW-Authenticate` header pointing to resource metadata when auth is required but missing.
- `requireAuth()` is only applied when `REQUIRE_AUTH=true`.
- Read endpoints (`GET /:id`, `GET /:id/result`) remain public regardless of `REQUIRE_AUTH`.
- Existing unauthenticated behavior is preserved when `REQUIRE_AUTH=false`.

## Dependencies

- **01** — `sessions` table must exist.
- **02** — `verifyAccessToken()` from `jwt.ts`.

## Relevant spec sections

- Section 6 (Middleware design — all subsections 6.1 through 6.4)
- Section 4.1 (MCP OAuth flow — 401 discovery with WWW-Authenticate)
- Section 7.2 (Token storage — httpOnly cookie properties)
- Section 7.4 (CSRF protection — SameSite=Lax)
