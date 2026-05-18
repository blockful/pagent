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
import { InvalidClientMetadataError, getClient, registerClient } from './clients-store.ts';
import { exchangeGoogleCode } from './google.ts';
import { getIssuer, getJwks } from './jwt.ts';
import { renderLoginPage } from './login-page.ts';
import { createAuthCode, upsertUser } from './provider.ts';
import { signStateJwt, verifyStateJwt } from './state-jwt.ts';

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

// --- GET /oauth/authorize ---------------------------------------------------
// Login page. Per spec §3.4: validates the authorize request parameters
// (client_id, redirect_uri exact match, PKCE), then renders an HTML page
// with "Continue with Google" + magic-link form. Errors are shown on the
// page itself (not redirected) per OAuth 2.1 §4.1.2.1 — we only redirect to
// `redirect_uri` if we trust it.
//
// browser_session=1 is the renderer/dashboard path: no client_id required,
// the rendered page leads to a session cookie instead of an auth code.
// Rate-limited at 30/IP/min per spec §7.3.

const AUTHORIZE_WINDOW_MS = 60 * 1000; // 1 minute
const AUTHORIZE_LIMIT = 30;
const AUTHORIZE_RETRY_AFTER_SECONDS = Math.ceil(AUTHORIZE_WINDOW_MS / 1000);

const authorizeLimiter = rateLimiter({
  windowMs: AUTHORIZE_WINDOW_MS,
  limit: AUTHORIZE_LIMIT,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => clientKey(c.req.header('x-forwarded-for')),
  handler: (c) => {
    c.header('Retry-After', String(AUTHORIZE_RETRY_AFTER_SECONDS));
    return c.json(
      {
        error: 'rate_limited',
        retry_after_seconds: AUTHORIZE_RETRY_AFTER_SECONDS,
        message: `Too many authorize requests from this IP; retry after ${AUTHORIZE_RETRY_AFTER_SECONDS} seconds`,
      },
      429,
    );
  },
});

/**
 * Render the login page with an error banner. The state JWT is omitted on
 * hard errors (invalid client_id / redirect_uri) so the user can't proceed
 * — there's no recoverable flow to resume.
 */
async function renderError(c: Context, message: string, status: 400 | 503 = 400) {
  return c.html(renderLoginPage({ error: message }), status);
}

authRoutes.get('/oauth/authorize', authorizeLimiter, async (c) => {
  const query = c.req.query();

  // Browser-session path: no PKCE / client validation. Just stamp a state JWT
  // and render the login page so the user can pick a provider.
  if (query.browser_session === '1') {
    const signedState = await signStateJwt({ browserSession: true });
    return c.html(renderLoginPage({ signedState }));
  }

  // MCP-client path: every PKCE-relevant parameter is required. Surface a
  // clean error on the login page itself when something's missing — the
  // caller likely supplied a typo and a 400 with an explanation is more
  // useful than a redirect-with-error to an untrusted URI.
  const { client_id, redirect_uri, code_challenge, code_challenge_method, scope, state } = query;

  if (typeof client_id !== 'string' || client_id.length === 0) {
    return renderError(c, 'Missing required parameter: client_id');
  }
  if (typeof redirect_uri !== 'string' || redirect_uri.length === 0) {
    return renderError(c, 'Missing required parameter: redirect_uri');
  }
  if (typeof code_challenge !== 'string' || code_challenge.length === 0) {
    return renderError(c, 'Missing required parameter: code_challenge');
  }
  // S256-only — `plain` is explicitly excluded per AS metadata + RFC 7636
  // §4.2 (S256 is mandatory wherever the client can do it; modern MCP
  // clients can).
  if (code_challenge_method !== 'S256') {
    return renderError(c, 'code_challenge_method must be S256');
  }

  const client = await getClient(client_id);
  if (!client) {
    return renderError(c, 'Unknown client_id');
  }
  // Exact string match — spec §7.5 (Open redirect prevention). No wildcards,
  // no host-only matching, no scheme tolerance.
  if (!client.redirect_uris.includes(redirect_uri)) {
    return renderError(c, 'redirect_uri does not match a registered URI for this client');
  }

  const signedState = await signStateJwt({
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    scope: typeof scope === 'string' && scope.length > 0 ? scope : undefined,
    state: typeof state === 'string' && state.length > 0 ? state : undefined,
  });
  return c.html(renderLoginPage({ signedState }));
});

