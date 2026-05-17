# 09 — Browser session support

## Description

Add browser-specific session endpoints (`POST /auth/logout`, `GET /auth/me`) and the browser session flow where the login page sets an httpOnly cookie after authentication. Support the `browser_session=1` query parameter for direct browser login without an MCP client.

## Files to create/modify

- `apps/api/auth/routes.ts` — add routes:
  - `GET /auth/me` — requires session cookie (via `resolveAuth()`), returns current user profile `{ id, handle, email, name, avatar_url }`. Returns 401 if no valid session.
  - `POST /auth/logout` — requires session cookie, calls `deleteSession()`, clears cookie with `Set-Cookie: pagent_session=; Max-Age=0; ...`, returns 200.
  - Modify `GET /oauth/authorize` — when `browser_session=1` is present (and no `client_id`): after successful authentication, set session cookie and redirect to `/` instead of issuing an auth code.
- `apps/api/auth/routes.ts` — in the Google callback and Magic Link verification handlers: when the authorize context has `browser_session=1`, call `createSession()` and set the cookie:
  - Cookie attributes: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` (30 days).
- `apps/api/auth/routes.test.ts` — add tests:
  - `GET /auth/me` with valid session returns user profile.
  - `GET /auth/me` without session returns 401.
  - `POST /auth/logout` clears the session and cookie.
  - Browser session flow (`browser_session=1`) sets cookie and redirects to `/`.

## Acceptance criteria

- `pagent_session` cookie is set only for browser-initiated auth flows.
- Cookie attributes: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=2592000`.
- `GET /auth/me` returns the user profile from the session.
- `POST /auth/logout` deletes the DB session row and clears the cookie.
- `browser_session=1` authorize flow works without `client_id`, `redirect_uri`, or `code_challenge`.
- After browser login, redirect goes to `/` (not to a client redirect_uri).
- Session creation stores IP address and User-Agent from the request.

## Dependencies

- **05** — Google OAuth callback must be working.
- **06** — Magic Link verification must be working.
- **08** — `resolveAuth()` middleware and session helpers must be working.

## Relevant spec sections

- Section 3.9 (Browser session endpoints — /auth/me, /auth/logout)
- Section 4.4 (Browser session flow — cookie setting, browser_session=1 parameter)
- Section 7.2 (Token storage — cookie attributes)
- Section 7.4 (CSRF protection — SameSite=Lax, POST /auth/logout)
