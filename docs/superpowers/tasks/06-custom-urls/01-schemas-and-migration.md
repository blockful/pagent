# 01 — Validation schemas, reserved handles, and DB migration

## Description

Add `handleSchema`, `slugSchema`, and `RESERVED_HANDLES` to the API schemas module, then create the database migration that extends the `pages` table with `slug` and `owner_id` columns plus the compound unique index.

## Files to create/modify

- `apps/api/schemas.ts` — add `handleSchema`, `slugSchema`, `RESERVED_HANDLES` set; update `newPageBodySchema` to accept optional `slug` on both union branches
- `apps/api/db.ts` — extend `Page` type with optional `slug: string` and `owner_id: string` fields; add boot migration `ALTER TABLE pages ADD COLUMN IF NOT EXISTS slug text` + `ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE SET NULL`; add `CREATE UNIQUE INDEX IF NOT EXISTS pages_owner_slug_unique ON pages (owner_id, slug) WHERE slug IS NOT NULL`
- `apps/api/schemas.test.ts` — add tests for `handleSchema` (valid, too short, leading/trailing hyphen, consecutive hyphens, 32-char hex rejection, reserved handles) and `slugSchema` (valid, bounds, format); add tests for updated `newPageBodySchema` with and without `slug`

## Acceptance criteria

- `handleSchema` validates: 3-40 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen, `.refine()` rejecting consecutive hyphens
- `slugSchema` validates: 3-64 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen
- `RESERVED_HANDLES` contains at least: `new`, `health`, `docs`, `mcp`, `resolve`, `_components`, `api`, `oauth`, `admin`, `settings`, `login`, `signup`, `logout`
- `newPageBodySchema` accepts optional `slug` on both `a2ui` and `html` branches (existing payloads without `slug` continue to parse)
- `Page` type includes optional `slug` and `owner_id`
- Boot migration in `db.init()` adds both columns and the partial unique index idempotently
- `insertPage()` writes `slug` and `owner_id` when provided
- All new/changed schemas have unit tests
- Existing tests still pass

## Dependencies

None (first task)

## Relevant spec sections

- 2.2 `pages` table (existing -- extended)
- 2.3 Validation constraints (application-level)
- 2.4 Full migration script
- 3.3 Handle validation rules
- 7.8 REST `POST /new` body schema update
- 8.1 Reserved handles
- 8.2 Hex ID disambiguation
