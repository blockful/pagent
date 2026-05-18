/**
 * OAuth discovery / metadata endpoints + dynamic client registration.
 *
 * The three .well-known routes MCP clients and OAuth tools probe to find
 * the authorization server. All public — no auth middleware, no rate limit.
 *
 * POST /oauth/register implements RFC 7591 dynamic client registration so
 * MCP clients can self-register before the authorization code flow.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §3.1, §3.2, §3.3, §5.3.
 * RFCs: 7591 (Dynamic Client Registration), 8414 (AS metadata), 9728
 * (Protected Resource metadata), 7517 (JWKS).
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { clientKey } from '../client-key.ts';
import { InvalidClientMetadataError, registerClient } from './clients-store.ts';
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

// --- Dynamic client registration (RFC 7591) ---------------------------------
// MCP clients self-register before starting the authorization code flow.
// Rate-limited per IP (10/hour) — registration is cheap but unbounded growth
// would let an attacker fill oauth_clients with junk rows. The cap mirrors
// auth-design spec §7.3 (Rate limiting table) and is intentionally distinct
// from the POST /new bucket so heavy MCP traffic can't lock out
// registrations.

const REGISTER_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const REGISTER_LIMIT = 10;
const REGISTER_RETRY_AFTER_SECONDS = Math.ceil(REGISTER_WINDOW_MS / 1000);

const registerLimiter = rateLimiter({
  windowMs: REGISTER_WINDOW_MS,
  limit: REGISTER_LIMIT,
  // IETF draft-7 RateLimit-* headers (same as POST /new) so clients can
  // discover the budget without hard-coding it.
  standardHeaders: 'draft-7',
  // Same last-hop trust model as POST /new — see apps/api/client-key.ts.
  keyGenerator: (c: Context) => clientKey(c.req.header('x-forwarded-for')),
  handler: (c) => {
    c.header('Retry-After', String(REGISTER_RETRY_AFTER_SECONDS));
    return c.json(
      {
        error: 'rate_limited',
        retry_after_seconds: REGISTER_RETRY_AFTER_SECONDS,
        message: `Too many client registrations from this IP; retry after ${REGISTER_RETRY_AFTER_SECONDS} seconds`,
      },
      429,
    );
  },
});

authRoutes.post('/oauth/register', registerLimiter, async (c) => {
  // Parse-or-null is the same pattern as POST /new — gives us a single
  // explicit branch for malformed JSON before zod / validation runs.
  const raw = await c.req.json().catch(() => null);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return c.json(
      {
        error: 'invalid_client_metadata',
        error_description: 'request body must be a JSON object',
      },
      400,
    );
  }
  try {
    const client = await registerClient(raw);
    // RFC 7591 §3.2.1 — 201 Created with the client information document.
    return c.json(client, 201);
  } catch (err) {
    if (err instanceof InvalidClientMetadataError) {
      return c.json(
        { error: 'invalid_client_metadata', error_description: err.description },
        400,
      );
    }
    // Anything else (e.g. transient DB error after withRetry exhausts) bubbles
    // up to app.onError which surfaces a 500 with a request_id.
    throw err;
  }
});
