# Auth — Design

Status: implemented; this document describes the shipped design as of 2026-09-15.

## 1. Overview and motivation

Pagent originally shipped without authentication: pages, API calls, and MCP
tool invocations were anonymous. The implemented auth system adds user
identity and page ownership while retaining a configurable grace period for
anonymous page creation. It establishes the foundation required by dashboard,
audit-log, custom-URL, and webhook features.

This spec introduces:

- **Users** — created via Google OAuth or Magic Link (passwordless email).
  Google identities are bound to the provider's immutable subject; verified
  email remains unique profile/contact data.
- **Sessions** — httpOnly cookies for browser clients (the renderer at
  `pagent.link` and any future dashboard).
- **OAuth 2.1 Authorization Server** — co-hosted with the API, issuing
  JWT access tokens and opaque refresh tokens. MCP clients authenticate
  via the MCP OAuth flow (spec 2025-11-25): 401 discovery, PKCE
  authorization code, Bearer tokens.
- **Page ownership** — pages gain an `owner_id` FK. During a grace
  period, unauthenticated page creation still works (`owner_id = NULL`).

The design is custom (no Clerk, no Auth0, no Supabase Auth). Pagent acts
as both the OAuth 2.1 Authorization Server (AS) and the Resource Server
(RS), co-hosted on the same origin per the MCP spec's recommendation for
simple deployments.

### Why custom

Third-party auth services add a runtime dependency, a billing
relationship, and (for Supabase Auth specifically) a tight coupling to
Supabase's session model that doesn't map cleanly to the MCP OAuth
flow's requirement for the RS to also be the AS. The MCP TypeScript SDK
supplies the transport and `AuthInfo` contract; Pagent implements its OAuth
routes and Postgres-backed provider functions directly so the same Hono
application owns discovery, authorization, tokens, and browser sessions.

## 2. Database schema

All tables live in the existing Supabase Postgres database. Schema
bootstrap follows the same pattern as the existing `pages` table:
`CREATE TABLE IF NOT EXISTS` in `db/connection.ts`'s `init()`, run on every
boot, idempotent.

### 2.1 `users`

```sql
CREATE TABLE IF NOT EXISTS users (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  handle     text        UNIQUE,          -- nullable: set during onboarding (Custom URLs feature), not at creation
  email      text        UNIQUE NOT NULL,
  google_sub text,
  name       text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_idx ON users (lower(handle));
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx
  ON users (google_sub) WHERE google_sub IS NOT NULL;
```

**`handle`** is a short, URL-safe username (e.g. `alex`). Auto-generated
from the email local part on first login, with a numeric suffix if
taken. Used in future features (custom page URLs, public profiles).
Validated: `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` (3-40 chars, lowercase
alphanumeric, internal hyphens only — no underscores, which are non-conventional in URLs).

### 2.2 `sessions`

Browser sessions. One user can have multiple active sessions (multiple
devices/browsers).

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text        NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
```

`token_hash` stores `SHA-256(session_token)`. The raw session token
lives only in the httpOnly cookie; the server never stores it in
cleartext. Lookup is by hash: `WHERE token_hash = SHA256(cookie_value)
AND expires_at > now()`.

Session lifetime: 30 days, sliding — each authenticated request extends
`expires_at` by 30 days. The server's 60-second TTL sweep reaps expired
session rows alongside other expired auth artifacts; session reads still
require `expires_at > now()` so cleanup timing never affects authorization.

### 2.3 `oauth_clients`

Dynamic client registration per RFC 7591. MCP clients self-register
before starting the authorization code flow.

```sql
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id              text        PRIMARY KEY,
  client_secret          text,
  client_secret_expires_at timestamptz,
  client_id_issued_at    timestamptz NOT NULL DEFAULT now(),
  client_name            text,
  client_uri             text,
  logo_uri               text,
  redirect_uris          text[]      NOT NULL,
  grant_types            text[]      NOT NULL DEFAULT '{authorization_code,refresh_token}',
  response_types         text[]      NOT NULL DEFAULT '{code}',
  scope                  text,
  token_endpoint_auth_method text    NOT NULL DEFAULT 'none',
  created_at             timestamptz NOT NULL DEFAULT now()
);
```

Public clients (`token_endpoint_auth_method = 'none'`) are the default
for MCP. The SDK's `OAuthClientInformationFull` type maps directly to
this table. `client_id` is a `randomUUID()`. `client_secret` is
generated only for confidential clients; MCP clients are always public.

### 2.4 `auth_codes`

Authorization codes issued during the PKCE flow. Short-lived (10
minutes).

```sql
CREATE TABLE IF NOT EXISTS auth_codes (
  code                   text        PRIMARY KEY,
  user_id                uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id              text        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri           text        NOT NULL,
  code_challenge         text        NOT NULL,
  code_challenge_method  text        NOT NULL DEFAULT 'S256',
  scope                  text,
  resource               text,
  refresh_token_family_id uuid       NOT NULL DEFAULT gen_random_uuid(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  consumed_at            timestamptz
);

CREATE INDEX IF NOT EXISTS auth_codes_expires_at_idx ON auth_codes (expires_at);
```

`consumed_at` is set on first use. A code that has `consumed_at IS NOT
NULL` is rejected on second use, and the server SHOULD revoke all tokens
issued from that code (per OAuth 2.1 Section 4.1.2 security guidance on
authorization code replay).

### 2.5 `refresh_tokens`

Opaque refresh tokens. Long-lived (90 days), rotated on each use.

```sql
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id  text        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  family_id  uuid        NOT NULL DEFAULT gen_random_uuid(),
  token_hash text        NOT NULL UNIQUE,
  scope      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_id_idx ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);
```

`token_hash` stores `SHA-256(raw_refresh_token)`. Like session tokens,
the raw value is never stored server-side. On rotation the old row gets
`revoked_at = now()` and a successor with the same `family_id` is inserted.
If a non-expired revoked token is replayed by its bound client, only active
tokens derived from that authorization grant are revoked. Independent later
grants for the same user and client have different family IDs and remain valid.
Expired refresh-token rows are reclaimed by the server's periodic auth-artifact
sweep; exchanges still reject expired rows before cleanup runs.

### 2.6 `magic_links`

Passwordless email login tokens. Short-lived (15 minutes).

```sql
CREATE TABLE IF NOT EXISTS magic_links (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text        NOT NULL,
  token_hash        text        NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  authorize_context jsonb
);

