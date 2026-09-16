import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthVariables } from '../auth/middleware.ts';
import { requireAuth, requirePageScopeForMethod } from '../auth/middleware.ts';
import {
  WorkspaceAdminForbiddenError,
  WorkspaceMemberNotFoundError,
  addManagedWorkspaceMember,
  getWorkspaceAdminView,
  suspendWorkspaceMember,
  updateWorkspacePolicy,
} from './repository-workspace-admin.ts';

const memberBodySchema = z
  .object({ email: z.string().trim().email(), role: z.enum(['admin', 'member']) })
  .strict();
const policyBodySchema = z
  .object({
    consentRequired: z.boolean(),
    retentionDays: z.number().int().min(30).max(2_555),
  })
  .strict();
const memberIdSchema = z.string().uuid();

export const workspaceAdminRoutes = new Hono<{ Variables: AuthVariables }>();
type WorkspaceContext = Context<{ Variables: AuthVariables }>;

workspaceAdminRoutes.use('/workspace', requireAuth(), requirePageScopeForMethod());
workspaceAdminRoutes.use('/workspace/*', requireAuth(), requirePageScopeForMethod());

workspaceAdminRoutes.get('/workspace', async (c) => {
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await getWorkspaceAdminView(user.id));
  } catch (error) {
    return workspaceError(c, error);
  }
});

workspaceAdminRoutes.post('/workspace/members', async (c) => {
  const body = memberBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await addManagedWorkspaceMember(user.id, body.data), 201);
  } catch (error) {
    return workspaceError(c, error);
  }
});

workspaceAdminRoutes.delete('/workspace/members/:memberId', async (c) => {
  const memberId = memberIdSchema.safeParse(c.req.param('memberId'));
  if (!memberId.success) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await suspendWorkspaceMember(user.id, memberId.data);
    return c.body(null, 204);
  } catch (error) {
    return workspaceError(c, error);
  }
});

workspaceAdminRoutes.put('/workspace/policy', async (c) => {
  const body = policyBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const user = c.var.user;
  if (user === null) return c.json({ error: 'unauthorized' }, 401);
  try {
    await updateWorkspacePolicy(user.id, body.data);
    return c.body(null, 204);
  } catch (error) {
    return workspaceError(c, error);
  }
});

function workspaceError(c: WorkspaceContext, error: unknown) {
  if (error instanceof WorkspaceAdminForbiddenError) return c.json({ error: 'forbidden' }, 403);
  if (error instanceof WorkspaceMemberNotFoundError) return c.json({ error: 'not_found' }, 404);
  throw error;
}
