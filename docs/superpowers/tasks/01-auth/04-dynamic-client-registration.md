# 04 — Dynamic client registration

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## Description

Implement `POST /oauth/register` per RFC 7591. MCP clients self-register before starting the authorization code flow. This endpoint creates rows in the `oauth_clients` table and also implements the `OAuthRegisteredClientsStore` interface from the MCP SDK.

## As-built files

- `apps/api/auth/clients-store.ts` — implements the registered-client store. Methods:
  - `registerClient(metadata)` — validates `redirect_uris` against Pagent's redirect policy, generates `client_id` via `randomUUID()`, inserts into `oauth_clients`. Returns `OAuthClientInformationFull`.
  - `getClient(clientId)` — looks up by `client_id` PK. Returns client info or undefined.
- `apps/api/auth/route-discovery.ts` — registers:
  - `POST /oauth/register` — validates request body, calls `registerClient()`, returns 201 with client info. Rate-limited to 10/IP/hour.
- `apps/api/auth/clients-store.test.ts` and `routes-register.test.ts` — verify:
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
- `redirect_uris` is a non-empty array. Remote web callbacks require HTTPS;
  HTTP is limited to `localhost`, `127.0.0.1`, and `[::1]`; native-client
  custom schemes are allowed. Credentials, fragments, executable/browser
  schemes, generic handler schemes, and relative URLs are rejected.
- Redirect safety and exact registration membership are checked again when
  authorization starts and completes, including for legacy database rows.
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
