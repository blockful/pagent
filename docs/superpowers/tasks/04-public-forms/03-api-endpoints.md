# 03 — API endpoints: POST /new, POST /:id/result, GET /:id/result, POST /:id/close, GET /:id

## Description

Update the REST API handlers to support public mode: extend `POST /new` with `mode` and `access_emails`, branch `POST /:id/result` and `GET /:id/result` by mode, add the new `POST /:id/close` endpoint, and return new fields from `GET /:id`. Add submission rate limiting for public pages.

## Files to create/modify

- `apps/api/schemas.ts` — update `newPageBodySchema` to accept `mode` (enum `['single','public']`, default `'single'`) and `access_emails` (array of emails, optional) on the a2ui branch. Reject `mode: 'public'` on the html branch with a refine. Add `closePageParamsSchema` if needed.
- `apps/api/app.ts` — modify `newPageHandler` to pass `mode`, `accessEmails`, `ownerId` to `store.createPage()`. Select TTL based on mode (`PUBLIC_PAGE_TTL_MS` for public, `PAGE_TTL_MS` for single). Modify `submitResultHandler` to handle the public-mode branch: check for `closed` state (409), check `access_emails` allowlist (403), return `{ ok: true, submission_id }`. Modify `getResultHandler` to return paginated submissions for public pages (accept `limit`, `cursor`, `after` query params). Add `closeHandler` for `POST /:id/close`. Modify `getPageHandler` to return `mode` and `access_emails`. Register the new route.
- `apps/api/store.ts` — update `createPage()` to accept `mode`, `accessEmails`, `ownerId`, `maxSubmissions`. Add `PUBLIC_PAGE_TTL_MS` config. Update `advanceResult()` to return public-mode response shape with submissions array.
- `apps/api/limits.ts` — add submission rate-limit constants: 5 submissions/min/IP/page, 100 submissions/min/page global.
- `apps/api/app.test.ts` — add tests for: creating a public page, submitting to a public page multiple times, submitting to a closed page (409), closing a page, closing by non-owner (403), closing a single-mode page (400), GET /:id/result pagination for public pages, submission rate limiting (429).
- `apps/api/schemas.test.ts` — add tests for the updated `newPageBodySchema` (mode + access_emails validation, html+public rejection).

## Acceptance criteria

- `POST /new` with `{ spec, mode: "public" }` creates a public page with 7-day TTL.
- `POST /new` with `{ format: "html", spec: "...", mode: "public" }` returns 400 `invalid_for_format`.
- `POST /new` stores `owner_id` from the auth header (NULL if unauthenticated).
- `POST /:id/result` on a public page inserts a submission, returns `{ ok: true, submission_id: "<uuid>" }`, and does NOT change page state.
- `POST /:id/result` on a closed public page returns 409 `{ error: "closed" }`.
- `POST /:id/result` on a page with `access_emails` and an unauthorized submitter returns 403 `{ error: "access_denied" }`.
- `POST /:id/result` on public pages is rate-limited at 5/min/IP/page and 100/min/page.
- `GET /:id/result` on a public page returns `{ state, mode: "public", format, submissions: [...], total, cursor }`.
- `GET /:id/result` accepts `limit` (default 50, max 200) and `cursor`/`after` query params.
- `POST /:id/close` transitions a public page to `closed`, returns `{ ok: true, state: "closed", closed_at }`.
- `POST /:id/close` returns 400 for single-mode, 403 for non-owner, 404 for missing, 409 for already closed.
- `GET /:id` returns `mode` and `access_emails` in the response.
- All existing single-mode tests continue to pass.

## Dependencies

- 01-schema-migration
- 02-db-functions

## Relevant spec sections

- API endpoints > `POST /new` — create page (modified)
- API endpoints > `POST /:id/result` — submit (modified)
- API endpoints > `GET /:id/result` — poll for result (modified)
- API endpoints > `POST /:id/close` — close page (new)
- API endpoints > `GET /:id` — get page (modified)
- Access control (email allowlist, close authorization, owner identification)
- Resolved questions > TTL for public pages
- Resolved questions > Submission rate limiting
- Resolved questions > Submission count cap
