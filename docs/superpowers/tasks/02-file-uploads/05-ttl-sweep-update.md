# 05 — TTL sweep: delete storage blobs before expired pages

## Description

Update the TTL sweep in `server.ts` to delete file blobs from Supabase Storage before the DB CASCADE removes `files` rows. Add the `filesOrphaned` metric for failed storage deletes.

## Files to create/modify

- `apps/api/server.ts` — update the `sweepTimer` setInterval callback:
  1. Call `db.getExpiredFilesPaths()` to collect storage paths for files belonging to expired pages.
  2. If paths exist, call `storage.deleteFiles(expiredPaths)` to remove blobs from Supabase Storage.
  3. Log the count of deleted file blobs at `debug` level.
  4. Then call `db.deleteExpiredPages()` as before (CASCADE removes `files` rows).
  - Import `storage` from `./storage.ts`.
- `apps/api/metrics.ts` — add `filesOrphaned` counter (`pagent.files.orphaned`, description: "File blobs that failed to delete from storage during sweep").
- `apps/api/storage.ts` — update `deleteFiles` to increment `metrics.filesOrphaned` counter on batch failure (in addition to logging the error).
- `apps/api/server.test.ts` or `apps/api/app.test.ts` — test that the sweep ordering is correct: `getExpiredFilesPaths` is called before `deleteExpiredPages`, and `storage.deleteFiles` is called with the returned paths.

## Acceptance criteria

- Sweep calls `db.getExpiredFilesPaths()` before `db.deleteExpiredPages()`.
- Sweep calls `storage.deleteFiles()` with the collected paths when there are expired files.
- If `storage.deleteFiles()` fails (logged, not thrown), the sweep still proceeds to delete expired pages.
- `metrics.filesOrphaned` counter is incremented when a storage batch delete fails.
- Sweep logs the count of deleted file blobs at `debug` level.
- Existing sweep behavior (deleting expired pages, counting abandoned pages) is preserved.
- All tests pass.

## Dependencies

- Task 01 (`db.getExpiredFilesPaths`)
- Task 02 (`storage.deleteFiles`)

## Relevant spec sections

- Section 9 (Cleanup logic) — 9.1 updated sweep, 9.3 orphan protection, 9.4 ordering guarantee
- Appendix B (Metrics additions) — `pagent.files.orphaned`
