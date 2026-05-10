# Supabase Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent-ui-session` survive server restarts by persisting sessions, surfaces, and the event log to Supabase Postgres while preserving the existing REST contract and SSE/long-poll fan-out.

**Architecture:** Eager-load + write-through. The in-memory `Map<sessionId, Session>` stays as the live working set; a new `db.ts` module mirrors every mutation to Postgres synchronously and rehydrates the Map at boot. SSE waiters remain in-process.

**Tech Stack:** TypeScript, Node 22 (`--experimental-strip-types`), [`postgres`](https://github.com/porsager/postgres) driver, Supabase Postgres (session pooler, port 5432), `node:test` for integration tests.

**Source spec:** [`docs/superpowers/specs/2026-05-09-supabase-persistence-design.md`](../specs/2026-05-09-supabase-persistence-design.md).

---

## File map

- **Create** `types.ts` — extracted `Session` and `SessionEvent` types so both `server.ts` and `db.ts` can import them.
- **Create** `db/init.sql` — schema migration (one file, applied by hand).
- **Create** `db.ts` — module owning all SQL: `init`, `shutdown`, `loadActiveSessions`, `insertSession`, `updateSurface`, `appendEvent`, `touchExpiry`, `deleteSession`.
- **Create** `db.test.ts` — integration tests for `db.ts` against the user's Supabase project. Skipped if `DATABASE_URL` is unset.
- **Create** `.env.example` — template for the `DATABASE_URL` secret.
- **Modify** `server.ts` — extract types, import `db`, add boot/shutdown wiring, write-through on every mutation, DB delete in TTL sweep.
- **Modify** `package.json` — add `postgres` dependency, add `test` script.

---

## Task 1: Project setup — dependency, env template, type extraction

**Files:**
- Modify: `package.json`
- Create: `.env.example`
- Create: `types.ts`
- Modify: `server.ts:9-21` (replace inline types with import)

- [ ] **Step 1: Install the `postgres` driver**

```bash
cd /Users/netto/work/hackathons/gen-ui-sf/agent-ui-session
npm install postgres
```

Expected: `postgres` appears in `dependencies` in `package.json`, no peer-dep warnings.

- [ ] **Step 2: Add a `test` script to `package.json`**

In `package.json` `"scripts"`, add after `"build:client"`:

```json
"test": "node --test --experimental-strip-types --env-file=.env --test-reporter=spec db.test.ts"
```

- [ ] **Step 3: Create `.env.example`**

Create `/Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/.env.example`:

```
# Supabase Postgres connection string.
# Supabase dashboard → Project Settings → Database → Connection string
# → URI mode → "Session pooler" (port 5432).
DATABASE_URL=postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
```

- [ ] **Step 4: Create `types.ts` with the extracted types**

Create `/Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/types.ts`:

```ts
export type SessionEvent =
  | { id: number; type: 'surface_updated'; format: string; spec: unknown; ts: number }
  | { id: number; type: 'user_action'; action: unknown; ts: number }
  | { id: number; type: 'session_closed'; ts: number };

export type Session = {
  id: string;
  createdAt: number;
  expiresAt: number;
  surface: { format: string; spec: unknown } | null;
  events: SessionEvent[];
  waiters: Set<(ev: SessionEvent) => void>;
};
```

- [ ] **Step 5: Replace inline types in `server.ts` with the import**

Edit `server.ts`. Replace lines 7-21 (the `// --- Types ---` block plus the two `type` declarations) with:

```ts
// --- Types -------------------------------------------------------------------

import type { Session, SessionEvent } from './types.ts';
```

Move the import to the top of the file with the other imports (above `// --- Types`).

- [ ] **Step 6: Run server to confirm types still resolve**

```bash
npm run dev:server
```

Expected: server prints `agent-ui-session listening on http://localhost:8787 …` and stays running. Stop with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .env.example types.ts server.ts
git commit -m "chore(db): extract types, add postgres dep, env template"
```

---

## Task 2: Schema migration

**Files:**
- Create: `db/init.sql`

- [ ] **Step 1: Create the schema file**

Create `/Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/db/init.sql`:

```sql
create table if not exists sessions (
  id             text primary key,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  surface_format text,
  surface_spec   jsonb
);

create index if not exists sessions_expires_at_idx
  on sessions (expires_at);

create table if not exists session_events (
  session_id text not null
             references sessions(id) on delete cascade,
  id         int  not null,
  type       text not null,
  ts         timestamptz not null default now(),
  payload    jsonb not null,
  primary key (session_id, id)
);
```

- [ ] **Step 2: Apply the schema to Supabase**

Set `DATABASE_URL` locally first (in a `.env` file at the project root, NOT committed):

```bash
# .env (gitignored)
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres
```

Then apply:

```bash
psql "$DATABASE_URL" -f db/init.sql
```

If `psql` isn't installed, paste the contents of `db/init.sql` into the Supabase SQL editor (Project → SQL Editor → New query → Run).

Expected output (psql):
```
CREATE TABLE
CREATE INDEX
CREATE TABLE
```

- [ ] **Step 3: Verify the tables exist**

```bash
psql "$DATABASE_URL" -c "\dt"
```

Expected: rows for `public.sessions` and `public.session_events`.

- [ ] **Step 4: Commit the schema file**

```bash
git add db/init.sql
git commit -m "feat(db): schema for sessions + session_events"
```

---

## Task 3: `db.ts` foundations — init, shutdown, ping

**Files:**
- Create: `db.ts`
- Create: `db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/db.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as db from './db.ts';

const DATABASE_URL = process.env.DATABASE_URL;

before(async () => {
  if (!DATABASE_URL) throw new Error('DATABASE_URL not set — see .env.example');
  await db.init(DATABASE_URL);
});

after(async () => {
  await db.shutdown();
});

test('init+shutdown cycle works and a second init is a no-op', async () => {
  await db.init(DATABASE_URL!); // second call should be idempotent
  // If we got here without throwing, the pool is healthy.
  assert.ok(true);
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test
```

Expected: failure with `Cannot find module './db.ts'` (or similar import error).

- [ ] **Step 3: Write the minimal `db.ts`**

Create `/Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/db.ts`:

```ts
import postgres from 'postgres';

let sql: ReturnType<typeof postgres> | null = null;

export async function init(connectionString: string): Promise<void> {
  if (sql) return;
  sql = postgres(connectionString, { ssl: 'require', prepare: false });
  await sql`select 1`;
}

export async function shutdown(): Promise<void> {
  if (!sql) return;
  await sql.end({ timeout: 5 });
  sql = null;
}

export function client(): ReturnType<typeof postgres> {
  if (!sql) throw new Error('db not initialized — call init() first');
  return sql;
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test
```

Expected: `# pass 1` for the `init+shutdown cycle` test.

- [ ] **Step 5: Commit**

```bash
git add db.ts db.test.ts
git commit -m "feat(db): init/shutdown with connection ping"
```

---

## Task 4: `db.ts` — `insertSession`, `deleteSession`, `touchExpiry`

**Files:**
- Modify: `db.ts`
- Modify: `db.test.ts`

- [ ] **Step 1: Add a test for the insert/delete/touch round-trip**

Append to `db.test.ts`:

```ts
import { randomBytes } from 'node:crypto';

const newId = () => 'test-' + randomBytes(8).toString('hex');

test('insertSession + touchExpiry + deleteSession', async () => {
  const c = db.client();
  const id = newId();
  const now = Date.now();
  const expiresAt = now + 60_000;

  await db.insertSession({
    id,
    createdAt: now,
    expiresAt,
    surface: null,
    events: [],
    waiters: new Set(),
  });

  const [row] = await c<Array<{ id: string; expires_at: Date }>>`
    select id, expires_at from sessions where id = ${id}
  `;
  assert.equal(row.id, id);
  assert.equal(row.expires_at.getTime(), expiresAt);

  const newExpiry = now + 120_000;
  await db.touchExpiry(id, newExpiry);
  const [row2] = await c<Array<{ expires_at: Date }>>`
    select expires_at from sessions where id = ${id}
  `;
  assert.equal(row2.expires_at.getTime(), newExpiry);

  await db.deleteSession(id);
  const rows = await c`select 1 from sessions where id = ${id}`;
  assert.equal(rows.length, 0);
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test
```

Expected: failure on `db.insertSession is not a function` (or test crash).

- [ ] **Step 3: Implement the three functions**

Append to `db.ts`:

```ts
import type { Session } from './types.ts';

export async function insertSession(s: Session): Promise<void> {
  const c = client();
  await c`
    insert into sessions (id, created_at, expires_at)
    values (
      ${s.id},
      to_timestamp(${s.createdAt} / 1000.0),
      to_timestamp(${s.expiresAt} / 1000.0)
    )
  `;
}

export async function touchExpiry(sessionId: string, expiresAt: number): Promise<void> {
  const c = client();
  await c`
    update sessions
    set expires_at = to_timestamp(${expiresAt} / 1000.0)
    where id = ${sessionId}
  `;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const c = client();
  await c`delete from sessions where id = ${sessionId}`;
}
```

(Move the `import type { Session } from './types.ts';` up next to the `postgres` import for cleanliness.)

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test
```

Expected: 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add db.ts db.test.ts
git commit -m "feat(db): insertSession, touchExpiry, deleteSession"
```

---

## Task 5: `db.ts` — `updateSurface` and `appendEvent`

**Files:**
- Modify: `db.ts`
- Modify: `db.test.ts`

- [ ] **Step 1: Add a test for surface update + event append + cascade**

Append to `db.test.ts`:

```ts
test('updateSurface + appendEvent + cascade delete', async () => {
  const c = db.client();
  const id = newId();
  const now = Date.now();

  await db.insertSession({
    id, createdAt: now, expiresAt: now + 60_000,
    surface: null, events: [], waiters: new Set(),
  });

  await db.updateSurface(id, 'a2ui-v0.9', { hello: 'world' });
  await db.appendEvent(id, {
    id: 1, type: 'surface_updated', format: 'a2ui-v0.9',
    spec: { hello: 'world' }, ts: now,
  });
  await db.appendEvent(id, {
    id: 2, type: 'user_action', action: { name: 'submit', value: 42 }, ts: now + 100,
  });

  const [s] = await c<Array<{ surface_format: string; surface_spec: { hello: string } }>>`
    select surface_format, surface_spec from sessions where id = ${id}
  `;
  assert.equal(s.surface_format, 'a2ui-v0.9');
  assert.deepEqual(s.surface_spec, { hello: 'world' });

  const events = await c<Array<{ id: number; type: string; payload: unknown }>>`
    select id, type, payload from session_events
    where session_id = ${id} order by id
  `;
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'surface_updated');
  assert.deepEqual(events[0].payload, { format: 'a2ui-v0.9', spec: { hello: 'world' } });
  assert.equal(events[1].type, 'user_action');
  assert.deepEqual(events[1].payload, { action: { name: 'submit', value: 42 } });

  // Cascade: deleting the session removes its events.
  await db.deleteSession(id);
  const after = await c`select 1 from session_events where session_id = ${id}`;
  assert.equal(after.length, 0);
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test
```

Expected: failure on `db.updateSurface is not a function`.

- [ ] **Step 3: Implement the two functions**

Append to `db.ts`:

```ts
import type { Session, SessionEvent } from './types.ts'; // already imported above; merge if duplicated

export async function updateSurface(
  sessionId: string,
  format: string,
  spec: unknown,
): Promise<void> {
  const c = client();
  await c`
    update sessions
    set surface_format = ${format},
        surface_spec   = ${c.json(spec as never)}
    where id = ${sessionId}
  `;
}

export async function appendEvent(sessionId: string, ev: SessionEvent): Promise<void> {
  const c = client();
  const payload = eventPayload(ev);
  await c`
    insert into session_events (session_id, id, type, ts, payload)
    values (
      ${sessionId},
      ${ev.id},
      ${ev.type},
      to_timestamp(${ev.ts} / 1000.0),
      ${c.json(payload as never)}
    )
  `;
}

function eventPayload(ev: SessionEvent): unknown {
  if (ev.type === 'surface_updated') return { format: ev.format, spec: ev.spec };
  if (ev.type === 'user_action') return { action: ev.action };
  return {};
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test
```

Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add db.ts db.test.ts
git commit -m "feat(db): updateSurface and appendEvent"
```

---

## Task 6: `db.ts` — `loadActiveSessions`

**Files:**
- Modify: `db.ts`
- Modify: `db.test.ts`

- [ ] **Step 1: Add a test for rehydration**

Append to `db.test.ts`:

```ts
import type { Session } from './types.ts';

test('loadActiveSessions rehydrates surface + events, skips expired', async () => {
  const live = newId();
  const dead = newId();
  const now = Date.now();

  await db.insertSession({
    id: live, createdAt: now, expiresAt: now + 60_000,
    surface: null, events: [], waiters: new Set(),
  });
  await db.updateSurface(live, 'a2ui-v0.9', { kind: 'form' });
  await db.appendEvent(live, {
    id: 1, type: 'surface_updated', format: 'a2ui-v0.9', spec: { kind: 'form' }, ts: now,
  });
  await db.appendEvent(live, {
    id: 2, type: 'user_action', action: { name: 'ok' }, ts: now + 50,
  });

  await db.insertSession({
    id: dead, createdAt: now - 120_000, expiresAt: now - 60_000,
    surface: null, events: [], waiters: new Set(),
  });

  const map = new Map<string, Session>();
  await db.loadActiveSessions(map);

  assert.ok(map.has(live), 'live session should be loaded');
  assert.ok(!map.has(dead), 'expired session should be skipped');

  const s = map.get(live)!;
  assert.deepEqual(s.surface, { format: 'a2ui-v0.9', spec: { kind: 'form' } });
  assert.equal(s.events.length, 2);
  assert.equal(s.events[0].type, 'surface_updated');
  assert.equal(s.events[1].type, 'user_action');
  assert.ok(s.waiters instanceof Set);
  assert.equal(s.waiters.size, 0);
  assert.equal(s.expiresAt, now + 60_000);

  await db.deleteSession(live);
  await db.deleteSession(dead);
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test
```

Expected: failure on `db.loadActiveSessions is not a function`.

- [ ] **Step 3: Implement `loadActiveSessions` and the event reconstructor**

Append to `db.ts`:

```ts
type SessionRow = {
  id: string;
  created_at: Date;
  expires_at: Date;
  surface_format: string | null;
  surface_spec: unknown;
};

type EventRow = {
  id: number;
  type: 'surface_updated' | 'user_action' | 'session_closed';
  ts: Date;
  payload: Record<string, unknown>;
};

export async function loadActiveSessions(into: Map<string, Session>): Promise<void> {
  const c = client();
  const sessions = await c<SessionRow[]>`
    select id, created_at, expires_at, surface_format, surface_spec
    from sessions
    where expires_at > now()
  `;

  for (const r of sessions) {
    const events = await c<EventRow[]>`
      select id, type, ts, payload
      from session_events
      where session_id = ${r.id}
      order by id
    `;
    into.set(r.id, {
      id: r.id,
      createdAt: r.created_at.getTime(),
      expiresAt: r.expires_at.getTime(),
      surface: r.surface_format
        ? { format: r.surface_format, spec: r.surface_spec }
        : null,
      events: events.map(reconstructEvent),
      waiters: new Set(),
    });
  }
}

function reconstructEvent(e: EventRow): SessionEvent {
  const base = { id: e.id, ts: e.ts.getTime() };
  if (e.type === 'surface_updated') {
    return {
      ...base, type: 'surface_updated',
      format: e.payload.format as string,
      spec: e.payload.spec,
    };
  }
  if (e.type === 'user_action') {
    return { ...base, type: 'user_action', action: e.payload.action };
  }
  return { ...base, type: 'session_closed' };
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test
```

Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add db.ts db.test.ts
git commit -m "feat(db): loadActiveSessions rehydrates Map at boot"
```

---

## Task 7: Wire `db.ts` into `server.ts` boot path

**Files:**
- Modify: `server.ts` (boot block at the bottom + new shutdown handlers)

- [ ] **Step 1: Import `db` and read `DATABASE_URL`**

At the top of `server.ts`, add to the imports block:

```ts
import * as db from './db.ts';
```

Below the existing storage constants (`PORT`, `PUBLIC_URL`, `TTL_MS`, `MAX_LONGPOLL_MS`), add:

```ts
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
```

- [ ] **Step 2: Replace the bottom Boot block**

Replace the current lines (the `// --- Boot ---` block and the `serve(...)` call):

```ts
// --- Boot --------------------------------------------------------------------

await db.init(DATABASE_URL);
await db.loadActiveSessions(sessions);
console.log(`rehydrated ${sessions.size} session(s) from db`);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`agent-ui-session listening on ${PUBLIC_URL} (port ${info.port})`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down`);
  server.close();
  await db.shutdown();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

- [ ] **Step 3: Verify boot with `DATABASE_URL` set**

```bash
npm run dev:server
```

Expected output:
```
rehydrated 0 session(s) from db
agent-ui-session listening on http://localhost:8787 (port 8787)
```

Press Ctrl-C; expected: `SIGINT received, shutting down` then exit cleanly.

- [ ] **Step 4: Verify boot fails fast without `DATABASE_URL`**

```bash
DATABASE_URL='' node --experimental-strip-types server.ts
```

Expected: `DATABASE_URL is not set. Copy .env.example to .env and fill it in.` and non-zero exit.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat(server): db.init + rehydrate on boot, graceful shutdown"
```

---

## Task 8: Wire write-through into the four mutating handlers + TTL sweep

**Files:**
- Modify: `server.ts` (the four route handlers + the periodic sweep)

- [ ] **Step 1: `POST /sessions` — write-through on create**

Find the existing `app.post('/sessions', ...)` handler (around line 78-82). Replace its body with:

```ts
app.post('/sessions', async (c) => {
  const s = newSession();
  await db.insertSession(s);
  sessions.set(s.id, s);
  return c.json({ id: s.id, url: `${PUBLIC_URL}/${s.id}`, ttl_ms: TTL_MS }, 201);
});
```

- [ ] **Step 2: `PUT /sessions/:id/surface` — write-through on surface update**

Find the existing handler (around lines 95-106). Replace the body of the success path so the DB writes happen *before* in-memory mutation. Final handler:

```ts
app.put('/sessions/:id/surface', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s || isExpired(s)) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => null) as { format?: string; spec?: unknown } | null;
  if (!body || typeof body.format !== 'string' || body.spec === undefined) {
    return c.json({ error: 'bad_request', detail: 'expected { format, spec }' }, 400);
  }
  const nextExpiry = Date.now() + TTL_MS;
  const evId = s.events.length + 1;
  const ev = {
    id: evId, type: 'surface_updated' as const,
    format: body.format, spec: body.spec, ts: Date.now(),
  };

  await db.updateSurface(s.id, body.format, body.spec);
  await db.appendEvent(s.id, ev);
  await db.touchExpiry(s.id, nextExpiry);

  s.surface = { format: body.format, spec: body.spec };
  s.expiresAt = nextExpiry;
  s.events.push(ev);
  for (const w of [...s.waiters]) w(ev);

  return c.json({ ok: true, cursor: ev.id });
});
```

(The previous `append()` helper still exists — but this handler now bypasses it because we need DB-before-memory ordering. Leave `append()` and `touch()` in place; they're still used by the other handlers.)

- [ ] **Step 3: `POST /sessions/:id/actions` — write-through on action**

Replace the body of the existing handler with:

```ts
app.post('/sessions/:id/actions', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s || isExpired(s)) return c.json({ error: 'not_found' }, 404);
  const action = await c.req.json().catch(() => null);
  if (action === null) return c.json({ error: 'bad_request' }, 400);

  const nextExpiry = Date.now() + TTL_MS;
  const ev = {
    id: s.events.length + 1, type: 'user_action' as const,
    action, ts: Date.now(),
  };

  await db.appendEvent(s.id, ev);
  await db.touchExpiry(s.id, nextExpiry);

  s.expiresAt = nextExpiry;
  s.events.push(ev);
  for (const w of [...s.waiters]) w(ev);

  return c.json({ ok: true, cursor: ev.id });
});
```

- [ ] **Step 4: `DELETE /sessions/:id` — write-through on close**

Replace the existing handler with:

```ts
app.delete('/sessions/:id', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'not_found' }, 404);

  const ev = {
    id: s.events.length + 1, type: 'session_closed' as const,
    ts: Date.now(),
  };
  await db.appendEvent(s.id, ev);
  await db.deleteSession(s.id);

  s.events.push(ev);
  for (const w of [...s.waiters]) w(ev);
  sessions.delete(s.id);

  return c.json({ ok: true });
});
```

- [ ] **Step 5: TTL sweep — write-through on expiry**

Replace the existing `setInterval(...)` block with:

```ts
setInterval(async () => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now >= s.expiresAt) {
      const ev = { id: s.events.length + 1, type: 'session_closed' as const, ts: now };
      try {
        await db.appendEvent(id, ev);
        await db.deleteSession(id);
      } catch (err) {
        console.error('ttl sweep db write failed for', id, err);
        continue; // leave the in-memory entry; try again next tick
      }
      s.events.push(ev);
      for (const w of [...s.waiters]) w(ev);
      sessions.delete(id);
    }
  }
}, 60_000).unref();
```

- [ ] **Step 6: Verify the server still boots and `curl` round-trips**

In one terminal:

```bash
npm run dev:server
```

In another:

```bash
# Create a session
SID=$(curl -s -XPOST http://localhost:8787/sessions | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "session: $SID"

# Set a surface
curl -s -XPUT -H 'content-type: application/json' \
  -d '{"format":"a2ui-v0.9","spec":{"kind":"hello"}}' \
  "http://localhost:8787/sessions/$SID/surface"

# Submit an action
curl -s -XPOST -H 'content-type: application/json' \
  -d '{"name":"submit","context":{"value":1}}' \
  "http://localhost:8787/sessions/$SID/actions"

# Read back via the events endpoint (long-poll, returns immediately because backlog is non-empty)
curl -s "http://localhost:8787/sessions/$SID/events?since=0"
```

Expected: each `curl` returns 2xx JSON. The final call returns two events: one `surface_updated`, one `user_action`.

- [ ] **Step 7: Verify the rows landed in Postgres**

```bash
psql "$DATABASE_URL" -c "select id, type, payload from session_events where session_id = '$SID' order by id"
```

Expected: two rows (`surface_updated` then `user_action`).

- [ ] **Step 8: Commit**

```bash
git add server.ts
git commit -m "feat(server): write-through to postgres on every mutation"
```

---

## Task 9: End-to-end restart-survives verification

**Files:** none (verification task)

- [ ] **Step 1: Create a session and add events**

With server running:

```bash
SID=$(curl -s -XPOST http://localhost:8787/sessions | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -XPUT -H 'content-type: application/json' \
  -d '{"format":"a2ui-v0.9","spec":{"kind":"persisted"}}' \
  "http://localhost:8787/sessions/$SID/surface" >/dev/null
curl -s -XPOST -H 'content-type: application/json' \
  -d '{"name":"submit","context":{"value":99}}' \
  "http://localhost:8787/sessions/$SID/actions" >/dev/null
echo "before restart, SID=$SID"
curl -s "http://localhost:8787/sessions/$SID" | python3 -m json.tool
```

Expected: GET returns the session with `surface.spec.kind == "persisted"` and `cursor: 2`.

- [ ] **Step 2: Restart the server**

Stop with Ctrl-C, then `npm run dev:server` again.

Expected boot log: `rehydrated 1 session(s) from db`.

- [ ] **Step 3: Verify state survived**

```bash
curl -s "http://localhost:8787/sessions/$SID" | python3 -m json.tool
curl -s "http://localhost:8787/sessions/$SID/events?since=0" | python3 -m json.tool
```

Expected:
- `GET /sessions/:id` returns the same surface (`kind: "persisted"`) and `cursor: 2`.
- `GET /events?since=0` returns the original two events (`surface_updated` then `user_action`).

- [ ] **Step 4: Verify the existing MCP smoke still works**

```bash
node mcp/smoke.mjs
```

Expected: smoke completes without errors. (Refer to `mcp/smoke.mjs` for what it prints; the existing flow should be unchanged.)

- [ ] **Step 5: Clean up the test session**

```bash
curl -s -XDELETE "http://localhost:8787/sessions/$SID"
psql "$DATABASE_URL" -c "select count(*) from sessions where id = '$SID'"
```

Expected: count is 0.

- [ ] **Step 6: Final commit if any tweaks were needed**

If steps 1-5 surfaced any fixups, commit them:

```bash
git add -p server.ts db.ts
git commit -m "fix: <whatever the verification surfaced>"
```

Otherwise nothing to commit.

---

## Task 10: Update the README and finalize

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Database" section to the README**

Add after the existing "Quick start" section (read the current README first to match its tone):

```markdown
## Database

V1 uses Supabase Postgres for durability. Sessions and the event log
survive restarts.

1. Create a Supabase project (or use an existing one).
2. Apply the schema:
   ```bash
   psql "$DATABASE_URL" -f db/init.sql
   ```
   Or paste `db/init.sql` into the Supabase SQL editor.
3. Copy `.env.example` to `.env` and fill in `DATABASE_URL` (use the
   **Session pooler** connection string on port 5432).
4. Run the integration tests:
   ```bash
   npm test
   ```

See `docs/superpowers/specs/2026-05-09-supabase-persistence-design.md`
for the full design.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): supabase setup instructions"
```

---

## Done criteria

- All 4 integration tests in `db.test.ts` pass against the user's Supabase project.
- `npm run dev:server` rehydrates sessions on boot and logs the count.
- `curl` round-trip in Task 8 step 6 succeeds end-to-end.
- Restart-survives flow in Task 9 returns identical state.
- `mcp/smoke.mjs` still works unchanged.
- Rows in `sessions` and `session_events` reflect every mutation.
