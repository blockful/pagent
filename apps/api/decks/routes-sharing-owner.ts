import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthVariables } from '../auth/middleware.ts';
import { requireAuth } from '../auth/middleware.ts';
import { createShareLinkBodySchema, deckIdSchema, shareLinkIdSchema } from './domain.ts';
import { accessDecisionBodySchema } from './http-schemas.ts';
import { DeckForbiddenError } from './repository-decks.ts';
import {
  listAccessRequests,
  listShareLinks,
  updateShareLink,
} from './repository-sharing-management.ts';
import { createShareLink, decideAccessRequest, revokeShareLink } from './repository-sharing.ts';
import { grantOwnerPreview } from './repository-viewer-preview.ts';

type SharingContext = Context<{ Variables: AuthVariables }>;
const requestIdSchema = z.string().uuid();
export const ownerSharingRoutes = new Hono<{ Variables: AuthVariables }>();

ownerSharingRoutes.use('/decks/*', requireAuth());

ownerSharingRoutes.post('/decks/:deckId/share-links', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const body = createShareLinkBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await createShareLink(user.id, deckId.data, body.data), 201);
  } catch (error) {
    return sharingError(c, error);
  }
});

ownerSharingRoutes.get('/decks/:deckId/share-links', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json({ links: await listShareLinks(user.id, deckId.data) });
  } catch (error) {
    return sharingError(c, error);
  }
});

ownerSharingRoutes.put('/decks/:deckId/share-links/:linkId', async (c) => {
  const ids = parseIds(c);
  const body = createShareLinkBodySchema.safeParse(await c.req.json().catch(() => null));
  if (ids === null) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await updateShareLink({
      userId: user.id,
      deckId: ids.deckId,
      linkId: ids.linkId,
      body: body.data,
    });
    return c.body(null, 204);
  } catch (error) {
    return sharingError(c, error);
  }
});

ownerSharingRoutes.post('/decks/:deckId/share-links/:linkId/revoke', async (c) => {
  const ids = parseIds(c);
  if (ids === null) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await revokeShareLink(user.id, ids.deckId, ids.linkId);
    return c.body(null, 204);
  } catch (error) {
    return sharingError(c, error);
  }
});

ownerSharingRoutes.post('/decks/:deckId/share-links/:linkId/preview', async (c) => {
  const ids = parseIds(c);
  if (ids === null) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await grantOwnerPreview(user.id, ids.linkId));
  } catch (error) {
    return sharingError(c, error);
  }
});

ownerSharingRoutes.get('/decks/:deckId/share-links/:linkId/requests', async (c) => {
  const ids = parseIds(c);
  if (ids === null) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json({ requests: await listAccessRequests(user.id, ids.deckId, ids.linkId) });
  } catch (error) {
    return sharingError(c, error);
  }
});

ownerSharingRoutes.post('/decks/:deckId/share-links/:linkId/requests/:requestId', async (c) => {
  const ids = parseIds(c);
  const requestId = requestIdSchema.safeParse(c.req.param('requestId'));
  const body = accessDecisionBodySchema.safeParse(await c.req.json().catch(() => null));
  if (ids === null || !requestId.success) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await decideAccessRequest({
      userId: user.id,
      linkId: ids.linkId,
      requestId: requestId.data,
      decision: body.data.decision,
    });
    return c.body(null, 204);
  } catch (error) {
    return sharingError(c, error);
  }
});

function parseIds(c: SharingContext): { readonly deckId: string; readonly linkId: string } | null {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const linkId = shareLinkIdSchema.safeParse(c.req.param('linkId'));
  return deckId.success && linkId.success ? { deckId: deckId.data, linkId: linkId.data } : null;
}

function sharingError(c: SharingContext, error: unknown) {
  if (error instanceof DeckForbiddenError) return c.json({ error: 'forbidden' }, 403);
  if (error instanceof RangeError)
    return c.json({ error: 'bad_request', message: error.message }, 400);
  throw error;
}
