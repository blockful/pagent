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
import { RateLimiter } from '../mcp/rate-limit.ts';
import { env } from '../schemas.ts';
import { InvalidClientMetadataError, getClient, registerClient } from './clients-store.ts';
import { exchangeGoogleCode } from './google.ts';
import { getIssuer, getJwks } from './jwt.ts';
import { renderLoginPage } from './login-page.ts';
import {
  InvalidMagicLinkError,
  SmtpUnavailableError,
  sendMagicLink,
  verifyMagicLink,
} from './magic-link.ts';
import {
  TokenError,
  createAuthCode,
  exchangeAuthCode,
  refreshToken as providerRefreshToken,
  revokeToken,
  upsertUser,
} from './provider.ts';
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
      return c.json({ error: 'invalid_client_metadata', error_description: err.description }, 400);
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

// --- POST /oauth/magic/send -------------------------------------------------
// Magic Link send endpoint. Accepts a form-encoded or JSON body with `email`
// and the signed state JWT from the login page, validates the email format,
// decodes the state to extract the authorize context, then dispatches an
// email via nodemailer.
//
// Returns 200 with the same response shape regardless of whether the email
// is registered — anti-enumeration per spec §7.6. The same code path runs
// for new and returning users (magic link doubles as sign-up).
//
// Rate-limited at 5 / email / 15 min per spec §7.3. We use the local
// `RateLimiter` (not hono-rate-limiter's middleware) because we need to
// inspect the request body to derive the key, and hono-rate-limiter's
// keyGenerator runs before the body is parsed — re-reading it from middleware
// would require buffering.

const MAGIC_SEND_LIMIT = 5;
const MAGIC_SEND_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Per-email rate limiter for POST /oauth/magic/send. Exported so tests can
 * `reset()` it between cases — the module-level state persists across
 * `app.fetch` calls in the same vitest run, and a test that exhausts the
 * bucket would leak into the next test if not cleared.
 */
export const magicSendLimiter = new RateLimiter(MAGIC_SEND_LIMIT, MAGIC_SEND_WINDOW_MS);

/**
 * Minimal RFC 5322 email validation — enough to reject obvious malformations
 * without going full RFC 5322 (which allows e.g. quoted local parts that no
 * real provider accepts). Mirrors the regex used by HTML5's <input type=
 * "email"> validation and is good enough for "did the user typo a space in"
 * level checks. Real validation happens at the SMTP RCPT TO step.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse the magic/send request body. Accepts both
 * application/x-www-form-urlencoded (the login-page form's default content
 * type) and application/json (programmatic callers, tests). Both must include
 * `email`; `state` is optional (browser-session flow has no MCP client to
 * resume).
 */
async function parseMagicSendBody(
  c: Context,
): Promise<{ email?: unknown; state?: unknown } | null> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    return c.req.json().catch(() => null);
  }
  // Default to form-encoded — that's what <form method="POST"> emits.
  try {
    const form = await c.req.parseBody();
    return form as { email?: unknown; state?: unknown };
  } catch {
    return null;
  }
}

authRoutes.post('/oauth/magic/send', async (c) => {
  // Refuse early if SMTP isn't configured. The error shape mirrors the other
  // 503s in this file (e.g. openapi_unavailable) so monitoring can group them.
  if (!env.SMTP_HOST) {
    return c.json(
      {
        error: 'service_unavailable',
        message:
          'Magic link sign-in is not configured on this deployment. Please use Google sign-in.',
      },
      503,
    );
  }

  const body = await parseMagicSendBody(c);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'invalid_request', message: 'Request body is malformed.' }, 400);
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const stateInput = typeof body.state === 'string' ? body.state : '';

  if (!email || !EMAIL_REGEX.test(email)) {
    return c.json(
      { error: 'invalid_request', message: 'Please provide a valid email address.' },
      400,
    );
  }
  const lowerEmail = email.toLowerCase();

  // Rate-limit keyed on the lowercased email. Per spec §7.3 — keys by email
  // (not IP) so a single malicious sender from many IPs still gets throttled,
  // and so a victim's email can't be spammed from multiple IPs.
  const rl = magicSendLimiter.check(lowerEmail);
  if (!rl.allowed) {
    c.header('Retry-After', String(rl.secondsUntilReset));
    return c.json(
      {
        error: 'rate_limited',
        retry_after_seconds: rl.secondsUntilReset,
        message: `Too many magic link requests for this email; retry after ${rl.secondsUntilReset} seconds`,
      },
      429,
    );
  }

  // Decode the signed state JWT to recover the authorize context. The state
  // is the same JWT the GET /oauth/authorize page embedded in the form's
  // hidden field. A missing / invalid state still produces a magic link, but
  // with an empty context — the verify step will then redirect to the
  // configured fallback (or render an error if there's no redirect_uri).
  let authorizeContext: Parameters<typeof sendMagicLink>[1] = {};
  if (stateInput) {
    try {
      const claims = await verifyStateJwt(stateInput);
      authorizeContext = {
        clientId: claims.clientId,
        redirectUri: claims.redirectUri,
        codeChallenge: claims.codeChallenge,
        // Re-emit the method only when a challenge is present — the auth-code
        // insert requires both or neither.
        codeChallengeMethod: claims.codeChallenge ? 'S256' : undefined,
        scope: claims.scope,
        state: claims.state,
        browserSession: claims.browserSession,
      };
    } catch {
      // Invalid / expired state — proceed with empty context. The verify
      // endpoint will surface a clear error when the user clicks the link.
      // We deliberately don't 400 here because that would distinguish "valid
      // state but unregistered email" from "invalid state" via response
      // shape — small enumeration leak.
    }
  }

  // Send. Any infrastructure failure (SMTP timeout, DB blip) bubbles up to
  // the global error handler. We don't try/catch here because returning 200
  // on a failed send would silently swallow the problem — the user would
  // never get an email and have no error to show.
  try {
    await sendMagicLink(lowerEmail, authorizeContext);
  } catch (err) {
    if (err instanceof SmtpUnavailableError) {
      // Should already have been caught by the env.SMTP_HOST check above,
      // but defensively return 503 here too in case env mutates between
      // checks (e.g. in tests).
      return c.json(
        {
          error: 'service_unavailable',
          message:
            'Magic link sign-in is not configured on this deployment. Please use Google sign-in.',
        },
        503,
      );
    }
    throw err;
  }

  return c.json({
    ok: true,
    message: 'Check your email for a sign-in link. The link expires in 15 minutes.',
  });
});

