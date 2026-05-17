# Custom URLs — Design

Status: draft, awaiting user review (2026-05-17).

Depends on: Auth (roadmap item 1 — users must exist before they can own handles).

## 1. Overview and motivation

Today every pagent page is addressed by a 32-character hex ID:

```
https://pagent.link/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

These IDs are intentionally opaque — great for single-shot ephemeral forms, but
they fail when pages become durable or shareable:

- **Unreadable** — users cannot glance at a URL and know what it leads to.
- **Unrecognizable** — there is no author provenance; a link could be from anyone.
- **Unsharable** — pasting a hex blob into Slack or an email looks suspicious.
- **No namespace** — agents cannot reference a stable slug across sessions
  ("open my quarterly-review form") because every page gets a fresh random ID.

Custom URLs solve this by introducing **user handles** and **page slugs**:

```
https://pagent.link/alex/quarterly-review
```

The hex-ID scheme continues to work for backward compatibility. Custom URLs are
opt-in: a page only gets a slug if the agent passes one to `show_ui` / `show_html`.

### Design principles

1. **Additive** — existing hex URLs never break; no flag day.
2. **Agent-driven slugs** — the agent picks the slug at page-creation time via
   the MCP tool. The user picks their handle once during onboarding.
3. **Stable references** — `(owner_id, slug)` is unique, so an agent can later
   reference "the page at /alex/quarterly-review" without remembering the hex ID.
4. **Simple routing** — the renderer resolves `/:handle/:slug` to a page ID and
   proceeds exactly as it does today for `/:id`.

## 2. Database schema changes

### 2.1 `users` table (created by Auth — not modified here)

Auth creates the `users` table with a nullable `handle text` column and the
partial unique index `users_handle_unique`. This spec does **not** alter the
`users` table — it only requires that `handle` is set (via `PUT /me/handle`)
before slug-based custom URLs work.

```sql
-- Reference: Auth creates the table with these relevant columns/indexes.
-- Repeated here for context; Custom URLs does NOT run these statements.
--
-- CREATE TABLE IF NOT EXISTS users (
--   id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   ...
--   handle     text,                          -- nullable until onboarding sets it
--   ...
-- );
--
-- CREATE UNIQUE INDEX IF NOT EXISTS users_handle_unique
--   ON users (handle)
--   WHERE handle IS NOT NULL;
```

**Column details (defined by Auth, consumed by Custom URLs):**

| Column   | Type   | Nullable | Default | Constraint                                      |
|----------|--------|----------|---------|--------------------------------------------------|
| `handle` | `text` | Yes*     | `NULL`  | Unique (partial, where not null), validated regex |

*Nullable until the user completes onboarding. The `PUT /me/handle` endpoint
(section 3) sets the value; the application layer enforces NOT NULL at the
endpoint level for new registrations.

### 2.2 `pages` table (existing — extended)

```sql
-- Add slug column. Nullable because most existing pages (and future HTML
-- show_html pages) won't have a slug.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS slug text;

-- Add owner_id column. Nullable for backward compat with anonymous pages
-- created before Auth ships. Once Auth is mandatory, tighten to NOT NULL.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- Compound unique: within a single user's namespace, slugs must be unique.
-- Partial index excludes NULL slugs (anonymous / slug-less pages).
CREATE UNIQUE INDEX IF NOT EXISTS pages_owner_slug_unique
  ON pages (owner_id, slug)
  WHERE slug IS NOT NULL;

-- Lookup index for the resolution endpoint: given a handle and slug, find the
-- page. This is a covering index — the query joins users.handle to pages.owner_id
-- and filters on pages.slug, so indexing (owner_id, slug) is sufficient. The
-- users.handle unique index handles the handle → user_id lookup.
-- (pages_owner_slug_unique already covers this; no additional index needed.)
```

**New columns on `pages`:**

| Column     | Type   | Nullable | Default | Constraint                                  |
|------------|--------|----------|---------|----------------------------------------------|
| `slug`     | `text` | Yes      | `NULL`  | Unique per (owner_id) where slug IS NOT NULL |
| `owner_id` | `uuid` | Yes*     | `NULL`  | FK → users(id) ON DELETE SET NULL             |

*Nullable during the Auth transition. Anonymous pages created before Auth have
no owner and therefore no slug.

### 2.3 Validation constraints (application-level)

Handle and slug formats are enforced in the application layer (Zod schemas)
rather than as CHECK constraints. This keeps validation rules co-located with
the API schemas and allows richer error messages.

```typescript
// apps/api/schemas.ts
export const handleSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/,
    'Handle must be 3-40 characters, lowercase alphanumeric and hyphens, cannot start/end with a hyphen',
  );

