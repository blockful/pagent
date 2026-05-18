# 01 -- Database schema and type changes

## Description

Add `webhook_url` and `webhook_secret` columns to the `pages` table and
update all TypeScript types, queries, and data-access functions that
touch page rows. This is the foundation every other webhook task builds on.

## Files to create/modify

- `apps/api/db.ts` -- modify
- `apps/api/db.test.ts` -- modify

## Changes

### `apps/api/db.ts`

1. **`Page` type** -- add `webhookUrl?: string | null` and
   `webhookSecret?: string | null`.

2. **`PageRow` (internal)** -- add matching `webhook_url` and
   `webhook_secret` snake_case fields.

3. **`init()`** -- add two idempotent `ALTER TABLE` migrations after the
   existing `format` migration:

   ```sql
   ALTER TABLE pages ADD COLUMN IF NOT EXISTS webhook_url    text;
   ALTER TABLE pages ADD COLUMN IF NOT EXISTS webhook_secret text;
   ```

   Also add both columns to the `CREATE TABLE IF NOT EXISTS` statement
   for fresh deployments.

4. **`insertPage()`** -- write `webhook_url` and `webhook_secret` when
   present; store `NULL` when absent.

5. **`getActivePage()`** -- select `webhook_url` and `webhook_secret` so
   downstream handlers can read them without a follow-up query.

6. **`submitPage()`** -- the `SubmitOutcome` `'ok'` variant gains
   `webhookUrl?: string | null` and `webhookSecret?: string | null`.
   The `UPDATE ... RETURNING` clause adds `webhook_url, webhook_secret`
   to the projection.

### `apps/api/db.test.ts`

- Add a test that inserts a page with both webhook fields, then reads it
  back via `getActivePage` and asserts the fields round-trip correctly.
- Add a test that inserts a page without webhook fields and asserts both
  fields are `null`.
- Add a test that `submitPage` returns the webhook fields in the `'ok'`
  outcome.

## Acceptance criteria

- [ ] `CREATE TABLE` includes `webhook_url text` and `webhook_secret text`
      as nullable columns.
- [ ] `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` runs on boot for both
      columns (idempotent migration pattern matches the `format` column).
- [ ] `Page` type has `webhookUrl?: string | null` and
      `webhookSecret?: string | null`.
- [ ] `insertPage` persists both fields (or NULL when omitted).
- [ ] `getActivePage` returns both fields.
- [ ] `submitPage` `'ok'` outcome includes `webhookUrl` and
      `webhookSecret`.
- [ ] Existing db tests remain green (no regressions).
- [ ] New db tests pass.

## Dependencies

None -- this is the first task.

## Relevant spec sections

- Section 2: Database schema changes
- Section 2: TypeScript type changes
- Section 2: Data access changes
- Section 2: Security: secret storage
