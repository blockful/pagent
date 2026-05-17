# Public Forms — Design

Status: draft, awaiting user review (2026-05-17).

## Goal

Add a **public** page mode alongside the existing single-shot page mode.
Public pages accept multiple submissions from multiple users — surveys,
intake forms, bug-report collectors, polls — rather than the current
one-spec-one-result model.

The agent gets a new `mode` parameter on `show_ui`:

- `show_ui({ spec, mode: "single" })` — current behavior. One
  submission, state machine walks `open → submitted → received`. Default
  when `mode` is omitted.
- `show_ui({ spec, mode: "public" })` — multi-submission. The page
  stays `open` until the owner explicitly closes it. Each browser
  submission creates a row in a new `submissions` table. The agent reads
  all submissions via `check_result`.

## Why now

The product roadmap (v2) lists public forms as the first major feature
after auth. Surveys, intake forms, and multi-user polls are the
most-requested capability gap: the current single-shot model forces the
agent to emit N separate pages to collect N responses, with no shared
URL. Public forms close that gap with a single shareable URL.

## Non-goals

- **Branching / conditional logic in forms.** The spec is static; the
  renderer does not evaluate visibility rules. Agents that need
  conditional follow-ups should emit a second page.
- **Editing a submitted response.** Once a submission row is written, it
  is immutable. The user can submit again (producing a new row).
- **Anonymous submissions for authenticated pages.** If `access_emails`
  is set, every submitter must authenticate. There is no "allow some
  anonymous" escape hatch.
- **Real-time submission streaming to the agent.** The agent polls
  `check_result`; there is no WebSocket/SSE push channel in V1.
- **Custom close messages.** The "this form is no longer accepting
  responses" copy is hard-coded. Custom close-page content is deferred.
- **Scheduled auto-close.** The agent can set a shorter TTL, but there
  is no `close_at` timestamp that fires automatically. The agent (or a
  cron) must call `POST /:id/close`.

---

## Database schema

### New table: `submissions`

```sql
create table submissions (
  id            uuid        primary key default gen_random_uuid(),
  page_id       text        not null references pages(id) on delete cascade,
  submitted_by  uuid        references users(id),  -- nullable for unauthenticated pages
  result        jsonb       not null,
  submitted_at  timestamptz not null default now()
);

create index submissions_page_id_idx on submissions (page_id, submitted_at);
```

**Design notes:**

- `id` is a UUID (not the 32-hex-char scheme pages use) because
  submissions are not URL-addressable — they only appear inside
  `check_result` response arrays.
- `on delete cascade` ensures TTL sweeps on `pages` automatically clean
  up child submissions without a second query.
- `submitted_by` is nullable: unauthenticated public pages (no
  `access_emails` set) allow anonymous submissions. When auth is
  present, this column stores the authenticated user's UUID.
- The composite index `(page_id, submitted_at)` supports the primary
  query pattern: "all submissions for page X, ordered by time."

### Alter table: `pages`

```sql
-- 1. Add mode column
alter table pages
  add column if not exists mode text
    not null default 'single'
    check (mode in ('single', 'public'));

-- 2. Expand state CHECK to include 'closed'
--    Postgres doesn't support ALTER CHECK directly; drop + re-add.
alter table pages drop constraint if exists pages_state_check;
alter table pages
  add constraint pages_state_check
    check (state in ('open', 'submitted', 'received', 'closed'));

-- 3. Add access control column
alter table pages
  add column if not exists access_emails text[];

-- 4. Add closed_at timestamp
alter table pages
  add column if not exists closed_at timestamptz;

-- 5. Add owner_id for close authorization
alter table pages
  add column if not exists owner_id uuid references users(id) on delete set null;

-- 6. Add max_submissions cap (default 10 000)
alter table pages
  add column if not exists max_submissions integer not null default 10000;
```

**Column semantics:**

