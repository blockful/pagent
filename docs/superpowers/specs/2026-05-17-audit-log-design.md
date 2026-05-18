# Audit Log — Design

Status: draft, awaiting user review (2026-05-17).

## 1. Overview and motivation

Pagent currently stores pages and their results but has no record of
_what happened_ or _who did what_. When a page is submitted, expired,
or fetched, the event is lost once the page row is garbage-collected.
Operators cannot answer:

- "Which agent created this page?"
- "When was the result read back?"
- "How many pages expired without any submission last week?"
- "Did the webhook for page X succeed or fail?"

An append-only audit log records every significant lifecycle event with
enough context to answer these questions, support future compliance
requirements, and power product analytics.

### Design principles

1. **Append-only.** Events are immutable once written. No UPDATE, no
   DELETE (except the 90-day retention purge).
2. **Fire-and-forget writes.** Audit emission must never block or fail
   the primary operation. If the audit INSERT throws, log the error and
   continue.
3. **Opt-in identity.** When a `user_id` is available (from the auth
   layer shipping in v2), it is captured. Otherwise `user_id = null`.
4. **Minimal PII.** Only IP address and User-Agent are stored as
   request-level context. No email, no name, no bearer token.

### Non-goals

- **Real-time alerting on audit events.** The log is queryable, not
  streamable. Alerting belongs in the metrics/observability layer.
- **Tamper-proof / cryptographic chain.** This is an operational audit
  log, not a compliance ledger. Hash-chaining is out of scope.
- **Cross-resource joins.** The audit log does not join to the `pages`
  table. Events carry denormalized metadata so they remain useful after
  the page row is garbage-collected.

---

## 2. Database schema

### Table

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid          REFERENCES users(id) ON DELETE SET NULL,
  action        text          NOT NULL,
  resource_type text          NOT NULL CHECK (resource_type IN ('page', 'file', 'webhook')),
  resource_id   text          NOT NULL,
  metadata      jsonb         NOT NULL DEFAULT '{}',
  ip_address    text,
  user_agent    text,
  created_at    timestamptz   NOT NULL DEFAULT now()
);
```

Notes on column choices:

- **id** — UUID v7 (time-sortable) would be ideal but Postgres
  `gen_random_uuid()` produces v4. Acceptable because queries sort on
  `created_at`, not `id`. If UUID v7 becomes available via an extension,
  switch — but do not block on it.
- **user_id** — Nullable FK to `users(id)` with `ON DELETE SET NULL`.
  Auth ships in v2 alongside the audit log, so the FK constraint is
  present from day one. `user_id` is `NULL` for system-initiated events
  (e.g. `page.expired`) and for unauthenticated requests.
- **action** — Free-text, not an enum. Enums require a migration to
  add a value; free-text with an application-level allowlist is cheaper
  to evolve.
- **resource_type** — CHECK constraint limits to known types. A new
  type (e.g. `'user'`) requires a migration to alter the CHECK, which
  is intentional — adding a resource type should be deliberate.
- **metadata** — JSONB bag for action-specific details. Schema per
  action type is documented in section 3 below.
- **ip_address** — Last-hop IP from `X-Forwarded-For`, extracted by
  the existing `clientKey()` utility. Stored as text, not inet, to
  avoid parse failures on malformed headers.
- **user_agent** — Raw `User-Agent` header value, truncated to 512
  characters at write time.

### Initial migration (in `db.init()`)

Because Pagent uses boot-time DDL (not a migration runner), the audit
log table is created in the same `db.init()` function that creates
`pages`. Auth ships in the same v2 batch, so the `users` FK is present
from day one.

```sql
-- In db.init(), after the pages table:
CREATE TABLE IF NOT EXISTS audit_log (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid          REFERENCES users(id) ON DELETE SET NULL,
  action        text          NOT NULL,
  resource_type text          NOT NULL CHECK (resource_type IN ('page', 'file', 'webhook')),
  resource_id   text          NOT NULL,
  metadata      jsonb         NOT NULL DEFAULT '{}',
  ip_address    text,
  user_agent    text,
  created_at    timestamptz   NOT NULL DEFAULT now()
);
```

### Indexes

```sql
-- Primary query path: "show me all events for this resource"
CREATE INDEX IF NOT EXISTS audit_log_resource_idx
  ON audit_log (resource_type, resource_id, created_at DESC);

