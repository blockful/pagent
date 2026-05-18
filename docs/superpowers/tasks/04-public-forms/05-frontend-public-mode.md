# 05 — Frontend: public-mode submit, form reset, confirmation toast, and closed state

## Description

Update the web frontend to handle public-mode pages: submit without locking, reset the form after each submission, show a confirmation toast, render the closed-state tombstone, and handle the 409/403 error responses. Store `mode` from the API response and branch behavior accordingly.

## Files to create/modify

- `apps/web/main.ts` — add `mode` property to `AgentUIApp` (type `'single' | 'public'`, populated from `GET /:id` response). In the action handler: if `mode === 'public'`, POST result, show confirmation toast, call `resetForm()`, do NOT set `this.awaiting = true`, do NOT poll for `received`. Handle 409 (closed) by setting `status = 'closed'`. Handle 403 (access_denied) by showing an error. Add `resetForm()` method that clears all surfaces and re-processes `this.originalSpec`. Store `originalSpec` during `loadPage`. Add `showConfirmation()` method for the transient toast (4s, top-center, fades). Add closed-state rendering: when `state === 'closed'`, show the tombstone banner with the form dimmed behind it. Add `PageResponse.mode` and `PageResponse.access_emails` to the type.
- `apps/web/main.ts` (CSS section) — add styles for `.submit-confirmation` (toast), `.closed-banner` (tombstone), `.form-dimmed` (overlay for closed state).

## Acceptance criteria

- Public page: submitting shows a "Response submitted" toast for 4 seconds, then the form resets to its initial state. The user can submit again.
- Public page: the page does NOT show the "awaiting" spinner or poll for `received` after submit.
- Public page: submitting to a closed page (409 response) transitions the UI to the closed state.
- Public page: submitting with an unauthorized email (403 response) shows an access-denied error.
- Closed state: a banner reading "This form is no longer accepting responses." is displayed with a block icon. The form spec is visible but dimmed behind an overlay.
- Single-mode pages: behavior is completely unchanged.
- The confirmation toast is accessible (`role="status"`, `aria-live="polite"`).
- `originalSpec` is preserved during `loadPage` for reset.
- `resetForm()` clears surfaces and re-processes the spec through `MessageProcessor`.

## Dependencies

- 03-api-endpoints (for the new response fields and error codes)

## Relevant spec sections

- Frontend changes > Page loading (`loadPage`)
- Frontend changes > Submit handler (public mode)
- Frontend changes > Closed state rendering
- Frontend changes > Confirmation toast
- Frontend changes > Form reset
- Frontend changes > Access-restricted pages
