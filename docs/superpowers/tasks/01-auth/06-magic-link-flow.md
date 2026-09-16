# 06 — Magic Link flow

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## Description

Implement passwordless email login via Magic Links: sending the email with a one-time token and verifying it on click. Reuses the user upsert and auth code generation from task 05.

## As-built files

- `apps/api/auth/magic-link.ts` — Magic Link generation, validation, and email sending:
  - `sendMagicLink(email, authorizeContext)` — generates a 32-byte random token, stores `SHA-256(token)` in `magic_links` with 15-minute expiry, and emails the raw one-time token. The server-side context includes client, redirect, PKCE, scopes/state, consent, browser-session mode, and browser-transaction hash. The returned raw token exists for tests; the production route discards it.
  - `inspectMagicLink(token)` — reads an active row without consuming it so
    the route can validate consent, browser binding, and redirect safety first.
  - `verifyMagicLink(token)` — only after those checks, atomically consumes by
    `SHA-256(token)` and returns the email and stored authorize context.
  - `createTransport(): Transporter` — creates a nodemailer SMTP transport from `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` env vars.
- `apps/api/auth/route-magic.ts` — registers:
  - `POST /oauth/magic/send` — accepts `{ email, state? }` as JSON or form data, validates email and any signed OAuth context, then calls `sendMagicLink()`. Every valid email uses the same delivery and accepted-response path. Rate-limited to 5/email, 10/client IP, and 50/API process per 15 minutes.
  - `GET /oauth/magic` — accepts `?token=...`, inspects without consuming,
    verifies the same HttpOnly browser transaction (and explicit consent for
    OAuth-client flows), rechecks the registered redirect, then consumes the
    link, upserts the user, creates the auth code, and redirects. Unbound email
    scanners receive an HTML 400 without burning the link.
- `apps/api/auth/login-page.ts` — wires the email form to POST to `/oauth/magic/send`.
- `apps/api/auth/magic-link*.test.ts` — verifies:
  - Token generation and verification round-trip.
  - Expired token is rejected.
  - Already-consumed token is rejected.
  - A scanner or browser without the bound transaction gets 400 and leaves the
    token available for the intended browser.
  - Layered email, client-IP, and provider-capacity limits are enforced.
  - Email enumeration: the send path does not query or reveal prior registration.

## Acceptance criteria

- Magic link tokens are 32 bytes, stored as SHA-256 hashes (raw token never persisted).
- Token expires after 15 minutes.
- Token is single-use (`consumed_at` prevents replay).
- Validation order is inspect → browser/consent/redirect checks → atomic
  consume → user mutation/code issuance.
- Authorize context is stored server-side (not in the email URL) to keep links short and avoid leaking OAuth params.
- Email is sent via `nodemailer` with `SMTP_*` env vars.
- `SMTP_FROM` defaults to `noreply@pagent.link`.
- `/oauth/magic/send` does not query or reveal prior email registration (anti-enumeration, spec section 7.6).
- Rate limits: 5 per email, 10 per client IP, and 50 per API process per 15 minutes.
- If `SMTP_HOST` is not configured, `/oauth/magic/send` returns 503.

## Dependencies

- **01** — `magic_links` table must exist.
- **05** — `upsertUser()` and `createAuthCode()` from `provider.ts`, login page from `login-page.ts`.

## Relevant spec sections

- Section 2.6 (magic_links table schema)
- Section 3.8 (Magic Link verification endpoint)
- Section 4.3 (Magic Link flow — full sequence diagram)
- Section 7.3 (Layered rate limiting for magic/send)
- Section 7.6 (Email enumeration prevention)
- Section 9 (SMTP env vars)
- Section 10 (Dependencies — `nodemailer`)
