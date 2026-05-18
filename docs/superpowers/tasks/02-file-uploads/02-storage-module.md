# 02 — Supabase Storage module

## Description

Create `apps/api/storage.ts` — the Supabase Storage client wrapper providing `uploadFile`, `createSignedUrl`, and `deleteFiles` functions. This module centralizes all interactions with the `page-files` bucket.

## Files to create/modify

- `apps/api/storage.ts` — new file. Initialize a Supabase client using `env.SUPABASE_URL` and `env.SUPABASE_SERVICE_ROLE_KEY`. Export three functions:
  - `uploadFile(storagePath: string, fileBuffer: Buffer, mimeType: string): Promise<void>` — uploads to `page-files` bucket with `upsert: false`.
  - `createSignedUrl(storagePath: string, expirySeconds: number): Promise<string>` — returns a signed URL from `page-files` bucket.
  - `deleteFiles(paths: string[]): Promise<void>` — batch-deletes from `page-files` bucket in chunks of 1000. Logs but does not throw on batch failure (orphan tolerance).
- `apps/api/storage.test.ts` — unit tests that mock `@supabase/supabase-js` and verify: upload passes correct params, signed URL returns the URL, deleteFiles batches correctly for >1000 paths, deleteFiles logs errors without throwing.

## Acceptance criteria

- `storage.ts` exports `uploadFile`, `createSignedUrl`, `deleteFiles`.
- `uploadFile` calls `supabase.storage.from('page-files').upload()` with `contentType` and `upsert: false`.
- `uploadFile` throws on storage errors.
- `createSignedUrl` calls `supabase.storage.from('page-files').createSignedUrl()` and returns `data.signedUrl`.
- `createSignedUrl` throws on storage errors.
- `deleteFiles` processes paths in batches of 1000.
- `deleteFiles` logs errors via `logger` or `console.error` but does not throw, to avoid breaking the TTL sweep.
- The Supabase client is initialized lazily or at import time from env vars.
- All tests pass.

## Dependencies

- Task 01 (env vars for `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; `@supabase/supabase-js` installed)

## Relevant spec sections

- Section 4 (Supabase Storage integration) — 4.1 bucket config, 4.3 signed URLs, 4.4 upload, 4.5 bulk deletion
- Section 9.2 (Storage deletion helper)
