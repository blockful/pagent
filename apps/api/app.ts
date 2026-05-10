import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Context } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { apiReference } from '@scalar/hono-api-reference';
import { trace } from '@opentelemetry/api';
import * as db from './db.ts';
import type { Page } from './db.ts';
import { env, pageIdSchema, newPageBodySchema, resultBodySchema } from './schemas.ts';
import { logger } from './logger.ts';
import { metrics, statusClassFor } from './metrics.ts';
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

export const newId = () => randomBytes(16).toString('hex');

// Extract the rate-limit key from the request. Behind Railway / Vercel the
// real client IP arrives in x-forwarded-for. In local dev and tests no proxy
// is present, so we collapse everything into a single bucket.
const clientKey = (c: Context): string => {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    // Trust the LAST hop. Reverse proxies (Railway, Vercel, Cloudflare)
    // append the real client IP to the right of any incoming XFF chain;
    // the leftmost entries are whatever the client sent and so are
    // attacker-controlled. Using the last hop assumes exactly one trusted
    // proxy in front of the API. If you ever stack proxies, raise the
    // index by hand.
    const hops = fwd
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1]!;
  }
  // Fallback for local dev / tests where no proxy is present. We deliberately
  // collapse all unknown clients into a single bucket — anonymous traffic is
  // rate-limited as one logical client.
  return 'anonymous';
};

const newPageLimiter = rateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7', // sets RateLimit-* headers per IETF draft 7
  keyGenerator: clientKey,
  handler: (c) => {
    const retryAfter = Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000);
    c.header('Retry-After', String(retryAfter));
    return c.json(
      {
        error: 'rate_limited',
        retry_after_seconds: retryAfter,
        message: `Too many requests; retry after ${retryAfter} seconds`,
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

// Request observability: bumps RED metrics, surfaces trace_id in a response
// header, and emits a structured access log. The try/finally is load-bearing:
// without it, exceptions that escape `next()` (and get caught by app.onError
// downstream) would skip the metric/log emission — meaning 500s wouldn't
// register in the error-rate panel.
app.use('*', async (c, next) => {
  const start = Date.now();
  try {
    await next();
  } finally {
    const durationMs = Date.now() - start;
    const status = c.res.status;
    // routePath is the matched pattern ("/:id") rather than the literal URL —
    // keeps metric cardinality bounded.
    const route = c.req.routePath ?? '<unknown>';

    // Surface trace_id so operators can paste it into Grafana's Tempo explorer.
    const span = trace.getActiveSpan();
    const traceId = span?.spanContext().traceId;
    if (traceId && traceId !== '00000000000000000000000000000000') {
      c.header('x-trace-id', traceId);
    }

    metrics.httpRequests.add(1, {
      method: c.req.method,
      route,
      status_class: statusClassFor(status),
      status_code: String(status),
    });
    metrics.httpRequestDuration.record(durationMs / 1000, {
      method: c.req.method,
      route,
    });

    getLog(c).info(
      {
        method: c.req.method,
        path: c.req.path,
        route,
        status,
        duration_ms: durationMs,
      },
      'request',
    );
  }
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
  const now = Date.now();
  const page: Page = {
    id: newId(),
    spec: result.data.spec,
    state: 'open',
    result: null,
    createdAt: now,
    expiresAt: now + PAGE_TTL_MS,
  };
  await db.insertPage(page);
  metrics.pagesCreated.add(1);
  return c.json({ id: page.id, url: `${PUBLIC_URL}/${page.id}`, expires_at: page.expiresAt }, 201);
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
  if (outcome.kind === 'not_found')
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  if (outcome.kind === 'conflict')
    return c.json(
      {
        error: 'conflict',
        message: 'Page was already submitted; create a new page if you need another submission',
      },
      409,
    );
  metrics.pagesSubmitted.add(1);
  metrics.pageSubmitLatency.record((Date.now() - outcome.createdAt.getTime()) / 1000);
  return c.json({ ok: true });
};

const getResultHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  const r = await db.fetchAndAdvanceResult(idResult.data);
  if (!r) return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  return c.json({ state: r.stateAtRead, result: r.result });
};

// --- Routes ------------------------------------------------------------------

app.post('/new', newPageLimiter, newPageHandler);
app.get('/:id', getPageHandler);
app.post('/:id/result', submitResultHandler);
app.get('/:id/result', getResultHandler);
