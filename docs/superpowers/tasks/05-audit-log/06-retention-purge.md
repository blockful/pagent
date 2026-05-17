# 06 -- Retention purge timer

## Description

Add the background timer that deletes audit log rows older than 90 days,
running every 6 hours alongside the existing page TTL sweep.

## Files to create/modify

- `apps/api/server.ts` -- add a `setInterval` (6-hour period) that calls
  `db.purgeOldAuditEvents(90)`. Log the count of deleted rows. Call
  `.unref()` on the timer so it does not prevent process exit.

## Acceptance criteria

- A `setInterval` runs every 6 hours (21,600,000 ms).
- It calls `db.purgeOldAuditEvents(90)` and logs the result via
  `logger.info` when `deleted > 0`.
- On error, it logs via `logger.error` and does not crash the process.
- The timer handle has `.unref()` so it does not keep the process alive
  during shutdown.
- The 90-day retention period is hardcoded (no env-var config in V1).

## Dependencies

- **01** (schema and DB layer) -- `purgeOldAuditEvents()` must exist.

## Relevant spec sections

- Section 9 (Retention policy) -- timer setup, purge implementation,
  batched delete strategy for large tables
