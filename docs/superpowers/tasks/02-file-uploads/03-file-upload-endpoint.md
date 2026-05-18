# 03 — POST /:id/files upload endpoint & validation

## Description

Add the `POST /:id/files` multipart endpoint that accepts a file upload for a specific page and field. This includes the spec-walker (`findFileComponent`), MIME type detection via `file-type`, filename sanitization, and all validation logic from the spec.

## Files to create/modify

- `apps/api/app.ts` — register `POST /:id/files` route with `bodyLimit({ maxSize: 11 * 1024 * 1024 })`. Handler (`uploadFileHandler`) implements the full validation sequence: parse page ID, verify format is `a2ui`, verify state is `open`, parse multipart body (`c.req.parseBody()`), look up `field_name` in spec, verify component is `FileInput`, check no existing file for `(page_id, field_name)`, validate file size against `maxSizeMB`, detect and validate MIME type, sanitize filename, upload to storage, insert `files` row, return 201 with file metadata.
- `apps/api/file-validation.ts` — new file. Export:
  - `findFileComponent(spec: unknown, fieldName: string): FileInputComponent | null` — walks A2UI spec `updateComponents` messages to find a `FileInput` component by id.
  - `detectMimeType(buffer: Buffer): Promise<string>` — uses `fileTypeFromBuffer` from `file-type` package, falls back to `application/octet-stream`.
  - `matchesAcceptFilter(detectedMime: string, accept: string): boolean` — checks against comma-separated accept list (exact MIME, wildcard MIME like `image/*`, extensions like `.pdf`).
  - `sanitizeFilename(name: string): string` — strips `/`, `\`, null bytes, caps at 255 chars.
  - `FileInputComponent` type export.
- `apps/api/file-validation.test.ts` — tests for all exported functions: `findFileComponent` finds the right component and returns null for missing/wrong type; `detectMimeType` detects PDF, PNG, falls back to octet-stream; `matchesAcceptFilter` handles exact, wildcard, and extension matching; `sanitizeFilename` strips dangerous chars and truncates.
- `apps/api/app.test.ts` — integration tests for `POST /:id/files`: successful upload returns 201 with correct shape, 400 for missing field_name, 400 for non-FileInput field, 400 for html-format pages, 400 for file too large, 400 for invalid MIME type, 400 for duplicate upload, 404 for missing page, 409 for already-submitted page, 413 for oversized body.
- `apps/api/metrics.ts` — add `filesUploaded` counter (`pagent.files.uploaded`) and `fileUploadSize` histogram (`pagent.files.upload.size`, unit: bytes).

## Acceptance criteria

- `POST /:id/files` accepts `multipart/form-data` with `field_name` (text) and `file` (binary) parts.
- Returns 201 with `{ file_id, field_name, original_name, mime_type, size_bytes }` on success.
- Returns 400 `bad_request` when `field_name` or `file` part is missing.
- Returns 400 `invalid_field_type` when the field exists but is not `type: "FileInput"`.
- Returns 400 `invalid_for_format` when page format is `html`.
- Returns 400 `file_too_large` when file exceeds field's `maxSizeMB` (or global default 10 MB).
- Returns 400 `invalid_mime_type` when detected MIME does not match field's `accept` filter.
- Returns 400 `file_already_uploaded` when a file already exists for `(page_id, field_name)`.
- Returns 404 `not_found` for missing or expired pages.
- Returns 409 `conflict` when page state is not `open`.
- Storage path follows `{page_id}/{field_name}/{uuid}.{ext}` convention.
- MIME type is detected from file content (magic numbers), not trusted from the upload header.
- `filesUploaded` counter is incremented on successful upload.
- `fileUploadSize` histogram records the file size in bytes.
- Original filename is sanitized before storage in the `files` table.
- All tests pass.

## Dependencies

- Task 01 (database `files` table, `insertFile`, `getFilesByPageId`, env vars)
- Task 02 (`storage.uploadFile`)

## Relevant spec sections

- Section 3.1 (POST /:id/files) — full endpoint spec including validation sequence
- Section 5 (A2UI spec extension) — 5.1 FileInputComponent type, 5.3 validation/spec walker
- Section 8 (File validation) — 8.1 MIME checking, 8.2 size limits, 8.4 filename sanitization
- Section 11.4 (Hono multipart parsing)
- Appendix B (Metrics additions)
