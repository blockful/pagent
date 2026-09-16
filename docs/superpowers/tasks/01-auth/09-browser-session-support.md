# 09 — Browser session support

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## As-built implementation

- `apps/api/auth/route-session.ts` registers `GET /auth/me` and
  `POST /auth/logout`. The profile endpoint requires a cookie-authenticated
  session; logout deletes the server-side row when present and always clears
  the browser cookie.
- `apps/api/auth/route-login.ts`, `route-consent.ts`, and `route-magic.ts`
  drive OAuth consent, Google, and Magic Link completion. A
  `browser_session=1` authorization request starts a browser transaction and,
  after verified authentication, creates a session instead of issuing an
  authorization code.
- `apps/api/auth/route-shared.ts` sets `pagent_session` with `HttpOnly`,
  `SameSite=Lax`, `Path=/`, and the configured maximum age. `Secure` is set
  in production.
- `apps/api/server.ts` periodically deletes expired session, authorization
  code, magic-link, and refresh-token rows. Session lookup independently
  checks expiry, so that retention sweep cannot extend an expired session.
- `routes-browser-session.test.ts`, `routes-session.test.ts`,
  `google-callback.test.ts`, and `magic-link.verify-route.test.ts` exercise
  session creation, profile lookup, logout, and browser-bound completion.

## Invariants

- Browser-session authentication does not need OAuth client, redirect URI, or
  PKCE parameters.
- A browser transaction cookie binds the login completion to the initiating
  browser before it can create a session or authorization code.
- Session creation records the validated client IP when Railway trusted-proxy
  mode is enabled, plus the request user agent when supplied.

## Relevant spec sections

- Section 3.9 (Browser session endpoints)
- Section 4.4 (Browser session flow)
- Section 7.2 (Token storage)
- Section 7.4 (CSRF protection)