// --- GET /oauth/magic -------------------------------------------------------
// Magic Link verify endpoint. The user lands here after clicking the link in
// their email. We:
//   1. Look up the token (atomically consuming it).
//   2. Upsert the user by email — creates a row on first-time login.
//   3. Mint a Pagent auth code bound to the original PKCE challenge.
//   4. 302 to the MCP client's redirect_uri with code + state.
//
// Token reuse, expiry, and tampering all surface as the same error page so
// we don't leak verification state. This endpoint is intentionally not rate-
// limited per IP: the 32-byte random token is already brute-force-resistant,
// and a legitimate user clicking the link twice (e.g. via a link prefetcher)
// should see an error, not a 429.

authRoutes.get('/oauth/magic', async (c) => {
  const token = c.req.query('token');
  if (typeof token !== 'string' || token.length === 0) {
    return renderError(c, 'Magic link is missing the token parameter.');
  }

  let consumed: Awaited<ReturnType<typeof verifyMagicLink>>;
  try {
    consumed = await verifyMagicLink(token);
  } catch (err) {
    if (err instanceof InvalidMagicLinkError) {
      return renderError(
        c,
        'This sign-in link has expired or has already been used. Please request a new one.',
      );
    }
    throw err;
  }

  // Upsert the user. The magic link flow doubles as sign-up so this is the
  // first time we see the email for brand-new users.
  const user = await upsertUser({ email: consumed.email });

  const ctx = consumed.authorizeContext;

  // Without a redirect_uri there's nowhere to send the user. The
  // browser-session flow (introduced in Task 09) will hit this path with
  // `browserSession: true` and set a cookie instead — for now surface a
  // clean error so deployment doesn't silently break that path.
  if (!ctx.redirectUri) {
    if (ctx.browserSession) {
      return renderError(c, 'Browser session login is not yet supported.');
    }
    return renderError(
      c,
      'This sign-in link is not bound to an OAuth flow. Please restart sign-in from your client.',
    );
  }

  if (!ctx.clientId || !ctx.codeChallenge) {
    return renderError(
      c,
      'Magic link is missing PKCE binding. Please restart sign-in from your client.',
    );
  }

  // Re-validate the client + redirect_uri at consume time — the registration
  // could have changed in the 15 minutes since the email was sent.
  const client = await getClient(ctx.clientId);
  if (!client || !client.redirect_uris.includes(ctx.redirectUri)) {
    return renderError(c, 'Client registration changed during sign-in. Please restart.');
  }

  const pagentCode = await createAuthCode(
    user.id,
    ctx.clientId,
    ctx.redirectUri,
    ctx.codeChallenge,
    ctx.codeChallengeMethod ?? 'S256',
    ctx.scope ?? null,
  );

  const target = new URL(ctx.redirectUri);
  target.searchParams.set('code', pagentCode);
  if (ctx.state) target.searchParams.set('state', ctx.state);
  return c.redirect(target.toString(), 302);
});

// --- POST /oauth/token ------------------------------------------------------
// OAuth 2.1 token endpoint. Dispatches on `grant_type`:
//   - authorization_code: exchange auth code + PKCE verifier for tokens
//   - refresh_token: rotate refresh token, mint new access token
// Body must be application/x-www-form-urlencoded (RFC 6749 §3.2). JSON bodies
// are rejected with invalid_request — that's not the wire format the OAuth
// spec mandates and accepting both would invite confusion.
//
// Rate-limited 20/IP/min per spec §7.3. Same per-IP bucket pattern as the
// other auth endpoints (last-hop X-Forwarded-For via clientKey).

