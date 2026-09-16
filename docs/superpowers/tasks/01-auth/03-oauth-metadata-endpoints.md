# 03 — OAuth metadata endpoints (well-known)

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## Description

Add the three discovery endpoints that MCP clients and OAuth tools use to find the authorization server configuration: the AS metadata, the protected resource metadata, and the JWKS endpoint. These are static JSON responses served by Hono routes.

## As-built files

- `apps/api/auth/route-discovery.ts` — registers:
  - `GET /.well-known/oauth-authorization-server` — returns AS metadata JSON (issuer, authorization_endpoint, token_endpoint, registration_endpoint, revocation_endpoint, response_types_supported, grant_types_supported, token_endpoint_auth_methods_supported, code_challenge_methods_supported, scopes_supported).
  - `GET /.well-known/oauth-protected-resource` — returns protected resource metadata JSON (resource, authorization_servers, scopes_supported, bearer_methods_supported, resource_name).
  - `GET /.well-known/jwks.json` — returns the JWKS from `jwt.getJwks()`.
- `apps/api/auth/routes.ts` — composes the auth route modules for `apps/api/app.ts`.
- `apps/api/auth/routes-discovery.test.ts` — verifies:
  - Each endpoint returns 200 with correct `Content-Type: application/json`.
  - AS metadata `issuer` matches `API_PUBLIC_URL`.
  - All required fields are present per RFC 8414 and RFC 9728.
  - JWKS contains one key with `kty: OKP`, `crv: Ed25519`.

## Acceptance criteria

- All three endpoints are publicly accessible (no auth required).
- `issuer` and `resource` values are dynamically derived from the API origin in `API_PUBLIC_URL`.
- Endpoint URLs in the AS metadata use `API_PUBLIC_URL` as the base (not hardcoded `api.pagent.link` and not the renderer's `PUBLIC_URL`).
- `scopes_supported` returns `["page:create", "page:read"]`.
- `code_challenge_methods_supported` returns `["S256"]` (no `plain`).
- No Express dependency — all routes are native Hono.

## Dependencies

- **02** — `getJwks()` from `jwt.ts` is needed for the JWKS endpoint.

## Relevant spec sections

- Section 3.1 (Authorization Server metadata)
- Section 3.2 (Protected Resource metadata — RFC 9728)
- Section 5.3 (JWKS endpoint format)
