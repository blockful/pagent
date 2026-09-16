# Pagent v2 Roadmap — Overview & Dependencies

> Master reference for all v2 feature specs. Each feature has its own detailed spec in this directory.

## Features

| # | Feature | Spec file | Lines | Status |
|---|---------|-----------|-------|--------|
| 1 | Auth (Google + Magic Link + MCP OAuth) | `2026-05-17-auth-design.md` | ~1330 | Ready |
| 2 | File Uploads (Supabase Storage) | `2026-05-17-file-uploads-design.md` | ~1050 | Ready |
| 3 | Webhooks on Submit | `2026-05-17-webhooks-design.md` | ~870 | Ready |
| 4 | Public Forms (multi-submission) | `2026-05-17-public-forms-design.md` | ~1035 | Ready |
| 5 | Audit Log | `2026-05-17-audit-log-design.md` | ~980 | Ready |
| 6 | Custom URLs (handle/slug) | `2026-05-17-custom-urls-design.md` | ~980 | Ready |
| 7 | Agent Form Submission (`write` variant) | `2026-05-17-agent-submit-design.md` | ~1400 | Needs alignment |
| 8 | Presentation Page Version History | This overview | — | Planned |

## Presentation Page Version History

Version history is a required roadmap capability for durable presentation
Pages. Updating a presentation must never overwrite its current content in
place. Each update creates a new immutable revision, and earlier revisions stay
available until the Page is deleted under its retention policy.

### Required behavior

- Calling `write` with an existing presentation `page_id` creates a new latest
  revision; it does not mutate or delete an earlier revision.
- Authorized editors can open a version history showing revision number,
  author, creation time, and an optional change summary.
- An authorized editor can preview the exact content of any earlier revision
  without changing the current Page or generating viewer analytics.
- Restoring an earlier version copies that snapshot into a **new** latest
  revision. Restore never rewrites or removes intervening history.
- Analytics and historical visits remain attached to the exact revision the
  viewer saw, including after later edits or restores.
- Active share links follow the latest revision by default. Revision pinning is
  a separate follow-up control and must not block the core history flow.
- Revision creation and restore operations are auditable and follow the same
  content permissions as the presentation Page. Workspace-admin metadata
  access alone does not grant revision-content access.

This capability extends the existing two-tool Page model; it does **not** add a
third MCP tool. Branching, revision merging, and live collaborative editing are
out of scope for the first version-history release.

## Dependency Graph

```
                      ┌──────────┐
                      │   AUTH   │
                      │ (Google  │
                      │  Magic   │
                      │  Link    │
                      │  OAuth)  │
                      └────┬─────┘
           ┌───────┬───────┼───────┬───────────┐
           ▼       ▼       ▼       ▼           ▼
      ┌────────┐ ┌──────┐ ┌─────┐ ┌────────┐ ┌──────────┐
      │CUSTOM  │ │PUBLIC│ │AUDIT│ │WEBHOOKS│ │  FILE    │
      │ URLs   │ │FORMS │ │ LOG │ │        │ │ UPLOADS  │
      └────────┘ └──────┘ └─────┘ └────────┘ └────┬─────┘
                                                   │
                                              ┌────▼─────┐
                                              │  AGENT   │
                                              │  SUBMIT  │
                                              └──────────┘
```

### Hard blockers

| Feature | Blocked by | Why |
|---------|-----------|-----|
| Custom URLs | Auth | Pages need an `owner_id` to have a handle namespace |
| Public Forms | Auth | Need identity for submitters + owner-only close |
| Agent Submit | Auth | Agent identity comes from OAuth tokens |
| Agent Submit | File Uploads | File support in the `write` submission variant depends on `POST /:id/files` |
| Presentation Version History | Auth + durable presentation revisions | History and restore require an attributable editor and immutable snapshots |

### Soft dependencies (enriched by, but works without)