-- Secondary query path: "show me all events by this user"
CREATE INDEX IF NOT EXISTS audit_log_user_idx
  ON audit_log (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Retention purge: delete rows older than 90 days
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx
  ON audit_log (created_at);

-- Action filtering: "show me all page.expired events"
CREATE INDEX IF NOT EXISTS audit_log_action_idx
  ON audit_log (action, created_at DESC);
```

Index rationale:

| Index | Serves | Why not a different shape |
|---|---|---|
| `resource_idx` | `GET /audit?resource_id=X` — the primary read path. Composite on `(resource_type, resource_id, created_at DESC)` so the planner can satisfy the filter + sort in one scan. | A single-column index on `resource_id` would still require a sort step for `ORDER BY created_at DESC`. |
| `user_idx` | `GET /audit?user_id=X` — secondary path. Partial index (`WHERE user_id IS NOT NULL`) saves space while the feature runs without auth (all rows have `user_id = NULL`). | Full index would waste pages on NULL-keyed rows that the query never matches. |
| `created_at_idx` | Retention `DELETE ... WHERE created_at < now() - interval '90 days'`. | Without this, the purge does a full table scan. |
| `action_idx` | Optional action filter on the API: `GET /audit?action=page.expired`. | Compound with `created_at DESC` so the planner can push both predicates + sort. |

---

## 3. Event catalog

Every event type, its trigger, and the shape of its `metadata` JSONB.

### 3.1 `page.created`

| Field | Value |
|---|---|
| **Trigger** | `store.createPage()` or `store.createHtmlPage()` — after the page INSERT succeeds. |
| **resource_type** | `'page'` |
| **resource_id** | The page `id` (32-char hex). |
| **ip_address** | From the request that called `POST /new` or the MCP `show_ui` / `show_html` tool. |
| **user_agent** | From the same request. |

```jsonc
// metadata
{
  "format": "a2ui" | "html",
  "spec_bytes": 14320,       // byte length of JSON.stringify(spec) or raw HTML
  "expires_at": 1747509600000, // ms epoch
  "url": "https://pagent.link/abc123..."
}
```

### 3.2 `page.submitted`

| Field | Value |
|---|---|
| **Trigger** | `db.submitPage()` returns `{ kind: 'ok' }`. |
| **resource_type** | `'page'` |
| **resource_id** | The page `id`. |
| **ip_address** | From the `POST /:id/result` request (the browser user). |
| **user_agent** | From the same request (browser UA). |

```jsonc
// metadata
{
  "format": "a2ui",
  "action_name": "submit",       // action.name from the A2UI client-action
  "action_surface_id": "root",   // action.surfaceId
  "latency_ms": 12345            // time from page creation to submission
}
```

Note: the full `result` payload is NOT stored in audit metadata. It
lives on the `pages` row (and is available to the agent via
`GET /:id/result`). Duplicating it in the audit log would bloat the
table and raise PII concerns (user-typed input is unbounded).

### 3.3 `page.received`

| Field | Value |
|---|---|
| **Trigger** | `db.fetchAndAdvanceResult()` performs the `submitted -> received` state transition (first read). |
| **resource_type** | `'page'` |
| **resource_id** | The page `id`. |
| **ip_address** | From the `GET /:id/result` request (the agent). |
| **user_agent** | From the same request (agent's HTTP client UA). |

```jsonc
// metadata
{
  "format": "a2ui",
  "read_latency_ms": 5432   // time from submission to agent's first read
}
```

Only emitted on the _first_ read that flips the state. Subsequent
`GET /:id/result` calls (state is already `received`) do NOT emit
another event.

### 3.4 `page.expired`

| Field | Value |
|---|---|
| **Trigger** | `db.deleteExpiredPages()` — the TTL sweep in `server.ts`. |
| **resource_type** | `'page'` |
| **resource_id** | The page `id`. |
| **ip_address** | `null` (system-initiated). |
| **user_agent** | `null` (system-initiated). |

```jsonc
// metadata
{
  "state_at_expiry": "open" | "submitted" | "received",
  "format": "a2ui" | "html",
  "age_ms": 1800000   // time from creation to expiry sweep
}
```

Emitted per expired row. When the sweep deletes 50 rows, 50 audit
events are inserted. This is batched in a single multi-row INSERT (see
section 8).

### 3.5 `page.closed`

| Field | Value |
|---|---|
| **Trigger** | Owner explicitly closes a public page before TTL (Public Forms, shipping in v2). |
| **ip_address** | From the request that called the close endpoint. |
| **user_agent** | From the same request. |
| **resource_type** | `'page'` |
| **resource_id** | The page `id`. |

```jsonc
// metadata
{
  "format": "a2ui" | "html",
  "state_at_close": "open" | "submitted" | "received",
  "remaining_ttl_ms": 120000
}
```

### 3.6 `file.uploaded`

| Field | Value |
|---|---|
| **Trigger** | File upload endpoint accepts a file (File Uploads, shipping in v2). |
| **ip_address** | From the upload request. |
| **user_agent** | From the same request. |
| **resource_type** | `'file'` |
| **resource_id** | The file identifier. |

```jsonc
// metadata
{
  "filename": "report.pdf",
  "content_type": "application/pdf",
  "size_bytes": 204800,
  "page_id": "abc123..."   // page the file is attached to, if any
}
```

### 3.7 `webhook.delivered`

| Field | Value |
|---|---|
| **Trigger** | Webhook delivery succeeds (HTTP 2xx from the target). Webhooks ship in v2. |
| **resource_type** | `'webhook'` |
| **resource_id** | The webhook configuration identifier. |

```jsonc
// metadata
{
  "page_id": "abc123...",
  "target_url": "https://example.com/hook",
  "http_status": 200,
  "latency_ms": 342,
  "attempt": 1
}
```

### 3.8 `webhook.failed`

| Field | Value |
|---|---|
| **Trigger** | Webhook delivery fails after all retries are exhausted. Webhooks ship in v2. |
| **resource_type** | `'webhook'` |
| **resource_id** | The webhook configuration identifier. |

```jsonc
// metadata
{
  "page_id": "abc123...",
  "target_url": "https://example.com/hook",
  "http_status": 503,
  "error": "timeout after 10s",
  "latency_ms": 10042,
  "attempt": 3,
  "max_attempts": 3
}
```

---

## 4. REST API endpoint

### `GET /audit`

Query audit log events. Supports filtering by resource, user, and
action, with cursor-based pagination.

#### Query parameters

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `resource_id` | string | no | — | Filter to events for this resource. When set, `resource_type` should also be set. |
| `resource_type` | `page` \| `file` \| `webhook` | no | — | Filter to a resource type. Ignored if `resource_id` is set (inferred from the resource). |
| `user_id` | uuid | no | — | Filter to events by this user. |
| `action` | string | no | — | Filter to a specific action (e.g. `page.created`). |
| `cursor` | string | no | — | Opaque pagination cursor from a previous response. |
| `limit` | integer | no | 50 | Page size, 1..200. |

At least one of `resource_id` or `user_id` MUST be provided. Open-ended
`GET /audit` with no filter returns 400. This prevents full-table scans
and enforces the access-control model (you must know what you are
querying for).

#### Response (200)

```jsonc
{
  "events": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "user_id": null,
      "action": "page.created",
      "resource_type": "page",
      "resource_id": "aabbccddeeff00112233445566778899",
      "metadata": {
        "format": "a2ui",
        "spec_bytes": 14320,
        "expires_at": 1747509600000,
        "url": "https://pagent.link/aabbccddeeff00112233445566778899"
      },
      "ip_address": "203.0.113.42",
      "user_agent": "claude-code/1.0",
      "created_at": "2026-05-17T14:30:00.000Z"
    }
    // ...more events
  ],
  "cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wNS0xN1QxNDoyOTowMC4wMDBaIiwiaWQiOiIuLi4ifQ==",
  "has_more": true
}
```

#### Pagination

Cursor-based, not offset-based. The cursor encodes `(created_at, id)`
of the last event in the current page. The next request uses:

```sql
WHERE (created_at, id) < ($cursor_created_at, $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT $limit
```

This gives stable results under concurrent writes (no skipped or
duplicated rows) and performs well with the `created_at DESC` index
ordering.

The cursor is a base64-encoded JSON object:
```jsonc
{ "created_at": "2026-05-17T14:29:00.000Z", "id": "550e8400-..." }
```

Clients treat it as opaque. The server validates the decoded shape and
returns 400 on a malformed cursor.

#### Error responses

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | Missing `resource_id` and `user_id`, invalid `limit`, malformed `cursor`. |
| 400 | `bad_request` | Unknown `resource_type` or `action` value. |
| 500 | `internal_error` | Database failure. |

#### Zod schema (validation)

```typescript
const auditQuerySchema = z.object({
  resource_id: z.string().optional(),
  resource_type: z.enum(['page', 'file', 'webhook']).optional(),
  user_id: z.string().uuid().optional(),
  action: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
}).refine(
  (q) => q.resource_id || q.user_id,
  { message: 'At least one of resource_id or user_id is required' },
);
```

#### Route registration

In `app.ts`, after the existing routes:

```typescript
app.get('/audit', auditHandler);
```

No rate limiter on the read path — it is bounded by the mandatory
filter requirement and the access-control check.

---

## 5. MCP tool

### `get_audit_log`

A new MCP tool registered alongside `show_ui`, `show_html`, and
`check_result` in `apps/api/mcp/tools.ts`.

#### Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `page_id` | string (32-char hex) | yes | The page to query audit events for. |
| `limit` | number (1..100) | no | Max events to return. Default 20. |

The tool only supports `page_id` queries — it cannot query by
`user_id` (the agent does not know the user's identity) or by action
type (too niche for the tool surface). Agents that need richer queries
can call `GET /audit` directly.

#### Response

```jsonc
{
  "content": [
    {
      "type": "text",
      "text": "Audit log for page aabb...:\n\n2026-05-17T14:30:00Z  page.created  (format: a2ui, 14320 bytes)\n2026-05-17T14:32:15Z  page.submitted  (latency: 135s)\n2026-05-17T14:32:18Z  page.received  (read latency: 3s)"
    }
  ],
  "structuredContent": {
    "page_id": "aabb...",
    "events": [
      {
        "action": "page.created",
        "created_at": "2026-05-17T14:30:00.000Z",
        "metadata": { "format": "a2ui", "spec_bytes": 14320 }
      }
      // ...
    ]
  }
}
```

The text content is a human-readable summary. The structuredContent
carries the full event list for programmatic consumption.

#### Registration

```typescript
// In registerPagentTools(), after check_result:

server.registerTool(
  'get_audit_log',
  {
    title: 'Get audit log for a page',
    description: GET_AUDIT_LOG_DESCRIPTION,
    inputSchema: {
      page_id: z.string().regex(/^[a-f0-9]{32}$/, 'invalid page_id')
        .describe('The page_id to fetch audit events for.'),
      limit: z.number().int().min(1).max(100).optional().default(20)
        .describe('Max events to return (default 20).'),
    },
  },
  async ({ page_id, limit }) => {
    const events = await ops.getAuditLog(page_id, limit);
    // ... format text + structuredContent
  },
);
```

#### PageOps extension

```typescript
export interface PageOps {
  showUi(spec: unknown): Promise<ShowUiResult>;
  showHtml(html: string): Promise<ShowUiResult>;
  checkResult(page_id: string): Promise<CheckResultOutcome>;
  getAuditLog(page_id: string, limit: number): Promise<AuditEvent[]>;
}
```

The in-process adapter (`mcp/http.ts`) queries the DB directly. The
stdio adapter (`apps/mcp/server.ts`) calls `GET /audit?resource_id=<page_id>&resource_type=page&limit=<limit>`.

---

## 6. Integration points

Where in existing code each audit event is emitted. Every call site
uses the `emitAuditEvent()` helper (section 6.1).

### 6.1 Audit emitter module

New file: `apps/api/audit.ts`.

```typescript
import * as db from './db.ts';
import { logger } from './logger.ts';

export type AuditEvent = {
  user_id?: string | null;
  action: string;
  resource_type: 'page' | 'file' | 'webhook';
  resource_id: string;
  metadata?: Record<string, unknown>;
  ip_address?: string | null;
  user_agent?: string | null;
};

/**
 * Fire-and-forget audit event insertion.
 *
 * Never throws — catches any DB error and logs it. The caller's
 * primary operation must not fail because the audit log is down.
 */
export function emitAuditEvent(event: AuditEvent): void {
  db.insertAuditEvent(event).catch((err) => {
    logger.error({ err, audit_event: event }, 'failed to emit audit event');
  });
}

/**
 * Batch-emit audit events (used by the TTL sweep for page.expired).
 * Same fire-and-forget contract as emitAuditEvent.
 */
export function emitAuditEvents(events: AuditEvent[]): void {
  if (events.length === 0) return;
  db.insertAuditEvents(events).catch((err) => {
    logger.error(
      { err, count: events.length },
      'failed to emit batch audit events',
    );
  });
}
```

### 6.2 Call sites

#### `page.created` — `apps/api/store.ts`

In `createPage()` and `createHtmlPage()`, after `db.insertPage()`
succeeds:

```typescript
// store.ts — createPage()
emitAuditEvent({
  action: 'page.created',
  resource_type: 'page',
  resource_id: page.id,
  metadata: {
    format,
    spec_bytes: JSON.stringify(spec).length,
    expires_at: page.expiresAt,
    url: `${cfg.publicUrl}/${page.id}`,
  },
  ip_address: ctx?.ipAddress,
  user_agent: ctx?.userAgent,
});
```

The `ctx` (request context — IP + UA) must be threaded through from
the route handler. Today `createPage()` does not receive request
context. The signature changes to:

```typescript
export type RequestContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function createPage(
  spec: unknown,
  format: PageFormat,
  cfg: CreatePageConfig,
  ctx?: RequestContext,    // NEW — optional for backward compat
): Promise<ShowUiResult>;
```

The REST handler (`app.ts` `newPageHandler`) extracts IP/UA from the
Hono context. The MCP in-process handler (`mcp/http.ts`) extracts from
the raw `IncomingMessage`. The MCP stdio handler has no request context
(events emitted by the REST API it calls, not by the stdio process).

#### `page.submitted` — `apps/api/app.ts`

In `submitResultHandler`, after `db.submitPage()` returns `{ kind: 'ok' }`:

```typescript
emitAuditEvent({
  action: 'page.submitted',
  resource_type: 'page',
  resource_id: idResult.data,
  metadata: {
    format: page.format,
    action_name: action.name,
    action_surface_id: action.surfaceId,
    latency_ms: Date.now() - outcome.createdAt.getTime(),
  },
  ip_address: clientKey(c.req.header('x-forwarded-for')),
  user_agent: c.req.header('user-agent')?.slice(0, 512),
});
```

#### `page.received` — `apps/api/db.ts` or `apps/api/store.ts`

In `fetchAndAdvanceResult()`, when `state === 'submitted'` and the
UPDATE to `'received'` succeeds. This is the trickiest call site
because `fetchAndAdvanceResult` currently has no request context. Two
options:

- **Option A (preferred):** Thread request context into
  `store.advanceResult()` and emit there.
- **Option B:** Emit in `getResultHandler` in `app.ts` by checking the
  returned `stateAtRead === 'submitted'` (meaning it just transitioned).

Option A is preferred because the MCP in-process path also calls
`store.advanceResult()`, and we want both paths to emit.

#### `page.expired` — `apps/api/server.ts`

In the sweep timer callback, after `db.deleteExpiredPages()`. The sweep
function must be extended to return the expired rows' metadata (id,
state, format, created_at) so the audit events can be populated:

```typescript
// Enhanced deleteExpiredPages return type:
export async function deleteExpiredPages(): Promise<{
  total: number;
  abandoned: number;
  expired: Array<{ id: string; state: PageState; format: PageFormat; created_at: Date }>;
}>;
```

Then in the sweep:

```typescript
const { total, abandoned, expired } = await db.deleteExpiredPages();
emitAuditEvents(expired.map((row) => ({
  action: 'page.expired',
  resource_type: 'page',
  resource_id: row.id,
  metadata: {
    state_at_expiry: row.state,
    format: row.format,
    age_ms: Date.now() - row.created_at.getTime(),
  },
})));
```

---

## 7. Access control

Auth ships in the same v2 batch. The access-control rules are:

| Query | Who can read |
|---|---|
| `GET /audit?resource_id=X` | The user who owns resource X (i.e. the user whose `user_id` matches the page creator). |
| `GET /audit?user_id=X` | Only user X themselves (authenticated via bearer token). |
| MCP `get_audit_log({ page_id })` | The agent session that created the page (validated by matching the session's user_id against the page creator). |

Implementation:

```typescript
// Pseudocode in auditHandler:
const authedUser = c.get('userId'); // set by auth middleware

if (query.user_id && query.user_id !== authedUser) {
  return c.json({ error: 'forbidden', message: 'Cannot query another user\'s audit log' }, 403);
}

if (query.resource_id) {
  const owner = await db.getResourceOwner(query.resource_type, query.resource_id);
  if (owner && owner !== authedUser) {
    return c.json({ error: 'forbidden', message: 'Cannot query audit log for a resource you do not own' }, 403);
  }
}
```

### Unauthenticated fallback

If a request arrives without a valid bearer token, `GET /audit` returns
401. Page IDs are 128-bit random hex (unguessable), but the audit log
should not be accessible without authentication.

---

## 8. Performance considerations

### Write path (hot)

Audit events are written on every page lifecycle transition. The
primary concern is that audit writes do not add latency to user-facing
operations.

**Strategy: fire-and-forget async INSERT.**

`emitAuditEvent()` calls `db.insertAuditEvent()` and catches errors
without awaiting the result in the caller's response path. The Promise
floats — if it rejects, the error is logged and swallowed.

This means:
- The `POST /new` response returns _before_ the audit INSERT commits.
- If Postgres is slow, the response is unaffected.
- If Postgres is down, the primary operation still succeeds (the page
  row was already inserted before the audit emit), and the audit event
  is lost. This is an acceptable trade-off.

### Batch insert for sweep

`page.expired` events from the TTL sweep are inserted in a single
multi-row INSERT to avoid N round-trips:

```sql
INSERT INTO audit_log (action, resource_type, resource_id, metadata, created_at)
VALUES
  ('page.expired', 'page', $1, $2, now()),
  ('page.expired', 'page', $3, $4, now()),
  ...
```

The sweep currently runs every 60 seconds. In pathological cases it
might delete thousands of rows. The batch INSERT is capped at 500 rows
per statement to avoid building a massive query string. If there are
more than 500 expired rows, emit in chunks.

### Read path

Reads go through the indexed queries described in section 2. The
mandatory filter requirement (`resource_id` or `user_id`) ensures
every query hits an index — there are no full-table scans.

Pagination is cursor-based, which is O(1) per page regardless of
offset depth (unlike OFFSET-based pagination, which degrades linearly).

### Table size estimate

Assumptions for a moderate deployment:
- 10,000 pages/day
- ~3 events per page (created + submitted + received)
- ~30,000 audit rows/day
- Average row size: ~500 bytes (including JSONB + indexes)
- Daily growth: ~15 MB
- 90-day retention: ~1.35 GB

This is well within Postgres capacity for a single-node deployment.

### Index overhead

Four indexes on a write-heavy append-only table add insertion overhead.
For the expected volume (~30K rows/day), this is negligible. If volume
grows 100x, consider:

1. Dropping the `action_idx` (least-used query pattern).
2. Partitioning by month (range partition on `created_at`), which also
   makes retention purge instant (DROP PARTITION).

---

## 9. Retention policy

### 90-day purge

Audit log rows older than 90 days are deleted by a background job.

**Implementation:** Extend the existing TTL sweep timer in `server.ts`
(which already runs every 60 seconds for `pages`) to also purge old
audit log rows. Run the audit purge less frequently — every 6 hours
(every 21,600th tick of the 1-second interval... or more practically,
use a separate `setInterval`).

```typescript
// In server.ts, after the existing sweepTimer:
const auditPurgeTimer = setInterval(async () => {
  try {
    const deleted = await db.purgeOldAuditEvents(90);
    if (deleted > 0) {
      logger.info({ deleted }, 'audit log retention purge');
    }
  } catch (err) {
    logger.error({ err }, 'audit log retention purge failed');
  }
}, 6 * 60 * 60 * 1000); // every 6 hours
auditPurgeTimer.unref();
```

DB function:

```typescript
// In db.ts:
export async function purgeOldAuditEvents(retentionDays: number): Promise<number> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<{ count: string }[]>`
      WITH deleted AS (
        DELETE FROM audit_log
        WHERE created_at < now() - make_interval(days => ${retentionDays})
        RETURNING id
      )
      SELECT count(*)::text AS count FROM deleted
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
  });
}
```

For large purges, this DELETE can lock many rows. If the table grows
large enough for this to matter, switch to batched deletes:

```sql
DELETE FROM audit_log
WHERE id IN (
  SELECT id FROM audit_log
  WHERE created_at < now() - interval '90 days'
  LIMIT 10000
)
```

Run in a loop until 0 rows are deleted.

### Configuration

The retention period (90 days) is hardcoded in V1. If it needs to be
configurable, add `AUDIT_RETENTION_DAYS` to the env schema with a
default of 90.

---

## 10. Privacy considerations

### PII inventory

| Column | PII? | Content | Risk |
|---|---|---|---|
| `user_id` | Yes (when auth ships) | Links to user identity. | Medium. Mitigated by access control. |
| `ip_address` | Yes | Client IP address, last hop from X-Forwarded-For. | Medium. IP is PII under GDPR. |
| `user_agent` | Borderline | Browser/agent UA string. Can fingerprint devices. | Low. Generic string, not unique to a person. |
| `metadata` | Depends | Action-specific JSONB. Never contains the full result payload, but does contain the URL, format, and byte sizes. | Low. No user-typed input is stored in metadata. |

### GDPR implications

1. **Right to erasure.** If a user requests deletion of their data, all
   `audit_log` rows where `user_id` matches must be deleted. The
   `ON DELETE SET NULL` FK means deleting the user row nullifies the
   audit entries rather than cascading — this may not satisfy a strict
   GDPR erasure request. When auth ships, implement a dedicated
   `deleteUserAuditData(userId)` function that hard-deletes rows.

2. **Right to access.** `GET /audit?user_id=X` already provides this.
   The response can be exported as JSON for a data portability request.

3. **IP address retention.** 90-day retention limits the exposure
   window. For stricter compliance, IP addresses could be hashed (one-way)
   or anonymized (zero the last octet for IPv4, last 80 bits for IPv6)
   at write time. V1 stores raw IPs for operational debugging; revisit
   if the product moves into EU-regulated verticals.

4. **Data minimization.** The schema deliberately excludes:
   - Email addresses
   - Authentication tokens
   - Full result payloads (user-typed input)
   - Page specs (agent-generated content; could contain PII if the
     agent included it, but that is the agent's responsibility)

### Operational access

Only the API process writes to `audit_log`. There is no admin UI in V1.
Operators query the table via `psql` or the REST endpoint. When an
admin dashboard ships, it should enforce the same access-control rules
as the REST endpoint.

---

## Appendix A — DB function signatures for `db.ts`

```typescript
// --- New functions to add to db.ts ---

export type AuditEventRow = {
  id: string;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
};

export async function insertAuditEvent(event: {
  user_id?: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata?: Record<string, unknown>;
  ip_address?: string | null;
  user_agent?: string | null;
}): Promise<void>;

export async function insertAuditEvents(events: Array<{
  user_id?: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata?: Record<string, unknown>;
  ip_address?: string | null;
  user_agent?: string | null;
}>): Promise<void>;

export async function queryAuditLog(params: {
  resource_id?: string;
  resource_type?: string;
  user_id?: string;
  action?: string;
  cursor?: { created_at: Date; id: string };
  limit: number;
}): Promise<{ events: AuditEventRow[]; cursor: string | null; has_more: boolean }>;

export async function purgeOldAuditEvents(retentionDays: number): Promise<number>;
```

## Appendix B — OpenAPI addition

The `GET /audit` endpoint should be added to `docs/openapi.yaml` under
a new `Audit` tag. The response schema references the event shape from
section 4. The OpenAPI doc is served from memory at boot, so the YAML
file is the single source of truth.

## Appendix C — Metrics

Two new OTel metrics in `metrics.ts`:

```typescript
auditEventsEmitted: meter.createCounter('pagent.audit.events.emitted', {
  description: 'Audit events successfully inserted',
}),
auditEventsFailed: meter.createCounter('pagent.audit.events.failed', {
  description: 'Audit events that failed to insert',
}),
```

Increment `auditEventsEmitted` in `db.insertAuditEvent(s)` on success.
Increment `auditEventsFailed` in the catch block of `emitAuditEvent()`.

## Appendix D — Test plan

| Test | Location | What it covers |
|---|---|---|
| `db.test.ts` — audit INSERT/query | `apps/api/db.test.ts` | `insertAuditEvent`, `insertAuditEvents`, `queryAuditLog`, `purgeOldAuditEvents` against a mocked SQL client. |
| `app.test.ts` — GET /audit | `apps/api/app.test.ts` | Route handler: query param validation, pagination, cursor decode, 400 on missing filters. DB module mocked. |
| `app.test.ts` — audit emission | `apps/api/app.test.ts` | Verify that `POST /new`, `POST /:id/result`, and `GET /:id/result` call `emitAuditEvent` with the correct action and metadata. |
| `tools.test.ts` — get_audit_log | `apps/api/mcp/tools.test.ts` | MCP tool registration, input validation, text + structured output formatting. |
| `server integration` — sweep emits page.expired | Test or manual | Verify the TTL sweep calls `emitAuditEvents` with `page.expired` for each deleted row. |