export const slugSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/,
    'Slug must be 3-64 characters, lowercase alphanumeric and hyphens, cannot start/end with a hyphen',
  );
```

### 2.4 Full migration script

```sql
-- 001_custom_urls.sql
-- Idempotent — safe to run on every deploy.
-- NOTE: users.handle already exists (created by the Auth migration).

BEGIN;

-- pages.slug + pages.owner_id
ALTER TABLE pages ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pages_owner_slug_unique
  ON pages (owner_id, slug) WHERE slug IS NOT NULL;

COMMIT;
```

## 3. Handle registration

### 3.1 Onboarding flow

After Auth creates the user record (Google / magic link), the user is prompted
to choose a handle. The handle is required before the user can create pages
(enforced by a middleware that checks `users.handle IS NOT NULL`).

**Endpoint: `PUT /me/handle`**

```
PUT /me/handle
Authorization: Bearer <token>
Content-Type: application/json

{ "handle": "alex" }
```

**Responses:**

| Status | Body                                    | When                                          |
|--------|-----------------------------------------|-----------------------------------------------|
| 200    | `{ "handle": "alex" }`                  | Handle set successfully                       |
| 400    | `{ "error": "bad_request", ... }`       | Validation failed (regex, length)             |
| 409    | `{ "error": "handle_taken", ... }`      | Another user already has this handle          |
| 422    | `{ "error": "handle_immutable", ... }`  | User already has a handle (cannot change v2)  |

**Handler logic:**

```
1. Authenticate request (Bearer token → user_id)
2. Validate handle against handleSchema
3. Check handle is not in RESERVED_HANDLES
4. Check handle does not match /^[a-f0-9]{32}$/ (collision avoidance)
5. If user already has a handle → 422
6. UPDATE users SET handle = $handle WHERE id = $user_id AND handle IS NULL
   - If 0 rows affected → race: another request set it first → 422
   - If unique constraint violated → 409
7. Return { handle }
```

### 3.2 Settings read endpoint

**Endpoint: `GET /me`**

Returns the current user profile including the handle. Part of the Auth
feature; this spec adds `handle` to the response shape.

```json
{
  "id": "uuid",
  "email": "alex@blockful.io",
  "handle": "alex",
  "created_at": "2026-05-17T..."
}
```

### 3.3 Handle validation rules

| Rule                         | Regex / Check                                      | Rationale                                |
|------------------------------|-----------------------------------------------------|------------------------------------------|
| Lowercase alphanumeric + `-` | `/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/`             | URL-safe, no encoding needed             |
| 3-40 characters              | Embedded in regex                                   | Short enough to type, long enough for names |
| No leading/trailing hyphen   | First/last char `[a-z0-9]`                          | Avoids confusion with CLI flags          |
| No consecutive hyphens       | Application-level `.refine(h => !h.includes('--'))` | Prevents visual confusion                |
| Not a 32-char hex string     | `/^[a-f0-9]{32}$/.test(h) → reject`                | Collision avoidance with page IDs        |
| Not in reserved list         | `RESERVED_HANDLES.has(h) → reject`                 | Protects system routes                   |
| Case-insensitive uniqueness  | Stored lowercase; regex enforces lowercase input    | Prevents `Alex` vs `alex` collisions     |

### 3.4 Immutability

Handles are immutable after creation in v2. Changing handles requires:

- Updating all external references (bookmarks, shared links)
- Potentially redirecting old URLs
- Handling the window where both old and new handles exist

This complexity is deferred to v3. The `PUT /me/handle` endpoint rejects
requests when the user already has a handle set.

## 4. Slug assignment

### 4.1 How slugs flow through the system

```
Agent calls show_ui({ spec, slug: "quarterly-review" })
       │
       ▼
