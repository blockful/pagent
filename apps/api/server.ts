import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import type { Page } from './db.ts';

// --- Storage -----------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8787);
// Prefer PUBLIC_URL; on Railway fall back to the known Vercel renderer rather
// than the container's localhost (Railway env injection has been flaky for this var).
const PUBLIC_URL =
  process.env.PUBLIC_URL ??
  (process.env.RAILWAY_ENVIRONMENT ? 'https://pagent.vercel.app' : `http://localhost:${PORT}`);
const PAGE_TTL_MS = Number(process.env.PAGE_TTL_MS ?? 30 * 60 * 1000);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

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
  const body = await c.req.json().catch(() => null) as { spec?: unknown } | null;
  if (!body || !('spec' in body) || body.spec === undefined) {
    return c.json({ error: 'bad_request', detail: 'expected { spec }' }, 400);
  }
  const now = Date.now();
  const page: Page = {
    id: newId(),
    spec: body.spec,
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
  const p = getLivePage(c.req.param('id'));
  if (!p) return c.json({ error: 'not_found' }, 404);
  return c.json({
    spec: p.spec,
    state: p.state,
    result: p.result,
    expires_at: p.expiresAt,
  });
});

app.post('/:id/result', async (c) => {
  const p = getLivePage(c.req.param('id'));
  if (!p) return c.json({ error: 'not_found' }, 404);
  if (p.state !== 'open') return c.json({ error: 'conflict', state: p.state }, 409);
  const action = await c.req.json().catch(() => null);
  if (action === null) return c.json({ error: 'bad_request' }, 400);
  await db.markSubmitted(p.id, action);
  p.state = 'submitted';
  p.result = action;
  return c.json({ ok: true });
});

app.get('/:id/result', async (c) => {
  const p = getLivePage(c.req.param('id'));
  if (!p) return c.json({ error: 'not_found' }, 404);
  const stateAtRead = p.state;
  if (p.state === 'submitted') {
    await db.markReceived(p.id);
    p.state = 'received';
  }
  return c.json({ state: stateAtRead, result: p.result });
});

// --- Boot --------------------------------------------------------------------

await db.init(DATABASE_URL);
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
