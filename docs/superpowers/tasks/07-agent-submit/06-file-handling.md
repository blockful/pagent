# 06 -- File Upload Support in submit_form

## Description

Wire the `files` parameter of `submit_form` to the file upload endpoint. The MCP tool reads files from local disk, uploads them via `POST /:id/files`, and includes the returned file IDs as `file_refs` in the submission payload. The API handler validates that referenced file IDs belong to the page.

## Files to create/modify

- **Modify** `apps/api/mcp/tools.ts` -- remove the "file uploads not yet supported" placeholder; implement file read/upload loop in the `submit_form` handler
- **Modify** `apps/mcp/server.ts` -- add `restOps.uploadFile(page_id, fieldId, file)` to the stdio adapter
- **Modify** `apps/api/mcp/http.ts` -- add `uploadFile` to `buildInProcessOps`
- **Modify** `apps/api/app.ts` -- in the agent submission branch, validate that each `file_refs` value is a known file ID belonging to the page
- **Modify** `apps/api/mcp/tools.test.ts` -- add file handling tests
- **Modify** `apps/api/app.test.ts` -- add file_refs validation tests

## Acceptance criteria

- `PageOps` interface includes `uploadFile(page_id: string, fieldId: string, file: FilePayload): Promise<string>` where `FilePayload = { buffer: Buffer, fileName: string, mimeType: string }`.
- MCP tool handler, when `files` is provided:
  1. For each entry, verifies the local path exists and is a file (throws `"File not found: /path"` if not).
  2. Reads the file into a buffer.
  3. Guesses MIME type from file extension.
  4. Calls `ops.uploadFile` with multipart form data to `POST /:id/files`.
  5. Collects returned `file_id` values into a `file_refs` map.
  6. Includes `file_refs` in the `POST /:id/result` payload.
- Stdio adapter: `uploadFile` sends `POST ${SERVICE_URL}/${page_id}/files` with `multipart/form-data` containing the file blob and `field_name`.
- API handler (server-side): validates each `file_refs[field]` value exists in storage and belongs to the target page. Returns 400 if a file_id is invalid.
- Errors: `"File not found: {path}"` for missing local files, `"File upload failed for field {field}: {reason}"` for server rejection.

## Dependencies

- 04 (PageOps interface -- `uploadFile` extends it)
- 05 (adapters -- adds `uploadFile` to existing adapter implementations)
- External: `POST /:id/files` endpoint must exist (file uploads feature from the v2 batch)

## Relevant spec sections

- Section 5: File Handling (full section)
- Section 1: Input schema (`files` parameter)
- Section 7: Error catalog (`file_not_found`, `file_upload_failed`)
- Section 11: Phase 2 (File handling)
