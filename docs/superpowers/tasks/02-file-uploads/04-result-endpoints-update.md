# 04 — Update POST /:id/result and GET /:id/result for file references

## Description

Extend the result submission endpoint to validate `__file_id` references and handle inline multipart file uploads. Extend the result retrieval endpoint to hydrate file references with signed download URLs via a new `hydrateFileUrls` function in `store.ts`.

## Files to create/modify

- `apps/api/app.ts` — update `POST /:id/result` handler:
  - Accept `multipart/form-data` in addition to existing `application/json`. When multipart: extract the `action` text part (JSON-encoded A2UI action) and file binary parts (keyed by field name). For each file part, upload to storage, insert into `files`, then rewrite the action's context to include `{ "__file_id": fileId }`.
  - For JSON submissions: walk `context` and validate each `__file_id` reference — verify the file exists in the `files` table and belongs to this page. Return 400 `invalid_file_reference` if not.
  - For each `FileInput` field with `required: true` in the page spec, verify either an inline file or a valid `__file_id` is present. Return 400 `missing_required_file` if not.
- `apps/api/store.ts` — add `hydrateFileUrls(result: unknown, pageId: string, expiresAt: number): Promise<unknown>` function:
  - Walks the result's `context` object.
  - For each value that is an object with a `__file_id` key, looks up the file via `db.getFileById()`.
  - Generates a signed URL via `storage.createSignedUrl()` with expiry = `max(remainingTtlSeconds, 300)`.
  - Replaces the `__file_id` object with `{ file_id, original_name, mime_type, size_bytes, download_url }`.
  - Call `hydrateFileUrls` in `advanceResult()` (or the GET handler) before returning the result.
- `apps/api/app.ts` — update `GET /:id/result` handler to call `hydrateFileUrls` on the result before responding.
- `apps/api/app.test.ts` — tests for:
  - JSON submission with valid `__file_id` succeeds.
  - JSON submission with invalid/foreign `__file_id` returns 400.
  - Multipart submission with inline file upload succeeds.
  - Submission missing a required file field returns 400 `missing_required_file`.
  - GET result returns hydrated file metadata with `download_url` instead of raw `__file_id`.
  - Signed URL expiry is clamped to floor of 300 seconds.
- `apps/api/store.test.ts` — unit tests for `hydrateFileUrls`: replaces `__file_id` objects, passes through non-file values, handles missing files gracefully.

## Acceptance criteria

- `POST /:id/result` with `Content-Type: application/json` validates `__file_id` references against the `files` table.
- Returns 400 `invalid_file_reference` for `__file_id` values that don't exist or belong to a different page.
- Returns 400 `missing_required_file` when a `required: true` FileInput field has no file.
- `POST /:id/result` with `Content-Type: multipart/form-data` uploads inline files, inserts DB rows, and rewrites context with `__file_id`.
- `GET /:id/result` replaces `__file_id` objects with full file metadata including `download_url`.
- Signed URL expiry = `max(floor((expiresAt - now) / 1000), 300)`.
- Non-file context values pass through unchanged.
- Existing non-file result submissions continue to work without regression.
- All tests pass.

## Dependencies

- Task 01 (database queries: `getFileById`, `getFilesByPageId`, `insertFile`)
- Task 02 (`storage.createSignedUrl`, `storage.uploadFile`)
- Task 03 (`findFileComponent` from `file-validation.ts` — needed to identify required file fields)

## Relevant spec sections

- Section 3.2 (POST /:id/result — updated) — multipart handling, `__file_id` validation, required file checks
- Section 3.3 (GET /:id/result — updated) — `hydrateFileUrls`, signed URL expiry calculation
- Section 4.3 (Signed URLs) — expiry calculation formula
