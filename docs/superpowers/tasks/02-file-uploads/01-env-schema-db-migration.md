# 01 — Environment variables, dependencies & database migration

## Description

Add Supabase env vars to the env schema, install `@supabase/supabase-js` and `file-type` npm dependencies, and add the `files` table and index to the database bootstrap in `db.ts`.

## Files to create/modify

- `apps/api/schemas.ts` — add `SUPABASE_URL` (z.string().url(), required), `SUPABASE_SERVICE_ROLE_KEY` (z.string().min(1), required), and `FILE_MAX_SIZE_MB` (z.coerce.number().int().positive().max(50).default(10)) to `envSchema`.
- `apps/api/schemas.test.ts` — tests for new env vars: parsing succeeds with valid values, fails when `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are missing, `FILE_MAX_SIZE_MB` defaults to 10.
- `apps/api/db.ts` — add `FileRow` type export. Add `CREATE TABLE IF NOT EXISTS files` with all columns from the spec (id, page_id, field_name, storage_path, original_name, mime_type, size_bytes, uploaded_by, created_at) and `CREATE INDEX IF NOT EXISTS files_page_id_idx` to the `init()` function, after the `pages` table migration. Add `insertFile()`, `getFilesByPageId()`, `getFileById()`, `getExpiredFilesPaths()` query functions.
- `apps/api/db.test.ts` — tests verifying the `files` table is created idempotently, `insertFile` round-trips correctly, CASCADE delete from `pages` removes `files` rows, `getExpiredFilesPaths` returns paths for expired pages only.
- `package.json` (root or `apps/api`) — install `@supabase/supabase-js@^2.49` and `file-type@^19.6`.
- `apps/api/.env.example` (if it exists) — document `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FILE_MAX_SIZE_MB`.

## Acceptance criteria

- `envSchema` parses successfully with valid `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` values.
- `envSchema` fails with a clear error when `SUPABASE_URL` is missing.
- `FILE_MAX_SIZE_MB` defaults to 10 when omitted, accepts values 1-50, rejects 0 and negatives.
- `files` table is created idempotently on `db.init()` — running init twice does not error.
- `files.page_id` has `ON DELETE CASCADE` referencing `pages(id)`.
- `files_page_id_idx` index exists on `files(page_id)`.
- `FileRow` type is exported from `db.ts`.
- `insertFile`, `getFilesByPageId`, `getFileById`, `getExpiredFilesPaths` are exported and tested.
- `@supabase/supabase-js` and `file-type` are in `dependencies` (not devDependencies).
- Existing tests continue to pass (no regressions).

## Dependencies

None — this is the foundation task.

## Relevant spec sections

- Section 2 (Database schema) — full section including design notes and `db.ts` additions
- Section 10 (Environment variables) — full table and schema additions
- Section 11 (Dependencies) — 11.1 `apps/api` new dependencies
