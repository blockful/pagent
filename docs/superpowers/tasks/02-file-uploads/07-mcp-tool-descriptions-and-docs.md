# 07 — MCP tool descriptions & OpenAPI docs

## Description

Update the MCP tool description strings so agents know `FileInput` exists, and update the OpenAPI spec to document the new `POST /:id/files` endpoint and the updated schemas for `POST /:id/result` and `GET /:id/result`.

## Files to create/modify

- `apps/api/mcp/tools.ts` — update `SHOW_UI_DESCRIPTION` and/or `SHOW_UI_INPUT_DESCRIPTION` strings to mention the `FileInput` component type with an inline example: `{ id: "upload", component: "FileInput", accept: ".pdf,.png", maxSizeMB: 5, required: true, label: "Upload file" }`.
- `apps/api/mcp/tools.test.ts` — verify the updated description strings contain "FileInput".
- `docs/openapi.yaml` — add:
  - `POST /{id}/files` endpoint with multipart request body schema, 201 response schema, and all error responses (400, 404, 409, 413, 429, 500).
  - Updated `POST /{id}/result` request body to document multipart alternative and `__file_id` context references.
  - Updated `GET /{id}/result` 200 response to show hydrated file metadata shape (`file_id`, `original_name`, `mime_type`, `size_bytes`, `download_url`).
  - `FileUploadResponse` schema component.
  - `FileMetadata` schema component (for hydrated result).

## Acceptance criteria

- `SHOW_UI_DESCRIPTION` or `SHOW_UI_INPUT_DESCRIPTION` mentions `FileInput` with props: `accept`, `maxSizeMB`, `required`, `label`.
- An agent reading the tool description can understand how to add a file upload field to a spec.
- `docs/openapi.yaml` documents `POST /{id}/files` with correct request/response shapes.
- `docs/openapi.yaml` documents the updated result endpoints with file metadata.
- The OpenAPI spec validates (no YAML/schema errors).
- MCP tool description tests pass.

## Dependencies

- Task 03 (upload endpoint exists — descriptions should match its actual behavior)
- Task 04 (result endpoint updates exist — OpenAPI should match)

## Relevant spec sections

- Section 7 (MCP tool changes) — 7.1 show_ui (no changes), 7.3 tool description updates, 7.4 check_result (no changes)
- Section 3 (API endpoints) — all subsections for OpenAPI documentation
- Appendix A (Migration checklist) — items 12, 15
