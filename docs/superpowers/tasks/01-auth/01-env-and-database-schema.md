# 01 — Environment variables & database schema

## Description

Extend the env schema with all auth-related variables and add the six new auth tables (`users`, `sessions`, `oauth_clients`, `auth_codes`, `refresh_tokens`, `magic_links`) plus the `owner_id` column on `pages` to the database bootstrap in `db.ts`.

## Files to create/modify

- `apps/api/schemas.ts` — add `REQUIRE_AUTH`, `JWT_SIGNING_KEY`, `JWT_PUBLIC_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `MAGIC_LINK_SECRET`, `AUTH_STATE_SECRET`, `SESSION_MAX_AGE_DAYS`, `REFRESH_TOKEN_MAX_DAYS`, `ACCESS_TOKEN_TTL_SECONDS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` to `envSchema`. Add `superRefine` requiring crypto/SMTP vars when `REQUIRE_AUTH=true`.
- `apps/api/schemas.test.ts` — tests for the new env vars and `superRefine` logic.
- `apps/api/db.ts` — add `CREATE TABLE IF NOT EXISTS` for `users`, `sessions`, `oauth_clients`, `auth_codes`, `refresh_tokens`, `magic_links` in the `init()` function. Add `ALTER TABLE pages ADD COLUMN IF NOT EXISTS owner_id`. Add indexes from spec section 2.
- `apps/api/db.test.ts` — tests verifying tables are created and `owner_id` column exists on `pages`.
- `apps/api/.env.example` — document the new env vars.

## Acceptance criteria

- `envSchema` parses successfully with `REQUIRE_AUTH=false` and no auth vars present.
- `envSchema` fails with a clear error when `REQUIRE_AUTH=true` but `JWT_SIGNING_KEY` is missing.
- All six tables are created idempotently on `db.init()` — running init twice does not error.
- `pages` table has a nullable `owner_id` FK referencing `users(id)` with `ON DELETE SET NULL`.
- `users` table has unique indexes on `lower(email)` and `lower(handle)`.
- `sessions`, `auth_codes`, `refresh_tokens`, `magic_links` have `expires_at` indexes.
- Existing tests continue to pass (no regressions).

## Dependencies

None — this is the foundation task.

## Relevant spec sections

- Section 2 (Database schema) — all subsections 2.1 through 2.7
- Section 9 (Environment variables) — full table and schema validation
