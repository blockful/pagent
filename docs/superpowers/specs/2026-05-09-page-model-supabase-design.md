# Page Model + Supabase — Design

Status: draft, awaiting user review (2026-05-09).

Replaces:
[`2026-05-09-supabase-persistence-design.md`](./2026-05-09-supabase-persistence-design.md)
(session/event-log architecture, no longer accurate after PRD pivot).

## Goal

Rewrite `agent-ui-session` to match the current PRD's **single-shot page**
architecture, with **Supabase Postgres** as the durable storage layer
from day one. The in-memory `Map<pageId, Page>` remains as the live
working set; writes are synchronous through to Postgres
(`PRD.md` § Storage).

This is one bundled effort — the architecture pivot and the persistence
layer land together. The current code (`server.ts`, `client/main.ts`,
`mcp/server.ts`) implements the prior session/event/SSE model and is
fully replaced.

## PRD alignment (per section)

| PRD requirement                                      | Where it's satisfied                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Page** = ephemeral, single-purpose, immutable spec | `pages.spec` is `jsonb not null`, never updated after `INSERT`                                 |
| **State** machine `open → submitted → received`      | `pages.state text check (state in ('open','submitted','received'))` + conditional `UPDATE`s    |
| Single-shot lifecycle                                | `POST /:id/result` only succeeds when `state='open'`; otherwise 409                            |
| `received` is "agent viewed the data"                | Side-effecting first `GET /:id/result` while `state='submitted'` flips to `'received'`         |
| `POST /new` returns immediately                      | One INSERT, one Map write, one response                                                        |
| `GET /:id` is read-only                              | `SELECT` from Map (Map is the live working set), no state mutation                             |
| `GET /:id/result` returns immediately, polling       | No long-poll, no waiters, plain JSON                                                           |
| No SSE / no event log                                | No `events` table, no `waiters` set, no `EventSource` in client                                |
| TTL ~30 min, lazy + 60s sweep                        | `expires_at`; `isExpired(p)` check on every handler; `setInterval` sweep deletes from Map + DB |
| Anonymous shareable links                            | 128-bit hex `id`, no auth, no RLS                                                              |
| Map remains live working set                         | Eager-load on boot; reads hit Map; writes go DB-first then Map                                 |
| Persistence beyond TTL → V1                          | Schema + writes; TTL still expires rows, just durably                                          |

## Architecture

```
agent (MCP)            server.ts                      Postgres
  │                       │                              │
  │  POST /new {spec} ───▶│ INSERT pages (state=open) ──▶│
  │◀── { id, url, exp }   │ map.set(id, page)            │
  │                       │                              │
  │  GET /:id/result ────▶│ map.get(id)                  │
  │◀── { state, result }  │ if state==submitted:         │
  │                       │   UPDATE state=received ────▶│
  │                       │   map mutation               │
  │                       │                              │
user (browser)             │                              │
  │                       │                              │
  │  GET /:id ───────────▶│ map.get(id) → spec/state    │
  │◀── { spec, state }    │ (no state mutation)          │
  │  POST /:id/result ───▶│ if state!=open → 409         │
  │◀── { ok }             │ UPDATE state=submitted ─────▶│
  │                       │ map mutation                 │
```

**No in-memory event log. No SSE waiters. No long-poll.** The Map's job
shrinks to: cache reads of immutable fields and current state, and serve
as a single source of truth that the server's request handlers
synchronize against. All durability lives in Postgres.

### Why DB-first writes

Writes go to Postgres before the Map mutates so memory and DB cannot
diverge: a successful response always implies a durable row, and a
crash mid-write leaves Map and DB consistent (Map gets re-loaded from DB
on next boot anyway).

### State transitions are guarded both in-memory and in SQL

Single-process JS is non-preemptive within a request, so the in-memory
state check is sufficient for correctness. The SQL `WHERE` clauses
duplicate the guard for crash-replay safety (if we restart between
states the Map rehydrates and the same logic applies).

## Schema

Single SQL file, `db/init.sql`, applied via the Supabase SQL editor
(or `psql $DATABASE_URL -f db/init.sql`).

```sql
create table if not exists pages (
  id            text primary key,
  spec          jsonb       not null,
  state         text        not null
                check (state in ('open','submitted','received')),
  result        jsonb,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  submitted_at  timestamptz,
  received_at   timestamptz
);

create index if not exists pages_expires_at_idx
  on pages (expires_at);
```

`spec` and `result` are opaque JSON to the service. The check constraint
makes invalid state values impossible at the DB layer.

## Module structure

