# 02 — JWT signing and verification

## Description

Implement the `apps/api/auth/jwt.ts` module that handles Ed25519 JWT signing, verification, and JWKS serialization. This is the core cryptographic primitive used by the token endpoint (task 06) and auth middleware (task 07).

## Files to create/modify

- `apps/api/auth/jwt.ts` (new) — export functions:
  - `signAccessToken(payload: { sub, email, handle, clientId, scope }): Promise<string>` — signs a JWT with `alg: EdDSA`, `typ: at+jwt`, `kid: pagent-2026-05`. Claims: `iss`, `sub`, `aud`, `exp` (1h from `iat`), `iat`, `jti` (random UUID), `client_id`, `scope`, `email`, `handle`.
  - `verifyAccessToken(token: string): Promise<JwtPayload>` — verifies signature, checks `exp > now`, `iss === issuer`, `aud === audience`. Returns decoded payload or throws.
  - `getJwks(): { keys: JWK[] }` — returns the public key as a JWK with `kty: OKP`, `crv: Ed25519`, `use: sig`, `kid`.
  - `initKeys(signingKey: string, publicKey: string): void` — imports base64url-encoded DER keys from env vars.
- `apps/api/auth/jwt.test.ts` (new) — tests:
  - Round-trip: sign then verify returns original claims.
  - Expired token is rejected.
  - Tampered token (modified payload) is rejected.
  - Wrong issuer/audience is rejected.
  - `getJwks()` returns valid JWK structure.

## Acceptance criteria

- Uses the `jose` library (already listed in spec section 10 as a new dependency).
- JWT header has `alg: EdDSA`, `typ: at+jwt`, `kid: pagent-2026-05`.
- All claims from spec section 5.1 are present in signed tokens.
- `ACCESS_TOKEN_TTL_SECONDS` from env is respected (defaults to 3600).
- `verifyAccessToken` does NOT hit the database — purely cryptographic.
- JWKS output matches the format in spec section 5.3.

## Dependencies

- **01** — env vars (`JWT_SIGNING_KEY`, `JWT_PUBLIC_KEY`, `ACCESS_TOKEN_TTL_SECONDS`) must be in the schema.

## Relevant spec sections

- Section 5.1 (Access tokens — JWT header and payload)
- Section 5.3 (Signing key management — key format, JWKS endpoint structure)
- Section 5.4 (Token validation — `PagentTokenVerifier` interface)
- Section 10 (Dependencies — `jose` package)
