# 06 — Metrics, TTL configuration, and submission cap enforcement

## Description

Add observability counters/histograms for public-form events, configure the separate TTL for public pages, and enforce the max-submissions cap on submit. These are cross-cutting concerns that wire into the API and DB layers built in tasks 02-03.

## Files to create/modify

- `apps/api/metrics.ts` — add `pagent.submissions.created` counter (labels: `mode`), `pagent.pages.closed` counter, `pagent.public_page.submissions` histogram. Add `mode` label to existing `pagent.pages.created` counter.
- `apps/api/metrics.test.ts` — add tests verifying the new instruments are registered.
- `apps/api/app.ts` — emit `submissions.created` in `submitResultHandler` for both modes. Emit `pages.closed` in `closeHandler`. Pass `mode` label to `pagesCreated` counter in `newPageHandler`.
- `apps/api/schemas.ts` — add `PUBLIC_PAGE_TTL_MS` to the `envSchema` (default `604800000`, 7 days). Export it.
- `apps/api/store.ts` — update `createPage()` to select TTL based on mode. Accept `mode` in `CreatePageConfig` or as a parameter. Record `public_page.submissions` histogram at close time (or let the TTL sweeper do it at expiry).
- `apps/api/db.ts` — in `submitPage()` for public mode, check `SELECT count(*) FROM submissions WHERE page_id = $1` against `pages.max_submissions`. Return a new `{ kind: 'submission_cap_reached' }` outcome when the cap is hit.
- `apps/api/app.ts` — map `submission_cap_reached` to 409 `{ error: "submission_cap_reached" }` in `submitResultHandler`.

## Acceptance criteria

- `pagent.pages.created` counter includes a `mode` label (`"single"` or `"public"`).
- `pagent.submissions.created` counter increments on every submission insert (both modes).
- `pagent.pages.closed` counter increments when `POST /:id/close` succeeds.
- `pagent.public_page.submissions` histogram records the submission count at page close/expiry.
- Public pages default to a 7-day TTL (`PUBLIC_PAGE_TTL_MS` env var, default `604800000`).
- Single pages keep their existing 30-minute TTL.
- `POST /:id/result` returns 409 `{ error: "submission_cap_reached" }` when submission count reaches `pages.max_submissions` (default 10,000).
- `SubmitOutcome` type includes `| { kind: 'submission_cap_reached' }`.
- TTL sweeps on `pages` cascade-delete child `submissions` rows automatically (verified by existing `deleteExpiredPages` behavior + `ON DELETE CASCADE`).

## Dependencies

- 01-schema-migration
- 02-db-functions
- 03-api-endpoints

## Relevant spec sections

- Metrics (all instruments)
- Resolved questions > TTL for public pages
- Resolved questions > Submission count cap
- DB layer changes > `deleteExpiredPages`
