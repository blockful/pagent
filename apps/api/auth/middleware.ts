/**
 * Hono auth middleware — cookie + Bearer JWT resolution.
 *
 * Two middlewares:
 *   - `resolveAuth()` runs on every request. Tries the `pagent_session`
 *     cookie first (browser sessions), then `Authorization: Bearer`
 *     (API / MCP clients), then sets `c.var.user = null` for anonymous
 *     requests. NEVER rejects — the caller decides whether to require auth.
 *   - `requireAuth()` runs only on protected routes. Rejects anonymous
 *     requests with 401 JSON.
 *
 * The split lets `c.var.user` be populated for handlers that want to log
 * the user / inject `owner_id` (POST /new) but still serve unauthenticated
 * read endpoints (GET /:id, GET /:id/result) without bouncing the request.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §6.2.
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyAccessToken } from './jwt.ts';
import { lookupSession } from './session.ts';
import { getRequestId } from '../request-id.ts';

// --- Types -------------------------------------------------------------------

/**
 * The authenticated user shape consumed by downstream handlers. `handle` is
 * nullable per the user schema — it's assigned during onboarding (not at
 * user creation time), so a brand-new account can be authenticated without
 * having picked one yet.
 *
 * `authMethod` distinguishes the two resolution paths so handlers can
 * differentiate browser session from API/MCP client behaviour (e.g. CSRF
 * defences only apply on cookie-authenticated state-changing requests).
 */
export type AuthUser = {
  id: string;
  email: string;
  handle: string | null;
  authMethod: 'cookie' | 'bearer';
};

/**
 * The Hono `Variables` shape this middleware contributes. Composed with
 * `RequestIdVariables` in `app.ts` so handlers can read both via `c.var`.
 *
 * `user` is `AuthUser | null` rather than `AuthUser | undefined` so handlers
 * that introspect it via `c.var.user` get a clear "anonymous request"
 * signal rather than an "unset" / "middleware didn't run" ambiguity.
 */
export type AuthVariables = {
  user: AuthUser | null;
};

// --- Cookie name -------------------------------------------------------------

/**
 * Cookie name for browser sessions. Exported so the login / logout routes
 * (and tests) refer to a single source of truth. Spec §6.2 mandates this
 * exact name; changing it would invalidate every outstanding session.
 */
export const SESSION_COOKIE_NAME = 'pagent_session';

// --- Helpers -----------------------------------------------------------------

const BEARER_PREFIX = 'Bearer ';

/**
 * Try to authenticate via the session cookie. Returns the resolved user, or
 * `null` if the cookie is missing or doesn't correspond to a live session.
 * Always sets `authMethod: 'cookie'` on success.
 */
async function tryCookieAuth(c: Context): Promise<AuthUser | null> {
  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
  if (!sessionToken) return null;
  const user = await lookupSession(sessionToken);
  if (!user) return null;
  // lookupSession already sets authMethod: 'cookie', but we re-spread here
  // to make the contract explicit at the resolution boundary.
  return { ...user, authMethod: 'cookie' };
}

/**
 * Try to authenticate via the Authorization: Bearer header. Returns the
 * resolved user, or `null` if the header is missing / malformed / signature
 * fails / claims are expired. We never throw — an invalid Bearer just
 * falls through to the anonymous branch (then `requireAuth` decides 401).
 */
async function tryBearerAuth(c: Context): Promise<AuthUser | null> {
  const authHeader = c.req.header('authorization');
  if (!authHeader?.startsWith(BEARER_PREFIX)) return null;
  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!token) return null;
  try {
    const claims = await verifyAccessToken(token);
    return {
      id: claims.sub,
      email: claims.email,
      handle: claims.handle || null,
      authMethod: 'bearer',
    };
  } catch {
    // Invalid / expired bearer: fall through to anonymous. The route-level
    // requireAuth() will turn that into a 401 with our standard shape.
    return null;
  }
}

// --- Middleware --------------------------------------------------------------

/**
 * Populate `c.var.user` from cookie or Bearer. Never short-circuits.
 *
 * Tried in priority order:
 *   1. `pagent_session` cookie (browser sessions, sliding expiry)
 *   2. `Authorization: Bearer <jwt>` (MCP / API clients)
 *   3. Anonymous → `c.var.user = null`
 *
 * Cookie takes precedence because the renderer (which holds the session
 * cookie) is the only client that would also accidentally send a stale
 * Bearer; honoring the cookie there matches the spec's "browser identity"
 * intent.
 */
export function resolveAuth(): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const cookieUser = await tryCookieAuth(c);
    if (cookieUser) {
      c.set('user', cookieUser);
      return next();
    }
    const bearerUser = await tryBearerAuth(c);
    if (bearerUser) {
      c.set('user', bearerUser);
      return next();
    }
    c.set('user', null);
    return next();
  };
}

/**
 * Reject anonymous requests with a 401 JSON response. Designed to be mounted
 * AFTER `resolveAuth()` — depends on `c.var.user` being set (to a user or
 * null). The response shape mirrors the other error envelopes in the API
 * (`{ error, message, request_id }`) so clients have a single parsing path.
 */
export function requireAuth(): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c: Context, next: Next) => {
    const user = c.get('user') as AuthUser | null | undefined;
    if (!user) {
      return c.json(
        {
          error: 'unauthorized',
          message: 'Authentication required',
          request_id: getRequestId(c),
        },
        401,
      );
    }
    return next();
  };
}
