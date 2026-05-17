# Auth — Design

Status: draft, awaiting user review (2026-05-17).

## 1. Overview and motivation

Pagent has no authentication. Every page is anonymous, every API call is
unauthenticated, and every MCP tool invocation is unguarded. This was
acceptable for an MVP where the blast radius of abuse is capped by the
30-minute TTL and per-IP rate limits, but it blocks every feature on the
V2 roadmap: page ownership, user dashboards, audit logs, custom URLs,
webhooks — all require a notion of "who."

This spec introduces:

- **Users** — identified by email, created via Google OAuth or Magic
  Link (passwordless email).
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
already ships `mcpAuthRouter`, `requireBearerAuth`, and
`OAuthServerProvider` — implementing the provider interface against
Postgres is less work than adapting an external service to satisfy it.

## 2. Database schema

All tables live in the existing Supabase Postgres database. Schema
bootstrap follows the same pattern as the existing `pages` table:
`CREATE TABLE IF NOT EXISTS` in `db.ts`'s `init()`, run on every boot,
idempotent.

### 2.1 `users`

```sql
CREATE TABLE IF NOT EXISTS users (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  handle     text        UNIQUE,          -- nullable: set during onboarding (Custom URLs feature), not at creation
  email      text        UNIQUE NOT NULL,
  name       text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_idx ON users (lower(handle));
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
`expires_at` by 30 days. A TTL sweep (same pattern as the existing page
sweep) reaps expired rows.

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
  token_hash text        NOT NULL UNIQUE,
  scope      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);
```

`token_hash` stores `SHA-256(raw_refresh_token)`. Like session tokens,
the raw value is never stored server-side. On rotation the old row gets
`revoked_at = now()` and a new row is inserted. If a revoked token is
presented, all refresh tokens for that `(user_id, client_id)` pair are
revoked (token family revocation — defense against stolen refresh
tokens per OAuth 2.1 Section 6.1).

### 2.6 `magic_links`

Passwordless email login tokens. Short-lived (15 minutes).

