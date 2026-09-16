import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { apiReference } from '@scalar/hono-api-reference';
import { trace } from '@opentelemetry/api';
import * as db from './db.ts';
import type { AuthVariables } from './auth/middleware.ts';
import { resolveAuth } from './auth/middleware.ts';
import { authRoutes } from './auth/routes.ts';
import { logger } from './logger.ts';
import { metrics, statusClassFor } from './metrics.ts';
import type { RequestIdVariables } from './request-id.ts';
import { getLog, getRequestId, requestId } from './request-id.ts';
import { ALLOWED_ORIGINS, MAX_BODY_BYTES } from './app/config.ts';
import { createNewPageLimiter, registerPageRoutes } from './app/page-routes.ts';

export {
  ALLOWED_ORIGINS,
  A2UI_MAX_SPEC_BYTES,
  MAX_BODY_BYTES,
  PAGE_TTL_MS,
  PORT,
  PUBLIC_URL,
} from './app/config.ts';

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

const newPageLimiter = createNewPageLimiter();

// --- App ---------------------------------------------------------------------

export const app = new Hono<{ Variables: RequestIdVariables & AuthVariables }>();
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
    // block the renderer at pagent.link from reading API responses at
    // api.pagent.link. CORS already gates cross-origin reads explicitly.
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

// --- Auth resolution ---------------------------------------------------------
// Populate c.var.user from the session cookie or Bearer JWT on EVERY route.
// Never short-circuits — `requireAuth()` is the gatekeeper for protected
// endpoints. Mounted before any route handler so subsequent middlewares
// (e.g. requireAuth on POST /new) can read c.var.user.

app.use('*', resolveAuth());

// --- Auth / OAuth discovery --------------------------------------------------
// Mounts the three .well-known endpoints (AS metadata, protected resource
// metadata, JWKS). Mounted at root so the literal RFC-defined paths land
// where MCP clients expect them. No auth required.

app.route('/', authRoutes);
registerPageRoutes(app, newPageLimiter);