| File                                               | Role                                                                                                            | Status        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------- |
| `types.ts`                                         | `Page` and `PageState` types                                                                                    | **new**       |
| `db/init.sql`                                      | schema migration                                                                                                | **new**       |
| `db.ts`                                            | SQL adapter: `init`, `shutdown`, `loadActivePages`, `insertPage`, `markSubmitted`, `markReceived`, `deletePage` | **new**       |
| `db.test.ts`                                       | integration tests against the user's Supabase project                                                           | **new**       |
| `.env.example`                                     | `DATABASE_URL` placeholder                                                                                      | **new**       |
| `server.ts`                                        | 4 routes, Map + write-through, lazy + sweep TTL                                                                 | **rewritten** |
| `client/main.ts`                                   | fetch-once on mount, optimistic lock on submit, optional poll for `received`                                    | **rewritten** |
| `mcp/server.ts`                                    | tools `show_ui` (POST /new) and `check_result` (GET /:id/result)                                                | **rewritten** |
| `mcp/smoke.mjs`                                    | smoke against new endpoints                                                                                     | **rewritten** |
| `mcp/SKILL.md`, `skills/agent-ui-session/SKILL.md` | prose for the polling pattern                                                                                   | **rewritten** |
| `requests.http`                                    | manual-test harness, new endpoints                                                                              | **rewritten** |
| `package.json`                                     | `postgres` dep, `test` script                                                                                   | **modified**  |

`client/index.html`, `vite.config.ts`, `tsconfig.json`, plugin metadata,
top-level deps unchanged.

## `db.ts` surface

```ts
import type { Page } from './types.ts';

export async function init(connectionString: string): Promise<void>;
export async function shutdown(): Promise<void>;

export async function loadActivePages(into: Map<string, Page>): Promise<void>;
export async function insertPage(p: Page): Promise<void>;
export async function markSubmitted(id: string, result: unknown): Promise<void>;
export async function markReceived(id: string): Promise<void>;
export async function deletePage(id: string): Promise<void>;
```

Each function is a single SQL statement. No transactions; single-process
ordering is enough.

## Endpoint → handler mapping

### `POST /new`

```ts
const id = newId();
const expiresAt = Date.now() + TTL_MS;
const page: Page = {
  id,
  spec: body.spec,
  state: 'open',
  result: null,
  createdAt: Date.now(),
  expiresAt,
  submittedAt: null,
  receivedAt: null,
};
await db.insertPage(page);
pages.set(id, page);
return c.json({ id, url: `${PUBLIC_URL}/${id}`, expires_at: page.expiresAt }, 201);
```

### `GET /:id`

```ts
const p = pages.get(id);
if (!p || isExpired(p)) return 404;
return c.json({ spec: p.spec, state: p.state, result: p.result, expires_at: p.expiresAt });
```

### `POST /:id/result`

```ts
const p = pages.get(id);
if (!p || isExpired(p)) return 404;
if (p.state !== 'open') return 409;
const action = await c.req.json();
await db.markSubmitted(id, action);
p.state = 'submitted';
p.result = action;
p.submittedAt = Date.now();
return c.json({ ok: true });
```

### `GET /:id/result`

```ts
const p = pages.get(id);
if (!p || isExpired(p)) return 404;
if (p.state === 'submitted') {
  await db.markReceived(id);
  p.state = 'received';
  p.receivedAt = Date.now();
}
return c.json({ state: p.state, result: p.result });
```

## Renderer (`client/main.ts`)

Replaces the current SSE-driven shell. Lit element with three render
states matching the page state:

1. **Loading.** On `connectedCallback`, `GET /:id`. While pending, show
   spinner.
2. **Open.** Mount the A2UI shell with the loaded `spec`. The shell's
   message-processor callback fires `POST /:id/result`. On dispatch,
   set `awaiting = true` (visual lock + banner).
3. **Submitted (locally).** After successful POST, optionally poll
   `GET /:id` every ~2s to detect `state === 'received'`; when seen,
   upgrade the banner to "the agent has your input." Stop polling on
   `received`. (This poll is the PRD's explicitly-marked optional polish.
   Default ON; easy to disable.)
4. **Errors.** 404 → "page expired or not found." 409 (rare race) →
   re-fetch with `GET /:id` and re-render in the new state.

No `EventSource`, no event log, no `surfacesMap` clearing, no
`surface_updated` handling. The page surface is loaded once at
mount and never replaced.

## MCP server

Two tools, both fire-and-return:

```ts
show_ui(spec) -> { page_id, url, expires_at }
  // POST /new
check_result(page_id) -> { state, result }
  // GET /:id/result
```

