/**
 * Resolves optional request identity separately from protected-route gating,
 * so public reads remain anonymous while writes can require authentication.
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §6.2.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyAccessToken } from './jwt.ts';
import { lookupSession } from './session.ts';
import { getRequestId } from '../request-id.ts';

/**
 * Authenticated request identity. `handle` remains null until onboarding;
 * `authMethod` distinguishes cookie requests from API and MCP bearer requests.
 */
export type AuthUser = {
  id: string;
  email: string;
  handle: string | null;
  authMethod: 'cookie' | 'bearer';
};

/** `null` distinguishes an anonymous request from middleware that did not run. */
export type AuthVariables = {
  user: AuthUser | null;
  authScopes: readonly string[] | null;
};

/** Stable cookie name; changing it would invalidate every outstanding session. */
export const SESSION_COOKIE_NAME = 'pagent_session';

const BEARER_PREFIX = 'Bearer ';

async function tryCookieAuth(c: Context): Promise<AuthUser | null> {
  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
  if (!sessionToken) return null;
  return lookupSession(sessionToken);
}

type BearerAuth = {
  readonly user: AuthUser;
  readonly scopes: readonly string[];
};

async function tryBearerAuth(c: Context): Promise<BearerAuth | null> {
  const authHeader = c.req.header('authorization');
  if (!authHeader?.startsWith(BEARER_PREFIX)) return null;
  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!token) return null;
  try {
    const claims = await verifyAccessToken(token);
    return {
      user: {
        id: claims.sub,
        email: claims.email,
        handle: claims.handle || null,
        authMethod: 'bearer',
      },
      scopes: [...new Set(claims.scope.split(/[ \t\r\n\f]+/).filter(Boolean))],
    };
  } catch {
    // Invalid credentials stay anonymous; protected routes convert that to 401.
    return null;
  }
}

/**
 * Populate authentication variables without rejecting the request. Cookies
 * take precedence so renderer identity wins over an accidentally stale bearer.
 */
export function resolveAuth(): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const cookieUser = await tryCookieAuth(c);
    if (cookieUser) {
      c.set('user', cookieUser);
      c.set('authScopes', null);
      return next();
    }
    const bearerAuth = await tryBearerAuth(c);
    if (bearerAuth) {
      c.set('user', bearerAuth.user);
      c.set('authScopes', bearerAuth.scopes);
      return next();
    }
    c.set('user', null);
    c.set('authScopes', null);
    return next();
  };
}

export function requireAuth(): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const user = c.get('user');
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

export function requireScope(
  requiredScope: string,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const user = c.get('user');
    const scopes = c.get('authScopes');
    if (user?.authMethod === 'bearer' && !scopes?.includes(requiredScope)) {
      c.header('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${requiredScope}"`);
      return c.json(
        {
          error: 'insufficient_scope',
          message: `Bearer token requires the ${requiredScope} scope`,
          request_id: getRequestId(c),
        },
        403,
      );
    }
    return next();
  };
}
