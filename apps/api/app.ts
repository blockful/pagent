import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Context } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import type { Page } from './db.ts';
import { env, pageIdSchema, newPageBodySchema, resultBodySchema } from './schemas.ts';
import { logger } from './logger.ts';

// --- Storage -----------------------------------------------------------------

export const PORT = env.PORT;
// Prefer PUBLIC_URL; on Railway fall back to the known Vercel renderer rather
// than the container's localhost (Railway env injection has been flaky for this var).
export const PUBLIC_URL =
  env.PUBLIC_URL ??
  (env.RAILWAY_ENVIRONMENT ? 'https://pagent.vercel.app' : `http://localhost:${PORT}`);
export const PAGE_TTL_MS = env.PAGE_TTL_MS;
export const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS;

export const MAX_BODY_BYTES = 256 * 1024; // 256 KB

export const pages = new Map<string, Page>();

export const newId = () => randomBytes(16).toString('hex');

// Extract the rate-limit key from the request. Behind Railway / Vercel the
// real client IP arrives in x-forwarded-for (first hop). In local dev and
// tests no proxy is present, so we collapse everything into a single bucket.
const clientKey = (c: Context): string => {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
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
    return c.json({ error: 'rate_limited', retry_after_seconds: retryAfter }, 429);
  },
});

export const isExpired = (p: Page) => Date.now() >= p.expiresAt;

export const getLivePage = (id: string): Page | null => {
  const p = pages.get(id);
  if (!p) return null;
  if (isExpired(p)) {
    pages.delete(id);
    db.deletePage(id).catch((err) =>
      logger.error({ err, page_id: id }, 'lazy ttl db delete failed'),
    );
    return null;
  }
  return p;
};

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pages) {
    if (now >= p.expiresAt) {
      pages.delete(id);
      db.deletePage(id).catch((err) =>
        logger.error({ err, page_id: id }, 'ttl sweep db delete failed'),
      );
    }
  }
}, 60_000).unref();

// --- App ---------------------------------------------------------------------

export const app = new Hono();
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
    onError: (c) => c.json({ error: 'payload_too_large', max_bytes: MAX_BODY_BYTES }, 413),
  }),
);

app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - start,
    },
    'request',
  );
});

app.get('/health', (c) => c.json({ ok: true, pages: pages.size }));

app.post('/new', newPageLimiter, async (c) => {
  const raw = await c.req.json().catch(() => null);
  const result = newPageBodySchema.safeParse(raw);
  if (!result.success) {
    return c.json({ error: 'bad_request', issues: result.error.issues }, 400);
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
  pages.set(page.id, page);
  return c.json({ id: page.id, url: `${PUBLIC_URL}/${page.id}`, expires_at: page.expiresAt }, 201);
});

app.get('/:id', (c) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success) return c.json({ error: 'not_found' }, 404);
  const p = getLivePage(idResult.data);
  if (!p) return c.json({ error: 'not_found' }, 404);
  return c.json({
    spec: p.spec,
    state: p.state,
    result: p.result,
    expires_at: p.expiresAt,
  });
});

app.post('/:id/result', async (c) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success) return c.json({ error: 'not_found' }, 404);
  const p = getLivePage(idResult.data);
  if (!p) return c.json({ error: 'not_found' }, 404);
  if (p.state !== 'open') return c.json({ error: 'conflict', state: p.state }, 409);
  const raw = await c.req.json().catch(() => null);
  const bodyResult = resultBodySchema.safeParse(raw);
  if (!bodyResult.success) {
    return c.json({ error: 'bad_request', issues: bodyResult.error.issues }, 400);
  }
  const action = bodyResult.data;
  await db.markSubmitted(p.id, action);
  p.state = 'submitted';
  p.result = action;
  return c.json({ ok: true });
});

app.get('/:id/result', async (c) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success) return c.json({ error: 'not_found' }, 404);
  const p = getLivePage(idResult.data);
  if (!p) return c.json({ error: 'not_found' }, 404);
  const stateAtRead = p.state;
  if (p.state === 'submitted') {
    await db.markReceived(p.id);
    p.state = 'received';
  }
  return c.json({ state: stateAtRead, result: p.result });
});