```sql
CREATE TABLE IF NOT EXISTS magic_links (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text        NOT NULL,
  token_hash text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS magic_links_expires_at_idx ON magic_links (expires_at);
```

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
  "scopes_supported": ["page:create", "page:read", "page:write"],
  "service_documentation": "https://github.com/anthropics/agent-ui-session#readme"
}
```

This endpoint is served by the MCP SDK's `mcpAuthRouter` or manually
if we need to customize. It MUST be public (no auth required).

### 3.2 Protected Resource metadata (RFC 9728)

```
GET /.well-known/oauth-protected-resource
```

**Response** `200 application/json`:

```json
{
  "resource": "https://api.pagent.link",
  "authorization_servers": ["https://api.pagent.link"],
  "scopes_supported": ["page:create", "page:read", "page:write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Pagent API",
  "resource_documentation": "https://github.com/anthropics/agent-ui-session#readme"
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

This endpoint serves a login page. The login page is a minimal HTML
page (server-rendered, not the Vite SPA) with two options:

1. **"Continue with Google"** — redirects to Google's OAuth consent
   screen with Pagent as the relying party.
2. **"Sign in with email"** — shows an email input. On submit, sends a
   Magic Link email and shows a "check your email" message.

After successful authentication (Google callback or Magic Link click),
the server:

1. Upserts the user in the `users` table (create on first login, update
   `name`/`avatar_url` on subsequent logins).
2. Generates an authorization code.
3. Redirects to `redirect_uri?code=...&state=...`.

If the request came from a browser session (not an MCP client), the
server also sets a session cookie.

**Error cases:**

| Status | Error                  | When                                              |
| ------ | ---------------------- | ------------------------------------------------- |
| 400    | `invalid_request`      | Missing required parameters                        |
| 400    | `invalid_client`       | `client_id` not found                              |
| 400    | `invalid_redirect_uri` | `redirect_uri` not in client's registered URIs     |

Errors on the authorize endpoint are shown on the login page itself
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

| Status | Error                  | When                                              |
| ------ | ---------------------- | ------------------------------------------------- |
| 400    | `invalid_grant`        | Code expired, already consumed, or verifier fails  |
| 400    | `invalid_client`       | `client_id` not found or mismatch                  |
| 400    | `invalid_request`      | Missing required parameters                        |
| 400    | `unsupported_grant_type` | Not `authorization_code` or `refresh_token`      |
| 429    | `rate_limited`         | Too many token requests                            |

### 3.6 Token revocation (RFC 7009)

```
POST /oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=...&
token_type_hint=refresh_token&
client_id=...
```

**Response** `200` (always — per RFC 7009, even if the token was already
revoked or invalid).

### 3.7 Google OAuth callback (internal)

```
GET /oauth/callback/google?code=...&state=...
```

Internal endpoint. Not part of the public OAuth contract. Receives the
authorization code from Google, exchanges it for user info, upserts the
user, then redirects back into the Pagent authorize flow (issues a
Pagent auth code and redirects to the MCP client's `redirect_uri`).

### 3.8 Magic Link verification (internal)

```
GET /oauth/magic?token=...
```

Internal endpoint. When the user clicks the link in their email, this
endpoint validates the token, upserts the user, and redirects back into
the Pagent authorize flow.

### 3.9 Browser session endpoints

These are for the web renderer and future dashboard, not for MCP
clients.

```
POST /auth/logout
Cookie: pagent_session=...
```

Deletes the session row and clears the cookie.

```
GET /auth/me
Cookie: pagent_session=...
```

Returns the current user's profile. Used by the renderer to show a
logged-in state.

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
    │    client_id=...&           │                         │
    │    code_challenge=...&      │                         │
    │    redirect_uri=            │                         │
    │    http://localhost:PORT/   │                         │
    │    callback&state=...       │                         │
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
    │  (login page shown)   │                           │
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

This is a signed, encrypted JWT (JWE) to prevent tampering. It is
short-lived (15 min) and single-use.

### 4.3 Magic Link flow

```
User Browser           Pagent API                  Email Service
    │                       │                           │
    │  GET /oauth/authorize │                           │
    │  (login page shown)   │                           │
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

The Magic Link email includes the full authorize context (client_id,
redirect_uri, code_challenge, scope, state) encoded in the magic link
URL or stored server-side keyed by the magic link token. Server-side
storage is preferred — it keeps the email link shorter and avoids
leaking OAuth parameters in email logs.

### 4.4 Browser session flow (renderer / dashboard)

For browser-based access (the renderer, a future dashboard), users
authenticate via the same `/oauth/authorize` login page. After
authentication, in addition to issuing an auth code for the OAuth flow,
the server sets an httpOnly session cookie:

```
Set-Cookie: pagent_session=<random-128-bit-hex>;
  HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
```

The cookie is set only when the authorize request comes from a
browser context (detected by the presence of a session-initiating query
parameter `browser_session=1` or by the absence of a registered
`client_id` — the renderer doesn't register as an OAuth client, it just
needs a session).

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

**Token family revocation:** If a revoked refresh token is presented,
all refresh tokens for that `(user_id, client_id)` pair are revoked
immediately. This detects token theft: the legitimate client used the
refresh token (rotating it), and now the attacker tries to use the old
one. Both parties lose their tokens, forcing re-authentication. This
follows OAuth 2.1 Section 6.1 guidance.

### 5.3 Signing key management

The Ed25519 key pair is stored as environment variables:

- `JWT_SIGNING_KEY` — the 64-byte Ed25519 private key, base64url-encoded.
- `JWT_PUBLIC_KEY` — the 32-byte Ed25519 public key, base64url-encoded.

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

The `OAuthTokenVerifier` implementation (for the MCP SDK's
`requireBearerAuth` middleware) validates JWTs locally:

```ts
class PagentTokenVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // 1. Decode and verify JWT signature (Ed25519)
    // 2. Check exp > now (reject expired)
    // 3. Check iss === expected issuer
    // 4. Check aud === expected audience
    // 5. Return AuthInfo { token, clientId, scopes, expiresAt, extra: { sub, email, handle } }
  }
}
```

No DB roundtrip on every request. The JWT is self-contained. The only
reason to hit the DB would be for revocation checks (checking `jti`
against a revocation list), which is deferred to V2 — the 1-hour
lifetime is the revocation mechanism for V1.

### 5.5 Scopes

| Scope          | Grants                                              |
| -------------- | --------------------------------------------------- |
| `page:create`  | `POST /new`, `show_ui`, `show_html` MCP tools       |
| `page:read`    | `GET /:id`, `GET /:id/result`, `check_result` tool  |
| `page:write`   | `POST /:id/result` (submit from browser)             |

Default scope (if none requested): `page:create page:read`. The
`page:write` scope is implicitly granted to session-cookie-authenticated
browser users (the renderer needs it to submit forms).

## 6. Middleware design

### 6.1 Architecture

Auth integrates into the existing Hono app and the raw Node HTTP MCP
handler via two middleware layers:

```
                            ┌─────────────────────────────────────┐
                            │         server.ts (Node HTTP)       │
                            │                                     │
  ┌─────────────────────┐   │  path = /mcp ?                     │
  │  MCP SDK auth       │◀──│  YES → mcpHandler (raw Node)       │
  │  requireBearerAuth  │   │        ↓                            │
  │  (Express compat)   │   │  bearerAuthMiddleware               │
  └─────────────────────┘   │        ↓                            │
                            │  StreamableHTTPServerTransport      │
                            │                                     │
  ┌─────────────────────┐   │  path != /mcp ?                    │
  │  Hono middleware     │◀──│  YES → Hono app                    │
  │  authMiddleware()    │   │        ↓                            │
  │  (cookie + Bearer)   │   │  resolve user from cookie or JWT   │
  └─────────────────────┘   │        ↓                            │
                            │  route handlers                     │
                            └─────────────────────────────────────┘
```

### 6.2 Hono auth middleware

New file: `apps/api/auth/middleware.ts`.

```ts
import type { Context, Next } from 'hono';

type AuthUser = {
  id: string;        // user UUID
  email: string;
  handle: string;
  authMethod: 'cookie' | 'bearer';
};

type AuthVariables = {
  user: AuthUser | null;
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
        return next();
      }
    }

    // Try Bearer token (API / MCP clients)
    const authHeader = c.req.header('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const user = await verifyJwt(token);
      if (user) {
        c.set('user', { ...user, authMethod: 'bearer' });
        return next();
      }
    }

    c.set('user', null);
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
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`
    );
    respondJson(res, 401, {
      error: 'unauthorized',
      message: 'Bearer token required',
    });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const authInfo = await tokenVerifier.verifyAccessToken(token);
    // Attach auth info for the transport
    (req as any).auth = authInfo;
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

// Conditionally require auth on mutation endpoints
if (env.REQUIRE_AUTH) {
  app.use('/new', requireAuth());
}
```

