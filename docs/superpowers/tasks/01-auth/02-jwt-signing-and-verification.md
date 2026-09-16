# 02 — JWT signing and verification

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## As-built implementation

- `apps/api/auth/jwt.ts` signs Ed25519 access tokens with `alg: EdDSA`,
  `typ: at+jwt`, and `kid: pagent-2026-05`; it verifies signature, issuer,
  audience, token type, expiry, and required Pagent claims without a database
  lookup.
- `signAccessToken()` emits `iss`, `sub`, `aud`, `exp`, `iat`, `jti`,
  `client_id`, `scope`, `email`, and `handle`. The configured
  `ACCESS_TOKEN_TTL_SECONDS` controls its lifetime (default 3600 seconds).
- `initKeys()` imports the base64url DER key pair at API startup, and
  `getJwks()` exposes the public Ed25519 signing key through the discovery
  route.
- `apps/api/auth/jwt.test.ts` covers successful verification, expiry,
  signature tampering, issuer/audience validation, required claims, and JWKS
  shape.

## Integration

Task 07's token providers call `signAccessToken()`. Task 08's REST middleware
and the MCP HTTP handler call `verifyAccessToken()` for Bearer requests.

## Invariants

- JWT verification is purely cryptographic and does not query Postgres.
- The issuer and audience are the configured public API origin.
- The JWKS contains only the public signing material.

## Relevant spec sections

- Section 5.1 (Access tokens — JWT header and payload)
- Section 5.3 (Signing key management — key format, JWKS endpoint structure)
- Section 5.4 (Token validation — `PagentTokenVerifier` interface)
