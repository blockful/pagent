# 01 -- Schema and DB layer

## Description

Create the `audit_log` table DDL in `db.init()` and implement the four
low-level database functions: single insert, batch insert, paginated
query, and retention purge.

## Files to create/modify

- `apps/api/db.ts` -- add `CREATE TABLE IF NOT EXISTS audit_log` with
  indexes inside `init()`. Add `insertAuditEvent()`,
  `insertAuditEvents()`, `queryAuditLog()`, `purgeOldAuditEvents()`.
- `apps/api/db.test.ts` -- unit tests for all four functions (mocked SQL
  client).

## Acceptance criteria

- `db.init()` creates the `audit_log` table with columns: `id`, `user_id`,
  `action`, `resource_type`, `resource_id`, `metadata`, `ip_address`,
  `user_agent`, `created_at`.
- `resource_type` has a CHECK constraint limiting to `('page', 'file', 'webhook')`.
- Four indexes are created: `audit_log_resource_idx`,
  `audit_log_user_idx` (partial, `WHERE user_id IS NOT NULL`),
  `audit_log_created_at_idx`, `audit_log_action_idx`.
- `insertAuditEvent(event)` inserts a single row; `user_agent` is
  truncated to 512 chars at write time.
- `insertAuditEvents(events)` performs a multi-row INSERT, chunked at
  500 rows per statement.
- `queryAuditLog(params)` returns `{ events, cursor, has_more }` with
  cursor-based pagination using `(created_at, id)` keyset. Cursor is
  base64-encoded JSON.
- `purgeOldAuditEvents(retentionDays)` deletes rows older than the
  given number of days and returns the count deleted.
- `AuditEventRow` type is exported.
- Tests cover: single insert, batch insert (>500 rows chunking), query
  with each filter (`resource_id`, `user_id`, `action`), cursor
  round-trip, purge.

## Dependencies

None -- this is the foundation task.

## Relevant spec sections

- Section 2 (Database schema) -- table DDL, column notes, indexes
- Section 8 (Performance considerations) -- batch insert chunking at 500
- Section 9 (Retention policy) -- `purgeOldAuditEvents` implementation
- Appendix A -- DB function signatures
