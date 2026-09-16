import type { Context, Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { clientKey } from '../client-key.ts';
import { getClient, isAllowedOAuthRedirectUri } from './clients-store.ts';
import { renderConsentPage } from './consent-page.ts';
import { exchangeGoogleCode } from './google.ts';
import { renderLoginPage } from './login-page.ts';
import type { AuthVariables } from './middleware.ts';
import { normalizeRequestedScope } from './oauth-scopes.ts';
import { createAuthCode, upsertGoogleUser } from './provider.ts';
import { getClientIp, renderError, setSessionCookie } from './route-shared.ts';
import {
  clearBrowserTransaction,
  startBrowserTransaction,
  verifyBrowserTransaction,
} from './route-transaction.ts';
import { createSession } from './session.ts';
import { signStateJwt, verifyStateJwt } from './state-jwt.ts';

const AUTHORIZE_WINDOW_MS = 60 * 1000;
const AUTHORIZE_LIMIT = 30;
const AUTHORIZE_RETRY_AFTER_SECONDS = Math.ceil(AUTHORIZE_WINDOW_MS / 1000);
const GOOGLE_ACCOUNT_LINK_ERROR =
  'This email already belongs to an existing account. Sign in with an email magic link; Google account linking is not available yet.';

type AuthRouter = Hono<{ Variables: AuthVariables }>;

function renderNoStoreHtml(c: Context, html: string, status: 200 | 400 = 200): Response {
  c.header('Cache-Control', 'no-store');
  return c.html(html, status);
}

const authorizeLimiter = rateLimiter({
  windowMs: AUTHORIZE_WINDOW_MS,
  limit: AUTHORIZE_LIMIT,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => clientKey(c.req.header('x-real-ip')),
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

export function registerLoginRoutes(authRoutes: AuthRouter): void {
  authRoutes.get('/oauth/authorize', authorizeLimiter, async (c) => {
    c.header('Cache-Control', 'no-store');
    const query = c.req.query();
    if (query.browser_session === '1') {
      const browserTransactionHash = startBrowserTransaction(c);
      const signedState = await signStateJwt({ browserSession: true, browserTransactionHash });
      return renderNoStoreHtml(c, renderLoginPage({ signedState }));
    }

    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      state,
    } = query;
    if (response_type !== 'code') {
      return renderError(c, 'response_type must be code');
    }
    if (typeof client_id !== 'string' || client_id.length === 0) {
      return renderError(c, 'Missing required parameter: client_id');
    }
    if (typeof redirect_uri !== 'string' || redirect_uri.length === 0) {
      return renderError(c, 'Missing required parameter: redirect_uri');
    }
    if (typeof code_challenge !== 'string' || code_challenge.length === 0) {
      return renderError(c, 'Missing required parameter: code_challenge');
    }
    if (code_challenge_method !== 'S256') {
      return renderError(c, 'code_challenge_method must be S256');
    }

    const client = await getClient(client_id);
    if (!client) return renderError(c, 'Unknown client_id');
    if (!isAllowedOAuthRedirectUri(redirect_uri) || !client.redirect_uris.includes(redirect_uri)) {
      return renderError(c, 'redirect_uri does not match a registered URI for this client');
    }
    const normalizedScope = normalizeRequestedScope(typeof scope === 'string' ? scope : undefined);
    if (!normalizedScope.ok) {
      return renderError(c, `Unsupported scope: ${normalizedScope.unsupportedScope}`);
    }

    const browserTransactionHash = startBrowserTransaction(c);
    const signedState = await signStateJwt({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      scope: normalizedScope.scope,
      state: typeof state === 'string' && state.length > 0 ? state : undefined,
      browserTransactionHash,
    });
    return renderNoStoreHtml(
      c,
      renderConsentPage({
        signedState,
        client: {
          id: client.client_id,
          name: client.client_name?.trim() || 'Unnamed OAuth client',
          redirectUri: redirect_uri,
          scope: normalizedScope.scope,
        },
      }),
    );
  });

  authRoutes.get('/oauth/callback/google', async (c) => {
    c.header('Cache-Control', 'no-store');
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (typeof code !== 'string' || code.length === 0) {
      return renderError(c, 'Google callback missing code parameter');
    }
    if (typeof state !== 'string' || state.length === 0) {
      return renderError(c, 'Google callback missing state parameter');
    }

    let claims: Awaited<ReturnType<typeof verifyStateJwt>>;
    try {
      claims = await verifyStateJwt(state);
    } catch {
      return renderError(c, 'Authorization session expired or invalid. Please restart sign-in.');
    }

    if (claims.browserSession) {
      const validTransaction = verifyBrowserTransaction(c, claims.browserTransactionHash);
      clearBrowserTransaction(c);
      if (!validTransaction) {
        return renderError(c, 'Authorization session expired or invalid. Please restart sign-in.');
      }
      let profile: Awaited<ReturnType<typeof exchangeGoogleCode>>;
      try {
        profile = await exchangeGoogleCode(code);
      } catch {
        return renderError(c, 'Google sign-in failed. Please try again.');
      }
      const userResult = await upsertGoogleUser({
        googleSubject: profile.sub,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.picture,
      });
      if (userResult.kind !== 'success') {
        return renderError(c, GOOGLE_ACCOUNT_LINK_ERROR);
      }
      const user = userResult.user;
      const sessionToken = await createSession(
        user.id,
        getClientIp(c),
        c.req.header('user-agent') ?? undefined,
      );
      setSessionCookie(c, sessionToken);
      return c.redirect('/', 302);
    }

    if (!claims.clientId || !claims.redirectUri || !claims.codeChallenge) {
      return renderError(c, 'Authorization state missing required fields.');
    }
    const validTransaction = verifyBrowserTransaction(c, claims.browserTransactionHash);
    clearBrowserTransaction(c);
    if (!claims.consentGranted || !validTransaction) {
      return renderError(c, 'Authorization consent expired or invalid. Please restart sign-in.');
    }
    const client = await getClient(claims.clientId);
    if (
      !client ||
      !isAllowedOAuthRedirectUri(claims.redirectUri) ||
      !client.redirect_uris.includes(claims.redirectUri)
    ) {
      return renderError(c, 'Client registration changed during sign-in. Please restart.');
    }

    let profile: Awaited<ReturnType<typeof exchangeGoogleCode>>;
    try {
      profile = await exchangeGoogleCode(code);
    } catch {
      return renderError(c, 'Google sign-in failed. Please try again.');
    }
    const userResult = await upsertGoogleUser({
      googleSubject: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
    });
    if (userResult.kind !== 'success') {
      return renderError(c, GOOGLE_ACCOUNT_LINK_ERROR);
    }
    const user = userResult.user;
    const pagentCode = await createAuthCode(
      user.id,
      claims.clientId,
      claims.redirectUri,
      claims.codeChallenge,
      'S256',
      claims.scope ?? null,
    );
    const target = new URL(claims.redirectUri);
    target.searchParams.set('code', pagentCode);
    if (claims.state) target.searchParams.set('state', claims.state);
    return c.redirect(target.toString(), 302);
  });
}