| Column          | Type       | Default    | Description |
|-----------------|------------|------------|-------------|
| `mode`          | `text`     | `'single'` | `'single'` = current one-shot behavior. `'public'` = multi-submission. |
| `state`         | `text`     | —          | Now allows `'closed'` in addition to `'open'`, `'submitted'`, `'received'`. |
| `access_emails` | `text[]`   | `NULL`     | Email allowlist. `NULL` = open to anyone. Non-null = only listed emails may view and submit. |
| `closed_at`     | `timestamptz` | `NULL`  | Set when owner calls `POST /:id/close`. |
| `owner_id`      | `uuid`     | `NULL`     | The user who created the page. `REFERENCES users(id) ON DELETE SET NULL`. Required for close authorization. NULL for legacy pages. |
| `max_submissions` | `integer` | `10000`   | Maximum number of submissions allowed. `POST /:id/result` returns 409 when this cap is reached. Configurable via `show_ui`. |

---

## State machines

### Single mode (unchanged)

```
            browser submits          agent reads result
  ┌───────┐ POST /:id/result  ┌───────────┐ GET /:id/result  ┌──────────┐
  │ open  │ ──────────────────▶│ submitted │ ────────────────▶│ received │
  └───────┘                    └───────────┘                   └──────────┘
      │                                                             │
      │  TTL expires                                TTL expires     │
      ▼                                                             ▼
  [deleted]                                                    [deleted]
```

When `mode = 'single'`, the existing logic applies without change.
Additionally, for forward-compatibility, a submission row is written to
`submissions` alongside setting `pages.result` so that both the inline
result and the normalized table agree.

### Public mode (new)

```
                          browser submits (repeatable)
  ┌──────┐  POST /:id/result   ┌──────┐
  │ open │ ────────────────────▶│ open │  (state does NOT change)
  └──────┘  INSERT submissions  └──────┘
      │                             │
      │  owner calls                │  TTL expires
      │  POST /:id/close           │
      ▼                             ▼
  ┌────────┐                   [deleted]
  │ closed │
  └────────┘
      │
      │  TTL expires
      ▼
  [deleted]
```

Key differences from single mode:

1. **State stays `open`.** `POST /:id/result` does NOT transition the
   page to `submitted`. Each submission is an INSERT into `submissions`;
   the page remains accepting new entries.
2. **No `submitted` or `received` states.** Public pages transition only
   from `open` to `closed` (or expire).
3. **`check_result` does not advance state.** For public pages the agent
   reads all submissions without side effects. The `received` state is
   meaningless for public pages.
4. **Owner-initiated close.** `POST /:id/close` is the only way to stop
   accepting submissions (besides TTL expiry).

---

## API endpoints

### `POST /new` — create page (modified)

**Request body changes:**

```jsonc
{
  "format": "a2ui",           // unchanged
  "spec": [ ... ],            // unchanged
  "mode": "single",           // NEW — "single" (default) | "public"
  "access_emails": [          // NEW — optional email allowlist
    "alice@example.com",
    "bob@example.com"
  ]
}
```

**Zod schema update** (`schemas.ts`):

```typescript
export const newPageBodySchema = z.union([
  z.object({
    format: z.literal('a2ui').optional().default('a2ui'),
    spec: z.unknown(),
    mode: z.enum(['single', 'public']).optional().default('single'),
    access_emails: z.array(z.string().email()).optional(),
  }).refine((b) => 'spec' in b, { message: "missing 'spec'" }),
  z.object({
    format: z.literal('html'),
    spec: z.string().min(1).max(HTML_MAX_BYTES),
    // HTML pages are always single/view-only; mode and access_emails
    // are not accepted. Passing them is a 400.
  }),
]);
```

**Validation rules:**

- `mode: "public"` is only valid with `format: "a2ui"`. HTML pages are
  view-only and cannot accept submissions. Reject with 400
  `invalid_for_format` if `mode: "public"` + `format: "html"`.
- `access_emails` is accepted on both modes but is more useful on public
  pages. On single pages it restricts who can view and submit.

**Response body:** unchanged (`{ id, url, expires_at }`).

**Side effects:**

