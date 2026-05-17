# 02 -- Audit emitter module

## Description

Create the fire-and-forget audit emitter (`apps/api/audit.ts`) that
wraps the DB insert functions, and add the two OTel counters for
success/failure tracking.

## Files to create/modify

- `apps/api/audit.ts` -- **new file**. Exports `emitAuditEvent()`,
  `emitAuditEvents()`, and the `AuditEvent` input type.
- `apps/api/metrics.ts` -- add `pagent.audit.events.emitted` counter and
  `pagent.audit.events.failed` counter.

## Acceptance criteria

- `emitAuditEvent(event)` calls `db.insertAuditEvent()` without
  awaiting in the caller. On DB error, logs via `logger.error` and
  swallows the exception (never throws).
- `emitAuditEvents(events)` calls `db.insertAuditEvents()` with the
  same fire-and-forget/swallow contract. No-ops on empty array.
- On successful insert, `pagent.audit.events.emitted` counter is
  incremented (by 1 for single, by `events.length` for batch).
- On failed insert, `pagent.audit.events.failed` counter is incremented.
- `AuditEvent` type matches the spec: `user_id?`, `action`, `resource_type`,
  `resource_id`, `metadata?`, `ip_address?`, `user_agent?`.
- `RequestContext` type (`{ ipAddress?: string | null; userAgent?: string | null }`)
  is exported from `audit.ts` (or `store.ts`) for use by call sites.

## Dependencies

- **01** (schema and DB layer) -- `insertAuditEvent`, `insertAuditEvents`
  must exist.

## Relevant spec sections

- Section 6.1 (Audit emitter module) -- full `emitAuditEvent` /
  `emitAuditEvents` implementation
- Section 6.2 preamble -- `RequestContext` type definition
- Appendix C (Metrics) -- counter names and descriptions
