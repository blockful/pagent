import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { z } from 'zod';
import { ALLOWED_ORIGINS } from '../app/config.ts';
import { requireAuth, requireScope, type AuthVariables } from '../auth/middleware.ts';
import { clientKey } from '../client-key.ts';
import { deckIdSchema } from './domain.ts';
import {
  documentCsp,
  documentOrigins,
  renderDocumentError,
  renderHtmlDocument,
  type RendererOrigin,
} from './html-document.ts';
import { DeckForbiddenError, getDeckPreview } from './repository-decks.ts';
import { getViewerDeck, ViewerSessionUnavailableError } from './repository-viewer-access.ts';

type DocumentVariables = AuthVariables & { readonly documentOrigin: RendererOrigin };
type DocumentContext = Context<{ Variables: DocumentVariables }>;
type DocumentSource = { readonly revisionId: string; readonly html: string | null };
const origins = documentOrigins(ALLOWED_ORIGINS);
const ownerFormSchema = z
  .object({ deck_id: deckIdSchema, revision_id: z.string().uuid() })
  .strict();
const viewerFormSchema = z
  .object({ session_token: z.string().min(20).max(200), revision_id: z.string().uuid() })
  .strict();
const frameLimiter = rateLimiter({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => clientKey(c.req.header('x-real-ip')),
  handler: (c) => {
    c.header('Retry-After', '60');
    return c.json({ error: 'rate_limited', retry_after_seconds: 60 }, 429);
  },
});

const requireRendererOrigin: MiddlewareHandler<{ Variables: DocumentVariables }> = async (
  c,
  next,
) => {
  c.header('Cache-Control', 'private, no-store');
  const origin = origins.find((allowed) => allowed === c.req.header('origin'));
  if (origin === undefined) return c.json({ error: 'forbidden' }, 403);
  c.set('documentOrigin', origin);
  await next();
  const acceptsHtml = c.req
    .header('accept')
    ?.split(',')
    .some((value) => value.split(';')[0]?.trim().toLowerCase() === 'text/html');
  if (c.res.status < 400 || !acceptsHtml) return;
  permitDocumentFrame(c);
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Content-Length', undefined);
  c.res = new Response(renderDocumentError(origin), {
    status: c.res.status,
    headers: c.res.headers,
  });
};

export const documentRoutes = new Hono<{ Variables: DocumentVariables }>();

documentRoutes.post('/viewer/document', requireRendererOrigin, frameLimiter, async (c) => {
  const parsed = viewerFormSchema.safeParse(await documentForm(c));
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
  try {
    return serveDocument(
      c,
      await getViewerDeck(parsed.data.session_token),
      parsed.data.revision_id,
    );
  } catch (error) {
    if (error instanceof ViewerSessionUnavailableError) {
      return c.json({ error: 'unavailable' }, error.state === 'not_found' ? 404 : 410);
    }
    throw error;
  }
});

documentRoutes.post(
  '/owner/document',
  requireRendererOrigin,
  frameLimiter,
  requireAuth(),
  requireScope('page:read'),
  async (c) => {
    const parsed = ownerFormSchema.safeParse(await documentForm(c));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const user = c.var.user;
    if (user === null) return c.json({ error: 'unauthorized' }, 401);
    try {
      return serveDocument(
        c,
        await getDeckPreview(user.id, parsed.data.deck_id),
        parsed.data.revision_id,
      );
    } catch (error) {
      if (error instanceof DeckForbiddenError) return c.json({ error: 'forbidden' }, 403);
      throw error;
    }
  },
);

async function documentForm(c: DocumentContext) {
  try {
    return await c.req.parseBody({ all: true });
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function serveDocument(c: DocumentContext, document: DocumentSource, expectedRevision: string) {
  if (document.revisionId !== expectedRevision) return c.json({ error: 'revision_changed' }, 409);
  if (document.html === null) return c.json({ error: 'unsupported_format' }, 415);
  permitDocumentFrame(c);
  return c.html(renderHtmlDocument(document.html, c.var.documentOrigin, document.revisionId));
}

function permitDocumentFrame(c: DocumentContext): void {
  c.header('Content-Security-Policy', documentCsp(origins));
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', undefined);
}
