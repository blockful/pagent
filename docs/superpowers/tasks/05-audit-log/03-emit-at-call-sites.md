# 03 -- Emit audit events at call sites

## Description

Wire `emitAuditEvent()` / `emitAuditEvents()` into the existing page
lifecycle code so that `page.created`, `page.submitted`,
`page.received`, and `page.expired` events are recorded.

## Files to create/modify

- `apps/api/store.ts` -- add `RequestContext` parameter to
  `createPage()` and `createHtmlPage()`. Emit `page.created` after
  `db.insertPage()`. Emit `page.received` in `advanceResult()` (or
  equivalent) when state flips from `submitted` to `received`.
- `apps/api/app.ts` -- extract `ip_address` (via `clientKey()`) and
  `user_agent` from the Hono context in `newPageHandler`,
  `submitResultHandler`, and `getResultHandler`. Pass `RequestContext` to
  store functions. Emit `page.submitted` after `db.submitPage()` returns
  `{ kind: 'ok' }`.
- `apps/api/server.ts` -- extend the TTL sweep callback. Change
  `db.deleteExpiredPages()` (or its caller) to return expired row
  metadata (`id`, `state`, `format`, `created_at`). Call
  `emitAuditEvents()` with `page.expired` for each deleted row.
- `apps/api/db.ts` -- extend `deleteExpiredPages()` return type to
  include the `expired` array with `{ id, state, format, created_at }`.
- `apps/api/mcp/http.ts` -- extract IP/UA from the raw
  `IncomingMessage` and pass `RequestContext` to store calls.

## Acceptance criteria

- `POST /new` emits `page.created` with metadata: `format`,
  `spec_bytes`, `expires_at`, `url`.
- `POST /:id/result` emits `page.submitted` with metadata: `format`,
  `action_name`, `action_surface_id`, `latency_ms`.
- `GET /:id/result` emits `page.received` (only on the first read that
  transitions state from `submitted` to `received`) with metadata:
  `format`, `read_latency_ms`.
- The TTL sweep emits one `page.expired` event per deleted row with
  metadata: `state_at_expiry`, `format`, `age_ms`.
- All emits include `ip_address` and `user_agent` when available (null
  for system-initiated events like expiry).
- Existing tests in `app.test.ts` still pass (no regressions from
  signature changes).
- New tests verify that each handler calls `emitAuditEvent` with the
  correct action and metadata shape.

## Dependencies

- **01** (schema and DB layer) -- `deleteExpiredPages` return type change.
- **02** (emitter module) -- `emitAuditEvent`, `emitAuditEvents`,
  `RequestContext`.

## Relevant spec sections

- Section 3 (Event catalog) -- 3.1 through 3.4 for metadata shapes
- Section 6.2 (Call sites) -- exact code locations and context threading
- Section 8 (Performance) -- fire-and-forget contract, batch insert for
  sweep
