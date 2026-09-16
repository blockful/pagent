import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthVariables } from '../auth/middleware.ts';
import { requireAuth } from '../auth/middleware.ts';
import { analyticsVisibilitySchema, deckIdSchema } from './domain.ts';
import {
  deleteViewerAnalytics,
  getAccessSettings,
  getAuditLog,
  removeWorkspaceMember,
  setAnalyticsPolicy,
} from './repository-access-settings.ts';
import { DeckForbiddenError } from './repository-decks.ts';
import {
  addWorkspaceMember,
  createTeam,
  previewAnalyticsVisibility,
  setAnalyticsVisibility,
  setDeckCollaborators,
} from './repository-permissions.ts';

type PermissionContext = Context<{ Variables: AuthVariables }>;

const memberBodySchema = z
  .object({ email: z.string().trim().email(), role: z.enum(['admin', 'member']) })
  .strict();
const memberIdsBodySchema = z.object({ memberIds: z.array(z.string().uuid()).max(500) }).strict();
const teamBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    memberIds: z.array(z.string().uuid()).min(1).max(500),
  })
  .strict();
const visibilityBodySchema = z
  .object({
    scope: analyticsVisibilitySchema,
    subjectIds: z.array(z.string().uuid()).max(500),
  })
  .strict();
const policyBodySchema = z
  .object({
    consentRequired: z.boolean(),
    retentionDays: z.number().int().min(30).max(2_555),
  })
  .strict();
const viewerDeletionBodySchema = z.object({ email: z.string().trim().email() }).strict();
const memberIdSchema = z.string().uuid();

export const permissionRoutes = new Hono<{ Variables: AuthVariables }>();
permissionRoutes.use('/decks/*', requireAuth());

permissionRoutes.post('/decks/:deckId/access/members', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const body = memberBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await addWorkspaceMember(user.id, deckId.data, body.data), 201);
  } catch (error) {
    return permissionError(c, error);
  }
});

permissionRoutes.get('/decks/:deckId/access', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await getAccessSettings(user.id, deckId.data));
  } catch (error) {
    return permissionError(c, error);
  }
});

permissionRoutes.put('/decks/:deckId/access/policy', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const body = policyBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await setAnalyticsPolicy(user.id, deckId.data, body.data);
    return c.body(null, 204);
  } catch (error) {
    return permissionError(c, error);
  }
});

permissionRoutes.delete('/decks/:deckId/access/members/:memberId', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const memberId = memberIdSchema.safeParse(c.req.param('memberId'));
  if (!deckId.success || !memberId.success) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await removeWorkspaceMember(user.id, deckId.data, memberId.data);
    return c.body(null, 204);
  } catch (error) {
    return permissionError(c, error);
  }
});

permissionRoutes.delete('/decks/:deckId/analytics/viewer', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const body = viewerDeletionBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json({
      removedVisits: await deleteViewerAnalytics(user.id, deckId.data, body.data.email),
    });
  } catch (error) {
    return permissionError(c, error);
  }
});

permissionRoutes.get('/decks/:deckId/audit', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json({ events: await getAuditLog(user.id, deckId.data) });
  } catch (error) {
    return permissionError(c, error);
  }
});

permissionRoutes.post('/decks/:deckId/access/teams', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const body = teamBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await createTeam(user.id, deckId.data, body.data), 201);
  } catch (error) {
    return permissionError(c, error);
  }
});

permissionRoutes.put('/decks/:deckId/access/collaborators', async (c) => {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const body = memberIdsBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await setDeckCollaborators(user.id, deckId.data, body.data.memberIds);
    return c.body(null, 204);
  } catch (error) {
    return permissionError(c, error);
  }
});

permissionRoutes.post('/decks/:deckId/access/analytics/preview', async (c) => {
  return visibility(c, true);
});

permissionRoutes.put('/decks/:deckId/access/analytics', async (c) => {
  return visibility(c, false);
});

async function visibility(c: PermissionContext, preview: boolean) {
  const deckId = deckIdSchema.safeParse(c.req.param('deckId'));
  const body = visibilityBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!deckId.success) return c.json({ error: 'not_found' }, 404);
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    const result = preview
      ? await previewAnalyticsVisibility(user.id, deckId.data, body.data)
      : await setAnalyticsVisibility(user.id, deckId.data, body.data);
    return c.json(result);
  } catch (error) {
    return permissionError(c, error);
  }
}

function permissionError(c: PermissionContext, error: unknown) {
  if (error instanceof DeckForbiddenError) return c.json({ error: 'forbidden' }, 403);
  throw error;
}