CREATE INDEX IF NOT EXISTS magic_links_expires_at_idx ON magic_links (expires_at);
```

Expired authorization codes and magic links are likewise reclaimed by the
periodic auth-artifact sweep. Their validation paths enforce expiry first, so
the sweep is retention work rather than an authorization control.

### 2.7 Changes to `pages`

Add `owner_id` as a nullable FK:

```sql
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS owner_id uuid
    REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pages_owner_id_idx ON pages (owner_id);
```

Nullable: during the grace period, unauthenticated page creation sets
`owner_id = NULL`. When `REQUIRE_AUTH=true`, the `POST /new` middleware
rejects unauthenticated requests before the handler runs, so all new
pages have an owner.

## 3. API endpoints

All auth endpoints live under `/oauth/` on the API server
(`api.pagent.link`). The well-known metadata endpoints live at the
standard RFC-defined paths.

### 3.1 Authorization Server metadata

```
GET /.well-known/oauth-authorization-server
```

**Response** `200 application/json`:

```json
{
  "issuer": "https://api.pagent.link",
  "authorization_endpoint": "https://api.pagent.link/oauth/authorize",
  "token_endpoint": "https://api.pagent.link/oauth/token",
  "registration_endpoint": "https://api.pagent.link/oauth/register",
  "revocation_endpoint": "https://api.pagent.link/oauth/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["page:create", "page:read"],
  "service_documentation": "https://github.com/blockful/pagent#readme"
}
```

This endpoint is served by Pagent's Hono discovery routes. It is public (no
auth required).

### 3.2 Protected Resource metadata (RFC 9728)

```
GET /.well-known/oauth-protected-resource
```

**Response** `200 application/json`:

```json
{
  "resource": "https://api.pagent.link",
  "authorization_servers": ["https://api.pagent.link"],
  "scopes_supported": ["page:create", "page:read"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Pagent API",
  "resource_documentation": "https://github.com/blockful/pagent#readme"
}
```

This is the entry point for MCP clients that receive a 401 on `/mcp`.
The `authorization_servers` array points back to the same origin (AS and
RS are co-hosted).

### 3.3 Dynamic client registration (RFC 7591)

```
POST /oauth/register
Content-Type: application/json

{
  "redirect_uris": ["http://localhost:9876/callback"],
  "client_name": "Claude Code",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

**Response** `201 application/json`:

```json
{
  "client_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "client_name": "Claude Code",
  "redirect_uris": ["http://localhost:9876/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "client_id_issued_at": 1747500000
}
```

**Error cases:**

| Status | Error                     | When                                             |
| ------ | ------------------------- | ------------------------------------------------ |
| 400    | `invalid_client_metadata` | Missing `redirect_uris`, invalid URI, etc.       |
| 429    | `rate_limited`            | Too many registrations from this IP               |

No `client_secret` is issued for public clients. This matches the MCP
spec's guidance: MCP clients are public (they can't keep a secret).

### 3.4 Authorization endpoint

```
GET /oauth/authorize?
  response_type=code&
  client_id=...&
  redirect_uri=...&
  state=...&
  code_challenge=...&
  code_challenge_method=S256&
  scope=page:create+page:read
```

For OAuth clients, this endpoint first serves a minimal consent page
(server-rendered, not the Vite SPA). The page labels all dynamically
registered client metadata as unverified and shows the self-asserted client
name, client ID, exact return destination, and requested scopes. It contains
only explicit **Allow** and **Cancel** POST actions; identity-provider links
are not present yet.

The pending request is bound to an HttpOnly, SameSite browser transaction.
`POST /oauth/authorize/consent` verifies both the signed request and that
transaction. Cancel clears it and renders a local confirmation without
redirecting to the client. Allow re-signs the request with consent recorded
and renders the login page with two options:

1. **"Allow and continue with Google"** — redirects to Google's OAuth consent
   screen with Pagent as the relying party.
2. **"Allow and send magic link"** — shows an email input. On submit, sends a
   Magic Link email and shows a "check your email" message.

After successful authentication (Google callback or Magic Link click), the
server follows one of two mutually exclusive completion paths:

1. Both paths upsert the user in the `users` table (create on first login,
   update `name`/`avatar_url` on subsequent logins).
2. An OAuth-client request generates an authorization code and redirects to
   `redirect_uri?code=...&state=...`; it does not create a browser session.
3. A renderer browser-session request creates the session cookie and redirects
   to the renderer `PUBLIC_URL`; it does not generate an authorization code.

**Error cases:**

| Status | Response        | When                                                         |
| ------ | --------------- | ------------------------------------------------------------ |
| 400    | HTML error page | `response_type` is missing or is not `code`                   |
| 400    | HTML error page | Another required parameter is missing or PKCE is not `S256`  |
| 400    | HTML error page | `client_id` is unknown                                       |
| 400    | HTML error page | `redirect_uri` is unsafe or not an exact registered URI      |

Errors on the authorize endpoint are shown on a local HTML error page
(not redirected), per OAuth 2.1 Section 4.1.2.1 — redirect-based
errors only go to the redirect URI if we trust it.

### 3.5 Token endpoint

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=...&
client_id=...&
redirect_uri=...&
code_verifier=...
```

**Response** `200 application/json`:

```json
{
  "access_token": "eyJhbGciOiJFZERTQSIs...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "rt_a1b2c3d4e5f6...",
  "scope": "page:create page:read"
}
```

**Refresh token grant:**

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&
refresh_token=rt_...&
client_id=...
```

Returns a new access token and a rotated refresh token. The old refresh
token is revoked.

**Error cases:**

| Status | Error                    | When                                                                    |
| ------ | ------------------------ | ----------------------------------------------------------------------- |
| 400    | `invalid_grant`          | Code/refresh token invalid or expired, PKCE fails, or client binding mismatches |
| 401    | `invalid_client`         | `client_id` is not registered                                           |
| 400    | `invalid_request`        | Missing required parameters                                             |
| 400    | `unsupported_grant_type` | Not `authorization_code` or `refresh_token`                            |
| 429    | `rate_limited`           | Too many token requests                                                 |

### 3.6 Token revocation (RFC 7009)

```
POST /oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=...&
token_type_hint=refresh_token&
client_id=...
```

**Response** `200` for handled revocation attempts — per RFC 7009, even if the token was already
revoked or invalid. The endpoint-wide abuse limit can return `429`. When the supplied opaque refresh token is recognized and
its optional `client_id` binding matches, revocation invalidates every refresh
token in that token's per-grant family. Access-token revocation remains a
no-op in V1 because access tokens are short-lived JWTs without a denylist.

### 3.7 Google OAuth callback (internal)

```
GET /oauth/callback/google?code=...&state=...
```

Internal endpoint. Not part of the public OAuth contract. Receives the
authorization code from Google, verifies the ID token and
`email_verified=true`, then identifies the user by Google's immutable `sub`.
Email-only accounts are not auto-linked; they must use Magic Link until an
authenticated account-linking flow exists. A successful callback resumes the
Pagent authorize flow and redirects to the MCP client's `redirect_uri`.

### 3.8 Magic Link verification (internal)

```
GET /oauth/magic?token=...
```

Internal endpoint. It first inspects the active token without consuming it,
then verifies the same HttpOnly browser transaction that initiated sign-in.
OAuth-client links additionally require explicit consent and a still-valid
registered redirect. Only after those checks pass does the endpoint atomically
consume the token, upsert the user, and continue the Pagent authorize flow.
Email scanners and other unbound browsers receive an HTML 400 response without
burning an otherwise active one-time link.

### 3.9 Browser session endpoints

These implemented API endpoints are for a future web-renderer/dashboard
integration, not for MCP clients. The current renderer does not initiate
browser sign-in or call these endpoints.

```
POST /auth/logout
Cookie: pagent_session=...
```

Deletes the session row and clears the cookie.

```
GET /auth/me
Cookie: pagent_session=...
```

Returns the current user's profile. A future renderer/dashboard integration
can use it to show a logged-in state. Cross-origin browser fetches will also
need credentialed CORS enabled for the exact renderer origin.

**Response** `200`:

```json
{
  "id": "uuid",
  "handle": "alex",
  "email": "alex@blockful.io",
  "name": "Alexandro Netto",
  "avatar_url": "https://lh3.googleusercontent.com/..."
}
```

**Response** `401` if no valid session cookie.

## 4. Auth flows

### 4.1 MCP OAuth flow (MCP client connecting via `/mcp`)

This is the primary auth flow for AI agents. Follows the MCP
specification 2025-11-25.

```
MCP Client                  Pagent API (AS+RS)         Google / Email
    │                             │                         │
    │  POST /mcp (no Bearer)      │                         │
    │────────────────────────────▶│                         │
    │  401 + WWW-Authenticate:    │                         │
    │    Bearer resource_metadata=│                         │
    │    "/.well-known/oauth-     │                         │
    │     protected-resource"     │                         │
    │◀────────────────────────────│                         │
    │                             │                         │
    │  GET /.well-known/oauth-    │                         │
    │      protected-resource     │                         │
    │────────────────────────────▶│                         │
    │  { authorization_servers:   │                         │
    │    ["https://api.pagent.    │                         │
    │     link"] }                │                         │
    │◀────────────────────────────│                         │
    │                             │                         │
    │  GET /.well-known/oauth-    │                         │
    │      authorization-server   │                         │
    │────────────────────────────▶│                         │
    │  { registration_endpoint,   │                         │
    │    authorization_endpoint,  │                         │
    │    token_endpoint, ... }    │                         │
    │◀────────────────────────────│                         │
    │                             │                         │
    │  POST /oauth/register       │                         │
    │  { redirect_uris, ... }     │                         │
    │────────────────────────────▶│                         │
    │  { client_id }              │                         │
    │◀────────────────────────────│                         │
    │                             │                         │
    │  Generate code_verifier,    │                         │
    │  code_challenge = S256(v)   │                         │
    │                             │                         │
    │  Open browser:              │                         │
    │  GET /oauth/authorize?      │                         │
    │    response_type=code&      │                         │
    │    client_id=...&           │                         │
    │    code_challenge=...&      │                         │
    │    redirect_uri=            │                         │
    │    http://localhost:PORT/   │                         │
    │    callback&state=...       │                         │
    │─ ─ ─ ─ ─(browser)─ ─ ─ ─ ▶│                         │
    │                             │  Consent page shown     │
    │  POST /oauth/authorize/     │                         │
    │    consent (Allow)          │                         │
    │─ ─ ─ ─ ─(browser)─ ─ ─ ─ ▶│                         │
    │                             │  Login page shown       │
    │                             │  User picks Google      │
    │                             │────────────────────────▶│
    │                             │  Google consent screen   │
    │                             │◀────────────────────────│
    │                             │  /oauth/callback/google │
    │                             │  code exchange, upsert   │
    │                             │  user, issue auth code   │
    │                             │                         │
    │  Redirect to                │                         │
    │  http://localhost:PORT/     │                         │
    │  callback?code=...&state=...│                         │
    │◀─ ─ ─(browser redirect)─ ─ │                         │
    │                             │                         │
    │  POST /oauth/token          │                         │
    │  grant_type=                │                         │
    │    authorization_code&      │                         │
    │  code=...&code_verifier=... │                         │
    │────────────────────────────▶│                         │
    │  { access_token (JWT),      │                         │
    │    refresh_token }          │                         │
    │◀────────────────────────────│                         │
    │                             │                         │
    │  POST /mcp                  │                         │
    │  Authorization: Bearer JWT  │                         │
    │────────────────────────────▶│                         │
    │  (MCP response)             │                         │
    │◀────────────────────────────│                         │
```

### 4.2 Google OAuth flow (identity provider leg)

Pagent is a relying party to Google. The user's browser is redirected
to Google's authorization endpoint. Google returns an authorization code
to Pagent's callback. Pagent exchanges it for an ID token and uses the
claims (`sub`, `email`, `name`, `picture`) to upsert the user.

```
User Browser           Pagent API                  Google OAuth
    │                       │                           │
    │  GET /oauth/authorize │                           │
    │  ?response_type=code… │                           │
    │──────────────────────▶│                           │
    │  Consent page         │                           │
    │◀──────────────────────│                           │
    │  POST /oauth/authorize/consent (Allow)            │
    │──────────────────────▶│                           │
    │  Login page           │                           │
    │◀──────────────────────│                           │
    │  Clicks "Google"      │                           │
    │──────────────────────▶│                           │
    │                       │  302 to                   │
    │                       │  accounts.google.com/     │
    │                       │  o/oauth2/v2/auth?        │
    │                       │  client_id=GOOGLE_ID&     │
    │                       │  redirect_uri=/oauth/     │
    │                       │  callback/google&         │
    │                       │  scope=openid+email+      │
    │                       │  profile&                 │
    │                       │  state=STATE&             │
    │                       │  response_type=code       │
    │◀──────────────────────│                           │
    │                       │                           │
    │  Google consent       │                           │
    │─────────────────────────────────────────────────▶│
    │  (user approves)      │                           │
    │◀─────────────────────────────────────────────────│
    │                       │                           │
    │  GET /oauth/callback/ │                           │
    │  google?code=...&     │                           │
    │  state=...            │                           │
    │──────────────────────▶│                           │
    │                       │  POST googleapis.com/     │
    │                       │  token (exchange code)    │
    │                       │──────────────────────────▶│
    │                       │  { id_token, access_token }│
    │                       │◀──────────────────────────│
    │                       │                           │
    │                       │  Decode id_token:         │
    │                       │  { sub, email, name,      │
    │                       │    picture }              │
    │                       │  Upsert user              │
    │                       │  Issue Pagent auth code   │
    │                       │                           │
    │  302 to redirect_uri  │                           │
    │  ?code=PAGENT_CODE    │                           │
    │  &state=STATE         │                           │
    │◀──────────────────────│                           │
```

**State parameter encoding:** The `state` parameter sent to Google
encodes both:
- The original MCP client's CSRF `state` value.
- The original authorize request parameters (client_id, redirect_uri,
  code_challenge, scope) so the callback can resume the flow.

This is a signed HS256 JWT, not an encrypted JWE. Its fields are values the
client already supplied, so confidentiality is not required; the signature,
issuer, audience, and 15-minute expiry prevent undetected tampering and
cross-purpose use. The state token itself is not stored or consumed as a
single-use record. For OAuth-client flows, explicit consent produces a fresh
signed state and subsequent use is additionally bound to the initiating
browser's HttpOnly transaction cookie.

### 4.3 Magic Link flow

```
User Browser           Pagent API                  Email Service
    │                       │                           │
    │  GET /oauth/authorize │                           │
    │  ?response_type=code… │                           │
    │──────────────────────▶│                           │
    │  Consent page         │                           │
    │◀──────────────────────│                           │
    │  POST /oauth/authorize/consent (Allow)            │
    │──────────────────────▶│                           │
    │  Login page           │                           │
    │◀──────────────────────│                           │
    │  Enters email, clicks │                           │
    │  "Send link"          │                           │
    │──────────────────────▶│                           │
    │                       │  POST /oauth/magic/send   │
    │                       │  (internal)               │
    │                       │                           │
    │                       │  Generate token (32 bytes)│
    │                       │  Store SHA256(token) in   │
    │                       │  magic_links table        │
    │                       │  Build link:              │
    │                       │  /oauth/magic?token=...   │
    │                       │──────────────────────────▶│
    │                       │  Send email with link     │
    │                       │                           │
    │  "Check your email"   │                           │
    │◀──────────────────────│                           │
    │                       │                           │
    │  User clicks link     │                           │
    │  GET /oauth/magic?    │                           │
    │  token=...            │                           │
    │──────────────────────▶│                           │
    │                       │  Validate:                │
    │                       │  - token_hash exists      │
    │                       │  - not expired            │
    │                       │  - not consumed           │
    │                       │  Mark consumed            │
    │                       │  Upsert user by email     │
    │                       │  Issue Pagent auth code   │
    │                       │                           │
    │  302 to redirect_uri  │                           │
    │  ?code=PAGENT_CODE    │                           │
    │  &state=STATE         │                           │
    │◀──────────────────────│                           │
```

The Magic Link row stores the full authorize context (`client_id`,
`redirect_uri`, `code_challenge`, scope, state, consent, and browser-transaction
hash) server-side keyed by the magic link token hash. The email URL contains
only the raw one-time token, keeping OAuth parameters out of email logs.

### 4.4 Browser session flow (renderer / dashboard)

For browser-based access (the renderer, a future dashboard), users authenticate
via `/oauth/authorize?browser_session=1`. After authentication, the server sets
an HttpOnly session cookie; this direct browser path does not issue an OAuth
authorization code:

```
Set-Cookie: pagent_session=<random-128-bit-hex>;
  HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
```

The cookie is set only for the explicit session-initiating query parameter
`browser_session=1`; merely omitting `client_id` from an OAuth request is an
HTML 400 error.

Direct browser login (not part of an MCP OAuth flow) uses a simplified
path:

```
GET /oauth/authorize?browser_session=1
```

No `client_id`, `redirect_uri`, or `code_challenge`. After login, the
server sets the session cookie and redirects to `/` (the renderer
homepage or a dashboard).

## 5. Token management

### 5.1 Access tokens (JWT)

Access tokens are JSON Web Tokens signed with Ed25519 (EdDSA algorithm).
Ed25519 provides 128-bit security in a compact signature (64 bytes)
with fast verification. The key pair is generated once and stored in
environment variables.

**JWT header:**

```json
{
  "alg": "EdDSA",
  "typ": "at+jwt",
  "kid": "pagent-2026-05"
}
```

**JWT payload:**

```json
{
  "iss": "https://api.pagent.link",
  "sub": "uuid-of-user",
  "aud": "https://api.pagent.link",
  "exp": 1747503600,
  "iat": 1747500000,
  "jti": "unique-token-id",
  "client_id": "registered-client-id",
  "scope": "page:create page:read",
  "email": "alex@blockful.io",
  "handle": "alex"
}
```

**Claims explained:**

| Claim       | Value                              | Purpose                                           |
| ----------- | ---------------------------------- | ------------------------------------------------- |
| `iss`       | `https://api.pagent.link`          | Issuer — must match the AS metadata issuer         |
| `sub`       | User UUID                          | Subject — the authenticated user                   |
| `aud`       | `https://api.pagent.link`          | Audience — the RS (same as issuer, co-hosted)      |
| `exp`       | Unix timestamp                     | Expiry — 1 hour from issuance                      |
| `iat`       | Unix timestamp                     | Issued at                                          |
| `jti`       | Random UUID                        | Token ID — for revocation checks if needed         |
| `client_id` | Registered client ID               | Which OAuth client obtained this token             |
| `scope`     | Space-separated scope string       | Authorized scopes                                  |
| `email`     | User email                         | Convenience claim — avoids a DB lookup per request  |
| `handle`    | User handle                        | Convenience claim                                  |

**Lifetime:** 1 hour. Short enough that a leaked token has limited
blast radius; long enough that a typical agent session doesn't need
more than 1-2 refreshes.

### 5.2 Refresh tokens (opaque)

Refresh tokens are opaque 256-bit random values, prefixed with `rt_`
for debuggability. Stored as `SHA-256(token)` in the `refresh_tokens`
table.

**Lifetime:** 90 days. Rotated on every use — the exchange returns a
new refresh token and revokes the old one.

**Token family revocation:** If a non-expired revoked refresh token is
presented by its bound client, every active refresh token with the same
per-grant `family_id` is revoked immediately. This detects token theft without
letting an obsolete token invalidate a later, independent authorization grant.
Expired or cross-client presentations are rejected before revocation.

### 5.3 Signing key management

The Ed25519 key pair is stored as environment variables:

- `JWT_SIGNING_KEY` — a PKCS#8 DER-encoded Ed25519 private key, then
  base64url-encoded.
- `JWT_PUBLIC_KEY` — an SPKI DER-encoded Ed25519 public key, then
  base64url-encoded.

Key generation (run once, store the output):

```bash
node -e "
  const { generateKeyPairSync } = require('crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  console.log('JWT_SIGNING_KEY=' + privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'));
  console.log('JWT_PUBLIC_KEY=' + publicKey.export({type:'spki',format:'der'}).toString('base64url'));
"
```

A `JWKS` endpoint (`GET /.well-known/jwks.json`) exposes the public
key so external verifiers (if needed in the future) can validate tokens
without sharing the private key:

```json
{
  "keys": [{
    "kty": "OKP",
    "crv": "Ed25519",
    "use": "sig",
    "kid": "pagent-2026-05",
    "x": "<base64url-encoded-public-key>"
  }]
}
```

### 5.4 Token validation

`verifyAccessToken()` validates JWTs locally and returns the checked claims:

```ts
const claims = await verifyAccessToken(token);
```

Signature (Ed25519), expiry, issuer, audience, client, scope, subject, email,
and handle are checked before claims are returned. REST middleware maps them
to `c.var.user` and `c.var.authScopes`. The raw Node MCP handler maps them to
the SDK's `AuthInfo` shape and assigns `req.auth` before invoking
`StreamableHTTPServerTransport`.

No DB roundtrip on every request. The JWT is self-contained. The only
reason to hit the DB would be for revocation checks (checking `jti`
against a revocation list), which is deferred to V2 — the 1-hour
lifetime is the revocation mechanism for V1.

### 5.5 Scopes

| Scope         | Grants                                             |
| ------------- | -------------------------------------------------- |
| `page:create` | `POST /new`, `show_ui`, `show_html` MCP tools      |
| `page:read`   | `GET /:id/result`, `check_result` MCP tool         |

Default scope (if none requested): `page:create page:read`. `GET /:id`
and the renderer's `POST /:id/result` submission route are public and do
not require an OAuth scope. Session-cookie-authenticated requests are not
subject to Bearer-token scope checks.

## 6. Middleware design

### 6.1 Architecture

Auth integrates into the existing Hono app and the raw Node HTTP MCP
handler via two native layers:

```
                            ┌─────────────────────────────────────┐
                            │         server.ts (Node HTTP)       │
                            │                                     │
  ┌─────────────────────┐   │  path = /mcp ?                     │
  │  Pagent MCP auth    │◀──│  YES → mcpHandler (raw Node)       │
  │  verifyAccessToken  │   │        ↓                            │
  │  + req.auth         │   │  StreamableHTTPServerTransport      │
  └─────────────────────┘   │        ↓                            │
                            │  StreamableHTTPServerTransport      │
                            │                                     │
  ┌─────────────────────┐   │  path != /mcp ?                    │
  │  Hono middleware     │◀──│  YES → Hono app                    │
  │  resolveAuth()       │   │        ↓                            │
  │  (cookie + Bearer)   │   │  resolve user from cookie or JWT   │
  └─────────────────────┘   │        ↓                            │
                            │  route handlers                     │
                            └─────────────────────────────────────┘
```

### 6.2 Hono auth middleware

Implemented in `apps/api/auth/middleware.ts`.

```ts
import type { Context, Next } from 'hono';

type AuthUser = {
  id: string;        // user UUID
  email: string;
  handle: string | null;
  authMethod: 'cookie' | 'bearer';
};

type AuthVariables = {
  user: AuthUser | null;
  authScopes: readonly string[] | null;
};

/**
 * Resolves the authenticated user from either:
 * 1. A session cookie (`pagent_session`) — browser clients
 * 2. A Bearer JWT in the Authorization header — API/MCP clients
 *
 * Sets c.var.user to the resolved user or null if unauthenticated.
 * Does NOT reject unauthenticated requests — that's the job of
 * requireAuth(), which wraps this and returns 401.
 */
export function resolveAuth(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Try cookie first (browser sessions)
    const sessionToken = getCookie(c, 'pagent_session');
    if (sessionToken) {
      const user = await lookupSession(sessionToken);
      if (user) {
        c.set('user', { ...user, authMethod: 'cookie' });
        c.set('authScopes', null);
        return next();
      }
    }

    // Try Bearer token (API / MCP clients)
    const authHeader = c.req.header('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7).trim();
        const claims = await verifyAccessToken(token);
        c.set('user', {
          id: claims.sub,
          email: claims.email,
          handle: claims.handle || null,
          authMethod: 'bearer',
        });
        c.set('authScopes', claims.scope.split(/\s+/).filter(Boolean));
        return next();
      } catch {
        // Invalid Bearer credentials resolve as anonymous here; protected
        // routes apply requireAuth() and return the standard 401 response.
      }
    }

    c.set('user', null);
    c.set('authScopes', null);
    return next();
  };
}

/**
 * Rejects unauthenticated requests with 401.
 * Applied to protected routes (POST /new, etc.) when REQUIRE_AUTH=true.
 */
export function requireAuth(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!c.var.user) {
      return c.json({
        error: 'unauthorized',
        message: 'Authentication required',
      }, 401);
    }
    return next();
  };
}
```

### 6.3 MCP auth middleware

The MCP handler in `apps/api/mcp/http.ts` currently writes directly to
the Node response stream. Auth is added before the
`StreamableHTTPServerTransport`:

```ts
// In makeMcpHttpHandler:
if (env.REQUIRE_AUTH) {
  // Check for Bearer token in Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    // Return 401 with WWW-Authenticate pointing to resource metadata
    res.setHeader('WWW-Authenticate',
      `Bearer resource_metadata="${API_PUBLIC_URL}/.well-known/oauth-protected-resource"`
    );
    respondJson(res, 401, {
      error: 'unauthorized',
      message: 'Bearer token required',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  try {
    const claims = await verifyAccessToken(token);
    req.auth = {
      token,
      clientId: claims.client_id,
      scopes: claims.scope.split(/\s+/).filter(Boolean),
      expiresAt: claims.exp,
      extra: { sub: claims.sub, email: claims.email, handle: claims.handle },
    };
  } catch (err) {
    respondJson(res, 401, {
      error: 'invalid_token',
      message: 'Invalid or expired access token',
    });
    return;
  }
}

// Pass auth info through to the transport
await transport.handleRequest(req, res, body);
```

The `StreamableHTTPServerTransport.handleRequest` accepts an optional
`auth` property on the request object (per the SDK's type definition),
which is forwarded to tool handlers.

### 6.4 Integration with existing routes

In `apps/api/app.ts`, the middleware chain becomes:

```ts
// Always resolve auth (sets c.var.user or null)
app.use('*', resolveAuth());

// POST /new and GET /:id/result conditionally use requireAuth().
// Their requireScope() middleware always checks valid Bearer credentials.
// GET /:id and POST /:id/result remain public.
```

`GET /:id` remains public because the renderer addresses pages by their
unguessable 128-bit ID. `GET /:id/result` requires authentication when
`REQUIRE_AUTH=true`; when the flag is false, anonymous polling remains
available for rollout compatibility. Scope checks are independent of that
anonymous gate: any valid Bearer used with `POST /new` or
`GET /:id/result` must include `page:create` or `page:read`, respectively,
even during grace mode. `POST /:id/result` remains public for renderer
submissions.

### 6.5 `owner_id` injection

When auth is resolved and a user is present, `POST /new` injects
`owner_id` into the page record:

```ts
// In store.ts createPage/createHtmlPage:
// Accept optional ownerId parameter
export async function createPage(
  spec: unknown,
  format: PageFormat,
  cfg: CreatePageConfig & { ownerId?: string },
): Promise<ShowUiResult> {
  // ... existing logic ...
  // Pass ownerId to db.insertPage
}
```

The `insertPage` function gains an optional `owner_id` column in the
INSERT.

## 7. Security considerations

### 7.1 PKCE

PKCE (Proof Key for Code Exchange) is mandatory. The server MUST
reject authorization code exchanges that don't include a valid
`code_verifier`. Only `S256` is supported (`plain` is forbidden per
OAuth 2.1). The challenge is stored with the authorization code and
validated at the token endpoint.

### 7.2 Token storage

| Token type     | Storage location          | Protection                          |
| -------------- | ------------------------- | ----------------------------------- |
| Session token  | httpOnly, Secure cookie   | Not accessible to JS; HTTPS only     |
| Access token   | MCP client memory         | Short-lived (1h); in-memory only     |
| Refresh token  | MCP client persistent     | Stored by SDK; rotated on use        |
| Auth code      | URL parameter (transient) | Single-use; 10-minute expiry         |
| Magic link     | Email (transient)         | Single-use; 15-minute expiry         |

Server-side, session tokens, refresh tokens, and magic link tokens are stored
as SHA-256 hashes; their raw values exist only in transit. Authorization codes
are high-entropy opaque values stored as the `auth_codes` primary key. They are
still short-lived, PKCE-bound, and atomically consumed on first successful
exchange, but they are not hashed in the current schema.

### 7.3 Rate limiting on auth endpoints

Auth endpoints are high-value targets for brute-force and enumeration
attacks. Separate rate limits from the existing page-creation limiter:

| Endpoint              | Limit        | Window  | Key                |
| --------------------- | ------------ | ------- | ------------------ |
| `POST /oauth/register`| 10 per IP    | 1 hour  | IP                 |
| `POST /oauth/token`   | 20 per IP    | 1 min   | IP                 |
| `POST /oauth/magic/send` | 5 per email, 10 per IP, 50 per API process | 15 min | Email + IP + provider bucket |
| `GET /oauth/authorize`| 30 per IP    | 1 min   | IP                 |

These are in-process (same `RateLimiter` class from
`apps/api/mcp/rate-limit.ts`), which is acceptable for the single-
instance deployment. If we scale horizontally, these move to
Redis/Upstash.

Production rate-limit identity uses Railway's `X-Real-IP` header. The runtime
accepts it only when `TRUSTED_PROXY_MODE=railway`; missing, repeated, or
non-IP values use the shared anonymous bucket, and `X-Forwarded-For` is
ignored. Staging must confirm traffic cannot bypass Railway ingress before
enabling that mode.

### 7.4 CSRF protection

- **OAuth flows:** CSRF is mitigated by the `state` parameter (MCP
  clients generate it, Pagent echoes it back), PKCE (the code verifier is
  never exposed to the browser), and a Pagent-issued HttpOnly transaction
  cookie whose hash is carried in signed state. Normal client callbacks and
  Magic Link completion require both explicit consent and that same browser
  transaction before user mutation or authorization-code issuance.
- **Session cookies:** `SameSite=Lax` prevents CSRF on state-changing
  requests (POST). The renderer and API are on different origins
  (`pagent.link` vs `api.pagent.link`), but `SameSite=Lax` allows
  top-level navigations (GET) while blocking cross-origin POST.
- **Logout:** `POST /auth/logout` requires the session cookie and is
  protected by `SameSite=Lax`.

### 7.5 Open redirect prevention

The `redirect_uri` in the authorize request is validated against the
client's registered `redirect_uris` array. Exact string match — no
wildcards, no pattern matching. Remote web redirects must use HTTPS; HTTP is
limited to explicit loopback hosts, and browser-executable schemes are
rejected. The policy is enforced at registration and again at authorize and
callback time so legacy rows cannot bypass it.

### 7.6 Email enumeration

The Magic Link flow does not query or reveal prior registration. Every
syntactically valid email address follows the same link-creation, delivery,
and accepted-response path. A user row is upserted only after the browser-bound
link is successfully redeemed.

### 7.7 Google OAuth state parameter

The `state` parameter sent to Google encodes the authorize context as a signed
JWT (HMAC-SHA256 with a server-side secret). The signature prevents tampering
with the redirect URI, PKCE challenge, consent decision, or browser-transaction
hash. The signed state is not treated as confidential or sufficient by itself:
the callback must also match the hash of the HttpOnly browser transaction
cookie before any user mutation or authorization-code issuance.

## 8. Migration plan

### 8.1 Phase 1: Schema + endpoints (auth optional)

1. Add all auth tables to `db/connection.ts`'s `init()` via `CREATE TABLE IF
   NOT EXISTS`. Add `owner_id` column to `pages` via `ALTER TABLE ... ADD
   COLUMN IF NOT EXISTS`. Family-ID defaults are installed before backfill and
   `NOT NULL` enforcement, and the backfill/constraint step is serialized by
   a transaction advisory lock so old replicas can keep inserting during a
   rolling deploy. Legacy authorization codes without a recoverable family
   are marked consumed; legacy refresh rows are assigned an ID and revoked.
   Both cases force one-time reauthentication rather than weakening replay
   containment.
2. Deploy all OAuth and auth endpoints.
3. `REQUIRE_AUTH` defaults to `false`. Everything works exactly as
   before — no user needs to log in, pages are created without owners.
4. Pages created by authenticated users get `owner_id` set; pages
   created by unauthenticated users get `owner_id = NULL`.

### 8.2 Phase 2: Grace period (auth encouraged)

1. Add the renderer's "Sign in" option, browser-session initiation, and
   credentialed `/auth/me` integration. These UI/CORS pieces are not shipped
   yet; the API endpoints and callback/session machinery are already present.
2. MCP clients that support OAuth (e.g. Claude Code with the MCP SDK)
   will go through the auth flow on first connect. MCP clients that
   don't support OAuth continue to work (the `/mcp` endpoint returns
   MCP responses, not 401).
3. Anonymous `POST /new` and `GET /:id/result` requests continue to work.
   A client that supplies a valid Bearer token must still have the matching
   route scope; under-scoped Bearer requests return 403 rather than falling
   back to anonymous access.
4. Monitor: what percentage of pages have `owner_id IS NOT NULL`?

### 8.3 Phase 3: Auth required

1. Set `REQUIRE_AUTH=true` in Railway.
2. `POST /new`, `GET /:id/result`, and `POST /mcp` return 401 without a
   valid authenticated identity. Bearer calls also require their route or
   tool scope.
3. Unauthenticated `GET /:id` access still works — pages are accessed by
   unguessable ID. Browser submissions to `POST /:id/result` also remain
   public.
4. The stdio MCP server (`apps/mcp`) now needs to send Bearer tokens
   with its HTTP requests to `SERVICE_URL`. The user provides their
   token via the `PAGENT_TOKEN` env var (or the SDK handles the OAuth
   flow).

### 8.4 Backward compatibility guarantees

| Behavior                                      | During grace period | After REQUIRE_AUTH=true |
| --------------------------------------------- | ------------------- | ----------------------- |
| `POST /new` without auth                      | Works (owner=NULL)  | 401                     |
| `POST /new` with under-scoped valid Bearer    | 403                 | 403                     |
| `GET /:id` without auth                       | Works               | Works                   |
| `GET /:id/result` without auth                | Works               | 401                     |
| `GET /:id/result` with under-scoped Bearer    | 403                 | 403                     |
| `POST /:id/result` without auth               | Works               | Works                   |
| `POST /mcp` without Bearer                    | Works               | 401 with discovery      |
| Existing pages (`owner_id = NULL`) via page URL | Readable          | Readable                |

## 9. Environment variables

New environment variables for the API (`apps/api`):

| Variable                    | Required   | Default                              | Description                                                        |
| --------------------------- | ---------- | ------------------------------------ | ------------------------------------------------------------------ |
| `PUBLIC_URL`                | Production | -                                    | HTTPS renderer origin used in generated page URLs                  |
| `API_PUBLIC_URL`            | Production | -                                    | HTTPS API origin used for OAuth issuer, callbacks, and magic links |
| `ALLOWED_ORIGINS`           | Production | -                                    | Comma-separated CORS allow-list                                    |
| `TRUSTED_PROXY_MODE`        | Production | -                                    | Must be `railway`; trusts Railway's `X-Real-IP` and ignores `X-Forwarded-For` |
| `REQUIRE_AUTH`              | No         | `false`                              | If `true`, page creation, result reads, and MCP require auth       |
| `JWT_SIGNING_KEY`           | Yes*       | -                                    | Ed25519 private key, base64url-encoded (DER)                       |
| `JWT_PUBLIC_KEY`            | Yes*       | -                                    | Ed25519 public key, base64url-encoded (DER)                        |
| `GOOGLE_CLIENT_ID`          | No         | -                                    | Google OAuth 2.0 client ID; Google sign-in is hidden when unset    |
| `GOOGLE_CLIENT_SECRET`      | No         | -                                    | Google OAuth 2.0 client secret; set together with the client ID    |
| `GOOGLE_REDIRECT_URI`       | No         | `{API_PUBLIC_URL}/oauth/callback/google` | Google OAuth callback URI                                      |
| `AUTH_STATE_SECRET`         | Yes*       | -                                    | OAuth state HMAC secret; at least 32 UTF-8 bytes                   |
| `SESSION_MAX_AGE_DAYS`      | No         | `30`                                 | Session cookie lifetime in days                                    |
| `REFRESH_TOKEN_MAX_DAYS`    | No         | `90`                                 | Refresh token lifetime in days                                     |
| `ACCESS_TOKEN_TTL_SECONDS`  | No         | `3600`                               | JWT access token lifetime in seconds                               |
| `SMTP_HOST`                 | Yes*       | -                                    | SMTP server for magic link emails                                  |
| `SMTP_PORT`                 | No         | `587`                                | SMTP port                                                          |
| `SMTP_USER`                 | Yes*       | -                                    | SMTP username                                                      |
| `SMTP_PASS`                 | Yes*       | -                                    | SMTP password                                                      |
| `SMTP_FROM`                 | No         | `noreply@pagent.link`                | From address for magic link emails                                 |

*Required when `REQUIRE_AUTH=true`. Google OAuth is an optional provider;
email magic links remain available without it. Production additionally requires
`PUBLIC_URL`, `API_PUBLIC_URL`, `ALLOWED_ORIGINS`, and
`TRUSTED_PROXY_MODE=railway`; both public URLs must be HTTPS origins. Magic
links are random opaque tokens stored as hashes and do not use a separate
`MAGIC_LINK_SECRET`.

New environment variable for the stdio MCP (`apps/mcp`):

| Variable       | Required | Default | Description                                      |
| -------------- | -------- | ------- | ------------------------------------------------ |
| `PAGENT_TOKEN` | No       | -       | Pre-obtained Bearer token for authenticated API   |

### Schema validation

The existing `envSchema` in `schemas.ts` is extended:

```ts
// Explicit parsing is required because Boolean("false") is true.
REQUIRE_AUTH: z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) =>
    typeof value === 'boolean' ? value : value === 'true' || value === '1',
  ),
