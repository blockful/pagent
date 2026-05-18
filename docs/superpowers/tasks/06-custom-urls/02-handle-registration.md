# 02 — Handle registration endpoint

## Description

Implement `PUT /me/handle` so authenticated users can claim a handle, and extend `GET /me` to include the handle in its response. Handles are immutable after creation.

## Files to create/modify

- `apps/api/app.ts` — register `PUT /me/handle` route with handler (`putHandleHandler`); ensure `GET /me` response shape includes `handle`
- `apps/api/db.ts` — add `setUserHandle(userId: string, handle: string): Promise<boolean>` that runs `UPDATE users SET handle = $handle WHERE id = $user_id AND handle IS NULL` and returns false on 0-row-update; add `getUserHandle(userId: string): Promise<string | null>`
- `apps/api/app.test.ts` — add tests for `PUT /me/handle`: success (200), validation failure (400), handle taken (409), already-has-handle (422), 32-char hex rejection (400), reserved handle rejection (400)

## Acceptance criteria

- `PUT /me/handle` with valid handle returns `200 { "handle": "alex" }`
- `PUT /me/handle` with invalid format returns `400 { "error": "bad_request", ... }`
- `PUT /me/handle` when handle is taken returns `409 { "error": "handle_taken", ... }`
- `PUT /me/handle` when user already has a handle returns `422 { "error": "handle_immutable", ... }`
- 32-char hex strings rejected with 400 (collision avoidance)
- Reserved handles (from `RESERVED_HANDLES`) rejected with 400
- `GET /me` includes `handle` field (null when not yet set)
- Route registered before `/:id` catch-all in app.ts
- All new handler logic has integration tests

## Dependencies

- 01 (schemas and migration -- needs `handleSchema`, `RESERVED_HANDLES`)

## Relevant spec sections

- 3.1 Onboarding flow
- 3.2 Settings read endpoint
- 3.3 Handle validation rules
- 3.4 Immutability
- 8.1 Reserved handles
- 8.2 Hex ID disambiguation
- 8.4 Route matching order (API)
