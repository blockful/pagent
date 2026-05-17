# 04 — Dynamic client registration

## Description

Implement `POST /oauth/register` per RFC 7591. MCP clients self-register before starting the authorization code flow. This endpoint creates rows in the `oauth_clients` table and also implements the `OAuthRegisteredClientsStore` interface from the MCP SDK.

## Files to create/modify

- `apps/api/auth/clients-store.ts` (new) — implements `OAuthRegisteredClientsStore` interface from `@modelcontextprotocol/sdk/server/auth/clients`. Methods:
  - `registerClient(metadata)` — validates `redirect_uris` (required, each must be a valid URI), generates `client_id` via `randomUUID()`, inserts into `oauth_clients`. Returns `OAuthClientInformationFull`.
  - `getClient(clientId)` — looks up by `client_id` PK. Returns client info or undefined.
- `apps/api/auth/routes.ts` — add route:
  - `POST /oauth/register` — validates request body, calls `registerClient()`, returns 201 with client info. Rate-limited to 10/IP/hour.
- `apps/api/auth/clients-store.test.ts` (new) — tests:
  - Successful registration returns `client_id` and echoes back metadata.
  - Missing `redirect_uris` returns 400 `invalid_client_metadata`.
  - Invalid URI in `redirect_uris` returns 400.
  - `getClient` returns the registered client.
  - `getClient` returns undefined for unknown `client_id`.
  - Rate limit (10/IP/hour) rejects the 11th request with 429.

## Acceptance criteria

- `POST /oauth/register` returns 201 with a body matching `OAuthClientInformationFull` from the MCP SDK.
- No `client_secret` is issued (public clients, `token_endpoint_auth_method: "none"`).
- `client_id` is a UUID.
- `client_id_issued_at` is a Unix timestamp (seconds).
- `redirect_uris` is validated: must be a non-empty array of valid URIs.
- `grant_types` defaults to `["authorization_code", "refresh_token"]`.
- `response_types` defaults to `["code"]`.
- Rate limit: 10 registrations per IP per hour.

## Dependencies

- **01** — `oauth_clients` table must exist.

## Relevant spec sections

- Section 2.3 (oauth_clients table schema)
- Section 3.3 (Dynamic client registration endpoint, request/response format, error cases)
- Section 7.3 (Rate limiting — 10/IP/hour for register)
- Section 10 (MCP SDK usage — `OAuthRegisteredClientsStore` interface)
