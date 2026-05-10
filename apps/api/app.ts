import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Context } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { apiReference } from '@scalar/hono-api-reference';
import * as db from './db.ts';
import * as store from './store.ts';
import { clientKey } from './client-key.ts';
import { env, pageIdSchema, newPageBodySchema, resultBodySchema } from './schemas.ts';
import { logger } from './logger.ts';
import type { RequestIdVariables } from './request-id.ts';
import { requestId, getLog, getRequestId } from './request-id.ts';

// --- OpenAPI spec (loaded once at boot, served from memory) ------------------

const openapiPath = resolve(import.meta.dirname, '../../docs/openapi.yaml');
let openapiYaml: string | null = null;
let openapiJson: string | null = null;
try {
  openapiYaml = await readFile(openapiPath, 'utf8');
  openapiJson = JSON.stringify(parseYaml(openapiYaml));
} catch (err) {
  logger.error({ err, openapiPath }, 'failed to load openapi.yaml at boot');
}

// --- Config ------------------------------------------------------------------

export const PORT = env.PORT;
// In production envSchema ensures PUBLIC_URL is set; in dev fall back to localhost.
export const PUBLIC_URL = env.PUBLIC_URL ?? `http://localhost:${PORT}`;
export const PAGE_TTL_MS = env.PAGE_TTL_MS;
export const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS;

export const MAX_BODY_BYTES = 256 * 1024; // 256 KB

const newPageLimiter = rateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7', // sets RateLimit-* headers per IETF draft 7
  keyGenerator: (c: Context) => clientKey(c.req.header('x-forwarded-for')),
  handler: (c) => {
    const retryAfter = Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000);
    c.header('Retry-After', String(retryAfter));
    return c.json(
      {
        error: 'rate_limited',
        retry_after_seconds: retryAfter,
        message: `Too many requests; retry after ${retryAfter} seconds`,
        request_id: getRequestId(c),
      },
      429,
    );
  },
});

// --- App ---------------------------------------------------------------------

export const app = new Hono<{ Variables: RequestIdVariables }>();
app.use('*', requestId());
app.use(
  '*',
  secureHeaders({
    // contentSecurityPolicy is intentionally omitted — Hono does not set CSP
    // by default, and its HTML-page preset would be noise on a JSON API.
    // Hono defaults X-Frame-Options to SAMEORIGIN; bump to DENY — this API
    // has no frames to embed and DENY is more restrictive.
    xFrameOptions: 'DENY',
    // Browsers default Cross-Origin-Resource-Policy to same-origin which would
    // block the renderer at pagent.vercel.app from reading API responses at
    // pagent.up.railway.app. CORS already gates cross-origin reads explicitly.
    crossOriginResourcePolicy: 'cross-origin',
    // Defaults are fine for everything else (HSTS, X-Content-Type-Options
    // nosniff, Referrer-Policy no-referrer, etc.)
  }),
);
app.use('*', cors({ origin: ALLOWED_ORIGINS ?? '*' }));

app.use(
  '*',
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        {
          error: 'payload_too_large',
          max_bytes: MAX_BODY_BYTES,
          message: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
        },
        413,
      ),
  }),
);

app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  getLog(c).info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - start,
    },
    'request',
  );
});

// --- Global error handler ----------------------------------------------------
// Safety net for any unhandled exception that escapes a route handler.
// Hono's framework default emits HTML / plain text — this replaces it with a
// structured JSON 500 so every JSON-expecting client gets a parseable response.

app.onError((err, c) => {
  getLog(c).error({ err, method: c.req.method, path: c.req.path }, 'unhandled error');
  return c.json(
    {
      error: 'internal_error',
      request_id: getRequestId(c),
      message: 'An unexpected error occurred; quote the request_id when reporting this',
    },
    500,
  );
});

// --- Health (unversioned — ops endpoint, not part of the API contract) -------

app.get('/health', async (c) => {
  try {
    await db.ping();
    return c.json({ ok: true, db: 'ok' });
  } catch (err) {
    logger.error({ err }, 'health check db ping failed');
    return c.json({ ok: false, db: 'error', message: 'Database connection failed' }, 503);
  }
});

// --- OpenAPI document --------------------------------------------------------

app.get('/openapi.json', (c) => {
  if (!openapiJson) return c.json({ error: 'openapi_unavailable' }, 503);
  return c.body(openapiJson, 200, { 'Content-Type': 'application/json; charset=utf-8' });
});

app.get('/openapi.yaml', (c) => {
  if (!openapiYaml) return c.json({ error: 'openapi_unavailable' }, 503);
  return c.body(openapiYaml, 200, { 'Content-Type': 'application/yaml; charset=utf-8' });
});

app.get(
  '/docs',
  apiReference({
    url: '/openapi.json',
    pageTitle: 'Pagent API Reference',
    theme: 'default',
  }),
);

// --- Route handlers ----------------------------------------------------------

const newPageHandler = async (c: Context) => {
  const raw = await c.req.json().catch(() => null);
  const result = newPageBodySchema.safeParse(raw);
  if (!result.success) {
    return c.json(
      {
        error: 'bad_request',
        issues: result.error.issues,
        message: 'Request body did not match the expected schema',
      },
      400,
    );
  }
  const created = await store.createPage(result.data.spec, {
    publicUrl: PUBLIC_URL,
    pageTtlMs: PAGE_TTL_MS,
  });
  return c.json(created, 201);
};

const getPageHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  const p = await db.getActivePage(idResult.data);
  if (!p) return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  return c.json({
    spec: p.spec,
    state: p.state,
    result: p.result,
    expires_at: p.expiresAt,
  });
};

const submitResultHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  const raw = await c.req.json().catch(() => null);
  const bodyResult = resultBodySchema.safeParse(raw);
  if (!bodyResult.success) {
    return c.json(
      {
        error: 'bad_request',
        issues: bodyResult.error.issues,
        message: 'Request body did not match the expected schema',
      },
      400,
    );
  }
  const action = bodyResult.data;
  const outcome = await db.submitPage(idResult.data, action);
  if (outcome === 'not_found')
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  if (outcome === 'conflict')
    return c.json(
      {
        error: 'conflict',
        message: 'Page was already submitted; create a new page if you need another submission',
      },
      409,
    );
  return c.json({ ok: true });
};

const getResultHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  const outcome = await store.advanceResult(idResult.data);
  if (outcome.kind === 'not_found')
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  return c.json({ state: outcome.state, result: outcome.result });
};

// --- Routes ------------------------------------------------------------------

app.post('/new', newPageLimiter, newPageHandler);
app.get('/:id', getPageHandler);
app.post('/:id/result', submitResultHandler);
app.get('/:id/result', getResultHandler);
