import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import type { Page } from './db.ts';
import { env, pageIdSchema, newPageBodySchema, resultBodySchema } from './schemas.ts';

// --- Storage -----------------------------------------------------------------

const PORT = env.PORT;
// Prefer PUBLIC_URL; on Railway fall back to the known Vercel renderer rather
// than the container's localhost (Railway env injection has been flaky for this var).
const PUBLIC_URL =
  env.PUBLIC_URL ??
  (env.RAILWAY_ENVIRONMENT ? 'https://pagent.vercel.app' : `http://localhost:${PORT}`);
const PAGE_TTL_MS = env.PAGE_TTL_MS;
const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS;

const pages = new Map<string, Page>();

const newId = () => randomBytes(16).toString('hex');

const isExpired = (p: Page) => Date.now() >= p.expiresAt;

const getLivePage = (id: string): Page | null => {
  const p = pages.get(id);
  if (!p) return null;
  if (isExpired(p)) {
    pages.delete(id);
    db.deletePage(id).catch((err) => console.error('lazy ttl db delete failed', id, err));
    return null;
  }
  return p;
};

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pages) {
    if (now >= p.expiresAt) {
      pages.delete(id);
      db.deletePage(id).catch((err) => console.error('ttl sweep db delete failed', id, err));
    }
  }
}, 60_000).unref();

// --- App ---------------------------------------------------------------------

const app = new Hono();
app.use('*', cors({ origin: ALLOWED_ORIGINS ?? '*' }));

app.get('/health', (c) => c.json({ ok: true, pages: pages.size }));

app.post('/new', async (c) => {
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

// --- Boot --------------------------------------------------------------------

await db.init(env.DATABASE_URL);
await db.loadActivePages(pages);
console.log(`rehydrated ${pages.size} page(s) from db`);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`pagent listening on ${PUBLIC_URL} (port ${info.port})`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down`);
  server.close();
  await db.shutdown();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
