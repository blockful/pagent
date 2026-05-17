# 07 -- Auth and Access Control Integration

## Description

Integrate OAuth token-based identity into agent submissions. The server extracts the submitter's email from the Bearer token, populates `submitted_by` on the stored result, and enforces access control on private pages.

## Files to create/modify

- **Modify** `apps/api/app.ts` -- in the agent submission branch: extract `email` from the Bearer token, set `submitted_by` on stored result, enforce `access_emails` allowlist for private pages, return 401 for anonymous submissions to private pages, return 403 for email not in allowlist
- **Modify** `apps/mcp/server.ts` -- include OAuth Bearer token in `Authorization` header on `POST /:id/result` and `POST /:id/files` requests
- **Modify** `apps/api/app.test.ts` -- add auth and access control test cases

## Acceptance criteria

- Server extracts `email` claim from the `Authorization: Bearer <token>` header on agent submissions.
- Stored agent result includes `submitted_by: "<email>"` (or `null` if no token).
- Private page access control:
  - If `page.access_emails` is non-null and non-empty:
    - Token email in list: allow submission.
    - Token email not in list: return 403 `access_denied` with message including the email.
    - No token: return 401 `unauthorized`.
  - If `page.access_emails` is null (public page): allow without access check.
- Public mode pages (`mode: "public"`) skip email allowlist checks entirely.
- Stdio adapter sends OAuth token on both `POST /:id/files` and `POST /:id/result`.
- `check_result` returns `submitted_by` in the result for agent submissions.
- Tests cover: successful submit with token, `submitted_by` populated in stored result, private page allowed email, private page denied email (403), private page no token (401), public page no token (allowed).

## Dependencies

- 03 (API handler -- agent submission branch must exist)
- 05 (adapters -- stdio adapter must exist to add auth headers)
- External: OAuth token infrastructure must exist (auth feature from the v2 batch)

## Relevant spec sections

- Section 6: Auth and Access Control (full section)
- Section 2: `submitted_by` field in agent submission payload
- Section 7: Error catalog (`access_denied`, `unauthorized`)
- Section 11: Phase 3 (Auth integration)