// --- GET /oauth/callback/google ---------------------------------------------
// Google's redirect after the user grants/denies consent. We:
//   1. Verify the state JWT (rejects tampering, replay, expiry).
//   2. Exchange Google's code for an ID token, decode the claims.
//   3. Upsert the user by email, generating a handle on first sight.
//   4. Mint a Pagent authorization code bound to the original PKCE challenge.
//   5. 302 to the MCP client's redirect_uri with code+state.
//
// Browser-session callbacks (state encoded `browser_session: true`) are not
// yet handled — Task 06 introduces session cookies. For now the
// browser_session path falls through to an error render.

authRoutes.get('/oauth/callback/google', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (typeof code !== 'string' || code.length === 0) {
    return renderError(c, 'Google callback missing code parameter');
  }
  if (typeof state !== 'string' || state.length === 0) {
    return renderError(c, 'Google callback missing state parameter');
  }

  // verifyStateJwt throws on tamper/expiry/wrong-iss-aud. The catch maps
  // every failure mode to a single user-facing message — distinguishing
  // them would leak verification details and isn't actionable for the user
  // (their only recourse is to restart from the MCP client).
  let claims: Awaited<ReturnType<typeof verifyStateJwt>>;
  try {
    claims = await verifyStateJwt(state);
  } catch {
    return renderError(c, 'Authorization session expired or invalid. Please restart sign-in.');
  }

  if (claims.browserSession) {
    // Task 06 will issue a session cookie here. For now, surface a clear
    // error so deployment of this task doesn't silently break the browser
    // flow path that Task 06 will complete.
    return renderError(c, 'Browser session login is not yet supported.');
  }

  // Validate the resumed claims — they were signed by us 15 minutes ago but
  // the client could have been deleted in between, or the redirect_uri
  // could have changed (we re-validate to defend against that edge case).
  if (!claims.clientId || !claims.redirectUri || !claims.codeChallenge) {
    return renderError(c, 'Authorization state missing required fields.');
  }
  const client = await getClient(claims.clientId);
  if (!client || !client.redirect_uris.includes(claims.redirectUri)) {
    return renderError(c, 'Client registration changed during sign-in. Please restart.');
  }

  // Exchange + upsert. Surface a single generic message if Google rejects
  // the code (typically: stale or already-used) — the verbose error from
  // exchangeGoogleCode is logged via the global error handler when it
  // throws, but we don't want to echo Google's internals to end users.
  let profile: Awaited<ReturnType<typeof exchangeGoogleCode>>;
  try {
    profile = await exchangeGoogleCode(code);
  } catch {
    return renderError(c, 'Google sign-in failed. Please try again.');
  }

  const user = await upsertUser({
    email: profile.email,
    name: profile.name,
    avatarUrl: profile.picture,
  });

  // Issue the Pagent authorization code with the original PKCE challenge.
  // The token endpoint (Task 06) will require the code_verifier matching
  // this code_challenge before issuing access/refresh tokens.
  const pagentCode = await createAuthCode(
    user.id,
    claims.clientId,
    claims.redirectUri,
    claims.codeChallenge,
    'S256',
    claims.scope ?? null,
  );

  // Build the final redirect: redirect_uri?code=...&state=...
  // (state is the MCP client's original CSRF state, not our internal JWT —
  // they decode it back to recognize the response as theirs.)
  const target = new URL(claims.redirectUri);
  target.searchParams.set('code', pagentCode);
  if (claims.state) target.searchParams.set('state', claims.state);
  return c.redirect(target.toString(), 302);
});
