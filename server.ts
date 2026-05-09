import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { randomBytes } from 'node:crypto';

// --- Types -------------------------------------------------------------------

type SessionEvent =
  | { id: number; type: 'surface_updated'; format: string; spec: unknown; ts: number }
  | { id: number; type: 'user_action'; action: unknown; ts: number }
  | { id: number; type: 'session_closed'; ts: number };

type Session = {
  id: string;
  createdAt: number;
  expiresAt: number;
  surface: { format: string; spec: unknown } | null;
  events: SessionEvent[];
  waiters: Set<(ev: SessionEvent) => void>;
};

// --- Storage -----------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const TTL_MS = Number(process.env.SESSION_TTL_MS ?? 30 * 60 * 1000);
const MAX_LONGPOLL_MS = 25_000;

const sessions = new Map<string, Session>();

const newId = () => randomBytes(16).toString('hex');

const newSession = (): Session => {
  const now = Date.now();
  return {
    id: newId(),
    createdAt: now,
    expiresAt: now + TTL_MS,
    surface: null,
    events: [],
    waiters: new Set(),
  };
};

const isExpired = (s: Session) => Date.now() >= s.expiresAt;

const touch = (s: Session) => {
  s.expiresAt = Date.now() + TTL_MS;
};

const append = (s: Session, ev: Omit<SessionEvent, 'id' | 'ts'> & { ts?: number }): SessionEvent => {
  const full = { ...ev, id: s.events.length + 1, ts: ev.ts ?? Date.now() } as SessionEvent;
  s.events.push(full);
  // Persistent listeners — caller is responsible for unsubscribing.
  for (const w of [...s.waiters]) w(full);
  return full;
};

// Periodic TTL sweep
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now >= s.expiresAt) {
      append(s, { type: 'session_closed' });
      sessions.delete(id);
    }
  }
}, 60_000).unref();

// --- App ---------------------------------------------------------------------

const app = new Hono();
app.use('*', cors());

app.get('/healthz', (c) => c.json({ ok: true, sessions: sessions.size }));

app.post('/sessions', (c) => {
  const s = newSession();
  sessions.set(s.id, s);
  return c.json({ id: s.id, url: `${PUBLIC_URL}/${s.id}`, ttl_ms: TTL_MS }, 201);
});

app.get('/sessions/:id', (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s || isExpired(s)) return c.json({ error: 'not_found' }, 404);
  return c.json({
    id: s.id,
    surface: s.surface,
    expires_at: s.expiresAt,
    cursor: s.events.length,
  });
});

app.put('/sessions/:id/surface', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s || isExpired(s)) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => null) as { format?: string; spec?: unknown } | null;
  if (!body || typeof body.format !== 'string' || body.spec === undefined) {
    return c.json({ error: 'bad_request', detail: 'expected { format, spec }' }, 400);
  }
  s.surface = { format: body.format, spec: body.spec };
  touch(s);
  const ev = append(s, { type: 'surface_updated', format: body.format, spec: body.spec });
  return c.json({ ok: true, cursor: ev.id });
});

app.post('/sessions/:id/actions', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s || isExpired(s)) return c.json({ error: 'not_found' }, 404);
  const action = await c.req.json().catch(() => null);
  if (action === null) return c.json({ error: 'bad_request' }, 400);
  touch(s);
  const ev = append(s, { type: 'user_action', action });
  return c.json({ ok: true, cursor: ev.id });
});

app.delete('/sessions/:id', (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'not_found' }, 404);
  append(s, { type: 'session_closed' });
  sessions.delete(s.id);
  return c.json({ ok: true });
});

// Single events endpoint with content negotiation:
//   Accept: text/event-stream → SSE (used by browser renderer)
//   else                       → long-poll JSON (used by MCP wait_for_event)
app.get('/sessions/:id/events', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s || isExpired(s)) return c.json({ error: 'not_found' }, 404);

  const since = Number(c.req.query('since') ?? 0);
  const typeFilter = c.req.query('type'); // optional: "user_action" | "surface_updated"
  const wantsSSE = (c.req.header('accept') ?? '').includes('text/event-stream');

  const matches = (ev: SessionEvent) => !typeFilter || ev.type === typeFilter;
  const backlog = s.events.filter((e) => e.id > since && matches(e));

  if (wantsSSE) {
    return streamSSE(c, async (stream) => {
      const queue: SessionEvent[] = [...backlog];
      let wake: (() => void) | null = null;
      const onEvent = (ev: SessionEvent) => {
        if (!matches(ev)) return;
        queue.push(ev);
        wake?.();
        wake = null;
      };
      s.waiters.add(onEvent);
      stream.onAbort(() => s.waiters.delete(onEvent));

      try {
        while (!stream.aborted) {
          while (queue.length) {
            const ev = queue.shift()!;
            await stream.writeSSE({ data: JSON.stringify(ev), id: String(ev.id) });
            if (ev.type === 'session_closed') return;
          }
          if (stream.aborted) return;
          await new Promise<void>((r) => { wake = r; });
        }
      } finally {
        s.waiters.delete(onEvent);
      }
    });
  }

  // Long-poll
  const timeoutMs = Math.min(
    Math.max(Number(c.req.query('timeout_ms') ?? MAX_LONGPOLL_MS), 0),
    MAX_LONGPOLL_MS,
  );
  if (backlog.length > 0) {
    return c.json({ events: backlog, cursor: backlog[backlog.length - 1].id });
  }
  const event = await new Promise<SessionEvent | null>((resolve) => {
    const onEvent = (ev: SessionEvent) => {
      if (!matches(ev)) return;
      clearTimeout(t);
      s.waiters.delete(onEvent);
      resolve(ev);
    };
    s.waiters.add(onEvent);
    const t = setTimeout(() => {
      s.waiters.delete(onEvent);
      resolve(null);
    }, timeoutMs);
  });
  if (!event) return c.json({ events: [], cursor: s.events.length });
  return c.json({ events: [event], cursor: event.id });
});

// --- Boot --------------------------------------------------------------------

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`agent-ui-session listening on ${PUBLIC_URL} (port ${info.port})`);
});
