import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomBytes } from 'node:crypto';

// --- Types -------------------------------------------------------------------

type PageState = 'open' | 'submitted' | 'received';

type Page = {
  id: string;
  spec: unknown;
  state: PageState;
  result: unknown;
  createdAt: number;
  expiresAt: number;
};

// --- Storage -----------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PAGE_TTL_MS = Number(process.env.PAGE_TTL_MS ?? 30 * 60 * 1000);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const pages = new Map<string, Page>();

const newId = () => randomBytes(16).toString('hex');

const isExpired = (p: Page) => Date.now() >= p.expiresAt;

const getLivePage = (id: string): Page | null => {
  const p = pages.get(id);
  if (!p) return null;
  if (isExpired(p)) {
    pages.delete(id);
    return null;
  }
  return p;
};

// Periodic TTL sweep
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pages) {
    if (now >= p.expiresAt) pages.delete(id);
  }
}, 60_000).unref();

// --- App ---------------------------------------------------------------------

const app = new Hono();
// If ALLOWED_ORIGINS is set, restrict to that comma-separated list.
// If unset (e.g. local dev), allow all origins.
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
  p.state = 'submitted';
  p.result = action;
  return c.json({ ok: true });
});

app.get('/:id/result', (c) => {
  const p = getLivePage(c.req.param('id'));
  if (!p) return c.json({ error: 'not_found' }, 404);
  const stateAtRead = p.state;
  // Side effect: first read while submitted transitions to received.
  if (p.state === 'submitted') p.state = 'received';
  return c.json({ state: stateAtRead, result: p.result });
});

// --- Boot --------------------------------------------------------------------

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`agent-ui-session listening on ${PUBLIC_URL} (port ${info.port})`);
});