API_PUBLIC_URL: z.string().url().optional(),
JWT_SIGNING_KEY: z.string().optional(),
JWT_PUBLIC_KEY: z.string().optional(),
GOOGLE_CLIENT_ID: z.string().optional(),
GOOGLE_CLIENT_SECRET: z.string().optional(),
GOOGLE_REDIRECT_URI: z.string().url().optional(),
AUTH_STATE_SECRET: z.string().optional(),
SESSION_MAX_AGE_DAYS: z.coerce.number().int().positive().optional().default(30),
REFRESH_TOKEN_MAX_DAYS: z.coerce.number().int().positive().optional().default(90),
ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().optional().default(3600),
SMTP_HOST: z.string().optional(),
SMTP_PORT: z.coerce.number().int().optional().default(587),
SMTP_USER: z.string().optional(),
SMTP_PASS: z.string().optional(),
SMTP_FROM: z.string().email().optional().default('noreply@pagent.link'),
```

With a `superRefine` that ensures the crypto/SMTP vars are present when
`REQUIRE_AUTH=true`.

## 10. Dependencies

New npm packages for `@pagent/api`:

| Package         | Version | Purpose                                           |
| --------------- | ------- | ------------------------------------------------- |
| `jose`          | `^6.x`  | JWT signing, verification, JWK/JWKS, Ed25519      |
| `nodemailer`    | `^10.x` | Sending magic link emails via SMTP                 |

**Why `jose`?** The `jose` library is the standard choice for JWT in
Node.js. It supports Ed25519 natively, has zero dependencies, handles
JWK/JWKS serialization, and is maintained by the author of the
`openid-client` library.

**Why not `jsonwebtoken`?** It doesn't support Ed25519/EdDSA. It
also has a `node-jws` dependency chain that is heavier than `jose`.

**Why `nodemailer`?** It is the de facto standard for sending email
from Node.js. Supports SMTP, has TypeScript types, and is well-
maintained.

No new packages for `@pagent/web` (the renderer). The login page is
server-rendered by the API. A future renderer integration will call
`/auth/me` with credentials so the browser attaches the `HttpOnly` session
cookie; renderer JavaScript must not read the cookie directly.

No new packages for `@pagent/mcp` (the stdio server). It sends Bearer
tokens read from `PAGENT_TOKEN` in its existing `fetch` calls.

### MCP SDK usage

The auth implementation uses these SDK exports:

| Export                          | From                                             | Usage                                     |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| `StreamableHTTPServerTransport` | `@modelcontextprotocol/sdk/server/streamableHttp` | Runs the stateless `/mcp` HTTP transport  |
| `AuthInfo`                      | `@modelcontextprotocol/sdk/server/auth/types`     | Types the verified `req.auth` information |

Pagent does not mount the SDK's Express auth router or bearer middleware.
Hono serves the OAuth and discovery routes, while the raw MCP handler verifies
the Bearer token directly and supplies the SDK transport with `req.auth`.

## File layout

The implemented auth module is split by responsibility:

```
apps/api/auth/
  provider.ts        # public provider-function facade
  auth-code-provider.ts
  token-provider.ts
  user-provider.ts
  clients-store.ts   # Postgres-backed dynamic clients
  jwt.ts             # JWT signing, verification, JWKS
  middleware.ts      # Hono resolveAuth() + requireAuth() middleware
  magic-link.ts      # Magic link generation, validation, email sending
  google.ts          # Google OAuth helper (redirect URL builder, token exchange)
  login-page.ts      # Server-rendered HTML login page
  routes.ts          # composes route-discovery/consent/login/magic/session/token
  session.ts         # Session create/validate/delete helpers