Read endpoints (`GET /:id`, `GET /:id/result`) remain public — pages
are accessed by their unguessable 128-bit ID. Ownership checks (e.g.,
"only the owner can delete") are deferred to V2 when we add
page-management endpoints.

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

Server-side, all secrets are stored as SHA-256 hashes — session tokens,
refresh tokens, magic link tokens, authorization codes. The raw values
exist only in transit (cookie, URL, email).

### 7.3 Rate limiting on auth endpoints

Auth endpoints are high-value targets for brute-force and enumeration
attacks. Separate rate limits from the existing page-creation limiter:

| Endpoint              | Limit        | Window  | Key                |
| --------------------- | ------------ | ------- | ------------------ |
| `POST /oauth/register`| 10 per IP    | 1 hour  | IP                 |
| `POST /oauth/token`   | 20 per IP    | 1 min   | IP                 |
| `POST /oauth/magic/send` | 5 per email | 15 min | Email              |
| `GET /oauth/authorize`| 30 per IP    | 1 min   | IP                 |

These are in-process (same `RateLimiter` class from
`apps/api/mcp/rate-limit.ts`), which is acceptable for the single-
instance deployment. If we scale horizontally, these move to
Redis/Upstash.

### 7.4 CSRF protection

- **OAuth flows:** CSRF is mitigated by the `state` parameter (MCP
  clients generate it, Pagent echoes it back) and PKCE (the code
  verifier is never exposed to the browser).
- **Session cookies:** `SameSite=Lax` prevents CSRF on state-changing
  requests (POST). The renderer and API are on different origins
  (`pagent.link` vs `api.pagent.link`), but `SameSite=Lax` allows
  top-level navigations (GET) while blocking cross-origin POST.
- **Logout:** `POST /auth/logout` requires the session cookie and is
  protected by `SameSite=Lax`.

### 7.5 Open redirect prevention

The `redirect_uri` in the authorize request is validated against the
client's registered `redirect_uris` array. Exact string match — no
wildcards, no pattern matching. This prevents an attacker from using
Pagent's authorize endpoint to redirect a user to a malicious site.

### 7.6 Email enumeration

The Magic Link flow does not reveal whether an email is registered.
Both "email found" and "email not found" show the same "check your
email" message. On the backend, if the email is not registered, no
email is sent (but the response is identical to avoid timing attacks —
add a small random delay to normalize response times).

### 7.7 Google OAuth state parameter

