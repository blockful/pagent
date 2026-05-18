# 02 — DB functions: insertSubmission, getSubmissions, closePage, and submitPage branching

## Description

Implement the new database functions (`insertSubmission`, `getSubmissions`, `closePage`) and modify `submitPage`, `insertPage`, and `fetchAndAdvanceResult` to branch on page mode. This is the core data layer that all API and MCP changes build on.

## Files to create/modify

- `apps/api/db.ts` — add `insertSubmission()`, `getSubmissions()`, `closePage()`. Modify `insertPage()` to accept and persist `mode`, `accessEmails`, `ownerId`, `maxSubmissions`. Modify `submitPage()` to branch on `mode`: public mode inserts a submission row without changing page state; single mode also inserts a submission row for consistency. Extend `SubmitOutcome` with `'closed'` kind and optional `submissionId`. Modify `fetchAndAdvanceResult()` to skip state advancement for public pages.
- `apps/api/db.test.ts` — add tests for `insertSubmission`, `getSubmissions` (including cursor pagination), `closePage` (success, not_found, not_owner, already_closed, wrong_mode), and the public-mode branch of `submitPage`.

## Acceptance criteria

- `insertSubmission(pageId, result, submittedBy)` inserts a row and returns `{ id, submittedAt }`.
- `getSubmissions(pageId, { limit, cursor? })` returns `{ submissions: Submission[], total: number }` with cursor-based pagination on `submitted_at`. Default limit 50, max 200. Returns submissions ordered oldest-to-newest.
- `closePage(pageId, callerId)` returns `{ kind: 'ok', closedAt }` on success, or `{ kind: 'not_found' | 'not_owner' | 'already_closed' | 'wrong_mode' }` on failure. Sets `pages.state = 'closed'` and `pages.closed_at = now()`.
- `submitPage()` for `mode = 'public'`: inserts a submission, does NOT change `pages.state`, does NOT set `pages.result`, returns `{ kind: 'ok', createdAt, submissionId }`. Returns `{ kind: 'closed' }` if page state is `'closed'`.
- `submitPage()` for `mode = 'single'`: existing behavior preserved, plus a `submissions` row is inserted alongside `pages.result`.
- `insertPage()` persists `mode`, `access_emails`, `owner_id`, `max_submissions`.
- `fetchAndAdvanceResult()` for public pages does NOT flip state from `submitted` to `received`.
- `SubmitOutcome` type includes `| { kind: 'closed' }` variant.

## Dependencies

- 01-schema-migration

## Relevant spec sections

- DB layer changes > New functions (`insertSubmission`, `getSubmissions`, `closePage`)
- DB layer changes > Modified functions (`submitPage`, `insertPage`, `fetchAndAdvanceResult`)
- DB layer changes > `SubmitOutcome` — extended
- State machines > Public mode
- Pagination > Strategy and SQL query