```

Tests follow the same split rather than a monolithic provider/routes suite:

```
apps/api/auth/
  jwt.test.ts
  middleware.resolve.test.ts
  middleware.require.test.ts
  provider.exchange.test.ts
  provider.refresh.test.ts
  provider.revoke.test.ts
  routes-browser-session.test.ts
  routes-discovery.test.ts
  routes-register.test.ts
  routes-revoke.test.ts
  routes-session.test.ts
  routes-token.test.ts
  session.test.ts
```

## Decisions summary

| Decision                               | Chosen                                            | Rejected                                           |
| -------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| Auth provider                          | Custom (Postgres-backed)                          | Clerk, Auth0, Supabase Auth                        |
| AS/RS co-hosting                       | Same origin                                       | Separate AS service                                |
| JWT algorithm                          | EdDSA (Ed25519)                                   | RS256, HS256, ES256                                |
| JWT library                            | `jose`                                            | `jsonwebtoken` (no Ed25519)                        |
| Access token format                    | JWT (self-contained)                              | Opaque (requires DB lookup per request)            |
| Refresh token format                   | Opaque (SHA-256 stored)                           | JWT (no revocation benefit)                        |
| PKCE method                            | S256 only                                         | S256 + plain                                       |
| Session storage                        | DB-backed (Postgres)                              | JWT cookies, Redis                                 |
| Identity providers                     | Google + Magic Link                               | GitHub, Apple, SMS OTP                             |
| Login page rendering                   | Server-rendered HTML                              | Vite SPA route, separate frontend                  |
| Express for SDK auth middleware        | No (Hono-native implementation)                   | Mount Express alongside Hono                       |
| Auth enforcement                       | Env var toggle (`REQUIRE_AUTH`)                    | Compile-time flag, gradual rollout via feature flag |
| Page read auth                         | None (unguessable ID is sufficient)               | Require auth for all reads                         |
| Token revocation (V1)                  | Short TTL (1h); no revocation list                | JTI blacklist in DB/Redis                          |
| Refresh token rotation                 | Rotate on every use + family revocation           | Reuse until expiry                                 |
| Email for magic links                  | SMTP via `nodemailer`                             | SendGrid, Resend, AWS SES SDK                      |

## Open questions

None blocking implementation. Future considerations:

- **Additional identity providers** (GitHub, Apple) — straightforward
  to add as additional handlers in the Google OAuth pattern. Defer
  until user demand signals which ones matter.
- **Token revocation list** — if the 1-hour JWT lifetime proves too
  long for abuse response, add a `jti` blacklist (small in-memory set
  with TTL sync from DB). The JWT `jti` claim is already present.
- **Rate limiter persistence** — in-memory rate limiters reset on
  deploy. If auth endpoint abuse becomes a real signal, move to
  Redis/Upstash.
- **SMTP provider** — `nodemailer` with raw SMTP is the simplest start.
  If deliverability becomes an issue, swap to Resend or SendGrid (the
  `magic-link.ts` module abstracts the transport).
- **Account linking** — Google identities are never auto-linked to an
  email-only account. Add an authenticated, explicit linking UI before allowing
  a Magic Link user to attach a Google subject.
- **Admin endpoints** — user management, client management, session
  revocation. Deferred to V2.
