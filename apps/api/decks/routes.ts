import { Hono } from 'hono';
import type { AuthVariables } from '../auth/middleware.ts';
import { ownerDeckRoutes } from './routes-owner.ts';
import { ownerSharingRoutes } from './routes-sharing-owner.ts';
import { permissionRoutes } from './routes-permissions.ts';
import { viewerRoutes } from './routes-viewer.ts';
import { workspaceAdminRoutes } from './routes-workspace-admin.ts';

export const deckRoutes = new Hono<{ Variables: AuthVariables }>();

deckRoutes.route('/', ownerDeckRoutes);
deckRoutes.route('/', ownerSharingRoutes);
deckRoutes.route('/', permissionRoutes);
deckRoutes.route('/', viewerRoutes);
deckRoutes.route('/', workspaceAdminRoutes);
