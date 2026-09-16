# 05 — Google OAuth flow

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## Description

Implement the Google OAuth identity provider leg: the authorize endpoint's login page, the redirect to Google's consent screen, and the callback that exchanges Google's authorization code for user info, upserts the user, and issues a Pagent authorization code.

## As-built files

- `apps/api/auth/google.ts` — Google OAuth helpers:
  - `buildGoogleAuthUrl(state: string): string` — constructs the Google OAuth URL with `GOOGLE_CLIENT_ID`, `GOOGLE_REDIRECT_URI`, `scope=openid email profile`, `response_type=code`, encoded `state`.
  - `exchangeGoogleCode(code: string): Promise<{ sub, email, name, picture }>` — exchanges the Google authorization code for an ID token via `googleapis.com/token`, verifies the token and `email_verified=true`, then decodes the profile claims.
- `apps/api/auth/consent-page.ts` — renders the initial OAuth-client page with
  unverified client metadata, exact redirect URI, requested scopes, and
  explicit Allow/Cancel POST actions. It exposes no identity-provider link.
- `apps/api/auth/login-page.ts` — renders Google and Magic Link choices only
  after a cookie-bound Allow decision, or directly for `browser_session=1`.
- `apps/api/auth/route-login.ts` and `route-consent.ts` — register:
  - `GET /oauth/authorize` — requires `response_type=code`; validates `client_id`, the redirect policy plus exact registered-URI match, `code_challenge`, and `code_challenge_method=S256`; starts an HttpOnly browser transaction and renders the consent page. Also supports `browser_session=1` mode (no client parameters required). Rate-limited to 30/IP/min.
  - `POST /oauth/authorize/consent` — verifies signed state and the matching browser transaction. Cancel stays local. Allow records consent in signed state and renders sign-in choices.
  - `GET /oauth/callback/google` — before exchanging Google's code or mutating a user, verifies signed consent and the matching browser transaction and rechecks the client redirect. It then upserts the user, creates a Pagent code, and redirects to the exact registered URI.
- `apps/api/auth/provider.ts` — exposes the user and authorization-code provider operations:
  - `upsertGoogleUser(profile)` — binds the account to Google's immutable `sub`, updates mutable email/profile data for that subject, rejects subject/email conflicts, and never auto-links an email-only account. Auto-generates `handle` from the email local part on first insert.
  - `createAuthCode(userId, clientId, redirectUri, codeChallenge, codeChallengeMethod, scope): Promise<string>` — generates random code, inserts into `auth_codes` with 10-minute expiry.

## Acceptance criteria

- The first OAuth-client page renders valid HTML with explicit Allow/Cancel
  controls and no Google or Magic Link action.
- Sign-in choices appear only after a cookie-bound Allow decision.
- Google button redirects to `accounts.google.com/o/oauth2/v2/auth` with correct params.
- `state` sent to Google is a signed JWT (HMAC-SHA256 with
  `AUTH_STATE_SECRET`) encoding the authorize parameters, explicit consent,
  and the browser-transaction hash.
- State JWT is validated and verified on callback — tampered state is rejected.
- Google callback requires a verified email and binds the user to Google's
  immutable `sub`; email changes for the same subject preserve the user.
- An existing email-only account is not auto-linked, and the error directs the
  user to Magic Link until an authenticated linking flow exists.
- `handle` is auto-generated from email local part, lowercased, validated against `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`, with numeric suffix if taken.
- Auth code is inserted with 10-minute expiry and PKCE challenge.
- `redirect_uri` passes the safe-scheme policy and exact registered-URI match
  both before consent and again at callback completion.
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