- `pages.mode` is set to the requested value.
- `pages.access_emails` is set if provided.
- `pages.owner_id` is set to the authenticated user's ID (from the
  auth header). NULL if unauthenticated.

---

### `POST /:id/result` — submit (modified)

**Single mode:** unchanged. Atomic `open → submitted` transition,
writes `pages.result`, writes a `submissions` row (new, for
consistency), returns `{ ok: true }`.

**Public mode:**

1. Verify page exists, is not expired, and `state = 'open'`.
   - If `state = 'closed'`: return 409
     `{ error: "closed", message: "This form is no longer accepting responses" }`.
2. If `access_emails` is non-null, verify the submitter's email is in
   the list. Return 403 if not.
3. INSERT into `submissions` (page_id, submitted_by, result).
4. Do NOT update `pages.state` or `pages.result`.
5. Fire webhook (see [Webhook interaction](#webhook-interaction)).
6. Return `{ ok: true, submission_id: "<uuid>" }`.

**Request body:** unchanged (`ResultRequest` schema).

**New response field for public mode:**

```jsonc
{
  "ok": true,
  "submission_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

The `submission_id` is returned only for public pages. Single-mode
pages continue returning `{ ok: true }` for backward compatibility.

**New error responses:**

| Status | Error code | When |
|--------|-----------|------|
| 403    | `access_denied` | Submitter's email not in `access_emails` allowlist |
| 409    | `closed` | Page is in state `closed` |

---

### `GET /:id/result` — poll for result (modified)

**Single mode:** unchanged. Returns `{ state, result, format }`.
First read after submission atomically flips `submitted → received`.

**Public mode:** returns all submissions as a paginated array.

**Response shape (public mode):**

```jsonc
{
  "state": "open",         // or "closed"
  "mode": "public",
  "format": "a2ui",
  "submissions": [
    {
      "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "submitted_by": "user-uuid-or-null",
      "result": { "name": "submitted", "surfaceId": "main", "context": { ... } },
      "submitted_at": "2026-05-17T12:34:56.789Z"
    }
    // ...
  ],
  "total": 42,
  "cursor": "2026-05-17T12:34:56.789Z"   // null if no more pages
}
```

**Query parameters (public mode only):**

| Param    | Type   | Default | Description |
|----------|--------|---------|-------------|
| `limit`  | int    | 50      | Max submissions per response. Capped at 200. |
| `cursor` | string | —       | ISO 8601 timestamp. Returns submissions with `submitted_at > cursor`. |
| `after`  | string | —       | Alias for `cursor` (convenience for agents). |

**Pagination strategy:** cursor-based on `submitted_at`. The response
includes a `cursor` field set to the `submitted_at` of the last
submission in the current page. The agent passes this as `?cursor=` on
the next request to get the next page. `cursor` is `null` when there
are no more submissions.

**Why cursor, not offset:** offset pagination breaks when new
submissions arrive between polls (rows shift). Cursor pagination is
stable under concurrent inserts.

**State behavior:** `GET /:id/result` does NOT advance state for
public pages. There is no `submitted → received` transition. The agent
can read submissions as many times as needed.

**`check_result` MCP tool behavior:** for public pages, the tool
returns the full paginated response. The model sees an array of
submissions rather than a single result object.

---

### `POST /:id/close` — close page (new)

Stops a public page from accepting further submissions. Sets
`state = 'closed'` and `closed_at = now()`.

**Authorization:** only the page owner may close a page. The request
must include a valid auth token whose user ID matches
`pages.owner_id`. Returns 403 if the caller is not the owner.

**Request:**

```http
POST /:id/close
Authorization: Bearer <supabase-jwt>
```

No request body required.

**Response (success):**

```jsonc
// 200 OK
{
  "ok": true,
  "state": "closed",
  "closed_at": "2026-05-17T15:00:00.000Z"
}
```

**Error responses:**

| Status | Error code | When |
|--------|-----------|------|
| 400    | `invalid_mode` | Page is `mode: 'single'` (single-mode pages use the existing state machine; close is meaningless) |
| 403    | `forbidden` | Caller is not the page owner |
| 404    | `not_found` | Page not found or expired |
| 409    | `already_closed` | Page is already in state `closed` |

**Idempotency:** calling close on an already-closed page returns 409
rather than silently succeeding. The agent can check the error code and
treat it as a no-op.

**Effect on submissions:** existing submissions are preserved. The page
remains readable via `GET /:id` and `GET /:id/result`. Only new
submissions are rejected.

---

### `GET /:id` — get page (modified)

**Response body gains new fields:**

```jsonc
{
  "spec": [ ... ],
  "format": "a2ui",
  "state": "open",           // now includes "closed" as a possible value
  "mode": "single",          // NEW — "single" | "public"
  "result": null,            // null for public pages (use GET /:id/result)
  "expires_at": 1709122000000,
  "access_emails": null      // NEW — null or string[]
}
```

The frontend uses `mode` to decide whether to show the "already
submitted" lock-out (single) or the "submit another" flow (public),
and whether to show the "closed" message.

---

## DB layer changes (`db.ts`)

### New types

```typescript
export type PageMode = 'single' | 'public';

// Extend PageState to include 'closed'
export type PageState = 'open' | 'submitted' | 'received' | 'closed';

// Extend Page to include new columns
export type Page = {
  id: string;
  spec: unknown;
  format: PageFormat;
  mode: PageMode;
  state: PageState;
  result: unknown;
  createdAt: number;
  expiresAt: number;
  accessEmails: string[] | null;
  ownerId: string | null;
};

export type Submission = {
  id: string;
  pageId: string;
  submittedBy: string | null;
  result: unknown;
  submittedAt: Date;
};
```

### New functions

```typescript
/** Insert a submission for a public page. Returns the submission ID. */
export async function insertSubmission(
  pageId: string,
  result: unknown,
  submittedBy: string | null,
): Promise<{ id: string; submittedAt: Date }>;

/** Fetch paginated submissions for a page. */
export async function getSubmissions(
  pageId: string,
  opts: { limit: number; cursor?: string },
): Promise<{ submissions: Submission[]; total: number }>;

/** Close a public page. Returns 'ok' | 'not_found' | 'not_owner' | 'already_closed' | 'wrong_mode'. */
export async function closePage(
  pageId: string,
  callerId: string,
): Promise<{ kind: 'ok'; closedAt: Date } | { kind: 'not_found' | 'not_owner' | 'already_closed' | 'wrong_mode' }>;
```

### Modified functions

**`submitPage`** — branching on mode:

```typescript
export async function submitPage(
  id: string,
  action: unknown,
  submittedBy?: string | null,
): Promise<SubmitOutcome> {
  const page = await getActivePage(id);
  if (!page) return { kind: 'not_found' };

  if (page.mode === 'public') {
    if (page.state === 'closed') return { kind: 'closed' };
    // Insert submission row, do NOT change page state
    const sub = await insertSubmission(id, action, submittedBy ?? null);
    return { kind: 'ok', createdAt: page.createdAt, submissionId: sub.id };
  }

  // Single mode: existing atomic open→submitted transition
  // Also insert a submissions row for consistency
  // ... existing logic ...
}
```

**`SubmitOutcome`** — extended:

```typescript
export type SubmitOutcome =
  | { kind: 'ok'; createdAt: Date; submissionId?: string }
  | { kind: 'conflict' }
  | { kind: 'closed' }
  | { kind: 'not_found' };
```

**`fetchAndAdvanceResult`** — branching on mode:

For public pages, this function does NOT advance state. It returns the
page state and defers to `getSubmissions` for the actual data.

**`insertPage`** — accepts `mode`, `accessEmails`, `ownerId`:

```typescript
export async function insertPage(p: Page): Promise<void> {
  await withRetry(async () => {
    const c = client();
    await c`insert into pages (id, spec, format, mode, state, expires_at, access_emails, owner_id)
            values (
              ${p.id},
              ${c.json(p.spec)},
              ${p.format},
              ${p.mode},
              'open',
              to_timestamp(${p.expiresAt} / 1000.0),
              ${p.accessEmails},
              ${p.ownerId}
            )`;
  });
}
```

**`deleteExpiredPages`** — unchanged. The `on delete cascade` on
`submissions.page_id` ensures child rows are cleaned up automatically.
Public pages in state `open` count as abandoned, same as single-mode.

---

## MCP tool changes

### `show_ui` — new parameters

```typescript
server.registerTool('show_ui', {
  title: 'Show UI to the user',
  description: SHOW_UI_DESCRIPTION,  // updated, see below
  inputSchema: {
    spec: z.array(z.record(z.unknown())).describe(SHOW_UI_INPUT_DESCRIPTION),
    mode: z.enum(['single', 'public']).optional().default('single')
      .describe(
        'Page mode. "single" (default): one submission, one result — the page locks after the first submit. ' +
        '"public": multiple submissions from multiple users — the page stays open until you close it. ' +
        'Use "public" for surveys, polls, intake forms, or any form where you need responses from many people.'
      ),
    access_emails: z.array(z.string().email()).optional()
      .describe(
        'Optional email allowlist. When set, only users with these email addresses can view and submit the form. ' +
        'Requires authentication. Omit to allow anyone with the link.'
      ),
  },
}, async ({ spec, mode, access_emails }) => {
  const created = await ops.showUi(spec, { mode, accessEmails: access_emails });
  // ... return content ...
});
```

**Updated `SHOW_UI_DESCRIPTION`** (additions in bold):

> Ask the user a question that needs a structured answer back. Forms,
> pickers, confirmations, multi-step wizards, surveys, dashboards-as-input.
>
> Returns { page_id, url, expires_at }. PRINT the URL so the user can
> open it. The agent never sees the user typing — only the final
> submitted result.
>
> **The `mode` parameter controls how many submissions the page accepts.
> Default "single": one spec, one result — the page locks after the
> first submit. Use "public" for surveys, polls, or intake forms that
> need responses from multiple people. Public pages stay open until you
> close them with `POST /:id/close` or they expire.**
>
> After this call, poll check_result on your own cadence to read the
> user response (start at 2-3s, back off exponentially up to ~30s; do
> other useful work between polls rather than blocking). **For public
> pages, check_result returns an array of all submissions so far.**

### `check_result` — response shape change

**Single mode:** unchanged.

```jsonc
{
  "state": "submitted",
  "result": { "name": "submitted", ... },
  "format": "a2ui",
  "page_id": "abc123..."
}
```

**Public mode:**

```jsonc
{
  "state": "open",
  "mode": "public",
  "format": "a2ui",
  "page_id": "abc123...",
  "submissions": [
    {
      "id": "uuid",
      "result": { ... },
      "submitted_by": "user-uuid-or-null",
      "submitted_at": "2026-05-17T12:34:56.789Z"
    }
  ],
  "total": 42,
  "cursor": "2026-05-17T12:34:56.789Z"
}
```

**Updated tool handler:**

```typescript
async ({ page_id }) => {
  const outcome = await ops.checkResult(page_id);
  if (outcome.kind === 'not_found') {
    throw new Error(`Page ${page_id} not found ...`);
  }

  if (outcome.mode === 'public') {
    const subText = outcome.submissions.length === 0
      ? `No submissions yet (state: ${outcome.state}). Call check_result again in a few seconds.`
      : `${outcome.total} total submission(s). Latest batch:\n${JSON.stringify(outcome.submissions)}`;

    return {
      content: [{ type: 'text', text: subText }],
      structuredContent: {
        state: outcome.state,
        mode: 'public',
        format: outcome.format,
        page_id,
        submissions: outcome.submissions,
        total: outcome.total,
        cursor: outcome.cursor,
      },
    };
  }

  // Single mode: existing logic unchanged
  // ...
}
```

**Updated `CHECK_RESULT_DESCRIPTION`:**

> Fetch the current state of a page created by show_ui. Fire-and-return — does NOT block or wait.
>
> **For single-mode pages:** Returns { state, result, format, page_id } where state is "open" | "submitted" | "received". When state is "open", the user has not responded yet — wait a few seconds and call again. When "submitted", result is the user input. When "received", you already read the result on a prior poll.
>
> **For public-mode pages:** Returns { state, mode, format, page_id, submissions, total, cursor }. Submissions is an array of all responses received so far. State stays "open" until the owner closes the page (state becomes "closed"). Use cursor-based pagination for pages with many submissions.

### `PageOps` interface — extended

```typescript
export interface PageOps {
  showUi(spec: unknown, opts?: { mode?: PageMode; accessEmails?: string[] }): Promise<ShowUiResult>;
  showHtml(html: string): Promise<ShowUiResult>;
  checkResult(page_id: string, opts?: { limit?: number; cursor?: string }): Promise<CheckResultOutcome>;
}
```

### `CheckResultOutcome` — extended

```typescript
export type CheckResultOutcome =
  | { kind: 'not_found' }
  | { kind: 'state'; state: PageState; result: unknown; format: PageFormat; mode: 'single' }
  | {
      kind: 'state';
      state: PageState;
      format: PageFormat;
      mode: 'public';
      submissions: Submission[];
      total: number;
      cursor: string | null;
    };
```

---

## Frontend changes (`apps/web/main.ts`)

### Page loading (`loadPage`)

The `GET /:id` response now includes `mode`. The frontend stores it:

```typescript
declare mode: PageMode;  // 'single' | 'public'
```

### Submit handler (public mode)

For public pages, the action handler in the `MessageProcessor` changes:

1. POST the result to `/:id/result` as before.
2. On success: show a "submitted successfully" confirmation toast/banner.
3. **Do NOT set `this.awaiting = true`** — the form stays interactive.
4. Reset form fields to their default values so the user (or another
   user) can submit again.
5. Do NOT start polling for `received` — public pages have no
   `received` state.

```typescript
// Pseudocode for the public-mode submit handler
if (this.mode === 'public') {
  const res = await fetch(`${API_BASE}/${pageId}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ... }),
  });
  if (!res.ok) {
    if (res.status === 409) {
      // Page is closed
      this.status = 'closed';
      return;
    }
    this.submitError = body.message ?? 'Submit failed';
    return;
  }
  this.showConfirmation('Response submitted successfully');
  this.resetForm();
  return;
}
```

### Closed state rendering

When `page.state === 'closed'`, the frontend renders a tombstone:

```html
<div class="closed-banner">
  <span class="material-symbols">block</span>
  <span>This form is no longer accepting responses.</span>
</div>
```

The closed state is visually distinct from "Session ended" (which
covers expired/deleted pages). The form spec is still visible behind
a dimmed overlay so late-arriving users can see what was asked.

### Confirmation toast

After a successful submission on a public page, a transient toast
appears for 4 seconds:

```html
<div class="submit-confirmation" role="status" aria-live="polite">
  ✓ Response submitted
</div>
```

CSS: absolute-positioned at the top center, fades in/out, does not
block interaction.

### Form reset

After successful submission on a public page, form fields reset to
their initial values. This is achieved by re-processing the original
spec through the `MessageProcessor`:

```typescript
private resetForm() {
  // Clear all surfaces and re-apply the original spec
  for (const id of Array.from(this.processor.model.surfacesMap.keys())) {
    this.processor.model.deleteSurface(id);
  }
  this.processor.processMessages(this.originalSpec as v0_9.A2uiMessage[]);
}
```

The original spec is stored during `loadPage` as `this.originalSpec`.

### Access-restricted pages

When a page has `access_emails` set and the user is not authenticated
(or not in the allowlist), the frontend shows:

```html
<div class="access-restricted">
  <span class="material-symbols">lock</span>
  <p>This form is restricted. Sign in with an authorized email to continue.</p>
  <button @click=${this.startAuth}>Sign in</button>
</div>
```

The auth flow is handled by Pagent's custom auth (magic link or OAuth)
and is out of scope for this spec — it is covered by the auth feature spec.

---

## Access control

### Email allowlist (`access_emails`)

When `access_emails` is non-null on a page:

1. **Viewing** (`GET /:id`): the API returns the spec only if the
   request includes a valid auth token whose email is in the allowlist.
   Unauthenticated requests get 403.
2. **Submitting** (`POST /:id/result`): same check. The `submitted_by`
   column is set to the authenticated user's ID.
3. **Reading results** (`GET /:id/result`): only the page owner can
   read submissions. Checked via `owner_id`.

When `access_emails` is null (default): no restrictions. Anyone with
the URL can view and submit. `submitted_by` is null in submission rows.

### Close authorization

`POST /:id/close` requires:

1. A valid auth token (Bearer JWT in Authorization header).
2. The token's user ID must match `pages.owner_id`.

If either check fails, return 403 `forbidden`.

### Owner identification

`pages.owner_id` is set at page creation time:

- If the `POST /new` request includes a valid auth token, the user ID
  is extracted and stored as `owner_id`.
- If no auth token is present, `owner_id` is null. This means the page
  cannot be closed via `POST /:id/close` — it will only expire via TTL.
- **Implication:** agents that want to close public pages must
  authenticate when creating them. The MCP stdio server includes the
  auth token if the user configured it.

---

## Webhook interaction

### Existing behavior (single mode)

Currently there are no webhooks. This spec defines the webhook contract
for both modes so the upcoming webhook feature has a clear integration
point.

### Public mode webhooks

When webhooks are implemented:

1. **Each submission fires a webhook.** The webhook payload includes:
   ```jsonc
   {
     "event": "submission.created",
     "page_id": "abc123...",
     "submission_id": "uuid",
     "mode": "public",
     "result": { ... },
     "submitted_by": "user-uuid-or-null",
     "submitted_at": "2026-05-17T12:34:56.789Z"
   }
   ```
2. **Close fires a webhook:**
   ```jsonc
   {
     "event": "page.closed",
     "page_id": "abc123...",
     "mode": "public",
     "closed_at": "2026-05-17T15:00:00.000Z",
     "total_submissions": 42
   }
   ```
3. **Webhook delivery is best-effort.** Failed deliveries are retried
   with jitter (3 attempts at 0s/1s/5s). After 3 failures, the webhook
   is dropped and logged.
4. **Webhook URL is set at page creation** via a future `webhook_url`
   parameter on `POST /new`. Not part of this spec.

### Single mode webhooks

For forward-compatibility, single-mode submissions also fire
`submission.created` webhooks (with `mode: "single"`). The state
transitions (`submitted`, `received`) fire `page.state_changed`.

---

## Backward compatibility

### Existing single-mode pages are unaffected

- `mode` defaults to `'single'` in the DB and in the API.
- Omitting `mode` from `POST /new` creates a single-mode page.
- All existing endpoints behave identically for single-mode pages.
- `pages.result` continues to be set for single-mode pages.
- `GET /:id/result` for single-mode pages returns the same shape.
- The `submitted → received` atomic flip is preserved for single mode.

### `check_result` shape discrimination

Agents can distinguish single vs public responses by checking for the
`mode` field:

- Single: `{ state, result, format, page_id }` (no `mode` field, or
  `mode: "single"`)
- Public: `{ state, mode: "public", submissions, total, cursor, ... }`

For maximum compatibility, the `mode` field is included in single-mode
responses too (set to `"single"`), but older agents that don't check it
will see the same shape they always did.

### MCP tool backward compatibility

- `show_ui` with no `mode` parameter behaves identically to today.
- `check_result` for single-mode pages returns the same text and
  structured content shape.
- The `mode` and `access_emails` parameters are optional with defaults
  that preserve current behavior.

---

## Pagination

### When pagination matters

A public page collecting survey responses might accumulate thousands of
submissions. The agent's `check_result` poll must not load all of them
in a single response.

### Strategy: cursor-based on `submitted_at`

- Default page size: 50 submissions.
- Maximum page size: 200 submissions (capped server-side).
- Cursor: the `submitted_at` ISO timestamp of the last submission in
  the current batch.
- Direction: always forward (oldest to newest).
- The response includes `total` (count of all submissions for the page)
  so the agent knows how many remain.
- When `cursor` in the response is `null`, there are no more
  submissions.

### SQL query

```sql
select id, page_id, submitted_by, result, submitted_at
from submissions
where page_id = $1
  and ($2::timestamptz is null or submitted_at > $2)
order by submitted_at asc
limit $3
```

The `total` is a separate count query (or a window function if
performance allows):

```sql
select count(*) from submissions where page_id = $1
```

### Agent polling pattern

For public pages, the agent can use cursor-based polling to get only
new submissions since the last poll:

1. First poll: `check_result(page_id)` — returns first 50 submissions.
2. Note the `cursor` from the response.
3. Next poll: `check_result(page_id, cursor)` — returns only
   submissions after the cursor.
4. Repeat until `cursor` is null (caught up) or page is `closed`.

The MCP `check_result` tool accepts an optional `cursor` parameter to
support this pattern:

```typescript
inputSchema: {
  page_id: z.string().regex(/^[a-f0-9]{32}$/),
  cursor: z.string().datetime().optional()
    .describe('Pagination cursor from a previous check_result call. Returns only submissions after this timestamp.'),
  limit: z.number().int().min(1).max(200).optional().default(50)
    .describe('Max submissions to return per call. Default 50, max 200.'),
}
```

---

## Metrics

New counters and histograms:

| Instrument | Type | Labels | Description |
|-----------|------|--------|-------------|
| `pagent.pages.created` | counter | `format`, `mode` | Existing counter, gains `mode` label |
| `pagent.submissions.created` | counter | `mode` | New: incremented on each submission insert |
| `pagent.pages.closed` | counter | — | New: incremented when owner closes a page |
| `pagent.public_page.submissions` | histogram | — | New: number of submissions per public page at close/expiry time |

---

## Migration strategy

### Phase 1: schema migration (zero downtime)

1. Run the `ALTER TABLE` statements to add `mode`, `access_emails`,
   `owner_id`, `closed_at` columns with defaults.
2. Run `CREATE TABLE submissions` and its index.
3. Update the `state` CHECK constraint.

All changes are additive (new columns with defaults, new table). No
existing queries break.

### Phase 2: API deployment

Deploy the updated API. The `mode` default ensures existing
`POST /new` calls without `mode` create single-mode pages.

### Phase 3: frontend deployment

Deploy the updated web app. The `mode` field in `GET /:id` responses
gates the new UI paths. Old pages (no `mode` in response) are treated
as single-mode.

### Phase 4: MCP server update

Update the MCP npm package. The new `mode` and `access_emails`
parameters are optional, so existing MCP clients continue working.

---

## Resolved questions

1. **TTL for public pages.** Public-mode pages default to 7 days
   (`PUBLIC_PAGE_TTL_MS` env var, default `604800000`). Single-mode
   pages keep the existing 30-minute default. The `POST /new` handler
   selects the TTL based on `mode`: `mode === 'public'` uses
   `PUBLIC_PAGE_TTL_MS`, `mode === 'single'` uses the existing
   `PAGE_TTL_MS`.

2. **Submission rate limiting.** 5 submissions per minute per IP per
   page, plus a 100 submissions per minute global cap per page.
   Implemented as Hono middleware on `POST /:id/result` for public
   pages. Single-mode pages are unaffected (they already accept at
   most one submission). Both limits return 429 with a `Retry-After`
   header when exceeded.

3. **Submission count cap.** 10,000 max submissions per page.
   `POST /:id/result` checks `SELECT count(*) FROM submissions WHERE
   page_id = ?` and returns 409 `{ error: "submission_cap_reached" }`
   when the cap is met. The cap is stored in `pages.max_submissions`
   (default 10000, configurable via `show_ui`).

4. **Auth readiness.** Auth is custom (not Supabase Auth) and ships in
   the same v2 batch as public forms, so `owner_id` and `access_emails`
   enforcement will be available at launch. No deferral needed.
