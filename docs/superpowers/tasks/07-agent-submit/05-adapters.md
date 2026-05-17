# 05 -- Stdio and In-Process Adapter Implementations

## Description

Implement the concrete `getPage` and `submitForm` methods in both the stdio REST adapter (`apps/mcp/server.ts`) and the in-process adapter (`apps/api/mcp/http.ts`), wiring the new `PageOps` methods to actual HTTP calls or direct handler invocation.

## Files to create/modify

- **Modify** `apps/mcp/server.ts` -- add `restOps.getPage` and `restOps.submitForm` to the stdio adapter
- **Modify** `apps/api/mcp/http.ts` -- add `getPage` and `submitForm` to `buildInProcessOps`
- **Modify** `apps/mcp/server.test.ts` -- add tests for stdio adapter's new methods
- **Modify** `apps/api/mcp/http.test.ts` -- add tests for in-process adapter's new methods

## Acceptance criteria

- **Stdio adapter** (`restOps` in `apps/mcp/server.ts`):
  - `getPage(page_id)`: `GET ${SERVICE_URL}/${page_id}` with `accept: application/json`. Returns `{ kind: 'not_found' }` on 404, `{ kind: 'ok', spec, format, state }` on 200.
  - `submitForm(page_id, body)`: `POST ${SERVICE_URL}/${page_id}/result` with JSON body. Maps status codes to `SubmitFormResult` kinds (404->not_found, 409->conflict, 403->access_denied, 400->validation_failed or invalid_format, 200->ok).
- **In-process adapter** (`buildInProcessOps` in `apps/api/mcp/http.ts`):
  - `getPage(page_id)`: reads from the page store directly (same store used by `checkResult`). Returns format, spec, and state.
  - `submitForm(page_id, body)`: calls the API handler logic directly (in-process), returning the appropriate result kind.
- Both adapters handle error responses gracefully and map them to `SubmitFormResult` discriminated union.
- Integration tests verify: end-to-end `submit_form` tool call through in-process transport creates a page with `show_ui`, submits with `submit_form`, and reads result with `check_result`. The result contains `source: "agent"` and the submitted data.

## Dependencies

- 03 (API handler -- the endpoint must exist for the stdio adapter to call, and the in-process adapter reuses handler logic)
- 04 (PageOps interface -- defines the methods to implement)

## Relevant spec sections

- Section 9: Stdio adapter code (`restOps.getPage`, `restOps.submitForm`)
- Section 11: Implementation Plan, Phase 1, items 5-6
