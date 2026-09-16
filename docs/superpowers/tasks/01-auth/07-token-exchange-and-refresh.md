# 07 — Token exchange and refresh

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## Description

Implement the OAuth token endpoint (`POST /oauth/token`) supporting both the `authorization_code` and `refresh_token` grant types, plus the revocation endpoint (`POST /oauth/revoke`). This is where PKCE verification happens and JWT access tokens are minted.

## As-built files

- `apps/api/auth/provider.ts` — exposes token operations:
  - `exchangeAuthCode(code, clientId, redirectUri, codeVerifier): Promise<TokenResponse>` — validates expiry, PKCE, client, and redirect before mutation. It atomically consumes the code and inserts the initial refresh token under the per-grant family lock. A correctly bound replay revokes only that grant family.
  - `refreshToken(refreshToken, clientId): Promise<TokenResponse>` — looks up by `SHA-256(token)`, validates expiry and client binding before replay handling, rotates atomically while preserving `family_id`, and revokes only that grant family on a correctly bound replay.
  - `revokeToken(token, tokenTypeHint, clientId): Promise<void>` — recognizes opaque refresh tokens and revokes their whole per-grant family; it always returns success per RFC 7009.
- `apps/api/auth/route-token.ts` — registers:
  - `POST /oauth/token` — parses `application/x-www-form-urlencoded` body, dispatches on `grant_type` to `exchangeAuthCode()` or `refreshToken()`. Rate-limited to 20/IP/min.
  - `POST /oauth/revoke` — parses body, calls `revokeToken()`. Returns 200 always.
- `apps/api/auth/provider.exchange.test.ts`, `provider.refresh.test.ts`, and
  `provider.revoke.test.ts` — test:
  - Authorization code exchange: valid code + verifier returns JWT + refresh token.
  - PKCE failure: wrong `code_verifier` returns `invalid_grant`.
  - Expired code returns `invalid_grant`.
  - Consumed code returns `invalid_grant`.
  - Refresh token exchange: returns new access token + new refresh token.
  - Old refresh token is revoked after rotation.
  - Presenting a revoked refresh token revokes the entire token family.
  - Unsupported `grant_type` returns `unsupported_grant_type`.
  - Token revocation always returns 200.

## Acceptance criteria

- Token endpoint accepts `application/x-www-form-urlencoded` (not JSON).
- PKCE verification uses S256 only: `BASE64URL(SHA256(code_verifier)) === code_challenge`.
- Access token is a JWT signed with Ed25519 (via `signAccessToken()`).
- Refresh token format: `rt_` prefix + 32 random bytes hex-encoded.
- Refresh tokens are stored as SHA-256 hashes.
- Refresh token rotation: every use issues a new refresh token and revokes the old one.
- Explicit refresh-token revocation invalidates the full per-grant family, including a
  successor created by a concurrent rotation.
- Token family revocation: presenting a non-expired revoked token from its bound
  client revokes only tokens with the same per-grant `family_id`; independent
  later grants remain valid.
- Auth code is single-use: `consumed_at` is set on first exchange.
- Rate limit: 20/IP/min on token endpoint.
- Error responses use OAuth 2.1 error format: `{ error, error_description }`.

## Dependencies

- **01** — `auth_codes`, `refresh_tokens` tables must exist.
- **02** — `signAccessToken()` from `jwt.ts`.
- **04** — `getClient()` from `clients-store.ts` for client_id validation.
- **05** — `createAuthCode()` must be working so codes exist to exchange.

## Relevant spec sections

- Section 3.5 (Token endpoint — request/response format, error cases)
- Section 3.6 (Token revocation — RFC 7009)
- Section 5.1 (Access token JWT format)
- Section 5.2 (Refresh tokens — opaque format, rotation, family revocation)
- Section 5.5 (Scopes)
- Section 7.1 (PKCE — S256 mandatory, plain forbidden)
- Section 7.3 (Rate limiting — 20/IP/min for token)