| Feature | Enriched by | What it adds |
|---------|------------|-------------|
| Audit Log | Auth | `user_id` on entries (without auth: null) |
| Webhooks | Auth | `submitted_by` in payload (without auth: null) |
| Webhooks | File Uploads | `files` array in payload (without files: empty) |
| Webhooks | Public Forms | `submission_id` + `mode` in payload |
| Presentation Version History | Audit Log | Records who created or restored each revision |

### Independent pairs (can build in parallel)

- Webhooks ∥ Custom URLs ∥ File Uploads ∥ Audit Log
- Public Forms ∥ Audit Log ∥ Custom URLs
- Presentation Version History ∥ Public Forms ∥ Custom URLs

## Recommended Build Order

### Phase 1: Foundation
**Auth** — everything else depends on user identity.

### Phase 2: Independent features (parallel)
Build these simultaneously after auth lands:
- **File Uploads** — new endpoint, Supabase Storage integration
- **Webhooks** — delivery logic, HMAC signing
- **Audit Log** — append-only event logging

### Phase 3: Identity-dependent features (parallel)
These need auth to be functional:
- **Custom URLs** — handle registration, slug routing
- **Public Forms** — multi-submission mode, access control
- **Presentation Version History** — revision list, preview, and non-destructive restore

### Phase 4: Capstone
**Agent Submit** — combines auth + file uploads as another `write` input variant.

## Unified Schema Changes

All features touch the database. Here is the consolidated migration order:

### Migration 1: Auth tables (Phase 1)
```sql
CREATE TABLE users (...)           -- auth spec
CREATE TABLE sessions (...)        -- auth spec
CREATE TABLE oauth_clients (...)   -- auth spec
CREATE TABLE auth_codes (...)      -- auth spec
CREATE TABLE refresh_tokens (...)  -- auth spec
CREATE TABLE magic_links (...)     -- auth spec
ALTER TABLE pages ADD COLUMN owner_id uuid REFERENCES users(id) ON DELETE SET NULL;
```

### Migration 2: Feature tables (Phase 2-3)
```sql
CREATE TABLE files (...)           -- file uploads spec
CREATE TABLE submissions (...)     -- public forms spec
CREATE TABLE audit_log (...)       -- audit log spec
ALTER TABLE pages ADD COLUMN webhook_url text;
ALTER TABLE pages ADD COLUMN webhook_secret text;
ALTER TABLE pages ADD COLUMN mode text NOT NULL DEFAULT 'single' CHECK (mode IN ('single', 'public'));
ALTER TABLE pages ADD COLUMN slug text;
ALTER TABLE pages ADD COLUMN access_emails text[];
ALTER TABLE pages ADD COLUMN closed_at timestamptz;
-- Update state CHECK to include 'closed'
```

### Indexes
```sql
CREATE INDEX pages_owner_id_idx ON pages (owner_id);
CREATE UNIQUE INDEX pages_owner_slug_idx ON pages (owner_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX files_page_id_idx ON files (page_id);
CREATE INDEX submissions_page_id_idx ON submissions (page_id);
CREATE INDEX audit_log_resource_idx ON audit_log (resource_type, resource_id, created_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, created_at DESC);
```

## Unified MCP Tool Interface

Pagent keeps exactly two MCP tools: `write` and `read`. Roadmap features extend
their discriminated inputs and outputs or use the authenticated web/REST
management surfaces; they do not add top-level MCP tools.

### `write` (extended)
```typescript
type WriteInput =
  | { type: 'interactive'; spec: unknown[]; mode?: 'single' | 'public' }
  | { type: 'document'; html: string }
  | {
      type: 'presentation';
      page_id?: string;
      title: string;
      slides: unknown[];
      restore_revision_id?: string;
    }
  | {
      type: 'submission';
      page_id: string;
      data: Record<string, unknown>;
      files?: Record<string, string>;
    };
```

Custom URLs, access rules, limits, and webhook settings remain authenticated
Page-management concerns unless an agent-authored Page needs them at creation.
Updating a presentation with `page_id` creates a revision; restoring uses the
same presentation variant and creates a new head revision.

