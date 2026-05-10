# Supabase Persistence — Design (V1 storage)

Status: approved 2026-05-09. Implementation pending.

## Goal

Persist sessions, surfaces, and the event log to Supabase Postgres so the
service survives restarts. Today the entire state lives in
`Map<sessionId, Session>` in `server.ts` and is lost on every boot.

This is the V1 "persistence beyond TTL" item explicitly deferred by `PRD.md`
(§ Storage V0, § Scope V0 — out). The PRD's other constraints stay intact.

## PRD alignment

- **Surface stays opaque + format-tagged.** Stored as `surface_format text`
  + `surface_spec jsonb`; the service still does not parse the spec.
- **Anonymous shareable-link sessions.** No auth, no RLS. Service-side access
  only, via a single Postgres connection string in the server's environment.
- **REST API contract unchanged.** All four endpoints behave identically;
  only their backing store changes.
- **SSE + long-poll unchanged.** In-process `waiters: Set<...>` continues to
  drive fan-out. Postgres is durability, not transport.
- **Thin and elegant.** One new module (`db.ts`), one SQL file, one env var.
  No migration tool, no ORM, no extra service.
- **TTL ~30 min.** Existing `SESSION_TTL_MS` and 60s sweep keep their roles;
  the sweep also deletes from Postgres.
- **Success criteria preserved.** Sync write-through adds one round-trip per
  mutating request (≈50–200ms over the Supabase pooler). The PRD's 1s
  event-delivery and 2s render budgets remain comfortably met.

## Architecture

Eager-load + write-through.

```
server.ts                  db.ts                Supabase Postgres
   │                         │                         │
   ├─ init() ───────────────▶│ open pool, ping ───────▶│
   │                         │                         │
   ├─ loadActiveSessions() ─▶│ SELECT … expires>now() ▶│
   │◀──── populated Map ─────│                         │
   │                         │                         │
   ├─ insertSession(s) ─────▶│ INSERT sessions ───────▶│
   ├─ updateSurface(...) ───▶│ UPDATE sessions;        │
   │                         │ INSERT session_events ▶│
   ├─ appendEvent(id, ev) ──▶│ INSERT session_events ▶│
   ├─ touchExpiry(id, exp) ─▶│ UPDATE sessions ───────▶│
   ├─ deleteSession(id) ────▶│ DELETE sessions ───────▶│ (cascade)
   │                         │                         │
   └─ shutdown() ───────────▶│ sql.end()               │
```

- The in-memory `Map<sessionId, Session>` remains the live working set; all
  reads hit memory, all writes go to Postgres before the response is sent.
- `waiters: Set<callback>` stays in-process. SSE fan-out is unchanged.
- `db.ts` exposes a small typed surface; `server.ts` never sees a row, a
  pool, or raw SQL. This keeps `server.ts` testable without a database.

### Why this approach (vs. alternatives)

- **Lazy cache**: extra cache-miss handling for no benefit at hackathon scale.
- **Postgres-only (no Map)**: DB hit per request, larger rewrite of
  `server.ts`, no win — waiters are still in-process anyway.

## Schema

Single SQL file, `db/init.sql`, applied once via the Supabase SQL editor
(or `psql $DATABASE_URL -f db/init.sql`).

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
  id         int  not null,                   -- per-session, monotonic
  type       text not null,                   -- 'surface_updated' |
                                              -- 'user_action' |
                                              -- 'session_closed'
  ts         timestamptz not null default now(),
  payload    jsonb not null,                  -- event-specific fields
  primary key (session_id, id)
);
```

`payload` is the type-specific tail of `SessionEvent`:

- `surface_updated`: `{ format, spec }`
- `user_action`: `{ action }`
- `session_closed`: `{}`

The base fields (`id`, `type`, `ts`) live in their own columns to keep the
table queryable. Reconstruction in `loadActiveSessions` is a straight merge.

Event `id` is computed in-process (`s.events.length + 1`) — single-process
service, no race. Multi-process would require a DB-side sequence; explicitly
out of scope (V2).

## Library & configuration

- **Driver:** [`postgres`](https://github.com/porsager/postgres) (porsager).
  Tagged-template SQL, SSL on by default (which Supabase requires), small
  surface area.
- **Connection string:** Supabase **session pooler**, port `5432`. Provided
  via env var `DATABASE_URL`. The transaction pooler on `6543` is rejected
  because it does not support session features we may want later
  (`LISTEN/NOTIFY`); for V1 we don't need them, but session pooler costs us
  nothing today and keeps options open.
- **One pool** created in `db.init()`; `await sql.end({ timeout: 5 })` on
  graceful shutdown (`SIGINT`, `SIGTERM`).
- **`.env`** holds the secret; `.env` is gitignored; `.env.example` ships
  with a placeholder.

## Lifecycle, ordering, and failure modes

- **Boot:** `db.init()` opens the pool and runs a trivial `SELECT 1` ping.
  If it fails, the process exits non-zero before binding the HTTP port —
  no half-started server. Then `db.loadActiveSessions(map)` rehydrates the
  Map (sessions whose `expires_at > now()` plus their event arrays).
- **Mutating requests:** Postgres write happens *before* in-memory mutation
  and waiter notification. If the DB write fails, the handler returns 500
  and no in-memory state changes — memory and DB stay in lockstep.
- **TTL sweep:** the existing 60s interval iterates expired sessions,
  appends `session_closed` (which writes to DB), then deletes the Map entry
  and the DB row. Cascade removes events.
- **Restart mid long-poll / SSE:** the connection dies with the process. On
  reconnect with `?since=N`, backlog is read from the rehydrated Map (which
  was populated from the DB on boot) — no events lost.
- **DB unreachable mid-request:** request fails 500; client (MCP server or
  browser) retries per its existing semantics. We do not buffer-and-retry
  in the server.

## Module boundary (`db.ts`)

Exported surface (final names may vary slightly during implementation):

```ts
export async function init(connectionString: string): Promise<void>;
export async function shutdown(): Promise<void>;