The `state` parameter sent to Google encodes the full authorize context
as a signed JWT (HMAC-SHA256 with a server-side secret). This prevents:
- Tampering with the redirect URI or code challenge during the Google
  round-trip.
- CSRF attacks on the Google callback (the state is unpredictable).

## 8. Migration plan

### 8.1 Phase 1: Schema + endpoints (auth optional)

1. Add all auth tables to `db.ts`'s `init()` via `CREATE TABLE IF NOT
   EXISTS`. Add `owner_id` column to `pages` via `ALTER TABLE ... ADD
   COLUMN IF NOT EXISTS`.
2. Deploy all OAuth and auth endpoints.
3. `REQUIRE_AUTH` defaults to `false`. Everything works exactly as
   before — no user needs to log in, pages are created without owners.
4. Pages created by authenticated users get `owner_id` set; pages
   created by unauthenticated users get `owner_id = NULL`.

### 8.2 Phase 2: Grace period (auth encouraged)

1. The renderer shows a "Sign in" option but doesn't require it.
2. MCP clients that support OAuth (e.g. Claude Code with the MCP SDK)
   will go through the auth flow on first connect. MCP clients that
   don't support OAuth continue to work (the `/mcp` endpoint returns
   MCP responses, not 401).
3. Monitor: what percentage of pages have `owner_id IS NOT NULL`?

### 8.3 Phase 3: Auth required

1. Set `REQUIRE_AUTH=true` in Railway.
2. `POST /new` and `POST /mcp` (for tool calls that create pages)
   return 401 without a valid token.
3. Unauthenticated read access (`GET /:id`, `GET /:id/result`) still
   works — pages are accessed by unguessable ID.
4. The stdio MCP server (`apps/mcp`) now needs to send Bearer tokens
   with its HTTP requests to `SERVICE_URL`. The user provides their
   token via the `PAGENT_TOKEN` env var (or the SDK handles the OAuth
   flow).

### 8.4 Backward compatibility guarantees

| Behavior                              | During grace period | After REQUIRE_AUTH=true |
| ------------------------------------- | ------------------- | ----------------------- |
| `POST /new` without auth              | Works (owner=NULL)  | 401                     |
| `GET /:id` without auth               | Works               | Works                   |
| `GET /:id/result` without auth        | Works               | Works                   |
| `POST /:id/result` without auth       | Works               | Works (cookie auth)     |
| `POST /mcp` without Bearer            | Works               | 401 with discovery      |
| Existing pages (owner_id=NULL)        | Readable            | Readable                |

## 9. Environment variables

New environment variables for the API (`apps/api`):

| Variable                   | Required | Default      | Description                                     |
| -------------------------- | -------- | ------------ | ----------------------------------------------- |
| `REQUIRE_AUTH`             | No       | `false`      | If `true`, mutation endpoints require auth       |
| `JWT_SIGNING_KEY`          | Yes*     | -            | Ed25519 private key, base64url-encoded (DER)     |
| `JWT_PUBLIC_KEY`           | Yes*     | -            | Ed25519 public key, base64url-encoded (DER)      |
| `GOOGLE_CLIENT_ID`        | Yes*     | -            | Google OAuth 2.0 client ID                       |
| `GOOGLE_CLIENT_SECRET`    | Yes*     | -            | Google OAuth 2.0 client secret                   |
| `GOOGLE_REDIRECT_URI`     | No       | `{PUBLIC_URL}/oauth/callback/google` | Google OAuth callback URI     |
| `MAGIC_LINK_SECRET`       | Yes*     | -            | HMAC key for signing magic link tokens           |
| `AUTH_STATE_SECRET`        | Yes*     | -            | HMAC key for signing OAuth state JWTs            |
| `SESSION_MAX_AGE_DAYS`    | No       | `30`         | Session cookie lifetime in days                  |
| `REFRESH_TOKEN_MAX_DAYS`  | No       | `90`         | Refresh token lifetime in days                   |
| `ACCESS_TOKEN_TTL_SECONDS`| No       | `3600`       | JWT access token lifetime in seconds             |
| `SMTP_HOST`               | Yes*     | -            | SMTP server for magic link emails                |
| `SMTP_PORT`               | No       | `587`        | SMTP port                                        |
| `SMTP_USER`               | Yes*     | -            | SMTP username                                    |
| `SMTP_PASS`               | Yes*     | -            | SMTP password                                    |
| `SMTP_FROM`               | No       | `noreply@pagent.link` | From address for magic link emails      |

*Required when `REQUIRE_AUTH=true` or when auth endpoints are
used. The API boots without them during the grace period (auth
endpoints return 503 "auth not configured").

New environment variable for the stdio MCP (`apps/mcp`):

| Variable       | Required | Default | Description                                      |
| -------------- | -------- | ------- | ------------------------------------------------ |
| `PAGENT_TOKEN` | No       | -       | Pre-obtained Bearer token for authenticated API   |

### Schema validation

The existing `envSchema` in `schemas.ts` is extended:

```ts
// Auth-related env vars — optional unless REQUIRE_AUTH is true
REQUIRE_AUTH: z.coerce.boolean().optional().default(false),
JWT_SIGNING_KEY: z.string().optional(),
JWT_PUBLIC_KEY: z.string().optional(),
GOOGLE_CLIENT_ID: z.string().optional(),
GOOGLE_CLIENT_SECRET: z.string().optional(),
GOOGLE_REDIRECT_URI: z.string().url().optional(),
MAGIC_LINK_SECRET: z.string().optional(),
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
| `nodemailer`    | `^6.x`  | Sending magic link emails via SMTP                 |

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
server-rendered by the API; the renderer only reads the session cookie.

