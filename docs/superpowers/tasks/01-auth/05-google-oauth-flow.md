# 05 — Google OAuth flow

## Description

Implement the Google OAuth identity provider leg: the authorize endpoint's login page, the redirect to Google's consent screen, and the callback that exchanges Google's authorization code for user info, upserts the user, and issues a Pagent authorization code.

## Files to create/modify

- `apps/api/auth/google.ts` (new) — Google OAuth helpers:
  - `buildGoogleAuthUrl(state: string): string` — constructs the Google OAuth URL with `GOOGLE_CLIENT_ID`, `GOOGLE_REDIRECT_URI`, `scope=openid email profile`, `response_type=code`, encoded `state`.
  - `exchangeGoogleCode(code: string): Promise<{ sub, email, name, picture }>` — exchanges the Google authorization code for an ID token via `googleapis.com/token`, decodes the ID token claims.
- `apps/api/auth/login-page.ts` (new) — exports a function `renderLoginPage(params: { clientId, redirectUri, codeChallenge, scope, state, error? }): string` that returns server-rendered HTML with "Continue with Google" button and an email input for Magic Link (Magic Link submit is wired in task 06).
- `apps/api/auth/routes.ts` — add routes:
  - `GET /oauth/authorize` — validates `client_id`, `redirect_uri` (exact match against registered URIs), `code_challenge`, `code_challenge_method=S256`. Renders the login page. Also supports `browser_session=1` mode (no client_id required). Rate-limited to 30/IP/min.
  - `GET /oauth/callback/google` — receives Google's `code` and `state`, calls `exchangeGoogleCode()`, upserts user (by email), generates a Pagent auth code (inserts into `auth_codes`), redirects to the MCP client's `redirect_uri?code=...&state=...`.
- `apps/api/auth/provider.ts` (new, partial) — begin the `OAuthServerProvider` implementation with the user upsert logic:
  - `upsertUser(profile: { email, name?, avatarUrl? }): Promise<User>` — INSERT ON CONFLICT(email) UPDATE name, avatar_url, updated_at. Auto-generates `handle` from email local part (with numeric suffix if taken).
  - `createAuthCode(userId, clientId, redirectUri, codeChallenge, codeChallengeMethod, scope): Promise<string>` — generates random code, inserts into `auth_codes` with 10-minute expiry.

## Acceptance criteria

- Login page renders valid HTML with a "Continue with Google" button.
- Google button redirects to `accounts.google.com/o/oauth2/v2/auth` with correct params.
- `state` parameter sent to Google is a signed JWT (HMAC-SHA256 with `AUTH_STATE_SECRET`) encoding the original authorize params (client_id, redirect_uri, code_challenge, scope, original state).
- State JWT is validated and verified on callback — tampered state is rejected.
- Google callback successfully upserts user with `email`, `name`, `avatar_url` from Google's ID token.
- `handle` is auto-generated from email local part, lowercased, validated against `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`, with numeric suffix if taken.
- Auth code is inserted with 10-minute expiry and PKCE challenge.
- `redirect_uri` is validated via exact string match against client's registered URIs.
- Invalid `client_id` returns error on the login page (not redirected).
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are read from env.

## Dependencies

- **01** — `users`, `auth_codes` tables must exist.
- **04** — `clients-store.ts` needed to look up `client_id` and validate `redirect_uri`.

## Relevant spec sections

- Section 3.4 (Authorization endpoint — login page, parameters, error cases)
- Section 3.7 (Google OAuth callback)
- Section 4.1 (MCP OAuth flow — full sequence diagram)
- Section 4.2 (Google OAuth flow — sequence diagram, state parameter encoding)
- Section 7.3 (Rate limiting — 30/IP/min for authorize)
- Section 7.5 (Open redirect prevention — exact match redirect_uri)
- Section 7.7 (Google OAuth state parameter — signed JWT)