export async function loadActiveSessions(
  into: Map<string, Session>,
): Promise<void>;

export async function insertSession(s: Session): Promise<void>;
export async function updateSurface(
  sessionId: string,
  format: string,
  spec: unknown,
): Promise<void>;
export async function appendEvent(
  sessionId: string,
  ev: SessionEvent,
): Promise<void>;
export async function touchExpiry(
  sessionId: string,
  expiresAt: number,
): Promise<void>;
export async function deleteSession(sessionId: string): Promise<void>;
```

`Session` and `SessionEvent` types are imported from `server.ts` (or both
move to a shared `types.ts` if that's cleaner during implementation).

## Changes to `server.ts`

Mechanical, contained edits:

- Top-of-file: `import * as db from './db.ts';`
- Boot: `await db.init(process.env.DATABASE_URL!); await db.loadActiveSessions(sessions);` before `serve(...)`.
- `POST /sessions`: `await db.insertSession(s);` after `sessions.set(...)`.
- `PUT /sessions/:id/surface`: `await db.updateSurface(...); await db.appendEvent(...);` before mutating `s.surface` / calling `append`.
- `POST /sessions/:id/actions`: `await db.appendEvent(...); await db.touchExpiry(...);` before `append`.
- `DELETE /sessions/:id`: `await db.appendEvent(closedEv); await db.deleteSession(id);` mirroring current order.
- TTL sweep: same, plus `await db.deleteSession(id)` per expired session.
- Graceful shutdown: `process.on('SIGTERM' / 'SIGINT', () => db.shutdown())`.

The `append()` helper currently both appends and notifies waiters; we
preserve that, but the DB write happens *before* the call so the in-memory
state and waiter notification only fire on a confirmed durable write.

## Verification (must hold before declaring done)

- `psql $DATABASE_URL -f db/init.sql` succeeds against the user's project.
- `npm run dev:server` boots cleanly with `DATABASE_URL` set; logs the
  number of rehydrated sessions (zero on first boot).
- `npm run dev:server` fails fast with a clear error when `DATABASE_URL`
  is missing or unreachable.
- End-to-end: `POST /sessions` → `PUT /surface` → `POST /actions` →
  `SELECT * FROM session_events WHERE session_id = ...` shows all three
  event rows. Restart server. Re-query `GET /sessions/:id/events?since=0`
  returns the same backlog.
- TTL sweep: short `SESSION_TTL_MS`, observe the row disappears from
  `sessions` after expiry and `session_events` rows cascade.
- Existing client + MCP smoke (`mcp/smoke.mjs`) still passes unchanged.

## Out of scope

- Auth / RLS / per-user sessions (V1 of the original PRD; still deferred).
- Multi-process / horizontal scale (would require DB-side sequence for
  event ids and `LISTEN/NOTIFY` for cross-process waiter fan-out).
- Migration tooling (drizzle-kit, node-pg-migrate, supabase migrations).
  V0 is one SQL file applied by hand.
- Backfilling old data — there is none.
- Supabase Storage, Auth, Edge Functions, Realtime — explicitly not used.

## Risks / open items

- **Pooler latency.** If the user's Supabase project is in a distant region,
  per-request latency could approach the PRD's 1s budget for action
  delivery. Mitigation: keep the pool warm (default behavior of `postgres`)
  and avoid extra round-trips per request (we only do one INSERT per
  action). If still tight, V2 can move events to async write-behind.
- **Credential hygiene.** `DATABASE_URL` belongs in `.env` and in
  deployment secrets; never committed. `.env` and `.env.local` are already
  in the project's `.gitignore`.