No new packages for `@pagent/mcp` (the stdio server). It sends Bearer
tokens read from `PAGENT_TOKEN` in its existing `fetch` calls.

### MCP SDK usage

The auth implementation uses these existing SDK exports:

| Export                        | From                                          | Usage                                           |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------ |
| `OAuthServerProvider`         | `@modelcontextprotocol/sdk/server/auth/provider` | Interface — implement for Pagent's Postgres store |
| `OAuthRegisteredClientsStore` | `@modelcontextprotocol/sdk/server/auth/clients`  | Interface — implement for `oauth_clients` table   |
| `mcpAuthRouter`               | `@modelcontextprotocol/sdk/server/auth/router`   | Express router for AS metadata + endpoints        |
| `requireBearerAuth`           | `@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth` | Express middleware for /mcp auth   |
| `AuthInfo`                    | `@modelcontextprotocol/sdk/server/auth/types`    | Type for verified token info                      |

**Important:** The SDK's `mcpAuthRouter` and `requireBearerAuth` are
Express middleware. Since Pagent's MCP handler already bypasses Hono
and writes directly to Node's `IncomingMessage`/`ServerResponse`,
Express compatibility is straightforward — Express middleware works on
raw Node HTTP objects. For the well-known metadata endpoints, we have
two options:

1. **Use the SDK's Express router** — mount it on a minimal Express app
   that handles only `/.well-known/*` and `/oauth/*`, multiplexed in
   `server.ts` alongside the Hono listener and MCP handler.
2. **Implement the metadata endpoints in Hono directly** — serve the
   JSON responses from Hono routes, which avoids adding Express as a
   dependency.

Option 2 is preferred. The metadata endpoints are static JSON — there
is no benefit to pulling in Express just to serve two `GET` routes. The
`mcpAuthRouter`'s real value is in the `/oauth/register`,
`/oauth/authorize`, and `/oauth/token` handlers, which implement
non-trivial OAuth logic. We implement those ourselves using Hono routes
backed by the `OAuthServerProvider` interface, keeping the provider
implementation (which is the complex part) reusable.

## File layout

New files under `apps/api/auth/`:

```
apps/api/auth/
  provider.ts        # OAuthServerProvider implementation (Postgres-backed)
  clients-store.ts   # OAuthRegisteredClientsStore implementation
  jwt.ts             # JWT signing, verification, JWKS
  middleware.ts      # Hono resolveAuth() + requireAuth() middleware
  magic-link.ts      # Magic link generation, validation, email sending
  google.ts          # Google OAuth helper (redirect URL builder, token exchange)
  login-page.ts      # Server-rendered HTML login page
  routes.ts          # Hono routes for /oauth/*, /auth/*, /.well-known/*
  session.ts         # Session create/validate/delete helpers
```

New files under `apps/api/auth/` tests:

```
apps/api/auth/
  jwt.test.ts
  middleware.test.ts
  provider.test.ts
  routes.test.ts
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
- **Account linking** — a user who first logs in via Magic Link and
  later via Google (same email) should be the same user. The `email`
  column's uniqueness constraint handles this: upsert on email. But
  there's no "link your Google account to your Magic Link account" UI
  yet.
- **Admin endpoints** — user management, client management, session
  revocation. Deferred to V2.
