# 07 — Token exchange and refresh

## Description

Implement the OAuth token endpoint (`POST /oauth/token`) supporting both the `authorization_code` and `refresh_token` grant types, plus the revocation endpoint (`POST /oauth/revoke`). This is where PKCE verification happens and JWT access tokens are minted.

## Files to create/modify

- `apps/api/auth/provider.ts` — extend the `OAuthServerProvider` with token operations:
  - `exchangeAuthCode(code, clientId, redirectUri, codeVerifier): Promise<TokenResponse>` — looks up auth code, validates `consumed_at IS NULL`, verifies PKCE (`code_challenge === BASE64URL(SHA256(code_verifier))`), validates `client_id` and `redirect_uri` match, marks code as consumed. Calls `signAccessToken()` from `jwt.ts`, generates opaque refresh token (`rt_` + 32 random bytes), stores `SHA-256(refresh_token)` in `refresh_tokens` with 90-day expiry. Returns `{ access_token, token_type, expires_in, refresh_token, scope }`.
  - `refreshToken(refreshToken, clientId): Promise<TokenResponse>` — looks up by `SHA-256(token)`, checks not expired, checks not revoked. If revoked: revoke ALL tokens for `(user_id, client_id)` pair (token family revocation). Rotates: inserts new refresh token, revokes old one (`revoked_at = now()`). Mints new access token. Returns same `TokenResponse` shape.
  - `revokeToken(token, tokenTypeHint, clientId): Promise<void>` — revokes the specified token. Always returns success per RFC 7009.
- `apps/api/auth/routes.ts` — add routes:
  - `POST /oauth/token` — parses `application/x-www-form-urlencoded` body, dispatches on `grant_type` to `exchangeAuthCode()` or `refreshToken()`. Rate-limited to 20/IP/min.
  - `POST /oauth/revoke` — parses body, calls `revokeToken()`. Returns 200 always.
- `apps/api/auth/provider.test.ts` (new) — tests:
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
- Token family revocation: presenting a revoked refresh token revokes all tokens for that `(user_id, client_id)` pair.
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
