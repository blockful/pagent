import type { Context, Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { clientKey } from '../client-key.ts';
import { InvalidClientMetadataError, registerClient } from './clients-store.ts';
import { getIssuer, getJwks } from './jwt.ts';
import type { AuthVariables } from './middleware.ts';
import { SUPPORTED_SCOPES } from './oauth-scopes.ts';

const DOCS_URL = 'https://github.com/blockful/pagent#readme';
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_LIMIT = 10;
const REGISTER_RETRY_AFTER_SECONDS = Math.ceil(REGISTER_WINDOW_MS / 1000);

type AuthRouter = Hono<{ Variables: AuthVariables }>;

const registerLimiter = rateLimiter({
  windowMs: REGISTER_WINDOW_MS,
  limit: REGISTER_LIMIT,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => clientKey(c.req.header('x-real-ip')),
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

export function registerDiscoveryRoutes(authRoutes: AuthRouter): void {
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
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: SUPPORTED_SCOPES,
      service_documentation: DOCS_URL,
    });
  });

  authRoutes.get('/.well-known/oauth-protected-resource', (c) => {
    const resource = getIssuer();
    return c.json({
      resource,
      authorization_servers: [resource],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Pagent API',
      resource_documentation: DOCS_URL,
    });
  });

  authRoutes.get('/.well-known/jwks.json', (c) => c.json(getJwks()));

  authRoutes.post('/oauth/register', registerLimiter, async (c) => {
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
      return c.json(client, 201);
    } catch (err) {
      if (err instanceof InvalidClientMetadataError) {
        return c.json(
          { error: 'invalid_client_metadata', error_description: err.description },
          400,
        );
      }
      throw err;
    }
  });
}
