# 03 — Store layer slug support and custom URL building

## Description

Update `store.createPage()` and `store.createHtmlPage()` to accept an optional slug and owner ID, enforce slug-requires-auth, catch unique-constraint violations as `SlugConflictError`, and build the custom URL (`/:handle/:slug`) when both handle and slug are present.

## Files to create/modify

- `apps/api/store.ts` — add `SlugConflictError` class; update `createPage(spec, format, cfg)` signature to accept optional `{ slug?: string; ownerId?: string; ownerHandle?: string }` options; reject slug without ownerId; pass slug + owner_id to `db.insertPage()`; catch Postgres error code `23505` on the `pages_owner_slug_unique` index and throw `SlugConflictError`; build URL as `${publicUrl}/${ownerHandle}/${slug}` when both present, else fall back to `${publicUrl}/${id}`
- `apps/api/app.ts` — update `newPageHandler` to extract `slug` from the parsed body and forward it to `store.createPage()` along with the authenticated user's `ownerId` and `ownerHandle`; map `SlugConflictError` to `409 { "error": "slug_conflict", "slug": "...", "message": "..." }`
- `apps/api/db.ts` — update `insertPage()` to write `slug` and `owner_id` columns when provided
- `apps/api/app.test.ts` — add tests: page created with slug returns custom URL; page created without slug returns hex URL; slug without auth rejected; duplicate slug returns 409

## Acceptance criteria

- `POST /new { spec, slug: "my-form" }` from authenticated user with handle `alex` returns `url: "https://pagent.link/alex/my-form"`
- `POST /new { spec }` (no slug) returns hex-ID URL as before
- `POST /new { spec, slug: "x" }` without authentication returns an error (slug requires auth)
- Duplicate slug for same owner returns `409 { "error": "slug_conflict", ... }`
- `SlugConflictError` is exported for use by MCP layer
- `createHtmlPage()` also accepts and forwards slug
- Existing tests for `POST /new` without slug still pass

## Dependencies

- 01 (schemas, migration, `slugSchema` in `newPageBodySchema`)
- 02 (handle registration -- need user with handle for integration tests)

## Relevant spec sections

- 4.1 How slugs flow through the system
- 4.3 Uniqueness enforcement
- 4.4 Slug lifecycle and expired pages
- 4.5 Slugs without Auth
- 7.5 Response URL format
