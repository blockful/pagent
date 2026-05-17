/**
 * OAuth discovery / metadata endpoints.
 *
 * The three .well-known routes MCP clients and OAuth tools probe to find
 * the authorization server. All public — no auth middleware, no rate limit.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §3.1, §3.2, §5.3.
 * RFCs: 8414 (AS metadata), 9728 (Protected Resource metadata), 7517 (JWKS).
 */
import { Hono } from 'hono';
import { getIssuer, getJwks } from './jwt.ts';

// Pagent ships exactly three OAuth scopes. Listed in both metadata documents
// so MCP clients can decide what to request without parsing the JWT itself.
const SCOPES_SUPPORTED = ['page:create', 'page:read', 'page:write'] as const;

// README link returned in both `service_documentation` and
// `resource_documentation`. Stable URL, doesn't depend on PUBLIC_URL.
const DOCS_URL = 'https://github.com/anthropics/agent-ui-session#readme';

export const authRoutes = new Hono();

// --- AS metadata (RFC 8414) --------------------------------------------------
// Every endpoint URL is derived from PUBLIC_URL via getIssuer() — never
// hardcode api.pagent.link. getIssuer() reads env on every call so a test
// or future config-reload can mutate PUBLIC_URL and observe the change.

authRoutes.get('/.well-known/oauth-authorization-server', (c) => {
  const issuer = getIssuer();
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Public clients only — MCP clients can't keep a secret. Matches spec §3.3.
    token_endpoint_auth_methods_supported: ['none'],
    // S256 only; `plain` is explicitly excluded per the task and PKCE best
    // practice (RFC 7636 §4.2 recommends S256 wherever the client can do it).
    code_challenge_methods_supported: ['S256'],
    scopes_supported: SCOPES_SUPPORTED,
    service_documentation: DOCS_URL,
  });
});

// --- Protected Resource metadata (RFC 9728) ---------------------------------
// MCP clients fetch this after a 401 on /mcp to learn which AS to ask. Since
// pagent co-hosts AS and RS, `resource` and `authorization_servers[0]` are
// the same URL — both derive from PUBLIC_URL.

authRoutes.get('/.well-known/oauth-protected-resource', (c) => {
  const resource = getIssuer();
  return c.json({
    resource,
    authorization_servers: [resource],
    scopes_supported: SCOPES_SUPPORTED,
    // Header-only — query/body bearer methods are deprecated (RFC 6750 §2.2,
    // 2.3) and we don't accept them on /mcp.
    bearer_methods_supported: ['header'],
    resource_name: 'Pagent API',
    resource_documentation: DOCS_URL,
  });
});

// --- JWKS (RFC 7517) ---------------------------------------------------------
// The Ed25519 public key that signs access tokens. Resource servers fetch
// this to verify token signatures. getJwks() returns the cached JWK built at
// initKeys() time — no I/O. Throws if initKeys() never ran; the global
// error handler in app.ts surfaces that as a 500 with a request_id.

authRoutes.get('/.well-known/jwks.json', (c) => {
  return c.json(getJwks());
});
