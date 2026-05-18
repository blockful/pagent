# 03 -- API Handler: Agent Submission Branch

## Description

Update the `submitResultHandler` in `apps/api/app.ts` to branch on the parsed body shape. When `source === "agent"`, run server-side validation against the page spec and store the agent result. Browser submissions remain unchanged.

## Files to create/modify

- **Modify** `apps/api/app.ts` -- update `submitResultHandler` to detect agent submissions, import validation module, add server-side validation, add `validation_failed` error response
- **Modify** `apps/api/app.test.ts` -- add integration tests for agent submission path

## Acceptance criteria

- After Zod parsing with the updated `resultBodySchema`, the handler checks `parsed.source === "agent"` to branch.
- Agent branch:
  1. Fetches the page and verifies `format === "a2ui"` (returns 400 `invalid_for_format` for HTML pages).
  2. Verifies `state === "open"` (returns 409 `conflict` if already submitted).
  3. Calls `extractComponentMap` + `validateAgentData` from the validation module.
  4. On validation failure: returns 400 with `{ error: "validation_failed", message, fields: FieldError[] }`.
  5. On success: stores result as `{ source: "agent", data, file_refs?, submitted_at }` and transitions state to `submitted`.
- Browser branch: existing behavior, no changes.
- Response codes match the spec table: 200 success, 400 bad_request / validation_failed / invalid_for_format, 404 not_found, 409 conflict.
- Integration tests cover: successful agent submit, validation failure response, HTML page rejection, already-submitted conflict, browser submit still works.

## Dependencies

- 01 (validation module -- imports `extractComponentMap`, `validateAgentData`)
- 02 (schema update -- uses the union `resultBodySchema`)

## Relevant spec sections

- Section 2: API Endpoint Changes (`POST /:id/result` -- dual-format)
- Section 2: Server-side validation (agent submissions)
- Section 2: Response codes table
- Section 2: Validation error response shape
- Section 10: Backward Compatibility (browser submissions unchanged)