MCP tool validates slug against slugSchema
       │
       ▼
store.createPage() receives (spec, format, { slug, ownerId })
       │
       ▼
db.insertPage() writes row with slug + owner_id
       │
       ▼
Response includes url: "https://pagent.link/alex/quarterly-review"
```

### 4.2 MCP tool changes (show_ui)

The `show_ui` tool gains an optional `slug` parameter:

```typescript
// apps/api/mcp/tools.ts — updated inputSchema
inputSchema: {
  spec: z.array(z.record(z.unknown())).describe(SHOW_UI_INPUT_DESCRIPTION),
  slug: slugSchema.optional().describe(
    'Optional URL slug for this page. If provided, the page will be ' +
    'addressable at pagent.link/<your-handle>/<slug>. Must be 3-64 chars, ' +
    'lowercase alphanumeric + hyphens, no leading/trailing hyphens. ' +
    'Must be unique within your namespace — if the slug is taken, the ' +
    'call fails with an error.'
  ),
},
```

The `show_html` tool also gains the same optional `slug` parameter with
identical validation.

### 4.3 Uniqueness enforcement

The compound unique index `pages_owner_slug_unique` enforces that a given
user cannot have two active pages with the same slug. When a slug collision
occurs:

```
INSERT INTO pages (..., slug, owner_id) VALUES (..., $slug, $owner_id)
-- Unique violation → Postgres error code 23505
```

The store layer catches this and returns a structured error:

```typescript
// apps/api/store.ts
export class SlugConflictError extends Error {
  constructor(public slug: string) {
    super(`A page with slug "${slug}" already exists in your namespace`);
    this.name = 'SlugConflictError';
  }
}
```

Both REST and MCP handlers map `SlugConflictError` to:

- REST: `409 { error: "slug_conflict", slug, message: "..." }`
- MCP: `throw new Error(...)` (surfaced as tool error to the agent)

### 4.4 Slug lifecycle and expired pages

When a page expires and is swept by the TTL cleanup, its slug is freed. This
means a slug can be reused after the previous page using it has expired. This is
intentional — slugs are a namespace convenience, not a permanent reservation.

The unique index is on `(owner_id, slug)` without an `expires_at` filter, which
means an expired-but-not-yet-swept page's slug is still "taken" until the sweep
runs. This is acceptable because:

1. Sweeps run every 60 seconds.
2. The agent gets a clear error message and can retry after a moment.
3. Adding `WHERE expires_at > now()` to the unique index would make it a
   partial-expression index, which Postgres supports but complicates reasoning
   about uniqueness guarantees.

### 4.5 Slugs without Auth

Before Auth ships, there is no `owner_id`. Pages created without authentication
cannot have slugs — the slug parameter is silently ignored (or rejected with an
error if we want to be strict). The recommendation is to reject:

```
if (slug && !ownerId) {
  throw new Error('slug requires authentication; set up your handle first');
}
```

This keeps the contract clean: slugs always imply an owner and a handle.

## 5. URL resolution

### 5.1 Routing logic and precedence

The web renderer (Vite SPA) handles all URL patterns. The resolution decision
tree for a path like `/foo/bar`:

```
pathname = location.pathname

1. Is pathname === "/" ?
   → render home page

2. Is pathname === "/_components" ?
   → render component showcase

3. Does pathname match /^\/[a-f0-9]{32}$/ ?
   → hex page ID → fetch API_BASE/:id → render page
   (backward compatible, existing behavior)

4. Does pathname match /^\/([^/]+)\/([^/]+)$/ ?
   → candidate handle/slug → fetch API_BASE/resolve/:handle/:slug
   → if 200, extract page_id → fetch API_BASE/:id → render page
   → if 404, show "page not found"

