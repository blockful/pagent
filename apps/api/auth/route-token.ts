import type { Context, Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { clientKey } from '../client-key.ts';
import type { AuthVariables } from './middleware.ts';
import {
  TokenError,
  exchangeAuthCode,
  refreshToken as providerRefreshToken,
  revokeToken,
} from './provider.ts';

const TOKEN_WINDOW_MS = 60 * 1000;
const TOKEN_LIMIT = 20;
const TOKEN_RETRY_AFTER_SECONDS = Math.ceil(TOKEN_WINDOW_MS / 1000);

type AuthRouter = Hono<{ Variables: AuthVariables }>;

function createTokenRateLimiter(operation: 'token' | 'revoke') {
  return rateLimiter({
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
          message: `Too many ${operation} requests from this IP; retry after ${TOKEN_RETRY_AFTER_SECONDS} seconds`,
        },
        429,
      );
    },
  });
}

const tokenLimiter = createTokenRateLimiter('token');
const revokeLimiter = createTokenRateLimiter('revoke');

function tokenErrorResponse(c: Context, err: TokenError) {
  return c.json({ error: err.code, error_description: err.description }, err.status);
}

async function parseTokenBody(c: Context): Promise<Record<string, string> | null> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/x-www-form-urlencoded')) return null;
  try {
    const form = await c.req.parseBody();
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(form)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

export function registerTokenRoutes(authRoutes: AuthRouter): void {
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
      if (err instanceof TokenError) return tokenErrorResponse(c, err);
      throw err;
    }
  });

  authRoutes.post('/oauth/revoke', revokeLimiter, async (c) => {
    const body = await parseTokenBody(c);
    if (body && typeof body.token === 'string' && body.token.length > 0) {
      try {
        await revokeToken(body.token, body.token_type_hint, body.client_id);
      } catch {
        // RFC 7009 requires the endpoint not to disclose revocation failure.
      }
    }
    return c.body(null, 200);
  });
}
