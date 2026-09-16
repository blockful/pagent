# 01 — Environment variables & database schema

> Status: implemented. This checklist is retained as an as-built contract and
> has been reconciled with the current runtime.

## Description

Extend the env schema with all auth-related variables and add the six new auth tables (`users`, `sessions`, `oauth_clients`, `auth_codes`, `refresh_tokens`, `magic_links`) plus the `owner_id` column on `pages` to the database bootstrap in `db.ts`.

## As-built files

- `apps/api/schemas.ts` — validates the auth, lifetime, SMTP, public-origin,
  CORS, and trusted Railway ingress settings. Crypto/SMTP variables are
  required when `REQUIRE_AUTH=true`; production origins and
  `TRUSTED_PROXY_MODE=railway` are always required in production.
- `apps/api/schemas.env.test.ts` — tests the environment contract and safe
  production boolean parsing.
- `apps/api/db/connection.ts` — idempotently creates `users`, `sessions`,
  `oauth_clients`, `auth_codes`, `refresh_tokens`, and `magic_links`, including
  Google subject binding, per-grant refresh-family IDs, stored magic-link
  authorize context, and the nullable `pages.owner_id` migration.
- `apps/api/db*.test.ts` and real-PostgreSQL E2E tests — verify schema and
  concurrency/security invariants.
- `apps/api/.env.example` — document the new env vars.

## Acceptance criteria

- `envSchema` parses successfully with `REQUIRE_AUTH=false` and no auth vars present.
- `envSchema` fails with a clear error when `REQUIRE_AUTH=true` but `JWT_SIGNING_KEY` is missing.
- All six tables are created idempotently on `db.init()` — running init twice does not error.
- `pages` table has a nullable `owner_id` FK referencing `users(id)` with `ON DELETE SET NULL`.
- `users` table has unique indexes on `lower(email)` and `lower(handle)`.
- Google identities have a unique non-null `google_sub` binding.
- Authorization codes and refresh tokens persist per-grant family IDs.
- The additive family-ID migration installs defaults before backfill and
  serializes the backfill/`NOT NULL` transition; legacy auth codes are consumed
  and legacy refresh rows are revoked so clients reauthenticate safely.
- Magic links persist their authorize context as JSONB.
- `sessions`, `auth_codes`, `refresh_tokens`, `magic_links` have `expires_at` indexes.
- The server's periodic retention sweep deletes expired sessions, auth codes,
  magic links, and refresh tokens; authorization reads independently enforce
  expiry.
- Existing tests continue to pass (no regressions).

## Dependencies

None — this is the foundation task.

## Relevant spec sections

- Section 2 (Database schema) — all subsections 2.1 through 2.7
- Section 9 (Environment variables) — full table and schema validation