const TOKEN_WINDOW_MS = 60 * 1000; // 1 minute
const TOKEN_LIMIT = 20;
const TOKEN_RETRY_AFTER_SECONDS = Math.ceil(TOKEN_WINDOW_MS / 1000);

const tokenLimiter = rateLimiter({
  windowMs: TOKEN_WINDOW_MS,
  limit: TOKEN_LIMIT,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => clientKey(c.req.header('x-forwarded-for')),
  handler: (c) => {
    c.header('Retry-After', String(TOKEN_RETRY_AFTER_SECONDS));
    return c.json(
      {
        error: 'rate_limited',
        retry_after_seconds: TOKEN_RETRY_AFTER_SECONDS,
        message: `Too many token requests from this IP; retry after ${TOKEN_RETRY_AFTER_SECONDS} seconds`,
      },
      429,
    );
  },
});

/**
 * Serialize a TokenError into the OAuth 2.1 error response shape. Status
 * comes from the error (401 for invalid_client, 400 for the rest). Body is
 * always `{ error, error_description }` per RFC 6749 §5.2.
 */
function tokenErrorResponse(c: Context, err: TokenError) {
  return c.json({ error: err.code, error_description: err.description }, err.status);
}

/**
 * Parse the body of a token-endpoint request. Strictly form-encoded —
 * application/json is rejected with invalid_request because the OAuth spec
 * mandates form encoding and accepting JSON would invite client confusion.
 *
 * Returns the parsed body as a string-keyed map (form values are always
 * strings; multipart-uploaded files would be File objects but we don't
 * accept multipart here).
 */
async function parseTokenBody(c: Context): Promise<Record<string, string> | null> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  // Strict form-encoded check. We accept the canonical and the variant with
  // a charset suffix (e.g. `application/x-www-form-urlencoded; charset=UTF-8`).
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return null;
  }
  try {
    const form = await c.req.parseBody();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

authRoutes.post('/oauth/token', tokenLimiter, async (c) => {
  const body = await parseTokenBody(c);
  if (!body) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400,
    );
  }

  const grantType = body.grant_type;
  if (!grantType) {
    return c.json(
      { error: 'invalid_request', error_description: 'Missing grant_type parameter' },
      400,
    );
  }

  try {
    if (grantType === 'authorization_code') {
      const { code, client_id, redirect_uri, code_verifier } = body;
      const response = await exchangeAuthCode(
        code ?? '',
        client_id ?? '',
        redirect_uri ?? '',
        code_verifier ?? '',
      );
      // RFC 6749 §5.1 — token responses MUST set Cache-Control: no-store and
      // Pragma: no-cache so intermediaries don't cache the bearer credential.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(response, 200);
    }
    if (grantType === 'refresh_token') {
      const { refresh_token, client_id } = body;
      const response = await providerRefreshToken(refresh_token ?? '', client_id ?? '');
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(response, 200);
    }
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: `Grant type '${grantType}' is not supported`,
      },
      400,
    );
  } catch (err) {
    if (err instanceof TokenError) {
      return tokenErrorResponse(c, err);
    }
    throw err;
  }
});

// --- POST /oauth/revoke -----------------------------------------------------
// RFC 7009 token revocation endpoint. Always returns 200 — distinguishing
// "token revoked" from "token unknown" would let an attacker probe which
// tokens are valid. Same form-encoded body shape as /oauth/token; we don't
// even reject non-form content types here (RFC 7009 §2.1 doesn't require it)
// — a misshapen body just means we have nothing to revoke and return 200.
//
// Rate-limited 20/IP/min mirroring the token endpoint. The two share an
// abuse profile (cheap to call, valuable to an attacker enumerating tokens),
// so a single per-endpoint budget is the right granularity.

const revokeLimiter = rateLimiter({
  windowMs: TOKEN_WINDOW_MS,
  limit: TOKEN_LIMIT,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => clientKey(c.req.header('x-forwarded-for')),
  handler: (c) => {
    c.header('Retry-After', String(TOKEN_RETRY_AFTER_SECONDS));
    return c.json(
      {
        error: 'rate_limited',
        retry_after_seconds: TOKEN_RETRY_AFTER_SECONDS,
        message: `Too many revoke requests from this IP; retry after ${TOKEN_RETRY_AFTER_SECONDS} seconds`,
      },
      429,
    );
  },
});

authRoutes.post('/oauth/revoke', revokeLimiter, async (c) => {
  // Best-effort parse. RFC 7009 §2.2 says invalid requests still return 200
  // (with the exception of unsupported_token_type, which we don't surface
  // since we accept the prefix-based discriminator instead of relying on
  // token_type_hint). A malformed body means there's nothing to revoke.
  const body = await parseTokenBody(c);
  if (body && typeof body.token === 'string' && body.token.length > 0) {
    try {
      await revokeToken(body.token, body.token_type_hint, body.client_id);
    } catch {
      // Swallow — RFC 7009 mandates 200 regardless of failure. The error is
      // logged via the global error handler if it propagates from a deeper
      // bug, but we don't want a transient DB blip to surface as 500.
    }
  }
  return c.body(null, 200);
});
