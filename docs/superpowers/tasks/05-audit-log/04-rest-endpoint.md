# 04 -- REST API endpoint (GET /audit)

## Description

Add the `GET /audit` route with query parameter validation, cursor-based
pagination, and access-control enforcement.

## Files to create/modify

- `apps/api/app.ts` -- register `app.get('/audit', auditHandler)` after
  existing routes. Implement `auditHandler`: parse and validate query
  params with the Zod schema, enforce the mandatory filter requirement
  (`resource_id` or `user_id`), call `db.queryAuditLog()`, and return
  the paginated JSON response.
- `apps/api/app.test.ts` -- tests for the `/audit` endpoint.

## Acceptance criteria

- `GET /audit?resource_id=X&resource_type=page` returns matching events
  sorted by `created_at DESC`.
- `GET /audit?user_id=X` returns matching events for that user.
- `GET /audit` with no `resource_id` or `user_id` returns 400 with
  `error: "bad_request"`.
- `limit` query param is validated: integer 1..200, defaults to 50.
- `cursor` is validated: base64 JSON with `created_at` + `id`. Malformed
  cursor returns 400.
- Response shape: `{ events: [...], cursor: string | null, has_more: boolean }`.
- Access control (when auth middleware is present):
  - `user_id` filter only returns results when `user_id === authedUser`.
  - `resource_id` filter checks resource ownership via
    `db.getResourceOwner()`. Returns 403 on mismatch.
  - Unauthenticated requests return 401.
- Tests cover: valid query with each filter, pagination round-trip,
  missing filter 400, invalid cursor 400, limit boundary values.

## Dependencies

- **01** (schema and DB layer) -- `queryAuditLog()` must exist.

## Relevant spec sections

- Section 4 (REST API endpoint) -- query params, response shape,
  pagination, Zod schema, error responses
- Section 7 (Access control) -- ownership checks, 401/403 rules
- Appendix B (OpenAPI addition) -- optional: add to `docs/openapi.yaml`
