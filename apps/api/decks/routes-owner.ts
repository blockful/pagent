import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthVariables } from '../auth/middleware.ts';
import { requireAuth, requirePageScopeForMethod } from '../auth/middleware.ts';
import {
  analyticsQuerySchema,
  analyticsUrlQuerySchema,
  deckIdSchema,
  deckListQuerySchema,
  publishDeckBodySchema,
} from './domain.ts';
import {
  DeckForbiddenError,
  InvalidDeckContentError,
  deleteDeck,
  getDeckDetail,
  getDeckPreview,
  listDecks,
  publishDeck,
  setDeckStatus,
  updateDeckTitle,
} from './repository-decks.ts';
import { getDeckAnalytics } from './repository-analytics.ts';
import { exportDeckAnalyticsCsv } from './repository-analytics-export.ts';

const deckMutationSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
  })
  .strict();

export const ownerDeckRoutes = new Hono<{ Variables: AuthVariables }>();
type DeckContext = Context<{ Variables: AuthVariables }>;

ownerDeckRoutes.use('/decks', requireAuth(), requirePageScopeForMethod());
ownerDeckRoutes.use('/decks/*', requireAuth(), requirePageScopeForMethod());

ownerDeckRoutes.post('/decks', async (c) => {
  const parsed = publishDeckBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalidBody(c, parsed.error.issues);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    const deck = await publishDeck(user, parsed.data);
    return c.json(deck, parsed.data.update_deck_id === undefined ? 201 : 200);
  } catch (error) {
    return deckError(c, error);
  }
});

ownerDeckRoutes.get('/decks', async (c) => {
  const parsed = deckListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return invalidBody(c, parsed.error.issues);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ decks: await listDecks(user.id, parsed.data) });
});

ownerDeckRoutes.get('/decks/:deckId/preview', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await getDeckPreview(user.id, deckId.data));
  } catch (error) {
    return deckError(c, error);
  }
});

ownerDeckRoutes.get('/decks/:deckId', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await getDeckDetail(user.id, deckId.data));
  } catch (error) {
    return deckError(c, error);
  }
});

ownerDeckRoutes.get('/decks/:deckId/analytics', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const query = analyticsUrlQuerySchema.safeParse(c.req.query());
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!query.success) return invalidBody(c, query.error.issues);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await getDeckAnalytics(user.id, deckId.data, query.data));
  } catch (error) {
    return deckError(c, error);
  }
});

ownerDeckRoutes.post('/decks/:deckId/analytics/query', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const filters = analyticsQuerySchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!filters.success) return invalidBody(c, filters.error.issues);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await getDeckAnalytics(user.id, deckId.data, filters.data));
  } catch (error) {
    return deckError(c, error);
  }
});

ownerDeckRoutes.get('/decks/:deckId/analytics.csv', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const query = analyticsUrlQuerySchema.safeParse(c.req.query());
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!query.success) return invalidBody(c, query.error.issues);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    const csv = await exportDeckAnalyticsCsv(user.id, deckId.data, query.data);
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="deck-${deckId.data}-analytics.csv"`,
    });
  } catch (error) {
    return deckError(c, error);
  }
});

ownerDeckRoutes.post('/decks/:deckId/analytics.csv', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const filters = analyticsQuerySchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!filters.success) return invalidBody(c, filters.error.issues);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    const csv = await exportDeckAnalyticsCsv(user.id, deckId.data, filters.data);
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="deck-${deckId.data}-analytics.csv"`,
    });
  } catch (error) {
    return deckError(c, error);
  }
});

ownerDeckRoutes.patch('/decks/:deckId', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const body = deckMutationSchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return invalidBody(c, body.error.issues);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await updateDeckTitle(user.id, deckId.data, body.data.title);
    return c.body(null, 204);
  } catch (error) {
    return deckError(c, error);
  }
});

ownerDeckRoutes.post('/decks/:deckId/archive', async (c) => {
  return setStatus(c, 'archived');
});

ownerDeckRoutes.post('/decks/:deckId/restore', async (c) => {
  return setStatus(c, 'active');
});

ownerDeckRoutes.delete('/decks/:deckId', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await deleteDeck(user.id, deckId.data);
    return c.body(null, 204);
  } catch (error) {
    return deckError(c, error);
  }
});

async function setStatus(c: DeckContext, status: 'active' | 'archived') {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await setDeckStatus(user.id, deckId.data, status);
    return c.body(null, 204);
  } catch (error) {
    return deckError(c, error);
  }
}

function invalidBody(c: DeckContext, issues: readonly unknown[]) {
  return c.json({ error: 'bad_request', issues }, 400);
}

function deckError(c: DeckContext, error: unknown) {
  if (error instanceof DeckForbiddenError) return c.json({ error: 'forbidden' }, 403);
  if (error instanceof InvalidDeckContentError || error instanceof RangeError) {
    return c.json({ error: 'bad_request', message: error.message }, 400);
  }
  throw error;
}