5. Does pathname match /^\/([^/]+)$/ and segment is NOT a 32-char hex?
   → candidate handle with no slug → show user profile page (future)
   → or 404 for now

6. Otherwise → 404
```

**Precedence rule:** Hex IDs are always tried first. A path segment that happens
to be exactly 32 hex characters is always treated as a page ID, never as a
handle. This is enforced by the collision avoidance rule (handles cannot be
32-char hex strings).

### 5.2 API resolution endpoint

**Endpoint: `GET /resolve/:handle/:slug`**

```
GET /resolve/alex/quarterly-review
```

**Responses:**

| Status | Body                                         | When                                    |
|--------|----------------------------------------------|-----------------------------------------|
| 200    | `{ "id": "<hex-id>", "handle": "...", ... }` | Page found and active                   |
| 404    | `{ "error": "not_found", ... }`              | Handle or slug not found, or page expired |

**Query:**

```sql
SELECT p.id, p.format, p.state, p.expires_at
FROM pages p
JOIN users u ON u.id = p.owner_id
WHERE u.handle = $handle
  AND p.slug = $slug
  AND p.expires_at > now()
LIMIT 1;
```

The endpoint returns only the page ID and metadata (not the full spec) so the
renderer can then call `GET /:id` as it does today. This keeps the resolution
endpoint lightweight and avoids duplicating the full page-fetch logic.

**Alternative considered:** Having `GET /resolve/:handle/:slug` return the full
page payload directly. Rejected because it would duplicate the `getPageHandler`
logic and complicate caching/metrics — better to resolve-then-fetch.

### 5.3 Redirect behavior

No HTTP-level redirects. The renderer resolves `/:handle/:slug` client-side and
fetches the page by ID from the API. The browser URL stays as
`pagent.link/alex/quarterly-review` — it never rewrites to the hex ID.

This preserves the human-readable URL in the address bar and in shared links.

### 5.4 API route registration

```typescript
// apps/api/app.ts — new route, added BEFORE the /:id catch-all
app.get('/resolve/:handle/:slug', resolveHandleSlugHandler);

// Existing routes (unchanged)
app.post('/new', newPageLimiter, newPageHandler);
app.get('/:id', getPageHandler);
app.post('/:id/result', submitResultHandler);
app.get('/:id/result', getResultHandler);
```

The `/resolve/:handle/:slug` route is registered before `/:id` so Hono matches
the more specific pattern first. Since `resolve` is not a valid 32-char hex
string, there is no ambiguity with the existing `/:id` route.

## 6. Frontend routing changes

### 6.1 Current routing (main.ts)

```typescript
// Current: extract first path segment as page ID
const pageId = location.pathname.replace(/^\/+/, '').split('/')[0];
```

### 6.2 Updated routing

```typescript
// apps/web/main.ts — new routing logic

