# 06 — Magic Link flow

## Description

Implement passwordless email login via Magic Links: sending the email with a one-time token and verifying it on click. Reuses the user upsert and auth code generation from task 05.

## Files to create/modify

- `apps/api/auth/magic-link.ts` (new) — Magic link generation, validation, and email sending:
  - `sendMagicLink(email: string, authorizeContext: AuthorizeContext): Promise<void>` — generates a 32-byte random token, stores `SHA-256(token)` in `magic_links` with 15-minute expiry. Stores the authorize context (client_id, redirect_uri, code_challenge, scope, state) server-side keyed by the magic link token. Sends the email via `nodemailer`.
  - `verifyMagicLink(token: string): Promise<{ email, authorizeContext }>` — looks up by `SHA-256(token)`, checks `expires_at > now()`, checks `consumed_at IS NULL`, marks `consumed_at = now()`. Returns the email and stored authorize context.
  - `createTransport(): Transporter` — creates a nodemailer SMTP transport from `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` env vars.
- `apps/api/auth/routes.ts` — add routes:
  - `POST /oauth/magic/send` — accepts `{ email }`, validates email format, calls `sendMagicLink()`. Always returns the same response ("check your email") regardless of whether the email exists. Rate-limited to 5/email/15min.
  - `GET /oauth/magic` — accepts `?token=...`, calls `verifyMagicLink()`, upserts user by email, generates auth code, redirects to `redirect_uri?code=...&state=...`.
- `apps/api/auth/login-page.ts` — wire the email form to POST to `/oauth/magic/send`. Show "Check your email" message on success.
- `apps/api/auth/magic-link.test.ts` (new) — tests:
  - Token generation and verification round-trip.
  - Expired token is rejected.
  - Already-consumed token is rejected.
  - Rate limit (5/email/15min) is enforced.
  - Email enumeration: response is identical for existing and non-existing emails.

## Acceptance criteria

- Magic link tokens are 32 bytes, stored as SHA-256 hashes (raw token never persisted).
- Token expires after 15 minutes.
- Token is single-use (`consumed_at` prevents replay).
- Authorize context is stored server-side (not in the email URL) to keep links short and avoid leaking OAuth params.
- Email is sent via `nodemailer` with `SMTP_*` env vars.
- `SMTP_FROM` defaults to `noreply@pagent.link`.
- Response to `/oauth/magic/send` does not reveal whether the email is registered (anti-enumeration, spec section 7.6).
- Rate limit: 5 per email per 15 minutes.
- If `SMTP_HOST` is not configured, `/oauth/magic/send` returns 503.

## Dependencies

- **01** — `magic_links` table must exist.
- **05** — `upsertUser()` and `createAuthCode()` from `provider.ts`, login page from `login-page.ts`.

## Relevant spec sections

- Section 2.6 (magic_links table schema)
- Section 3.8 (Magic Link verification endpoint)
- Section 4.3 (Magic Link flow — full sequence diagram)
- Section 7.3 (Rate limiting — 5/email/15min for magic/send)
- Section 7.6 (Email enumeration prevention)
- Section 9 (SMTP env vars)
- Section 10 (Dependencies — `nodemailer`)
