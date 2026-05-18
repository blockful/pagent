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
| 7 | Agent Form Submission (submit_form) | `2026-05-17-agent-submit-design.md` | ~1400 | Ready |

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
| Agent Submit | File Uploads | File support in `submit_form` depends on `POST /:id/files` |

### Soft dependencies (enriched by, but works without)

| Feature | Enriched by | What it adds |
|---------|------------|-------------|
| Audit Log | Auth | `user_id` on entries (without auth: null) |
| Webhooks | Auth | `submitted_by` in payload (without auth: null) |
| Webhooks | File Uploads | `files` array in payload (without files: empty) |
| Webhooks | Public Forms | `submission_id` + `mode` in payload |

### Independent pairs (can build in parallel)

- Webhooks ∥ Custom URLs ∥ File Uploads ∥ Audit Log
- Public Forms ∥ Audit Log ∥ Custom URLs

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

### Phase 4: Capstone
**Agent Submit** — combines auth + file uploads, adds `submit_form` MCP tool.

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

All features extend the MCP tools. Here is the final combined interface:

### `show_ui` (extended)
```typescript
{
  spec: unknown[],             // A2UI components (existing)
  slug?: string,               // Custom URLs
  mode?: 'single' | 'public',  // Public Forms (default: 'single')
  access_emails?: string[],    // Public Forms (email allowlist)
  max_submissions?: number,    // Public Forms (default: 10000, only for public mode)
  webhook_url?: string,        // Webhooks
  webhook_secret?: string,     // Webhooks
}
```

### `show_html` (extended)
```typescript
{
  html: string,                // HTML content (existing)
  slug?: string,               // Custom URLs
  webhook_url?: string,        // Webhooks
  webhook_secret?: string,     // Webhooks
}
```

### `check_result` (extended)
```typescript
// Input
{ page_id: string, cursor?: string, limit?: number }

// Output (single mode — unchanged)
{ kind: 'state', state: string, result?: unknown, format?: string }

// Output (public mode — new)
{ kind: 'submissions', mode: 'public', page_id: string,
  submissions: Array<{ id, result, submitted_at, submitted_by? }>,
  total: number, cursor?: string }
```

### `submit_form` (new)
```typescript
// Input
{ page_id: string, data: Record<string, unknown>, files?: Record<string, string> }

// Output
{ success: true, submission_id: string }
| { success: false, errors: Array<{ field, message }> }
```

### `get_audit_log` (new)
```typescript
// Input
{ page_id: string, limit?: number }

// Output
{ events: Array<{ action, resource_type, resource_id, metadata, created_at }> }
```

## New Environment Variables

| Variable | Feature | Required | Default |
|----------|---------|----------|---------|
| `GOOGLE_CLIENT_ID` | Auth | Yes (when auth enabled) | — |
| `GOOGLE_CLIENT_SECRET` | Auth | Yes (when auth enabled) | — |
| `JWT_PRIVATE_KEY` | Auth | Yes (when auth enabled) | — |
| `JWT_PUBLIC_KEY` | Auth | Yes (when auth enabled) | — |
| `SMTP_HOST` | Auth (magic link) | Yes (when auth enabled) | — |
| `SMTP_PORT` | Auth (magic link) | No | 587 |
| `SMTP_USER` | Auth (magic link) | Yes (when auth enabled) | — |
| `SMTP_PASS` | Auth (magic link) | Yes (when auth enabled) | — |
| `SMTP_FROM` | Auth (magic link) | No | `noreply@pagent.io` |
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
3. **Submission count cap** — 10,000 max submissions per page. `POST /:id/result` returns 409 after cap reached. Stored in `pages.max_submissions` (default 10000, configurable via `show_ui`).