Skill prose (in `mcp/SKILL.md` and `skills/agent-ui-session/SKILL.md`):

> Call `show_ui(spec)` and print the URL. Then call `check_result`. If
> `state === "open"`, the user hasn't responded yet — wait a few
> seconds (or do other work) and call again. When `result` is
> populated, you have the user's input.

## Library and configuration

- **Driver:** `postgres` (porsager). Tagged-template SQL, SSL on by
  default.
- **Connection:** Supabase **session pooler** on port 5432 via
  `DATABASE_URL` env var. `.env.example` ships with a placeholder.
  `.env` is already gitignored.
- One pool created in `db.init()`; `await sql.end({ timeout: 5 })` on
  graceful shutdown (`SIGINT`, `SIGTERM`).

## Lifecycle, ordering, and failure modes

- **Boot:** `db.init()` opens the pool and runs `select 1`. Failure
  exits the process before binding the HTTP port. Then
  `db.loadActivePages(map)` rehydrates pages whose `expires_at > now()`.
  Server logs the count.
- **Mutating requests:** DB write happens _before_ the Map mutation. If
  the DB write fails, the handler returns 500 and the Map is unchanged.
- **TTL sweep:** existing 60s interval iterates expired Map entries,
  deletes them from DB, then the Map. Failures are logged and retried
  next tick (entry stays in Map).
- **DB unreachable mid-request:** 500. The renderer surfaces it as a
  retry message; the agent sees an error from the MCP tool.
- **`POST /:id/result` after submit:** 409. Renderer's optimistic lock
  prevents this from happening normally; if it does (e.g., page open in
  two tabs), the second tab gets 409 and re-fetches `GET /:id` to
  display the now-locked state.
- **Concurrent first GET /:id/result:** in single-process Node both
  reads see `state==='submitted'`. The second one re-issues
  `markReceived` — idempotent, no-op SET on already-received state.
  (We can sharpen the SQL with `WHERE state='submitted'` for safety;
  see `db.ts` surface notes below.)

### `db.ts` SQL details

- `markSubmitted(id, result)`:
  `UPDATE pages SET state='submitted', result=$2, submitted_at=now() WHERE id=$1 AND state='open'`
- `markReceived(id)`:
  `UPDATE pages SET state='received', received_at=now() WHERE id=$1 AND state='submitted'`

Both `WHERE state=...` clauses provide defense-in-depth: if memory and
DB ever drift (e.g. crash mid-write, manual DB poke), the conditional
`UPDATE` makes a stale call a no-op rather than a corrupting overwrite.

- `deletePage(id)`: `DELETE FROM pages WHERE id=$1`.

## Verification (must hold before declaring done)

- `psql $DATABASE_URL -f db/init.sql` succeeds; `\dt` shows `pages`.
- `npm test` runs the integration tests against the real DB; all pass.
- `npm run dev` boots cleanly; logs `rehydrated N page(s) from db`.
- Missing/unreachable `DATABASE_URL` → fail fast with clear message.
- End-to-end smoke (`mcp/smoke.mjs`):
  - `show_ui` returns `{page_id, url}`.
  - Open URL in browser → renderer fetches and shows surface.
  - Submit → server stores result, Map and DB both updated.
  - `check_result` returns `{state: 'submitted', result: ...}`.
  - Second `check_result` returns `{state: 'received', result: ...}`.
- Restart-survives: create page, submit, restart server, `GET /:id`
  returns identical state including `result` and `state==='submitted'`
  or `'received'` as last left.
- `requests.http` manual flow exercises every status code (201, 200,
  400, 404, 409).

## Out of scope

- Auth, RLS, per-user pages.
- Multi-process / horizontal scale (would need DB-side state machine
  enforcement and a smaller in-process working set).
- Migration tooling (drizzle-kit, supabase migrations). One SQL file by
  hand for V0.
- Multi-format spec negotiation. Renderer assumes A2UI v0.9.
- Renderer's optional `received` poll cadence backoff (fixed 2s for V0).

## Risks / open items

- **Pooler latency over WAN.** Each mutating request waits on one
  Postgres round-trip (~50–200ms over the Supabase pooler). Well within
  the PRD's 2s render and "next-poll" delivery budgets.
- **`received` is single-edge.** Once flipped, `GET /:id/result`
  returning the same `result` is fine — the agent's polling loop
  terminates as soon as `result !== null`. No multi-fetch problem.
- **Credential hygiene.** `DATABASE_URL` lives in `.env` (gitignored)
  and deployment secrets only.
