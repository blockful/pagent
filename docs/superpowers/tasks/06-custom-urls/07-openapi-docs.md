# 07 — OpenAPI spec updates

## Description

Document the new `GET /resolve/:handle/:slug` and `PUT /me/handle` endpoints in the OpenAPI spec, and update the `POST /new` schema to include the optional `slug` field.

## Files to create/modify

- `docs/openapi.yaml` — add path `/resolve/{handle}/{slug}` with GET operation (200 with `{ id, format, state, expires_at }`, 404); add path `/me/handle` with PUT operation (200, 400, 409, 422); update `POST /new` request body to include optional `slug` field on both `a2ui` and `html` branches; add `HandleSchema` and `SlugSchema` component schemas

## Acceptance criteria

- `GET /resolve/{handle}/{slug}` fully documented with path parameters, response schemas for 200 and 404
- `PUT /me/handle` documented with request body schema, response schemas for 200, 400, 409, 422
- `POST /new` request body schemas updated with optional `slug` on both format branches
- `HandleSchema` and `SlugSchema` defined as reusable components with pattern and length constraints
- API docs page (`/docs`) renders the new endpoints correctly
- YAML is valid and parseable (no syntax errors)

## Dependencies

- 02 (handle registration endpoint exists)
- 04 (resolve endpoint exists)

## Relevant spec sections

- 3.1 Onboarding flow (PUT /me/handle response table)
- 5.2 API resolution endpoint (GET /resolve/:handle/:slug response table)
- 7.8 REST `POST /new` body schema update
- Appendix A: Full file change inventory (docs/openapi.yaml row)
