# 01 — Schema migration: submissions table and pages columns

## Description

Add the `submissions` table and extend the `pages` table with `mode`, `access_emails`, `owner_id`, `closed_at`, and `max_submissions` columns. Update the `state` CHECK constraint to include `'closed'`. All changes are additive with defaults, so existing queries continue to work.

## Files to create/modify

- `apps/api/db.ts` — add `CREATE TABLE submissions` and all `ALTER TABLE pages` statements inside `init()`. Update the `PageState` type to include `'closed'`. Add the `PageMode` type. Extend the `Page` type with `mode`, `accessEmails`, `ownerId`, `closedAt`, `maxSubmissions`. Add the `Submission` type.

## Acceptance criteria

- Running `init()` on a fresh database creates the `submissions` table with columns `id` (uuid PK), `page_id` (text FK → pages), `submitted_by` (uuid nullable FK → users), `result` (jsonb), `submitted_at` (timestamptz).
- The composite index `submissions_page_id_idx` on `(page_id, submitted_at)` exists.
- `submissions.page_id` has `ON DELETE CASCADE`.
- Running `init()` on an existing database adds `mode` (text, default `'single'`, CHECK `('single','public')`), `access_emails` (text[]), `owner_id` (uuid), `closed_at` (timestamptz), and `max_submissions` (integer, default 10000) to `pages` idempotently.
- The `pages` state CHECK constraint allows `'open'`, `'submitted'`, `'received'`, `'closed'`.
- `PageState` type is `'open' | 'submitted' | 'received' | 'closed'`.
- `PageMode` type is `'single' | 'public'`.
- `Page` type includes `mode: PageMode`, `accessEmails: string[] | null`, `ownerId: string | null`, `closedAt: number | null`, `maxSubmissions: number`.
- `Submission` type is exported with fields `id`, `pageId`, `submittedBy`, `result`, `submittedAt`.
- Existing `db.test.ts` tests pass without modification.

## Dependencies

None — this is the foundation for all other tasks.

## Relevant spec sections

- Database schema > New table: `submissions`
- Database schema > Alter table: `pages`
- DB layer changes > New types