### `read` (extended)

```typescript
type ReadInput = {
  page_id: string;
  include?: 'response' | 'analytics' | 'versions' | 'audit';
  revision_id?: string;
  cursor?: string;
  limit?: number;
};
```

`read` returns the requested Page response, presentation analytics, immutable
version metadata/content, or authorized audit records. Default selection stays
type-aware so ordinary calls need only `page_id`.

## New Environment Variables

| Variable | Feature | Required | Default |
|----------|---------|----------|---------|
| `GOOGLE_CLIENT_ID` | Auth | No (optional provider) | — |
| `GOOGLE_CLIENT_SECRET` | Auth | No (optional provider) | — |
| `JWT_SIGNING_KEY` | Auth | Yes (when auth enabled) | — |
| `JWT_PUBLIC_KEY` | Auth | Yes (when auth enabled) | — |
| `SMTP_HOST` | Auth (magic link) | Yes (when auth enabled) | — |
| `SMTP_PORT` | Auth (magic link) | No | 587 |
| `SMTP_USER` | Auth (magic link) | Yes (when auth enabled) | — |
| `SMTP_PASS` | Auth (magic link) | Yes (when auth enabled) | — |
| `SMTP_FROM` | Auth (magic link) | No | `noreply@pagent.link` |
| `REQUIRE_AUTH` | Auth | No | `false` |
| `SUPABASE_URL` | File Uploads | Yes (when files enabled) | — |
| `SUPABASE_SERVICE_ROLE_KEY` | File Uploads | Yes (when files enabled) | — |
| `FILE_MAX_SIZE_MB` | File Uploads | No | `10` |
| `WEBHOOK_ALLOW_PRIVATE_IPS` | Webhooks | No | `false` |
| `PUBLIC_PAGE_TTL_MS` | Public Forms | No | `604800000` (7 days) |

## New Dependencies

| Package | Feature | Why |
|---------|---------|-----|
| `jose` | Auth | JWT signing/verification (Ed25519, zero deps) |
| `nodemailer` | Auth | SMTP email for magic links |
| `@supabase/supabase-js` | File Uploads | Supabase Storage client |
| `file-type` | File Uploads | MIME type detection via magic bytes |

## Cross-Spec Consistency (post-review)

The following inconsistencies were found during cross-spec review and have been resolved:

1. ~~`users.handle` nullability~~ — Fixed: nullable in auth, set during onboarding via Custom URLs
2. ~~`pages.owner_id` FK target~~ — Fixed: standardized to `REFERENCES users(id) ON DELETE SET NULL`
3. ~~`auth.users` references in Public Forms~~ — Fixed: changed to `users`
4. ~~Handle regex (underscores)~~ — Fixed: hyphens only, `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`
5. ~~`field_id` vs `field_name`~~ — Fixed: standardized to `field_name`
6. ~~Audit log events marked "reserved"~~ — Fixed: all events active since all features ship in v2
7. ~~Webhook payload missing `submitted_by`/`files`~~ — Fixed: both included
8. ~~Webhook retry timing conflict~~ — Fixed: canonical 0s/1s/5s with jitter

## Resolved Questions

1. **Public form TTL** — Public-mode pages default to 7 days (`PUBLIC_PAGE_TTL_MS` env var, default `604800000`). Single-mode pages keep the existing 30-minute default.
2. **Submission rate limiting** — 5 submissions/min per IP per page + 100 submissions/min global cap per page. Implemented as Hono middleware on `POST /:id/result` for public pages.
3. **Submission count cap** — 10,000 max submissions per page. `POST /:id/result` returns 409 after cap reached. Stored in `pages.max_submissions` (default 10000, configured through Page management or the relevant `write` variant).
4. **Presentation versioning** — Every update creates an immutable revision. Earlier revisions remain previewable, and restoring one creates a new head revision rather than overwriting history. This stays within the existing `write`/`read` MCP contract.
