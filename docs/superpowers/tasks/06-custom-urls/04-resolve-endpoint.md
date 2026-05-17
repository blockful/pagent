# 04 — Resolution endpoint (`GET /resolve/:handle/:slug`)

## Description

Add the API endpoint that resolves a `(handle, slug)` pair to a page ID, enabling the web renderer to look up pages by their custom URL.

## Files to create/modify

- `apps/api/db.ts` — add `resolveHandleSlug(handle: string, slug: string): Promise<{ id: string; format: PageFormat; state: PageState; expiresAt: number } | null>` that joins `pages` on `users` (`u.handle = $handle AND p.slug = $slug AND p.expires_at > now()`)
- `apps/api/app.ts` — add `GET /resolve/:handle/:slug` route and `resolveHandleSlugHandler`; register it BEFORE `/:id` catch-all; handler validates params against `handleSchema`/`slugSchema`, calls `db.resolveHandleSlug()`, returns `200 { id, format, state, expires_at }` or `404 { error: "not_found" }`
- `apps/api/app.test.ts` — add tests: resolve existing active page (200), resolve non-existent handle (404), resolve non-existent slug (404), resolve expired page (404), invalid handle format (400)

## Acceptance criteria

- `GET /resolve/alex/quarterly-review` returns `200 { "id": "<hex>", ... }` when page exists and is not expired
- `GET /resolve/alex/no-such-slug` returns `404`
- `GET /resolve/nobody/anything` returns `404` (unknown handle)
- Expired pages return `404` (query filters on `expires_at > now()`)
- Route is registered before `/:id` in app.ts -- no ambiguity with hex page IDs
- Shares the same rate limiter as `GET /:id` (read-only, generous)
- Handler validates handle/slug format and returns `400` for obviously invalid params
- Integration tests cover all response codes

## Dependencies

- 01 (schemas -- `handleSchema`, `slugSchema`)
- 03 (store -- pages must be insertable with slug + owner_id for test setup)

## Relevant spec sections

- 5.1 Routing logic and precedence
- 5.2 API resolution endpoint
- 5.3 Redirect behavior
- 5.4 API route registration
- 8.4 Route matching order (API)
