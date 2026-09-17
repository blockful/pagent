import { Hono, type Context } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { z } from 'zod';
import type { AuthVariables } from '../auth/middleware.ts';
import { clientKey } from '../client-key.ts';
import { getRequestId } from '../request-id.ts';
import { env } from '../schemas.ts';
import { ShareUnavailableError } from './errors.ts';
import {
  accessRequestBodySchema,
  engagementBodySchema,
  startVisitBodySchema,
  viewerAccessBodySchema,
} from './http-schemas.ts';
import { EngagementForbiddenError, ingestEngagement, startVisit } from './repository-engagement.ts';
import {
  getAccessRequestStatus,
  getShareMetadata,
  grantViewerAccess,
  requestAccess,
} from './repository-sharing.ts';
import { ViewerSessionUnavailableError, getViewerDeck } from './repository-viewer-access.ts';
import { hashOpaqueToken } from './tokens.ts';

type ViewerContext = Context<{ Variables: AuthVariables }>;
const tokenSchema = z.string().min(20).max(200);
const visitIdSchema = z.string().uuid();
const EVENT_IP_LIMIT_MULTIPLIER = 4;
const EVENT_SESSION_LIMIT = 30;
const accessLimiter = createViewerWriteLimiter(env.RATE_LIMIT_MAX);
const visitLimiter = createViewerWriteLimiter(env.RATE_LIMIT_MAX);
const eventLimiter = createViewerWriteLimiter(env.RATE_LIMIT_MAX * EVENT_IP_LIMIT_MULTIPLIER);
const eventSessionLimiter = createViewerSessionLimiter(EVENT_SESSION_LIMIT);
export const viewerRoutes = new Hono<{ Variables: AuthVariables }>();

viewerRoutes.get('/share', async (c) => {
  const token = shareToken(c);
  if (token === null) return c.json({ error: 'not_found' }, 404);
  try {
    return c.json(await getShareMetadata(token));
  } catch (error) {
    return unavailable(c, error);
  }
});

viewerRoutes.post('/share/access', accessLimiter, async (c) => {
  const token = shareToken(c);
  const body = viewerAccessBodySchema.safeParse(await c.req.json().catch(() => null));
  if (token === null) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  try {
    return c.json(
      await grantViewerAccess({
        token,
        email: body.data.email,
        authenticatedUser: user === null ? undefined : user,
      }),
    );
  } catch (error) {
    return unavailable(c, error);
  }
});

viewerRoutes.post('/share/request', accessLimiter, async (c) => {
  const token = shareToken(c);
  const body = accessRequestBodySchema.safeParse(await c.req.json().catch(() => null));
  if (token === null || !body.success) {
    return c.json({ error: 'bad_request' }, 400);
  }
  return c.json(await requestAccess(token, body.data.email), 202);
});

viewerRoutes.get('/share/request/:requestId', async (c) => {
  const token = shareToken(c);
  const requestId = visitIdSchema.safeParse(c.req.param('requestId'));
  if (token === null || !requestId.success) return c.json({ error: 'not_found' }, 404);
  return c.json({ status: await getAccessRequestStatus(token, requestId.data) });
});

viewerRoutes.get('/viewer/deck', async (c) => {
  const token = viewerToken(c);
  if (token === null) return c.json({ error: 'not_found' }, 404);
  try {
    return c.json(await getViewerDeck(token));
  } catch (error) {
    return unavailable(c, error);
  }
});

viewerRoutes.post('/viewer/visits', visitLimiter, async (c) => {
  const token = viewerToken(c);
  const body = startVisitBodySchema.safeParse(await c.req.json().catch(() => null));
  if (token === null || !body.success) return c.json({ error: 'bad_request' }, 400);
  try {
    return c.json(await startVisit(token, body.data));
  } catch (error) {
    return unavailable(c, error);
  }
});

viewerRoutes.post(
  '/viewer/visits/:visitId/events',
  eventLimiter,
  eventSessionLimiter,
  async (c) => {
    const token = viewerToken(c);
    const visitId = visitIdSchema.safeParse(c.req.param('visitId'));
    const body = engagementBodySchema.safeParse(await c.req.json().catch(() => null));
    if (token === null || !visitId.success || !body.success) {
      return c.json({ error: 'bad_request' }, 400);
    }
    try {
      await ingestEngagement(token, visitId.data, body.data.events);
      return c.body(null, 202);
    } catch (error) {
      return unavailable(c, error);
    }
  },
);

function shareToken(c: ViewerContext): string | null {
  const parsed = tokenSchema.safeParse(c.req.header('x-share-token'));
  return parsed.success ? parsed.data : null;
}

function viewerToken(c: ViewerContext): string | null {
  const parsed = tokenSchema.safeParse(c.req.header('x-viewer-session'));
  return parsed.success ? parsed.data : null;
}

function createViewerWriteLimiter(
  limit: number,
  keyGenerator: (c: Context) => string = (c) => clientKey(c.req.header('x-real-ip')),
) {
  const retryAfter = Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000);
  return rateLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit,
    standardHeaders: 'draft-7',
    keyGenerator,
    handler: (c) => {
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          error: 'rate_limited',
          retry_after_seconds: retryAfter,
          message: `Too many viewer requests; retry after ${retryAfter} seconds`,
          request_id: getRequestId(c),
        },
        429,
      );
    },
  });
}

function createViewerSessionLimiter(limit: number) {
  const limiter = createViewerWriteLimiter(
    limit,
    (c) => `viewer-session:${hashOpaqueToken(c.req.header('x-viewer-session') ?? '')}`,
  );

  return async (c: ViewerContext, next: () => Promise<void>) => {
    if (viewerToken(c) === null) return next();
    return limiter(c, next);
  };
}

function unavailable(c: ViewerContext, error: unknown) {
  if (error instanceof ShareUnavailableError || error instanceof ViewerSessionUnavailableError) {
    return c.json({ error: error.state }, error.state === 'not_found' ? 404 : 410);
  }
  if (error instanceof EngagementForbiddenError) return c.json({ error: 'unavailable' }, 410);
  throw error;
}
