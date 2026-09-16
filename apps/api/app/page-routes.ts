import type { Context, Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import * as db from '../db.ts';
import * as store from '../store.ts';
import { clientKey } from '../client-key.ts';
import { metrics } from '../metrics.ts';
import type { AuthVariables } from '../auth/middleware.ts';
import { requireAuth, requireScope } from '../auth/middleware.ts';
import type { RequestIdVariables } from '../request-id.ts';
import { getLog, getRequestId } from '../request-id.ts';
import { newPageBodySchema, pageIdSchema, resultBodySchema, env } from '../schemas.ts';
import { A2UI_MAX_SPEC_BYTES, PAGE_TTL_MS, PUBLIC_URL } from './config.ts';

export function createNewPageLimiter() {
  return rateLimiter({
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
}

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
  const { format, spec } = result.data;

  if (format === 'a2ui') {
    // Enforce the historical 256 KB cap on A2UI specs; HTML uses the full 1 MB.
    // The bodyLimit middleware lets us inspect the parsed value here without
    // double-paying for the read.
    const serialized = JSON.stringify(spec ?? null);
    if (serialized.length > A2UI_MAX_SPEC_BYTES) {
      return c.json(
        {
          error: 'payload_too_large',
          format: 'a2ui',
          max_bytes: A2UI_MAX_SPEC_BYTES,
          message: `A2UI spec exceeds the ${A2UI_MAX_SPEC_BYTES}-byte limit`,
        },
        413,
      );
    }
  }

  // Authenticated user id flows from resolveAuth() (cookie or Bearer JWT) onto
  // c.var.user. Null during the grace period; the row goes in with
  // owner_id = NULL. When REQUIRE_AUTH=true, requireAuthIfEnabled has already
  // rejected anonymous requests with 401 — so this read is non-null in that path.
  const ownerId = c.var.user?.id ?? null;

  if (format === 'html') {
    try {
      const created = await store.createHtmlPage(
        spec as string,
        { publicUrl: PUBLIC_URL, pageTtlMs: PAGE_TTL_MS, ownerId },
        getLog(c),
      );
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof store.SanitizedEmptyError) {
        return c.json(
          {
            error: 'sanitized_empty',
            format: 'html',
            message: err.message,
          },
          400,
        );
      }
      throw err;
    }
  }

  const created = await store.createPage(spec, format, {
    publicUrl: PUBLIC_URL,
    pageTtlMs: PAGE_TTL_MS,
    ownerId,
  });
  return c.json(created, 201);
};

const getPageHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  const p = await db.getActivePage(idResult.data);
  if (!p) return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  // The "render" signal for the adoption funnel: a page being fetched by the
  // renderer is the closest server-side proxy for "the user saw the UI".
  // Only count while state is "open" — after submit the renderer polls this
  // same endpoint (2s→30s backoff) waiting for the "received" flip, and those
  // reads are not renders. html pages are view-only and stay "open", so every
  // view of them counts.
  if (p.state === 'open') metrics.pagesViewed.add(1, { format: p.format });
  return c.json({
    spec: p.spec,
    format: p.format,
    state: p.state,
    result: p.result,
    expires_at: p.expiresAt,
  });
};

const submitResultHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);

  // Format check happens before body parse to fail fast on HTML pages. HTML
  // pages are view-only — there is no submit pipeline for them.
  const page = await db.getActivePage(idResult.data);
  if (!page) return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  if (page.format === 'html') {
    return c.json(
      {
        error: 'invalid_for_format',
        format: page.format,
        message: 'POST /:id/result is not supported for format=html; HTML pages are view-only',
      },
      400,
    );
  }
  // Future formats: TypeScript exhaustiveness check — if PageFormat grows a new
  // variant, this assignment fails to typecheck and forces maintainers to
  // either handle the format above or remove it from the discriminated union.
  const _exhaustive: 'a2ui' = page.format;
  void _exhaustive;

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
  metrics.pagesSubmitted.add(1, { format: page.format });
  metrics.pageSubmitLatency.record((Date.now() - outcome.createdAt.getTime()) / 1000);
  return c.json({ ok: true });
};

const getResultHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  const outcome = await store.advanceResult(idResult.data);
  if (outcome.kind === 'not_found')
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  return c.json({
    state: outcome.state,
    result: outcome.result,
    format: outcome.format,
  });
};

export function registerPageRoutes(
  app: Hono<{ Variables: RequestIdVariables & AuthVariables }>,
  newPageLimiter: ReturnType<typeof createNewPageLimiter>,
): void {
  /**
   * No-op or 401-gating middleware, chosen at module load based on the
   * REQUIRE_AUTH env var. Centralizing the branch here means route declarations
   * stay clean and the grace-period behavior (REQUIRE_AUTH=false → no rejection)
   * is the boring path.
   *
   * When REQUIRE_AUTH=false: passes through. POST /new still gets c.var.user
   * populated by resolveAuth, but anonymous requests succeed (matches the spec's
   * phased rollout — see §8.2 "Grace period").
   * When REQUIRE_AUTH=true: returns 401 for anonymous requests on protected
   * routes (§8.3).
   */
  const requireAuthIfEnabled: ReturnType<typeof requireAuth> = env.REQUIRE_AUTH
    ? requireAuth()
    : async (_c, next) => {
        await next();
      };

  // POST /new — gated by requireAuth when REQUIRE_AUTH=true; otherwise the
  // requireAuthIfEnabled middleware is a no-op pass-through.
  app.post(
    '/new',
    requireAuthIfEnabled,
    requireScope('page:create'),
    newPageLimiter,
    newPageHandler,
  );
  app.get('/:id', getPageHandler);
  app.post('/:id/result', submitResultHandler);
  app.get('/:id/result', requireAuthIfEnabled, requireScope('page:read'), getResultHandler);
}
