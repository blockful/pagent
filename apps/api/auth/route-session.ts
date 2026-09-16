import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import * as db from '../db.ts';
import type { AuthVariables } from './middleware.ts';
import { SESSION_COOKIE_NAME } from './middleware.ts';
import { clearSessionCookie } from './route-shared.ts';
import { deleteSession } from './session.ts';

type AuthRouter = Hono<{ Variables: AuthVariables }>;

export function registerSessionRoutes(authRoutes: AuthRouter): void {
  authRoutes.get('/auth/me', async (c) => {
    const user = c.var.user;
    if (!user || user.authMethod !== 'cookie') {
      return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
    }
    const row = await db.getUserById(user.id);
    if (!row) return c.json({ error: 'unauthorized', message: 'User not found' }, 401);
    return c.json({
      id: row.id,
      handle: row.handle,
      email: row.email,
      name: row.name,
      avatar_url: row.avatar_url,
    });
  });

  authRoutes.post('/auth/logout', async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionToken) await deleteSession(sessionToken);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
}
