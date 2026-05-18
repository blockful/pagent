# 07 — Backward compatibility verification and OpenAPI spec update

## Description

Verify that all existing single-mode flows remain unchanged end-to-end, add the `mode` field to single-mode responses for forward compatibility, and update the OpenAPI document to cover the new endpoints, parameters, and response shapes.

## Files to create/modify

- `docs/openapi.yaml` — add `mode` and `access_emails` parameters to `POST /new` request schema. Add `POST /:id/close` endpoint. Update `POST /:id/result` response to include `submission_id` for public mode and new error codes (409 closed, 403 access_denied). Update `GET /:id/result` response with the public-mode shape (submissions array, total, cursor). Update `GET /:id` response with `mode` and `access_emails`. Add the `closed` value to state enums.
- `apps/api/app.ts` — ensure `GET /:id/result` for single-mode includes `mode: "single"` in the response for forward compatibility.
- `apps/api/mcp/tools.ts` — ensure `CheckResultOutcome` single-mode variant includes `mode: 'single'` so agents can discriminate.
- `apps/api/app.test.ts` — add an explicit backward-compatibility test suite: create a single-mode page with no `mode` param, submit, read result, verify exact response shapes match pre-public-forms behavior. Verify `mode: "single"` is present in responses.
- `apps/mcp/server.test.ts` — verify stdio MCP `show_ui` with no `mode` param works identically to current behavior.

## Acceptance criteria

- `POST /new` with no `mode` parameter creates a single-mode page (default `"single"`).
- `POST /:id/result` on a single-mode page returns `{ ok: true }` (no `submission_id`).
- `GET /:id/result` on a single-mode page returns `{ state, result, format, mode: "single" }`.
- The `submitted -> received` atomic flip is preserved for single-mode pages.
- `GET /:id` returns `mode: "single"` for pages created without a mode parameter.
- `check_result` MCP tool for single-mode pages returns the same text and structuredContent shape as before, plus `mode: "single"`.
- `docs/openapi.yaml` documents all new and modified endpoints, parameters, request/response schemas, and error codes.
- The OpenAPI spec renders correctly at `/docs` (Scalar API reference).

## Dependencies

- 03-api-endpoints
- 04-mcp-tools
- 05-frontend-public-mode
- 06-metrics-and-ttl

## Relevant spec sections

- Backward compatibility (entire section)
- API endpoints (all modified response shapes)
- MCP tool changes > `check_result` shape discrimination
- Migration strategy