const HEX_ID_RE = /^[a-f0-9]{32}$/;
const HANDLE_SLUG_RE = /^\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/([a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;

type PageRef =
  | { kind: 'id'; id: string }
  | { kind: 'handle-slug'; handle: string; slug: string }
  | { kind: 'home' }
  | { kind: 'showcase' };

function parseRoute(pathname: string): PageRef {
  if (pathname === '/' || pathname === '') return { kind: 'home' };
  if (pathname === '/_components') return { kind: 'showcase' };

  // Strip trailing slash
  const clean = pathname.replace(/\/+$/, '');
  const segments = clean.replace(/^\/+/, '').split('/');

  // Single segment: hex ID or unknown
  if (segments.length === 1) {
    if (HEX_ID_RE.test(segments[0])) {
      return { kind: 'id', id: segments[0] };
    }
    // Future: user profile page at /:handle
    return { kind: 'home' }; // fallback for now
  }

  // Two segments: handle/slug candidate
  if (segments.length === 2) {
    const match = HANDLE_SLUG_RE.exec(clean);
    if (match) {
      return { kind: 'handle-slug', handle: match[1], slug: match[2] };
    }
  }

  return { kind: 'home' }; // fallback
}
```

### 6.3 Resolution in AgentUIApp

When the route is `handle-slug`, the app first calls the resolution endpoint,
then proceeds as it does today with the resolved ID:

```typescript
// Inside AgentUIApp
private async loadPage() {
  let resolvedId: string;

  if (this.ref.kind === 'id') {
    resolvedId = this.ref.id;
  } else if (this.ref.kind === 'handle-slug') {
    try {
      const res = await fetch(
        `${API_BASE}/resolve/${this.ref.handle}/${this.ref.slug}`,
        { headers: { accept: 'application/json' } },
      );
      if (res.status === 404) {
        this.status = 'error';
        this.error = 'Page not found or expired.';
        return;
      }
      if (!res.ok) {
        this.status = 'error';
        this.error = `Failed to resolve page (${res.status}).`;
        return;
      }
      const { id } = (await res.json()) as { id: string };
      resolvedId = id;
    } catch (err) {
      console.error('resolve failed', err);
      this.status = 'error';
      this.error = 'Failed to load page.';
      return;
    }
  } else {
    return; // home / showcase handled elsewhere
  }

  // Existing fetch-by-id logic continues from here...
  const res = await fetch(`${API_BASE}/${resolvedId}`, { ... });
  // ...
}
```

### 6.4 Vite dev-server proxy changes

The dev proxy in `vite.config.ts` needs new rules for handle/slug patterns:

```typescript
// apps/web/vite.config.ts — additional proxy rules

// /resolve/:handle/:slug — always API
[`^/resolve/[a-z0-9][a-z0-9-]{1,38}[a-z0-9]/[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`]: {
  target: API_TARGET,
  changeOrigin: true,
},

// /:handle/:slug — content-negotiated (same logic as /:id)
// Browser navigation → SPA; fetch() → API
[`^/[a-z0-9][a-z0-9-]{1,38}[a-z0-9]/[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`]: {
  target: API_TARGET,
  changeOrigin: true,
  bypass(req) {
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/html')) return '/index.html';
  },
},
```

### 6.5 Vercel rewrite (no change needed)

The existing Vercel catch-all rewrite handles this:

```json
{ "source": "/(.*)", "destination": "/index.html" }
```

All paths that don't match a static asset already fall through to `index.html`,
so `/:handle/:slug` paths are served the SPA shell. The client-side routing in
`main.ts` takes over from there.

## 7. MCP tool changes

### 7.1 `show_ui` — slug parameter

```typescript
// Updated tool registration
server.registerTool(
  'show_ui',
  {
    title: 'Show UI to the user',
    description: SHOW_UI_DESCRIPTION,  // updated, see 7.3
    inputSchema: {
      spec: z.array(z.record(z.unknown())).describe(SHOW_UI_INPUT_DESCRIPTION),
      slug: slugSchema.optional().describe(
        'URL-friendly slug for this page (e.g. "quarterly-review"). ' +
        'When set, the page URL will be pagent.link/<your-handle>/<slug> ' +
        'instead of a random hex ID. Must be unique in your namespace.'
      ),
    },
  },
  async ({ spec, slug }) => {
    const created = await ops.showUi(spec, slug);
    return {
      content: [
        {
          type: 'text',
          text: `UI ready. Share this URL with the user:\n${created.url}\n\n` +
                `page_id: ${created.id}\nexpires_at: ${created.expires_at}`,
        },
      ],
      structuredContent: {
        page_id: created.id,
        url: created.url,
        expires_at: created.expires_at,
      },
    };
  },
);
```

### 7.2 `show_html` — same slug parameter

Identical change: add optional `slug` to `show_html`'s input schema.

### 7.3 Updated tool description

Add to `SHOW_UI_DESCRIPTION`:

```
'You can optionally pass a `slug` to make the page addressable at a
human-readable URL (pagent.link/<handle>/<slug>) instead of a random hex ID.
Slugs must be unique within your namespace — if the slug is already taken by
another active page, the call will fail.'
```

### 7.4 `check_result` — page_id format update

Once custom URLs exist, agents may try to pass a handle/slug to `check_result`
instead of the hex page_id. The tool description should clarify:

```
'page_id must be the 32-character hex ID returned by show_ui, not a URL slug.'
```

The `page_id` schema validation (`/^[a-f0-9]{32}$/`) already rejects non-hex
inputs, so no code change is needed — just description clarity.

### 7.5 Response URL format

When a page has a slug and the creating user has a handle, the response URL
uses the custom format:

```json
{
  "page_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "url": "https://pagent.link/alex/quarterly-review",
  "expires_at": 1747500000000
}
```

When no slug is provided (or the user has no handle), the URL falls back to
the hex format:

```json
{
  "url": "https://pagent.link/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
}
```

### 7.6 PageOps interface update

```typescript
export interface PageOps {
  showUi(spec: unknown, slug?: string): Promise<ShowUiResult>;
  showHtml(html: string, slug?: string): Promise<ShowUiResult>;
  checkResult(page_id: string): Promise<CheckResultOutcome>;
}
```

### 7.7 Stdio MCP adapter (apps/mcp/server.ts)

The stdio adapter's `restOps` forwards the slug to the REST API:

```typescript
const restOps: PageOps = {
  async showUi(spec, slug) {
    const res = await fetch(`${SERVICE_URL}/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec, ...(slug && { slug }) }),
    });
    // ...
  },
  async showHtml(html, slug) {
    const res = await fetch(`${SERVICE_URL}/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'html', spec: html, ...(slug && { slug }) }),
    });
    // ...
  },
  // checkResult unchanged
};
```

### 7.8 REST `POST /new` body schema update

```typescript
// apps/api/schemas.ts — updated newPageBodySchema
export const newPageBodySchema = z.union([
  z
    .object({
      format: z.literal('a2ui').optional().default('a2ui'),
      spec: z.unknown(),
      slug: slugSchema.optional(),
    })
    .refine((b) => 'spec' in b, { message: "missing 'spec'" }),
  z.object({
    format: z.literal('html'),
    spec: z.string().min(1).max(HTML_MAX_BYTES),
    slug: slugSchema.optional(),
  }),
]);
```

## 8. Collision avoidance

### 8.1 Reserved handles

Handles that collide with existing or planned routes are rejected at
registration time.

```typescript
// apps/api/schemas.ts or a dedicated constants file
export const RESERVED_HANDLES = new Set([
  // Existing API routes
  'new',
  'health',
  'docs',
  'mcp',
  'resolve',

  // Existing web routes
  '_components',

  // Planned / reserved
  'api',
  'oauth',
  'admin',
  'settings',
  'audit',
  'webhooks',
  'login',
  'signup',
  'logout',
  'callback',
  'profile',

  // Infrastructure
  'www',
  'mail',
  'ftp',
  'cdn',
  'static',
  'assets',

  // Generic reserved
  'pagent',
  'support',
  'help',
  'about',
  'blog',
  'status',
  'pricing',
  'terms',
  'privacy',
]);
```

### 8.2 Hex ID disambiguation

Handles are rejected if they match the 32-char hex pattern:

```typescript
if (/^[a-f0-9]{32}$/.test(handle)) {
  return c.json({
    error: 'bad_request',
    message: 'Handle cannot be a 32-character hex string (conflicts with page IDs)',
  }, 400);
}
```

This check is technically redundant with the 40-char max (a 32-char hex string
within the 3-40 range could match), so it's an explicit guard. The handle regex
already requires at least 3 characters, and a 32-char all-hex string like
`a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4` would pass the regex but must be rejected.

### 8.3 Slug collision with API sub-paths

Slugs are scoped under a handle (`/:handle/:slug`), so they cannot collide with
top-level API routes. However, if a user's handle is `resolve`, the path
`/resolve/foo` would be ambiguous. This is why `resolve` is in the reserved
handles list.

### 8.4 Route matching order (API)

```
1. /health                    → health check
2. /new                       → create page
3. /docs                      → API reference
4. /openapi.json              → OpenAPI spec
5. /openapi.yaml              → OpenAPI spec
6. /mcp                       → MCP HTTP transport
7. /me/handle                 → handle registration
8. /me                        → user profile
9. /resolve/:handle/:slug     → handle/slug resolution
10. /:id                      → page by hex ID
11. /:id/result               → page result
```

Named routes are registered first. The `/:id` wildcard only matches valid
32-char hex strings (enforced by `pageIdSchema` validation inside the handler,
not by the route pattern). The `resolve` prefix ensures handle/slug resolution
never shadows the page-by-ID route.

## 9. SEO and sharing considerations

### 9.1 Canonical URLs

Pages with slugs should declare their custom URL as canonical:

```html
<link rel="canonical" href="https://pagent.link/alex/quarterly-review" />
```

For hex-ID-only pages, the canonical is the hex URL:

```html
<link rel="canonical" href="https://pagent.link/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" />
```

The SPA shell (`index.html`) does not have a canonical tag. The renderer
injects it dynamically after resolving the page. Since pagent pages are rendered
client-side and search engines may not execute JavaScript, actual SEO indexing
is limited — but the canonical tag is still good practice for crawlers that do
render JS (Googlebot).

### 9.2 Open Graph tags

For link previews in Slack, Discord, Twitter, etc., the renderer should inject
OG tags. Since the SPA renders client-side, a server-side middleware or edge
function is needed for proper unfurling:

**Phase 1 (this spec):** No server-side OG rendering. Link previews show the
generic pagent branding from `index.html`. This is acceptable for v2.

**Phase 2 (future):** Add a Vercel edge middleware or a dedicated
`/og/:handle/:slug` endpoint that returns a minimal HTML page with OG meta tags
for crawlers (detected via User-Agent). The OG tags would include:

```html
<meta property="og:title" content="quarterly-review — alex on pagent" />
<meta property="og:url" content="https://pagent.link/alex/quarterly-review" />
<meta property="og:type" content="website" />
<meta property="og:description" content="Interactive form by alex" />
```

### 9.3 `robots.txt`

Pagent pages are ephemeral (30-minute TTL by default). Indexing them would
create broken links. The existing `robots.txt` (or lack thereof) should
disallow crawling of page paths:

```
User-agent: *
Allow: /
Disallow: /*/     # handle/slug pages
```

However, as pagent evolves toward durable pages, this policy will change. For
now, no `robots.txt` changes are needed — the TTL naturally deters indexing.

## 10. Migration plan

### 10.1 Existing pages (pre-custom-URLs)

All existing pages have `slug = NULL` and `owner_id = NULL`. They continue to
work exactly as before — addressed by hex ID, no resolution needed.

### 10.2 Deployment sequence

Because this feature depends on Auth, the deployment order is:

```
1. Auth ships (users table, authentication middleware, onboarding)
2. Run migration 001_custom_urls.sql (adds handle, slug, owner_id columns)
3. Deploy API with handle registration endpoint (PUT /me/handle)
4. Deploy API with slug support in POST /new + resolve endpoint
5. Deploy MCP with slug parameter in show_ui / show_html
6. Deploy web renderer with handle/slug routing
```

Steps 2-6 can ship as a single deploy since the columns are nullable and the
new code paths are additive (old clients that don't send `slug` still work).

### 10.3 Backward compatibility guarantees

| Scenario                                  | Behavior                                |
|-------------------------------------------|-----------------------------------------|
| Old agent, no slug                        | Works as before, hex URL returned       |
| Old agent, POST /new without slug         | Works as before                         |
| New agent, slug provided                  | Custom URL returned if user has handle  |
| Browser opens hex URL                     | Works as before                         |
| Browser opens custom URL                  | Resolves via API, then renders          |
| Agent polls check_result with hex page_id | Works as before                         |
| Page expires                              | Slug freed, hex URL returns 404 (same)  |

### 10.4 Rollback plan

If custom URLs need to be rolled back:

1. Remove the `GET /resolve/:handle/:slug` route from the API.
2. Remove the slug parameter from `POST /new` schema (ignore if present).
3. Revert the web renderer routing to hex-only.
4. Leave the database columns in place (nullable, no harm).
5. Handle registration endpoint can remain (no harm, prep for retry).

The migration is fully backward-compatible and the columns are nullable, so
rollback does not require a schema migration.

## Appendix A: Full file change inventory

| File                          | Change                                                         |
|-------------------------------|----------------------------------------------------------------|
| `apps/api/schemas.ts`         | Add `handleSchema`, `slugSchema`, `RESERVED_HANDLES`; update `newPageBodySchema` with optional `slug` |
| `apps/api/db.ts`              | Add `slug` and `owner_id` to `Page` type, `insertPage`, `getActivePage`; add `resolveHandleSlug()` query; boot migration for new columns |
| `apps/api/store.ts`           | Add `SlugConflictError`; update `createPage` / `createHtmlPage` to accept slug + ownerId; build custom URL when both exist |
| `apps/api/app.ts`             | Add `GET /resolve/:handle/:slug` route + handler; add `PUT /me/handle` + `GET /me` routes (Auth integration); update `newPageHandler` to extract slug |
| `apps/api/mcp/tools.ts`       | Add `slug` to `show_ui` and `show_html` input schemas; update `PageOps` interface; update tool descriptions |
| `apps/api/mcp/http.ts`        | Update `buildInProcessOps` to forward slug to store functions |
| `apps/mcp/server.ts`          | Update `restOps.showUi` / `showHtml` to forward slug in REST body |
| `apps/web/main.ts`            | New route parser (`parseRoute`); resolution fetch for handle/slug; pass resolved ID to existing page-load logic |
| `apps/web/vite.config.ts`     | Add dev-proxy rules for `/resolve/...` and `/:handle/:slug` patterns |
| `docs/openapi.yaml`           | Document `GET /resolve/:handle/:slug`, `PUT /me/handle`; update `POST /new` with `slug` field |
| `infra/` or migration script  | `001_custom_urls.sql` — ALTER TABLE + CREATE INDEX statements |

## Appendix B: Example end-to-end flow

```
1. User signs up via Google OAuth → users row created (id=uuid, email=alex@blockful.io)
2. Onboarding screen prompts for handle → user types "alex"
3. PUT /me/handle { "handle": "alex" } → 200 { "handle": "alex" }
4. Agent calls show_ui({ spec: [...], slug: "quarterly-review" })
5. API creates page:
   - id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" (random)
   - slug = "quarterly-review"
   - owner_id = <alex's uuid>
6. API returns:
   {
     "page_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
     "url": "https://pagent.link/alex/quarterly-review",
     "expires_at": 1747500000000
   }
7. Agent prints URL to user
8. User opens https://pagent.link/alex/quarterly-review in browser
9. Web renderer:
   a. parseRoute("/alex/quarterly-review") → { kind: 'handle-slug', handle: 'alex', slug: 'quarterly-review' }
   b. fetch("https://api.pagent.link/resolve/alex/quarterly-review")
   c. Response: { "id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" }
   d. fetch("https://api.pagent.link/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4")
   e. Renders page as normal
10. User submits form → POST /:id/result (unchanged)
11. Agent polls check_result("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4") → gets result
```

## Appendix C: Open questions

1. **Should slugs be mutable?** Currently, once a page is created with a slug,
   the slug cannot be changed. This mirrors handle immutability. If we want
   agents to update slugs on existing pages, we need an `UPDATE` endpoint.
   Recommendation: defer to v3 alongside handle changes.

2. **Should we support slug-only URLs?** e.g., `pagent.link/quarterly-review`
   without a handle. This would require globally unique slugs (much harder
   namespace). Recommendation: no. Always require `/:handle/:slug`.

3. **Should expired pages redirect?** When a user opens a custom URL for an
   expired page, should we show "this page existed but has expired" with the
   author's handle? Recommendation: yes, but this is a UX polish item, not a
   routing concern. The 404 page can include the handle if the resolution
   endpoint returns it.

4. **Rate limiting on resolve?** The resolution endpoint is read-only and cheap
   (indexed lookup). It should be rate-limited to prevent enumeration of
   handle/slug combinations. Recommendation: share the same rate limiter as
   `GET /:id` (generous, since it's read-only).
